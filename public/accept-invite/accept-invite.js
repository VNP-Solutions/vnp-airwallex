(() => {
    const stateLoading = document.getElementById('state-loading');
    const stateForm = document.getElementById('state-form');
    const stateError = document.getElementById('state-error');
    const errorText = document.getElementById('error-text');
    const emailLabel = document.getElementById('invite-email');
    const form = document.getElementById('accept-form');
    const passwordEl = document.getElementById('password');
    const confirmEl = document.getElementById('confirm');
    const submitBtn = document.getElementById('submit-btn');
    const formError = document.getElementById('form-error');

    const token = new URLSearchParams(window.location.search).get('token');

    function show(stateEl) {
        [stateLoading, stateForm, stateError].forEach((s) => { s.hidden = s !== stateEl; });
    }

    function showError(message) {
        errorText.textContent = message;
        show(stateError);
    }

    if (!token) {
        showError('No invite token in the link. Make sure you used the link from your invite email.');
        return;
    }

    // Eye toggles
    document.getElementById('eye-new').addEventListener('click', () => {
        passwordEl.type = passwordEl.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('eye-confirm').addEventListener('click', () => {
        confirmEl.type = confirmEl.type === 'password' ? 'text' : 'password';
    });

    // Step 1 — validate token
    (async () => {
        try {
            const res = await fetch(
                `/api/users/invite/preview?token=${encodeURIComponent(token)}`
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                showError(data.error || 'This invite link is invalid or has expired.');
                return;
            }
            emailLabel.textContent = data.email;
            show(stateForm);
            setTimeout(() => passwordEl.focus(), 80);
        } catch (e) {
            console.error(e);
            showError('Could not check your invitation. Please try again later.');
        }
    })();

    // Step 2 — submit password
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        formError.hidden = true;
        const password = passwordEl.value;
        const confirm = confirmEl.value;
        if (password.length < 8) {
            formError.textContent = 'Password must be at least 8 characters.';
            formError.hidden = false;
            return;
        }
        if (password !== confirm) {
            formError.textContent = 'Passwords do not match.';
            formError.hidden = false;
            return;
        }

        const label = submitBtn.querySelector('.btn-label');
        const originalText = label.textContent;
        submitBtn.classList.add('loading');
        submitBtn.disabled = true;
        label.textContent = 'Activating…';

        try {
            const res = await fetch('/api/users/accept-invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                formError.textContent = data.error || 'Could not activate your account.';
                formError.hidden = false;
                return;
            }
            sessionStorage.setItem(
                'login_toast',
                'Your account is ready. Sign in to get started.'
            );
            window.location.href = '/login';
        } catch (err) {
            console.error(err);
            formError.textContent = 'Network error. Please try again.';
            formError.hidden = false;
        } finally {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
            label.textContent = originalText;
        }
    });
})();