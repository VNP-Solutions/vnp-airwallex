const userService = require('../services/userService');

async function createUser(req, res, next) {
    try {
        const { email, first_name, last_name, password } = req.body || {};

        if (!email || !first_name || !last_name || !password) {
            return res.status(400).json({
                error: 'email, first_name, last_name and password are required',
            });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const user = await userService.createUser({ email, first_name, last_name, password });
        return res.status(201).json(user);
    } catch (err) {
        return next(err);
    }
}

async function listUsers(req, res, next) {
    try {
        const { q, status, sort, limit, skip } = req.query;
        const result = await userService.listUsers({
            q,
            status,
            sort,
            limit: limit ? Number(limit) : undefined,
            skip: skip ? Number(skip) : undefined,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function getUser(req, res, next) {
    try {
        const { id } = req.params;
        if (req.userId !== id) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const user = await userService.getUserById(id);
        return res.json(user);
    } catch (err) {
        return next(err);
    }
}

async function inviteUser(req, res, next) {
    try {
        const { email, first_name, last_name } = req.body || {};
        if (!email || !first_name || !last_name) {
            return res.status(400).json({
                error: 'email, first_name and last_name are required',
            });
        }
        const user = await userService.inviteUser({
            email,
            first_name,
            last_name,
            invited_by_id: req.userId,
        });
        return res.status(201).json(user);
    } catch (err) {
        return next(err);
    }
}

async function previewInvite(req, res, next) {
    try {
        const { token } = req.query;
        const result = await userService.previewInvite({ token });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function acceptInvite(req, res, next) {
    try {
        const { token, password } = req.body || {};
        const result = await userService.acceptInvite({ token, password });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function revokeUser(req, res, next) {
    try {
        const { id } = req.params;
        const user = await userService.revokeUser({
            userId: id,
            actorId: req.userId,
        });
        return res.json(user);
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    createUser,
    listUsers,
    getUser,
    inviteUser,
    previewInvite,
    acceptInvite,
    revokeUser,
};