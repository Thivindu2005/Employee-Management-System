// Send people back to login if they are not signed in
if (!isLoggedIn()) window.location.href = 'index.html';

const user = JSON.parse(sessionStorage.getItem('user') || '{}');
document.getElementById('userName').textContent = user.fullName || user.emailId || '';

let employees = [];
let departments = [];
let editingId = null;
const modal = new bootstrap.Modal(document.getElementById('empModal'));

// ---------- data layer ----------
// Demo mode keeps data in localStorage. Real mode calls the EmployeeApp API.
// Demo departments and designations come from demoDepts() / demoDesigs() in api.js
// so the dashboard and the departments page share the same data.

function demoList() {
  const saved = localStorage.getItem('demoEmployees');
  if (saved) return JSON.parse(saved);
  const seed = [
    { employeeId: 1, fullName: 'Nimali Perera', email: 'nimali@demo.com', phone: '0771234567', gender: 'Female', dateOfJoining: '2023-02-01', departmentId: 1, designationId: 1, employeeType: 'Permanent', salary: 185000 },
    { employeeId: 2, fullName: 'Kasun Silva', email: 'kasun@demo.com', phone: '0719876543', gender: 'Male', dateOfJoining: '2024-05-12', departmentId: 2, designationId: 3, employeeType: 'Contract', salary: 220000 }
  ];
  localStorage.setItem('demoEmployees', JSON.stringify(seed));
  return seed;
}

// the docs do not show the response shape, so accept a plain array or an ApiResponse wrapper
const unwrap = (res) => (Array.isArray(res) ? res : (res && res.data) || []);
const empId = (e) => e.employeeId ?? e.id;
const deptId = (d) => d.departmentId ?? d.id;
const deptName = (d) => d.departmentName ?? d.name;
const desigId = (d) => d.designationId ?? d.id;
const desigName = (d) => d.designationName ?? d.name;

async function loadDepartments() {
  departments = DEMO_MODE ? demoDepts() : unwrap(await apiGet('/EmployeeApp/GetDepartments'));
}
async function loadDesignations(id) {
  if (!id) return [];
  return DEMO_MODE ? demoDesigs().filter((g) => g.deptId == id) : unwrap(await apiGet('/EmployeeApp/GetDesignationsByDeptId?deptId=' + id));
}
async function loadEmployees() {
  employees = DEMO_MODE ? demoList() : unwrap(await apiGet('/EmployeeApp/GetEmployees'));
}
async function saveEmployee(data) {
  if (DEMO_MODE) {
    const list = demoList();
    if (editingId) {
      const i = list.findIndex((e) => empId(e) === editingId);
      list[i] = { ...list[i], ...data };
    } else {
      list.push({ ...data, employeeId: Date.now() });
    }
    localStorage.setItem('demoEmployees', JSON.stringify(list));
    return { result: true };
  }
  return editingId
    ? apiPut('/EmployeeApp/UpdateEmployee?id=' + editingId, data)
    : apiPost('/EmployeeApp/CreateEmployee', data);
}
async function removeEmployee(id) {
  if (DEMO_MODE) {
    localStorage.setItem('demoEmployees', JSON.stringify(demoList().filter((e) => empId(e) !== id)));
    return { result: true };
  }
  return apiDelete('/EmployeeApp/DeleteEmployee?id=' + id);
}

// ---------- rendering ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const deptLabel = (id) => { const d = departments.find((x) => deptId(x) == id); return d ? deptName(d) : '-'; };

function renderStats() {
  document.getElementById('statTotal').textContent = employees.length;
  document.getElementById('statDept').textContent = departments.length;
  document.getElementById('statPerm').textContent = employees.filter((e) => e.employeeType === 'Permanent').length;
  const pay = employees.reduce((sum, e) => sum + (Number(e.salary) || 0), 0);
  document.getElementById('statPay').textContent = pay.toLocaleString();
}

function renderTable() {
  const q = document.getElementById('search').value.toLowerCase();
  const type = document.getElementById('filterType').value;
  const rows = employees.filter((e) =>
    (!type || e.employeeType === type) &&
    ((e.fullName || '').toLowerCase().includes(q) || (e.email || '').toLowerCase().includes(q)));

  document.getElementById('empBody').innerHTML = rows.length
    ? rows.map((e) => `
      <tr>
        <td>${esc(e.fullName)}</td>
        <td>${esc(e.email)}</td>
        <td>${esc(deptLabel(e.departmentId))}</td>
        <td>${esc(e.employeeType)}</td>
        <td>${(Number(e.salary) || 0).toLocaleString()}</td>
        <td class="text-end">
          <button class="row-btn" onclick="openEdit(${empId(e)})">Edit</button>
          <button class="row-btn del" onclick="deleteEmp(${empId(e)})">Delete</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No employees found. Add your first employee.</td></tr>';
}

async function refresh() {
  try {
    await loadEmployees();
    renderStats();
    renderTable();
  } catch (err) {
    showAlert('danger', 'Could not load employees: ' + err.message);
  }
}

// ---------- form ----------
function fillSelect(sel, items, idFn, nameFn, placeholder) {
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${idFn(i)}">${esc(nameFn(i))}</option>`).join('');
}

const fDept = document.getElementById('fDept');
const fDesig = document.getElementById('fDesig');

fDept.addEventListener('change', async () => {
  fillSelect(fDesig, await loadDesignations(fDept.value), desigId, desigName, 'Select designation');
});

async function openForm(e) {
  editingId = e ? empId(e) : null;
  document.getElementById('modalTitle').textContent = e ? 'Edit employee' : 'Add employee';
  document.getElementById('formAlert').innerHTML = '';
  document.getElementById('empForm').reset();
  fillSelect(fDept, departments, deptId, deptName, 'Select department');
  fillSelect(fDesig, [], desigId, desigName, 'Select designation');

  if (e) {
    document.getElementById('fFullName').value = e.fullName || '';
    document.getElementById('fEmail').value = e.email || '';
    document.getElementById('fPhone').value = e.phone || '';
    document.getElementById('fGender').value = e.gender || '';
    document.getElementById('fJoin').value = (e.dateOfJoining || '').slice(0, 10);
    document.getElementById('fType').value = e.employeeType || 'Permanent';
    document.getElementById('fSalary').value = e.salary ?? '';
    fDept.value = e.departmentId || '';
    fillSelect(fDesig, await loadDesignations(fDept.value), desigId, desigName, 'Select designation');
    fDesig.value = e.designationId || '';
  }
  modal.show();
}

document.getElementById('addBtn').addEventListener('click', () => openForm(null));
window.openEdit = (id) => openForm(employees.find((e) => empId(e) === id));

document.getElementById('empForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fullName = document.getElementById('fFullName').value.trim();
  const email = document.getElementById('fEmail').value.trim();
  const phone = document.getElementById('fPhone').value.trim();
  const box = document.getElementById('formAlert');
  const fail = (m) => (box.innerHTML = `<div class="alert alert-danger">${m}</div>`);

  // validation from the API docs: name and email required, phone is 10 digits
  if (!fullName) return fail('Enter the full name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail('Enter a valid email address.');
  if (phone && !/^\d{10}$/.test(phone)) return fail('Phone number must be exactly 10 digits.');

  const data = {
    fullName, email,
    phone: phone || null,
    gender: document.getElementById('fGender').value || null,
    dateOfJoining: document.getElementById('fJoin').value || null,
    departmentId: Number(fDept.value) || null,
    designationId: Number(fDesig.value) || null,
    employeeType: document.getElementById('fType').value,
    salary: Number(document.getElementById('fSalary').value) || 0
  };

  try {
    const res = await saveEmployee(data);
    if (res.result === false) return fail(res.message || 'Could not save the employee.');
    modal.hide();
    showAlert('success', editingId ? 'Employee updated.' : 'Employee added.');
    refresh();
  } catch (err) {
    fail(esc(err.message || 'Could not reach the server.'));
  }
});

window.deleteEmp = async (id) => {
  if (!confirm('Delete this employee? This cannot be undone.')) return;
  try {
    const res = await removeEmployee(id);
    if (res.result === false) return showAlert('danger', res.message || 'Could not delete.');
    showAlert('success', 'Employee deleted.');
    refresh();
  } catch (err) {
    showAlert('danger', err.message || 'Could not reach the server.');
  }
};

document.getElementById('search').addEventListener('input', renderTable);
document.getElementById('filterType').addEventListener('change', renderTable);

// ---------- start ----------
(async () => {
  try { await loadDepartments(); } catch (err) { showAlert('danger', 'Could not load departments: ' + err.message); }
  refresh();
})();
