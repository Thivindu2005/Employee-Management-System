'use strict';
// Employee Management API + website, one process, zero npm dependencies.
// Needs Node.js 22.13 or newer (uses the built-in node:sqlite module).
//
//   npm start            run locally   ->  http://localhost:3000
//   npm test             run the automated API tests
//
// Environment variables (all optional on your computer, some required in production):
//   PORT                  default 3000 (hosting platforms set this for you)
//   NODE_ENV=production   turns on the strict checks below
//   JWT_SECRET            REQUIRED in production, at least 16 random characters
//   ADMIN_EMAIL           REQUIRED in production, first admin account (created if there are no users)
//   ADMIN_PASSWORD        REQUIRED in production
//   DB_PATH               SQLite file, default ./data/app.db
//   SEED_DEMO_DATA=false  do not add the sample departments and employees
//   ALLOWED_ORIGIN        only needed if the frontend is hosted on a different address
//   ACCESS_TOKEN_MINUTES  default 30
//   WRAP=1                return list responses as { message, result, data } instead of plain arrays

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- config ----------
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const ACCESS_SECONDS = Number(process.env.ACCESS_TOKEN_SECONDS) || (Number(process.env.ACCESS_TOKEN_MINUTES) || 30) * 60;
const REFRESH_SECONDS = 7 * 24 * 3600;
const WRAP = process.env.WRAP === '1';
const SEED_DEMO = process.env.SEED_DEMO_DATA !== 'false';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || (PROD ? '' : '*');

let JWT_SECRET = process.env.JWT_SECRET;
let ADMIN_EMAIL = process.env.ADMIN_EMAIL;
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (PROD) {
  const missing = ['JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) { console.error('Missing required environment variables: ' + missing.join(', ')); process.exit(1); }
  if (JWT_SECRET.length < 16) { console.error('JWT_SECRET must be at least 16 characters.'); process.exit(1); }
} else {
  JWT_SECRET ||= 'dev-only-secret-change-me';
  ADMIN_EMAIL ||= 'admin@demo.com';
  ADMIN_PASSWORD ||= 'admin123';
}

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  -- departments and designations share one "master data" table (like the EmployeeOnboarding endpoints)
  CREATE TABLE IF NOT EXISTS masters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    master_for TEXT NOT NULL CHECK (master_for IN ('Department', 'Designation')),
    parent_master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ux_masters_name ON masters (master_for, IFNULL(parent_master_id, 0), name);
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone TEXT,
    gender TEXT,
    date_of_joining TEXT,
    department_id INTEGER REFERENCES masters(id) ON DELETE RESTRICT,
    designation_id INTEGER REFERENCES masters(id) ON DELETE RESTRICT,
    employee_type TEXT NOT NULL DEFAULT 'Permanent',
    salary REAL NOT NULL DEFAULT 0
  );
`);

const EMP_COLS = `id AS employeeId, full_name AS fullName, email, phone, gender,
  date_of_joining AS dateOfJoining, department_id AS departmentId,
  designation_id AS designationId, employee_type AS employeeType, salary`;

// ---------- security helpers ----------
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + (await scrypt(pw, salt)).toString('hex');
}
async function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex || '', 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex || '', 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
let DUMMY_HASH;   // used so an unknown email takes as long as a wrong password

const b64u = (x) => Buffer.from(x).toString('base64url');
function signJwt(payload) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ACCESS_SECONDS }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}
function verifyJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch { return null; }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function issueTokens(user) {
  const refreshToken = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(refreshToken), user.id, Math.floor(Date.now() / 1000) + REFRESH_SECONDS);
  return {
    userId: user.id, emailId: user.email, fullName: user.full_name,
    token: signJwt({ sub: user.id, email: user.email }),
    refreshToken
  };
}

// limit repeated wrong passwords: 8 tries per 15 minutes per address + email
const failures = new Map();
const LOCK_MS = 15 * 60 * 1000;
const isLocked = (key) => { const f = failures.get(key); return !!f && f.until > Date.now() && f.count >= 8; };
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + LOCK_MS });
  else f.count++;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of failures) if (v.until < n) failures.delete(k); }, 60 * 1000).unref();

// ---------- first start: admin user and sample data ----------
async function seed() {
  DUMMY_HASH = await hashPassword('not-a-real-password');
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare('INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)')
      .run(ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD), 'Admin User');
    console.log('Created admin user: ' + ADMIN_EMAIL);
  }
  if (SEED_DEMO && db.prepare('SELECT COUNT(*) AS n FROM masters').get().n === 0) {
    const addMaster = db.prepare('INSERT INTO masters (master_for, parent_master_id, name) VALUES (?, ?, ?)');
    const dept = (name) => Number(addMaster.run('Department', null, name).lastInsertRowid);
    const desig = (parent, name) => Number(addMaster.run('Designation', parent, name).lastInsertRowid);
    const hr = dept('HR'), it = dept('IT'), fin = dept('Finance');
    const hrMgr = desig(hr, 'HR Manager'); desig(hr, 'Recruiter');
    const swe = desig(it, 'Software Engineer'); desig(it, 'QA Engineer');
    desig(fin, 'Accountant'); desig(fin, 'Finance Analyst');
    const addEmp = db.prepare(`INSERT INTO employees (full_name, email, phone, gender, date_of_joining, department_id, designation_id, employee_type, salary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    addEmp.run('Nimali Perera', 'nimali@demo.com', '0771234567', 'Female', '2023-02-01', hr, hrMgr, 'Permanent', 185000);
    addEmp.run('Kasun Silva', 'kasun@demo.com', '0719876543', 'Male', '2024-05-12', it, swe, 'Contract', 220000);
    console.log('Added sample departments, designations and employees.');
  }
}

// ---------- response helpers ----------
function headers(extra = {}) {
  const h = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', ...extra
  };
  if (ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
  }
  return h;
}
function send(res, status, body) {
  res.writeHead(status, headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const wrapped = (data, message = '') => ({ message, result: true, data });
const listOut = (data) => (WRAP ? wrapped(data) : data);
const fail = (res, status, message) => send(res, status, { message, result: false });
const validationError = (res, errors) => send(res, 400, {
  type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
  title: 'One or more validation errors occurred.', status: 400, errors
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100 * 1024) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const toId = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// ---------- employee validation ----------
function validateEmployee(b, excludeId = 0) {
  const errors = {};
  const d = {};

  d.fullName = str(b.fullName);
  if (!d.fullName) errors.FullName = ['FullName is required.'];
  else if (d.fullName.length > 150) errors.FullName = ['FullName must be at most 150 characters.'];

  d.email = str(b.email);
  if (!/^\S+@\S+\.\S+$/.test(d.email) || d.email.length > 254) errors.Email = ['A valid Email is required.'];
  else if (db.prepare('SELECT 1 FROM employees WHERE email = ? AND id != ?').get(d.email, excludeId)) {
    errors.Email = ['An employee with this email already exists.'];
  }

  d.phone = str(b.phone) || null;
  if (d.phone && !/^\d{10}$/.test(d.phone)) errors.Phone = ['Phone must be exactly 10 digits.'];

  d.gender = str(b.gender) || null;
  if (d.gender && !['Male', 'Female', 'Other'].includes(d.gender)) errors.Gender = ['Gender must be Male, Female or Other.'];

  d.dateOfJoining = str(b.dateOfJoining) || null;
  if (d.dateOfJoining && (!/^\d{4}-\d{2}-\d{2}/.test(d.dateOfJoining) || Number.isNaN(Date.parse(d.dateOfJoining)))) {
    errors.DateOfJoining = ['DateOfJoining must be a valid date (YYYY-MM-DD).'];
  }

  d.employeeType = str(b.employeeType) || 'Permanent';
  if (!['Permanent', 'Contract', 'Part-time'].includes(d.employeeType)) errors.EmployeeType = ['EmployeeType must be Permanent, Contract or Part-time.'];

  d.salary = b.salary === undefined || b.salary === null || b.salary === '' ? 0 : Number(b.salary);
  if (!Number.isFinite(d.salary) || d.salary < 0 || d.salary > 1e9) errors.Salary = ['Salary must be a number from 0 to 1,000,000,000.'];

  d.departmentId = toId(b.departmentId);
  d.designationId = toId(b.designationId);
  if (d.departmentId !== null) {
    if (!Number.isInteger(d.departmentId) || !db.prepare("SELECT 1 FROM masters WHERE id = ? AND master_for = 'Department'").get(d.departmentId)) {
      errors.DepartmentId = ['That department does not exist.'];
    }
  }
  if (d.designationId !== null) {
    const g = Number.isInteger(d.designationId)
      ? db.prepare("SELECT parent_master_id AS parent FROM masters WHERE id = ? AND master_for = 'Designation'").get(d.designationId)
      : null;
    if (!g) errors.DesignationId = ['That designation does not exist.'];
    else if (d.departmentId === null) errors.DesignationId = ['Choose a department before choosing a designation.'];
    else if (g.parent !== d.departmentId) errors.DesignationId = ['That designation does not belong to the chosen department.'];
  }
  return { errors: Object.keys(errors).length ? errors : null, data: d };
}

const getEmployee = (id) => db.prepare(`SELECT ${EMP_COLS} FROM employees WHERE id = ?`).get(id);

// ---------- API routes ----------
async function handleApi(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean).map((p) => p.toLowerCase());   // ['api','employeeapp','getemployees']
  const [, controller, action] = parts;
  const method = req.method;

  if (controller === 'health' && method === 'GET') return send(res, 200, { status: 'ok' });

  // ----- UserApp: public endpoints -----
  if (controller === 'userapp' && action === 'login' && method === 'POST') {
    const b = await readBody(req);
    const email = str(b.emailId).slice(0, 254);
    const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    const key = clientIp(req) + '|' + email.toLowerCase();
    if (isLocked(key)) return fail(res, 429, 'Too many failed attempts. Try again in 15 minutes.');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      noteFailure(key);
      return send(res, 200, { message: 'Wrong email or password.', result: false, data: null });
    }
    failures.delete(key);
    return send(res, 200, wrapped(issueTokens(user), 'Login successful'));
  }

  if (controller === 'userapp' && action === 'createnewuser' && method === 'POST') {
    const b = await readBody(req);
    const email = str(b.emailId);
    const errors = {};
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) errors.EmailId = ['A valid EmailId is required.'];
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) errors.Password = ['Password must be 8 to 200 characters.'];
    const fullName = str(b.fullName) || email;
    if (fullName.length > 150) errors.FullName = ['FullName must be at most 150 characters.'];
    if (Object.keys(errors).length) return validationError(res, errors);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return send(res, 200, { message: 'That email is already registered.', result: false, data: null });
    }
    const r = db.prepare('INSERT INTO users (email, password_hash, full_name) VALUES (?, ?, ?)').run(email, await hashPassword(b.password), fullName);
    return send(res, 200, wrapped({ userId: Number(r.lastInsertRowid), emailId: email, fullName }, 'User created'));
  }

  if (controller === 'userapp' && action === 'refresh' && method === 'POST') {
    const b = await readBody(req);
    const row = typeof b.refreshToken === 'string'
      ? db.prepare(`SELECT u.*, r.token_hash FROM refresh_tokens r JOIN users u ON u.id = r.user_id
                    WHERE r.token_hash = ? AND r.expires_at > ?`).get(sha256(b.refreshToken), Math.floor(Date.now() / 1000))
      : null;
    if (!row || (b.emailId && String(b.emailId).toLowerCase() !== row.email.toLowerCase())) {
      return fail(res, 401, 'Invalid or expired refresh token.');
    }
    db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(row.token_hash);   // each refresh token works once
    return send(res, 200, wrapped(issueTokens(row), 'Token refreshed'));
  }

  if (controller === 'userapp' && action === 'logout' && method === 'POST') {
    const b = await readBody(req);
    if (typeof b.refreshToken === 'string') db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(sha256(b.refreshToken));
    return send(res, 200, wrapped(null, 'Logged out'));
  }

  // ----- everything below needs a valid access token -----
  const h = req.headers.authorization || '';
  const claims = h.startsWith('Bearer ') ? verifyJwt(h.slice(7)) : null;
  if (!claims) return fail(res, 401, 'Unauthorized: missing, invalid or expired token.');

  if (controller === 'userapp' && action === 'getallusers' && method === 'GET') {
    return send(res, 200, wrapped(db.prepare('SELECT id AS userId, email AS emailId, full_name AS fullName FROM users ORDER BY id').all()));
  }

  // ----- EmployeeApp -----
  if (controller === 'employeeapp') {
    if (action === 'getdepartments' && method === 'GET') {
      return send(res, 200, listOut(db.prepare(
        "SELECT id AS departmentId, name AS departmentName FROM masters WHERE master_for = 'Department' ORDER BY name").all()));
    }
    if (action === 'getdesignationsbydeptid' && method === 'GET') {
      return send(res, 200, listOut(db.prepare(
        "SELECT id AS designationId, name AS designationName, parent_master_id AS departmentId FROM masters WHERE master_for = 'Designation' AND parent_master_id = ? ORDER BY name")
        .all(Number(query.get('deptId')) || 0)));
    }
    if (action === 'getemployees' && method === 'GET') {
      return send(res, 200, listOut(db.prepare(`SELECT ${EMP_COLS} FROM employees ORDER BY id`).all()));
    }
    if (action === 'createemployee' && method === 'POST') {
      const { errors, data: d } = validateEmployee(await readBody(req));
      if (errors) return validationError(res, errors);
      const r = db.prepare(`INSERT INTO employees (full_name, email, phone, gender, date_of_joining, department_id, designation_id, employee_type, salary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.fullName, d.email, d.phone, d.gender, d.dateOfJoining, d.departmentId, d.designationId, d.employeeType, d.salary);
      return send(res, 200, wrapped(getEmployee(Number(r.lastInsertRowid)), 'Employee created'));
    }
    if (action === 'updateemployee' && method === 'PUT') {
      const id = Number(query.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'id query parameter is required.');
      const current = getEmployee(id);
      if (!current) return fail(res, 404, 'Employee not found.');
      const { errors, data: d } = validateEmployee({ ...current, ...(await readBody(req)) }, id);
      if (errors) return validationError(res, errors);
      db.prepare(`UPDATE employees SET full_name = ?, email = ?, phone = ?, gender = ?, date_of_joining = ?, department_id = ?,
        designation_id = ?, employee_type = ?, salary = ? WHERE id = ?`)
        .run(d.fullName, d.email, d.phone, d.gender, d.dateOfJoining, d.departmentId, d.designationId, d.employeeType, d.salary, id);
      return send(res, 200, wrapped(getEmployee(id), 'Employee updated'));
    }
    if (action === 'deleteemployee' && method === 'DELETE') {
      const id = Number(query.get('id'));
      if (!Number.isInteger(id)) return fail(res, 400, 'id query parameter is required.');
      if (!db.prepare('DELETE FROM employees WHERE id = ?').run(id).changes) return fail(res, 404, 'Employee not found.');
      return send(res, 200, wrapped(null, 'Employee deleted'));
    }
    if (/^\d+$/.test(action || '') && method === 'GET') {
      const e = getEmployee(Number(action));
      return e ? send(res, 200, listOut(e)) : fail(res, 404, 'Employee not found.');
    }
  }

  // ----- EmployeeOnboarding: master data (departments and designations) -----
  if (controller === 'employeeonboarding') {
    if (action === 'createnewmaster' && method === 'POST') {
      const b = await readBody(req);
      const name = str(b.masterValue);
      const errors = {};
      if (!name) errors.MasterValue = ['MasterValue is required.'];
      else if (name.length > 100) errors.MasterValue = ['MasterValue must be at most 100 characters.'];
      if (!['Department', 'Designation'].includes(b.masterFor)) errors.MasterFor = ['MasterFor must be Department or Designation.'];
      if (Object.keys(errors).length) return validationError(res, errors);
      let parent = null;
      if (b.masterFor === 'Designation') {
        parent = Number(b.parentMasterId);
        if (!db.prepare("SELECT 1 FROM masters WHERE id = ? AND master_for = 'Department'").get(parent)) return fail(res, 400, 'Parent department not found.');
      }
      try {
        db.prepare('INSERT INTO masters (master_for, parent_master_id, name) VALUES (?, ?, ?)').run(b.masterFor, parent, name);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return fail(res, 400, 'That name already exists.');
        throw e;
      }
      return send(res, 200, wrapped(null, 'Master created'));
    }
    if (action === 'updatemaster' && method === 'POST') {
      const id = Number(query.get('id'));
      const name = str((await readBody(req)).masterValue);
      if (!name || name.length > 100) return validationError(res, { MasterValue: ['MasterValue is required (max 100 characters).'] });
      try {
        if (!db.prepare('UPDATE masters SET name = ? WHERE id = ?').run(name, id).changes) return fail(res, 404, 'Master record not found.');
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return fail(res, 400, 'That name already exists.');
        throw e;
      }
      return send(res, 200, wrapped(null, 'Master updated'));
    }
    if (action === 'deletemasterbyid' && method === 'DELETE') {
      const id = Number(query.get('id'));
      const m = db.prepare('SELECT master_for FROM masters WHERE id = ?').get(id);
      if (!m) return fail(res, 404, 'Master record not found.');
      const used = db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE department_id = ? OR designation_id = ?
        OR designation_id IN (SELECT id FROM masters WHERE parent_master_id = ?)`).get(id, id, id).n;
      if (used) return fail(res, 400, m.master_for === 'Department'
        ? 'Employees still belong to this department.' : 'Employees still use this designation.');
      db.prepare('DELETE FROM masters WHERE id = ?').run(id);   // a department's designations are removed with it
      return send(res, 200, wrapped(null, m.master_for + ' deleted'));
    }
  }

  return fail(res, 404, 'Not found: ' + method + ' ' + pathname);
}

// ---------- static files (the website in /public) ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers()); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400, headers()); return res.end(); }
  const file = path.resolve(PUBLIC_DIR, '.' + (rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403, headers()); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, headers({ 'Content-Type': 'text/plain' })); return res.end('Not found'); }
    res.writeHead(200, headers({ 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const u = new URL(req.url, 'http://localhost');
  res.on('finish', () => console.log(req.method, u.pathname, res.statusCode, (Date.now() - started) + 'ms'));
  if (req.method === 'OPTIONS') { res.writeHead(204, headers()); return res.end(); }
  try {
    if (u.pathname.toLowerCase().startsWith('/api/')) await handleApi(req, res, u.pathname, u.searchParams);
    else serveStatic(req, res, u.pathname);
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    console.error(err);                                   // details stay in the server log
    fail(res, 500, 'Something went wrong on the server.');
  }
});

seed().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Listening on port ' + PORT + (PROD ? ' (production)' : '  ->  http://localhost:' + PORT));
  });
}).catch((err) => { console.error('Startup failed:', err); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); }); });
}
