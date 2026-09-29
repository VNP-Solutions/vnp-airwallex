const financeService = require('../services/financeService');

async function getBalances(req, res, next) {
    try {
        return res.json(
            await financeService.getBalances({ includeZero: req.query.include_zero === 'true' })
        );
    } catch (err) {
        return next(err);
    }
}

async function getSettlements(req, res, next) {
    try {
        return res.json(
            await financeService.getSettlements({
                from: req.query.from,
                to: req.query.to,
                currency: req.query.currency,
                status: req.query.status,
                limit: req.query.limit,
            })
        );
    } catch (err) {
        return next(err);
    }
}

async function getSettlementTransactions(req, res, next) {
    try {
        return res.json(
            await financeService.getSettlementTransactions(req.params.batchId, {
                limit: req.query.limit,
            })
        );
    } catch (err) {
        return next(err);
    }
}

async function getTransactions(req, res, next) {
    try {
        return res.json(await financeService.getTransactions(req.query));
    } catch (err) {
        return next(err);
    }
}

async function exportTransactions(req, res, next) {
    try {
        const { csv, count } = await financeService.exportTransactions(req.query);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="transactions-${stamp}.csv"`);
        res.setHeader('X-Export-Count', String(count));
        return res.send(csv);
    } catch (err) {
        return next(err);
    }
}

function reportOptions(req, res) {
    return res.json(financeService.reportOptions());
}

async function listReports(req, res, next) {
    try {
        return res.json(
            await financeService.listReports({
                page: req.query.page,
                page_size: req.query.page_size,
            })
        );
    } catch (err) {
        return next(err);
    }
}

async function createReport(req, res, next) {
    try {
        const report = await financeService.createReport(req.body || {});
        return res.status(202).json(report);
    } catch (err) {
        return next(err);
    }
}

async function getReport(req, res, next) {
    try {
        return res.json(await financeService.getReport(req.params.id));
    } catch (err) {
        return next(err);
    }
}

/**
 * Stream a generated report to the browser.
 *
 * Proxied rather than redirected: the download needs our bearer token, which
 * must never reach the client.
 */
async function downloadReport(req, res, next) {
    try {
        const { buffer, contentType, filename } = await financeService.downloadReport(
            req.params.id
        );
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', String(buffer.length));
        return res.send(buffer);
    } catch (err) {
        return next(err);
    }
}

function getEnvironment(req, res) {
    return res.json(require('../services/airwallexService').describeMode());
}

module.exports = {
    getEnvironment,
    getBalances,
    getSettlements,
    getSettlementTransactions,
    getTransactions,
    exportTransactions,
    reportOptions,
    listReports,
    createReport,
    getReport,
    downloadReport,
};
