const airwallex = require('./airwallexService');
const { toCsv } = require('./csv');

/**
 * Treasury view over the Airwallex account: wallet balances, settlement
 * batches, and the Financial Reports API.
 *
 * Nothing here is mirrored locally — unlike payments, this is Airwallex's own
 * ledger and they are the only source of truth for it. Everything is read
 * through on demand.
 */

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

// ============== Balances ==============

/**
 * Wallet balances. Airwallex returns every currency the account *can* hold —
 * 46 of them, nearly all zero — so empty ones are dropped unless asked for.
 */
async function getBalances({ includeZero = false } = {}) {
    const rows = await airwallex.getBalances();
    const all = Array.isArray(rows) ? rows : [];

    const funded = all.filter(
        (b) =>
            (b.total_amount || 0) !== 0 ||
            (b.available_amount || 0) !== 0 ||
            (b.pending_amount || 0) !== 0 ||
            (b.reserved_amount || 0) !== 0
    );

    const items = (includeZero ? all : funded).sort((a, b) => {
        // Largest holdings first, then alphabetically so zeros stay stable.
        const diff = (b.total_amount || 0) - (a.total_amount || 0);
        return diff !== 0 ? diff : String(a.currency).localeCompare(String(b.currency));
    });

    return {
        items,
        currencies_total: all.length,
        currencies_funded: funded.length,
    };
}

// ============== Settlements ==============

const SETTLEMENT_PAGE_LIMIT = 500;

/**
 * Settlement batches, derived by grouping financial transactions on `batch_id`.
 *
 * Airwallex exposes no batch-level endpoint — a batch *is* the set of ledger
 * entries sharing an id — so the grouping happens here.
 */
async function getSettlements({ from, to, currency, status, limit } = {}) {
    const pageSize = Math.min(Math.max(Number(limit) || 200, 10), SETTLEMENT_PAGE_LIMIT);

    const data = await airwallex.getFinancialTransactions({
        page_size: pageSize,
        currency,
        status,
        from_created_at: from,
        to_created_at: to,
    });

    const items = (data && data.items) || [];
    const batches = new Map();

    for (const tx of items) {
        // Entries that never made it into a batch (older or still unsettled)
        // are grouped under a single bucket rather than dropped.
        const key = tx.batch_id || `unbatched_${tx.currency}`;
        if (!batches.has(key)) {
            batches.set(key, {
                batch_id: tx.batch_id || null,
                currency: tx.currency,
                count: 0,
                gross: 0,
                fee: 0,
                net: 0,
                statuses: new Set(),
                types: new Set(),
                settled_at: tx.settled_at || null,
                estimated_settled_at: tx.estimated_settled_at || null,
            });
        }
        const batch = batches.get(key);
        batch.count += 1;
        batch.gross += tx.amount || 0;
        batch.fee += tx.fee || 0;
        batch.net += tx.net || 0;
        batch.statuses.add(tx.status);
        batch.types.add(tx.transaction_type);
        // Keep the latest settlement timestamp in the batch.
        if (tx.settled_at && (!batch.settled_at || tx.settled_at > batch.settled_at)) {
            batch.settled_at = tx.settled_at;
        }
    }

    const round = (n) => Math.round(n * 100) / 100;

    const list = [...batches.values()]
        .map((b) => ({
            ...b,
            gross: round(b.gross),
            fee: round(b.fee),
            net: round(b.net),
            statuses: [...b.statuses],
            types: [...b.types],
            // A batch is only settled once every entry in it is.
            status: b.statuses.has('PENDING')
                ? 'PENDING'
                : b.statuses.has('SETTLED')
                  ? 'SETTLED'
                  : [...b.statuses][0] || 'UNKNOWN',
        }))
        .sort((a, b) => String(b.settled_at || '').localeCompare(String(a.settled_at || '')));

    const totals = {};
    for (const b of list) {
        totals[b.currency] = totals[b.currency] || { currency: b.currency, gross: 0, fee: 0, net: 0 };
        totals[b.currency].gross = round(totals[b.currency].gross + b.gross);
        totals[b.currency].fee = round(totals[b.currency].fee + b.fee);
        totals[b.currency].net = round(totals[b.currency].net + b.net);
    }

    return {
        batches: list,
        totals: Object.values(totals),
        transaction_count: items.length,
        has_more: !!(data && data.has_more),
    };
}

/** The ledger entries inside one batch. */
async function getSettlementTransactions(batchId, { limit = 200 } = {}) {
    if (!batchId) throw badRequest('A batch id is required');
    const data = await airwallex.getFinancialTransactions({
        batch_id: batchId,
        page_size: Math.min(Math.max(Number(limit) || 200, 10), SETTLEMENT_PAGE_LIMIT),
    });
    return { items: (data && data.items) || [], has_more: !!(data && data.has_more) };
}

async function getTransactions(params = {}) {
    const data = await airwallex.getFinancialTransactions({
        page_size: Math.min(Math.max(Number(params.limit) || 100, 10), SETTLEMENT_PAGE_LIMIT),
        page: params.page,
        currency: params.currency,
        status: params.status,
        source_type: params.source_type,
        from_created_at: params.from,
        to_created_at: params.to,
    });
    return { items: (data && data.items) || [], has_more: !!(data && data.has_more) };
}

const TRANSACTION_HEADERS = [
    'Transaction ID',
    'Batch ID',
    'Source Type',
    'Transaction Type',
    'Currency',
    'Amount',
    'Fee',
    'Net',
    'Status',
    'Created',
    'Estimated Settled',
    'Settled',
    'Source ID',
    'Description',
];

/** Export the ledger as CSV, for reconciliation outside Airwallex's own files. */
async function exportTransactions(params = {}) {
    const { items } = await getTransactions({ ...params, limit: SETTLEMENT_PAGE_LIMIT });
    return {
        count: items.length,
        csv: toCsv({
            headers: TRANSACTION_HEADERS,
            rows: items.map((t) => ({
                'Transaction ID': t.id,
                'Batch ID': t.batch_id || '',
                'Source Type': t.source_type || '',
                'Transaction Type': t.transaction_type || '',
                Currency: t.currency,
                Amount: t.amount,
                Fee: t.fee,
                Net: t.net,
                Status: t.status,
                Created: t.created_at || '',
                'Estimated Settled': t.estimated_settled_at || '',
                Settled: t.settled_at || '',
                'Source ID': t.source_id || '',
                Description: t.description || '',
            })),
        }),
    };
}

// ============== Financial reports ==============

/**
 * Which file formats each report type accepts.
 *
 * Probed against the API rather than taken from the docs: asking for an
 * unsupported pair fails with "File format CSV not supported", so the UI only
 * offers combinations that actually work.
 */
const REPORT_TYPES = [
    {
        type: 'SETTLEMENT_REPORT',
        label: 'Settlement',
        description: 'Settlements received in your wallet and the transactions behind them.',
        formats: ['CSV', 'EXCEL'],
    },
    {
        type: 'TRANSACTION_RECON_REPORT',
        label: 'Transaction reconciliation',
        description: 'Transaction-level detail with fees, for reconciling a settlement batch.',
        formats: ['CSV', 'EXCEL'],
    },
    {
        type: 'BALANCE_ACTIVITY_REPORT',
        label: 'Balance activity',
        description: 'Every movement in and out of the wallet over the period.',
        formats: ['CSV', 'EXCEL', 'PDF'],
    },
    {
        type: 'ONLINE_PAYMENTS_TRANSACTION_REPORT',
        label: 'Online payments',
        description: 'Payment transactions processed through the payments API.',
        formats: ['EXCEL'],
    },
    {
        type: 'ACCOUNT_STATEMENT_REPORT',
        label: 'Account statement',
        description: 'Formal statement for the period. Requires at least one currency.',
        formats: ['PDF'],
        requiresCurrencies: true,
    },
];

function reportOptions() {
    return { types: REPORT_TYPES };
}

async function listReports({ page, page_size } = {}) {
    const data = await airwallex.listFinancialReports({ page, page_size });
    return { items: (data && data.items) || [], has_more: !!(data && data.has_more) };
}

async function createReport({ type, file_format, from_date, to_date, currencies, time_zone }) {
    const spec = REPORT_TYPES.find((r) => r.type === type);
    if (!spec) throw badRequest('Unknown report type');
    if (!spec.formats.includes(file_format)) {
        throw badRequest(
            `${spec.label} reports are only available as ${spec.formats.join(' or ')}`
        );
    }
    if (!from_date || !to_date) throw badRequest('A from and to date are required');
    if (from_date > to_date) throw badRequest('The from date must not be after the to date');
    if (spec.requiresCurrencies && (!currencies || !currencies.length)) {
        throw badRequest(`${spec.label} reports need at least one currency`);
    }

    const payload = {
        type,
        file_format,
        from_date,
        to_date,
        time_zone: time_zone || 'UTC',
    };
    if (currencies && currencies.length) payload.currencies = currencies;

    return airwallex.createFinancialReport(payload);
}

async function getReport(id) {
    return airwallex.getFinancialReport(id);
}

/**
 * Fetch a generated report's bytes.
 *
 * Airwallex labels a CSV settlement report `text/plain` but actually returns a
 * ZIP of per-currency CSVs, so the content type is corrected from the filename
 * rather than trusted — otherwise the browser saves a .zip it will not open.
 */
async function downloadReport(id) {
    const { buffer, contentType, filename } = await airwallex.downloadFinancialReport(id);

    const name = filename || `report-${id}`;
    let type = contentType;
    if (/\.zip$/i.test(name)) type = 'application/zip';
    else if (/\.xlsx$/i.test(name))
        type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (/\.pdf$/i.test(name)) type = 'application/pdf';
    else if (/\.csv$/i.test(name)) type = 'text/csv; charset=utf-8';

    return { buffer, contentType: type, filename: name };
}

module.exports = {
    REPORT_TYPES,
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
