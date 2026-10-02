const express = require('express');
const batchController = require('../controllers/batchController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/', requireAuth, batchController.listBatches);
// Declared before /:id so "bulk-delete" is never read as a batch id.
router.post('/bulk-delete', requireAuth, batchController.bulkDeleteBatches);

router.get('/:id', requireAuth, batchController.getBatch);
router.delete('/:id', requireAuth, batchController.deleteBatch);

router.post('/:id/run', requireAuth, batchController.startRun);
router.post('/:id/stop', requireAuth, batchController.stopRun);

module.exports = router;
