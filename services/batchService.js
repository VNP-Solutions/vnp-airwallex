const Batch = require('../models/Batch');
const Payment = require('../models/Payment');
require('../models/User');
const paymentService = require('./paymentService');
const cardVault = require('./cardVault');

/**
 * Batches: uploaded payment files and what happened to them.
 *
 * A batch owns the intents it created, so deleting one is a real cleanup —
 * every intent is cancelled at Airwallex before the records go, which is the
 * whole point when a file was uploaded wrong.
 */

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

/** Statuses representing money that actually moved. */
const SETTLED_STATUSES = ['SUCCEEDED', 'REQUIRES_CAPTURE'];
const PAYABLE_STATUSES = ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION'];

async function listBatches({ limit = 50, skip = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeSkip = Math.max(Number(skip) || 0, 0);

    const [items, total] = await Promise.all([
        Batch.find({})
            .sort({ created_at: -1 })
            .skip(safeSkip)
            .limit(safeLimit)
            .select('-results')
            .populate('created_by', 'first_name last_name email')
            .lean(),
        Batch.countDocuments(),
    ]);

    // Live counts per batch: the stored totals describe creation, but a batch's
    // payment state moves every time one is paid or cancelled.
    const ids = items.map((b) => b._id);
    const stats = await Payment.aggregate([
        { $match: { batch: { $in: ids } } },
        {
            $group: {
                _id: { batch: '$batch', status: '$status' },
                count: { $sum: 1 },
                amount: { $sum: '$amount' },
            },
        },
    ]);

    const byBatch = new Map();
    for (const row of stats) {
        const key = String(row._id.batch);
        if (!byBatch.has(key)) byBatch.set(key, { payments: 0, by_status: {}, amount: 0 });
        const entry = byBatch.get(key);
        entry.payments += row.count;
        entry.amount += row.amount;
        entry.by_status[row._id.status] = row.count;
    }

    return {
        items: items.map((b) => {
            const live = byBatch.get(String(b._id)) || { payments: 0, by_status: {}, amount: 0 };
            const paid = SETTLED_STATUSES.reduce(
                (sum, s) => sum + (live.by_status[s] || 0),
                0
            );
            const payable = PAYABLE_STATUSES.reduce(
                (sum, s) => sum + (live.by_status[s] || 0),
                0
            );
            return {
                ...b,
                payments: live.payments,
                amount: Math.round(live.amount * 100) / 100,
                by_status: live.by_status,
                paid,
                payable,
            };
        }),
        total,
        limit: safeLimit,
        skip: safeSkip,
    };
}

async function getBatch(id) {
    const batch = await Batch.findById(id)
        .populate('created_by', 'first_name last_name email')
        .catch(() => null);
    if (!batch) {
        const err = new Error('Batch not found');
        err.statusCode = 404;
        throw err;
    }
    return batch;
}

/**
 * Delete a batch and everything it produced.
 *
 * Unpaid intents are cancelled at Airwallex first — a local delete alone would
 * leave payable intents behind with nothing pointing at them. A batch holding
 * payments that took money is refused unless explicitly forced.
 */
async function deleteBatch(id, { force = false } = {}) {
    const batch = await getBatch(id);

    if (batch.pay_run && batch.pay_run.status === 'running') {
        const err = new Error('This batch is being paid right now — stop the run first');
        err.statusCode = 409;
        throw err;
    }

    const payments = await Payment.find({ batch: batch._id }).select(
        'payment_intent_id status'
    );
    const settled = payments.filter((p) => SETTLED_STATUSES.includes(p.status));

    if (settled.length && !force) {
        const err = new Error(
            `${settled.length} payment${settled.length === 1 ? '' : 's'} in this batch took money — deleting removes the only record of the charge`
        );
        err.statusCode = 409;
        err.settled = settled.length;
        throw err;
    }

    // A batch whose upload produced no payments — every row rejected, or an
    // import abandoned partway — is still a record to clear away. deletePayments
    // rightly refuses an empty selection, so there is simply nothing to ask it.
    const result = payments.length
        ? await paymentService.deletePayments(
              payments.map((p) => p.payment_intent_id),
              { force }
          )
        : { deleted: 0, refused: 0, results: [] };

    await Batch.deleteOne({ _id: batch._id });

    return {
        batch_id: String(batch._id),
        file_name: batch.file_name,
        payments_deleted: result.deleted,
        payments_refused: result.refused,
        cancelled: result.results.filter((r) => r.cancelled).length,
        warnings: result.results.filter((r) => r.warning).map((r) => r.warning),
    };
}

/**
 * Delete several batches in one go.
 *
 * Each is attempted independently: one batch refusing — because it is mid-run,
 * or because it holds settled payments — must not stop the rest from going.
 * The caller gets a per-batch account of what happened rather than a single
 * pass/fail, so a partial result is legible.
 */
async function deleteBatches(ids, { force = false } = {}) {
    const list = [...new Set((ids || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!list.length) {
        const err = new Error('No batches selected');
        err.statusCode = 400;
        throw err;
    }

    const deleted = [];
    const refused = [];

    for (const id of list) {
        try {
            deleted.push(await deleteBatch(id, { force }));
        } catch (err) {
            refused.push({
                batch_id: id,
                error: err.message,
                settled: err.settled,
            });
        }
    }

    return {
        requested: list.length,
        deleted: deleted.length,
        refused: refused.length,
        payments_deleted: deleted.reduce((n, d) => n + (d.payments_deleted || 0), 0),
        cancelled: deleted.reduce((n, d) => n + (d.cancelled || 0), 0),
        results: deleted,
        errors: refused,
    };
}

/**
 * The payments in a batch that still need paying, with their card details
 * decrypted.
 *
 * Only ever called by the automation runner on the server. The plaintext is
 * held in memory for the duration of one payment and never persisted, logged
 * or returned over HTTP.
 */
function withDecryptedCard(payment) {
    if (!payment.card || !payment.card.pan) {
        return { payment, card: null, reason: 'No card stored for this payment' };
    }
    try {
        return {
            payment,
            card: {
                pan: cardVault.decrypt(payment.card.pan),
                expiry: cardVault.decrypt(payment.card.expiry),
                cvv: cardVault.decrypt(payment.card.cvv),
                name:
                    payment.card.cardholder_name ||
                    payment.customer_label ||
                    'Card Holder',
            },
        };
    } catch (err) {
        return { payment, card: null, reason: `Card could not be decrypted: ${err.message}` };
    }
}

async function getPayableWithCards(batchId) {
    const payments = await Payment.find({
        batch: batchId,
        status: { $in: PAYABLE_STATUSES },
    })
        .select('+card.pan +card.expiry +card.cvv')
        .sort({ created_at: 1 });

    return payments.map(withDecryptedCard);
}

/**
 * One payment and its card, for paying a single row through the same
 * automation the batches use.
 */
async function getPaymentWithCard(paymentId) {
    // Resolved the same way as getPayment: callers hold an intent id, an order
    // id or a mongo id depending on where they came from.
    const id = String(paymentId || '');
    const payment = await Payment.findOne({
        $or: [
            { payment_intent_id: id },
            { merchant_order_id: id },
            ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : []),
        ],
    }).select('+card.pan +card.expiry +card.cvv');
    if (!payment) {
        const err = new Error('Payment not found');
        err.statusCode = 404;
        throw err;
    }
    return withDecryptedCard(payment);
}

/**
 * Drop the stored card once a payment has succeeded.
 *
 * Keeping credentials past the charge they were stored for serves no purpose
 * and only widens the blast radius of a breach.
 */
async function clearCardData(paymentId) {
    await Payment.updateOne(
        { _id: paymentId },
        {
            $unset: { 'card.pan': '', 'card.expiry': '', 'card.cvv': '' },
            $set: { 'card.purged_at': new Date() },
        }
    );
}

/** How many payments in a batch still hold usable card details. */
async function cardCoverage(batchId) {
    const [withCard, payable] = await Promise.all([
        Payment.countDocuments({ batch: batchId, 'card.last4': { $exists: true, $ne: null } }),
        Payment.countDocuments({ batch: batchId, status: { $in: PAYABLE_STATUSES } }),
    ]);
    return { with_card: withCard, payable };
}

module.exports = {
    PAYABLE_STATUSES,
    SETTLED_STATUSES,
    listBatches,
    getBatch,
    deleteBatch,
    deleteBatches,
    getPayableWithCards,
    getPaymentWithCard,
    clearCardData,
    cardCoverage,
};
