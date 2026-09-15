const paymentService = require('../services/paymentService');
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
        } = req.body || {};

        if (amount === undefined || amount === null || amount === '') {
            return res.status(400).json({ error: 'amount is required' });
        }
        if (!currency) {
            return res.status(400).json({ error: 'currency is required' });
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
            checkout_mode: req.query.checkout_mode || 'embedded_elements',
            autoCreateHotels: req.query.auto_create_hotels !== 'false',
        });
        return res.status(202).json(job);
    } catch (err) {
        if (err.statusCode === 400 && err.details) {
            return res.status(422).json({ error: err.message, errors: err.details });
        }
        return next(err);
    }
}

async function getBulkJob(req, res, next) {
    try {
        return res.json(await paymentService.getBulkJob(req.params.jobId));
    } catch (err) {
        return next(err);
    }
}

async function listBulkJobs(req, res, next) {
    try {
        return res.json(await paymentService.listBulkJobs({ limit: req.query.limit }));
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
        const payment = await paymentService.syncPayment(req.params.orderId).catch(
            async (err) => {
                // If Airwallex is unreachable, fall back to what we last stored
                // rather than failing the shopper's return page outright.
                if (err.statusCode === 404) throw err;
                console.error('Return-page sync failed:', err.message);
                return paymentService.getPayment(req.params.orderId);
            }
        );

        return res.json({
            merchant_order_id: payment.merchant_order_id,
            status: payment.status,
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
    getCheckoutSession,
    bulkTemplate,
    validateBulkPayments,
    startBulkPayments,
    getBulkJob,
    listBulkJobs,
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
