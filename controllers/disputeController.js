const disputeService = require('../services/disputeService');
const airwallex = require('../services/airwallexService');

function handle(res, next, err) {
    if (err.statusCode && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message });
    }
    return next(err);
}

async function listDisputes(req, res, next) {
    try {
        const open =
            req.query.open === 'true' ? true : req.query.open === 'false' ? false : undefined;
        return res.json(
            await disputeService.listDisputes({
                status: req.query.status,
                stage: req.query.stage,
                q: req.query.q,
                open,
                limit: req.query.limit,
                skip: req.query.skip,
            })
        );
    } catch (err) {
        return handle(res, next, err);
    }
}

async function getStats(req, res, next) {
    try {
        return res.json(await disputeService.disputeStats());
    } catch (err) {
        return handle(res, next, err);
    }
}

/** The vocabulary the forms are built from, so the UI never hard-codes it. */
async function getOptions(req, res, next) {
    try {
        return res.json({
            stages: disputeService.STAGES,
            statuses: disputeService.STATUSES,
            open_statuses: disputeService.OPEN_STATUSES,
            closed_statuses: disputeService.CLOSED_STATUSES,
            challenge_reasons: disputeService.CHALLENGE_REASONS,
            accept_reasons: disputeService.ACCEPT_REASONS,
            product_types: disputeService.PRODUCT_TYPES,
            document_types: disputeService.DOCUMENT_TYPES,
            accepted_file_types: disputeService.ACCEPTED_FILE_TYPES,
            evidence_text_fields: disputeService.EVIDENCE_TEXT_FIELDS,
            environment: airwallex.describeMode(),
        });
    } catch (err) {
        return handle(res, next, err);
    }
}

async function syncDisputes(req, res, next) {
    try {
        return res.json(await disputeService.syncDisputes({ since: req.query.since }));
    } catch (err) {
        return handle(res, next, err);
    }
}

async function getDispute(req, res, next) {
    try {
        return res.json(
            await disputeService.getDispute(req.params.id, {
                refresh: req.query.refresh === 'true',
            })
        );
    } catch (err) {
        return handle(res, next, err);
    }
}

async function challengeDispute(req, res, next) {
    try {
        return res.json(
            await disputeService.challengeDispute(req.params.id, req.body || {}, {
                userId: req.userId,
            })
        );
    } catch (err) {
        return handle(res, next, err);
    }
}

async function acceptDispute(req, res, next) {
    try {
        return res.json(
            await disputeService.acceptDispute(req.params.id, req.body || {}, {
                userId: req.userId,
            })
        );
    } catch (err) {
        return handle(res, next, err);
    }
}

async function updateMetadata(req, res, next) {
    try {
        const { metadata } = req.body || {};
        if (!metadata || typeof metadata !== 'object') {
            return res.status(400).json({ error: 'metadata object is required' });
        }
        return res.json(await disputeService.updateMetadata(req.params.id, metadata));
    } catch (err) {
        return handle(res, next, err);
    }
}

/**
 * Evidence upload.
 *
 * The raw bytes arrive as the request body with the filename in the query, so
 * no multipart parser is needed on our side — the file is handed straight to
 * Airwallex's file service.
 */
async function uploadEvidence(req, res, next) {
    try {
        const buffer = Buffer.isBuffer(req.body) ? req.body : null;
        if (!buffer || !buffer.length) {
            return res.status(400).json({ error: 'No file content received' });
        }
        return res.status(201).json(
            await disputeService.uploadEvidence(req.params.id, {
                buffer,
                filename: req.query.filename || 'evidence',
                contentType: req.get('content-type'),
                category: req.query.category,
                userId: req.userId,
            })
        );
    } catch (err) {
        return handle(res, next, err);
    }
}

async function removeEvidence(req, res, next) {
    try {
        return res.json(await disputeService.removeEvidence(req.params.id, req.params.fileId));
    } catch (err) {
        return handle(res, next, err);
    }
}

// ============== Sandbox only ==============

/**
 * Raise a dispute against one of our own payments, so the screen can be
 * exercised without waiting for a real cardholder. Refused on live by the
 * service beneath.
 */
async function simulate(req, res, next) {
    try {
        const { payment_intent_id, stage, reason_code, due_at, amount, comment } = req.body || {};
        if (!payment_intent_id) {
            return res.status(400).json({ error: 'payment_intent_id is required' });
        }
        const raw = await airwallex.simulateDispute({
            payment_intent_id,
            stage: stage || 'RFI',
            reason_code: reason_code || '10.4',
            due_at:
                due_at ||
                new Date(Date.now() + 7 * 864e5).toISOString().replace(/\.\d+Z$/, '+0000'),
            ...(amount ? { amount } : {}),
            ...(comment ? { comment } : {}),
        });
        return res.status(201).json(await disputeService.upsertDispute(raw));
    } catch (err) {
        return handle(res, next, err);
    }
}

async function simulateEscalate(req, res, next) {
    try {
        await airwallex.simulateDisputeEscalate(req.params.id, req.body || {});
        return res.json(await disputeService.refreshDispute(req.params.id));
    } catch (err) {
        return handle(res, next, err);
    }
}

async function simulateResolve(req, res, next) {
    try {
        await airwallex.simulateDisputeResolve(req.params.id, req.body || {});
        return res.json(await disputeService.refreshDispute(req.params.id));
    } catch (err) {
        return handle(res, next, err);
    }
}

module.exports = {
    listDisputes,
    getStats,
    getOptions,
    syncDisputes,
    getDispute,
    challengeDispute,
    acceptDispute,
    updateMetadata,
    uploadEvidence,
    removeEvidence,
    simulate,
    simulateEscalate,
    simulateResolve,
};
