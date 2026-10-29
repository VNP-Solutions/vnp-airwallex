const jwt = require('jsonwebtoken');

/**
 * Sessions: the tokens, and the cookies that carry them to a browser.
 *
 * Three kinds of JWT are signed with JWT_SECRET, told apart by their `type`
 * claim so one can never be passed off as another:
 *
 *   access                  a signed-in person; short-lived
 *   refresh                 renews an access token; long-lived. Held by the
 *                           browser (in an HttpOnly cookie) and by the Access
 *                           Portal, which reuses it to open this system again
 *   external-communication  the Access Portal calling as a service — see
 *                           middleware/authMiddleware.js
 *
 * Browsers never see a token. Both live in HttpOnly cookies, which page
 * JavaScript cannot read; the Access Portal's server-to-server routes are the
 * only place a token appears in a response body.
 */

const ACCESS_COOKIE = 'awx_at';
const REFRESH_COOKIE = 'awx_rt';
// Narrowest path the refresh cookie is needed on: refresh and logout. Every
// other request goes without it.
const REFRESH_COOKIE_PATH = '/api/auth';

const DEFAULT_ACCESS_TTL = '1h';
const DEFAULT_REFRESH_TTL = '30d';

function secret() {
    const value = process.env.JWT_SECRET;
    if (!value) throw new Error('JWT_SECRET is not set');
    return value;
}

const accessTtl = () => process.env.ACCESS_TOKEN_TTL || DEFAULT_ACCESS_TTL;
const refreshTtl = () => process.env.REFRESH_TOKEN_TTL || DEFAULT_REFRESH_TTL;

function sign(payload, expiresIn) {
    const token = jwt.sign(payload, secret(), { expiresIn });
    const { exp } = jwt.decode(token);
    return { token, expires_at: new Date(exp * 1000) };
}

/** An access + refresh pair for one person. */
function issueTokens(userId) {
    const sub = String(userId);
    const access = sign({ sub, type: 'access' }, accessTtl());
    const refresh = sign({ sub, type: 'refresh' }, refreshTtl());
    return {
        access_token: access.token,
        refresh_token: refresh.token,
        access_expires_at: access.expires_at.toISOString(),
        refresh_expires_at: refresh.expires_at.toISOString(),
    };
}

function invalidToken(message = 'Invalid or expired token') {
    const err = new Error(message);
    err.statusCode = 401;
    return err;
}

/**
 * Verify a person's access token.
 *
 * Tokens issued before sessions had types carry neither `type` nor `purpose`
 * and are still accepted until they expire. Everything else must say it is an
 * access token: a refresh token, a password-reset token and the portal's
 * service token are all signed with the same secret and must not open a
 * session.
 */
function verifyAccess(token) {
    let payload;
    try {
        payload = jwt.verify(token, secret());
    } catch (e) {
        throw invalidToken();
    }
    const legacy = payload.type === undefined && payload.purpose === undefined;
    if (!payload.sub || !(payload.type === 'access' || legacy)) throw invalidToken();
    return payload;
}

function verifyRefresh(token) {
    let payload;
    try {
        payload = jwt.verify(token, secret());
    } catch (e) {
        throw invalidToken('Invalid or expired refresh token');
    }
    if (!payload.sub || payload.type !== 'refresh') {
        throw invalidToken('Invalid or expired refresh token');
    }
    return payload;
}

// ============== Cookies ==============

/**
 * HttpOnly, Secure, SameSite=None, and host-only — never a Domain attribute.
 *
 * A Domain on a shared parent would send this session to every sibling site
 * and let identically named cookies from other systems overwrite it. Secure is
 * set even locally: browsers treat http://localhost as a secure context.
 * Partitioned is not added because this frontend and API are served by the
 * same host; it only matters when they are on different sites.
 */
function cookieOptions({ path = '/', maxAge } = {}) {
    return {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path,
        ...(maxAge ? { maxAge } : {}),
    };
}

/**
 * Put a fresh session on the response.
 *
 * `persistent` decides whether the cookies outlive the browser: the sign-in
 * page's "remember me" turns it off, the portal handoff always keeps it on.
 */
function setSessionCookies(res, tokens, { persistent = true } = {}) {
    const now = Date.now();
    const accessAge = new Date(tokens.access_expires_at).getTime() - now;
    const refreshAge = new Date(tokens.refresh_expires_at).getTime() - now;

    res.cookie(
        ACCESS_COOKIE,
        tokens.access_token,
        cookieOptions({ maxAge: persistent ? accessAge : undefined })
    );
    res.cookie(
        REFRESH_COOKIE,
        tokens.refresh_token,
        cookieOptions({ path: REFRESH_COOKIE_PATH, maxAge: persistent ? refreshAge : undefined })
    );
}

/** Cleared with exactly the attributes they were set with, or they survive. */
function clearSessionCookies(res) {
    res.clearCookie(ACCESS_COOKIE, cookieOptions());
    res.clearCookie(REFRESH_COOKIE, cookieOptions({ path: REFRESH_COOKIE_PATH }));
}

/** Read one cookie without pulling in a parser for the sake of two values. */
function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        if (part.slice(0, idx).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(idx + 1).trim());
        } catch (e) {
            return null;
        }
    }
    return null;
}

// ============== Origins ==============

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch (e) {
        return null;
    }
}

/** Where this system's own frontend lives. Reuses APP_BASE_URL by default. */
function frontendUrl() {
    return (process.env.FRONTEND_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
}

/**
 * The origins allowed to act on a person's behalf with their cookies.
 *
 * CORS_ORIGINS when set, plus the frontend and app URLs, plus whatever host
 * this request actually arrived on: the frontend is served by this same
 * server, so its own origin is always legitimate.
 */
function allowedOrigins(req) {
    const list = new Set(
        String(process.env.CORS_ORIGINS || '')
            .split(',')
            .map((s) => originOf(s.trim()))
            .filter(Boolean)
    );
    for (const url of [process.env.FRONTEND_URL, process.env.APP_BASE_URL]) {
        const o = url && originOf(url);
        if (o) list.add(o);
    }
    if (req) {
        const own = originOf(`${req.protocol}://${req.get('host')}`);
        if (own) list.add(own);
    }
    return list;
}

/**
 * The origin a browser says a request came from: Origin, or failing that the
 * Referer's. null when neither is present.
 */
function requestOrigin(req) {
    return req.get('origin') || originOf(req.get('referer') || '') || null;
}

function isAllowedOrigin(req) {
    const origin = requestOrigin(req);
    return Boolean(origin && allowedOrigins(req).has(origin));
}

module.exports = {
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    issueTokens,
    verifyAccess,
    verifyRefresh,
    setSessionCookies,
    clearSessionCookies,
    readCookie,
    frontendUrl,
    allowedOrigins,
    requestOrigin,
    isAllowedOrigin,
};
