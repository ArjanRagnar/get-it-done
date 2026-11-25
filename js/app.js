(() => {
'use strict';
const DAY = 864e5, KEY = 'gid-doc', BASEKEY = 'gid-base', METAKEY = 'gid-meta', CONFKEY = 'gid-conflicts', C = window.GID_CONFIG;
let S, view = 'board', panelId = null, conflicts = [], syncState = 'local', syncTimer = null, syncing = false, lastSyncAt = 0, filter = 'all', openBucket = null, logTab = 'items', period = 'month', doneFilter = {period: 'all', proc: ''};
const sel = new Set(), expanded = new Set(), moreOpen = new Set(), askedPast = new Set();
let pending = [];

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => Date.now();
const uid = p => (p || 'i') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const get = id => S.items.find(i => i.id === id);
const bucket = id => S.buckets.find(b => b.id === id);
const bname = id => (bucket(id) || {}).name || '—';
const person = id => S.people.find(p => p.id === id);
const place = id => S.places.find(p => p.id === id);
const proc = id => S.processes.find(p => p.id === id);
const isTop = i => !i.groupId || i.isMaster;
const live = i => i.status === 'active';
const open_ = i => live(i) && !i.done;
const groupAll = gid => S.items.filter(x => x.groupId === gid && x.status !== 'deleted');
const groupMembers = gid => groupAll(gid).filter(x => !x.isMaster);
const fmt = t => new Date(t).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const fmtD = t => new Date(t).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'});
const dayEnd = t => { const d = new Date(t); d.setHours(23, 59, 59, 999); return +d; };
const isoDay = t => { const d = new Date(t); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const isoDT = t => { const d = new Date(t); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); };
const parseDay = v => { const [y, m, d] = v.split('-').map(Number); return +new Date(y, m - 1, d, 9, 0, 0); };
const TYPES = {task: 'Task', event: 'Event', appt: 'Appointment'};
const REPEATS = {none: 'Does not repeat', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly'};
const ownEnd = s => s.type === 'task' ? dayEnd(s.at) : s.at + (s.len || 30) * 6e4;
const delPending = i => i.delegates.filter(d => d.status !== 'Done');
const hasConflict = id => conflicts.some(c => c.id === id);
const locked = i => !!i.sched || i.delegates.some(d => d.sched && d.status !== 'Done') || hasConflict(i.id);
const flagged = i => i.reschedules > 5 || i.delegates.some(d => d.reschedules > 3);
const waiting = i => !!i.bucket && !locked(i) && !i.done && i.firstBucketedAt && now() - i.firstBucketedAt >= 14 * DAY;
const dOverdue = d => d.sched && d.status !== 'Done' && now() > dayEnd(d.sched.at);
const dStatus = d => d.status === 'Done' ? 'Done' : dOverdue(d) ? 'Overdue' : (d.status || 'Not scheduled');
const tops = () => S.items.filter(i => isTop(i) && i.status !== 'deleted');
const needsProc = i => !i.process && !i.personal;
const nextOcc = (t, r) => { const d = new Date(t); if (r === 'daily') d.setDate(d.getDate() + 1); else if (r === 'weekly') d.setDate(d.getDate() + 7); else if (r === 'monthly') d.setMonth(d.getMonth() + 1); else if (r === 'yearly') d.setFullYear(d.getFullYear() + 1); return +d; };

function save(){ try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} queueSync(); }
function load(){ try { const r = localStorage.getItem(KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
function toast(m, act){ const t = $('#toast'); t.innerHTML = ''; t.appendChild(document.createTextNode(m)); t.classList.toggle('act', !!act);
  if (act) { const b = document.createElement('button'); b.type = 'button'; b.className = 'tbtn'; b.textContent = act.label; b.onclick = () => { t.classList.remove('on'); act.fn(); }; t.appendChild(b); }
  t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), act ? 10000 : 3000); }
function logItem(id, kind, detail){ S.itemLog.unshift({t: now(), id, kind, detail}); }
function logBucket(detail){ S.bucketLog.unshift({t: now(), detail}); }
function logPerson(pid, id, kind){ S.personLog.unshift({t: now(), pid, id, kind}); }
function note(id, text){ if (text && text.trim()) S.notes.unshift({t: now(), id, text: text.trim()}); }
function commit(msg){ save(); render(); if (msg) toast(msg); }

/* ---------- modal ---------- */
function modal({title, body = '', ok = 'OK', cancel = 'Cancel', danger = false, onOk, onCancel, wide, extra}){
  const ov = $('#ov');
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true"${wide ? ' style="max-width:580px"' : ''}><h2>${esc(title)}</h2>${body}<div class="foot">${extra || ''}${cancel ? `<button class="btn ghost" data-m="x">${esc(cancel)}</button>` : ''}${ok ? `<button class="btn ${danger ? 'danger' : 'pri'}" data-m="ok">${esc(ok)}</button>` : ''}</div></div>`;
  ov.classList.add('on');
  const close = () => { ov.classList.remove('on'); ov.innerHTML = ''; setTimeout(() => flushMail() || checkPast(), 50); };
  ov.onclick = e => {
    const m = e.target.dataset && e.target.dataset.m;
    if (e.target === ov || m === 'x') { close(); onCancel && onCancel(); }
    else if (m === 'ok') { if (!onOk || onOk(ov) !== false) close(); }
    else if (m && m.startsWith('alt')) { const f = (modal.alts || {})[m]; close(); f && f(); }
  };
  ov.querySelectorAll('input[name=kind]').forEach(r => r.addEventListener('change', () => { const w = ov.querySelector('#m-procwrap'); if (w) w.style.display = r.value === 'work' ? '' : 'none'; }));
  const f = ov.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,select'); if (f) f.focus();
  return ov;
}
const modalOpen = () => $('#ov').classList.contains('on');
const ask = (title, text, ok, fn, danger) => modal({title, body: `<p>${text}</p>`, ok, danger, onOk: () => { fn(); }});

/* ---------- seed ---------- */
function base(o){ return Object.assign({id: uid(), text: '', expl: '', atts: [], created: now(), bucket: null, urgent: false, place: null, process: null, personal: false,
  status: 'active', struckAt: null, deletedAt: null, groupId: null, isMaster: false, sched: null, schedCount: 0, reschedules: 0, forcedFree: false, pastNotDone: false,
  delegates: [], ownDone: false, firstBucketedAt: null, oldName: null, wasIn: null, edited: false, needsExpl: false, done: null}, o); }
function deleg(pid, o){ return Object.assign({pid, sched: null, status: null, schedCount: 0, reschedules: 0, forcedFree: false, doneAt: null, pastNotDone: false, planned: null, assignedAt: now()}, o); }
function seed(){
  S = {v: 1, seq: 1, gmailAcct: 0, userName: '', font: 'Aptos', eaMode: false, eaEmail: '', holidays: ['01-26', '08-15', '10-02'], ui: {weeks: 6, offset: 0, mview: 'time', mbucket: null, mrange: 'week'},
    items: [], buckets: [], people: [], places: [], processes: [], itemLog: [], bucketLog: [], personLog: [], notes: [], doneLog: [], closedDeleg: []};
  ['Daily','Weekly','Bi-weekly','Monthly','Quarterly','Half yearly','Annually','Location specific','Someday'].forEach(n => S.buckets.push({id: uid('b'), name: n, loc: n === 'Location specific'}));
}
function gateSvg(){
  const s = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='#C9D6D4'/><rect x='20' y='30' width='80' height='70' fill='none' stroke='#1D2A2E' stroke-width='5'/><line x1='60' y1='30' x2='60' y2='100' stroke='#1D2A2E' stroke-width='4'/><circle cx='66' cy='64' r='5' fill='#B8432B'/></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
}

/* ---------- purge ---------- */
function purge(){
  let n = 0;
  S.items = S.items.filter(i => {
    if (i.status === 'deleted' && now() - i.deletedAt >= 60 * DAY) { logItem(i.id, 'delete', `"${i.text}" removed for good after 60 days`); n++; return false; }
    return true;
  });
  return n;
}

/* ---------- core ---------- */
function moveItems(ids, to){
  let moved = 0; const noExpl = [], lockedL = [];
  ids.map(get).filter(i => i && isTop(i) && open_(i)).forEach(i => {
    if (locked(i)) { lockedL.push(i); return; }
    if (to === i.bucket) return;
    if (to && !i.expl.trim()) { i.needsExpl = true; noExpl.push(i); return; }
    const from = i.bucket, fb = bucket(from);
    (i.groupId ? groupAll(i.groupId) : [i]).forEach(x => {
      x.bucket = to;
      if (to) { x.firstBucketedAt = x.firstBucketedAt || now(); x.wasIn = null; x.oldName = null; x.needsExpl = false;
        x.delegates.forEach(dd => { if (dd.planned && !dd.sched) { countSchedule(dd); dd.sched = {at: dd.planned.at}; dd.planned = null; dd.status = 'Due'; } }); }
      else if (fb && fb.deleting) x.wasIn = fb.name;
    });
    logBucket(`"${i.text}" moved ${from ? 'from ' + bname(from) : 'from the brain dump'} to ${to ? bname(to) : 'the brain dump'}`);
    moved++;
  });
  let msg = `${moved} moved`;
  if (noExpl.length) msg += ` · ${noExpl.length} need an explanation first`;
  if (lockedL.length) msg += ` · ${lockedL.length} scheduled (unschedule first)`;
  return msg;
}
function countSchedule(o){ o.schedCount++; if (o.schedCount > 1 && !o.forcedFree) o.reschedules++; o.forcedFree = false; o.pastNotDone = false; }
function gForget(sch, kind){ if (sch && sch.g && sch.g.id) { S.gDel = S.gDel || []; S.gDel.push({kind, id: sch.g.id}); } }
function unscheduleOwn(i){ if (i.sched) i.lastSched = {t: now(), sched: Object.assign({}, i.sched, {g: null})}; const fb = bucket(i.bucket); gForget(i.sched, i.sched && i.sched.type === 'task' ? 'task' : 'event'); i.sched = null; i.pastNotDone = false; if (fb && fb.deleting) i.forcedFree = true; }
function unscheduleDel(i, d){ if (d.sched) d.lastSched = {t: now(), sched: {at: d.sched.at, g: null}}; const fb = bucket(i.bucket); gForget(d.sched, 'task'); d.sched = null; d.status = null; d.pastNotDone = false; if (fb && fb.deleting) d.forcedFree = true; }
function strike(i){ i.status = 'struck'; i.struckAt = now(); logItem(i.id, 'delete', `"${i.text}" deleted (struck through)`); }
function resetCounters(x){ x.schedCount = 0; x.reschedules = 0; x.forcedFree = false; x.delegates.forEach(d => { d.schedCount = 0; d.reschedules = 0; d.forcedFree = false; }); }
function hasHistory(i){ return i.schedCount > 0 || i.delegates.some(d => d.schedCount > 0); }
function afterEditPrompt(i){
  if (!hasHistory(i)) return;
  modal({title: 'Treat as a new item?', ok: 'Yes, new item', cancel: 'No',
    body: `<p>This item has a schedule history (${i.reschedules} reschedule${i.reschedules === 1 ? '' : 's'}${i.delegates.length ? ', plus follow-ups' : ''}). A new item starts every counter again at 0.</p>`,
    onOk: () => { resetCounters(i); logItem(i.id, 'edit', 'Treated as a new item: reschedule counters reset'); commit('Counters reset'); }});
}
function completeIfReady(i, msg){
  const pend = delPending(i);
  const ownOk = i.ownDone || (!i.sched && i.schedCount === 0 && i.delegates.length > 0);
  if (!pend.length && ownOk) {
    i.done = {at: now()}; i.ownDone = true; i.urgent = false;
    S.doneLog.push({t: now(), id: i.id});
    return msg || 'Done. Moved to the Done list.';
  }
  const left = pend.map(d => person(d.pid).name).concat(ownOk ? [] : ['your own part']);
  return `${msg || 'Your part is done'}. Still waiting on ${left.join(', ')}.`;
}
function markOwnDone(i){
  if (i.sched && i.sched.type === 'task' && i.sched.repeat !== 'none') {
    S.doneLog.push({t: now(), id: i.id});
    if (i.sched.g && i.sched.g.id) { S.gTick = S.gTick || []; S.gTick.push(i.sched.g.id); i.sched.g = null; } // tick this one in Google; the next is created fresh
    i.sched.at = nextOcc(i.sched.at, i.sched.repeat);
    while (dayEnd(i.sched.at) < now()) i.sched.at = nextOcc(i.sched.at, i.sched.repeat);
    i.pastNotDone = false;
    return `Ticked. Counted as 1 done; next task created for ${fmtD(i.sched.at)}.`;
  }
  i.ownDone = true;
  return completeIfReady(i);
}
function markDelDone(i, d){
  d.status = 'Done'; d.doneAt = now(); queueMail([{i, d, kind: 'done'}]);
  logPerson(d.pid, i.id, d.sched && now() > dayEnd(d.sched.at) ? 'done late' : 'done on time');
  return completeIfReady(i, `${person(d.pid).name}: done`);
}
function reopen(i){
  i.done = null; i.ownDone = false; i.sched = null; i.pastNotDone = false;
  logBucket(`"${i.text}" reopened, back in ${i.bucket ? bname(i.bucket) : 'the brain dump'}`);
}

/* ---------- capture ---------- */
function readFile(file){
  return new Promise(res => {
    const r = new FileReader();
    if (file.type.startsWith('image/')) {
      r.onload = () => { const img = new Image(); img.onload = () => {
        const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res({type: 'photo', name: file.name, data: c.toDataURL('image/jpeg', .72)}); }; img.onerror = () => res(null); img.src = r.result; };
    } else r.onload = () => res({type: 'voice', name: file.name, data: file.size < 1.5e6 ? r.result : null, transcript: ''});
    r.readAsDataURL(file);
  });
}
const simVoice = () => ({type: 'voice', name: 'Voice note', data: null, transcript: '(Transcribed automatically once online. Edit to correct.)'});
function gmailUrl(a){
  const d = new Date(a.date + 'T12:00:00'), f = x => `${x.getFullYear()}/${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')}`;
  const b = new Date(d); b.setDate(b.getDate() - 1); const e = new Date(d); e.setDate(e.getDate() + 1);
  const q = `subject:"${a.subject}" after:${f(b)} before:${f(e)}`;
  return `https://mail.google.com/mail/u/${S.gmailAcct || 0}/#search/${encodeURIComponent(q)}`;
}
function findSubject(subj){
  const k = subj.trim().toLowerCase();
  return S.items.find(i => i.status !== 'deleted' && i.atts.some(a => a.type === 'email' && a.subject.trim().toLowerCase() === k));
}

/* ---------- counts ---------- */
function counts(){
  const T = tops(), act = T.filter(open_);
  return {total: act.length, unb: act.filter(i => !i.bucket).length, inb: act.filter(i => i.bucket).length,
    del: S.items.filter(i => i.status === 'deleted').length, flag: act.filter(flagged).length, conf: act.filter(i => i.oldName).length,
    urg: act.filter(i => i.urgent).length, urgUnsched: act.filter(i => i.urgent && !locked(i)).length,
    sched: act.filter(locked).length, done: T.filter(i => live(i) && i.done).length,
    email: T.filter(i => live(i) && i.atts.some(a => a.type === 'email')).length};
}
function bucketCounts(b){
  const its = tops().filter(i => open_(i) && i.bucket === b.id);
  return {open: its.length, sched: its.filter(locked).length, unsched: its.filter(i => !locked(i)).length, urg: its.filter(i => i.urgent).length,
    flag: its.filter(flagged).length, del: its.filter(i => i.delegates.length).length, wait: its.filter(waiting).length, noplace: its.filter(i => !i.place).length};
}

/* ---------- "Did you do this?" ---------- */
function pastQueue(){
  const q = [];
  tops().filter(open_).forEach(i => {
    if (i.sched && !i.ownDone && !i.pastNotDone && !(i.sched.type !== 'task' && i.sched.repeat !== 'none') && ownEnd(i.sched) < now()) q.push({i, own: true});
    i.delegates.forEach(d => { if (d.sched && d.status !== 'Done' && !d.pastNotDone && dayEnd(d.sched.at) < now()) q.push({i, d}); });
  });
  return q.filter(x => !askedPast.has(x.i.id + (x.d ? x.d.pid : 'own')));
}
function checkPast(){
  if (modalOpen()) return;
  const q = pastQueue(); if (!q.length) return;
  const key = x => x.i.id + (x.d ? x.d.pid : 'own');
  const when = x => x.d ? `Follow-up with ${esc(person(x.d.pid).name)} · due ${fmtD(x.d.sched.at)}`
    : `${TYPES[x.i.sched.type]} · ${x.i.sched.type === 'task' ? 'due ' + fmtD(x.i.sched.at) : 'ended ' + fmt(ownEnd(x.i.sched))}`;
  const ov = modal({title: `Did you do ${q.length === 1 ? 'this' : 'these'}?`, ok: null, cancel: 'Close', wide: true,
    body: `<p>${q.length} item${q.length === 1 ? '' : 's'} went past ${q.length === 1 ? 'its' : 'their'} time. Answer each one; anything you skip is asked again next time you open the app.</p>
      ${q.map((x, k) => `<div class="opt" data-row="${k}" style="align-items:center"><div style="flex:1"><b>${esc(x.i.text)}</b><div class="note">${when(x)}</div></div>
        <div class="seg" data-btns="${k}"><button class="btn sm pri" data-pa="done" data-k="${k}">Done</button><button class="btn sm" data-pa="res" data-k="${k}">Reschedule</button><button class="btn sm ghost" data-pa="not" data-k="${k}">Not yet</button></div></div>`).join('')}`,
    onCancel: () => { q.forEach(x => askedPast.add(key(x))); commit(); }});
  ov.querySelector('.modal').addEventListener('click', e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    e.stopPropagation();
    const x = q[+b.dataset.k], slot = ov.querySelector(`[data-btns="${b.dataset.k}"]`);
    askedPast.add(key(x));
    if (b.dataset.pa === 'done') { const m = x.d ? markDelDone(x.i, x.d) : markOwnDone(x.i); slot.innerHTML = `<span class="b ok">✓ ${esc(m.split('.')[0])}</span>`; save(); render(); }
    else if (b.dataset.pa === 'not') { if (x.d) x.d.pastNotDone = true; else x.i.pastNotDone = true; slot.innerHTML = '<span class="b warn">Past, not done</span>'; save(); render(); }
    else { ov.classList.remove('on'); ov.innerHTML = ''; x.d ? scheduleDelModal(x.i, x.d) : scheduleModal(x.i); }
  });
}

/* ---------- rendering ---------- */
function badges(i){
  const o = [];
  if (i.done) o.push(`<span class="b done">✓ Done ${esc(fmtD(i.done.at))}</span>`);
  if (i.bucket) o.push(`<span class="b bucket">${esc(bname(i.bucket))}</span>`);
  if (i.sched && !i.done) o.push(`<span class="b sched">${TYPES[i.sched.type]} · ${i.sched.type === 'task' ? esc(fmtD(i.sched.at)) : esc(fmt(i.sched.at)) + ' · ' + i.sched.len + ' min'}${i.sched.repeat !== 'none' ? ' · ' + REPEATS[i.sched.repeat].toLowerCase() : ''}</span>`);
  if (i.sched && i.sched.loc) o.push(`<span class="b">📍 ${esc(i.sched.loc)}</span>`);
  if (i.pastNotDone) o.push(`<span class="b warn">Past, not done</span>`);
  if (i.ownDone && !i.done) o.push(`<span class="b ok">Your part done</span>`);
  if (i.urgent) o.push(`<span class="b urg">Urgent</span>`);
  if (flagged(i)) o.push(`<span class="b flag">Flagged</span>`);
  if (i.schedCount) o.push(`<span class="b">Scheduled ${i.schedCount}× · ${i.reschedules} reschedule${i.reschedules === 1 ? '' : 's'}</span>`);
  if (waiting(i)) o.push(`<span class="b wait">Waiting 2+ weeks</span>`);
  if (i.personal) o.push(`<span class="b">Personal</span>`); else if (i.process) o.push(`<span class="b type">Work · ${esc(proc(i.process).name)}</span>`); else o.push(`<span class="b tag">Personal or work?</span>`);
  if (i.place) o.push(`<span class="b">📍 ${esc(place(i.place).name)}</span>`);
  if (i.oldName) o.push(`<span class="b tag">Old name: ${esc(i.oldName)}</span>`);
  if (i.wasIn) o.push(`<span class="b tag">Was in ${esc(i.wasIn)}</span>`);
  if (i.needsExpl && !i.expl.trim()) o.push(`<span class="b warn">Needs explanation</span>`);
  if (i.edited || S.notes.some(n => n.id === i.id)) o.push(`<span class="b edited" data-act="history" data-id="${i.id}">${i.edited ? 'edited' : 'history'}</span>`);
  return o.join('');
}
function atts(i){
  if (!i.atts.length) return '';
  return `<div class="atts">${i.atts.map(a => a.type === 'photo' ? `<img src="${a.data}" alt="${esc(a.name)}">`
    : a.type === 'voice' ? `<div class="voice">🎙 ${a.data ? `<audio controls src="${a.data}"></audio>` : ''}<span>${esc(a.transcript || a.name)}</span></div>`
    : a.type === 'email' ? `<div class="email">✉ <span>${esc(a.subject)} · received ${esc(a.date)}</span><a href="${esc(gmailUrl(a))}" target="_blank" rel="noopener">Find in Gmail</a>${a.link ? ` <a href="${esc(a.link)}" target="_blank" rel="noopener">Open link</a>` : ''}</div>`
    : `<div class="lnk">🔗 <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label || a.url)}</a></div>`).join('')}</div>`;
}
function moveSelect(i){
  const opts = orderedBuckets().filter(b => b.id !== i.bucket).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  return `<select data-act="move" data-id="${i.id}" aria-label="Move to bucket"><option value="">Move to…</option>${opts}${i.bucket ? '<option value="__dump">Back to brain dump</option>' : ''}</select>`;
}
function delegSection(i){
  if (!i.delegates.length) return '';
  return `<div class="deleg">${i.delegates.map(d => { const p = person(d.pid), st = dStatus(d); const done = d.status === 'Done';
    const btns = done || i.done ? '' : d.sched
      ? `<button class="btn sm" data-act="dunsched" data-id="${i.id}" data-p="${d.pid}">Unschedule</button><button class="btn sm" data-act="ddone" data-id="${i.id}" data-p="${d.pid}">☑ Done / ticked</button>`
      : (i.bucket ? `<button class="btn sm pri" data-act="dsched" data-id="${i.id}" data-p="${d.pid}">Set due date</button>` : '') + `<button class="btn sm" data-act="ddone" data-id="${i.id}" data-p="${d.pid}">Done</button>`;
    return `<div class="drow"><div><span class="who">→ ${esc(p.name)}</span> ${!p.active ? '<span class="b warn">inactive, reassign</span>' : ''}
      <div class="st">${d.planned && !d.sched ? 'By ' + esc(fmtD(d.planned.at)) + ' · task added when bucketed' : st}${d.sched && !done ? ' · by ' + esc(fmtD(d.sched.at)) : ''}${d.reschedules ? ` · ${d.reschedules} reschedule${d.reschedules === 1 ? '' : 's'}` : ''}${d.reschedules > 3 ? ' · <b style="color:var(--flag)">flagged</b>' : ''}${d.pastNotDone ? ' · past, not done' : ''}</div></div><div style="display:flex;gap:4px;flex-wrap:wrap">${btns}</div></div>`; }).join('')}</div>`;
}
function card(i, ctx){
  const struck = i.status === 'struck', lk = locked(i), done = !!i.done;
  const cls = ['card', struck ? 'struck' : '', done ? 'done' : '', (ctx !== 'bucket' && i.bucket && !struck && !done) ? 'dim' : '', sel.has(i.id) ? 'sel' : ''].join(' ');
  let a = [], more = [];
  if (struck) a = [`<button class="btn sm" data-act="restore" data-id="${i.id}">Restore</button>`, `<button class="btn sm danger" data-act="perm" data-id="${i.id}">Delete for good</button>`];
  else if (done) { a.push(`<button class="btn sm" data-act="reopen" data-id="${i.id}">Reopen</button>`); }
  else {
    if (!lk) a.push(`<button class="btn sm" data-act="edit" data-id="${i.id}">Edit</button>`);
    if (i.sched) {
      a.push(`<button class="btn sm" data-act="unsched" data-id="${i.id}">Unschedule</button>`);
      if (!i.ownDone) a.push(`<button class="btn sm" data-act="owndone" data-id="${i.id}">${i.sched.type === 'task' ? '☑ Done / ticked' : (i.sched.repeat !== 'none' ? 'Done (stop repeating)' : 'Done')}</button>`);
      if (i.sched.repeat !== 'none' && i.sched.type === 'task') a.push(`<button class="btn sm ghost" data-act="stoprep" data-id="${i.id}">Stop repeating</button>`);
    } else {
      if (i.bucket && !i.ownDone) a.push(`<button class="btn sm pri" data-act="sched" data-id="${i.id}">${i.schedCount ? 'Reschedule' : 'Schedule'}</button>`);
      if (!i.ownDone) a.push(`<button class="btn sm" data-act="owndone" data-id="${i.id}">Done</button>`);
    }
    if (!lk) a.push(moveSelect(i));
    more.push(`<button class="btn sm" data-act="urgent" data-id="${i.id}">${i.urgent ? 'Not urgent' : 'Urgent'}</button>`);
    more.push(`<button class="btn sm" data-act="delegate" data-id="${i.id}">Delegate${i.delegates.length ? ' (' + i.delegates.length + ')' : ''}</button>`);
    more.push(`<button class="btn sm" data-act="process" data-id="${i.id}">Personal / work</button>`);
    if (!lk) more.push(`<button class="btn sm" data-act="place" data-id="${i.id}">${i.place ? 'Place' : 'Add place'}</button>`);
    if (i.oldName) a.push(`<button class="btn sm" data-act="confirm" data-id="${i.id}">Confirm bucket</button>`);
    if (canUndo(i)) a.push(`<button class="btn sm" data-act="undoresched" data-id="${i.id}">↶ Undo reschedule</button>`);
    if (i.reschedules > 0 || i.delegates.some(x => x.reschedules > 0)) a.push(`<button class="btn sm" data-act="resetcount" data-id="${i.id}">Reset counter</button>`);
    if (i.isMaster && !lk) more.push(`<button class="btn sm ghost" data-act="unmerge" data-id="${i.id}">Unmerge</button>`, `<button class="btn sm ghost" data-act="master" data-id="${i.id}">Change master</button>`);
    if (!lk) more.push(`<button class="btn sm danger" data-act="del" data-id="${i.id}">Delete</button>`);
    a.push(`<button class="btn sm ghost" data-act="more" data-id="${i.id}">${moreOpen.has(i.id) ? 'Less' : 'More…'}</button>`);
  }
  let grp = '';
  if (i.isMaster) {
    const ms = groupMembers(i.groupId), op = expanded.has(i.groupId);
    grp = `<div class="group"><div class="group-t" data-act="expand" data-id="${i.groupId}">${op ? '▾' : '▸'} ${ms.length} merged item${ms.length === 1 ? '' : 's'}</div>${op ? ms.map(m => `
      <div class="member ${m.status === 'struck' ? 'struck' : ''}"><div class="mt">${esc(m.text)}<small>${esc(m.expl) || 'No explanation'}</small></div><div>${
        m.status === 'struck' ? `<button class="btn sm" data-act="restore" data-id="${m.id}">Restore</button> <button class="btn sm danger" data-act="perm" data-id="${m.id}">Delete for good</button>`
        : (lk || done ? '' : `<button class="btn sm danger" data-act="delmember" data-id="${m.id}">Delete</button>`)}</div></div>`).join('') : ''}</div>`;
  }
  return `<div class="${cls}">${!struck && !done ? `<input type="checkbox" data-act="sel" data-id="${i.id}" ${sel.has(i.id) ? 'checked' : ''} aria-label="Select">` : '<span style="width:17px;flex:none"></span>'}
    <div class="cbody"><div class="text">${done ? '✓ ' : ''}${esc(i.text) || '<em>Untitled</em>'}${i.isMaster ? ' <span class="b bucket" style="vertical-align:2px">master</span>' : ''}</div>
    ${explBlock(i, struck || done)}
    ${atts(i)}<div class="badges">${badges(i)}</div>${delegSection(i)}<div class="acts">${a.join('')}</div>${moreOpen.has(i.id) && more.length ? `<div class="more-acts">${more.join('')}</div>` : ''}${grp}</div></div>`;
}
function bulkBar(){
  if (!sel.size) return '';
  const opts = orderedBuckets().map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  return `<div class="bulk"><b>${sel.size} selected</b><select data-act="bulkmove" aria-label="Move selected"><option value="">Move to bucket…</option>${opts}</select>
    <button class="btn sm" data-act="bulkdump">Back to brain dump</button><button class="btn sm" data-act="merge">Merge</button>
    <button class="btn sm" data-act="bulkurgent">Mark urgent</button><button class="btn sm" data-act="bulkconfirm">Confirm bucket</button>
    <button class="btn sm" data-act="bulkdel">Delete</button><span class="spacer"></span><button class="btn sm" data-act="clearsel">Clear</button></div>`;
}
const stat = (v, label, cls = '', f) => `<div class="stat ${cls} ${f ? 'click' : ''}" ${f ? `data-act="filter" data-f="${f}"` : ''}><div class="v">${v}</div><div class="k">${label}</div></div>`;

function vDump(){
  const c = counts(), T = tops().filter(matchQ);
  const unb = T.filter(i => open_(i) && !i.bucket).sort((a, b) => b.created - a.created);
  const inb = T.filter(i => open_(i) && i.bucket).sort((a, b) => b.created - a.created);
  const dn = T.filter(i => live(i) && i.done).sort((a, b) => b.done.at - a.done.at);
  const str = T.filter(i => i.status === 'struck').sort((a, b) => b.struckAt - a.struckAt);
  const sec = (t, arr) => arr.length ? `<div class="sep">${t}</div>` + arr.map(i => card(i)).join('') : '';
  let list;
  if (filter === 'all') list = sec('Unbucketed', unb) + sec('In buckets', inb) + sec('Done', dn) + sec('Struck through', str);
  else if (filter === 'unb') list = unb.map(i => card(i)).join('');
  else if (filter === 'inb') list = inb.map(i => card(i)).join('');
  else if (filter === 'struck') list = str.map(i => card(i)).join('');
  else if (filter === 'conf') list = T.filter(i => open_(i) && i.oldName).map(i => card(i)).join('');
  else if (filter === 'email') list = T.filter(i => live(i) && i.atts.some(a => a.type === 'email')).map(i => card(i)).join('');
  const chips = [['all', 'All'], ['unb', 'Unbucketed'], ['inb', 'In buckets'], ['email', 'From email'], ['struck', 'Struck through']].concat(c.conf ? [['conf', `To confirm (${c.conf})`]] : []);
  return `${captureBar()}<div class="head"><div><h1>Brain dump</h1><p>Everything lands here first. Nothing ever leaves this list.</p></div></div>
  <div class="stats">${stat(c.total, 'Total')}${stat(c.unb, 'Unbucketed', '', 'unb')}${stat(c.inb, 'In buckets', '', 'inb')}${stat(c.done, 'Done')}${stat(c.del, 'Deleted')}${stat(c.flag, 'Flagged', c.flag ? 'hot' : '')}${c.conf ? stat(c.conf, 'To confirm', 'hot', 'conf') : ''}</div>
  ${searchBox()}
  <div class="chips">${chips.map(([k, l]) => `<button class="chip ${filter === k ? 'on' : ''}" data-act="filter" data-f="${k}">${l}</button>`).join('')}</div>
  ${bulkBar()}<div class="list">${list || '<div class="empty">Nothing here.</div>'}</div>`;
}
function vBuckets(){
  if (openBucket) return vBucket(bucket(openBucket));
  return `<div class="head"><div><h1>Buckets</h1><p>Labels that sort the river. Any item can be scheduled from any bucket.</p></div><button class="btn pri" data-act="addbucket">+ New bucket</button></div>
  <div class="grid">${orderedBuckets().map(b => { const k = bucketCounts(b); const m = (v, l) => `<div class="${v ? '' : 'z'}"><b>${v}</b>${l}</div>`;
    return `<div class="bcard" data-act="openb" data-id="${b.id}"><h3>${esc(b.name)}<span>${k.unsched} not scheduled</span></h3>
      <div class="mini">${m(k.open, 'Open')}${m(k.sched, 'Scheduled')}${m(k.urg, 'Urgent')}${m(k.flag, 'Flagged')}${m(k.del, 'Delegated')}${m(k.wait, 'Waiting')}${b.loc ? m(k.noplace, 'No place') : ''}</div>
      ${b.deleting ? '<div class="note" style="color:var(--urgent)">Emptying for deletion</div>' : ''}</div>`; }).join('')}</div>`;
}
function vBucket(b){
  if (!b) { openBucket = null; return vBuckets(); }
  const k = bucketCounts(b);
  const its = tops().filter(i => open_(i) && i.bucket === b.id).sort((x, y) => (flagged(y) - flagged(x)) || (y.urgent - x.urgent) || (x.created - y.created));
  const unconf = its.filter(i => i.oldName).length;
  return `<div class="head"><div><button class="btn sm ghost" data-act="backb">← All buckets</button><h1 style="margin-top:8px">${esc(b.name)}</h1><p>Sorted: flagged, then urgent, then oldest. Done items move to the Done list.</p></div>
    <div style="display:flex;gap:6px"><button class="btn" data-act="renameb" data-id="${b.id}">Rename</button><button class="btn danger" data-act="deleteb" data-id="${b.id}">Delete bucket</button></div></div>
  ${b.deleting ? `<div class="banner warn">Emptying this bucket for deletion: ${its.length} item${its.length === 1 ? '' : 's'} left. Items sent to the brain dump get a “Was in ${esc(b.name)}” tag. Unscheduling here won't count toward the flag.<span class="spacer"></span><button class="btn sm" data-act="canceldel" data-id="${b.id}">Stop</button></div>` : ''}
  ${unconf ? `<div class="banner info">${unconf} item${unconf === 1 ? '' : 's'} still carry an old bucket name. Confirm each one belongs here.<span class="spacer"></span><button class="btn sm" data-act="confirmall" data-id="${b.id}">Confirm all</button></div>` : ''}
  <div class="stats">${stat(k.open, 'Open')}${stat(k.sched, 'Scheduled')}${stat(k.unsched, 'Not scheduled')}${stat(k.urg, 'Urgent', k.urg ? 'urg' : '')}${stat(k.flag, 'Flagged', k.flag ? 'hot' : '')}${stat(k.del, 'Delegated')}${stat(k.wait, 'Waiting 2+ wks')}${b.loc ? stat(k.noplace, 'No place') : ''}</div>
  ${bulkBar()}<div class="list">${its.map(i => card(i, 'bucket')).join('') || '<div class="empty">This bucket is empty.</div>'}</div>`;
}
function vUrgent(){
  const its = tops().filter(i => open_(i) && i.urgent).sort((a, b) => locked(a) - locked(b) || a.created - b.created);
  const n = its.filter(i => !locked(i)).length;
  return `<div class="head"><div><h1>Urgent</h1><p>Urgent stays on an item until it's done. Scheduled urgent items stay here but drop out of the morning number.</p></div></div>
  <div class="banner info">Tomorrow at 4:00 am, Google Calendar shows: <b>“${n} urgent item${n === 1 ? '' : 's'} not scheduled”</b>. It shows on your watch too.</div>
  ${bulkBar()}<div class="list">${its.map(i => card(i)).join('') || '<div class="empty">No urgent items.</div>'}</div>`;
}
function vCalendar(){
  const ev = [];
  tops().filter(live).forEach(i => {
    if (i.sched && !(i.done && i.sched.type !== 'task')) ev.push({t: i.sched.at, i, own: true});
    if (!i.done) i.delegates.forEach(d => { if (d.sched) ev.push({t: d.sched.at, i, d}); });
  });
  const c = counts(); const t4 = new Date(now()); t4.setDate(t4.getDate() + 1); t4.setHours(4, 0, 0, 0);
  ev.push({t: +t4, sys: true}); ev.sort((a, b) => a.t - b.t);
  const days = {}; ev.forEach(e => { const k = fmtD(e.t); (days[k] = days[k] || []).push(e); });
  const row = e => {
    if (e.sys) return `<div class="ev sys"><time>4:00</time><div><b>${c.urgUnsched} urgent item${c.urgUnsched === 1 ? '' : 's'} not scheduled</b><div class="note">Daily reminder, updated by the app</div></div></div>`;
    const i = e.i;
    if (e.d) { const dn = e.d.status === 'Done';
      return `<div class="ev task ${dn ? 'done-ev' : ''}"><time>${dn ? '☑' : '☐'}</time><div><b>Follow up with ${esc(person(e.d.pid).name)}: ${esc(i.text)}</b><div class="note">Google Task · ${esc(i.expl)}${dOverdue(e.d) ? ' · <span style="color:var(--urgent)">Overdue</span>' : ''}</div></div></div>`; }
    const s = i.sched, dn = !!i.done;
    return `<div class="ev ${s.type === 'task' ? 'task' : ''} ${dn ? 'done-ev' : ''}"><time>${s.type === 'task' ? (dn ? '☑' : '☐') : new Date(s.at).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})}</time>
      <div><b>${esc(i.text)}</b><div class="note">${s.type === 'task' ? 'Google Task' : TYPES[s.type] + ' · ' + s.len + ' min'}${s.loc ? ' · 📍 ' + esc(s.loc) : ''}${s.repeat !== 'none' ? ' · repeats ' + REPEATS[s.repeat].toLowerCase() : ''} · ${esc(i.expl)}${i.atts.some(a => a.type === 'email') ? ' · Find in Gmail link' : ''}</div></div></div>`;
  };
  return `<div class="head"><div><h1>Google Calendar</h1><p>A simulation of what the app writes to your main Google calendar and Google Tasks. Use “Moved / Deleted / Ticked in Google” on an item to test sync.</p></div></div>
  ${Object.entries(days).map(([d, es]) => `<div class="cal-day"><h3>${d}</h3>${es.map(row).join('')}</div>`).join('')}`;
}
function inPeriod(t){
  const n = new Date(now()); let s;
  if (period === 'week') { s = new Date(n); s.setDate(n.getDate() - ((n.getDay() + 6) % 7)); s.setHours(0, 0, 0, 0); return t >= +s && t < +s + 7 * DAY; }
  if (period === 'month') { s = new Date(n.getFullYear(), n.getMonth(), 1); const e = new Date(n.getFullYear(), n.getMonth() + 1, 1); return t >= +s && t < +e; }
  const q = Math.floor(n.getMonth() / 3); s = new Date(n.getFullYear(), q * 3, 1); const e = new Date(n.getFullYear(), q * 3 + 3, 1); return t >= +s && t < +e;
}
function periodBounds(){
  const n = new Date(now());
  if (period === 'week') { const s = new Date(n); s.setDate(n.getDate() - ((n.getDay() + 6) % 7)); s.setHours(0, 0, 0, 0); return [+s, +s + 7 * DAY]; }
  if (period === 'month') return [+new Date(n.getFullYear(), n.getMonth(), 1), +new Date(n.getFullYear(), n.getMonth() + 1, 1)];
  const q = Math.floor(n.getMonth() / 3); return [+new Date(n.getFullYear(), q * 3, 1), +new Date(n.getFullYear(), q * 3 + 3, 1)];
}
function hoursFor(i){
  const s = i.sched; if (!s || s.type === 'task') return 0;
  const [a, b] = periodBounds(); let t = s.at, n = 0, guard = 0;
  if (s.repeat === 'none') return inPeriod(t) ? s.len / 60 : 0;
  while (t < a && guard++ < 2000) t = nextOcc(t, s.repeat);
  while (t < b && guard++ < 4000) { n++; t = nextOcc(t, s.repeat); }
  return n * s.len / 60;
}
function vReport(){
  const rows = {}; const key = i => i.personal ? '__personal' : (i.process || '__none');
  const add = (k, f, v) => { rows[k] = rows[k] || {items: 0, hours: 0, done: 0}; rows[k][f] += v; };
  tops().filter(i => i.status !== 'deleted' && i.status !== 'struck').forEach(i => {
    if (inPeriod(i.created)) add(key(i), 'items', 1);
    const h = hoursFor(i); if (h) add(key(i), 'hours', h);
  });
  S.doneLog.filter(l => inPeriod(l.t)).forEach(l => { const i = get(l.id); if (i) add(key(i), 'done', 1); });
  const work = Object.entries(rows).filter(([k]) => k !== '__personal').reduce((s, [, r]) => s + r.hours, 0);
  const name = k => k === '__personal' ? 'Personal' : k === '__none' ? 'No process yet' : proc(k).name;
  const order = Object.keys(rows).sort((a, b) => (a === '__personal') - (b === '__personal') || rows[b].hours - rows[a].hours || rows[b].items - rows[a].items);
  return `<div class="head"><div><h1>Metrics</h1><p>Time by process. Items count in the period they were captured; hours count when the event or appointment takes place. Tasks add no hours.</p></div></div>
  <div class="chips">${['week', 'month', 'quarter'].map(p => `<button class="chip ${period === p ? 'on' : ''}" data-act="period" data-p="${p}">This ${p}</button>`).join('')}</div>
  <table class="rep"><thead><tr><th>Process</th><th class="num">Items</th><th class="num">Scheduled hours</th><th class="num">Items done</th><th>% of work hours</th></tr></thead><tbody>
  ${order.map(k => { const r = rows[k], pc = k === '__personal' || !work ? null : Math.round(r.hours / work * 100);
    return `<tr><td><b>${esc(name(k))}</b></td><td class="num">${r.items}</td><td class="num">${r.hours.toFixed(1)}</td><td class="num">${r.done}</td><td>${pc === null ? '<span class="note">not counted</span>' : `<div style="display:flex;gap:8px;align-items:center"><div class="bar"><i style="width:${pc}%"></i></div>${pc}%</div>`}</td></tr>`; }).join('') || '<tr><td colspan="5">Nothing in this period.</td></tr>'}
  </tbody></table><p class="note">Work hours this ${period}: ${work.toFixed(1)}. Repeating events count every occurrence in the period.</p>`;
}
function vDone(){
  const its = tops().filter(i => live(i) && i.done).filter(i => {
    if (doneFilter.proc === '__personal' && !i.personal) return false;
    if (doneFilter.proc && doneFilter.proc !== '__personal' && i.process !== doneFilter.proc) return false;
    if (doneFilter.period === 'week') return now() - i.done.at < 7 * DAY;
    if (doneFilter.period === 'month') return now() - i.done.at < 31 * DAY;
    return true;
  }).sort((a, b) => b.done.at - a.done.at);
  return `<div class="head"><div><h1>Done</h1><p>Kept forever. Reopening puts an item back in its bucket, unscheduled.</p></div></div>
  <div class="chips">${[['all', 'All time'], ['week', 'Last 7 days'], ['month', 'Last 31 days']].map(([k, l]) => `<button class="chip ${doneFilter.period === k ? 'on' : ''}" data-act="dfper" data-p="${k}">${l}</button>`).join('')}
  <select data-act="dfproc" style="border:1px solid var(--line);border-radius:20px;padding:4px 10px;background:transparent"><option value="">All processes</option>${S.processes.map(p => `<option value="${p.id}" ${doneFilter.proc === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__personal" ${doneFilter.proc === '__personal' ? 'selected' : ''}>Personal</option></select></div>
  <div class="list">${its.map(i => card(i)).join('') || '<div class="empty">Nothing done in this view yet.</div>'}</div>`;
}
function vPeople(){
  const stats = p => {
    const ids = [...new Set(S.personLog.filter(l => l.pid === p.id && l.kind === 'assigned').map(l => l.id))];
    const ds = []; ids.map(get).filter(Boolean).forEach(i => i.delegates.filter(d => d.pid === p.id).forEach(d => ds.push(d)));
    const done = ds.filter(d => d.status === 'Done' && d.sched), late = done.filter(d => d.doneAt > dayEnd(d.sched.at));
    const delay = late.length ? (late.reduce((s, d) => s + (d.doneAt - dayEnd(d.sched.at)), 0) / late.length / DAY).toFixed(1) : 0;
    const op = S.items.filter(i => live(i) && !i.done && i.delegates.some(d => d.pid === p.id && d.status !== 'Done')).length;
    return {total: ids.length, ontime: done.length - late.length, late: late.length, delay, open: op};
  };
  const col = (title, addId, addPh, addAct, rows, extra = '') => `<section class="pcol"><div class="pcol-h"><h2>${title}</h2><span class="note">${rows.length}</span></div>
    <div class="inline"><input id="${addId}" placeholder="${addPh}">${extra}<button class="btn pri" data-act="${addAct}">Add</button></div><div class="plist">${rows.join('') || '<span class="empty-s">None yet</span>'}</div></section>`;
  const people = S.people.map(p => { const s = stats(p); return `<div class="prow"><div><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="b warn">inactive</span>'}
    <small>${p.email ? esc(p.email) : 'no email'}</small><small>${s.total} delegated · ${s.open} open · ${s.ontime} on time · ${s.late} late${s.late ? ` (avg ${s.delay} days)` : ''}</small>${!p.active && s.open ? `<small style="color:var(--urgent)">${s.open} open item${s.open === 1 ? '' : 's'} need reassigning</small>` : ''}</div>
    <div class="pbtns"><button class="btn sm" data-act="renamep" data-id="${p.id}">Edit</button><button class="btn sm" data-act="togglep" data-id="${p.id}">${p.active ? 'Make inactive' : 'Make active'}</button></div></div>`; });
  const places = S.places.map(l => `<div class="prow"><div><b>${esc(l.name)}</b><small>${S.items.filter(i => i.place === l.id && live(i)).length} items</small></div><div class="pbtns"><button class="btn sm" data-act="renamel" data-id="${l.id}">Rename</button></div></div>`);
  const procs = S.processes.map(r => `<div class="prow"><div><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="b warn">inactive</span>'}<small>${S.items.filter(i => i.process === r.id && live(i)).length} items</small></div>
    <div class="pbtns"><button class="btn sm" data-act="renamer" data-id="${r.id}">Rename</button><button class="btn sm" data-act="toggler" data-id="${r.id}">${r.active ? 'Make inactive' : 'Make active'}</button></div></div>`);
  return `<div class="head"><div><h1>People, places, processes</h1><p>None of these can be deleted: rename them, or mark people and processes inactive.</p></div></div>
  <div class="pcols">${col('People', 'newp', 'Name', 'addp', people, '<input id="newpe" placeholder="Email (optional)">')}${col('Places', 'newl', 'New place', 'addl', places)}${col('Processes', 'newr', 'New process', 'addr', procs)}</div>`;
}
function vLog(){
  const tabs = [['items', 'Item changes'], ['buckets', 'Bucket changes'], ['people', 'Delegation'], ['notes', 'Reschedule notes']];
  let rows;
  if (logTab === 'items') rows = S.itemLog.map(l => `<tr><td>${fmt(l.t)}</td><td>${esc(l.kind)}</td><td>${esc(l.detail)}</td></tr>`);
  else if (logTab === 'buckets') rows = S.bucketLog.map(l => `<tr><td>${fmt(l.t)}</td><td colspan="2">${esc(l.detail)}</td></tr>`);
  else if (logTab === 'people') rows = S.personLog.map(l => `<tr><td>${fmt(l.t)}</td><td>${esc((person(l.pid) || {}).name)}</td><td>${esc(l.kind)}${l.id ? ': ' + esc((get(l.id) || {text: '(removed item)'}).text) : ''}</td></tr>`);
  else rows = S.notes.map(n => `<tr><td>${fmt(n.t)}</td><td>${esc((get(n.id) || {text: ''}).text)}</td><td>${esc(n.text)}</td></tr>`);
  return `<div class="head"><div><h1>Change log</h1><p>Item changes record edits, merges and deletes. Moves are bucket changes. Reschedule notes are not edits.</p></div></div>
  <div class="tabs">${tabs.map(([k, l]) => `<button class="chip ${logTab === k ? 'on' : ''}" data-act="logtab" data-t="${k}">${l}</button>`).join('')}</div>
  <table><thead><tr><th style="width:150px">When</th><th style="width:140px">${logTab === 'people' ? 'Person' : logTab === 'notes' ? 'Item' : 'Type'}</th><th>Detail</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="3">Nothing yet.</td></tr>'}</tbody></table>`;
}
function vDeleted(){
  const its = S.items.filter(i => i.status === 'deleted').sort((a, b) => a.deletedAt - b.deletedAt);
  return `<div class="head"><div><h1>Deleted</h1><p>Kept for 60 days, then removed for good. Restored items come back unbucketed.</p></div>${its.length ? '<button class="btn danger" data-act="emptyd">Empty now</button>' : ''}</div>
  <div class="list">${its.map(i => { const left = Math.max(0, Math.ceil((i.deletedAt + 60 * DAY - now()) / DAY));
    return `<div class="card"><div class="cbody"><div class="text">${esc(i.text)}</div><div class="badges"><span class="b ${left <= 7 ? 'warn' : ''}">${left} day${left === 1 ? '' : 's'} left</span></div>
      <div class="acts"><button class="btn sm" data-act="undelete" data-id="${i.id}">Restore</button><button class="btn sm danger" data-act="delnow" data-id="${i.id}">Delete now</button></div></div></div>`; }).join('') || '<div class="empty">The Deleted section is empty.</div>'}</div>`;
}
function render(){
  if (purge()) save();
  renderSide();
  document.documentElement.style.setProperty('--ff', S.font === 'Times New Roman' ? '"Times New Roman", Times, serif' : 'Aptos, "Segoe UI", -apple-system, system-ui, sans-serif');
  $('#main').innerHTML = (S._welcome ? '' : conflictBanner()) + ({board: vBoard, dump: vDump, buckets: vBuckets, urgent: vUrgent, done: vDone, report: vReport, people: vPeople, log: vLog, deleted: vDeleted, settings: vSettings})[view]();
  renderPanel();
  setTimeout(() => flushMail() || checkPast(), 60);
}

/* ---------- modals ---------- */
function procField(i){
  const k = i.personal ? 'personal' : i.process ? 'work' : '';
  return `<div class="f"><label>Personal or work? (required before scheduling)</label><div class="seg">
      <label><input type="radio" name="kind" value="personal" ${k === 'personal' ? 'checked' : ''}><span>Personal</span></label>
      <label><input type="radio" name="kind" value="work" ${k === 'work' ? 'checked' : ''}><span>Work</span></label></div></div>
    <div class="f" id="m-procwrap" style="${k === 'work' ? '' : 'display:none'}"><label>Process</label><select id="m-proc"><option value="">Choose a process…</option>${S.processes.filter(p => p.active || p.id === i.process).map(p => `<option value="${p.id}" ${p.id === i.process ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`;
}
function applyProc(i, o){
  const r = o.querySelector('input[name=kind]:checked'); if (!o.querySelector('input[name=kind]')) return true;
  if (!r) return false;
  if (r.value === 'personal') { i.personal = true; i.process = null; return true; }
  const v = o.querySelector('#m-proc').value; if (!v) return false;
  i.personal = false; i.process = v; return true;
}
function scheduleModal(i){
  const s = i.sched || {}, resched = i.schedCount > 0;
  const startT = Math.max(now() + DAY, s.at || 0);
  const ov = modal({title: resched ? 'Reschedule' : 'Schedule', ok: 'Add to Google', wide: true,
    body: `${C.stage < 2 ? '<div class="banner info">Test stage 1: this is saved in the app and shows on the board. Sending it to Google Calendar and Tasks arrives in stage 2.</div>' : ''}${needsProc(i) ? procField(i) : ''}
      <div class="f"><label>Type</label><div class="seg">${Object.entries(TYPES).map(([k, l]) => `<label><input type="radio" name="ty" value="${k}" ${(s.type || 'task') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div></div>
      <div id="m-when"></div>
      <div class="f"><label>Repeat</label><select id="m-rep">${Object.entries(REPEATS).map(([k, l]) => `<option value="${k}" ${(s.repeat || 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${resched ? `<p>${i.forcedFree ? 'This won\'t count as a reschedule (unscheduled to empty a bucket).' : `This will be reschedule #${i.reschedules + 1}.${i.reschedules + 1 === 6 ? ' The item will be Flagged.' : ''}`}</p>
      <div class="f"><label>Note (optional, shown in the item's history)</label><input type="text" id="m-note" placeholder="Why it moved"></div>` : ''}`,
    onOk: o => {
      if (!applyProc(i, o)) { toast('Choose Personal, or Work and a process'); return false; }
      const ty = o.querySelector('input[name=ty]:checked').value, rep = o.querySelector('#m-rep').value;
      let at, len, loc = '';
      if (ty === 'task') { const v = o.querySelector('#m-day').value; if (!v) return false; at = parseDay(v); }
      else { at = Date.parse(o.querySelector('#m-dt').value); len = +o.querySelector('#m-len').value || 30; if (ty === 'appt') loc = o.querySelector('#m-loc').value.trim(); if (!at) return false; }
      if (i.schedCount > 0) snapUndo(i); countSchedule(i); const oldS = i.sched, keepG = oldS && oldS.g && ((oldS.type === 'task') === (ty === 'task')) ? oldS.g : null; if (oldS && oldS.g && !keepG) gForget(oldS, oldS.type === 'task' ? 'task' : 'event'); i.sched = {at, type: ty, len, loc, repeat: rep, g: keepG};
      if (resched) note(i.id, (o.querySelector('#m-note') || {}).value);
      commit(i.reschedules === 6 && resched ? 'Rescheduled. 6th reschedule: the item is now Flagged.' : C.stage < 2 ? `${TYPES[ty]} scheduled (Google sync comes in stage 2)` : `${TYPES[ty]} added to Google${ty === 'task' ? ' Tasks' : ' Calendar'}`);
    }});
  const drawWhen = () => {
    const ty = ov.querySelector('input[name=ty]:checked').value;
    ov.querySelector('#m-when').innerHTML = ty === 'task'
      ? `<div class="f"><label>Date (Google doesn't let apps give tasks a time)</label><input type="date" id="m-day" value="${isoDay(startT)}"></div>`
      : `<div class="row2"><div class="f"><label>Date and time</label><input type="datetime-local" id="m-dt" value="${isoDT(s.at && s.type !== 'task' ? startT : new Date(startT).setHours(9, 0, 0, 0))}"></div>
         <div class="f"><label>Length (minutes)</label><select id="m-len">${[15, 30, 45, 60, 90, 120].map(m => `<option ${(s.len || 30) === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>
         ${ty === 'appt' ? `<div class="f"><label>Location</label><input type="text" id="m-loc" value="${esc(s.loc || '')}" placeholder="e.g. Dr Rao's clinic"></div>` : ''}`;
  };
  ov.querySelectorAll('input[name=ty]').forEach(r => r.onchange = drawWhen); drawWhen();
}
function moveInGoogleModal(i){
  const s = i.sched;
  modal({title: 'Simulate: moved in Google', ok: 'Sync the move',
    body: `<p>The app notices at the next sync. However many times it moved in between, this counts as 1 reschedule.</p>
      <div class="f"><label>New ${s.type === 'task' ? 'date' : 'date and time'}</label>${s.type === 'task' ? `<input type="date" id="m-day" value="${isoDay(s.at + DAY)}">` : `<input type="datetime-local" id="m-dt" value="${isoDT(s.at + DAY)}">`}</div>
      <div class="f"><label>Note (optional)</label><input type="text" id="m-note"></div>`,
    onOk: o => { const at = s.type === 'task' ? parseDay(o.querySelector('#m-day').value) : Date.parse(o.querySelector('#m-dt').value); if (!at) return false;
      i.schedCount++; i.reschedules++; i.sched.at = at; i.pastNotDone = false; note(i.id, o.querySelector('#m-note').value);
      commit(i.reschedules === 6 ? 'Synced. 6th reschedule: the item is now Flagged.' : 'Synced: counted as 1 reschedule'); }});
}
function scheduleDelModal(i, d, sim){
  const p = person(d.pid), resched = d.schedCount > 0;
  if (!p.active && !sim) return toast(`${p.name} is inactive. Reassign first.`);
  modal({title: sim ? `Simulate: ${p.name}'s task moved in Google` : `${resched ? 'Change due date' : 'Set due date'} for ${p.name}`, ok: sim ? 'Sync the move' : 'Add task to Google',
    body: `${!sim && needsProc(i) ? procField(i) : ''}<p>Follow-ups are always Google Tasks: “Follow up with ${esc(p.name)}: ${esc(i.text)}”.</p>
      ${resched || sim ? `<p>${d.forcedFree && !sim ? 'This won\'t count as a reschedule.' : `This will be reschedule #${d.reschedules + 1} for ${esc(p.name)}.${d.reschedules + 1 === 4 ? ' The item will be Flagged (follow-ups flag after 3).' : ''}`}</p>` : ''}
      <div class="f"><label>Date</label><input type="date" id="m-day" value="${isoDay(Math.max(now() + DAY, d.sched ? d.sched.at + DAY : 0))}"></div>
      ${resched || sim ? '<div class="f"><label>Note (optional)</label><input type="text" id="m-note"></div>' : ''}`,
    onOk: o => {
      if (!sim && !applyProc(i, o)) { toast('Choose Personal, or Work and a process'); return false; }
      const at = parseDay(o.querySelector('#m-day').value); if (!at) return false;
      const prev = d.sched ? d.sched.at : null;
      if (sim || d.schedCount > 0) snapUndo(i, d); if (sim) { d.schedCount++; d.reschedules++; } else countSchedule(d);
      d.sched = {at, g: d.sched && d.sched.g || null}; d.status = d.schedCount > 1 ? 'Rescheduled' : 'Due'; d.pastNotDone = false;
      if (resched || sim) note(i.id, `${p.name}: ${(o.querySelector('#m-note') || {}).value || ''}`.replace(/: $/, ''));
      commit(d.reschedules === 4 ? `${p.name}'s 4th reschedule: the item is now Flagged.` : 'Follow-up task added');
      queueMail([{i, d, kind: resched || sim ? 'moved' : 'new', prev}]); setTimeout(flushMail, 0);
    }});
}
function editModal(i){
  let att = i.atts.map(a => Object.assign({}, a));
  const draw = ov => { ov.querySelector('#m-atts').innerHTML = att.map((a, k) => `<div class="opt">${a.type === 'photo' ? `<img src="${a.data}" style="width:48px;height:48px;object-fit:cover;border-radius:6px">` : a.type === 'voice' ? '🎙' : a.type === 'email' ? '✉' : '🔗'}
      <div style="flex:1">${a.type === 'voice' ? `<textarea data-k="${k}" class="m-tr" style="min-height:44px">${esc(a.transcript)}</textarea>` : a.type === 'email' ? esc(a.subject) + ' · ' + esc(a.date) : esc(a.label || a.url || a.name)}</div><button class="btn sm danger" data-rm="${k}">Remove</button></div>`).join(''); };
  const ov = modal({title: 'Edit item', ok: 'Save', wide: true,
    body: `<div class="f"><label>Text</label><textarea id="m-text">${esc(i.text)}</textarea></div>
      <div class="f"><label>Explanation (what needs to be done)</label><textarea id="m-expl">${esc(i.expl)}</textarea></div>
      <div class="f"><label>Photos, voice notes, emails, links</label><div id="m-atts"></div>
      <div class="cap-row"><label class="btn sm">+ Photo<input type="file" accept="image/*" id="m-photo"></label><button class="btn sm" id="m-voice">+ Voice note (simulated)</button></div>
      <div class="row2" style="margin-top:8px"><input type="text" id="m-url" placeholder="Paste a link (maps, web…)"><button class="btn sm" id="m-addurl">+ Link</button></div>
      <div class="row2" style="margin-top:8px"><input type="text" id="m-esub" placeholder="Email subject"><input type="date" id="m-edate" value="${isoDay(now())}"></div><button class="btn sm" id="m-addemail" style="margin-top:6px">+ Email</button></div>`,
    onOk: o => {
      o.querySelectorAll('.m-tr').forEach(t => att[t.dataset.k].transcript = t.value);
      const text = o.querySelector('#m-text').value.trim(), expl = o.querySelector('#m-expl').value.trim(), ch = [];
      if (text !== i.text) ch.push(`Text: "${i.text}" → "${text}"`);
      const explChanged = expl !== i.expl;
      if (JSON.stringify(att) !== JSON.stringify(i.atts)) ch.push(`Attachments: ${i.atts.length} → ${att.length}`);
      if (!ch.length && !explChanged) return;
      i.text = text; i.expl = expl; i.atts = att; if (expl) i.needsExpl = false;
      if (explChanged) note(i.id, `Explanation updated: "${expl}"`);
      if (!ch.length) { save(); render(); toast('Explanation saved'); return; }
      i.edited = true; logItem(i.id, 'edit', ch.join(' · ')); save(); render(); toast('Saved and logged');
      setTimeout(() => afterEditPrompt(i), 0);
    }});
  draw(ov);
  ov.querySelector('#m-atts').onclick = e => { if (e.target.dataset.rm !== undefined) { ov.querySelectorAll('.m-tr').forEach(t => att[t.dataset.k].transcript = t.value); att.splice(+e.target.dataset.rm, 1); draw(ov); } };
  ov.querySelector('#m-voice').onclick = () => { att.push(simVoice()); draw(ov); };
  ov.querySelector('#m-addurl').onclick = () => { const u = ov.querySelector('#m-url').value.trim(); if (!/^https?:\/\//i.test(u)) return toast('Links start with http:// or https://'); att.push({type: 'link', url: u, label: ''}); ov.querySelector('#m-url').value = ''; draw(ov); };
  ov.querySelector('#m-addemail').onclick = () => { const s = ov.querySelector('#m-esub').value.trim(); if (!s) return; att.push({type: 'email', subject: s, date: ov.querySelector('#m-edate').value || isoDay(now()), link: ''}); ov.querySelector('#m-esub').value = ''; draw(ov); };
  ov.querySelector('#m-photo').onchange = async e => { for (const f of e.target.files) { const a = await readFile(f); if (a) att.push(a); } draw(ov); };
}
function emailModal(){
  modal({title: 'Add email', ok: 'Add to brain dump',
    body: `<p>Paste the subject. “Find in Gmail” will search for it around the date received.</p>
      <div class="f"><label>Subject</label><input type="text" id="m-sub"></div>
      <div class="f"><label>Date received</label><input type="date" id="m-date" value="${isoDay(now())}"></div>
      <div class="f"><label>Link (optional; from the browser's address bar in Gmail)</label><input type="url" id="m-link" placeholder="https://mail.google.com/…"></div>`,
    onOk: o => {
      const subject = o.querySelector('#m-sub').value.trim(); if (!subject) return false;
      const a = {type: 'email', subject, date: o.querySelector('#m-date').value || isoDay(now()), link: o.querySelector('#m-link').value.trim()};
      const ex = findSubject(subject);
      const create = () => { S.items.push(base({text: subject, atts: [a]})); commit('Email added to the brain dump'); };
      if (!ex) { create(); return; }
      setTimeout(() => {
        modal.alts = {alt1: create};
        modal({title: 'This subject already exists', ok: 'Attach to it', extra: '<button class="btn" data-m="alt1">Create a new item</button>',
          body: `<p>“${esc(subject)}” is already on <b>${esc(ex.text)}</b>. Attach this email to that item instead?</p>`,
          onOk: () => { if (locked(ex)) { toast('That item is scheduled (locked). Unschedule it first, or create a new item.'); return; } ex.atts.push(a); ex.edited = true; logItem(ex.id, 'edit', `Email added: "${subject}"`); commit('Email attached'); setTimeout(() => afterEditPrompt(ex), 0); }});
      }, 0);
    }});
}
function mergeFlow(){
  const its = [...sel].map(get).filter(Boolean);
  if (its.length < 2) return toast('Select at least two items to merge');
  if (its.some(i => !open_(i))) return toast('Only open items can be merged.');
  if (its.some(locked)) return toast('A scheduled item cannot be merged. Unschedule it first.');
  if (new Set(its.map(i => !!i.bucket)).size > 1) return toast("Bucketed and unbucketed items can't be merged. Bucket the unbucketed ones first.");
  const def = its.find(i => i.isMaster) || its.slice().sort((a, b) => a.created - b.created)[0];
  modal({title: 'Merge items', ok: 'Merge',
    body: `<p>Pick the master. The others go under it.${its[0].bucket ? ' The whole group moves to the master\'s bucket.' : ''} Reschedule counters reset.</p>
      ${its.map(i => `<label class="opt"><input type="radio" name="mm" value="${i.id}" ${i === def ? 'checked' : ''}><div><b>${esc(i.text)}</b>${i.isMaster ? ` <span class="b">group of ${groupAll(i.groupId).length}</span>` : ''}<div class="note">${i.bucket ? esc(bname(i.bucket)) + ' · ' : ''}${esc(i.expl) || 'No explanation'}</div></div></label>`).join('')}`,
    onOk: o => {
      const m = get(o.querySelector('input[name=mm]:checked').value), gid = m.groupId || uid('g'), all = [];
      its.forEach(i => (i.groupId ? groupAll(i.groupId) : [i]).forEach(x => all.includes(x) || all.push(x)));
      all.forEach(x => { if (m.bucket && x.bucket !== m.bucket) logBucket(`"${x.text}" moved from ${bname(x.bucket)} to ${bname(m.bucket)} (merge)`);
        x.bucket = m.bucket; x.groupId = gid; x.isMaster = x === m; resetCounters(x); if (m.bucket) x.firstBucketedAt = x.firstBucketedAt || now(); });
      m.edited = true; logItem(m.id, 'merge', `"${m.text}" is master of: ${all.filter(x => x !== m).map(x => '"' + x.text + '"').join(', ')}`);
      sel.clear(); expanded.add(gid); commit('Merged. Counters reset.');
    }});
}
function deleteTop(i){
  if (locked(i)) return toast('Scheduled items are locked. Unschedule first.');
  if (i.bucket) return toast(i.isMaster ? 'To delete the master, move the group back to the brain dump first.' : 'Move it back to the brain dump before deleting.');
  if (i.isMaster) {
    const ms = groupMembers(i.groupId).filter(live);
    modal({title: 'Delete the master', ok: 'Delete', danger: true,
      body: `<p>Choose which merged items are deleted with it. The rest stay merged; the one captured first becomes the new master.</p>${ms.map(m => `<label class="opt"><input type="checkbox" value="${m.id}"><div>${esc(m.text)}<div class="note">captured ${fmt(m.created)}</div></div></label>`).join('')}`,
      onOk: o => { const gone = [...o.querySelectorAll('input:checked')].map(c => get(c.value)), gid = i.groupId;
        [i, ...gone].forEach(x => { x.groupId = null; x.isMaster = false; strike(x); });
        const rest = groupAll(gid), act = rest.filter(live).sort((a, b) => a.created - b.created);
        if (act.length >= 2) { act[0].isMaster = true; logItem(act[0].id, 'merge', 'Became master (first captured)'); } else rest.forEach(x => { x.groupId = null; x.isMaster = false; });
        commit('Deleted (struck through)'); }});
    return;
  }
  ask('Delete this item?', `“${esc(i.text)}” will be struck through and moved to the bottom. You can restore it.`, 'Delete', () => { strike(i); commit('Struck through'); }, true);
}

const dirty = new Set();
function queueMail(list){ list.forEach(x => { const p = person(x.d.pid); p.pend = p.pend || []; p.pend.push({kind: x.kind, id: x.i.id, prev: x.prev || null, at: (x.d.sched || x.d.planned || {}).at || null}); dirty.add(p.id); }); save(); }
const isoWeek = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7); const w1 = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - w1) / DAY - 3 + (w1.getDay() + 6) % 7) / 7); };
const runWeeks = (from, to) => Math.max(1, Math.ceil((to - from) / (7 * DAY)));
function digestRows(p){
  const pend = p.pend || [], mark = id => { const e = pend.filter(x => x.id === id); if (e.some(x => x.kind === 'new')) return ' (new)'; const m = e.find(x => x.kind === 'moved'); return m ? (m.prev ? ` (moved from ${fmtD(m.prev)})` : ' (new date)') : ''; };
  const open = [], done = [], gone = [], keep = 28 * DAY;
  tops().filter(live).forEach(i => i.delegates.forEach(d => { if (d.pid !== p.id) return;
    const at = (d.sched || d.planned || {}).at;
    if (d.status === 'Done') { if (now() - d.doneAt < keep) done.push({w: isoWeek(d.assignedAt), task: i.text, expl: i.expl, rs: d.reschedules, run: runWeeks(d.assignedAt, d.doneAt), st: `Done ${fmtD(d.doneAt)}`, sort: d.doneAt}); }
    else open.push({w: isoWeek(d.assignedAt), task: i.text, expl: i.expl, rs: d.reschedules, run: runWeeks(d.assignedAt, now()),
      st: (at ? (dOverdue(d) ? `Overdue, was due ${fmtD(at)}` : `${d.status === 'Rescheduled' ? 'Rescheduled, due' : 'Due'} ${fmtD(at)}`) : 'Date to be set') + mark(i.id), sort: at || 0, over: dOverdue(d)}); }));
  (S.closedDeleg || []).filter(c => c.pid === p.id && now() - c.closedAt < keep).forEach(c => gone.push({w: isoWeek(c.assignedAt), task: c.text, expl: c.expl, rs: c.reschedules, run: runWeeks(c.assignedAt, c.closedAt), st: 'No longer needed', sort: c.closedAt, gone: true}));
  open.sort((x, y) => x.sort - y.sort); done.sort((x, y) => y.sort - x.sort); gone.sort((x, y) => y.sort - x.sort);
  return open.concat(done.map(r => Object.assign(r, {done: true})), gone);
}
function digestTable(rows){
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #1D2A2E;font-size:12px"', td = 'style="padding:6px 8px;border-bottom:1px solid #E3DDD0;vertical-align:top;font-size:12.5px"';
  return `<table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #E3DDD0;border-radius:0;font-size:12.5px"><thead><tr><th ${th}>Week delegated</th><th ${th}>Task</th><th ${th}>Explanation</th><th ${th}>Reschedules</th><th ${th}>Running weeks</th><th ${th}>Status</th></tr></thead><tbody>
    ${rows.map(r => `<tr style="${r.done ? 'color:#3B7448' : r.gone ? 'color:#9AA3A6;text-decoration:line-through' : ''}"><td ${td}>W${r.w}</td><td ${td}><b>${esc(r.task)}</b></td><td ${td}>${esc(r.expl || '-')}</td><td ${td}>${r.rs}</td><td ${td}>${r.run}</td><td ${td}${r.over ? ' style="padding:6px 8px;border-bottom:1px solid #E3DDD0;color:#B8432B;font-weight:600"' : ''}>${esc(r.st)}</td></tr>`).join('') || `<tr><td ${td} colspan="6">Nothing open right now.</td></tr>`}</tbody></table>`;
}
function flushMail(){
  if (C.stage < 3) { dirty.clear(); return false; }
  if (modalOpen() || !dirty.size) return false;
  const pid = [...dirty][0]; dirty.delete(pid);
  const p = person(pid);
  if (!p.email) { p.pend = []; save(); toast(`${p.name} has no email address, so no email was sent.`); setTimeout(flushMail, 0); return true; }
  const subj = () => `Tasks delegated to ${p.name} by ${S.userName || '(your name)'}`;
  const ov = modal({title: `Update ${p.name}'s email?`, ok: 'Send', cancel: 'Not now', wide: true,
    body: `<p class="note">From your Gmail · to ${esc(p.email)} · ${p.threadStarted ? 'reply in the existing thread' : 'starts the thread; every later update replies in it'}${navigator.onLine === false ? ' · offline: sends when back online' : ''}</p>
      ${S.userName ? '' : '<div class="f"><label>Your name, as it should appear (asked once)</label><input type="text" id="m-un" placeholder="Your name"></div>'}
      <div class="f"><label>Subject (fixed)</label><div id="m-subj" style="font-weight:600">${esc(subj())}</div></div>
      <div class="f"><label>Opening line (editable)</label><textarea id="m-eb" style="min-height:60px">Hi ${esc(p.name)},\n\nHere is the current list of tasks I've delegated to you.</textarea></div>
      <div style="overflow-x:auto;margin-top:10px">${digestTable(digestRows(p))}</div>
      <p class="note" style="margin-top:8px">Open tasks first (earliest due date on top), then done, then no longer needed. Done and removed rows stay in the table for 4 weeks. “Not now” keeps the changes for the next update. Prototype: nothing is really sent.</p>`,
    onOk: o => { const un = o.querySelector('#m-un'); if (un) { if (!un.value.trim()) { toast('Add your name for the subject line'); return false; } S.userName = un.value.trim(); }
      p.pend = []; p.threadStarted = true; logPerson(p.id, '', 'emailed task list'); save(); toast(`${p.name}'s task list sent (simulated)`); },
    onCancel: () => toast(`Kept for ${p.name}'s next update`)});
  const un = ov.querySelector('#m-un'); if (un) un.addEventListener('input', () => ov.querySelector('#m-subj').textContent = `Tasks delegated to ${p.name} by ${un.value.trim() || '(your name)'}`);
  return true;
}
function delegateModal(i){
  const today = isoDay(now() + 2 * DAY);
  const ov = modal({title: 'Delegate', ok: 'Save', wide: true,
    body: `<p>Pick each person and the date it must be done by. A task “Follow up with …” goes on your calendar for that date, and the person gets an email if their address is on file. Not an edit; you can change this even while it's scheduled.</p>
      ${!i.bucket ? '<p class="note">This item isn\'t in a bucket yet: the tasks are added to Google when it moves into one.</p>' : ''}
      ${needsProc(i) ? procField(i) : ''}
      ${S.people.map(p => { const x = i.delegates.find(y => y.pid === p.id); if (!p.active && !x) return '';
        const v = x ? isoDay((x.sched || x.planned || {at: now() + 2 * DAY}).at) : today;
        return `<div class="opt" style="align-items:center"><input type="checkbox" class="m-dp" value="${p.id}" ${x ? 'checked' : ''}><div style="flex:1">${esc(p.name)}${p.active ? '' : ' <span class="b warn">inactive</span>'}<div class="note">${p.email ? esc(p.email) : 'no email on file'}</div></div>
          <input type="date" class="m-dd" data-p="${p.id}" value="${v}" style="max-width:160px" ${x && x.status === 'Done' ? 'disabled' : ''}></div>`; }).join('')}
      <div class="f"><label>…or add someone new</label><div class="row2"><input type="text" id="m-np" placeholder="Name"><input type="text" id="m-ne" placeholder="Email (optional)"></div>
        <input type="date" id="m-nd" value="${today}" style="margin-top:8px"></div>`,
    onOk: o => {
      const want = {};
      o.querySelectorAll('.m-dp:checked').forEach(c => want[c.value] = o.querySelector(`.m-dd[data-p="${c.value}"]`).value);
      const nn = o.querySelector('#m-np').value.trim();
      if (nn) { const p = {id: uid('p'), name: nn, phone: '', email: o.querySelector('#m-ne').value.trim(), active: true}; S.people.push(p); want[p.id] = o.querySelector('#m-nd').value; }
      if (Object.values(want).some(v => !v)) { toast('Each person needs a date'); return false; }
      if (Object.keys(want).length && !applyProc(i, o)) { toast('Choose Personal, or Work and a process'); return false; }
      const mails = [];
      i.delegates.filter(x => !(x.pid in want)).forEach(x => { logPerson(x.pid, i.id, 'removed'); if (x.status !== 'Done') { S.closedDeleg = S.closedDeleg || []; S.closedDeleg.push({pid: x.pid, id: i.id, text: i.text, expl: i.expl, assignedAt: x.assignedAt || now(), reschedules: x.reschedules, closedAt: now()}); mails.push({i, d: x, kind: 'removed'}); } });
      i.delegates.filter(x => !(x.pid in want)).forEach(x => gForget(x.sched, 'task'));
      i.delegates = i.delegates.filter(x => x.pid in want);
      Object.entries(want).forEach(([pid, v]) => {
        const at = parseDay(v); let x = i.delegates.find(y => y.pid === pid);
        if (!x) { x = deleg(pid); i.delegates.push(x); logPerson(pid, i.id, 'assigned'); placeDeleg(i, x, at); mails.push({i, d: x, kind: 'new'}); }
        else if (x.status !== 'Done') { const cur = (x.sched || x.planned || {}).at; if (!cur || isoDay(cur) !== v) { const prev = cur; if (x.sched) { snapUndo(i, x); x.schedCount++; x.reschedules++; x.sched.at = at; x.status = 'Rescheduled'; } else placeDeleg(i, x, at); mails.push({i, d: x, kind: 'moved', prev}); } }
      });
      commit(i.delegates.length ? `Delegated to ${i.delegates.map(x => person(x.pid).name).join(', ')}` : 'No longer delegated');
      queueMail(mails); setTimeout(flushMail, 0);
    }});
  return ov;
}
function placeDeleg(i, x, at){
  if (i.bucket) { countSchedule(x); x.sched = {at}; x.planned = null; x.status = x.schedCount > 1 ? 'Rescheduled' : 'Due'; }
  else { x.planned = {at}; x.status = null; }
}

/* ---------- actions ---------- */
const D = d => get(d.id), DP = d => { const i = get(d.id); return [i, i.delegates.find(x => x.pid === d.p)]; };
const A = {
  nav: d => { view = d.v; openBucket = null; panelId = null; sel.clear(); filter = 'all'; render(); try { window.scrollTo(0, 0); } catch (e) {} },
  clock: d => { askedPast.clear(); S.clock = +d.d ? S.clock + d.d * DAY : 0; commit(+d.d ? `Clock moved ${d.d} day${d.d == 1 ? '' : 's'} ahead` : 'Clock reset'); },
  reset: () => ask('Reload sample data?', 'This replaces everything in this prototype with the sample items.', 'Reload', () => { seed(); sel.clear(); askedPast.clear(); view = 'dump'; commit('Sample data loaded'); }, true),
  acct: () => modal({title: 'Settings', ok: 'Save', body: `<div class="f"><label>Your name (used in “Tasks delegated to … by …”)</label><input type="text" id="m-un" value="${esc(S.userName || '')}"></div><div class="f"><label>Gmail account for “Find in Gmail” (0 is the first account signed in)</label><input type="number" id="m-a" min="0" max="9" value="${S.gmailAcct || 0}"></div>`,
    onOk: o => { S.userName = o.querySelector('#m-un').value.trim(); S.gmailAcct = Math.max(0, +o.querySelector('#m-a').value || 0); commit('Saved'); }}),
  filter: d => { filter = d.f; render(); },
  period: d => { period = d.p; render(); },
  dfper: d => { doneFilter.period = d.p; render(); },
  sel: d => { sel.has(d.id) ? sel.delete(d.id) : sel.add(d.id); render(); },
  clearsel: () => { sel.clear(); render(); },
  more: d => { moreOpen.has(d.id) ? moreOpen.delete(d.id) : moreOpen.add(d.id); render(); },
  expand: d => { expanded.has(d.id) ? expanded.delete(d.id) : expanded.add(d.id); render(); },
  history: d => { const i = D(d), l = S.itemLog.filter(x => x.id === d.id).map(x => ({t: x.t, k: x.kind, v: x.detail})).concat(S.notes.filter(n => n.id === d.id).map(n => ({t: n.t, k: 'note', v: n.text}))).sort((a, b) => b.t - a.t);
    modal({title: 'Item history', cancel: null, ok: 'Close', body: `<p><b>${esc(i.text)}</b></p>${l.map(x => `<div class="opt"><div><div class="note">${fmt(x.t)} · ${esc(x.k)}</div>${esc(x.v)}</div></div>`).join('') || '<p>Nothing recorded.</p>'}`}); },
  add: () => { const text = $('#cap').value.trim(), expl = $('#capx').value.trim();
    if (!text && !pending.length) return toast('Type something, or add a photo, voice note or email');
    S.items.push(base({text: text || (pending[0].type === 'photo' ? 'Photo' : 'Voice note'), expl, atts: pending})); pending = []; commit('Added to the brain dump'); },
  capvoice: () => { const k = [$('#cap').value, $('#capx').value]; pending.push(simVoice()); render(); $('#cap').value = k[0]; $('#capx').value = k[1]; toast('Voice note attached (simulated)'); },
  capemail: emailModal,
  edit: d => editModal(D(d)),
  sched: d => scheduleModal(D(d)),
  unsched: d => { const i = D(d); unscheduleOwn(i); commit(bucket(i.bucket)?.deleting ? 'Unscheduled (won\'t count as a reschedule)' : 'Unscheduled: removed from Google, back in its bucket'); },
  gmove: d => moveInGoogleModal(D(d)),
  gdel: d => { unscheduleOwn(D(d)); commit('Sync: deleted in Google, so the item is unscheduled'); },
  owndone: d => { const i = D(d); commit(markOwnDone(i)); },
  stoprep: d => { const i = D(d); ask('Stop repeating?', 'No more tasks are created and the item moves to Done.', 'Stop repeating', () => { i.sched.repeat = 'none'; i.ownDone = true; commit(completeIfReady(i)); }); },
  untick: d => { const i = D(d); reopen(i); commit('Sync: unticked in Google, so the item is reopened'); },
  reopen: d => { const i = D(d); reopen(i); commit('Reopened: back in its bucket, unscheduled'); },
  dsched: d => { const [i, x] = DP(d); scheduleDelModal(i, x); },
  dunsched: d => { const [i, x] = DP(d); unscheduleDel(i, x); commit('Follow-up removed from Google'); },
  dmove: d => { const [i, x] = DP(d); scheduleDelModal(i, x, true); },
  dgdel: d => { const [i, x] = DP(d); unscheduleDel(i, x); commit('Sync: deleted in Google, so the follow-up is unscheduled'); },
  ddone: d => { const [i, x] = DP(d); commit(markDelDone(i, x)); },
  urgent: d => { const i = D(d); i.urgent = !i.urgent; commit(i.urgent ? 'Marked urgent (stays until done)' : 'Urgent removed'); },
  process: d => { const i = D(d); modal({title: 'Personal or work', ok: 'Save', body: `<p>Not an edit. If it changes, its items and hours move with it.</p>${procField(i)}`, onOk: o => { if (!applyProc(i, o)) { toast('Choose Personal, or Work and a process'); return false; } commit(i.personal ? 'Marked personal' : `Work · ${proc(i.process).name}`); }}); },
  delegate: d => delegateModal(D(d)),
  place: d => { const i = D(d);
    modal({title: 'Place label', ok: 'Save', body: `<div class="f"><select id="m-l"><option value="">No place</option>${S.places.map(l => `<option value="${l.id}" ${l.id === i.place ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div><div class="f"><label>…or add a new place</label><input type="text" id="m-nl" placeholder="e.g. London"></div>`,
      onOk: o => { let lid = o.querySelector('#m-l').value; const nn = o.querySelector('#m-nl').value.trim(); if (nn) { const l = {id: uid('l'), name: nn}; S.places.push(l); lid = l.id; } i.place = lid || null; commit('Place updated'); }}); },
  confirm: d => { D(d).oldName = null; commit('Confirmed'); },
  confirmall: d => { tops().filter(i => i.bucket === d.id && i.oldName).forEach(i => i.oldName = null); commit('All confirmed'); },
  bulkconfirm: () => { let n = 0; [...sel].map(get).forEach(i => { if (i && i.oldName) { i.oldName = null; n++; } }); sel.clear(); commit(`${n} confirmed`); },
  unmerge: d => { const m = D(d), all = groupAll(m.groupId);
    ask('Unmerge?', `${all.length} items become separate again${m.bucket ? ', staying in ' + esc(bname(m.bucket)) : ''}. Every item's reschedule counter resets to 0.`, 'Unmerge', () => {
      all.forEach(x => { x.groupId = null; x.isMaster = false; resetCounters(x); }); logItem(m.id, 'merge', `Unmerged: ${all.map(x => '"' + x.text + '"').join(', ')}`); commit('Unmerged'); }); },
  master: d => { const m = D(d), ms = groupMembers(m.groupId).filter(live);
    modal({title: 'Change master', ok: 'Change', body: ms.map(x => `<label class="opt"><input type="radio" name="nm" value="${x.id}"><div>${esc(x.text)}</div></label>`).join(''),
      onOk: o => { const c = o.querySelector('input[name=nm]:checked'); if (!c) return false; const n = get(c.value);
        m.isMaster = false; n.isMaster = true; n.edited = true; logItem(n.id, 'edit', `Master changed from "${m.text}" to "${n.text}"`); save(); render(); toast('Master changed (logged as an edit)'); setTimeout(() => afterEditPrompt(n), 0); }}); },
  del: d => deleteTop(D(d)),
  delmember: d => { const x = D(d); ask('Delete this merged item?', `“${esc(x.text)}” is struck through inside the group.`, 'Delete', () => { strike(x); commit('Struck through'); }, true); },
  restore: d => { const i = D(d); i.status = 'active'; i.struckAt = null; commit('Restored'); },
  perm: d => { const i = D(d); ask('Delete for good?', `“${esc(i.text)}” moves to the Deleted section for 60 days, then it is gone.`, 'Delete for good', () => {
    i.status = 'deleted'; i.deletedAt = now(); i.groupId = null; i.isMaster = false; logItem(i.id, 'delete', `"${i.text}" sent to the Deleted section`); commit('Moved to Deleted (60 days)'); }, true); },
  undelete: d => { Object.assign(D(d), {status: 'active', deletedAt: null, struckAt: null, bucket: null, groupId: null, isMaster: false, sched: null}); commit('Restored as an unbucketed item'); },
  delnow: d => { const i = D(d); ask('Delete now?', 'This cannot be undone.', 'Delete now', () => { S.items = S.items.filter(x => x !== i); logItem(i.id, 'delete', `"${i.text}" removed for good`); commit('Removed for good'); }, true); },
  emptyd: () => ask('Empty the Deleted section?', 'Everything in it is removed for good. This cannot be undone.', 'Empty now', () => {
    S.items.filter(x => x.status === 'deleted').forEach(x => logItem(x.id, 'delete', `"${x.text}" removed for good`)); S.items = S.items.filter(x => x.status !== 'deleted'); commit('Emptied'); }, true),
  merge: mergeFlow,
  bulkdump: () => { const m = moveItems([...sel], null); sel.clear(); commit(m); },
  bulkurgent: () => { let n = 0; [...sel].map(get).forEach(i => { if (i) { i.urgent = true; n++; } }); sel.clear(); commit(`${n} marked urgent`); },
  bulkdel: () => { const its = [...sel].map(get).filter(Boolean), ok = its.filter(i => !i.bucket && !locked(i) && !i.isMaster), skip = its.length - ok.length;
    if (!ok.length) return toast('Only unbucketed, unmerged, unscheduled items can be bulk-deleted');
    ask(`Delete ${ok.length} item${ok.length === 1 ? '' : 's'}?`, `They'll be struck through and can be restored.${skip ? ` ${skip} other${skip === 1 ? ' is' : 's are'} skipped.` : ''}`, 'Delete', () => { ok.forEach(strike); sel.clear(); commit('Struck through'); }, true); },
  addbucket: () => modal({title: 'New bucket', ok: 'Add', body: '<div class="f"><input type="text" id="m-b" placeholder="Name"></div>', onOk: o => { const n = o.querySelector('#m-b').value.trim(); if (!n) return false; S.buckets.push({id: uid('b'), name: n}); logBucket(`Bucket "${n}" added`); commit('Bucket added'); }}),
  openb: d => { view = 'buckets'; openBucket = d.id; panelId = null; sel.clear(); render(); try { window.scrollTo(0, 0); } catch (e) {} },
  backb: () => { openBucket = null; view = 'board'; sel.clear(); render(); },
  renameb: d => { const b = bucket(d.id), unc = tops().filter(i => i.bucket === b.id && i.oldName && open_(i)).length;
    modal({title: 'Rename bucket', ok: unc ? 'Rename anyway' : 'Rename', body: `${unc ? `<div class="banner warn">${unc} item${unc === 1 ? ' is' : 's are'} still unconfirmed from an earlier rename. Their tag will keep the last name you confirmed.</div>` : ''}
      <p>Items in it get an “Old name: ${esc(b.name)}” tag until you confirm them.</p><div class="f"><input type="text" id="m-b" value="${esc(b.name)}"></div>`,
      onOk: o => { const n = o.querySelector('#m-b').value.trim(); if (!n || n === b.name) return; tops().filter(i => i.bucket === b.id && open_(i) && !i.oldName).forEach(i => i.oldName = b.name); logBucket(`"${b.name}" renamed "${n}"`); b.name = n; commit('Renamed'); }}); },
  deleteb: d => { const b = bucket(d.id), n = tops().filter(i => i.bucket === b.id && live(i)).length;
    if (!n) return ask('Delete bucket?', `“${esc(b.name)}” is empty and will be deleted.`, 'Delete bucket', () => { S.buckets = S.buckets.filter(x => x !== b); logBucket(`Bucket "${b.name}" deleted (it was empty)`); openBucket = null; commit('Bucket deleted'); }, true);
    ask('Empty it first', `A bucket can only be deleted when it's empty. Move its ${n} item${n === 1 ? '' : 's'} (done items included) to other buckets or the brain dump; scheduled ones must be unscheduled first. Start emptying?`, 'Start emptying', () => { b.deleting = true; commit(); }); },
  canceldel: d => { bucket(d.id).deleting = false; commit(); },
  renamep: d => { const p = person(d.id); modal({title: 'Edit person', ok: 'Save', body: `<div class="f"><label>Name</label><input type="text" id="m-n" value="${esc(p.name)}"></div><div class="f"><label>Email (optional; used to tell them about delegated tasks)</label><input type="text" id="m-e" value="${esc(p.email || '')}"></div>`, onOk: o => { const n = o.querySelector('#m-n').value.trim(); if (n) { p.name = n; p.email = o.querySelector('#m-e').value.trim(); commit('Saved'); } }}); },
  togglep: d => { const p = person(d.id); p.active = !p.active; commit(p.active ? `${p.name} is active again` : `${p.name} is inactive. Their open follow-ups show a warning.`); },
  addp: () => { const n = $('#newp').value.trim(); if (n) { S.people.push({id: uid('p'), name: n, phone: '', email: $('#newpe').value.trim(), active: true}); commit('Person added'); } },
  renamer: d => { const r = proc(d.id); modal({title: 'Rename process', ok: 'Rename', body: `<div class="f"><input type="text" id="m-n" value="${esc(r.name)}"></div>`, onOk: o => { const n = o.querySelector('#m-n').value.trim(); if (n) { r.name = n; commit('Renamed'); } }}); },
  toggler: d => { const r = proc(d.id); r.active = !r.active; commit(r.active ? 'Process active' : 'Process inactive: it can no longer be chosen for new items'); },
  addr: () => { const n = $('#newr').value.trim(); if (n) { S.processes.push({id: uid('r'), name: n, active: true}); commit('Process added'); } },
  renamel: d => { const l = place(d.id); modal({title: 'Rename place', ok: 'Rename', body: `<div class="f"><input type="text" id="m-n" value="${esc(l.name)}"></div>`, onOk: o => { const n = o.querySelector('#m-n').value.trim(); if (n) { l.name = n; commit('Renamed'); } }}); },
  addl: () => { const n = $('#newl').value.trim(); if (n) { S.places.push({id: uid('l'), name: n}); commit('Place added'); } },
  logtab: d => { logTab = d.t; render(); }
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type === 'file') || t.closest('#ov')) return;
  const f = A[t.dataset.act]; if (f) { e.preventDefault(); f(t.dataset); }
});
document.addEventListener('change', async e => {
  const t = e.target, a = t.dataset.act;
  if (a === 'move' && t.value) commit(moveItems([t.dataset.id], t.value === '__dump' ? null : t.value));
  else if (a === 'bulkmove' && t.value) { const m = moveItems([...sel], t.value); sel.clear(); commit(m); }
  else if (a === 'dfproc') { doneFilter.proc = t.value; render(); }
  else if (a === 'capfile') { const k = [$('#cap').value, $('#capx').value]; for (const f of t.files) { const x = await readFile(f); if (x) pending.push(x); } render(); $('#cap').value = k[0]; $('#capx').value = k[1]; }
});
/* ================= Stage 1: sync with Google Drive ================= */
const LOGS = ['itemLog', 'bucketLog', 'personLog', 'notes', 'doneLog', 'closedDeleg'];
const COLLS = ['items', 'buckets', 'people', 'places', 'processes'];
const SETTINGS = ['gmailAcct', 'userName', 'font', 'eaMode', 'eaEmail', 'holidays'];
const lget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const lset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
function queueSync(){ clearTimeout(syncTimer); if (window.GID && GID.signedIn) { syncState = 'pending'; syncTimer = setTimeout(syncNow, 2500); } else syncState = 'local'; }
function mergeDocs(L, R, B){
  B = B || {}; const out = Object.assign({}, L), confl = [];
  COLLS.forEach(k => {
    const lm = new Map((L[k] || []).map(x => [x.id, x])), rm = new Map((R[k] || []).map(x => [x.id, x])), bm = new Map((B[k] || []).map(x => [x.id, x]));
    const ids = new Set([...lm.keys(), ...rm.keys()]), res = [];
    ids.forEach(id => {
      const l = lm.get(id), r = rm.get(id), b = bm.get(id), J = JSON.stringify;
      if (l && !r) { if (b && J(l) === J(b)) return; res.push(l); return; }       // removed on the other device
      if (r && !l) { if (b && J(r) === J(b)) return; res.push(r); return; }       // removed here, or new there
      if (J(l) === J(r)) { res.push(l); return; }
      if (b && J(l) === J(b)) { res.push(r); return; }
      if (b && J(r) === J(b)) { res.push(l); return; }
      res.push(l); if (k === 'items') confl.push({id, remote: r, t: Date.now()}); // changed on both devices
    });
    out[k] = res;
  });
  LOGS.forEach(k => { const seen = new Set(), all = []; [...(L[k] || []), ...(R[k] || [])].forEach(x => { const j = JSON.stringify(x); if (!seen.has(j)) { seen.add(j); all.push(x); } });
    all.sort((a, b) => k === 'doneLog' || k === 'closedDeleg' ? (a.t || a.closedAt || 0) - (b.t || b.closedAt || 0) : (b.t || 0) - (a.t || 0)); out[k] = all; });
  const sl = JSON.stringify(SETTINGS.map(k => L[k])), sb = JSON.stringify(SETTINGS.map(k => B[k]));
  if (sl === sb) SETTINGS.forEach(k => { if (k in R) out[k] = R[k]; });
  out.seq = Math.max(L.seq || 1, R.seq || 1);
  return {doc: out, conflicts: confl};
}
async function syncNow(){
  if (syncing || !window.GID || !GID.signedIn || !navigator.onLine) { if (!navigator.onLine) syncState = 'offline'; renderSide(); return; }
  syncing = true; syncState = 'syncing'; renderSide();
  try {
    const meta = lget(METAKEY) || {}; let f = await GID.findFile(); let doc = S;
    if (f && f.version !== meta.version) {
      const remote = await GID.readFile(f.id), baseDoc = lget(BASEKEY);
      if (!baseDoc && !S.items.length) { doc = Object.assign({}, remote, {ui: S.ui}); }
      else { const m = mergeDocs(S, remote, baseDoc || {}); doc = m.doc;
      if (m.conflicts.length) { m.conflicts.forEach(c => { if (!hasConflict(c.id)) conflicts.push(c); }); lset(CONFKEY, conflicts); } }
    }
    S = doc; await googleRound(); doc = S;
    const mine = JSON.stringify(doc);
    if (!f || mine !== JSON.stringify(lget(BASEKEY))) f = await GID.writeFile(f && f.id, doc);
    S = doc; try { localStorage.setItem(KEY, mine); } catch (e) {}
    lset(BASEKEY, doc); lset(METAKEY, {id: f.id, version: f.version});
    lastSyncAt = Date.now(); syncState = 'synced';
  } catch (e) { syncState = navigator.onLine ? 'error' : 'offline'; console.warn('sync', e); }
  syncing = false;
  if (document.activeElement && document.activeElement !== document.body && ($('#main').contains(document.activeElement) || $('#ov').contains(document.activeElement))) renderSide(); else render();
}
function conflictBanner(){
  if (!conflicts.length) return '';
  return `<div class="banner warn">${conflicts.length} item${conflicts.length === 1 ? ' was' : 's were'} changed on two devices before they synced. ${conflicts.length === 1 ? 'It is' : 'They are'} locked until you choose a version.<span class="spacer"></span><button class="btn sm" data-act="resolve">Resolve</button></div>`;
}
function resolveModal(){
  const c = conflicts[0]; if (!c) return; const l = get(c.id), r = c.remote;
  const side = (x, t) => `<div class="panel" style="padding:12px"><div class="note">${t}</div><b>${esc(x ? x.text : '(deleted)')}</b><div class="note">${esc(x ? x.expl : '')}</div></div>`;
  modal.alts = {alt1: () => { const k = S.items.findIndex(x => x.id === c.id); if (k >= 0) S.items[k] = r; else S.items.push(r); conflicts.shift(); lset(CONFKEY, conflicts); logItem(c.id, 'edit', 'Conflict resolved: kept the other device\'s version'); commit('Kept the other device\'s version'); }};
  modal({title: 'Changed on two devices', ok: 'Keep this device\'s', extra: '<button class="btn" data-m="alt1">Keep the other device\'s</button>', wide: true,
    body: `<p>Pick the version to keep. The other one is noted in the item's history.</p><div class="two">${side(l, 'This device')}${side(r, 'Other device')}</div>`,
    onOk: () => { conflicts.shift(); lset(CONFKEY, conflicts); if (l) { logItem(c.id, 'edit', `Conflict resolved: kept this device's version (other had "${r.text}")`); } commit('Kept this device\'s version'); }});
}

/* ================= Board (swimlanes) ================= */
const ICON = {
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/>', done: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  event: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', appt: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>', photo: '<rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="3.5"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', text: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  deleg: '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6M15 14l4 3-4 3M13 17h6"/>', repeat: '<path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>'
};
const ic = (k, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
const kindOf = i => i.atts.some(a => a.type === 'email') ? 'mail' : i.atts.some(a => a.type === 'photo') ? 'photo' : i.atts.some(a => a.type === 'voice') ? 'voice' : 'text';
function mchip(i, o = {}){
  const done = o.done, k = o.kind || kindOf(i);
  return `<button type="button" class="mchip ${done ? 'is-done' : ''} ${o.over ? 'is-over' : ''}" data-act="open" data-id="${i.id}">
    <span class="mrow">${ic(done ? 'done' : k)}<span class="mt">${esc(o.label || i.text)}</span>${i.urgent && !done ? '<span class="udot" title="Urgent"></span>' : ''}${flagged(i) ? ic('flag', 'fl') : ''}${o.rep ? ic('repeat') : ''}</span>
    ${o.meta ? `<span class="mm">${esc(o.meta)}</span>` : ''}${o.tag ? `<span class="mtag">${esc(o.tag)}</span>` : ''}</button>`;
}
const monday = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return +d; };
function weekList(){ const n = S.ui.weeks || 6, start = monday(now()) + ((S.ui.offset || 0) - 1) * 7 * DAY; return Array.from({length: n}, (_, k) => start + k * 7 * DAY); }
const tfmt = t => new Date(t).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
const dshort = t => new Date(t).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'});
function entriesIn(from, to, bucketId){
  const out = [];
  tops().filter(live).forEach(i => {
    if (bucketId !== undefined && i.bucket !== bucketId) return;
    const s = i.sched;
    if (s) {
      let t = s.at, g = 0;
      if (s.repeat !== 'none' && !i.done) { while (t < from && g++ < 800) t = nextOcc(t, s.repeat); }
      for (; t < to && g++ < 900; t = nextOcc(t, s.repeat)) {
        if (t >= from) out.push({t, i, kind: s.type, done: !!i.done || (i.ownDone && !i.done), rep: s.repeat !== 'none',
          meta: s.type === 'task' ? dshort(t) : `${dshort(t)} ${tfmt(t)}${s.loc ? ' · ' + s.loc : ''}`});
        if (s.repeat === 'none' || i.done) break;
      }
    }
    i.delegates.forEach(d => { const at = (d.sched || {}).at; if (at && at >= from && at < to) out.push({t: at, i, kind: 'deleg', done: d.status === 'Done', over: dOverdue(d),
      label: `${person(d.pid).name}: ${i.text}`, meta: dOverdue(d) ? `Overdue · ${dshort(at)}` : `Due ${dshort(at)}`}); });
  });
  return out.sort((a, b) => a.t - b.t);
}
function railHtml(){
  const T = tops().filter(i => open_(i) && !i.bucket), u = T.filter(i => i.urgent), n = T.filter(i => !i.urgent);
  const sec = (t, arr, cls) => `<section class="rail"><div class="rail-h ${cls}"><h2>${t}</h2><b>${arr.length}</b></div>${arr.map(i => mchip(i, {meta: i.expl.trim() ? '' : 'Needs explanation'})).join('') || '<span class="empty-s">Nothing here</span>'}</section>`;
  return `<div class="rails" role="region" aria-label="Unbucketed">${sec('Unbucketed · urgent', u, 'u')}${sec('Unbucketed', n, '')}</div>`;
}
function vBoard(){
  if (window.matchMedia('(max-width: 820px)').matches) return vBoardMobile();
  const W = weekList(), cur = monday(now());
  const cols = `grid-template-columns: 280px repeat(${W.length}, minmax(128px, 1fr))`;
  let lastMonth = -1;
  const head = `<div class="lane lane-h" style="${cols}"><div class="wk-ctl">
      <button type="button" class="ibtn" data-act="wk" data-d="-1" aria-label="Earlier weeks">‹</button><button type="button" class="btn" data-act="wk" data-d="0">This week</button><button type="button" class="ibtn" data-act="wk" data-d="1" aria-label="Later weeks">›</button>
      <label class="note">Show <select data-act="weeks">${[4, 6, 13].map(n => `<option value="${n}" ${S.ui.weeks === n ? 'selected' : ''}>${n === 13 ? 'Quarter' : n + ' weeks'}</option>`).join('')}</select></label></div>
    ${W.map(w => { const d = new Date(w), m = d.getMonth(), show = m !== lastMonth; lastMonth = m; const e = new Date(w + 6 * DAY);
      return `<div class="wk-h ${w === cur ? 'cur' : ''}"><span class="mo">${show ? d.toLocaleDateString(undefined, {month: 'short', year: m === 0 || W[0] === w ? 'numeric' : undefined}) : '&#160;'}</span><b>W${isoWeek(w)}${w === cur ? ' · this week' : ''}</b><span class="note">${d.getDate()}–${e.getDate()}</span></div>`; }).join('')}</div>`;
  const OB = orderedBuckets();
  const lanes = OB.map((b, bi) => {
    const its = tops().filter(i => open_(i) && i.bucket === b.id && !locked(i)), u = its.filter(i => i.urgent), n = its.filter(i => !i.urgent), tray = u.concat(n);
    const exp = expanded.has('tray-' + b.id), shown = exp ? tray : tray.slice(0, 3);
    const mine = (S.ui.bsort || 'mine') === 'mine';
    return `<section class="lane" style="${cols}" aria-label="${esc(b.name)}" data-bdrag="${b.id}" draggable="${mine ? 'true' : 'false'}"><div class="tray"><div class="tray-h"><h3>${mine ? '<span class="grip" title="Drag to move" aria-hidden="true">⠿</span>' : ''}<a href="#" data-act="openb" data-id="${b.id}">${esc(b.name)}</a>${mine ? `<span class="bord"><button type="button" class="tiny" data-act="bup" data-id="${b.id}" aria-label="Move ${esc(b.name)} up" ${bi === 0 ? 'disabled' : ''}>▲</button><button type="button" class="tiny" data-act="bdown" data-id="${b.id}" aria-label="Move ${esc(b.name)} down" ${bi === OB.length - 1 ? 'disabled' : ''}>▼</button></span>` : ''}</h3><span>${u.length ? `<span class="ub">${u.length} urgent</span> ` : ''}<span class="note">${tray.length} to schedule</span></span></div>
      ${shown.map(i => mchip(i, {meta: waiting(i) ? 'Waiting 2+ weeks' : (b.loc && i.place ? place(i.place).name : '')})).join('') || '<span class="empty-s">Nothing waiting</span>'}
      ${tray.length > 3 ? `<a href="#" class="more" data-act="expand" data-id="tray-${b.id}">${exp ? 'Show less' : '+' + (tray.length - 3) + ' more'}</a>` : ''}</div>
      ${W.map(w => `<div class="cell ${w === cur ? 'cur' : w < cur ? 'past' : ''}">${entriesIn(w, w + 7 * DAY, b.id).map(e => mchip(e.i, {kind: e.kind, done: e.done, over: e.over, rep: e.rep, meta: e.meta, label: e.label})).join('')}</div>`).join('')}</section>`;
  }).join('');
  return `${captureBar()}<div class="board-top"><div class="bt-l"><h1>Buckets by week</h1><button type="button" class="btn sm" data-act="addbucket">+ New bucket</button><label class="note">Order <select data-act="bsort">${[['mine', 'My order'], ['az', 'A to Z'], ['waiting', 'Most to schedule'], ['urgent', 'Most urgent']].map(([v, l]) => `<option value="${v}" ${(S.ui.bsort || 'mine') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div><div class="legend">${ic('task')}Task ${ic('event')}Event ${ic('appt')}Appointment ${ic('deleg')}Delegated ${ic('done')}Done <span class="udot"></span>Urgent</div></div>
  <div class="board-wrap">${railHtml()}<div class="board"><div style="min-width:${280 + 128 * W.length}px">${head}${lanes}</div></div></div>`;
}
function vBoardMobile(){
  const mv = S.ui.mview || 'time';
  const tog = `<div class="seg2" role="group" aria-label="View"><button type="button" class="${mv === 'time' ? 'on' : ''}" data-act="mview" data-v="time">By time</button><button type="button" class="${mv === 'bucket' ? 'on' : ''}" data-act="mview" data-v="bucket">By bucket</button></div>`;
  if (mv === 'time') {
    const rng = S.ui.mrange || 'week', start = rng === 'day' ? new Date(new Date(now()).setHours(0, 0, 0, 0)).getTime() + (S.ui.offset || 0) * DAY : monday(now()) + (S.ui.offset || 0) * 7 * DAY;
    const days = rng === 'day' ? [start] : Array.from({length: 7}, (_, k) => start + k * DAY);
    const bn = i => i.bucket ? bname(i.bucket) : 'Unbucketed';
    return `${captureBar()}${tog}<div class="m-bar"><button type="button" class="ibtn" data-act="wk" data-d="-1" aria-label="Earlier">‹</button><b>${rng === 'day' ? fmtD(start) : 'W' + isoWeek(start) + ' · ' + new Date(start).getDate() + '–' + new Date(start + 6 * DAY).getDate() + ' ' + new Date(start + 6 * DAY).toLocaleDateString(undefined, {month: 'short'})}</b><button type="button" class="ibtn" data-act="wk" data-d="1" aria-label="Later">›</button>
      <span class="spacer"></span><button type="button" class="chip ${rng === 'week' ? 'on' : ''}" data-act="mrange" data-v="week">Week</button><button type="button" class="chip ${rng === 'day' ? 'on' : ''}" data-act="mrange" data-v="day">Day</button></div>
      ${days.map(d => { const es = entriesIn(d, d + DAY), today = d === new Date(new Date(now()).setHours(0, 0, 0, 0)).getTime();
        return `<div class="m-day ${today ? 'cur' : ''}"><div class="m-dh">${fmtD(d)}${today ? ' · today' : ''}</div>${es.map(e => mchip(e.i, {kind: e.kind, done: e.done, over: e.over, rep: e.rep, meta: e.kind === 'task' || e.kind === 'deleg' ? e.meta.replace(/^.*?·\s?/, '') : tfmt(e.t), label: e.label, tag: bn(e.i)})).join('') || '<span class="empty-s">Nothing scheduled</span>'}</div>`; }).join('')}
      ${railHtml()}`;
  }
  const bid = S.ui.mbucket && bucket(S.ui.mbucket) ? S.ui.mbucket : '__unb';
  const tabs = `<nav class="m-tabs" aria-label="Buckets"><button type="button" class="chip ${bid === '__unb' ? 'on' : ''}" data-act="mbucket" data-v="__unb">Unbucketed</button>${orderedBuckets().map(b => `<button type="button" class="chip ${bid === b.id ? 'on' : ''}" data-act="mbucket" data-v="${b.id}">${esc(b.name)}</button>`).join('')}<button type="button" class="chip" data-act="addbucket">+ New bucket</button></nav>`;
  if (bid === '__unb') return captureBar() + tog + tabs + railHtml();
  const its = tops().filter(i => open_(i) && i.bucket === bid && !locked(i)), u = its.filter(i => i.urgent), n = its.filter(i => !i.urgent);
  const W = Array.from({length: 6}, (_, k) => monday(now()) + (k - 1) * 7 * DAY);
  return `${captureBar()}${tog}${tabs}<div class="m-sec"><h2 class="u">Urgent, unscheduled <b>${u.length}</b></h2>${u.map(i => mchip(i)).join('') || '<span class="empty-s">None</span>'}</div>
    <div class="m-sec"><h2>Unscheduled <b>${n.length}</b></h2>${n.map(i => mchip(i)).join('') || '<span class="empty-s">None</span>'}</div>
    <div class="m-sec"><h2>Scheduled &amp; tasks, by week</h2>${W.map(w => `<div class="m-day ${w === monday(now()) ? 'cur' : ''}"><div class="m-dh">W${isoWeek(w)} · ${new Date(w).getDate()}–${new Date(w + 6 * DAY).getDate()} ${new Date(w + 6 * DAY).toLocaleDateString(undefined, {month: 'short'})}</div>${entriesIn(w, w + 7 * DAY, bid).map(e => mchip(e.i, {kind: e.kind, done: e.done, over: e.over, rep: e.rep, meta: e.meta, label: e.label})).join('') || '<span class="empty-s">Nothing scheduled</span>'}</div>`).join('')}</div>`;
}
function renderPanel(){
  const p = $('#panel'); const i = panelId && get(panelId);
  if (!i) { p.classList.remove('on'); p.innerHTML = ''; return; }
  p.classList.add('on');
  p.innerHTML = `<div class="panel-h"><b>Item</b><button type="button" class="ibtn" data-act="closepanel" aria-label="Close">✕</button></div>${card(isTop(i) ? i : get(groupAll(i.groupId).find(x => x.isMaster).id))}`;
}

/* ================= Settings ================= */
function vSettings(){
  const st = {local: 'Saved on this device only (not signed in)', pending: 'Changes waiting to sync', syncing: 'Syncing…', synced: 'Synced with Google Drive', offline: 'Offline: changes sync when you\'re back online', error: 'Sync problem: will retry'}[syncState];
  return `<div class="head"><div><h1>Settings</h1><p>Version ${C.version} · test stage ${C.stage} of 3</p></div></div>
  <div class="two"><div class="panel"><h2>Account</h2>
    ${GID.signedIn ? `<p>Signed in as <b>${esc(GID.email || 'your Google account')}</b></p><p class="note">${st}${lastSyncAt ? ' · ' + fmt(lastSyncAt) : ''}</p>${gNote ? `<p class="note" style="color:var(--urgent)">${esc(gNote)}</p>` : ''}<div class="cap-row"><button class="btn" data-act="syncnow">Sync now</button><button class="btn danger" data-act="signout">Sign out</button></div>`
      : `<p>Not signed in. Your items are only on this device.</p><button class="btn pri" data-act="signin">Sign in with Google</button>`}
    <h2 style="margin-top:18px">Look</h2><div class="f"><label class="note">Font</label><div class="seg">${['Aptos', 'Times New Roman'].map(f => `<label><input type="radio" name="font" value="${f}" ${S.font === f ? 'checked' : ''} data-act="font"><span>${f}</span></label>`).join('')}</div><p class="note">On iPhone and iPad, Aptos shows as Apple's SF Pro.</p></div>
    <h2 style="margin-top:18px">You</h2><div class="inline"><input id="set-name" value="${esc(S.userName || '')}" placeholder="Your name (used in delegation emails)"><button class="btn" data-act="savename">Save</button></div>
    <div class="inline"><input id="set-acct" type="number" min="0" max="9" value="${S.gmailAcct || 0}" style="max-width:90px"><span class="note" style="align-self:center">Gmail account number for “Find in Gmail” (0 = first)</span><button class="btn" data-act="saveacct">Save</button></div></div>
  <div class="panel"><h2>EA mode</h2><p class="note">When on, every person's delegation email and the urgent summary go to your EA instead. Emails start in test stage 3.</p>
    <label class="opt"><input type="checkbox" data-act="eamode" ${S.eaMode ? 'checked' : ''}><div><b>EA mode ${S.eaMode ? 'on' : 'off'}</b></div></label>
    <div class="inline"><input id="set-ea" type="email" value="${esc(S.eaEmail || '')}" placeholder="EA's email address"><button class="btn" data-act="saveea">Save</button></div>
    <h2 style="margin-top:18px">Holidays</h2><p class="note">No regular emails; deadlines move to 6 pm the working day before.</p>
    ${(S.holidays || []).map(h => `<div class="prow"><span>${new Date('2000-' + h + 'T12:00').toLocaleDateString(undefined, {day: 'numeric', month: 'long'})}</span><button class="btn sm danger" data-act="delhol" data-v="${h}">Remove</button></div>`).join('')}
    <div class="inline"><input id="set-hol" type="date"><button class="btn" data-act="addhol">Add holiday</button></div></div></div>`;
}

/* ================= Capture modal with real voice recording ================= */
let rec = null, recChunks = [];
function captureModal(kind){
  let att = [];
  const ov = modal({title: kind === 'email' ? 'Add email' : 'Capture', ok: 'Add to brain dump', wide: true,
    body: kind === 'email' ? '' : `<div class="f"><label>What's on your mind?</label><textarea id="c-text"></textarea></div>
      <div class="f"><label>Explanation (needed before it can go into a bucket)</label><input type="text" id="c-expl"></div>
      <div id="c-atts" class="atts"></div>
      <div class="cap-row"><label class="btn">📷 Photo<input type="file" accept="image/*" id="c-photo" multiple></label><button type="button" class="btn" id="c-rec">🎙 Record voice note</button><span class="note" id="c-recst"></span></div>`,
    onOk: o => { const text = o.querySelector('#c-text').value.trim(), expl = o.querySelector('#c-expl').value.trim();
      if (rec) { toast('Stop the recording first'); return false; }
      if (!text && !att.length) { toast('Type something, or add a photo or voice note'); return false; }
      S.items.push(base({text: text || (att[0].type === 'photo' ? 'Photo' : 'Voice note'), expl, atts: att})); commit('Added to the brain dump'); }});
  if (kind === 'email') { $('#ov').classList.remove('on'); return emailModal(); }
  const draw = () => { ov.querySelector('#c-atts').innerHTML = att.map(a => a.type === 'photo' ? `<img src="${a.data}" alt="">` : `<div class="voice">🎙 <audio controls src="${a.data}"></audio></div>`).join(''); };
  ov.querySelector('#c-photo').onchange = async e => { for (const f of e.target.files) { const a = await readFile(f); if (a) att.push(a); } draw(); };
  const rb = ov.querySelector('#c-rec'), rs = ov.querySelector('#c-recst');
  rb.onclick = async () => {
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This browser can\'t record audio'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true}); recChunks = [];
      rec = new MediaRecorder(stream); const t0 = Date.now();
      rec.ondataavailable = e => recChunks.push(e.data);
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); clearInterval(rec._tm); const blob = new Blob(recChunks, {type: rec.mimeType || 'audio/webm'}); rec = null; rb.textContent = '🎙 Record voice note'; rs.textContent = '';
        const r = new FileReader(); r.onload = () => { att.push({type: 'voice', name: 'Voice note', data: r.result, transcript: ''}); draw(); }; r.readAsDataURL(blob); };
      rec.start(); rb.textContent = '■ Stop'; rec._tm = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); rs.textContent = `Recording ${s}s (max 2 min)`; if (s >= 120 && rec) rec.stop(); }, 500);
    } catch (e) { toast('Microphone permission was refused'); }
  };
}

/* ================= Side bar ================= */
function renderSide(){
  $('.app').classList.toggle('collapsed', !!(S.ui && S.ui.side === 'hidden'));
  const c = counts();
  const nav = [['board', 'Dashboard'], ['dump', 'Brain dump', c.unb], ['urgent', 'Urgent', c.urg, true], ['done', 'Done', c.done], ['report', 'Metrics'], ['people', 'People, places, processes'], ['log', 'Change log'], ['deleted', 'Deleted', c.del], ['settings', 'Settings']];
  const st = {local: 'This device only', pending: 'Saving…', syncing: 'Syncing…', synced: 'Synced', offline: 'Offline', error: 'Sync problem'}[syncState];
  $('#side').innerHTML = `
    <div class="brand"><div class="bl"><img src="icons/icon.svg" width="30" height="30" alt=""><div>Get it Done<small>Test stage ${C.stage} · v${C.version}</small></div></div><button type="button" class="side-x" data-act="side" aria-label="Hide menu" title="Hide menu">«</button></div>
    <button type="button" class="btn pri cap-btn" data-act="capture">+ Capture</button>
    <nav>${nav.map(([k, l, n, hot]) => `<button class="${view === k ? 'on' : ''}" data-act="nav" data-v="${k}"><span>${l}</span>${n !== undefined ? `<span class="n ${hot && n ? 'hot' : ''}">${n}</span>` : ''}</button>`).join('')}</nav>
    <div class="side-card"><div class="lbl">Google</div>${GID.signedIn ? `<b>${esc(GID.email || 'Signed in')}</b><br>${st}${S.eaMode ? '<br><b>EA mode on</b>' : ''}` : `Not signed in<div class="row"><button data-act="signin">Sign in</button></div>`}</div>`;
}

/* ================= Boot ================= */
function welcome(){
  $('#main').innerHTML = `<div class="welcome"><img src="icons/icon.svg" width="64" height="64" alt=""><h1>Get it Done</h1>
    <p>Sign in with the Google account you set up for testing. Your items are saved in a private folder in that account's Google Drive.</p>
    <button class="btn pri" data-act="signin" style="font-size:16px;padding:10px 18px">Sign in with Google</button>
    <p class="note" style="margin-top:18px">Google will say the app is unverified. That's expected for a private test app: choose <b>Continue</b>.</p>
    <p><a href="#" data-act="skipsignin">Try it without signing in</a></p></div>`;
}
function boot(){
  S = load(); if (!S) seed();
  S.ui = Object.assign({weeks: 6, offset: 0, mview: 'time', mbucket: null, mrange: 'week'}, S.ui || {});
  ['closedDeleg', 'doneLog', 'notes'].forEach(k => S[k] = S[k] || []);
  conflicts = lget(CONFKEY) || [];
  renderSide(); if (!GID.wasSignedIn() && !localStorage.getItem('gid-skip')) welcome(); else render(); // show something straight away, before Google's script loads
  const start = () => {
    GID.onChange = () => { if (GID.signedIn) GID.whoami().then(() => { renderSide(); syncNow(); }); render(); };
    if (!GID.signedIn && !GID.wasSignedIn() && !localStorage.getItem('gid-skip')) { renderSide(); welcome(); return; }
    render(); if (GID.signedIn) GID.whoami().then(() => { renderSide(); syncNow(); });
  };
  const tryInit = (n) => { if (GID.init()) start(); else if (n > 0) setTimeout(() => tryInit(n - 1), 300); else { render(); toast('Offline: Google sign-in is not available right now'); } };
  tryInit(20);
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => { syncState = 'offline'; renderSide(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
  window.addEventListener('resize', () => { clearTimeout(boot._r); boot._r = setTimeout(render, 200); });
}
Object.assign(A, {
  side: () => { S.ui.side = S.ui.side === 'hidden' ? 'shown' : 'hidden'; save(); render(); },
  open: d => { panelId = d.id; renderPanel(); },
  closepanel: () => { panelId = null; renderPanel(); },
  capture: () => captureModal(),
  wk: d => { S.ui.offset = +d.d === 0 ? 0 : (S.ui.offset || 0) + +d.d; save(); render(); },
  mview: d => { S.ui.mview = d.v; S.ui.offset = 0; save(); render(); },
  mrange: d => { S.ui.mrange = d.v; S.ui.offset = 0; save(); render(); },
  mbucket: d => { S.ui.mbucket = d.v; save(); render(); },
  signin: () => GID.signIn('consent').then(() => toast('Signed in')).catch(e => toast('Sign-in did not finish: ' + e.message)),
  signout: () => ask('Sign out?', 'Your items stay on this device and in your Google Drive.', 'Sign out', () => { GID.signOut(); syncState = 'local'; render(); }),
  skipsignin: () => { try { localStorage.setItem('gid-skip', '1'); } catch (e) {} render(); },
  syncnow: () => syncNow(),
  resolve: () => resolveModal(),
  savename: () => { S.userName = $('#set-name').value.trim(); commit('Saved'); },
  saveacct: () => { S.gmailAcct = Math.max(0, +$('#set-acct').value || 0); commit('Saved'); },
  saveea: () => { S.eaEmail = $('#set-ea').value.trim(); commit('EA email saved'); },
  addhol: () => { const v = $('#set-hol').value; if (!v) return; const md = v.slice(5); S.holidays = [...new Set([...(S.holidays || []), md])].sort(); commit('Holiday added'); },
  delhol: d => { S.holidays = (S.holidays || []).filter(h => h !== d.v); commit('Holiday removed'); }
});
document.addEventListener('change', e => {
  const t = e.target, a = t.dataset && t.dataset.act;
  if (a === 'weeks') { S.ui.weeks = +t.value; save(); render(); }
  else if (a === 'font') { S.font = t.value; commit(); }
  else if (a === 'eamode') { S.eaMode = t.checked; commit(S.eaMode ? 'EA mode on' : 'EA mode off'); }
});

/* ================= Capture bar (above the buckets) ================= */
let qb = {text: '', expl: '', atts: []}, qbRec = null;
function captureBar(){
  return `<form class="qbar" data-qbar onsubmit="return false">
    <div class="qrow"><label class="sr" for="qb-text">Capture</label><input id="qb-text" class="qin" autocomplete="off" placeholder="What's on your mind? Type it and press Enter" value="${esc(qb.text)}">
      <label class="ibtn qi" title="Add photo" aria-label="Add photo">📷<input type="file" accept="image/*" multiple data-act="qbphoto" hidden></label>
      <button type="button" class="ibtn qi ${qbRec ? 'rec' : ''}" data-act="qbrec" aria-label="${qbRec ? 'Stop recording' : 'Record voice note'}">${qbRec ? '■' : '🎙'}</button>
      <button type="button" class="ibtn qi" data-act="qbemail" title="Add an email" aria-label="Add an email">✉</button>
      <button type="submit" class="btn pri" data-act="qbadd">Add</button></div>
    <div class="qrow2 ${qb.text || qb.atts.length ? 'show' : ''}"><label class="sr" for="qb-expl">Explanation</label><input id="qb-expl" class="qin sm" autocomplete="off" placeholder="Explanation: what needs to be done (optional now, needed before bucketing)" value="${esc(qb.expl)}">
      <span class="qatts">${qb.atts.map((a, k) => a.type === 'photo' ? `<img src="${a.data}" alt="">` : `<span class="voice">🎙 ${k + 1}</span>`).join('')}</span><span class="note" id="qb-st">${qbRec ? 'Recording…' : ''}</span></div>
  </form>`;
}
function qbAdd(){
  if (qbRec) return toast('Stop the recording first');
  const text = qb.text.trim(), expl = qb.expl.trim();
  if (!text && !qb.atts.length) { const el = $('#qb-text'); el && el.focus(); return toast('Type something first'); }
  S.items.push(base({text: text || (qb.atts[0].type === 'photo' ? 'Photo' : 'Voice note'), expl, atts: qb.atts}));
  qb = {text: '', expl: '', atts: []}; commit('Added to the brain dump');
  setTimeout(() => { const el = $('#qb-text'); el && el.focus(); }, 0);
}
async function qbRecord(){
  if (qbRec) { qbRec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('This browser can\'t record audio');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true}), chunks = [];
    const r = new MediaRecorder(stream); qbRec = r;
    r.ondataavailable = e => chunks.push(e.data);
    r.onstop = () => { stream.getTracks().forEach(t => t.stop()); clearTimeout(r._t); const blob = new Blob(chunks, {type: r.mimeType || 'audio/webm'}); qbRec = null;
      const fr = new FileReader(); fr.onload = () => { qb.atts.push({type: 'voice', name: 'Voice note', data: fr.result, transcript: ''}); render(); }; fr.readAsDataURL(blob); };
    r.start(); r._t = setTimeout(() => qbRec && qbRec.stop(), 120000); render();
  } catch (e) { qbRec = null; toast('Microphone permission was refused'); }
}
document.addEventListener('input', e => { if (e.target.id === 'qb-text') { qb.text = e.target.value; const r2 = $('.qrow2'); r2 && r2.classList.toggle('show', !!qb.text || qb.atts.length > 0); } else if (e.target.id === 'qb-expl') qb.expl = e.target.value; });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.id === 'qb-text' || e.target.id === 'qb-expl')) { e.preventDefault(); qbAdd(); } });
document.addEventListener('change', async e => { if (e.target.dataset && e.target.dataset.act === 'qbphoto') { for (const f of e.target.files) { const a = await readFile(f); if (a) qb.atts.push(a); } render(); } });
Object.assign(A, {
  qbadd: () => qbAdd(), qbrec: () => qbRecord(), qbemail: () => emailModal(),
  capture: () => { view = 'board'; panelId = null; render(); setTimeout(() => { const el = $('#qb-text'); el && el.focus(); }, 0); }
});

/* ================= Inline explanation editing ================= */
let editingExpl = null;
function explBlock(i, ro){
  if (editingExpl === i.id) return `<div class="expl-ed"><textarea id="ex-${i.id}" class="qin sm" rows="2" placeholder="What needs to be done?">${esc(i.expl)}</textarea>
    <div class="cap-row"><button type="button" class="btn sm pri" data-act="saveexpl" data-id="${i.id}">Save</button><button type="button" class="btn sm ghost" data-act="cancelexpl">Cancel</button><span class="note">Enter saves · Shift+Enter for a new line</span></div></div>`;
  const has = i.expl.trim(), can = !ro && !locked(i);
  const inner = has ? esc(i.expl) : (can ? '+ Add explanation' : 'No explanation yet');
  return can ? `<button type="button" class="expl expl-btn ${has ? '' : 'miss'}" data-act="editexpl" data-id="${i.id}" title="${has ? 'Edit explanation' : 'Add explanation'}">${inner}</button>`
    : `<div class="expl ${has ? '' : 'miss'}" ${!ro && locked(i) ? 'title="Scheduled items are locked. Unschedule to edit."' : ''}>${inner}</div>`;
}
function saveExpl(id){
  const i = get(id), el = document.getElementById('ex-' + id); if (!i || !el) return;
  const v = el.value.trim(); editingExpl = null;
  if (v === i.expl) { render(); return; }
  note(i.id, `Explanation updated: "${v}"`); i.expl = v; if (v) i.needsExpl = false;
  save(); render(); toast('Explanation saved');
}
document.addEventListener('keydown', e => {
  if (e.target.id && e.target.id.startsWith('ex-')) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveExpl(e.target.id.slice(3)); }
    else if (e.key === 'Escape') { editingExpl = null; render(); }
  }
});
/* ================= Bucket order and sorting on the dashboard ================= */
function orderedBuckets(){
  const by = S.ui.bsort || 'mine', bs = S.buckets.slice();
  if (by === 'mine') return bs;
  const cnt = b => tops().filter(i => open_(i) && i.bucket === b.id && !locked(i));
  if (by === 'az') return bs.sort((a, b) => a.name.localeCompare(b.name));
  if (by === 'waiting') return bs.sort((a, b) => cnt(b).length - cnt(a).length);
  if (by === 'urgent') return bs.sort((a, b) => cnt(b).filter(i => i.urgent).length - cnt(a).filter(i => i.urgent).length || cnt(b).length - cnt(a).length);
  return bs;
}
function moveBucket(id, dir){
  const k = S.buckets.findIndex(b => b.id === id), j = k + dir;
  if (k < 0 || j < 0 || j >= S.buckets.length) return;
  const [b] = S.buckets.splice(k, 1); S.buckets.splice(j, 0, b); save(); render();
}
let dragB = null;
document.addEventListener('dragstart', e => { const l = e.target.closest && e.target.closest('[data-bdrag]'); if (l) { dragB = l.dataset.bdrag; e.dataTransfer.effectAllowed = 'move'; l.classList.add('dragging'); } });
document.addEventListener('dragover', e => { if (dragB && e.target.closest('[data-bdrag]')) e.preventDefault(); });
document.addEventListener('drop', e => { const l = e.target.closest && e.target.closest('[data-bdrag]'); if (!dragB || !l) return; e.preventDefault();
  const from = S.buckets.findIndex(b => b.id === dragB), to = S.buckets.findIndex(b => b.id === l.dataset.bdrag);
  if (from >= 0 && to >= 0 && from !== to) { const [b] = S.buckets.splice(from, 1); S.buckets.splice(to, 0, b); S.ui.bsort = 'mine'; save(); render(); } dragB = null; });
document.addEventListener('dragend', () => { dragB = null; document.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging')); });
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.act === 'bsort') { S.ui.bsort = e.target.value; save(); render(); } });
Object.assign(A, {
  editexpl: d => { editingExpl = d.id; render(); setTimeout(() => { const el = document.getElementById('ex-' + d.id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0); },
  saveexpl: d => saveExpl(d.id),
  cancelexpl: () => { editingExpl = null; render(); },
  bup: d => { S.ui.bsort = 'mine'; moveBucket(d.id, -1); },
  bdown: d => { S.ui.bsort = 'mine'; moveBucket(d.id, 1); }
});

/* ================= Stage 2: Google Calendar and Google Tasks ================= */
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events', TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
const RR = {daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY'};
function gNotes(i){
  const lines = [];
  if (i.expl) lines.push(i.expl);
  i.atts.filter(a => a.type === 'email').forEach(a => lines.push(`Find in Gmail (${a.subject}): ${gmailUrl(a)}`));
  i.atts.filter(a => a.type === 'link').forEach(a => lines.push(a.url));
  lines.push('', 'From Get it Done');
  return lines.join('\n');
}
const ownHash = i => JSON.stringify([i.sched.at, i.sched.type, i.sched.len, i.sched.loc, i.sched.repeat, i.text, i.expl, !!(i.done || i.ownDone), i.atts.length]);
const delHash = (i, d) => JSON.stringify([d.sched.at, i.text, i.expl, d.status === 'Done', person(d.pid).name]);
function eventBody(i){
  const s = i.sched, done = i.done || i.ownDone, b = {summary: (done ? '✓ ' : '') + i.text, description: gNotes(i),
    start: {dateTime: new Date(s.at).toISOString(), timeZone: TZ}, end: {dateTime: new Date(s.at + (s.len || 30) * 6e4).toISOString(), timeZone: TZ},
    reminders: {useDefault: true}, extendedProperties: {private: {gid: i.id}}};
  if (s.type === 'appt' && s.loc) b.location = s.loc; else b.location = '';
  b.recurrence = s.repeat !== 'none' ? [`RRULE:FREQ=${RR[s.repeat]}${done ? ';UNTIL=' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') : ''}`] : [];
  return b;
}
const taskDue = at => isoDay(at) + 'T00:00:00.000Z';
const taskBody = (title, notes, at, done) => ({title, notes, due: taskDue(at), status: done ? 'completed' : 'needsAction'});
async function gjson(url, method, body){ const r = await GID.api(url, {method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined}); return r.status === 204 ? null : r.json(); }
async function gget(url){ try { const r = await GID.api(url); return await r.json(); } catch (e) { if (/ 40[34]|410/.test(e.message) || /Google 40[34]|Google 410/.test(e.message)) return {_gone: true}; throw e; } }
let gNote = '';
async function pullGoogle(){
  const msgs = [];
  for (const i of tops().filter(live)) {
    const s = i.sched;
    if (s && s.g && s.g.id && s.g.h === ownHash(i)) { // only when nothing changed here since the last push; local changes win
      if (s.type === 'task') {
        const t = await gget(`${TASKS}/${s.g.id}`);
        if (t._gone || t.deleted) { s.g = null; unscheduleOwn(i); msgs.push(`"${i.text}" was deleted in Google, so it's unscheduled`); continue; }
        if (t.status === 'completed' && !i.done && !i.ownDone) { msgs.push(markOwnDone(i)); continue; }
        if (t.status === 'needsAction' && i.done) { reopen(i); msgs.push(`"${i.text}" was unticked in Google, so it's reopened`); continue; }
        if (t.due && t.due.slice(0, 10) !== isoDay(s.at)) { const nd = parseDay(t.due.slice(0, 10)); snapUndo(i, null, true); i.schedCount++; i.reschedules++; s.at = nd; s.g.h = ownHash(i); msgs.push(`"${i.text}" was moved in Google: counted as a reschedule`); }
      } else if (!i.done) {
        const e = await gget(`${CAL}/${s.g.id}`);
        if (e._gone || e.status === 'cancelled') { s.g = null; unscheduleOwn(i); msgs.push(`"${i.text}" was deleted in Google, so it's unscheduled`); continue; }
        const st = e.start && Date.parse(e.start.dateTime || e.start.date);
        if (st && Math.abs(st - s.at) > 60000 && s.repeat === 'none') { snapUndo(i, null, true); i.schedCount++; i.reschedules++; s.len = Math.round((Date.parse(e.end.dateTime || e.end.date) - st) / 6e4) || s.len; s.at = st; s.g.h = ownHash(i); msgs.push(`"${i.text}" was moved in Google: counted as a reschedule`); }
      }
    }
    for (const d of i.delegates) {
      if (!(d.sched && d.sched.g && d.sched.g.id) || d.sched.g.h !== delHash(i, d)) continue;
      const t = await gget(`${TASKS}/${d.sched.g.id}`);
      if (t._gone || t.deleted) { d.sched.g = null; unscheduleDel(i, d); msgs.push(`${person(d.pid).name}'s follow-up was deleted in Google`); continue; }
      if (t.status === 'completed' && d.status !== 'Done') { msgs.push(markDelDone(i, d)); continue; }
      if (t.due && t.due.slice(0, 10) !== isoDay(d.sched.at)) { snapUndo(i, d, true); d.schedCount++; d.reschedules++; d.status = 'Rescheduled'; d.sched.at = parseDay(t.due.slice(0, 10)); d.sched.g.h = delHash(i, d); queueMail([{i, d, kind: 'moved'}]); msgs.push(`${person(d.pid).name}'s follow-up was moved in Google`); }
    }
  }
  return msgs;
}
async function pushGoogle(){
  let n = 0;
  for (const x of (S.gDel || []).splice(0)) { try { await GID.api(x.kind === 'task' ? `${TASKS}/${x.id}` : `${CAL}/${x.id}`, {method: 'DELETE'}); n++; } catch (e) { if (!/40[34]|410/.test(e.message)) { S.gDel.push(x); } } }
  for (const id of (S.gTick || []).splice(0)) { try { await gjson(`${TASKS}/${id}`, 'PATCH', {status: 'completed'}); } catch (e) { if (!/40[34]|410/.test(e.message)) S.gTick.push(id); } }
  for (const i of tops().filter(live)) {
    const s = i.sched;
    if (s) {
      const h = ownHash(i);
      if (!s.g || !s.g.id) {
        if (i.done && s.type !== 'task') continue;
        const r = s.type === 'task' ? await gjson(TASKS, 'POST', taskBody(i.text, gNotes(i), s.at, !!(i.done || i.ownDone))) : await gjson(CAL, 'POST', eventBody(i));
        s.g = {id: r.id, h}; n++;
      } else if (s.g.h !== h) {
        if (s.type === 'task') await gjson(`${TASKS}/${s.g.id}`, 'PATCH', taskBody(i.text, gNotes(i), s.at, !!(i.done || i.ownDone)));
        else await gjson(`${CAL}/${s.g.id}`, 'PATCH', eventBody(i));
        s.g.h = h; n++;
      }
    }
    for (const d of i.delegates) {
      if (!d.sched) continue;
      const h = delHash(i, d), title = `Follow up with ${person(d.pid).name}: ${i.text}`;
      if (!d.sched.g || !d.sched.g.id) { const r = await gjson(TASKS, 'POST', taskBody(title, gNotes(i), d.sched.at, d.status === 'Done')); d.sched.g = {id: r.id, h}; n++; }
      else if (d.sched.g.h !== h) { await gjson(`${TASKS}/${d.sched.g.id}`, 'PATCH', taskBody(title, gNotes(i), d.sched.at, d.status === 'Done')); d.sched.g.h = h; n++; }
    }
  }
  return n;
}
async function googleRound(){
  if (C.stage < 2) return;
  try {
    const msgs = await pullGoogle(); const n = await pushGoogle();
    gNote = ''; if (msgs.length) toast(msgs.length === 1 ? msgs[0] : `${msgs.length} changes picked up from Google`);
    return n;
  } catch (e) {
    console.warn('google', e);
    gNote = /Google 403/.test(e.message) ? 'Google Calendar or Tasks permission is missing. Sign out, sign in again and tick every box.' : 'Could not reach Google Calendar or Tasks; will retry.';
  }
}

/* ================= Undo a reschedule ================= */
const UNDO_HOURS = 24;
function snapUndo(i, d, fromGoogle){
  const tgt = d || i;
  i.undo = {t: now(), pid: d ? d.pid : null, fromGoogle: !!fromGoogle,
    sched: tgt.sched ? JSON.parse(JSON.stringify(tgt.sched)) : (tgt.lastSched && now() - tgt.lastSched.t < UNDO_HOURS * 3600e3 ? JSON.parse(JSON.stringify(tgt.lastSched.sched)) : null),
    c: {schedCount: tgt.schedCount, reschedules: tgt.reschedules, forcedFree: !!tgt.forcedFree, status: tgt.status || null, pastNotDone: !!tgt.pastNotDone}};
  if (!fromGoogle) setTimeout(() => toast(d ? `${person(d.pid).name}'s date changed` : 'Rescheduled', {label: 'Undo', fn: () => undoResched(i.id)}), 50);
}
const canUndo = i => i.undo && now() - i.undo.t < UNDO_HOURS * 3600e3 && !i.done && live(i);
function undoResched(id){
  const i = get(id); if (!i || !canUndo(i)) return toast('Nothing to undo');
  const u = i.undo, d = u.pid ? i.delegates.find(x => x.pid === u.pid) : null, tgt = u.pid ? d : i;
  if (!tgt) { i.undo = null; return toast('Nothing to undo'); }
  const curG = tgt.sched && tgt.sched.g;
  if (!u.sched) { gForget(tgt.sched, tgt === i && tgt.sched && tgt.sched.type !== 'task' ? 'event' : 'task'); tgt.sched = null; }
  else {
    const typeSame = tgt.sched && ((tgt.sched.type === 'task') === ((u.sched.type || 'task') === 'task'));
    if (curG && !typeSame) gForget(tgt.sched, tgt.sched.type === 'task' ? 'task' : 'event');
    tgt.sched = Object.assign({}, u.sched, {g: curG && typeSame ? {id: curG.id, h: ''} : (u.sched.g && !curG ? null : null)});
  }
  Object.assign(tgt, u.c);
  S.notes = S.notes.filter(n => !(n.id === i.id && n.t >= u.t));
  note(i.id, `Reschedule undone${u.pid ? ' (' + person(u.pid).name + ')' : ''}: back to ${u.sched ? fmtD(u.sched.at) : 'unscheduled'}`);
  if (d && dirty) queueMail([{i, d, kind: 'moved'}]);
  i.undo = null;
  commit(`Reschedule undone: back to ${u.sched ? fmtD(u.sched.at) : 'unscheduled'}${u.fromGoogle ? ' (Google updates at the next sync)' : ''}`);
}
Object.assign(A, {undoresched: d => undoResched(d.id)});

/* ================= Reset the reschedule counter by hand ================= */
function resetCount(i){
  const parts = [];
  if (i.reschedules) parts.push(`yours: ${i.reschedules}`);
  i.delegates.filter(x => x.reschedules).forEach(x => parts.push(`${person(x.pid).name}: ${x.reschedules}`));
  modal({title: 'Reset the reschedule counter?', ok: 'Reset to 0',
    body: `<p><b>${esc(i.text)}</b></p><p>Reschedules counted so far: ${esc(parts.join(', ') || '0')}. Resetting sets them to 0 and clears the Flagged mark. The item stays on its current date, and the reset is noted in its history.</p>`,
    onOk: () => {
      i.reschedules = 0; i.schedCount = i.sched ? 1 : 0; i.forcedFree = false;
      i.delegates.forEach(x => { x.reschedules = 0; x.schedCount = x.sched ? 1 : 0; if (x.status === 'Rescheduled') x.status = 'Due'; });
      i.undo = null; note(i.id, `Reschedule counter reset by hand (was ${parts.join(', ')})`);
      commit('Counter reset to 0');
    }});
}
Object.assign(A, {resetcount: d => resetCount(get(d.id))});

/* ================= Search in the brain dump ================= */
let dq = '';
function itemHay(i){
  const g = i.groupId ? groupAll(i.groupId) : [i];
  return g.map(x => [x.text, x.expl, x.bucket ? bname(x.bucket) : 'unbucketed', x.process && proc(x.process) ? proc(x.process).name : '', x.personal ? 'personal' : '', x.place && place(x.place) ? place(x.place).name : '',
    ...x.delegates.map(d => (person(d.pid) || {}).name), ...x.atts.map(a => a.type === 'email' ? a.subject : a.type === 'voice' ? a.transcript : a.type === 'link' ? (a.label || a.url) : a.name)].join(' ')).join(' ').toLowerCase();
}
const matchQ = i => { const q = dq.trim().toLowerCase(); if (!q) return true; const h = itemHay(i); return q.split(/\s+/).every(w => h.includes(w)); };
function searchBox(){
  const n = dq.trim() ? tops().filter(i => i.status !== 'deleted' && matchQ(i)).length : null;
  return `<div class="sbox"><span aria-hidden="true">🔍</span><label class="sr" for="dq">Search the brain dump</label><input id="dq" type="search" autocomplete="off" placeholder="Search text, explanations, emails, people, buckets…" value="${esc(dq)}">${n !== null ? `<span class="note">${n} found</span><button type="button" class="btn sm ghost" data-act="dqclear">Clear</button>` : ''}</div>`;
}
document.addEventListener('input', e => { if (e.target.id === 'dq') { dq = e.target.value; const pos = e.target.selectionStart; render(); const el = $('#dq'); if (el) { el.focus(); el.setSelectionRange(pos, pos); } } });
Object.assign(A, {dqclear: () => { dq = ''; render(); }});

boot();
})();
