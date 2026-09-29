const express = require('express');
const financeController = require('../controllers/financeController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/environment', requireAuth, financeController.getEnvironment);
router.get('/balances', requireAuth, financeController.getBalances);

router.get('/settlements', requireAuth, financeController.getSettlements);
router.get('/settlements/:batchId', requireAuth, financeController.getSettlementTransactions);

router.get('/transactions', requireAuth, financeController.getTransactions);
router.get('/transactions/export', requireAuth, financeController.exportTransactions);

// Declared before /reports/:id so "options" is never read as a report id.
router.get('/reports/options', requireAuth, financeController.reportOptions);
router.get('/reports', requireAuth, financeController.listReports);
router.post('/reports', requireAuth, financeController.createReport);
router.get('/reports/:id', requireAuth, financeController.getReport);
router.get('/reports/:id/download', requireAuth, financeController.downloadReport);

module.exports = router;
