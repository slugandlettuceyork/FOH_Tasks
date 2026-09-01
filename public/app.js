/* FOH Tasks — S&L York
   Single-file app logic. Talks to /api/data (Netlify Blobs) for shared,
   cross-device storage. No login for staff; a 4-digit PIN gates the Admin
   tab only (editing task lists, close-down list, order sheet, week anchor).
*/

const APP_VERSION = '2026-09-01.3'; // shown in header; bump this on every deploy so it's obvious a change landed

const DAY_NAMES = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
const DAY_SHORT = {MONDAY:'Mon',TUESDAY:'Tue',WEDNESDAY:'Wed',THURSDAY:'Thu',FRIDAY:'Fri',SATURDAY:'Sat',SUNDAY:'Sun'};
// One colour per weekday for the day-strip pills (readable text kept dark/white per pair).
const DAY_CLASS = {MONDAY:'mon',TUESDAY:'tue',WEDNESDAY:'wed',THURSDAY:'thu',FRIDAY:'fri',SATURDAY:'sat',SUNDAY:'sun'};

/* Daily Cleaning Tasks items that didn't get ticked + initialed carry
   forward onto the next day (and the next, etc) so they don't get lost,
   but we don't want them piling up forever if something's genuinely not
   getting done — they drop off after this many days. */
const CARRY_MAX_DAYS = 3;

let CONFIG = null;          // { days, closedown, order, adminPin, weekAnchor }
let selectedDate = businessDate();   // date shown on "Today's Tasks" tab
let taskState = null;       // state blob for selectedDate
let orderEntries = null;    // persistent order-sheet entries
let adminUnlocked = false;
let sectionCollapse = {};   // local-only UI state, not synced

/* ---------------- date / week helpers ---------------- */

function pad(n){ return n < 10 ? '0' + n : '' + n; }
function isoDate(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }

/* The venue trades past midnight, so a new "day" (and, on Mondays, a new
   week) doesn't start until 4am rather than at midnight — 2am on what the
   clock calls Monday is still Sunday night's shift as far as the
   checklists are concerned. Everywhere the app needs "today", it should
   go through this rather than `new Date()` directly. */
function businessDate(){
  const d = new Date();
  if(d.getHours() < 4){ d.setDate(d.getDate() - 1); }
  return startOfDay(d);
}

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
  const monday = mondayOf(businessDate());
  const out = [];
  for(let i=0;i<7;i++){ const d = new Date(monday); d.setDate(monday.getDate()+i); out.push(d); }
  return out;
}

function formatLongDate(d){
  return d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

/* 1st, 2nd, 3rd, 4th... */
function ordinal(n){
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function daysBetweenIso(isoA, isoB){
  return Math.round((new Date(isoB + 'T00:00:00') - new Date(isoA + 'T00:00:00')) / 86400000);
}
function formatShortDate(d){
  return DAY_SHORT[dayNameOf(d)] + ' ' + ordinal(d.getDate()) + ' ' + d.toLocaleDateString('en-GB',{month:'short'});
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

/* ---------------- write ordering / anti-race sync layer ----------------
   A tick or initial saves to local state instantly (UI updates right away),
   but the save to the shared server happens as a background request. If a
   periodic sync poll asks the server "what's current?" while that save is
   still in flight, it can get back the pre-edit version and briefly stomp
   the local edit until the next poll catches up. That's the "ticks
   disappear then reappear" symptom.

   Fix, in two parts:
   1. Writes to the same key are chained in order (writeChains), and any
      pull first waits for whatever's already queued for that key to land
      on the server (pendingWrite/apiGetFresh) before asking for the
      current value — so a pull can't read data out from under a save
      that's already in flight.
   2. That still leaves a narrower gap: an edit landing in the split-second
      while the pull's own fetch to the server is already underway. Every
      local edit bumps a per-key generation counter; a pull records that
      counter before it starts and only applies the server's value if the
      counter hasn't moved by the time the fetch resolves. If it has, the
      pull leaves that key alone and lets the edit's own save (already
      queued above) and the next poll settle it instead. */

const writeChains = {};   // key -> promise chain of queued saves, in order
const pendingSave = {};   // key -> { resolve, timer } for the in-progress debounce batch
const editGen = {};       // key -> counts local edits, used to detect races with in-flight pulls

// Belt-and-braces on top of the chain/generation guards above: Netlify Blobs
// defaults to *eventual* consistency, so a read can occasionally hit a
// stale edge-cached copy for a short while after a write (the backend
// function now asks for 'strong' consistency to avoid this, but a sync
// simply refusing to run during a burst of active ticking removes the
// question entirely, on any device). No background/periodic sync runs
// within this many ms of the last local edit; if one's due, it waits for
// things to go quiet and retries once.
const EDIT_GRACE_MS = 2500;
let lastLocalEditAt = 0;
let refreshRetryTimer = null;

function bumpGen(key){ editGen[key] = (editGen[key] || 0) + 1; lastLocalEditAt = Date.now(); }

function cloneVal(v){ return JSON.parse(JSON.stringify(v)); }

/* Immediate save (chained onto the key's queue), for discrete actions like
   ticking a checkbox or hitting an explicit Save button. */
function writeNow(key, value){
  bumpGen(key);
  markStale();
  const snapshot = cloneVal(value);
  const prevChain = writeChains[key] || Promise.resolve();
  const next = prevChain.then(() => apiSet(key, snapshot).then(markSynced));
  writeChains[key] = next.catch(() => {});
  return next;
}

/* Debounced save for fast-typing fields (initials, sales target, etc).
   Rapid edits within the delay window coalesce onto one pending batch and
   send a single up-to-date snapshot — but the write is still registered in
   the key's chain the moment the FIRST edit in the batch happens, so a pull
   that starts mid-batch still waits for it. */
function scheduleSave(key, value, delay){
  bumpGen(key);
  markStale();
  if(!pendingSave[key]){
    let resolveFn;
    const placeholder = new Promise(res => { resolveFn = res; });
    const prevChain = writeChains[key] || Promise.resolve();
    writeChains[key] = prevChain.then(() => placeholder).catch(() => {});
    pendingSave[key] = { resolve: resolveFn, timer: null };
  }
  pendingSave[key].snapshot = cloneVal(value);
  clearTimeout(pendingSave[key].timer);
  pendingSave[key].timer = setTimeout(() => {
    const entry = pendingSave[key];
    delete pendingSave[key];
    apiSet(key, entry.snapshot).then(markSynced).finally(entry.resolve);
  }, delay || 400);
}

function pendingWrite(key){ return writeChains[key] || Promise.resolve(); }

async function apiGetFresh(key){
  await pendingWrite(key);
  return apiGet(key);
}

/* Returns {skip:true} if a local edit raced the fetch (caller should leave
   its current local value alone), otherwise {skip:false, value}. */
async function pullGuarded(key){
  const genBefore = editGen[key] || 0;
  const value = await apiGetFresh(key);
  const genAfter = editGen[key] || 0;
  if(genAfter !== genBefore) return { skip:true };
  return { skip:false, value };
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

/* One-off content fixes, written to run idempotently so they self-heal the
   live config in Blobs regardless of what's actually stored there (default
   seed data or whatever Admin has since edited) — see PROJECT NOTES. Safe
   to run on every load: once applied there's nothing left to find, so
   later runs are no-ops. */
function findSectionIndex(sections, nameStartsWith){
  return sections.findIndex(s => s.name && s.name.toUpperCase().startsWith(nameStartsWith));
}
function removeItemCI(items, text){
  const needle = text.trim().toLowerCase();
  const idx = items.findIndex(i => i.trim().toLowerCase() === needle);
  if(idx === -1) return false;
  items.splice(idx, 1);
  return true;
}
function removeAllItemCI(items, text){
  let removedAny = false;
  while(removeItemCI(items, text)) removedAny = true;
  return removedAny;
}
function hasItemCI(items, text){
  const needle = text.trim().toLowerCase();
  return items.some(i => i.trim().toLowerCase() === needle);
}

function applyConfigFixes(cfg){
  let changed = false;

  // 1) Remove "Daily spot check completed" and the old "Check Collins -
  //    Open enquiries and messages" line (superseded by the fuller wording
  //    added below) everywhere — any day, any section, both weeks.
  ['odd','even'].forEach(parity => {
    const week = cfg.days && cfg.days[parity];
    if(!week) return;
    Object.keys(week).forEach(dayName => {
      (week[dayName] || []).forEach(section => {
        if(removeAllItemCI(section.items, 'Daily spot check completed')) changed = true;
        if(removeAllItemCI(section.items, 'Check Collins - Open enquiries and messages')) changed = true;
      });
    });
  });

  // 2) Swap "deck scrub cellar mat / cellar and spirit cupboard swept" onto
  //    Thursday, and "top of all bar fridges dusted / fridge seals and
  //    wooden surrounds cleaned" onto Tuesday, in the Daily Cleaning Tasks
  //    section, for both odd and even weeks. Written as a from-Tue-to-Thu
  //    and from-Thu-to-Tue move rather than an outright overwrite so it's a
  //    no-op wherever a week is already arranged this way.
  const cellarItems = ['Deck scrub cellar mat in front of pre-mix', 'Cellar and spirit cupboard swept'];
  const fridgeItems = ['Top of all bar fridges dusted', 'Fridge seals and wooden surrounds cleaned'];

  ['odd','even'].forEach(parity => {
    const week = cfg.days && cfg.days[parity];
    if(!week || !week.TUESDAY || !week.THURSDAY) return;
    const tueSections = week.TUESDAY;
    const thuSections = week.THURSDAY;
    const tueIdx = findSectionIndex(tueSections, 'DAILY CLEANING TASKS');
    const thuIdx = findSectionIndex(thuSections, 'DAILY CLEANING TASKS');
    if(tueIdx === -1 || thuIdx === -1) return;
    const tueItems = tueSections[tueIdx].items;
    const thuItems = thuSections[thuIdx].items;

    cellarItems.forEach(text => {
      if(removeItemCI(tueItems, text)){
        changed = true;
        if(!hasItemCI(thuItems, text)) thuItems.push(text);
      }
    });
    fridgeItems.forEach(text => {
      if(removeItemCI(thuItems, text)){
        changed = true;
        if(!hasItemCI(tueItems, text)) tueItems.push(text);
      }
    });
  });

  // 3) "Check Collins" follow-up task on Management Opening Tasks and
  //    Manager Closing Tasks, every day, both weeks. Appended to the end
  //    of each list (not inserted mid-list) so it can't shift the
  //    position of any already-ticked item.
  const collinsText = 'Check Collins - ensure all messages/enquiries have been picked up and responded to';
  ['odd','even'].forEach(parity => {
    const week = cfg.days && cfg.days[parity];
    if(!week) return;
    Object.keys(week).forEach(dayName => {
      const sections = week[dayName] || [];
      const openIdx = findSectionIndex(sections, 'MANAGEMENT OPENING TASKS');
      const closeIdx = findSectionIndex(sections, 'MANAGER CLOSING TASKS');
      if(openIdx !== -1 && !hasItemCI(sections[openIdx].items, collinsText)){
        sections[openIdx].items.push(collinsText);
        changed = true;
      }
      if(closeIdx !== -1 && !hasItemCI(sections[closeIdx].items, collinsText)){
        sections[closeIdx].items.push(collinsText);
        changed = true;
      }
    });
  });

  return changed;
}

async function loadConfig(){
  markStale();
  const remote = await apiGetFresh('config');
  if(remote && remote.days){
    CONFIG = remote;
  } else {
    CONFIG = defaultConfig();
    await writeNow('config', CONFIG); // seed it so admin edits have something to build on
  }
  if(applyConfigFixes(CONFIG)){
    await writeNow('config', CONFIG); // persist the correction so it sticks and other devices pick it up
  }
  markSynced();
}

/* ---------------- header ---------------- */

function renderHeader(){
  const info = computeWeekInfo(selectedDate, CONFIG.weekAnchor);
  document.getElementById('dateLine').textContent = formatLongDate(businessDate());
  const pill = document.getElementById('weekPill');
  pill.textContent = 'Week ' + info.weekNum + ' · ' + (info.parity === 'odd' ? 'Odd' : 'Even');
  pill.className = 'week-pill' + (info.parity === 'even' ? ' even' : '');
  document.getElementById('buildNum').textContent = 'v' + APP_VERSION;
}

/* ---------------- TODAY TAB ---------------- */

function renderDayStrip(){
  const strip = document.getElementById('dayStrip');
  strip.innerHTML = '';
  const today = businessDate();
  getCurrentWeekDates().forEach(d => {
    const chip = document.createElement('button');
    chip.className = 'day-chip ' + DAY_CLASS[dayNameOf(d)] +
      (isSameDay(d, selectedDate) ? ' active' : '') + (isSameDay(d, today) ? ' today' : '');
    chip.textContent = DAY_SHORT[dayNameOf(d)] + ' ' + ordinal(d.getDate());
    chip.addEventListener('click', () => { selectedDate = d; loadAndRenderToday(); });
    strip.appendChild(chip);
  });
}

let taskStateKey = null; // which date's state is currently loaded into `taskState`

async function loadAndRenderToday(){
  renderHeader();
  renderDayStrip();
  const key = 'taskstate:' + isoDate(selectedDate);
  const isDaySwitch = key !== taskStateKey;
  markStale();

  if(isDaySwitch){
    // Genuinely new day being viewed — always load its real state.
    const remote = await apiGetFresh(key);
    taskState = remote || { meta: { salesTarget:'', amManager:'', pmManager:'', handoverNotes:'' }, sections: {} };
    taskStateKey = key;
  } else {
    // Periodic refresh of the day already on screen — don't clobber an edit
    // that's racing this exact fetch.
    const result = await pullGuarded(key);
    if(!result.skip){
      taskState = result.value || { meta: { salesTarget:'', amManager:'', pmManager:'', handoverNotes:'' }, sections: {} };
    }
  }
  await syncCarryOver();
  await renderHandoverBanner();
  markSynced();
  document.getElementById('salesTarget').value = taskState.meta.salesTarget || '';
  document.getElementById('amManager').value = taskState.meta.amManager || '';
  document.getElementById('pmManager').value = taskState.meta.pmManager || '';
  document.getElementById('handoverNotes').value = taskState.meta.handoverNotes || '';
  renderTodaySections();
}

function saveTaskStateNow(){
  writeNow('taskstate:' + isoDate(selectedDate), taskState);
}
function saveTaskStateSoon(){
  scheduleSave('taskstate:' + isoDate(selectedDate), taskState, 400);
}

/* ---------------- Daily Cleaning Tasks carry-over ----------------
   Anything in the Daily Cleaning Tasks section that isn't both ticked AND
   initialed by the end of the day rolls onto the next day (and the one
   after, up to CARRY_MAX_DAYS) as an extra, clearly-flagged row in that
   same section, until someone completes it or it ages out. Tracked
   separately from the day-specific taskstate records (it isn't really
   "owned" by any one date), under its own 'carryover' key so it gets the
   same cross-device sync treatment via the generic writeNow/scheduleSave/
   pullGuarded machinery above. */

let carryOver = null; // { lastProcessedDate: 'YYYY-MM-DD'|null, items: [{id,text,originDate,done,initials}] }

function defaultCarryOver(){ return { lastProcessedDate: null, items: [] }; }

/* Walks forward from the last date we checked, up to (not including)
   today, folding any still-incomplete Daily Cleaning Tasks items from each
   elapsed day into the carry list (de-duped by task text, so a task
   already being carried isn't added twice), then drops anything that's
   aged past CARRY_MAX_DAYS. Mutates `co` in place; returns whether
   anything changed so the caller knows whether to persist it. */
async function computeCarryOverUpdates(co){
  const today = businessDate();
  let changed = false;

  if(!co.lastProcessedDate){
    // First run ever — nothing to backfill, just start tracking from here.
    co.lastProcessedDate = isoDate(addDays(today, -1));
    changed = true;
  } else {
    let cursor = addDays(new Date(co.lastProcessedDate + 'T00:00:00'), 1);
    while(cursor < today){
      const dayName = dayNameOf(cursor);
      const parity = computeWeekInfo(cursor, CONFIG.weekAnchor).parity;
      const sections = combinedSectionsFor(dayName, parity);
      const sIdx = findSectionIndex(sections, 'DAILY CLEANING TASKS');
      if(sIdx !== -1 && sections[sIdx].items.length){
        const state = await apiGet('taskstate:' + isoDate(cursor));
        const sectionState = (state && state.sections && state.sections[sIdx]) || {};
        sections[sIdx].items.forEach((text, iIdx) => {
          const st = sectionState[iIdx];
          const doneOk = st && st.done && st.initials && st.initials.trim();
          const alreadyTracked = co.items.some(c => c.text.trim().toLowerCase() === text.trim().toLowerCase());
          if(!doneOk && !alreadyTracked){
            co.items.push({
              id: 'carry-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
              text, originDate: isoDate(cursor), done: false, initials: ''
            });
            changed = true;
          }
        });
      }
      co.lastProcessedDate = isoDate(cursor);
      changed = true;
      cursor = addDays(cursor, 1);
    }
  }

  const todayIso = isoDate(today);
  const before = co.items.length;
  co.items = co.items.filter(c => daysBetweenIso(c.originDate, todayIso) <= CARRY_MAX_DAYS);
  if(co.items.length !== before) changed = true;

  return changed;
}

async function syncCarryOver(){
  if(!carryOver){
    carryOver = (await apiGetFresh('carryover')) || defaultCarryOver();
  } else {
    const result = await pullGuarded('carryover');
    if(!result.skip) carryOver = result.value || defaultCarryOver();
  }
  const changed = await computeCarryOverUpdates(carryOver);
  if(changed) await writeNow('carryover', carryOver);
}

function saveCarryOverNow(){ writeNow('carryover', carryOver); }
function saveCarryOverSoon(){ scheduleSave('carryover', carryOver, 400); }

/* Today's Tasks now includes the (shared, admin-edited) Close Down
   checklist as trailing sections on every day — same list every night,
   but each day still gets its own tick/initial state since it's saved
   under that day's taskstate:<date> key, continuing the same section
   index numbering as the day's own sections. */
function combinedSectionsFor(dayName, parity){
  const daySections = (CONFIG.days[parity] && CONFIG.days[parity][dayName]) || [];
  const closedown = CONFIG.closedown || [];
  return daySections.concat(closedown);
}

function renderTodaySections(){
  const info = computeWeekInfo(selectedDate, CONFIG.weekAnchor);
  const dayName = dayNameOf(selectedDate);
  const sections = combinedSectionsFor(dayName, info.parity);
  const wrap = document.getElementById('todaySections');
  wrap.innerHTML = '';

  if(sections.length === 0){
    wrap.innerHTML = '<div class="empty-note">No tasks set up for this day yet. Add some in Admin.</div>';
    document.getElementById('sectionPills').innerHTML = '';
    return;
  }

  // Carried-over Daily Cleaning Tasks items only ever show against "today"
  // — not when browsing other days of the week in the day-strip.
  const isTodayView = isSameDay(selectedDate, businessDate());
  const dailyCleaningIdx = isTodayView ? findSectionIndex(sections, 'DAILY CLEANING TASKS') : -1;

  const cards = [];
  const dayCount = ((CONFIG.days[info.parity] && CONFIG.days[info.parity][dayName]) || []).length;
  sections.forEach((section, sIdx) => {
    if(sIdx === dayCount && dayCount > 0 && (CONFIG.closedown || []).length > 0){
      const heading = document.createElement('div');
      heading.style.cssText = 'font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;margin:18px 4px 8px;';
      heading.textContent = 'Closing checklist';
      wrap.appendChild(heading);
    }
    if(!taskState.sections[sIdx]) taskState.sections[sIdx] = {};
    const carryItems = (sIdx === dailyCleaningIdx && carryOver) ? carryOver.items : [];
    const built = buildSectionCard(section, sIdx, taskState.sections[sIdx], saveTaskStateNow, saveTaskStateSoon, 'today', carryItems);
    wrap.appendChild(built.card);
    cards.push(built);
  });

  renderSectionPills(cards);
}

function renderSectionPills(cards){
  const wrap = document.getElementById('sectionPills');
  wrap.innerHTML = '';
  cards.forEach(({ section, card, isComplete }) => {
    const pill = document.createElement('button');
    pill.className = 'section-pill' + (isComplete() ? ' complete' : '');
    pill.textContent = section.name.replace(/\s*\(INITIAL WHEN COMPLETE\)/i, '');
    pill.addEventListener('click', () => card.scrollIntoView({ behavior:'smooth', block:'start' }));
    wrap.appendChild(pill);
  });
}

/* Shared section-card builder. onToggle fires immediately (checkbox
   ticks); onType is debounced (typing initials) — see the write-ordering
   notes near writeNow/scheduleSave. Returns { card, section, isComplete }
   so the caller can build the jump-pill row from the same data. */
function buildSectionCard(section, sIdx, stateForSection, onToggle, onType, scopeKey, carryItems){
  carryItems = carryItems || [];
  const collapseKey = scopeKey + ':' + sIdx;
  const card = document.createElement('div');
  card.className = 'section-card';
  card.id = 'section-' + scopeKey + '-' + sIdx;

  const head = document.createElement('div');
  head.className = 'section-head';

  const isInfoSection = section.name === 'A-BOARD';

  function isComplete(){
    return !isInfoSection && section.items.length > 0 &&
      section.items.every((_, i) => stateForSection[i] && stateForSection[i].done);
  }

  const headRight = document.createElement('div');
  headRight.className = 'section-head-right';
  const progressSpan = document.createElement('span');
  progressSpan.className = 'section-progress';
  const chevronSpan = document.createElement('span');
  chevronSpan.className = 'chevron' + (sectionCollapse[collapseKey] ? ' collapsed' : '');
  chevronSpan.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>';

  const titleEl = document.createElement('h3');
  titleEl.textContent = section.name;
  head.appendChild(titleEl);
  if(!isInfoSection) headRight.appendChild(progressSpan);
  headRight.appendChild(chevronSpan);
  head.appendChild(headRight);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'section-body' + (sectionCollapse[collapseKey] ? ' collapsed' : '');
  card.appendChild(body);

  function setCollapsed(collapsed){
    sectionCollapse[collapseKey] = collapsed;
    body.classList.toggle('collapsed', collapsed);
    chevronSpan.classList.toggle('collapsed', collapsed);
  }

  head.addEventListener('click', () => setCollapsed(!sectionCollapse[collapseKey]));

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
      const wasComplete = isComplete();
      item.done = !item.done;
      check.classList.toggle('done', item.done);
      text.classList.toggle('done', item.done);
      updateProgress();
      onToggle();
      if(item.done && !item.initials){ initialsInput.focus(); }

      const nowComplete = isComplete();
      if(nowComplete && !wasComplete){
        // Short pause so the last tick is visible before the section tidies itself away.
        setTimeout(() => {
          if(isComplete()) setCollapsed(true);
        }, 1500);
      }
    });

    const text = document.createElement('div');
    text.className = 'task-text' + (item.done ? ' done' : '');
    text.textContent = itemText;

    const initialsInput = document.createElement('input');
    initialsInput.className = 'initials-input';
    initialsInput.maxLength = 7;
    initialsInput.placeholder = 'init.';
    initialsInput.value = item.initials || '';
    initialsInput.addEventListener('input', () => {
      item.initials = initialsInput.value.toUpperCase();
      initialsInput.value = item.initials;
      onType();
    });

    row.appendChild(check);
    row.appendChild(text);
    row.appendChild(initialsInput);
    body.appendChild(row);
  });

  // Carried-over items from previous day(s) — same look as a normal task
  // row, plus a small tag showing where it carried from. Completing one
  // (ticked AND initialed) removes it from the carry list entirely; it
  // won't reappear tomorrow.
  carryItems.forEach(citem => {
    const row = document.createElement('div');
    row.className = 'task-row carried';

    const check = document.createElement('button');
    check.className = 'check' + (citem.done ? ' done' : '');
    check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="4,13 9,18 20,6"/></svg>';

    const textWrap = document.createElement('div');
    textWrap.className = 'task-text-wrap';
    const text = document.createElement('div');
    text.className = 'task-text' + (citem.done ? ' done' : '');
    text.textContent = citem.text;
    const tag = document.createElement('div');
    tag.className = 'carried-tag';
    tag.textContent = 'Carried from ' + formatShortDate(new Date(citem.originDate + 'T00:00:00'));
    textWrap.appendChild(text);
    textWrap.appendChild(tag);

    const initialsInput = document.createElement('input');
    initialsInput.className = 'initials-input';
    initialsInput.maxLength = 7;
    initialsInput.placeholder = 'init.';
    initialsInput.value = citem.initials || '';

    function maybeResolve(){
      if(citem.done && citem.initials && citem.initials.trim()){
        // Short pause so the tick/initials are visible before the row disappears.
        // Resolves against the live carryOver.items (by id) rather than the
        // array captured at render time, in case a background sync swapped
        // in a fresh carryOver object while this was pending.
        setTimeout(() => {
          if(carryOver && carryOver.items){
            const idx = carryOver.items.findIndex(c => c.id === citem.id);
            if(idx !== -1) carryOver.items.splice(idx, 1);
          }
          saveCarryOverNow();
          renderTodaySections();
        }, 900);
      }
    }

    check.addEventListener('click', () => {
      citem.done = !citem.done;
      check.classList.toggle('done', citem.done);
      text.classList.toggle('done', citem.done);
      saveCarryOverNow();
      if(citem.done && !citem.initials){ initialsInput.focus(); }
      maybeResolve();
    });
    initialsInput.addEventListener('input', () => {
      citem.initials = initialsInput.value.toUpperCase();
      initialsInput.value = citem.initials;
      saveCarryOverSoon();
      maybeResolve();
    });

    row.appendChild(check);
    row.appendChild(textWrap);
    row.appendChild(initialsInput);
    body.appendChild(row);
  });

  function updateProgress(){
    if(isInfoSection) return;
    const c = section.items.filter((_, i) => stateForSection[i] && stateForSection[i].done).length;
    progressSpan.textContent = c + '/' + section.items.length;
    card.classList.toggle('complete', isComplete());
  }
  updateProgress();

  return { card, section, isComplete };
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------------- handover notes ---------------- */

/* Free-text box at the bottom of Today's Tasks; whatever's typed there
   shows as a banner at the top of the next day's tasks (relative to
   whichever day is being viewed, not necessarily "today" — so browsing
   back to a past day in the day-strip shows what was handed over into
   it). Read directly from the previous day's own taskstate record rather
   than anything synced separately, so it needs no extra backend key. */
async function renderHandoverBanner(){
  const banner = document.getElementById('handoverBanner');
  const prevDate = addDays(selectedDate, -1);
  const prevState = await apiGet('taskstate:' + isoDate(prevDate));
  const notes = prevState && prevState.meta && prevState.meta.handoverNotes && prevState.meta.handoverNotes.trim();
  banner.innerHTML = '';
  if(!notes){
    banner.style.display = 'none';
    return;
  }
  banner.style.display = '';
  const title = document.createElement('div');
  title.className = 'handover-banner-title';
  title.textContent = 'Handover from ' + formatShortDate(prevDate);
  const body = document.createElement('div');
  body.className = 'handover-banner-body';
  body.textContent = notes;
  banner.appendChild(title);
  banner.appendChild(body);
}

/* ---------------- ORDER SHEET TAB ---------------- */

let orderEntriesLoaded = false;

async function loadAndRenderOrder(){
  markStale();
  if(!orderEntriesLoaded){
    const remote = await apiGetFresh('orderentries');
    orderEntries = remote || {};
    orderEntriesLoaded = true;
  } else {
    const result = await pullGuarded('orderentries');
    if(!result.skip){ orderEntries = result.value || {}; }
  }
  markSynced();
  renderOrderTable();
}

function saveOrderSoon(){
  scheduleSave('orderentries', orderEntries, 400);
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
  writeNow('orderentries', orderEntries);
  renderOrderTable();
  toast('Cleared');
});

document.getElementById('salesTarget').addEventListener('input', e => { taskState.meta.salesTarget = e.target.value; saveTaskStateSoon(); });
document.getElementById('amManager').addEventListener('input', e => { taskState.meta.amManager = e.target.value; saveTaskStateSoon(); });
document.getElementById('pmManager').addEventListener('input', e => { taskState.meta.pmManager = e.target.value; saveTaskStateSoon(); });
document.getElementById('handoverNotes').addEventListener('input', e => { taskState.meta.handoverNotes = e.target.value; saveTaskStateSoon(); });

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
  panel.appendChild(buildHistorySection());
}

/* Read-only viewer for previous days' sign-off data. Data is only kept for
   2 weeks (a scheduled Netlify function prunes anything older nightly),
   so this only ever has a couple of weeks to show. Uses the CURRENT task
   list to label items, so if a task's wording has since been edited in
   Admin, an old day may show slightly different text against its ticks —
   the tick/initial history itself is exactly what was saved that day. */
function buildHistorySection(){
  const wrap = document.createElement('div');
  wrap.className = 'admin-section';
  wrap.innerHTML = '<h3>Previous weeks</h3><p style="color:var(--muted);font-size:0.82rem;margin-top:-4px;">Task data is kept for 2 weeks, then cleared out automatically.</p>';

  const listWrap = document.createElement('div');
  wrap.appendChild(listWrap);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn secondary small';
  refreshBtn.textContent = 'Load available days';
  refreshBtn.addEventListener('click', loadDayList);
  wrap.appendChild(refreshBtn);

  const detailWrap = document.createElement('div');
  detailWrap.style.marginTop = '12px';
  wrap.appendChild(detailWrap);

  async function loadDayList(){
    listWrap.innerHTML = '<div class="empty-note">Loading…</div>';
    try{
      const res = await fetch('/api/data?list=' + encodeURIComponent('taskstate:'));
      const j = await res.json();
      const dates = (j.keys || [])
        .map(k => k.slice('taskstate:'.length))
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();
      if(dates.length === 0){
        listWrap.innerHTML = '<div class="empty-note">No stored days found yet.</div>';
        return;
      }
      listWrap.innerHTML = '';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      dates.forEach(dateStr => {
        const d = new Date(dateStr + 'T00:00:00');
        const btn = document.createElement('button');
        btn.className = 'day-chip';
        btn.textContent = DAY_SHORT[dayNameOf(d)] + ' ' + d.getDate() + '/' + (d.getMonth()+1);
        btn.addEventListener('click', () => showDay(dateStr));
        row.appendChild(btn);
      });
      listWrap.appendChild(row);
    }catch(e){
      listWrap.innerHTML = '<div class="empty-note">Couldn\'t load the list — try again.</div>';
    }
  }

  async function showDay(dateStr){
    detailWrap.innerHTML = '<div class="empty-note">Loading…</div>';
    const d = new Date(dateStr + 'T00:00:00');
    const info = computeWeekInfo(d, CONFIG.weekAnchor);
    const dayName = dayNameOf(d);
    const sections = combinedSectionsFor(dayName, info.parity);
    const state = await apiGet('taskstate:' + dateStr);
    detailWrap.innerHTML = '';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-weight:600;margin-bottom:8px;';
    heading.textContent = formatLongDate(d) + ' — Week ' + info.weekNum + ' (' + info.parity + ')';
    detailWrap.appendChild(heading);

    if(!state || !sections.length){
      detailWrap.appendChild(Object.assign(document.createElement('div'), { className:'empty-note', textContent:'No data saved for this day.' }));
      return;
    }

    sections.forEach((section, sIdx) => {
      if(section.name === 'A-BOARD') return;
      const sState = (state.sections && state.sections[sIdx]) || {};
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;';
      const doneCount = section.items.filter((_, i) => sState[i] && sState[i].done).length;
      let html = '<div style="font-weight:600;font-size:0.85rem;margin-bottom:6px;">' + escapeHtml(section.name) + ' — ' + doneCount + '/' + section.items.length + '</div>';
      section.items.forEach((item, iIdx) => {
        const st = sState[iIdx] || {};
        html += '<div style="font-size:0.8rem;color:var(--muted);display:flex;justify-content:space-between;gap:8px;padding:2px 0;">' +
          '<span style="color:' + (st.done ? 'var(--teal-dark)' : 'var(--muted)') + ';">' + (st.done ? '✓' : '—') + ' ' + escapeHtml(item) + '</span>' +
          '<span>' + escapeHtml(st.initials || '') + '</span></div>';
      });
      box.innerHTML = html;
      detailWrap.appendChild(box);
    });
  }

  return wrap;
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
  await writeNow('config', CONFIG);
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
  const elapsed = Date.now() - lastLocalEditAt;
  if(elapsed < EDIT_GRACE_MS){
    clearTimeout(refreshRetryTimer);
    refreshRetryTimer = setTimeout(fullRefresh, EDIT_GRACE_MS - elapsed + 50);
    return;
  }

  const view = activeViewName();
  const isEditingAdmin = (view === 'admin' && adminUnlocked);

  // Admin edits (task/close-down/order-sheet editing) live in memory until
  // the person hits an explicit Save button, unlike the tick/initial fields
  // elsewhere which save near-instantly. Refreshing config from the server
  // while that's happening would silently discard whatever they'd typed —
  // so skip the background pull entirely until they save or lock the tab.
  if(!isEditingAdmin){
    await loadConfig();
  }
  renderHeader();

  if(view === 'today') await loadAndRenderToday();
  else if(view === 'order') await loadAndRenderOrder();
}

document.getElementById('syncNowBtn').addEventListener('click', fullRefresh);
setInterval(fullRefresh, 20000);
['visibilitychange','focus','pageshow'].forEach(ev => {
  window.addEventListener(ev, () => { if(document.visibilityState !== 'hidden') fullRefresh(); });
});

/* Preload the Order Sheet tab's data lazily when first opened */
document.querySelector('.tab-btn[data-view="order"]').addEventListener('click', () => { if(!orderEntries) loadAndRenderOrder(); });

/* ---------------- INIT ---------------- */

(async function init(){
  await loadConfig();
  renderHeader();
  await loadAndRenderToday();
})();
