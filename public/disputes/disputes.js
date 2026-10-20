(() => {
    const token =
        localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    if (!token) {
        window.location.replace('/login');
        return;
    }

    async function api(path, options = {}) {
        const res = await fetch(path, {
            ...options,
            headers: {
                ...(options.body && !(options.body instanceof ArrayBuffer)
                    ? { 'Content-Type': 'application/json' }
                    : {}),
                Authorization: `Bearer ${token}`,
                ...(options.headers || {}),
            },
        });
        if (res.status === 401) {
            window.location.replace('/login');
            throw new Error('Unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    const tbody = document.getElementById('disputes-tbody');
    const detailModal = document.getElementById('detail-modal');
    const detailBody = document.getElementById('detail-body');
    const acceptModal = document.getElementById('accept-modal');
    const syncBtn = document.getElementById('sync-btn');
    const simulateBtn = document.getElementById('simulate-btn');
    const searchInput = document.getElementById('search-input');

    let options = null;
    let rows = [];
    let filter = 'open';
    let search = '';
    let current = null;

    // ============== Helpers ==============
    const escapeHtml = (v) =>
        String(v == null ? '' : v).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );

    const title = (v) =>
        String(v || '')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase());

    function money(amount, currency) {
        const n = Number(amount);
        if (!Number.isFinite(n)) return '—';
        try {
            return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
        } catch (e) {
            return `${n.toFixed(2)} ${currency || ''}`;
        }
    }

    function formatDate(value) {
        if (!value) return '—';
        return new Date(value).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    }

    /** How long until a response is due — the thing that decides what to work next. */
    function dueCell(d) {
        if (!d.due_at) return '<span class="entity-meta">—</span>';
        const days = Math.ceil((new Date(d.due_at) - Date.now()) / 864e5);
        const open = (options ? options.open_statuses : ['REQUIRES_RESPONSE']).includes(d.status);
        if (!open) {
            return `<span class="entity-meta">${escapeHtml(formatDate(d.due_at))}</span>`;
        }
        const cls = days < 0 ? 'is-overdue' : days <= 3 ? 'is-soon' : '';
        const label =
            days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'today' : `${days}d left`;
        return `<div class="entity-stack">
            <div class="due-label ${cls}">${escapeHtml(label)}</div>
            <div class="order-id">${escapeHtml(formatDate(d.due_at))}</div>
        </div>`;
    }

    function statusPill(status) {
        const map = {
            REQUIRES_RESPONSE: 'pending',
            CHALLENGED: 'info',
            PENDING_DECISION: 'info',
            PENDING_CLOSURE: 'info',
            WON: 'success',
            ACCEPTED: 'danger',
            LOST: 'danger',
            EXPIRED: 'danger',
            REVERSED: 'success',
        };
        return `<span class="pill ${map[status] || 'info'}">${escapeHtml(title(status))}</span>`;
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
        const label = button.querySelector('.btn-label');
        if (isLoading) {
            button.dataset.original = label ? label.textContent : '';
            if (label && text) label.textContent = text;
            button.classList.add('loading');
            button.disabled = true;
        } else {
            if (label && button.dataset.original) label.textContent = button.dataset.original;
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    const openModal = (m) => {
        m.hidden = false;
        m.offsetHeight;
        m.classList.add('visible');
    };
    const closeModal = (m) => {
        m.classList.remove('visible');
        setTimeout(() => {
            m.hidden = true;
        }, 200);
    };

    document.addEventListener('click', (e) => {
        const closer = e.target.closest('[data-close]');
        if (closer) {
            closeModal(closer.dataset.close === 'accept' ? acceptModal : detailModal);
            return;
        }
        if (e.target === detailModal) closeModal(detailModal);
        if (e.target === acceptModal) closeModal(acceptModal);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!acceptModal.hidden) closeModal(acceptModal);
        else if (!detailModal.hidden) closeModal(detailModal);
    });

    // ============== Table ==============
    function render() {
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="9"><div class="data-empty">
                <p>No disputes here.</p>
                <span>Press “Sync from Airwallex” to pull the latest.</span>
            </div></td></tr>`;
            return;
        }

        tbody.innerHTML = rows
            .map(
                (d) => `
            <tr data-id="${escapeHtml(d.dispute_id)}">
                <td>
                    <div class="entity-stack">
                        <div class="entity-name">${escapeHtml(d.dispute_id)}</div>
                        <div class="order-id">${escapeHtml(formatDate(d.dispute_created_at))}</div>
                    </div>
                </td>
                <td>
                    <div class="entity-stack">
                        <div class="entity-name">${escapeHtml(d.hotel_name || '—')}</div>
                        ${
                            d.hotel_portfolio
                                ? `<div class="order-id">${escapeHtml(d.hotel_portfolio)}</div>`
                                : ''
                        }
                    </div>
                </td>
                <td>
                    <div class="entity-stack">
                        <div class="entity-name">${escapeHtml(
                            d.reservation_id || d.merchant_order_id || '—'
                        )}</div>
                        <div class="order-id">${escapeHtml(d.payment_intent_id || '')}</div>
                    </div>
                </td>
                <td class="amount-cell">${escapeHtml(money(d.amount, d.currency))}</td>
                <td>
                    <div class="entity-stack">
                        <div class="entity-name">${escapeHtml(
                            title((d.reason && d.reason.type) || '—')
                        )}</div>
                        ${
                            d.reason && d.reason.original_code
                                ? `<div class="order-id">${escapeHtml(d.reason.original_code)}</div>`
                                : ''
                        }
                    </div>
                </td>
                <td><span class="entity-meta">${escapeHtml(title(d.stage))}</span></td>
                <td>${statusPill(d.status)}</td>
                <td>${dueCell(d)}</td>
                <td class="col-actions">
                    <div class="actions">
                        <button class="action-link" type="button" data-view="${escapeHtml(
                            d.dispute_id
                        )}">View</button>
                    </div>
                </td>
            </tr>`
            )
            .join('');
    }

    async function load() {
        const params = new URLSearchParams();
        if (filter === 'open') params.set('open', 'true');
        else if (filter === 'closed') params.set('open', 'false');
        else if (filter) params.set('status', filter);
        if (search) params.set('q', search);
        params.set('limit', '200');

        try {
            const data = await api(`/api/disputes?${params}`);
            rows = data.items || [];
            render();
        } catch (err) {
            tbody.innerHTML = `<tr><td colspan="9"><div class="data-empty"><p>${escapeHtml(
                err.message
            )}</p></div></td></tr>`;
        }
    }

    const formatNumber = (n) => Number(n || 0).toLocaleString();
    const formatAmount = (n) =>
        Number(n || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });

    async function loadStats() {
        const grid = document.getElementById('stats-grid');
        try {
            const s = await api('/api/disputes/stats');

            const closed = (s.by_status || []).reduce(
                (n, r) =>
                    (options ? options.closed_statuses : []).includes(r.status) ? n + r.count : n,
                0
            );
            const won = (s.by_status || []).find((r) => r.status === 'WON');

            grid.innerHTML = `
                <div class="stat-card">
                    <div class="stat-label">Needs response</div>
                    <div class="stat-value">${formatNumber(s.open)}</div>
                    <div class="stat-hint">${
                        s.due_soon
                            ? `${formatNumber(s.due_soon)} due within 3 days`
                            : 'nothing due in the next 3 days'
                    }</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Open cases</div>
                    <div class="stat-value">${formatNumber(s.total - closed)}</div>
                    <div class="stat-hint">${formatNumber(s.total)} in total</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Resolved</div>
                    <div class="stat-value">${formatNumber(closed)}</div>
                    <div class="stat-hint">${
                        won ? `${formatNumber(won.count)} won` : 'none won yet'
                    }</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Amount at risk</div>
                    ${
                        (s.at_risk || []).length
                            ? `<div class="currency-list">${s.at_risk
                                  .map(
                                      (c) => `
                                <div class="currency-row">
                                    <span class="currency-code">${escapeHtml(c.currency)}</span>
                                    <span class="currency-amount">${formatAmount(c.amount)}</span>
                                    <span class="currency-count">${formatNumber(c.count)}</span>
                                </div>`
                                  )
                                  .join('')}</div>`
                            : '<div class="stat-value">—</div><div class="stat-hint">nothing outstanding</div>'
                    }
                </div>`;
        } catch (e) {
            grid.innerHTML = '';
        }
    }

    // ============== Custom select ==============
    //
    // The same dropdown the rest of the app uses — the .menu / .menu-option
    // panel from bulk.css, with a grey hint line under each choice — wrapped
    // as a form control. Native <select>s render as white OS widgets in a
    // dark modal, and cannot carry the hint that explains what each option
    // actually means to the issuer.

    const CHALLENGE_HINTS = {
        PRODUCT_RECEIVED: 'The stay or service was provided as booked',
        CUSTOMER_WITHDRAWN: 'The cardholder has withdrawn the dispute',
        CUSTOMER_REFUNDED: 'Already refunded outside this dispute',
        PURCHASE_HISTORY: 'The cardholder has booked with you before',
        NOT_ENTITLED: 'Not entitled to a refund under the booking terms',
        SEPARATE_PRODUCT: 'Separate bookings, not a duplicate charge',
        AUTHENTIC_PRODUCT: 'What was sold was genuine and as described',
        OTHER_REASONS: 'Explain in the note below',
    };

    const PRODUCT_HINTS = {
        RESERVE_OR_BOOKING: 'A hotel room or other reservation',
        TRAVEL: 'Transport or a travel package',
        OFFLINE_SERVICE: 'A service delivered in person',
        DIGITAL_PRODUCT_OR_SERVICE: 'Delivered online',
        PHYSICAL_GOODS: 'Shipped goods',
        OTHERS: 'None of the above',
    };

    const ACCEPT_HINTS = {
        LOW_VALUE_TRANSACTION: 'Costs more to defend than it is worth',
        VALID_CUSTOMER_DISPUTE: 'The cardholder is right',
        AGREEMENT_REACHED_WITH_CUSTOMER: 'Settled directly with the guest',
        CUSTOMER_RELATIONSHIP_MAINTENANCE: 'Conceding to keep the relationship',
        NO_ACTION_TAKEN_BY_MERCHANT: 'No response is being made',
        OTHERS: 'Explain in the note',
    };

    const CHEVRON =
        '<svg class="menu-chevron" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const CHECK =
        '<svg class="cselect-check" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    /** Markup for one custom select. Its value lives on data-value. */
    function customSelect(id, items, value) {
        const chosen = items.find((i) => i.value === value) || items[0] || {};
        return `
            <div class="cselect menu-wrap" id="${escapeHtml(id)}" data-value="${escapeHtml(
            chosen.value || ''
        )}">
                <button type="button" class="cselect-trigger" aria-haspopup="listbox">
                    <span class="cselect-label">${escapeHtml(chosen.label || '—')}</span>
                    ${CHEVRON}
                </button>
                <div class="menu cselect-menu" role="listbox" hidden>
                    ${items
                        .map(
                            (i) => `
                        <button type="button" class="menu-option${
                            i.value === chosen.value ? ' is-selected' : ''
                        }" data-option="${escapeHtml(i.value)}" role="option">
                            <span class="cselect-option-label">${escapeHtml(i.label)}${CHECK}</span>
                            ${i.hint ? `<span>${escapeHtml(i.hint)}</span>` : ''}
                        </button>`
                        )
                        .join('')}
                </div>
            </div>`;
    }

    const selectValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.dataset.value : '';
    };

    /**
     * Fit an open menu into the room the dialog actually has.
     *
     * Modals scroll, so anything that hangs past their edge is clipped rather
     * than overflowing onto the page — in the small accept dialog that hid most
     * of the reasons. Open downward when it fits, upward when there is more
     * room above, and otherwise cap the height and let the menu scroll.
     */
    function placeMenu(wrap, menu) {
        const box = (wrap.closest('.modal') || document.body).getBoundingClientRect();
        const trigger = wrap.querySelector('.cselect-trigger').getBoundingClientRect();
        const gap = 14;
        const below = box.bottom - trigger.bottom - gap;
        const above = trigger.top - box.top - gap;

        menu.style.maxHeight = '';
        const natural = Math.min(menu.scrollHeight, 290);
        const up = natural > below && above > below;

        wrap.classList.toggle('drop-up', up);
        menu.style.maxHeight = `${Math.max(140, Math.min(290, up ? above : below))}px`;
    }

    function closeAllSelects(except) {
        document.querySelectorAll('.cselect.open').forEach((el) => {
            if (el === except) return;
            el.classList.remove('open');
            el.querySelector('.cselect-menu').hidden = true;
        });
    }

    // One listener for every custom select on the page, modals included.
    document.addEventListener('click', (e) => {
        const option = e.target.closest('.cselect [data-option]');
        if (option) {
            const wrap = option.closest('.cselect');
            wrap.dataset.value = option.dataset.option;
            wrap.querySelector('.cselect-label').textContent = option.querySelector(
                '.cselect-option-label'
            ).firstChild.textContent;
            wrap.querySelectorAll('.menu-option').forEach((o) =>
                o.classList.toggle('is-selected', o === option)
            );
            closeAllSelects();
            return;
        }
        const trigger = e.target.closest('.cselect-trigger');
        if (trigger) {
            const wrap = trigger.closest('.cselect');
            const opening = !wrap.classList.contains('open');
            closeAllSelects(wrap);
            wrap.classList.toggle('open', opening);
            const menu = wrap.querySelector('.cselect-menu');
            menu.hidden = !opening;
            if (opening) placeMenu(wrap, menu);
            return;
        }
        closeAllSelects();
    });

    // ============== Detail ==============
    async function openDetail(id) {
        detailBody.innerHTML = '<div class="data-empty"><p>Loading…</p></div>';
        openModal(detailModal);
        try {
            current = await api(`/api/disputes/${encodeURIComponent(id)}?refresh=true`);
            renderDetail(current);
        } catch (err) {
            detailBody.innerHTML = `<div class="data-empty"><p>${escapeHtml(err.message)}</p></div>`;
        }
    }

    function isOpen(d) {
        return (options ? options.open_statuses : ['REQUIRES_RESPONSE']).includes(d.status);
    }

    function acceptedFor(d) {
        if (!options) return [];
        return (
            options.accepted_file_types[String(d.card_brand || '').toLowerCase()] ||
            options.accepted_file_types.default
        );
    }

    function dueBadge(d) {
        if (!d.due_at || !isOpen(d)) return '';
        const days = Math.ceil((new Date(d.due_at) - Date.now()) / 864e5);
        const cls = days < 0 ? 'is-overdue' : days <= 3 ? 'is-soon' : '';
        const label =
            days < 0
                ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
                : days === 0
                  ? 'Due today'
                  : `${days} day${days === 1 ? '' : 's'} to respond`;
        return `<div class="due-badge ${cls}">${escapeHtml(label)}</div>`;
    }

    const fact = (label, value, extra = '') =>
        `<div class="fact"><dt>${escapeHtml(label)}</dt><dd${extra}>${value}</dd></div>`;

    /** What the operator has typed into the response form, kept across re-renders. */
    function captureForm() {
        if (!document.getElementById('challenge-reason')) return null;
        return {
            reason: selectValue('challenge-reason'),
            product: selectValue('challenge-product-type'),
            category: selectValue('evidence-category'),
            note: (document.getElementById('challenge-description') || {}).value || '',
        };
    }

    function renderDetail(d, keep = captureForm()) {
        const open = isOpen(d);
        const p = d.payment || {};
        const files = d.evidence_files || [];
        const history = [...(d.challenge_details || []), ...(d.accept_details || [])];
        const reasonText = title((d.reason && d.reason.type) || '');

        detailBody.innerHTML = `
            <header class="dispute-head">
                <div>
                    <div class="dispute-eyebrow">${escapeHtml(title(d.stage))} · ${escapeHtml(
            reasonText
        )}${d.reason && d.reason.original_code ? ` · code ${escapeHtml(d.reason.original_code)}` : ''}</div>
                    <h2 class="dispute-title">${escapeHtml(money(d.amount, d.currency))}
                        <span class="dispute-id">${escapeHtml(d.dispute_id)}</span>
                    </h2>
                    <div class="dispute-pills">${statusPill(d.status)}</div>
                </div>
                ${dueBadge(d)}
            </header>

            ${
                d.issuer_comment
                    ? `<div class="issuer-note"><strong>From the issuer</strong><p>${escapeHtml(
                          d.issuer_comment
                      )}</p></div>`
                    : ''
            }

            <dl class="facts">
                ${fact(
                    'Hotel',
                    `${escapeHtml(d.hotel_name || '—')}${
                        d.hotel_portfolio
                            ? `<span class="fact-sub">${escapeHtml(d.hotel_portfolio)}</span>`
                            : ''
                    }`
                )}
                ${fact('Reservation', escapeHtml(d.reservation_id || '—'))}
                ${fact(
                    'Charged',
                    `${escapeHtml(p.amount != null ? money(p.amount, p.currency) : '—')}${
                        p.status ? `<span class="fact-sub">${escapeHtml(title(p.status))}</span>` : ''
                    }`
                )}
                ${fact('Respond by', escapeHtml(formatDate(d.due_at)))}
                ${fact(
                    'Card',
                    `${escapeHtml(d.card_brand || '—')}${
                        p.card_last4 ? ` •••• ${escapeHtml(p.card_last4)}` : ''
                    }${p.card_issuer ? `<span class="fact-sub">${escapeHtml(p.card_issuer)}</span>` : ''}`
                )}
                ${fact('Order ID', escapeHtml(d.merchant_order_id || '—'))}
                ${fact('Descriptor', escapeHtml(p.descriptor || '—'), ' class="mono"')}
                ${fact(
                    'Payment',
                    d.payment_intent_id
                        ? `<a class="fact-link" href="/payments?q=${encodeURIComponent(
                              d.merchant_order_id || d.payment_intent_id
                          )}">${escapeHtml(d.payment_intent_id)} →</a>`
                        : '—',
                    ' class="mono"'
                )}
            </dl>

            <div class="dispute-panels${open ? '' : ' is-closed'}">
                <section class="panel">
                    <header class="panel-head">
                        <h3>Evidence</h3>
                        <span class="panel-count">${files.length} attached</span>
                    </header>

                    ${
                        files.length
                            ? `<ul class="evidence-list">${files
                                  .map(
                                      (f) => `
                                <li>
                                    <span class="evidence-icon">${fileIcon()}</span>
                                    <span class="evidence-main">
                                        <span class="evidence-name" title="${escapeHtml(
                                            f.filename
                                        )}">${escapeHtml(f.filename)}</span>
                                        <span class="evidence-meta">${escapeHtml(
                                            docTypeLabel(f.category)
                                        )} · ${Math.max(1, Math.round((f.size || 0) / 1024))} KB</span>
                                    </span>
                                    ${
                                        open
                                            ? `<button class="evidence-remove" type="button" data-remove-file="${escapeHtml(
                                                  f.file_id
                                              )}" aria-label="Remove ${escapeHtml(f.filename)}">×</button>`
                                            : ''
                                    }
                                </li>`
                                  )
                                  .join('')}</ul>`
                            : `<p class="panel-empty">${
                                  open
                                      ? 'Nothing attached yet. The issuer will not consider a response without a document.'
                                      : 'No documents were attached.'
                              }</p>`
                    }

                    ${
                        open
                            ? `<div class="field">
                                   <label>Document type</label>
                                   ${customSelect(
                                       'evidence-category',
                                       (options ? options.document_types : []).map((t) => ({
                                           value: t.key,
                                           label: t.label,
                                           hint: t.hint,
                                       })),
                                       (keep && keep.category) || 'PRIMARY'
                                   )}
                               </div>
                               <label class="dropzone evidence-drop" id="evidence-drop">
                                   <input type="file" id="evidence-file" hidden accept="${acceptedFor(d)
                                       .map((e) => '.' + e)
                                       .join(',')}">
                                   <svg viewBox="0 0 24 24" fill="none" class="dropzone-icon">
                                       <path d="M12 16V4M7.5 8.5L12 4l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                                       <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                                   </svg>
                                   <p class="dropzone-text" id="evidence-drop-text">Drop a file here or click to choose</p>
                                   <p class="dropzone-hint">${escapeHtml(
                                       `${acceptedFor(d).join(', ')} · up to 20MB · ${
                                           d.card_brand || 'card network'
                                       } rules`
                                   )}</p>
                               </label>`
                            : ''
                    }
                </section>

                ${
                    open
                        ? `<section class="panel">
                               <header class="panel-head">
                                   <h3>Respond</h3>
                                   <span class="panel-count">${
                                       files.length
                                           ? `${files.length} document${files.length === 1 ? '' : 's'} will be sent`
                                           : 'attach evidence first'
                                   }</span>
                               </header>

                               <div class="field">
                                   <label>Why you are challenging</label>
                                   ${customSelect(
                                       'challenge-reason',
                                       (options ? options.challenge_reasons : []).map((r) => ({
                                           value: r,
                                           label: title(r),
                                           hint: CHALLENGE_HINTS[r],
                                       })),
                                       (keep && keep.reason) || 'PRODUCT_RECEIVED'
                                   )}
                               </div>

                               <div class="field">
                                   <label>What was sold</label>
                                   ${customSelect(
                                       'challenge-product-type',
                                       (options ? options.product_types : []).map((r) => ({
                                           value: r,
                                           label: title(r),
                                           hint: PRODUCT_HINTS[r],
                                       })),
                                       (keep && keep.product) || 'RESERVE_OR_BOOKING'
                                   )}
                               </div>

                               <div class="field">
                                   <label>Explanation <span class="field-hint">sent to the issuer</span></label>
                                   <textarea id="challenge-description" rows="4" placeholder="e.g. The guest checked in on 19 June and stayed one night; the folio is attached.">${escapeHtml(
                                       (keep && keep.note) || ''
                                   )}</textarea>
                               </div>

                               <p class="form-error" id="detail-error" role="alert" hidden></p>

                               <div class="panel-actions">
                                   <button class="btn btn-ghost btn-danger-ghost" type="button" id="accept-open">Accept instead</button>
                                   <button class="btn btn-primary" type="button" id="challenge-btn"${
                                       files.length ? '' : ' disabled'
                                   }>
                                       <span class="btn-spinner" aria-hidden="true"></span>
                                       <span class="btn-label">Submit challenge</span>
                                   </button>
                               </div>
                           </section>`
                        : `<section class="panel">
                               <header class="panel-head"><h3>Outcome</h3></header>
                               <p class="panel-empty">This case is ${escapeHtml(
                                   title(d.status).toLowerCase()
                               )} — there is nothing left to respond to.</p>
                           </section>`
                }
            </div>

            ${
                history.length
                    ? `<section class="panel panel-history">
                           <header class="panel-head"><h3>History</h3></header>
                           <ul class="history-list">
                               ${history
                                   .map(
                                       (h) =>
                                           `<li>
                                               <span class="history-stage">${escapeHtml(
                                                   title(h.stage || '')
                                               )}</span>
                                               <span class="history-what">${escapeHtml(
                                                   title(h.reason || '') || 'Responded'
                                               )}${h.description ? ` — ${escapeHtml(h.description)}` : ''}</span>
                                               <span class="entity-meta">${escapeHtml(
                                                   formatDate(h.accepted_at || h.challenged_at)
                                               )}</span>
                                           </li>`
                                   )
                                   .join('')}
                           </ul>
                       </section>`
                    : ''
            }`;

        bindDropzone(d);
    }

    function docTypeLabel(key) {
        const t = (options ? options.document_types : []).find((x) => x.key === key);
        return t ? t.label : title(key || 'PRIMARY');
    }

    function fileIcon() {
        return '<svg viewBox="0 0 24 24" fill="none"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    }

    /**
     * Choosing or dropping a file uploads it straight away under the selected
     * type — one step rather than choose-then-press-upload.
     */
    function bindDropzone(d) {
        const drop = document.getElementById('evidence-drop');
        const input = document.getElementById('evidence-file');
        if (!drop || !input) return;

        input.addEventListener('change', () => {
            if (input.files && input.files[0]) uploadEvidence(input.files[0]);
        });
        ['dragenter', 'dragover'].forEach((ev) =>
            drop.addEventListener(ev, (e) => {
                e.preventDefault();
                drop.classList.add('is-dragging');
            })
        );
        ['dragleave', 'drop'].forEach((ev) =>
            drop.addEventListener(ev, (e) => {
                e.preventDefault();
                drop.classList.remove('is-dragging');
            })
        );
        drop.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) uploadEvidence(file);
        });
    }

    async function uploadEvidence(file) {
        const drop = document.getElementById('evidence-drop');
        const text = document.getElementById('evidence-drop-text');
        const ext = file.name.split('.').pop().toLowerCase();
        const accepted = acceptedFor(current);

        // Caught here as well as on the server, so a wrong format is a
        // red dropzone rather than a round trip.
        if (accepted.length && !accepted.includes(ext)) {
            drop.classList.add('is-error');
            text.textContent = `.${ext} is not accepted — use ${accepted.join(', ')}`;
            return;
        }

        drop.classList.remove('is-error');
        drop.classList.add('has-file');
        text.textContent = `Uploading ${file.name}…`;

        try {
            const buf = await file.arrayBuffer();
            const res = await fetch(
                `/api/disputes/${encodeURIComponent(current.dispute_id)}/evidence?filename=${encodeURIComponent(
                    file.name
                )}&category=${encodeURIComponent(selectValue('evidence-category') || 'PRIMARY')}`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': file.type || 'application/octet-stream',
                    },
                    body: buf,
                }
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Upload failed');

            const keep = captureForm();
            current = await api(`/api/disputes/${encodeURIComponent(current.dispute_id)}`);
            renderDetail(current, keep);
            showToast(`${data.filename} attached.`);
        } catch (err) {
            drop.classList.remove('has-file');
            drop.classList.add('is-error');
            text.textContent = err.message;
        }
    }

    // ============== Actions ==============
    tbody.addEventListener('click', (e) => {
        const view = e.target.closest('[data-view]');
        if (view) {
            openDetail(view.dataset.view);
            return;
        }
        const row = e.target.closest('tr[data-id]');
        if (row) openDetail(row.dataset.id);
    });

    detailBody.addEventListener('click', async (e) => {
        const remove = e.target.closest('[data-remove-file]');
        if (remove) {
            try {
                const keep = captureForm();
                await api(
                    `/api/disputes/${encodeURIComponent(current.dispute_id)}/evidence/${encodeURIComponent(
                        remove.dataset.removeFile
                    )}`,
                    { method: 'DELETE' }
                );
                current = await api(`/api/disputes/${encodeURIComponent(current.dispute_id)}`);
                renderDetail(current, keep);
                showToast('Removed.');
            } catch (err) {
                showToast(err.message, 'error');
            }
            return;
        }

        if (e.target.closest('#challenge-btn')) {
            const btn = e.target.closest('#challenge-btn');
            const err = document.getElementById('detail-error');
            err.hidden = true;
            const note = document.getElementById('challenge-description').value;
            setLoading(btn, true, 'Submitting…');
            try {
                const updated = await api(
                    `/api/disputes/${encodeURIComponent(current.dispute_id)}/challenge`,
                    {
                        method: 'POST',
                        body: JSON.stringify({
                            reason: selectValue('challenge-reason'),
                            product_type: selectValue('challenge-product-type'),
                            description: note,
                            product_description: note,
                        }),
                    }
                );
                current = updated;
                renderDetail(updated, null);
                showToast('Challenge submitted.');
                load();
                loadStats();
            } catch (e2) {
                err.textContent = e2.message;
                err.hidden = false;
                setLoading(btn, false);
            }
            return;
        }

        if (e.target.closest('#accept-open')) {
            document.getElementById('accept-reason-wrap').innerHTML = customSelect(
                'accept-reason',
                (options ? options.accept_reasons : []).map((r) => ({
                    value: r,
                    label: title(r),
                    hint: ACCEPT_HINTS[r],
                })),
                'LOW_VALUE_TRANSACTION'
            );
            document.getElementById('accept-sub').textContent = `${money(
                current.amount,
                current.currency
            )} on ${current.reservation_id || current.merchant_order_id} goes back to the cardholder.`;
            document.getElementById('accept-ack').checked = false;
            document.getElementById('accept-error').hidden = true;
            openModal(acceptModal);
        }
    });

    document.getElementById('accept-confirm').addEventListener('click', async () => {
        const btn = document.getElementById('accept-confirm');
        const err = document.getElementById('accept-error');
        err.hidden = true;
        if (!document.getElementById('accept-ack').checked) {
            err.textContent = 'Tick the box to confirm you want to concede this dispute.';
            err.hidden = false;
            return;
        }
        setLoading(btn, true, 'Accepting…');
        try {
            const updated = await api(
                `/api/disputes/${encodeURIComponent(current.dispute_id)}/accept`,
                {
                    method: 'POST',
                    body: JSON.stringify({
                        acknowledge: true,
                        reason: selectValue('accept-reason'),
                        description: document.getElementById('accept-note').value,
                    }),
                }
            );
            closeModal(acceptModal);
            current = updated;
            renderDetail(updated);
            showToast('Dispute accepted and closed.');
            load();
            loadStats();
        } catch (e2) {
            err.textContent = e2.message;
            err.hidden = false;
        } finally {
            setLoading(btn, false);
        }
    });

    syncBtn.addEventListener('click', async () => {
        setLoading(syncBtn, true, 'Syncing…');
        try {
            const r = await api('/api/disputes/sync', { method: 'POST' });
            showToast(
                `${r.synced} dispute${r.synced === 1 ? '' : 's'} synced${
                    r.created ? `, ${r.created} new` : ''
                }.`
            );
            await Promise.all([load(), loadStats()]);
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            setLoading(syncBtn, false);
        }
    });

    simulateBtn.addEventListener('click', async () => {
        const intent = prompt('Payment intent ID to raise a test dispute against:');
        if (!intent) return;
        try {
            const d = await api('/api/disputes/simulate', {
                method: 'POST',
                body: JSON.stringify({ payment_intent_id: intent.trim() }),
            });
            showToast(`Test dispute ${d.dispute_id} created.`);
            await Promise.all([load(), loadStats()]);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    document.getElementById('status-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-filter]');
        if (!tab) return;
        document
            .querySelectorAll('#status-tabs .status-tab')
            .forEach((t) => t.classList.toggle('active', t === tab));
        filter = tab.dataset.filter;
        load();
    });

    let searchTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            search = searchInput.value.trim();
            load();
        }, 250);
    });

    (async () => {
        try {
            options = await api('/api/disputes/options');
            // Raising a test dispute only exists in sandbox.
            if (options.environment && options.environment.mode === 'sandbox') {
                simulateBtn.hidden = false;
            }
        } catch (e) {
            /* the page still lists what it has */
        }
        await Promise.all([load(), loadStats()]);
    })();
})();
