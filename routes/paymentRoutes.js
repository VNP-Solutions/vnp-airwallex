const express = require('express');
const paymentController = require('../controllers/paymentController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Bulk uploads arrive as a raw body — CSV as text, .xlsx as binary. Parsed by
// magic bytes downstream, so the exact Content-Type the browser picks does not
// matter. Capped so an oversized file is rejected before it is ever inflated.
const spreadsheetBody = express.raw({
    type: [
        'text/csv',
        'text/plain',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream',
    ],
    limit: '10mb',
});

// Public — Airwallex posts here; authenticated by HMAC signature, not JWT.
router.post('/webhook', paymentController.handleWebhook);

// Public — the shopper returning from checkout has no session.
router.get('/status/:orderId', paymentController.getPublicStatus);

// Everything else is operator-facing and requires auth.
router.post('/', requireAuth, paymentController.createPayment);
router.get('/', requireAuth, paymentController.listPayments);
router.get('/stats', requireAuth, paymentController.getStats);
router.get('/analytics', requireAuth, paymentController.getAnalytics);

// Bulk creation. Declared before /:id so "bulk" is never read as a payment id.
router.get('/bulk/template', requireAuth, paymentController.bulkTemplate);
router.post('/bulk/validate', requireAuth, spreadsheetBody, paymentController.validateBulkPayments);
router.post('/bulk/create', requireAuth, spreadsheetBody, paymentController.startBulkPayments);
router.get('/bulk/jobs', requireAuth, paymentController.listBulkJobs);
router.get('/bulk/jobs/:jobId', requireAuth, paymentController.getBulkJob);
router.post('/query', requireAuth, paymentController.queryPayments);
// `field` may contain a dot (customer.email), so match the rest of the path.
router.get('/distinct/:field', requireAuth, paymentController.distinctValues);
router.get('/:id', requireAuth, paymentController.getPayment);
router.post('/:id/sync', requireAuth, paymentController.syncPayment);
router.post('/:id/checkout', requireAuth, paymentController.getCheckoutSession);
router.post('/:id/cancel', requireAuth, paymentController.cancelPayment);

module.exports = router;
