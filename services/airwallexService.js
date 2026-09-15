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

function baseUrl() {
    return (process.env.AIRWALLEX_BASE_URL || 'https://api-demo.airwallex.com').replace(
        /\/$/,
        ''
    );
}

/**
 * Which Airwallex environment the browser SDK should talk to. Derived from the
 * API host so the two can never drift apart.
 */
function env() {
    if (process.env.AIRWALLEX_ENV) return process.env.AIRWALLEX_ENV;
    // Both api-demo.airwallex.com and api.sandbox.airwallex.com are test hosts.
    return /(-demo|sandbox)\./.test(baseUrl()) ? 'demo' : 'prod';
}

function requireCredentials() {
    const clientId = process.env.AIRWALLEX_CLIENT_ID;
    const apiKey = process.env.AIRWALLEX_API_KEY;
    if (!clientId || !apiKey) {
        const err = new Error(
            'AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY must be set'
        );
        err.statusCode = 500;
        throw err;
    }
    return { clientId, apiKey };
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
        token: data.token,
        expiresAt: data.expires_at
            ? new Date(data.expires_at).getTime()
            : Date.now() + 30 * 60 * 1000,
    };
    return cachedToken.token;
}

async function getToken() {
    if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) {
        return cachedToken.token;
    }
    return authenticate();
}

function clearToken() {
    cachedToken = null;
}

async function request(method, path, body, { retryOnAuthFailure = true } = {}) {
    const token = await getToken();

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
        return request(method, path, body, { retryOnAuthFailure: false });
    }

    if (!res.ok) throw await readError(res);
    return res.json();
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

    return request('POST', '/api/v1/pa/payment_intents/create', payload);
}

async function retrievePaymentIntent(id) {
    return request('GET', `/api/v1/pa/payment_intents/${encodeURIComponent(id)}`);
}

async function cancelPaymentIntent(id, { request_id, cancellation_reason } = {}) {
    return request(
        'POST',
        `/api/v1/pa/payment_intents/${encodeURIComponent(id)}/cancel`,
        {
            request_id: request_id || crypto.randomUUID(),
            cancellation_reason: cancellation_reason || 'requested_by_customer',
        }
    );
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
