const Hotel = require('../models/Hotel');
// Registers the User model for the populate() calls below — see the same note
// in paymentService.
require('../models/User');
const { buildTemplate, toCsv } = require('./csv');
const { parseTabular } = require('./tabular');

const DESCRIPTOR_MAX_LENGTH = 32;
const BULK_ROW_LIMIT = 5000;

// Column headers used by both the downloadable templates and the importer.
// Import/update accept these case-insensitively so a spreadsheet that has been
// re-saved with different capitalisation still lines up.
const IMPORT_HEADERS = ['Portfolio', 'Hotel Name', 'Expedia ID', 'Descriptor', 'Website'];
const UPDATE_HEADERS = ['Expedia ID', 'Portfolio', 'Hotel Name', 'Descriptor', 'Website', 'Status'];

const HEADER_TO_FIELD = {
    portfolio: 'portfolio',
    'hotel name': 'name',
    name: 'name',
    'expedia id': 'expedia_id',
    expedia_id: 'expedia_id',
    descriptor: 'descriptor',
    website: 'website',
    url: 'website',
    status: 'status',
};

// ============== Filters (mirrors paymentService) ==============
const FILTERABLE_FIELDS = {
    portfolio: 'enum',
    name: 'text',
    expedia_id: 'text',
    descriptor: 'text',
    website: 'text',
    status: 'enum',
    created_at: 'date',
};

const SORTABLE_FIELDS = new Set(Object.keys(FILTERABLE_FIELDS));

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCondition(kind, filter) {
    if (!filter || typeof filter !== 'object') return null;
    const { op } = filter;

    if (kind === 'text' || kind === 'enum') {
        const value = filter.value;
        if (op === 'in' && Array.isArray(value)) {
            const cleaned = value.filter((v) => v != null && v !== '');
            return cleaned.length ? { $in: cleaned } : null;
        }
        if (op === 'contains' && value) return { $regex: escapeRegex(value), $options: 'i' };
        if (op === 'startswith' && value) return { $regex: '^' + escapeRegex(value), $options: 'i' };
        if (op === 'endswith' && value) return { $regex: escapeRegex(value) + '$', $options: 'i' };
        if (op === 'eq' && value !== undefined && value !== '') return value;
        return null;
    }

    if (kind === 'date') {
        const cond = {};
        if (filter.after) {
            const d = new Date(filter.after);
            if (!Number.isNaN(d.getTime())) cond.$gte = d;
        }
        if (filter.before) {
            const d = new Date(filter.before);
            if (!Number.isNaN(d.getTime())) {
                cond.$lt = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            }
        }
        return Object.keys(cond).length ? cond : null;
    }

    return null;
}

function buildQuery({ filters, search }) {
    const query = {};

    if (filters && typeof filters === 'object') {
        for (const [field, filter] of Object.entries(filters)) {
            const kind = FILTERABLE_FIELDS[field];
            if (!kind) continue;
            const cond = buildCondition(kind, filter);
            if (cond !== null) query[field] = cond;
        }
    }

    if (search && String(search).trim()) {
        const regex = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
        query.$or = [
            { name: regex },
            { portfolio: regex },
            { expedia_id: regex },
            { descriptor: regex },
            { website: regex },
        ];
    }

    return query;
}

async function queryHotels({ filters, sort, search, limit = 25, skip = 0 } = {}) {
    const query = buildQuery({ filters, search });
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
    const safeSkip = Math.max(Number(skip) || 0, 0);

    let sortSpec = { created_at: -1 };
    if (sort && sort.key && SORTABLE_FIELDS.has(sort.key)) {
        sortSpec = { [sort.key]: sort.dir === 'asc' ? 1 : -1 };
    }

    const [items, total] = await Promise.all([
        Hotel.find(query)
            .sort(sortSpec)
            .skip(safeSkip)
            .limit(safeLimit)
            .populate('created_by', 'first_name last_name email'),
        Hotel.countDocuments(query),
    ]);

    return { items, total, limit: safeLimit, skip: safeSkip };
}

async function distinctValues({ field, search, limit = 200 }) {
    if (!FILTERABLE_FIELDS[field]) {
        throw badRequest('Field is not filterable');
    }

    const match = { [field]: { $nin: [null, ''] } };
    if (search && String(search).trim()) {
        match[field] = {
            ...match[field],
            $regex: escapeRegex(String(search).trim()),
            $options: 'i',
        };
    }

    const [result] = await Hotel.aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        {
            $facet: {
                values: [{ $limit: Math.min(Number(limit) || 200, 500) }],
                total: [{ $count: 'count' }],
            },
        },
    ]);

    const facet = result || {};
    const values = (facet.values || []).map((v) => v._id).filter((v) => v != null && v !== '');
    return {
        values,
        total: (facet.total && facet.total[0] && facet.total[0].count) || 0,
        shown: values.length,
    };
}

/** Type-ahead for the hotel picker in the payment dialog. */
async function searchHotels({ q, limit = 20, includeArchived = false } = {}) {
    const query = includeArchived ? {} : { status: 'active' };
    if (q && String(q).trim()) {
        const regex = { $regex: escapeRegex(String(q).trim()), $options: 'i' };
        query.$or = [{ name: regex }, { expedia_id: regex }, { portfolio: regex }];
    }
    const items = await Hotel.find(query)
        .sort({ name: 1 })
        .limit(Math.min(Number(limit) || 20, 100))
        .select('portfolio name expedia_id descriptor website status');
    return { items };
}

// ============== Validation ==============
/**
 * Tidy a website into a bare host: no scheme, no www., no trailing slash.
 *
 * It ends up on a 32-character statement descriptor, so every saved character
 * counts — and "grandriverside.com" is what a cardholder actually recognises.
 */
function normaliseWebsite(value) {
    const raw = (value == null ? '' : String(value)).trim();
    if (!raw) return '';
    return raw
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/+$/, '')
        .trim()
        // Domains are case-insensitive; normalising means two operators typing
        // the same site produce the same reference.
        .toLowerCase();
}

function validateHotelFields(
    { portfolio, name, expedia_id, descriptor, website },
    { partial = false } = {}
) {
    const clean = {};

    const check = (field, value, label) => {
        const trimmed = (value == null ? '' : String(value)).trim();
        if (!trimmed) {
            if (partial) return;
            throw badRequest(`${label} is required`);
        }
        clean[field] = trimmed;
    };

    check('portfolio', portfolio, 'Portfolio');
    check('name', name, 'Hotel name');
    check('expedia_id', expedia_id, 'Expedia ID');
    check('descriptor', descriptor, 'Descriptor');

    if (clean.descriptor && clean.descriptor.length > DESCRIPTOR_MAX_LENGTH) {
        throw badRequest(
            `Descriptor must be ${DESCRIPTOR_MAX_LENGTH} characters or fewer (Airwallex limit)`
        );
    }

    // Website is optional. Only validate the shape when one was supplied —
    // existing hotels predate the field and must stay editable without it.
    if (website !== undefined) {
        const host = normaliseWebsite(website);
        if (host) {
            if (/\s/.test(host) || !/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(host)) {
                throw badRequest(`"${website}" does not look like a website`);
            }
            clean.website = host;
        } else if (!partial) {
            // Explicit empty on create: just leave it unset.
        }
    }

    return clean;
}

// ============== CRUD ==============
async function createHotel(payload, { userId } = {}) {
    const clean = validateHotelFields(payload);

    const existing = await Hotel.findOne({ expedia_id: clean.expedia_id });
    if (existing) {
        const err = new Error(`A hotel with Expedia ID ${clean.expedia_id} already exists`);
        err.statusCode = 409;
        throw err;
    }

    return Hotel.create({ ...clean, created_by: userId, updated_by: userId });
}

async function getHotel(id) {
    const hotel = await Hotel.findOne({
        $or: [
            { expedia_id: id },
            ...(String(id).match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : []),
        ],
    }).populate('created_by', 'first_name last_name email');

    if (!hotel) {
        const err = new Error('Hotel not found');
        err.statusCode = 404;
        throw err;
    }
    return hotel;
}

async function updateHotel(id, payload, { userId } = {}) {
    const hotel = await getHotel(id);
    const clean = validateHotelFields(payload, { partial: true });

    // Changing the Expedia ID must not collide with another property.
    if (clean.expedia_id && clean.expedia_id !== hotel.expedia_id) {
        const clash = await Hotel.findOne({ expedia_id: clean.expedia_id });
        if (clash) {
            const err = new Error(`A hotel with Expedia ID ${clean.expedia_id} already exists`);
            err.statusCode = 409;
            throw err;
        }
    }

    if (payload.status !== undefined) {
        const status = String(payload.status || '').trim().toLowerCase();
        if (status && !['active', 'archived'].includes(status)) {
            throw badRequest('Status must be active or archived');
        }
        if (status) hotel.status = status;
    }

    Object.assign(hotel, clean);
    hotel.updated_by = userId;
    await hotel.save();
    return hotel;
}

async function archiveHotel(id, { userId } = {}) {
    const hotel = await getHotel(id);
    hotel.status = 'archived';
    hotel.updated_by = userId;
    await hotel.save();
    return hotel;
}

// ============== Bulk ==============
/** Normalise a CSV row's headers onto our field names. */
function mapRow(row) {
    const mapped = { __line: row.__line };
    for (const [header, value] of Object.entries(row)) {
        if (header === '__line') continue;
        const field = HEADER_TO_FIELD[String(header).trim().toLowerCase()];
        if (field) mapped[field] = value;
    }
    return mapped;
}

function parseBulkCsv(input) {
    const { headers, rows } = parseTabular(input);
    if (!headers.length) throw badRequest('The file is empty');
    if (!rows.length) throw badRequest('The file has a header row but no data rows');
    if (rows.length > BULK_ROW_LIMIT) {
        throw badRequest(`Too many rows — the limit is ${BULK_ROW_LIMIT} per file`);
    }
    return rows.map(mapRow);
}

/**
 * Create hotels from a CSV.
 *
 * Every row is validated first and nothing is written unless the whole file is
 * clean — a half-imported portfolio is worse than a rejected file, because the
 * operator cannot tell which rows landed without diffing by hand.
 * `upsert` re-points the run at existing rows instead of failing on them.
 */
async function bulkImport(input, { userId, upsert = false } = {}) {
    const rows = parseBulkCsv(input);

    const errors = [];
    const prepared = [];
    const seen = new Map();

    for (const row of rows) {
        try {
            const clean = validateHotelFields(row);

            // Duplicate Expedia IDs inside the same file would silently
            // collapse into one record; flag them instead.
            if (seen.has(clean.expedia_id)) {
                throw badRequest(
                    `Expedia ID ${clean.expedia_id} appears twice (also on line ${seen.get(
                        clean.expedia_id
                    )})`
                );
            }
            seen.set(clean.expedia_id, row.__line);
            prepared.push({ line: row.__line, clean });
        } catch (err) {
            errors.push({ line: row.__line, error: err.message });
        }
    }

    const ids = prepared.map((p) => p.clean.expedia_id);
    const existing = await Hotel.find({ expedia_id: { $in: ids } }).select('expedia_id');
    const existingIds = new Set(existing.map((h) => h.expedia_id));

    if (!upsert) {
        for (const { line, clean } of prepared) {
            if (existingIds.has(clean.expedia_id)) {
                errors.push({
                    line,
                    error: `Expedia ID ${clean.expedia_id} already exists — tick "update existing" to overwrite`,
                });
            }
        }
    }

    if (errors.length) {
        return {
            applied: false,
            created: 0,
            updated: 0,
            total: rows.length,
            errors: errors.sort((a, b) => a.line - b.line),
        };
    }

    const operations = prepared.map(({ clean }) => ({
        updateOne: {
            filter: { expedia_id: clean.expedia_id },
            update: {
                $set: { ...clean, updated_by: userId },
                $setOnInsert: { created_by: userId, status: 'active' },
            },
            upsert: true,
        },
    }));

    const result = operations.length ? await Hotel.bulkWrite(operations) : null;

    return {
        applied: true,
        created: result ? result.upsertedCount || 0 : 0,
        updated: result ? result.modifiedCount || 0 : 0,
        total: rows.length,
        errors: [],
    };
}

/**
 * Update existing hotels from a CSV keyed on Expedia ID.
 *
 * Only the columns present in the file are touched, so a file with just
 * "Expedia ID,Descriptor" re-points descriptors and leaves names alone.
 */
async function bulkUpdate(input, { userId } = {}) {
    const { headers } = parseTabular(input);
    const rows = parseBulkCsv(input);

    const presentFields = new Set(
        headers
            .map((h) => HEADER_TO_FIELD[String(h).trim().toLowerCase()])
            .filter(Boolean)
    );

    if (!presentFields.has('expedia_id')) {
        throw badRequest('The file must include an "Expedia ID" column to match on');
    }
    const updatable = [...presentFields].filter((f) => f !== 'expedia_id');
    if (!updatable.length) {
        throw badRequest('The file has nothing to update besides the Expedia ID');
    }

    const errors = [];
    const prepared = [];
    const seen = new Map();

    for (const row of rows) {
        const expediaId = (row.expedia_id || '').trim();
        if (!expediaId) {
            errors.push({ line: row.__line, error: 'Expedia ID is required' });
            continue;
        }
        if (seen.has(expediaId)) {
            errors.push({
                line: row.__line,
                error: `Expedia ID ${expediaId} appears twice (also on line ${seen.get(expediaId)})`,
            });
            continue;
        }
        seen.set(expediaId, row.__line);

        const update = {};
        try {
            for (const field of updatable) {
                const value = (row[field] == null ? '' : String(row[field])).trim();
                // A blank cell means "leave this alone" rather than "clear it";
                // clearing a required field would break the record.
                if (!value) continue;

                if (field === 'descriptor' && value.length > DESCRIPTOR_MAX_LENGTH) {
                    throw badRequest(
                        `Descriptor must be ${DESCRIPTOR_MAX_LENGTH} characters or fewer`
                    );
                }
                if (field === 'status' && !['active', 'archived'].includes(value.toLowerCase())) {
                    throw badRequest('Status must be active or archived');
                }
                if (field === 'website') {
                    // Same normalisation as the form, so a bulk-updated website
                    // produces an identical reference to a hand-edited one.
                    const host = normaliseWebsite(value);
                    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(host)) {
                        throw badRequest(`"${value}" does not look like a website`);
                    }
                    update.website = host;
                    continue;
                }
                update[field] = field === 'status' ? value.toLowerCase() : value;
            }
        } catch (err) {
            errors.push({ line: row.__line, error: err.message });
            continue;
        }

        if (!Object.keys(update).length) {
            errors.push({ line: row.__line, error: 'No values to update on this row' });
            continue;
        }

        prepared.push({ line: row.__line, expedia_id: expediaId, update });
    }

    // Every referenced hotel must exist — a typo'd Expedia ID would otherwise
    // silently update nothing.
    const ids = prepared.map((p) => p.expedia_id);
    const found = await Hotel.find({ expedia_id: { $in: ids } }).select('expedia_id');
    const foundIds = new Set(found.map((h) => h.expedia_id));
    for (const { line, expedia_id } of prepared) {
        if (!foundIds.has(expedia_id)) {
            errors.push({ line, error: `No hotel found with Expedia ID ${expedia_id}` });
        }
    }

    if (errors.length) {
        return {
            applied: false,
            matched: 0,
            updated: 0,
            total: rows.length,
            errors: errors.sort((a, b) => a.line - b.line),
        };
    }

    const operations = prepared.map(({ expedia_id, update }) => ({
        updateOne: {
            filter: { expedia_id },
            update: { $set: { ...update, updated_by: userId } },
        },
    }));

    const result = operations.length ? await Hotel.bulkWrite(operations) : null;

    return {
        applied: true,
        matched: result ? result.matchedCount || 0 : 0,
        updated: result ? result.modifiedCount || 0 : 0,
        total: rows.length,
        errors: [],
    };
}

/** Resolve Expedia IDs to hotels in one query, for bulk payment creation. */
async function findByExpediaIds(ids) {
    const unique = [...new Set(ids.filter(Boolean).map((id) => String(id).trim()))];
    if (!unique.length) return new Map();
    const hotels = await Hotel.find({ expedia_id: { $in: unique } });
    return new Map(hotels.map((h) => [h.expedia_id, h]));
}

// ============== Templates ==============
function importTemplate() {
    return buildTemplate({
        headers: IMPORT_HEADERS,
        example: {
            Portfolio: 'West Coast',
            'Hotel Name': 'The Grand Riverside',
            'Expedia ID': '12345678',
            Descriptor: 'GRAND RIVERSIDE',
            Website: 'grandriverside.com',
        },
    });
}

function updateTemplate() {
    return buildTemplate({
        headers: UPDATE_HEADERS,
        example: {
            'Expedia ID': '12345678',
            Portfolio: 'West Coast',
            'Hotel Name': 'The Grand Riverside',
            Descriptor: 'GRAND RIVERSIDE',
            Website: 'grandriverside.com',
            Status: 'active',
        },
    });
}

/** Export the current hotel list in the same shape the update template uses. */
async function exportCsv({ filters, search } = {}) {
    const query = buildQuery({ filters, search });
    const hotels = await Hotel.find(query).sort({ portfolio: 1, name: 1 }).limit(BULK_ROW_LIMIT);
    return toCsv({
        headers: UPDATE_HEADERS,
        rows: hotels.map((h) => ({
            'Expedia ID': h.expedia_id,
            Portfolio: h.portfolio,
            'Hotel Name': h.name,
            Descriptor: h.descriptor,
            Website: h.website || '',
            Status: h.status,
        })),
    });
}

async function getStats() {
    const [total, active, portfolios] = await Promise.all([
        Hotel.countDocuments(),
        Hotel.countDocuments({ status: 'active' }),
        Hotel.distinct('portfolio'),
    ]);
    return { total, active, archived: total - active, portfolios: portfolios.length };
}

module.exports = {
    FILTERABLE_FIELDS,
    normaliseWebsite,
    IMPORT_HEADERS,
    UPDATE_HEADERS,
    DESCRIPTOR_MAX_LENGTH,
    queryHotels,
    distinctValues,
    searchHotels,
    createHotel,
    getHotel,
    updateHotel,
    archiveHotel,
    bulkImport,
    bulkUpdate,
    findByExpediaIds,
    importTemplate,
    updateTemplate,
    exportCsv,
    getStats,
};
