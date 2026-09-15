const { parseCsv } = require('./csv');
const { isXlsx, parseXlsx } = require('./xlsx');

/**
 * Parse an uploaded spreadsheet, whichever form it arrives in.
 *
 * Dispatches on the file's own magic bytes rather than its Content-Type or
 * extension — a browser reports .xlsx inconsistently across platforms, and a
 * mislabelled file should still be read correctly instead of being parsed as
 * CSV and yielding nonsense rows.
 *
 * Both branches return the identical { headers, rows } shape, so everything
 * downstream is unaware of which format was uploaded.
 */
function parseTabular(input) {
    const buffer = Buffer.isBuffer(input) ? input : null;

    if (buffer && isXlsx(buffer)) {
        return parseXlsx(buffer);
    }

    // A legacy .xls is an OLE2 compound file, not a zip and not CSV. Check the
    // raw bytes: its D0 CF signature does not survive a UTF-8 decode, so this
    // has to happen before any string conversion.
    if (buffer && buffer.length > 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf) {
        const err = new Error(
            'That is a legacy .xls file — re-save it as .xlsx or CSV and upload again'
        );
        err.statusCode = 400;
        throw err;
    }

    const text = buffer ? buffer.toString('utf8') : String(input == null ? '' : input);
    return parseCsv(text);
}

module.exports = { parseTabular };
