/**
 * Minimal RFC 4180 CSV parse/serialise.
 *
 * CSV rather than xlsx on purpose: operators build these files in Excel and
 * "Save as CSV", and it keeps a parser with a history of prototype-pollution
 * advisories out of a service that handles money.
 */

const BOM = '﻿';

/**
 * Parse CSV text into an array of row objects keyed by the header row.
 *
 * Handles quoted fields containing commas, newlines and escaped quotes ("");
 * tolerates CRLF, a UTF-8 BOM, and trailing blank lines.
 */
function parseCsv(text) {
    if (typeof text !== 'string') return { headers: [], rows: [] };

    let input = text;
    if (input.startsWith(BOM)) input = input.slice(1);
    if (!input.trim()) return { headers: [], rows: [] };

    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;

    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];

        if (inQuotes) {
            if (char === '"') {
                if (input[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            record.push(field);
            field = '';
        } else if (char === '\r') {
            // Swallow; the \n that follows ends the record.
        } else if (char === '\n') {
            record.push(field);
            records.push(record);
            record = [];
            field = '';
        } else {
            field += char;
        }
    }

    // Final record (file may not end with a newline).
    if (field !== '' || record.length) {
        record.push(field);
        records.push(record);
    }

    if (!records.length) return { headers: [], rows: [] };

    const headers = records[0].map((h) => h.trim());
    const rows = [];

    for (let i = 1; i < records.length; i += 1) {
        const cells = records[i];
        // Skip blank lines rather than emitting a row of empty strings.
        if (cells.every((c) => String(c).trim() === '')) continue;

        const row = {};
        headers.forEach((header, index) => {
            row[header] = (cells[index] !== undefined ? cells[index] : '').trim();
        });
        // 1-based line number in the original file, counting the header.
        row.__line = i + 1;
        rows.push(row);
    }

    return { headers, rows };
}

function escapeCell(value) {
    const str = value === undefined || value === null ? '' : String(value);
    // Quote when the value contains a delimiter, quote or newline. Also quote
    // leading/trailing spaces so they survive a round trip.
    if (/[",\r\n]/.test(str) || str !== str.trim()) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Serialise rows to CSV.
 *
 * A UTF-8 BOM is prepended so Excel opens non-ASCII hotel names correctly
 * instead of mangling them to mojibake.
 */
function toCsv({ headers, rows = [] }) {
    const lines = [headers.map(escapeCell).join(',')];
    for (const row of rows) {
        lines.push(headers.map((h) => escapeCell(row[h])).join(','));
    }
    return BOM + lines.join('\r\n') + '\r\n';
}

/**
 * A downloadable template: the header row plus one example row, so the
 * operator can see the expected shape of every column.
 */
function buildTemplate({ headers, example }) {
    return toCsv({ headers, rows: example ? [example] : [] });
}

module.exports = { parseCsv, toCsv, buildTemplate, BOM };
