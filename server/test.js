'use strict';
// Automated API tests. Run with:  npm test
// Starts the server on a temporary database, runs the checks, then stops it.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 3911;
const BASE = 'http://localhost:' + PORT;
const DB = path.join(os.tmpdir(), 'ems-test-' + Date.now() + '.db');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ACCESS_TOKEN_SECONDS: '2', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/health'); break; } catch { await sleep(100); } }

    console.log('Health and static files');
    check('health endpoint', (await call('GET', '/api/health')).status === 200);
    const home = await call('GET', '/');
    check('index.html is served', home.status === 200 && home.text.includes('Employee Management'));
    check('server source is NOT served', (await call('GET', '/server/server.js')).status === 404);
    check('path traversal is blocked', [403, 404].includes((await call('GET', '/..%2fserver%2fserver.js')).status));

    console.log('Login');
    check('no token -> 401', (await call('GET', '/api/EmployeeApp/GetEmployees')).status === 401);
    check('bad token -> 401', (await call('GET', '/api/EmployeeApp/GetEmployees', undefined, 'abc.def.ghi')).status === 401);
    const bad = await call('POST', '/api/UserApp/login', { emailId: 'admin@demo.com', password: 'wrong' });
    check('wrong password -> result false', bad.json && bad.json.result === false);
    const login = await call('POST', '/api/UserApp/login', { emailId: 'admin@demo.com', password: 'admin123' });
    check('login ok returns token + refreshToken', login.json.result && login.json.data.token && login.json.data.refreshToken);
    let { token, refreshToken } = login.json.data;

    console.log('Employees');
    const list = await call('GET', '/api/EmployeeApp/GetEmployees', undefined, token);
    check('seeded employees listed', Array.isArray(list.json) && list.json.length === 2);
    const depts = (await call('GET', '/api/EmployeeApp/GetDepartments', undefined, token)).json;
    check('3 departments seeded', depts.length === 3 && depts[0].departmentName);
    const it = depts.find((d) => d.departmentName === 'IT');
    const desigs = (await call('GET', '/api/EmployeeApp/GetDesignationsByDeptId?deptId=' + it.departmentId, undefined, token)).json;
    check('IT has 2 designations', desigs.length === 2);

    const invalid = await call('POST', '/api/EmployeeApp/CreateEmployee', { fullName: '', email: 'nope', phone: '12' }, token);
    check('invalid employee -> 400 with errors', invalid.status === 400 && invalid.json.errors.FullName && invalid.json.errors.Email && invalid.json.errors.Phone);

    const good = { fullName: 'Test User', email: 'test@x.com', phone: null, gender: null, departmentId: it.departmentId, designationId: desigs[0].designationId, employeeType: 'Permanent', salary: 1000 };
    const created = await call('POST', '/api/EmployeeApp/CreateEmployee', good, token);
    check('create employee', created.status === 200 && created.json.result && created.json.data.employeeId);
    const newId = created.json.data.employeeId;
    check('duplicate email -> 400', (await call('POST', '/api/EmployeeApp/CreateEmployee', good, token)).status === 400);

    const hr = depts.find((d) => d.departmentName === 'HR');
    const mismatch = await call('POST', '/api/EmployeeApp/CreateEmployee', { ...good, email: 'm@x.com', departmentId: hr.departmentId }, token);
    check('designation from another department -> 400', mismatch.status === 400 && mismatch.json.errors.DesignationId);

    const upd = await call('PUT', '/api/EmployeeApp/UpdateEmployee?id=' + newId, { ...good, fullName: 'Renamed User', salary: 5000 }, token);
    check('update employee', upd.json.result && upd.json.data.fullName === 'Renamed User' && upd.json.data.salary === 5000);
    check('get employee by id', (await call('GET', '/api/EmployeeApp/' + newId, undefined, token)).json.fullName === 'Renamed User');
    check('update unknown id -> 404', (await call('PUT', '/api/EmployeeApp/UpdateEmployee?id=99999', good, token)).status === 404);

    console.log('Departments and designations');
    check('cannot delete department that has employees', (await call('DELETE', '/api/EmployeeOnboarding/DeleteMasterById?id=' + it.departmentId, undefined, token)).status === 400);
    check('add department', (await call('POST', '/api/EmployeeOnboarding/CreateNewMaster', { masterFor: 'Department', parentMasterId: 0, masterValue: 'Sales' }, token)).json.result);
    check('duplicate department name -> 400', (await call('POST', '/api/EmployeeOnboarding/CreateNewMaster', { masterFor: 'Department', parentMasterId: 0, masterValue: 'sales' }, token)).status === 400);
    const sales = (await call('GET', '/api/EmployeeApp/GetDepartments', undefined, token)).json.find((d) => d.departmentName === 'Sales');
    check('new department appears in GetDepartments', !!sales);
    check('add designation', (await call('POST', '/api/EmployeeOnboarding/CreateNewMaster', { masterFor: 'Designation', parentMasterId: sales.departmentId, masterValue: 'Rep' }, token)).json.result);
    check('rename department', (await call('POST', '/api/EmployeeOnboarding/UpdateMaster?id=' + sales.departmentId, { masterValue: 'Sales Team' }, token)).json.result);
    check('delete empty department (designations go with it)', (await call('DELETE', '/api/EmployeeOnboarding/DeleteMasterById?id=' + sales.departmentId, undefined, token)).json.result);
    check('delete employee', (await call('DELETE', '/api/EmployeeApp/DeleteEmployee?id=' + newId, undefined, token)).json.result);
    check('delete employee again -> 404', (await call('DELETE', '/api/EmployeeApp/DeleteEmployee?id=' + newId, undefined, token)).status === 404);

    console.log('Token expiry and refresh');
    await sleep(2300);   // access token lives 2 seconds in this test
    check('expired token -> 401', (await call('GET', '/api/EmployeeApp/GetEmployees', undefined, token)).status === 401);
    const refreshed = await call('POST', '/api/UserApp/refresh', { emailId: 'admin@demo.com', token, refreshToken });
    check('refresh gives a new token', refreshed.json && refreshed.json.result && refreshed.json.data.token);
    check('new token works', (await call('GET', '/api/EmployeeApp/GetEmployees', undefined, refreshed.json.data.token)).status === 200);
    check('old refresh token cannot be reused', (await call('POST', '/api/UserApp/refresh', { emailId: 'admin@demo.com', refreshToken })).status === 401);
    const out = await call('POST', '/api/UserApp/logout', { refreshToken: refreshed.json.data.refreshToken });
    check('logout revokes refresh token', out.json.result && (await call('POST', '/api/UserApp/refresh', { refreshToken: refreshed.json.data.refreshToken })).status === 401);

    console.log('Registration and rate limit');
    check('short password -> 400', (await call('POST', '/api/UserApp/CreateNewUser', { emailId: 'n@x.com', password: '123' })).status === 400);
    check('register user', (await call('POST', '/api/UserApp/CreateNewUser', { emailId: 'new@x.com', password: 'longenough1', fullName: 'New User' })).json.result);
    check('new user can log in', (await call('POST', '/api/UserApp/login', { emailId: 'new@x.com', password: 'longenough1' })).json.result);
    check('duplicate registration -> result false', (await call('POST', '/api/UserApp/CreateNewUser', { emailId: 'NEW@x.com', password: 'longenough1' })).json.result === false);
    let last;
    for (let i = 0; i < 9; i++) last = await call('POST', '/api/UserApp/login', { emailId: 'victim@x.com', password: 'guess' + i });
    check('9th wrong attempt -> 429', last.status === 429);
    check('invalid JSON -> 400', (await fetch(BASE + '/api/UserApp/login', { method: 'POST', body: '{oops' })).status === 400);
  } finally {
    server.kill();
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB + ext, { force: true });
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
