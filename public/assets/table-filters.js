/**
 * Excel-style column filter + sort popover, extracted from the QP utility's
 * dataset page so any table view can reuse it.
 *
 * The host page owns the data and the reload; this module owns the popover UI
 * and the filter/sort state it produces.
 *
 *   const filters = TableFilters.init({
 *       theadRow, popoverEl, columns,
 *       fetchDistinct: (field, search) => Promise<{values, total, shown}>,
 *       onChange: () => reloadTable(),
 *   });
 *   filters.getFilters()  // -> { field: {op, value, ...}, ... }
 *   filters.getSort()     // -> { key, dir } | null
 *
 * Column shape: { key, label, filter: { kind: 'text'|'number'|'enum'|'date', field? } }
 * `filter.field` lets a display column filter on a different backing field.
 */
window.TableFilters = (() => {
    const ICONS = {
        funnel: '<svg viewBox="0 0 16 16" fill="none"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
        funnelFilled: '<svg viewBox="0 0 16 16"><path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" fill="currentColor"/></svg>',
        sortAsc: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        sortDesc: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 3v10M4.5 9.5L8 13l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><line x1="16.5" y1="16.5" x2="21" y2="21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    };

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    function debounce(fn, ms) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
    }

    function init({ theadRow, popoverEl, columns, fetchDistinct, onChange }) {
        let filterState = {};
        let sortState = null;
        let popoverCtx = null;
        let distinctReqSeq = 0;

        const fieldOf = (col) => (col.filter && col.filter.field) || col.key;

        // ============== Header rendering ==============
        function renderHead(leadingCells = '') {
            const cols = columns
                .map((col) => {
                    if (!col.filter) {
                        return `<th${col.className ? ` class="${col.className}"` : ''}><span class="th-label">${escapeHtml(
                            col.label
                        )}</span></th>`;
                    }
                    const field = fieldOf(col);
                    const active = !!filterState[field] || (sortState && sortState.key === field);
                    return `
                        <th${col.className ? ` class="${col.className}"` : ''}>
                            <span class="th-label">${escapeHtml(col.label)}</span>
                            <button class="filter-btn${active ? ' active' : ''}" data-filter-col="${escapeHtml(
                                col.key
                            )}" aria-label="Filter ${escapeHtml(col.label)}">${
                                filterState[field] ? ICONS.funnelFilled : ICONS.funnel
                            }</button>
                        </th>`;
                })
                .join('');
            theadRow.innerHTML = leadingCells + cols;
        }

        // ============== Open / close ==============
        theadRow.addEventListener('click', (event) => {
            const btn = event.target.closest('.filter-btn');
            if (!btn) return;
            event.stopPropagation();
            const col = columns.find((c) => c.key === btn.dataset.filterCol);
            if (!col || !col.filter) return;
            if (popoverCtx && popoverCtx.col === col) {
                closePopover();
                return;
            }
            openPopover(col, btn);
        });

        document.addEventListener('click', () => {
            if (popoverCtx) closePopover();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && popoverCtx) closePopover();
        });

        function openPopover(col, anchorEl) {
            const field = fieldOf(col);
            popoverCtx = {
                col,
                field,
                anchorEl,
                draftFilter: filterState[field] ? { ...filterState[field] } : null,
                draftSort: sortState && sortState.key === field ? { ...sortState } : null,
                searchTerm: '',
                distinctValues: [],
                distinctTotal: 0,
                distinctLoading: true,
            };

            popoverEl.hidden = false;
            renderPopover();
            positionPopover(anchorEl);
            popoverEl.offsetHeight;
            popoverEl.classList.add('visible');

            if (col.filter.kind === 'text' || col.filter.kind === 'enum') {
                loadDistinct();
            } else {
                setTimeout(() => {
                    const focusEl = popoverEl.querySelector('[data-autofocus]');
                    if (focusEl) focusEl.focus();
                }, 30);
            }
        }

        function closePopover() {
            popoverEl.classList.remove('visible');
            setTimeout(() => {
                if (!popoverEl.classList.contains('visible')) {
                    popoverEl.hidden = true;
                    popoverEl.innerHTML = '';
                    popoverCtx = null;
                }
            }, 180);
        }

        function positionPopover(anchorEl) {
            const rect = anchorEl.getBoundingClientRect();
            const width = 320;
            const margin = 12;

            let left = rect.left;
            if (left + width > window.innerWidth - margin) {
                left = window.innerWidth - width - margin;
            }
            if (left < margin) left = margin;

            // Prefer opening downward; flip up when there isn't room, and cap
            // the scrollable body so Apply always stays reachable.
            const spaceBelow = window.innerHeight - rect.bottom - margin;
            const spaceAbove = rect.top - margin;
            const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
            let top = openUp ? rect.top - 6 : rect.bottom + 6;

            const header = popoverEl.querySelector('.filter-popover-header');
            const body = popoverEl.querySelector('.filter-popover-body');
            const footer = popoverEl.querySelector('.filter-popover-footer');
            if (body) {
                const chrome =
                    (header ? header.offsetHeight : 0) + (footer ? footer.offsetHeight : 0);
                const available = (openUp ? spaceAbove : spaceBelow) - chrome - 16;
                body.style.maxHeight = `${Math.max(140, available)}px`;
            }
            if (openUp) {
                top = rect.top - 6 - popoverEl.offsetHeight;
                if (top < margin) top = margin;
            }

            popoverEl.style.left = `${left}px`;
            popoverEl.style.top = `${top}px`;
        }

        // ============== Popover content ==============
        function renderPopover() {
            if (!popoverCtx) return;
            const kind = popoverCtx.col.filter.kind;

            popoverEl.innerHTML = `
                <div class="filter-popover-header">${escapeHtml(popoverCtx.col.label)}</div>
                <div class="filter-popover-body">
                    ${kind !== 'enum' ? renderSortSection(kind) : ''}
                    ${renderFilterSection(kind)}
                </div>
                <div class="filter-popover-footer">
                    ${
                        isDirty()
                            ? '<button class="filter-link" data-action="clear-filter">Clear filter</button>'
                            : ''
                    }
                    <button class="filter-apply-btn" data-action="apply">Apply Filter</button>
                </div>`;
            attachHandlers();
            // innerHTML wipes the inline max-height, and async content changes
            // the height — re-fit so Apply stays reachable.
            if (popoverCtx.anchorEl) positionPopover(popoverCtx.anchorEl);
        }

        function renderSortSection(kind) {
            const labels =
                kind === 'number'
                    ? { asc: 'Sort Smallest to Largest', desc: 'Sort Largest to Smallest' }
                    : kind === 'date'
                      ? { asc: 'Sort Oldest to Newest', desc: 'Sort Newest to Oldest' }
                      : { asc: 'Sort A to Z', desc: 'Sort Z to A' };
            const dir = popoverCtx.draftSort ? popoverCtx.draftSort.dir : null;

            return `
                <div class="filter-sort-section">
                    <button class="filter-sort-btn${dir === 'asc' ? ' active' : ''}" data-action="sort" data-dir="asc">
                        ${ICONS.sortAsc}<span>${escapeHtml(labels.asc)}</span>
                    </button>
                    <button class="filter-sort-btn${dir === 'desc' ? ' active' : ''}" data-action="sort" data-dir="desc">
                        ${ICONS.sortDesc}<span>${escapeHtml(labels.desc)}</span>
                    </button>
                </div>`;
        }

        function renderFilterSection(kind) {
            switch (kind) {
                case 'text':
                case 'enum':
                    return renderListFilter();
                case 'number':
                    return renderNumberFilter();
                case 'date':
                    return renderDateFilter();
                default:
                    return '';
            }
        }

        function renderListFilter() {
            const draft = popoverCtx.draftFilter;
            // With no filter applied every value is implicitly selected — that
            // mirrors the real state of the table (everything is shown).
            const unfilteredDefault = !draft;
            const selected = Array.isArray(draft && draft.value) ? draft.value : [];
            const selectedSet = new Set(selected.map(String));

            let optionsHtml;
            if (popoverCtx.distinctLoading) {
                optionsHtml = '<div class="filter-loading">Loading values…</div>';
            } else if (!popoverCtx.distinctValues.length) {
                optionsHtml = '<div class="filter-empty">No values found</div>';
            } else {
                optionsHtml = popoverCtx.distinctValues
                    .map((v) => {
                        const safe = escapeHtml(String(v));
                        const checked = unfilteredDefault || selectedSet.has(String(v));
                        return `
                            <label class="filter-check">
                                <input type="checkbox" data-action="toggle-value" data-value="${safe}" ${
                                    checked ? 'checked' : ''
                                }>
                                <span class="filter-check-box"></span>
                                <span class="filter-check-label">${safe}</span>
                            </label>`;
                    })
                    .join('');
            }

            const selectedCount = unfilteredDefault ? popoverCtx.distinctTotal : selectedSet.size;
            const totalLabel = popoverCtx.distinctTotal
                ? `${selectedCount} / ${popoverCtx.distinctTotal}`
                : '—';

            return `
                <div class="filter-section">
                    <div class="filter-section-label">Filter by Value</div>
                    <div class="filter-search-wrap">
                        <span class="filter-search-icon">${ICONS.search}</span>
                        <input type="text" class="filter-search-input" placeholder="Search..." data-action="search" data-autofocus value="${escapeHtml(
                            popoverCtx.searchTerm
                        )}">
                    </div>
                    <div class="filter-actions-row">
                        <div class="filter-actions-left">
                            <button class="filter-link primary" data-action="select-all">Select All</button>
                            <button class="filter-link" data-action="clear-values">Clear</button>
                        </div>
                        <span class="filter-count">${totalLabel}</span>
                    </div>
                    <div class="filter-checkboxes">${optionsHtml}</div>
                </div>`;
        }

        function renderNumberFilter() {
            const draft = popoverCtx.draftFilter || {};
            const op = draft.op || 'eq';
            const value = draft.value != null ? String(draft.value) : '';
            const min = draft.min != null ? String(draft.min) : '';
            const max = draft.max != null ? String(draft.max) : '';

            const valueInput =
                op === 'between'
                    ? `<div class="filter-row-2">
                           <input type="number" step="any" class="filter-text-input" placeholder="Min" data-action="set-min" data-autofocus value="${escapeHtml(min)}">
                           <input type="number" step="any" class="filter-text-input" placeholder="Max" data-action="set-max" value="${escapeHtml(max)}">
                       </div>`
                    : `<input type="number" step="any" class="filter-text-input" placeholder="Enter value" data-action="set-value" data-autofocus value="${escapeHtml(
                          value
                      )}">`;

            const option = (v, label) =>
                `<option value="${v}" ${op === v ? 'selected' : ''}>${label}</option>`;

            return `
                <div class="filter-section">
                    <div class="filter-section-label">Condition</div>
                    <select class="filter-select" data-action="set-op">
                        ${option('eq', 'Equals (=)')}
                        ${option('ne', 'Not equals (≠)')}
                        ${option('gt', 'Greater than (&gt;)')}
                        ${option('gte', 'Greater or equal (≥)')}
                        ${option('lt', 'Less than (&lt;)')}
                        ${option('lte', 'Less or equal (≤)')}
                        ${option('between', 'Between')}
                    </select>
                    <div class="filter-section-label" style="margin-top: 14px">Value</div>
                    ${valueInput}
                </div>`;
        }

        function renderDateFilter() {
            const draft = popoverCtx.draftFilter || {};
            return `
                <div class="filter-section">
                    <div class="filter-section-label">After</div>
                    <input type="date" class="filter-date-input" data-action="set-after" data-autofocus value="${escapeHtml(
                        draft.after || ''
                    )}">
                    <div class="filter-section-label" style="margin-top: 14px">Before</div>
                    <input type="date" class="filter-date-input" data-action="set-before" value="${escapeHtml(
                        draft.before || ''
                    )}">
                </div>`;
        }

        // ============== Handlers ==============
        function attachHandlers() {
            popoverEl.querySelectorAll('[data-action]').forEach((el) => {
                switch (el.dataset.action) {
                    case 'sort':
                        el.addEventListener('click', () => {
                            const dir = el.dataset.dir;
                            popoverCtx.draftSort =
                                popoverCtx.draftSort && popoverCtx.draftSort.dir === dir
                                    ? null
                                    : { key: popoverCtx.field, dir };
                            renderPopover();
                        });
                        break;
                    case 'search':
                        el.addEventListener(
                            'input',
                            debounce(() => {
                                if (!popoverCtx) return;
                                popoverCtx.searchTerm = el.value;
                                loadDistinct();
                            }, 200)
                        );
                        break;
                    case 'toggle-value':
                        el.addEventListener('change', () => {
                            const v = el.dataset.value;
                            // A null draft means the user was looking at the
                            // implicit "all checked" state — materialise it
                            // before mutating.
                            let arr;
                            if (!popoverCtx.draftFilter) {
                                arr = popoverCtx.distinctValues.map(String);
                            } else if (Array.isArray(popoverCtx.draftFilter.value)) {
                                arr = popoverCtx.draftFilter.value.slice();
                            } else {
                                arr = [];
                            }
                            const idx = arr.findIndex((x) => String(x) === String(v));
                            if (el.checked && idx === -1) arr.push(v);
                            else if (!el.checked && idx !== -1) arr.splice(idx, 1);

                            // Collapse back to "no filter" when everything is
                            // selected again.
                            popoverCtx.draftFilter =
                                arr.length === popoverCtx.distinctValues.length
                                    ? null
                                    : { op: 'in', value: arr };
                            renderPopover();
                        });
                        break;
                    case 'select-all':
                        el.addEventListener('click', () => {
                            popoverCtx.draftFilter = null;
                            renderPopover();
                        });
                        break;
                    case 'clear-values':
                        el.addEventListener('click', () => {
                            popoverCtx.draftFilter = { op: 'in', value: [] };
                            renderPopover();
                        });
                        break;
                    case 'set-op':
                        el.addEventListener('change', () => {
                            const prev = popoverCtx.draftFilter || {};
                            popoverCtx.draftFilter = {
                                op: el.value,
                                value: prev.value,
                                min: prev.min,
                                max: prev.max,
                            };
                            renderPopover();
                        });
                        break;
                    case 'set-value':
                        el.addEventListener('input', () => {
                            const prev = popoverCtx.draftFilter || { op: 'eq' };
                            popoverCtx.draftFilter =
                                el.value === '' ? null : { ...prev, value: el.value };
                        });
                        break;
                    case 'set-min':
                        el.addEventListener('input', () => {
                            const prev = popoverCtx.draftFilter || { op: 'between' };
                            popoverCtx.draftFilter = { ...prev, op: 'between', min: el.value };
                        });
                        break;
                    case 'set-max':
                        el.addEventListener('input', () => {
                            const prev = popoverCtx.draftFilter || { op: 'between' };
                            popoverCtx.draftFilter = { ...prev, op: 'between', max: el.value };
                        });
                        break;
                    case 'set-after':
                    case 'set-before':
                        el.addEventListener('input', () => {
                            const key = el.dataset.action === 'set-after' ? 'after' : 'before';
                            const prev = popoverCtx.draftFilter || {};
                            const next = { ...prev, [key]: el.value || undefined };
                            popoverCtx.draftFilter = next.after || next.before ? next : null;
                        });
                        break;
                    case 'clear-filter':
                        el.addEventListener('click', () => {
                            popoverCtx.draftFilter = null;
                            popoverCtx.draftSort = null;
                            applyAndClose();
                        });
                        break;
                    case 'apply':
                        el.addEventListener('click', applyAndClose);
                        break;
                    default:
                        break;
                }
            });

            popoverEl.addEventListener('click', stopProp, { once: true });
        }

        function stopProp(event) {
            event.stopPropagation();
            popoverEl.addEventListener('click', stopProp, { once: true });
        }

        function applyAndClose() {
            if (!popoverCtx) return;
            const { field, draftFilter, draftSort, col } = popoverCtx;

            if (draftFilter && hasValue(draftFilter, col.filter.kind)) {
                filterState[field] = draftFilter;
            } else {
                delete filterState[field];
            }
            sortState =
                draftSort || (sortState && sortState.key === field ? null : sortState);

            closePopover();
            onChange();
        }

        function hasValue(f, kind) {
            if (!f) return false;
            if (kind === 'text' || kind === 'enum') {
                if (f.op === 'in') return Array.isArray(f.value) && f.value.length > 0;
                return f.value != null && f.value !== '';
            }
            if (kind === 'number') {
                if (f.op === 'between') return f.min !== undefined || f.max !== undefined;
                return f.value !== undefined && f.value !== '';
            }
            if (kind === 'date') return !!(f.after || f.before);
            return false;
        }

        function isDirty() {
            if (!popoverCtx) return false;
            return (
                !!filterState[popoverCtx.field] ||
                (sortState && sortState.key === popoverCtx.field)
            );
        }

        async function loadDistinct() {
            if (!popoverCtx) return;
            const seq = ++distinctReqSeq;
            popoverCtx.distinctLoading = true;
            renderPopover();
            try {
                const data = await fetchDistinct(popoverCtx.field, popoverCtx.searchTerm);
                if (seq !== distinctReqSeq || !popoverCtx) return;
                popoverCtx.distinctValues = data.values || [];
                popoverCtx.distinctTotal = data.total || 0;
            } catch (err) {
                console.error(err);
                if (seq !== distinctReqSeq || !popoverCtx) return;
                popoverCtx.distinctValues = [];
            } finally {
                if (seq === distinctReqSeq && popoverCtx) {
                    popoverCtx.distinctLoading = false;
                    renderPopover();
                }
            }
        }

        // ============== Public API ==============
        return {
            renderHead,
            getFilters: () => filterState,
            /** Set or clear one field's filter without firing onChange. */
            set(field, filter) {
                if (filter) filterState[field] = filter;
                else delete filterState[field];
            },
            get: (field) => filterState[field] || null,
            getSort: () => sortState,
            /** Describe active filters for the summary chips. */
            describe() {
                return Object.entries(filterState).map(([field, filter]) => {
                    const col =
                        columns.find((c) => fieldOf(c) === field) || { label: field };
                    return { field, label: col.label, filter, text: describeFilter(filter) };
                });
            },
            remove(field) {
                delete filterState[field];
                onChange();
            },
            clearAll() {
                filterState = {};
                sortState = null;
                onChange();
            },
            hasAny: () => Object.keys(filterState).length > 0 || !!sortState,
        };
    }

    function describeFilter(f) {
        if (!f) return '';
        if (f.op === 'in') {
            const vals = Array.isArray(f.value) ? f.value : [];
            if (vals.length <= 2) return vals.join(', ');
            return `${vals.slice(0, 2).join(', ')} +${vals.length - 2}`;
        }
        if (f.op === 'between') {
            return `${f.min != null && f.min !== '' ? f.min : '−∞'} … ${
                f.max != null && f.max !== '' ? f.max : '∞'
            }`;
        }
        if (f.after || f.before) {
            if (f.after && f.before) return `${f.after} … ${f.before}`;
            return f.after ? `after ${f.after}` : `before ${f.before}`;
        }
        const ops = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };
        return `${ops[f.op] || ''} ${f.value != null ? f.value : ''}`.trim();
    }

    return { init };
})();
