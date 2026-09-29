const batchService = require('../services/batchService');
const paymentRunner = require('../services/paymentRunner');

function appBaseUrl(req) {
    // The automation drives our own checkout page, so it needs a URL the
    // headless browser can actually reach.
    return (
        process.env.AUTOMATION_BASE_URL ||
        process.env.APP_BASE_URL ||
        `${req.protocol}://${req.get('host')}`
    ).replace(/\/$/, '');
}

async function listBatches(req, res, next) {
    try {
        return res.json(
            await batchService.listBatches({ limit: req.query.limit, skip: req.query.skip })
        );
    } catch (err) {
        return next(err);
    }
}

async function getBatch(req, res, next) {
    try {
        const batch = await batchService.getBatch(req.params.id);
        const coverage = await batchService.cardCoverage(batch._id);
        return res.json({
            ...batch.toObject(),
            card_coverage: coverage,
            running: paymentRunner.isRunning(batch._id),
        });
    } catch (err) {
        return next(err);
    }
}

async function deleteBatch(req, res, next) {
    try {
        const result = await batchService.deleteBatch(req.params.id, {
            force: req.query.force === 'true',
        });
        return res.json(result);
    } catch (err) {
        if (err.statusCode === 409) {
            return res.status(409).json({ error: err.message, settled: err.settled });
        }
        return next(err);
    }
}

/** Kick off the automated payment run. Returns immediately; poll the batch. */
async function startRun(req, res, next) {
    try {
        const batch = await paymentRunner.runBatch(req.params.id, {
            userId: req.userId,
            headless: (req.body || {}).headless !== false,
            baseUrl: appBaseUrl(req),
        });
        return res.status(202).json(batch);
    } catch (err) {
        if (err.statusCode === 409) return res.status(409).json({ error: err.message });
        return next(err);
    }
}

async function stopRun(req, res, next) {
    try {
        return res.json(paymentRunner.stopRun(req.params.id));
    } catch (err) {
        if (err.statusCode === 409) return res.status(409).json({ error: err.message });
        return next(err);
    }
}

module.exports = { listBatches, getBatch, deleteBatch, startRun, stopRun };
