const Batch = require('../models/Batch');
const Payment = require('../models/Payment');
const batchService = require('./batchService');
const paymentService = require('./paymentService');
const cardVault = require('./cardVault');

/**
 * Automated payment of a batch through a real browser.
 *
 * Airwallex's card fields live in their own iframes and never expose the PAN to
 * our page — that is the point of the embedded element. So paying a stored
 * virtual card means driving an actual browser: open our checkout page for the
 * intent, type into their iframe, submit.
 *
 * Runs one payment at a time. Card networks and risk engines both treat a burst
 * of identical, instantaneous submissions as suspicious, so the pacing below is
 * deliberate rather than decorative.
 */

// Only one run at a time, per batch and overall: two browsers racing the same
// intents would double-submit.
const activeRuns = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uniform jitter — real people are not metronomes. */
function jitter(min, max) {
    return Math.floor(min + Math.random() * (max - min));
}

/**
 * Run logging.
 *
 * A headless run is invisible by definition: the only way to see where a batch
 * is spending its time, or which step a row died on, is to say so as it
 * happens. These land in `pm2 logs` and are deliberately one line each so a
 * 500-row run stays greppable.
 */
function log(prefix, message) {
    console.log(`[pay]${prefix ? ' ' + prefix : ''} ${message}`);
}

/** A logger bound to one row, so every line identifies which payment it is. */
function rowLogger(index, total, label) {
    return (message) => log(`${index}/${total} ${label}`, message);
}

/**
 * Type into a field the way a person does: variable per-keystroke delay, with
 * the occasional longer pause as if glancing back at the source.
 */
async function humanType(frame, selector, value) {
    const element = await frame.waitForSelector(selector, { visible: true, timeout: 20000 });
    await element.click();
    await sleep(jitter(120, 320));

    // Clear whatever is already there before typing.
    //
    // Airwallex pre-fills the cardholder name from the customer on the intent,
    // so typing straight in produced "Expedia GroupExpedia Group". This also
    // matters on a retry, where a field may still hold the previous attempt.
    const existing = await frame
        .evaluate((el) => el.value || '', element)
        .catch(() => '');

    if (existing) {
        if (existing.trim() === String(value).trim()) {
            // Already correct — leave it rather than retyping the same thing.
            await sleep(jitter(100, 260));
            return;
        }
        // Select all within the field, then delete: the same thing a person does.
        await element.click({ clickCount: 3 });
        await sleep(jitter(80, 180));
        await frame.page().keyboard.press('Backspace');
        await sleep(jitter(120, 260));
    }

    for (const char of String(value)) {
        await element.type(char, { delay: jitter(45, 140) });
        // Occasional hesitation, roughly once every twelve characters.
        if (Math.random() < 0.08) await sleep(jitter(180, 520));
    }
    await sleep(jitter(140, 380));
}

/**
 * Find the frame holding a given selector.
 *
 * Airwallex splits the card form across several same-origin-ish iframes and the
 * arrangement differs by element version, so the frame is discovered rather
 * than assumed.
 */
async function findFrameWith(page, selectors, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            for (const selector of selectors) {
                try {
                    const handle = await frame.$(selector);
                    if (handle) return { frame, selector };
                } catch (err) {
                    // Frame detached mid-search; ignore and keep looking.
                }
            }
        }
        await sleep(400);
    }
    return null;
}

// Airwallex has renamed these fields across element versions; try the known set.
const FIELD_SELECTORS = {
    number: [
        'input[name="cardnumber"]',
        'input[name="cardNumber"]',
        'input[data-testid="card-number"]',
        'input[autocomplete="cc-number"]',
        'input#cardNumber',
    ],
    expiry: [
        'input[name="expiry"]',
        'input[name="expiryDate"]',
        'input[data-testid="card-expiry"]',
        'input[autocomplete="cc-exp"]',
        'input#expiry',
    ],
    cvc: [
        'input[name="cvc"]',
        'input[name="cvv"]',
        'input[data-testid="card-cvc"]',
        'input[autocomplete="cc-csc"]',
        'input#cvc',
    ],
    name: [
        'input[autocomplete="cc-name"]',
        'input[name="name"]',
        'input[name="cardHolderName"]',
        'input[name="cardholderName"]',
    ],
};

/**
 * Click the drop-in's Pay button.
 *
 * It lives inside Airwallex's iframe and carries no id, name or test id — only
 * its label — so it is matched on text. A real ElementHandle click is used
 * rather than el.click() in page script, so it dispatches a genuine mouse
 * event at the button's coordinates.
 */
const SUBMIT_TEXT = /^(pay|pay now|confirm|confirm payment)\b/i;

async function clickPayButton(page, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        for (const frame of page.frames()) {
            let buttons = [];
            try {
                buttons = await frame.$$('button, [role="button"], input[type="submit"]');
            } catch (err) {
                continue; // frame detached mid-scan
            }

            for (const button of buttons) {
                try {
                    const text = await frame.evaluate(
                        (el) => (el.textContent || el.value || '').trim(),
                        button
                    );
                    if (!SUBMIT_TEXT.test(text)) continue;

                    const disabled = await frame.evaluate((el) => el.disabled === true, button);
                    if (disabled) continue;

                    await button.click();
                    return true;
                } catch (err) {
                    // Element went stale between finding and clicking; keep looking.
                }
            }
        }
        await sleep(400);
    }
    return false;
}

/**
 * Pay one intent in an already-open browser.
 * Resolves with { ok, status, error }.
 */
// Clicking Pay is only the middle of the story, so the wait after it gets its
// own budget: the drop-in confirms the intent, the browser may be sent through
// a 3DS step, and our result page then re-reads the intent from Airwallex.
const RESULT_TIMEOUT_MS = 90000;

/**
 * Wait for the checkout to actually finish in the browser.
 *
 * Waiting only for the URL to become /payment-result was too early: that page
 * then calls our status endpoint, which re-reads the intent from Airwallex, and
 * closing the tab on navigation alone cut that confirming request off part-way.
 * So wait for the page to render a real outcome — a resolved icon rather than
 * its loading spinner — or for the checkout to show a decline banner, which is
 * where a refused card stays put.
 *
 * Polled rather than page.waitForFunction because the navigation tears down the
 * execution context underneath a long-running evaluation.
 */
async function waitForOutcome(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const state = await page
            .evaluate(() => {
                if (window.location.pathname.startsWith('/payment-result')) {
                    const icon = document.getElementById('icon');
                    const title = document.getElementById('title');
                    const variant = ((icon && icon.className) || '').match(
                        /is-(success|pending|error)/
                    );
                    return {
                        where: 'result',
                        // The icon only carries a variant once render() has run,
                        // which means the status call came back.
                        resolved: Boolean(variant),
                        variant: variant ? variant[1] : null,
                        title: ((title && title.textContent) || '').trim(),
                    };
                }

                const banner = document.querySelector('#status.is-error');
                const text = document.getElementById('status-text');
                return {
                    where: 'checkout',
                    declined: Boolean(banner),
                    message: banner ? ((text && text.textContent) || '').trim() : '',
                };
            })
            // Throws while the context is being swapped for the new document.
            .catch(() => null);

        if (state && state.where === 'result' && state.resolved) return state;
        if (state && state.where === 'checkout' && state.declined) return state;

        await sleep(400);
    }

    return { where: 'timeout' };
}

async function payOne(browser, { baseUrl, handoff, card, timeoutMs, say = () => {} }) {
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: jitter(1280, 1440), height: jitter(800, 900) });

        // Surface anything the checkout page itself complains about — a failed
        // SDK load or a script error would otherwise be silent in headless.
        page.on('pageerror', (err) => say(`page error: ${err.message}`));
        page.on('requestfailed', (req) => {
            const url = req.url();
            if (/airwallex|checkout/i.test(url)) {
                say(`request failed: ${url.slice(0, 90)}`);
            }
        });

        // The checkout page reads its session from sessionStorage, exactly as it
        // does for a human operator — no special automation entry point, so the
        // automated path exercises the same code as the manual one.
        await page.evaluateOnNewDocument((payload) => {
            try {
                window.sessionStorage.setItem('awx_checkout_handoff', JSON.stringify(payload));
            } catch (e) {
                /* storage unavailable; the page will show its own error */
            }
        }, handoff);

        say('opening checkout');
        await page.goto(`${baseUrl}/checkout`, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
        });

        // Wait for Airwallex's element to mount inside its iframe.
        const numberField = await findFrameWith(page, FIELD_SELECTORS.number, timeoutMs);
        if (!numberField) {
            throw new Error('Card fields never appeared — the checkout did not load');
        }
        say('card fields ready');

        await sleep(jitter(400, 1100));
        await humanType(numberField.frame, numberField.selector, card.pan);
        say(`card number entered (•••• ${String(card.pan).slice(-4)})`);

        const expiryField = await findFrameWith(page, FIELD_SELECTORS.expiry, 10000);
        if (!expiryField) throw new Error('Expiry field not found');
        // The field masks itself as MM / YY, so the four digits are enough.
        await humanType(expiryField.frame, expiryField.selector, card.expiry.replace(/\D/g, ''));
        say(`expiry entered (${card.expiry})`);

        const cvcField = await findFrameWith(page, FIELD_SELECTORS.cvc, 10000);
        if (!cvcField) throw new Error('CVC field not found');
        await humanType(cvcField.frame, cvcField.selector, card.cvv);
        say('cvc entered');

        // Cardholder name is not always rendered.
        const nameField = await findFrameWith(page, FIELD_SELECTORS.name, 3000);
        if (nameField) {
            await humanType(nameField.frame, nameField.selector, card.name);
            say(`cardholder entered (${card.name})`);
        }

        await sleep(jitter(500, 1400));

        const submitted = await clickPayButton(page);
        if (!submitted) throw new Error('Pay button not found');
        say('pay clicked — waiting for the result page');

        const outcome = await waitForOutcome(page, RESULT_TIMEOUT_MS);

        if (outcome.where === 'result') {
            say(`result page: ${outcome.variant} — "${outcome.title}"`);
            // The result page writes the operator toast after it renders; give
            // it that beat before the tab goes away.
            await sleep(jitter(700, 1400));
        } else if (outcome.where === 'checkout') {
            say(`checkout refused it: ${outcome.message || 'error shown, no message'}`);
        } else {
            say('no outcome shown before the timeout — falling back to Airwallex');
        }

        // Whatever the browser showed is a hint, not a verdict — the caller
        // confirms the real outcome against Airwallex.
        return { ok: true, seen: outcome };
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Pay one payment through the same browser automation the batches use.
 *
 * Single and bulk deliberately share this path. Airwallex's card element
 * records the IP of whoever is filling it in, so a payment typed by an operator
 * carries their address while a batch carries the server's — two different risk
 * profiles for what is the same merchant taking the same kind of card. Driving
 * both from here means every payment leaves from the same place.
 *
 * Unlike a batch run this is awaited: it is one payment, the operator is
 * watching, and the answer is worth the half minute.
 */
async function paySingle(paymentId, { headless = true, baseUrl } = {}) {
    const key = `single:${paymentId}`;
    if (activeRuns.has(key)) {
        const err = new Error('This payment is already being paid');
        err.statusCode = 409;
        throw err;
    }

    if (!cardVault.isConfigured()) {
        const err = new Error(
            'CARD_ENCRYPTION_KEY is not set on this server — the stored card cannot be decrypted'
        );
        err.statusCode = 409;
        throw err;
    }

    const { payment, card, reason } = await batchService.getPaymentWithCard(paymentId);

    if (!batchService.PAYABLE_STATUSES.includes(payment.status)) {
        const err = new Error(
            `This payment is ${payment.status
                .toLowerCase()
                .replace(/_/g, ' ')} and cannot be paid`
        );
        err.statusCode = 409;
        throw err;
    }
    if (!card) {
        const err = new Error(reason || 'No card stored for this payment');
        err.statusCode = 409;
        throw err;
    }

    const label = payment.description || payment.merchant_order_id;
    const say = (message) => log(label, message);

    activeRuns.set(key, { cancelled: false });
    const puppeteer = require('puppeteer');
    let browser = null;

    try {
        say(`single payment — ${payment.amount} ${payment.currency}, headless=${headless}`);
        browser = await puppeteer.launch({
            headless,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
            ],
            defaultViewport: null,
        });

        // A fresh client_secret, and a status re-check: a payment settled
        // elsewhere since the page loaded is refused rather than charged twice.
        const { checkout } = await paymentService.getCheckoutSession(
            payment.payment_intent_id
        );

        const attempt = await payOne(browser, {
            baseUrl,
            handoff: checkout,
            card,
            timeoutMs: 60000,
            say,
        });

        say('confirming with Airwallex');
        const outcome = await settleOutcome(payment.payment_intent_id);

        if (outcome.settled) {
            say(`PAID — ${outcome.status}`);
            await batchService.clearCardData(payment._id);
            await clearStaleError(payment._id);
            return { ok: true, status: outcome.status, payment_intent_id: payment.payment_intent_id };
        }

        const seen = attempt && attempt.seen;
        const why =
            outcome.generic && seen && seen.message ? seen.message : outcome.reason;
        say(`FAILED — ${why}`);
        await recordFailure(payment, why);
        return { ok: false, reason: why, payment_intent_id: payment.payment_intent_id };
    } catch (err) {
        say(`ERROR — ${err.message}`);
        await recordFailure(payment, err.message).catch(() => {});
        throw err;
    } finally {
        if (browser) await browser.close().catch(() => {});
        activeRuns.delete(key);
    }
}

/**
 * Pay every outstanding payment in a batch.
 *
 * Progress is written to the batch after each row so the page shows real
 * movement and an interrupted run leaves an accurate partial record.
 */
async function runBatch(batchId, { userId, headless = true, baseUrl } = {}) {
    const key = String(batchId);
    if (activeRuns.has(key)) {
        const err = new Error('This batch is already being paid');
        err.statusCode = 409;
        throw err;
    }

    // Fail the whole run up front rather than one row at a time.
    //
    // Without the key every stored card is unreadable, so a run would grind
    // through the entire batch recording the same decryption failure on each
    // row. One clear message beats several hundred identical ones.
    if (!cardVault.isConfigured()) {
        const err = new Error(
            'CARD_ENCRYPTION_KEY is not set on this server — stored cards cannot be decrypted'
        );
        err.statusCode = 409;
        throw err;
    }

    const batch = await batchService.getBatch(batchId);
    const items = await batchService.getPayableWithCards(batchId);
    if (!items.length) {
        const err = new Error('Nothing left to pay in this batch');
        err.statusCode = 409;
        throw err;
    }

    // A key that is set but wrong fails exactly like one that is missing, only
    // later and per row. If nothing in the batch decrypts, say so now.
    const usable = items.filter((i) => i.card).length;
    if (!usable) {
        const firstReason = (items[0] && items[0].reason) || 'no usable cards';
        const err = new Error(`No card in this batch could be read — ${firstReason}`);
        err.statusCode = 409;
        throw err;
    }
    if (usable < items.length) {
        log('', `warning: ${items.length - usable} of ${items.length} rows have no usable card`);
    }

    log(
        '',
        `batch "${batch.file_name || batchId}" — ${items.length} awaiting payment, ` +
            `${usable} with a readable card`
    );

    const controller = { cancelled: false };
    activeRuns.set(key, controller);

    await Batch.findByIdAndUpdate(batchId, {
        status: 'paying',
        'pay_run.status': 'running',
        'pay_run.headless': headless,
        'pay_run.total': items.length,
        'pay_run.processed': 0,
        'pay_run.succeeded': 0,
        'pay_run.failed': 0,
        'pay_run.error': null,
        'pay_run.started_at': new Date(),
        'pay_run.finished_at': null,
    });

    // Deliberately not awaited — the caller gets the batch back immediately and
    // polls. Failures are recorded on the batch, never left unhandled.
    execute(batchId, items, { headless, baseUrl, controller }).catch(async (err) => {
        log('', `run crashed: ${err.message}`);
        console.error('Batch pay run crashed:', err);
        activeRuns.delete(key);
        await Batch.findByIdAndUpdate(batchId, {
            status: 'ready',
            'pay_run.status': 'failed',
            'pay_run.error': err.message,
            'pay_run.finished_at': new Date(),
        }).catch(() => {});
    });

    return batch;
}

async function execute(batchId, items, { headless, baseUrl, controller }) {
    const puppeteer = require('puppeteer');
    const timeoutMs = 60000;
    const startedAt = Date.now();

    log('', `run starting — ${items.length} to pay, headless=${headless}, base=${baseUrl}`);

    const browser = await puppeteer.launch({
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
        ],
        defaultViewport: null,
    });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    try {
        for (const item of items) {
            if (controller.cancelled) {
                log('', 'run cancelled by operator — stopping after the current row');
                break;
            }

            const { payment, card, reason } = item;
            const label = payment.description || payment.merchant_order_id;
            const index = processed + 1;
            const say = rowLogger(index, items.length, label);

            await Batch.findByIdAndUpdate(batchId, { 'pay_run.current': label });

            // Re-read our own record before touching this row.
            //
            // The list was captured when the run started. On a resume — or a
            // long run — a row can have been settled since by an earlier run,
            // another operator, or a webhook. Paying it again would be a
            // duplicate charge, so anything no longer awaiting payment is
            // passed over rather than retried.
            const current = await Payment.findById(payment._id).select('status').lean();
            const liveStatus = (current && current.status) || payment.status;

            if (!batchService.PAYABLE_STATUSES.includes(liveStatus)) {
                processed += 1;
                if (batchService.SETTLED_STATUSES.includes(liveStatus)) {
                    succeeded += 1;
                    say(`already ${liveStatus.toLowerCase()} — skipping, not charging again`);
                } else {
                    failed += 1;
                    await recordFailure(
                        payment,
                        `Not payable — the intent is ${liveStatus.toLowerCase().replace(/_/g, ' ')}`
                    );
                    say(`is ${liveStatus.toLowerCase()} — cannot be paid, skipping`);
                }
                skipped += 1;
                await Batch.findByIdAndUpdate(batchId, {
                    'pay_run.processed': processed,
                    'pay_run.succeeded': succeeded,
                    'pay_run.failed': failed,
                }).catch(() => {});
                continue;
            }

            if (!card) {
                failed += 1;
                processed += 1;
                say(`no usable card: ${reason || 'none stored'}`);
                await recordFailure(payment, reason || 'No usable card');
                await Batch.findByIdAndUpdate(batchId, {
                    'pay_run.processed': processed,
                    'pay_run.succeeded': succeeded,
                    'pay_run.failed': failed,
                });
                continue;
            }

            say(`starting — ${payment.amount} ${payment.currency}`);

            try {
                // A fresh client_secret per attempt: they are short-lived, and
                // this doubles as a status re-check, so a payment completed
                // elsewhere is skipped rather than charged twice.
                const { checkout } = await paymentService.getCheckoutSession(
                    payment.payment_intent_id
                );

                const attempt = await payOne(browser, {
                    baseUrl,
                    handoff: checkout,
                    card,
                    timeoutMs,
                    say,
                });

                // Airwallex is the authority on the outcome, not the browser —
                // and capture lags the click, so give it a moment to land
                // rather than calling a good payment a failure.
                say('confirming with Airwallex');
                const outcome = await settleOutcome(payment.payment_intent_id);
                if (outcome.settled) {
                    succeeded += 1;
                    say(`PAID — ${outcome.status}`);
                    await batchService.clearCardData(payment._id);
                    await clearStaleError(payment._id);
                } else {
                    failed += 1;
                    // Only when Airwallex gave us nothing specific is the
                    // browser's own error banner the better thing to record.
                    const seen = attempt && attempt.seen;
                    const reason =
                        outcome.generic && seen && seen.message
                            ? seen.message
                            : outcome.reason;
                    say(`FAILED — ${reason}`);
                    await recordFailure(payment, reason);
                }
            } catch (err) {
                // getCheckoutSession re-reads the intent and refuses a 409 when
                // it is no longer payable. That is a row to pass over, not a
                // failure to report — it means someone already settled it.
                if (err.statusCode === 409) {
                    processed += 1;
                    skipped += 1;
                    succeeded += 1;
                    say(`skipped — ${err.message}`);
                    await Batch.findByIdAndUpdate(batchId, {
                        'pay_run.processed': processed,
                        'pay_run.succeeded': succeeded,
                        'pay_run.failed': failed,
                    }).catch(() => {});
                    continue;
                }
                failed += 1;
                say(`ERROR — ${err.message}`);
                await recordFailure(payment, err.message);
            }

            processed += 1;
            await Batch.findByIdAndUpdate(batchId, {
                'pay_run.processed': processed,
                'pay_run.succeeded': succeeded,
                'pay_run.failed': failed,
            }).catch(() => {});

            // Pause between payments. A steady machine-gun cadence is exactly
            // what fraud scoring looks for.
            if (!controller.cancelled) await sleep(jitter(2500, 6500));
        }
    } finally {
        await browser.close().catch(() => {});
        activeRuns.delete(String(batchId));
    }

    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    log(
        '',
        `run ${controller.cancelled ? 'cancelled' : 'complete'} — ` +
            `${succeeded} ok, ${failed} failed` +
            `${skipped ? `, ${skipped} skipped (not attempted)` : ''}` +
            ` of ${processed}/${items.length} in ${mins}m`
    );

    await Batch.findByIdAndUpdate(batchId, {
        status: 'ready',
        'pay_run.status': controller.cancelled ? 'cancelled' : 'completed',
        'pay_run.processed': processed,
        'pay_run.succeeded': succeeded,
        'pay_run.failed': failed,
        'pay_run.current': null,
        'pay_run.finished_at': new Date(),
    });
}

/**
 * Wait for Airwallex to settle on an outcome.
 *
 * A capture is requested the moment the button is clicked but the intent can
 * sit in flight for a few seconds. Judging it on the first read marks genuinely
 * successful payments as failures — which is exactly what happened before this
 * existed.
 */
async function settleOutcome(intentId, { attempts = 6, waitMs = 2500 } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
        last = await paymentService.syncPayment(intentId);

        if (batchService.SETTLED_STATUSES.includes(last.status)) {
            return { settled: true, status: last.status };
        }
        // A declined attempt is final; no point waiting it out.
        if (last.last_attempt_status === 'FAILED') {
            return {
                settled: false,
                reason:
                    (last.last_error && last.last_error.message) || 'The card was declined',
            };
        }
        if (i < attempts - 1) await sleep(waitMs);
    }

    return {
        settled: false,
        generic: true,
        reason: `Payment did not settle — still ${String(
            (last && last.status) || 'unknown'
        ).toLowerCase()}`,
    };
}

/**
 * Record a failure without going through save().
 *
 * The in-memory document is stale by this point — clearCardData and syncPayment
 * have both written to it — so save() throws a version conflict. A targeted
 * update sidesteps that.
 */
async function recordFailure(payment, message) {
    try {
        await Payment.updateOne(
            { _id: payment._id },
            {
                $set: {
                    last_error: {
                        code: 'automation_failed',
                        message,
                        occurred_at: new Date(),
                    },
                },
            }
        );
    } catch (err) {
        console.error('Could not record automation failure:', err.message);
    }
}

/** A successful retry should not leave the previous attempt's error behind. */
async function clearStaleError(paymentId) {
    await Payment.updateOne({ _id: paymentId }, { $unset: { last_error: '' } }).catch(
        () => {}
    );
}

function stopRun(batchId) {
    const controller = activeRuns.get(String(batchId));
    if (!controller) {
        const err = new Error('No run in progress for this batch');
        err.statusCode = 409;
        throw err;
    }
    controller.cancelled = true;
    return { stopping: true };
}

function isRunning(batchId) {
    return activeRuns.has(String(batchId));
}

/** Runs live in memory; a restart abandons them. */
async function failStaleRuns() {
    const result = await Batch.updateMany(
        { 'pay_run.status': 'running' },
        {
            $set: {
                status: 'ready',
                'pay_run.status': 'failed',
                'pay_run.error': 'Interrupted by a server restart',
                'pay_run.finished_at': new Date(),
            },
        }
    );
    if (result.modifiedCount) {
        console.warn(`Marked ${result.modifiedCount} interrupted pay run(s) as failed`);
    }
    return result.modifiedCount || 0;
}

module.exports = { runBatch, paySingle, stopRun, isRunning, failStaleRuns };
