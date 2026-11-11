/* Family Control Room — self-hosted edition.
   Firebase Authentication (email + password) for sign-in, Cloud Firestore for shared data and files.
   Only the two accounts listed in firestore.rules can read or write anything. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, getDoc, deleteDoc, Bytes } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const DAY = 864e5, AWAY_MS = 15 * 60e3;
const $ = (s, el = document) => el.querySelector(s);
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const ICON = {
  link:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  more:'<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  back:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  tick:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>',
  play:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  mail:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></svg>'
};
const ls = {get(k,d){ try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch(e) { return d; } }, set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} }};

/* ---------- Firebase ---------- */
const CFG = window.FCR_CONFIG || {};
const configured = !!(CFG.apiKey && CFG.projectId && !/PASTE/i.test(CFG.apiKey + CFG.projectId));
let fb = null, auth = null, fs = null, user = null;

/* A small wrapper so the app code reads the same as before: db.collection(name).onSnapshot, db.doc(path).set/get/delete/onSnapshot */
function makeDb(){
  const snap = s => ({exists: s.exists(), id: s.id, data: () => s.data()});
  return {
    collection: name => ({ onSnapshot: (cb, err) => onSnapshot(collection(fs, name), s => cb({docs: s.docs.map(d => ({id: d.id, data: () => d.data()}))}), err) }),
    doc: path => { const r = doc(fs, path); return {
      set: (v, opts) => setDoc(r, v, opts || {}), delete: () => deleteDoc(r), get: () => getDoc(r).then(snap),
      onSnapshot: (cb, err) => onSnapshot(r, s => cb(snap(s)), err) }; }
  };
}

/* Files live in Firestore in pieces of up to 700 KB (a Firestore document holds at most 1 MB).
   Large photos are shrunk before upload; each image also keeps a small thumbnail for the grid. */
const CHUNK = 700 * 1024, MAX_FILE = 20 * 1048576;
const blobCache = {};
function loadImage(file){
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image();
    i.onload = () => res({img: i, url: u}); i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); }; i.src = u; });
}
function drawScaled(img, max){
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height); return c;
}
async function prepareImage(file){
  let loaded; try { loaded = await loadImage(file); } catch(e) { return {file, thumb: null}; }
  const {img, url} = loaded;
  try {
    const thumb = drawScaled(img, 360).toDataURL('image/jpeg', 0.7);
    const big = Math.max(img.naturalWidth, img.naturalHeight) > 2400 || file.size > 1.5 * 1048576;
    if (!big) return {file, thumb};
    const blob = await new Promise(r => drawScaled(img, 2400).toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return {file, thumb};
    const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return {file: new File([blob], name, {type: 'image/jpeg'}), thumb};
  } finally { URL.revokeObjectURL(url); }
}
const assets = {
  async upload(original, onProgress){
    const isImg = (original.type || '').startsWith('image/');
    const {file, thumb} = isImg ? await prepareImage(original) : {file: original, thumb: null};
    if (file.size > MAX_FILE) { const e = new Error('too large'); e.code = 'too_large'; throw e; }
    const bytes = new Uint8Array(await file.arrayBuffer()), id = uid(), n = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let i = 0; i < n; i++) {
      onProgress && onProgress(i + 1, n);
      await setDoc(doc(fs, 'blobs', id + '_' + i), {data: Bytes.fromUint8Array(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)), i, of: n});
    }
    return {id, chunks: n, name: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size, thumb};
  },
  async load(f){
    if (blobCache[f.assetId]) return blobCache[f.assetId];
    const parts = await Promise.all(Array.from({length: f.chunks || 1}, (_, i) => getDoc(doc(fs, 'blobs', f.assetId + '_' + i))));
    if (parts.some(p => !p.exists())) throw new Error('missing');
    const blob = new Blob(parts.map(p => p.data().data.toUint8Array()), {type: f.type || 'application/octet-stream'});
    return blobCache[f.assetId] = {blob, url: URL.createObjectURL(blob)};
  },
  async delete(f){ await Promise.all(Array.from({length: f.chunks || 1}, (_, i) => deleteDoc(doc(fs, 'blobs', f.assetId + '_' + i)))); }
};

/* ---------- App state ---------- */
let db = null, myId = null, myName = 'You', canWrite = true;
const T = {}, F = {}, H = {}, N = {}, TD = {}, NAMES = {};
let MY = {timer:null}, myLoaded = false, loaded = false, loadState = configured ? 'loading' : 'setup';
let showResting = ls.get('fcr-show-resting', false), askedName = false;
function fill(store, s){ for (const k in store) delete store[k]; s.docs.forEach(d => store[d.id] = {id:d.id, ...d.data()}); }

function boot(){
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!configured) { render(); return; }
  fb = initializeApp(CFG);
  auth = getAuth(fb);
  try { fs = initializeFirestore(fb, {localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})}); }
  catch(e) { fs = getFirestore(fb); }
  render();
  onAuthStateChanged(auth, u => {
    if (u && !user) { user = u; startData(); }
    else if (!u) { if (user) { location.reload(); return; } loadState = 'signedout'; render(); }
  });
}

function startData(){
  myId = user.uid; myName = (user.email || 'You').split('@')[0]; db = makeDb();
  loadState = 'loading'; render();
  const slow = setTimeout(() => { if (!loaded) { loadState = 'slow'; render(); } }, 10000);
  const denied = e => { clearTimeout(slow); loadState = e && e.code === 'permission-denied' ? 'denied' : 'error'; render(); };
  db.collection('tasks').onSnapshot(s => { fill(T, s); loaded = true; loadState = 'ok'; clearTimeout(slow); render(); }, denied);
  const sub = (name, store) => db.collection(name).onSnapshot(s => { fill(store, s); if (loaded) render(); }, () => {});
  sub('files', F); sub('history', H); sub('notes', N); sub('todos', TD);
  db.collection('people').onSnapshot(s => {
    s.docs.forEach(d => { const v = d.data(); if (v.name) NAMES[d.id] = v.name; });
    if (NAMES[myId]) myName = NAMES[myId];
    if (loaded) render();
    if (!NAMES[myId] && !askedName && loadState === 'ok') { askedName = true; nameSheet(true); }
  }, () => {});
  db.doc('data/users/' + myId + '/me').onSnapshot(s => {
    const d = s.exists ? s.data() : {timer:null};
    if (myLoaded && (d.rev || 0) < (MY.rev || 0)) return; // ignore an older copy than what this device just saved
    const keepAct = MY.timer && d.timer && MY.timer.startedAt === d.timer.startedAt ? Math.max(MY.timer.lastAct, d.timer.lastAct || 0) : null;
    MY = d; if (!MY.timer) MY.timer = null; else if (keepAct) MY.timer.lastAct = keepAct;
    myLoaded = true; renderTimer(); if (!checking) checkReturn();
    if (!MY.timer && checking) { checking = false; closeSheet(); }
  }, () => {});
  const pr = db.doc('people/' + myId);
  pr.get().then(s => { const o = s.exists ? s.data() : {}; return pr.set({email: user.email || '', lastOpened: Date.now(), opens: (o.opens || 0) + 1}, {merge: true}); }).catch(() => {});
}
const firstName = n => String(n || 'Someone').split(' ')[0];
const whoName = id => id && id === myId ? 'You' : firstName(NAMES[id]);

function writeErr(e){
  if (e && e.code === 'permission-denied') toast('This account is not allowed to make changes.');
  else if (e && e.code === 'resource-exhausted') toast('Storage is full. Remove some old files.');
  else toast('That change did not save. Check your connection and try again.');
}
const clean = t => { const o = {...t}; delete o.id; return JSON.parse(JSON.stringify(o)); };
function put(t){ T[t.id] = t; render(); return db.doc('tasks/' + t.id).set(clean(t)).catch(writeErr); }
function putIn(coll, store, id, d){ store[id] = {id, ...d}; render(); return db.doc(coll + '/' + id).set(clean(d)).catch(writeErr); }
function delIn(coll, store, id){ delete store[id]; render(); return db.doc(coll + '/' + id).delete().catch(writeErr); }
function log(taskId, text){ const id = uid(), e = {taskId, ts: Date.now(), who: myId || '', text}; H[id] = e; db.doc('history/' + id).set(e).catch(() => {}); }
function saveMe(){ if (!myId) return; MY.rev = Math.max(Date.now(), (MY.rev || 0) + 1); db.doc('data/users/' + myId + '/me').set(JSON.parse(JSON.stringify(MY))).catch(() => {}); }
let snoozeUntil = 0;

/* ---------- Dates & status ---------- */
const now = () => Date.now();
const sod = t => { const d = new Date(t); d.setHours(0,0,0,0); return d.getTime(); };
const dayDiff = (a,b) => Math.round((sod(a)-sod(b))/DAY);
const fmtDate = t => new Date(t).toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'});
const fmtShort = t => new Date(t).toLocaleDateString('en-CA',{month:'short',day:'numeric'});
const days = n => n === 1 ? '1 day' : n + ' days';
function isoDate(t){const d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function parseDate(s){const [y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d).getTime()}
function addMonths(iso, n){ const [y,m,d] = iso.split('-').map(Number); const last = new Date(y, m-1+n+1, 0).getDate(); return isoDate(new Date(y, m-1+n, Math.min(d, last))); }
function nextDate(dl){ // move a repeating deadline forward until it is after today
  const step = dl.repeat === 'monthly' ? 1 : 12; let d = addMonths(dl.date, step), guard = 0;
  while (parseDate(d) <= sod(now()) && guard++ < 600) d = addMonths(d, step);
  return d;
}
const REPEAT = {none:"Doesn't repeat", monthly:'Every month', yearly:'Every year'};
function fmtDur(ms){ const m = Math.round(ms/60e3), hh = Math.floor(m/60), mm = m%60; return hh ? `${hh}h ${mm}m` : `${mm}m`; }
function clock(ms){ const s=Math.floor(ms/1000); return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map((v,i)=>i?String(v).padStart(2,'0'):v).join(':'); }
const fmtSize = b => b > 1048576 ? (b/1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b/1024)) + ' KB';

/* Bring any older task shape up to date (single deadline, single email/phone). */
function norm(t){
  if (!t) return t;
  t.links = t.links || []; t.subtasks = t.subtasks || [];
  t.contacts = (t.contacts || []).map(c => ({name:c.name||'', role:c.role||'',
    emails: c.emails || (c.email ? [{label:'', value:c.email}] : []),
    phones: c.phones || (c.phone ? [{label:'', value:c.phone}] : [])}));
  if (!Array.isArray(t.deadlines)) t.deadlines = t.deadline ? [{id:'d0', label:'', date:t.deadline, redLead: t.redLead ?? 14, repeat: t.repeatYearly ? 'yearly' : 'none'}] : [];
  delete t.deadline; delete t.redLead; delete t.repeatYearly;
  if (t.visibility === undefined) t.visibility = 'auto';
  return t;
}
function status(t){
  const n = now(), toYellow = dayDiff(t.lastDone + t.interval*DAY, n);
  const dls = t.deadlines.map(d => ({...d, to: dayDiff(parseDate(d.date), n)})).sort((a,b) => a.to - b.to);
  const reds = dls.filter(d => d.to <= d.redLead);
  if (reds.length) {
    const d = reds[0], what = d.label || 'the deadline';
    return {c:'r', label: d.to < 0 ? 'Past deadline' : 'Deadline soon', big: d.to < 0 ? days(-d.to) : d.to === 0 ? 'Today' : days(d.to),
      sub: d.to < 0 ? `past ${what}` : d.to === 0 ? `${d.label || 'deadline'} is today` : `until ${what}`, reds, dls, toYellow};
  }
  if (toYellow <= 0) return {c:'y', label:'Check in', big: toYellow === 0 ? 'Today' : days(-toYellow), sub: toYellow === 0 ? 'check-in is due' : 'overdue for check-in', reds, dls, toYellow};
  return {c:'g', label:'All good', big: days(toYellow), sub:'until check-in is due', reds, dls, toYellow};
}
/* Resting: green tiles that are far from needing anything are hidden by default. */
function restWindow(t){
  if (t.visibility === 'always') return null;
  if (typeof t.visibility === 'number') return t.visibility;
  return t.interval >= 180 && !t.subtasks.length ? 90 : null; // automatic: yearly-type tasks with no steps
}
function restInfo(t, s){
  const w = restWindow(t); if (w === null || s.c !== 'g') return null;
  const next = Math.min(s.toYellow, ...s.dls.map(d => d.to - d.redLead));
  return next > w ? {appearsIn: next - w} : null;
}
function progress(t){
  const st = t.subtasks; if (!st.length) return null;
  const w = s => s.est > 0 ? s.est : 1, tot = st.reduce((a,s)=>a+w(s),0);
  return Math.round(100 * st.filter(s=>s.done).reduce((a,s)=>a+w(s),0) / tot);
}
function dial(p, size=46, stroke=5, cls=''){
  const r = (size-stroke)/2, c = 2*Math.PI*r;
  return `<div class="dial ${cls}" style="width:${size}px;height:${size}px" aria-label="${p}% complete">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
    <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c*p/100} ${c}" transform="rotate(-90 ${size/2} ${size/2})"/></svg>
    <div class="pct">${p}%</div></div>`;
}
const host = u => { if (/^shortcuts:/i.test(u)) return 'Opens an app on this device'; try { return new URL(u).hostname.replace(/^www\./,''); } catch(e) { return u; } };
const live = () => Object.values(T).filter(t => !t.archived).map(norm);
const task = id => norm(T[id]);
const filesOf = id => Object.values(F).filter(f => f.taskId === id).sort((a,b) => a.ts - b.ts);
const histOf = id => Object.values(H).filter(e => e.taskId === id).sort((a,b) => b.ts - a.ts);
const notesOf = id => Object.values(N).filter(e => e.taskId === id).sort((a,b) => b.ts - a.ts);
const openTodos = () => Object.values(TD).filter(x => !x.done).sort((a,b) => a.ts - b.ts);

/* ---------- Starter tasks ---------- */
function starters(){
  const y = new Date().getFullYear(); let apr = new Date(y,3,30); if (apr.getTime() < Date.now()) apr = new Date(y+1,3,30);
  return [
    {name:'Personal Taxes', interval:30, criteria:'Every tax slip or receipt that arrived this month is saved here, and any questions from the accountant are answered.',
     deadlines:[{id:'d0', label:'Tax filing', date:isoDate(apr), redLead:30, repeat:'yearly'}],
     links:[{label:'CRA My Account',url:'https://www.canada.ca/en/revenue-agency/services/e-services/digital-services-individuals/account-individuals.html'},{label:'CRA important dates',url:'https://www.canada.ca/en/revenue-agency/services/tax/individuals/topics/important-dates-individuals.html'}],
     subtasks:[{name:'Gather T4s and slips',actions:'Download T4, T5 and RRSP slips from CRA My Account and the bank.',est:2},{name:'Collect receipts',actions:'Medical, donations, childcare. Add photos or PDFs to Files.',est:3},{name:'Send package to accountant',actions:'Email the slips and receipts with a short note.',est:0.5},{name:'Review and sign return',actions:'Check the summary and sign the authorization.',est:1}]},
    {name:'Home Insurance', interval:365, criteria:'Renewal reviewed, coverage amounts confirmed, and payment set up.', links:[]},
    {name:'Vehicle Service', interval:90, criteria:'Oil change and inspection done, and the receipt is saved here.', links:[{label:'ICBC',url:'https://www.icbc.com/'},{label:'Transport Canada recalls',url:'https://tc.canada.ca/en/road-transportation/motor-vehicle-safety/recalls'}]},
    {name:'Monthly Banking Review', interval:30, criteria:'All accounts reviewed, no unknown charges, and bills scheduled for the month.', links:[]},
    {name:'Family Dental', interval:180, criteria:'Cleanings booked for everyone, and claims submitted to the benefits plan.', links:[]}
  ];
}
function starterSheet(){
  const list = starters(), have = new Set(Object.values(T).map(t => t.name));
  sheet(`<div class="stack"><h2>Add starter tasks</h2><p class="muted" style="margin:0">Pick the ones that fit. You can edit everything afterwards, including links, contacts and deadlines.</p>
    ${list.map((s,i) => `<label class="toggle"><input type="checkbox" data-st="${i}" ${have.has(s.name)?'':'checked'}> <span>${h(s.name)}<small class="muted" style="display:block;font-weight:500;font-size:13px">Every ${days(s.interval)}${have.has(s.name) ? ' · you already have this one' : ''}</small></span></label>`).join('')}
    <div class="wiz-foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="yes">Add tasks</button></div></div>`,
  () => { $('#no').onclick = closeSheet;
    $('#yes').onclick = () => {
      const picks = [...document.querySelectorAll('[data-st]')].filter(c => c.checked).map(c => list[+c.dataset.st]);
      picks.forEach(s => { const t = {id:uid(), lastDone:now(), deadlines:[], contacts:[], subtasks:[], archived:false, visibility:'auto', ...s};
        t.subtasks = t.subtasks.map(x => ({id:uid(), done:false, ms:0, ...x})); put(t); log(t.id, 'Created'); });
      closeSheet(); toast(`Added ${picks.length} ${picks.length===1?'task':'tasks'}`); };
  });
}

/* ---------- Views ---------- */
let view = {name:'dash'};
function go(v){ view = v; render(); window.scrollTo(0,0); }
let deferred = false;
function render(){
  const a = document.activeElement; // don't rebuild the page under someone who is typing; catch up when they finish
  if (loadState === 'ok' && a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
    if (!deferred) { deferred = true; a.addEventListener('blur', () => { deferred = false; setTimeout(render, 0); }, {once:true}); }
    return;
  }
  if (loadState === 'signedout') return renderSignIn();
  if (loadState !== 'ok') return renderStatus();
  if (view.name === 'detail' && T[view.id]) renderDetail(task(view.id));
  else if (view.name === 'todo') renderTodo();
  else renderDash();
  renderTimer();
}
function renderStatus(){
  const msg = {loading:['Loading your tasks',''], slow:['Still connecting','Your tasks will appear as soon as the connection comes through.'],
    setup:['Almost ready','This copy of the Control Room is not connected to Firebase yet. Fill in config.js using the steps in the setup guide, then upload the folder again.'],
    denied:['This account does not have access','You are signed in as ' + (user && user.email || 'an unknown account') + ', which is not one of the two accounts allowed in the security rules.'],
    error:['Your tasks could not load','Check your connection and open the app again.']}[loadState];
  $('#app').innerHTML = `<div class="top"><div><div class="eyebrow">${fmtDate(now())}</div><h1>Control Room</h1></div></div>
    <div class="summary" style="flex-direction:column;align-items:flex-start"><div><div class="big">${msg[0]}</div>${msg[1] ? `<div class="muted" style="font-size:14px;margin-top:4px">${h(msg[1])}</div>` : ''}</div>
    ${user && (loadState === 'denied' || loadState === 'error') ? '<button class="btn" id="so">Sign out</button>' : ''}</div>`;
  if ($('#so')) $('#so').onclick = () => signOut(auth);
}
function renderSignIn(){
  $('#app').innerHTML = `<form class="signin" id="sf" novalidate>
      <img class="logo" src="icon-192.png" alt="">
      <div><h1 style="font-size:24px">Control Room</h1><p class="muted" style="margin:4px 0 0;font-size:14px">Sign in with your family account.</p></div>
      <div class="field"><label for="se">Email</label><input class="input" id="se" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></div>
      <div class="field"><label for="sp">Password</label><input class="input" id="sp" type="password" autocomplete="current-password" required></div>
      <p class="err" id="serr" hidden></p>
      <button class="btn primary block" id="sbtn" type="submit">Sign in</button>
      <button class="btn ghost" id="sforgot" type="button">Forgot password?</button>
    </form>`;
  const err = m => { $('#serr').textContent = m; $('#serr').hidden = !m; };
  const why = e => ({'auth/invalid-credential':'That email and password do not match.', 'auth/wrong-password':'That email and password do not match.', 'auth/user-not-found':'That email and password do not match.',
    'auth/invalid-email':'Enter a valid email address.', 'auth/too-many-requests':'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed':'No connection. Check your internet and try again.', 'auth/user-disabled':'This account has been turned off.'}[e && e.code] || 'Sign-in did not work. Try again.');
  $('#sf').onsubmit = async e => {
    e.preventDefault(); err('');
    const em = $('#se').value.trim(), pw = $('#sp').value;
    if (!em || !pw) return err('Enter your email and password.');
    $('#sbtn').disabled = true; $('#sbtn').textContent = 'Signing in…';
    try { await signInWithEmailAndPassword(auth, em, pw); }
    catch(x) { err(why(x)); $('#sbtn').disabled = false; $('#sbtn').textContent = 'Sign in'; }
  };
  $('#sforgot').onclick = async () => {
    const em = $('#se').value.trim(); if (!em) { err('Enter your email first, then tap Forgot password.'); $('#se').focus(); return; }
    try { await sendPasswordResetEmail(auth, em); err(''); toast('If that account exists, a reset email is on its way.'); }
    catch(x) { err(why(x)); }
  };
}
function topBar(tab){
  const n = openTodos().length, off = typeof navigator !== 'undefined' && navigator.onLine === false;
  return `<div class="top"><div><div class="eyebrow">${fmtDate(now())}${off ? '<span class="offline">Offline · changes sync later</span>' : ''}</div><h1>Control Room</h1></div>
      <button class="who" id="acct" aria-label="Account"><span class="avatar">${h((myName[0] || '?').toUpperCase())}</span>${h(firstName(myName))}</button></div>
    <div class="seg" role="tablist"><button role="tab" class="${tab==='dash'?'on':''}" data-tab="dash" aria-selected="${tab==='dash'}">Tiles</button>
      <button role="tab" class="${tab==='todo'?'on':''}" data-tab="todo" aria-selected="${tab==='todo'}">To-do${n ? `<span class="n">${n}</span>` : ''}</button></div>`;
}
function bindTabs(){
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go({name:b.dataset.tab}));
  if ($('#acct')) $('#acct').onclick = accountSheet;
}
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());

function renderDash(){
  view = {name:'dash'};
  const order = {r:0,y:1,g:2};
  const all = live().map(t => { const s = status(t); return {t, s, rest: restInfo(t, s)}; })
    .sort((a,b) => order[a.s.c]-order[b.s.c] || (!!a.rest - !!b.rest) || (a.s.toYellow - b.s.toYellow));
  const visible = all.filter(x => showResting || !x.rest), resting = all.filter(x => x.rest);
  const n = c => all.filter(x => x.s.c === c).length, attention = n('r') + n('y');
  const archived = Object.values(T).filter(t => t.archived);
  $('#app').innerHTML = topBar('dash') + (all.length ? `
    <div class="summary"><div class="big">${attention ? `${attention} ${attention===1?'task needs':'tasks need'} attention` : 'Everything is on track'}</div>
      <div class="counts"><span class="count"><i class="dot r"></i>${n('r')}</span><span class="count"><i class="dot y"></i>${n('y')}</span><span class="count"><i class="dot g"></i>${n('g')}</span></div></div>
    <div class="grid">${visible.map(({t,s,rest}) => tileHTML(t,s,rest)).join('')}
      <button class="add-tile" id="add"><span class="plus">+</span>New task</button></div>
    ${resting.length ? `<div class="rest-bar"><span>${resting.length} resting ${resting.length===1?'tile':'tiles'} not due for a while</span><button class="btn sm" id="rest">${showResting ? 'Hide resting tiles' : 'Show all tiles'}</button></div>` : ''}`
    : `<div class="summary" style="flex-direction:column;align-items:flex-start;gap:14px"><div><div class="big">Set up your Control Room</div>
        <div class="muted" style="font-size:14px;margin-top:4px">Each task becomes a tile that stays green while you keep up with it, turns yellow when a check-in is due, and turns red as a hard deadline gets close.</div></div>
        <div class="demo-row"><button class="btn primary" id="starters">Add starter tasks</button><button class="btn" id="add">Create a task</button></div></div>`) + `
    <div class="demo-row" style="margin-top:22px">
      ${archived.length ? `<button class="btn sm ghost" id="archived">Archived (${archived.length})</button>` : ''}
      ${all.length ? '<button class="btn sm ghost" id="starters">Add starter tasks</button>' : ''}</div>
    <p class="note" style="margin-top:10px">Press and hold a tile, or tap ⋯, for quick access to its links and contacts. Only your two family accounts can see this.</p>`;
  bindTabs();
  if ($('#add')) $('#add').onclick = () => openWizard();
  document.querySelectorAll('#starters').forEach(b => b.onclick = starterSheet);
  if ($('#archived')) $('#archived').onclick = archivedSheet;
  if ($('#rest')) $('#rest').onclick = () => { showResting = !showResting; ls.set('fcr-show-resting', showResting); render(); };
  document.querySelectorAll('.tile').forEach(bindTile);
}
function tileHTML(t, s, rest){
  const p = progress(t), links = t.links, cls = rest ? 'rest' : s.c;
  const dl = s.c === 'r' ? s.reds[0] : s.dls[0];
  return `<div class="tile ${cls}" data-id="${t.id}" tabindex="0" role="button" aria-label="${h(t.name)}, ${rest ? 'resting' : s.label}">
    <div class="tile-head"><div class="tile-name">${h(t.name)}</div>${rest ? `<span class="pill rest">Resting</span>` : `<span class="pill ${s.c}"><i class="dot ${s.c}"></i>${s.label}</span>`}</div>
    <div class="tile-mid"><div class="countdown"><b>${s.big}</b><span>${s.sub}${rest ? ` · back on the dashboard in ${days(rest.appearsIn)}` : ''}</span></div>${p!==null ? dial(p) : ''}</div>
    ${dl ? `<div class="deadline">${h(dl.label || 'Deadline')} <strong>${fmtDate(parseDate(dl.date))}</strong>${s.dls.length > 1 ? ` · +${s.dls.length-1} more` : ''}</div>` : ''}
    <div class="chips" style="padding-right:44px;min-height:36px">${links.slice(0,2).map(l => `<a class="chip" href="${h(l.url)}" target="_blank" rel="noopener" data-stop><span>${h(l.label)}</span>${ICON.link}</a>`).join('')}
      ${links.length > 2 ? `<button class="chip more" data-quick="${t.id}" data-stop>+${links.length-2} more</button>` : ''}</div>
    <button class="icon-btn more-btn" data-quick="${t.id}" data-stop aria-label="Quick access for ${h(t.name)}">${ICON.more}</button></div>`;
}
function bindTile(el){
  let timer = null, fired = false;
  const id = el.dataset.id;
  el.addEventListener('pointerdown', e => { if (e.target.closest('[data-stop]')) return; fired = false; timer = setTimeout(() => { fired = true; quickSheet(task(id)); }, 480); });
  ['pointerup','pointerleave','pointercancel','pointermove'].forEach(ev => el.addEventListener(ev, e => { if (ev==='pointermove' && Math.abs(e.movementX)+Math.abs(e.movementY) < 4) return; clearTimeout(timer); }));
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('click', e => {
    const q = e.target.closest('[data-quick]'); if (q) { e.stopPropagation(); quickSheet(task(q.dataset.quick)); return; }
    if (e.target.closest('[data-stop]')) return;
    if (fired) { fired = false; return; }
    go({name:'detail', id, from:'dash'});
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) go({name:'detail', id, from:'dash'}); });
}

/* ---------- Account ---------- */
function nameSheet(first){
  sheet(`<div class="stack"><h2>${first ? 'Welcome' : 'Your name'}</h2>
    <p class="muted" style="margin:0;font-size:14px">${first ? 'What should the Control Room call you? Your name shows on history, notes and to-dos.' : 'This name shows on history, notes and to-dos.'}</p>
    <div class="field"><label for="nm">Name</label><input class="input" id="nm" autocomplete="given-name" value="${h(NAMES[myId] || '')}" enterkeyhint="done"></div>
    <div class="wiz-foot"><button class="btn" id="no">${first ? 'Later' : 'Cancel'}</button><button class="btn primary" id="yes">Save</button></div></div>`,
  () => { const i = $('#nm'); $('#no').onclick = closeSheet;
    const save = () => { const v = i.value.trim(); if (!v) return toast('Enter a name');
      NAMES[myId] = myName = v; closeSheet(); render(); db.doc('people/' + myId).set({name: v}, {merge: true}).catch(writeErr); };
    $('#yes').onclick = save; i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); }); });
}
function accountSheet(){
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  sheet(`<div class="stack"><div><div class="eyebrow">Signed in</div><h2 style="margin-top:4px">${h(NAMES[myId] || myName)}</h2><div class="muted" style="font-size:14px">${h(user.email || '')}</div></div>
    <div class="list">
      <button class="row" id="a-name" style="width:100%;border:0;background:none;text-align:left"><span class="main"><span class="t">Change your name</span></span></button>
      <button class="row" id="a-pw" style="width:100%;border:0;border-top:1px solid var(--line);background:none;text-align:left"><span class="main"><span class="t">Change password</span><span class="s" style="display:block">We email you a secure link</span></span></button>
      <button class="row" id="a-bk" style="width:100%;border:0;border-top:1px solid var(--line);background:none;text-align:left"><span class="main"><span class="t">Save a backup</span><span class="s" style="display:block">Tasks, history, notes, to-dos and saved emails as one file. Photos and PDFs are not included.</span></span></button>
      <button class="row" id="a-im" style="width:100%;border:0;border-top:1px solid var(--line);background:none;text-align:left"><span class="main"><span class="t">Import</span><span class="s" style="display:block">Bring in tasks from the Claude version or from a backup file</span></span></button>
    </div>
    ${standalone ? '' : '<p class="note" style="margin:0">Tip: tap Share, then Add to Home Screen, to open the Control Room like an app.</p>'}
    <div class="wiz-foot"><button class="btn danger" id="a-out">Sign out</button><button class="btn primary" id="a-ok">Done</button></div></div>`,
  () => {
    $('#a-ok').onclick = closeSheet;
    $('#a-name').onclick = () => nameSheet(false);
    $('#a-pw').onclick = async () => { try { await sendPasswordResetEmail(auth, user.email); toast('Check your email for a link to set a new password'); } catch(e) { toast('Could not send the email. Try again.'); } };
    $('#a-bk').onclick = backup;
    $('#a-im').onclick = importSheet;
    $('#a-out').onclick = () => confirmSheet('Sign out?', 'You will need your email and password to sign back in on this device.', 'Sign out', () => signOut(auth));
  });
}
async function backup(){
  const strip = o => Object.fromEntries(Object.entries(o).map(([k,v]) => [k, Object.fromEntries(Object.entries(v).filter(([f]) => f !== 'thumb'))]));
  const data = {app:'family-control-room', version:1, exportedAt:new Date().toISOString(), tasks:T, history:H, notes:N, todos:TD, files:strip(F), people:NAMES};
  const name = `control-room-backup-${isoDate(now())}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, {type:'application/json'});
  try { if (navigator.canShare && navigator.canShare({files:[file]})) { await navigator.share({files:[file], title:name}); return; } } catch(e) { if (e && e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  toast('Backup saved');
}

/* ---------- Import (from the Claude version's export, or from a backup) ----------
   Items keep their original IDs, so importing the same file twice updates rather than duplicates. */
let importing = false;
function importSheet(){
  sheet(`<div class="stack"><h2>Import</h2>
    <p class="muted" style="margin:0;font-size:14px">Choose the export file from the Claude version, or a backup saved from this app. Tasks that are already here are updated, not duplicated.</p>
    <label class="toggle"><input type="checkbox" id="im-mine" checked> <span>Items in the file were made by me<small class="muted" style="display:block;font-weight:500;font-size:13px">Shows them as yours in history and to-dos. Untick if your partner is importing her own file.</small></span></label>
    <label class="btn primary block" for="im-file">Choose file<input id="im-file" type="file" hidden></label>
    <details><summary class="muted" style="font-size:14px;font-weight:600;cursor:pointer;padding:4px 0">Or paste copied text</summary>
      <div class="stack" style="margin-top:8px"><textarea class="input" id="im-text" placeholder="Paste the export text here"></textarea>
      <button class="btn block" id="im-paste">Import pasted text</button></div></details>
    <p class="note" id="im-status" style="margin:0" hidden></p>
    <button class="btn ghost" id="im-no">Close</button></div>`,
  () => {
    $('#scrim').dataset.lock = '1';
    $('#im-no').onclick = () => { if (importing) return toast('Import is still running'); closeSheet(); };
    $('#im-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await runImport(await f.text()); } catch(x) { imStatus('That file could not be read.'); } e.target.value = ''; };
    $('#im-paste').onclick = () => runImport($('#im-text').value);
  });
}
function imStatus(msg){ const el = $('#im-status'); if (el) { el.textContent = msg; el.hidden = !msg; } }
async function runImport(text){
  if (importing) return;
  let d; try { d = JSON.parse(String(text || '').trim()); } catch(e) { return imStatus('That does not look like a Control Room export. Make sure you copied all of it.'); }
  if (!d || d.app !== 'family-control-room' || typeof d.tasks !== 'object') return imStatus('That does not look like a Control Room export.');
  importing = true;
  const mineBox = $('#im-mine'), remap = d.previousOwner && (!mineBox || mineBox.checked) ? d.previousOwner : null;
  const own = v => { if (!remap) return v; const c = {...v}; ['who','by','doneBy'].forEach(k => { if (c[k] === remap) c[k] = myId; }); return c; };
  const n = {tasks:0, history:0, notes:0, todos:0, emails:0, files:0, skipped:0};
  const strip = o => { const c = own({...o}); delete c.id; delete c.url; delete c.data; delete c.pending; delete c.previewUrl; return JSON.parse(JSON.stringify(c)); };
  try {
    imStatus('Importing tasks…');
    for (const [coll, key] of [['tasks','tasks'],['history','history'],['notes','notes'],['todos','todos']]) {
      const rows = Object.entries(d[key] || {});
      await Promise.all(rows.map(([id, v]) => setDoc(doc(fs, coll, id), strip(v))));
      n[key] = rows.length;
    }
    const people = Object.entries(d.people || {}).filter(([id, name]) => id && name && id !== myId && id !== remap && !NAMES[id]);
    await Promise.all(people.map(([id, name]) => setDoc(doc(fs, 'people', id), {name, imported:true}, {merge:true})));
    const files = Object.entries(d.files || {});
    let i = 0;
    for (const [id, f] of files) {
      i++;
      if (F[id]) continue; // already imported
      if (f.type === 'text/email') { await setDoc(doc(fs, 'files', id), strip(f)); n.emails++; continue; }
      if (f.data) {
        imStatus(`Copying photos and PDFs · ${i} of ${files.length}`);
        try {
          const blob = await (await fetch(f.data)).blob();
          const r = await assets.upload(new File([blob], f.name || 'file', {type: f.type || blob.type}));
          const fd = {taskId:f.taskId, name:r.name, type:r.contentType, size:r.sizeBytes, assetId:r.id, chunks:r.chunks, ts:f.ts || Date.now(), by:own(f).by || ''};
          if (r.thumb) fd.thumb = r.thumb;
          await setDoc(doc(fs, 'files', id), fd); n.files++;
        } catch(e) { n.skipped++; }
        continue;
      }
      if (f.assetId && f.chunks) { await setDoc(doc(fs, 'files', id), strip(f)); n.files++; continue; } // from this app's own backup
      n.skipped++;
    }
    const parts = [`${n.tasks} ${n.tasks === 1 ? 'task' : 'tasks'}`, n.todos && `${n.todos} to-dos`, n.notes && `${n.notes} notes`, n.emails && `${n.emails} emails`, n.files && `${n.files} photos and PDFs`].filter(Boolean);
    imStatus(`Done. Imported ${parts.join(', ')}.${n.skipped ? ` ${n.skipped} ${n.skipped === 1 ? 'file' : 'files'} could not be copied.` : ''}`);
    toast('Import finished');
  } catch(e) {
    imStatus(e && e.code === 'permission-denied' ? 'This account is not allowed to make changes.' : 'The import stopped part way, probably because the connection dropped. Run it again: anything already imported is skipped or updated.');
  } finally { importing = false; }
}

/* ---------- To-do list ---------- */
function todoRow(x){
  const t = x.taskId && T[x.taskId];
  const meta = [t ? h(t.name) : '', x.done ? `Done by ${h(whoName(x.doneBy))} ${fmtShort(x.doneAt)}` : `Added by ${h(whoName(x.by))} ${fmtShort(x.ts)}`].filter(Boolean).join(' · ');
  return `<div class="todo ${x.done?'done':''}"><button class="check ${x.done?'on':''}" data-td="${x.id}" aria-label="Mark ${h(x.text)} ${x.done?'not done':'done'}">${x.done?ICON.tick:''}</button>
    <div class="main" data-tdedit="${x.id}"><div class="t">${h(x.text)}</div><div class="s">${meta}</div></div></div>`;
}
function taskOptions(sel){ return `<option value="">No task</option>` + live().sort((a,b)=>a.name.localeCompare(b.name)).map(t => `<option value="${t.id}" ${t.id===sel?'selected':''}>${h(t.name)}</option>`).join(''); }
function bindTodoRows(){
  document.querySelectorAll('[data-td]').forEach(b => b.onclick = () => { const x = TD[b.dataset.td]; const d = !x.done;
    putIn('todos', TD, x.id, {...x, done:d, doneAt: d ? Date.now() : null, doneBy: d ? (myId||'') : null}); });
  document.querySelectorAll('[data-tdedit]').forEach(b => b.onclick = () => todoSheet(TD[b.dataset.tdedit]));
}
function addTodo(text, taskId){
  text = text.trim(); if (!text) return;
  const id = uid(); putIn('todos', TD, id, {text, taskId: taskId || null, done:false, ts:Date.now(), by: myId || ''});
  if (taskId) log(taskId, `Added to-do "${text}"`);
}
function renderTodo(){
  view = {name:'todo'};
  const need = live().map(t => ({t, s:status(t)})).filter(x => x.s.c !== 'g').sort((a,b) => (a.s.c === 'r' ? 0 : 1) - (b.s.c === 'r' ? 0 : 1));
  const open = openTodos(), weekAgo = Date.now() - 7*DAY;
  const done = Object.values(TD).filter(x => x.done).sort((a,b) => (b.doneAt||0) - (a.doneAt||0));
  const recent = done.filter(x => (x.doneAt||0) >= weekAgo);
  $('#app').innerHTML = topBar('todo') + `
    <div class="section"><div class="addrow"><input class="input" id="td-text" placeholder="Add a to-do (tap the keyboard mic to dictate)" enterkeyhint="done">
      <select class="input" id="td-task" style="flex:0 1 200px;min-width:140px" aria-label="Link to a task">${taskOptions('')}</select>
      <button class="btn primary" id="td-add">Add</button></div></div>
    <section class="section"><div class="section-head"><h2>For this week's meeting</h2><button class="btn sm ghost" id="td-copy">Copy as text</button></div>
      <div class="list">${need.length ? need.map(({t,s}) => `<button class="row" data-open="${t.id}" style="width:100%;border:0;border-top:1px solid var(--line);background:none;text-align:left"><i class="dot ${s.c}"></i><span class="main"><span class="t">${h(t.name)}</span><span class="s" style="display:block">${s.label} · ${s.big} ${s.sub}</span></span></button>`).join('') : '<div class="empty">No tiles need attention right now.</div>'}</div></section>
    <section class="section"><div class="section-head"><h2>To do</h2><span class="muted num" style="font-size:13px">${open.length}</span></div>
      <div class="list">${open.length ? open.map(todoRow).join('') : '<div class="empty">Nothing on the list. Add items above as they come up during the week.</div>'}</div></section>
    ${done.length ? `<section class="section"><div class="section-head"><h2>Done this week</h2><button class="btn sm ghost" id="td-clear">Clear done items</button></div>
      <div class="list">${recent.length ? recent.map(todoRow).join('') : '<div class="empty">Nothing finished in the last 7 days.</div>'}</div></section>` : ''}`;
  bindTabs(); bindTodoRows();
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => go({name:'detail', id:b.dataset.open, from:'todo'}));
  const add = () => { if (document.activeElement) document.activeElement.blur(); addTodo($('#td-text').value, $('#td-task').value); };
  $('#td-add').onclick = add; $('#td-text').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  $('#td-copy').onclick = () => {
    const lines = [`Control Room · ${fmtDate(now())}`, '', 'Needs attention:', ...(need.length ? need.map(({t,s}) => `- ${t.name}: ${s.label}, ${s.big} ${s.sub}`) : ['- Nothing']),
      '', 'To do:', ...(open.length ? open.map(x => `- ${x.text}${x.taskId && T[x.taskId] ? ` (${T[x.taskId].name})` : ''}`) : ['- Nothing']),
      '', 'Done this week:', ...(recent.length ? recent.map(x => `- ${x.text}`) : ['- Nothing'])];
    copy(lines.join('\n'));
  };
  if ($('#td-clear')) $('#td-clear').onclick = () => confirmSheet('Clear done items?', `${done.length} finished ${done.length===1?'item':'items'} will be removed for both of you.`, 'Clear', () => done.forEach(x => delIn('todos', TD, x.id)));
}
function todoSheet(x){
  if (!x) return;
  sheet(`<div class="stack"><h2>Edit to-do</h2>
    <div class="field"><label for="te-text">To-do</label><textarea class="input" id="te-text">${h(x.text)}</textarea></div>
    <div class="field"><label for="te-task">Task</label><select class="input" id="te-task">${taskOptions(x.taskId)}</select></div>
    <div class="wiz-foot"><button class="btn danger" id="te-del">Delete</button><button class="btn primary" id="te-save">Save</button></div></div>`,
  () => { $('#te-del').onclick = () => { closeSheet(); delIn('todos', TD, x.id); toast('To-do deleted'); };
    $('#te-save').onclick = () => { const text = $('#te-text').value.trim(); if (!text) return toast('Write something, or delete the to-do');
      closeSheet(); putIn('todos', TD, x.id, {...x, text, taskId: $('#te-task').value || null}); }; });
}

/* ---------- Detail ---------- */
function contactHTML(c, t){
  const subj = encodeURIComponent(t.name);
  return `<div class="contact"><div><div class="t" style="font-weight:600">${h(c.name)}</div>${c.role ? `<div class="s muted" style="font-size:13px">${h(c.role)}</div>` : ''}</div>
    ${c.emails.map(e => `<div class="c-line">${e.label ? `<span class="c-lab">${h(e.label)}</span>` : ''}<span class="addr">${h(e.value)}</span>
      <a class="btn sm primary" href="googlegmail:///co?to=${encodeURIComponent(e.value)}&subject=${subj}">Gmail</a>
      <a class="btn sm" href="mailto:${h(e.value)}?subject=${subj}">Mail</a>
      <button class="btn sm ghost" data-copy="${h(e.value)}">Copy</button></div>`).join('')}
    ${c.phones.map(p => `<div class="c-line">${p.label ? `<span class="c-lab">${h(p.label)}</span>` : ''}<span class="addr num">${h(p.value)}</span>
      <a class="btn sm primary" href="tel:${h(p.value.replace(/[^\d+]/g,''))}">Call</a>
      <button class="btn sm ghost" data-copy="${h(p.value)}">Copy</button></div>`).join('')}</div>`;
}
const isNote = f => f.type === 'text/email';
const isImg = f => (f.type||'').startsWith('image/');
const fileCls = f => isNote(f) ? 'note' : isImg(f) && (f.thumb || f.previewUrl) ? 'has-img' : '';
const extOf = f => (f.name.split('.').pop()||'FILE').toUpperCase();
function fileInner(f){
  if (isNote(f)) return `${ICON.mail}<span class="nm">${h(f.name)}</span>${f.from ? `<span class="fr">${h(f.from.replace(/<.*>/,'').trim())}</span>` : ''}`;
  if (isImg(f) && (f.thumb || f.previewUrl)) return `<img src="${h(f.thumb || f.previewUrl)}" alt="${h(f.name)}" loading="lazy">`;
  if (f.pending) return `<span class="ext">${h(extOf(f))}</span><span>${h(f.name)}</span><span class="fr">Uploads on save</span>`;
  return `<span class="ext">${h(extOf(f))}</span><span>${h(f.name)}</span>`;
}
function renderDetail(t){
  const s = status(t), p = progress(t), files = filesOf(t.id), hist = histOf(t.id), notes = notesOf(t.id);
  const tds = Object.values(TD).filter(x => x.taskId === t.id && !x.done);
  const totalMs = t.subtasks.reduce((a,x)=>a+(x.ms||0),0) + (t.extraMs||0);
  const estH = t.subtasks.reduce((a,x)=>a+(+x.est||0),0);
  const myTimer = MY.timer && MY.timer.taskId === t.id;
  const from = view.from || 'dash';
  $('#app').innerHTML = `
    <button class="back" id="back">${ICON.back} ${from === 'todo' ? 'To-do' : 'Control Room'}</button>
    <div class="d-head"><h1>${h(t.name)}</h1><button class="btn" id="edit">Edit</button></div>
    <div class="hero ${s.c}">
      <div class="hero-top"><div class="countdown"><span class="pill ${s.c}" style="align-self:flex-start;margin-bottom:8px"><i class="dot ${s.c}"></i>${s.label}</span><b>${s.big}</b><span>${s.sub}</span></div>${p!==null ? dial(p,92,9,'lg') : ''}</div>
      <div class="deadline">Last check-in <strong>${fmtDate(t.lastDone)}</strong> · every ${days(t.interval)}
        ${s.dls.map(d => `<span class="dl-line">${h(d.label || 'Hard deadline')} <strong>${fmtDate(parseDate(d.date))}</strong> · red ${days(d.redLead)} before${d.repeat !== 'none' ? ' · ' + REPEAT[d.repeat].toLowerCase() : ''}</span>`).join('')}</div>
      <div class="hero-actions"><button class="btn primary" id="done">Mark as done</button><button class="btn" id="timer">${myTimer && !MY.timer.subId ? 'Timer running' : ICON.play + ' Start timer'}</button></div></div>

    <section class="section"><div class="section-head"><h2>Links</h2><span class="muted num" style="font-size:13px">${t.links.length}</span></div>
      <div class="list">${t.links.length ? t.links.map(l => `<a class="row" href="${h(l.url)}" target="_blank" rel="noopener"><span class="favicon">${h((l.label.trim()[0]||'?').toUpperCase())}</span><span class="main"><span class="t">${h(l.label)}</span><span class="s" style="display:block">${h(host(l.url))}</span></span>${ICON.link}</a>`).join('') : '<div class="empty">No links yet. Add them with Edit.</div>'}</div></section>

    <section class="section"><div class="section-head"><h2>Contacts</h2></div>
      <div class="list">${t.contacts.length ? t.contacts.map(c => contactHTML(c,t)).join('') : '<div class="empty">No contacts yet. Add them with Edit.</div>'}</div></section>

    ${t.subtasks.length ? `<section class="section"><div class="section-head"><h2>Subtasks</h2><span class="muted num" style="font-size:13px">${fmtDur(totalMs)} logged of ~${estH}h estimated</span></div>
      <div class="list">${t.subtasks.map(x => `<div class="sub ${x.done?'done':''}"><button class="check ${x.done?'on':''}" data-sub="${x.id}" aria-label="Mark ${h(x.name)} ${x.done?'not done':'done'}">${x.done?ICON.tick:''}</button>
        <div class="main" style="flex:1;min-width:0"><div class="t" style="font-weight:600">${h(x.name)}</div>${x.actions ? `<div class="s muted" style="font-size:13.5px">${h(x.actions)}</div>` : ''}
        <div class="s muted num" style="font-size:12.5px;margin-top:3px">Est. ${x.est||0}h · logged ${fmtDur(x.ms||0)}</div></div>
        ${x.done ? '' : `<button class="btn sm" data-subtimer="${x.id}" aria-label="Start timer for ${h(x.name)}">${MY.timer && MY.timer.subId===x.id ? 'Running' : ICON.play}</button>`}</div>`).join('')}</div></section>` : ''}

    <section class="section"><div class="section-head"><h2>To-dos</h2><button class="btn sm ghost" id="addtd">+ Add</button></div>
      <div class="list">${tds.length ? tds.map(todoRow).join('') : '<div class="empty">No open to-dos for this task.</div>'}</div></section>

    <section class="section"><div class="section-head"><h2>What counts as done</h2></div><div class="criteria">${h(t.criteria) || '<span class="muted">No criteria set.</span>'}</div></section>

    <section class="section"><div class="section-head"><h2>Files</h2><span class="muted num" style="font-size:13px">${files.length}</span></div>
      <div class="files">${files.map(f => `<button class="file ${fileCls(f)}" data-file="${f.id}">${fileInner(f)}</button>`).join('')}
        <button class="file upload" id="paste">+ Paste email</button>
        <label class="file upload" for="up">+ Photo or PDF<input id="up" type="file" accept="image/*,application/pdf" multiple hidden></label></div></section>

    <section class="section hist"><div class="section-head"><h2>History</h2></div>
      <div class="list">${hist.length ? hist.slice(0,12).map(e => `<div class="row"><span class="main">${h(e.text)}</span><span class="muted num" style="font-size:13px;white-space:nowrap">${h(whoName(e.who))} · ${fmtShort(e.ts)}</span></div>`).join('') : '<div class="empty">Nothing yet.</div>'}</div></section>

    <button class="btn ghost danger" id="archive">Archive task</button>

    <details class="notes" id="notes" ${notesOpen.has(t.id) ? 'open' : ''}><summary>Notes${notes.length ? ` (${notes.length})` : ''}</summary>
      <div class="stack" style="margin:8px 0 6px"><textarea class="input" id="note-text" placeholder="Type, or tap the microphone on your keyboard to dictate">${h(noteDrafts[t.id] || '')}</textarea>
        <div><button class="btn sm primary" id="note-save">Save note</button></div></div>
      ${notes.map(n => `<div class="note-item"><p>${h(n.text)}<small>${h(whoName(n.by))} · ${fmtDate(n.ts)}</small></p><button class="x" data-delnote="${n.id}" aria-label="Delete note">×</button></div>`).join('')}
    </details>`;
  $('#back').onclick = () => go({name: from});
  $('#notes').addEventListener('toggle', e => { e.target.open ? notesOpen.add(t.id) : notesOpen.delete(t.id); });
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
  document.querySelectorAll('[data-file]').forEach(b => b.onclick = () => fileSheet(t, F[b.dataset.file]));
  bindTodoRows();
  $('#edit').onclick = () => openWizard(t.id);
  $('#done').onclick = () => doneSheet(t);
  $('#timer').onclick = () => startTimer(t.id, null);
  $('#addtd').onclick = () => quickTodoSheet(t);
  $('#archive').onclick = () => confirmSheet('Archive this task?', 'It leaves the dashboard for both of you. Its history and files are kept, and you can restore it from Archived.', 'Archive', () => { t.archived = true; put(t); log(t.id,'Archived'); go({name:'dash'}); toast('Task archived'); });
  document.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => { const x = t.subtasks.find(y=>y.id===b.dataset.sub); x.done = !x.done; put(t); log(t.id, x.done ? `Marked "${x.name}" done` : `Reopened "${x.name}"`); });
  document.querySelectorAll('[data-subtimer]').forEach(b => b.onclick = () => startTimer(t.id, b.dataset.subtimer));
  $('#up').onchange = e => uploadFiles(t.id, [...e.target.files]);
  $('#paste').onclick = () => pasteSheet(note => saveNote(t.id, note), () => {});
  const nt = $('#note-text');
  nt.addEventListener('input', () => noteDrafts[t.id] = nt.value);
  $('#note-save').onclick = () => { nt.blur(); const text = nt.value.trim(); if (!text) return toast('Write or dictate a note first');
    delete noteDrafts[t.id]; notesOpen.add(t.id); putIn('notes', N, uid(), {taskId:t.id, text, ts:Date.now(), by:myId||''}); toast('Note saved'); };
  document.querySelectorAll('[data-delnote]').forEach(b => b.onclick = () => confirmSheet('Delete this note?', 'It will be removed for both of you.', 'Delete', () => delIn('notes', N, b.dataset.delnote)));
}
const notesOpen = new Set(), noteDrafts = {};
function quickTodoSheet(t){
  sheet(`<div class="stack"><h2>Add to-do</h2><p class="muted" style="margin:0;font-size:14px">Linked to ${h(t.name)}. It also appears on the To-do list for your weekly meeting.</p>
    <div class="field"><label for="qt-text">To-do</label><input class="input" id="qt-text" placeholder="Type, or tap the keyboard mic to dictate" enterkeyhint="done"></div>
    <div class="wiz-foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="yes">Add</button></div></div>`,
  () => { const i = $('#qt-text'); i.focus(); $('#no').onclick = closeSheet;
    const go_ = () => { if (!i.value.trim()) return; addTodo(i.value, t.id); closeSheet(); toast('Added to the to-do list'); };
    $('#yes').onclick = go_; i.addEventListener('keydown', e => { if (e.key === 'Enter') go_(); }); });
}

/* ---------- Files ---------- */
let uploading = Promise.resolve();
function uploadFiles(taskId, files){
  // one at a time, so progress messages stay readable
  uploading = uploading.then(async () => {
    for (const f of files) {
      if (f.size > 40 * 1048576) { toast(`${f.name} is too large (over 40 MB)`); continue; }
      toast(`Preparing ${f.name}…`);
      try {
        const r = await assets.upload(f, (i, n) => { if (n > 1) toast(`Uploading ${f.name} · ${Math.round(100 * i / n)}%`); });
        const id = uid(), d = {taskId, name:r.name, type:r.contentType, size:r.sizeBytes, assetId:r.id, chunks:r.chunks, ts:Date.now(), by:myId || ''};
        if (r.thumb) d.thumb = r.thumb;
        F[id] = {id, ...d}; render();
        await db.doc('files/' + id).set(d); log(taskId, `Added file ${r.name}`); toast('Saved to Files');
      } catch(e) {
        toast(e && e.code === 'too_large' ? `${f.name} is over 20 MB, even after shrinking. Try a smaller copy.` : e && e.code === 'permission-denied' ? 'This account is not allowed to add files.' : `${f.name} did not upload. Check your connection and try again.`);
      }
    }
  });
  return uploading;
}
function saveNote(taskId, note){
  const id = uid(), d = {taskId, ...note, by: myId || ''};
  F[id] = {id, ...d}; render();
  db.doc('files/' + id).set(d).then(() => { log(taskId, `Saved email "${note.name}"`); toast('Email saved to Files'); }).catch(writeErr);
}
function parseMail(text){
  const grab = re => { const m = text.match(re); return m ? m[1].trim() : ''; };
  return { subject: grab(/^\s*Subject:\s*(.+)$/mi), from: grab(/^\s*From:\s*(.+)$/mi), sent: grab(/^\s*(?:Date|Sent):\s*(.+)$/mi) };
}
function pasteSheet(onSave, onCancel){
  sheet(`<div class="stack"><h2>Paste an email</h2>
    <p class="muted" style="margin:0;font-size:14px">In Gmail, select the message text, tap Copy, then paste it here. If you copy the From, Date and Subject lines too, they are picked up automatically.</p>
    <div class="field"><label for="p-title">Title</label><input class="input" id="p-title" placeholder="e.g. Accountant's instructions for this year"></div>
    <div class="field"><label for="p-text">Email text</label><textarea class="input big" id="p-text" placeholder="Paste the email here"></textarea></div>
    <div class="wiz-foot"><button class="btn" id="p-no">Cancel</button><button class="btn primary" id="p-ok" disabled>Save to Files</button></div></div>`,
  () => {
    $('#scrim').dataset.lock = '1';
    const ta = $('#p-text'), ti = $('#p-title');
    const sync = () => { $('#p-ok').disabled = !ta.value.trim(); const m = parseMail(ta.value); if (!ti.dataset.touched && m.subject) ti.value = m.subject; };
    ta.addEventListener('input', sync); ti.addEventListener('input', () => ti.dataset.touched = '1');
    ta.focus();
    $('#p-no').onclick = () => { closeSheet(); onCancel(); };
    $('#p-ok').onclick = () => {
      const text = ta.value.trim().slice(0, 200000), m = parseMail(text);
      const first = text.split('\n').find(l => l.trim()) || 'Email';
      const name = ti.value.trim() || m.subject || first.slice(0, 60);
      closeSheet(); onSave({name, type:'text/email', size:text.length, text, from:m.from, sent:m.sent, ts:Date.now()});
    };
  });
}
function fileSheet(t, f){
  if (!f) return;
  const rm = () => confirmSheet('Remove this file?', `"${f.name}" will be removed for both of you.`, 'Remove', async () => {
    delete F[f.id]; render();
    try { await db.doc('files/' + f.id).delete(); if (f.assetId) await assets.delete(f).catch(() => {}); log(t.id, `Removed ${isNote(f) ? 'email' : 'file'} "${f.name}"`); } catch(e) { writeErr(e); } });
  const foot = `<div class="wiz-foot"><button class="btn danger" id="rm">Remove</button>${isNote(f) ? '<button class="btn" id="cp">Copy text</button>' : ''}<button class="btn primary" id="ok">Close</button></div>`;
  let body;
  if (isNote(f)) body = `<div class="eyebrow">Saved email</div><h2 style="overflow-wrap:anywhere">${h(f.name)}</h2>
      ${f.from || f.sent ? `<dl class="meta">${f.from ? `<dt>From</dt><dd>${h(f.from)}</dd>` : ''}${f.sent ? `<dt>Sent</dt><dd>${h(f.sent)}</dd>` : ''}</dl>` : ''}
      <div class="mailtext">${h(f.text)}</div>`;
  else body = `<h2 style="overflow-wrap:anywhere">${h(f.name)}</h2>
      ${isImg(f) ? `<img id="fv-img" src="${h(f.thumb || '')}" alt="${h(f.name)}" ${f.thumb ? '' : 'hidden'}>` : ''}
      <div class="two"><a class="btn" id="fv-open" target="_blank" rel="noopener" aria-disabled="true">Loading…</a><button class="btn" id="fv-share" disabled>Share or save</button></div>`;
  sheet(`<div class="stack imgview">${body}<div class="muted" style="font-size:13px">Added ${fmtDate(f.ts)}${f.by ? ' by ' + h(whoName(f.by)) : ''}${f.size && !isNote(f) ? ' · ' + fmtSize(f.size) : ''}</div>${foot}</div>`,
    () => { $('#ok').onclick = closeSheet; if ($('#cp')) $('#cp').onclick = () => copy(f.text); $('#rm').onclick = rm;
      if (isNote(f) || !f.assetId) return;
      assets.load(f).then(({blob, url}) => {
        if (!$('#fv-open')) return;
        const im = $('#fv-img'); if (im) { im.src = url; im.hidden = false; }
        const o = $('#fv-open'); o.href = url; o.removeAttribute('aria-disabled'); o.innerHTML = `Open ${h(extOf(f))} ${ICON.link}`;
        const file = new File([blob], f.name, {type: f.type});
        const sh = $('#fv-share');
        if (navigator.canShare && navigator.canShare({files:[file]})) { sh.disabled = false; sh.onclick = () => navigator.share({files:[file], title:f.name}).catch(() => {}); }
        else { sh.disabled = false; sh.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }; }
      }).catch(() => { const o = $('#fv-open'); if (o) o.textContent = navigator.onLine === false ? 'Available when online' : 'Could not load the file'; });
    });
}

/* ---------- Sheets ---------- */
function sheet(html, onMount){
  const L = $('#layer');
  L.innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div></div>`;
  $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim' && !e.target.dataset.lock) closeSheet(); });
  onMount && onMount($('.sheet'));
}
function closeSheet(){ $('#layer').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#scrim') && !$('#scrim').dataset.lock) closeSheet(); });
function confirmSheet(title, body, action, fn){
  sheet(`<div class="stack"><h2>${h(title)}</h2><p class="muted" style="margin:0">${h(body)}</p>
    <div class="wiz-foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="yes">${h(action)}</button></div></div>`,
    () => { $('#no').onclick = closeSheet; $('#yes').onclick = () => { closeSheet(); fn(); }; });
}
function quickSheet(t){
  if (!t) return; const s = status(t);
  sheet(`<div class="stack"><div><span class="pill ${s.c}" style="background:var(--${s.c}-bg)"><i class="dot ${s.c}"></i>${s.label} · ${s.big}</span><h2 style="margin-top:8px">${h(t.name)}</h2></div>
    ${t.links.length ? `<div><div class="lbl" style="margin-bottom:6px">Links</div><div class="list">${t.links.map(l => `<a class="row" href="${h(l.url)}" target="_blank" rel="noopener"><span class="favicon">${h((l.label.trim()[0]||'?').toUpperCase())}</span><span class="main"><span class="t">${h(l.label)}</span><span class="s" style="display:block">${h(host(l.url))}</span></span>${ICON.link}</a>`).join('')}</div></div>` : ''}
    ${t.contacts.length ? `<div><div class="lbl" style="margin-bottom:6px">Contacts</div><div class="list">${t.contacts.map(c => contactHTML(c,t)).join('')}</div></div>` : ''}
    <div class="two"><button class="btn" id="qtimer">${ICON.play} Start timer</button><button class="btn primary" id="qopen">Open task</button></div></div>`,
    () => { $('#qopen').onclick = () => { closeSheet(); go({name:'detail', id:t.id, from:'dash'}); };
      $('#qtimer').onclick = () => { closeSheet(); startTimer(t.id, null); };
      document.querySelectorAll('.sheet [data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy)); });
}
function doneSheet(t){
  const reds = status(t).reds;
  sheet(`<div class="stack"><h2>Mark ${h(t.name)} as done</h2>
    <div class="criteria">${h(t.criteria) || 'No criteria set for this task.'}</div>
    ${reds.length ? `<div class="lbl">Deadlines this covers</div>${reds.map(d => `<label class="toggle"><input type="checkbox" data-met="${h(d.id)}" checked> <span>${h(d.label || 'Deadline')} · ${fmtDate(parseDate(d.date))}<small class="muted" style="display:block;font-weight:500;font-size:13px">${d.repeat === 'none' ? 'Will be cleared' : 'Moves to ' + fmtDate(parseDate(nextDate(d)))}</small></span></label>`).join('')}` : ''}
    <label class="toggle"><input type="checkbox" id="agree"> I confirm this has been done</label>
    <div class="wiz-foot"><button class="btn" id="no">Cancel</button><button class="btn primary" id="yes" disabled>Mark as done</button></div></div>`,
    () => { $('#agree').onchange = e => $('#yes').disabled = !e.target.checked; $('#no').onclick = closeSheet;
      $('#yes').onclick = () => {
        const met = new Set([...document.querySelectorAll('[data-met]')].filter(c => c.checked).map(c => c.dataset.met));
        t.deadlines = t.deadlines.flatMap(d => {
          if (!met.has(d.id)) return [d];
          const name = d.label || 'Deadline';
          if (d.repeat === 'none') { log(t.id, `${name} ${fmtDate(parseDate(d.date))} met`); return []; }
          const nd = nextDate(d); log(t.id, `${name} met; next ${fmtDate(parseDate(nd))}`); return [{...d, date: nd}];
        });
        t.lastDone = now(); log(t.id, 'Checked in and confirmed done'); put(t); closeSheet(); toast(`${t.name} is up to date`); }; });
}
function archivedSheet(){
  const a = Object.values(T).filter(t => t.archived);
  sheet(`<div class="stack"><h2>Archived tasks</h2><div class="list">${a.map(t => `<div class="row"><span class="main t">${h(t.name)}</span><button class="btn sm" data-restore="${t.id}">Restore</button></div>`).join('')}</div>
    <button class="btn block" id="ok">Close</button></div>`,
    () => { $('#ok').onclick = closeSheet; document.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => { const t = task(b.dataset.restore); t.archived = false; put(t); log(t.id,'Restored'); closeSheet(); toast(`${t.name} restored`); }); });
}

/* ---------- Wizard ---------- */
const STEPS = [
  {k:'basics', title:'The basics', hint:'Name the task, how often it needs a check-in, and when its tile should show.'},
  {k:'deadline', title:'Hard deadlines', hint:'Optional. Add one for each date, such as two car renewals. The tile turns red a set number of days before each.'},
  {k:'links', title:'Links', hint:'Websites you open for this task. The first two appear on the tile.'},
  {k:'contacts', title:'Contacts', hint:'People you email or call about this task. Add as many emails and numbers as you need.'},
  {k:'subtasks', title:'Subtasks', hint:'Optional. Break the job into steps with rough time estimates. The dial fills by estimated hours.'},
  {k:'files', title:'Files', hint:'Emails, photos, screenshots and PDFs for this task.'},
  {k:'review', title:'Review', hint:'Check everything, then save.'}
];
const lines = arr => arr.map(x => x.label ? `${x.label}: ${x.value}` : x.value).join('\n');
const parseLines = txt => String(txt||'').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const m = l.match(/^([^:@]{1,20}):\s*(.+)$/); return m ? {label:m[1].trim(), value:m[2].trim()} : {label:'', value:l}; });
let W = null;
function openWizard(id){
  const src = id ? task(id) : null;
  const d = src ? JSON.parse(JSON.stringify(src)) : {name:'', interval:30, criteria:'', deadlines:[], links:[{label:'',url:''}], contacts:[], subtasks:[], visibility:'auto'};
  d.contacts = d.contacts.map(c => ({name:c.name, role:c.role, emailsText: lines(c.emails), phonesText: lines(c.phones)}));
  d.visMode = typeof d.visibility === 'number' ? 'days' : d.visibility; d.visDays = typeof d.visibility === 'number' ? d.visibility : 90;
  W = {step:0, id, pending:[], d};
  renderWizard();
}
function collect(){
  document.querySelectorAll('.sheet [data-f]').forEach(el => {
    const f = el.dataset.f; W.d[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value; });
  document.querySelectorAll('.sheet [data-l]').forEach(el => {
    const row = W.d[el.dataset.l][+el.dataset.i]; if (row) row[el.dataset.k] = el.type === 'number' ? +el.value : el.value; });
}
function rowsHTML(key, fields, label){
  return W.d[key].map((r,i) => `<div class="rowcard"><div class="rc-head"><span class="lbl">${label} ${i+1}</span><span style="display:flex;gap:4px">
      ${i>0 ? `<button class="btn sm ghost" data-up="${key}:${i}" aria-label="Move up">↑</button>` : ''}
      <button class="btn sm ghost danger" data-rm="${key}:${i}">Remove</button></span></div>
    ${fields.map(f => {
      const a = `data-l="${key}" data-i="${i}" data-k="${f.k}" id="${key}-${i}-${f.k}" aria-label="${f.ph}"`;
      const field = f.select ? `<select class="input" ${a}>${Object.entries(f.select).map(([v,l]) => `<option value="${v}" ${r[f.k]===v?'selected':''}>${l}</option>`).join('')}</select>`
        : f.area ? `<textarea class="input" placeholder="${f.ph}" ${a}>${h(r[f.k])}</textarea>`
        : `<input class="input" type="${f.type||'text'}" ${f.type==='number'?'step="0.5" min="0" inputmode="decimal"':''} placeholder="${f.ph}" value="${h(r[f.k])}" ${a}>`;
      return f.lab ? `<div class="field"><label for="${key}-${i}-${f.k}">${f.lab}</label>${field}</div>` : field;
    }).join('')}</div>`).join('');
}
function stepBody(k){
  const d = W.d;
  if (k === 'basics') return `
    <div class="field"><label for="w-name">Task name</label><input class="input" id="w-name" data-f="name" value="${h(d.name)}" placeholder="e.g. Personal Taxes"></div>
    <div class="field"><label for="w-int">Days until the tile turns yellow without a check-in</label><input class="input num" id="w-int" type="number" min="1" inputmode="numeric" data-f="interval" value="${d.interval}">
      <div class="presets">${[[7,'Weekly'],[30,'Monthly'],[90,'Quarterly'],[180,'6 months'],[365,'Yearly']].map(([v,l]) => `<button class="btn sm ${d.interval==v?'primary':''}" data-preset="${v}">${l}</button>`).join('')}</div></div>
    <div class="field"><label for="w-crit">What counts as done</label><textarea class="input" id="w-crit" data-f="criteria" placeholder="You'll confirm this each time before the tile turns green.">${h(d.criteria)}</textarea></div>
    <div class="field"><label for="w-vis">When to show the tile</label>
      <select class="input" id="w-vis" data-f="visMode">
        <option value="auto" ${d.visMode==='auto'?'selected':''}>Automatic: yearly tasks without subtasks rest until 90 days before</option>
        <option value="always" ${d.visMode==='always'?'selected':''}>Always show</option>
        <option value="days" ${d.visMode==='days'?'selected':''}>Show only when it's close</option></select>
      <div id="vis-days" class="field" ${d.visMode==='days'?'':'hidden'}><label for="w-vd">Show this many days before a check-in or deadline</label><input class="input num" type="number" min="1" inputmode="numeric" id="w-vd" data-f="visDays" value="${d.visDays}"></div></div>`;
  if (k === 'deadline') return (d.deadlines.length ? '' : '<p class="muted" style="margin:0">No hard deadlines. Skip this step if the task has none.</p>') +
    rowsHTML('deadlines',[{k:'label',ph:'Name, e.g. Car 1 insurance',lab:'Name (optional)'},{k:'date',ph:'Date',type:'date',lab:'Date'},{k:'redLead',ph:'Days before',type:'number',lab:'Turn red this many days before'},{k:'repeat',ph:'Repeats',select:REPEAT,lab:'Repeats'}],'Deadline') +
    `<button class="btn" data-add="deadlines">+ Add deadline</button>`;
  if (k === 'links') return rowsHTML('links',[{k:'label',ph:'Name, e.g. CRA My Account'},{k:'url',ph:'https://…',type:'url'}],'Link') + `<button class="btn" data-add="links">+ Add link</button>`;
  if (k === 'contacts') return rowsHTML('contacts',[{k:'name',ph:'Name'},{k:'role',ph:'Role, e.g. Accountant'},
      {k:'emailsText',ph:'One per line, e.g. Work: name@example.com',area:true,lab:'Emails'},{k:'phonesText',ph:'One per line, e.g. Cell: 604-555-0100',area:true,lab:'Phone numbers'}],'Contact') +
    `<button class="btn" data-add="contacts">+ Add contact</button>`;
  if (k === 'subtasks') return (d.subtasks.length ? '' : '<p class="muted" style="margin:0">No subtasks. Skip this step if the task is a single job.</p>') +
    rowsHTML('subtasks',[{k:'name',ph:'Subtask name'},{k:'actions',ph:'Actions required',area:true},{k:'est',ph:'Estimated hours',type:'number'}],'Subtask') + `<button class="btn" data-add="subtasks">+ Add subtask</button>`;
  if (k === 'files') {
    const existing = W.id ? filesOf(W.id) : [];
    const pend = W.pending.map(p => p.note ? p.note : {name:p.file.name, type:p.file.type, pending:true, previewUrl:p.preview});
    return `<div class="files">${existing.concat(pend).map(f => `<div class="file ${fileCls(f)}">${fileInner(f)}</div>`).join('')}
    <button class="file upload" id="w-paste">+ Paste email</button>
    <label class="file upload" for="w-up">+ Photo or PDF<input id="w-up" type="file" accept="image/*,application/pdf" multiple hidden></label></div>
    <p class="muted" style="margin:0;font-size:13px">Paste an email copied from Gmail, or add photos, screenshots and PDFs from Photos, the camera or Files. New files are saved when you finish.</p>`;
  }
  const links = d.links.filter(l => l.url), subs = d.subtasks.filter(x => x.name), dls = d.deadlines.filter(x => x.date);
  return `<div class="review"><dl>
    <dt>Name</dt><dd>${h(d.name) || '<span style="color:var(--r)">Missing</span>'}</dd>
    <dt>Check-in</dt><dd>Every ${days(d.interval)}</dd>
    <dt>Tile shows</dt><dd>${d.visMode==='always' ? 'Always' : d.visMode==='days' ? `${days(d.visDays)} before it's due` : 'Automatic'}</dd>
    <dt>Deadlines</dt><dd>${dls.length ? dls.map(x => `${h(x.label || 'Deadline')} ${fmtDate(parseDate(x.date))} (${REPEAT[x.repeat].toLowerCase()})`).join('<br>') : 'None'}</dd>
    <dt>Links</dt><dd>${links.length ? links.map(l => h(l.label||host(l.url))).join(', ') : 'None'}</dd>
    <dt>Contacts</dt><dd>${d.contacts.filter(c=>c.name).map(c=>h(c.name)).join(', ') || 'None'}</dd>
    <dt>Subtasks</dt><dd>${subs.length ? `${subs.length}, about ${subs.reduce((a,x)=>a+(+x.est||0),0)}h` : 'None'}</dd>
    <dt>New files</dt><dd>${W.pending.length}</dd></dl></div>`;
}
function renderWizard(){
  const st = STEPS[W.step], last = W.step === STEPS.length-1;
  sheet(`<div class="eyebrow">${W.id ? 'Edit task' : 'New task'} · Step ${W.step+1} of ${STEPS.length}</div>
    <div class="progress"><i style="width:${(W.step+1)/STEPS.length*100}%"></i></div>
    <h2 style="margin-top:10px">${st.title}</h2><p class="muted" style="margin:0 0 14px;font-size:14px">${st.hint}</p>
    <div class="stack">${stepBody(st.k)}</div>
    <div class="wiz-foot"><button class="btn" id="w-back">${W.step ? 'Back' : 'Cancel'}</button><button class="btn primary" id="w-next">${last ? (W.id ? 'Save changes' : 'Create task') : 'Next'}</button></div>`,
  sh => {
    $('#scrim').dataset.lock = '1';
    $('#w-back').onclick = () => { if (!W.step) { closeSheet(); return; } collect(); W.step--; renderWizard(); };
    $('#w-next').onclick = () => {
      collect();
      if (W.step === 0 && !W.d.name.trim()) { toast('Give the task a name'); $('#w-name').focus(); return; }
      if (W.step === 0 && !(W.d.interval > 0)) { toast('Enter at least 1 day'); return; }
      if (W.step === 1 && W.d.deadlines.some(x => !x.date)) { toast('Pick a date for each deadline, or remove the empty one'); return; }
      if (last) return saveWizard();
      W.step++; renderWizard(); };
    sh.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => { collect(); W.d.interval = +b.dataset.preset; renderWizard(); });
    const vis = $('#w-vis'); if (vis) vis.onchange = () => $('#vis-days').hidden = vis.value !== 'days';
    sh.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { collect(); const k = b.dataset.add;
      W.d[k].push(k==='links' ? {label:'',url:''} : k==='contacts' ? {name:'',role:'',emailsText:'',phonesText:''}
        : k==='deadlines' ? {id:uid(), label:'', date:'', redLead:14, repeat:'yearly'} : {id:uid(),name:'',actions:'',est:1,done:false,ms:0}); renderWizard(); });
    sh.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { collect(); const [k,i] = b.dataset.rm.split(':'); W.d[k].splice(+i,1); renderWizard(); });
    sh.querySelectorAll('[data-up]').forEach(b => b.onclick = () => { collect(); const [k,i] = b.dataset.up.split(':'), a = W.d[k]; [a[i-1],a[i]] = [a[i],a[i-1]]; renderWizard(); });
    const up = $('#w-up'); if (up) up.onchange = e => { [...e.target.files].forEach(f => W.pending.push({file:f, preview: (f.type||'').startsWith('image/') ? URL.createObjectURL(f) : null})); renderWizard(); };
    const wp = $('#w-paste'); if (wp) wp.onclick = () => pasteSheet(note => { W.pending.push({note}); renderWizard(); }, () => renderWizard());
  });
}
function saveWizard(){
  const d = W.d;
  const c = {
    name: d.name.trim(), interval: Math.max(1, Math.round(d.interval)), criteria: (d.criteria||'').trim(),
    visibility: d.visMode === 'days' ? Math.max(1, Math.round(d.visDays || 90)) : d.visMode,
    deadlines: d.deadlines.filter(x => x.date).map(x => ({id:x.id||uid(), label:(x.label||'').trim(), date:x.date, redLead:Math.max(0, Math.round(x.redLead||0)), repeat: REPEAT[x.repeat] ? x.repeat : 'none'})),
    links: d.links.filter(l => (l.url||'').trim()).map(l => { let u = l.url.trim(); if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; return {label: (l.label||'').trim() || host(u), url: u}; }),
    contacts: d.contacts.map(x => ({name:(x.name||'').trim(), role:(x.role||'').trim(), emails:parseLines(x.emailsText), phones:parseLines(x.phonesText)}))
      .filter(x => x.name || x.emails.length || x.phones.length).map(x => ({...x, name: x.name || (x.emails[0]||x.phones[0]).value})),
    subtasks: d.subtasks.filter(x => (x.name||'').trim()).map(x => ({id:x.id||uid(), name:x.name.trim(), actions:(x.actions||'').trim(), est:+x.est||0, done:!!x.done, ms:x.ms||0}))
  };
  let t;
  if (W.id) {
    t = task(W.id); const changes = [];
    if (t.name !== c.name) changes.push(`Renamed to "${c.name}"`);
    if (t.interval !== c.interval) changes.push(`Check-in interval changed ${t.interval} → ${c.interval} days`);
    if (JSON.stringify(t.deadlines) !== JSON.stringify(c.deadlines)) changes.push(c.deadlines.length ? 'Deadlines updated' : 'Deadlines removed');
    if (t.visibility !== c.visibility) changes.push('Tile visibility changed');
    if ((t.criteria||'') !== c.criteria) changes.push('Done criteria updated');
    if (JSON.stringify(t.links) !== JSON.stringify(c.links)) changes.push('Links updated');
    if (JSON.stringify(t.contacts) !== JSON.stringify(c.contacts)) changes.push('Contacts updated');
    if (JSON.stringify(t.subtasks.map(x=>[x.name,x.est,x.actions])) !== JSON.stringify(c.subtasks.map(x=>[x.name,x.est,x.actions]))) changes.push('Subtasks updated');
    t = {...t, ...c}; put(t); changes.forEach(x => log(t.id, x));
  } else {
    t = {id:uid(), lastDone: now(), archived:false, ...c}; put(t); log(t.id, 'Created');
  }
  const pending = W.pending, id = t.id, isNew = !W.id;
  closeSheet(); go({name:'detail', id, from:'dash'}); toast(isNew ? 'Task created' : 'Changes saved');
  pending.filter(p => p.note).forEach(p => saveNote(id, p.note));
  const blobs = pending.filter(p => p.file).map(p => p.file); if (blobs.length) uploadFiles(id, blobs);
}

/* ---------- Timer with check-in on return ---------- */
function startTimer(taskId, subId){
  if (MY.timer) { toast('Stop the running timer first'); return; }
  MY.timer = {taskId, subId: subId || null, startedAt: Date.now(), acc: 0, lastAct: Date.now()}; saveMe(); render();
  toast('Timer started. Leave the app and do the task.');
}
function timerLabel(){ const t = task(MY.timer.taskId); if (!t) return 'Task'; const s = MY.timer.subId && t.subtasks.find(x=>x.id===MY.timer.subId); return s ? `${t.name} · ${s.name}` : t.name; }
function elapsed(){ return MY.timer.acc + (Date.now() - MY.timer.startedAt); }
function stopTimer(ms){
  const TM = MY.timer, t = task(TM.taskId); MY.timer = null; saveMe();
  if (t && ms >= 60e3) { const s = TM.subId && t.subtasks.find(x=>x.id===TM.subId);
    if (s) s.ms = (s.ms||0) + ms; else t.extraMs = (t.extraMs||0) + ms;
    put(t); log(t.id, `Logged ${fmtDur(ms)}${s ? ` on ${s.name}` : ''}`); toast(`Saved ${fmtDur(ms)}`); }
  else if (t) toast('Under a minute, so nothing was logged');
  render();
}
let tick = null;
function renderTimer(){
  clearInterval(tick);
  if (!MY.timer || loadState !== 'ok') { $('#timerbar').innerHTML = ''; return; }
  $('#timerbar').innerHTML = `<div class="timerbar"><div class="inner"><i class="pulse"></i><div class="main"><div class="t">${h(timerLabel())}</div><div class="clock" id="clk">${clock(elapsed())}</div></div><button class="btn sm" id="stop">Stop and save</button></div></div>`;
  $('#stop').onclick = () => stopTimer(elapsed());
  tick = setInterval(() => { const c = $('#clk'); if (c && MY.timer) c.textContent = clock(elapsed()); }, 1000);
}
let lastSaveAct = 0, checking = false;
['pointerdown','keydown','scroll'].forEach(ev => window.addEventListener(ev, () => {
  if (!MY.timer || checking) return;
  if (Date.now() - MY.timer.lastAct > AWAY_MS) { checkReturn(); return; }
  MY.timer.lastAct = Date.now(); if (Date.now() - lastSaveAct > 60e3) { lastSaveAct = Date.now(); saveMe(); }
}, {passive:true, capture:true}));
function checkReturn(){
  if (!myLoaded || !MY.timer || checking || loadState !== 'ok' || Date.now() < snoozeUntil) return;
  if (Date.now() - MY.timer.lastAct <= AWAY_MS) return;
  checking = true;
  const all = elapsed(), until = Math.max(0, MY.timer.acc + (MY.timer.lastAct - MY.timer.startedAt));
  let pick = 'all';
  sheet(`<div class="stack"><div class="eyebrow">Welcome back</div><h2>Timer has been running ${fmtDur(all)}</h2>
    <p class="muted" style="margin:0">How much of that was work on <strong style="color:var(--ink)">${h(timerLabel())}</strong>?</p>
    <button class="choice on" data-pick="all"><span>Keep all of it<small>${fmtDur(all)}</small></span>${ICON.tick}</button>
    <button class="choice" data-pick="until"><span>Keep until I left the app<small>${fmtDur(until)}</small></span></button>
    <button class="choice" data-pick="custom"><span>Enter the actual time<small>Hours and minutes</small></span></button>
    <div class="two" id="custom" hidden><div class="field"><label for="ch">Hours</label><input class="input num" id="ch" type="number" min="0" inputmode="numeric" value="${Math.floor(until/36e5)}"></div>
      <div class="field"><label for="cm">Minutes</label><input class="input num" id="cm" type="number" min="0" max="59" inputmode="numeric" value="${Math.round(until/60e3)%60}"></div></div>
    <div class="wiz-foot"><button class="btn" id="cont">Keep timing</button><button class="btn primary" id="fin">Stop and save</button></div>
    <div class="demo-row" style="justify-content:space-between"><button class="btn sm ghost" id="later">Decide later</button><button class="btn sm ghost danger" id="discard">Discard this timer</button></div></div>`,
  () => {
    const done = () => { checking = false; snoozeUntil = Date.now() + 5000; closeSheet(); };
    $('#later').onclick = () => { done(); snoozeUntil = Date.now() + 10 * 60e3; };
    $('#discard').onclick = () => { done(); MY.timer = null; saveMe(); render(); toast('Timer discarded. Nothing was logged.'); };
    $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim') { done(); snoozeUntil = Date.now() + 10 * 60e3; } });
    $('#scrim').dataset.lock = '1';
    document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { pick = b.dataset.pick;
      document.querySelectorAll('[data-pick]').forEach(x => { x.classList.toggle('on', x===b); const ic = x.querySelector('svg'); if (ic) ic.remove(); });
      b.insertAdjacentHTML('beforeend', ICON.tick); $('#custom').hidden = pick !== 'custom'; });
    const chosen = () => pick === 'all' ? all : pick === 'until' ? until : ((+$('#ch').value||0)*36e5 + (+$('#cm').value||0)*60e3);
    $('#cont').onclick = () => { const ms = chosen(); done(); if (!MY.timer) return render(); MY.timer.acc = ms; MY.timer.startedAt = Date.now(); MY.timer.lastAct = Date.now(); saveMe(); render(); toast(`Kept ${fmtDur(ms)}. Timer continues.`); };
    $('#fin').onclick = () => { const ms = chosen(); done(); if (!MY.timer) return render(); try { stopTimer(ms); } catch(e) { MY.timer = null; saveMe(); render(); } };
  });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { checkReturn(); render(); } });
window.addEventListener('focus', () => checkReturn());

/* ---------- Utilities ---------- */
let toastT;
function toast(msg){ const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2800); }
function copy(text){
  const fallback = () => { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch(e) { toast('Select the text to copy it'); } ta.remove(); };
  try { navigator.clipboard.writeText(text).then(() => toast('Copied'), fallback); } catch(e) { fallback(); }
}
boot();
