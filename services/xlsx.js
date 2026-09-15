const zlib = require('zlib');

/**
 * Minimal .xlsx reader — enough to turn a tabular export into rows.
 *
 * Dependency-free on purpose. The npm-published `xlsx` is frozen at 0.18.5 and
 * carries a prototype-pollution advisory (CVE-2023-30533); the maintained
 * releases moved off npm entirely. Rather than pull a parser with known holes
 * into a service that handles money, this reads the only parts of the format
 * these files actually use: the shared string table and the first worksheet.
 *
 * Scope, deliberately: first worksheet only, values only (no styles, formulas
 * are read from their cached result). Anything more exotic should be saved as
 * CSV instead — the operator gets a clear error rather than a silent misread.
 */

// An .xlsx is a ZIP. Guard the decompressed size so a zip bomb cannot exhaust
// memory before the row limit is ever reached.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 20000;

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function isXlsx(buffer) {
    return (
        Buffer.isBuffer(buffer) &&
        buffer.length > 4 &&
        buffer[0] === 0x50 && // P
        buffer[1] === 0x4b && // K
        buffer[2] === 0x03 &&
        buffer[3] === 0x04
    );
}

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

/** Read the ZIP central directory into a map of filename -> decompressed Buffer. */
function readZip(buffer) {
    // The end-of-central-directory record sits at the tail, after a comment of
    // unknown length, so scan backwards for its signature.
    let eocd = -1;
    const from = Math.max(0, buffer.length - 66 * 1024);
    for (let i = buffer.length - 22; i >= from; i -= 1) {
        if (buffer.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd === -1) throw badRequest('That file is not a readable .xlsx workbook');

    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) {
        throw badRequest('ZIP64 workbooks are not supported — save the sheet as CSV');
    }

    const files = new Map();

    for (let i = 0; i < entryCount; i += 1) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CEN_SIG) break;

        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

        offset += 46 + nameLength + extraLength + commentLength;

        // Only the handful of parts we actually read are worth inflating.
        if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml)$|^xl\/_rels\/workbook\.xml\.rels$/.test(name)) {
            continue;
        }
        if (uncompressedSize > MAX_ENTRY_BYTES) {
            throw badRequest('That workbook is too large to read — save the sheet as CSV');
        }

        if (buffer.readUInt32LE(localOffset) !== LOC_SIG) continue;
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);

        let content;
        if (method === 0) {
            content = raw;
        } else if (method === 8) {
            content = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
        } else {
            continue;
        }
        files.set(name, content);
    }

    return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
        if (entity[0] === '#') {
            const code =
                entity[1] === 'x' || entity[1] === 'X'
                    ? parseInt(entity.slice(2), 16)
                    : parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[entity] !== undefined ? ENTITIES[entity] : match;
    });
}

/** Concatenate every <t> in a fragment, skipping phonetic <rPh> runs. */
function textOf(fragment) {
    let out = '';
    const withoutPhonetic = fragment.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
    let m;
    while ((m = re.exec(withoutPhonetic)) !== null) {
        out += m[1] !== undefined ? decodeXml(m[1]) : '';
    }
    return out;
}

function readSharedStrings(files) {
    const xml = files.get('xl/sharedStrings.xml');
    if (!xml) return [];
    const text = xml.toString('utf8');
    const strings = [];
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        strings.push(m[1] !== undefined ? textOf(m[1]) : '');
    }
    return strings;
}

/** Resolve the first worksheet in the workbook's own tab order. */
function firstSheetPath(files) {
    const workbook = files.get('xl/workbook.xml');
    const rels = files.get('xl/_rels/workbook.xml.rels');

    if (workbook && rels) {
        const sheet = workbook.toString('utf8').match(/<sheet\b[^>]*\/?>/);
        const relId = sheet && sheet[0].match(/r:id="([^"]+)"/);
        if (relId) {
            const relXml = rels.toString('utf8');
            const rel = relXml.match(
                new RegExp(`<Relationship\\b[^>]*Id="${relId[1]}"[^>]*>`)
            );
            const target = rel && rel[0].match(/Target="([^"]+)"/);
            if (target) {
                const path = target[1].replace(/^\/?xl\//, '').replace(/^\.\//, '');
                const full = `xl/${path}`;
                if (files.has(full)) return full;
            }
        }
    }

    // Fall back to the lowest-numbered sheet part.
    const sheets = [...files.keys()]
        .filter((n) => n.startsWith('xl/worksheets/') && n.endsWith('.xml'))
        .sort();
    return sheets[0];
}

/** Excel column letters -> zero-based index. A=0, Z=25, AA=26. */
function columnIndex(ref) {
    let index = 0;
    for (const ch of ref) {
        const code = ch.charCodeAt(0);
        if (code < 65 || code > 90) break;
        index = index * 26 + (code - 64);
    }
    return index - 1;
}

const DAY_MS = 86400000;

/** Excel serial -> ISO date. Its epoch is 1899-12-30. */
function serialToDate(serial) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * DAY_MS)
        .toISOString()
        .slice(0, 10);
}

/**
 * Read the first worksheet into the same shape parseCsv produces:
 * { headers, rows } with each row keyed by header plus a __line number.
 */
function parseXlsx(buffer) {
    const files = readZip(buffer);
    const sheetPath = firstSheetPath(files);
    if (!sheetPath) throw badRequest('That workbook has no worksheets');

    const shared = readSharedStrings(files);
    const xml = files.get(sheetPath).toString('utf8');

    const grid = [];
    const rowRe = /<row\b([^>]*)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rowMatch;

    while ((rowMatch = rowRe.exec(xml)) !== null) {
        if (grid.length > MAX_ROWS) {
            throw badRequest(`That workbook has more than ${MAX_ROWS} rows`);
        }
        const body = rowMatch[2] || '';
        const cells = [];

        const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cellMatch;
        while ((cellMatch = cellRe.exec(body)) !== null) {
            const attrs = cellMatch[1] || '';
            const inner = cellMatch[2] || '';

            const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
            const index = refMatch ? columnIndex(refMatch[1]) : cells.length;
            const typeMatch = attrs.match(/t="([^"]+)"/);
            const type = typeMatch ? typeMatch[1] : 'n';

            let value = '';
            if (type === 'inlineStr') {
                value = textOf(inner);
            } else {
                const v = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
                const rawValue = v ? decodeXml(v[1]) : '';
                if (type === 's') {
                    const i = Number(rawValue);
                    value = Number.isInteger(i) && shared[i] !== undefined ? shared[i] : '';
                } else if (type === 'b') {
                    value = rawValue === '1' ? 'TRUE' : 'FALSE';
                } else {
                    // 'str' (cached formula result), 'd' (ISO date) and plain
                    // numbers all pass through as their literal text.
                    value = rawValue;
                }
            }

            cells[index] = value;
        }

        for (let i = 0; i < cells.length; i += 1) {
            if (cells[i] === undefined) cells[i] = '';
        }
        grid.push(cells);
    }

    if (!grid.length) return { headers: [], rows: [] };

    const headers = grid[0].map((h) => String(h == null ? '' : h).trim());
    const rows = [];

    for (let i = 1; i < grid.length; i += 1) {
        const cells = grid[i];
        if (!cells.length || cells.every((c) => String(c).trim() === '')) continue;

        const row = {};
        headers.forEach((header, index) => {
            row[header] = String(cells[index] === undefined ? '' : cells[index]).trim();
        });
        row.__line = i + 1;
        rows.push(row);
    }

    return { headers, rows };
}

module.exports = { isXlsx, parseXlsx, serialToDate };
