(() => {
    const token =
        localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
    const userId =
        localStorage.getItem('auth_user_id') || sessionStorage.getItem('auth_user_id');

    if (!token || !userId) {
        window.location.replace('/login');
    }
})();