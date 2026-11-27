if (!isLoggedIn()) window.location.href = 'index.html';

// ---------- field names ----------
// The EmployeeApp API only has read endpoints for departments and designations.
// To add, rename or delete them we use the EmployeeOnboarding master-data endpoints.
// The docs do not list that model's fields, so these names are guesses.
// Check the real request in the Network tab and fix them here if they differ.
const MASTER_FOR_DEPT = 'Department';
const MASTER_FOR_DESIG = 'Designation';
const NAME_FIELD = 'masterValue';

// Set to true if the real API turns out not to support adding/renaming/deleting here.
// The page then only lists departments and designations.
const READ_ONLY = false;

let departments = [];
let designations = [];
let selectedDept = null;
let mode = null;        // 'dept' or 'desig'
let editingId = null;
const modal = new bootstrap.Modal(document.getElementById('nameModal'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const unwrap = (res) => (Array.isArray(res) ? res : (res && res.data) || []);
const dId = (d) => d.departmentId ?? d.id;
const dName = (d) => d.departmentName ?? d.name;
const gId = (d) => d.designationId ?? d.id;
const gName = (d) => d.designationName ?? d.name;

// ---------- loading ----------
async function loadDepartments() {
  departments = DEMO_MODE ? demoDepts() : unwrap(await apiGet('/EmployeeApp/GetDepartments'));
  renderDepartments();
}

async function loadDesignations() {
  if (!selectedDept) { designations = []; return renderDesignations(); }
  designations = DEMO_MODE
    ? demoDesigs().filter((d) => d.deptId == selectedDept)
    : unwrap(await apiGet('/EmployeeApp/GetDesignationsByDeptId?deptId=' + selectedDept));
  renderDesignations();
}

// ---------- rendering ----------
function renderDepartments() {
  document.getElementById('deptList').innerHTML = departments.length
    ? departments.map((d) => `
      <li class="item ${dId(d) == selectedDept ? 'active' : ''}" onclick="selectDept(${dId(d)})">
        <span>${esc(dName(d))}</span>
        ${READ_ONLY ? '' : `<span>
          <button class="row-btn" onclick="event.stopPropagation(); openForm('dept', ${dId(d)})">Rename</button>
          <button class="row-btn del" onclick="event.stopPropagation(); removeItem('dept', ${dId(d)})">Delete</button>
        </span>`}
      </li>`).join('')
    : '<li class="empty">No departments yet. Add your first department.</li>';
}

function renderDesignations() {
  const dept = departments.find((d) => dId(d) == selectedDept);
  document.getElementById('desigTitle').textContent = dept ? dName(dept) + ' designations' : 'Designations';
  document.getElementById('addDesig').disabled = !selectedDept;
  document.getElementById('addDesig').hidden = READ_ONLY;
  document.getElementById('desigList').innerHTML = !selectedDept
    ? '<li class="empty">Select a department to see its designations.</li>'
    : designations.length
      ? designations.map((g) => `
        <li class="item">
          <span>${esc(gName(g))}</span>
          ${READ_ONLY ? '' : `<span>
            <button class="row-btn" onclick="openForm('desig', ${gId(g)})">Rename</button>
            <button class="row-btn del" onclick="removeItem('desig', ${gId(g)})">Delete</button>
          </span>`}
        </li>`).join('')
      : '<li class="empty">No designations in this department yet.</li>';
}

window.selectDept = (id) => { selectedDept = id; renderDepartments(); loadDesignations(); };

// ---------- add / rename ----------
window.openForm = (type, id = null) => {
  mode = type; editingId = id;
  const list = type === 'dept' ? departments : designations;
  const current = id ? list.find((x) => (type === 'dept' ? dId(x) : gId(x)) == id) : null;
  document.getElementById('nameTitle').textContent =
    (id ? 'Rename ' : 'Add ') + (type === 'dept' ? 'department' : 'designation');
  document.getElementById('nameInput').value = current ? (type === 'dept' ? dName(current) : gName(current)) : '';
  document.getElementById('formAlert').innerHTML = '';
  modal.show();
};
document.getElementById('addDept').addEventListener('click', () => openForm('dept'));
document.getElementById('addDesig').addEventListener('click', () => openForm('desig'));

async function save(name) {
  if (DEMO_MODE) {
    const key = mode === 'dept' ? 'demoDepts' : 'demoDesigs';
    const list = mode === 'dept' ? demoDepts() : demoDesigs();
    if (editingId) list.find((x) => x.id == editingId).name = name;
    else list.push(mode === 'dept' ? { id: Date.now(), name } : { id: Date.now(), name, deptId: Number(selectedDept) });
    localStorage.setItem(key, JSON.stringify(list));
    return { result: true };
  }
  const body = {
    masterFor: mode === 'dept' ? MASTER_FOR_DEPT : MASTER_FOR_DESIG,
    parentMasterId: mode === 'dept' ? 0 : Number(selectedDept),
    [NAME_FIELD]: name
  };
  return editingId
    ? apiPost('/EmployeeOnboarding/UpdateMaster?id=' + editingId, body)
    : apiPost('/EmployeeOnboarding/CreateNewMaster', body);
}

document.getElementById('nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('nameInput').value.trim();
  const box = document.getElementById('formAlert');
  if (!name) return (box.innerHTML = '<div class="alert alert-danger">Enter a name.</div>');

  // stop duplicate names in the same list
  const list = mode === 'dept' ? departments : designations;
  const nameOf = mode === 'dept' ? dName : gName;
  const idOf = mode === 'dept' ? dId : gId;
  if (list.some((x) => nameOf(x).toLowerCase() === name.toLowerCase() && idOf(x) != editingId)) {
    return (box.innerHTML = '<div class="alert alert-danger">That name already exists.</div>');
  }

  try {
    const res = await save(name);
    if (res.result === false) return (box.innerHTML = `<div class="alert alert-danger">${esc(res.message || 'Could not save.')}</div>`);
    modal.hide();
    if (mode === 'dept') {
      await loadDepartments();
      // the master-data endpoint may write to a different table than GetDepartments reads
      if (!DEMO_MODE && !departments.some((x) => dName(x).toLowerCase() === name.toLowerCase())) {
        return showAlert('danger', 'Saved, but "' + name + '" does not appear in GetDepartments. Check the field names in the Network tab, or set READ_ONLY = true.');
      }
    } else {
      await loadDesignations();
    }
    showAlert('success', 'Saved.');
  } catch (err) {
    box.innerHTML = `<div class="alert alert-danger">${esc(err.message || 'Could not reach the server.')}</div>`;
  }
});

// ---------- delete ----------
window.removeItem = async (type, id) => {
  if (type === 'dept') {
    // warn when employees still use this department (demo data only; the real API will refuse or not)
    const used = DEMO_MODE && JSON.parse(localStorage.getItem('demoEmployees') || '[]').some((e) => e.departmentId == id);
    if (used) return showAlert('danger', 'Employees still belong to this department. Move them first.');
  }
  if (!confirm('Delete this ' + (type === 'dept' ? 'department' : 'designation') + '?')) return;

  try {
    let res = { result: true };
    if (DEMO_MODE) {
      if (type === 'dept') {
        localStorage.setItem('demoDepts', JSON.stringify(demoDepts().filter((d) => d.id != id)));
        localStorage.setItem('demoDesigs', JSON.stringify(demoDesigs().filter((g) => g.deptId != id)));
      } else {
        localStorage.setItem('demoDesigs', JSON.stringify(demoDesigs().filter((g) => g.id != id)));
      }
    } else {
      res = await apiDelete('/EmployeeOnboarding/DeleteMasterById?id=' + id);
    }
    if (res.result === false) return showAlert('danger', res.message || 'Could not delete.');
    showAlert('success', 'Deleted.');
    if (type === 'dept') { if (selectedDept == id) selectedDept = null; await loadDepartments(); loadDesignations(); }
    else loadDesignations();
  } catch (err) {
    showAlert('danger', err.message || 'Could not reach the server.');
  }
};

// ---------- start ----------
loadDepartments().catch((err) => showAlert('danger', 'Could not load departments: ' + err.message));
renderDesignations();
document.getElementById('addDept').hidden = READ_ONLY;
