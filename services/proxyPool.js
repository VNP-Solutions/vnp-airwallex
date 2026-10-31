/**
 * A fixed pool of exit IPs for the payment browser, from a Bright Data ISP zone.
 *
 * Airwallex's card element records the IP of the browser filling it in, and the
 * IPs in this pool are the ones whitelisted with Airwallex. So every automated
 * payment — batch or single — goes out through one of them, and never through
 * the server's own address: when the pool is configured, a payment that cannot
 * get through the proxy fails rather than quietly going direct.
 *
 * Rotation is round-robin, moving to the next IP after every
 * BRIGHT_DATA_ROTATE_EVERY payments. The counter is shared by batch runs and
 * single payments, and kept in memory: a restart begins again at the first IP,
 * which is harmless because every IP in the pool is whitelisted.
 *
 * A specific IP is selected with Bright Data's `-ip-x.x.x.x` username suffix,
 * which only works on zones with dedicated IPs — the reason the zone is
 * "Dedicated unlimited".
 */

const DEFAULT_ROTATE_EVERY = 3;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function config() {
    const e = process.env;
    const ips = String(e.BRIGHT_DATA_IPS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const every = Number.parseInt(e.BRIGHT_DATA_ROTATE_EVERY, 10);
    return {
        host: (e.BRIGHT_DATA_HOST || '').trim(),
        port: (e.BRIGHT_DATA_PORT || '').trim(),
        username: (e.BRIGHT_DATA_USERNAME || '').trim(),
        password: e.BRIGHT_DATA_PASSWORD || '',
        ips,
        rotateEvery: Number.isFinite(every) && every > 0 ? every : DEFAULT_ROTATE_EVERY,
    };
}

/** Whether a pool is set up. None of it set means "no proxy"; half set is an error. */
function enabled() {
    const c = config();
    return Boolean(c.host || c.port || c.username || c.password || c.ips.length);
}

/**
 * Refuse a half-configured pool loudly. Running a payment through the server's
 * own IP because one setting was missing would defeat the whitelisting without
 * anyone noticing.
 */
function assertConfigured() {
    const c = config();
    const missing = ['host', 'port', 'username', 'password'].filter((k) => !c[k]);
    if (!c.ips.length) missing.push('ips');
    if (missing.length) {
        throw proxyError(
            `The proxy pool is only partly configured — missing BRIGHT_DATA_${missing
                .map((m) => m.toUpperCase())
                .join(', BRIGHT_DATA_')}`
        );
    }
    const bad = c.ips.filter((ip) => {
        const m = IPV4.exec(ip);
        return !m || m.slice(1).some((n) => Number(n) > 255);
    });
    if (bad.length) throw proxyError(`BRIGHT_DATA_IPS contains invalid addresses: ${bad.join(', ')}`);
    return c;
}

function proxyError(message) {
    const err = new Error(message);
    err.statusCode = 500;
    err.proxy = true;
    return err;
}

// ============== Rotation ==============

let cursor = 0; // index into the pool
let usedOnCurrent = 0; // payments sent through the current IP

/**
 * The exit for the next payment.
 *
 * Returns the proxy server for the browser and the credentials that pin this
 * payment to one IP. Advances the rotation as a side effect, so call it once
 * per payment attempt.
 */
function next() {
    const c = assertConfigured();
    if (cursor >= c.ips.length) cursor = 0; // the pool shrank since last time
    if (usedOnCurrent >= c.rotateEvery) {
        cursor = (cursor + 1) % c.ips.length;
        usedOnCurrent = 0;
    }
    usedOnCurrent += 1;

    return exitFor(c, c.ips[cursor], cursor, usedOnCurrent);
}

function exitFor(c, ip, index, useCount = 0) {
    return {
        ip,
        index,
        poolSize: c.ips.length,
        useCount,
        rotateEvery: c.rotateEvery,
        server: `http://${c.host}:${c.port}`,
        credentials: { username: `${c.username}-ip-${ip}`, password: c.password },
    };
}

/** Where rotation stands, for logs and the admin view. */
function status() {
    if (!enabled()) return { enabled: false };
    const c = config();
    return {
        enabled: true,
        pool_size: c.ips.length,
        rotate_every: c.rotateEvery,
        current_ip: c.ips[cursor % Math.max(c.ips.length, 1)] || null,
        used_on_current: usedOnCurrent,
    };
}

// ============== Per-IP location ==============

const http = require('http');
const tls = require('tls');

// The timezone each exit IP resolves to. Looked up once per IP and kept: an
// IP's location does not move between payments.
const timezoneByIp = new Map();
const GEO_HOST = 'geo.brdtest.com';
const GEO_PATH = '/mygeo.json';
const FALLBACK_TZ = 'America/New_York';

/**
 * GET a URL through the proxy, pinned to one exit IP: an HTTP CONNECT tunnel,
 * then TLS over it. Plain Node, so it can run before any browser starts.
 */
function getThroughProxy(exit, host, path, timeoutMs = 20000) {
    const [proxyHost, proxyPort] = exit.server.replace(/^https?:\/\//, '').split(':');
    const auth = Buffer.from(`${exit.credentials.username}:${exit.credentials.password}`).toString('base64');

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(proxyError(`Proxy check timed out for ${exit.ip}`)), timeoutMs);
        const done = (fn, value) => {
            clearTimeout(timer);
            fn(value);
        };

        const req = http.request({
            host: proxyHost,
            port: Number(proxyPort),
            method: 'CONNECT',
            path: `${host}:443`,
            headers: { Host: `${host}:443`, 'Proxy-Authorization': `Basic ${auth}` },
        });
        req.on('error', (err) => done(reject, proxyError(`Proxy unreachable for ${exit.ip}: ${err.message}`)));
        req.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                const hint =
                    {
                        407: ' — zone username or password rejected',
                        403: " — this server's IP may not be on the zone's allowlist in Bright Data",
                    }[res.statusCode] || '';
                return done(reject, proxyError(`Proxy refused ${exit.ip}: HTTP ${res.statusCode}${hint}`));
            }
            const secure = tls.connect({ socket, servername: host }, () => {
                secure.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
            });
            let raw = '';
            secure.on('data', (chunk) => (raw += chunk));
            secure.on('end', () => {
                const [head, ...rest] = raw.split('\r\n\r\n');
                const status = Number((head.match(/^HTTP\/1\.\d (\d{3})/) || [])[1]);
                const body = rest.join('\r\n\r\n');
                // Chunked encoding: keep only what lies between the braces.
                const json = body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1);
                done(resolve, { status, body: json });
            });
            secure.on('error', (err) => done(reject, proxyError(`Proxy TLS failed for ${exit.ip}: ${err.message}`)));
        });
        req.end();
    });
}

/**
 * The timezone of an exit IP, for starting the payment browser in.
 *
 * It has to be set on the browser process, not the page: Airwallex's card
 * fields run in their own cross-origin iframes, which ignore a page-level
 * timezone override and report the server's real one — every payment showed
 * the machine's own offset until this. Doubles as a check that the exit works
 * before a browser is even started.
 */
async function timezoneFor(exit) {
    if (timezoneByIp.has(exit.ip)) return timezoneByIp.get(exit.ip);
    const { status, body } = await getThroughProxy(exit, GEO_HOST, GEO_PATH);
    if (status !== 200) throw proxyError(`Proxy check failed for ${exit.ip}: HTTP ${status}`);
    let tz = FALLBACK_TZ;
    try {
        const geo = JSON.parse(body);
        if (geo.geo && geo.geo.tz) tz = geo.geo.tz;
    } catch (e) {
        /* keep the fallback */
    }
    timezoneByIp.set(exit.ip, tz);
    return tz;
}

/**
 * Try every IP in the pool, in parallel, without moving the rotation.
 *
 * Run at startup so a broken zone, a wrong password or a dead IP shows up in
 * the boot log rather than in the first failed payment. It also looks up and
 * caches each IP's timezone, so no payment pays for that lookup later.
 */
async function checkAll() {
    const c = assertConfigured();
    return Promise.all(
        c.ips.map(async (ip, index) => {
            const started = Date.now();
            try {
                const tz = await timezoneFor(exitFor(c, ip, index));
                return { ip, ok: true, tz, ms: Date.now() - started };
            } catch (err) {
                return { ip, ok: false, error: err.message, ms: Date.now() - started };
            }
        })
    );
}

/** Print the pool's health, in the same spirit as the Airwallex boot banner. */
async function logStartupCheck(log = console) {
    if (!enabled()) {
        log.log("Proxy: OFF — automated payments go out from this server's own IP");
        return;
    }

    let results;
    try {
        results = await checkAll();
    } catch (err) {
        // Half-configured: payments will refuse to run, so say why up front.
        log.error(`Proxy: MISCONFIGURED — ${err.message}`);
        log.error('  ** automated payments will be refused until this is fixed **');
        return;
    }

    const c = config();
    const good = results.filter((r) => r.ok);
    const head = `Proxy: ${c.host}:${c.port}  ${good.length}/${results.length} IPs reachable  rotate every ${c.rotateEvery}`;
    (good.length === results.length ? log.log : log.error)(head);

    for (const r of results) {
        const line = r.ok
            ? `  ok    ${r.ip.padEnd(15)}  ${r.tz}  (${r.ms}ms)`
            : `  FAIL  ${r.ip.padEnd(15)}  ${r.error}`;
        (r.ok ? log.log : log.error)(line);
    }

    if (!good.length) {
        log.error('  ** no exit IP works — every automated payment will fail **');
    } else if (good.length < results.length) {
        // A failing IP still takes its turn in the rotation; its payments fail.
        log.error('  ** payments routed to a failing IP will fail — check the zone in Bright Data **');
    }
}

module.exports = { enabled, assertConfigured, next, status, timezoneFor, checkAll, logStartupCheck };
