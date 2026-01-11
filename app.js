
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const uid = (p='id') => p + '_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const nowEn = () => new Date().toLocaleString('en-US', { hour12: true });
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const deepCopy = (x) => JSON.parse(JSON.stringify(x));
  const debounce = (fn, wait=200) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  };

  
  // ---------- firebase (Auth + Profiles) ----------
  // Firebase Web config is not a secret, but keeping it out of the repo helps prevent accidental leaks.
  // We load it from Vercel Serverless Function: GET /api/firebase-config
  let FIREBASE_CONFIG = null;

  async function loadFirebaseConfig(){
    if(FIREBASE_CONFIG) return FIREBASE_CONFIG;

    // Optional: allow inline override (for local testing)
    if(window.__FIREBASE_CONFIG__ && window.__FIREBASE_CONFIG__.apiKey){
      FIREBASE_CONFIG = window.__FIREBASE_CONFIG__;
      return FIREBASE_CONFIG;
    }

    const res = await fetch('/api/firebase-config', { cache:'no-store' });
    if(!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new Error('FIREBASE_CONFIG_FETCH_FAILED ' + res.status + ' ' + txt);
    }
    const cfg = await res.json();
    if(!cfg || !cfg.apiKey || !cfg.projectId){
      throw new Error('FIREBASE_CONFIG_INVALID');
    }
    FIREBASE_CONFIG = cfg;
    return FIREBASE_CONFIG;
  }


  // Optional: set one email as the first super admin bootstrap (only if profile missing)
  const SUPER_ADMIN_EMAIL = "snimarbadr@gmail.com";
  const SUPER_ADMIN_USERNAME = "سنمار بدر";

  let fbApp = null;
  let db = null;
  let auth = null;

  function firebaseReady(){
    return (typeof firebase !== 'undefined') && !!firebase?.initializeApp;
  }

  async function initFirebase(){
    if(!firebaseReady()) return false;
    try{
      if(!FIREBASE_CONFIG){
        await loadFirebaseConfig();
      }
      fbApp = firebase.apps?.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      auth = firebase.auth();

      // Offline persistence (best-effort)
      try{
        db.enablePersistence({ synchronizeTabs:true }).catch(()=>{});
      }catch(_){}

      return true;
    }catch(err){
      console.error(err);
      return false;
    }
  }

  async function getProfile(uid){
    if(!db) return null;
    const snap = await db.collection('profiles').doc(uid).get();
    return snap.exists ? snap.data() : null;
  }

  async function upsertProfile(uid, data){
    if(!db) return;
    await db.collection('profiles').doc(uid).set(data, { merge:true });
  }

  async function listProfiles(){
    if(!db) return [];
    const qs = await db.collection('profiles').orderBy('createdAt', 'desc').limit(500).get();
    return qs.docs.map(d => ({ id:d.id, ...d.data() }));
  }

  // ---------- roles (normalize + gates) ----------
  function normalizeRole(r){
    const raw0 = String(r || '').trim();
    if(!raw0) return 'reader';

    const low = raw0.toLowerCase();
    const compact = low.replace(/[\s_-]/g,'');
    if(compact === 'superadmin' || compact === 'super') return 'super';
    if(compact === 'admin' || compact === 'administrator') return 'admin';
    if(compact === 'trainer' || compact === 'coach') return 'trainer';
    if(compact === 'reader' || compact === 'viewer' || compact === 'readonly') return 'reader';

    // Arabic aliases
    const raw = raw0.replace(/\s+/g,'');
    if(/سوبر/.test(raw)) return 'super';
    if(/(ادمن|أدمن|إدارة|الادارة|الاداره|اداره)/.test(raw)) return 'admin';
    if(/(مدرب|تدريب)/.test(raw)) return 'trainer';
    if(/(قارئ|مشاهد|قراءة)/.test(raw)) return 'reader';

    return 'reader';
  }


  function isSuperRole(){
    return normalizeRole(session?.role) === 'super';
  }
  function isAdminRole(){
    const r = normalizeRole(session?.role);
    return r === 'super' || r === 'admin';
  }
  function isTrainerRole(){
    const r = normalizeRole(session?.role);
    return r === 'super' || r === 'admin' || r === 'trainer';
  }
  function canManageUsers(){
    return isAdminRole();
  }

// ---------- intro splash ----------
  function initIntroSplash(){
    const el = document.getElementById('intro-splash');
    if(!el) return;
    const hide = () => {
      if(el.classList.contains('hide')) return;
      el.classList.add('hide');
      // remove from DOM after animation
      setTimeout(() => {
        try{ el.remove(); }catch(_){ el.style.display='none'; }
      }, 520);
    };
    // auto hide after 4 seconds
    setTimeout(hide, 4000);
    // allow click to skip
    el.addEventListener('click', hide, { once:true });
  }
  // run as soon as possible
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initIntroSplash, { once:true });
  }else{
    initIntroSplash();
  }

  function toast(msg){
    const t = $('#toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => (t.style.display='none'), 2200);
  }

  function confirmModal({title, message, okText='نعم', cancelText='إلغاء'}){
    return new Promise((resolve) => {
      openModal({
        title,
        body: `
          <div class="card" style="margin:0;">
            <div style="font-weight:900;margin-bottom:10px;">${escapeHtml(message)}</div>
          </div>
        `,
        foot: `
          <button class="btn primary" id="cm-ok">${escapeHtml(okText)}</button>
          <button class="btn" id="cm-cancel">${escapeHtml(cancelText)}</button>
        `,
        onReady: () => {
          $('#cm-ok').addEventListener('click', () => { closeModal(); resolve(true); });
          $('#cm-cancel').addEventListener('click', () => { closeModal(); resolve(false); });
        }
      });
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  
// ---------- realtime storage (Firestore) ----------
// تم إزالة LocalStorage بالكامل. كل البيانات (المرشحين/الأسئلة/الربط/الحضور/الحالة)
// محفوظة في Firestore وتعمل بتحديث مباشر بين الأجهزة عبر onSnapshot.

let pendingLoginUsername = ''; // used during login bootstrap (in-memory only)

// Candidate photos are transient (not saved to Firestore)
const photoCache = new Map(); // candidateId -> dataUrl

// Firestore listeners (unsub handlers)
let unsubConfig = null;
let unsubCandidates = null;
let unsubPresence = null;
let unsubStatus = null;

// ---------- quota + smart lock (estimated, to avoid UI freezing) ----------
const FIXED_LIMITS = {
  readsMax: 50000,
  writesMax: 50000,
  // no pre-warning gate; show maintenance only at the hard limit
  warnAt: null
};

const quota = {
  readsUsed: 0,
  writesUsed: 0,
  readsMax: FIXED_LIMITS.readsMax,
  writesMax: FIXED_LIMITS.writesMax,
  warnAtReads: FIXED_LIMITS.warnAt,
  warnAtWrites: FIXED_LIMITS.warnAt,
  // keep warnRatio for backward compatibility in status/config payloads
  warnRatio: 1.96,
  warn: false,
  locked: false,
  lockedReason: '',
  lockedUntilMs: 0,
  lastError: ''
};

function nextResetMs(){
  // Reset near local midnight (00:02) to avoid edge cases around exact midnight
  const d = new Date();
  d.setHours(24, 0, 2, 0);
  return d.getTime();
}

function fmtCountdown(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2,'0');
  if(h > 0) return `${h}:${pad(m)}:${pad(ss)}`;
  return `${m}:${pad(ss)}`;
}

let _countdownTimer = null;
let _countdownUntilMs = 0;

function setCountdownTarget(untilMs){
  _countdownUntilMs = Number(untilMs || 0);
  clearInterval(_countdownTimer);
  if(!_countdownUntilMs) return;

  const tick = () => {
    const rem = fmtCountdown(_countdownUntilMs - Date.now());
    const sb = document.getElementById('sb-countdown');
    if(sb) sb.textContent = rem;
    const lk = document.getElementById('lock-countdown');
    if(lk) lk.textContent = rem;

    if(Date.now() >= _countdownUntilMs){
      clearInterval(_countdownTimer);
      _countdownTimer = null;
    }
  };

  tick();
  _countdownTimer = setInterval(tick, 1000);
}

function bannerCountdownHtml(untilMs){
  const rem = fmtCountdown(Number(untilMs||0) - Date.now());
  return `<div class="sb-count">يعاد التفعيل بعد <b dir="ltr" id="sb-countdown">${escapeHtml(rem)}</b></div>`;
}


function setSystemBanner({type='info', title='', message='', actionsHtml='', untilMs=0} = {}){
  const el = document.getElementById('system-banner');
  if(!el) return;

  const _until = Number(untilMs || 0);
  if(_until){
    actionsHtml = actionsHtml || bannerCountdownHtml(_until);
    setCountdownTarget(_until);
  }else{
    setCountdownTarget(0);
  }

  el.className = `system-banner ${type}`;
  el.innerHTML = `
    <div class="sb-inner">
      <div class="sb-text">
        <div class="sb-title">${escapeHtml(title || '')}</div>
        <div class="sb-msg">${escapeHtml(message || '')}</div>
      </div>
      <div class="sb-actions">${actionsHtml || ''}</div>
    </div>
  `;
  el.style.display = 'block';
}

function clearSystemBanner(){
  const el = document.getElementById('system-banner');
  if(!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
  el.className = 'system-banner';
}

function setLockOverlay({locked=false, reason='', untilMs=0} = {}){
  const wrap = document.getElementById('lock-overlay');
  if(!wrap) return;

  if(!locked){
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }

  const rem = untilMs ? fmtCountdown(untilMs - Date.now()) : '';
  if(untilMs) setCountdownTarget(untilMs);

  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="lock-card">
      <div class="lock-title">تم إيقاف النظام مؤقتًا</div>
      <div class="lock-msg">${escapeHtml(reason || 'تم الوصول لحد الاستخدام اليومي.')}</div>
      <div class="lock-meta">
        ${untilMs ? `سيُفتح تلقائيًا بعد: <b dir="ltr" id="lock-countdown">${escapeHtml(rem)}</b>` : ''}
      </div>
      <div class="lock-actions">
        <button class="btn tiny" id="btn-lock-refresh">تحديث</button>
      </div>
    </div>
  `;
  const btn = document.getElementById('btn-lock-refresh');
  btn?.addEventListener('click', () => location.reload());
}

function updateWriteGatesUI(){
  const blockedAdds = quota.locked;

  const addCand = document.getElementById('btn-add-candidate');
  if(addCand){
    addCand.disabled = blockedAdds || !canEditCandidate();
    addCand.title = quota.locked ? 'يوجد صيانة مؤقتة — الرجاء المحاولة لاحقًا' : '';
  }

  const addUser = document.getElementById('btn-add-user');
  if(addUser){
    // only gate creation; editing still available
    addUser.disabled = blockedAdds || !canManageUsers();
    addUser.title = quota.locked ? 'يوجد صيانة مؤقتة — الرجاء المحاولة لاحقًا' : '';
  }
}

function recomputeWarn(){
  const waR = Number(quota.warnAtReads);
  const waW = Number(quota.warnAtWrites);
  const warnReads = (Number.isFinite(waR) && waR > 0) ? (quota.readsUsed >= waR) : false;
  const warnWrites = (Number.isFinite(waW) && waW > 0) ? (quota.writesUsed >= waW) : false;
  quota.warn = Boolean(warnReads || warnWrites);
}

function bumpReads(n=1){
  const prevWarn = quota.warn;
  quota.readsUsed += Math.max(0, Number(n)||0);
  recomputeWarn();
  updateWriteGatesUI();

  // Auto lock when we reach the hard limit (estimated)
  if(!quota.locked && quota.readsMax && quota.readsUsed >= quota.readsMax){
    lockApp('يوجد صيانة مؤقتة بسبب ضغط الاستخدام. يرجى المحاولة لاحقًا.', nextResetMs()).catch(()=>{});
  }

  if(prevWarn !== quota.warn){
    scheduleWarnStatusReport();
    applyLocalWarnUI();
  }
}

function bumpWrites(n=1){
  const prevWarn = quota.warn;
  quota.writesUsed += Math.max(0, Number(n)||0);
  recomputeWarn();
  updateWriteGatesUI();

  if(!quota.locked && quota.writesMax && quota.writesUsed >= quota.writesMax){
    lockApp('يوجد صيانة مؤقتة بسبب ضغط الاستخدام. يرجى المحاولة لاحقًا.', nextResetMs()).catch(()=>{});
  }

  if(prevWarn !== quota.warn){
    scheduleWarnStatusReport();
    applyLocalWarnUI();
  }
}

let _warnReportTimer = null;
function scheduleWarnStatusReport(){
  // only admins/super broadcast warn state to all devices
  if(!isAdminRole()) return;
  clearTimeout(_warnReportTimer);
  _warnReportTimer = setTimeout(() => {
    reportAppStatus({
      warn: quota.warn,
      warnUntilMs: nextResetMs(),
      readsUsed: quota.readsUsed,
      writesUsed: quota.writesUsed,
      readsMax: quota.readsMax,
      writesMax: quota.writesMax,
      warnAt: quota.warnAtReads
    }).catch(()=>{});
  }, 800);
}

function applyLocalWarnUI(){
  // Pre-warning at 48k removed by request; keep banner only for hard-lock at the limit.
  if(quota.warn){ quota.warn = false; }
}


function isQuotaError(err){
  const code = String(err?.code || err?.message || '').toLowerCase();
  return code.includes('resource-exhausted') || code.includes('quota') || code.includes('exceeded');
}

async function reportAppStatus(patch){
  // Best effort: write status so other devices see it (admins/super only)
  try{
    if(!db || !auth?.currentUser) return;
    if(!isAdminRole()) return;
    await db.collection('system').doc('appStatus').set({
      ...patch,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: {
        uid: auth.currentUser.uid,
        email: auth.currentUser.email || null,
        username: session?.username || null,
        role: normalizeRole(session?.role || 'reader')
      }
    }, { merge:true });
  }catch(_e){
    // ignore — status is best-effort
  }
}

async function lockApp(reason, untilMs){
  quota.locked = true;
  quota.lockedReason = reason || 'يوجد صيانة مؤقتة — الرجاء المحاولة لاحقًا.';
  quota.lockedUntilMs = untilMs || nextResetMs();

  setSystemBanner({
    type: 'danger',
    title: 'صيانة مؤقتة',
    message: quota.lockedReason,
    untilMs: quota.lockedUntilMs,
    actionsHtml: bannerCountdownHtml(quota.lockedUntilMs) + `
      <div class="sb-metric">قراءة: <b dir="ltr">${(quota.readsUsed||0).toLocaleString()}</b> / <b dir="ltr">${(quota.readsMax||0).toLocaleString()}</b></div>
      <div class="sb-metric">كتابة: <b dir="ltr">${(quota.writesUsed||0).toLocaleString()}</b> / <b dir="ltr">${(quota.writesMax||0).toLocaleString()}</b></div>
    `
  });
  setLockOverlay({ locked:true, reason: quota.lockedReason, untilMs: quota.lockedUntilMs });
  updateWriteGatesUI();

  // Stop heavy listeners to reduce reads
  try{ if(unsubCandidates){ unsubCandidates(); unsubCandidates=null; } }catch(_){}
  try{ if(unsubPresence){ unsubPresence(); unsubPresence=null; } }catch(_){}

  await reportAppStatus({
    locked: true,
    warn: false,
    reason: quota.lockedReason,
    untilMs: quota.lockedUntilMs,
    readsUsed: quota.readsUsed,
    writesUsed: quota.writesUsed,
    readsMax: quota.readsMax,
    writesMax: quota.writesMax,
    warnAt: quota.warnAtReads,
    warnRatio: quota.warnRatio
  });

  // Local auto unlock timer (Firestore status may also unlock it)
  clearTimeout(lockApp._tm);
  lockApp._tm = setTimeout(() => {
    if(Date.now() >= quota.lockedUntilMs){
      location.reload();
    }
  }, Math.max(1000, quota.lockedUntilMs - Date.now() + 250));
}

function applyRemoteStatus(data){
  if(!data) return;

  // Enforce fixed limits from code (do not override from Firestore)
  quota.readsMax = FIXED_LIMITS.readsMax;
  quota.writesMax = FIXED_LIMITS.writesMax;
  quota.warnAtReads = FIXED_LIMITS.warnAt;
  quota.warnAtWrites = FIXED_LIMITS.warnAt;
  quota.warnRatio = FIXED_LIMITS.readsMax ? (FIXED_LIMITS.warnAt / FIXED_LIMITS.readsMax) : quota.warnRatio;

  // If remote lock expired, auto-unlock (admin only) and reset counters
  const remoteLocked = Boolean(data.locked);
  const remoteUntil = Number(data.untilMs || 0);
  if(remoteLocked && remoteUntil && Date.now() >= remoteUntil){
    if(isAdminRole()){
      reportAppStatus({ locked:false, warn:false, reason:'', untilMs:0, readsUsed:0, writesUsed:0 }).catch(()=>{});
    }
    data = { ...data, locked:false, warn:false, readsUsed:0, writesUsed:0 };
  }

  // If remote warn expired, clear it (admin only)
  const remoteWarnFlag0 = Boolean(data.warn);
  const remoteWarnUntil0 = Number(data.warnUntilMs || 0);
  if(remoteWarnFlag0 && remoteWarnUntil0 && Date.now() >= remoteWarnUntil0){
    if(isAdminRole()){
      reportAppStatus({ warn:false, warnUntilMs:0, readsUsed:0, writesUsed:0 }).catch(()=>{});
    }
    data = { ...data, warn:false, readsUsed:0, writesUsed:0 };
  }

  // Sync counters if provided (used for showing the banner across devices)
  if(Number.isFinite(Number(data.readsUsed))) quota.readsUsed = Number(data.readsUsed);
  if(Number.isFinite(Number(data.writesUsed))) quota.writesUsed = Number(data.writesUsed);

  // Locked state
  if(Boolean(data.locked)){
    quota.locked = true;
    quota.lockedReason = String(data.reason || 'تم إيقاف النظام مؤقتًا.');
    quota.lockedUntilMs = Number(data.untilMs || nextResetMs());

    setSystemBanner({
      type:'danger',
      title:'النظام مقفل',
      message: quota.lockedReason,
      untilMs: quota.lockedUntilMs,
      actionsHtml: bannerCountdownHtml(quota.lockedUntilMs) + `
        <div class="sb-metric">قراءة: <b dir="ltr">${(quota.readsUsed||0).toLocaleString()}</b> / <b dir="ltr">${(quota.readsMax||0).toLocaleString()}</b></div>
        <div class="sb-metric">كتابة: <b dir="ltr">${(quota.writesUsed||0).toLocaleString()}</b> / <b dir="ltr">${(quota.writesMax||0).toLocaleString()}</b></div>
      `
    });

    setLockOverlay({ locked:true, reason: quota.lockedReason, untilMs: quota.lockedUntilMs });
  }else{
    quota.locked = false;
    quota.lockedReason = '';
    quota.lockedUntilMs = 0;
    setLockOverlay({ locked:false });
  }
  // Pre-warning removed: ignore warn state
  quota.warn = false;
  if(!quota.locked){
    clearSystemBanner();
  }

updateWriteGatesUI();
}

function normalizeCandidates(list){
    // Deduplicate primarily by nationalId (after removing spaces), fallback to id.
    const order = [];
    const seen = new Map();

    const cleanNid = (v) => String(v||'').replace(/[^\d]/g,'').trim();

    const ts = (c) => {
      const u = Date.parse(c?.updatedAt || '') || 0;
      const cr = Date.parse(c?.createdAt || '') || 0;
      return Math.max(u, cr);
    };

    (list || []).forEach(c => {
      if(!c || (!c.id && !c.nationalId)) return;

      const key = cleanNid(c.nationalId) || String(c.id);
      if(!key) return;

      if(!seen.has(key)){
        order.push(key);
        seen.set(key, c);
        return;
      }

      const prev = seen.get(key);
      // keep the item with the newest timestamp
      if(ts(c) >= ts(prev)){
        seen.set(key, c);
      }
    });

    return order.map(k => seen.get(k)).filter(Boolean);
  }

// ---------- defaults ----------
  const DEFAULT_USERS = [
    { id:'u_admin', username:'admin', password:'1234', role:'super' }
  ];

  const JOB_OPTIONS = [
    'وظيفة سابقة','_','عاطل','كهرب','تكسي','قمامه','سطحه','عدل','شرطه','مطعم','ورشه','منجم','تدوير','خياطه'
  ];

  const YESNO = ['0','1','2']; // 0/1/2 for scoring / selections (used in some selects)

  const DEFAULT_QUESTIONS = [
    { id: uid('q'), label:'الاسم', type:'text', options:[] },
    { id: uid('q'), label:'الرقم الوطني', type:'text', options:[] },
    { id: uid('q'), label:'العمر', type:'text', options:[] },
    { id: uid('q'), label:'المقابل', type:'text', options:[] },
    { id: uid('q'), label:'جودة المايك', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'عدد ساعات التواجد', type:'text', options:[] },
    { id: uid('q'), label:'وظيفة سابقة', type:'select', options: JOB_OPTIONS.filter(x => x!=='وظيفة سابقة') },
    { id: uid('q'), label:'سجل إجرامي', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'خبرة بالمجال', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'رخصة', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'وشوم', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'نية الذهاب للشرطة', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'شهادة عدم ممانعة', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'مسعف سابق', type:'select', options:['0','1','2'] },
    { id: uid('q'), label:'المميزات', type:'textarea', options:[] },
    { id: uid('q'), label:'الملاحظات', type:'textarea', options:[] }
  ];

  // Summary linking: admin chooses which question fills each summary line
  const DEFAULT_SUMMARY_LINKS = [
    { id: uid('sl'), label: 'شهادة', questionLabel: 'شهادة عدم ممانعة', enabled: true },
    { id: uid('sl'), label: 'مسعف سابق', questionLabel: 'مسعف سابق', enabled: true },
    { id: uid('sl'), label: 'جودة المايك', questionLabel: 'جودة المايك', enabled: true },
    { id: uid('sl'), label: 'عدد ساعات التواجد', questionLabel: 'عدد ساعات التواجد', enabled: true },
    { id: uid('sl'), label: 'المميزات', questionLabel: 'المميزات', enabled: true },
    { id: uid('sl'), label: 'الملاحظات', questionLabel: 'الملاحظات', enabled: true }
  ];



  // score questions (1..8) with max points: [2,1,1,1,1,1,2,1]
  const SCORE_CONFIG = [
    { n: 1, max: 2 },
    { n: 2, max: 1 },
    { n: 3, max: 1 },
    { n: 4, max: 1 },
    { n: 5, max: 1 },
    { n: 6, max: 1 },
    { n: 7, max: 2 },
    { n: 8, max: 1 }
  ];

  // ---------- state ----------
// NOTE: NO LocalStorage. We keep a small in-memory state; persistence and sync are in Firestore.
let users = [];                // derived from Firestore profiles (admin only)
let questions = deepCopy(DEFAULT_QUESTIONS); // from config/app

let hasConfigLoadedOnce = false;
function questionsSignature(qs){
  try{
    return (qs||[]).map(q => {
      const opt = Array.isArray(q.options) ? q.options.join(',') : '';
      const vis = q.visibility || '';
      const en = (q.enabled === false) ? '0' : '1';
      return `${q.id}|${String(q.label||'')}|${q.type||''}|${opt}|${vis}|${en}`;
    }).join('§');
  }catch(_){
    return String(Date.now());
  }
}
let summaryTemplate = null;    // from config/app (ربط)

const DEFAULT_HEALTH_SUPERVISOR_MENTION = '<@&827121686499295252>';
let healthSupervisorMention = DEFAULT_HEALTH_SUPERVISOR_MENTION;
let appLimits = { readsMax: 20000, writesMax: 5000, warnRatio: 0.85 }; // from config/app
let candidates = [];           // from Firestore
let audit = [];                // local (in-memory) fallback only

// Firestore audit feed (global)
let auditFS = null; // array of docs from Firestore
let auditUnsub = null;

// Presence map from Firestore (admin only): username -> { tsMs, role, email }
let presence = {};

let session = null;

// pagination
const PAGE_SIZE = 50;
let currentPage = 1;
let currentSearch = '';
let sortOrder = 'newest'; // stored in profile.preferences.sortOrder (Firestore)

// ---------- audit ----------


  
function addAudit(kind, action, details){
  const actor = session?.username || session?.email || '—';
  const entry = {
    id: uid('a'),
    time: nowEn(),
    actor,
    kind, // auth/user/question/candidate/presence
    action, // Arabic readable
    details // object for internal
  };
  // local (fallback / offline)
  audit.unshift(entry);
  audit = audit.slice(0, 2000);
  renderAudit();

  // Firestore (global activity) — best effort
  try{
    if(db && auth?.currentUser){
      db.collection('audit').add({
        kind,
        action,
        details: details || null,
        actorUid: auth.currentUser.uid,
        actorEmail: auth.currentUser.email || null,
        actorUsername: session?.username || null,
        actorRole: normalizeRole(session?.role || 'reader'),
        ts: firebase.firestore.FieldValue.serverTimestamp(),
        clientTime: new Date().toISOString()
      }).then(()=>{ bumpWrites(1); }).catch(()=>{});
    }
  }catch(_){}
}


  
// ---------- audit (Firestore live feed) ----------
function stopAuditFeed(){
  if(auditUnsub){
    try{ auditUnsub(); }catch(_){}
    auditUnsub = null;
  }
  auditFS = null;
}

function startAuditFeed(){
  stopAuditFeed();
  if(!db || !session || !isAdminRole()) return;
  try{
    auditUnsub = db.collection('audit')
      .orderBy('ts','desc')
      .limit(200)
      .onSnapshot((snap) => {
        bumpReads(Math.max(snap.docChanges().length || 0, snap.size || 0, 1));
        auditFS = snap.docs.map(d => ({ id:d.id, ...d.data() }));
        renderAudit();
      }, (err) => {
        console.warn('audit_feed_error', err);
        stopAuditFeed();
        renderAudit();
      });
  }catch(e){
    console.warn('audit_feed_init_error', e);
  }
}

// ---------- roles ----------
  function roleName(role){
    const r = normalizeRole(role);
    if(r === 'super') return 'Super Admin';
    if(r === 'admin') return 'الإدارة';
    if(r === 'trainer') return 'مدرب';
    return 'قارى';
  }
  
  // ---------- question visibility ----------
  function visibilityName(v){
    if(v === 'admins') return 'الإدارة فقط';
    if(v === 'trainer') return 'المدرب';
    return 'للجميع';
  }
  function canSeeQuestion(q){
    const lab = String(q?.label || '').trim();
    // keep core identity fields always visible to avoid breaking the form
    if(['الاسم','الرقم الوطني','العمر','المقابل'].includes(lab)) return true;

    const v = (q && q.visibility) ? q.visibility : 'all';
    if(v === 'admins') return isAdmin();
    if(v === 'trainer') return isTrainer();
    return true; // all
  }

  // Legacy gates used throughout the UI
  function isAdmin(){
    return isAdminRole();
  }
  function isTrainer(){
    return isTrainerRole();
  }
  function canEditCandidate(){
    return isTrainerRole();
  }
  function canDeleteCandidate(){
    return isAdminRole();
  }
  function canSetStatusAll(){
    return isAdminRole();
  }

  // ---------- presence ----------
// Presence is stored in Firestore (/presence) and synced live (admin only).
// Here we only render the UI from the in-memory `presence` map.
function updatePresenceUI(){
  if(!session) return;

  const dot = $('#presence-dot');
  if(dot) dot.style.background = 'var(--ok)';

  const mini = document.getElementById('mini-online');
  if(mini){
    mini.style.display = 'block';
    mini.classList.add('on');

    // show count if admin (because only admin listens to presence)
    if(isAdminRole()){
      const now = Date.now();
      const onlineCount = Object.values(presence||{}).filter(v => (now - (v.ts||0)) < 15000).length;
      mini.innerHTML = `<span class="label">متصلين</span><span class="count" dir="ltr">${onlineCount}</span>`;
    }else{
      mini.textContent = 'متصل';
    }
  }

  const ps = document.getElementById('presence-summary');
  if(ps) ps.textContent = buildPresenceSummary();

  if(window.__activeNav === 'online') renderOnline();
}

function buildPresenceSummary(){
  if(!isAdminRole()) return '';
  const now = Date.now();
  const rows = Object.entries(presence||{})
    .filter(([u, v]) => (now - (v.ts||0)) < 15000)
    .map(([u]) => u);
  return rows.length ? rows.join(' • ') : '';
}

// ---------- modal ----------
  
  // ---------- modal guards / active modal context ----------
  let modalCloseGuard = null;
  let activeCandidateModal = null;

  // ---------- in-app confirm (no browser confirm) ----------
  let __confirmLock = false;
  function showConfirmModal(opts={}){
    // returns Promise<boolean>
    return new Promise((resolve) => {
      const bd = $('#confirm-backdrop');
      const titleEl = $('#confirm-title');
      const msgEl = $('#confirm-message');
      const okBtn = $('#confirm-ok');
      const cancelBtn = $('#confirm-cancel');

      const title = String(opts.title ?? 'تنبيه');
      const message = String(opts.message ?? 'هل تريد المتابعة؟');
      const okText = String(opts.okText ?? 'تأكيد');
      const cancelText = String(opts.cancelText ?? 'إلغاء');

      titleEl.textContent = title;
      msgEl.textContent = message;
      okBtn.textContent = okText;
      cancelBtn.textContent = cancelText;

      // prevent stacking
      if(__confirmLock){
        // if somehow called twice, resolve false to be safe
        resolve(false);
        return;
      }
      __confirmLock = true;

      const cleanup = () => {
        __confirmLock = false;
        bd.style.display = 'none';
        bd.setAttribute('aria-hidden','true');
        document.removeEventListener('keydown', onKey);
        bd.removeEventListener('click', onBackdrop);
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
      };

      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const onBackdrop = (e) => {
        if(e.target && e.target.id === 'confirm-backdrop') onCancel();
      };
      const onKey = (e) => {
        if(e.key === 'Escape'){
          e.preventDefault();
          onCancel();
        }
      };

      bd.style.display = 'flex';
      bd.setAttribute('aria-hidden','false');
      // attach listeners
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      bd.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);

      // focus
      setTimeout(() => { try{ okBtn.focus(); }catch(_){ } }, 0);
    });
  }


  async function requestCloseModal(reason){
    try{
      if(typeof modalCloseGuard === 'function'){
        const ok = await modalCloseGuard(reason);
        if(!ok) return;
      }
    }catch(e){ console.warn(e); }
    closeModal();
  }

function openModal({title, body, foot, onReady, className}){
    modalCloseGuard = null;
    activeCandidateModal = null;
    $('#modal-title').textContent = title || '—';
    $('#modal-body').innerHTML = body || '';
    $('#modal-foot').innerHTML = foot || '';

    // apply optional modal classes (for wide/full layouts)
    const modalEl = document.querySelector('.modal');
    if(modalEl){
      modalEl.className = 'modal' + (className ? (' ' + String(className)) : '');
    }

    $('#modal-backdrop').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    if(typeof onReady === 'function') onReady();
  }
  function closeModal(){
    modalCloseGuard = null;
    activeCandidateModal = null;
    $('#modal-backdrop').style.display = 'none';
    $('#modal-body').innerHTML = '';
    $('#modal-foot').innerHTML = '';
    document.body.style.overflow = '';
    const modalEl = document.querySelector('.modal');
    if(modalEl) modalEl.className = 'modal';
  }
  $('#modal-close').addEventListener('click', () => requestCloseModal('x'));
  $('#modal-backdrop').addEventListener('click', (e) => {
    if(e.target.id === 'modal-backdrop') requestCloseModal('backdrop');
  });
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && $('#modal-backdrop').style.display === 'flex') requestCloseModal('esc');
  });

  // ---------- routing / panels ----------
  const panels = ['dashboard','interview','control','admin','audit','online'];
  function navTo(name){
    window.__activeNav = name;
    // permission gates
    if((name==='control' || name==='admin' || name==='audit' || name==='online') && !isAdmin()){
      toast('هذه الصفحة للإدارة و Super Admin فقط.');
      return;
    }
    panels.forEach(p => $('#panel-'+p).classList.toggle('active', p===name));
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.nav===name));
    // close sidebar on mobile
    $('#sidebar').classList.remove('open');
    if(name==='interview') renderCandidates();
    if(name==='control') renderQuestions();
    if(name==='admin') renderUsers();
    if(name==='audit') renderAudit();
    if(name==='online') renderOnline();
    if(name==='dashboard') renderStats();
  }

  // sidebar toggle on mobile
  $('#btn-open-menu').addEventListener('click', () => {
    $('#sidebar').classList.toggle('open');
  });

  // nav btn clicks (delegated)
  $('#sidebar').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if(!btn) return;
    if(btn.id === 'btn-logout') return;
    const target = btn.dataset.nav;
    if(target) navTo(target);
  });

    // logout handled in auth section

// ---------- auth (Firebase) ----------
let unsubProfiles = null;

function stopRealtimeAll(){
  try{ if(unsubConfig){unsubConfig();unsubConfig=null;} }catch(_){}
  try{ if(unsubCandidates){unsubCandidates();unsubCandidates=null;} }catch(_){}
  try{ if(unsubPresence){unsubPresence();unsubPresence=null;} }catch(_){}
  try{ if(unsubStatus){unsubStatus();unsubStatus=null;} }catch(_){}
  try{ if(unsubProfiles){unsubProfiles();unsubProfiles=null;} }catch(_){}
  stopAuditFeed();
}

function buildDefaultSummaryTemplate(qs){
  const byLabel = new Map((qs||[]).map(q => [String(q.label||'').trim(), q.id]));
  const qid = (lab) => byLabel.get(String(lab).trim()) || '';
  const mkQ = (label, labLookup=label, visibility='all') => ({
    id: uid('st'),
    kind: 'question',
    label,
    questionId: qid(labLookup),
    enabled: true,
    visibility
  });
  const mkComp = (label, computed) => ({
    id: uid('st'),
    kind: 'computed',
    label,
    computed,
    enabled: true,
    visibility: 'all'
  });
  const mkFixed = (text) => ({
    id: uid('st'),
    kind: 'fixed',
    text,
    enabled: true,
    visibility: 'all'
  });

  return [
    mkQ('الاسم','الاسم'),
    mkQ('الرقم الوطني','الرقم الوطني'),
    mkQ('العمر','العمر'),
    mkQ('جودة المايك','جودة المايك'),
    mkQ('عدد ساعات التواجد','عدد ساعات التواجد'),
    mkComp('النتيجة','totalScore'),
    mkQ('المميزات','المميزات'),
    mkQ('الملاحظات','الملاحظات'),
    mkQ('مسعف سابق','مسعف سابق'),
    // If you have a question "شهادة" in your bank, map it; else map "شهادة عدم ممانعة"
    mkQ('شهادة','شهادة'),
    mkQ('المقابل','المقابل'),
  ];
}

function canSeeSummaryItem(item){
  // Visibility options for summary items:
  // - all: everyone
  // - trainer: trainer + admin + super
  // - admin: admin + super
  const v0 = String(item?.visibility || 'all').toLowerCase();
  const v = (v0 === 'super' || v0 === 'admins') ? 'admin' : v0; // migrate old values
  if(v === 'admin') return isAdminRole();
  if(v === 'trainer') return isTrainerRole();
  return true;
}

async function seedDefaultConfigIfMissing(){
  if(!db) return;
  const ref = db.collection('config').doc('app');
  const snap = await ref.get();
  bumpReads(1);
  if(snap.exists) return;

  const qs = deepCopy(DEFAULT_QUESTIONS).map(q => ({
    ...q,
    visibility: q.visibility || 'all'
  }));

  // ensure we map شهادة -> شهادة عدم ممانعة if exists
  const hasCert = qs.some(q => String(q.label||'').trim() === 'شهادة');
  if(!hasCert){
    const t = buildDefaultSummaryTemplate(qs);
    // patch the "شهادة" line to map to شهادة عدم ممانعة if exists
    const byLabel = new Map(qs.map(q => [String(q.label||'').trim(), q.id]));
    const certQid = byLabel.get('شهادة عدم ممانعة') || '';
    t.forEach(it => {
      if(it.kind==='question' && String(it.label||'').trim()==='شهادة' && certQid){
        it.questionId = certQid;
      }
    });
  }

  const tmpl = buildDefaultSummaryTemplate(qs);

  const payload = {
    questions: qs,
    summaryTemplate: tmpl,
    healthSupervisorMention: DEFAULT_HEALTH_SUPERVISOR_MENTION,
    limits: { readsMax: quota.readsMax, writesMax: quota.writesMax, warnRatio: quota.warnRatio },
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  await ref.set(payload, { merge:true });
  bumpWrites(1);
}

async function startSessionFromProfile(profile, fbUser){
  session = {
    uid: fbUser.uid,
    email: fbUser.email || '',
    username: profile.username || '',
    role: normalizeRole(profile.role || 'trainer')
  };

  sortOrder = String(profile?.preferences?.sortOrder || 'newest') === 'oldest' ? 'oldest' : 'newest';

  $('#current-user-name').textContent = session.username || session.email || '—';
  $('#current-user-role').textContent = roleName(session.role);

  $('#view-login').classList.remove('active');
  $('#view-shell').classList.add('active');

  applyPermissions();
  navTo('dashboard');      hasConfigLoadedOnce = true;

  renderAll();

  startRealtime();
  startPresenceHeartbeat();
  if(isAdminRole()) startAuditFeed();

  addAudit('auth','تسجيل دخول', { user: session.username || session.email, role: session.role });
}

async function handleAuthState(user){
  stopRealtimeAll();
  session = null;
  users = [];
  candidates = [];
  presence = {};
  questions = deepCopy(DEFAULT_QUESTIONS);
  summaryTemplate = null;

  if(!user){
    $('#view-shell').classList.remove('active');
    $('#view-login').classList.add('active');
    return;
  }

  let profile = await getProfile(user.uid);
  bumpReads(1);

  if(!profile){
    const mail = (user.email||'').toLowerCase();
    const uname = pendingLoginUsername || (user.email || '');

    if(SUPER_ADMIN_EMAIL && mail === String(SUPER_ADMIN_EMAIL).toLowerCase()){
      profile = {
        email: user.email || '',
        username: SUPER_ADMIN_USERNAME || uname,
        role: 'super',
        preferences: { sortOrder:'newest' },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
    }else{
      profile = {
        email: user.email || '',
        username: uname,
        role: 'trainer',
        preferences: { sortOrder:'newest' },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };
    }
    await upsertProfile(user.uid, profile);
    bumpWrites(1);
  }else{
    // backfill preferences if missing
    if(!profile.preferences){
      try{
        await upsertProfile(user.uid, { preferences:{ sortOrder:'newest' } });
        bumpWrites(1);
      }catch(_){}
    }
  }

  await startSessionFromProfile(profile, user);
}

// login submit
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email')?.value.trim() || '';
  const username = $('#login-username')?.value.trim() || '';
  const password = $('#login-password')?.value || '';

  pendingLoginUsername = username;

  if(!await initFirebase()){
    $('#login-hint').textContent = 'Firebase غير مهيأ. تأكد من إضافة متغيرات Firebase في Vercel (Environment Variables).';
    return;
  }

  $('#btn-login').disabled = true;
  $('#login-hint').textContent = '... جاري تسجيل الدخول';
  try{
    const cred = await auth.signInWithEmailAndPassword(email, password);
    const user = cred.user;
    const profile = await getProfile(user.uid);
    bumpReads(1);
    if(profile && profile.username && profile.username !== username){
      await auth.signOut();
      $('#login-hint').textContent = 'اسم المستخدم غير مطابق لهذا الحساب.';
      return;
    }
    $('#login-hint').textContent = '';
  }catch(err){
    console.error(err);
    if(isQuotaError(err)){
      lockApp('تم الوصول لحد الاستخدام، جرب لاحقًا.', nextResetMs());
    }
    $('#login-hint').textContent = 'بيانات الدخول غير صحيحة أو الحساب غير موجود.';
  }finally{
    $('#btn-login').disabled = false;
  }
});

// logout
document.getElementById('btn-logout')?.addEventListener('click', async () => {
  const ok = await confirmModal({title:'تأكيد', message:'هل تريد تسجيل الخروج؟'});
  if(!ok) return;
  try{ await markPresenceOffline(); }catch(_){}
  try{ if(auth) await auth.signOut(); }catch(_){}
  stopRealtimeAll();
  session = null;
  $('#view-shell').classList.remove('active');
  $('#view-login').classList.add('active');
});

// Observe Firebase auth state
(async function bootAuth(){
  if(await initFirebase()){
    auth.onAuthStateChanged((u)=>{ handleAuthState(u); });
  }
})();

// ---------- realtime wiring ----------
async function saveConfigPatch(patch){
  if(!db) return;
  if(quota.locked) throw new Error('LOCKED');
  const ref = db.collection('config').doc('app');
  await ref.set({
    ...patch,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: {
      uid: auth?.currentUser?.uid || null,
      email: auth?.currentUser?.email || null,
      username: session?.username || null,
      role: normalizeRole(session?.role || 'reader')
    }
  }, { merge:true });
  bumpWrites(1);
}

function normalizeConfigQuestions(qs){
  const arr = Array.isArray(qs) ? qs : [];
  return arr.map(q => ({
    id: q.id || uid('q'),
    label: q.label || '',
    type: q.type || 'text',
    options: Array.isArray(q.options) ? q.options : [],
    visibility: q.visibility || 'all'
  }));
}

function normalizeSummaryTemplate(tmpl, qs){
  const byLabel = new Map((qs||[]).map(q => [String(q.label||'').trim(), q.id]));
  const hasQ = (id) => (qs||[]).some(q => q.id === id);

  const out = (Array.isArray(tmpl) ? tmpl : []).map(it => {
    const kind = String(it.kind || it.type || '').toLowerCase();
    if(kind === 'fixed'){
      return {
        id: it.id || uid('st'),
        kind:'fixed',
        text: String(it.text || it.value || it.label || ''),
        enabled: it.enabled !== false,
        visibility: it.visibility || 'all'
      };
    }
    if(kind === 'computed'){
      return {
        id: it.id || uid('st'),
        kind:'computed',
        label: String(it.label||'—'),
        computed: String(it.computed || it.key || 'totalScore'),
        enabled: it.enabled !== false,
        visibility: it.visibility || 'all'
      };
    }
    const qid = it.questionId || it.qid || '';
    let resolved = qid;
    if(!resolved && it.questionLabel && byLabel.has(String(it.questionLabel).trim())){
      resolved = byLabel.get(String(it.questionLabel).trim());
    }
    if(resolved && !hasQ(resolved)) resolved = '';
    return {
      id: it.id || uid('st'),
      kind:'question',
      label: String(it.label||'—'),
      questionId: resolved,
      enabled: it.enabled !== false,
      visibility: it.visibility || 'all'
    };
  }).filter(Boolean);

  return out.length ? out : buildDefaultSummaryTemplate(qs);
}

function startRealtime(){
  // system status
  try{
    if(unsubStatus){ unsubStatus(); unsubStatus=null; }
    unsubStatus = db.collection('system').doc('appStatus').onSnapshot((snap) => {
      bumpReads(1);
      applyRemoteStatus(snap.data());
    }, (err) => {
      console.warn('status_listener_error', err);
    });
  }catch(e){
    console.warn(e);
  }

  // config/app
  try{
    if(unsubConfig){ unsubConfig(); unsubConfig=null; }
    unsubConfig = db.collection('config').doc('app').onSnapshot(async (snap) => {
      bumpReads(1);
      if(!snap.exists){
        if(isAdminRole()){
          try{ await seedDefaultConfigIfMissing(); }catch(err){ console.warn('seed_config_error', err); }
        }else{
          setSystemBanner({ type:'warn', title:'لم يتم تجهيز النظام بعد', message:'تواصل مع الإدارة لإعداد (الأسئلة/الربط).' });
        }
        return;
      }
      const data = snap.data() || {};
      const prevQs = questions;
      const prevSig = questionsSignature(prevQs);
      const prevIds = new Set((prevQs||[]).map(q => q.id));
      const qs = normalizeConfigQuestions(data.questions || []);
      const newSig = questionsSignature(qs);
      questions = qs;

      // live-update open candidate modal (without closing) if questions changed
      try{
        if(hasConfigLoadedOnce && activeCandidateModal && typeof activeCandidateModal.refreshFromConfig === 'function' && prevSig !== newSig){
          const addedCount = qs.filter(q => !prevIds.has(q.id)).length;
          activeCandidateModal.refreshFromConfig({ addedCount });
        }
        if(hasConfigLoadedOnce && prevSig !== newSig){
          const addedCount = qs.filter(q => !prevIds.has(q.id)).length;
          if(addedCount > 0 && !(activeCandidateModal && typeof activeCandidateModal.refreshFromConfig === 'function')) toast('تم إضافة سؤال جديد.');
        }
      }catch(e){ console.warn(e); }


      // Fixed limits in code (ignore config overrides)
      appLimits = { readsMax: FIXED_LIMITS.readsMax, writesMax: FIXED_LIMITS.writesMax, warnRatio: quota.warnRatio };
      quota.readsMax = FIXED_LIMITS.readsMax;
      quota.writesMax = FIXED_LIMITS.writesMax;
      quota.warnAtReads = FIXED_LIMITS.warnAt;
      quota.warnAtWrites = FIXED_LIMITS.warnAt;

      summaryTemplate = normalizeSummaryTemplate(data.summaryTemplate || data.summaryLinks || null, qs);
      healthSupervisorMention = String(data.healthSupervisorMention || data.healthMention || DEFAULT_HEALTH_SUPERVISOR_MENTION).trim() || DEFAULT_HEALTH_SUPERVISOR_MENTION;

      renderAll();
    }, (err) => {
      console.warn('config_listener_error', err);
      if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (قراءة).', nextResetMs());
    });
  }catch(e){
    console.warn(e);
  }

  // candidates
  try{
    if(unsubCandidates){ unsubCandidates(); unsubCandidates=null; }
    unsubCandidates = db.collection('candidates')
      .orderBy('updatedAtMs','desc')
      .limit(2000)
      .onSnapshot((snap) => {
        bumpReads(Math.max(snap.docChanges().length || 0, snap.size || 0, 1));
        candidates = snap.docs.map(d => {
          const data = d.data() || {};
          const createdAt = data.createdAt?.toDate ? data.createdAt.toDate().toLocaleString('en-US',{hour12:true}) : (data.createdAtStr || '');
          const updatedAt = data.updatedAt?.toDate ? data.updatedAt.toDate().toLocaleString('en-US',{hour12:true}) : (data.updatedAtStr || '');
          return {
            id: d.id,
            name: data.name || '',
            nationalId: data.nationalId || '',
            age: data.age || '',
            interviewer: data.interviewer || '',
            status: data.status || 'قيد المراجعة',
            answers: data.answers || {},
            scores: Array.isArray(data.scores) ? data.scores : Array(8).fill(0),
            createdAt,
            updatedAt,
            createdAtMs: Number(data.createdAtMs || 0),
            updatedAtMs: Number(data.updatedAtMs || 0),
          };
        });
        renderAfterCandidateChange();
      }, (err) => {
        console.warn('candidates_listener_error', err);
        if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (قراءة المرشحين).', nextResetMs());
        else setSystemBanner({ type:'danger', title:'خطأ', message:'تعذر تحميل المرشحين. حاول تحديث الصفحة.' });
      });
  }catch(e){
    console.warn(e);
  }

  // presence + users (admin only)
  if(isAdminRole()){
    try{
      if(unsubPresence){ unsubPresence(); unsubPresence=null; }
      unsubPresence = db.collection('presence')
        .orderBy('lastSeenMs','desc')
        .limit(200)
        .onSnapshot((snap) => {
          bumpReads(Math.max(snap.docChanges().length || 0, snap.size || 0, 1));
          const map = {};
          snap.docs.forEach(d => {
            const x = d.data() || {};
            const uname = String(x.username || x.email || d.id);
            map[uname] = { ts: Number(x.lastSeenMs||0), role: x.role || 'reader', email: x.email || '' };
          });
          presence = map;
          updatePresenceUI();
        }, (err) => {
          console.warn('presence_listener_error', err);
        });
    }catch(_){}

    try{
      if(unsubProfiles){ unsubProfiles();unsubProfiles=null; }
      unsubProfiles = db.collection('profiles')
        .orderBy('createdAt','desc')
        .limit(500)
        .onSnapshot((snap) => {
          bumpReads(Math.max(snap.docChanges().length || 0, snap.size || 0, 1));
          users = snap.docs.map(d => {
            const p = d.data() || {};
            return { id:d.id, username:p.username||'', role:normalizeRole(p.role||'trainer'), email:p.email||'' };
          });
          renderUsers();
        }, (err) => {
          console.warn('profiles_listener_error', err);
        });
    }catch(_){}
  }
}

let _presenceTimer = null;

async function markPresenceOffline(){
  try{
    if(!db || !auth?.currentUser) return;
    await db.collection('presence').doc(auth.currentUser.uid).set({
      online:false,
      lastSeenMs: Date.now()
    }, { merge:true });
    bumpWrites(1);
  }catch(_){}
}

async function presenceTickFS(){
  try{
    if(!db || !auth?.currentUser || !session) return;
    await db.collection('presence').doc(auth.currentUser.uid).set({
      online:true,
      username: session.username || null,
      email: session.email || null,
      role: normalizeRole(session.role || 'reader'),
      lastSeenMs: Date.now()
    }, { merge:true });
    bumpWrites(1);
  }catch(err){
    if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (كتابة الحضور).', nextResetMs());
  }
}

function startPresenceHeartbeat(){
  clearInterval(_presenceTimer);
  if(!session) return;
  presenceTickFS();
  _presenceTimer = setInterval(presenceTickFS, 10000);

  window.addEventListener('beforeunload', () => {
    try{
      if(db && auth?.currentUser){
        db.collection('presence').doc(auth.currentUser.uid).set({ online:false, lastSeenMs: Date.now() }, { merge:true });
      }
    }catch(_){}
  }, { once:true });
}

// ---------- candidates ----------
  function statusBadge(status){
    if(status === 'مقبول') return 'accept';
    if(status === 'مرفوض') return 'reject';
    return 'review';
  }
  function getScoreMax(i){
    const cfg = SCORE_CONFIG[i];
    const max = cfg ? Number(cfg.max ?? cfg.w ?? 2) : 2;
    return Number.isFinite(max) ? max : 2;
  }

  function calcTotalScore(scores){
    // Each question has max points (1 or 2). Total is the SUM of chosen points.
    let total = 0;
    for(let i=0;i<SCORE_CONFIG.length;i++){
      const max = getScoreMax(i);
      const v = clamp(Number(scores?.[i] ?? 0), 0, max);
      total += v;
    }
    return total;
  }
  function scoreColor(v){
    if(String(v)==='2') return 'var(--ok)';
    if(String(v)==='1') return 'var(--warn)';
    return 'var(--danger)';
  }

function maxTotalScore(){
    let m = 0;
    for(let i=0;i<SCORE_CONFIG.length;i++) m += getScoreMax(i);
    return m;
  }

  function scoreBg(total){
    const max = maxTotalScore();
    const r = max ? (Number(total)/max) : 0;
    if(r >= 0.7) return 'rgba(34,197,94,0.18)';
    if(r >= 0.4) return 'rgba(250,204,21,0.18)';
    return 'rgba(239,68,68,0.18)';
  }

  function createEmptyAnswers(){
    const ans = {};
    questions.forEach(q => { ans[q.id] = ''; });
    return ans;
  }

  function getCandidateById(id){
    return candidates.find(c => c.id === id);
  }


function makeCandidateDocId(nationalId){
  const digits = String(nationalId || '').replace(/[^0-9]/g,'').trim();
  return digits ? `nid_${digits}` : uid('c');
}

function ensureCandidateAnswers(c){
  c.answers = c.answers || {};
  // ensure keys for current questions
  questions.forEach(q => {
    if(!(q.id in c.answers)) c.answers[q.id] = '';
  });
  // fixed interviewer
  const iq = questions.find(q => String(q.label).trim() === 'المقابل');
  if(iq){
    c.interviewer = c.interviewer || session?.username || '';
    c.answers[iq.id] = c.interviewer;
  }
  return c;
}

async function upsertCandidateFS(candidate, isNew, docId){
  if(!db || !auth?.currentUser) throw new Error('NO_DB');
  if(quota.locked) throw new Error('LOCKED');

  const nowMs = Date.now();
  const c = ensureCandidateAnswers(deepCopy(candidate));
  const payload = {
    name: String(c.name || '').trim(),
    nationalId: String(c.nationalId || '').trim(),
    age: String(c.age || '').trim(),
    interviewer: String(c.interviewer || session?.username || '').trim(),
    status: String(c.status || 'قيد المراجعة'),
    answers: c.answers || {},
    scores: Array.isArray(c.scores) ? c.scores : Array(8).fill(0),
    totalScore: calcTotalScore(c.scores || []),
    updatedAtMs: nowMs,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  if(isNew){
    payload.createdAtMs = nowMs;
    payload.createdAt = firebase.firestore.FieldValue.serverTimestamp();
  }

  await db.collection('candidates').doc(docId).set(payload, { merge: !isNew });
  bumpWrites(1);
}

async function deleteCandidateFS(docId){
  if(!db || !auth?.currentUser) throw new Error('NO_DB');
  if(quota.locked) throw new Error('LOCKED');
  await db.collection('candidates').doc(docId).delete();
  bumpWrites(1);
}

  function renderCandidates(){
    const grid = $('#candidates-grid');
    const empty = $('#candidates-empty');

    // search value
    const search = (currentSearch || '').toLowerCase().trim();

    let filtered = candidates;
    if(search){
      filtered = candidates.filter(c => {
        const name = (c.name||'').toLowerCase();
        const nid = (c.nationalId||'').toLowerCase();
        const nidClean = nid.replace(/\s+/g,'');
        const sClean = search.replace(/\s+/g,'');
        return name.includes(search) || nid.includes(search) || (sClean && nidClean.includes(sClean));
      });
    }

    
// sort (default: newest)
const ts = (c) => {
  const u = Date.parse(c?.updatedAt || '') || 0;
  const cr = Date.parse(c?.createdAt || '') || 0;
  return Math.max(u, cr);
};
filtered = (filtered || []).slice().sort((a,b) => {
  const da = ts(a), db = ts(b);
  if(da === db){
    return (String(a?.name||'')).localeCompare(String(b?.name||''), 'ar');
  }
  return (sortOrder === 'oldest') ? (da - db) : (db - da);
});

const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    currentPage = clamp(currentPage, 1, totalPages);

    const start = (currentPage-1) * PAGE_SIZE;
    const pageItems = filtered.slice(start, start + PAGE_SIZE);

    $('#page-indicator').textContent = `${currentPage} / ${totalPages}`;

    empty.style.display = (pageItems.length===0) ? 'block' : 'none';

    grid.innerHTML = pageItems.map(c => {
      const b = statusBadge(c.status);
      const badgeText = c.status || 'قيد المراجعة';
      return `
        <div class="cand-card" data-cid="${c.id}">
          <div class="cand-top">
            <div>
              <div class="cand-name">${escapeHtml(c.name || '—')}</div>
              <div class="cand-meta">
                الرقم الوطني: ${escapeHtml(c.nationalId || '—')}<br/>
                العمر: ${escapeHtml(c.age || '—')}<br/>
                المقابل: ${escapeHtml(c.interviewer || '—')}
              </div>
            </div>
            <div class="badge ${b}">${escapeHtml(badgeText)}</div>
          </div>

          <div class="cand-meta">
            المجموع: <b>${calcTotalScore(c.scores || []).toString()}</b>
          </div>

          <div class="cand-actions">
            <button class="btn" data-action="details">عرض التفاصيل</button>
            ${canEditCandidate() ? `<button class="btn" data-action="edit">تعديل</button>` : ``}
            ${canDeleteCandidate() ? `<button class="btn danger" data-action="delete">حذف</button>` : ``}
          </div>
        </div>
      `;
    }).join('');
  }

  // candidate search (debounced to keep UI smooth)
  const onCandidateSearchInput = debounce((val) => {
    currentSearch = val || '';
    currentPage = 1;
    renderCandidates();
  }, 180);

  $('#candidate-search').addEventListener('input', (e) => {
    onCandidateSearchInput(e.target.value);
  });

  const onQuickSearchInput = debounce((val) => {
    currentSearch = val || '';
    $('#candidate-search').value = currentSearch;
    currentPage = 1;
    renderCandidates();
    navTo('interview');
  }, 180);
  $('#quick-search').addEventListener('input', (e) => {
    onQuickSearchInput(e.target.value);
  });



// sort selector (newest/oldest)
const sortSel = $('#candidates-sort');
if(sortSel){
  sortSel.value = (sortOrder === 'oldest') ? 'oldest' : 'newest';
  sortSel.addEventListener('change', (e) => {
    sortOrder = (e.target.value === 'oldest') ? 'oldest' : 'newest';
    // save preference in Firestore profile
    try{
      if(db && auth?.currentUser){
        upsertProfile(auth.currentUser.uid, { preferences: { sortOrder } }).then(()=>{ bumpWrites(1); }).catch(()=>{});
      }
    }catch(_){ }
    currentPage = 1;
    renderCandidates();
  });
}

  // pagination buttons
  $('#btn-prev-page').addEventListener('click', () => { currentPage -= 1; renderCandidates(); });
  $('#btn-next-page').addEventListener('click', () => { currentPage += 1; renderCandidates(); });
  $('#btn-go-page').addEventListener('click', () => {
    const n = parseInt($('#page-jump').value, 10);
    if(!Number.isFinite(n)) return;
    currentPage = n;
    renderCandidates();
  });

  // add candidate
  $('#btn-add-candidate').addEventListener('click', () => {
    if(quota.locked){
      toast('النظام مقفل مؤقتًا بسبب حد الاستخدام.');
      return;
    }
    if(!canEditCandidate()){
      toast('لا تملك صلاحية إضافة مرشح.');
      return;
    }
    openCandidateModal(null);
  });

  // candidate card actions (delegated)
  $('#candidates-grid').addEventListener('click', async (e) => {
    const card = e.target.closest('.cand-card');
    if(!card) return;
    const cid = card.dataset.cid;
    const act = e.target.closest('button')?.dataset.action;
    if(!act) return;

    if(act === 'details'){
      openCandidateDetailsModal(cid);
      return;
    }
    if(act === 'edit'){
      openCandidateModal(cid);
      return;
    }
    
if(act === 'delete'){
  if(!canDeleteCandidate()){
    toast('لا تملك صلاحية حذف مرشح.');
    return;
  }
  const c = getCandidateById(cid);
  if(!c) return;
  const ok = await confirmModal({title:'تأكيد', message:`حذف المرشح: ${c.name || ''} ؟`, okText:'حذف', cancelText:'إلغاء'});
  if(!ok) return;

  try{
    await deleteCandidateFS(cid);
    addAudit('candidate','حذف مرشح', { name: c.name, nationalId: c.nationalId });
    toast('تم الحذف');
    // list will update automatically via onSnapshot
  }catch(err){
    console.error(err);
    if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (حذف).', nextResetMs());
    else toast('تعذر الحذف');
  }
}
  });

  // Candidate modal (add/edit)
  function openCandidateModal(candidateId){
    const isEdit = Boolean(candidateId);
    const c = isEdit ? deepCopy(getCandidateById(candidateId)) : {
      id: uid('c'),
      name: '',
      nationalId: '',
      age: '',
      interviewer: session?.username || '',
      status: 'قيد المراجعة',
      answers: createEmptyAnswers(),
      scores: Array(8).fill(0),
      photo: '',
      createdAt: nowEn(),
      updatedAt: nowEn(),
    };

    // hydrate transient photo for edits (not stored in Firestore)
    if(isEdit){
      c.photo = photoCache.get(candidateId) || c.photo || '';
    }
    ensureCandidateAnswers(c);

    // interviewer is fixed (auto) and not editable
    c.interviewer = c.interviewer || session?.username || '';
    const _iqOpen = questions.find(q => String(q.label).trim() === 'المقابل');
    if(_iqOpen){
      c.answers = c.answers || {};
      c.answers[_iqOpen.id] = c.interviewer;
    }

    const canEditAll = isAdmin();
    const canEditResults = canEditCandidate();
    const canStatusAll = canSetStatusAll();
    const statusOptions = canStatusAll ? ['قيد المراجعة','مقبول','مرفوض'] : ['قيد المراجعة'];

    const visibleQs = questions.filter(q => canSeeQuestion(q));

    const qHtml = visibleQs.map(q => {
      const lab = String(q.label || '').trim();
      let dis = !canEditResults;
      if(canEditResults){
        dis = false;
      }
      // identity fields: admin + trainer can edit (name / national id / age)
      if(['الاسم','الرقم الوطني','العمر'].includes(lab)) dis = !(canEditAll || isTrainerRole());
      return renderQuestionInput(q, c.answers[q.id] ?? '', dis);
    }).join('');

    const scoreHtml = SCORE_CONFIG.map((s, idx) => {
      const val = Number(c.scores?.[idx] ?? 0);
      return `
        <div class="score-tile">
          <div class="st-title">السؤال ${s.n} (${getScoreMax(idx)===2 ? 'درجتين' : 'درجة واحدة'})</div>
          <select data-score="${idx}" ${canEditResults ? '' : 'disabled'}>
              ${(() => {
                const max = getScoreMax(idx);
                let o = '';
                for(let v=0; v<=max; v++){
                  o += `<option value="${v}" ${val===v?'selected':''}>${v}</option>`;
                }
                return o;
              })()}
            </select>
        </div>
      `;
    }).join('');

    const body = `
      <div class="interview-split">
        <div class="pane-photo">
          
          <div class="card photo-card">
            <div class="card-head">
              <div class="card-title">صورة المرشح</div>
              <div class="photo-actions">
                <input type="file" id="photo-file" class="file-hidden desktop-only" accept="image/*" ${canEditResults ? '' : 'disabled'} />
                <button class="btn tiny desktop-only" id="btn-choose-photo" ${canEditResults ? '' : 'disabled'}>إضافة من الكمبيوتر</button>
                <button class="btn tiny danger" id="btn-remove-photo" ${canEditResults ? '' : 'disabled'} ${c.photo ? '' : 'disabled'}>حذف الصورة</button>
              </div>
            </div>
            <div class="photo-box big" id="photo-box">
              ${c.photo ? `<img id="photo-img" alt="Candidate photo" src="${c.photo}">` : `<div class="muted">اسحب صورة هنا أو ألصق (Ctrl+V)</div>`}
              <div class="photo-hint">رفع أو لصق (Ctrl+V)</div>
            </div>
          </div>


        <div id="img-overlay" class="img-overlay" style="display:none;">
          <button class="icon-btn img-overlay-close" id="img-overlay-close" aria-label="إغلاق">✕</button>
          <img id="img-overlay-img" alt="" />
        </div>
        </div>

        <div class="pane-form">
          <div class="card">
          <div class="card-title">مدخلات التقييم</div>

          <div class="field">
            <label>الحالة</label>
            <select id="cand-status" ${canEditResults ? '' : 'disabled'}>
              ${statusOptions.map(s => `<option ${c.status===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>

          <div class="field">
            <label>الدرجات (0/1/2)</label>
            <div class="score-grid" id="score-grid">${scoreHtml}</div>
            <div class="muted" style="margin-top:8px;">0 = أحمر • 1 = أصفر • 2 = أخضر</div>
            <div style="margin-top:10px;font-weight:900;">المجموع: <span id="total-score">${calcTotalScore(c.scores)}</span></div>
          </div>

          <hr style="border:none;border-top:1px solid var(--line);margin:12px 0;"/>
          <div class="card-title">الأسئلة</div>
          <div id="candidate-questions-wrap">${qHtml}</div>

          <hr style="border:none;border-top:1px solid var(--line);margin:12px 0;"/>
          <div class="card-title">الملخص (قابل للنسخ)</div>
          <textarea id="summary-box" readonly>${buildSummary(c)}</textarea>
          <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;">
            <button class="btn" id="btn-copy-summary">نسخ الملخص</button>
            <button class="btn desktop-only" id="btn-copy-summary-image">نسخ الصور كصورة واحدة</button>
            ${canEditResults ? `
            <button class="btn desktop-only" id="btn-open-docs">إضافة صور بطاقات (كمبيوتر فقط)</button>` : ``}
          </div>
        </div>
        </div>
      </div>

      ${canEditResults ? `
      <!-- Docs sub-modal (Desktop only, temporary in-memory) -->
      <div class="submodal-backdrop hidden" id="docs-submodal" aria-hidden="true">
        <div class="submodal-card" role="dialog" aria-modal="true" aria-label="إضافة صور بطاقات">
          <div class="submodal-head">
            <div class="submodal-title">إضافة صور بطاقات</div>
            <button class="icon-btn danger" id="docs-submodal-x" title="إغلاق">✕</button>
          </div>

          <div class="submodal-body">
            <div class="docs-grid">
              <div class="doc-drop" id="doc-cert" data-doc="cert" tabindex="0">
                <div class="doc-top">
                  <div class="doc-label">شهادة</div>
                  <div class="doc-actions">
                    <button class="icon-btn" data-doc-choose="cert" title="اختيار من الجهاز">📁</button>
                    <button class="icon-btn danger doc-remove" data-doc-remove="cert" title="إزالة">✕</button>
                  </div>
                </div>
                <div class="doc-body" id="doc-cert-body">
                  <div class="muted doc-empty">اسحب الصورة • Ctrl+V • أو اختر من الجهاز</div>
                </div>
                <input type="file" accept="image/*" class="file-hidden" id="doc-cert-file" />
              </div>

              <div class="doc-drop" id="doc-id" data-doc="id" tabindex="0">
                <div class="doc-top">
                  <div class="doc-label">هوية</div>
                  <div class="doc-actions">
                    <button class="icon-btn" data-doc-choose="id" title="اختيار من الجهاز">📁</button>
                    <button class="icon-btn danger doc-remove" data-doc-remove="id" title="إزالة">✕</button>
                  </div>
                </div>
                <div class="doc-body" id="doc-id-body">
                  <div class="muted doc-empty">اسحب الصورة • Ctrl+V • أو اختر من الجهاز</div>
                </div>
                <input type="file" accept="image/*" class="file-hidden" id="doc-id-file" />
              </div>

              <div class="doc-drop" id="doc-lic" data-doc="license" tabindex="0">
                <div class="doc-top">
                  <div class="doc-label">رخصة</div>
                  <div class="doc-actions">
                    <button class="icon-btn" data-doc-choose="license" title="اختيار من الجهاز">📁</button>
                    <button class="icon-btn danger doc-remove" data-doc-remove="license" title="إزالة">✕</button>
                  </div>
                </div>
                <div class="doc-body" id="doc-lic-body">
                  <div class="muted doc-empty">اسحب الصورة • Ctrl+V • أو اختر من الجهاز</div>
                </div>
                <input type="file" accept="image/*" class="file-hidden" id="doc-lic-file" />
              </div>
            </div>
</div>

          <div class="submodal-foot">
            <button class="btn primary" id="docs-submodal-copy-image">نسخ الصور كصورة واحدة</button>
            <button class="btn" id="docs-submodal-copy">الملخص خلاص</button>
<button class="btn" id="docs-submodal-cancel">إلغاء</button>
          </div>
        </div>
      </div>

          <div class="submodal-foot">
            <button class="btn primary" id="discord-send">إرسال</button>
            <button class="btn" id="discord-cancel">إلغاء</button>
          </div>
        </div>
      </div>
      ` : ``}
    `;

    const foot = `
      ${canEditResults ? `<button class="btn primary" id="btn-save-candidate">حفظ</button>` : ``}
      <button class="btn" id="btn-close">إغلاق</button>
    `;

    openModal({
      title: isEdit ? `تفاصيل المرشح` : `إضافة مرشح`,
      body,
      foot,
      className: 'modal-wide modal-interview',
      onReady: () => {

        // active candidate modal context (for live refresh + safe close)
        activeCandidateModal = { type:'candidate', dirty:false, refreshFromConfig:null };
        const markDirty = () => { if(activeCandidateModal) activeCandidateModal.dirty = true; };

        // Warn if user closes by mistake (X / خارج المودل / ESC)
        modalCloseGuard = () => {
          if(!activeCandidateModal || !activeCandidateModal.dirty) return true;
          return showConfirmModal({ title:'تنبيه', message:'سيتم إغلاق نافذة الأسئلة وقد تفقد التعديلات غير المحفوظة.\n\nهل تريد الإغلاق؟', okText:'إغلاق', cancelText:'رجوع' });
        };

        const syncDraftFromDom = () => {
          const els = $$('#modal-body [data-qid]');
          els.forEach(el => {
            const qid = el.dataset.qid;
            const label = String(el.dataset.qlabel || '').trim();
            let v = '';
            if(el.tagName === 'SELECT'){
              v = el.value;
            }else if(el.type === 'checkbox'){
              v = el.checked ? 'نعم' : 'لا';
            }else{
              v = el.value;
            }
            c.answers = c.answers || {};
            c.answers[qid] = v;
            if(label === 'الاسم') c.name = v;
            if(label === 'الرقم الوطني') c.nationalId = v;
            if(label === 'العمر') c.age = v;
          });
        };

        const buildQuestionsHtmlLive = () => {
          const visible = questions.filter(q => canSeeQuestion(q));
          return visible.map(q => {
            const lab = String(q.label || '').trim();
            let dis = !canEditResults;
            if(canEditResults){ dis = false; }
            if(['الاسم','الرقم الوطني','العمر'].includes(lab)) dis = !(canEditAll || isTrainerRole());
            return renderQuestionInput(q, c.answers[q.id] ?? '', dis);
          }).join('');
        };

        activeCandidateModal.refreshFromConfig = ({addedCount=0}={}) => {
          const wrap = document.getElementById('candidate-questions-wrap');
          if(!wrap) return;

          // keep current draft values
          syncDraftFromDom();

          const activeEl = document.activeElement;
          const activeQid = activeEl && activeEl.dataset ? activeEl.dataset.qid : '';

          wrap.innerHTML = buildQuestionsHtmlLive();

          // re-setup national id duplicate UI after re-render
          try{ setupNationalIdUI(); }catch(e){ console.warn(e); }

          // restore focus (best-effort)
          try{
            if(activeQid){
              const esc = (window.CSS && CSS.escape) ? CSS.escape(activeQid) : activeQid.replace(/"/g,'\\\"');
              const el = wrap.querySelector(`[data-qid="${esc}"]`);
              if(el) el.focus();
            }
          }catch(_){}

          // update summary box
          const sb = document.getElementById('summary-box');
          if(sb) sb.value = buildSummary(c);

          if(addedCount > 0){
            toast('تم إضافة سؤال جديد — تم تحديث الأسئلة داخل النموذج.');
          }else{
            toast('تم تحديث الأسئلة داخل النموذج.');
          }
        };

        // score colors + total
        const sg = $('#score-grid');
        const setScoreUI = () => {
          $$('#score-grid select').forEach(sel => {
            sel.style.borderColor = scoreColor(sel.value);
            sel.style.boxShadow = `0 0 0 3px rgba(0,0,0,0)`;
          });
          $('#total-score').textContent = String(calcTotalScore(c.scores));
        };
        setScoreUI();

        // nationalId uniqueness (based on nationalId only)
const cleanNationalId = (v) => String(v||'').replace(/[^0-9]/g,'').trim();
const isDuplicateNationalId = (nid) => {
  const key = cleanNationalId(nid);
  if(!key) return false;
  return candidates.some(x => {
    if(!x) return false;
    const k2 = cleanNationalId(x.nationalId);
    if(!k2) return false;
    // exclude current candidate (by id OR by same key already being edited)
    if(x.id === c.id) return false;
    return k2 === key;
  });
};


const setupNationalIdUI = () => {
  const btnSaveGlobal = $('#btn-save-candidate');
  const nidInputEl = $('#modal-body [data-qlabel="الرقم الوطني"]');

  // remove previous hint if any (during live refresh)
  const oldHint = document.getElementById('nid-dup-hint');
  if(oldHint) oldHint.remove();

  let nidHintEl = null;
  if(nidInputEl){
    const fieldWrap = nidInputEl.closest('.field');
    if(fieldWrap){
      nidHintEl = document.createElement('div');
      nidHintEl.id = 'nid-dup-hint';
      nidHintEl.className = 'field-hint error';
      nidHintEl.style.display = 'none';
      nidHintEl.textContent = '';
      fieldWrap.appendChild(nidHintEl);
    }
  }

  const setNidError = (on) => {
    // duplicates are allowed now -> keep UI clean and keep Save enabled
    if(nidHintEl) nidHintEl.style.display = 'none';
    if(nidInputEl){
      nidInputEl.style.borderColor = '';
    }
    if(btnSaveGlobal){
      btnSaveGlobal.disabled = false;
      btnSaveGlobal.title = '';
    }
  };

  validateNationalIdNow = () => {
    // duplicates are allowed now
    setNidError(false);
    return true;
  };

  validateNationalIdNow();

  if(nidInputEl){
    const validateNidFast = () => {
      c.nationalId = nidInputEl.value;
      validateNationalIdNow();
    };
    // بعض المتصفحات (خصوصًا مع إدخال عربي/IME) قد لا تطلق input بشكل متوقع
    // لذلك نراقب أكثر من حدث لضمان إخفاء رسالة التكرار فور تغيّر الرقم.
    ['input','keyup','change','blur'].forEach(evt => {
      nidInputEl.addEventListener(evt, validateNidFast);
    });
  }
};

let validateNationalIdNow = () => true;
setupNationalIdUI();
// handle score change
        sg.addEventListener('change', (e) => {
          const sel = e.target.closest('select');
          if(!sel) return;
          const idx = Number(sel.dataset.score);
          const max = getScoreMax(idx);
          const v = clamp(Number(sel.value), 0, max);
          c.scores[idx] = v;
          setScoreUI();
          $('#summary-box').value = buildSummary(c);
          markDirty();
        });

        // questions change (support input + change so select options work reliably)
        const onAnswerFieldChange = (e) => {
          const el = e.target;
          const qid = el?.dataset?.qid;
          if(!qid) return;
          const v = (el && el.type === 'checkbox') ? (el.checked ? '1' : '0') : el.value;
          c.answers[qid] = v;
          // mirror key fields
          const label = (el?.dataset?.qlabel || questions.find(q => q.id===qid)?.label || '').trim();
          if(label === 'الاسم') c.name = v;
          if(label === 'الرقم الوطني'){
            c.nationalId = v;
            // live duplicate check
            validateNationalIdNow();
          }
          if(label === 'العمر') c.age = v;
          if(label === 'المقابل') c.interviewer = (c.interviewer || session?.username || '');
          $('#summary-box').value = buildSummary(c);
          markDirty();
        };
        $('#modal-body').addEventListener('input', onAnswerFieldChange);
        $('#modal-body').addEventListener('change', onAnswerFieldChange);

        // status change
        $('#cand-status').addEventListener('change', (e) => {
          c.status = e.target.value;
          $('#summary-box').value = buildSummary(c);
          markDirty();
        });

        // Enter to jump to next question (Shift+Enter keeps new line in textarea)
const focusNextQuestion = (el) => {
  const qInputs = Array.from($$('#modal-body [data-qid]'));
  const i = qInputs.indexOf(el);
  if(i >= 0 && i < qInputs.length - 1){
    const next = qInputs[i+1];
    next.focus();
    try{ next.scrollIntoView({block:'center', behavior:'smooth'}); }catch(_){}
  }
};

$('#modal-body').addEventListener('keydown', (e) => {
  const el = e.target;
  if(!el || !el.dataset || !el.dataset.qid) return;
  if(e.key !== 'Enter') return;

  const tag = (el.tagName || '').toUpperCase();
  if(tag === 'TEXTAREA'){
    if(e.shiftKey) return; // allow newline
    e.preventDefault();
    focusNextQuestion(el);
    return;
  }
  if(tag === 'INPUT'){
    e.preventDefault();
    focusNextQuestion(el);
    return;
  }
});

        // copy summary (with temp images)
        const copySummaryWithImages = async () => {
          const text = String($('#summary-box')?.value || '').trim();
          const imgs = [];
          try{
            // candidate photo (temporary)
            const p = (typeof c?.photo === 'string') ? c.photo.trim() : '';
            if(p) imgs.push({ label:'صورة المرشح', src:p });
          }catch(_){}

          // temp documents (3 boxes) - stored in memory only
          try{
            const t = window.__hiTempDocs || {};
            if(t.cert) imgs.push({ label:'صورة لشهادة', src: t.cert });
            if(t.id) imgs.push({ label:'صورة بطاقة الهوية', src: t.id });
            if(t.license) imgs.push({ label:'صورة بطاقة رخصة', src: t.license });
          }catch(_){}

          // Build HTML that carries images + text together (best effort across apps)
          const esc = (s) => escapeHtml(String(s||''));
          const htmlImgs = imgs.map(x => `
              <figure style="margin:0;">
                <div style="font-size:12px;opacity:.85;margin-bottom:6px;">${esc(x.label)}</div>
                <img src="${esc(x.src)}" style="max-width:320px;max-height:220px;border-radius:14px;border:1px solid rgba(0,0,0,.12);" />
              </figure>
          `).join('');
          const html = `
            <div dir="rtl" style="font-family:inherit;">
              <pre style="white-space:pre-wrap;margin:0;">${esc(text)}</pre>
              ${imgs.length ? `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;align-items:flex-start;">${htmlImgs}</div>` : ``}
            </div>
          `.trim();

          
          const dataUrlToBlob = async (dataUrl) => {
            const res = await fetch(dataUrl);
            return await res.blob();
          };

          try{
            if(navigator.clipboard?.write && typeof ClipboardItem === 'function'){
              if(imgs.length){
                const blobs = [];
                for(const im of imgs){
                  try{
                    const b = await dataUrlToBlob(im.src);
                    if(b && b.type && String(b.type).startsWith('image/')) blobs.push(b);
                  }catch(_){ }
                }

                const items = [];
                const base = {
                  'text/plain': new Blob([text], { type:'text/plain' }),
                  'text/html': new Blob([html], { type:'text/html' }),
                };

                // Put the first image in the same clipboard item with the text
                // (this is the most compatible way to paste into Discord).
                if(blobs[0]){
                  base[blobs[0].type || 'image/png'] = blobs[0];
                }
                items.push(new ClipboardItem(base));

                // Add remaining images as separate clipboard items (best effort).
                for(let i=1;i<blobs.length;i++){
                  const b = blobs[i];
                  items.push(new ClipboardItem({ [b.type || 'image/png']: b }));
                }

                await navigator.clipboard.write(items);
                toast(blobs.length ? 'تم نسخ الملخص + الصور' : 'تم نسخ الملخص');
              }else{
                await navigator.clipboard.write([
                  new ClipboardItem({
                    'text/plain': new Blob([text], { type:'text/plain' }),
                    'text/html': new Blob([html], { type:'text/html' }),
                  })
                ]);
                toast('تم نسخ الملخص');
              }
            }else{
              await navigator.clipboard.writeText(text);
              toast('تم نسخ الملخص');
            }
          }catch(err){

            try{
              await navigator.clipboard.writeText(text);
              toast(imgs.length ? 'تم نسخ الملخص (الصور غير مدعومة على هذا الجهاز)' : 'تم نسخ الملخص');
            }catch(_){
              toast('تعذر النسخ');
            }
          }
        };

        


        // copy summary text only (fast + most compatible)
        const copySummaryTextOnly = async () => {
          const text = String($('#summary-box')?.value || '').trim();
          try{
            await navigator.clipboard.writeText(text);
            toast('تم نسخ الملخص');
          }catch(_){
            try{
              // legacy fallback
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.setAttribute('readonly','');
              ta.style.position = 'fixed';
              ta.style.top = '-1000px';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
              toast('تم نسخ الملخص');
            }catch(__){
              toast('تعذر النسخ');
            }
          }
        };


        

        // copy documents as ONE image (best for Discord paste)
        const copySummaryAsSingleImage = async () => {
          const imgs = [];

          // temp documents (3 boxes) - stored in memory only
          try{
            const t = window.__hiTempDocs || {};
            if(t.cert) imgs.push({ label:'شهادة', src: t.cert });
            if(t.id) imgs.push({ label:'هوية', src: t.id });
            if(t.license) imgs.push({ label:'رخصة', src: t.license });
          }catch(_){ }

          try{
            const blob = await composeDocsOnlyImageBlob({ imgs });
            if(!blob){
              toast('لا توجد صور بطاقات لنسخها');
              return;
            }

            if(navigator.clipboard?.write && typeof ClipboardItem === 'function'){
              try{
                await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
                toast('تم نسخ الصور كصورة واحدة');
                return;
              }catch(e){
                // If clipboard image write is blocked/unsupported on this device, fall back to download below.
                console.warn(e);
              }
            }

            // fallback: download (if clipboard images not supported)
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'docs.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
            toast('تم تنزيل الصورة (النسخ غير مدعوم)');
          }catch(err){
            console.warn(err);
            toast('تعذر النسخ');
          }
        };

        // Compose ONLY the 3 docs images (Certificate / ID / License) as a single PNG.
        // No summary text included.
        const composeDocsOnlyImageBlob = async ({ imgs }) => {
          const list = Array.isArray(imgs) ? imgs.filter(x => x && x.src) : [];
          if(!list.length) return null;

          const loadImg = (src) => new Promise((resolve, reject) => {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = src;
          });

          const loaded = [];
          for(const it of list){
            try{
              const im = await loadImg(it.src);
              const w = im.naturalWidth || im.width || 1;
              const h = im.naturalHeight || im.height || 1;
              loaded.push({ label: it.label || '', im, w, h, r: w / h });
            }catch(_){}
          }

          const n = loaded.length;
          if(!n) return null;

          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const pad = 14;     // transparent padding
          const gap = 18;     // transparent gap between images

          const fitContain = (iw, ih, sw, sh) => {
            const s = Math.min(sw / iw, sh / ih);
            return { w: iw * s, h: ih * s };
          };

          const maxW = 2048;
          let W = maxW;
          let H = 0;

          const slots = []; // {x,y,w,h,img}

          if(n === 1){
            const it = loaded[0];
            const availW = W - pad * 2;
            const maxH = 1600;
            const dim = fitContain(it.w, it.h, availW, maxH);
            H = Math.round(dim.h + pad * 2);
            slots.push({ x: pad, y: pad, w: availW, h: H - pad * 2, img: it });
          }else if(n === 2){
            const sorted = loaded.slice().sort((a,b) => a.r - b.r);
            const hasPortrait = sorted[0].r < 0.95;
            const availW = W - pad * 2;

            if(hasPortrait){
              // portrait on the left, the other on the right (bigger + clearer)
              H = 1280;
              const leftW = Math.round((availW - gap) * 0.42);
              const rightW = availW - gap - leftW;

              slots.push({ x: pad, y: pad, w: leftW, h: H - pad * 2, img: sorted[0] });
              slots.push({ x: pad + leftW + gap, y: pad, w: rightW, h: H - pad * 2, img: sorted[1] });
            }else{
              // two landscapes side-by-side
              H = 900;
              const colW = (availW - gap) / 2;

              slots.push({ x: pad, y: pad, w: colW, h: H - pad * 2, img: loaded[0] });
              slots.push({ x: pad + colW + gap, y: pad, w: colW, h: H - pad * 2, img: loaded[1] });
            }
          }else{
            // 3 images: smart layout (certificate usually portrait) on the left
            // and the other two stacked on the right — maximizes readability
            const sorted = loaded.slice().sort((a,b) => a.r - b.r); // most portrait-ish first
            const leftImg = sorted[0];
            const rightImgs = [sorted[1], sorted[2]];

            H = 1280;
            const availW = W - pad * 2;
            const leftW = Math.round((availW - gap) * 0.42);
            const rightW = availW - gap - leftW;
            const rightH = (H - pad * 2 - gap) / 2;

            slots.push({ x: pad, y: pad, w: leftW, h: H - pad * 2, img: leftImg });
            slots.push({ x: pad + leftW + gap, y: pad, w: rightW, h: rightH, img: rightImgs[0] });
            slots.push({ x: pad + leftW + gap, y: pad + rightH + gap, w: rightW, h: rightH, img: rightImgs[1] });
          }

          const canvas = document.createElement('canvas');
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);

          const ctx = canvas.getContext('2d', { alpha: true });
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';

          // IMPORTANT: keep background transparent (no fillRect)

          for(const s of slots){
            const it = s.img;
            const dim = fitContain(it.w, it.h, s.w, s.h);
            const dx = s.x + (s.w - dim.w) / 2;
            const dy = s.y + (s.h - dim.h) / 2;
            ctx.drawImage(it.im, dx, dy, dim.w, dim.h);
          }

          const blob = await new Promise((resolve) => {
            canvas.toBlob((b) => resolve(b), 'image/png');
          });
          return blob;
        };



        const isLikelyDiscordWebhook = (u) => {
          const s = String(u || '').trim();
          if(!s) return false;
          // discord.com + discordapp.com + canary/ptb subdomains
          return /^https?:\/\/((canary|ptb)\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_\-]+/i.test(s);
        };

        const dataUrlToBlob = async (dataUrl) => {
          const res = await fetch(dataUrl);
          return await res.blob();
        };

        const sendSummaryWithImagesToDiscord = async () => {
          const hook = String(discordHookInput?.value || '').trim();
          if(!hook){
            toast('حط Webhook URL');
            return;
          }
          if(!isLikelyDiscordWebhook(hook)){
            toast('Webhook غير صحيح');
            return;
          }

          const btn = discordSendBtn;
          const prevTxt = btn ? btn.textContent : '';
          try{
            if(btn){ btn.disabled = true; btn.textContent = '...'; }

            const summary = String($('#summary-box')?.value || '').trim();
            const imgs = [];

            // candidate photo (temporary)
            try{
              const p = (typeof c?.photo === 'string') ? c.photo.trim() : '';
              if(p) imgs.push({ key:'photo', label:'صورة المرشح', src:p });
            }catch(_){}

            // temp documents (3 boxes) - stored in memory only
            try{
              const t = window.__hiTempDocs || {};
              if(t.cert) imgs.push({ key:'cert', label:'صورة لشهادة', src: t.cert });
              if(t.id) imgs.push({ key:'id', label:'صورة بطاقة الهوية', src: t.id });
              if(t.license) imgs.push({ key:'license', label:'صورة بطاقة رخصة', src: t.license });
            }catch(_){}

            const fd = new FormData();

            const payload = {
              content: '',
              allowed_mentions: { parse: ['roles','users'] }
            };

            let fileIndex = 0;

            if(summary && summary.length <= 1900){
              payload.content = summary;
            }else if(summary){
              payload.content = 'ملخص طويل — مرفق ملف summary.txt';
              const txtBlob = new Blob([summary], { type:'text/plain;charset=utf-8' });
              fd.append(`files[${fileIndex}]`, txtBlob, 'summary.txt');
              fileIndex++;
            }else{
              payload.content = imgs.length ? ' ' : 'لا يوجد ملخص';
            }

            fd.append('payload_json', JSON.stringify(payload));

            const safeName = (k) => {
              const map = {
                photo: 'candidate',
                cert: 'certificate',
                id: 'id-card',
                license: 'license'
              };
              return map[k] || 'image';
            };

            for(const im of imgs){
              try{
                const b = await dataUrlToBlob(im.src);
                if(!b || !String(b.type||'').startsWith('image/')) continue;
                const ext = (b.type === 'image/jpeg') ? 'jpg' : (b.type === 'image/webp' ? 'webp' : 'png');
                fd.append(`files[${fileIndex}]`, b, `${safeName(im.key)}.${ext}`);
                fileIndex++;
              }catch(_){ }
            }

            const res = await fetch(hook, {
              method: 'POST',
              body: fd
            });

            if(!res || !res.ok){
              let details = '';
              try{ details = await res.text(); }catch(_){}
              console.warn('Discord webhook failed', res?.status, details);
              toast('تعذر الإرسال للدسكورد');
              return;
            }

            toast('تم الإرسال للدسكورد');
            closeDiscordModal({ commit:true });
          }catch(err){
            console.error(err);
            toast('تعذر الإرسال للدسكورد');
          }finally{
            if(btn){ btn.disabled = false; btn.textContent = prevTxt || 'إرسال'; }
          }
        };

$('#btn-copy-summary').addEventListener('click', () => copySummaryTextOnly());

$('#btn-copy-summary-image')?.addEventListener('click', async () => {
          await copySummaryAsSingleImage();
        });

        // photo upload/paste
        const photoFile = $('#photo-file');
        const chooseBtn = $('#btn-choose-photo');
        const photoBox = $('#photo-box');
        chooseBtn?.addEventListener('click', () => { if(photoFile && !photoFile.disabled) photoFile.click(); });
        const removeBtn = $('#btn-remove-photo');
        removeBtn?.addEventListener('click', () => {
          if(removeBtn.disabled) return;
          c.photo = '';
          photoBox.innerHTML = `<div class="muted">اسحب صورة هنا أو ألصق (Ctrl+V)</div><div class="photo-hint">رفع أو لصق (Ctrl+V)</div>`;
          removeBtn.disabled = true;
        });
        const overlay = $('#img-overlay');
        const overlayImg = $('#img-overlay-img');
        const overlayClose = $('#img-overlay-close');
        let autoOverlayShown = false;

        const showOverlay = (src) => {
          if(!overlay || !overlayImg) return;
          overlayImg.src = src;
          overlay.style.display = 'flex';
        };
        const hideOverlay = () => {
          if(!overlay || !overlayImg) return;
          overlay.style.display = 'none';
          overlayImg.src = '';
        };

        overlayClose?.addEventListener('click', hideOverlay);
        overlay?.addEventListener('click', (e) => {
          if(e.target === overlay) hideOverlay();
        });

        photoBox?.addEventListener('click', () => {
          if(c.photo) showOverlay(c.photo);
        });
                function setPhoto(dataUrl){
          c.photo = dataUrl;
          photoBox.innerHTML = `<img id="photo-img" alt="Candidate photo" src="${dataUrl}"><div class="photo-hint">رفع أو لصق (Ctrl+V)</div>`;
          const img = $('#photo-img', photoBox);
          if(img){
            img.classList.add('photo-pop');
            setTimeout(() => img.classList.remove('photo-pop'), 380);
          }
          const rmBtn = $('#btn-remove-photo');
          if(rmBtn){ rmBtn.disabled = false; }
          if(!autoOverlayShown){
            autoOverlayShown = true;
            setTimeout(() => showOverlay(dataUrl), 120);
          }
        }

        if(canEditResults){
          photoFile.addEventListener('change', async () => {
            const f = photoFile.files && photoFile.files[0];
            if(!f) return;
            const dataUrl = await fileToDataUrl(f);
            setPhoto(dataUrl);
          });

          // temp docs (3 boxes) - memory only (no Firestore / no LocalStorage)
          window.__hiTempDocs = { cert:'', id:'', license:'' };
          let docStore = window.__hiTempDocs; // switches to draft when docs sub-modal is open
          let docDraft = null;

          const docsBackdrop = document.getElementById('docs-submodal');
          const docsOpenBtn = document.getElementById('btn-open-docs');
          const docsCloseX = document.getElementById('docs-submodal-x');
          const docsCancelBtn = document.getElementById('docs-submodal-cancel');
          // (removed) docs save button
          const docsSendBtn = document.getElementById('docs-submodal-send');
          const docsCopyBtn = document.getElementById('docs-submodal-copy');
          const docsCopyImgBtn = document.getElementById('docs-submodal-copy-image');


          // Discord Webhook sub-modal (send directly)
          const discordBackdrop = document.getElementById('discord-submodal');
          const discordOpenBtn = document.getElementById('btn-send-discord');
          const discordCloseX = document.getElementById('discord-submodal-x');
          const discordCancelBtn = document.getElementById('discord-cancel');
          const discordSendBtn = document.getElementById('discord-send');
          const discordHookInput = document.getElementById('discord-webhook');

          let discordHookDraft = String(window.__hiDiscordHook || window.DISCORD_WEBHOOK_URL || '').trim();

          let activePasteTarget = 'photo'; // photo | cert | id | license

          const setActiveTarget = (key) => {
            activePasteTarget = key || 'photo';
            // UI highlight
            try{
              photoBox?.classList.toggle('active-drop', activePasteTarget === 'photo');
              ['cert','id','license'].forEach(k => {
                const el = document.getElementById(k==='license'?'doc-lic':(k==='id'?'doc-id':'doc-cert'));
                if(el) el.classList.toggle('active-drop', activePasteTarget === k);
              });
            }catch(_){}
          };

          const renderDocBox = (key) => {
            const src = docStore?.[key] || '';
            const boxId = (key==='license') ? 'doc-lic' : (key==='id' ? 'doc-id' : 'doc-cert');
            const bodyId = (key==='license') ? 'doc-lic-body' : (key==='id' ? 'doc-id-body' : 'doc-cert-body');
            const bodyEl = document.getElementById(bodyId);
            const dropEl = document.getElementById(boxId);
            const removeBtn = document.querySelector(`[data-doc-remove="${key}"]`);
            if(removeBtn) removeBtn.style.display = src ? 'inline-flex' : 'none';
            if(!bodyEl) return;
            if(!src){
              bodyEl.innerHTML = `<div class="muted doc-empty">اسحب الصورة • Ctrl+V • أو اختر من الجهاز</div>`;
              return;
            }
            bodyEl.innerHTML = `<img class="doc-img" alt="" src="${src}">`;
          };

          const setDocImage = async (key, fileOrDataUrl) => {
            try{
              let src = '';
              if(typeof fileOrDataUrl === 'string') src = fileOrDataUrl;
              else src = await fileToDataUrl(fileOrDataUrl);
              if(!docStore){
                window.__hiTempDocs = window.__hiTempDocs || { cert:'', id:'', license:'' };
                docStore = window.__hiTempDocs;
              }
              docStore[key] = src;
              renderDocBox(key);
            }catch(e){
              console.warn(e);
            }
          };

          const clearDoc = (key) => {
            if(!docStore){
              window.__hiTempDocs = window.__hiTempDocs || { cert:'', id:'', license:'' };
              docStore = window.__hiTempDocs;
            }
            docStore[key] = '';
            renderDocBox(key);
          };

          const renderAllDocs = () => {
            ['cert','id','license'].forEach(renderDocBox);
          };

          const isDocsModalOpen = () => {
            return Boolean(docsBackdrop && !docsBackdrop.classList.contains('hidden'));
          };


          const isDiscordModalOpen = () => {
            return Boolean(discordBackdrop && !discordBackdrop.classList.contains('hidden'));
          };

          const openDiscordModal = () => {
            if(!discordBackdrop) return;
            try{
              if(window.matchMedia && window.matchMedia('(max-width:980px)').matches){
                toast('إرسال للدسكورد متاح للكمبيوتر فقط');
                return;
              }
            }catch(_){ }

            discordHookDraft = String(window.__hiDiscordHook || window.DISCORD_WEBHOOK_URL || discordHookDraft || '').trim();
            if(discordHookInput) discordHookInput.value = discordHookDraft;

            discordBackdrop.classList.remove('hidden');
            discordBackdrop.setAttribute('aria-hidden','false');
            setTimeout(() => {
              try{ discordHookInput?.focus(); discordHookInput?.select(); }catch(_){}
            }, 30);
          };

          const closeDiscordModal = ({ commit=false } = {}) => {
            if(!discordBackdrop) return;
            if(commit){
              discordHookDraft = String(discordHookInput?.value || '').trim();
              window.__hiDiscordHook = discordHookDraft;
            }
            discordBackdrop.classList.add('hidden');
            discordBackdrop.setAttribute('aria-hidden','true');
          };

          const openDocsModal = () => {
            if(!docsBackdrop) return;
            try{
              if(window.matchMedia && window.matchMedia('(max-width:980px)').matches){
                toast('إضافة صور البطاقات متاحة للكمبيوتر فقط');
                return;
              }
            }catch(_){ }
            // draft copy (so Cancel truly cancels)
            docDraft = {
              cert: String(window.__hiTempDocs?.cert || ''),
              id: String(window.__hiTempDocs?.id || ''),
              license: String(window.__hiTempDocs?.license || ''),
            };
            docStore = docDraft;
            renderAllDocs();
            docsBackdrop.classList.remove('hidden');
            docsBackdrop.setAttribute('aria-hidden','false');
            setActiveTarget('cert');
            try{ document.getElementById('doc-cert')?.focus(); }catch(_){ }
          };

          const closeDocsModal = ({ commit=false } = {}) => {
            if(!docsBackdrop) return;

            if(commit && docDraft){
              window.__hiTempDocs = {
                cert: String(docDraft.cert || ''),
                id: String(docDraft.id || ''),
                license: String(docDraft.license || ''),
              };
            }
            docDraft = null;
            docStore = window.__hiTempDocs;
            renderAllDocs();

            docsBackdrop.classList.add('hidden');
            docsBackdrop.setAttribute('aria-hidden','true');
            setActiveTarget('photo');
          };

          // Wire docs sub-modal
          docsOpenBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            openDocsModal();
          });

          discordOpenBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            openDiscordModal();
          });
          docsCloseX?.addEventListener('click', (e) => {
            e.preventDefault();
            closeDocsModal({ commit:false });
          });
          docsCancelBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            closeDocsModal({ commit:false });
          });

          docsSendBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            closeDocsModal({ commit:true });
            openDiscordModal();
          });
docsCopyBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            closeDocsModal({ commit:true });
            await copySummaryTextOnly();
          });
          docsCopyImgBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            closeDocsModal({ commit:true });
            await copySummaryAsSingleImage();
          });
          docsBackdrop?.addEventListener('click', (e) => {
            if(e.target === docsBackdrop) closeDocsModal({ commit:false });
          });


          // Wire Discord sub-modal
          discordCloseX?.addEventListener('click', (e) => {
            e.preventDefault();
            closeDiscordModal({ commit:true });
          });
          discordCancelBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            closeDiscordModal({ commit:true });
          });
          discordSendBtn?.addEventListener('click', async (e) => {
            e.preventDefault();
            await sendSummaryWithImagesToDiscord();
          });
          discordBackdrop?.addEventListener('click', (e) => {
            if(e.target === discordBackdrop) closeDiscordModal({ commit:true });
          });
          discordHookInput?.addEventListener('keydown', async (e) => {
            if(e.key === 'Enter'){
              e.preventDefault();
              await sendSummaryWithImagesToDiscord();
            }
          });

          // Escape closes Discord modal first (without closing the main modal)
          const onDiscordEsc = (e) => {
            if(e.key !== 'Escape') return;
            if(!isDiscordModalOpen()) return;
            e.preventDefault();
            e.stopPropagation();
            closeDiscordModal({ commit:true });
          };
          try{
            if(window.__hiDiscordEscHandler){
              window.removeEventListener('keydown', window.__hiDiscordEscHandler, true);
            }
          }catch(_){ }
          window.__hiDiscordEscHandler = onDiscordEsc;
          window.addEventListener('keydown', onDiscordEsc, true);

          // Escape closes docs modal first (without closing the main modal)
          const onDocsEsc = (e) => {
            if(e.key !== 'Escape') return;
            if(!isDocsModalOpen()) return;
            e.preventDefault();
            e.stopPropagation();
            closeDocsModal({ commit:false });
          };
          try{
            if(window.__hiDocsEscHandler){
              window.removeEventListener('keydown', window.__hiDocsEscHandler, true);
            }
          }catch(_){ }
          window.__hiDocsEscHandler = onDocsEsc;
          window.addEventListener('keydown', onDocsEsc, true);

          // setup doc boxes (desktop only)
          const setupDocBox = (key) => {
            const boxId = (key==='license') ? 'doc-lic' : (key==='id' ? 'doc-id' : 'doc-cert');
            const fileId = (key==='license') ? 'doc-lic-file' : (key==='id' ? 'doc-id-file' : 'doc-cert-file');
            const dropEl = document.getElementById(boxId);
            const fileEl = document.getElementById(fileId);
            const removeBtn = document.querySelector(`[data-doc-remove="${key}"]`);
            if(!dropEl || !fileEl) return;

            renderDocBox(key);

            dropEl.addEventListener('click', () => { setActiveTarget(key); });
            const chooseBtn = document.querySelector(`[data-doc-choose="${key}"]`);
            chooseBtn?.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              setActiveTarget(key);
              fileEl.click();
            });

            dropEl.addEventListener('dblclick', () => {
              setActiveTarget(key);
              const has = Boolean(docStore?.[key]);
              if(has){ try{ showOverlay(docStore[key]); }catch(_){ } }
              else fileEl.click();
            });
            dropEl.addEventListener('keydown', (e) => {
              if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); setActiveTarget(key); fileEl.click(); }
            });
            dropEl.addEventListener('focus', () => setActiveTarget(key));
            dropEl.addEventListener('dragover', (e) => { e.preventDefault(); setActiveTarget(key); dropEl.classList.add('drag'); });
            dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag'));
            dropEl.addEventListener('drop', async (e) => {
              e.preventDefault();
              dropEl.classList.remove('drag');
              setActiveTarget(key);
              const f = e.dataTransfer?.files?.[0];
              if(f && String(f.type||'').startsWith('image/')) await setDocImage(key, f);
            });

            fileEl.addEventListener('change', async () => {
              const f = fileEl.files?.[0];
              if(f && String(f.type||'').startsWith('image/')) await setDocImage(key, f);
              fileEl.value = '';
            });

            removeBtn?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); clearDoc(key); });
          };

          setupDocBox('cert');
          setupDocBox('id');
          setupDocBox('license');

          // photo is default active target
          photoBox?.addEventListener('click', () => setActiveTarget('photo'));
          setActiveTarget('photo');

          // paste support (routes to active target)
          const onPaste = async (evt) => {
            const items = evt.clipboardData?.items;
            if(!items) return;
            for(const it of items){
              if(it.type && it.type.startsWith('image/')){
                const file = it.getAsFile();
                if(file){
                  const dataUrl = await fileToDataUrl(file);
                  if(activePasteTarget === 'photo') setPhoto(dataUrl);
                  else if(activePasteTarget === 'cert' || activePasteTarget === 'id' || activePasteTarget === 'license') await setDocImage(activePasteTarget, dataUrl);
                  evt.preventDefault();
                  return;
                }
              }
            }
          };

          // avoid accumulating multiple handlers
          try{
            if(window.__hiCandidatePasteHandler){
              window.removeEventListener('paste', window.__hiCandidatePasteHandler);
            }
          }catch(_){}
          window.__hiCandidatePasteHandler = onPaste;
          window.addEventListener('paste', onPaste, { once:false });

          // drag & drop
          photoBox.addEventListener('dragover', (e) => { e.preventDefault(); photoBox.style.borderColor='rgba(53,224,201,.45)'; });
          photoBox.addEventListener('dragleave', () => { photoBox.style.borderColor='rgba(232,243,255,.18)'; });
          photoBox.addEventListener('drop', async (e) => {
            e.preventDefault();
            photoBox.style.borderColor='rgba(232,243,255,.18)';
            const f = e.dataTransfer?.files?.[0];
            if(f && f.type.startsWith('image/')){
              const dataUrl = await fileToDataUrl(f);
              setPhoto(dataUrl);
            }
          });
        }

        // close
        $('#btn-close').addEventListener('click', () => requestCloseModal('btn-close'));

        // save
        const btnSave = $('#btn-save-candidate');
        if(btnSave){
          let saving = false;
          btnSave.addEventListener('click', async () => {
            if(saving) return;
            saving = true;
            const _t = btnSave.textContent;
            btnSave.disabled = true;
            btnSave.textContent = 'جارٍ الحفظ...';
            btnSave.dataset.busy = '1';

            try{
              // Gate writes
              if(quota.locked){
                toast('النظام مقفل مؤقتًا بسبب حد الاستخدام.');
                return;
              }
              // enforce fixed interviewer
              c.interviewer = (c.interviewer || session?.username || '');
              const _iq = questions.find(q => String(q.label).trim() === 'المقابل');
              if(_iq){
                c.answers = c.answers || {};
                c.answers[_iq.id] = c.interviewer;
              }
              // ensure core fields
              c.name = String(c.name || '').trim();
              c.nationalId = String(c.nationalId || '').trim();
              c.age = String(c.age || '').trim();

              if(!c.name || !c.nationalId){
                toast('الاسم والرقم الوطني مطلوبان.');
                return;
              }
              const docId = isEdit ? candidateId : uid('c');

              await upsertCandidateFS(c, !isEdit, docId);

              // photo (transient only)
              if(c.photo){
                photoCache.set(docId, c.photo);
              }else{
                photoCache.delete(docId);
              }

              if(isEdit){
                addAudit('candidate','تعديل مرشح', { name: c.name, nationalId: c.nationalId, status: c.status });
              }else{
                addAudit('candidate','إضافة مرشح', { name: c.name, nationalId: c.nationalId, status: c.status });
              }

              toast('تم الحفظ');
              if(activeCandidateModal) activeCandidateModal.dirty = false;
              closeModal();
            }finally{
              saving = false;
              if(document.body.contains(btnSave)){
                delete btnSave.dataset.busy;
                btnSave.disabled = false;
                btnSave.textContent = _t;
                try{ validateNationalIdNow(); }catch(_e){}
              }
            }
          });
        }
      }
    });
  }

  
  function scoreClassByValue(v, max){
    const n = Number(v ?? 0);
    const m = Number(max ?? 2);
    if(n <= 0) return 'score-red';
    if(n >= m) return 'score-green';
    return 'score-amber';
  }

  
  function openCandidateDetailsModal(candidateId){
    if(isAdmin()) return openCandidateDetailsModalAdmin(candidateId);
    return openCandidateDetailsModalLite(candidateId);
  }

function openCandidateDetailsModalLite(candidateId){
    const c = getCandidateById(candidateId);
    if(!c){
      toast('لم يتم العثور على المرشح');
      return;
    }
    const title = `تفاصيل المرشح — ${c.name || '—'}`;

    const summaryText = buildSummary(c);
    const lines = summaryText.split('\n').filter(Boolean);

    const summaryHtml = lines.map(line => {
      const trimmed = String(line).trim();
      if(trimmed.startsWith('<@&')){
        return `<div class="summary-tag">${escapeHtml(trimmed)}</div>`;
      }
      const m = trimmed.match(/^(.+?)\s*:\s*(.*)$/);
      if(!m) return `<div class="summary-row"><div class="sr-label">${escapeHtml(trimmed)}</div></div>`;
      const label = m[1];
      const val = m[2] || '—';
      return `<div class="summary-row"><div class="sr-label">${escapeHtml(label)}</div><div class="sr-val">${escapeHtml(val)}</div></div>`;
    }).join('');

    const resultHtml = SCORE_CONFIG.map((s, idx) => {
      const max = getScoreMax(idx);
      const val = Number(c.scores?.[idx] ?? 0);
      const cls = scoreClassByValue(val, max);
      return `
        <div class="res-item ${cls}">
          <div class="ri-title">السؤال ${s.n}</div>
          <div class="ri-score">${val} / ${max}</div>
        </div>
      `;
    }).join('');

    const statusB = statusBadge(c.status);

    const body = `
      <div class="details-layout">
        <div class="details-card">
          <div class="details-head">
            <div>
              <div class="details-title">الملخص</div>
              <div class="muted">مرتّب وجاهز للنسخ</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="btn tiny" id="btn-copy-summary2">نسخ</button>
            </div>
          </div>
          <div class="summary-list">${summaryHtml}</div>
        </div>

        <div class="details-card">
          <div class="details-head">
            <div>
              <div class="details-title">النتيجة</div>
              <div class="muted">ألوان الدرجة: 0 أحمر • 1 أصفر • 2 أخضر</div>
            </div>
            <div class="badge ${statusB}">${escapeHtml(c.status || 'قيد المراجعة')}</div>
          </div>

          <div class="result-top">
            <div class="result-total">المجموع: <b>${calcTotalScore(c.scores || [])}</b></div>
            <div class="muted">آخر تحديث: ${escapeHtml(c.updatedAt || '—')}</div>
          </div>

          <div class="result-grid">${resultHtml}</div>
        </div>
      </div>
    `;

    const foot = `
      ${canEditCandidate() ? `<button class="btn primary" id="btn-edit-from-details">تعديل</button>` : ``}
      <button class="btn" id="btn-close-details">إغلاق</button>
    `;

    openModal({
      title,
      body,
      foot,
      onReady: () => {
        $('#btn-close-details')?.addEventListener('click', closeModal);
        $('#btn-copy-summary2')?.addEventListener('click', async () => {
          try{
            await navigator.clipboard.writeText(summaryText);
            toast('تم نسخ الملخص');
          }catch(err){
            toast('تعذر نسخ الملخص');
          }
        });
        $('#btn-edit-from-details')?.addEventListener('click', () => {
          closeModal();
          openCandidateModal(candidateId);
        });
      }
    });
  }


  function openCandidateDetailsModalAdmin(candidateId){
    const c = getCandidateById(candidateId);
    if(!c){
      toast('لم يتم العثور على المرشح');
      return;
    }
    const title = `تفاصيل المرشح — ${c.name || '—'}`;

    const summaryText = buildSummary(c);
    const lines = summaryText.split('\n').filter(Boolean);

    const summaryHtml = lines.map(line => {
      const trimmed = String(line).trim();
      if(trimmed.startsWith('<@&')){
        return `<div class="summary-tag">${escapeHtml(trimmed)}</div>`;
      }
      const m = trimmed.match(/^(.+?)\s*:\s*(.*)$/);
      if(!m) return `<div class="summary-row"><div class="sr-label">${escapeHtml(trimmed)}</div></div>`;
      const label = m[1];
      const val = m[2] || '—';
      return `<div class="summary-row"><div class="sr-label">${escapeHtml(label)}</div><div class="sr-val">${escapeHtml(val)}</div></div>`;
    }).join('');

    const resultHtml = SCORE_CONFIG.map((s, idx) => {
      const max = getScoreMax(idx);
      const val = Number(c.scores?.[idx] ?? 0);
      const cls = scoreClassByValue(val, max);
      return `
        <div class="res-item ${cls}">
          <div class="ri-title">السؤال ${s.n}</div>
          <div class="ri-score">${val} / ${max}</div>
        </div>
      `;
    }).join('');

    const qaHtml = questions.map(q => {
      const lab = String(q.label || '').trim();
      let val = (c.answers?.[q.id] ?? '');
      if(lab === 'الاسم') val = c.name || val;
      if(lab === 'الرقم الوطني') val = c.nationalId || val;
      if(lab === 'العمر') val = c.age || val;
      if(lab === 'المقابل') val = c.interviewer || val;
      const s = (val === undefined || val === null) ? '' : String(val);
      const disp = s.trim() ? s.trim() : '—';
      const t = (q.type === 'select') ? 'خيارات' : (q.type === 'textarea' ? 'نص طويل' : 'نص');
      const vis = visibilityName(q.visibility || 'all');
      return `
        <div class="qa-row">
          <div class="qa-label">${escapeHtml(lab || '—')}</div>
          <div class="qa-val">${escapeHtml(disp)}</div>
          <div class="qa-tags">
            <span class="qa-tag">${escapeHtml(t)}</span>
            <span class="qa-tag">${escapeHtml(vis)}</span>
          </div>
        </div>
      `;
    }).join('');

    const statusB = statusBadge(c.status);

    const body = `
      <div class="details-layout admin">
        <div class="details-card">
          <div class="details-head">
            <div>
              <div class="details-title">الملخص</div>
              <div class="muted">مرتّب وجاهز للنسخ</div>
            </div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="btn tiny" id="btn-copy-summary-admin">نسخ</button>
            </div>
          </div>
          <div class="summary-list">${summaryHtml}</div>
        </div>

        <div class="details-card">
          <div class="details-head">
            <div>
              <div class="details-title">النتيجة</div>
              <div class="muted">ألوان الدرجة: 0 أحمر • 1 أصفر • 2 أخضر</div>
            </div>
            <div class="badge ${statusB}">${escapeHtml(c.status || 'قيد المراجعة')}</div>
          </div>

          <div class="result-top">
            <div class="result-total">المجموع: <b>${calcTotalScore(c.scores || [])}</b></div>
            <div class="muted">آخر تحديث: ${escapeHtml(c.updatedAt || '—')}</div>
          </div>

          <div class="result-grid">${resultHtml}</div>
        </div>

        <div class="details-card qa-card">
          <div class="details-head">
            <div>
              <div class="details-title">كل الأسئلة</div>
              <div class="muted">يتحدث تلقائيًا عند إضافة/تعديل الأسئلة</div>
            </div>
            <div class="qa-meta">${questions.length} سؤال</div>
          </div>
          <div class="qa-list">${qaHtml}</div>
        </div>
      </div>
    `;

    const foot = `
      ${canEditCandidate() ? `<button class="btn primary" id="btn-edit-from-details-admin">تعديل</button>` : ``}
      <button class="btn" id="btn-close-details-admin">إغلاق</button>
    `;

    openModal({
      title,
      body,
      foot,
      onReady: () => {
        $('#btn-close-details-admin')?.addEventListener('click', closeModal);
        $('#btn-copy-summary-admin')?.addEventListener('click', async () => {
          try{
            await navigator.clipboard.writeText(summaryText);
            toast('تم نسخ الملخص');
          }catch(err){
            toast('تعذر نسخ الملخص');
          }
        });
        $('#btn-edit-from-details-admin')?.addEventListener('click', () => {
          closeModal();
          openCandidateModal(candidateId);
        });
      }
    });
  }

function renderQuestionInput(q, value, disabled){
    // اجعل حقل (المقابل) تلقائيًا باسم المستخدم الحالي ولا يمكن تعديله
    if(q && String(q.label).trim() === 'المقابل'){
      value = (value || ((session && session.username) ? session.username : ''));
      disabled = true;
    }
    const dis = disabled ? 'disabled' : '';
    if(q.type === 'text'){
      return `
        <div class="field">
          <label>${escapeHtml(q.label)}</label>
          <input data-qid="${q.id}" data-qlabel="${escapeHtml(q.label)}" type="text" value="${escapeHtml(value)}" ${dis}/>
        </div>
      `;
    }
    if(q.type === 'textarea'){
      return `
        <div class="field">
          <label>${escapeHtml(q.label)}</label>
          <textarea data-qid="${q.id}" data-qlabel="${escapeHtml(q.label)}" ${dis}>${escapeHtml(value)}</textarea>
        </div>
      `;
    }
    // select
    const opts = (q.options || []).map(o => `<option value="${escapeHtml(o)}" ${String(value)===String(o)?'selected':''}>${escapeHtml(o)}</option>`).join('');
    return `
      <div class="field">
        <label>${escapeHtml(q.label)}</label>
        <select data-qid="${q.id}" data-qlabel="${escapeHtml(q.label)}" ${dis}>
          <option value="" ${value===''?'selected':''}>—</option>
          ${opts}
        </select>
      </div>
    `;
  }

  function buildSummary(c){
    const tmpl = normalizeSummaryTemplate(summaryTemplate, questions);
    const lines = [];

    const getAnswerByQid = (qid) => {
      if(!qid) return '';
      const v = (c && c.answers) ? (c.answers[qid] ?? '') : '';
      return (v === undefined || v === null) ? '' : String(v).trim();
    };

    const formatLine = (label, value) => {
      const lab = String(label || '').trim();
      const val = (value === undefined || value === null) ? '' : String(value).trim();
      if(!lab && val) return val;
      if(!lab) return '';
      return `${lab} : ${val}`;
    };

    const fmtTime = (ts) => {
      try{
        if(!ts) return '';
        const d = (typeof ts?.toDate === 'function') ? ts.toDate() : new Date(ts);
        if(isNaN(d.getTime())) return '';
        return d.toLocaleString('en-GB');
      }catch(_){ return ''; }
    };

    for(const item of (tmpl || [])){
      if(!item) continue;
      if(item.enabled === false) continue;
      if(!canSeeSummaryItem(item)) continue;

      const kind = String(item.kind || 'question');
      if(kind === 'question'){
        const qid = String(item.questionId || '');
        const q = questions.find(x => x.id === qid);
        // "المقابل" ثابت باسم المستخدم (مثل الفورم)
        if(q && String(q.label||'').trim() === 'المقابل'){
          const who = (c?.interviewer || (session?.username || '')).trim();
          const line = formatLine(item.label || q.label, who);
          if(line) lines.push(line);
          continue;
        }

        const val = getAnswerByQid(qid);
        const line = formatLine(item.label || (q?.label || ''), val);
        if(line) lines.push(line);
        continue;
      }

      if(kind === 'computed'){
        const key = String(item.computed || 'totalScore');
        let val = '';
        if(key === 'totalScore'){
          val = String(calcTotalScore(c?.scores || []) || 0);
        }else if(key === 'createdAt'){
          val = fmtTime(c?.createdAt);
        }else if(key === 'updatedAt'){
          val = fmtTime(c?.updatedAt);
        }
        const line = formatLine(item.label || 'النتيجة', val);
        if(line) lines.push(line);
        continue;
      }

      if(kind === 'fixed'){
        const txt = String(item.text || '').trim();
        const line = (String(item.label||'').trim())
          ? formatLine(item.label, txt)
          : txt;
        if(line) lines.push(line);
        continue;
      }
    }

    // fallback if template is empty for any reason
    if(!lines.length){
      const parts = [
        `الاسم : ${(c?.name || '').trim()}`,
        `الرقم الوطني : ${(c?.nationalId || '').trim()}`,
        `العمر : ${(c?.age || '').trim()}`,
        `المجموع : ${calcTotalScore(c?.scores || [])}`,
      ];
      lines.push(...parts);
    }

    // Always keep the health supervisor mention as the LAST line
    const mention = String(healthSupervisorMention || DEFAULT_HEALTH_SUPERVISOR_MENTION).trim();
    if(mention){
      for(let i=lines.length-1;i>=0;i--){
        if(String(lines[i]).trim() === mention) lines.splice(i,1);
      }
      lines.push(mention);
    }

    return lines.join('\n');
  }


  
  async function fileToDataUrl(file){
    // Lightweight compression to keep the app fast (esp. with many candidates)
    // - Resizes longest side to <= 1400px
    // - Encodes as JPEG (or WebP if supported)
    const readRaw = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    try{
      if(!file || !file.type || !file.type.startsWith('image/')) return await readRaw();
      // if already small, keep as-is
      if(file.size && file.size < 250 * 1024) return await readRaw();

      const MAX_DIM = 1400;
      const QUALITY = 0.78;

      const bmp = (window.createImageBitmap)
        ? await createImageBitmap(file)
        : await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
          });

      const w0 = bmp.width || bmp.naturalWidth || 0;
      const h0 = bmp.height || bmp.naturalHeight || 0;
      if(!w0 || !h0) return await readRaw();

      const scale = Math.min(1, MAX_DIM / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha:false });
      if(!ctx) return await readRaw();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);

      // WebP if available, else JPEG
      let mime = 'image/jpeg';
      try{
        const test = canvas.toDataURL('image/webp', 0.7);
        if(test && test.startsWith('data:image/webp')) mime = 'image/webp';
      }catch(_){ /* ignore */ }

      const out = canvas.toDataURL(mime, QUALITY);
      // cleanup
      try{ if(bmp && bmp.close) bmp.close(); }catch(_){ }
      return out || await readRaw();
    }catch(err){
      return await readRaw();
    }
  }

  // ---------- summary template editor (admin only) ----------
// "ربط" يتحكم في ما يظهر داخل الملخص وبأي ترتيب + صلاحيات (سوبر/إدارة/مدربين)
$('#btn-link-summary').addEventListener('click', () => {
  if(!isAdmin()) return;
  openSummaryTemplateEditor();
});

function openSummaryTemplateEditor(){
  // Minimal editor:
  // [الاسم] [ربط] [إظهار لمن] [✓ إظهار] + (▲▼ حذف)
  const rawTmpl = Array.isArray(summaryTemplate) ? deepCopy(summaryTemplate) : buildDefaultSummaryTemplate(questions);
  const _m = String(healthSupervisorMention || DEFAULT_HEALTH_SUPERVISOR_MENTION).trim();
  const tmpl = (rawTmpl||[]).filter(it => {
    const k = String(it?.kind || it?.type || '').toLowerCase();
    if(k !== 'fixed') return true;
    const t = String(it?.text || it?.value || it?.label || '').trim();
    if(t === _m) return false;
    if(/^<@&\d+>$/.test(t)) return false;
    return true;
  });

  const visOptions = [
    {v:'all', t:'الكل'},
    {v:'admin', t:'الإدارة + سوبر ادمن'},
    {v:'trainer', t:'مدرب'},
  ];

  const computedOptions = [
    {v:'totalScore', t:'النتيجة (مجموع النقاط)'},
    {v:'createdAt', t:'تاريخ الإنشاء'},
    {v:'updatedAt', t:'آخر تحديث'},
  ];

  const mapOptionsHtml = () => {
    const qs = (questions||[]).map(q => `<option value="q:${q.id}">سؤال: ${escapeHtml(q.label)}</option>`).join('');
    const comp = computedOptions.map(o => `<option value="c:${o.v}">${escapeHtml(o.t)}</option>`).join('');
    const fixed = `<option value="f:fixed">نص ثابت</option>`;
    return `<optgroup label="الأسئلة">${qs}</optgroup><optgroup label="محسوب">${comp}</optgroup>${fixed}`;
  };

  const visHtml = visOptions.map(o => `<option value="${o.v}">${o.t}</option>`).join('');

  const normalizeVis = (v0) => {
    const v = String(v0 || 'all').toLowerCase();
    if(v === 'super' || v === 'admins') return 'admin';
    if(v === 'admin' || v === 'trainer' || v === 'all') return v;
    return 'all';
  };

  const getMapValue = (it) => {
    const kind = String(it.kind || 'question');
    if(kind === 'question') return `q:${it.questionId || ''}`;
    if(kind === 'computed') return `c:${it.computed || 'totalScore'}`;
    return 'f:fixed';
  };

  const applyMapToItem = (it, mapVal) => {
    const mv = String(mapVal || '');
    if(mv.startsWith('q:')){
      it.kind = 'question';
      it.questionId = mv.slice(2) || '';
      delete it.computed;
      delete it.text;
      return;
    }
    if(mv.startsWith('c:')){
      it.kind = 'computed';
      it.computed = mv.slice(2) || 'totalScore';
      delete it.questionId;
      delete it.text;
      return;
    }
    // fixed
    it.kind = 'fixed';
    it.text = String(it.text || '').trim();
    delete it.questionId;
    delete it.computed;
  };

  const rowHtml = (it, idx) => {
    const enabled = it.enabled !== false;
    const visibility = normalizeVis(it.visibility);
    const label = String(it.label || '').trim();
    const mapVal = getMapValue(it);
    const isFixed = String(it.kind || '') === 'fixed';

    return `
      <div class="sl-row sl-row-min" data-idx="${idx}">
        <div class="sl-main">
          <input class="input sl-label" data-k="label" placeholder="الاسم" value="${escapeHtml(label)}"/>
          <select class="input sl-map" data-k="map">${mapOptionsHtml()}</select>
          <select class="input sl-vis" data-k="visibility">${visHtml}</select>
          <label class="check sl-check">
            <input type="checkbox" data-k="enabled" ${enabled?'checked':''}/>
            <span>إظهار</span>
          </label>
          <input class="input sl-fixed ${isFixed?'':'hidden'}" data-k="text" placeholder="مثال: <@&827121686499295252>" value="${escapeHtml(String(it.text||''))}"/>
        </div>

        <div class="sl-actions sl-actions-min">
          <button class="btn tiny" data-act="up" title="أعلى">▲</button>
          <button class="btn tiny" data-act="down" title="أسفل">▼</button>
          <button class="btn tiny danger" data-act="del" title="حذف">حذف</button>
        </div>
      </div>
    `;
  };

  openModal({
    title: 'ربط الملخص (تحكم كامل)',
    body: `
      <div class="sl-toolbar sl-toolbar-min">
        <div class="sl-toolbar-left">
          <button class="btn tiny primary" id="sl-add">إضافة</button>
          <button class="btn tiny" id="sl-edit-mention">مشرف الصحة</button>
        </div>
        <div class="muted">رتّب بالأسهم • اربط من قائمة "ربط" • فعّل/عطّل بعلامة الصح</div>
      </div>

      <div class="sl-mention" id="sl-mention" style="display:none;">
        <div class="sl-mention-row">
          <div class="muted">منشن مشرف الصحة (سيظهر دائمًا آخر سطر في الملخص)</div>
          <input class="input sl-mention-input" id="sl-mention-input" value="${escapeHtml(String(healthSupervisorMention || DEFAULT_HEALTH_SUPERVISOR_MENTION))}" />
          <div class="sl-mention-actions">
            <button class="btn tiny primary" id="sl-mention-save">حفظ</button>
            <button class="btn tiny" id="sl-mention-cancel">إلغاء</button>
          </div>
        </div>
      </div>

      <div class="sl-list" id="sl-list">${tmpl.map(rowHtml).join('')}</div>
    `,
    foot: `
      <button class="btn primary" id="sl-save">حفظ</button>
      <button class="btn" id="sl-close">إغلاق</button>
    `,
    onReady: () => {
      const list = $('#sl-list');

      // health supervisor mention editor (separate from template)
      const mentionWrap = $('#sl-mention');
      const mentionInput = $('#sl-mention-input');
      const openMention = () => {
        if(!mentionWrap || !mentionInput) return;
        mentionInput.value = String(healthSupervisorMention || DEFAULT_HEALTH_SUPERVISOR_MENTION).trim();
        mentionWrap.style.display = 'block';
        setTimeout(() => { try{ mentionInput.focus(); mentionInput.select(); }catch(_){ } }, 10);
      };
      const closeMention = () => { if(mentionWrap) mentionWrap.style.display = 'none'; };
      $('#sl-edit-mention')?.addEventListener('click', openMention);
      $('#sl-mention-cancel')?.addEventListener('click', closeMention);
      $('#sl-mention-save')?.addEventListener('click', async () => {
        if(quota.locked){ toast('النظام مقفل مؤقتًا.'); return; }
        try{
          const v = String(mentionInput?.value || '').trim() || DEFAULT_HEALTH_SUPERVISOR_MENTION;
          await saveConfigPatch({ healthSupervisorMention: v });
          healthSupervisorMention = v;
          addAudit('config','تعديل منشن مشرف الصحة', { mention: v });
          toast('تم الحفظ');
          closeMention();
        }catch(err){
          console.error(err);
          if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (حفظ المنشن).', nextResetMs());
          else toast('تعذر الحفظ');
        }
      });


      const syncRow = (row) => {
        const idx = Number(row.dataset.idx);
        const it = tmpl[idx];
        it.visibility = normalizeVis(it.visibility);

        const mapSel = row.querySelector('[data-k="map"]');
        if(mapSel){
          const desired = getMapValue(it);
          mapSel.value = desired;
          // If the current value doesn't exist in options (e.g. deleted question),
          // fall back to the first question to keep the UI usable.
          if(!mapSel.value && questions?.[0]?.id){
            applyMapToItem(it, `q:${questions[0].id}`);
            mapSel.value = getMapValue(it);
          }
        }
        const visSel = row.querySelector('[data-k="visibility"]');
        if(visSel) visSel.value = it.visibility || 'all';

        const fixedInp = row.querySelector('[data-k="text"]');
        if(fixedInp){
          if(String(it.kind) === 'fixed') fixedInp.classList.remove('hidden');
          else fixedInp.classList.add('hidden');
        }
      };

      const bindRows = () => {
        list.querySelectorAll('.sl-row').forEach(row => {
          const idx = Number(row.dataset.idx);

          syncRow(row);

          row.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if(!btn) return;
            const act = btn.dataset.act;
            if(act === 'del'){
              tmpl.splice(idx, 1);
              rerender();
            }else if(act === 'up' && idx > 0){
              const t = tmpl[idx]; tmpl[idx] = tmpl[idx-1]; tmpl[idx-1] = t;
              rerender();
            }else if(act === 'down' && idx < tmpl.length - 1){
              const t = tmpl[idx]; tmpl[idx] = tmpl[idx+1]; tmpl[idx+1] = t;
              rerender();
            }
          });

          row.querySelector('[data-k="label"]').addEventListener('input', (e) => {
            tmpl[idx].label = e.target.value;
          });

          row.querySelector('[data-k="map"]').addEventListener('change', (e) => {
            applyMapToItem(tmpl[idx], e.target.value);
            rerender();
          });

          row.querySelector('[data-k="visibility"]').addEventListener('change', (e) => {
            tmpl[idx].visibility = normalizeVis(e.target.value);
          });

          row.querySelector('[data-k="enabled"]').addEventListener('change', (e) => {
            tmpl[idx].enabled = e.target.checked;
          });

          row.querySelector('[data-k="text"]')?.addEventListener('input', (e) => {
            tmpl[idx].text = e.target.value;
          });
        });
      };

      const rerender = () => {
        list.innerHTML = tmpl.map(rowHtml).join('');
        bindRows();
      };

      bindRows();

      $('#sl-add').addEventListener('click', () => {
        const firstQ = questions?.[0];
        tmpl.push({
          id: uid('st'),
          kind: 'question',
          label: firstQ?.label || 'حقل',
          questionId: firstQ?.id || '',
          enabled: true,
          visibility: 'all'
        });
        rerender();
      });

      $('#sl-close')?.addEventListener('click', closeModal);

      $('#sl-save').addEventListener('click', async () => {
        if(quota.locked){
          toast('النظام مقفل مؤقتًا.');
          return;
        }
        try{
          const clean0 = tmpl.map(it => {
            const kind = String(it.kind || 'question');
            const base = {
              id: it.id || uid('st'),
              kind,
              enabled: it.enabled !== false,
              visibility: normalizeVis(it.visibility || 'all'),
              label: String(it.label || '').trim()
            };
            if(kind === 'fixed'){
              return { ...base, text: String(it.text || '').trim() };
            }
            if(kind === 'computed'){
              return { ...base, computed: String(it.computed || 'totalScore') };
            }
            return { ...base, questionId: String(it.questionId || '') };
          });
          const clean = clean0.filter(it => {
            const k = String(it?.kind || '').toLowerCase();
            if(k !== 'fixed') return true;
            const t = String(it?.text || '').trim();
            if(t === String(healthSupervisorMention || DEFAULT_HEALTH_SUPERVISOR_MENTION).trim()) return false;
            if(/^<@&\d+>$/.test(t)) return false;
            return true;
          });

          await saveConfigPatch({ summaryTemplate: clean });
          addAudit('config','تعديل ربط الملخص', { count: clean.length });
          toast('تم الحفظ');
          closeModal();
        }catch(err){
          console.error(err);
          if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (حفظ الربط).', nextResetMs());
          else toast('تعذر الحفظ');
        }
      });
    }
  });
}

 // ---------- control (questions) ----------



  function renderQuestions(){
    const list = $('#questions-list');
    list.innerHTML = questions.map(q => {
      const typeName = (q.type === 'select') ? 'خيارات' : (q.type === 'textarea' ? 'نص طويل' : 'نص');
      const visName = visibilityName(q.visibility || 'all');
      const optCount = (q.type === 'select') ? (q.options?.length || 0) : 0;
      return `
        <div class="row" data-qid="${q.id}">
          <div>
            <div class="row-title">${escapeHtml(q.label)}</div>
            <div class="row-sub">النوع: ${typeName}${q.type==='select' ? ` • خيارات: ${optCount}` : ''} • الإظهار: ${visName}</div>
          </div>
          <div class="row-actions">
            <button class="btn" data-action="edit-q">تعديل</button>
            <button class="btn danger" data-action="del-q">حذف</button>
          </div>
        </div>
      `;
    }).join('');
  }

  $('#btn-add-question').addEventListener('click', () => {
    if(!isAdmin()) return toast('غير مصرح.');
    openQuestionEditor(null);
  })

  $('#questions-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if(!row) return;
    const qid = row.dataset.qid;
    const act = e.target.closest('button')?.dataset.action;
    if(!act) return;

    if(act === 'edit-q'){
      openQuestionEditor(qid);
      return;
    }
    if(act === 'del-q'){
      const q = questions.find(x => x.id === qid);
      if(!q) return;
      const ok = await confirmModal({title:'تأكيد', message:`حذف السؤال: ${q.label} ؟`, okText:'حذف'});
      if(!ok) return;
      questions = questions.filter(x => x.id !== qid);
      // optional: remove from in-memory candidate answers (Firestore docs may still have old keys)
      candidates.forEach(c => { if(c.answers) delete c.answers[qid]; });

      // unlink summary template items pointing to this question
      if(!Array.isArray(summaryTemplate)) summaryTemplate = buildDefaultSummaryTemplate(questions);
      summaryTemplate = summaryTemplate.map(it => (it && it.kind==='question' && it.questionId===qid) ? ({ ...it, questionId:'' }) : it);

      try{
        await saveConfigPatch({ questions, summaryTemplate });
      }catch(err){
        console.error(err);
        if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (حفظ الأسئلة).', nextResetMs());
        else toast('تعذر حفظ التغييرات');
        return;
      }

      addAudit('question','حذف سؤال', { label: q.label });
      renderAll();
      toast('تم حذف السؤال');
    }
  });

  function openQuestionEditor(qid){
    const isEdit = Boolean(qid);
    const q = isEdit ? deepCopy(questions.find(x => x.id === qid)) : { id: uid('q'), label:'', type:'text', options:[], visibility:'all' };
    q.visibility = q.visibility || 'all';
    const body = `
      <div class="card" style="margin:0;">
        <div class="field">
          <label>اسم السؤال</label>
          <input id="qe-label" type="text" value="${escapeHtml(q.label)}">
        </div>
        <div class="field">
          <label>نوع الإدخال</label>
          <select id="qe-type">
            <option value="text" ${q.type==='text'?'selected':''}>نص</option>
            <option value="textarea" ${q.type==='textarea'?'selected':''}>نص طويل</option>
            <option value="select" ${q.type==='select'?'selected':''}>خيارات</option>
          </select>
        </div>
        <div class="field">
          <label>إظهار السؤال</label>
          <select id="qe-vis">
            <option value="all" ${q.visibility==='all'?'selected':''}>للجميع</option>
            <option value="admins" ${q.visibility==='admins'?'selected':''}>للإدارة فقط</option>
            <option value="trainer" ${q.visibility==='trainer'?'selected':''}>للمدرب</option>
          </select>
          <div class="muted">اختر من يستطيع رؤية هذا السؤال في نموذج المقابلة.</div>
        </div>

        <div class="field" id="qe-options-wrap" style="${q.type==='select'?'':'display:none;'}">
          <label>خيارات</label>
          <textarea id="qe-options" placeholder="كل خيار بسطر">${escapeHtml((q.options||[]).join('\n'))}</textarea>
          <div class="muted">تُستخدم فقط عندما يكون النوع: خيارات.</div>
        </div>
      </div>
    `;
    const foot = `
      <button class="btn primary" id="qe-save">حفظ</button>
      <button class="btn" id="qe-cancel">إلغاء</button>
    `;
    openModal({
      title: isEdit ? 'تعديل سؤال' : 'إضافة سؤال',
      body,
      foot,
      onReady: () => {
        $('#qe-type').addEventListener('change', (e) => {
          const v = e.target.value;
          $('#qe-options-wrap').style.display = (v==='select') ? 'block' : 'none';
        });
        $('#qe-cancel').addEventListener('click', closeModal);
        $('#qe-save').addEventListener('click', async () => {
          const label = $('#qe-label').value.trim();
          const type = $('#qe-type').value;
          const vis = $('#qe-vis').value || 'all';
                    const opts = ($('#qe-options').value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

          if(!label){
            toast('اسم السؤال مطلوب.');
            return;
          }
          if(quota.locked){
            toast('النظام مقفل مؤقتًا.');
            return;
          }

          q.label = label;
          q.type = type;
          q.visibility = vis;
          q.options = (type==='select') ? opts : [];

          const auditAction = isEdit ? 'تعديل سؤال' : 'إضافة سؤال';

          if(isEdit){
            const idx = questions.findIndex(x => x.id === qid);
            if(idx >= 0) questions[idx] = q;
          }else{
            questions.push(q);
          }

          try{
            await saveConfigPatch({ questions });
          }catch(err){
            console.error(err);
            if(isQuotaError(err)) lockApp('تم الوصول لحد الاستخدام (حفظ الأسئلة).', nextResetMs());
            else toast('تعذر حفظ السؤال');
            return;
          }

          addAudit('question', auditAction, { label: q.label, type: q.type, visibility: q.visibility });
          renderAll();
          toast('تم حفظ السؤال');
          closeModal();
        });
      }
    });
  }

  
  // ---------- admin (users) [Firebase profiles + Auth create] ----------
  function renderUsers(){
    const list = $('#users-list');
    if(!list) return;
    if(!canManageUsers()){
      list.innerHTML = `<div class="muted">ليس لديك صلاحية لعرض المستخدمين.</div>`;
      return;
    }
    const rows = (users || []).map(u => {
      return `
        <div class="row" data-uid="${escapeHtml(u.id)}">
          <div>
            <div class="row-title">${escapeHtml(u.username || '—')}</div>
            <div class="row-sub">الدور: ${escapeHtml(roleName(u.role))} — ${escapeHtml(u.email||'')}</div>
          </div>
          <div class="row-actions">
            <button class="btn" data-action="edit-u">تعديل</button>
          </div>
        </div>
      `;
    }).join('');
    list.innerHTML = rows || `<div class="muted">لا يوجد مستخدمون.</div>`;
  }

  async function refreshUsers(){
    if(!canManageUsers()) return;
    users = (await listProfiles()).map(p => ({ id:p.id, username:p.username||'', role: normalizeRole(p.role||'trainer'), email:p.email||'' }));
    renderUsers();
  }

  async function openUserEditor(uid_){
    const isEdit = Boolean(uid_);
    const u = isEdit ? deepCopy(users.find(x => x.id === uid_)) : { id:'', email:'', username:'', role:'trainer' };

    const body = `
      <div class="card" style="margin:0;">
        <div class="field">
          <label>البريد الإلكتروني</label>
          <input id="ue-email" type="email" value="${escapeHtml(u.email||'')}" ${isEdit?'disabled':''} placeholder="name@example.com">
        </div>
        <div class="field">
          <label>اسم المستخدم (يدعم العربي)</label>
          <input id="ue-username" type="text" value="${escapeHtml(u.username||'')}" placeholder="مثال: عبدالله">
        </div>
        <div class="field">
          <label>${isEdit ? 'الدور' : 'الصلاحية'}</label>
          <select id="ue-role">
            <option value="trainer" ${u.role==='trainer'?'selected':''}>مدرب</option>
            <option value="admin" ${u.role==='admin'?'selected':''}>إدارة</option>
            <option value="super" ${u.role==='super'?'selected':''}>Super Admin</option>
          </select>
        </div>

        ${isEdit ? `
          <div class="hint muted">لتغيير كلمة المرور: استخدم زر إعادة تعيين كلمة المرور.</div>
          <button class="btn" id="btn-reset-pass" style="width:100%;margin-top:10px;">إرسال إعادة تعيين كلمة المرور</button>
        ` : `
          <div class="field">
            <label>كلمة المرور</label>
            <input id="ue-password" type="password" value="" placeholder="••••••••" autocomplete="new-password">
          </div>
        `}
      </div>
    `;

    openModal({
      title: isEdit ? 'تعديل مستخدم' : 'إضافة مستخدم',
      body,
      foot: `
        <button class="btn" id="ue-cancel">إلغاء</button>
        <button class="btn primary" id="ue-save">حفظ</button>
      `,
      onReady: () => {
        // Safety: if the modal body didn't render for any reason, show a helpful message.
        if(!$('#ue-username')){
          $('#modal-body').innerHTML = '<div class="muted" style="padding:12px;">تعذر عرض نموذج إضافة المستخدم. حدّث الصفحة (Ctrl+F5) ثم جرّب مرة أخرى.</div>';
          return;
        }

        $('#ue-cancel')?.addEventListener('click', closeModal);

        if(isEdit){
          $('#btn-reset-pass')?.addEventListener('click', async ()=>{
            try{
              if(!auth) return;
              const email = u.email;
              if(!email){ toast('لا يوجد بريد لهذا المستخدم.'); return; }
              await auth.sendPasswordResetEmail(email);
              toast('تم إرسال رابط إعادة تعيين كلمة المرور.');
            }catch(err){
              console.error(err);
              toast('تعذر الإرسال. تحقق من الإعدادات.');
            }
          });
        }

        $('#ue-save')?.addEventListener('click', async ()=>{
          const email = ($('#ue-email')?.value || '').trim();
          const username = ($('#ue-username')?.value || '').trim();
          const role = normalizeRole($('#ue-role')?.value || 'trainer');

          if(!username){
            toast('اسم المستخدم مطلوب.');
            return;
          }
          if(!await initFirebase()){
            toast('Firebase غير مهيأ.');
            return;
          }

          if(quota.locked){
            toast('النظام مقفل مؤقتًا بسبب حد الاستخدام.');
            return;
          }
          $('#ue-save').disabled = true;
          try{
            if(isEdit){
              await upsertProfile(u.id, { username, role, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
              addAudit('user','تعديل مستخدم', { uid:u.id, username, role });
              toast('تم الحفظ.');
              closeModal();
              await refreshUsers();
              return;
            }

            // create auth user using secondary app (won't log out current admin)
            const password = ($('#ue-password')?.value || '');
            if(!email || !password){
              toast('البريد الإلكتروني وكلمة المرور مطلوبة.');
              return;
            }

            const secondary = firebase.apps?.find(a => a.name === 'secondary')
              ? firebase.app('secondary')
              : firebase.initializeApp(FIREBASE_CONFIG, 'secondary');

            const auth2 = firebase.auth(secondary);
            const cred = await auth2.createUserWithEmailAndPassword(email, password);
            const newUser = cred.user;

            await upsertProfile(newUser.uid, {
              email,
              username,
              role,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            await auth2.signOut();
            addAudit('user','إضافة مستخدم', { uid:newUser.uid, email, username, role });
            toast('تمت إضافة المستخدم.');
            closeModal();
            await refreshUsers();
          }catch(err){
            console.error(err);
            toast('تعذر الحفظ (قد يكون البريد مستخدم).');
          }finally{
            $('#ue-save').disabled = false;
          }
        });
      }
    });
  }

  $('#btn-add-user')?.addEventListener('click', async ()=>{
    if(!canManageUsers()){
      toast('لا توجد صلاحية.');
      return;
    }
    if(quota.locked){
      toast('النظام مقفل مؤقتًا بسبب حد الاستخدام.');
      return;
    }
    await openUserEditor(null);
  });

  $('#users-list')?.addEventListener('click', async (e) => {
    const row = e.target.closest('.row');
    if(!row) return;
    const uid_ = row.dataset.uid;
    const act = e.target.closest('button')?.dataset.action;
    if(act === 'edit-u'){
      openUserEditor(uid_);
    }
  });


  // ---------- audit render ----------
  function renderAudit(){
    const list = $('#audit-list');
    const filter = $('#audit-filter').value || 'all';
    const src = (Array.isArray(auditFS) && auditFS) ? auditFS.map(x => ({
      id: x.id,
      time: x.ts ? x.ts.toDate().toLocaleString('en-GB') : (x.clientTime || ''),
      actor: x.actorUsername || '—',
      actorEmail: x.actorEmail || '',
      kind: x.kind || 'all',
      action: x.action || '',
      details: x.details || null
    })) : audit;
    const filtered = (filter==='all') ? src : src.filter(a => a.kind===filter);
    list.innerHTML = filtered.map(a => {
      // user friendly details
      const details = friendlyAuditDetails(a);
      return `
        <div class="row">
          <div>
            <div class="row-title">${escapeHtml(a.action)}</div>
            <div class="row-sub">الوقت: ${escapeHtml(a.time)} • من: ${escapeHtml(a.actor)} • ${escapeHtml(details)}</div>
          </div>
          <div class="row-actions">
            <span class="badge">${escapeHtml(a.kind)}</span>
          </div>
        </div>
      `;
    }).join('');
    $('#presence-summary').textContent = buildPresenceSummary();
  }

  // ---------- online users ----------
  function renderOnline(){
    const list = $('#online-list');
    if(!list) return;

    const now = Date.now();
    const rows = users.map(u => {
      const ts = presence?.[u.username]?.ts || 0;
      const online = ts && (now - ts) < 15000; // 15s window
      return { username: u.username, role: u.role, ts, online };
    }).sort((a,b) => (b.online - a.online) || a.username.localeCompare(b.username, 'ar'));

    list.innerHTML = rows.map(r => {
      const when = r.ts ? new Date(r.ts).toLocaleString('en-US') : '—';
      return `
        <div class="row">
          <div>
            <div class="row-title">${escapeHtml(r.username)}</div>
            <div class="row-sub">الدور: ${escapeHtml(roleName(r.role))} • آخر نشاط: ${escapeHtml(when)}</div>
          </div>
          <div class="row-actions">
            <span class="badge ${r.online ? 'ok' : ''}">${r.online ? 'متصل الآن' : 'غير متصل'}</span>
          </div>
        </div>
      `;
    }).join('') || '<div class="muted">لا يوجد مستخدمون بعد.</div>';
  }

    $('#audit-filter').addEventListener('change', renderAudit);

  function friendlyAuditDetails(a){
    const d = a.details || {};
    if(a.kind==='candidate'){
      const name = d.name ? `المرشح: ${d.name}` : '';
      const nid = d.nationalId ? `الرقم: ${d.nationalId}` : '';
      const st = d.status ? `الحالة: ${d.status}` : '';
      return [name,nid,st].filter(Boolean).join(' • ');
    }
    if(a.kind==='question'){
      const lab = d.label ? `السؤال: ${d.label}` : '';
      const ty = d.type ? `النوع: ${d.type}` : '';
      return [lab,ty].filter(Boolean).join(' • ');
    }
    if(a.kind==='user'){
      const u = d.username ? `المستخدم: ${d.username}` : '';
      const r = d.role ? `الدور: ${roleName(d.role)}` : '';
      return [u,r].filter(Boolean).join(' • ');
    }
    if(a.kind==='auth'){
      const u = d.user ? `المستخدم: ${d.user}` : '';
      return u;
    }
    if(a.kind==='presence'){
      return d.username ? `المستخدم: ${d.username} • ${d.state}` : '';
    }
    return '';
  }

  // ---------- render all ----------
  function renderStats(){
    $('#stat-candidates').textContent = String(candidates.length);
    $('#stat-review').textContent = String(candidates.filter(c => (c.status||'قيد المراجعة')==='قيد المراجعة').length);
    $('#stat-accepted').textContent = String(candidates.filter(c => c.status==='مقبول').length);
    $('#stat-rejected').textContent = String(candidates.filter(c => c.status==='مرفوض').length);
  }

  function applyPermissions(){
    const role = session?.role || 'reader';
    const allowed = isAdmin() ? ['dashboard','interview','control','admin','audit','online'] : ['dashboard','interview'];

    // show/hide nav buttons by allowed set
    $$('.nav-btn[data-nav]').forEach(btn => {
      const nav = btn.dataset.nav;
      btn.style.display = allowed.includes(nav) ? 'block' : 'none';
    });

    // Reader: hide add button (view only)
    const addBtn = document.getElementById('btn-add-candidate');
    if(addBtn){
      addBtn.style.display = (role === 'reader') ? 'none' : 'inline-flex';
    }
  }

  function renderAll(){
    applyPermissions();
    renderStats();
    renderCandidates();
    renderQuestions();
    renderUsers();
    renderAudit();
  }

  function renderAfterCandidateChange(){
    // keep it light: candidates + stats + (audit is rendered by addAudit())
    applyPermissions();
    renderStats();
    // render list only if needed (or keep it always safe)
    renderCandidates();
    // online/audit panels are updated elsewhere
  }

  // kick render if logged-in
  function boot(){
    if(session){
      applyPermissions();
      navTo('dashboard');
      renderAll();
      // heartbeat
      presenceTick();
      setInterval(presenceTick, 5000);
    }
  }
  boot();

})();
