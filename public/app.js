/* FOH Tasks — S&L York
   Single-file app logic. Talks to /api/data (Netlify Blobs) for shared,
   cross-device storage. No login for staff; a 4-digit PIN gates the Admin
   tab only (editing task lists, close-down list, order sheet, week anchor).
*/

const DAY_NAMES = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
const DAY_SHORT = {MONDAY:'Mon',TUESDAY:'Tue',WEDNESDAY:'Wed',THURSDAY:'Thu',FRIDAY:'Fri',SATURDAY:'Sat',SUNDAY:'Sun'};

let CONFIG = null;          // { days, closedown, order, adminPin, weekAnchor }
let selectedDate = startOfDay(new Date());   // date shown on "Today's Tasks" tab
let taskState = null;       // state blob for selectedDate
let closedownState = null;  // state blob for real "today"
let orderEntries = null;    // persistent order-sheet entries
let adminUnlocked = false;
let sectionCollapse = {};   // local-only UI state, not synced
let saveTimers = {};

/* ---------------- date / week helpers ---------------- */

function pad(n){ return n < 10 ? '0' + n : '' + n; }
function isoDate(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function mondayOf(d){
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Mon=0 ... Sun=6
  x.setDate(x.getDate() - dow);
  return x;
}
function isSameDay(a,b){ return isoDate(a) === isoDate(b); }
function dayNameOf(d){ return DAY_NAMES[(d.getDay()+6)%7]; }

function computeWeekInfo(date, anchor){
  const anchorMonday = mondayOf(new Date(anchor.date + 'T00:00:00'));
  const thisMonday = mondayOf(date);
  const diffDays = Math.round((thisMonday - anchorMonday) / 86400000);
  const weeksSince = Math.floor(diffDays / 7);
  const weekNum = (((anchor.week - 1 + weeksSince) % 52) + 52) % 52 + 1;
  const parity = (weekNum % 2 === 1) ? 'odd' : 'even';
  return { weekNum, parity };
}

function getCurrentWeekDates(){
  const monday = mondayOf(new Date());
  const out = [];
  for(let i=0;i<7;i++){ const d = new Date(monday); d.setDate(monday.getDate()+i); out.push(d); }
  return out;
}

function formatLongDate(d){
  return d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

/* ---------------- backend helpers ---------------- */

async function apiGet(key){
  try{
    const res = await fetch('/api/data?key=' + encodeURIComponent(key));
    if(!res.ok) return null;
    const j = await res.json();
    return j.value ?? null;
  }catch(e){ return null; }
}
async function apiSet(key, value){
  try{
    await fetch('/api/data', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key, value })
    });
    return true;
  }catch(e){ return false; }
}

function debouncedSave(key, value, delay){
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => { apiSet(key, value); markSynced(); }, delay || 500);
}

/* ---------------- toast / sync UI ---------------- */

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function markSynced(){
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  dot.classList.remove('stale');
  label.textContent = 'synced';
}
function markStale(){
  const dot = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  dot.classList.add('stale');
  label.textContent = 'syncing…';
}

/* ---------------- config load ---------------- */

function defaultConfig(){
  const d = window.__FOH_DEFAULT_DATA__;
  return {
    days: d.days,
    closedown: d.closedown,
    order: d.order,
    adminPin: '4321',
    weekAnchor: { date: '2026-08-31', week: 49 } // Mon 31 Aug 2026 = week 49 (odd)
  };
}

async function loadConfig(){
  markStale();
  const remote = await apiGet('config');
  if(remote && remote.days){
    CONFIG = remote;
  } else {
    CONFIG = defaultConfig();
    await apiSet('config', CONFIG); // seed it so admin edits have something to build on
  }
  markSynced();
}

/* ---------------- header ---------------- */

function renderHeader(){
  const info = computeWeekInfo(selectedDate, CONFIG.weekAnchor);
  document.getElementById('dateLine').textContent = formatLongDate(new Date());
  const pill = document.getElementById('weekPill');
  pill.textContent = 'Week ' + info.weekNum + ' · ' + (info.parity === 'odd' ? 'Odd' : 'Even');
  pill.className = 'week-pill' + (info.parity === 'even' ? ' even' : '');
}

/* ---------------- TODAY TAB ---------------- */

function renderDayStrip(){
  const strip = document.getElementById('dayStrip');
  strip.innerHTML = '';
  const today = startOfDay(new Date());
  getCurrentWeekDates().forEach(d => {
    const chip = document.createElement('button');
    chip.className = 'day-chip' + (isSameDay(d, selectedDate) ? ' active' : '') + (isSameDay(d, today) ? ' today' : '');
    chip.textContent = DAY_SHORT[dayNameOf(d)] + ' ' + d.getDate();
    chip.addEventListener('click', () => { selectedDate = d; loadAndRenderToday(); });
    strip.appendChild(chip);
  });
}

async function loadAndRenderToday(){
  renderHeader();
  renderDayStrip();
  const key = 'taskstate:' + isoDate(selectedDate);
  markStale();
  const remote = await apiGet(key);
  taskState = remote || { meta: { salesTarget:'', amManager:'', pmManager:'' }, sections: {} };
  markSynced();
  document.getElementById('salesTarget').value = taskState.meta.salesTarget || '';
  document.getElementById('amManager').value = taskState.meta.amManager || '';
  document.getElementById('pmManager').value = taskState.meta.pmManager || '';
  renderTodaySections();
}

function saveTaskStateSoon(){
  debouncedSave('taskstate:' + isoDate(selectedDate), taskState, 500);
}

function renderTodaySections(){
  const info = computeWeekInfo(selectedDate, CONFIG.weekAnchor);
  const dayName = dayNameOf(selectedDate);
  const sections = (CONFIG.days[info.parity] && CONFIG.days[info.parity][dayName]) || [];
  const wrap = document.getElementById('todaySections');
  wrap.innerHTML = '';

  if(sections.length === 0){
    wrap.innerHTML = '<div class="empty-note">No tasks set up for this day yet. Add some in Admin.</div>';
    return;
  }

  sections.forEach((section, sIdx) => {
    if(!taskState.sections[sIdx]) taskState.sections[sIdx] = {};
    const card = buildSectionCard(section, sIdx, taskState.sections[sIdx], saveTaskStateSoon, 'today');
    wrap.appendChild(card);
  });
}

/* Shared section-card builder, used by Today tab and Close Down tab.
   scopeKey namespaces the collapse-state map so today/closedown don't clash. */
function buildSectionCard(section, sIdx, stateForSection, onChange, scopeKey){
  const collapseKey = scopeKey + ':' + sIdx;
  const card = document.createElement('div');
  card.className = 'section-card';

  const head = document.createElement('div');
  head.className = 'section-head';

  const isInfoSection = section.name === 'A-BOARD';
  const doneCount = isInfoSection ? 0 : section.items.filter((_, i) => stateForSection[i] && stateForSection[i].done).length;

  head.innerHTML = '<h3>' + escapeHtml(section.name) + '</h3>' +
    (isInfoSection ? '' : '<span class="section-progress">' + doneCount + '/' + section.items.length + '</span>');
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'section-body' + (sectionCollapse[collapseKey] ? ' collapsed' : '');
  card.appendChild(body);

  head.addEventListener('click', () => {
    sectionCollapse[collapseKey] = !sectionCollapse[collapseKey];
    body.classList.toggle('collapsed');
  });

  section.items.forEach((itemText, iIdx) => {
    if(isInfoSection){
      const row = document.createElement('div');
      row.className = 'info-row';
      row.textContent = itemText;
      body.appendChild(row);
      return;
    }

    if(!stateForSection[iIdx]) stateForSection[iIdx] = { done:false, initials:'' };
    const item = stateForSection[iIdx];

    const row = document.createElement('div');
    row.className = 'task-row';

    const check = document.createElement('button');
    check.className = 'check' + (item.done ? ' done' : '');
    check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="4,13 9,18 20,6"/></svg>';
    check.addEventListener('click', () => {
      item.done = !item.done;
      check.classList.toggle('done', item.done);
      text.classList.toggle('done', item.done);
      head.querySelector('.section-progress') && updateProgress();
      onChange();
      if(item.done && !item.initials){ initialsInput.focus(); }
    });

    const text = document.createElement('div');
    text.className = 'task-text' + (item.done ? ' done' : '');
    text.textContent = itemText;

    const initialsInput = document.createElement('input');
    initialsInput.className = 'initials-input';
    initialsInput.maxLength = 4;
    initialsInput.placeholder = 'init.';
    initialsInput.value = item.initials || '';
    initialsInput.addEventListener('input', () => {
      item.initials = initialsInput.value.toUpperCase();
      initialsInput.value = item.initials;
      onChange();
    });

    row.appendChild(check);
    row.appendChild(text);
    row.appendChild(initialsInput);
    body.appendChild(row);
  });

  function updateProgress(){
    const el = head.querySelector('.section-progress');
    if(!el) return;
    const c = section.items.filter((_, i) => stateForSection[i] && stateForSection[i].done).length;
    el.textContent = c + '/' + section.items.length;
  }

  return card;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- CLOSE DOWN TAB ---------------- */

async function loadAndRenderClosedown(){
  const key = 'closedownstate:' + isoDate(new Date());
  markStale();
  const remote = await apiGet(key);
  closedownState = remote || { sections: {} };
  markSynced();
  renderClosedownSections();
}

function saveClosedownSoon(){
  debouncedSave('closedownstate:' + isoDate(new Date()), closedownState, 500);
}

function renderClosedownSections(){
  const wrap = document.getElementById('closedownSections');
  wrap.innerHTML = '';
  const sections = CONFIG.closedown || [];
  if(sections.length === 0){
    wrap.innerHTML = '<div class="empty-note">No close-down checklist set up yet. Add one in Admin.</div>';
    return;
  }
  sections.forEach((section, sIdx) => {
    if(!closedownState.sections[sIdx]) closedownState.sections[sIdx] = {};
    const card = buildSectionCard(section, sIdx, closedownState.sections[sIdx], saveClosedownSoon, 'closedown');
    wrap.appendChild(card);
  });
}

/* ---------------- ORDER SHEET TAB ---------------- */

async function loadAndRenderOrder(){
  markStale();
  const remote = await apiGet('orderentries');
  orderEntries = remote || {};
  markSynced();
  renderOrderTable();
}

function saveOrderSoon(){
  debouncedSave('orderentries', orderEntries, 500);
}

function renderOrderTable(){
  const body = document.getElementById('orderTableBody');
  body.innerHTML = '';
  const items = CONFIG.order || [];
  if(items.length === 0){
    body.innerHTML = '<tr><td colspan="4" class="empty-note">No products on the order sheet yet. Add some in Admin.</td></tr>';
    return;
  }
  items.forEach((item, idx) => {
    if(!orderEntries[idx]) orderEntries[idx] = { need:'' };
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(item.product) + (item.notes ? '<br><span style="color:var(--muted);font-size:0.72rem;">' + escapeHtml(item.notes) + '</span>' : '') + '</td>' +
      '<td>' + escapeHtml(item.pack_size || '') + '</td>' +
      '<td>' + escapeHtml(String(item.par ?? '')) + '</td>' +
      '<td></td>';
    const needTd = tr.querySelector('td:last-child');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = orderEntries[idx].need || '';
    input.addEventListener('input', () => {
      orderEntries[idx].need = input.value;
      saveOrderSoon();
    });
    needTd.appendChild(input);
    body.appendChild(tr);
  });
}

document.getElementById('clearOrderBtn').addEventListener('click', () => {
  if(!confirm('Clear all "need to order" amounts?')) return;
  orderEntries = {};
  apiSet('orderentries', orderEntries);
  renderOrderTable();
  toast('Cleared');
});

document.getElementById('salesTarget').addEventListener('input', e => { taskState.meta.salesTarget = e.target.value; saveTaskStateSoon(); });
document.getElementById('amManager').addEventListener('input', e => { taskState.meta.amManager = e.target.value; saveTaskStateSoon(); });
document.getElementById('pmManager').addEventListener('input', e => { taskState.meta.pmManager = e.target.value; saveTaskStateSoon(); });

/* ---------------- ADMIN TAB ---------------- */

let pinEntry = '';

function renderAdminTab(){
  if(!adminUnlocked){
    document.getElementById('pinGateWrap').style.display = 'block';
    document.getElementById('adminPanel').style.display = 'none';
    renderPinGate();
  } else {
    document.getElementById('pinGateWrap').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    renderAdminPanel();
  }
}

function renderPinGate(){
  pinEntry = '';
  const wrap = document.getElementById('pinGateWrap');
  wrap.innerHTML =
    '<div class="pin-gate">' +
      '<h2>Admin</h2>' +
      '<p>Enter the 4-digit PIN to edit tasks, close down list, order sheet and the week calendar.</p>' +
      '<div class="pin-dots" id="pinDots"></div>' +
      '<div class="pin-pad" id="pinPad"></div>' +
      '<div class="pin-error" id="pinError"></div>' +
    '</div>';
  updatePinDots();
  const pad = document.getElementById('pinPad');
  ['1','2','3','4','5','6','7','8','9','','0','⌫'].forEach(k => {
    const btn = document.createElement('button');
    btn.className = 'pin-key';
    if(k === ''){ btn.style.visibility = 'hidden'; }
    btn.textContent = k;
    btn.addEventListener('click', () => onPinKey(k));
    pad.appendChild(btn);
  });
}

function updatePinDots(){
  const dots = document.getElementById('pinDots');
  dots.innerHTML = '';
  for(let i=0;i<4;i++){
    const d = document.createElement('div');
    d.className = 'pin-dot' + (i < pinEntry.length ? ' filled' : '');
    dots.appendChild(d);
  }
}

function onPinKey(k){
  if(k === '⌫'){ pinEntry = pinEntry.slice(0,-1); updatePinDots(); return; }
  if(k === '' || pinEntry.length >= 4) return;
  pinEntry += k;
  updatePinDots();
  if(pinEntry.length === 4){
    if(pinEntry === (CONFIG.adminPin || '4321')){
      adminUnlocked = true;
      renderAdminTab();
    } else {
      document.getElementById('pinError').textContent = 'Incorrect PIN';
      setTimeout(() => { pinEntry=''; updatePinDots(); document.getElementById('pinError').textContent=''; }, 700);
    }
  }
}

function renderAdminPanel(){
  const panel = document.getElementById('adminPanel');
  panel.innerHTML = '';

  panel.appendChild(buildAdminBar());
  panel.appendChild(buildWeekAnchorSection());
  panel.appendChild(buildPinSection());
  panel.appendChild(buildTaskEditorSection());
  panel.appendChild(buildClosedownEditorSection());
  panel.appendChild(buildOrderEditorSection());
}

function buildAdminBar(){
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;';
  bar.innerHTML = '<div style="font-size:0.8rem;color:var(--muted);">Signed in as admin</div>';
  const btn = document.createElement('button');
  btn.className = 'btn secondary small';
  btn.textContent = 'Lock';
  btn.addEventListener('click', () => { adminUnlocked = false; renderAdminTab(); });
  bar.appendChild(btn);
  return bar;
}

async function saveConfig(msg){
  await apiSet('config', CONFIG);
  toast(msg || 'Saved');
}

function buildWeekAnchorSection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Week calendar</h3>' +
    '<p style="color:var(--muted);font-size:0.82rem;margin-top:-4px;">Tell the app one known Monday and its week number (1–52) — everything else is calculated from that.</p>';

  const row = document.createElement('div');
  row.className = 'select-row';
  row.innerHTML =
    '<div><div class="field-label">Anchor Monday</div><input class="subtle-input" type="date" id="anchorDate" value="' + CONFIG.weekAnchor.date + '"></div>' +
    '<div><div class="field-label">Week number (1–52)</div><input class="subtle-input" type="number" min="1" max="52" id="anchorWeek" value="' + CONFIG.weekAnchor.week + '" style="width:100px;"></div>';
  wrap.appendChild(row);

  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = 'Save week calendar';
  btn.addEventListener('click', async () => {
    const dateVal = document.getElementById('anchorDate').value;
    const weekVal = parseInt(document.getElementById('anchorWeek').value, 10);
    const d = new Date(dateVal + 'T00:00:00');
    if(!dateVal || dayNameOf(d) !== 'MONDAY'){
      toast('Anchor date must be a Monday'); return;
    }
    if(!weekVal || weekVal < 1 || weekVal > 52){ toast('Week must be 1–52'); return; }
    CONFIG.weekAnchor = { date: dateVal, week: weekVal };
    await saveConfig('Week calendar saved');
    renderHeader();
    if(document.querySelector('.tab-btn[data-view="today"]').classList.contains('active')) loadAndRenderToday();
  });
  wrap.appendChild(btn);
  return wrap;
}

function buildPinSection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Admin PIN</h3>';
  const row = document.createElement('div');
  row.className = 'select-row';
  row.innerHTML = '<input class="subtle-input" type="text" inputmode="numeric" maxlength="4" id="newPin" placeholder="New 4-digit PIN" style="width:160px;">';
  wrap.appendChild(row);
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = 'Update PIN';
  btn.addEventListener('click', async () => {
    const v = document.getElementById('newPin').value.trim();
    if(!/^\d{4}$/.test(v)){ toast('PIN must be exactly 4 digits'); return; }
    CONFIG.adminPin = v;
    await saveConfig('PIN updated');
    document.getElementById('newPin').value = '';
  });
  wrap.appendChild(btn);
  return wrap;
}

function buildTaskEditorSection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Daily tasks</h3>';

  const selRow = document.createElement('div');
  selRow.className = 'select-row';
  selRow.innerHTML =
    '<select id="editParity"><option value="odd">Odd week</option><option value="even">Even week</option></select>' +
    '<select id="editDay">' + DAY_NAMES.map(d => '<option value="'+d+'">'+d.charAt(0)+d.slice(1).toLowerCase()+'</option>').join('') + '</select>';
  wrap.appendChild(selRow);

  const listWrap = document.createElement('div');
  listWrap.id = 'taskEditorList';
  wrap.appendChild(listWrap);

  const addSectionBtn = document.createElement('button');
  addSectionBtn.className = 'btn secondary small';
  addSectionBtn.textContent = '+ Add section';
  addSectionBtn.style.marginTop = '8px';
  addSectionBtn.addEventListener('click', () => {
    const parity = document.getElementById('editParity').value;
    const day = document.getElementById('editDay').value;
    CONFIG.days[parity][day] = CONFIG.days[parity][day] || [];
    CONFIG.days[parity][day].push({ name:'NEW SECTION', items:[] });
    renderTaskEditorList();
  });
  wrap.appendChild(addSectionBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn small';
  saveBtn.textContent = 'Save daily tasks';
  saveBtn.style.marginTop = '8px';
  saveBtn.style.marginLeft = '8px';
  saveBtn.addEventListener('click', () => saveConfig('Daily tasks saved'));
  wrap.appendChild(saveBtn);

  function renderTaskEditorList(){
    const parity = document.getElementById('editParity').value;
    const day = document.getElementById('editDay').value;
    const sections = CONFIG.days[parity][day] || [];
    listWrap.innerHTML = '';
    sections.forEach((section, sIdx) => {
      listWrap.appendChild(buildEditableSection(section, () => {
        sections.splice(sIdx,1);
        renderTaskEditorList();
      }));
    });
  }

  document.addEventListener('DOMContentLoaded', renderTaskEditorList);
  selRow.querySelector('#editParity').addEventListener('change', renderTaskEditorList);
  selRow.querySelector('#editDay').addEventListener('change', renderTaskEditorList);
  setTimeout(renderTaskEditorList, 0);

  return wrap;
}

/* Builds an editable section block: title input, item rows, add-item, remove-section */
function buildEditableSection(section, onRemoveSection){
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:10px;';

  const titleRow = document.createElement('div');
  titleRow.className = 'admin-row';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = section.name;
  titleInput.addEventListener('input', () => { section.name = titleInput.value; });
  const rmSectionBtn = document.createElement('button');
  rmSectionBtn.className = 'rm-btn';
  rmSectionBtn.textContent = '✕ section';
  rmSectionBtn.addEventListener('click', () => { if(confirm('Remove this whole section?')) onRemoveSection(); });
  titleRow.appendChild(titleInput);
  titleRow.appendChild(rmSectionBtn);
  box.appendChild(titleRow);

  const itemsWrap = document.createElement('div');
  itemsWrap.style.marginTop = '6px';
  box.appendChild(itemsWrap);

  function renderItems(){
    itemsWrap.innerHTML = '';
    section.items.forEach((text, iIdx) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = text;
      input.addEventListener('input', () => { section.items[iIdx] = input.value; });
      const rm = document.createElement('button');
      rm.className = 'rm-btn';
      rm.textContent = '✕';
      rm.addEventListener('click', () => { section.items.splice(iIdx,1); renderItems(); });
      row.appendChild(input);
      row.appendChild(rm);
      itemsWrap.appendChild(row);
    });
  }
  renderItems();

  const addItemBtn = document.createElement('button');
  addItemBtn.className = 'btn secondary small';
  addItemBtn.textContent = '+ Add item';
  addItemBtn.addEventListener('click', () => { section.items.push(''); renderItems(); });
  box.appendChild(addItemBtn);

  return box;
}

function buildClosedownEditorSection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Close down checklist</h3><p style="color:var(--muted);font-size:0.82rem;margin-top:-4px;">One list, used every night.</p>';

  const listWrap = document.createElement('div');
  wrap.appendChild(listWrap);

  function renderList(){
    listWrap.innerHTML = '';
    CONFIG.closedown.forEach((section, sIdx) => {
      listWrap.appendChild(buildEditableSection(section, () => {
        CONFIG.closedown.splice(sIdx,1);
        renderList();
      }));
    });
  }
  renderList();

  const addBtn = document.createElement('button');
  addBtn.className = 'btn secondary small';
  addBtn.textContent = '+ Add section';
  addBtn.addEventListener('click', () => { CONFIG.closedown.push({name:'NEW SECTION', items:[]}); renderList(); });
  wrap.appendChild(addBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn small';
  saveBtn.textContent = 'Save close down list';
  saveBtn.style.marginLeft = '8px';
  saveBtn.addEventListener('click', () => saveConfig('Close down list saved'));
  wrap.appendChild(saveBtn);

  return wrap;
}

function buildOrderEditorSection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Order sheet — products &amp; par levels</h3>';

  const listWrap = document.createElement('div');
  wrap.appendChild(listWrap);

  function renderList(){
    listWrap.innerHTML = '';
    CONFIG.order.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.style.flexWrap = 'wrap';
      row.innerHTML =
        '<input type="text" data-f="product" placeholder="Product" style="flex:2;min-width:140px;" value="'+escapeHtml(item.product||'')+'">' +
        '<input type="text" data-f="pack_size" placeholder="Pack size" style="flex:1;min-width:80px;" value="'+escapeHtml(item.pack_size||'')+'">' +
        '<input type="text" data-f="par" placeholder="Par" style="flex:0 0 60px;" value="'+escapeHtml(String(item.par??''))+'">';
      row.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', () => { item[inp.dataset.f] = inp.value; });
      });
      const rm = document.createElement('button');
      rm.className = 'rm-btn';
      rm.textContent = '✕';
      rm.addEventListener('click', () => { CONFIG.order.splice(idx,1); renderList(); });
      row.appendChild(rm);
      listWrap.appendChild(row);
    });
  }
  renderList();

  const addBtn = document.createElement('button');
  addBtn.className = 'btn secondary small';
  addBtn.textContent = '+ Add product';
  addBtn.addEventListener('click', () => { CONFIG.order.push({product:'', pack_size:'', par:'', notes:''}); renderList(); });
  wrap.appendChild(addBtn);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn small';
  saveBtn.textContent = 'Save order sheet';
  saveBtn.style.marginLeft = '8px';
  saveBtn.addEventListener('click', () => saveConfig('Order sheet saved'));
  wrap.appendChild(saveBtn);

  return wrap;
}

/* ---------------- TABS / NAV ---------------- */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    if(btn.dataset.view === 'admin') renderAdminTab();
  });
});

/* ---------------- SYNC ---------------- */

function activeViewName(){
  return document.querySelector('.tab-btn.active').dataset.view;
}

async function fullRefresh(){
  await loadConfig();
  renderHeader();
  const view = activeViewName();
  if(view === 'today') await loadAndRenderToday();
  else if(view === 'closedown') await loadAndRenderClosedown();
  else if(view === 'order') await loadAndRenderOrder();
  else if(view === 'admin' && adminUnlocked) renderAdminPanel();
}

document.getElementById('syncNowBtn').addEventListener('click', fullRefresh);
setInterval(fullRefresh, 20000);
['visibilitychange','focus','pageshow'].forEach(ev => {
  window.addEventListener(ev, () => { if(document.visibilityState !== 'hidden') fullRefresh(); });
});

/* Preload the other tabs' data lazily when first opened */
document.querySelector('.tab-btn[data-view="closedown"]').addEventListener('click', () => { if(!closedownState) loadAndRenderClosedown(); });
document.querySelector('.tab-btn[data-view="order"]').addEventListener('click', () => { if(!orderEntries) loadAndRenderOrder(); });

/* ---------------- INIT ---------------- */

(async function init(){
  await loadConfig();
  renderHeader();
  await loadAndRenderToday();
})();
