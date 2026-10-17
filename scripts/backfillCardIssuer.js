/**
 * Backfill card_issuer on payments created before the field existed.
 *
 * The issuer has been arriving all along inside the stored Airwallex responses
 * — every retrieve of a paid intent carries it on the payment attempt — it was
 * simply never lifted onto the payment itself. So this reads from what is
 * already in the database rather than re-querying Airwallex: no API calls, no
 * rate limits, and it is safe to run repeatedly.
 *
 * The newest entry that carries an issuer wins, since a card can be updated
 * (Airwallex's own card_updater_info records exactly that).
 *
 *   node scripts/backfillCardIssuer.js          # report only, writes nothing
 *   node scripts/backfillCardIssuer.js --write  # apply
 */

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Payment = require('../models/Payment');

const WRITE = process.argv.includes('--write');
const BATCH = 500;

/** The issuer from the most recent logged response that has one. */
function issuerFrom(apiLog) {
    if (!Array.isArray(apiLog)) return null;
    for (let i = apiLog.length - 1; i >= 0; i -= 1) {
        const card =
            apiLog[i] &&
            apiLog[i].response &&
            apiLog[i].response.latest_payment_attempt &&
            apiLog[i].response.latest_payment_attempt.payment_method &&
            apiLog[i].response.latest_payment_attempt.payment_method.card;
        if (card && card.issuer_name) return card.issuer_name;
    }
    return null;
}

(async () => {
    await mongoose.connect(process.env.DATABASE_URI);

    const query = {
        card_issuer: { $in: [null, ''] },
        'api_log.response.latest_payment_attempt.payment_method.card.issuer_name': {
            $exists: true,
        },
    };

    const total = await Payment.countDocuments(query);
    console.log(`${total} payment(s) missing card_issuer but holding one in their api_log`);
    if (!total) {
        await mongoose.disconnect();
        return;
    }

    const cursor = Payment.find(query).select('_id api_log').lean().cursor();
    const issuers = new Map();
    let ops = [];
    let matched = 0;
    let written = 0;

    for await (const doc of cursor) {
        const issuer = issuerFrom(doc.api_log);
        if (!issuer) continue;

        matched += 1;
        issuers.set(issuer, (issuers.get(issuer) || 0) + 1);
        ops.push({
            updateOne: { filter: { _id: doc._id }, update: { $set: { card_issuer: issuer } } },
        });

        if (ops.length >= BATCH) {
            if (WRITE) written += (await Payment.bulkWrite(ops, { ordered: false })).modifiedCount;
            ops = [];
            process.stdout.write(`\r  ${matched}/${total} read…`);
        }
    }

    if (ops.length && WRITE) {
        written += (await Payment.bulkWrite(ops, { ordered: false })).modifiedCount;
    }

    console.log(`\r  ${matched}/${total} had a readable issuer`);
    console.log(WRITE ? `  ${written} updated` : '  (dry run — nothing written)');

    console.log('\nissuers found:');
    [...issuers.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([name, n]) => console.log(`  ${String(n).padStart(6)}  ${name}`));

    await mongoose.disconnect();
})().catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exit(1);
});
