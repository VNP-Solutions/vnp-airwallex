(() => {
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
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    const escapeHtml = BulkUpload.escapeHtml;
    const listEl = document.getElementById('batch-list');

    const runModal = document.getElementById('run-modal');
    const runSub = document.getElementById('run-sub');
    const runWarning = document.getElementById('run-warning');
    const runHeadless = document.getElementById('run-headless');
    const runError = document.getElementById('run-error');
    const runConfirm = document.getElementById('run-confirm');

    const deleteModal = document.getElementById('delete-modal');
    const deleteSub = document.getElementById('delete-sub');
    const deleteBody = document.getElementById('delete-body');
    const deleteError = document.getElementById('delete-error');
    const deleteConfirm = document.getElementById('delete-confirm');

    let batches = [];
    let runTarget = null;
    let deleteTarget = null;
    let pollTimer = null;

    // ============== Helpers ==============
    function formatAmount(value) {
        const n = Number(value);
        return Number.isFinite(n)
            ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '0.00';
    }

    function formatDate(value) {
        if (!value) return '—';
        return new Date(value).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        });
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
            closeModal(closer.dataset.close === 'run' ? runModal : deleteModal);
            return;
        }
        if (event.target === runModal) closeModal(runModal);
        if (event.target === deleteModal) closeModal(deleteModal);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!runModal.hidden) closeModal(runModal);
        if (!deleteModal.hidden) closeModal(deleteModal);
    });

    // ============== Rendering ==============
    function statusPill(batch) {
        const run = batch.pay_run || {};
        if (run.status === 'running') return '<span class="pill pending">Paying</span>';
        if (batch.status === 'creating') return '<span class="pill pending">Creating</span>';
        if (batch.status === 'failed') return '<span class="pill danger">Failed</span>';
        if (batch.payable === 0 && batch.payments > 0)
            return '<span class="pill success">All paid</span>';
        return '<span class="pill info">Ready</span>';
    }

    function progressBlock(batch) {
        const run = batch.pay_run || {};
        const creating = batch.status === 'creating';

        // While rows are still being created, the meaningful progress is
        // creation; once paying starts, it is the pay run.
        const total = creating ? batch.total_rows : run.total || 0;
        const done = creating ? batch.processed : run.processed || 0;
        const ok = creating ? batch.succeeded : run.succeeded || 0;
        const bad = creating ? batch.failed : run.failed || 0;

        if (!creating && run.status === 'idle') return '';
        if (!total) return '';

        const pct = total ? Math.round((done / total) * 100) : 0;
        return `
            <div class="batch-progress">
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
                <div class="progress-meta">
                    <span>${creating ? 'Creating intents' : runLabel(run)}</span>
                    <span class="progress-counts">
                        <span class="ok">${ok} ok</span>${
                            bad ? ` · <span class="bad">${bad} failed</span>` : ''
                        } · ${done}/${total}
                    </span>
                </div>
                ${
                    run.current && run.status === 'running'
                        ? `<div class="progress-current">Paying ${escapeHtml(run.current)}…</div>`
                        : ''
                }
                ${
                    run.error
                        ? `<div class="progress-error">${escapeHtml(run.error)}</div>`
                        : ''
                }
            </div>`;
    }

    function runLabel(run) {
        if (run.status === 'running')
            return `Paying${run.headless ? '' : ' (browser visible)'}`;
        if (run.status === 'completed') return 'Last run complete';
        if (run.status === 'cancelled') return 'Run stopped';
        if (run.status === 'failed') return 'Run failed';
        return 'Payment run';
    }

    function render() {
        if (!batches.length) {
            listEl.innerHTML = `
                <div class="data-empty">
                    <p>No batches yet.</p>
                    <span>Upload a payment file from the Payments page to create one.</span>
                </div>`;
            return;
        }

        listEl.innerHTML = batches
            .map((b) => {
                const run = b.pay_run || {};
                const running = run.status === 'running';
                const canPay = b.payable > 0 && b.status !== 'creating' && !running;

                return `
                <article class="batch-card${running ? ' is-running' : ''}" data-id="${escapeHtml(
                    b._id
                )}">
                    <div class="batch-head">
                        <div class="batch-title">
                            <span class="batch-name">${escapeHtml(b.file_name)}</span>
                            ${statusPill(b)}
                        </div>
                        <div class="batch-meta">
                            ${escapeHtml(formatDate(b.created_at))}${
                                b.created_by
                                    ? ` · ${escapeHtml(b.created_by.email || '')}`
                                    : ''
                            }
                        </div>
                    </div>

                    <div class="batch-stats">
                        <div class="batch-stat"><span class="k">Rows</span><span class="v">${
                            b.total_rows
                        }</span></div>
                        <div class="batch-stat"><span class="k">Payments</span><span class="v">${
                            b.payments
                        }</span></div>
                        <div class="batch-stat"><span class="k">Awaiting</span><span class="v">${
                            b.payable
                        }</span></div>
                        <div class="batch-stat"><span class="k">Paid</span><span class="v ok">${
                            b.paid
                        }</span></div>
                        <div class="batch-stat"><span class="k">Value</span><span class="v">${escapeHtml(
                            formatAmount(b.amount)
                        )}</span></div>
                    </div>

                    ${progressBlock(b)}

                    <div class="batch-actions">
                        <a class="btn btn-ghost" href="/payments?batch=${encodeURIComponent(
                            b._id
                        )}">Pay individually</a>
                        ${
                            running
                                ? `<button class="btn btn-danger" type="button" data-stop="${escapeHtml(
                                      b._id
                                  )}">Stop run</button>`
                                : `<button class="btn btn-primary" type="button" data-run="${escapeHtml(
                                      b._id
                                  )}" ${canPay ? '' : 'disabled'}>Pay in bulk</button>`
                        }
                        <button class="btn btn-ghost batch-delete" type="button" data-delete="${escapeHtml(
                            b._id
                        )}" ${running ? 'disabled' : ''}>Delete</button>
                    </div>
                </article>`;
            })
            .join('');
    }

    async function load() {
        try {
            const data = await api('/api/batches?limit=50');
            batches = data.items;
            render();
            schedulePoll();
        } catch (err) {
            listEl.innerHTML = `<div class="data-empty"><p>${escapeHtml(err.message)}</p></div>`;
        }
    }

    /** Poll only while something is actually moving. */
    function schedulePoll() {
        clearTimeout(pollTimer);
        const busy = batches.some(
            (b) => b.status === 'creating' || (b.pay_run && b.pay_run.status === 'running')
        );
        if (busy) pollTimer = setTimeout(load, 2000);
    }

    // ============== Run ==============
    listEl.addEventListener('click', async (event) => {
        const runBtn = event.target.closest('[data-run]');
        if (runBtn && !runBtn.disabled) {
            runTarget = batches.find((b) => b._id === runBtn.dataset.run);
            if (!runTarget) return;

            let coverage = null;
            try {
                const detail = await api(`/api/batches/${runTarget._id}`);
                coverage = detail.card_coverage;
            } catch (err) {
                /* fall back to a generic warning */
            }

            runSub.textContent = `${runTarget.payable} payment${
                runTarget.payable === 1 ? '' : 's'
            } in ${runTarget.file_name} will be paid with their stored cards, one at a time.`;

            const missing =
                coverage && coverage.payable > coverage.with_card
                    ? coverage.payable - coverage.with_card
                    : 0;
            runWarning.innerHTML = missing
                ? `<strong>${missing}</strong> of these have no stored card and will be skipped.`
                : 'Each payment is charged once. Rows that fail are left unpaid and can be retried.';

            runError.hidden = true;
            openModal(runModal);
            return;
        }

        const stopBtn = event.target.closest('[data-stop]');
        if (stopBtn) {
            try {
                await api(`/api/batches/${stopBtn.dataset.stop}/stop`, {
                    method: 'POST',
                    body: JSON.stringify({}),
                });
                showToast('Stopping after the current payment.');
                load();
            } catch (err) {
                showToast(err.message, 'error');
            }
            return;
        }

        const delBtn = event.target.closest('[data-delete]');
        if (delBtn && !delBtn.disabled) {
            deleteTarget = batches.find((b) => b._id === delBtn.dataset.delete);
            if (!deleteTarget) return;
            deleteSub.textContent = `${deleteTarget.file_name} — this cancels every unpaid intent at Airwallex and removes all ${deleteTarget.payments} payment records.`;
            deleteBody.innerHTML = deleteTarget.paid
                ? `<label class="upsert-toggle">
                       <input type="checkbox" id="delete-force">
                       <span class="checkbox-custom"></span>
                       <span><strong>${deleteTarget.paid}</strong> of these were paid. Deleting removes the only record that money moved — tick to delete anyway.</span>
                   </label>`
                : '';
            deleteError.hidden = true;
            openModal(deleteModal);
        }
    });

    runConfirm.addEventListener('click', async () => {
        if (!runTarget) return;
        setLoading(runConfirm, true, 'Starting…');
        runError.hidden = true;
        try {
            await api(`/api/batches/${runTarget._id}/run`, {
                method: 'POST',
                body: JSON.stringify({ headless: runHeadless.checked }),
            });
            closeModal(runModal);
            showToast('Payment run started.');
            load();
        } catch (err) {
            runError.textContent = err.message;
            runError.hidden = false;
        } finally {
            setLoading(runConfirm, false);
        }
    });

    deleteConfirm.addEventListener('click', async () => {
        if (!deleteTarget) return;
        const force = document.getElementById('delete-force');
        setLoading(deleteConfirm, true, 'Deleting…');
        deleteError.hidden = true;
        try {
            const result = await api(
                `/api/batches/${deleteTarget._id}?force=${!!(force && force.checked)}`,
                { method: 'DELETE' }
            );
            closeModal(deleteModal);
            showToast(
                `${result.payments_deleted} payments removed, ${result.cancelled} cancelled at Airwallex.`
            );
            load();
        } catch (err) {
            deleteError.textContent = err.message;
            deleteError.hidden = false;
        } finally {
            setLoading(deleteConfirm, false);
        }
    });

    document.getElementById('refresh-btn').addEventListener('click', load);

    load();
})();
