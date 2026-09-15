(() => {
    const PAGE_SIZE = 25;

    const COLUMNS = [
        { key: 'portfolio', label: 'Portfolio', filter: { kind: 'enum' } },
        { key: 'name', label: 'Hotel', className: 'col-primary', filter: { kind: 'text' } },
        { key: 'expedia_id', label: 'Expedia ID', filter: { kind: 'text' } },
        { key: 'descriptor', label: 'Descriptor', filter: { kind: 'text' } },
        { key: 'website', label: 'Website', filter: { kind: 'text' } },
        { key: 'status', label: 'Status', filter: { kind: 'enum' } },
        { key: 'created_at', label: 'Added', filter: { kind: 'date' } },
        { key: 'actions', label: '', className: 'col-actions' },
    ];

    // ============== DOM ==============
    const tbody = document.getElementById('hotels-tbody');
    const theadRow = document.getElementById('hotels-thead-row');
    const popoverEl = document.getElementById('filter-popover');
    const activeFiltersEl = document.getElementById('active-filters');
    const paginationEl = document.getElementById('hotels-pagination');
    const statusTabs = document.getElementById('status-tabs');
    const searchEl = document.getElementById('search');
    const searchInput = document.getElementById('search-input');
    const toastEl = document.getElementById('toast');

    const templateWrap = document.getElementById('template-wrap');
    const templateBtn = document.getElementById('template-btn');
    const templateMenu = document.getElementById('template-menu');

    const hotelModal = document.getElementById('hotel-modal');
    const hotelForm = document.getElementById('hotel-form');
    const hotelSubmit = document.getElementById('hotel-submit');
    const hotelError = document.getElementById('hotel-error');
    const hotelTitle = document.getElementById('hotel-modal-title');
    const statusField = document.getElementById('status-field');
    const descriptorInput = document.getElementById('hotel-descriptor-input');
    const descriptorValue = document.getElementById('hotel-descriptor-value');
    const descriptorCount = document.getElementById('hotel-descriptor-count');
    const portfolioList = document.getElementById('portfolio-list');

    const bulkModal = document.getElementById('bulk-modal');
    const bulkTitle = document.getElementById('bulk-title');
    const bulkSub = document.getElementById('bulk-sub');
    const bulkTemplateLink = document.getElementById('bulk-template-link');
    const bulkResult = document.getElementById('bulk-result');
    const bulkSubmit = document.getElementById('bulk-submit');
    const upsertToggle = document.getElementById('upsert-toggle');
    const upsertCheck = document.getElementById('upsert-check');

    // ============== State ==============
    let currentPage = 1;
    let total = 0;
    let searchQuery = '';
    let loadSeq = 0;
    let editingId = null;
    let bulkMode = 'import';

    // ============== API ==============
    function getToken() {
        return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    }

    async function api(path, options = {}) {
        const res = await fetch(path, {
            ...options,
            headers: {
                ...(options.body && !options.rawBody ? { 'Content-Type': 'application/json' } : {}),
                ...(options.rawBody ? { 'Content-Type': 'text/csv' } : {}),
                Authorization: `Bearer ${getToken()}`,
                ...(options.headers || {}),
            },
        });
        if (res.status === 401) {
            window.location.replace('/login');
            throw new Error('Unauthorized');
        }
        const data = await res.json().catch(() => ({}));
        // 422 carries a structured validation result, not a plain error.
        if (!res.ok && res.status !== 422) throw new Error(data.error || 'Request failed');
        return { ok: res.ok, status: res.status, data };
    }

    const escapeHtml = BulkUpload.escapeHtml;

    function formatDate(value) {
        if (!value) return '—';
        return new Date(value).toLocaleDateString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        });
    }

    let toastTimer;
    function showToast(message, variant = 'success') {
        clearTimeout(toastTimer);
        toastEl.textContent = message;
        toastEl.className = `toast ${variant === 'error' ? 'error' : 'success'}`;
        toastEl.hidden = false;
        toastEl.offsetHeight;
        toastEl.classList.add('visible');
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            setTimeout(() => { toastEl.hidden = true; }, 300);
        }, 4000);
    }

    function setLoading(button, isLoading, label) {
        const labelEl = button.querySelector('.btn-label');
        if (isLoading) {
            button.dataset.originalLabel = labelEl.textContent;
            if (label) labelEl.textContent = label;
            button.classList.add('loading');
            button.disabled = true;
        } else {
            if (button.dataset.originalLabel) labelEl.textContent = button.dataset.originalLabel;
            button.classList.remove('loading');
            button.disabled = false;
        }
    }

    // ============== Filters ==============
    const filters = TableFilters.init({
        theadRow,
        popoverEl,
        columns: COLUMNS,
        fetchDistinct: async (field, search) => {
            const params = new URLSearchParams({ limit: '200' });
            if (search) params.set('search', search);
            const { data } = await api(`/api/hotels/distinct/${field}?${params}`);
            return data;
        },
        onChange: () => {
            currentPage = 1;
            tbody.innerHTML = '';
            syncStatusTabs();
            load();
        },
    });

    // ============== Modals ==============
    function openModal(modal) {
        modal.hidden = false;
        modal.offsetHeight;
        modal.classList.add('visible');
    }
    function closeModal(modal) {
        modal.classList.remove('visible');
        setTimeout(() => { modal.hidden = true; }, 200);
    }

    document.addEventListener('click', (event) => {
        const closer = event.target.closest('[data-close]');
        if (closer) {
            closeModal(closer.dataset.close === 'hotel' ? hotelModal : bulkModal);
            return;
        }
        if (event.target === hotelModal) closeModal(hotelModal);
        if (event.target === bulkModal) closeModal(bulkModal);
        if (!templateWrap.contains(event.target)) {
            templateMenu.hidden = true;
            templateWrap.classList.remove('open');
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!hotelModal.hidden) closeModal(hotelModal);
        if (!bulkModal.hidden) closeModal(bulkModal);
        templateMenu.hidden = true;
        templateWrap.classList.remove('open');
    });

    // ============== Templates menu ==============
    templateBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        templateMenu.hidden = !templateMenu.hidden;
        templateWrap.classList.toggle('open', !templateMenu.hidden);
    });

    templateMenu.addEventListener('click', async (event) => {
        const option = event.target.closest('[data-download]');
        if (!option) return;
        templateMenu.hidden = true;
        templateWrap.classList.remove('open');
        try {
            await BulkUpload.download(option.dataset.download);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    // ============== Descriptor preview ==============
    function refreshDescriptor() {
        const value = descriptorInput.value.trim();
        descriptorValue.textContent = value || '—';
        descriptorCount.textContent = `${value.length}/32`;
        descriptorCount.classList.toggle('over', value.length > 32);
    }
    descriptorInput.addEventListener('input', refreshDescriptor);

    // ============== Add / edit ==============
    document.getElementById('add-hotel-btn').addEventListener('click', () => {
        editingId = null;
        hotelForm.reset();
        hotelError.hidden = true;
        statusField.hidden = true;
        hotelTitle.textContent = 'Add hotel';
        refreshDescriptor();
        openModal(hotelModal);
    });

    async function openEdit(id) {
        try {
            const { data: hotel } = await api(`/api/hotels/${encodeURIComponent(id)}`);
            editingId = hotel.expedia_id;
            hotelForm.reset();
            hotelForm.portfolio.value = hotel.portfolio;
            hotelForm.name.value = hotel.name;
            hotelForm.expedia_id.value = hotel.expedia_id;
            hotelForm.descriptor.value = hotel.descriptor;
            hotelForm.website.value = hotel.website || '';
            hotelForm.status.value = hotel.status;
            statusField.hidden = false;
            hotelTitle.textContent = 'Edit hotel';
            hotelError.hidden = true;
            refreshDescriptor();
            openModal(hotelModal);
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    hotelForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        hotelError.hidden = true;

        const formData = new FormData(hotelForm);
        const payload = {
            portfolio: (formData.get('portfolio') || '').trim(),
            name: (formData.get('name') || '').trim(),
            expedia_id: (formData.get('expedia_id') || '').trim(),
            descriptor: (formData.get('descriptor') || '').trim(),
            website: (formData.get('website') || '').trim(),
        };
        if (!statusField.hidden) payload.status = formData.get('status');

        setLoading(hotelSubmit, true, 'Saving…');
        try {
            const { ok, data } = editingId
                ? await api(`/api/hotels/${encodeURIComponent(editingId)}`, {
                      method: 'PATCH',
                      body: JSON.stringify(payload),
                  })
                : await api('/api/hotels', { method: 'POST', body: JSON.stringify(payload) });

            if (!ok) throw new Error(data.error || 'Could not save');

            closeModal(hotelModal);
            showToast(editingId ? 'Hotel updated.' : 'Hotel added.');
            load();
            loadStats();
        } catch (err) {
            hotelError.textContent = err.message;
            hotelError.hidden = false;
        } finally {
            setLoading(hotelSubmit, false);
        }
    });

    // ============== Bulk ==============
    const dropzoneCtl = BulkUpload.attachDropzone({
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('bulk-file'),
        textEl: document.getElementById('dropzone-text'),
        hintEl: document.getElementById('dropzone-hint'),
        onChange: (file) => {
            bulkSubmit.disabled = !file;
        },
    });

    function openBulk(mode) {
        bulkMode = mode;
        const isImport = mode === 'import';
        bulkTitle.textContent = isImport ? 'Bulk import hotels' : 'Bulk update hotels';
        bulkSub.textContent = isImport
            ? 'Upload a CSV of new hotels. Nothing is saved unless every row is valid.'
            : 'Match on Expedia ID and change only the columns your file includes.';
        bulkTemplateLink.dataset.url = isImport
            ? '/api/hotels/templates/import'
            : '/api/hotels/templates/update';
        upsertToggle.hidden = !isImport;
        upsertCheck.checked = false;
        bulkResult.hidden = true;
        dropzoneCtl.reset('Drop a CSV or Excel file here', '.csv or .xlsx, up to 5000 rows');
        openModal(bulkModal);
    }

    document.getElementById('bulk-import-btn').addEventListener('click', () => openBulk('import'));
    document.getElementById('bulk-update-btn').addEventListener('click', () => openBulk('update'));

    bulkTemplateLink.addEventListener('click', async (event) => {
        event.preventDefault();
        try {
            await BulkUpload.download(bulkTemplateLink.dataset.url);
        } catch (err) {
            showToast(err.message, 'error');
        }
    });

    bulkSubmit.addEventListener('click', async () => {
        const file = dropzoneCtl.file;
        if (!file) return;

        setLoading(bulkSubmit, true, 'Uploading…');
        bulkResult.hidden = true;
        try {
            const url =
                bulkMode === 'import'
                    ? `/api/hotels/bulk/import?upsert=${upsertCheck.checked}`
                    : '/api/hotels/bulk/update';

            // Sent as the File itself so an .xlsx keeps its bytes intact.
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': BulkUpload.contentTypeFor(file),
                    Authorization: `Bearer ${getToken()}`,
                },
                body: file,
            });
            if (res.status === 401) {
                window.location.replace('/login');
                return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok && res.status !== 422) {
                throw new Error(data.error || 'Upload failed');
            }

            if (data.applied) {
                BulkUpload.renderResult(bulkResult, data, {
                    successLabel: bulkMode === 'import' ? 'Import complete' : 'Update complete',
                });
                showToast(
                    bulkMode === 'import'
                        ? `${data.created} created, ${data.updated} updated.`
                        : `${data.updated} hotel${data.updated === 1 ? '' : 's'} updated.`
                );
                load();
                loadStats();
            } else {
                BulkUpload.renderResult(bulkResult, data);
            }
        } catch (err) {
            BulkUpload.renderResult(bulkResult, { errors: [{ line: '—', error: err.message }] });
        } finally {
            setLoading(bulkSubmit, false);
        }
    });

    // ============== Table ==============
    function skeletonRows(count = 5) {
        return Array.from({ length: count })
            .map(
                () => `<tr class="skeleton-row">${Array.from({ length: 8 })
                    .map(() => '<td><div class="skel-pill" style="width:65%"></div></td>')
                    .join('')}</tr>`
            )
            .join('');
    }

    function emptyState() {
        const filtered = searchQuery || filters.hasAny();
        return `
            <tr><td colspan="8">
                <div class="data-empty">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none">
                            <path d="M3 21h18M5 21V7l7-4 7 4v14" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                            <path d="M9 21v-5h6v5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                        </svg>
                    </div>
                    <p>${filtered ? 'No hotels match these filters.' : 'No hotels yet.'}</p>
                    <span>${
                        filtered
                            ? 'Try a different search, or clear the filters above.'
                            : 'Add one, or bulk import a CSV to get started.'
                    }</span>
                </div>
            </td></tr>`;
    }

    function renderRows(items) {
        tbody.innerHTML = items
            .map(
                (h) => `
                <tr data-id="${escapeHtml(h.expedia_id)}">
                    <td><span class="portfolio-tag">${escapeHtml(h.portfolio)}</span></td>
                    <td><div class="entity-name">${escapeHtml(h.name)}</div></td>
                    <td><span class="order-id">${escapeHtml(h.expedia_id)}</span></td>
                    <td><code class="descriptor-cell">${escapeHtml(h.descriptor)}</code></td>
                    <td>${
                        h.website
                            ? `<a class="website-link" href="https://${escapeHtml(
                                  h.website
                              )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                                  h.website
                              )}</a>`
                            : '<span class="entity-meta">—</span>'
                    }</td>
                    <td><span class="pill ${h.status === 'active' ? 'success' : 'neutral'}">${
                        h.status === 'active' ? 'Active' : 'Archived'
                    }</span></td>
                    <td><span class="entity-meta">${escapeHtml(formatDate(h.created_at))}</span></td>
                    <td class="col-actions">
                        <div class="actions">
                            <button class="action-link" type="button" data-edit="${escapeHtml(
                                h.expedia_id
                            )}">Edit</button>
                        </div>
                    </td>
                </tr>`
            )
            .join('');
    }

    function renderPagination() {
        const pages = Math.ceil(total / PAGE_SIZE);
        if (pages <= 1) {
            paginationEl.hidden = true;
            return;
        }
        paginationEl.hidden = false;
        const from = (currentPage - 1) * PAGE_SIZE + 1;
        const to = Math.min(currentPage * PAGE_SIZE, total);

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
            <div class="pagination-info">${from}–${to} of ${total}</div>
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

    function renderActiveFilters() {
        const active = filters.describe();
        const sort = filters.getSort();
        if (!active.length && !sort) {
            activeFiltersEl.hidden = true;
            return;
        }
        const chips = active
            .map(
                (a) => `
                <span class="filter-chip">
                    <span class="filter-chip-label">${escapeHtml(a.label)}</span>
                    <span class="filter-chip-value">${escapeHtml(a.text)}</span>
                    <button class="filter-chip-remove" type="button" data-remove="${escapeHtml(
                        a.field
                    )}" aria-label="Remove filter">&times;</button>
                </span>`
            )
            .join('');
        const sortChip = sort
            ? `<span class="filter-chip sort-chip"><span class="filter-chip-label">Sorted by</span><span class="filter-chip-value">${escapeHtml(
                  (COLUMNS.find((c) => c.key === sort.key) || { label: sort.key }).label
              )} ${sort.dir === 'asc' ? '↑' : '↓'}</span></span>`
            : '';
        activeFiltersEl.innerHTML = `${chips}${sortChip}<button class="filter-clear-all" type="button" data-clear-all>Clear all</button>`;
        activeFiltersEl.hidden = false;
    }

    async function load() {
        const seq = ++loadSeq;
        if (!tbody.children.length) tbody.innerHTML = skeletonRows();
        try {
            const { data } = await api('/api/hotels/query', {
                method: 'POST',
                body: JSON.stringify({
                    filters: filters.getFilters(),
                    sort: filters.getSort(),
                    search: searchQuery || undefined,
                    limit: PAGE_SIZE,
                    skip: (currentPage - 1) * PAGE_SIZE,
                }),
            });
            if (seq !== loadSeq) return;

            total = data.total;
            filters.renderHead();
            renderActiveFilters();

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

    async function loadStats() {
        try {
            const { data } = await api('/api/hotels/stats');
            document.getElementById('stat-total').textContent = data.total;
            document.getElementById('stat-active').textContent = data.active;
            document.getElementById('stat-archived').textContent = data.archived;
            document.getElementById('stat-portfolios').textContent = data.portfolios;
        } catch (err) {
            console.error(err);
        }
    }

    async function loadPortfolios() {
        try {
            const { data } = await api('/api/hotels/distinct/portfolio?limit=200');
            portfolioList.innerHTML = (data.values || [])
                .map((v) => `<option value="${escapeHtml(v)}"></option>`)
                .join('');
        } catch (err) {
            console.error(err);
        }
    }

    // ============== Events ==============
    tbody.addEventListener('click', (event) => {
        const edit = event.target.closest('[data-edit]');
        if (edit) openEdit(edit.dataset.edit);
    });

    activeFiltersEl.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove]');
        if (remove) return filters.remove(remove.dataset.remove);
        if (event.target.closest('[data-clear-all]')) filters.clearAll();
    });

    paginationEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-page]');
        if (!button || button.disabled) return;
        currentPage = Number(button.dataset.page);
        load();
    });

    statusTabs.addEventListener('click', (event) => {
        const tab = event.target.closest('.status-tab');
        if (!tab) return;
        const status = tab.dataset.status;
        filters.set('status', status ? { op: 'in', value: [status] } : null);
        currentPage = 1;
        tbody.innerHTML = '';
        markTab(status);
        load();
    });

    function markTab(status) {
        statusTabs.querySelectorAll('.status-tab').forEach((t) => {
            t.classList.toggle('active', (t.dataset.status || '') === (status || ''));
        });
    }

    function syncStatusTabs() {
        const f = filters.get('status');
        const single =
            f && f.op === 'in' && Array.isArray(f.value) && f.value.length === 1 ? f.value[0] : null;
        markTab(single || (f ? '__none__' : ''));
    }

    let searchTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchEl.classList.add('loading');
        searchTimer = setTimeout(() => {
            searchQuery = searchInput.value.trim();
            currentPage = 1;
            load();
        }, 300);
    });

    // ============== Init ==============
    filters.renderHead();
    refreshDescriptor();
    load();
    loadStats();
    loadPortfolios();
})();
