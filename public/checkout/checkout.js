(() => {
    const HANDOFF_KEY = 'awx_checkout_handoff';

    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const summaryEl = document.getElementById('summary');

    function fail(message, { allowRetry = true } = {}) {
        statusEl.hidden = false;
        statusEl.classList.add('is-error');
        statusText.innerHTML = `${message}${
            allowRetry ? '<br><a class="retry-link" href="/payments">Back to payments</a>' : ''
        }`;
    }

    function formatAmount(amount, currency) {
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency,
            }).format(amount);
        } catch (e) {
            return `${Number(amount).toFixed(2)} ${currency}`;
        }
    }

    // The intent details were handed over by the payments page rather than put
    // in the URL — client_secret is a credential and does not belong in a link,
    // browser history or a referer header.
    let handoff;
    try {
        handoff = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || 'null');
    } catch (e) {
        handoff = null;
    }

    if (!handoff || !handoff.intent_id || !handoff.client_secret) {
        fail('This checkout session has expired or was opened directly.');
        return;
    }

    // One-shot: a client_secret should not be replayable from a stale tab.
    sessionStorage.removeItem(HANDOFF_KEY);

    document.getElementById('summary-amount').textContent = formatAmount(
        handoff.amount,
        handoff.currency
    );
    document.getElementById('summary-description').textContent =
        handoff.description || '';
    document.getElementById('summary-order').textContent = handoff.merchant_order_id;
    document.getElementById('summary-descriptor').textContent = handoff.descriptor || '—';
    summaryEl.hidden = false;

    function goToResult(outcome) {
        window.location.href = `/payment-result?order=${encodeURIComponent(
            handoff.merchant_order_id
        )}&outcome=${outcome}`;
    }

    // Only one outcome may win: a success event and a late error must not both
    // navigate, or the shopper bounces between result pages.
    let settled = false;

    function settle(fn) {
        if (settled) return;
        settled = true;
        fn();
    }

    /**
     * Decide what an error really means by asking our own server, which re-reads
     * the intent from Airwallex.
     *
     * The drop-in reports a generic "something went wrong" when a confirm is
     * rejected — including `invalid_status_for_operation` on an intent that has
     * ALREADY succeeded. Treating that as a failure would tell a shopper their
     * payment failed after they had been charged.
     */
    async function resolveError(message) {
        try {
            const res = await fetch(
                `/api/payments/status/${encodeURIComponent(handoff.merchant_order_id)}`
            );
            if (res.ok) {
                const data = await res.json();
                if (['SUCCEEDED', 'REQUIRES_CAPTURE'].includes(data.status)) {
                    settle(() => goToResult('success'));
                    return;
                }
            }
        } catch (e) {
            // Fall through to showing the original error.
        }
        fail(message);
    }

    async function mountDropIn() {
        const sdk = window.AirwallexComponentsSDK;
        if (!sdk) {
            fail('Could not load the Airwallex SDK. Check your connection and try again.');
            return;
        }

        try {
            await sdk.init({
                env: handoff.env,
                enabledElements: ['payments'],
            });

            const element = await sdk.createElement('dropIn', {
                intent_id: handoff.intent_id,
                client_secret: handoff.client_secret,
                currency: handoff.currency,
                // Capture straight away; switch to false to authorise now and
                // capture later from the payments page.
                autoCapture: true,
                layout: { type: 'accordion' },
                appearance: {
                    mode: 'light',
                    variables: { colorBrand: '#14274E' },
                },
            });

            // The payments drop-in signals through bubbling DOM CustomEvents on
            // its mount node, NOT through element.on(). element.on() registers
            // into an internal emitter that never fires for this element, so it
            // fails silently — the form renders but nothing is ever handled.
            // These bubble with composed:true, so document sees them all.
            document.addEventListener('onReady', () => {
                statusEl.hidden = true;
            });

            document.addEventListener('onSuccess', () => {
                settle(() => {
                    statusEl.hidden = false;
                    statusEl.classList.remove('is-error');
                    statusText.textContent = 'Payment authorised — confirming…';
                    goToResult('success');
                });
            });

            document.addEventListener('onError', (event) => {
                const detail = (event && event.detail) || {};
                const error = detail.error || {};
                resolveError(
                    error.message ||
                        error.code ||
                        'Something went wrong while processing the payment.'
                );
            });

            document.addEventListener('onCancel', () => {
                settle(() => goToResult('cancel'));
            });

            element.mount('dropin-container');

            // Safety net: if onReady is ever missed the shopper would stare at a
            // spinner sitting above a perfectly usable form. Hide it as soon as
            // the drop-in puts anything into the container.
            const container = document.getElementById('dropin-container');
            const observer = new MutationObserver(() => {
                if (container.childNodes.length) {
                    statusEl.hidden = true;
                    observer.disconnect();
                }
            });
            observer.observe(container, { childList: true, subtree: true });
        } catch (err) {
            console.error(err);
            fail(err.message || 'Could not start checkout.');
        }
    }

    mountDropIn();
})();
