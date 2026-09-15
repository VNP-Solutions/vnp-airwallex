(() => {
    // ============== Constants ==============
    const PAGE_SIZE = 25;
    const CHECKOUT_HANDOFF_KEY = 'awx_checkout_handoff';

    // Airwallex statuses are uppercase; map them onto the shared pill variants.
    const STATUS_STYLE = {
        SUCCEEDED: 'success',
        REQUIRES_PAYMENT_METHOD: 'pending',
        REQUIRES_CUSTOMER_ACTION: 'pending',
        REQUIRES_CAPTURE: 'info',
        PENDING: 'pending',
        CANCELLED: 'danger',
        EXPIRED: 'danger',
        FAILED: 'danger',
    };

    const CANCELLABLE = ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION', 'PENDING'];

    // Mirrors PAYABLE_STATUSES on the server. PENDING is excluded on purpose:
    // that payment is already in flight and re-opening checkout invites a
    // double charge.
    const PAYABLE = ['REQUIRES_PAYMENT_METHOD', 'REQUIRES_CUSTOMER_ACTION'];

    // Columns drive both the header and the filter popover. `filter.kind`
    // picks the popover UI; `filter.field` points a display column at the
    // backing document field when they differ.
    const COLUMNS = [
        { key: 'order', label: 'Order', className: 'col-primary', filter: { kind: 'text', field: 'merchant_order_id' } },
        { key: 'hotel_name', label: 'Hotel', filter: { kind: 'text' } },
        { key: 'hotel_portfolio', label: 'Portfolio', filter: { kind: 'enum' } },
        { key: 'reference', label: 'Reference', filter: { kind: 'text' } },
        { key: 'description', label: 'Description', filter: { kind: 'text' } },
        { key: 'amount', label: 'Amount', filter: { kind: 'number' } },
        { key: 'currency', label: 'Currency', filter: { kind: 'enum' } },
        { key: 'status', label: 'Status', filter: { kind: 'enum' } },
        { key: 'descriptor', label: 'Descriptor', filter: { kind: 'text' } },
        { key: 'created_at', label: 'Created', filter: { kind: 'date' } },
        { key: 'actions', label: '', className: 'col-actions' },
    ];

    // ============== DOM ==============
    const tbody = document.getElementById('payments-tbody');
    const theadRow = document.getElementById('payments-thead-row');
    const popoverEl = document.getElementById('filter-popover');
    const activeFiltersEl = document.getElementById('active-filters');
    const filteredTotalsEl = document.getElementById('filtered-totals');
    const paginationEl = document.getElementById('payments-pagination');
    const statusTabs = document.getElementById('status-tabs');
    const searchEl = document.getElementById('search');
    const searchInput = document.getElementById('search-input');
    const toastEl = document.getElementById('toast');
    const refreshBtn = document.getElementById('refresh-btn');

    const newBtn = document.getElementById('new-payment-btn');
    const newModal = document.getElementById('new-modal');
    const newForm = document.getElementById('new-form');
    const newSubmit = document.getElementById('new-submit');
    const newError = document.getElementById('new-error');
    const detailModal = document.getElementById('detail-modal');
    const detailBody = document.getElementById('detail-body');

    const referenceInput = document.getElementById('reference-input');
    const descriptorInput = document.getElementById('descriptor-input');
    const descriptorValue = document.getElementById('descriptor-value');
    const descriptorCount = document.getElementById('descriptor-count');

    const hotelSearch = document.getElementById('hotel-search');
    const hotelResults = document.getElementById('hotel-results');
    const hotelSelected = document.getElementById('hotel-selected');
    const hotelSelectedName = document.getElementById('hotel-selected-name');
    const hotelSelectedMeta = document.getElementById('hotel-selected-meta');
    const hotelClear = document.getElementById('hotel-clear');
    const referenceHint = document.getElementById('reference-autofill-hint');

    const bulkModal = document.getElementById('bulk-modal');
    const bulkResult = document.getElementById('bulk-result');
    const bulkValidateBtn = document.getElementById('bulk-validate');
    const bulkSubmitBtn = document.getElementById('bulk-submit');
    const bulkTemplateLink = document.getElementById('bulk-template-link');
    const autoCreateCheck = document.getElementById('autocreate-check');
    const jobProgress = document.getElementById('job-progress');
    const jobBarFill = document.getElementById('job-bar-fill');
    const jobLabel = document.getElementById('job-label');
    const jobCounts = document.getElementById('job-counts');

    // ============== State ==============
    let currentPage = 1;
    let totalPayments = 0;
    let searchQuery = '';
    let loadSeq = 0;
    let selectedHotel = null;
    // The last value we auto-filled into the reference. Used to tell "untouched"
    // from "the operator typed this", so we never clobber their own input.
    let autoFilledReference = '';
    let jobPollTimer = null;

    // ============== Auth ==============
    function getToken() {
        return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    }
    function authHeaders() {
        return { Authorization: `Bearer ${getToken()}` };
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
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    // ============== Global filters ==============
    // Filters and sort are sent to /api/payments/query and applied in Mongo, so
    // they span the whole history rather than just the rows on this page.
    const filters = TableFilters.init({
        theadRow,
        popoverEl,
        columns: COLUMNS,
        fetchDistinct: async (field, search) => {
            const params = new URLSearchParams({ limit: '200' });
            if (search) params.set('search', search);
            return api(`/api/payments/distinct/${field}?${params.toString()}`);
        },
        onChange: () => {
            currentPage = 1;
            tbody.innerHTML = '';
            syncStatusTabsToFilter();
            loadPayments();
        },
    });

    // ============== Helpers ==============
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(
            /[&<>"']/g,
            (c) =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    function formatAmount(amount, currency) {
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency,
                currencyDisplay: 'code',
            })
                .format(amount)
                .replace(currency, '')
                .trim();
        } catch (e) {
            return Number(amount).toFixed(2);
        }
    }

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        return d.toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function statusLabel(status) {
        return String(status || '')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase());
    }

    function statusPill(status) {
        const variant = STATUS_STYLE[status] || 'neutral';
        return `<span class="pill ${variant}">${escapeHtml(statusLabel(status))}</span>`;
    }

    let toastTimer;
    function showToast(message, variant = 'success') {
        if (!toastEl) return;
        clearTimeout(toastTimer);
        toastEl.textContent = message;
        toastEl.className = `toast ${variant === 'error' ? 'error' : 'success'}`;
        toastEl.hidden = false;
        toastEl.offsetHeight;
        toastEl.classList.add('visible');
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            setTimeout(() => {
                toastEl.hidden = true;
            }, 300);
        }, 4000);
    }

    function setLoading(button, isLoading, loadingLabel) {
        const label = button.querySelector('.btn-label');
        if (isLoading) {
            button.dataset.originalLabel = label.textContent;
            if (loadingLabel) label.textContent = loadingLabel;
            button.classList.add('loading');
            button.disabled = true;
        } else {
            if (button.dataset.originalLabel) {
                label.textContent = button.dataset.originalLabel;
            }
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    // ============== Descriptor preview ==============
    // Mirrors buildDescriptor() on the server: the descriptor is the selected
    // hotel's, used verbatim. The reference is a separate field and is
    // deliberately not mixed in — that used to eat the 32-character budget and
    // truncate the hotel name.
    const DESCRIPTOR_MAX = 32;
    const DESCRIPTOR_PREFIX = 'VNP';

    function buildDescriptor() {
        const base = selectedHotel ? selectedHotel.descriptor : DESCRIPTOR_PREFIX;
        return base.slice(0, DESCRIPTOR_MAX);
    }

    function refreshDescriptorPreview() {
        const override = descriptorInput.value.trim();
        const value = override || buildDescriptor();

        descriptorValue.textContent = value || '—';
        descriptorCount.textContent = `${value.length}/${DESCRIPTOR_MAX}`;
        descriptorCount.classList.toggle('over', value.length > DESCRIPTOR_MAX);
    }

    referenceInput.addEventListener('input', () => {
        if (referenceInput.value.trim() !== autoFilledReference) {
            autoFilledReference = '';
            referenceHint.hidden = true;
        }
        refreshDescriptorPreview();
    });
    descriptorInput.addEventListener('input', refreshDescriptorPreview);

    // ============== Hotel picker ==============
    function renderHotelResults(items) {
        if (!items.length) {
            hotelResults.innerHTML = '<div class="hotel-empty">No matching hotels</div>';
            hotelResults.hidden = false;
            return;
        }
        hotelResults.innerHTML = items
            .map(
                (h) => `
                <button type="button" class="hotel-option" data-id="${escapeHtml(h._id)}"
                        data-name="${escapeHtml(h.name)}"
                        data-expedia="${escapeHtml(h.expedia_id)}"
                        data-portfolio="${escapeHtml(h.portfolio)}"
                        data-website="${escapeHtml(h.website || '')}"
                        data-descriptor="${escapeHtml(h.descriptor)}">
                    <span class="hotel-option-name">${escapeHtml(h.name)}</span>
                    <span class="hotel-option-meta">${escapeHtml(h.portfolio)} · ${escapeHtml(
                        h.expedia_id
                    )}</span>
                    <code class="hotel-option-descriptor">${escapeHtml(h.descriptor)}</code>
                </button>`
            )
            .join('');
        hotelResults.hidden = false;
    }

    let hotelSearchTimer;
    async function searchHotels(query) {
        try {
            const params = new URLSearchParams({ limit: '8' });
            if (query) params.set('q', query);
            const data = await api(`/api/hotels/search?${params}`);
            renderHotelResults(data.items || []);
        } catch (err) {
            console.error(err);
        }
    }

    hotelSearch.addEventListener('input', () => {
        clearTimeout(hotelSearchTimer);
        hotelSearchTimer = setTimeout(() => searchHotels(hotelSearch.value.trim()), 200);
    });

    hotelSearch.addEventListener('focus', () => searchHotels(hotelSearch.value.trim()));

    hotelResults.addEventListener('click', (event) => {
        const option = event.target.closest('.hotel-option');
        if (!option) return;
        selectedHotel = {
            _id: option.dataset.id,
            name: option.dataset.name,
            expedia_id: option.dataset.expedia,
            portfolio: option.dataset.portfolio,
            website: option.dataset.website,
            descriptor: option.dataset.descriptor,
        };
        hotelSelectedName.textContent = selectedHotel.name;
        hotelSelectedMeta.textContent = `${selectedHotel.portfolio} · ${selectedHotel.expedia_id}`;
        hotelSelected.hidden = false;
        hotelSearch.hidden = true;
        hotelResults.hidden = true;
        hotelSearch.value = '';
        applyHotelWebsiteToReference();
        refreshDescriptorPreview();
    });

    hotelClear.addEventListener('click', () => {
        selectedHotel = null;
        hotelSelected.hidden = true;
        hotelSearch.hidden = false;
        hotelResults.hidden = true;
        clearAutoFilledReference();
        refreshDescriptorPreview();
    });

    /**
     * Put the hotel's website into the reference so it reaches the cardholder's
     * statement — a recognisable domain is what stops a charge being disputed.
     *
     * Only fills when the field is empty or still holds the value we put there,
     * so a reference the operator typed is never overwritten.
     */
    function applyHotelWebsiteToReference() {
        const website = (selectedHotel && selectedHotel.website) || '';
        if (!website) {
            clearAutoFilledReference();
            return;
        }

        const current = referenceInput.value.trim();
        if (current && current !== autoFilledReference) {
            referenceHint.hidden = true;
            return;
        }

        referenceInput.value = website;
        autoFilledReference = website;
        referenceHint.hidden = false;
    }

    function clearAutoFilledReference() {
        if (autoFilledReference && referenceInput.value.trim() === autoFilledReference) {
            referenceInput.value = '';
        }
        autoFilledReference = '';
        referenceHint.hidden = true;
    }

    document.addEventListener('click', (event) => {
        if (!event.target.closest('#hotel-picker')) hotelResults.hidden = true;
    });

    function resetHotelPicker() {
        selectedHotel = null;
        autoFilledReference = '';
        if (referenceHint) referenceHint.hidden = true;
        hotelSelected.hidden = true;
        hotelSearch.hidden = false;
        hotelSearch.value = '';
        hotelResults.hidden = true;
    }

    // ============== Modals ==============
    function openModal(modal) {
        modal.hidden = false;
        modal.offsetHeight;
        modal.classList.add('visible');
    }

    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(() => {
            modal.hidden = true;
        }, 200);
    }

    document.addEventListener('click', (event) => {
        const closer = event.target.closest('[data-close]');
        if (closer) {
            const target =
                { new: newModal, bulk: bulkModal, detail: detailModal }[closer.dataset.close] ||
                detailModal;
            closeModal(target);
            return;
        }
        if (event.target === newModal) closeModal(newModal);
        if (event.target === bulkModal) closeModal(bulkModal);
        if (event.target === detailModal) closeModal(detailModal);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!newModal.hidden) closeModal(newModal);
        if (!bulkModal.hidden) closeModal(bulkModal);
        if (!detailModal.hidden) closeModal(detailModal);
    });

    newBtn.addEventListener('click', () => {
        newForm.reset();
        newError.hidden = true;
        descriptorInput.value = '';
        resetHotelPicker();
        refreshDescriptorPreview();
        openModal(newModal);
    });

    // ============== Create payment ==============
    newForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        newError.hidden = true;

        const formData = new FormData(newForm);
        const amount = Number(formData.get('amount'));
        if (!Number.isFinite(amount) || amount <= 0) {
            newError.textContent = 'Enter an amount greater than zero.';
            newError.hidden = false;
            return;
        }

        const payload = {
            amount,
            currency: formData.get('currency'),
            reference: (formData.get('reference') || '').trim() || undefined,
            description: (formData.get('description') || '').trim() || undefined,
            descriptor: (formData.get('descriptor') || '').trim() || undefined,
            hotel_id: selectedHotel ? selectedHotel._id : undefined,
            customer: {
                name: (formData.get('customer_name') || '').trim() || undefined,
                email: (formData.get('customer_email') || '').trim() || undefined,
            },
        };

        setLoading(newSubmit, true, 'Creating…');
        try {
            const { payment, checkout } = await api('/api/payments', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            // client_secret is short-lived and must not sit in a URL or in our
            // database — hand it to the checkout page in sessionStorage.
            sessionStorage.setItem(
                CHECKOUT_HANDOFF_KEY,
                JSON.stringify({
                    ...checkout,
                    merchant_order_id: payment.merchant_order_id,
                    descriptor: payment.descriptor,
                    description: payment.description,
                })
            );
            window.location.href = '/checkout';
        } catch (err) {
            newError.textContent = err.message;
            newError.hidden = false;
            setLoading(newSubmit, false);
            // The intent exists even if checkout failed to open — show it.
            loadPayments();
            loadStats();
        }
    });

    // ============== Bulk create ==============
    const bulkDropzone = BulkUpload.attachDropzone({
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('bulk-file'),
        textEl: document.getElementById('dropzone-text'),
        hintEl: document.getElementById('dropzone-hint'),
        onChange: (file) => {
            bulkValidateBtn.disabled = !file;
            bulkSubmitBtn.disabled = !file;
            bulkResult.hidden = true;
        },
    });

    document.getElementById('bulk-create-btn').addEventListener('click', () => {
        stopJobPolling();
        bulkResult.hidden = true;
        jobProgress.hidden = true;
        bulkDropzone.reset(
            'Drop a CSV or Excel file here',
            '.csv or .xlsx, up to 500 payments'
        );
        openModal(bulkModal);
    });

    bulkTemplateLink.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
            await BulkUpload.download('/api/payments/bulk/template');
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    /**
     * Card columns in a booking export are read by nobody — storing a CVV is
     * prohibited outright and PANs would drag us into a compliance scope we are
     * nowhere near. Say so explicitly so it is never assumed they were charged.
     */
    function ignoredColumnsHtml(data) {
        const ignored = data.ignored_columns || [];
        if (!ignored.length) return '';
        return `<div class="bulk-note">Ignored and never stored: <strong>${ignored
            .map(escapeHtml)
            .join(', ')}</strong>. Card details only ever reach Airwallex from the shopper's browser.</div>`;
    }

    /**
     * POST the uploaded file and return {ok, status, data} — 422 is a result,
     * not a throw. The File goes up as-is so an .xlsx keeps its bytes intact.
     */
    async function postFile(url, file) {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': BulkUpload.contentTypeFor(file),
                ...authHeaders(),
            },
            body: file,
        });
        if (res.status === 401) {
            window.location.replace('/login');
            throw new Error('Unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 422) throw new Error(data.error || 'Request failed');
        return { ok: res.ok, status: res.status, data };
    }

    /** Dry run — show every problem, and the totals, before creating anything. */
    bulkValidateBtn.addEventListener('click', async () => {
        const file = bulkDropzone.file;
        if (!file) return;

        setLoading(bulkValidateBtn, true, 'Checking…');
        bulkResult.hidden = true;
        try {
            const { data } = await postFile(
                `/api/payments/bulk/validate?auto_create_hotels=${autoCreateCheck.checked}`,
                file
            );

            if (!data.valid) {
                bulkResult.innerHTML = '';
                BulkUpload.renderResult(bulkResult, data);
                bulkResult.insertAdjacentHTML('beforeend', ignoredColumnsHtml(data));
                bulkSubmitBtn.disabled = true;
                return;
            }

            const totals = (data.totals || [])
                .map((t) => `${formatAmount(t.amount, t.currency)} ${t.currency}`)
                .join(' · ');
            const newHotels = data.hotels_to_create || [];
            const dupes = data.duplicates || [];
            bulkResult.className = 'bulk-result is-success';
            bulkResult.innerHTML = `
                <div class="bulk-result-head">
                    <strong>${data.ready} payment${data.ready === 1 ? '' : 's'} ready</strong>
                    <span>${escapeHtml(totals)} — nothing has been created yet.</span>
                </div>
                ${ignoredColumnsHtml(data)}
                ${
                    dupes.length
                        ? `<div class="bulk-subhead">${dupes.length} row${
                              dupes.length === 1 ? '' : 's'
                          } already created — they will be skipped</div>
                           <ul class="bulk-preview-list">
                             ${dupes
                                 .slice(0, 10)
                                 .map(
                                     (d) => `<li>
                                        <span class="bulk-line">Line ${d.line}</span>
                                        <span class="bulk-preview-hotel">${escapeHtml(
                                            d.reservation_id
                                        )}</span>
                                        <span class="bulk-preview-amount">${escapeHtml(
                                            statusLabel(d.status)
                                        )}</span>
                                     </li>`
                                 )
                                 .join('')}
                           </ul>
                           ${
                               dupes.length > 10
                                   ? `<p class="bulk-more">…and ${dupes.length - 10} more</p>`
                                   : ''
                           }`
                        : ''
                }
                ${
                    newHotels.length
                        ? `<div class="bulk-subhead">${newHotels.length} new hotel${
                              newHotels.length === 1 ? '' : 's'
                          } will be created</div>
                           <ul class="bulk-preview-list">
                             ${newHotels
                                 .map(
                                     (h) => `<li>
                                        <span class="bulk-line">${escapeHtml(h.expedia_id)}</span>
                                        <span class="bulk-preview-hotel">${escapeHtml(h.name)}</span>
                                        <code class="descriptor-cell">${escapeHtml(h.descriptor)}</code>
                                     </li>`
                                 )
                                 .join('')}
                           </ul>`
                        : ''
                }
                <ul class="bulk-preview-list">
                    ${data.preview
                        .map(
                            (r) => `<li>
                                <span class="bulk-line">Line ${r.line}</span>
                                <span class="bulk-preview-hotel">${escapeHtml(r.hotel_name)}</span>
                                <code class="descriptor-cell">${escapeHtml(r.descriptor)}</code>
                                <span class="bulk-preview-amount">${escapeHtml(
                                    formatAmount(r.amount, r.currency)
                                )} ${escapeHtml(r.currency)}</span>
                            </li>`
                        )
                        .join('')}
                </ul>
                ${
                    data.ready > data.preview.length
                        ? `<p class="bulk-more">…and ${data.ready - data.preview.length} more</p>`
                        : ''
                }`;
            bulkResult.hidden = false;
            // Nothing to do when every row was created by an earlier run.
            bulkSubmitBtn.disabled = data.ready === 0;
        } catch (err) {
            BulkUpload.renderResult(bulkResult, { errors: [{ line: '—', error: err.message }] });
        } finally {
            setLoading(bulkValidateBtn, false);
        }
    });

    bulkSubmitBtn.addEventListener('click', async () => {
        const file = bulkDropzone.file;
        if (!file) return;

        setLoading(bulkSubmitBtn, true, 'Starting…');
        bulkResult.hidden = true;
        try {
            const { status, data } = await postFile(
                `/api/payments/bulk/create?auto_create_hotels=${autoCreateCheck.checked}`,
                file
            );

            if (status === 422) {
                BulkUpload.renderResult(bulkResult, { errors: data.errors || [] });
                return;
            }

            // Creation runs in the background; follow the job instead of waiting.
            jobProgress.hidden = false;
            pollJob(data._id);
        } catch (err) {
            BulkUpload.renderResult(bulkResult, { errors: [{ line: '—', error: err.message }] });
        } finally {
            setLoading(bulkSubmitBtn, false);
        }
    });

    function stopJobPolling() {
        if (jobPollTimer) {
            clearTimeout(jobPollTimer);
            jobPollTimer = null;
        }
    }

    async function pollJob(jobId) {
        stopJobPolling();
        bulkSubmitBtn.disabled = true;

        async function tick() {
            try {
                const job = await api(`/api/payments/bulk/jobs/${jobId}`);
                const pct = job.total ? Math.round((job.processed / job.total) * 100) : 0;
                jobBarFill.style.width = `${pct}%`;
                jobCounts.innerHTML = `<span class="job-ok">${job.succeeded} created</span>${
                    job.failed ? ` · <span class="job-fail">${job.failed} failed</span>` : ''
                } · ${job.processed}/${job.total}`;

                if (job.status === 'completed' || job.status === 'failed') {
                    jobLabel.textContent =
                        job.status === 'failed' ? 'Job failed' : 'Done';
                    stopJobPolling();
                    bulkSubmitBtn.disabled = false;

                    const failures = (job.results || []).filter((r) => !r.ok);
                    if (failures.length) {
                        BulkUpload.renderResult(bulkResult, {
                            errors: failures.map((f) => ({ line: f.line, error: f.error })),
                        });
                    } else if (job.status === 'failed') {
                        BulkUpload.renderResult(bulkResult, {
                            errors: [{ line: '—', error: job.error || 'Job failed' }],
                        });
                    } else {
                        BulkUpload.renderResult(bulkResult, job, {
                            successLabel: `${job.succeeded} payment${
                                job.succeeded === 1 ? '' : 's'
                            } created`,
                        });
                        if (job.hotels_created) {
                            bulkResult.insertAdjacentHTML(
                                'beforeend',
                                `<div class="bulk-subhead">${job.hotels_created} new hotel${
                                    job.hotels_created === 1 ? '' : 's'
                                } created from the file</div>`
                            );
                        }
                        showToast(
                            `${job.succeeded} payments created` +
                                (job.hotels_created
                                    ? ` · ${job.hotels_created} new hotels`
                                    : '') +
                                '.'
                        );
                    }

                    loadPayments();
                    loadStats();
                    return;
                }

                jobLabel.textContent = 'Creating payments…';
                jobPollTimer = setTimeout(tick, 1200);
            } catch (err) {
                stopJobPolling();
                bulkSubmitBtn.disabled = false;
                showToast(err.message, 'error');
            }
        }

        tick();
    }

    // ============== List ==============
    function skeletonRows(count = 5) {
        return Array.from({ length: count })
            .map(
                () => `
                <tr class="skeleton-row">
                    <td><div class="skel-pill" style="width:70%"></div></td>
                    <td><div class="skel-pill" style="width:65%"></div></td>
                    <td><div class="skel-pill" style="width:50%"></div></td>
                    <td><div class="skel-pill" style="width:60%"></div></td>
                    <td><div class="skel-pill" style="width:70%"></div></td>
                    <td><div class="skel-pill" style="width:45%"></div></td>
                    <td><div class="skel-pill" style="width:35%"></div></td>
                    <td><div class="skel-pill" style="width:55%"></div></td>
                    <td><div class="skel-pill" style="width:65%"></div></td>
                    <td><div class="skel-pill" style="width:55%"></div></td>
                    <td><div class="skel-pill" style="width:40%"></div></td>
                </tr>`
            )
            .join('');
    }

    function emptyState() {
        const filtered = searchQuery || filters.hasAny();
        return `
            <tr>
                <td colspan="11">
                    <div class="data-empty">
                        <div class="empty-icon">
                            <svg viewBox="0 0 24 24" fill="none">
                                <rect x="2" y="5" width="20" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6"/>
                                <path d="M2 10h20" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                        </div>
                        <p>${filtered ? 'No payments match these filters.' : 'No payments yet.'}</p>
                        <span>${
                            filtered
                                ? 'Try a different search, or clear the filters above.'
                                : 'Create one with the “New payment” button.'
                        }</span>
                    </div>
                </td>
            </tr>`;
    }

    function renderRows(items) {
        tbody.innerHTML = items
            .map(
                (p) => `
                <tr data-id="${escapeHtml(p.payment_intent_id)}">
                    <td>
                        <div class="entity-stack">
                            <div class="entity-name">${escapeHtml(p.merchant_order_id)}</div>
                            <div class="order-id">${escapeHtml(p.payment_intent_id)}</div>
                        </div>
                    </td>
                    <td>
                        <div class="entity-stack">
                            <div class="entity-name">${escapeHtml(p.hotel_name || '—')}</div>
                            ${
                                p.hotel_expedia_id
                                    ? `<div class="order-id">${escapeHtml(p.hotel_expedia_id)}</div>`
                                    : ''
                            }
                        </div>
                    </td>
                    <td>${
                        p.hotel_portfolio
                            ? `<span class="portfolio-tag">${escapeHtml(p.hotel_portfolio)}</span>`
                            : '<span class="entity-meta">—</span>'
                    }</td>
                    <td><div class="entity-name">${escapeHtml(p.reference || '—')}</div></td>
                    <td>${
                        p.description
                            ? `<span class="description-cell" title="${escapeHtml(
                                  p.description
                              )}">${escapeHtml(p.description)}</span>`
                            : '<span class="entity-meta">—</span>'
                    }</td>
                    <td class="amount-cell">${escapeHtml(formatAmount(p.amount, p.currency))}</td>
                    <td><span class="entity-meta">${escapeHtml(p.currency)}</span></td>
                    <td>${statusPill(p.status)}</td>
                    <td>${
                        p.descriptor
                            ? `<code class="descriptor-cell">${escapeHtml(p.descriptor)}</code>`
                            : '<span class="entity-meta">—</span>'
                    }</td>
                    <td><span class="entity-meta">${escapeHtml(formatDate(p.created_at))}</span></td>
                    <td class="col-actions">
                        <div class="actions">
                            ${
                                PAYABLE.includes(p.status)
                                    ? `<button class="pay-btn" type="button" data-pay="${escapeHtml(
                                          p.payment_intent_id
                                      )}">Pay</button>`
                                    : ''
                            }
                            <button class="action-link" type="button" data-action="detail">View</button>
                        </div>
                    </td>
                </tr>`
            )
            .join('');
    }

    function renderPagination() {
        const pages = Math.ceil(totalPayments / PAGE_SIZE);
        if (pages <= 1) {
            paginationEl.hidden = true;
            return;
        }
        paginationEl.hidden = false;

        const from = (currentPage - 1) * PAGE_SIZE + 1;
        const to = Math.min(currentPage * PAGE_SIZE, totalPayments);

        let buttons = '';
        for (let i = 1; i <= pages; i += 1) {
            if (i === 1 || i === pages || Math.abs(i - currentPage) <= 1) {
                buttons += `<button class="page-btn ${
                    i === currentPage ? 'active' : ''
                }" type="button" data-page="${i}">${i}</button>`;
            } else if (Math.abs(i - currentPage) === 2) {
                buttons += '<span class="page-dots">…</span>';
            }
        }

        paginationEl.innerHTML = `
            <div class="pagination-info">${from}–${to} of ${totalPayments}</div>
            <div class="pagination-controls">
                <button class="page-btn" type="button" data-page="${currentPage - 1}" ${
                    currentPage === 1 ? 'disabled' : ''
                }>Prev</button>
                ${buttons}
                <button class="page-btn" type="button" data-page="${currentPage + 1}" ${
                    currentPage === pages ? 'disabled' : ''
                }>Next</button>
            </div>`;
    }

    async function loadPayments() {
        const seq = ++loadSeq;
        if (!tbody.children.length) tbody.innerHTML = skeletonRows();

        try {
            const data = await api('/api/payments/query', {
                method: 'POST',
                body: JSON.stringify({
                    filters: filters.getFilters(),
                    sort: filters.getSort(),
                    search: searchQuery || undefined,
                    limit: PAGE_SIZE,
                    skip: (currentPage - 1) * PAGE_SIZE,
                }),
            });
            if (seq !== loadSeq) return; // a newer request already landed

            totalPayments = data.total;
            filters.renderHead();
            renderActiveFilters();
            renderFilteredTotals(data.totals);

            if (!data.items.length) {
                tbody.innerHTML = emptyState();
                paginationEl.hidden = true;
                return;
            }
            renderRows(data.items);
            renderPagination();
        } catch (err) {
            if (seq !== loadSeq) return;
            tbody.innerHTML = emptyState();
            showToast(err.message, 'error');
        } finally {
            if (seq === loadSeq) searchEl.classList.remove('loading');
        }
    }

    // ============== Active filter chips ==============
    function renderActiveFilters() {
        const active = filters.describe();
        const sort = filters.getSort();

        if (!active.length && !sort) {
            activeFiltersEl.hidden = true;
            activeFiltersEl.innerHTML = '';
            return;
        }

        const chips = active
            .map(
                (a) => `
                <span class="filter-chip" data-field="${escapeHtml(a.field)}">
                    <span class="filter-chip-label">${escapeHtml(a.label)}</span>
                    <span class="filter-chip-value">${escapeHtml(a.text)}</span>
                    <button class="filter-chip-remove" type="button" data-remove="${escapeHtml(
                        a.field
                    )}" aria-label="Remove ${escapeHtml(a.label)} filter">&times;</button>
                </span>`
            )
            .join('');

        const sortChip = sort
            ? `<span class="filter-chip sort-chip">
                   <span class="filter-chip-label">Sorted by</span>
                   <span class="filter-chip-value">${escapeHtml(
                       labelForField(sort.key)
                   )} ${sort.dir === 'asc' ? '↑' : '↓'}</span>
               </span>`
            : '';

        activeFiltersEl.innerHTML = `
            ${chips}${sortChip}
            <button class="filter-clear-all" type="button" data-clear-all>Clear all</button>`;
        activeFiltersEl.hidden = false;
    }

    function labelForField(field) {
        const col = COLUMNS.find(
            (c) => ((c.filter && c.filter.field) || c.key) === field
        );
        return col ? col.label : field;
    }

    activeFiltersEl.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove]');
        if (remove) {
            filters.remove(remove.dataset.remove);
            return;
        }
        if (event.target.closest('[data-clear-all]')) {
            filters.clearAll();
        }
    });

    // ============== Totals for the filtered set ==============
    function renderFilteredTotals(totals) {
        if (!totals || !totals.length) {
            filteredTotalsEl.hidden = true;
            return;
        }
        filteredTotalsEl.innerHTML = `
            <span class="totals-label">Matching total</span>
            ${totals
                .map(
                    (t) => `
                <span class="totals-item">
                    <span class="totals-amount">${escapeHtml(
                        formatAmount(t.amount, t.currency)
                    )}</span>
                    <span class="totals-currency">${escapeHtml(t.currency)}</span>
                    <span class="totals-count">${t.count} payment${t.count === 1 ? '' : 's'}</span>
                </span>`
                )
                .join('')}`;
        filteredTotalsEl.hidden = false;
    }

    async function loadStats() {
        try {
            const stats = await api('/api/payments/stats');
            document.getElementById('stat-total').textContent = stats.total;
            document.getElementById('stat-succeeded').textContent = stats.succeeded;
            document.getElementById('stat-pending').textContent =
                (stats.by_status.REQUIRES_PAYMENT_METHOD || 0) +
                (stats.by_status.REQUIRES_CUSTOMER_ACTION || 0) +
                (stats.by_status.PENDING || 0);
            document.getElementById('stat-captured').textContent = stats.captured.length
                ? stats.captured
                      .map((c) => `${formatAmount(c.amount, c.currency)} ${c.currency}`)
                      .join(' · ')
                : '—';
        } catch (err) {
            console.error(err);
        }
    }

    // ============== Detail ==============
    async function openDetail(intentId) {
        detailBody.innerHTML = '<div class="data-empty"><p>Loading…</p></div>';
        openModal(detailModal);

        try {
            const p = await api(`/api/payments/${encodeURIComponent(intentId)}`);
            renderDetail(p);
        } catch (err) {
            detailBody.innerHTML = `<div class="data-empty"><p>${escapeHtml(
                err.message
            )}</p></div>`;
        }
    }

    function renderDetail(p) {
        const events = (p.events || [])
            .slice()
            .reverse()
            .map((e) => {
                const variant =
                    e.status === 'SUCCEEDED'
                        ? 'is-success'
                        : ['CANCELLED', 'EXPIRED', 'FAILED'].includes(e.status)
                          ? 'is-danger'
                          : '';
                return `
                    <li class="${variant}">
                        <div class="timeline-name">${escapeHtml(e.name)}</div>
                        <div class="timeline-meta">${escapeHtml(
                            formatDate(e.occurred_at)
                        )}<span class="timeline-source">${escapeHtml(
                            e.source || 'local'
                        )}</span></div>
                    </li>`;
            })
            .join('');

        const card =
            p.card_brand || p.card_last4
                ? `${escapeHtml(p.card_brand || 'Card')} ···· ${escapeHtml(p.card_last4 || '')}`
                : null;

        detailBody.innerHTML = `
            <div class="detail-head">
                <div class="detail-amount">${escapeHtml(
                    formatAmount(p.amount, p.currency)
                )}<span>${escapeHtml(p.currency)}</span></div>
                ${statusPill(p.status)}
            </div>

            <div class="detail-grid">
                <div class="detail-item">
                    <div class="detail-key">Payment Intent</div>
                    <div class="detail-val mono">${escapeHtml(p.payment_intent_id)}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Order ID</div>
                    <div class="detail-val mono">${escapeHtml(p.merchant_order_id)}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Statement descriptor</div>
                    <div class="detail-val mono">${escapeHtml(p.descriptor || '—')}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Captured</div>
                    <div class="detail-val">${escapeHtml(
                        formatAmount(p.captured_amount || 0, p.currency)
                    )} ${escapeHtml(p.currency)}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Reference</div>
                    <div class="detail-val">${escapeHtml(p.reference || '—')}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Description</div>
                    <div class="detail-val">${escapeHtml(p.description || '—')}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Customer</div>
                    <div class="detail-val">${escapeHtml(
                        (p.customer && (p.customer.name || p.customer.email)) || '—'
                    )}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Payment method</div>
                    <div class="detail-val">${card || escapeHtml(p.payment_method_type || '—')}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Checkout</div>
                    <div class="detail-val">${
                        p.checkout_mode === 'embedded_elements'
                            ? 'Embedded elements'
                            : 'Hosted Payment Page'
                    }</div>
                </div>
                <div class="detail-item">
                    <div class="detail-key">Created</div>
                    <div class="detail-val">${escapeHtml(formatDate(p.created_at))}</div>
                </div>
            </div>

            ${
                p.last_error && p.last_error.message
                    ? `<p class="form-error" style="display:block">${escapeHtml(
                          p.last_error.message
                      )}</p>`
                    : ''
            }

            <div class="timeline-title">Timeline</div>
            <ul class="timeline">${events || '<li>No events recorded.</li>'}</ul>

            <div class="detail-actions">
                ${
                    PAYABLE.includes(p.status)
                        ? `<button class="btn btn-primary" type="button" data-pay="${escapeHtml(
                              p.payment_intent_id
                          )}">Take payment</button>`
                        : ''
                }
                <button class="btn btn-ghost" type="button" data-detail-action="sync" data-id="${escapeHtml(
                    p.payment_intent_id
                )}">
                    <span class="btn-spinner" aria-hidden="true"></span>
                    <span class="btn-label">Sync from Airwallex</span>
                </button>
                ${
                    CANCELLABLE.includes(p.status)
                        ? `<button class="btn btn-danger" type="button" data-detail-action="cancel" data-id="${escapeHtml(
                              p.payment_intent_id
                          )}">
                            <span class="btn-spinner" aria-hidden="true"></span>
                            <span class="btn-label">Cancel payment</span>
                           </button>`
                        : ''
                }
            </div>`;
    }

    detailBody.addEventListener('click', async (event) => {
        const pay = event.target.closest('[data-pay]');
        if (pay) {
            openCheckoutFor(pay.dataset.pay, pay);
            return;
        }

        const button = event.target.closest('[data-detail-action]');
        if (!button) return;

        const { detailAction, id } = button.dataset;
        setLoading(button, true, detailAction === 'sync' ? 'Syncing…' : 'Cancelling…');

        try {
            const updated = await api(
                `/api/payments/${encodeURIComponent(id)}/${detailAction}`,
                { method: 'POST', body: JSON.stringify({}) }
            );
            renderDetail(updated);
            showToast(
                detailAction === 'sync' ? 'Synced from Airwallex.' : 'Payment cancelled.'
            );
            loadPayments();
            loadStats();
        } catch (err) {
            setLoading(button, false);
            showToast(err.message, 'error');
        }
    });

    // ============== Take payment on an existing intent ==============
    /**
     * Re-open checkout for a payment that was created earlier.
     *
     * The client_secret was never stored, so the server mints a fresh one from
     * Airwallex. That round trip also re-checks the status, so a payment that
     * was completed elsewhere is refused here rather than charged twice.
     */
    async function openCheckoutFor(intentId, button) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = 'Opening…';
        try {
            const { checkout } = await api(
                `/api/payments/${encodeURIComponent(intentId)}/checkout`,
                { method: 'POST', body: JSON.stringify({}) }
            );
            sessionStorage.setItem(CHECKOUT_HANDOFF_KEY, JSON.stringify(checkout));
            window.location.href = '/checkout';
        } catch (err) {
            button.disabled = false;
            button.textContent = original;
            showToast(err.message, 'error');
            // The status moved on underneath us — show the truth.
            loadPayments();
            loadStats();
        }
    }

    // ============== Events ==============
    tbody.addEventListener('click', (event) => {
        const pay = event.target.closest('[data-pay]');
        if (pay) {
            // Don't also open the detail modal for this click.
            event.stopPropagation();
            openCheckoutFor(pay.dataset.pay, pay);
            return;
        }
        const row = event.target.closest('tr[data-id]');
        if (!row) return;
        openDetail(row.dataset.id);
    });

    paginationEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-page]');
        if (!button || button.disabled) return;
        currentPage = Number(button.dataset.page);
        loadPayments();
    });

    // The status tabs are a shortcut into the same status filter the column
    // popover writes, so the two can never disagree.
    statusTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('.status-tab');
        if (!tab) return;
        const status = tab.dataset.status;
        filters.set('status', status ? { op: 'in', value: [status] } : null);
        currentPage = 1;
        tbody.innerHTML = '';
        markActiveStatusTab(status);
        loadPayments();
    });

    function markActiveStatusTab(status) {
        statusTabs.querySelectorAll('.status-tab').forEach((t) => {
            t.classList.toggle('active', (t.dataset.status || '') === (status || ''));
        });
    }

    /** Keep the tabs in step when the status filter is changed elsewhere. */
    function syncStatusTabsToFilter() {
        const f = filters.get('status');
        const single =
            f && f.op === 'in' && Array.isArray(f.value) && f.value.length === 1
                ? f.value[0]
                : null;
        const hasTab =
            single &&
            Array.from(statusTabs.querySelectorAll('.status-tab')).some(
                (t) => t.dataset.status === single
            );
        markActiveStatusTab(hasTab ? single : f ? '__none__' : '');
    }

    let searchTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchEl.classList.add('loading');
        searchTimer = setTimeout(() => {
            searchQuery = searchInput.value.trim();
            currentPage = 1;
            loadPayments();
        }, 300);
    });

    refreshBtn.addEventListener('click', () => {
        tbody.innerHTML = '';
        loadPayments();
        loadStats();
    });

    // Surface the outcome of a checkout the shopper just came back from.
    const returnedStatus = sessionStorage.getItem('payment_toast');
    if (returnedStatus) {
        sessionStorage.removeItem('payment_toast');
        const parsed = JSON.parse(returnedStatus);
        showToast(parsed.message, parsed.variant);
    }

    refreshDescriptorPreview();
    filters.renderHead();
    loadPayments();
    loadStats();
})();
