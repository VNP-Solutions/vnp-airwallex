const crypto = require('crypto');

/**
 * Thin wrapper over the Airwallex Payments API.
 *
 * Auth: POST /api/v1/authentication/login with x-client-id + x-api-key returns
 * a bearer token valid for 30 minutes. Airwallex explicitly asks that the token
 * be reused rather than re-minted per request, so it is cached in-process and
 * refreshed a minute before it lapses.
 */

const DESCRIPTOR_MAX_LENGTH = 32;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

let cachedToken = null; // { token, expiresAt: number }

/**
 * Which Airwallex account this process talks to.
 *
 * AIRWALLEX_MODE picks between two credential sets held side by side, so
 * switching is one word rather than four values — editing them individually is
 * how a process ends up with live keys and a sandbox host, or worse.
 *
 * Falls back to the flat AIRWALLEX_BASE_URL / CLIENT_ID / API_KEY when no mode
 * is set, so an existing .env keeps working untouched.
 */
function mode() {
    const raw = (process.env.AIRWALLEX_MODE || '').trim().toLowerCase();
    if (raw === 'live' || raw === 'prod' || raw === 'production') return 'live';
    if (raw === 'sandbox' || raw === 'demo' || raw === 'test') return 'sandbox';
    return null;
}

function scoped(name) {
    const active = mode();
    if (!active) return process.env[`AIRWALLEX_${name}`];
    const prefix = active === 'live' ? 'AIRWALLEX_LIVE_' : 'AIRWALLEX_SANDBOX_';
    return process.env[`${prefix}${name}`] || process.env[`AIRWALLEX_${name}`];
}

function baseUrl() {
    const configured = scoped('BASE_URL');
    if (configured) return configured.replace(/\/$/, '');
    // Sensible default per mode so a missing URL cannot silently point the
    // wrong way.
    return mode() === 'live'
        ? 'https://api.airwallex.com'
        : 'https://api-demo.airwallex.com';
}

/** A one-line description of the active configuration, for logs and the UI. */
function describeMode() {
    const active = mode();
    return {
        mode: active || (/(-demo|sandbox)\./.test(baseUrl()) ? 'sandbox' : 'live'),
        explicit: !!active,
        base_url: baseUrl(),
        sdk_env: env(),
        client_id_hint: (scoped('CLIENT_ID') || '').slice(0, 8),
    };
}

/**
 * Which Airwallex environment the browser SDK should talk to. Derived from the
 * API host so the two can never drift apart.
 */
function env() {
    const active = mode();
    // The browser SDK env follows the mode, so the two can never disagree.
    if (active) return active === 'live' ? 'prod' : 'demo';
    if (process.env.AIRWALLEX_ENV) return process.env.AIRWALLEX_ENV;
    // Both api-demo.airwallex.com and api.sandbox.airwallex.com are test hosts.
    return /(-demo|sandbox)\./.test(baseUrl()) ? 'demo' : 'prod';
}

function requireCredentials() {
    const clientId = scoped('CLIENT_ID');
    const apiKey = scoped('API_KEY');
    if (!clientId || !apiKey) {
        const active = mode();
        const err = new Error(
            active
                ? `AIRWALLEX_${active === 'live' ? 'LIVE' : 'SANDBOX'}_CLIENT_ID and _API_KEY must be set for AIRWALLEX_MODE=${active}`
                : 'AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY must be set'
        );
        err.statusCode = 500;
        throw err;
    }
    return { clientId, apiKey };
}

const MAX_LOGGED_BODY_CHARS = 4000;

/**
 * Strip anything that must never sit in a debug log.
 *
 * `client_secret` is a live credential — anyone holding it can drive checkout
 * for that intent — so it never reaches storage, even here. Card data is not a
 * concern: a PAN only ever travels from the shopper's browser to Airwallex.
 */
function redact(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redact);

    const out = {};
    for (const [key, val] of Object.entries(value)) {
        if (/client_secret|api_key|authorization/i.test(key)) {
            out[key] = '[redacted]';
        } else if (/^(number|cvc|cvv)$/i.test(key)) {
            out[key] = '[redacted]';
        } else {
            out[key] = redact(val);
        }
    }
    return out;
}

/** Keep a stored body bounded so one huge response cannot bloat a document. */
function capBody(value) {
    if (value === undefined) return undefined;
    const json = JSON.stringify(value);
    if (json && json.length > MAX_LOGGED_BODY_CHARS) {
        return { _truncated: true, _bytes: json.length, preview: json.slice(0, MAX_LOGGED_BODY_CHARS) };
    }
    return value;
}

function recordExchange(log, entry) {
    if (!Array.isArray(log)) return;
    log.push({
        at: new Date(),
        method: entry.method,
        path: entry.path,
        status: entry.status,
        duration_ms: entry.duration_ms,
        request: capBody(redact(entry.request)),
        response: capBody(redact(entry.response)),
        error: entry.error,
    });
}

async function readError(res) {
    const body = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch (e) {
        parsed = null;
    }
    const message =
        (parsed && (parsed.message || parsed.code)) ||
        body.slice(0, 300) ||
        res.statusText;
    const err = new Error(`Airwallex: ${message}`);
    // Their validation errors are our caller's fault; surface them as 400
    // rather than dressing them up as a 500.
    err.statusCode = res.status >= 400 && res.status < 500 ? 400 : 502;
    err.airwallex = parsed || { raw: body };
    return err;
}

async function authenticate() {
    const { clientId, apiKey } = requireCredentials();

    const res = await fetch(`${baseUrl()}/api/v1/authentication/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-client-id': clientId,
            'x-api-key': apiKey,
        },
    });

    if (!res.ok) throw await readError(res);

    const data = await res.json();
    if (!data.token) {
        throw new Error('Airwallex: authentication returned no token');
    }

    cachedToken = {
        fingerprint: `${baseUrl()}|${clientId}`,
        token: data.token,
        expiresAt: data.expires_at
            ? new Date(data.expires_at).getTime()
            : Date.now() + 30 * 60 * 1000,
    };
    return cachedToken.token;
}

async function getToken() {
    // Keyed on the account the token was minted for: a mode switch inside a
    // live process must not keep using the previous account's token.
    const fingerprint = `${baseUrl()}|${scoped('CLIENT_ID') || ''}`;
    if (
        cachedToken &&
        cachedToken.fingerprint === fingerprint &&
        cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()
    ) {
        return cachedToken.token;
    }
    return authenticate();
}

function clearToken() {
    cachedToken = null;
}

async function request(method, path, body, { retryOnAuthFailure = true, log } = {}) {
    const token = await getToken();
    const startedAt = Date.now();

    const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    // A cached token can be revoked server-side before it expires; mint a new
    // one and try once more before giving up.
    if (res.status === 401 && retryOnAuthFailure) {
        clearToken();
        return request(method, path, body, { retryOnAuthFailure: false, log });
    }

    if (!res.ok) {
        const err = await readError(res);
        recordExchange(log, {
            method,
            path,
            status: res.status,
            duration_ms: Date.now() - startedAt,
            request: body,
            response: err.airwallex,
            error: err.message,
        });
        throw err;
    }

    const json = await res.json();
    recordExchange(log, {
        method,
        path,
        status: res.status,
        duration_ms: Date.now() - startedAt,
        request: body,
        response: json,
    });
    return json;
}

/**
 * Resolve the statement descriptor — what the shopper sees on their card
 * statement.
 *
 * This is the hotel's descriptor verbatim, so every charge for a property shows
 * the same recognisable merchant name. The payment reference is deliberately
 * NOT appended: mixing it in ate the 32-character budget and truncated the
 * hotel name mid-word. The reference travels to Airwallex on its own field.
 */
function buildDescriptor({ prefix } = {}) {
    const base = (prefix || process.env.AIRWALLEX_DESCRIPTOR_PREFIX || 'VNP')
        .trim()
        .replace(/\s+/g, ' ');

    return base.slice(0, DESCRIPTOR_MAX_LENGTH);
}

function assertDescriptorFits(descriptor) {
    if (descriptor && descriptor.length > DESCRIPTOR_MAX_LENGTH) {
        const err = new Error(
            `descriptor must be ${DESCRIPTOR_MAX_LENGTH} characters or fewer`
        );
        err.statusCode = 400;
        throw err;
    }
}

async function createPaymentIntent({
    request_id,
    merchant_order_id,
    amount,
    currency,
    descriptor,
    customer,
    order,
    metadata,
    return_url,
    log,
}) {
    assertDescriptorFits(descriptor);

    const payload = {
        request_id,
        merchant_order_id,
        amount,
        currency,
    };

    if (descriptor) payload.descriptor = descriptor;
    if (customer) payload.customer = customer;
    if (order) payload.order = order;
    if (metadata) payload.metadata = metadata;
    if (return_url) payload.return_url = return_url;

    return request('POST', '/api/v1/pa/payment_intents/create', payload, { log });
}

async function retrievePaymentIntent(id, { log } = {}) {
    return request('GET', `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`, undefined, {
        log,
    });
}

async function cancelPaymentIntent(id, { request_id, cancellation_reason, log } = {}) {
    return request(
        'POST',
        `/api/v1/pa/payment_intents/${encodeURIComponent(id)}/cancel`,
        {
            request_id: request_id || crypto.randomUUID(),
            cancellation_reason: cancellation_reason || 'requested_by_customer',
        },
        { log }
    );
}

/**
 * GET a binary payload (report files) rather than JSON.
 *
 * Returns the bytes plus the content-type and filename Airwallex chose, which
 * matters because a CSV settlement report actually arrives as a ZIP of
 * per-currency CSVs under a text/plain content-type.
 */
async function requestBinary(path, { retryOnAuthFailure = true } = {}) {
    const token = await getToken();
    const res = await fetch(`${baseUrl()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401 && retryOnAuthFailure) {
        clearToken();
        return requestBinary(path, { retryOnAuthFailure: false });
    }
    if (!res.ok) throw await readError(res);

    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        filename: match ? match[1] : null,
    };
}

// ============== Treasury ==============

/** Wallet balances, one entry per currency the account can hold. */
async function getBalances() {
    return request('GET', '/api/v1/balances/current');
}

/**
 * Ledger entries behind every settlement, fee, payout and conversion.
 *
 * There is no batch-level endpoint — a settlement batch is simply the set of
 * transactions sharing a `batch_id`, which is how the settlements view is built.
 */
async function getFinancialTransactions(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    const qs = query.toString();
    return request('GET', `/api/v1/financial_transactions${qs ? `?${qs}` : ''}`);
}

async function getBalanceHistory(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    const qs = query.toString();
    return request('GET', `/api/v1/balances/history${qs ? `?${qs}` : ''}`);
}

// ============== Financial reports ==============

async function listFinancialReports(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') query.set(key, value);
    }
    const qs = query.toString();
    return request('GET', `/api/v1/finance/financial_reports${qs ? `?${qs}` : ''}`);
}

async function createFinancialReport(payload) {
    return request('POST', '/api/v1/finance/financial_reports/create', payload);
}

async function getFinancialReport(id) {
    return request('GET', `/api/v1/finance/financial_reports/${encodeURIComponent(id)}`);
}

async function downloadFinancialReport(id) {
    return requestBinary(`/api/v1/finance/financial_reports/${encodeURIComponent(id)}/content`);
}

/**
 * Verify a webhook came from Airwallex.
 *
 * They sign `x-timestamp + raw request body` with the notification URL's secret
 * using HMAC-SHA256 and send the hex digest in `x-signature`. The *unmodified*
 * body bytes must be used — a re-serialised JSON object will not match.
 */
function verifyWebhookSignature({ timestamp, signature, rawBody, secret }) {
    const key = secret || process.env.AIRWALLEX_WEBHOOK_SECRET;
    if (!key) {
        const err = new Error('AIRWALLEX_WEBHOOK_SECRET is not set');
        err.statusCode = 500;
        throw err;
    }
    if (!timestamp || !signature || !rawBody) return false;

    const expected = crypto
        .createHmac('sha256', key)
        .update(String(timestamp) + rawBody.toString('utf8'))
        .digest('hex');

    const received = Buffer.from(String(signature), 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (received.length !== computed.length) return false;

    return crypto.timingSafeEqual(received, computed);
}

module.exports = {
    DESCRIPTOR_MAX_LENGTH,
    redact,
    mode,
    describeMode,
    getBalances,
    getFinancialTransactions,
    getBalanceHistory,
    listFinancialReports,
    createFinancialReport,
    getFinancialReport,
    downloadFinancialReport,
    env,
    buildDescriptor,
    createPaymentIntent,
    retrievePaymentIntent,
    cancelPaymentIntent,
    verifyWebhookSignature,
    // exported for tests / diagnostics
    authenticate,
    clearToken,
};
