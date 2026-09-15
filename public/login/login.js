(() => {
    const form = document.getElementById('login-form');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const rememberInput = document.getElementById('remember');
    const eyeBtn = document.getElementById('eye-btn');
    const submitBtn = document.getElementById('submit-btn');
    const errorEl = document.getElementById('form-error');
    const toastEl = document.getElementById('toast');

    // Show a one-shot toast queued by another page (e.g. password reset success).
    const pendingToast = sessionStorage.getItem('login_toast');
    if (pendingToast && toastEl) {
        sessionStorage.removeItem('login_toast');
        toastEl.textContent = pendingToast;
        toastEl.hidden = false;
        // Force reflow so the transition runs.
        // eslint-disable-next-line no-unused-expressions
        toastEl.offsetHeight;
        toastEl.classList.add('visible');
        setTimeout(() => {
            toastEl.classList.remove('visible');
            setTimeout(() => { toastEl.hidden = true; }, 300);
        }, 4500);
    }

    if (!form) return;

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }

    function clearError() {
        errorEl.textContent = '';
        errorEl.hidden = true;
    }

    eyeBtn?.addEventListener('click', () => {
        const isPassword = passwordInput.type === 'password';
        passwordInput.type = isPassword ? 'text' : 'password';
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearError();

        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            showError('Email and password are required.');
            return;
        }

        const labelEl = submitBtn.querySelector('.btn-label');
        const originalLabel = labelEl.textContent;
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        labelEl.textContent = 'Sending code…';

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                showError(data.error || 'Login failed. Please try again.');
                return;
            }

            // Stash the email and remember-me choice so the OTP step can finish the flow.
            sessionStorage.setItem('pending_login_email', email);
            sessionStorage.setItem('pending_login_remember', rememberInput.checked ? '1' : '0');
            sessionStorage.setItem('pending_login_expires_at', data.expires_at || '');

            window.location.href = '/otp';
        } catch (err) {
            console.error(err);
            showError('Network error. Please check your connection and try again.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
            labelEl.textContent = originalLabel;
        }
    });
})();