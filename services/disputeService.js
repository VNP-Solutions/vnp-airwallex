const crypto = require('crypto');
const Dispute = require('../models/Dispute');
const Payment = require('../models/Payment');
const airwallex = require('./airwallexService');

// Registered so populate('payment') works when this runs outside the server.
require('../models/Hotel');
require('../models/User');

/**
 * Disputes, worked from here rather than from the Airwallex dashboard.
 *
 * Airwallex owns the state of a dispute; this service mirrors it, attaches the
 * hotel and reservation it belongs to, and sends our responses back. Every
 * write re-reads the dispute afterwards, so what the page shows is what
 * Airwallex has, not what we hoped it would have.
 */

/** Stages, worst-to-best in terms of how far a case has escalated. */
const STAGES = ['RFI', 'PRE_CHARGEBACK', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'];

const STATUSES = [
    'REQUIRES_RESPONSE',
    'CHALLENGED',
    'PENDING_DECISION',
    'PENDING_CLOSURE',
    'ACCEPTED',
    'WON',
    'LOST',
    'REVERSED',
    'EXPIRED',
];

/** Cases still needing something from us. */
const OPEN_STATUSES = ['REQUIRES_RESPONSE'];

/** Cases closed one way or the other. */
const CLOSED_STATUSES = ['ACCEPTED', 'WON', 'LOST', 'REVERSED', 'EXPIRED'];

const CHALLENGE_REASONS = [
    'CUSTOMER_WITHDRAWN',
    'CUSTOMER_REFUNDED',
    'PRODUCT_RECEIVED',
    'PURCHASE_HISTORY',
    'NOT_ENTITLED',
    'SEPARATE_PRODUCT',
    'AUTHENTIC_PRODUCT',
    'OTHER_REASONS',
];

const ACCEPT_REASONS = [
    'AGREEMENT_REACHED_WITH_CUSTOMER',
    'CUSTOMER_RELATIONSHIP_MAINTENANCE',
    'LOW_VALUE_TRANSACTION',
    'VALID_CUSTOMER_DISPUTE',
    'NO_ACTION_TAKEN_BY_MERCHANT',
    'OTHERS',
];

const PRODUCT_TYPES = [
    'PHYSICAL_GOODS',
    'DIGITAL_PRODUCT_OR_SERVICE',
    'OFFLINE_SERVICE',
    'TRAVEL',
    'RESERVE_OR_BOOKING',
    'OTHERS',
];

/**
 * How a supporting document is classified on a challenge.
 *
 * Established by probing the API rather than from the reference: the older
 * `evidence` object with its per-purpose `*_file_ids` arrays is deprecated and
 * now refused outright with "Please attach at least one recommended evidence
 * types", whatever you put in it. Documents must come through
 * supporting_documents.documents[] carrying one of these four types, and at
 * least one PRIMARY is what the issuer actually reads.
 */
const DOCUMENT_TYPES = [
    {
        key: 'PRIMARY',
        label: 'Primary evidence',
        hint: 'The document that answers the dispute reason — a folio, or proof the stay was taken.',
    },
    { key: 'ORDER', label: 'Order record', hint: 'The booking itself: confirmation, rate, dates.' },
    {
        key: 'CUSTOMER',
        label: 'Customer evidence',
        hint: 'Correspondence with the guest, or what they agreed to.',
    },
    { key: 'OTHER', label: 'Other', hint: 'Anything else that supports the case.' },
];

/**
 * File formats the card networks accept, by brand.
 *
 * Airwallex rejects anything else at challenge time rather than at upload, so
 * this is checked when the file arrives — finding out at submission that a PNG
 * was never usable wastes the response window.
 */
const ACCEPTED_FILE_TYPES = {
    visa: ['jpg', 'jpeg', 'pdf', 'tiff', 'tif'],
    mastercard: ['jpg', 'jpeg', 'pdf', 'tiff', 'tif', 'png'],
    default: ['jpg', 'jpeg', 'pdf', 'tiff', 'tif'],
};

function acceptedTypesFor(cardBrand) {
    return ACCEPTED_FILE_TYPES[String(cardBrand || '').toLowerCase()] || ACCEPTED_FILE_TYPES.default;
}

const EVIDENCE_TEXT_FIELDS = [
    'product_description',
    'refund_policy_url',
    'merchant_business_model_description',
    'order_fulfilled_at',
    'duplicate_explanation',
    'duplicate_acquirer_reference_number',
    'duplicate_transaction_created_at',
    'duplicate_transaction_amount_currency',
];

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function notFound(message) {
    const err = new Error(message);
    err.statusCode = 404;
    return err;
}

/**
 * Fold an Airwallex dispute into our record, attaching the charge it belongs
 * to.
 *
 * The hotel and reservation come from our own payment: Airwallex carries only
 * the order id, so without this a dispute is a number with no context.
 */
async function upsertDispute(raw, { apiLog } = {}) {
    const payment = await Payment.findOne({
        $or: [
            { payment_intent_id: raw.payment_intent_id },
            ...(raw.merchant_order_id ? [{ merchant_order_id: raw.merchant_order_id }] : []),
        ],
    })
        .select(
            'merchant_order_id description hotel hotel_name hotel_expedia_id hotel_portfolio batch_name'
        )
        .lean();

    const update = {
        dispute_id: raw.id,
        payment_intent_id: raw.payment_intent_id,
        payment_attempt_id: raw.payment_attempt_id,
        merchant_order_id: raw.merchant_order_id,
        payment: payment ? payment._id : undefined,
        hotel: payment ? payment.hotel : undefined,
        hotel_name: payment ? payment.hotel_name : undefined,
        hotel_expedia_id: payment ? payment.hotel_expedia_id : undefined,
        hotel_portfolio: payment ? payment.hotel_portfolio : undefined,
        reservation_id: payment ? payment.description : undefined,
        batch_name: payment ? payment.batch_name : undefined,

        amount: raw.amount,
        currency: raw.currency,
        stage: raw.stage,
        status: raw.status,
        mode: raw.mode,
        transaction_type: raw.transaction_type,
        payment_method_type: raw.payment_method_type,
        card_brand: raw.card_brand,
        customer_name: raw.customer_name,
        acquirer_reference_number: raw.acquirer_reference_number,
        reason: raw.reason || undefined,
        due_at: raw.due_at ? new Date(raw.due_at) : undefined,
        dispute_created_at: raw.created_at ? new Date(raw.created_at) : undefined,
        dispute_updated_at: raw.updated_at ? new Date(raw.updated_at) : undefined,
        issuer_comment: raw.issuer_comment,
        issuer_documents: raw.issuer_documents || [],
        accept_details: raw.accept_details || [],
        challenge_details: raw.challenge_details || [],
        refunds: raw.refunds || [],
        ai_dispute_automation: raw.ai_dispute_automation,
        metadata: raw.metadata,
        raw,
        last_synced_at: new Date(),
    };

    const doc = await Dispute.findOneAndUpdate(
        { dispute_id: raw.id },
        {
            $set: update,
            ...(apiLog && apiLog.length ? { $push: { api_log: { $each: apiLog, $slice: -40 } } } : {}),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return doc;
}

/**
 * Pull disputes from Airwallex into our table.
 *
 * Pages through the whole list rather than a window, because a dispute that
 * slipped past unnoticed is exactly the one that costs money.
 */
async function syncDisputes({ since, pageSize = 200 } = {}) {
    const params = { size: Math.min(pageSize, 1000) };
    if (since) params.from_updated_at = new Date(since).toISOString();

    let page = 0;
    let seen = 0;
    let created = 0;
    const errors = [];

    for (;;) {
        const apiLog = [];
        const res = await airwallex.listDisputes({ ...params, page }, { log: apiLog });
        const items = (res && res.items) || [];
        if (!items.length) break;

        for (const raw of items) {
            try {
                const existed = await Dispute.exists({ dispute_id: raw.id });
                await upsertDispute(raw, { apiLog: page === 0 ? apiLog : null });
                seen += 1;
                if (!existed) created += 1;
            } catch (err) {
                errors.push({ dispute_id: raw.id, error: err.message });
            }
        }

        if (items.length < params.size) break;
        page += 1;
        // A guard against an endpoint that never stops returning full pages.
        if (page > 100) break;
    }

    return { synced: seen, created, errors, at: new Date() };
}

/** One dispute, re-read from Airwallex so the page is never stale. */
async function refreshDispute(disputeId) {
    const apiLog = [];
    const raw = await airwallex.retrieveDispute(disputeId, { log: apiLog });
    return upsertDispute(raw, { apiLog });
}

async function listDisputes({ status, stage, q, open, limit = 50, skip = 0 } = {}) {
    const query = {};
    if (status) query.status = Array.isArray(status) ? { $in: status } : status;
    if (stage) query.stage = Array.isArray(stage) ? { $in: stage } : stage;
    if (open === true) query.status = { $in: OPEN_STATUSES };
    if (open === false) query.status = { $in: CLOSED_STATUSES };

    if (q && String(q).trim()) {
        const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        query.$or = [
            { dispute_id: rx },
            { merchant_order_id: rx },
            { reservation_id: rx },
            { payment_intent_id: rx },
            { hotel_name: rx },
            { customer_name: rx },
        ];
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeSkip = Math.max(Number(skip) || 0, 0);

    const [items, total] = await Promise.all([
        Dispute.find(query)
            // Soonest due first: a dispute is a deadline before it is anything else.
            .sort({ due_at: 1, dispute_created_at: -1 })
            .skip(safeSkip)
            .limit(safeLimit)
            .select('-raw -api_log')
            .lean(),
        Dispute.countDocuments(query),
    ]);

    return { items, total, limit: safeLimit, skip: safeSkip };
}

/** Counts for the header tiles. */
async function disputeStats() {
    const [byStatus, byStage, totals] = await Promise.all([
        Dispute.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        Dispute.aggregate([{ $group: { _id: '$stage', n: { $sum: 1 } } }]),
        Dispute.aggregate([
            { $group: { _id: '$currency', amount: { $sum: '$amount' }, n: { $sum: 1 } } },
        ]),
    ]);

    const open = await Dispute.countDocuments({ status: { $in: OPEN_STATUSES } });
    const dueSoon = await Dispute.countDocuments({
        status: { $in: OPEN_STATUSES },
        due_at: { $lte: new Date(Date.now() + 3 * 864e5) },
    });

    return {
        open,
        due_soon: dueSoon,
        total: await Dispute.countDocuments(),
        by_status: byStatus.map((r) => ({ status: r._id, count: r.n })),
        by_stage: byStage.map((r) => ({ stage: r._id, count: r.n })),
        at_risk: totals.map((r) => ({ currency: r._id, amount: r.amount, count: r.n })),
    };
}

async function getDispute(disputeId, { refresh = false } = {}) {
    if (refresh) await refreshDispute(disputeId);

    const dispute = await Dispute.findOne({ dispute_id: disputeId })
        .populate('payment', 'merchant_order_id description amount currency status descriptor card_last4 card_brand card_issuer created_at')
        .lean();
    if (!dispute) throw notFound('Dispute not found');
    return dispute;
}

/**
 * Store an evidence document with Airwallex and remember it against the case.
 *
 * The file goes to Airwallex, not to us — we keep only the id they return and
 * enough to show it in a list.
 */
async function uploadEvidence(disputeId, { buffer, filename, contentType, category, userId }) {
    if (!buffer || !buffer.length) throw badRequest('No file received');

    const dispute = await Dispute.findOne({ dispute_id: disputeId });
    if (!dispute) throw notFound('Dispute not found');

    // Checked here rather than at challenge time: Airwallex only complains when
    // the response is submitted, by which point the window may have closed.
    const accepted = acceptedTypesFor(dispute.card_brand);
    const ext = String(filename || '').split('.').pop().toLowerCase();
    if (!accepted.includes(ext)) {
        throw badRequest(
            `${dispute.card_brand || 'This card network'} does not accept .${ext} — use ${accepted.join(', ')}`
        );
    }

    const result = await airwallex.uploadFile(buffer, filename, { contentType });
    const file = {
        file_id: result.file_id,
        filename: result.filename || filename,
        size: result.size || buffer.length,
        content_type: contentType,
        category: category || undefined,
        uploaded_at: new Date(),
        uploaded_by: userId || undefined,
    };

    await Dispute.updateOne({ _id: dispute._id }, { $push: { evidence_files: file } });
    return file;
}

async function removeEvidence(disputeId, fileId) {
    const res = await Dispute.updateOne(
        { dispute_id: disputeId },
        { $pull: { evidence_files: { file_id: fileId } } }
    );
    if (!res.matchedCount) throw notFound('Dispute not found');
    return { removed: fileId };
}

/**
 * Contest the dispute.
 *
 * Evidence file ids are grouped by the slot they belong to and sent alongside
 * whatever text the operator supplied. Airwallex asks for at least one
 * document, so an empty challenge is refused here rather than there.
 */
async function challengeDispute(disputeId, body = {}, { userId } = {}) {
    const dispute = await Dispute.findOne({ dispute_id: disputeId });
    if (!dispute) throw notFound('Dispute not found');

    if (!OPEN_STATUSES.includes(dispute.status)) {
        const err = new Error(
            `This dispute is ${String(dispute.status).toLowerCase().replace(/_/g, ' ')} and cannot be challenged`
        );
        err.statusCode = 409;
        throw err;
    }

    // Which uploaded files to send, and under which type. Defaults to
    // everything already attached to the case, since that is what an operator
    // means by "submit the evidence".
    const chosen =
        Array.isArray(body.file_ids) && body.file_ids.length
            ? dispute.evidence_files.filter((f) => body.file_ids.includes(f.file_id))
            : dispute.evidence_files;

    if (!chosen.length) {
        throw badRequest(
            'Attach at least one document before challenging — the issuer refuses a response without one'
        );
    }

    const byType = new Map();
    for (const file of chosen) {
        const type = DOCUMENT_TYPES.some((t) => t.key === file.category)
            ? file.category
            : 'PRIMARY';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(file.file_id);
    }
    // The issuer reads the primary document; a response without one is a
    // response about nothing.
    if (!byType.has('PRIMARY')) {
        const [firstType] = byType.keys();
        byType.set('PRIMARY', byType.get(firstType));
        byType.delete(firstType);
    }

    const documents = [...byType.entries()].map(([type, file_ids]) => ({
        type,
        file_ids,
        ...(body.description ? { description: String(body.description).slice(0, 500) } : {}),
    }));

    if (body.reason && !CHALLENGE_REASONS.includes(body.reason)) {
        throw badRequest(`reason must be one of: ${CHALLENGE_REASONS.join(', ')}`);
    }
    if (body.product_type && !PRODUCT_TYPES.includes(body.product_type)) {
        throw badRequest(`product_type must be one of: ${PRODUCT_TYPES.join(', ')}`);
    }

    const payload = {
        request_id: crypto.randomUUID(),
        supporting_documents: { documents },
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.product_type ? { product_type: body.product_type } : {}),
        ...(body.product_description ? { product_description: body.product_description } : {}),
        ...(body.refund_refusal_reason
            ? { refund_refusal_reason: body.refund_refusal_reason }
            : {}),
        ...(body.customer_info ? { customer_info: body.customer_info } : {}),
        ...(body.delivery_info ? { delivery_info: body.delivery_info } : {}),
        ...(body.order_info ? { order_info: body.order_info } : {}),
        ...(body.seller_info ? { seller_info: body.seller_info } : {}),
        ...(userId ? { challenged_by: String(userId) } : {}),
    };

    const apiLog = [];
    await airwallex.challengeDispute(disputeId, payload, { log: apiLog });
    // Re-read rather than trust the response: the status is theirs to set.
    return upsertDispute(await airwallex.retrieveDispute(disputeId, { log: apiLog }), { apiLog });
}

/**
 * Concede the dispute.
 *
 * The money goes back to the cardholder and the case closes. There is no
 * undoing it, so the caller must pass acknowledge: true.
 */
async function acceptDispute(disputeId, body = {}, { userId } = {}) {
    const dispute = await Dispute.findOne({ dispute_id: disputeId });
    if (!dispute) throw notFound('Dispute not found');

    if (!OPEN_STATUSES.includes(dispute.status)) {
        const err = new Error(
            `This dispute is ${String(dispute.status).toLowerCase().replace(/_/g, ' ')} and cannot be accepted`
        );
        err.statusCode = 409;
        throw err;
    }
    if (body.acknowledge !== true) {
        throw badRequest(
            'Accepting concedes the money and closes the case permanently — confirm to proceed'
        );
    }
    if (body.reason && !ACCEPT_REASONS.includes(body.reason)) {
        throw badRequest(`reason must be one of: ${ACCEPT_REASONS.join(', ')}`);
    }

    const payload = {
        request_id: crypto.randomUUID(),
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(userId ? { accepted_by: String(userId) } : {}),
        ...(body.refund && body.refund.amount
            ? { refund: { amount: body.refund.amount, reason: body.refund.reason } }
            : {}),
    };

    const apiLog = [];
    await airwallex.acceptDispute(disputeId, payload, { log: apiLog });
    return upsertDispute(await airwallex.retrieveDispute(disputeId, { log: apiLog }), { apiLog });
}

/** Operator notes, kept on the dispute at Airwallex as metadata. */
async function updateMetadata(disputeId, metadata = {}) {
    const apiLog = [];
    await airwallex.updateDispute(disputeId, metadata, { log: apiLog });
    return upsertDispute(await airwallex.retrieveDispute(disputeId, { log: apiLog }), { apiLog });
}

/**
 * Fold a dispute webhook into the record.
 *
 * Events arrive as payment_dispute.* and carry the dispute object, so the case
 * updates itself without waiting for someone to press sync.
 */
async function applyWebhook(event) {
    const raw = event && event.data && event.data.object;
    if (!raw || !raw.id) return null;
    return upsertDispute(raw, {
        apiLog: [
            {
                at: new Date(),
                method: 'WEBHOOK',
                path: event.name || 'payment_dispute',
                status: 200,
                response: raw,
            },
        ],
    });
}

module.exports = {
    STAGES,
    STATUSES,
    OPEN_STATUSES,
    CLOSED_STATUSES,
    CHALLENGE_REASONS,
    ACCEPT_REASONS,
    PRODUCT_TYPES,
    DOCUMENT_TYPES,
    ACCEPTED_FILE_TYPES,
    acceptedTypesFor,
    EVIDENCE_TEXT_FIELDS,
    syncDisputes,
    refreshDispute,
    listDisputes,
    disputeStats,
    getDispute,
    uploadEvidence,
    removeEvidence,
    challengeDispute,
    acceptDispute,
    updateMetadata,
    applyWebhook,
    upsertDispute,
};
