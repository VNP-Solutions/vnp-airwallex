(() => {
    /**
     * Finish a sign-in handed over by the VNP Access Portal.
     *
     * The portal opened this system's API, which forwarded the browser here
     * with a single-use code in the URL fragment. Posting it back from this
     * page is what makes the session cookies land under this site: a cookie
     * set on the API's own redirect would be filed under whatever page the
     * browser was showing at the time, and never sent back here.
     *
     * Every failure is shown on this page. None goes to the login screen —
     * that would make an expired link, a misconfigured server and a cookie
     * problem all look exactly the same.
     */

    const working = document.getElementById('state-working');
    const failed = document.getElementById('state-failed');
    const reasonEl = document.getElementById('failed-reason');
    const portalLink = document.getElementById('portal-link');

    function fail(reason, portalUrl) {
        working.hidden = true;
        failed.hidden = false;
        reasonEl.textContent = reason;
        if (portalUrl) {
            portalLink.href = portalUrl;
            portalLink.hidden = false;
        }
    }

    // Read the code from the fragment — "#code=…" or a bare "#…" — and take it
    // out of the address bar before anything else, so it is not left in
    // history or copied into a shared link.
    const fragment = window.location.hash.replace(/^#/, '');
    const code = new URLSearchParams(fragment).get('code') || (fragment.includes('=') ? '' : fragment);
    window.history.replaceState(null, '', '/auth/handoff');

    if (!code) {
        fail('This link is missing its sign-in code. Open this system again from the Access Portal.');
        return;
    }

    // The code burns on first use, so a second request for it would fail even
    // though the first succeeded. Keep the in-flight request for each code and
    // reuse it.
    const inFlight = (window.__handoffRequests = window.__handoffRequests || new Map());
    if (!inFlight.has(code)) {
        inFlight.set(
            code,
            fetch('/api/access-portal/v1/auth/handoff', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            }).then(async (res) => ({ ok: res.ok, body: await res.json().catch(() => ({})) }))
        );
    }

    inFlight
        .get(code)
        .then(({ ok, body }) => {
            if (!ok) {
                fail(
                    body.error || 'Sign-in could not be completed. Open this system again from the Access Portal.',
                    body.portal_url
                );
                return;
            }

            // Display details only — the session itself is in HttpOnly cookies
            // this page cannot read.
            const user = (body.data && body.data.user) || {};
            try {
                localStorage.setItem('auth_user_id', user.id || '');
                localStorage.setItem('auth_first_name', user.first_name || '');
                localStorage.setItem('auth_last_name', user.last_name || '');
                localStorage.setItem('auth_email', user.email || '');
            } catch (e) {
                /* storage unavailable: the pages fetch it themselves */
            }

            // Replace, so Back does not return to a spent code.
            window.location.replace('/dashboard');
        })
        .catch(() => {
            fail("We couldn't reach this system to finish signing you in. Check your connection and open it again from the Access Portal.");
        });
})();
