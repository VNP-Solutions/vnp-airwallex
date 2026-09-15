(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order');
    const outcome = params.get('outcome');

    const iconEl = document.getElementById('icon');
    const titleEl = document.getElementById('title');
    const messageEl = document.getElementById('message');
    const metaEl = document.getElementById('meta');
    const continueEl = document.getElementById('continue');

    const ICONS = {
        success: '<svg viewBox="0 0 24 24"><path d="M4 12.5L9.5 18L20 7"/></svg>',
        pending: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>',
        error: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    };

    // How each Airwallex status should read to the shopper.
    const OUTCOMES = {
        SUCCEEDED: {
            variant: 'success',
            title: 'Payment successful',
            message: 'Thank you — your payment has been received.',
        },
        REQUIRES_CAPTURE: {
            variant: 'success',
            title: 'Payment authorised',
            message: 'The funds are on hold and will be captured shortly.',
        },
        PENDING: {
            variant: 'pending',
            title: 'Payment processing',
            message: 'Your payment is still being processed. This page will update once it settles.',
        },
        REQUIRES_CUSTOMER_ACTION: {
            variant: 'pending',
            title: 'Payment incomplete',
            message: 'The payment needs another step to finish. You can start again from the payments page.',
        },
        REQUIRES_PAYMENT_METHOD: {
            variant: 'pending',
            title: 'Payment not completed',
            message: 'No payment was taken. You can try again from the payments page.',
        },
        CANCELLED: {
            variant: 'error',
            title: 'Payment cancelled',
            message: 'This payment was cancelled and nothing was charged.',
        },
        EXPIRED: {
            variant: 'error',
            title: 'Payment expired',
            message: 'This payment link is no longer valid. Please start a new one.',
        },
        FAILED: {
            variant: 'error',
            title: 'Payment failed',
            message: 'The payment could not be completed. No funds were taken.',
        },
    };

    function render({ variant, title, message }) {
        iconEl.className = `result-icon is-${variant}`;
        iconEl.innerHTML = ICONS[variant] || ICONS.pending;
        titleEl.textContent = title;
        messageEl.textContent = message;
    }

    function formatAmount(amount, currency) {
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
                amount
            );
        } catch (e) {
            return `${Number(amount).toFixed(2)} ${currency}`;
        }
    }

    // Operators land back in the app; shoppers just see the outcome.
    const isOperator =
        localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    if (!isOperator) {
        continueEl.hidden = true;
    }

    if (!orderId) {
        render({
            variant: 'error',
            title: 'Nothing to show',
            message: 'This page was opened without a payment reference.',
        });
        return;
    }

    // A shopper who bailed out never reached Airwallex, so trust the URL for
    // that case only; every other outcome is confirmed against the API.
    if (outcome === 'cancel') {
        render(OUTCOMES.CANCELLED);
    }

    async function loadStatus() {
        try {
            // This endpoint re-reads the intent from Airwallex, so the status
            // shown here is authoritative and not just our last known value.
            const res = await fetch(
                `/api/payments/status/${encodeURIComponent(orderId)}`
            );
            const data = await res.json();

            if (!res.ok) {
                render({
                    variant: 'error',
                    title: 'Payment not found',
                    message: data.error || 'We could not find this payment.',
                });
                return;
            }

            render(
                OUTCOMES[data.status] || {
                    variant: 'pending',
                    title: 'Payment status',
                    message: `Current status: ${String(data.status || '')
                        .toLowerCase()
                        .replace(/_/g, ' ')}.`
                }
            );

            document.getElementById('meta-amount').textContent = formatAmount(
                data.amount,
                data.currency
            );
            document.getElementById('meta-order').textContent = data.merchant_order_id;
            document.getElementById('meta-descriptor').textContent =
                data.descriptor || '—';
            metaEl.hidden = false;

            if (isOperator) {
                const variant =
                    (OUTCOMES[data.status] || {}).variant === 'success'
                        ? 'success'
                        : 'error';
                sessionStorage.setItem(
                    'payment_toast',
                    JSON.stringify({
                        message: `${data.merchant_order_id}: ${String(data.status)
                            .toLowerCase()
                            .replace(/_/g, ' ')}`,
                        variant,
                    })
                );
            }
        } catch (err) {
            console.error(err);
            render({
                variant: 'error',
                title: 'Could not confirm payment',
                message: 'We could not reach the server. Please check the payments page.',
            });
        }
    }

    loadStatus();
})();
