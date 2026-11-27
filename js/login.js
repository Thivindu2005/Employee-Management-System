// If the user is already signed in, skip the login page
if (isLoggedIn()) window.location.href = 'dashboard.html';

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passInput = document.getElementById('password');
const btn = document.getElementById('loginBtn');
const spin = document.getElementById('spin');
const btnText = document.getElementById('btnText');

// Demo hint (only while there is no real API)
if (DEMO_MODE) {
  document.getElementById('demoHint').textContent =
    'Demo mode: use admin@demo.com / admin123 until the real API URL is set.';
}

// Show / hide password
document.getElementById('togglePass').addEventListener('click', (e) => {
  const hidden = passInput.type === 'password';
  passInput.type = hidden ? 'text' : 'password';
  e.target.textContent = hidden ? 'Hide' : 'Show';
});

function setLoading(on) {
  btn.disabled = on;
  spin.classList.toggle('d-none', !on);
  btnText.textContent = on ? 'Signing in...' : 'Sign in';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const emailId = emailInput.value.trim();
  const password = passInput.value;

  // basic validation
  if (!emailId || !password) return showAlert('danger', 'Enter your email and password.');
  if (!/^\S+@\S+\.\S+$/.test(emailId)) return showAlert('danger', 'Enter a valid email address.');

  setLoading(true);
  try {
    let user, token = '';

    if (DEMO_MODE) {
      // fake login so the UI can be built and tested without the API
      if (emailId !== 'admin@demo.com' || password !== 'admin123') {
        throw new Error('Wrong email or password.');
      }
      user = { emailId, fullName: 'Demo Admin' };
    } else {
      // real login: POST /api/UserApp/login
      const res = await apiPost('/UserApp/login', { emailId, password });
      if (!res.result) throw new Error(res.message || 'Login failed.');
      user = res.data || { emailId };
      // the docs do not name the token field, so check the likely ones
      token = (res.data && (res.data.token || res.data.jwtToken || res.data.accessToken)) || '';
      if (res.data && res.data.refreshToken) sessionStorage.setItem('refreshToken', res.data.refreshToken);
    }

    sessionStorage.setItem('user', JSON.stringify(user));
    if (token) sessionStorage.setItem('token', token);

    showAlert('success', 'Signed in. Opening your dashboard...');
    setTimeout(() => (window.location.href = 'dashboard.html'), 600);
  } catch (err) {
    showAlert('danger', err.message || 'Could not reach the server.');
    setLoading(false);
  }
});
