/**
 * Re-read payments from Airwallex to close gaps in card_issuer.
 *
 * The backfill script recovers the issuer from responses already stored; this
 * one asks Airwallex again, for payments whose stored responses never carried
 * it. Read-only against Airwallex — it retrieves intents and never creates,
 * confirms or cancels anything — but it does update our own records, which is
 * the point: an intent paid since the last sync comes back with its status and
 * its issuer together.
 *
 * Airwallex only reports an issuer once a card has actually been presented, so
 * an intent nobody has attempted has nothing to report and is skipped by
 * default. Pass --all to sweep those too, which doubles as a check that they
 * really are untouched.
 *
 *   node scripts/resyncCardIssuer.js            # report only, writes nothing
 *   node scripts/resyncCardIssuer.js --write    # apply
 *   node scripts/resyncCardIssuer.js --write --all
 *
 * MUST run against the account the payments live in. A mismatch shows up
 * immediately as "not found in this account" on every row — if that is what you
 * see, check AIRWALLEX_MODE and the credentials before going further.
 */

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const paymentService = require('../services/paymentService');
const airwallex = require('../services/airwallexService');

const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');

// Gentle on the API: a handful in flight, with a pause between groups. There is
// no deadline here and a 429 would only slow things down further.
const CONCURRENCY = 4;
const PAUSE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attemptedFilter() {
    return {
        $or: [
            { last_attempt_status: { $nin: [null, ''] } },
            { status: { $in: ['SUCCEEDED', 'REQUIRES_CAPTURE'] } },
        ],
    };
}

(async () => {
    // A declared mode that disagrees with the credentials is the one failure
    // that would silently read the wrong account for every row.
    airwallex.assertModeMatchesCredentials();

    const env = airwallex.describeMode();
    console.log(`Airwallex: ${env.mode.toUpperCase()}  ${env.base_url}  client ${env.client_id_hint}`);
    if (!env.explicit) {
        console.log('  (mode inferred — set AIRWALLEX_MODE to be explicit)');
    }

    await mongoose.connect(process.env.DATABASE_URI);

    const query = {
        card_issuer: { $in: [null, ''] },
        ...(ALL ? {} : attemptedFilter()),
    };

    const targets = await Payment.find(query)
        .select('payment_intent_id merchant_order_id status last_attempt_status')
        .lean();

    console.log(
        `\n${targets.length} payment(s) to re-read` +
            (ALL ? ' (including never-attempted)' : ' (attempted only — pass --all for the rest)')
    );
    if (!targets.length) {
        await mongoose.disconnect();
        return;
    }
    if (!WRITE) {
        console.log('  (dry run — nothing will be written; re-run with --write)');
    }

    let resolved = 0;
    let stillBlank = 0;
    let notFound = 0;
    let failed = 0;
    const issuers = new Map();

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const group = targets.slice(i, i + CONCURRENCY);

        await Promise.all(
            group.map(async (t) => {
                try {
                    if (WRITE) {
                        // The ordinary sync path, so the record is updated the
                        // same way a webhook or a manual refresh would.
                        const updated = await paymentService.syncPayment(t.payment_intent_id);
                        if (updated.card_issuer) {
                            resolved += 1;
                            issuers.set(
                                updated.card_issuer,
                                (issuers.get(updated.card_issuer) || 0) + 1
                            );
                        } else {
                            stillBlank += 1;
                        }
                        return;
                    }

                    // Dry run: look, do not touch.
                    const intent = await airwallex.retrievePaymentIntent(t.payment_intent_id, {
                        log: [],
                    });
                    const card =
                        intent.latest_payment_attempt &&
                        intent.latest_payment_attempt.payment_method &&
                        intent.latest_payment_attempt.payment_method.card;
                    if (card && card.issuer_name) {
                        resolved += 1;
                        issuers.set(card.issuer_name, (issuers.get(card.issuer_name) || 0) + 1);
                    } else {
                        stillBlank += 1;
                    }
                } catch (err) {
                    if (/cannot be found/i.test(err.message)) {
                        notFound += 1;
                        if (notFound <= 3) {
                            console.log(`  ${t.merchant_order_id}: not found in this account`);
                        }
                    } else {
                        failed += 1;
                        if (failed <= 5) console.log(`  ${t.merchant_order_id}: ${err.message}`);
                    }
                }
            })
        );

        process.stdout.write(
            `\r  ${Math.min(i + CONCURRENCY, targets.length)}/${targets.length}…`
        );
        await sleep(PAUSE_MS);
    }

    console.log(`\r  ${targets.length}/${targets.length} done          `);
    console.log(`  issuer found     : ${resolved}`);
    console.log(`  still no issuer  : ${stillBlank}  (never presented a card)`);
    if (notFound) {
        console.log(
            `  not in account   : ${notFound}  <- wrong environment, or created elsewhere`
        );
    }
    if (failed) console.log(`  errored          : ${failed}`);

    if (issuers.size) {
        console.log('\nissuers:');
        [...issuers.entries()]
            .sort((a, b) => b[1] - a[1])
            .forEach(([name, n]) => console.log(`  ${String(n).padStart(6)}  ${name}`));
    }

    await mongoose.disconnect();
})().catch((err) => {
    console.error('Resync failed:', err.message);
    process.exit(1);
});
