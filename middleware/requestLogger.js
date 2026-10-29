const crypto = require('crypto');

/**
 * One log line per API request, for reading in `pm2 logs`.
 *
 *   [api] 2026-10-29T12:04:11.512Z id=3f9a1c2e GET /api/access-portal/v1/roles
 *         -> 401 12ms ip=203.0.113.7 auth=bearer:invalid ua="node-fetch/1.0"
 *         error="Invalid or expired service token"
 *
 * Built to answer "is the Access Portal even reaching us, and what did we tell
 * it?" — so it records who called (IP, origin, user agent), how they
 * authenticated (the KIND of credential, never the value), what we answered,
 * and for any failure the error message we sent back.
 *
 * Never logged: request or response bodies, tokens, secrets, passwords,
 * cookies, or the handoff code. Query values whose names could carry one are
 * redacted. Every response carries the request id in X-Request-Id, so a
 * failure the portal team sees can be matched to the line here.
 *
 * Set API_LOG=off to silence it.
 */

// Query parameters that may carry a credential. Matched by name, case-insensitive.
const REDACT_QUERY = /^(code|token|access_token|refresh_token|secret|password|key|api_key|signature)$/i;

// Paths worth logging. Static assets are noise; the handoff page is not.
const LOGGED = /^\/(api\/|auth\/handoff)/;

function enabled() {
    return String(process.env.API_LOG || 'on').toLowerCase() !== 'off';
}

/** The path with credential-like query values replaced. */
function safeUrl(req) {
    const [path, query] = req.originalUrl.split('?');
    if (!query) return path;
    const parts = [];
    for (const [key, value] of new URLSearchParams(query)) {
        parts.push(
            REDACT_QUERY.test(key)
                ? `${key}=<redacted:${value.length}>`
                : `${key}=${encodeURIComponent(value)}`
        );
    }
    return `${path}?${parts.join('&')}`;
}

/** What kind of credential arrived — never its value. */
function authKind(req) {
    const header = String(req.headers.authorization || '');
    if (header) {
        const [scheme, value] = header.split(' ');
        if (scheme !== 'Bearer' || !value) return 'header:malformed';
        // A JWT has three dot-separated parts; the raw shared secret does not.
        // Distinguishing them shows whether the portal sent the secret where a
        // token belongs, or the other way round.
        return value.split('.').length === 3 ? 'bearer:jwt' : 'bearer:opaque';
    }
    if (/(?:^|;\s*)awx_at=/.test(req.headers.cookie || '')) return 'cookie';
    return 'none';
}

const quote = (v) => `"${String(v).replace(/"/g, "'").slice(0, 200)}"`;

function requestLogger(req, res, next) {
    req.id = crypto.randomBytes(4).toString('hex');
    res.set('X-Request-Id', req.id);

    if (!enabled() || !LOGGED.test(req.path)) return next();

    const started = process.hrtime.bigint();

    // Keep the error message we send, without keeping the rest of the body.
    let errorMessage = null;
    let errorCode = null;
    const json = res.json.bind(res);
    res.json = (body) => {
        if (body && typeof body === 'object' && res.statusCode >= 400) {
            errorMessage = body.error || body.message || null;
            errorCode = body.code || null;
        }
        return json(body);
    };

    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const parts = [
            `[api] ${new Date().toISOString()} id=${req.id}`,
            `${req.method} ${safeUrl(req)}`,
            `-> ${res.statusCode} ${ms.toFixed(0)}ms`,
            `ip=${req.ip}`,
            `auth=${authKind(req)}`,
        ];
        const origin = req.get('origin');
        if (origin) parts.push(`origin=${origin}`);
        const ua = req.get('user-agent');
        if (ua) parts.push(`ua=${quote(ua)}`);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.get('location')) {
            // Strip the fragment: the handoff redirect carries the code there.
            parts.push(`location=${res.get('location').split('#')[0]}`);
        }
        if (errorCode) parts.push(`code=${errorCode}`);
        if (errorMessage) parts.push(`error=${quote(errorMessage)}`);

        const line = parts.join(' ');
        if (res.statusCode >= 500) console.error(line);
        else console.log(line);
    });

    // A request that never finishes — the client hung up, or we never answered.
    res.on('close', () => {
        if (!res.writableFinished) {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            console.warn(
                `[api] ${new Date().toISOString()} id=${req.id} ${req.method} ${safeUrl(req)} -> aborted after ${ms.toFixed(0)}ms ip=${req.ip}`
            );
        }
    });

    return next();
}

module.exports = { requestLogger };
