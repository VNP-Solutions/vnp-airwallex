(() => {
    const state = {
        email: '',
        reset_token: '',
    };

    const steps = Array.from(document.querySelectorAll('.step'));
    const panes = {
        1: document.getElementById('step-email'),
        2: document.getElementById('step-otp'),
        3: document.getElementById('step-password'),
    };

    function goToStep(n) {
        Object.entries(panes).forEach(([key, el]) => {
            el.hidden = Number(key) !== n;
        });
        steps.forEach((s) => {
            const stepNum = Number(s.dataset.step);
            s.classList.toggle('active', stepNum === n);
            s.classList.toggle('completed', stepNum < n);
        });
    }

    function makeErrorHelpers(el) {
        return {
            show(message) {
                el.textContent = message;
                el.hidden = false;
            },
            clear() {
                el.textContent = '';
                el.hidden = true;
            },
        };
    }

    // -------- Step 1: Email --------
    const emailForm = document.getElementById('email-form');
    const emailInput = document.getElementById('email');
    const emailSubmit = document.getElementById('email-submit');
    const emailErr = makeErrorHelpers(document.getElementById('email-error'));

    emailForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        emailErr.clear();
        const email = emailInput.value.trim();
        if (!email) {
            emailErr.show('Please enter your email.');
            return;
        }

        emailSubmit.disabled = true;
        const originalLabel = emailSubmit.textContent;
        emailSubmit.textContent = 'Sending code…';

        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                emailErr.show(data.error || 'Could not send code. Please try again.');
                return;
            }

            state.email = email;
            document.getElementById('otp-email').textContent = email;
            goToStep(2);
            setTimeout(() => otpInputs[0].focus(), 50);
        } catch (err) {
            console.error(err);
            emailErr.show('Network error. Please try again.');
        } finally {
            emailSubmit.disabled = false;
            emailSubmit.textContent = originalLabel;
        }
    });

    // -------- Step 2: OTP --------
    const otpInputs = Array.from(document.querySelectorAll('.otp-input'));
    const otpForm = document.getElementById('otp-form');
    const otpSubmit = document.getElementById('otp-submit');
    const otpInputsWrap = document.getElementById('otp-inputs');
    const resendLink = document.getElementById('resend-link');
    const otpErr = {
        show(message) {
            const el = document.getElementById('otp-error');
            el.textContent = message;
            el.hidden = false;
            otpInputsWrap.classList.add('error');
        },
        clear() {
            const el = document.getElementById('otp-error');
            el.textContent = '';
            el.hidden = true;
            otpInputsWrap.classList.remove('error');
        },
    };

    function getCode() {
        return otpInputs.map((i) => i.value).join('');
    }

    function setFilledStates() {
        otpInputs.forEach((input) => {
            input.classList.toggle('filled', !!input.value);
        });
    }

    otpInputs.forEach((input, idx) => {
        input.addEventListener('input', (event) => {
            otpErr.clear();
            const digit = event.target.value.replace(/\D/g, '').slice(-1);
            event.target.value = digit;
            setFilledStates();

            if (digit && idx < otpInputs.length - 1) {
                otpInputs[idx + 1].focus();
            }

            if (getCode().length === otpInputs.length) {
                submitOtp();
            }
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Backspace' && !input.value && idx > 0) {
                otpInputs[idx - 1].focus();
                otpInputs[idx - 1].value = '';
                setFilledStates();
            }
            if (event.key === 'ArrowLeft' && idx > 0) otpInputs[idx - 1].focus();
            if (event.key === 'ArrowRight' && idx < otpInputs.length - 1) otpInputs[idx + 1].focus();
        });

        input.addEventListener('paste', (event) => {
            event.preventDefault();
            const pasted = (event.clipboardData || window.clipboardData).getData('text');
            const digits = pasted.replace(/\D/g, '').slice(0, otpInputs.length).split('');
            if (!digits.length) return;
            otpInputs.forEach((inp, i) => { inp.value = digits[i] || ''; });
            setFilledStates();
            const firstEmpty = otpInputs.find((i) => !i.value) || otpInputs[otpInputs.length - 1];
            firstEmpty.focus();
            if (getCode().length === otpInputs.length) submitOtp();
        });
    });

    async function submitOtp() {
        const otp = getCode();
        if (otp.length !== otpInputs.length) {
            otpErr.show('Please enter all 6 digits.');
            return;
        }

        otpSubmit.disabled = true;
        const originalLabel = otpSubmit.textContent;
        otpSubmit.textContent = 'Verifying…';

        try {
            const res = await fetch('/api/auth/forgot-password/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: state.email, otp }),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                otpErr.show(data.error || 'Verification failed. Please try again.');
                otpInputs.forEach((i) => { i.value = ''; });
                setFilledStates();
                otpInputs[0].focus();
                return;
            }

            state.reset_token = data.reset_token;
            goToStep(3);
            setTimeout(() => document.getElementById('new-password').focus(), 50);
        } catch (err) {
            console.error(err);
            otpErr.show('Network error. Please try again.');
        } finally {
            otpSubmit.disabled = false;
            otpSubmit.textContent = originalLabel;
        }
    }

    otpForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitOtp();
    });

    resendLink.addEventListener('click', async (event) => {
        event.preventDefault();
        if (resendLink.classList.contains('disabled')) return;

        otpErr.clear();
        resendLink.classList.add('disabled');
        const originalText = resendLink.textContent;
        resendLink.textContent = 'Sending…';

        try {
            const res = await fetch('/api/auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: state.email }),
            });
            if (!res.ok) {
                otpErr.show('Could not resend code.');
                resendLink.classList.remove('disabled');
                resendLink.textContent = originalText;
                return;
            }
            resendLink.textContent = 'Sent!';
            setTimeout(() => {
                resendLink.classList.remove('disabled');
                resendLink.textContent = originalText;
            }, 30000);
        } catch (err) {
            console.error(err);
            otpErr.show('Network error while resending.');
            resendLink.classList.remove('disabled');
            resendLink.textContent = originalText;
        }
    });

    // -------- Step 3: New password --------
    const passwordForm = document.getElementById('password-form');
    const newPasswordInput = document.getElementById('new-password');
    const confirmPasswordInput = document.getElementById('confirm-password');
    const passwordSubmit = document.getElementById('password-submit');
    const passwordErr = makeErrorHelpers(document.getElementById('password-error'));

    document.getElementById('eye-new').addEventListener('click', () => {
        newPasswordInput.type = newPasswordInput.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('eye-confirm').addEventListener('click', () => {
        confirmPasswordInput.type = confirmPasswordInput.type === 'password' ? 'text' : 'password';
    });

    passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        passwordErr.clear();

        const newPassword = newPasswordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        if (newPassword.length < 8) {
            passwordErr.show('Password must be at least 8 characters.');
            return;
        }
        if (newPassword !== confirmPassword) {
            passwordErr.show('Passwords do not match.');
            return;
        }

        passwordSubmit.disabled = true;
        const originalLabel = passwordSubmit.textContent;
        passwordSubmit.textContent = 'Resetting…';

        try {
            const res = await fetch('/api/auth/forgot-password/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reset_token: state.reset_token,
                    new_password: newPassword,
                }),
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                passwordErr.show(data.error || 'Could not reset password. Please try again.');
                return;
            }

            // Hand off success message to the login page via sessionStorage.
            sessionStorage.setItem('login_toast', 'Password reset successfully. Please sign in with your new password.');
            window.location.href = '/login';
        } catch (err) {
            console.error(err);
            passwordErr.show('Network error. Please try again.');
        } finally {
            passwordSubmit.disabled = false;
            passwordSubmit.textContent = originalLabel;
        }
    });
})();