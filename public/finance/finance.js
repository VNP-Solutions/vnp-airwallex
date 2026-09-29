(() => {
    // ============== Auth ==============
    const token =
        localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    if (!token) {
        window.location.replace('/login');
        return;
    }
    function authHeaders() {
        return { Authorization: `Bearer ${token}` };
    }

    async function api(path, options = {}) {
        const res = await fetch(path, {
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...authHeaders(),
                ...(options.headers || {}),
            },
        });
        if (res.status === 401) {
            window.location.replace('/login');
            throw new Error('Unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
        return data;
    }

    const escapeHtml = BulkUpload.escapeHtml;

    // ============== Formatting ==============
    function formatAmount(value, currency) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '—';
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency,
                currencyDisplay: 'code',
            })
                .format(n)
                .replace(currency, '')
                .trim();
        } catch (e) {
            return n.toFixed(2);
        }
    }

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        return d.toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    }

    function label(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase());
    }

    const STATUS_VARIANT = {
        SETTLED: 'success',
        COMPLETED: 'success',
        PENDING: 'pending',
        CANCELLED: 'danger',
        FAILED: 'danger',
    };

    function pill(status) {
        return `<span class="pill ${STATUS_VARIANT[status] || 'neutral'}">${escapeHtml(
            label(status)
        )}</span>`;
    }

    let toastTimer;
    function showToast(message, variant = 'success') {
        const el = document.getElementById('toast');
        clearTimeout(toastTimer);
        el.textContent = message;
        el.className = `toast ${variant === 'error' ? 'error' : 'success'}`;
        el.hidden = false;
        el.offsetHeight;
        el.classList.add('visible');
        toastTimer = setTimeout(() => {
            el.classList.remove('visible');
            setTimeout(() => {
                el.hidden = true;
            }, 300);
        }, 4000);
    }

    function setLoading(button, isLoading, text) {
        const labelEl = button.querySelector('.btn-label');
        if (isLoading) {
            button.dataset.originalLabel = labelEl.textContent;
            if (text) labelEl.textContent = text;
            button.classList.add('loading');
            button.disabled = true;
        } else {
            if (button.dataset.originalLabel) labelEl.textContent = button.dataset.originalLabel;
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    function skeletonRows(cols, count = 4) {
        return Array.from({ length: count })
            .map(
                () =>
                    `<tr class="skeleton-row">${Array.from({ length: cols })
                        .map(() => '<td><div class="skel-pill" style="width:60%"></div></td>')
                        .join('')}</tr>`
            )
            .join('');
    }

    function emptyRow(cols, message) {
        return `<tr><td colspan="${cols}"><div class="data-empty"><p>${escapeHtml(
            message
        )}</p></div></td></tr>`;
    }

    // ============== Tabs ==============
    const tabs = document.getElementById('finance-tabs');
    const loaded = new Set();

    tabs.addEventListener('click', (event) => {
        const btn = event.target.closest('.finance-tab');
        if (!btn) return;
        const name = btn.dataset.tab;

        tabs.querySelectorAll('.finance-tab').forEach((t) =>
            t.classList.toggle('active', t === btn)
        );
        document.querySelectorAll('.tab-panel').forEach((p) => {
            p.hidden = p.dataset.panel !== name;
        });

        // Each tab is its own Airwallex call; load on first view rather than
        // firing four requests on page load.
        if (!loaded.has(name)) {
            loaded.add(name);
            LOADERS[name]();
        }
    });

    // ============== Balances ==============
    const balanceGrid = document.getElementById('balance-grid');
    const balancesMeta = document.getElementById('balances-meta');
    const includeZero = document.getElementById('include-zero');
    // Populates the currency filters on the other tabs.
    let knownCurrencies = [];

    async function loadBalances() {
        balanceGrid.innerHTML = Array.from({ length: 4 })
            .map(() => '<div class="balance-card is-skeleton"></div>')
            .join('');
        try {
            const data = await api(
                `/api/finance/balances?include_zero=${includeZero.checked}`
            );
            balancesMeta.textContent = `${data.currencies_funded} funded of ${data.currencies_total} currencies`;

            if (!knownCurrencies.length) {
                knownCurrencies = data.items.map((b) => b.currency);
                fillCurrencySelects();
            }

            if (!data.items.length) {
                balanceGrid.innerHTML =
                    '<div class="data-empty"><p>No balances to show.</p></div>';
                return;
            }

            balanceGrid.innerHTML = data.items
                .map(
                    (b) => `
                <article class="balance-card">
                    <div class="balance-head">
                        <span class="balance-currency">${escapeHtml(b.currency)}</span>
                        <span class="balance-type">${escapeHtml(label(b.account_type))}</span>
                    </div>
                    <div class="balance-available">${escapeHtml(
                        formatAmount(b.available_amount, b.currency)
                    )}</div>
                    <div class="balance-available-label">Available</div>
                    <dl class="balance-breakdown">
                        <div><dt>Pending</dt><dd>${escapeHtml(
                            formatAmount(b.pending_amount, b.currency)
                        )}</dd></div>
                        <div><dt>Reserved</dt><dd>${escapeHtml(
                            formatAmount(b.reserved_amount, b.currency)
                        )}</dd></div>
                        <div><dt>Total</dt><dd>${escapeHtml(
                            formatAmount(b.total_amount, b.currency)
                        )}</dd></div>
                    </dl>
                </article>`
                )
                .join('');
        } catch (err) {
            balanceGrid.innerHTML = `<div class="data-empty"><p>${escapeHtml(
                err.message
            )}</p></div>`;
        }
    }

    includeZero.addEventListener('change', loadBalances);

    function fillCurrencySelects() {
        const options = `<option value="">All</option>${knownCurrencies
            .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
            .join('')}`;
        document.getElementById('settle-currency').innerHTML = options;
        document.getElementById('tx-currency').innerHTML = options;
        document.getElementById('report-currencies').innerHTML = knownCurrencies
            .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
            .join('');
    }

    // ============== Settlements ==============
    const settleBody = document.getElementById('settle-tbody');
    const settleMeta = document.getElementById('settle-meta');
    const settleTotals = document.getElementById('settle-totals');

    async function loadSettlements() {
        settleBody.innerHTML = skeletonRows(8);
        const params = new URLSearchParams({ limit: '500' });
        const from = document.getElementById('settle-from').value;
        const to = document.getElementById('settle-to').value;
        const currency = document.getElementById('settle-currency').value;
        if (from) params.set('from', `${from}T00:00:00Z`);
        if (to) params.set('to', `${to}T23:59:59Z`);
        if (currency) params.set('currency', currency);

        try {
            const data = await api(`/api/finance/settlements?${params}`);
            settleMeta.textContent = `${data.batches.length} batches from ${data.transaction_count} entries${
                data.has_more ? ' (more available — narrow the dates)' : ''
            }`;

            settleTotals.hidden = !data.totals.length;
            settleTotals.innerHTML = data.totals
                .map(
                    (t) => `
                <div class="settle-total">
                    <span class="settle-total-currency">${escapeHtml(t.currency)}</span>
                    <span class="settle-total-net">${escapeHtml(
                        formatAmount(t.net, t.currency)
                    )}</span>
                    <span class="settle-total-fee">fees ${escapeHtml(
                        formatAmount(t.fee, t.currency)
                    )}</span>
                </div>`
                )
                .join('');

            if (!data.batches.length) {
                settleBody.innerHTML = emptyRow(8, 'No settlements in this period.');
                return;
            }

            settleBody.innerHTML = data.batches
                .map(
                    (b) => `
                <tr class="settle-row" data-batch="${escapeHtml(b.batch_id || '')}">
                    <td>
                        <div class="entity-name">${escapeHtml(b.batch_id || 'Unbatched')}</div>
                        <div class="entity-sub">${escapeHtml(
                            b.types.slice(0, 3).map(label).join(', ')
                        )}</div>
                    </td>
                    <td><span class="entity-meta">${escapeHtml(b.currency)}</span></td>
                    <td><span class="entity-meta">${b.count}</span></td>
                    <td class="amount-cell">${escapeHtml(formatAmount(b.gross, b.currency))}</td>
                    <td class="amount-cell fee">${escapeHtml(formatAmount(b.fee, b.currency))}</td>
                    <td class="amount-cell net">${escapeHtml(formatAmount(b.net, b.currency))}</td>
                    <td>${pill(b.status)}</td>
                    <td><span class="entity-meta">${escapeHtml(formatDate(b.settled_at))}</span></td>
                </tr>`
                )
                .join('');
        } catch (err) {
            settleBody.innerHTML = emptyRow(8, err.message);
        }
    }

    document.getElementById('settle-apply').addEventListener('click', loadSettlements);

    // Expand a batch in place to show the entries behind it.
    settleBody.addEventListener('click', async (event) => {
        const row = event.target.closest('.settle-row');
        if (!row || !row.dataset.batch) return;

        const next = row.nextElementSibling;
        if (next && next.classList.contains('settle-detail')) {
            next.remove();
            row.classList.remove('is-open');
            return;
        }

        row.classList.add('is-open');
        const detail = document.createElement('tr');
        detail.className = 'settle-detail';
        detail.innerHTML = '<td colspan="8"><div class="settle-detail-body">Loading…</div></td>';
        row.after(detail);

        try {
            const data = await api(
                `/api/finance/settlements/${encodeURIComponent(row.dataset.batch)}`
            );
            detail.querySelector('.settle-detail-body').innerHTML = `
                <table class="inner-table">
                    <thead><tr><th>Type</th><th>Amount</th><th>Fee</th><th>Net</th><th>Status</th><th>Source</th></tr></thead>
                    <tbody>
                        ${data.items
                            .map(
                                (t) => `<tr>
                                    <td>${escapeHtml(label(t.transaction_type))}</td>
                                    <td class="amount-cell">${escapeHtml(
                                        formatAmount(t.amount, t.currency)
                                    )}</td>
                                    <td class="amount-cell fee">${escapeHtml(
                                        formatAmount(t.fee, t.currency)
                                    )}</td>
                                    <td class="amount-cell net">${escapeHtml(
                                        formatAmount(t.net, t.currency)
                                    )}</td>
                                    <td>${pill(t.status)}</td>
                                    <td class="mono">${escapeHtml(t.source_id || '—')}</td>
                                </tr>`
                            )
                            .join('')}
                    </tbody>
                </table>`;
        } catch (err) {
            detail.querySelector('.settle-detail-body').textContent = err.message;
        }
    });

    // ============== Transactions ==============
    const txBody = document.getElementById('tx-tbody');
    const txMeta = document.getElementById('tx-meta');

    function txParams() {
        const params = new URLSearchParams({ limit: '200' });
        const currency = document.getElementById('tx-currency').value;
        const status = document.getElementById('tx-status').value;
        if (currency) params.set('currency', currency);
        if (status) params.set('status', status);
        return params;
    }

    async function loadTransactions() {
        txBody.innerHTML = skeletonRows(8);
        try {
            const data = await api(`/api/finance/transactions?${txParams()}`);
            txMeta.textContent = `${data.items.length} entries${
                data.has_more ? ' (more available)' : ''
            }`;

            if (!data.items.length) {
                txBody.innerHTML = emptyRow(8, 'No transactions match these filters.');
                return;
            }

            txBody.innerHTML = data.items
                .map(
                    (t) => `
                <tr>
                    <td>
                        <div class="entity-name">${escapeHtml(label(t.transaction_type))}</div>
                        <div class="entity-sub">${escapeHtml(label(t.source_type))}</div>
                    </td>
                    <td class="mono">${escapeHtml(t.batch_id || '—')}</td>
                    <td><span class="entity-meta">${escapeHtml(t.currency)}</span></td>
                    <td class="amount-cell">${escapeHtml(formatAmount(t.amount, t.currency))}</td>
                    <td class="amount-cell fee">${escapeHtml(formatAmount(t.fee, t.currency))}</td>
                    <td class="amount-cell net">${escapeHtml(formatAmount(t.net, t.currency))}</td>
                    <td>${pill(t.status)}</td>
                    <td><span class="entity-meta">${escapeHtml(formatDate(t.settled_at))}</span></td>
                </tr>`
                )
                .join('');
        } catch (err) {
            txBody.innerHTML = emptyRow(8, err.message);
        }
    }

    document.getElementById('tx-apply').addEventListener('click', loadTransactions);
    document.getElementById('tx-export').addEventListener('click', async () => {
        try {
            await BulkUpload.download(`/api/finance/transactions/export?${txParams()}`);
            showToast('Transactions exported.');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    // ============== Reports ==============
    const typeSelect = document.getElementById('report-type');
    const formatSelect = document.getElementById('report-format');
    const reportDesc = document.getElementById('report-desc');
    const currencyField = document.getElementById('report-currency-field');
    const reportError = document.getElementById('report-error');
    const reportsBody = document.getElementById('reports-tbody');
    const reportsMeta = document.getElementById('reports-meta');
    const generateBtn = document.getElementById('report-generate');
    let reportTypes = [];

    async function loadReportOptions() {
        const data = await api('/api/finance/reports/options');
        reportTypes = data.types;
        typeSelect.innerHTML = reportTypes
            .map((t) => `<option value="${escapeHtml(t.type)}">${escapeHtml(t.label)}</option>`)
            .join('');
        syncFormats();
    }

    /** Only offer formats the chosen report actually supports. */
    function syncFormats() {
        const spec = reportTypes.find((t) => t.type === typeSelect.value);
        if (!spec) return;
        formatSelect.innerHTML = spec.formats
            .map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
            .join('');
        reportDesc.textContent = spec.description;
        currencyField.hidden = !spec.requiresCurrencies;
    }

    typeSelect.addEventListener('change', syncFormats);

    async function loadReports() {
        reportsBody.innerHTML = skeletonRows(5);
        try {
            const data = await api('/api/finance/reports?page_size=20');
            reportsMeta.textContent = `${data.items.length} report${
                data.items.length === 1 ? '' : 's'
            }`;

            if (!data.items.length) {
                reportsBody.innerHTML = emptyRow(5, 'No reports generated yet.');
                return;
            }

            reportsBody.innerHTML = data.items
                .map((r) => {
                    const params = r.report_parameters || {};
                    const ready = r.status === 'COMPLETED';
                    return `
                    <tr data-report="${escapeHtml(r.id)}">
                        <td>
                            <div class="entity-name">${escapeHtml(label(r.type))}</div>
                            <div class="entity-sub mono">${escapeHtml(r.file_name || '')}</div>
                        </td>
                        <td><span class="entity-meta">${escapeHtml(
                            params.from_date || '—'
                        )} → ${escapeHtml(params.to_date || '—')}</span></td>
                        <td><span class="entity-meta">${escapeHtml(r.file_format || '')}</span></td>
                        <td>${pill(r.status)}</td>
                        <td class="col-actions">
                            ${
                                ready
                                    ? `<button class="action-link" type="button" data-download="${escapeHtml(
                                          r.id
                                      )}">Download</button>`
                                    : '<span class="entity-meta">—</span>'
                            }
                        </td>
                    </tr>`;
                })
                .join('');
        } catch (err) {
            reportsBody.innerHTML = emptyRow(5, err.message);
        }
    }

    reportsBody.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-download]');
        if (!btn) return;
        const original = btn.textContent;
        btn.textContent = 'Downloading…';
        btn.disabled = true;
        try {
            // Proxied through our server so the Airwallex token stays server-side.
            await BulkUpload.download(`/api/finance/reports/${btn.dataset.download}/download`);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.textContent = original;
            btn.disabled = false;
        }
    });

    generateBtn.addEventListener('click', async () => {
        reportError.hidden = true;
        const spec = reportTypes.find((t) => t.type === typeSelect.value);
        const currencies = [...document.getElementById('report-currencies').selectedOptions].map(
            (o) => o.value
        );

        setLoading(generateBtn, true, 'Requesting…');
        try {
            const report = await api('/api/finance/reports', {
                method: 'POST',
                body: JSON.stringify({
                    type: typeSelect.value,
                    file_format: formatSelect.value,
                    from_date: document.getElementById('report-from').value,
                    to_date: document.getElementById('report-to').value,
                    currencies: spec && spec.requiresCurrencies ? currencies : undefined,
                }),
            });
            showToast('Report requested — it appears below when ready.');
            await loadReports();
            pollReport(report.id);
        } catch (err) {
            reportError.textContent = err.message;
            reportError.hidden = false;
        } finally {
            setLoading(generateBtn, false);
        }
    });

    /** Airwallex builds the file asynchronously; watch until it is ready. */
    async function pollReport(id, attempt = 0) {
        if (attempt > 30) return;
        try {
            const report = await api(`/api/finance/reports/${id}`);
            if (report.status === 'COMPLETED' || report.status === 'FAILED') {
                await loadReports();
                showToast(
                    report.status === 'COMPLETED'
                        ? 'Report ready to download.'
                        : 'Airwallex could not build that report.',
                    report.status === 'COMPLETED' ? 'success' : 'error'
                );
                return;
            }
            setTimeout(() => pollReport(id, attempt + 1), 2000);
        } catch (err) {
            console.error(err);
        }
    }

    // ============== Init ==============
    const LOADERS = {
        balances: loadBalances,
        settlements: loadSettlements,
        transactions: loadTransactions,
        reports: async () => {
            await loadReportOptions();
            await loadReports();
        },
    };

    // Default the report range to the last 30 days.
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86400000);
    document.getElementById('report-to').value = today.toISOString().slice(0, 10);
    document.getElementById('report-from').value = monthAgo.toISOString().slice(0, 10);

    document.getElementById('refresh-btn').addEventListener('click', () => {
        const active = tabs.querySelector('.finance-tab.active').dataset.tab;
        LOADERS[active]();
    });

    loaded.add('balances');
    loadBalances();
})();
