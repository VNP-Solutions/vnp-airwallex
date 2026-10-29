const express = require('express');
const { requireCommunicationSecret, signServiceToken } = require('../middleware/authMiddleware');

/**
 * Service authentication for the VNP Access Portal, at
 * /api/external-auth/generate-token — the same path on every VNP system, so
 * the portal needs no per-system configuration.
 *
 * The raw JWT_COMMUNICATION_SECRET buys a JWT marked as a service token, valid
 * for a day. That token is as powerful as a full administrator here.
 */
const router = express.Router();

router.post('/generate-token', requireCommunicationSecret, (req, res) => {
    res.json(signServiceToken());
});

module.exports = router;
