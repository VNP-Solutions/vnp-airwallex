const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.post('/login', authController.login);
router.post('/verify', authController.verify);

router.post('/forgot-password', authController.forgotPassword);
router.post('/forgot-password/verify', authController.verifyForgotPassword);
router.post('/forgot-password/reset', authController.resetPassword);

module.exports = router;