const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        return next(new Error('JWT_SECRET is not set'));
    }

    try {
        const payload = jwt.verify(token, secret);
        if (!payload.sub) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        req.userId = payload.sub;
        return next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = { requireAuth };