const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/login', authController.login);
router.post('/verify', authController.verify);

// The browser's session, held in HttpOnly cookies.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

router.post('/forgot-password', authController.forgotPassword);
router.post('/forgot-password/verify', authController.verifyForgotPassword);
router.post('/forgot-password/reset', authController.resetPassword);

module.exports = router;