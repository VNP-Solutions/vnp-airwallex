(() => {
    const inputs = Array.from(document.querySelectorAll('.otp-input'));
    const form = document.getElementById('otp-form');
    const submitBtn = document.getElementById('verify-btn');
    const errorEl = document.getElementById('form-error');
    const emailEl = document.getElementById('otp-email');
    const inputsWrap = document.getElementById('otp-inputs');
    const resendLink = document.getElementById('resend-link');

    const email = sessionStorage.getItem('pending_login_email');
    const remember = sessionStorage.getItem('pending_login_remember') === '1';

    if (!email) {
        window.location.href = '/login';
        return;
    }

    emailEl.textContent = email;

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = false;
        inputsWrap.classList.add('error');
    }

    function clearError() {
        errorEl.textContent = '';
        errorEl.hidden = true;
        inputsWrap.classList.remove('error');
    }

    function getCode() {
        return inputs.map((i) => i.value).join('');
    }

    function setFilledStates() {
        inputs.forEach((input) => {
            input.classList.toggle('filled', !!input.value);
        });
    }

    function focusFirstEmpty() {
        const firstEmpty = inputs.find((i) => !i.value) || inputs[inputs.length - 1];
        firstEmpty.focus();
    }

    inputs.forEach((input, idx) => {
        input.addEventListener('input', (event) => {
            clearError();
            // Keep only the last typed digit
            const digit = event.target.value.replace(/\D/g, '').slice(-1);
            event.target.value = digit;
            setFilledStates();

            if (digit && idx < inputs.length - 1) {
                inputs[idx + 1].focus();
            }

            if (getCode().length === inputs.length) {
                submitForm();
            }
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' && !input.value && idx > 0) {
                inputs[idx - 1].focus();
                inputs[idx - 1].value = '';
                setFilledStates();
            }
            if (event.key === 'ArrowLeft' && idx > 0) {
                inputs[idx - 1].focus();
            }
            if (event.key === 'ArrowRight' && idx < inputs.length - 1) {
                inputs[idx + 1].focus();
            }
        });

        input.addEventListener('paste', (event) => {
            event.preventDefault();
            const pasted = (event.clipboardData || window.clipboardData).getData('text');
            const digits = pasted.replace(/\D/g, '').slice(0, inputs.length).split('');
            if (!digits.length) return;
            inputs.forEach((inp, i) => {
                inp.value = digits[i] || '';
            });
            setFilledStates();
            focusFirstEmpty();
            if (getCode().length === inputs.length) {
                submitForm();
            }
        });
    });

    inputs[0].focus();

    function storeAuth({ userId, token, first_name, last_name, email: userEmail }) {
        const storage = remember ? localStorage : sessionStorage;
        storage.setItem('auth_token', token);
        storage.setItem('auth_user_id', userId);
        if (first_name) storage.setItem('auth_first_name', first_name);
        if (last_name) storage.setItem('auth_last_name', last_name);
        if (userEmail) storage.setItem('auth_email', userEmail);
        // Clear pending login state regardless.
        sessionStorage.removeItem('pending_login_email');
        sessionStorage.removeItem('pending_login_remember');
        sessionStorage.removeItem('pending_login_expires_at');
    }

    async function submitForm() {
        const otp = getCode();
        if (otp.length !== inputs.length) {
            showError('Please enter all 6 digits.');
            return;
        }

        submitBtn.disabled = true;
        const originalLabel = submitBtn.textContent;
        submitBtn.textContent = 'Verifying…';

        try {
            const res = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, otp }),
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                showError(data.error || 'Verification failed. Please try again.');
                inputs.forEach((i) => { i.value = ''; });
                setFilledStates();
                inputs[0].focus();
                return;
            }

            storeAuth(data);
            window.location.href = '/';
        } catch (err) {
            console.error(err);
            showError('Network error. Please check your connection and try again.');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
        }
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        submitForm();
    });

    resendLink?.addEventListener('click', async (event) => {
        event.preventDefault();
        if (resendLink.classList.contains('disabled')) return;

        const password = prompt('To resend the code, please re-enter your password:');
        if (!password) return;

        clearError();
        resendLink.classList.add('disabled');
        const originalText = resendLink.textContent;
        resendLink.textContent = 'Sending…';

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                showError(data.error || 'Could not resend code.');
                resendLink.classList.remove('disabled');
                resendLink.textContent = originalText;
                return;
            }

            resendLink.textContent = 'Sent!';
            setTimeout(() => {
                resendLink.classList.remove('disabled');
                resendLink.textContent = originalText;
            }, 30000); // 30s cooldown
        } catch (err) {
            console.error(err);
            showError('Network error while resending.');
            resendLink.classList.remove('disabled');
            resendLink.textContent = originalText;
        }
    });
})();