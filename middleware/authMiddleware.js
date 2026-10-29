const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const session = require('../services/sessionService');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function bearer(req) {
    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    return scheme === 'Bearer' && token ? token : null;
}

/**
 * A signed-in person, by session cookie or by Authorization header.
 *
 * Checked against the user record on every request, not just the token's
 * signature: a token outlives a decision to remove someone's access, and until
 * now a revoked person kept working until theirs expired.
 *
 * Cookie-authenticated writes must also come from this system's own origin.
 * The session cookies are SameSite=None (required by the Access Portal
 * contract), which means a browser will attach them to a request any other
 * site makes — including a plain form post to an endpoint that charges a
 * card. Browsers always send Origin on such requests, so that is the check.
 * Header-authenticated requests cannot be forged that way and skip it.
 */
async function requireAuth(req, res, next) {
    try {
        const headerToken = bearer(req);
        const token = headerToken || session.readCookie(req, session.ACCESS_COOKIE);
        if (!token) {
            return res.status(401).json({ error: 'Not signed in' });
        }

        let payload;
        try {
            payload = session.verifyAccess(token);
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        if (!headerToken && !SAFE_METHODS.has(req.method) && !session.isAllowedOrigin(req)) {
            return res.status(403).json({ error: 'Request origin not allowed' });
        }

        const user = await User.findById(payload.sub).select('status').lean();
        if (!user || user.status !== 'active') {
            return res.status(401).json({ error: 'Your access has been removed' });
        }

        req.userId = payload.sub;
        req.authVia = headerToken ? 'header' : 'cookie';
        return next();
    } catch (err) {
        return next(err);
    }
}

// ============== Access Portal service authentication ==============

const SERVICE_TOKEN_TYPE = 'external-communication';

/** Constant-time comparison that does not leak the secret's length. */
function secretsMatch(given, expected) {
    const a = crypto.createHash('sha256').update(String(given)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * The raw shared secret, presented once to buy a service JWT.
 *
 * Refuses everything when the secret is not configured — an unset secret must
 * never match an empty Bearer value.
 */
function requireCommunicationSecret(req, res, next) {
    const configured = process.env.JWT_COMMUNICATION_SECRET;
    const given = bearer(req);
    if (!configured || !given || !secretsMatch(given, configured)) {
        return res.status(401).json({ success: false, message: 'Invalid communication secret', error: 'Invalid communication secret', data: null });
    }
    return next();
}

/**
 * The Access Portal's service JWT, on contract routes.
 *
 * Checks the claim, not merely the signature: a person's access token is
 * signed with the same secret, and if it passed here any signed-in user could
 * administer every account in this system.
 */
function requireServiceToken(req, res, next) {
    const token = bearer(req);
    if (!token) return res.status(401).json({ success: false, message: 'Service token required', error: 'Service token required', data: null });
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET || '');
        if (payload.type !== SERVICE_TOKEN_TYPE) {
            return res.status(401).json({ success: false, message: 'Service token required', error: 'Service token required', data: null });
        }
        return next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid or expired service token', error: 'Invalid or expired service token', data: null });
    }
}

function signServiceToken() {
    const expiresIn = '1d';
    const token = jwt.sign({ type: SERVICE_TOKEN_TYPE }, process.env.JWT_SECRET, { expiresIn });
    return { token, expiresIn };
}

module.exports = {
    requireAuth,
    requireCommunicationSecret,
    requireServiceToken,
    signServiceToken,
    bearer,
};
