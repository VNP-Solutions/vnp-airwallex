const crypto = require('crypto');

const Payment = require('../models/Payment');
const Hotel = require('../models/Hotel');
const Batch = require('../models/Batch');
// Required for its side effect: listPayments/getPayment populate `created_by`,
// which needs the User model registered on the mongoose instance. Without this
// the service works inside the server (userRoutes pulls it in) but throws
// "Schema hasn't been registered" from a standalone script or job.
require('../models/User');
const airwallex = require('./airwallexService');
const hotelService = require('./hotelService');
const { buildTemplate, toCsv } = require('./csv');
const { parseTabular } = require('./tabular');
const cardVault = require('./cardVault');

const MAX_EVENTS = 50;

function appBaseUrl() {
    return (process.env.APP_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function roundAmount(value) {
    return Math.round(Number(value) * 100) / 100;
}

/**
 * Our own order reference. Airwallex caps merchant_order_id at 64 chars; this
 * stays well inside that and is unique enough to double as an idempotency key.
 */
function generateOrderId() {
    return `vnp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Airwallex caps merchant_order_id at 64 characters and rejects an empty one,
// but does NOT enforce uniqueness — it will happily create a second intent with
// an order id already in use. Uniqueness is entirely ours to keep.
const ORDER_ID_MAX_LENGTH = 64;

function normaliseOrderId(value) {
    return (value == null ? '' : String(value)).trim();
}

function assertOrderIdShape(orderId) {
    if (orderId.length > ORDER_ID_MAX_LENGTH) {
        throw badRequest(
            `Order ID must be ${ORDER_ID_MAX_LENGTH} characters or fewer (Airwallex limit)`
        );
    }
}

/**
 * Reject an order id already used by another payment.
 *
 * The unique index is the real guarantee; this exists so the operator gets
 * "already used by …" instead of a raw duplicate-key error.
 */
/**
 * A request_id that Airwallex cannot have seen before.
 *
 * Keeps the original in front so the key still reads as the booking it belongs
 * to, and appends enough entropy that two retries seconds apart cannot collide.
 * Truncated from the left of the suffix, never the reservation, so the id stays
 * recognisable at 64 characters.
 */
function uniqueRequestId(base) {
    const suffix = `-r${Date.now().toString(36)}${crypto
        .randomBytes(2)
        .toString('hex')}`;
    const room = 64 - suffix.length;
    return `${String(base || 'req').slice(0, room)}${suffix}`;
}

/**
 * Validate and normalise a card for storage.
 *
 * The same rules the bulk importer applies, so a card typed into the form and
 * one read from a spreadsheet are held to an identical standard: supported
 * brand, plausible number, a readable expiry that has not passed, a CVV.
 * Returns undefined when no card was supplied — paying by hand stays valid.
 */
function prepareCard(card) {
    if (!card) return undefined;

    const pan = cardVault.normalisePan(card.pan || card.number || card.card_number);
    const rawExpiry = card.expiry || card.card_expiry;
    const rawCvv = card.cvv || card.card_cvv;

    // Nothing entered at all is not an error; it just means no stored card.
    if (!pan && !rawExpiry && !rawCvv) return undefined;

    if (!cardVault.isConfigured()) {
        throw badRequest('CARD_ENCRYPTION_KEY is not set — card details cannot be stored');
    }
    if (!pan) throw badRequest('Card number is required when storing a card');

    const brand = cardVault.brandOf(pan);
    if (BLOCKED_CARD_BRANDS.includes(brand)) {
        throw badRequest(
            `${brand === 'amex' ? 'American Express' : brand} is not supported`
        );
    }
    if (!cardVault.luhnValid(pan)) {
        throw badRequest(`Card ending ${pan.slice(-4) || '????'}: ${cardVault.describePanProblem(pan)}`);
    }

    const expiry = cardVault.normaliseExpiry(rawExpiry);
    if (!expiry) throw badRequest(`Expiry "${rawExpiry || ''}" is not a readable date`);
    if (cardVault.expiryPassed(expiry)) throw badRequest(`The card expired in ${expiry}`);

    const cvv = cardVault.normaliseCvv(rawCvv);
    if (!cvv) throw badRequest('CVV is required when storing a card');

    return { pan, expiry, cvv };
}

/**
 * An order id is only spoken for once money has actually moved against it.
 *
 * A reservation that failed — wrong card, wrong amount, a decline — gets tried
 * again under the same order id, because it is the same booking. Only a settled
 * payment makes the id permanently taken: charging a second time against an
 * order that already paid is the one outcome there is no undoing.
 */
async function assertOrderIdFree(orderId) {
    const clash = await Payment.findOne({
        merchant_order_id: orderId,
        status: { $in: SETTLED_STATUSES },
    })
        .select('payment_intent_id description status created_at')
        .lean();
    if (clash) {
        const err = new Error(
            `Order ID "${orderId}" already took payment${
                clash.description ? ` (${clash.description})` : ''
            } — it cannot be charged again`
        );
        err.statusCode = 409;
        err.conflict = clash;
        throw err;
    }
}

// Airwallex failure codes are machine-readable; give the common ones wording an
// operator can act on without opening the API reference.
const FAILURE_MESSAGES = {
    fraud_rejected: 'Blocked by risk checks',
    insufficient_funds: 'Insufficient funds',
    do_not_honor: 'Declined by the issuer (do not honour)',
    invalid_card_number: 'Invalid card number',
    expired_card: 'Card expired',
    incorrect_cvc: 'Incorrect security code',
    card_declined: 'Card declined by the issuer',
    authentication_failed: '3D Secure authentication failed',
    processing_error: 'Processing error at the issuer',
    call_issuer: 'Issuer asked the cardholder to call',
    lost_or_stolen: 'Card reported lost or stolen',
    pickup_card: 'Card flagged for pickup',
    withdrawal_count_limit_exceeded: 'Card transaction limit exceeded',
};

function describeFailure(code) {
    if (!code) return 'The payment attempt failed';
    return (
        FAILURE_MESSAGES[code] ||
        String(code).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    );
}

/**
 * Keep only the most recent exchanges. Debug value drops off fast and an
 * unbounded array would grow a document without limit.
 */
const MAX_API_LOG_ENTRIES = 25;

function appendApiLog(payment, entries) {
    if (!entries || !entries.length) return;
    payment.api_log = [...(payment.api_log || []), ...entries].slice(-MAX_API_LOG_ENTRIES);
}

function pushEvent(payment, event) {
    payment.events.push(event);
    if (payment.events.length > MAX_EVENTS) {
        payment.events = payment.events.slice(-MAX_EVENTS);
    }
}

/**
 * Copy the fields Airwallex owns onto our record. Returns true if anything
 * actually changed, so callers can skip pointless writes.
 */
function applyIntent(payment, intent, { source = 'sync', eventName, eventId } = {}) {
    const before = payment.status;

    if (intent.status) payment.status = intent.status;
    if (typeof intent.captured_amount === 'number') {
        payment.captured_amount = intent.captured_amount;
    }
    if (intent.descriptor) payment.descriptor = intent.descriptor;
    if (intent.created_at) payment.intent_created_at = new Date(intent.created_at);
    if (intent.updated_at) payment.intent_updated_at = new Date(intent.updated_at);

    const attempt = intent.latest_payment_attempt;
    if (attempt) {
        if (attempt.payment_method) {
            const method = attempt.payment_method;
            if (method.type) payment.payment_method_type = method.type;
            if (method.card) {
                if (method.card.brand) payment.card_brand = method.card.brand;
                if (method.card.last4) payment.card_last4 = method.card.last4;
            }
        }

        // A decline does not move the intent to FAILED — Airwallex leaves it at
        // REQUIRES_PAYMENT_METHOD so the shopper can retry, and puts the
        // outcome on the attempt. Mirror it, or a declined payment is
        // indistinguishable from one nobody has tried.
        if (attempt.status) payment.last_attempt_status = attempt.status;
        if (attempt.id && attempt.id !== payment.last_attempt_id) {
            payment.last_attempt_id = attempt.id;
            payment.attempt_count = (payment.attempt_count || 0) + 1;
        }

        if (attempt.status === 'FAILED') {
            const details = attempt.failure_details || {};
            payment.last_error = {
                code: attempt.failure_code || details.code || 'failed',
                message:
                    details.message ||
                    details.description ||
                    describeFailure(attempt.failure_code),
                occurred_at: attempt.updated_at ? new Date(attempt.updated_at) : new Date(),
            };
        }
    }

    // Kept for completeness — Airwallex populates the attempt, not this, on a
    // decline, but an intent-level error should still surface if one appears.
    if (intent.last_payment_error) {
        payment.last_error = {
            code: intent.last_payment_error.code,
            message: intent.last_payment_error.message,
            occurred_at: new Date(),
        };
    }

    payment.last_synced_at = new Date();

    const changed = before !== payment.status;
    if (changed || eventName) {
        pushEvent(payment, {
            name: eventName || `status.${payment.status}`,
            status: payment.status,
            source,
            occurred_at: new Date(),
            event_id: eventId,
        });
    }
    return changed;
}

/**
 * Create a Payment Intent at Airwallex and mirror it locally.
 *
 * The local record is written only after Airwallex accepts the intent, so we
 * never end up with history rows pointing at intents that do not exist.
 */
/**
 * Resolve the hotel for a payment from either its id or its Expedia ID.
 * Returns null when no hotel was requested; throws when one was but is unusable.
 */
async function resolveHotel({ hotel_id, expedia_id }) {
    if (!hotel_id && !expedia_id) return null;

    const hotel = hotel_id
        ? await Hotel.findById(hotel_id).catch(() => null)
        : await Hotel.findOne({ expedia_id: String(expedia_id).trim() });

    if (!hotel) {
        throw badRequest(
            expedia_id
                ? `No hotel found with Expedia ID ${expedia_id}`
                : 'Hotel not found'
        );
    }
    if (hotel.status === 'archived') {
        throw badRequest(
            `${hotel.name} (${hotel.expedia_id}) is archived — reactivate it before taking payments`
        );
    }
    return hotel;
}

async function createPayment({
    amount,
    currency,
    reference,
    description,
    descriptor,
    descriptor_prefix,
    hotel_id,
    expedia_id,
    customer,
    checkout_mode = 'embedded_elements',
    metadata,
    created_by,
    batch_name,
    request_id: requestId,
    merchant_order_id: orderIdInput,
    card,
    customer_label,
    batch,
}) {
    const numericAmount = roundAmount(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        throw badRequest('amount must be a positive number');
    }
    if (!currency || !/^[A-Za-z]{3}$/.test(currency)) {
        throw badRequest('currency must be a 3-letter ISO code');
    }
    if (!['hosted_page', 'embedded_elements'].includes(checkout_mode)) {
        throw badRequest('checkout_mode must be hosted_page or embedded_elements');
    }

    const hotel = await resolveHotel({ hotel_id, expedia_id });

    // Descriptor precedence: an explicit override, else the selected hotel's
    // descriptor, else the configured default. The hotel's descriptor is the
    // whole reason properties are held centrally — it is what the cardholder
    // sees, and it is used verbatim.
    const finalDescriptor = (descriptor || '').trim()
        ? descriptor.trim()
        : airwallex.buildDescriptor({
              prefix: descriptor_prefix || (hotel ? hotel.descriptor : undefined),
          });

    if (finalDescriptor.length > airwallex.DESCRIPTOR_MAX_LENGTH) {
        throw badRequest(
            `descriptor must be ${airwallex.DESCRIPTOR_MAX_LENGTH} characters or fewer`
        );
    }

    // Operator-supplied when given; otherwise the description, which carries
    // the reservation id. Generated only when both are blank.
    const suppliedOrderId =
        normaliseOrderId(orderIdInput) || normaliseOrderId(description);
    if (suppliedOrderId) {
        assertOrderIdShape(suppliedOrderId);
        await assertOrderIdFree(suppliedOrderId);
    }
    const merchant_order_id = suppliedOrderId || generateOrderId();
    // Minted before the intent so the return URL can carry it.
    const publicToken = crypto.randomBytes(16).toString('base64url');

    // The idempotency key. Callers pass the reservation id — unique per
    // transaction — so a re-run of the same booking cannot charge twice.
    // Airwallex rejects a reused request_id outright (it does NOT replay the
    // original intent), which is what makes this a real guard.
    let request_id = (requestId || '').trim() || crypto.randomUUID();
    if (request_id.length > 64) {
        throw badRequest('request_id must be 64 characters or fewer');
    }

    const cleanCustomer = customer
        ? {
              name: (customer.name || '').trim() || undefined,
              email: (customer.email || '').trim() || undefined,
              phone: (customer.phone || '').trim() || undefined,
          }
        : undefined;

    // Collects the request/response so the payment carries its own debug trail.
    const apiLog = [];

    let intent;
    let retried = false;

    // Wrapped so a request_id collision can be answered by asking again under a
    // new key — see the catch below for why that is the right response.
    async function attemptCreate() {
    try {
        intent = await airwallex.createPaymentIntent({
        log: apiLog,
        request_id,
        merchant_order_id,
        amount: numericAmount,
        currency: currency.toUpperCase(),
        descriptor: finalDescriptor,
        customer: cleanCustomer && Object.values(cleanCustomer).some(Boolean)
            ? {
                  first_name: cleanCustomer.name
                      ? cleanCustomer.name.split(' ')[0]
                      : undefined,
                  last_name: cleanCustomer.name
                      ? cleanCustomer.name.split(' ').slice(1).join(' ') || undefined
                      : undefined,
                  email: cleanCustomer.email,
                  phone_number: cleanCustomer.phone,
              }
            : undefined,
        order: description
            ? {
                  products: [
                      {
                          name: description.slice(0, 120),
                          quantity: 1,
                          unit_price: numericAmount,
                      },
                  ],
              }
            : undefined,
        metadata: {
            ...(metadata || {}),
            source: 'vnp-airwallex',
            ...(reference ? { reference } : {}),
            ...(hotel
                ? { hotel_expedia_id: hotel.expedia_id, hotel_name: hotel.name }
                : {}),
        },
        return_url: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
            publicToken
        )}`,
        });
    } catch (err) {
        // Airwallex remembers every request_id it has ever seen, for good, and
        // across environments it is a separate ledger from ours. So a reused
        // key means only "this exact request was sent before" — not "this
        // booking is already paid". Our own guard for that is the settled-status
        // check in assertOrderIdFree, which ran above.
        //
        // That distinction matters because the two can disagree: a record
        // deleted here, or a batch first attempted against a different account,
        // leaves Airwallex holding a key we have no trace of. Refusing on that
        // basis blocks a legitimate retry for a booking nobody ever charged —
        // which is what stalled a whole 38-row file. So a collision is resolved
        // by asking again under a key that is unmistakably new, once.
        if (err.airwallex && err.airwallex.code === 'duplicate_request' && !retried) {
            retried = true;
            request_id = uniqueRequestId(request_id);
            return attemptCreate();
        }
        throw err;
    }
    }

    await attemptCreate();

    const payment = new Payment({
        public_token: publicToken,
        payment_intent_id: intent.id,
        request_id,
        merchant_order_id,
        amount: numericAmount,
        currency: currency.toUpperCase(),
        captured_amount: intent.captured_amount || 0,
        descriptor: intent.descriptor || finalDescriptor,
        status: intent.status || 'REQUIRES_PAYMENT_METHOD',
        checkout_mode,
        reference: (reference || '').trim() || undefined,
        description: (description || '').trim() || undefined,
        hotel: hotel ? hotel._id : undefined,
        hotel_expedia_id: hotel ? hotel.expedia_id : undefined,
        hotel_name: hotel ? hotel.name : undefined,
        hotel_portfolio: hotel ? hotel.portfolio : undefined,
        batch: batch || undefined,
        batch_name: batch_name || undefined,
        customer_label: customer_label || undefined,
        // Encrypted on the way in; the plaintext never leaves this call.
        card: card
            ? {
                  pan: cardVault.encrypt(card.pan),
                  expiry: cardVault.encrypt(card.expiry),
                  cvv: cardVault.encrypt(card.cvv),
                  last4: card.pan.slice(-4),
                  brand: cardVault.brandOf(card.pan),
                  cardholder_name: customer_label || undefined,
              }
            : undefined,
        customer: cleanCustomer,
        metadata: metadata || {},
        created_by,
        intent_created_at: intent.created_at ? new Date(intent.created_at) : undefined,
        intent_updated_at: intent.updated_at ? new Date(intent.updated_at) : undefined,
        last_synced_at: new Date(),
        api_log: apiLog,
        events: [
            {
                name: 'payment_intent.created',
                status: intent.status,
                source: 'local',
                occurred_at: new Date(),
            },
        ],
    });
    await payment.save();

    // The freshly built document still holds the encrypted card in memory, and
    // every normal read leaves those fields out (select: false). Strip them here
    // too so the create response matches: ciphertext has no business leaving
    // the server, and the client has last4 and brand for display already.
    const safePayment = payment.toObject();
    if (safePayment.card) {
        delete safePayment.card.pan;
        delete safePayment.card.expiry;
        delete safePayment.card.cvv;
    }

    // client_secret is deliberately not persisted — it is a short-lived
    // client-side credential, handed straight to the browser and never stored.
    return {
        payment: safePayment,
        checkout: {
            intent_id: intent.id,
            client_secret: intent.client_secret,
            currency: payment.currency,
            amount: payment.amount,
            env: airwallex.env(),
            mode: checkout_mode,
            // Keys the return page and its status lookup.
            public_token: publicToken,
            merchant_order_id: payment.merchant_order_id,
            successUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                publicToken
            )}&outcome=success`,
            cancelUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                publicToken
            )}&outcome=cancel`,
        },
    };
}

async function listPayments({
    q,
    status,
    checkout_mode,
    sort = 'desc',
    limit = 25,
    skip = 0,
} = {}) {
    const query = {};

    if (q && String(q).trim()) {
        const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = { $regex: escaped, $options: 'i' };
        query.$or = [
            { payment_intent_id: regex },
            { merchant_order_id: regex },
            { reference: regex },
            { description: regex },
            { descriptor: regex },
            { 'customer.email': regex },
            { 'customer.name': regex },
        ];
    }
    if (status) query.status = String(status).toUpperCase();
    if (checkout_mode) query.checkout_mode = checkout_mode;

    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safeSkip = Math.max(Number(skip) || 0, 0);
    const sortOrder = sort === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
        Payment.find(query)
            .sort({ created_at: sortOrder })
            .skip(safeSkip)
            .limit(safeLimit)
            .select('-events')
            .populate('created_by', 'first_name last_name email'),
        Payment.countDocuments(query),
    ]);

    return { items, total, limit: safeLimit, skip: safeSkip };
}

/**
 * Look up a payment by its public token — the only identifier the
 * unauthenticated return page is given. Deliberately does not accept
 * merchant_order_id: those are operator-chosen and guessable.
 */
async function getPaymentByPublicToken(token) {
    const payment = await Payment.findOne({ public_token: String(token || '') });
    if (!payment) {
        const err = new Error('Payment not found');
        err.statusCode = 404;
        throw err;
    }
    return payment;
}

async function getPayment(id) {
    const payment = await Payment.findOne({
        $or: [
            { payment_intent_id: id },
            { merchant_order_id: id },
            ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : []),
        ],
    }).populate('created_by', 'first_name last_name email');

    if (!payment) {
        const err = new Error('Payment not found');
        err.statusCode = 404;
        throw err;
    }
    return payment;
}

/** Pull the current state from Airwallex and persist any change. */
async function syncPayment(id) {
    const payment = await getPayment(id);
    const apiLog = [];
    const intent = await airwallex.retrievePaymentIntent(payment.payment_intent_id, {
        log: apiLog,
    });
    applyIntent(payment, intent, { source: 'sync' });
    appendApiLog(payment, apiLog);
    await payment.save();
    return payment;
}

// Statuses a shopper can still pay. PENDING is excluded on purpose: the
// payment is already in flight and re-presenting checkout invites a double
// charge.
const PAYABLE_STATUSES = ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION'];

/**
 * Re-open checkout for a payment that has not been paid yet.
 *
 * The client_secret is never stored, so it is fetched fresh from Airwallex —
 * retrieving an intent mints a new one with its own short expiry. The retrieve
 * also carries the current status, so this doubles as a sync and cannot hand
 * out a checkout for something that has already succeeded elsewhere.
 */
async function getCheckoutSession(id) {
    const payment = await getPayment(id);
    const apiLog = [];
    const intent = await airwallex.retrievePaymentIntent(payment.payment_intent_id, {
        log: apiLog,
    });

    applyIntent(payment, intent, { source: 'sync' });
    appendApiLog(payment, apiLog);
    await payment.save();

    if (!PAYABLE_STATUSES.includes(payment.status)) {
        const err = new Error(
            `This payment is ${payment.status.toLowerCase().replace(/_/g, ' ')} and cannot be paid`
        );
        err.statusCode = 409;
        throw err;
    }

    if (!intent.client_secret) {
        const err = new Error('Airwallex did not return a checkout session for this payment');
        err.statusCode = 502;
        throw err;
    }

    return {
        payment,
        checkout: {
            intent_id: payment.payment_intent_id,
            client_secret: intent.client_secret,
            currency: payment.currency,
            amount: payment.amount,
            env: airwallex.env(),
            mode: 'embedded_elements',
            public_token: payment.public_token,
            merchant_order_id: payment.merchant_order_id,
            descriptor: payment.descriptor,
            description: payment.description,
            successUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                payment.public_token
            )}&outcome=success`,
            cancelUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                payment.public_token
            )}&outcome=cancel`,
        },
    };
}

async function cancelPayment(id, { reason } = {}) {
    const payment = await getPayment(id);

    if (payment.isTerminal()) {
        const err = new Error(`Payment is already ${payment.status.toLowerCase()}`);
        err.statusCode = 409;
        throw err;
    }

    const apiLog = [];
    const intent = await airwallex.cancelPaymentIntent(payment.payment_intent_id, {
        cancellation_reason: reason,
        log: apiLog,
    });
    applyIntent(payment, intent, {
        source: 'sync',
        eventName: 'payment_intent.cancelled',
    });
    appendApiLog(payment, apiLog);
    await payment.save();
    return payment;
}

/**
 * Apply a verified webhook event.
 *
 * payment_intent.* events carry the intent itself; payment_attempt.* events
 * carry an attempt that points back at one. Anything we do not have a local
 * record for is acknowledged and ignored — the notification URL is shared by
 * the whole Airwallex account, not just this app.
 */
async function handleWebhookEvent(event) {
    const name = event && event.name;
    const object = (event && event.data && event.data.object) || {};

    if (!name) return { handled: false, reason: 'missing event name' };

    let intentId = null;
    if (name.startsWith('payment_intent.')) {
        intentId = object.id;
    } else if (name.startsWith('payment_attempt.')) {
        intentId = object.payment_intent_id;
    } else if (name.startsWith('refund.')) {
        intentId = object.payment_intent_id;
    }

    if (!intentId) return { handled: false, reason: `unhandled event ${name}` };

    const payment = await Payment.findOne({ payment_intent_id: intentId });
    if (!payment) return { handled: false, reason: 'no local record' };

    // Drop duplicate deliveries — Airwallex retries until it gets a 200.
    if (event.id && payment.events.some((e) => e.event_id === event.id)) {
        return { handled: true, duplicate: true, payment };
    }

    if (name.startsWith('payment_intent.')) {
        applyIntent(payment, object, {
            source: 'webhook',
            eventName: name,
            eventId: event.id,
        });
    } else {
        // Attempt/refund events do not carry intent status; record the event and
        // re-read the intent so status stays authoritative.
        pushEvent(payment, {
            name,
            status: object.status,
            source: 'webhook',
            occurred_at: event.created_at ? new Date(event.created_at) : new Date(),
            event_id: event.id,
        });
        try {
            const apiLog = [];
            const intent = await airwallex.retrievePaymentIntent(intentId, { log: apiLog });
            applyIntent(payment, intent, { source: 'webhook' });
            appendApiLog(payment, apiLog);
        } catch (err) {
            console.error('Failed to re-read intent after webhook:', err.message);
        }
    }

    await payment.save();
    return { handled: true, payment };
}


// ============================================================
//  Global filters — Excel-style per-column filtering over the
//  whole payment history, applied server-side so filters span
//  every page rather than just the rows currently loaded.
// ============================================================

// Field -> filter kind. `text` and `enum` behave identically here (regex or
// $in); the split only tells the frontend which popover UI to draw.
const FILTERABLE_FIELDS = {
    payment_intent_id: 'text',
    merchant_order_id: 'text',
    reference: 'text',
    description: 'text',
    descriptor: 'text',
    'customer.name': 'text',
    'customer.email': 'text',
    card_last4: 'text',
    hotel_name: 'text',
    hotel_expedia_id: 'text',
    hotel_portfolio: 'enum',
    // The batch's file name, filterable as a column.
    batch_name: 'enum',
    // Not surfaced as a column filter — used by the Batches page's
    // "Pay individually" link to scope the table to one upload.
    batch: 'text',

    amount: 'number',
    captured_amount: 'number',

    status: 'enum',
    last_attempt_status: 'enum',
    currency: 'enum',
    checkout_mode: 'enum',
    payment_method_type: 'enum',
    card_brand: 'enum',

    created_at: 'date',
    intent_created_at: 'date',
};

const SORTABLE_FIELDS = new Set(Object.keys(FILTERABLE_FIELDS));

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCondition(kind, filter) {
    if (!filter || typeof filter !== 'object') return null;
    const { op } = filter;

    if (kind === 'text' || kind === 'enum') {
        const value = filter.value;
        if (op === 'in' && Array.isArray(value)) {
            const cleaned = value.filter((v) => v != null && v !== '');
            return cleaned.length ? { $in: cleaned } : null;
        }
        if (op === 'contains' && value) {
            return { $regex: escapeRegex(value), $options: 'i' };
        }
        if (op === 'startswith' && value) {
            return { $regex: '^' + escapeRegex(value), $options: 'i' };
        }
        if (op === 'endswith' && value) {
            return { $regex: escapeRegex(value) + '$', $options: 'i' };
        }
        if (op === 'eq' && value !== undefined && value !== '') return value;
        return null;
    }

    if (kind === 'number') {
        if (op === 'between') {
            const cond = {};
            const min = filter.min != null && filter.min !== '' ? Number(filter.min) : NaN;
            const max = filter.max != null && filter.max !== '' ? Number(filter.max) : NaN;
            if (!Number.isNaN(min)) cond.$gte = min;
            if (!Number.isNaN(max)) cond.$lte = max;
            return Object.keys(cond).length ? cond : null;
        }
        if (op === 'in' && Array.isArray(filter.value)) {
            const nums = filter.value.map(Number).filter((n) => !Number.isNaN(n));
            return nums.length ? { $in: nums } : null;
        }
        const num = Number(filter.value);
        if (Number.isNaN(num)) return null;
        switch (op) {
            case 'eq': return num;
            case 'ne': return { $ne: num };
            case 'gt': return { $gt: num };
            case 'gte': return { $gte: num };
            case 'lt': return { $lt: num };
            case 'lte': return { $lte: num };
            default: return null;
        }
    }

    if (kind === 'date') {
        const cond = {};
        if (filter.after) {
            const d = new Date(filter.after);
            if (!Number.isNaN(d.getTime())) cond.$gte = d;
        }
        if (filter.before) {
            const d = new Date(filter.before);
            if (!Number.isNaN(d.getTime())) {
                // Inclusive end-of-day: bump a day and use $lt.
                cond.$lt = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            }
        }
        return Object.keys(cond).length ? cond : null;
    }

    return null;
}

function buildQuery({ filters, search }) {
    const query = {};

    if (filters && typeof filters === 'object') {
        for (const [field, filter] of Object.entries(filters)) {
            const kind = FILTERABLE_FIELDS[field];
            if (!kind) continue;
            const cond = buildCondition(kind, filter);
            if (cond === null) continue;

            // `batch` holds ObjectIds. Mongoose throws a cast error on anything
            // else, turning a malformed filter into a 500 — match nothing
            // instead, which is what an unknown batch should do anyway.
            if (field === 'batch') {
                const ids = (Array.isArray(filter.value) ? filter.value : [filter.value])
                    .map((v) => String(v || ''))
                    .filter((v) => /^[0-9a-fA-F]{24}$/.test(v));
                if (!ids.length) {
                    query._id = null; // matches nothing
                    continue;
                }
                query.batch = ids.length === 1 ? ids[0] : { $in: ids };
                continue;
            }

            query[field] = cond;
        }
    }

    if (search && String(search).trim()) {
        const regex = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
        query.$or = [
            { payment_intent_id: regex },
            { merchant_order_id: regex },
            { reference: regex },
            { description: regex },
            { descriptor: regex },
            { 'customer.email': regex },
            { 'customer.name': regex },
            { hotel_name: regex },
            { hotel_expedia_id: regex },
        ];
    }

    return query;
}

/**
 * Filtered, sorted, paged history. Filters and sort are applied in Mongo so
 * they cover the entire collection, not just the current page.
 */
async function queryPayments({ filters, sort, search, limit = 25, skip = 0 } = {}) {
    const query = buildQuery({ filters, search });

    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const safeSkip = Math.max(Number(skip) || 0, 0);

    let sortSpec = { created_at: -1 };
    if (sort && sort.key && SORTABLE_FIELDS.has(sort.key)) {
        sortSpec = { [sort.key]: sort.dir === 'asc' ? 1 : -1 };
    }

    const [items, total, totals] = await Promise.all([
        Payment.find(query)
            .sort(sortSpec)
            .skip(safeSkip)
            .limit(safeLimit)
            .select('-events')
            .populate('created_by', 'first_name last_name email'),
        Payment.countDocuments(query),
        // Totals for the whole filtered set, not just this page.
        Payment.aggregate([
            { $match: query },
            {
                $group: {
                    _id: '$currency',
                    amount: { $sum: '$amount' },
                    captured: { $sum: '$captured_amount' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { amount: -1 } },
        ]),
    ]);

    return {
        items,
        total,
        limit: safeLimit,
        skip: safeSkip,
        totals: totals.map((t) => ({
            currency: t._id,
            amount: Math.round(t.amount * 100) / 100,
            captured: Math.round(t.captured * 100) / 100,
            count: t.count,
        })),
    };
}

/** Distinct values for a field, used to populate the filter checkbox list. */
async function distinctValues({ field, search, limit = 200 }) {
    if (!FILTERABLE_FIELDS[field]) {
        const err = new Error('Field is not filterable');
        err.statusCode = 400;
        throw err;
    }

    const match = { [field]: { $nin: [null, ''] } };
    if (search && String(search).trim()) {
        match[field] = {
            ...match[field],
            $regex: escapeRegex(String(search).trim()),
            $options: 'i',
        };
    }

    const [result] = await Payment.aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        {
            $facet: {
                values: [{ $limit: Math.min(Number(limit) || 200, 500) }],
                total: [{ $count: 'count' }],
            },
        },
    ]);

    const facet = result || {};
    const values = (facet.values || [])
        .map((v) => v._id)
        .filter((v) => v != null && v !== '');

    return {
        values,
        total: (facet.total && facet.total[0] && facet.total[0].count) || 0,
        shown: values.length,
    };
}

/** Restrict a period tab ('week'|'month'|'year'|'all') to a created_at range. */
function buildPeriodMatch(period) {
    if (!period || period === 'all') return null;
    const days = { week: 7, month: 30, year: 365 }[period];
    if (!days) return null;
    return { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

/**
 * Chart data for the dashboard: a daily amount series split by status, plus
 * two breakdowns for the donuts.
 */
async function getAnalytics({ period = 'all' } = {}) {
    const match = {};
    const periodMatch = buildPeriodMatch(period);
    if (periodMatch) match.created_at = periodMatch;

    const [result] = await Payment.aggregate([
        { $match: match },
        {
            $facet: {
                daily: [
                    {
                        $group: {
                            _id: {
                                date: {
                                    $dateToString: {
                                        format: '%Y-%m-%d',
                                        date: '$created_at',
                                        timezone: 'UTC',
                                    },
                                },
                                status: '$status',
                            },
                            amount: { $sum: '$amount' },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { '_id.date': 1 } },
                ],
                by_checkout_mode: [
                    { $group: { _id: '$checkout_mode', count: { $sum: 1 } } },
                ],
                by_portfolio: [
                    { $match: { hotel_portfolio: { $nin: [null, ''] } } },
                    { $group: { _id: '$hotel_portfolio', count: { $sum: 1 } } },
                ],
                by_status: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                by_currency: [
                    {
                        $group: {
                            _id: '$currency',
                            count: { $sum: 1 },
                            amount: { $sum: '$amount' },
                        },
                    },
                ],
            },
        },
    ]);

    const facet = result || {};

    // Pivot [{date, status, amount}] -> [{date, SUCCEEDED: n, CANCELLED: n, ...}]
    const byDate = new Map();
    for (const row of facet.daily || []) {
        const { date, status } = row._id;
        if (!byDate.has(date)) byDate.set(date, { date });
        byDate.get(date)[status] = Math.round(row.amount * 100) / 100;
    }
    const daily_amounts = Array.from(byDate.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
    );

    const toMap = (rows) =>
        (rows || []).reduce((acc, r) => {
            if (r._id) acc[r._id] = r.count;
            return acc;
        }, {});

    return {
        period,
        daily_amounts,
        by_checkout_mode: toMap(facet.by_checkout_mode),
        by_portfolio: toMap(facet.by_portfolio),
        by_status: toMap(facet.by_status),
        by_currency: (facet.by_currency || []).map((c) => ({
            currency: c._id,
            count: c.count,
            amount: Math.round(c.amount * 100) / 100,
        })),
    };
}

async function getStats({ period = 'all' } = {}) {
    const periodMatch = buildPeriodMatch(period);
    const match = periodMatch ? { created_at: periodMatch } : {};

    const [byStatus, totals] = await Promise.all([
        Payment.aggregate([
            { $match: match },
            { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        Payment.aggregate([
            { $match: { ...match, status: 'SUCCEEDED' } },
            {
                $group: {
                    _id: '$currency',
                    captured: { $sum: '$captured_amount' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);

    const statusCounts = byStatus.reduce((acc, row) => {
        acc[row._id] = row.count;
        return acc;
    }, {});

    const total = byStatus.reduce((sum, row) => sum + row.count, 0);

    return {
        period,
        total,
        by_status: statusCounts,
        succeeded: statusCounts.SUCCEEDED || 0,
        captured: totals.map((t) => ({
            currency: t._id,
            amount: Math.round(t.captured * 100) / 100,
            count: t.count,
        })),
    };
}


// ============================================================
//  Bulk payment intent creation
//
//  Each row is one Airwallex API call, so a few hundred rows outlive any
//  sensible HTTP timeout. The work runs in the background against a Batch
//  record that the browser polls.
// ============================================================

// Columns mirror the operator's own booking export so a file can be pasted in
// with no rework. The hotel columns are carried alongside each payment because
// the same export is the source of truth for both.
const BULK_PAYMENT_HEADERS = [
    'Order ID',
    'OTA ID',
    'Portfolio',
    'Property Name',
    'Descriptor',
    'Website',
    'Reservation ID',
    'Hotel Confirmation Code',
    'Customer',
    'Check In',
    'Check Out',
    'Currency',
    'Amount to Charge',
    'Card Number',
    'Expiry date',
    'CVV',
];

const BULK_HEADER_TO_FIELD = {
    // Our own order reference. Optional — generated when blank.
    'order id': 'merchant_order_id',
    order_id: 'merchant_order_id',
    'merchant order id': 'merchant_order_id',

    // Hotel key — 'OTA ID' is what the booking export calls it.
    'ota id': 'ota_id',
    'expedia id': 'ota_id',
    expedia_id: 'ota_id',
    'hotel id': 'ota_id',

    // Hotel definition, used to auto-create properties we do not hold yet.
    portfolio: 'portfolio',
    'property name': 'property_name',
    'hotel name': 'property_name',
    descriptor: 'descriptor',
    website: 'website',

    // Payment
    'reservation id': 'reservation_id',
    reference: 'reference',
    'hotel confirmation code': 'confirmation_code',
    'confirmation code': 'confirmation_code',
    // 'Customer' is the payer on the booking — it becomes both the Airwallex
    // customer name and the cardholder name on the virtual card.
    customer: 'customer_name',
    'customer name': 'customer_name',
    // 'Guest name' is the hotel guest, not the payer — deliberately unmapped.
    'guest email': 'customer_email',
    'customer email': 'customer_email',
    'check in': 'check_in',
    'check out': 'check_out',
    currency: 'currency',
    'amount to charge': 'amount',
    amount: 'amount',
    description: 'description',

    // Virtual-card credentials, stored encrypted for the automated run.
    'card number': 'card_number',
    'card no': 'card_number',
    pan: 'card_number',
    'expiry date': 'card_expiry',
    expiry: 'card_expiry',
    'exp date': 'card_expiry',
    cvv: 'card_cvv',
    cvc: 'card_cvv',
    'security code': 'card_cvv',
};

/**
 * Columns we deliberately refuse to read.
 *
 * The booking export carries raw PANs, expiry dates and CVVs. Storing a CVV is
 * prohibited outright by PCI DSS and holding PANs would drag this service into
 * a compliance scope it is nowhere near. Card data reaches Airwallex only from
 * the shopper's browser, through their iframe — never through us.
 */
// Card columns are now read and stored encrypted (see cardVault). The guest
// name is read but discarded: the payer, not the guest, is what Airwallex needs.
const BULK_IGNORED_HEADERS = ['guest name'];

// No cap on rows: a real booking export is however long it is, and creation
// already runs in the background with per-row progress. The parser's own
// ceiling in xlsx.js is the only structural guard.
const BULK_PAYMENT_ROW_LIMIT = Infinity;

/**
 * Card brands this integration will not charge.
 *
 * Amex rows are skipped rather than failed: a booking export is a whole day's
 * work and rejecting the file over cards that were never going to be charged
 * would make it unusable. They are reported back so nothing disappears quietly.
 */
const BLOCKED_CARD_BRANDS = ['amex'];

function bulkPaymentTemplate() {
    return buildTemplate({
        headers: BULK_PAYMENT_HEADERS,
        example: {
            'Order ID': 'ORD-100234',
            'OTA ID': '1548104',
            Portfolio: 'HYATT',
            'Property Name': 'Andaz San Diego, by Hyatt',
            Descriptor: 'ANDAZ',
            Website: 'https://www.hyatt.com/andaz/en-US',
            'Reservation ID': '2497667019',
            'Hotel Confirmation Code': '150927RA015397',
            Customer: 'Expedia Group',
            'Check In': '2026-07-02',
            'Check Out': '2026-07-03',
            Currency: 'USD',
            'Amount to Charge': '3.20',
            'Card Number': '5567174801604015',
            'Expiry date': '09/29',
            CVV: '945',
        },
    });
}

/**
 * Excel writes dates as a serial number when a sheet is saved straight to CSV.
 * Accept either that or an already-formatted date, and leave anything else
 * alone — these are descriptive, not something to validate hard.
 */
function parseSheetDate(value) {
    const raw = (value == null ? '' : String(value)).trim();
    if (!raw) return '';

    if (/^\d{4,6}(\.\d+)?$/.test(raw)) {
        const serial = Number(raw);
        // Excel's epoch is 1899-12-30. Only treat plausible dates as serials so
        // a numeric confirmation code is never mangled into a date.
        if (serial > 20000 && serial < 80000) {
            const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
            return new Date(ms).toISOString().slice(0, 10);
        }
    }
    return raw;
}

/**
 * Validate a bulk payment CSV without creating anything.
 *
 * Every row is checked and all hotels resolved up front so the operator sees
 * every problem at once. Nothing is sent to Airwallex until this passes —
 * a file that fails halfway would leave real payable intents behind.
 *
 * Rows referencing an OTA ID we do not hold are prepared as new hotels when
 * `autoCreateHotels` is on; the caller is told exactly which properties would
 * be created before anything commits.
 */
async function validateBulkPayments(
    input,
    { autoCreateHotels = true, skipCardChecks = false } = {}
) {
    const { headers, rows: rawRows } = parseTabular(input);
    if (!headers.length) throw badRequest('The file is empty');
    if (!rawRows.length) throw badRequest('The file has a header row but no data rows');

    const ignoredColumns = headers.filter((h) =>
        BULK_IGNORED_HEADERS.includes(String(h).trim().toLowerCase())
    );

    const rows = rawRows.map((row) => {
        const mapped = { __line: row.__line };
        for (const [header, value] of Object.entries(row)) {
            if (header === '__line') continue;
            const field = BULK_HEADER_TO_FIELD[String(header).trim().toLowerCase()];
            if (field) mapped[field] = value;
        }
        return mapped;
    });

    const hotelMap = await hotelService.findByExpediaIds(rows.map((r) => r.ota_id));

    // The reservation id doubles as the Airwallex idempotency key, so anything
    // already created is looked up in one query rather than discovered as a
    // wall of duplicate_request errors halfway through the run.
    const reservationIds = rows
        .map((r) => (r.reservation_id || '').trim())
        .filter(Boolean);
    // Matched on description as well as request_id: rows created before the
    // reservation id became the idempotency key carry a uuid there, and would
    // otherwise go unrecognised and be created a second time.
    // The reservation id doubles as the order id unless the file overrides it —
    // one reservation, one order reference, entered once.
    const fileOrderIds = rows
        .map((r) =>
            normaliseOrderId(r.merchant_order_id) || normaliseOrderId(r.reservation_id)
        )
        .filter(Boolean);
    // Only a settled payment reserves an order id — see assertOrderIdFree.
    const takenOrderIds = new Set(
        (
            await Payment.find({
                merchant_order_id: { $in: fileOrderIds },
                status: { $in: SETTLED_STATUSES },
            })
                .select('merchant_order_id')
                .lean()
        ).map((p) => p.merchant_order_id)
    );

    const existingRows = await Payment.find({
        $or: [
            { request_id: { $in: reservationIds } },
            { description: { $in: reservationIds } },
            // A payment made from the single-payment form carries a generated
            // uuid in request_id and no description, so the order id is the
            // only place its reservation is recorded. Without this, such a row
            // is invisible here and then collides on the order-id check below —
            // turning "already created, skip it" into a hard error that blocks
            // the whole file.
            { merchant_order_id: { $in: reservationIds } },
        ],
    })
        .select('request_id description merchant_order_id payment_intent_id status created_at')
        .sort({ created_at: -1 })
        .lean();

    // Settled payments only: an unpaid attempt no longer blocks the row, it
    // just means the next attempt needs its own idempotency key.
    const settledByReservation = new Map();
    // How many attempts each reservation already has, so a retry can be given a
    // request_id Airwallex has not seen — it rejects a reused one outright
    // rather than replaying the original.
    const attemptsByReservation = new Map();

    for (const row of existingRows) {
        for (const key of [row.request_id, row.description, row.merchant_order_id]) {
            if (!key || !reservationIds.includes(key)) continue;

            attemptsByReservation.set(key, (attemptsByReservation.get(key) || 0) + 1);
            if (SETTLED_STATUSES.includes(row.status) && !settledByReservation.has(key)) {
                settledByReservation.set(key, row);
            }
            // One payment can match on several keys; count it once per row.
            break;
        }
    }

    const errors = [];
    const prepared = [];
    const duplicates = [];
    // Rows left out on purpose — an unsupported card brand, not a mistake.
    const excluded = [];
    // Guards against the same reservation appearing twice in one file, which
    // would otherwise send two intents for one booking.
    const seenReservations = new Map();
    // Catches the same order id twice inside one file.
    const seenOrderIds = new Map();
    // Properties in the file that we do not hold yet, keyed by OTA ID so the
    // same hotel repeated across many bookings is only created once.
    const newHotels = new Map();

    for (const row of rows) {
        const line = row.__line;
        const otaId = (row.ota_id || '').trim();

        if (!otaId) {
            errors.push({ line, error: 'OTA ID is required' });
            continue;
        }

        let hotel = hotelMap.get(otaId) || null;
        let pendingHotel = newHotels.get(otaId) || null;

        if (!hotel && !pendingHotel) {
            if (!autoCreateHotels) {
                errors.push({ line, error: `No hotel found with OTA ID ${otaId}` });
                continue;
            }
            // Auto-create needs the property's own columns to be present.
            const missing = ['portfolio', 'property_name', 'descriptor'].filter(
                (f) => !String(row[f] || '').trim()
            );
            if (missing.length) {
                const labels = { portfolio: 'Portfolio', property_name: 'Property Name', descriptor: 'Descriptor' };
                errors.push({
                    line,
                    error: `OTA ID ${otaId} is not in the system yet — add ${missing
                        .map((f) => labels[f])
                        .join(', ')} to create it`,
                });
                continue;
            }

            const descriptor = String(row.descriptor).trim();
            if (descriptor.length > airwallex.DESCRIPTOR_MAX_LENGTH) {
                errors.push({
                    line,
                    error: `Descriptor "${descriptor}" is longer than ${airwallex.DESCRIPTOR_MAX_LENGTH} characters`,
                });
                continue;
            }

            pendingHotel = {
                expedia_id: otaId,
                portfolio: String(row.portfolio).trim(),
                name: String(row.property_name).trim(),
                descriptor,
                website: hotelService.normaliseWebsite(row.website),
                line,
            };
            newHotels.set(otaId, pendingHotel);
        }

        if (hotel && hotel.status === 'archived') {
            errors.push({ line, error: `${hotel.name} (${otaId}) is archived` });
            continue;
        }

        // Checked before the order id. A row created on an earlier run keys its
        // order id to its own existing payment, so checking order ids first
        // reported a re-upload as a clash instead of skipping it.
        const reservationId = (row.reservation_id || '').trim();

        if (reservationId) {
            if (reservationId.length > 64) {
                errors.push({
                    line,
                    error: `Reservation ID "${reservationId}" is longer than 64 characters`,
                });
                continue;
            }
            if (seenReservations.has(reservationId)) {
                errors.push({
                    line,
                    error: `Reservation ID ${reservationId} appears twice (also on line ${seenReservations.get(
                        reservationId
                    )})`,
                });
                continue;
            }
            seenReservations.set(reservationId, line);

            // Already created on an earlier run — skip rather than fail. This is
            // what makes re-uploading the same file safe.
            // Already paid: there is nothing left to do for this booking, and
            // charging it again is the one mistake with no undo.
            const settled = settledByReservation.get(reservationId);
            if (settled) {
                duplicates.push({
                    line,
                    reservation_id: reservationId,
                    payment_intent_id: settled.payment_intent_id,
                    status: settled.status,
                    created_at: settled.created_at,
                });
                continue;
            }
        }

        // Explicit Order ID column wins; otherwise the reservation id is the
        // order id. Blank both and one is generated at creation time.
        const orderId =
            normaliseOrderId(row.merchant_order_id) || normaliseOrderId(row.reservation_id);
        if (orderId) {
            if (orderId.length > ORDER_ID_MAX_LENGTH) {
                errors.push({
                    line,
                    error: `Order ID "${orderId}" is longer than ${ORDER_ID_MAX_LENGTH} characters`,
                });
                continue;
            }
            if (seenOrderIds.has(orderId)) {
                errors.push({
                    line,
                    error: `Order ID ${orderId} appears twice (also on line ${seenOrderIds.get(
                        orderId
                    )})`,
                });
                continue;
            }
            if (takenOrderIds.has(orderId)) {
                errors.push({
                    line,
                    error: `Order ID ${orderId} already belongs to a payment for a different reservation — give this row its own Order ID`,
                });
                continue;
            }
            seenOrderIds.set(orderId, line);
        }

        const amount = roundAmount(row.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            errors.push({ line, error: `Amount "${row.amount || ''}" is not a positive number` });
            continue;
        }

        const currency = (row.currency || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
            errors.push({ line, error: `Currency "${row.currency || ''}" must be a 3-letter ISO code` });
            continue;
        }

        // Exactly what the form does: the property's website becomes the
        // reference, and the property's descriptor becomes the descriptor.
        // An explicit Reference column still wins, mirroring the form's
        // "auto-filled unless the operator typed something" rule.
        const reference =
            (row.reference || '').trim() ||
            (hotel ? hotel.website : pendingHotel.website) ||
            '';
        const descriptor = airwallex.buildDescriptor({
            prefix: hotel ? hotel.descriptor : pendingHotel.descriptor,
        });

        // Card details are optional at validate time — a batch without them can
        // still be paid by hand — but a malformed one is rejected rather than
        // discovered mid-run by the automation.
        let card = null;
        const rawPan = cardVault.normalisePan(row.card_number);
        if (rawPan || row.card_expiry || row.card_cvv) {
            if (!cardVault.isConfigured()) {
                errors.push({
                    line,
                    error: 'CARD_ENCRYPTION_KEY is not set — card details cannot be stored',
                });
                continue;
            }

            // Checked before the checksum: an unsupported brand is a skip, and
            // reporting a malformed number on a card we would not charge anyway
            // is noise.
            const brand = cardVault.brandOf(rawPan);
            if (BLOCKED_CARD_BRANDS.includes(brand)) {
                excluded.push({
                    line,
                    reason: `${brand === 'amex' ? 'American Express' : brand} is not supported`,
                    brand,
                    card_last4: rawPan.slice(-4),
                    ota_id: otaId,
                    reservation_id: (row.reservation_id || '').trim() || undefined,
                });
                continue;
            }
            // Skippable: a closed-loop virtual card scheme may not use Luhn at
            // all. Off by default, because the check earns its keep catching
            // mistyped digits before a run wastes a real attempt.
            if (!skipCardChecks && !cardVault.luhnValid(rawPan)) {
                errors.push({
                    line,
                    error: `Card ending ${rawPan.slice(-4) || '????'}: ${cardVault.describePanProblem(
                        rawPan
                    )}`,
                });
                continue;
            }
            if (!rawPan) {
                errors.push({ line, error: 'Card number is missing' });
                continue;
            }
            const expiry = cardVault.normaliseExpiry(row.card_expiry);
            if (!expiry) {
                errors.push({
                    line,
                    error: `Expiry "${row.card_expiry || ''}" is not a readable date`,
                });
                continue;
            }
            if (cardVault.expiryPassed(expiry)) {
                errors.push({ line, error: `Card expired ${expiry}` });
                continue;
            }
            const cvv = cardVault.normaliseCvv(row.card_cvv);
            if (cvv.length < 3 || cvv.length > 4) {
                errors.push({ line, error: 'CVV must be 3 or 4 digits' });
                continue;
            }
            card = { pan: rawPan, expiry, cvv };
        }

        const checkIn = parseSheetDate(row.check_in);
        const checkOut = parseSheetDate(row.check_out);
        const confirmation = (row.confirmation_code || '').trim();
        // The reservation id is how a transaction gets identified internally,
        // so it is the description. An explicit Description column overrides it.
        const description = (row.description || '').trim() || reservationId;

        // The reservation id is the idempotency key for the first attempt. A
        // retry of a failed booking is a genuinely new request, so it is
        // suffixed — Airwallex refuses a reused request_id rather than
        // replaying it, which would otherwise make every retry impossible.
        const priorAttempts = attemptsByReservation.get(reservationId) || 0;
        const requestId = reservationId
            ? priorAttempts
                ? `${reservationId}-r${priorAttempts + 1}`.slice(0, 64)
                : reservationId
            : undefined;

        prepared.push({
            line,
            ota_id: otaId,
            request_id: requestId,
            // How many times this booking has been tried before, so the
            // operator can see a retry for what it is.
            attempt: priorAttempts + 1,
            merchant_order_id: orderId || undefined,
            hotel_id: hotel ? hotel._id : undefined,
            hotel_name: hotel ? hotel.name : pendingHotel.name,
            hotel_is_new: !hotel,
            amount,
            currency,
            reference: reference || undefined,
            description: description || undefined,
            descriptor,
            customer: {
                name: (row.customer_name || '').trim() || undefined,
                email: (row.customer_email || '').trim() || undefined,
            },
            // Held separately from `customer` because it is also the name that
            // goes on the card during the automated run.
            customer_label: (row.customer_name || '').trim() || undefined,
            card,
            has_card: !!card,
            // Booking detail is kept as metadata rather than squeezed into the
            // description, so it stays queryable on the intent.
            metadata: {
                ...(reservationId ? { reservation_id: reservationId } : {}),
                ...(confirmation ? { confirmation_code: confirmation } : {}),
                ...(checkIn ? { check_in: checkIn } : {}),
                ...(checkOut ? { check_out: checkOut } : {}),
            },
        });
    }

    const totals = prepared.reduce((acc, r) => {
        acc[r.currency] = Math.round(((acc[r.currency] || 0) + r.amount) * 100) / 100;
        return acc;
    }, {});

    return {
        valid: errors.length === 0,
        total: rows.length,
        ready: prepared.length,
        // Not errors: these rows were created by an earlier run and are skipped.
        duplicates: duplicates.sort((a, b) => a.line - b.line),
        // Not errors either: rows deliberately left out, e.g. an unsupported card.
        excluded: excluded.sort((a, b) => a.line - b.line),
        errors: errors.sort((a, b) => a.line - b.line),
        // Only the last four reach the client — the preview is for eyeballing a
        // file, not for reading card numbers back out.
        preview: prepared.slice(0, 10).map((row) => ({
            ...row,
            card: undefined,
            card_last4: row.card ? row.card.pan.slice(-4) : undefined,
            card_expiry: row.card ? row.card.expiry : undefined,
        })),
        cards_present: prepared.filter((r) => r.has_card).length,
        totals: Object.entries(totals).map(([currency, amount]) => ({ currency, amount })),
        ignored_columns: ignoredColumns,
        hotels_to_create: [...newHotels.values()].map((h) => ({
            expedia_id: h.expedia_id,
            portfolio: h.portfolio,
            name: h.name,
            descriptor: h.descriptor,
            website: h.website,
        })),
        prepared,
        newHotels: [...newHotels.values()],
    };
}

/**
 * Validate, then create every intent in the background.
 * Returns the batch immediately; poll getBatch() for progress.
 */
async function startBulkPayments(
    input,
    {
        userId,
        checkout_mode = 'embedded_elements',
        autoCreateHotels = true,
        skipCardChecks = false,
        fileName = 'upload.csv',
        fileSize = 0,
    } = {}
) {
    const validation = await validateBulkPayments(input, { autoCreateHotels, skipCardChecks });
    if (!validation.valid) {
        const err = new Error('The file has errors — fix them and upload again');
        err.statusCode = 400;
        err.details = validation.errors;
        throw err;
    }

    // Create any missing properties before the intents, so every row has a real
    // hotel to point at. Done up front rather than per row: the same property
    // repeats across many bookings, and a half-created set would leave payments
    // orphaned from their hotel.
    let hotelsCreated = 0;
    if (validation.newHotels.length) {
        const operations = validation.newHotels.map((h) => ({
            updateOne: {
                filter: { expedia_id: h.expedia_id },
                update: {
                    $set: {
                        portfolio: h.portfolio,
                        name: h.name,
                        descriptor: h.descriptor,
                        ...(h.website ? { website: h.website } : {}),
                        updated_by: userId,
                    },
                    $setOnInsert: { created_by: userId, status: 'active' },
                },
                upsert: true,
            },
        }));
        const result = await Hotel.bulkWrite(operations);
        hotelsCreated = result.upsertedCount || 0;

        // Re-resolve so the prepared rows carry real ids.
        const created = await Hotel.find({
            expedia_id: { $in: validation.newHotels.map((h) => h.expedia_id) },
        });
        const byOta = new Map(created.map((h) => [h.expedia_id, h]));
        for (const row of validation.prepared) {
            if (!row.hotel_id) {
                const hotel = byOta.get(row.ota_id);
                if (hotel) row.hotel_id = hotel._id;
            }
        }
    }

    if (!validation.prepared.length) {
        const err = new Error(
            validation.duplicates.length
                ? `Every row was already created on an earlier run — nothing to do`
                : validation.excluded.length
                  ? 'Every row was excluded — no supported cards in that file'
                  : 'There is nothing to create in that file'
        );
        err.statusCode = 409;
        throw err;
    }

    const job = await Batch.create({
        file_name: fileName,
        file_size: fileSize,
        status: 'creating',
        total_rows: validation.prepared.length,
        hotels_created: hotelsCreated,
        created_by: userId,
        started_at: new Date(),
    });

    // Deliberately not awaited: the HTTP response returns the job id now and
    // the browser polls. Failures are recorded on the job, never thrown into
    // an unhandled rejection.
    runBulkPayments(job._id, validation.prepared, {
        userId,
        checkout_mode,
        fileLabel: fileName,
    }).catch(
        async (err) => {
            console.error('Bulk payment job crashed:', err);
            await Batch.findByIdAndUpdate(job._id, {
                status: 'failed',
                error: err.message,
                finished_at: new Date(),
            }).catch(() => {});
        }
    );

    return job;
}

async function runBulkPayments(jobId, prepared, { userId, checkout_mode, fileLabel }) {
    await Batch.findByIdAndUpdate(jobId, { status: 'creating', started_at: new Date() });

    const results = [];
    let succeeded = 0;
    let failed = 0;

    // Sequential on purpose: Airwallex rate-limits, and a burst of parallel
    // creates risks throttling that would fail rows for no good reason.
    for (const row of prepared) {
        try {
            const { payment } = await createPayment({
                amount: row.amount,
                currency: row.currency,
                reference: row.reference,
                description: row.description,
                hotel_id: row.hotel_id,
                customer: row.customer,
                metadata: row.metadata,
                request_id: row.request_id,
                merchant_order_id: row.merchant_order_id,
                checkout_mode,
                created_by: userId,
                batch: jobId,
                batch_name: fileLabel,
                card: row.card,
                customer_label: row.customer_label,
            });

            results.push({
                line: row.line,
                ok: true,
                ota_id: row.ota_id,
                reservation_id: row.description || row.request_id,
                payment_intent_id: payment.payment_intent_id,
                merchant_order_id: payment.merchant_order_id,
            });
            succeeded += 1;
        } catch (err) {
            results.push({
                line: row.line,
                ok: false,
                ota_id: row.ota_id,
                reservation_id: row.description || row.request_id,
                error: err.message,
            });
            failed += 1;
        }

        // Persist progress as we go so the poller shows real movement and a
        // crash leaves behind an accurate partial record.
        await Batch.findByIdAndUpdate(jobId, {
            processed: results.length,
            succeeded,
            failed,
            results,
        }).catch(() => {});
    }

    await Batch.findByIdAndUpdate(jobId, {
        status: 'ready',
        processed: results.length,
        succeeded,
        failed,
        results,
        finished_at: new Date(),
    });
}

async function getBatch(id) {
    const job = await Batch.findById(id).catch(() => null);
    if (!job) {
        const err = new Error('Batch not found');
        err.statusCode = 404;
        throw err;
    }
    return job;
}

async function listBatches({ limit = 10 } = {}) {
    const items = await Batch.find({})
        .sort({ created_at: -1 })
        .limit(Math.min(Number(limit) || 10, 50))
        .select('-results')
        .populate('created_by', 'first_name last_name email');
    return { items };
}

/**
 * Mark jobs left mid-flight by a restart as failed.
 *
 * Jobs run in-process, so a deploy or crash abandons anything running. Without
 * this sweep those rows would poll forever against a job nothing is advancing.
 */
async function failStaleBatches() {
    const result = await Batch.updateMany(
        { status: { $in: ['creating', 'paying'] } },
        {
            $set: {
                status: 'failed',
                error: 'Interrupted by a server restart — re-upload the remaining rows',
                finished_at: new Date(),
            },
        }
    );
    if (result.modifiedCount) {
        console.warn(`Marked ${result.modifiedCount} interrupted batch(es) as failed`);
    }
    return result.modifiedCount || 0;
}


// ============================================================
//  Delete + export
// ============================================================

/** Statuses representing money that actually moved. */
const SETTLED_STATUSES = ['SUCCEEDED', 'REQUIRES_CAPTURE'];

/**
 * Delete local payment records.
 *
 * Deleting is for cleaning up a bad import, so unpaid intents are cancelled at
 * Airwallex first — otherwise the local row disappears while a payable intent
 * lives on, and a shopper with the old link could still be charged for
 * something we no longer have any record of.
 *
 * A payment that took money is refused unless `force` is set: the local record
 * is the only durable account of that charge once Airwallex's retention lapses.
 */
async function deletePayments(ids, { force = false } = {}) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
    if (!list.length) throw badRequest('No payments selected');
    // No cap: a batch delete passes every payment in the file, which can be
    // thousands. Airwallex cancels are sequential, so a large one simply takes
    // a while rather than being refused.

    const payments = await Payment.find({
        $or: [
            { payment_intent_id: { $in: list } },
            { merchant_order_id: { $in: list } },
            {
                _id: {
                    $in: list.filter((id) => /^[0-9a-fA-F]{24}$/.test(id)),
                },
            },
        ],
    });

    const results = [];
    const deletable = [];

    for (const payment of payments) {
        if (SETTLED_STATUSES.includes(payment.status) && !force) {
            results.push({
                payment_intent_id: payment.payment_intent_id,
                deleted: false,
                error: `${payment.status.toLowerCase()} — money moved; deleting would destroy the only durable record`,
            });
            continue;
        }
        deletable.push(payment);
    }

    for (const payment of deletable) {
        let cancelled = false;
        // Best effort: a cancel that fails must not block the cleanup, but the
        // outcome is reported so an orphaned intent is visible.
        if (!SETTLED_STATUSES.includes(payment.status) && payment.status !== 'CANCELLED') {
            try {
                await airwallex.cancelPaymentIntent(payment.payment_intent_id, {
                    cancellation_reason: 'abandoned',
                });
                cancelled = true;
            } catch (err) {
                results.push({
                    payment_intent_id: payment.payment_intent_id,
                    deleted: true,
                    cancelled: false,
                    warning: `Deleted locally, but the Airwallex intent could not be cancelled: ${err.message}`,
                });
            }
        }

        await Payment.deleteOne({ _id: payment._id });
        if (!results.some((r) => r.payment_intent_id === payment.payment_intent_id)) {
            results.push({
                payment_intent_id: payment.payment_intent_id,
                deleted: true,
                cancelled,
            });
        }
    }

    const missing = list.filter(
        (id) =>
            !payments.some(
                (p) =>
                    p.payment_intent_id === id ||
                    p.merchant_order_id === id ||
                    String(p._id) === id
            )
    );

    return {
        requested: list.length,
        deleted: results.filter((r) => r.deleted).length,
        refused: results.filter((r) => !r.deleted).length,
        not_found: missing.length,
        results,
    };
}

// Column order for the exported report.
const EXPORT_HEADERS = [
    'Payment Intent ID',
    'Order ID',
    'Status',
    'Attempt Status',
    'Failure Code',
    'Failure Reason',
    'Amount',
    'Currency',
    'Captured',
    'Descriptor',
    'Reference',
    'Description',
    'OTA ID',
    'Hotel',
    'Portfolio',
    'Customer Name',
    'Customer Email',
    'Card Brand',
    'Card Last4',
    'Batch',
    'Created',
    'Last Synced',
];

function toExportRow(p) {
    return {
        'Payment Intent ID': p.payment_intent_id,
        'Order ID': p.merchant_order_id,
        Status: p.status,
        'Attempt Status': p.last_attempt_status || '',
        'Failure Code': (p.last_error && p.last_error.code) || '',
        'Failure Reason': (p.last_error && p.last_error.message) || '',
        Amount: p.amount,
        Currency: p.currency,
        Captured: p.captured_amount || 0,
        Descriptor: p.descriptor || '',
        Reference: p.reference || '',
        Description: p.description || '',
        'OTA ID': p.hotel_expedia_id || '',
        Hotel: p.hotel_name || '',
        Portfolio: p.hotel_portfolio || '',
        'Customer Name': (p.customer && p.customer.name) || '',
        'Customer Email': (p.customer && p.customer.email) || '',
        'Card Brand': p.card_brand || '',
        'Card Last4': p.card_last4 || '',
        Batch: p.batch_name || '',
        Created: p.created_at ? new Date(p.created_at).toISOString() : '',
        'Last Synced': p.last_synced_at ? new Date(p.last_synced_at).toISOString() : '',
    };
}

/**
 * Export payments as CSV — either an explicit selection, or everything matching
 * the caller's current filters. Exporting the filtered set rather than the
 * visible page is the point: the table shows 25 rows, the report should not.
 */
async function exportPayments({ ids, filters, search, sort } = {}) {
    let query;
    if (Array.isArray(ids) && ids.length) {

        query = {
            $or: [
                { payment_intent_id: { $in: ids } },
                {
                    _id: {
                        $in: ids.filter((id) => /^[0-9a-fA-F]{24}$/.test(id)),
                    },
                },
            ],
        };
    } else {
        query = buildQuery({ filters, search });
    }

    let sortSpec = { created_at: -1 };
    if (sort && sort.key && SORTABLE_FIELDS.has(sort.key)) {
        sortSpec = { [sort.key]: sort.dir === 'asc' ? 1 : -1 };
    }

    const rows = await Payment.find(query).sort(sortSpec).select('-events -api_log').lean();
    return {
        csv: toCsv({ headers: EXPORT_HEADERS, rows: rows.map(toExportRow) }),
        count: rows.length,
    };
}

module.exports = {
    prepareCard,
    FILTERABLE_FIELDS,
    BLOCKED_CARD_BRANDS,
    ORDER_ID_MAX_LENGTH,
    getPaymentByPublicToken,
    assertOrderIdFree,
    normaliseOrderId,
    deletePayments,
    exportPayments,
    EXPORT_HEADERS,
    PAYABLE_STATUSES,
    getCheckoutSession,
    BULK_PAYMENT_HEADERS,
    BULK_PAYMENT_ROW_LIMIT,
    bulkPaymentTemplate,
    validateBulkPayments,
    startBulkPayments,
    getBatch,
    listBatches,
    failStaleBatches,
    createPayment,
    queryPayments,
    distinctValues,
    getAnalytics,
    listPayments,
    getPayment,
    syncPayment,
    cancelPayment,
    handleWebhookEvent,
    getStats,
};
