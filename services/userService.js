const crypto = require('crypto');
const User = require('../models/User');
const { sendInviteEmail } = require('./emailService');

const INVITE_TOKEN_TTL_DAYS = 7;

function appBaseUrl() {
    return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function generateInviteToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function createUser({ email, first_name, last_name, password }) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
        const err = new Error('A user with this email already exists');
        err.statusCode = 409;
        throw err;
    }

    const user = await User.create({
        email,
        first_name,
        last_name,
        password,
        status: 'active',
    });
    return user;
}

async function listUsers({
    q,
    status,
    sort = 'desc',
    limit = 50,
    skip = 0,
} = {}) {
    const query = {};
    if (q && String(q).trim()) {
        const escaped = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = { $regex: escaped, $options: 'i' };
        query.$or = [
            { email: regex },
            { first_name: regex },
            { last_name: regex },
        ];
    }
    if (status && ['active', 'pending', 'revoked'].includes(status)) {
        query.status = status;
    }

    const sortOrder = sort === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
        User.find(query)
            .sort({ created_at: sortOrder })
            .skip(skip)
            .limit(limit)
            .populate('invited_by', 'first_name last_name email'),
        User.countDocuments(query),
    ]);

    return { items, total, limit, skip };
}

async function getUserById(id) {
    const user = await User.findById(id).populate(
        'invited_by',
        'first_name last_name email'
    );
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }
    return user;
}

/**
 * Create a pending user record and email them an invite link to set their
 * own password. The link points at /accept-invite?token=… on APP_BASE_URL.
 */
async function inviteUser({ email, first_name, last_name, invited_by_id }) {
    const normalised = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalised });
    if (existing) {
        // If they were revoked previously, allow re-inviting by recycling
        // the same record. Otherwise reject.
        if (existing.status === 'revoked') {
            existing.status = 'pending';
            existing.first_name = first_name;
            existing.last_name = last_name;
            existing.invited_by = invited_by_id || existing.invited_by;
            existing.password = undefined;
            existing.invite_token = generateInviteToken();
            existing.invite_expires_at = new Date(
                Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
            );
            existing.invite_accepted_at = undefined;
            await existing.save();
            await sendInvite(existing, invited_by_id);
            return existing;
        }
        const err = new Error('A user with this email already exists');
        err.statusCode = 409;
        throw err;
    }

    const token = generateInviteToken();
    const expiresAt = new Date(
        Date.now() + INVITE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    );

    const user = await User.create({
        email: normalised,
        first_name,
        last_name,
        status: 'pending',
        invited_by: invited_by_id || undefined,
        invite_token: token,
        invite_expires_at: expiresAt,
    });

    await sendInvite(user, invited_by_id);
    return user;
}

async function sendInvite(user, invitedById) {
    let inviterName = null;
    if (invitedById) {
        const inviter = await User.findById(invitedById).select('first_name last_name');
        if (inviter) {
            inviterName = [inviter.first_name, inviter.last_name]
                .filter(Boolean)
                .join(' ')
                .trim();
        }
    }
    const inviteUrl = `${appBaseUrl()}/accept-invite?token=${encodeURIComponent(
        user.invite_token
    )}`;
    await sendInviteEmail({
        to: user.email,
        firstName: user.first_name,
        inviterName: inviterName || null,
        inviteUrl,
        expiresInDays: INVITE_TOKEN_TTL_DAYS,
    });
}

/**
 * Look up a pending user by their invite token without consuming it.
 * Used by the accept-invite page to confirm the link is still valid
 * before showing the form.
 */
async function previewInvite({ token }) {
    if (!token) {
        const err = new Error('Invite token is required');
        err.statusCode = 400;
        throw err;
    }
    const user = await User.findOne({
        invite_token: token,
        status: 'pending',
    }).select('+invite_token +invite_expires_at');
    if (!user) {
        const err = new Error('Invalid or expired invite link');
        err.statusCode = 404;
        throw err;
    }
    if (user.invite_expires_at && user.invite_expires_at.getTime() < Date.now()) {
        const err = new Error('This invite has expired. Ask for a new one.');
        err.statusCode = 410;
        throw err;
    }
    return {
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
    };
}

async function acceptInvite({ token, password }) {
    if (!token) {
        const err = new Error('Invite token is required');
        err.statusCode = 400;
        throw err;
    }
    if (!password || password.length < 8) {
        const err = new Error('Password must be at least 8 characters');
        err.statusCode = 400;
        throw err;
    }
    const user = await User.findOne({
        invite_token: token,
        status: 'pending',
    }).select('+invite_token +invite_expires_at');
    if (!user) {
        const err = new Error('Invalid or expired invite link');
        err.statusCode = 404;
        throw err;
    }
    if (user.invite_expires_at && user.invite_expires_at.getTime() < Date.now()) {
        const err = new Error('This invite has expired. Ask for a new one.');
        err.statusCode = 410;
        throw err;
    }

    user.password = password;
    user.status = 'active';
    user.invite_token = undefined;
    user.invite_expires_at = undefined;
    user.invite_accepted_at = new Date();
    await user.save();
    return { email: user.email };
}

async function revokeUser({ userId, actorId }) {
    if (String(userId) === String(actorId)) {
        const err = new Error("You can't revoke your own access");
        err.statusCode = 400;
        throw err;
    }
    const user = await User.findById(userId);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }
    if (user.status === 'revoked') {
        return user;
    }
    user.status = 'revoked';
    user.invite_token = undefined;
    user.invite_expires_at = undefined;
    await user.save();
    return user;
}

module.exports = {
    createUser,
    listUsers,
    getUserById,
    inviteUser,
    previewInvite,
    acceptInvite,
    revokeUser,
};