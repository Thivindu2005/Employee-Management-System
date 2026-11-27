// ---------- API settings ----------
// When the site is opened from the server (http://localhost:3000 or your deployed URL),
// the API lives at the same address, so '/api' is enough.
// If you open the HTML files directly (file://) there is no server, so the app uses demo mode.
// To use an API on a different address, put its full URL here, e.g. 'https://my-api.onrender.com/api'.
const API_BASE = location.protocol === 'file:' ? 'https://your-api-domain.com/api' : '/api';
const HEADERS = { 'Content-Type': 'application/json' };

// While the URL is still the placeholder, the app runs in demo mode
const DEMO_MODE = API_BASE.includes('your-api-domain.com');

// ---------- session helpers ----------
function authHeaders() {
  const token = sessionStorage.getItem('token');
  return token ? { ...HEADERS, Authorization: 'Bearer ' + token } : HEADERS;
}

function isLoggedIn() {
  return sessionStorage.getItem('user') !== null;
}

function logout() {
  // tell the server to revoke the refresh token (best effort)
  const rt = sessionStorage.getItem('refreshToken');
  if (rt && !DEMO_MODE) {
    try { fetch(API_BASE + '/UserApp/logout', { method: 'POST', headers: HEADERS, body: JSON.stringify({ refreshToken: rt }), keepalive: true }); } catch { /* ignore */ }
  }
  sessionStorage.clear();
  window.location.href = 'index.html';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showAlert(type, msg) {
  document.getElementById('alert').innerHTML = `<div class="alert alert-${type}">${escapeHtml(msg)}</div>`;
}

// ---------- request helper ----------
// Throws an Error when the server answers 400/401/404/500 etc., so the
// catch blocks in the pages can show the real message instead of a fake "success".
let refreshing = null;
async function refreshSession() {
  const refreshToken = sessionStorage.getItem('refreshToken');
  if (!refreshToken) return false;
  if (!refreshing) {
    const user = JSON.parse(sessionStorage.getItem('user') || '{}');
    refreshing = fetch(API_BASE + '/UserApp/refresh', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ emailId: user.emailId, token: sessionStorage.getItem('token'), refreshToken })
    })
      .then(async (r) => {
        if (!r.ok) return false;
        const d = (await r.json()).data;
        if (!d || !d.token) return false;
        sessionStorage.setItem('token', d.token);
        if (d.refreshToken) sessionStorage.setItem('refreshToken', d.refreshToken);
        return true;
      })
      .catch(() => false)
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

async function request(path, options = {}, retried = false) {
  const res = await fetch(API_BASE + path, { ...options, headers: authHeaders() });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  // expired token: try once to get a new one with the refresh token, then repeat the request
  if (res.status === 401 && sessionStorage.getItem('token')) {
    if (!retried && await refreshSession()) return request(path, options, true);
    logout();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) {
    let msg = data && typeof data === 'object' ? (data.message || data.title) : data;
    // ASP.NET validation errors come as { errors: { Field: ['message'] } }
    if (data && data.errors) msg = Object.values(data.errors).flat().join(' ');
    throw new Error(msg || 'Request failed (' + res.status + ')');
  }
  return data ?? { result: true };   // some DELETE/PUT calls return an empty body
}

const apiGet = (path) => request(path);
const apiPost = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
const apiPut = (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) });
const apiDelete = (path) => request(path, { method: 'DELETE' });

// ---------- demo data (shared by the dashboard and the departments page) ----------
function demoDepts() {
  const saved = localStorage.getItem('demoDepts');
  if (saved) return JSON.parse(saved);
  const seed = [{ id: 1, name: 'HR' }, { id: 2, name: 'IT' }, { id: 3, name: 'Finance' }];
  localStorage.setItem('demoDepts', JSON.stringify(seed));
  return seed;
}

function demoDesigs() {
  const saved = localStorage.getItem('demoDesigs');
  if (saved) return JSON.parse(saved);
  const seed = [
    { id: 1, name: 'HR Manager', deptId: 1 }, { id: 2, name: 'Recruiter', deptId: 1 },
    { id: 3, name: 'Software Engineer', deptId: 2 }, { id: 4, name: 'QA Engineer', deptId: 2 },
    { id: 5, name: 'Accountant', deptId: 3 }, { id: 6, name: 'Finance Analyst', deptId: 3 }
  ];
  localStorage.setItem('demoDesigs', JSON.stringify(seed));
  return seed;
}
