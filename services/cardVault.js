const crypto = require('crypto');

/**
 * Encryption for stored virtual-card credentials.
 *
 * These are the operator's OWN virtual cards used to pay hotel reservations —
 * not cardholder data belonging to a shopper — and storage here is covered by
 * the operator's PCI sign-off. Nothing in this file is a substitute for that
 * sign-off; it exists so the data is never at rest in plaintext.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than returning garbage. A fresh random IV per value means identical card
 * numbers do not produce identical ciphertext.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;

let cachedKey = null;

/**
 * The key comes from CARD_ENCRYPTION_KEY — 32 bytes as hex or base64.
 * Generate one with: openssl rand -hex 32
 */
function getKey() {
    if (cachedKey) return cachedKey;

    const raw = (process.env.CARD_ENCRYPTION_KEY || '').trim();
    if (!raw) {
        const err = new Error(
            'CARD_ENCRYPTION_KEY is not set — card details cannot be stored without it'
        );
        err.statusCode = 500;
        throw err;
    }

    let key;
    if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
    else key = Buffer.from(raw, 'base64');

    if (key.length !== KEY_BYTES) {
        const err = new Error(
            `CARD_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (64 hex chars) — got ${key.length}`
        );
        err.statusCode = 500;
        throw err;
    }

    cachedKey = key;
    return key;
}

/** Encrypt to a self-describing "v1.iv.tag.ciphertext" string. */
function encrypt(plaintext) {
    const value = plaintext == null ? '' : String(plaintext);
    if (!value) return null;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
        'v1',
        iv.toString('base64'),
        tag.toString('base64'),
        ciphertext.toString('base64'),
    ].join('.');
}

function decrypt(payload) {
    if (!payload) return null;
    const parts = String(payload).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
        throw new Error('Stored card value is not in a readable format');
    }

    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        getKey(),
        Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

function isConfigured() {
    try {
        getKey();
        return true;
    } catch (err) {
        return false;
    }
}

// ============== Card field normalisation ==============

/** Digits only — spreadsheets carry spaces, dashes and stray apostrophes. */
function normalisePan(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
}

/** Luhn check. Catches a mistyped digit before a card is ever attempted. */
function luhnValid(pan) {
    if (!/^\d{12,19}$/.test(pan)) return false;
    let sum = 0;
    let double = false;
    for (let i = pan.length - 1; i >= 0; i -= 1) {
        let digit = pan.charCodeAt(i) - 48;
        if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}

function brandOf(pan) {
    if (/^4/.test(pan)) return 'visa';
    if (/^(5[1-5]|2[2-7])/.test(pan)) return 'mastercard';
    if (/^3[47]/.test(pan)) return 'amex';
    if (/^6(?:011|5)/.test(pan)) return 'discover';
    if (/^3(?:0[0-5]|[68])/.test(pan)) return 'diners';
    if (/^35/.test(pan)) return 'jcb';
    return 'unknown';
}

/**
 * Normalise an expiry to mm/yy.
 *
 * Accepts what spreadsheets actually produce: an Excel date serial (47362),
 * an ISO date, mm/yyyy, mm-yy, mmyy, and mm/yy already.
 */
function normaliseExpiry(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';

    const pad = (m, y) => `${String(m).padStart(2, '0')}/${String(y).slice(-2)}`;

    // Excel serial — a plain number in a plausible date range.
    if (/^\d{4,6}(\.\d+)?$/.test(raw)) {
        const serial = Number(raw);
        if (serial > 20000 && serial < 80000) {
            const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
            return pad(d.getUTCMonth() + 1, String(d.getUTCFullYear()));
        }
    }

    // ISO-ish date.
    const iso = raw.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (iso) return pad(Number(iso[2]), iso[1]);

    // mm/yy, mm/yyyy, mm-yy, mm.yy
    const sep = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/);
    if (sep) {
        const month = Number(sep[1]);
        if (month >= 1 && month <= 12) return pad(month, sep[2]);
    }

    // mmyy / mmyyyy with no separator.
    const bare = raw.match(/^(\d{2})(\d{2}|\d{4})$/);
    if (bare) {
        const month = Number(bare[1]);
        if (month >= 1 && month <= 12) return pad(month, bare[2]);
    }

    return '';
}

/** Has this expiry already passed? Cards expire at the end of their month. */
function expiryPassed(mmyy, now = new Date()) {
    const match = /^(\d{2})\/(\d{2})$/.exec(mmyy || '');
    if (!match) return false;
    const month = Number(match[1]);
    const year = 2000 + Number(match[2]);
    // First day of the following month, UTC.
    const expiresAfter = Date.UTC(year, month, 1);
    return now.getTime() >= expiresAfter;
}

function normaliseCvv(value) {
    return String(value == null ? '' : value).replace(/\D/g, '');
}

// Digit counts each network actually issues. A mismatch is the most common
// cause of a failed checksum and is far more actionable than "invalid".
const BRAND_LENGTHS = {
    visa: [13, 16, 19],
    mastercard: [16],
    amex: [15],
    discover: [16, 19],
    diners: [14, 16, 19],
    jcb: [16, 17, 18, 19],
};

/** Explain why a card number looks wrong, in terms an operator can act on. */
function describePanProblem(pan) {
    if (!pan) return 'Card number is missing';
    if (!/^\d+$/.test(pan)) return 'Card number contains non-digits';
    if (pan.length < 12 || pan.length > 19) {
        return `Card number has ${pan.length} digits — expected 12 to 19`;
    }

    const brand = brandOf(pan);
    const expected = BRAND_LENGTHS[brand];
    if (expected && !expected.includes(pan.length)) {
        return `${brand === 'amex' ? 'Amex' : brand} numbers are ${expected.join(
            ' or '
        )} digits — this one has ${pan.length}`;
    }
    return 'Card number failed its checksum — check for a mistyped digit';
}

module.exports = {
    describePanProblem,
    encrypt,
    decrypt,
    isConfigured,
    normalisePan,
    normaliseExpiry,
    normaliseCvv,
    expiryPassed,
    luhnValid,
    brandOf,
};
