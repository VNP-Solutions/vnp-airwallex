(() => {
    const SIDEBAR_KEY = 'dashboard_sidebar_collapsed';

    const NAV_ITEMS = [
        {
            key: 'dashboard',
            label: 'Dashboard',
            href: '/dashboard',
            icon: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/></svg>',
        },
        {
            key: 'hotels',
            label: 'Hotels',
            href: '/hotels',
            icon: '<svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5"/></svg>',
        },
        {
            key: 'payments',
            label: 'Payments',
            href: '/payments',
            icon: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
        },
        {
            key: 'users',
            label: 'Users',
            href: '/users',
            icon: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        },
    ];

    // Which nav items should auto-fetch their count badge on init.
    // Each entry's `fetch` returns a Promise<number|null>.
    const BADGE_FETCHERS = {};

    document.addEventListener('DOMContentLoaded', () => {
        const mount = document.querySelector('[data-sidebar-mount]');
        if (!mount) return;
        const activeKey = mount.dataset.active || '';
        mount.outerHTML = renderSidebar(activeKey);
        bind();
    });

    function renderSidebar(activeKey) {
        const navHtml = NAV_ITEMS.map((item) => {
            const isActive = item.key === activeKey;
            return `
                <a href="${item.href}" class="nav-item${isActive ? ' active' : ''}" data-key="${item.key}" title="${item.label}">
                    <span class="nav-icon">${item.icon}</span>
                    <span class="nav-label">${item.label}</span>
                    <span class="nav-badge" data-badge hidden></span>
                </a>`;
        }).join('');

        const { name, initial } = readUserDisplay();

        return `
            <aside class="sidebar">
                <div class="sidebar-header">
                    <div class="sidebar-brand">
                        <img src="/assets/logo.svg" alt="VNP" class="sidebar-logo">
                        <div class="sidebar-mark">V</div>
                    </div>
                    <button class="sidebar-toggle" data-sidebar-toggle aria-label="Collapse sidebar">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M10 4L6 8L10 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                    <button class="sidebar-toggle-floating" data-sidebar-toggle aria-label="Expand sidebar">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </button>
                </div>

                <nav class="sidebar-nav">
                    <div class="nav-section-label">Workspace</div>
                    ${navHtml}
                </nav>

                <div class="sidebar-footer">
                    <div class="user-avatar">${initial}</div>
                    <div class="user-info">
                        <div class="user-name" data-user-name>${name}</div>
                        <div class="user-meta">Signed in</div>
                    </div>
                    <button class="user-logout" data-logout title="Log out" aria-label="Log out">
                        <svg viewBox="0 0 24 24"><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/><path d="M13 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8"/></svg>
                    </button>
                </div>
            </aside>`;
    }

    function setBadge(key, count) {
        const badge = document.querySelector(
            `.nav-item[data-key="${key}"] .nav-badge`
        );
        if (!badge) return;
        if (count == null || count <= 0) {
            badge.hidden = true;
            badge.textContent = '';
        } else {
            badge.hidden = false;
            badge.textContent = String(count);
        }
    }

    // Expose for pages to push counts after CRUD changes
    window.updateSidebarBadge = setBadge;

    function readUserDisplay() {
        const first =
            localStorage.getItem('auth_first_name') ||
            sessionStorage.getItem('auth_first_name') ||
            '';
        const last =
            localStorage.getItem('auth_last_name') ||
            sessionStorage.getItem('auth_last_name') ||
            '';

        const full = [first, last].filter(Boolean).join(' ').trim();
        const name = full || 'My Account';
        const initial = (first[0] || full[0] || 'A').toUpperCase();
        return { name, initial };
    }

    function bind() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;

        // Restore persisted collapsed state without animating on first paint.
        const wasCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
        if (wasCollapsed) {
            sidebar.classList.add('collapsed', 'no-transition');
            requestAnimationFrame(() => sidebar.classList.remove('no-transition'));
        }

        document.querySelectorAll('[data-sidebar-toggle]').forEach((btn) => {
            btn.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
                localStorage.setItem(
                    SIDEBAR_KEY,
                    sidebar.classList.contains('collapsed') ? '1' : '0'
                );
            });
        });

        // Kick off badge fetchers
        Object.entries(BADGE_FETCHERS).forEach(async ([key, fetcher]) => {
            const count = await fetcher();
            if (count != null) setBadge(key, count);
        });

        const logoutBtn = document.querySelector('[data-logout]');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                [
                    'auth_token',
                    'auth_user_id',
                    'auth_first_name',
                    'auth_last_name',
                    'auth_email',
                ].forEach((k) => {
                    localStorage.removeItem(k);
                    sessionStorage.removeItem(k);
                });
                window.location.replace('/login');
            });
        }
    }
})();