const paymentService = require('../services/paymentService');
const paymentRunner = require('../services/paymentRunner');
const airwallex = require('../services/airwallexService');

async function createPayment(req, res, next) {
    try {
        const {
            amount,
            currency,
            reference,
            description,
            descriptor,
            descriptor_prefix,
            hotel_id,
            expedia_id,
            customer,
            checkout_mode,
            metadata,
            request_id,
            merchant_order_id,
            card,
        } = req.body || {};

        if (amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: 'amount is required' });
        }
        if (!currency) {
            return res.status(400).json({ error: 'currency is required' });
        }

        // Validated and normalised here, before anything reaches Airwallex, so
        // a mistyped card is a 400 rather than an intent nobody can pay.
        let storedCard;
        try {
            storedCard = paymentService.prepareCard(card);
        } catch (err) {
            return res.status(400).json({ error: err.message });
        }

        const { payment, checkout } = await paymentService.createPayment({
            amount,
            currency,
            reference,
            description,
            descriptor,
            descriptor_prefix,
            hotel_id,
            expedia_id,
            customer,
            checkout_mode,
            metadata,
            request_id,
            merchant_order_id,
            card: storedCard,
            customer_label: (customer && customer.name) || undefined,
            created_by: req.userId,
        });

        return res.status(201).json({ payment, checkout });
    } catch (err) {
        return next(err);
    }
}

async function listPayments(req, res, next) {
    try {
        const { q, status, checkout_mode, sort, limit, skip } = req.query;
        const result = await paymentService.listPayments({
            q,
            status,
            checkout_mode,
            sort,
            limit,
            skip,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function getPayment(req, res, next) {
    try {
        const payment = await paymentService.getPayment(req.params.id);
        return res.json(payment);
    } catch (err) {
        return next(err);
    }
}

async function syncPayment(req, res, next) {
    try {
        const payment = await paymentService.syncPayment(req.params.id);
        return res.json(payment);
    } catch (err) {
        return next(err);
    }
}

/** Re-open checkout for an unpaid payment, with a freshly minted client_secret. */
function appBaseUrl(req) {
    // The automation drives our own checkout page, so it needs a URL the
    // headless browser can actually reach. Mirrors batchController.
    return (
        process.env.AUTOMATION_BASE_URL ||
        process.env.APP_BASE_URL ||
        `${req.protocol}://${req.get('host')}`
    ).replace(/\/$/, '');
}

/**
 * Pay one payment with the server-side browser automation.
 *
 * Awaited rather than backgrounded: it is a single payment and the operator is
 * watching the button. Takes roughly half a minute.
 */
async function payAutomated(req, res, next) {
    try {
        const result = await paymentRunner.paySingle(req.params.id, {
            headless: (req.body || {}).headless !== false,
            baseUrl: appBaseUrl(req),
        });
        return res.json(result);
    } catch (err) {
        if (err.statusCode === 409 || err.statusCode === 404) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        return next(err);
    }
}

async function getCheckoutSession(req, res, next) {
    try {
        const { payment, checkout } = await paymentService.getCheckoutSession(
            req.params.id
        );
        return res.json({ payment, checkout });
    } catch (err) {
        return next(err);
    }
}

async function cancelPayment(req, res, next) {
    try {
        const payment = await paymentService.cancelPayment(req.params.id, {
            reason: (req.body || {}).reason,
        });
        return res.json(payment);
    } catch (err) {
        return next(err);
    }
}

async function queryPayments(req, res, next) {
    try {
        const body = req.body || {};
        const result = await paymentService.queryPayments({
            filters: body.filters || {},
            sort: body.sort || null,
            search: body.search,
            limit: body.limit,
            skip: body.skip,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function distinctValues(req, res, next) {
    try {
        const result = await paymentService.distinctValues({
            field: req.params.field,
            search: req.query.search,
            limit: req.query.limit,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function getAnalytics(req, res, next) {
    try {
        const result = await paymentService.getAnalytics({ period: req.query.period });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

// ============== Bulk payment creation ==============
function readUploadBody(req) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return req.body;
    if (req.body && typeof req.body.csv === 'string') return req.body.csv;
    return '';
}

function hasContent(body) {
    if (Buffer.isBuffer(body)) return body.length > 0;
    return String(body || '').trim().length > 0;
}

function bulkTemplate(req, res) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments-bulk-template.csv"');
    return res.send(paymentService.bulkPaymentTemplate());
}

/** Dry run: report every problem and the totals before anything is created. */
async function validateBulkPayments(req, res, next) {
    try {
        const upload = readUploadBody(req);
        if (!hasContent(upload)) {
            return res.status(400).json({ error: 'No file content received' });
        }
        const result = await paymentService.validateBulkPayments(upload, {
            autoCreateHotels: req.query.auto_create_hotels !== 'false',
            skipCardChecks: req.query.skip_card_checks === 'true',
        });
        // Internal detail; the client gets `preview` and `hotels_to_create`.
        delete result.prepared;
        delete result.newHotels;
        return res.status(result.valid ? 200 : 422).json(result);
    } catch (err) {
        return next(err);
    }
}

async function startBulkPayments(req, res, next) {
    try {
        const upload = readUploadBody(req);
        if (!hasContent(upload)) {
            return res.status(400).json({ error: 'No file content received' });
        }
        const job = await paymentService.startBulkPayments(upload, {
            userId: req.userId,
            // Sent by the browser so the batch is identifiable by its file.
            fileName: req.query.file_name || 'upload',
            fileSize: Buffer.isBuffer(upload) ? upload.length : String(upload).length,
            checkout_mode: req.query.checkout_mode || 'embedded_elements',
            autoCreateHotels: req.query.auto_create_hotels !== 'false',
            skipCardChecks: req.query.skip_card_checks === 'true',
        });
        return res.status(202).json(job);
    } catch (err) {
        if (err.statusCode === 400 && err.details) {
            return res.status(422).json({ error: err.message, errors: err.details });
        }
        return next(err);
    }
}

async function getBatch(req, res, next) {
    try {
        return res.json(await paymentService.getBatch(req.params.jobId));
    } catch (err) {
        return next(err);
    }
}

async function listBatches(req, res, next) {
    try {
        return res.json(await paymentService.listBatches({ limit: req.query.limit }));
    } catch (err) {
        return next(err);
    }
}

/**
 * Is this order id free? Backs the inline check in the new-payment form so a
 * clash is caught while typing rather than on submit.
 */
async function checkOrderId(req, res, next) {
    try {
        const value = paymentService.normaliseOrderId(req.query.value);
        if (!value) return res.json({ value: '', available: null });
        if (value.length > paymentService.ORDER_ID_MAX_LENGTH) {
            return res.json({
                value,
                available: false,
                reason: `Must be ${paymentService.ORDER_ID_MAX_LENGTH} characters or fewer`,
            });
        }
        await paymentService.assertOrderIdFree(value);
        return res.json({ value, available: true });
    } catch (err) {
        if (err.statusCode === 409) {
            return res.json({ value: req.query.value, available: false, reason: err.message });
        }
        return next(err);
    }
}

// ============== Delete + export ==============
async function deletePayment(req, res, next) {
    try {
        const result = await paymentService.deletePayments([req.params.id], {
            force: req.query.force === 'true',
        });
        // A single refusal is a 409, not a success with a buried error.
        if (result.deleted === 0 && result.refused > 0) {
            return res.status(409).json({ error: result.results[0].error, ...result });
        }
        if (result.deleted === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function bulkDeletePayments(req, res, next) {
    try {
        const body = req.body || {};
        const result = await paymentService.deletePayments(body.ids, {
            force: body.force === true,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function exportPayments(req, res, next) {
    try {
        const body = req.body || {};
        const { csv, count } = await paymentService.exportPayments({
            ids: body.ids,
            filters: body.filters,
            search: body.search,
            sort: body.sort,
        });
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="payments-${stamp}.csv"`);
        res.setHeader('X-Export-Count', String(count));
        return res.send(csv);
    } catch (err) {
        return next(err);
    }
}

async function getStats(req, res, next) {
    try {
        const stats = await paymentService.getStats({ period: req.query.period });
        return res.json(stats);
    } catch (err) {
        return next(err);
    }
}

/**
 * Public status lookup for the post-checkout return page.
 *
 * The shopper lands here without a session, so this is keyed on the
 * merchant_order_id from the return URL and deliberately exposes only what the
 * page needs to render an outcome — never the full history record.
 */
async function getPublicStatus(req, res, next) {
    try {
        // Resolve by the unguessable token first, then sync through the normal
        // path so the status shown is authoritative.
        const known = await paymentService.getPaymentByPublicToken(req.params.orderId);
        const payment = await paymentService
            .syncPayment(known.payment_intent_id)
            .catch(async (err) => {
                // If Airwallex is unreachable, fall back to what we last stored
                // rather than failing the shopper's return page outright.
                if (err.statusCode === 404) throw err;
                console.error('Return-page sync failed:', err.message);
                return known;
            });

        // A decline leaves the intent at REQUIRES_PAYMENT_METHOD, so without
        // this flag the return page cannot tell "declined" from "never tried".
        // The reason itself is deliberately withheld: this endpoint is
        // unauthenticated, and enumerating decline codes helps card testers.
        const declined =
            payment.last_attempt_status === 'FAILED' &&
            !['SUCCEEDED', 'REQUIRES_CAPTURE'].includes(payment.status);

        return res.json({
            // The operator's own order id, safe to show: the caller already
            // proved knowledge of the token to get here.
            merchant_order_id: payment.merchant_order_id,
            status: payment.status,
            declined,
            amount: payment.amount,
            currency: payment.currency,
            captured_amount: payment.captured_amount,
            descriptor: payment.descriptor,
            reference: payment.reference,
            description: payment.description,
        });
    } catch (err) {
        return next(err);
    }
}

/**
 * Airwallex webhook receiver.
 *
 * Verifies the HMAC over `x-timestamp + raw body` before trusting anything in
 * the payload, and always answers 200 once the signature checks out — a
 * non-2xx makes Airwallex retry, which we only want for genuine failures.
 */
async function handleWebhook(req, res) {
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];

    if (!process.env.AIRWALLEX_WEBHOOK_SECRET) {
        console.error('Webhook received but AIRWALLEX_WEBHOOK_SECRET is not set');
        return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    let valid = false;
    try {
        valid = airwallex.verifyWebhookSignature({
            timestamp,
            signature,
            rawBody: req.rawBody,
        });
    } catch (err) {
        console.error('Webhook verification error:', err.message);
        return res.status(500).json({ error: 'Webhook verification failed' });
    }

    if (!valid) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
        const result = await paymentService.handleWebhookEvent(req.body);
        return res.status(200).json({ received: true, ...result, payment: undefined });
    } catch (err) {
        // Genuine processing failure — let Airwallex retry.
        console.error('Webhook processing failed:', err);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
}

module.exports = {
    createPayment,
    checkOrderId,
    deletePayment,
    bulkDeletePayments,
    exportPayments,
    getCheckoutSession,
    payAutomated,
    bulkTemplate,
    validateBulkPayments,
    startBulkPayments,
    getBatch,
    listBatches,
    queryPayments,
    distinctValues,
    getAnalytics,
    listPayments,
    getPayment,
    syncPayment,
    cancelPayment,
    getStats,
    getPublicStatus,
    handleWebhook,
};
