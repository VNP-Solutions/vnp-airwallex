const crypto = require('crypto');

const Payment = require('../models/Payment');
const Hotel = require('../models/Hotel');
const BulkJob = require('../models/BulkJob');
// Required for its side effect: listPayments/getPayment populate `created_by`,
// which needs the User model registered on the mongoose instance. Without this
// the service works inside the server (userRoutes pulls it in) but throws
// "Schema hasn't been registered" from a standalone script or job.
require('../models/User');
const airwallex = require('./airwallexService');
const hotelService = require('./hotelService');
const { buildTemplate } = require('./csv');
const { parseTabular } = require('./tabular');

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
    if (attempt && attempt.payment_method) {
        const method = attempt.payment_method;
        if (method.type) payment.payment_method_type = method.type;
        if (method.card) {
            if (method.card.brand) payment.card_brand = method.card.brand;
            if (method.card.last4) payment.card_last4 = method.card.last4;
        }
    }

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
    bulk_job,
    request_id: requestId,
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

    const merchant_order_id = generateOrderId();

    // The idempotency key. Callers pass the reservation id — unique per
    // transaction — so a re-run of the same booking cannot charge twice.
    // Airwallex rejects a reused request_id outright (it does NOT replay the
    // original intent), which is what makes this a real guard.
    const request_id = (requestId || '').trim() || crypto.randomUUID();
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

    let intent;
    try {
        intent = await airwallex.createPaymentIntent({
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
            merchant_order_id
        )}`,
        });
    } catch (err) {
        // Surfaces when a reservation is submitted twice. Airwallex's own guard
        // caught it, so nothing was charged — say so plainly rather than
        // leaking "duplicate_request".
        if (err.airwallex && err.airwallex.code === 'duplicate_request') {
            const clash = new Error(
                `A payment already exists for reference ${request_id} — nothing was charged again`
            );
            clash.statusCode = 409;
            throw clash;
        }
        throw err;
    }

    const payment = new Payment({
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
        bulk_job: bulk_job || undefined,
        customer: cleanCustomer,
        metadata: metadata || {},
        created_by,
        intent_created_at: intent.created_at ? new Date(intent.created_at) : undefined,
        intent_updated_at: intent.updated_at ? new Date(intent.updated_at) : undefined,
        last_synced_at: new Date(),
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

    // client_secret is deliberately not persisted — it is a short-lived
    // client-side credential, handed straight to the browser and never stored.
    return {
        payment,
        checkout: {
            intent_id: intent.id,
            client_secret: intent.client_secret,
            currency: payment.currency,
            amount: payment.amount,
            env: airwallex.env(),
            mode: checkout_mode,
            successUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                merchant_order_id
            )}&outcome=success`,
            cancelUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                merchant_order_id
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
    const intent = await airwallex.retrievePaymentIntent(payment.payment_intent_id);
    applyIntent(payment, intent, { source: 'sync' });
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
    const intent = await airwallex.retrievePaymentIntent(payment.payment_intent_id);

    applyIntent(payment, intent, { source: 'sync' });
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
            merchant_order_id: payment.merchant_order_id,
            descriptor: payment.descriptor,
            description: payment.description,
            successUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                payment.merchant_order_id
            )}&outcome=success`,
            cancelUrl: `${appBaseUrl()}/payment-result?order=${encodeURIComponent(
                payment.merchant_order_id
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

    const intent = await airwallex.cancelPaymentIntent(payment.payment_intent_id, {
        cancellation_reason: reason,
    });
    applyIntent(payment, intent, {
        source: 'sync',
        eventName: 'payment_intent.cancelled',
    });
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
            const intent = await airwallex.retrievePaymentIntent(intentId);
            applyIntent(payment, intent, { source: 'webhook' });
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

    amount: 'number',
    captured_amount: 'number',

    status: 'enum',
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
            if (cond !== null) query[field] = cond;
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
//  sensible HTTP timeout. The work runs in the background against a BulkJob
//  record that the browser polls.
// ============================================================

// Columns mirror the operator's own booking export so a file can be pasted in
// with no rework. The hotel columns are carried alongside each payment because
// the same export is the source of truth for both.
const BULK_PAYMENT_HEADERS = [
    'OTA ID',
    'Portfolio',
    'Property Name',
    'Descriptor',
    'Website',
    'Reservation ID',
    'Hotel Confirmation Code',
    'Guest Name',
    'Check In',
    'Check Out',
    'Currency',
    'Amount to Charge',
];

const BULK_HEADER_TO_FIELD = {
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
    'guest name': 'customer_name',
    'customer name': 'customer_name',
    'guest email': 'customer_email',
    'customer email': 'customer_email',
    'check in': 'check_in',
    'check out': 'check_out',
    currency: 'currency',
    'amount to charge': 'amount',
    amount: 'amount',
    description: 'description',
};

/**
 * Columns we deliberately refuse to read.
 *
 * The booking export carries raw PANs, expiry dates and CVVs. Storing a CVV is
 * prohibited outright by PCI DSS and holding PANs would drag this service into
 * a compliance scope it is nowhere near. Card data reaches Airwallex only from
 * the shopper's browser, through their iframe — never through us.
 */
const BULK_IGNORED_HEADERS = [
    'card number',
    'card no',
    'pan',
    'expiry date',
    'expiry',
    'exp date',
    'cvv',
    'cvc',
    'security code',
];

const BULK_PAYMENT_ROW_LIMIT = 500;

function bulkPaymentTemplate() {
    return buildTemplate({
        headers: BULK_PAYMENT_HEADERS,
        example: {
            'OTA ID': '1548104',
            Portfolio: 'HYATT',
            'Property Name': 'Andaz San Diego, by Hyatt',
            Descriptor: 'ANDAZ',
            Website: 'https://www.hyatt.com/andaz/en-US',
            'Reservation ID': '2497667019',
            'Hotel Confirmation Code': '150927RA015397',
            'Guest Name': 'Syamak Tabrizi',
            'Check In': '2026-07-02',
            'Check Out': '2026-07-03',
            Currency: 'USD',
            'Amount to Charge': '3.20',
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
async function validateBulkPayments(input, { autoCreateHotels = true } = {}) {
    const { headers, rows: rawRows } = parseTabular(input);
    if (!headers.length) throw badRequest('The file is empty');
    if (!rawRows.length) throw badRequest('The file has a header row but no data rows');
    if (rawRows.length > BULK_PAYMENT_ROW_LIMIT) {
        throw badRequest(
            `Too many rows — the limit is ${BULK_PAYMENT_ROW_LIMIT} payments per file`
        );
    }

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
    const existingRows = await Payment.find({
        $or: [
            { request_id: { $in: reservationIds } },
            { description: { $in: reservationIds } },
        ],
    })
        .select('request_id description payment_intent_id status created_at')
        .lean();

    const existingByReservation = new Map();
    for (const row of existingRows) {
        for (const key of [row.request_id, row.description]) {
            if (key && reservationIds.includes(key) && !existingByReservation.has(key)) {
                existingByReservation.set(key, row);
            }
        }
    }

    const errors = [];
    const prepared = [];
    const duplicates = [];
    // Guards against the same reservation appearing twice in one file, which
    // would otherwise send two intents for one booking.
    const seenReservations = new Map();
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

        const checkIn = parseSheetDate(row.check_in);
        const checkOut = parseSheetDate(row.check_out);
        const confirmation = (row.confirmation_code || '').trim();
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
            const existing = existingByReservation.get(reservationId);
            if (existing) {
                duplicates.push({
                    line,
                    reservation_id: reservationId,
                    payment_intent_id: existing.payment_intent_id,
                    status: existing.status,
                    created_at: existing.created_at,
                });
                continue;
            }
        }

        // The reservation id is how a transaction gets identified internally,
        // so it is the description. An explicit Description column overrides it.
        const description = (row.description || '').trim() || reservationId;

        prepared.push({
            line,
            ota_id: otaId,
            // Reservation id is unique per transaction, so it is the
            // idempotency key sent to Airwallex.
            request_id: reservationId || undefined,
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
        errors: errors.sort((a, b) => a.line - b.line),
        preview: prepared.slice(0, 10),
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
 * Returns the job immediately; poll getBulkJob() for progress.
 */
async function startBulkPayments(
    input,
    { userId, checkout_mode = 'embedded_elements', autoCreateHotels = true } = {}
) {
    const validation = await validateBulkPayments(input, { autoCreateHotels });
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
                : 'There is nothing to create in that file'
        );
        err.statusCode = 409;
        throw err;
    }

    const job = await BulkJob.create({
        type: 'payments_create',
        status: 'queued',
        total: validation.prepared.length,
        hotels_created: hotelsCreated,
        created_by: userId,
    });

    // Deliberately not awaited: the HTTP response returns the job id now and
    // the browser polls. Failures are recorded on the job, never thrown into
    // an unhandled rejection.
    runBulkPayments(job._id, validation.prepared, { userId, checkout_mode }).catch(
        async (err) => {
            console.error('Bulk payment job crashed:', err);
            await BulkJob.findByIdAndUpdate(job._id, {
                status: 'failed',
                error: err.message,
                finished_at: new Date(),
            }).catch(() => {});
        }
    );

    return job;
}

async function runBulkPayments(jobId, prepared, { userId, checkout_mode }) {
    await BulkJob.findByIdAndUpdate(jobId, {
        status: 'running',
        started_at: new Date(),
    });

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
                checkout_mode,
                created_by: userId,
                bulk_job: jobId,
            });

            results.push({
                line: row.line,
                ok: true,
                expedia_id: row.ota_id,
                reference: row.reference,
                payment_intent_id: payment.payment_intent_id,
                merchant_order_id: payment.merchant_order_id,
            });
            succeeded += 1;
        } catch (err) {
            results.push({
                line: row.line,
                ok: false,
                expedia_id: row.ota_id,
                reference: row.reference,
                error: err.message,
            });
            failed += 1;
        }

        // Persist progress as we go so the poller shows real movement and a
        // crash leaves behind an accurate partial record.
        await BulkJob.findByIdAndUpdate(jobId, {
            processed: results.length,
            succeeded,
            failed,
            results,
        }).catch(() => {});
    }

    await BulkJob.findByIdAndUpdate(jobId, {
        status: 'completed',
        processed: results.length,
        succeeded,
        failed,
        results,
        finished_at: new Date(),
    });
}

async function getBulkJob(id) {
    const job = await BulkJob.findById(id).catch(() => null);
    if (!job) {
        const err = new Error('Job not found');
        err.statusCode = 404;
        throw err;
    }
    return job;
}

async function listBulkJobs({ limit = 10 } = {}) {
    const items = await BulkJob.find({ type: 'payments_create' })
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
async function failStaleBulkJobs() {
    const result = await BulkJob.updateMany(
        { status: { $in: ['queued', 'running'] } },
        {
            $set: {
                status: 'failed',
                error: 'Interrupted by a server restart — re-upload the remaining rows',
                finished_at: new Date(),
            },
        }
    );
    if (result.modifiedCount) {
        console.warn(`Marked ${result.modifiedCount} interrupted bulk job(s) as failed`);
    }
    return result.modifiedCount || 0;
}

module.exports = {
    FILTERABLE_FIELDS,
    PAYABLE_STATUSES,
    getCheckoutSession,
    BULK_PAYMENT_HEADERS,
    BULK_PAYMENT_ROW_LIMIT,
    bulkPaymentTemplate,
    validateBulkPayments,
    startBulkPayments,
    getBulkJob,
    listBulkJobs,
    failStaleBulkJobs,
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
