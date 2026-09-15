const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { sendOtpEmail, sendPasswordResetEmail } = require('./emailService');

const OTP_TTL_MINUTES = 10;
const RESET_OTP_TTL_MINUTES = 15;
const RESET_TOKEN_TTL = '15m';
const OTP_BCRYPT_ROUNDS = 8;

function signToken(userId) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not set');
    }
    const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
    return jwt.sign({ sub: userId.toString() }, secret, { expiresIn });
}

function signResetToken(userId) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not set');
    }
    return jwt.sign(
        { sub: userId.toString(), purpose: 'password_reset' },
        secret,
        { expiresIn: RESET_TOKEN_TTL }
    );
}

function generateOtp() {
    const n = crypto.randomInt(0, 1_000_000);
    return n.toString().padStart(6, '0');
}

async function login({ email, password }) {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) {
        const err = new Error('Invalid email or password');
        err.statusCode = 401;
        throw err;
    }

    if (user.status === 'revoked') {
        const err = new Error('Your access has been revoked. Contact an administrator.');
        err.statusCode = 403;
        throw err;
    }
    if (user.status === 'pending') {
        const err = new Error('Please accept your email invitation before signing in.');
        err.statusCode = 403;
        throw err;
    }

    const matches = await user.comparePassword(password);
    if (!matches) {
        const err = new Error('Invalid email or password');
        err.statusCode = 401;
        throw err;
    }

    const otp = generateOtp();
    const otp_hash = await bcrypt.hash(otp, OTP_BCRYPT_ROUNDS);
    const otp_expires_at = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    user.otp_hash = otp_hash;
    user.otp_expires_at = otp_expires_at;
    await user.save();

    await sendOtpEmail({ to: user.email, otp, firstName: user.first_name });

    return {
        message: 'OTP sent to your email',
        email: user.email,
        expires_at: otp_expires_at.toISOString(),
    };
}

async function verifyOtp({ email, otp }) {
    const user = await User.findOne({ email: email.toLowerCase() }).select(
        '+otp_hash +otp_expires_at'
    );
    if (!user || !user.otp_hash || !user.otp_expires_at) {
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    if (user.otp_expires_at.getTime() < Date.now()) {
        user.otp_hash = undefined;
        user.otp_expires_at = undefined;
        await user.save();
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    const matches = await bcrypt.compare(otp, user.otp_hash);
    if (!matches) {
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    user.otp_hash = undefined;
    user.otp_expires_at = undefined;
    await user.save();

    const token = signToken(user._id);
    return {
        userId: user._id.toString(),
        token,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
    };
}

async function requestPasswordReset({ email }) {
    // Don't reveal whether the email exists — always return success.
    const normalized = email.toLowerCase();
    const user = await User.findOne({ email: normalized });

    if (user) {
        const otp = generateOtp();
        const reset_otp_hash = await bcrypt.hash(otp, OTP_BCRYPT_ROUNDS);
        const reset_otp_expires_at = new Date(
            Date.now() + RESET_OTP_TTL_MINUTES * 60 * 1000
        );

        user.reset_otp_hash = reset_otp_hash;
        user.reset_otp_expires_at = reset_otp_expires_at;
        await user.save();

        await sendPasswordResetEmail({
            to: user.email,
            otp,
            firstName: user.first_name,
        });
    }

    return {
        message: 'If an account exists for this email, a reset code has been sent.',
        email: normalized,
    };
}

async function verifyPasswordResetOtp({ email, otp }) {
    const user = await User.findOne({ email: email.toLowerCase() }).select(
        '+reset_otp_hash +reset_otp_expires_at'
    );
    if (!user || !user.reset_otp_hash || !user.reset_otp_expires_at) {
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    if (user.reset_otp_expires_at.getTime() < Date.now()) {
        user.reset_otp_hash = undefined;
        user.reset_otp_expires_at = undefined;
        await user.save();
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    const matches = await bcrypt.compare(otp, user.reset_otp_hash);
    if (!matches) {
        const err = new Error('Invalid or expired code');
        err.statusCode = 401;
        throw err;
    }

    // Burn the OTP — it can only be used once.
    user.reset_otp_hash = undefined;
    user.reset_otp_expires_at = undefined;
    await user.save();

    const reset_token = signResetToken(user._id);
    return { reset_token };
}

async function resetPassword({ reset_token, new_password }) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not set');
    }

    let payload;
    try {
        payload = jwt.verify(reset_token, secret);
    } catch (e) {
        const err = new Error('Invalid or expired reset token');
        err.statusCode = 401;
        throw err;
    }

    if (payload.purpose !== 'password_reset' || !payload.sub) {
        const err = new Error('Invalid reset token');
        err.statusCode = 401;
        throw err;
    }

    const user = await User.findById(payload.sub);
    if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
    }

    user.password = new_password;
    await user.save();

    return { message: 'Password has been reset successfully' };
}

module.exports = {
    login,
    verifyOtp,
    signToken,
    requestPasswordReset,
    verifyPasswordResetOtp,
    resetPassword,
};