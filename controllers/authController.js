const authService = require('../services/authService');

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

        const result = await authService.verifyOtp({ email, otp });
        return res.json(result);
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

module.exports = {
    login,
    verify,
    forgotPassword,
    verifyForgotPassword,
    resetPassword,
};