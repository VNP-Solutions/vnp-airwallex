(() => {
    // ============== Palette / icons ==============
    const AVATAR_PALETTE = [
        ['#FFD200', '#E0B500'],
        ['#6FA8FF', '#3D7BD9'],
        ['#4CD295', '#1F8C5A'],
        ['#FF8A65', '#D2553A'],
        ['#B084EF', '#7C50C4'],
        ['#F5A623', '#C97F11'],
        ['#7FE3B5', '#4CD295'],
        ['#FF6B8E', '#D2456B'],
    ];

    const ICONS = {
        check: '<svg viewBox="0 0 16 16"><path d="M3 8L7 12L13 5"/></svg>',
        cross: '<svg viewBox="0 0 16 16"><path d="M4 4L12 12M12 4L4 12"/></svg>',
        emptyUsers: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    };

    // ============== DOM ==============
    const tbody = document.getElementById('users-tbody');
    const paginationEl = document.getElementById('users-pagination');
    const statusTabs = document.getElementById('status-tabs');
    const searchEl = document.getElementById('search');
    const searchInput = document.getElementById('search-input');
    const toastEl = document.getElementById('toast');

    const addBtn = document.getElementById('add-user-btn');
    const inviteBtn = document.getElementById('invite-user-btn');
    const addModal = document.getElementById('add-modal');
    const inviteModal = document.getElementById('invite-modal');
    const revokeModal = document.getElementById('revoke-modal');
    const addForm = document.getElementById('add-form');
    const inviteForm = document.getElementById('invite-form');
    const addSubmit = document.getElementById('add-submit');
    const inviteSubmit = document.getElementById('invite-submit');
    const revokeSubmit = document.getElementById('revoke-submit');
    const revokeName = document.getElementById('revoke-name');
    const addError = document.getElementById('add-error');
    const inviteError = document.getElementById('invite-error');
    const revokeError = document.getElementById('revoke-error');

    // ============== State ==============
    const PAGE_SIZE = 25;
    let currentUsers = [];
    let totalUsers = 0;
    let currentPage = 1;
    let searchQuery = '';
    let statusFilter = '';
    let loadSeq = 0;
    let currentUserId = null;
    let revokeTargetId = null;

    // ============== Auth ==============
    function getToken() {
        return localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    }
    function authHeaders() {
        return { Authorization: `Bearer ${getToken()}` };
    }

    currentUserId =
        localStorage.getItem('auth_user_id') ||
        sessionStorage.getItem('auth_user_id') ||
        null;

    // ============== Helpers ==============
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function formatDate(value) {
        if (!value) return '—';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}/${m}/${day}`;
    }

    function fullName(user) {
        return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.email;
    }

    function initials(name) {
        return String(name || '?')
            .split(/\s+/)
            .map((p) => p[0])
            .filter(Boolean)
            .slice(0, 2)
            .join('')
            .toUpperCase() || '?';
    }

    function avatarFor(name) {
        const hash = Array.from(name || '?').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const palette = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
        return `linear-gradient(135deg, ${palette[0]} 0%, ${palette[1]} 100%)`;
    }

    // ============== Toast ==============
    let toastTimer;
    function showToast(kind, message) {
        clearTimeout(toastTimer);
        toastEl.className = `toast ${kind}`;
        toastEl.querySelector('.toast-icon').innerHTML = kind === 'success' ? ICONS.check : ICONS.cross;
        toastEl.querySelector('.toast-text').textContent = message;
        toastEl.hidden = false;
        // eslint-disable-next-line no-unused-expressions
        toastEl.offsetHeight;
        toastEl.classList.add('visible');
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            setTimeout(() => { toastEl.hidden = true; }, 300);
        }, 4500);
    }

    // ============== Skeleton ==============
    function renderSkeleton(rows = 6) {
        const widths = [70, 40, 50, 60, 30];
        let html = '';
        for (let i = 0; i < rows; i++) {
            html += `<tr class="skeleton-row" style="animation-delay:${i * 40}ms">${
                widths.map((w) => `<td><div class="skel-pill" style="width:${w}%"></div></td>`).join('')
            }</tr>`;
        }
        tbody.innerHTML = html;
    }

    // ============== Render ==============
    function renderRows(users) {
        if (!users.length) {
            const msg = searchQuery || statusFilter
                ? 'No users match these filters.'
                : 'No users yet. Add or invite someone to get started.';
            tbody.innerHTML = `
                <tr><td colspan="5">
                    <div class="users-empty">
                        <div class="empty-icon">${ICONS.emptyUsers}</div>
                        <div>${msg}</div>
                    </div>
                </td></tr>`;
            return;
        }
        tbody.innerHTML = '';
        const frag = document.createDocumentFragment();
        users.forEach((user, i) => {
            const tr = document.createElement('tr');
            tr.style.animationDelay = `${Math.min(i * 28, 320)}ms`;
            const name = fullName(user);
            const isYou = currentUserId && String(user._id) === String(currentUserId);
            const inv = user.invited_by;
            const inviterDisplay = (() => {
                if (!inv) return '<span class="user-meta">Manually added</span>';
                if (typeof inv === 'string') return '<span class="user-meta">—</span>';
                const inviter = [inv.first_name, inv.last_name].filter(Boolean).join(' ').trim() || inv.email || 'User';
                return `<span class="user-meta">${escapeHtml(inviter)}</span>`;
            })();
            const status = user.status || 'active';

            // Action: revoke (or "—" if you, or "Revoked" if already)
            let actionsHtml;
            if (status === 'revoked') {
                actionsHtml = '<span class="action-meta">Revoked</span>';
            } else if (isYou) {
                actionsHtml = '<span class="action-meta">That\'s you</span>';
            } else {
                actionsHtml = `<button class="action-link" data-action="revoke" data-id="${user._id}">Revoke</button>`;
            }

            tr.innerHTML = `
                <td class="col-user">
                    <div class="user-cell">
                        <div class="user-avatar-circle" style="background:${avatarFor(name)}">${initials(name)}</div>
                        <div class="user-stack">
                            <div class="user-name">${escapeHtml(name)}${isYou ? '<span class="user-you">You</span>' : ''}</div>
                            <div class="user-email">${escapeHtml(user.email || '')}</div>
                        </div>
                    </div>
                </td>
                <td><span class="user-status ${status}">${status}</span></td>
                <td><span class="user-meta">${escapeHtml(formatDate(user.created_at))}</span></td>
                <td>${inviterDisplay}</td>
                <td class="col-actions"><div class="actions">${actionsHtml}</div></td>
            `;
            frag.appendChild(tr);
        });
        tbody.appendChild(frag);
    }

    function buildPageList(current, total) {
        const set = new Set([1, total, current - 1, current, current + 1]);
        const valid = [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
        const out = [];
        for (let i = 0; i < valid.length; i++) {
            if (i > 0 && valid[i] - valid[i - 1] > 1) out.push('...');
            out.push(valid[i]);
        }
        return out;
    }

    function renderPagination() {
        const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        if (totalUsers === 0) {
            paginationEl.hidden = true;
            paginationEl.innerHTML = '';
            return;
        }
        paginationEl.hidden = false;
        const startNum = (currentPage - 1) * PAGE_SIZE + 1;
        const endNum = Math.min(currentPage * PAGE_SIZE, totalUsers);
        const pages = buildPageList(currentPage, totalPages);
        const pageBtns = pages.map((p) => {
            if (p === '...') return '<span class="page-dots">…</span>';
            const cls = p === currentPage ? ' active' : '';
            return `<button class="page-btn${cls}" data-page="${p}">${p}</button>`;
        }).join('');
        paginationEl.innerHTML = `
            <div class="pagination-info">Showing ${startNum}–${endNum} of ${totalUsers}</div>
            <div class="pagination-controls">
                <button class="page-btn" data-action="prev" ${currentPage <= 1 ? 'disabled' : ''} aria-label="Previous">‹</button>
                ${pageBtns}
                <button class="page-btn" data-action="next" ${currentPage >= totalPages ? 'disabled' : ''} aria-label="Next">›</button>
            </div>
        `;
    }

    paginationEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.page-btn');
        if (!btn || btn.disabled) return;
        const totalPages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
        const action = btn.dataset.action;
        if (action === 'prev') { if (currentPage <= 1) return; currentPage--; }
        else if (action === 'next') { if (currentPage >= totalPages) return; currentPage++; }
        else if (btn.dataset.page) {
            const n = Number(btn.dataset.page);
            if (n === currentPage) return;
            currentPage = n;
        } else return;
        loadUsers();
    });

    // ============== Load ==============
    async function loadUsers() {
        const seq = ++loadSeq;
        tbody.style.opacity = currentUsers.length ? '0.55' : '1';
        try {
            const params = new URLSearchParams();
            params.set('limit', String(PAGE_SIZE));
            params.set('skip', String((currentPage - 1) * PAGE_SIZE));
            if (searchQuery) params.set('q', searchQuery);
            if (statusFilter) params.set('status', statusFilter);

            const res = await fetch(`/api/users?${params}`, { headers: authHeaders() });
            if (res.status === 401) { window.location.replace('/login'); return; }
            const data = await res.json();
            if (seq !== loadSeq) return;

            if (data.total > 0 && (data.items || []).length === 0 && currentPage > 1) {
                currentPage = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
                return loadUsers();
            }

            currentUsers = data.items || [];
            totalUsers = data.total || 0;
            renderRows(currentUsers);
            renderPagination();
        } catch (e) {
            console.error(e);
            showToast('error', 'Could not load users.');
        } finally {
            if (seq === loadSeq) tbody.style.opacity = '1';
        }
    }

    // ============== Search ==============
    let searchDebounce;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchEl.classList.add('loading');
        searchDebounce = setTimeout(async () => {
            const next = searchInput.value.trim();
            if (next === searchQuery) {
                searchEl.classList.remove('loading');
                return;
            }
            searchQuery = next;
            currentPage = 1;
            try { await loadUsers(); }
            finally { searchEl.classList.remove('loading'); }
        }, 250);
    });

    // ============== Status filter ==============
    statusTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-status]');
        if (!btn) return;
        const next = btn.dataset.status || '';
        if (next === statusFilter) return;
        statusFilter = next;
        statusTabs.querySelectorAll('.status-tab').forEach((t) => {
            t.classList.toggle('active', t === btn);
        });
        currentPage = 1;
        loadUsers();
    });

    // ============== Modal helpers ==============
    function openModal(el) {
        el.hidden = false;
        // eslint-disable-next-line no-unused-expressions
        el.offsetHeight;
        el.classList.add('visible');
        document.body.style.overflow = 'hidden';
        // Focus first input if any
        const firstField = el.querySelector('input');
        if (firstField) setTimeout(() => firstField.focus(), 80);
    }
    function closeModal(el) {
        el.classList.remove('visible');
        document.body.style.overflow = '';
        setTimeout(() => {
            el.hidden = true;
            // Clear forms
            const form = el.querySelector('form');
            if (form) form.reset();
            el.querySelectorAll('.form-error').forEach((er) => { er.hidden = true; er.textContent = ''; });
        }, 280);
    }

    function setButtonLoading(btn, loading, originalLabel) {
        const label = btn.querySelector('.btn-label');
        if (loading) {
            btn.classList.add('loading');
            btn.disabled = true;
            if (label && originalLabel != null) btn.dataset.originalLabel = label.textContent;
            if (label) label.textContent = originalLabel || 'Working…';
        } else {
            btn.classList.remove('loading');
            btn.disabled = false;
            if (label && btn.dataset.originalLabel) {
                label.textContent = btn.dataset.originalLabel;
                delete btn.dataset.originalLabel;
            }
        }
    }

    // ============== Add user ==============
    addBtn.addEventListener('click', () => openModal(addModal));
    addModal.querySelectorAll('[data-close="add"]').forEach((el) =>
        el.addEventListener('click', () => closeModal(addModal))
    );
    addModal.addEventListener('click', (e) => {
        if (e.target === addModal) closeModal(addModal);
    });

    addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        addError.hidden = true;
        const fd = new FormData(addForm);
        const body = {
            email: String(fd.get('email') || '').trim(),
            first_name: String(fd.get('first_name') || '').trim(),
            last_name: String(fd.get('last_name') || '').trim(),
            password: String(fd.get('password') || ''),
        };
        if (body.password.length < 8) {
            addError.textContent = 'Password must be at least 8 characters.';
            addError.hidden = false;
            return;
        }
        setButtonLoading(addSubmit, true, 'Creating…');
        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                addError.textContent = data.error || 'Could not add user.';
                addError.hidden = false;
                return;
            }
            closeModal(addModal);
            showToast('success', `${data.first_name} added successfully.`);
            currentPage = 1;
            await loadUsers();
        } catch (err) {
            console.error(err);
            addError.textContent = 'Network error. Please try again.';
            addError.hidden = false;
        } finally {
            setButtonLoading(addSubmit, false);
        }
    });

    // ============== Invite user ==============
    inviteBtn.addEventListener('click', () => openModal(inviteModal));
    inviteModal.querySelectorAll('[data-close="invite"]').forEach((el) =>
        el.addEventListener('click', () => closeModal(inviteModal))
    );
    inviteModal.addEventListener('click', (e) => {
        if (e.target === inviteModal) closeModal(inviteModal);
    });

    inviteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        inviteError.hidden = true;
        const fd = new FormData(inviteForm);
        const body = {
            email: String(fd.get('email') || '').trim(),
            first_name: String(fd.get('first_name') || '').trim(),
            last_name: String(fd.get('last_name') || '').trim(),
        };
        setButtonLoading(inviteSubmit, true, 'Sending…');
        try {
            const res = await fetch('/api/users/invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                inviteError.textContent = data.error || 'Could not send invite.';
                inviteError.hidden = false;
                return;
            }
            closeModal(inviteModal);
            showToast('success', `Invite sent to ${data.email}.`);
            currentPage = 1;
            await loadUsers();
        } catch (err) {
            console.error(err);
            inviteError.textContent = 'Network error. Please try again.';
            inviteError.hidden = false;
        } finally {
            setButtonLoading(inviteSubmit, false);
        }
    });

    // ============== Revoke ==============
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="revoke"]');
        if (!btn) return;
        const id = btn.dataset.id;
        const user = currentUsers.find((u) => String(u._id) === String(id));
        if (!user) return;
        revokeTargetId = id;
        revokeName.textContent = fullName(user);
        revokeError.hidden = true;
        openModal(revokeModal);
    });

    revokeModal.querySelectorAll('[data-close="revoke"]').forEach((el) =>
        el.addEventListener('click', () => closeModal(revokeModal))
    );
    revokeModal.addEventListener('click', (e) => {
        if (e.target === revokeModal) closeModal(revokeModal);
    });

    revokeSubmit.addEventListener('click', async () => {
        if (!revokeTargetId) return;
        revokeError.hidden = true;
        setButtonLoading(revokeSubmit, true, 'Revoking…');
        try {
            const res = await fetch(`/api/users/${revokeTargetId}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                revokeError.textContent = data.error || 'Could not revoke user.';
                revokeError.hidden = false;
                return;
            }
            closeModal(revokeModal);
            showToast('success', 'Access revoked.');
            await loadUsers();
        } catch (err) {
            console.error(err);
            revokeError.textContent = 'Network error. Please try again.';
            revokeError.hidden = false;
        } finally {
            setButtonLoading(revokeSubmit, false);
            revokeTargetId = null;
        }
    });

    // ============== Esc closes any open modal ==============
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        [addModal, inviteModal, revokeModal].forEach((m) => {
            if (!m.hidden) closeModal(m);
        });
    });

    // ============== Init ==============
    renderSkeleton(8);
    loadUsers();
})();