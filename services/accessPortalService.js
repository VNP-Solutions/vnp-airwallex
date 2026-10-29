const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const session = require('./sessionService');
const { normaliseEmail } = require('./authService');

/**
 * The VNP Access Portal contract (v2), carried out on this system's users.
 *
 * The portal calls as a trusted service and decides who may do what; this
 * side carries it out. Three things about this system shape the mapping:
 *
 *   Roles    This system has none — everyone signed in can do everything. It
 *            exposes a single role so the portal's create/assign flow works
 *            without inventing permissions nothing here would enforce.
 *   Status   Users are active, pending (invited, not yet accepted) or revoked.
 *            is_active is `status === 'active'`; disabling revokes, it never
 *            deletes.
 *   Email    Nothing here sends mail on a portal-driven change: accounts are
 *            created directly, never through the invitation flow.
 */

const ROLES = [{ id: 'user', name: 'User' }];
const ROLE_IDS = new Set(ROLES.map((r) => r.id));

/** This system's only password rule. Looser than the portal's, so anything it accepts passes here. */
const PASSWORD_MIN = 8;

function httpError(status, message, code) {
    const err = new Error(message);
    err.statusCode = status;
    if (code) err.code = code;
    return err;
}

/** The person, in the contract's shape. */
function toContractUser(user) {
    return {
        id: String(user._id),
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        role_id: ROLES[0].id,
        role_name: ROLES[0].name,
        is_active: user.status === 'active',
    };
}

/** A malformed id is "no such user" — a 404, never a cast error turned 500. */
async function findById(id, select) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'User not found');
    const query = User.findById(id);
    if (select) query.select(select);
    const user = await query;
    if (!user) throw httpError(404, 'User not found');
    return user;
}

function assertPassword(password) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
        throw httpError(422, `Password must be at least ${PASSWORD_MIN} characters`, 'INVALID_PASSWORD');
    }
}

// ============== Auth ==============

/** Email + password in, token pair out. No code, no email. */
async function login({ email, password }) {
    if (!email || !password) throw httpError(401, 'Invalid email or password');
    const user = await User.findOne({ email: normaliseEmail(email) }).select('+password');
    if (!user || user.status !== 'active' || !user.password) {
        throw httpError(401, 'Invalid email or password');
    }
    if (!(await user.comparePassword(String(password)))) {
        throw httpError(401, 'Invalid email or password');
    }
    return session.issueTokens(user._id);
}

/** Renew a pair. Refused once the person has been disabled. */
async function refresh({ refresh_token }) {
    if (!refresh_token) throw httpError(401, 'Invalid or expired refresh token');
    const payload = session.verifyRefresh(refresh_token);
    const user = await User.findById(payload.sub).select('status');
    if (!user || user.status !== 'active') {
        throw httpError(401, 'Invalid or expired refresh token');
    }
    return session.issueTokens(user._id);
}

/** Whether a person's access token still works, and whose it is. */
async function me(accessToken) {
    if (!accessToken) throw httpError(401, 'Access token required');
    const payload = session.verifyAccess(accessToken);
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'active') throw httpError(401, 'Invalid or expired token');
    return toContractUser(user);
}

// ============== Users ==============

/** Exact equality on a normalised email. A lookup, not a search. */
async function findByEmail(email) {
    const normalised = normaliseEmail(email);
    if (!normalised) throw httpError(422, 'email is required');
    const user = await User.findOne({ email: normalised });
    return user ? toContractUser(user) : null;
}

/**
 * Create an account directly, usable at once, with the password given.
 *
 * Deliberately not the invitation flow: that emails the person and leaves them
 * pending, and the portal expects silence and a working login.
 */
async function createUser({ email, first_name, last_name, password, role_id, is_active }) {
    const normalised = normaliseEmail(email);
    if (!normalised) throw httpError(422, 'email is required');
    if (!String(first_name || '').trim() || !String(last_name || '').trim()) {
        throw httpError(422, 'first_name and last_name are required');
    }
    if (!ROLE_IDS.has(role_id)) throw httpError(422, 'role_id is not a role in this system', 'UNKNOWN_ROLE');
    assertPassword(password);

    const existing = await User.findOne({ email: normalised });
    if (existing) {
        if (existing.status === 'pending') {
            throw httpError(409, 'An invitation for this email has not been accepted yet', 'INVITATION_PENDING');
        }
        throw httpError(409, 'A user with this email already exists', 'EMAIL_EXISTS');
    }

    try {
        const user = await User.create({
            email: normalised,
            first_name: String(first_name).trim(),
            last_name: String(last_name).trim(),
            password,
            status: is_active === false ? 'revoked' : 'active',
        });
        return { id: String(user._id) };
    } catch (err) {
        // Two creates for the same email racing each other.
        if (err && err.code === 11000) {
            throw httpError(409, 'A user with this email already exists', 'EMAIL_EXISTS');
        }
        throw err;
    }
}

async function getUser(id) {
    return toContractUser(await findById(id));
}

/**
 * Set the password to exactly this value.
 *
 * Hashed by the model's own save hook, as every other password here is. No
 * email, no forced change at next login, and existing sessions are left alone
 * (this system does not sign people out on a password change anywhere else).
 * Idempotent: setting the same value again simply succeeds. Works whatever the
 * account's status.
 */
async function setPassword(id, password) {
    assertPassword(password);
    const user = await findById(id, '+password');
    user.password = password;
    // Any reset in flight was for the password this replaces.
    user.reset_otp_hash = undefined;
    user.reset_otp_expires_at = undefined;
    await user.save();

    // A 200 has to mean the login will accept it — so check, rather than trust
    // that the save did what it should.
    const stored = await User.findById(user._id).select('+password');
    if (!stored || !(await stored.comparePassword(password))) {
        throw httpError(500, 'Password was not stored');
    }
    return { id: String(user._id) };
}

async function setRole(id, role_id) {
    const user = await findById(id);
    if (!ROLE_IDS.has(role_id)) throw httpError(422, 'role_id is not a role in this system', 'UNKNOWN_ROLE');
    // One role: there is nothing to change, but the request is valid.
    return { id: String(user._id) };
}

/**
 * Enable or disable. Never deletes.
 *
 * Enabling someone still pending an invitation needs a password on the
 * account; with one (set through the password route) it activates them, and
 * without one there is nothing they could sign in with.
 */
async function setStatus(id, is_active) {
    if (typeof is_active !== 'boolean') throw httpError(422, 'is_active must be true or false');
    const user = await findById(id, '+password');

    if (is_active) {
        if (user.status === 'pending' && !user.password) {
            throw httpError(
                409,
                'This invitation has not been accepted and the account has no password yet',
                'INVITATION_PENDING'
            );
        }
        user.status = 'active';
    } else {
        user.status = 'revoked';
    }
    user.invite_token = undefined;
    user.invite_expires_at = undefined;
    await user.save();
    return { id: String(user._id), is_active: user.status === 'active' };
}

function listRoles() {
    return ROLES;
}

// ============== Handoff ==============

const REDEEM_TIMEOUT_MS = 10000;

function portalConfigured() {
    return Boolean(process.env.ACCESS_PORTAL_URL && process.env.ACCESS_PORTAL_HANDOFF_SECRET);
}

/**
 * Trade a handoff code for one of our own refresh tokens, server to server.
 *
 * Only the code is sent: the handoff secret is what tells the portal which
 * system is asking. The outcomes are kept distinct on purpose, so an expired
 * link and a misconfigured secret never look the same to whoever is debugging.
 */
async function redeem(code) {
    const url = `${process.env.ACCESS_PORTAL_URL.replace(/\/$/, '')}/api/handoff/redeem`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Handoff-Secret': process.env.ACCESS_PORTAL_HANDOFF_SECRET,
            },
            body: JSON.stringify({ code }),
            signal: AbortSignal.timeout(REDEEM_TIMEOUT_MS),
        });
    } catch (err) {
        return { outcome: 'unreachable' };
    }

    if (res.ok) {
        const body = await res.json().catch(() => ({}));
        return body && body.token ? { outcome: 'ok', token: body.token } : { outcome: 'bad_response', status: res.status };
    }
    if (res.status === 400) return { outcome: 'code_rejected', status: 400 };
    if (res.status === 401 || res.status === 403) return { outcome: 'secret_rejected', status: res.status };
    // Nothing at that path, or not accepting POST: ACCESS_PORTAL_URL is not the
    // portal's API. Its public address is a static site, so this is the likely
    // misconfiguration and worth naming on its own.
    if (res.status === 404 || res.status === 405) return { outcome: 'wrong_address', status: res.status };
    return { outcome: 'portal_error', status: res.status };
}

/** In-memory, per IP: plenty for one process, and it resets on restart. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();

function rateLimited(ip) {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.reset <= now) {
        hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
        if (hits.size > 10000) {
            for (const [key, value] of hits) if (value.reset <= now) hits.delete(key);
        }
        return false;
    }
    entry.count += 1;
    return entry.count > RATE_LIMIT;
}

/** A short id that ties one attempt's log lines together. Never the code itself. */
function traceId() {
    return crypto.randomBytes(4).toString('hex');
}

module.exports = {
    ROLES,
    toContractUser,
    login,
    refresh,
    me,
    findByEmail,
    createUser,
    getUser,
    setPassword,
    setRole,
    setStatus,
    listRoles,
    portalConfigured,
    redeem,
    rateLimited,
    traceId,
};
