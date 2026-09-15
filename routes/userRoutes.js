const express = require('express');
const userController = require('../controllers/userController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Public — used by the /accept-invite page (no token needed since the
// invite token itself is the credential).
router.get('/invite/preview', userController.previewInvite);
router.post('/accept-invite', userController.acceptInvite);

// Everything else requires auth.
router.post('/', requireAuth, userController.createUser);
router.get('/', requireAuth, userController.listUsers);
router.post('/invite', requireAuth, userController.inviteUser);
router.get('/:id', requireAuth, userController.getUser);
router.delete('/:id', requireAuth, userController.revokeUser);

module.exports = router;