const portal = require('../services/accessPortalService');
const session = require('../services/sessionService');
const { bearer } = require('../middleware/authMiddleware');

/**
 * The VNP Access Portal contract, under /api/access-portal/v1.
 *
 * Responses follow the shapes in the portal's handoff guide. Errors carry a
 * `code` where the portal acts on it (EMAIL_EXISTS, INVITATION_PENDING): the
 * app's global error handler only returns `error`, so these routes answer
 * their own failures rather than passing them on and losing the code.
 */

/**
 * Every reply is in the VNP envelope, { success, message, data } — the shape the
 * portal's single connector reads from DBMS and Dashboard. `error` and `code`
 * are kept alongside on failures because the guide names them.
 *
 * `flat` also spreads the data at the top level. Login, refresh and /auth/me are
 * documented with their fields at the top; sending both satisfies a connector
 * that reads either.
 */
function ok(res, data, { status = 200, message = 'OK', flat = false } = {}) {
    return res.status(status).json({
        success: true,
        message,
        data,
        ...(flat && data && typeof data === 'object' ? data : {}),
    });
}

function fail(res, next, err) {
    if (err && err.statusCode && err.statusCode < 500) {
        return res.status(err.statusCode).json({
            success: false,
            message: err.message,
            error: err.message,
            data: null,
            ...(err.code ? { code: err.code } : {}),
        });
    }
    return next(err);
}

const wrap = (fn) => async (req, res, next) => {
    try {
        await fn(req, res, next);
    } catch (err) {
        fail(res, next, err);
    }
};

// ============== Auth ==============

const login = wrap(async (req, res) => {
    const { email, password } = req.body || {};
    ok(res, await portal.login({ email, password }), { flat: true });
});

const refresh = wrap(async (req, res) => {
    ok(res, await portal.refresh({ refresh_token: (req.body || {}).refresh_token }), { flat: true });
});

/** Carries the PERSON's access token, not the service token. */
const me = wrap(async (req, res) => {
    ok(res, await portal.me(bearer(req)), { flat: true });
});

// ============== Handoff ==============

const log = (trace, message) => console.log(`[access-portal] trace=${trace} ${message}`);

function htmlPage(title, message) {
    const esc = (s) =>
        String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — VNP &lt;&gt; AIRWALLEX</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0B1730;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
main{max-width:440px;padding:32px;border-radius:16px;background:#12223F;border:1px solid rgba(255,255,255,.08)}
h1{font-size:19px;margin:0 0 10px}p{margin:0;line-height:1.55;color:rgba(255,255,255,.75);font-size:14px}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
}

/**
 * The tab the portal opens. Redeems nothing: it forwards the code to this
 * system's own frontend, in the URL FRAGMENT, which no browser sends to a
 * server or puts in a Referer. The cookies are set later, on a request the
 * frontend makes, so they land under the frontend's site.
 */
function handoffGet(req, res) {
    const trace = portal.traceId();
    res.set('Cache-Control', 'no-store');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    log(trace, `GET code_present=${Boolean(code)} code_length=${code.length}`);

    if (!portal.portalConfigured() || !session.frontendUrl()) {
        log(trace, 'GET refused: access portal not configured');
        return res
            .status(503)
            .type('html')
            .send(htmlPage('Sign-in from the portal is not set up', 'This system is not configured for the Access Portal yet. Ask an administrator to finish setting it up.'));
    }
    if (!code) {
        return res
            .status(400)
            .type('html')
            .send(htmlPage('This link is missing its sign-in code', 'Open this system again from the Access Portal.'));
    }

    const target = `${session.frontendUrl()}/auth/handoff#code=${encodeURIComponent(code)}`;
    log(trace, 'GET 303 -> frontend /auth/handoff');
    return res.redirect(303, target);
}

/**
 * Called by this system's own handoff page with the code. Redeems it with the
 * portal, turns the refresh token it returns into a session, and sets the
 * cookies on this response — which the browser files under the frontend.
 *
 * Every failure answers with its own reason. None redirects to the login page:
 * that would make an expired link, a wrong secret and a cookie problem look
 * identical.
 */
async function handoffPost(req, res, next) {
    const trace = portal.traceId();
    res.set('Cache-Control', 'no-store');
    const portalUrl = process.env.ACCESS_PORTAL_URL || null;
    const reply = (status, code, error) => {
        log(trace, `POST ${status} ${code}`);
        return res.status(status).json({
            success: false,
            message: error,
            error,
            code,
            data: null,
            ...(portalUrl ? { portal_url: portalUrl } : {}),
        });
    };

    try {
        // Login CSRF: without this any site could post a stolen code and sign
        // its visitor in as someone else.
        if (!session.isAllowedOrigin(req)) {
            return reply(403, 'ORIGIN_NOT_ALLOWED', 'This sign-in request did not come from this system.');
        }
        if (portal.rateLimited(req.ip)) {
            return reply(429, 'RATE_LIMITED', 'Too many sign-in attempts — wait a minute and try again.');
        }
        if (!portal.portalConfigured()) {
            return reply(503, 'NOT_CONFIGURED', 'This system is not configured for the Access Portal yet.');
        }

        const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
        log(trace, `POST code_present=${Boolean(code)} code_length=${code.length}`);
        if (!code) {
            return reply(400, 'CODE_MISSING', 'This link is missing its sign-in code — open the system again from the portal.');
        }

        const redeemed = await portal.redeem(code);
        log(trace, `redeem outcome=${redeemed.outcome}${redeemed.status ? ` status=${redeemed.status}` : ''}`);

        if (redeemed.outcome === 'code_rejected') {
            return reply(400, 'CODE_EXPIRED', 'This link has expired or was already used — open the system again from the portal.');
        }
        if (redeemed.outcome === 'secret_rejected') {
            return reply(502, 'HANDOFF_SECRET_REJECTED', "The portal didn't recognise this system. An administrator needs to check its handoff secret.");
        }
        if (redeemed.outcome === 'wrong_address') {
            return reply(502, 'PORTAL_MISCONFIGURED', "Sign-in from the portal isn't set up correctly on this system. An administrator needs to check its Access Portal address.");
        }
        if (redeemed.outcome !== 'ok') {
            return reply(502, 'PORTAL_UNAVAILABLE', "The Access Portal couldn't be reached to complete sign-in. Try again in a moment.");
        }

        let tokens;
        let user;
        try {
            tokens = await portal.refresh({ refresh_token: redeemed.token });
            user = await portal.me(tokens.access_token);
        } catch (err) {
            log(trace, `session exchange failed: ${err.statusCode || 500}`);
            return reply(401, 'SESSION_REFUSED', 'Your access to this system has been removed, or your session could not be started.');
        }

        session.setSessionCookies(res, tokens);
        log(trace, `POST 200 cookies=${session.ACCESS_COOKIE},${session.REFRESH_COOKIE}`);
        return ok(res, { user }, { message: 'Signed in' });
    } catch (err) {
        log(trace, `POST error ${err.message}`);
        return next(err);
    }
}

// ============== Users ==============

const findUser = wrap(async (req, res) => {
    ok(res, await portal.findByEmail(req.query.email));
});

const createUser = wrap(async (req, res) => {
    ok(res, await portal.createUser(req.body || {}), { status: 201, message: 'User created' });
});

const getUser = wrap(async (req, res) => {
    ok(res, await portal.getUser(req.params.id));
});

const setPassword = wrap(async (req, res) => {
    ok(res, await portal.setPassword(req.params.id, (req.body || {}).password), { message: 'Password updated' });
});

const setRole = wrap(async (req, res) => {
    ok(res, await portal.setRole(req.params.id, (req.body || {}).role_id), { message: 'Role updated' });
});

const setStatus = wrap(async (req, res) => {
    ok(res, await portal.setStatus(req.params.id, (req.body || {}).is_active), { message: 'Status updated' });
});

const listRoles = wrap(async (req, res) => {
    ok(res, portal.listRoles());
});

module.exports = {
    login,
    refresh,
    me,
    handoffGet,
    handoffPost,
    findUser,
    createUser,
    getUser,
    setPassword,
    setRole,
    setStatus,
    listRoles,
};
