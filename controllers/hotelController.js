const hotelService = require('../services/hotelService');

/** Send a CSV as a download with the given filename. */
function sendCsv(res, filename, body) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(body);
}

/**
 * The uploaded spreadsheet, untouched.
 *
 * Returned as a Buffer wherever possible so an .xlsx survives intact — decoding
 * it to a string would corrupt the zip. The parser dispatches on magic bytes.
 */
function readUploadBody(req) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return req.body;
    if (req.body && typeof req.body.csv === 'string') return req.body.csv;
    return '';
}

/** Is there anything to parse? Works for both a Buffer and a string. */
function hasContent(body) {
    if (Buffer.isBuffer(body)) return body.length > 0;
    return String(body || '').trim().length > 0;
}

async function queryHotels(req, res, next) {
    try {
        const body = req.body || {};
        const result = await hotelService.queryHotels({
            filters: body.filters || {},
            sort: body.sort || null,
            search: body.search,
            limit: body.limit,
            skip: body.skip,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function listHotels(req, res, next) {
    try {
        const result = await hotelService.queryHotels({
            search: req.query.q,
            limit: req.query.limit,
            skip: req.query.skip,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function searchHotels(req, res, next) {
    try {
        const result = await hotelService.searchHotels({
            q: req.query.q,
            limit: req.query.limit,
            includeArchived: req.query.include_archived === 'true',
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function distinctValues(req, res, next) {
    try {
        const result = await hotelService.distinctValues({
            field: req.params.field,
            search: req.query.search,
            limit: req.query.limit,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
}

async function getStats(req, res, next) {
    try {
        return res.json(await hotelService.getStats());
    } catch (err) {
        return next(err);
    }
}

async function createHotel(req, res, next) {
    try {
        const hotel = await hotelService.createHotel(req.body || {}, {
            userId: req.userId,
        });
        return res.status(201).json(hotel);
    } catch (err) {
        return next(err);
    }
}

async function getHotel(req, res, next) {
    try {
        return res.json(await hotelService.getHotel(req.params.id));
    } catch (err) {
        return next(err);
    }
}

async function updateHotel(req, res, next) {
    try {
        const hotel = await hotelService.updateHotel(req.params.id, req.body || {}, {
            userId: req.userId,
        });
        return res.json(hotel);
    } catch (err) {
        return next(err);
    }
}

async function archiveHotel(req, res, next) {
    try {
        const hotel = await hotelService.archiveHotel(req.params.id, {
            userId: req.userId,
        });
        return res.json(hotel);
    } catch (err) {
        return next(err);
    }
}

async function bulkImport(req, res, next) {
    try {
        const upload = readUploadBody(req);
        if (!hasContent(upload)) {
            return res.status(400).json({ error: 'No file content received' });
        }
        const result = await hotelService.bulkImport(upload, {
            userId: req.userId,
            upsert: req.query.upsert === 'true',
        });
        // Nothing was written when the file had errors — say so with a 422 so
        // the frontend does not report a successful import.
        return res.status(result.applied ? 200 : 422).json(result);
    } catch (err) {
        return next(err);
    }
}

async function bulkUpdate(req, res, next) {
    try {
        const upload = readUploadBody(req);
        if (!hasContent(upload)) {
            return res.status(400).json({ error: 'No file content received' });
        }
        const result = await hotelService.bulkUpdate(upload, { userId: req.userId });
        return res.status(result.applied ? 200 : 422).json(result);
    } catch (err) {
        return next(err);
    }
}

function importTemplate(req, res) {
    return sendCsv(res, 'hotels-import-template.csv', hotelService.importTemplate());
}

function updateTemplate(req, res) {
    return sendCsv(res, 'hotels-update-template.csv', hotelService.updateTemplate());
}

async function exportHotels(req, res, next) {
    try {
        const csv = await hotelService.exportCsv({ search: req.query.q });
        const stamp = new Date().toISOString().slice(0, 10);
        return sendCsv(res, `hotels-${stamp}.csv`, csv);
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    queryHotels,
    listHotels,
    searchHotels,
    distinctValues,
    getStats,
    createHotel,
    getHotel,
    updateHotel,
    archiveHotel,
    bulkImport,
    bulkUpdate,
    importTemplate,
    updateTemplate,
    exportHotels,
};
