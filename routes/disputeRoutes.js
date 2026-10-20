const express = require('express');
const disputeController = require('../controllers/disputeController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * Evidence arrives as raw bytes with the filename in the query string, so the
 * body is kept as a Buffer rather than parsed. 20MB is Airwallex's own limit.
 */
const fileBody = express.raw({ type: () => true, limit: '20mb' });

// Declared before /:id so these are never read as dispute ids.
router.get('/options', requireAuth, disputeController.getOptions);
router.get('/stats', requireAuth, disputeController.getStats);
router.post('/sync', requireAuth, disputeController.syncDisputes);
router.post('/simulate', requireAuth, disputeController.simulate);

router.get('/', requireAuth, disputeController.listDisputes);
router.get('/:id', requireAuth, disputeController.getDispute);

router.post('/:id/challenge', requireAuth, disputeController.challengeDispute);
router.post('/:id/accept', requireAuth, disputeController.acceptDispute);
router.post('/:id/metadata', requireAuth, disputeController.updateMetadata);

router.post('/:id/evidence', requireAuth, fileBody, disputeController.uploadEvidence);
router.delete('/:id/evidence/:fileId', requireAuth, disputeController.removeEvidence);

// Sandbox only — the service refuses these against a live account.
router.post('/:id/simulate/escalate', requireAuth, disputeController.simulateEscalate);
router.post('/:id/simulate/resolve', requireAuth, disputeController.simulateResolve);

module.exports = router;
