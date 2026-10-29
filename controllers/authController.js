const authService = require('../services/authService');
const session = require('../services/sessionService');
const User = require('../models/User');

/** What the browser is told about who is signed in. Never a token. */
function publicUser(user) {
    return {
        id: String(user._id),
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
    };
}

async function login(req, res, next) {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }

        const result = await authService.login({ email, password });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function verify(req, res, next) {
    try {
        const { email, otp } = req.body || {};
        if (!email || !otp) {
            return res.status(400).json({ error: 'email and otp are required' });
        }

        // It sets session cookies, so it must come from this system's own
        // pages — otherwise another site could sign a visitor in as someone
        // else (login CSRF).
        if (session.requestOrigin(req) && !session.isAllowedOrigin(req)) {
            return res.status(403).json({ error: 'Request origin not allowed' });
        }

        const user = await authService.verifyOtp({ email, otp });
        // The session goes in HttpOnly cookies; the page only learns who it is.
        session.setSessionCookies(res, session.issueTokens(user._id), {
            persistent: req.body.remember !== false,
        });
        return res.json({ data: { user: publicUser(user) } });
    } catch (err) {
        return next(err);
    }
}

async function forgotPassword(req, res, next) {
    try {
        const { email } = req.body || {};
        if (!email) {
            return res.status(400).json({ error: 'email is required' });
        }

        const result = await authService.requestPasswordReset({ email });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function verifyForgotPassword(req, res, next) {
    try {
        const { email, otp } = req.body || {};
        if (!email || !otp) {
            return res.status(400).json({ error: 'email and otp are required' });
        }

        const result = await authService.verifyPasswordResetOtp({ email, otp });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function resetPassword(req, res, next) {
    try {
        const { reset_token, new_password } = req.body || {};
        if (!reset_token || !new_password) {
            return res
                .status(400)
                .json({ error: 'reset_token and new_password are required' });
        }
        if (new_password.length < 8) {
            return res
                .status(400)
                .json({ error: 'Password must be at least 8 characters' });
        }

        const result = await authService.resetPassword({ reset_token, new_password });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

/**
 * Renew the browser's session from its refresh cookie.
 *
 * Refused once the person's access has been removed — otherwise taking access
 * away would last only until their access token expired.
 */
async function refresh(req, res, next) {
    try {
        const token = session.readCookie(req, session.REFRESH_COOKIE);
        if (!token) return res.status(401).json({ error: 'Not signed in' });

        let payload;
        try {
            payload = session.verifyRefresh(token);
        } catch (err) {
            session.clearSessionCookies(res);
            return res.status(401).json({ error: 'Session expired — sign in again' });
        }

        const user = await User.findById(payload.sub).select('status');
        if (!user || user.status !== 'active') {
            session.clearSessionCookies(res);
            return res.status(401).json({ error: 'Your access has been removed' });
        }

        session.setSessionCookies(res, session.issueTokens(user._id));
        return res.json({ data: { ok: true } });
    } catch (err) {
        return next(err);
    }
}

async function logout(req, res) {
    session.clearSessionCookies(res);
    return res.json({ data: { ok: true } });
}

/** Who the current session belongs to. Behind requireAuth. */
async function me(req, res, next) {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(401).json({ error: 'Not signed in' });
        return res.json({ data: publicUser(user) });
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    login,
    verify,
    refresh,
    logout,
    me,
    forgotPassword,
    verifyForgotPassword,
    resetPassword,
};