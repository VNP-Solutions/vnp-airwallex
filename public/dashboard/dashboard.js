(() => {
    // ============== Status palette (kept in sync with the payments page) ==============
    const STATUS_COLORS = {
        SUCCEEDED: '#4CD295',
        REQUIRES_CAPTURE: '#7FE3B5',
        REQUIRES_PAYMENT_METHOD: '#FFB94B',
        REQUIRES_CUSTOMER_ACTION: '#FFD200',
        PENDING: '#F5A623',
        CANCELLED: '#FF6B6B',
        EXPIRED: '#FF8A65',
        FAILED: '#EF5350',
    };

    const FALLBACK_PALETTE = ['#6FA8FF', '#B084EF', '#7FE3B5', '#FFD200', '#FF8A65', '#9CA3B0'];
    const FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

    // ============== DOM ==============
    const periodTabs = document.getElementById('period-tabs');
    const statsGrid = document.getElementById('stats-grid');
    const toastEl = document.getElementById('toast');

    // ============== State ==============
    let currentPeriod = 'all';
    let statsSeq = 0;
    let analyticsSeq = 0;
    let chartDaily = null;
    let chartPortfolio = null;
    let chartStatus = null;
    let hiddenSeries = new Set();

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

    const firstName =
        localStorage.getItem('auth_first_name') ||
        sessionStorage.getItem('auth_first_name') ||
        '';
    if (firstName) {
        const subtitle = document.getElementById('page-subtitle');
        if (subtitle) {
            subtitle.textContent = `Welcome back, ${firstName}. VNP <> Airwallex integration console.`;
        }
    }

    // ============== Formatting ==============
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(
            /[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
        );
    }

    function formatNumber(n) {
        if (n == null || Number.isNaN(Number(n))) return '0';
        return Number(n).toLocaleString();
    }

    function formatAmount(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '0.00';
        return n.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    }

    function formatCompact(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '0';
        if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
        return n.toFixed(0);
    }

    function statusLabel(status) {
        return String(status || '')
            .toLowerCase()
            .replace(/_/g, ' ')
            .replace(/^./, (c) => c.toUpperCase());
    }

    function colorForStatus(status, index) {
        return (
            STATUS_COLORS[status] || FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]
        );
    }

    // ============== Toast ==============
    let toastTimer;
    function showToast(kind, message) {
        if (!toastEl) return;
        clearTimeout(toastTimer);
        toastEl.className = `toast ${kind}`;
        toastEl.querySelector('.toast-text').textContent = message;
        toastEl.hidden = false;
        toastEl.offsetHeight;
        toastEl.classList.add('visible');
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            setTimeout(() => {
                toastEl.hidden = true;
            }, 300);
        }, 4500);
    }

    // ============== Period tabs ==============
    periodTabs.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-period]');
        if (!btn || btn.dataset.period === currentPeriod) return;
        periodTabs.querySelectorAll('.period-tab').forEach((t) => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        currentPeriod = btn.dataset.period;
        refreshAll();
    });

    // ============== Stats ==============
    function renderStatsSkeleton() {
        statsGrid.innerHTML = Array.from({ length: 4 })
            .map(() => '<div class="stat-card stat-skeleton"></div>')
            .join('');
    }

    function renderStats(stats, userTotal) {
        const byStatus = stats.by_status || {};
        const awaiting =
            (byStatus.REQUIRES_PAYMENT_METHOD || 0) +
            (byStatus.REQUIRES_CUSTOMER_ACTION || 0) +
            (byStatus.PENDING || 0);
        const captured = stats.captured || [];

        const successRate = stats.total
            ? ((stats.succeeded / stats.total) * 100).toFixed(1)
            : '0.0';

        statsGrid.innerHTML = `
            <div class="stat-card">
                <div class="stat-label">Payments</div>
                <div class="stat-value">${formatNumber(stats.total)}</div>
                <div class="stat-hint">${formatNumber(stats.succeeded)} succeeded · ${successRate}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Awaiting payment</div>
                <div class="stat-value">${formatNumber(awaiting)}</div>
                <div class="stat-hint">not yet completed</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Captured</div>
                ${
                    captured.length
                        ? `<div class="currency-list">${captured
                              .map(
                                  (c) => `
                            <div class="currency-row">
                                <span class="currency-code">${escapeHtml(c.currency)}</span>
                                <span class="currency-amount">${formatAmount(c.amount)}</span>
                                <span class="currency-count">${formatNumber(c.count)}</span>
                            </div>`
                              )
                              .join('')}</div>`
                        : '<div class="stat-value" style="font-size:15px;color:rgba(255,255,255,0.4)">Nothing captured yet</div>'
                }
            </div>
            <div class="stat-card">
                <div class="stat-label">Users</div>
                <div class="stat-value">${userTotal == null ? '—' : formatNumber(userTotal)}</div>
                <div class="stat-hint">with workspace access</div>
            </div>
        `;
    }

    async function loadStats() {
        const seq = ++statsSeq;
        try {
            const [statsRes, usersRes] = await Promise.all([
                fetch(`/api/payments/stats?period=${currentPeriod}`, { headers: authHeaders() }),
                fetch('/api/users?limit=1', { headers: authHeaders() }),
            ]);
            if (statsRes.status === 401) {
                window.location.replace('/login');
                return;
            }
            if (!statsRes.ok) throw new Error('stats request failed');
            const stats = await statsRes.json();
            const users = usersRes.ok ? await usersRes.json() : null;
            if (seq !== statsSeq) return;
            renderStats(stats, users ? users.total : null);
        } catch (err) {
            console.error(err);
            if (seq === statsSeq) showToast('error', 'Could not load stats.');
        }
    }

    // ============== Analytics ==============
    async function loadAnalytics() {
        const seq = ++analyticsSeq;
        try {
            const res = await fetch(`/api/payments/analytics?period=${currentPeriod}`, {
                headers: authHeaders(),
            });
            if (res.status === 401) {
                window.location.replace('/login');
                return;
            }
            if (!res.ok) throw new Error('analytics request failed');
            const data = await res.json();
            if (seq !== analyticsSeq) return;
            renderDailyChart(data.daily_amounts || []);
            renderPortfolioChart(data.by_portfolio || {});
            renderStatusChart(data.by_status || {});
        } catch (err) {
            console.error(err);
            if (seq === analyticsSeq) showToast('error', 'Could not load chart data.');
        }
    }

    // ============== Daily area chart ==============
    function renderDailyChart(daily) {
        const empty = document.getElementById('chart-empty-daily');
        const legendEl = document.getElementById('legend-daily');
        const el = document.getElementById('chart-daily');
        if (!el) return;

        if (!daily.length) {
            if (chartDaily) {
                chartDaily.destroy();
                chartDaily = null;
            }
            el.innerHTML = '';
            el.style.opacity = '0';
            empty.hidden = false;
            legendEl.innerHTML = '';
            return;
        }
        empty.hidden = true;
        el.style.opacity = '1';

        // Series are whichever statuses actually occur in this period, so the
        // legend never advertises outcomes that never happened.
        const statuses = Array.from(
            new Set(daily.flatMap((d) => Object.keys(d).filter((k) => k !== 'date')))
        ).sort();

        const categories = daily.map((d) => d.date);
        const series = statuses.map((status, i) => ({
            name: statusLabel(status),
            color: colorForStatus(status, i),
            data: daily.map((d) => Number(d[status] || 0)),
        }));

        const options = {
            chart: {
                type: 'area',
                height: 320,
                stacked: true,
                background: 'transparent',
                fontFamily: FONT,
                foreColor: 'rgba(255, 255, 255, 0.55)',
                toolbar: { show: false },
                zoom: { enabled: false },
                animations: {
                    enabled: true,
                    easing: 'easeinout',
                    speed: 800,
                    animateGradually: { enabled: true, delay: 130 },
                    dynamicAnimation: { enabled: true, speed: 400 },
                },
            },
            theme: { mode: 'dark' },
            colors: series.map((s) => s.color),
            series,
            stroke: { curve: 'smooth', width: 2.5, lineCap: 'round' },
            fill: {
                type: 'gradient',
                gradient: {
                    shadeIntensity: 1,
                    type: 'vertical',
                    opacityFrom: 0.32,
                    opacityTo: 0,
                    stops: [0, 100],
                },
            },
            grid: {
                borderColor: 'rgba(255, 255, 255, 0.045)',
                strokeDashArray: 0,
                xaxis: { lines: { show: false } },
                yaxis: { lines: { show: true } },
                padding: { left: 8, right: 16, top: 4, bottom: 0 },
            },
            xaxis: {
                categories,
                labels: {
                    style: {
                        colors: 'rgba(255,255,255,0.4)',
                        fontSize: '11px',
                        fontFamily: FONT,
                    },
                    rotate: 0,
                    hideOverlappingLabels: true,
                },
                axisBorder: { show: false },
                axisTicks: { show: false },
                crosshairs: {
                    show: true,
                    stroke: { color: 'rgba(255, 210, 0, 0.4)', width: 1, dashArray: 0 },
                },
                tooltip: { enabled: false },
            },
            yaxis: {
                labels: {
                    style: {
                        colors: 'rgba(255,255,255,0.4)',
                        fontSize: '11px',
                        fontFamily: FONT,
                    },
                    formatter: (v) => formatCompact(v),
                },
            },
            dataLabels: { enabled: false },
            markers: {
                size: 0,
                strokeWidth: 2,
                strokeColors: '#0F1B33',
                hover: { size: 6, sizeOffset: 0 },
            },
            legend: { show: false },
            tooltip: {
                theme: 'dark',
                shared: true,
                intersect: false,
                followCursor: false,
                x: { show: true },
                y: { formatter: (v) => formatAmount(v) },
                marker: { show: true },
                style: { fontFamily: FONT, fontSize: '12px' },
            },
            states: {
                hover: { filter: { type: 'none' } },
                active: { filter: { type: 'none' } },
            },
        };

        if (chartDaily) {
            chartDaily.updateOptions(
                { xaxis: { categories }, colors: series.map((s) => s.color) },
                false,
                true
            );
            chartDaily.updateSeries(series);
        } else {
            chartDaily = new ApexCharts(el, options);
            chartDaily.render();
        }

        // Clickable legend that toggles each series.
        legendEl.innerHTML = series
            .map(
                (s) => `
                <span class="chart-legend-item${hiddenSeries.has(s.name) ? ' muted' : ''}" data-series="${escapeHtml(
                    s.name
                )}">
                    <span class="chart-legend-swatch" style="background:${s.color}"></span>
                    ${escapeHtml(s.name)}
                </span>`
            )
            .join('');

        // Re-apply hidden state after a re-render, otherwise toggles reset on
        // every period change.
        hiddenSeries.forEach((name) => {
            if (series.some((s) => s.name === name)) chartDaily.hideSeries(name);
        });

        legendEl.querySelectorAll('.chart-legend-item').forEach((item) => {
            item.addEventListener('click', () => {
                const name = item.dataset.series;
                chartDaily.toggleSeries(name);
                if (hiddenSeries.has(name)) hiddenSeries.delete(name);
                else hiddenSeries.add(name);
                item.classList.toggle('muted');
            });
        });
    }

    // ============== Donuts ==============
    function renderPortfolioChart(byPortfolio) {
        const keys = Object.keys(byPortfolio).sort((a, b) => byPortfolio[b] - byPortfolio[a]);
        renderDonut({
            elId: 'chart-portfolio',
            centerId: 'center-portfolio',
            legendId: 'legend-portfolio',
            emptyId: 'chart-empty-portfolio',
            entries: byPortfolio,
            order: keys,
            labels: keys.reduce((acc, k) => {
                acc[k] = k;
                return acc;
            }, {}),
            colors: keys.reduce((acc, k, i) => {
                acc[k] = FALLBACK_PALETTE[i % FALLBACK_PALETTE.length];
                return acc;
            }, {}),
            getExisting: () => chartPortfolio,
            setExisting: (c) => {
                chartPortfolio = c;
            },
        });
    }

    function renderStatusChart(byStatus) {
        const keys = Object.keys(byStatus).sort((a, b) => byStatus[b] - byStatus[a]);
        renderDonut({
            elId: 'chart-status',
            centerId: 'center-status',
            legendId: 'legend-status',
            emptyId: 'chart-empty-status',
            entries: byStatus,
            order: keys,
            labels: keys.reduce((acc, k) => {
                acc[k] = statusLabel(k);
                return acc;
            }, {}),
            colors: keys.reduce((acc, k, i) => {
                acc[k] = colorForStatus(k, i);
                return acc;
            }, {}),
            getExisting: () => chartStatus,
            setExisting: (c) => {
                chartStatus = c;
            },
        });
    }

    function renderDonut({
        elId,
        centerId,
        legendId,
        emptyId,
        entries,
        order,
        labels,
        colors,
        getExisting,
        setExisting,
    }) {
        const el = document.getElementById(elId);
        const centerEl = document.getElementById(centerId);
        const legendEl = document.getElementById(legendId);
        const emptyEl = document.getElementById(emptyId);
        if (!el) return;

        const presentKeys = order.filter((k) => (entries[k] || 0) > 0);
        const total = presentKeys.reduce((sum, k) => sum + entries[k], 0);
        const existing = getExisting();

        if (total === 0) {
            if (existing) {
                existing.destroy();
                setExisting(null);
            }
            el.innerHTML = '';
            el.style.opacity = '0';
            emptyEl.hidden = false;
            centerEl.querySelector('.donut-center-value').textContent = '—';
            legendEl.innerHTML = '';
            return;
        }
        emptyEl.hidden = true;
        el.style.opacity = '1';

        const data = presentKeys.map((k) => entries[k]);
        const displayLabels = presentKeys.map((k) => labels[k] || k);
        const bg = presentKeys.map((k) => colors[k] || '#888');

        const options = {
            chart: {
                type: 'donut',
                height: 200,
                background: 'transparent',
                fontFamily: FONT,
                foreColor: 'rgba(255, 255, 255, 0.55)',
                animations: {
                    enabled: true,
                    easing: 'easeinout',
                    speed: 700,
                    animateGradually: { enabled: true, delay: 80 },
                    dynamicAnimation: { enabled: true, speed: 400 },
                },
            },
            theme: { mode: 'dark' },
            series: data,
            labels: displayLabels,
            colors: bg,
            stroke: { width: 3, colors: ['#0F1B33'], lineCap: 'round' },
            plotOptions: {
                pie: {
                    expandOnClick: false,
                    donut: { size: '70%', background: 'transparent', labels: { show: false } },
                },
            },
            dataLabels: { enabled: false },
            legend: { show: false },
            tooltip: {
                theme: 'dark',
                y: {
                    formatter(value, { w }) {
                        const sum = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                        const pct = sum > 0 ? ((value / sum) * 100).toFixed(1) : 0;
                        return `${formatNumber(value)} <span style="opacity:0.65; font-weight:400">(${pct}%)</span>`;
                    },
                    title: { formatter: (name) => name },
                },
                style: { fontFamily: FONT, fontSize: '12px' },
            },
            states: {
                hover: { filter: { type: 'lighten', value: 0.05 } },
                active: { filter: { type: 'none' } },
            },
        };

        if (existing) {
            existing.updateOptions({ labels: displayLabels, colors: bg }, false, true);
            existing.updateSeries(data);
        } else {
            const chart = new ApexCharts(el, options);
            chart.render();
            setExisting(chart);
        }

        centerEl.querySelector('.donut-center-value').textContent = formatNumber(total);

        legendEl.innerHTML = presentKeys
            .map((key) => {
                const count = entries[key];
                const pct = ((count / total) * 100).toFixed(1);
                return `
                    <div class="donut-legend-item">
                        <span class="donut-legend-swatch" style="background:${colors[key]}"></span>
                        <span class="donut-legend-label">${escapeHtml(labels[key] || key)}</span>
                        <span class="donut-legend-value">${formatNumber(count)} · ${pct}%</span>
                    </div>`;
            })
            .join('');
    }

    // ============== Init ==============
    async function refreshAll() {
        statsGrid.style.opacity = '0.5';
        await Promise.all([loadStats(), loadAnalytics()]);
        statsGrid.style.opacity = '1';
    }

    renderStatsSkeleton();
    refreshAll();
})();
