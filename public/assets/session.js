/**
 * The signed-in session, for every protected page. Load it in <head>, before
 * any other script.
 *
 * The session lives in HttpOnly cookies that this code cannot see, so "am I
 * signed in?" is answered by asking the server, not by looking in storage. The
 * page is kept hidden until it answers, so a signed-out visitor never sees a
 * flash of the app before being sent to sign in.
 *
 * It also wraps fetch: an API call that comes back 401 because the access
 * cookie expired is renewed once from the refresh cookie and retried, so pages
 * never need their own refresh logic. Only when renewal fails does the visitor
 * go to the sign-in page.
 */
(() => {
    const hide = document.createElement('style');
    hide.id = 'session-pending';
    hide.textContent = 'html{visibility:hidden}';
    document.head.appendChild(hide);
    const reveal = () => hide.remove();

    const nativeFetch = window.fetch.bind(window);

    // One renewal at a time: a page that fires five calls at once on an
    // expired session must not race five refreshes against each other.
    let renewing = null;
    function renewOnce() {
        if (!renewing) {
            renewing = nativeFetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
                .then((res) => res.ok)
                .catch(() => false)
                .finally(() => setTimeout(() => (renewing = null), 0));
        }
        return renewing;
    }

    let leaving = false;
    function toSignIn() {
        if (leaving) return;
        leaving = true;
        window.location.replace('/login');
    }

    function isRenewable(input) {
        let url;
        try {
            url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
        } catch (e) {
            return false;
        }
        return (
            url.origin === window.location.origin &&
            url.pathname.startsWith('/api/') &&
            // The auth routes answer 401 as their actual result.
            !url.pathname.startsWith('/api/auth/')
        );
    }

    window.fetch = async (input, init) => {
        const res = await nativeFetch(input, init);
        if (res.status !== 401 || !isRenewable(input)) return res;
        if (await renewOnce()) return nativeFetch(input, init);
        toSignIn();
        return res;
    };

    function remember(user) {
        try {
            localStorage.setItem('auth_user_id', user.id || '');
            localStorage.setItem('auth_first_name', user.first_name || '');
            localStorage.setItem('auth_last_name', user.last_name || '');
            localStorage.setItem('auth_email', user.email || '');
        } catch (e) {
            /* display details only */
        }
    }

    (async () => {
        try {
            let res = await nativeFetch('/api/auth/me', { credentials: 'same-origin' });
            if (res.status === 401 && (await renewOnce())) {
                res = await nativeFetch('/api/auth/me', { credentials: 'same-origin' });
            }
            if (!res.ok) return toSignIn();
            const body = await res.json().catch(() => ({}));
            if (body.data) remember(body.data);
            reveal();
        } catch (e) {
            // Unreachable counts as signed out, not as a broken page.
            toSignIn();
        }
    })();

    /** Sign out: the server clears the cookies, since nothing here can. */
    async function signOut() {
        try {
            await nativeFetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (e) {
            /* leave regardless */
        }
        ['auth_token', 'auth_user_id', 'auth_first_name', 'auth_last_name', 'auth_email'].forEach((k) => {
            try {
                localStorage.removeItem(k);
                sessionStorage.removeItem(k);
            } catch (e) {
                /* ignore */
            }
        });
        leaving = true;
        window.location.replace('/login');
    }

    window.Session = { signOut };
})();
