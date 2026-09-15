const express = require('express');
const hotelController = require('../controllers/hotelController');
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

router.get('/templates/import', requireAuth, hotelController.importTemplate);
router.get('/templates/update', requireAuth, hotelController.updateTemplate);
router.get('/export', requireAuth, hotelController.exportHotels);

router.get('/search', requireAuth, hotelController.searchHotels);
router.get('/stats', requireAuth, hotelController.getStats);
router.post('/query', requireAuth, hotelController.queryHotels);
router.get('/distinct/:field', requireAuth, hotelController.distinctValues);

router.post('/bulk/import', requireAuth, spreadsheetBody, hotelController.bulkImport);
router.post('/bulk/update', requireAuth, spreadsheetBody, hotelController.bulkUpdate);

router.get('/', requireAuth, hotelController.listHotels);
router.post('/', requireAuth, hotelController.createHotel);
router.get('/:id', requireAuth, hotelController.getHotel);
router.patch('/:id', requireAuth, hotelController.updateHotel);
router.delete('/:id', requireAuth, hotelController.archiveHotel);

module.exports = router;
