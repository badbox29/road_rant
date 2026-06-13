/* ─────────────────────────────────────────────────────────────────
   Road Rant — app.js
   ───────────────────────────────────────────────────────────────── */

'use strict';

// ── Constants ─────────────────────────────────────────────────────

const STORAGE_PREFIX  = 'rr_';
const STORAGE_KEY     = 'rr_appdata';
const STORAGE_AUTH    = 'rr_google_id_token';
const STORAGE_DISMISS = 'rr_token_upgrade_dismissed';

const SEVERITY_TIERS = {
  'road-rage':          'critical',
  'reckless-driving':   'critical',
  'impaired-driving':   'critical',
  'tailgating':         'serious',
  'unsafe-lane-change': 'serious',
  'distracted-driving': 'serious',
  'failure-to-yield':   'moderate',
  'illegal-passing':    'moderate',
  'horn-gestures':      'moderate',
  'parking-violation':  'minor',
};

const INCIDENT_LABELS = {
  'road-rage':          'Road Rage',
  'reckless-driving':   'Reckless Driving',
  'impaired-driving':   'Impaired Driving',
  'tailgating':         'Aggressive Tailgating',
  'unsafe-lane-change': 'Unsafe Lane Change',
  'distracted-driving': 'Distracted Driving',
  'failure-to-yield':   'Failure to Yield',
  'illegal-passing':    'Illegal Passing',
  'horn-gestures':      'Horn / Gestures',
  'parking-violation':  'Parking Violation',
};

// Default map center (Atlanta, GA — home base)
const DEFAULT_LAT = 33.749;
const DEFAULT_LNG = -84.388;
const DEFAULT_ZOOM = 11;

// ── State ─────────────────────────────────────────────────────────

const state = {
  // Auth
  token:        null,
  workerUrl:    null,
  authMethod:   null,
  linkedGoogle: null,
  createdAt:    null,
  username:     null,

  // Social
  friends:      [],
  incomingReqs: [],
  outgoingReqs: [],

  // Data
  incidents:    [],
  pageSize:     20,
  currentPage:  1,
  filterType:   'all',
  searchQuery:  '',

  // Map
  mainMap:      null,
  miniMap:      null,
  markerCluster: null,
  markers:      {},       // { incidentId: L.Marker }
  chalkHull:    null,     // L.Polygon for convex hull
  chalkMode:    false,
  chalkPlate:   null,     // { state, number } being highlighted

  // UI
  activeIncidentId: null, // currently open in drawer
  editingId:        null,
  darkMode:         true,

  // Plates data
  platesConfig:   null,   // plates.json
  platesSubtypes: null,   // plate_subtypes.json
};

// ── Dark mode ─────────────────────────────────────────────────────

function tdnn() {
  const moon   = document.querySelector('.moon');
  const toggle = document.querySelector('.tdnn');
  if (!moon || !toggle) return;
  moon.classList.toggle('sun');
  toggle.classList.toggle('day');
  document.body.classList.toggle('light');
  state.darkMode = !document.body.classList.contains('light');
  saveSettings();
}

function applyDarkMode() {
  const moon   = document.querySelector('.moon');
  const toggle = document.querySelector('.tdnn');
  if (state.darkMode) {
    document.body.classList.remove('light');
    moon?.classList.remove('sun');
    toggle?.classList.remove('day');
  } else {
    document.body.classList.add('light');
    moon?.classList.add('sun');
    toggle?.classList.add('day');
  }
}

// ── Utilities ─────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function nowLocalISO() {
  const now = new Date();
  const off = now.getTimezoneOffset();
  return new Date(now.getTime() - off * 60000).toISOString().slice(0, 16);
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function showToast(msg, duration = 2800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function getSeverity(incidentType) {
  return SEVERITY_TIERS[incidentType] || 'moderate';
}

function getLabel(incidentType) {
  return INCIDENT_LABELS[incidentType] || incidentType;
}

// ── Settings / Persistence ────────────────────────────────────────

function loadSettings() {
  const g = (k) => localStorage.getItem(STORAGE_PREFIX + k);
  state.token        = g('token')      || null;
  state.workerUrl    = g('worker')     || '';
  state.authMethod   = g('auth_method')|| null;
  state.username     = g('username')   || null;
  state.pageSize     = parseInt(g('page_size') || '20', 10);
  state.darkMode     = g('dark') !== 'false'; // default dark

  const rawGoogle = g('linked_google');
  state.linkedGoogle = rawGoogle ? JSON.parse(rawGoogle) : null;
  state.createdAt    = parseInt(g('created_at') || '0', 10) || null;

  const rawFriends = g('friends');
  state.friends = rawFriends ? JSON.parse(rawFriends) : [];

  // Legacy: existing token with no authMethod → infer token
  if (!state.authMethod && state.token) {
    state.authMethod = 'token';
    localStorage.setItem(STORAGE_PREFIX + 'auth_method', 'token');
  }
}

function saveSettings() {
  const s = (k, v) => { if (v != null && v !== '') localStorage.setItem(STORAGE_PREFIX + k, v); else localStorage.removeItem(STORAGE_PREFIX + k); };
  s('token',        state.token);
  s('worker',       state.workerUrl);
  s('auth_method',  state.authMethod);
  s('username',     state.username);
  s('page_size',    state.pageSize);
  s('dark',         state.darkMode ? 'true' : 'false');
  s('linked_google', state.linkedGoogle ? JSON.stringify(state.linkedGoogle) : null);
  s('created_at',   state.createdAt);
  s('friends',      state.friends.length ? JSON.stringify(state.friends) : null);
}

// ── Local incident storage ────────────────────────────────────────

function loadIncidents() {
  const raw = localStorage.getItem(STORAGE_PREFIX + 'incidents');
  state.incidents = raw ? JSON.parse(raw) : [];
}

function saveIncidents() {
  localStorage.setItem(STORAGE_PREFIX + 'incidents', JSON.stringify(state.incidents));
}

// ── Worker API ────────────────────────────────────────────────────

async function workerFetch(path, method = 'GET', body = null) {
  if (!state.workerUrl) throw new Error('Worker URL not configured');
  if (Auth.isGuest()) throw new Error('Guest accounts cannot sync');
  const url     = state.workerUrl.replace(/\/$/, '') + path;
  const bodyStr = body !== null ? JSON.stringify(body) : null;
  let authHeaders = {};
  try { authHeaders = await Auth._authHeaders(method, state.token, bodyStr); } catch {}
  const opts = { method, headers: { 'Content-Type': 'application/json', ...authHeaders } };
  if (bodyStr !== null) opts.body = bodyStr;
  const res = await fetch(url, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
  return res.json();
}

async function kvGet(key) {
  const d = await workerFetch(`/storage/${state.token}/${key}`);
  return d.value;
}

async function kvPut(key, value) {
  await workerFetch(`/storage/${state.token}/${key}`, 'PUT', value);
}

async function pushIncidentsToWorker() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return false;
  try {
    await kvPut('incidents', state.incidents);
    // For public/friends incidents, update plate index
    for (const inc of state.incidents) {
      if (inc.visibility !== 'private' && inc.lat && inc.lng) {
        await updatePlateIndex(inc, false);
      }
    }
    return true;
  } catch (e) {
    console.warn('[Worker] push failed:', e.message);
    return false;
  }
}

async function pullIncidentsFromWorker() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return;
  try {
    const remote = await kvGet('incidents');
    if (Array.isArray(remote) && remote.length > 0) {
      // Merge: keep local entries not on remote, prefer remote for conflicts
      const remoteIds = new Set(remote.map(i => i.id));
      const localOnly = state.incidents.filter(i => !remoteIds.has(i.id));
      state.incidents = [...remote, ...localOnly];
      saveIncidents();
    }
  } catch (e) {
    console.warn('[Worker] pull failed:', e.message);
  }
}

async function updatePlateIndex(incident, remove = false) {
  if (!state.workerUrl || !incident.plateState || !incident.plateNumber) return;
  const state_code = incident.plateState;
  const plate      = incident.plateNumber.replace(/\s+/g, '').toUpperCase();
  const path       = `/plates/${state_code}/${plate}/${incident.id}`;
  try {
    if (remove) {
      await workerFetch(path, 'DELETE', { token: state.token });
    } else {
      await workerFetch(path, 'PUT', {
        token:        state.token,
        username:     state.username,
        lat:          incident.lat,
        lng:          incident.lng,
        incidentType: incident.incidentType,
        datetime:     incident.datetime,
        visibility:   incident.visibility,
      });
    }
  } catch (e) {
    console.warn('[Plate index] update failed:', e.message);
  }
}

// ── Profile KV sync ───────────────────────────────────────────────

async function saveProfileToKV() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return;
  try {
    const profile = {
      username:     state.username,
      pageSize:     state.pageSize,
      darkMode:     state.darkMode,
      authMethod:   state.authMethod,
      linkedGoogle: state.linkedGoogle,
      createdAt:    state.createdAt,
      friends:      state.friends,
      incomingReqs: state.incomingReqs,
      outgoingReqs: state.outgoingReqs,
    };
    await kvPut('profile', profile);
  } catch (e) { console.warn('[Profile KV] save failed:', e.message); }
}

async function loadProfileFromKV() {
  if (!state.workerUrl || !state.token || Auth.isGuest()) return;
  try {
    const authHeaders = await Auth._authHeaders('GET', state.token, null).catch(() => ({}));
    const res = await fetch(
      `${state.workerUrl.replace(/\/$/, '')}/storage/${state.token}/profile`,
      { headers: { 'Content-Type': 'application/json', ...authHeaders } }
    );
    const migratedTo = res.headers.get('X-Token-Migrated');
    if (migratedTo) {
      const data = await res.json().catch(() => ({}));
      Auth.handlePullMigration(migratedTo, { ...data.value, userToken: migratedTo });
      state.token = migratedTo;
      saveSettings();
      return;
    }
    if (res.status === 410) { Auth.showAccountSetup(); return; }
    if (!res.ok) return;
    const json    = await res.json();
    const profile = json.value;
    if (!profile) return;
    if (profile.username)     state.username     = profile.username;
    if (profile.pageSize)     state.pageSize     = profile.pageSize;
    if (profile.authMethod)   state.authMethod   = profile.authMethod;
    if (profile.linkedGoogle) state.linkedGoogle = profile.linkedGoogle;
    if (Array.isArray(profile.friends) && profile.friends.length) state.friends = profile.friends;
    if (Array.isArray(profile.incomingReqs)) state.incomingReqs = profile.incomingReqs;
    if (Array.isArray(profile.outgoingReqs)) state.outgoingReqs = profile.outgoingReqs;
    if (profile.darkMode != null) state.darkMode = profile.darkMode;
    saveSettings();
  } catch (e) { console.warn('[Profile KV] load failed:', e.message); }
}

// ── Plates JSON ───────────────────────────────────────────────────

async function loadPlatesConfig() {
  try {
    const [platesRes, subtypesRes] = await Promise.all([
      fetch('data/plates.json'),
      fetch('data/plate_subtypes.json'),
    ]);
    state.platesConfig   = await platesRes.json();
    state.platesSubtypes = await subtypesRes.json();
  } catch (e) {
    console.warn('[Plates] failed to load config:', e.message);
    state.platesConfig   = {};
    state.platesSubtypes = {};
  }
  populateStateDropdown();
}

function populateStateDropdown() {
  const sel = document.getElementById('incident-plate-state');
  if (!sel || !state.platesConfig) return;
  const states = Object.keys(state.platesConfig).sort();
  states.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    // Convert key like "New_York" to "New York"
    opt.textContent = s.replace(/_/g, ' ');
    sel.appendChild(opt);
  });
}

function onStateSelected(stateKey) {
  const config = state.platesConfig?.[stateKey];
  if (!config) return;

  // SubType dropdown
  const subtypeGroup = document.getElementById('plate-subtype-group');
  const subtypeSel   = document.getElementById('incident-plate-subtype');
  if (config.plateSubType === true && state.platesSubtypes?.[stateKey]) {
    subtypeSel.innerHTML = '';
    state.platesSubtypes[stateKey].forEach(sub => {
      const opt = document.createElement('option');
      opt.value = sub.id;
      opt.textContent = sub.label;
      subtypeSel.appendChild(opt);
    });
    subtypeGroup.style.display = '';
  } else {
    subtypeGroup.style.display = 'none';
  }

  // Re-render plate preview if number already entered
  renderPlatePreview();
}

// ── Plate canvas renderer ─────────────────────────────────────────

// ── Font preloader ────────────────────────────────────────────────
// Cache of loaded FontFace objects keyed by family name
const _loadedFonts = {};

async function ensureFontLoaded(fontFamily, fontWeight) {
  // Extract the first named font from the stack (strip quotes)
  const primary = fontFamily.split(',')[0].trim().replace(/['"]/g, '');
  const cacheKey = `${primary}::${fontWeight}`;
  if (_loadedFonts[cacheKey]) return _loadedFonts[cacheKey];

  // Map font name to file path
  const fontFiles = {
    'License Plate USA':        'fonts/LICENSE_PLATE_USA.ttf',
    'Charles Wright':           'fonts/CharlesWright-Bold.otf',
    'Highway Gothic':           'fonts/HWYGOTH.TTF',
    'Highway Gothic Wide':      'fonts/HWYGEXPD.TTF',
    'Highway Gothic Condensed': 'fonts/HWYGCOND.TTF',
    'Highway Gothic Narrow':    'fonts/HWYGNRRW.TTF',
    'Highway Gothic DE':        'fonts/HWYGWDE.TTF',
  };

  const src = fontFiles[primary];
  if (!src) return null; // system font, no loading needed

  try {
    const ff = new FontFace(primary, `url(${src})`, { weight: String(fontWeight || 700) });
    await ff.load();
    document.fonts.add(ff);
    _loadedFonts[cacheKey] = ff;
    console.log(`[Fonts] Loaded: ${primary}`);
    return ff;
  } catch (e) {
    console.warn(`[Fonts] Failed to load ${primary}:`, e.message);
    return null;
  }
}

// Measure total width of spaced text
function spacedTextWidth(ctx, text, letterSpacing) {
  const chars  = text.split('');
  const widths = chars.map(c => ctx.measureText(c).width);
  return widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
}

// Draw text with manual letter spacing, centered on x
function drawSpacedText(ctx, text, x, y, letterSpacing) {
  const chars  = text.split('');
  const widths = chars.map(c => ctx.measureText(c).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let curX = x - totalW / 2;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, curX, y); curX += widths[i] + letterSpacing; });
  ctx.textAlign = 'center';
}

function drawSpacedStroke(ctx, text, x, y, letterSpacing) {
  const chars  = text.split('');
  const widths = chars.map(c => ctx.measureText(c).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let curX = x - totalW / 2;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.strokeText(ch, curX, y); curX += widths[i] + letterSpacing; });
  ctx.textAlign = 'center';
}

// Draw text left-aligned from startX
function drawSpacedTextLeft(ctx, text, startX, y, letterSpacing) {
  const chars  = text.split('');
  const widths = chars.map(c => ctx.measureText(c).width);
  let curX = startX;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, curX, y); curX += widths[i] + letterSpacing; });
  ctx.textAlign = 'center';
}

// Draw text right-aligned ending at endX
function drawSpacedTextRight(ctx, text, endX, y, letterSpacing) {
  const chars  = text.split('');
  const widths = chars.map(c => ctx.measureText(c).width);
  const totalW = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let curX = endX - totalW;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, curX, y); curX += widths[i] + letterSpacing; });
  ctx.textAlign = 'center';
}

// Master text renderer — respects splitMode from plates.json
function renderPlateText(ctx, plateNum, pt, y, fontSize, spacing, doStroke) {
  const safeLeft  = pt.safeArea?.x || 120;
  const safeRight = safeLeft + (pt.safeArea?.width || 1092);
  const x         = pt.x || 666;
  const splitMode = pt.splitMode || null;

  if (doStroke) {
    ctx.strokeStyle = pt.stroke;
    ctx.lineWidth   = Math.max(4, Math.round(fontSize * 0.07));
    ctx.lineJoin    = 'round';
  }

  if (splitMode === 'pin-edges') {
    // Split at first space: left group pins to left edge, right group pins to right edge
    const spaceIdx = plateNum.indexOf(' ');
    if (spaceIdx === -1) {
      // No space — fall through to centered
      if (doStroke) drawSpacedStroke(ctx, plateNum, x, y, spacing);
      else drawSpacedText(ctx, plateNum, x, y, spacing);
      return;
    }
    const left  = plateNum.slice(0, spaceIdx);
    const right = plateNum.slice(spaceIdx + 1);
    if (doStroke) {
      ctx.strokeStyle = pt.stroke;
      drawSpacedTextLeft(ctx, left, safeLeft, y, spacing);
      drawSpacedTextRight(ctx, right, safeRight, y, spacing);
    } else {
      drawSpacedTextLeft(ctx, left, safeLeft, y, spacing);
      drawSpacedTextRight(ctx, right, safeRight, y, spacing);
    }

  } else if (splitMode === 'right-align') {
    // Single block, right-aligned within safe zone
    if (doStroke) drawSpacedStroke(ctx, plateNum, x, y, spacing);
    else drawSpacedTextRight(ctx, plateNum.replace(/\s+/g,''), safeRight, y, spacing);

  } else if (splitMode === 'wyoming') {
    // 1 char | bronco gap (left of center) | remaining chars
    // Split: first char left-pinned, rest right-pinned
    // Gap is the bronco figure sitting slightly left of center (~560-700px on 1332 canvas)
    const firstChar = plateNum.replace(/\s+/g,'').slice(0, 1);
    const restChars = plateNum.replace(/\s+/g,'').slice(1);
    const broncLeft  = 520;  // left edge of bronco figure
    const broncRight = 720;  // right edge of bronco figure
    if (doStroke) {
      drawSpacedTextLeft(ctx, firstChar, safeLeft, y, spacing);
      drawSpacedTextRight(ctx, restChars, safeRight, y, spacing);
    } else {
      drawSpacedTextLeft(ctx, firstChar, safeLeft, y, spacing);
      drawSpacedTextRight(ctx, restChars, safeRight, y, spacing);
    }

  } else {
    // Default: centered
    if (doStroke) drawSpacedStroke(ctx, plateNum, x, y, spacing);
    else drawSpacedText(ctx, plateNum, x, y, spacing);
  }
}

// Core render: draws plate background + number onto a canvas.
// Canvas should be at reference dimensions (1332x684); CSS scales display.
async function renderPlateOnCanvas(canvas, stateKey, plateNum) {
  if (!canvas || !stateKey || !plateNum) return;
  const config = state.platesConfig?.[stateKey];
  if (!config) return;

  const pt      = config.plateText;
  const safeW   = pt.safeArea?.width  || pt.maxWidth || 900;
  const safeH   = pt.safeArea?.height || 220;
  const x       = pt.x || 666;
  const y       = pt.y || 342;
  const fontFam = pt.fontFamily || "'Charles Wright', 'Arial Narrow', Arial, sans-serif";
  const fontWt  = pt.fontWeight || 700;
  const spacing = pt.letterSpacing || 0;

  // Ensure custom font is loaded before touching Canvas
  await ensureFontLoaded(fontFam, fontWt);

  const W   = canvas.width;
  const H   = canvas.height;
  const ctx = canvas.getContext('2d');

  // Draw background image
  await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { ctx.clearRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); resolve(); };
    img.onerror = () => {
      ctx.fillStyle = '#d0d0d0';
      ctx.fillRect(0, 0, W, H);
      resolve();
    };
    img.src = `plates/${stateKey}.png`;
  });

  // Binary search: largest font size where spaced text fits within safeW
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'center';

  const primaryFont = fontFam.split(',')[0].trim().replace(/['"]/g, '');

  function totalSpacedWidth(size) {
    ctx.font = `${fontWt} ${size}px ${primaryFont}, Arial Narrow, Arial, sans-serif`;
    const splitMode = pt.splitMode || null;
    const safeLeft  = pt.safeArea?.x || 120;
    const safeRight = safeLeft + (pt.safeArea?.width || 1092);

    if (splitMode === 'pin-edges') {
      // Both groups must fit simultaneously without crossing center.
      // Left group starts at safeLeft, right group ends at safeRight.
      // They must not overlap: leftGroupWidth + rightGroupWidth <= safeRight - safeLeft - minGap
      const parts    = plateNum.split(' ');
      const minGap   = pt.splitMinGap || 120; // per-state override or default
      const leftW    = spacedTextWidth(ctx, parts[0] || '', spacing);
      const rightW   = spacedTextWidth(ctx, parts[1] || '', spacing);
      return leftW + rightW + minGap; // must fit within safeW total
    } else if (splitMode === 'wyoming') {
      const stripped = plateNum.replace(/\s+/g, '');
      const left     = stripped.slice(0, 1);
      const right    = stripped.slice(1);
      const minGap   = 200; // bronco figure gap
      return spacedTextWidth(ctx, left, spacing) + spacedTextWidth(ctx, right, spacing) + minGap;
    }
    return spacedTextWidth(ctx, plateNum.replace(/\s+/g, ' '), spacing);
  }

  let lo = 40, hi = safeH;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    totalSpacedWidth(mid) <= safeW ? (lo = mid) : (hi = mid);
  }
  const fontSize = lo;
  ctx.font = `${fontWt} ${fontSize}px ${primaryFont}, Arial Narrow, Arial, sans-serif`;

  ctx.fillStyle = pt.fill || '#111111';

  // Stroke pass for busy backgrounds (Wyoming etc.)
  if (pt.stroke) {
    renderPlateText(ctx, plateNum, pt, y, fontSize, spacing, true);
  }

  // Fill pass
  renderPlateText(ctx, plateNum, pt, y, fontSize, spacing, false);
}

// Render into the modal preview canvas
function renderPlatePreview() {
  const stateKey = document.getElementById('incident-plate-state')?.value;
  const plateNum = document.getElementById('incident-plate-number')?.value?.trim().toUpperCase();
  const wrap     = document.getElementById('plate-preview-wrap');
  const canvas   = document.getElementById('plate-canvas');

  if (!stateKey || !plateNum || !canvas || !wrap) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (!state.platesConfig?.[stateKey]) { wrap.style.display = 'none'; return; }

  wrap.style.display = '';
  // Ensure canvas is at reference resolution so plates.json coords are correct
  canvas.width  = 1332;
  canvas.height = 684;
  renderPlateOnCanvas(canvas, stateKey, plateNum).catch(e => console.warn('[Plate preview]', e));
}

// Render a thumbnail into the drawer (small canvas injected above plate text)
function renderDrawerThumbnail(stateKey, plateNum) {
  const existing = document.getElementById('drawer-plate-canvas');
  if (!stateKey || !plateNum || !state.platesConfig?.[stateKey]) {
    if (existing) existing.remove();
    return;
  }

  let canvas = existing;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id     = 'drawer-plate-canvas';
    canvas.width  = 1332;
    canvas.height = 684;
    canvas.style.cssText = 'width:100%;max-width:200px;height:auto;display:block;border-radius:4px;margin-bottom:.4rem;border:1px solid var(--border);';
    // Insert before the drawer-plate text element
    const plateEl = document.getElementById('drawer-plate');
    if (plateEl) plateEl.parentNode.insertBefore(canvas, plateEl);
  }

  renderPlateOnCanvas(canvas, stateKey, plateNum).catch(e => console.warn('[Drawer thumb]', e));
}

// ── Map setup ─────────────────────────────────────────────────────

function initMainMap() {
  if (state.mainMap) return;
  const map = L.map('main-map', {
    center:  [DEFAULT_LAT, DEFAULT_LNG],
    zoom:    DEFAULT_ZOOM,
    zoomControl: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Marker cluster
  state.markerCluster = L.markerClusterGroup({
    maxClusterRadius: 40,
    iconCreateFunction: (cluster) => {
      return L.divIcon({
        html: `<div class="rr-cluster">${cluster.getChildCount()}</div>`,
        className: '',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      });
    },
  });
  map.addLayer(state.markerCluster);

  // Click on map background → exit chalk-line mode / close drawer
  map.on('click', () => {
    if (state.chalkMode) exitChalkMode();
    else closeDrawer();
  });

  state.mainMap = map;
}

function initMiniMap() {
  if (state.miniMap) { state.miniMap.invalidateSize(); return; }
  const map = L.map('incident-mini-map', {
    center:  [DEFAULT_LAT, DEFAULT_LNG],
    zoom:    13,
    zoomControl: true,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  }).addTo(map);

  let miniMarker = null;
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    if (miniMarker) miniMarker.setLatLng([lat, lng]);
    else {
      miniMarker = L.marker([lat, lng]).addTo(map);
    }
    document.getElementById('incident-lat').value = lat.toFixed(6);
    document.getElementById('incident-lng').value = lng.toFixed(6);
    reverseGeocode(lat, lng);
  });

  state.miniMap = map;
  state.miniMarker = null;
  state._miniMarkerRef = (m) => { state.miniMarker = m; };
}

async function reverseGeocode(lat, lng) {
  try {
    const res  = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`);
    const data = await res.json();
    const name = data.display_name?.split(',').slice(0, 3).join(', ') || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    document.getElementById('incident-location-name').value = name;
  } catch {
    document.getElementById('incident-location-name').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

// ── Pin rendering ─────────────────────────────────────────────────

function makePinIcon(severity, extraClass = '') {
  return L.divIcon({
    html:       `<div class="rr-pin ${severity} ${extraClass}"></div>`,
    className:  '',
    iconSize:   [24, 24],
    iconAnchor: [12, 24],
    popupAnchor:[0, -26],
  });
}

function renderMapPins() {
  if (!state.mainMap) return;

  // Clear existing
  state.markerCluster.clearLayers();
  state.markers = {};

  state.incidents.forEach(inc => {
    if (!inc.lat || !inc.lng) return;
    const sev    = getSeverity(inc.incidentType);
    const marker = L.marker([inc.lat, inc.lng], { icon: makePinIcon(sev) });
    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      openDrawer(inc.id);
    });
    state.markers[inc.id] = marker;
    state.markerCluster.addLayer(marker);
  });

  if (state.incidents.some(i => i.lat && i.lng)) {
    fitMapToIncidents();
  }
}

function fitMapToIncidents() {
  const pts = state.incidents.filter(i => i.lat && i.lng).map(i => [i.lat, i.lng]);
  if (pts.length === 0) return;
  if (pts.length === 1) { state.mainMap.setView(pts[0], 14); return; }
  state.mainMap.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
}

// ── Drawer ────────────────────────────────────────────────────────

function openDrawer(incidentId) {
  const inc = state.incidents.find(i => i.id === incidentId);
  if (!inc) return;
  state.activeIncidentId = incidentId;

  document.getElementById('drawer-title').textContent = getLabel(inc.incidentType);
  document.getElementById('drawer-plate').textContent =
    inc.plateState && inc.plateNumber ? `${inc.plateState.replace(/_/g,' ')} · ${inc.plateNumber}` : '';

  // Render plate thumbnail above the plate text
  renderDrawerThumbnail(inc.plateState || null, inc.plateNumber ? inc.plateNumber.trim().toUpperCase() : null);

  // Count incidents for this plate to determine chalk-line eligibility
  const plateCount = (inc.plateState && inc.plateNumber)
    ? countPlateIncidents(inc.plateState, inc.plateNumber)
    : 0;
  const isRepeat   = plateCount >= 2;

  const sev = getSeverity(inc.incidentType);
  document.getElementById('drawer-body').innerHTML = `
    ${isRepeat ? `
    <div class="repeat-offender-badge">
      ⚠ ${plateCount} incident${plateCount !== 1 ? 's' : ''} on record for this plate
    </div>` : ''}
    <div class="detail-row">
      <span class="detail-label">Severity</span>
      <span class="detail-value"><span class="severity-pill ${sev}">${sev}</span></span>
    </div>
    <div class="detail-row">
      <span class="detail-label">When</span>
      <span class="detail-value">${formatDateTime(inc.datetime)}</span>
    </div>
    ${inc.locationName ? `
    <div class="detail-row">
      <span class="detail-label">Location</span>
      <span class="detail-value">${inc.locationName}</span>
    </div>` : ''}
    ${inc.vehicleMake ? `
    <div class="detail-row">
      <span class="detail-label">Vehicle</span>
      <span class="detail-value">${[inc.vehicleColor, inc.vehicleMake].filter(Boolean).join(' ')}</span>
    </div>` : ''}
    ${inc.notes ? `
    <div class="detail-row">
      <span class="detail-label">Notes</span>
      <span class="detail-value">${inc.notes}</span>
    </div>` : ''}
    <div class="detail-row">
      <span class="detail-label">Visibility</span>
      <span class="detail-value">${inc.visibility || 'private'}</span>
    </div>
  `;

  // Show chalk-line button only for repeat offenders (2+ incidents)
  const chalkBtn = document.getElementById('btn-chalk-mode');
  if (chalkBtn) chalkBtn.style.display = isRepeat ? '' : 'none';

  const drawer = document.getElementById('incident-drawer');
  drawer.classList.add('open');
  document.getElementById('map-wrapper').classList.add('drawer-open');

  // Pan map to keep pin visible
  if (inc.lat && inc.lng && state.mainMap) {
    state.mainMap.panTo([inc.lat, inc.lng], { animate: true });
  }
}

function closeDrawer() {
  document.getElementById('incident-drawer').classList.remove('open');
  document.getElementById('map-wrapper').classList.remove('drawer-open');
  state.activeIncidentId = null;
  if (!state.chalkMode) exitChalkMode();
}

// ── Chalk-line mode ───────────────────────────────────────────────

// Count incidents matching a plate (normalized comparison)
function countPlateIncidents(plateState, plateNumber) {
  const normPlate = plateNumber.replace(/\s+/g, '').toUpperCase();
  return state.incidents.filter(i =>
    i.plateState === plateState &&
    (i.plateNumber || '').replace(/\s+/g, '').toUpperCase() === normPlate &&
    i.lat && i.lng
  ).length;
}

function enterChalkMode(plateState, plateNumber) {
  state.chalkMode  = true;
  state.chalkPlate = { state: plateState, number: plateNumber };

  const normPlate = plateNumber.replace(/\s+/g, '').toUpperCase();

  // Find all matching incidents — normalize both sides
  const matchingIncs = state.incidents.filter(i =>
    i.plateState === plateState &&
    (i.plateNumber || '').replace(/\s+/g, '').toUpperCase() === normPlate &&
    i.lat && i.lng
  );
  const matchingIds = new Set(matchingIncs.map(i => i.id));
  const matchingPts = matchingIncs.map(i => [i.lat, i.lng]);

  // Remove cluster layer, add markers directly so we can style individually
  state.mainMap.removeLayer(state.markerCluster);
  // Small delay to let cluster fully unload
  Object.entries(state.markers).forEach(([id, marker]) => {
    const inc = state.incidents.find(i => i.id === id);
    if (!inc) return;
    const sev = getSeverity(inc.incidentType);
    if (matchingIds.has(id)) {
      // Keep natural severity color — just ensure it's on the map directly
      marker.setIcon(makePinIcon(sev));
      marker.addTo(state.mainMap);
    } else {
      // Mute non-matching pins
      marker.setIcon(makePinIcon(sev, 'chalk-muted'));
      marker.addTo(state.mainMap);
    }
  });

  // Draw convex hull only for 3+ points
  if (state.chalkHull) { state.mainMap.removeLayer(state.chalkHull); state.chalkHull = null; }

  if (matchingPts.length >= 3) {
    const hull = convexHull(matchingPts);
    state.chalkHull = L.polygon(hull, {
      color:       '#e0282c',
      fillColor:   '#e0282c',
      fillOpacity: 0.08,
      weight:      2,
      dashArray:   '6 4',
    }).addTo(state.mainMap);
    state.mainMap.fitBounds(L.latLngBounds(hull), { padding: [60, 60] });
  } else if (matchingPts.length === 2) {
    state.mainMap.fitBounds(L.latLngBounds(matchingPts), { padding: [80, 80] });
  } else if (matchingPts.length === 1) {
    state.mainMap.setView(matchingPts[0], 14);
  }

  // Show banner
  const banner    = document.getElementById('chalk-banner');
  document.getElementById('chalk-banner-text').textContent =
    `CHALK-LINE: ${plateState.replace(/_/g,' ')} · ${plateNumber} — ${matchingPts.length} incident${matchingPts.length !== 1 ? 's' : ''}`;
  banner.style.display = '';
}

function exitChalkMode() {
  state.chalkMode  = false;
  state.chalkPlate = null;

  // Remove individually-added markers
  Object.values(state.markers).forEach(m => {
    if (state.mainMap.hasLayer(m)) state.mainMap.removeLayer(m);
  });

  // Restore cluster layer with default pin colors
  Object.entries(state.markers).forEach(([id, marker]) => {
    const inc = state.incidents.find(i => i.id === id);
    if (!inc) return;
    marker.setIcon(makePinIcon(getSeverity(inc.incidentType)));
  });
  if (!state.mainMap.hasLayer(state.markerCluster)) {
    state.mainMap.addLayer(state.markerCluster);
  }

  // Remove hull
  if (state.chalkHull) { state.mainMap.removeLayer(state.chalkHull); state.chalkHull = null; }

  // Hide banner
  document.getElementById('chalk-banner').style.display = 'none';
}

// ── Convex Hull (Graham scan) ─────────────────────────────────────
// Input: [[lat, lng], ...]  Output: [[lat, lng], ...]

function convexHull(points) {
  if (points.length < 3) return points;
  const pts = points.map(p => ({ x: p[1], y: p[0] })); // use lng as x, lat as y
  pts.sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const cross = (O, A, B) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return [...lower, ...upper].map(p => [p.y, p.x]);
}

// ── Incident feed rendering ───────────────────────────────────────

function renderFeed() {
  const container = document.getElementById('incident-feed');
  const empty     = document.getElementById('feed-empty');
  if (!container) return;

  let filtered = state.incidents;
  if (state.filterType !== 'all') {
    filtered = filtered.filter(i => getSeverity(i.incidentType) === state.filterType);
  }
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(i =>
      (i.plateNumber || '').toLowerCase().includes(q) ||
      (i.plateState  || '').toLowerCase().includes(q) ||
      (i.incidentType|| '').toLowerCase().includes(q) ||
      getLabel(i.incidentType || '').toLowerCase().includes(q) ||
      (i.notes || '').toLowerCase().includes(q)
    );
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  state.currentPage = Math.min(state.currentPage, totalPages);
  const start = (state.currentPage - 1) * state.pageSize;
  const page  = filtered.slice(start, start + state.pageSize);

  if (filtered.length === 0) {
    container.innerHTML = '';
    empty.style.display = '';
    renderPagination(0);
    return;
  }
  empty.style.display = 'none';

  container.innerHTML = page.map(inc => {
    const sev = getSeverity(inc.incidentType);
    return `
      <div class="incident-card" data-id="${inc.id}">
        <div class="incident-card-sev ${sev}"></div>
        <div class="incident-card-content">
          <div class="incident-card-plate">${(inc.plateState||'').replace(/_/g,' ')} ${inc.plateNumber || '—'}</div>
          <div class="incident-card-type">${getLabel(inc.incidentType)}</div>
          <div class="incident-card-meta">
            <span>${formatDateTime(inc.datetime)}</span>
            ${inc.locationName ? `<span>· ${inc.locationName.split(',')[0]}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.incident-card').forEach(card => {
    card.addEventListener('click', () => {
      closeModal('modal-my-incidents');
      openDrawer(card.dataset.id);
    });
  });

  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const el = document.getElementById('feed-pagination');
  if (!el) return;
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="page-btn ${i === state.currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => { state.currentPage = parseInt(btn.dataset.page); renderFeed(); });
  });
}

function renderMobileFeed() {
  const container = document.getElementById('mobile-feed-list');
  const empty     = document.getElementById('mobile-feed-empty');
  if (!container) return;

  const recent = state.incidents.slice().sort((a, b) => new Date(b.datetime) - new Date(a.datetime)).slice(0, 10);
  if (recent.length === 0) {
    container.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';

  container.innerHTML = recent.map(inc => {
    const sev = getSeverity(inc.incidentType);
    return `
      <div class="incident-card" data-id="${inc.id}">
        <div class="incident-card-sev ${sev}"></div>
        <div class="incident-card-content">
          <div class="incident-card-plate">${(inc.plateState||'').replace(/_/g,' ')} ${inc.plateNumber || '—'}</div>
          <div class="incident-card-type">${getLabel(inc.incidentType)}</div>
          <div class="incident-card-meta"><span>${formatDateTime(inc.datetime)}</span></div>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('.incident-card').forEach(card => {
    card.addEventListener('click', () => openDrawer(card.dataset.id));
  });
}

// ── Incident modal ────────────────────────────────────────────────

function openIncidentModal(editId = null) {
  state.editingId = editId;
  const title = document.getElementById('incident-modal-title');
  title.textContent = editId ? 'Edit Incident' : 'Log Incident';

  if (editId) {
    resetIncidentForm();
  } else {
    resetIncidentForm();
  }

  openModal('modal-incident');

  // Populate AFTER modal is visible so select options are rendered
  setTimeout(() => {
    if (editId) {
      const inc = state.incidents.find(i => i.id === editId);
      if (inc) populateIncidentForm(inc);
    }

    initMiniMap();
    if (editId) {
      const inc = state.incidents.find(i => i.id === editId);
      if (inc?.lat && inc?.lng) {
        state.miniMap.setView([inc.lat, inc.lng], 14);
        if (state.miniMarker) state.miniMarker.setLatLng([inc.lat, inc.lng]);
        else state.miniMarker = L.marker([inc.lat, inc.lng]).addTo(state.miniMap);
      }
    } else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        state.miniMap?.setView([pos.coords.latitude, pos.coords.longitude], 14);
      }, () => {});
    }
    state.miniMap?.invalidateSize();
  }, 150);
}

function resetIncidentForm() {
  const fields = ['incident-plate-state', 'incident-plate-number', 'incident-type',
    'incident-vehicle-make', 'incident-vehicle-color', 'incident-location-name',
    'incident-lat', 'incident-lng', 'incident-notes'];
  fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('incident-datetime').value = nowLocalISO();
  document.getElementById('incident-visibility').value = 'private';
  document.getElementById('plate-preview-wrap').style.display = 'none';
  document.getElementById('plate-subtype-group').style.display = 'none';
}

function populateIncidentForm(inc) {
  document.getElementById('incident-plate-state').value    = inc.plateState    || '';
  document.getElementById('incident-plate-number').value   = inc.plateNumber   || '';
  document.getElementById('incident-type').value           = inc.incidentType  || '';
  document.getElementById('incident-datetime').value       = inc.datetime?.slice(0,16) || nowLocalISO();
  document.getElementById('incident-vehicle-make').value   = inc.vehicleMake   || '';
  document.getElementById('incident-vehicle-color').value  = inc.vehicleColor  || '';
  document.getElementById('incident-location-name').value  = inc.locationName  || '';
  document.getElementById('incident-lat').value            = inc.lat           || '';
  document.getElementById('incident-lng').value            = inc.lng           || '';
  document.getElementById('incident-notes').value          = inc.notes         || '';
  document.getElementById('incident-visibility').value     = inc.visibility    || 'private';
  if (inc.plateState) onStateSelected(inc.plateState);
  renderPlatePreview();
}

function collectIncidentForm() {
  return {
    plateState:   document.getElementById('incident-plate-state').value,
    plateNumber:  document.getElementById('incident-plate-number').value.trim().toUpperCase(),
    incidentType: document.getElementById('incident-type').value,
    datetime:     document.getElementById('incident-datetime').value,
    vehicleMake:  document.getElementById('incident-vehicle-make').value.trim(),
    vehicleColor: document.getElementById('incident-vehicle-color').value.trim(),
    locationName: document.getElementById('incident-location-name').value.trim(),
    lat:          parseFloat(document.getElementById('incident-lat').value) || null,
    lng:          parseFloat(document.getElementById('incident-lng').value) || null,
    notes:        document.getElementById('incident-notes').value.trim(),
    visibility:   document.getElementById('incident-visibility').value,
  };
}

function saveIncident() {
  const data = collectIncidentForm();
  if (!data.plateState || !data.plateNumber) { showToast('Please select a state and enter a plate number.'); return; }
  if (!data.incidentType) { showToast('Please select an incident type.'); return; }

  if (state.editingId) {
    const idx = state.incidents.findIndex(i => i.id === state.editingId);
    if (idx !== -1) {
      state.incidents[idx] = { ...state.incidents[idx], ...data };
    }
  } else {
    state.incidents.unshift({ id: uid(), ...data, createdAt: new Date().toISOString() });
  }

  saveIncidents();
  closeModal('modal-incident');
  renderMapPins();
  renderMobileFeed();
  showToast(state.editingId ? 'Incident updated.' : 'Incident logged. 📍');
  state.editingId = null;

  // Async sync
  if (state.workerUrl && !Auth.isGuest()) pushIncidentsToWorker().catch(() => {});
}

function deleteIncident(id) {
  const inc = state.incidents.find(i => i.id === id);
  if (!inc) return;
  document.getElementById('delete-message').textContent =
    `Delete the ${getLabel(inc.incidentType)} incident for ${inc.plateState?.replace(/_/g,' ')} ${inc.plateNumber}?`;
  state._pendingDeleteId = id;
  openModal('modal-delete');
}

function confirmDelete() {
  const id  = state._pendingDeleteId;
  const inc = state.incidents.find(i => i.id === id);
  state.incidents = state.incidents.filter(i => i.id !== id);
  saveIncidents();
  closeModal('modal-delete');
  closeDrawer();
  renderMapPins();
  renderMobileFeed();
  showToast('Incident deleted.');
  state._pendingDeleteId = null;
  // Remove from plate index
  if (inc && inc.visibility !== 'private' && state.workerUrl) {
    updatePlateIndex(inc, true).catch(() => {});
  }
}

// ── Modal system ──────────────────────────────────────────────────

function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('open'); document.body.style.overflow = 'hidden'; }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    if (!document.querySelector('.modal-overlay.open')) document.body.style.overflow = '';
  }
}

// Close buttons
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Click overlay to close
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ── Settings modal ────────────────────────────────────────────────

function openSettingsModal() {
  // Populate fields
  const tokenEl  = document.getElementById('p-token');
  const workerEl = document.getElementById('p-worker-url');
  const userEl   = document.getElementById('settings-username');
  const psEl     = document.getElementById('settings-page-size');

  if (tokenEl)  tokenEl.value  = state.token    || '';
  if (workerEl) workerEl.value = state.workerUrl || '';
  if (userEl)   userEl.value   = state.username  || '';
  if (psEl)     psEl.value     = state.pageSize;

  // Let auth module set badge + toggle section visibility
  Auth.renderSettingsSection();

  // Additionally hide/show worker URL group based on auth state
  // (Auth.renderSettingsSection handles token/google/guest groups but not this field)
  const workerGroupEl = document.getElementById('settings-worker-group');
  if (workerGroupEl) workerGroupEl.style.display = Auth.isGuest() ? 'none' : '';

  openModal('modal-settings');
}

function saveSettings_modal() {
  const workerEl = document.getElementById('p-worker-url');
  const psEl     = document.getElementById('settings-page-size');
  if (workerEl) state.workerUrl = workerEl.value.trim().replace(/\/$/, '');
  if (psEl)     state.pageSize  = parseInt(psEl.value, 10) || 20;
  saveSettings();
  closeModal('modal-settings');
  showToast('Settings saved.');
}

// ── Friends modal ─────────────────────────────────────────────────

function updateFriendsBadge() {
  const badge = document.getElementById('friends-badge');
  const count = state.incomingReqs.length;
  if (badge) badge.style.display = count > 0 ? '' : 'none';
}

// ── Map control buttons ───────────────────────────────────────────

document.getElementById('btn-map-locate')?.addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition(
    pos => state.mainMap?.setView([pos.coords.latitude, pos.coords.longitude], 14),
    ()  => showToast('Location unavailable.')
  );
});

document.getElementById('btn-map-fit')?.addEventListener('click', fitMapToIncidents);
document.getElementById('btn-chalk-exit')?.addEventListener('click', exitChalkMode);

// ── Header buttons ────────────────────────────────────────────────

document.getElementById('btn-new-incident')?.addEventListener('click', () => openIncidentModal());
document.getElementById('btn-my-incidents')?.addEventListener('click', () => {
  state.currentPage = 1;
  renderFeed();
  openModal('modal-my-incidents');
});
document.getElementById('btn-friends')?.addEventListener('click', () => openModal('modal-friends'));
document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);

// ── Drawer buttons ────────────────────────────────────────────────

document.getElementById('btn-drawer-close')?.addEventListener('click', () => {
  exitChalkMode();
  closeDrawer();
});

document.getElementById('btn-drawer-edit')?.addEventListener('click', () => {
  const editId = state.activeIncidentId;  // capture BEFORE closeDrawer clears it
  if (editId) {
    closeDrawer();
    openIncidentModal(editId);
  }
});

document.getElementById('btn-chalk-mode')?.addEventListener('click', () => {
  if (!state.activeIncidentId) return;
  const inc = state.incidents.find(i => i.id === state.activeIncidentId);
  if (!inc || !inc.plateState || !inc.plateNumber) {
    showToast('No plate data for this incident.');
    return;
  }
  enterChalkMode(inc.plateState, inc.plateNumber.replace(/\s+/g,'').toUpperCase());
});

document.getElementById('btn-drawer-delete')?.addEventListener('click', () => {
  if (state.activeIncidentId) deleteIncident(state.activeIncidentId);
});

// ── Incident modal buttons ────────────────────────────────────────

document.getElementById('btn-save-incident')?.addEventListener('click', saveIncident);
document.getElementById('btn-confirm-delete')?.addEventListener('click', confirmDelete);

document.getElementById('incident-plate-state')?.addEventListener('change', (e) => {
  onStateSelected(e.target.value);
  renderPlatePreview();
});

document.getElementById('incident-plate-number')?.addEventListener('input', () => {
  const el  = document.getElementById('incident-plate-number');
  el.value  = el.value.toUpperCase();
  renderPlatePreview();
});

document.getElementById('btn-incident-locate')?.addEventListener('click', () => {
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    document.getElementById('incident-lat').value = lat.toFixed(6);
    document.getElementById('incident-lng').value = lng.toFixed(6);
    reverseGeocode(lat, lng);
    if (state.miniMap) {
      state.miniMap.setView([lat, lng], 15);
      if (state.miniMarker) state.miniMarker.setLatLng([lat, lng]);
      else { state.miniMarker = L.marker([lat, lng]).addTo(state.miniMap); }
    }
  }, () => showToast('Location unavailable.'));
});

// ── Settings modal buttons ────────────────────────────────────────

document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings_modal);

document.getElementById('btn-switch-account')?.addEventListener('click', () => {
  closeModal('modal-settings');
  if (Auth.isGuest()) Auth.showGuestSwitchConfirm();
  else Auth.showAccountSetup();
});

// Event delegation on the settings modal for guest section buttons.
// These buttons are dynamically shown/hidden so direct listeners can misfire.
// setTimeout defers execution past DOM mutation caused by closeModal.
document.getElementById('modal-settings')?.addEventListener('click', e => {
  if (e.target.closest('#btn-guest-create-account')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showSetupFresh(); }, 0);
  }
  if (e.target.closest('#btn-switch-account-guest')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showGuestSwitchConfirm(); }, 0);
  }
  if (e.target.closest('#btn-upgrade-to-google')) {
    setTimeout(() => { closeModal('modal-settings'); Auth.showGoogleUpgradeFlow(); }, 0);
  }
});

// btn-upgrade-to-google handled via modal event delegation above

document.getElementById('btn-manual-sync')?.addEventListener('click', async () => {
  showToast('Syncing…');
  await pullIncidentsFromWorker();
  await pushIncidentsToWorker();
  renderMapPins();
  renderMobileFeed();
  showToast('Synced ✓');
});

// Feed search / filter
document.getElementById('feed-search')?.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  state.currentPage = 1;
  renderFeed();
});
document.getElementById('feed-filter-type')?.addEventListener('change', (e) => {
  state.filterType = e.target.value;
  state.currentPage = 1;
  renderFeed();
});

// Friends tabs
document.querySelectorAll('.friends-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.friends-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.friends-tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(target)?.classList.add('active');
  });
});

// ── Boot ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  loadSettings();
  loadIncidents();
  applyDarkMode();

  // Auth module init
  Auth.init({
    googleClientId:    '',   // Set your Google Client ID
    storageKey:        STORAGE_KEY,
    storageAuthKey:    STORAGE_AUTH,
    storageDismissKey: STORAGE_DISMISS,
    workerBase:        () => state.workerUrl || '',
    getData: () => ({
      userToken:    state.token,
      workerUrl:    state.workerUrl,
      authMethod:   state.authMethod,
      linkedGoogle: state.linkedGoogle,
      createdAt:    state.createdAt,
    }),
    setData: (d) => {
      if (d.userToken    !== undefined) state.token        = d.userToken;
      if (d.workerUrl    !== undefined) state.workerUrl    = d.workerUrl;
      if (d.authMethod   !== undefined) state.authMethod   = d.authMethod;
      if (d.linkedGoogle !== undefined) state.linkedGoogle = d.linkedGoogle;
      if (d.createdAt    !== undefined) state.createdAt    = d.createdAt;
      saveSettings();
    },
    mergeData: (raw) => ({
      userToken:    raw.userToken    ?? state.token,
      workerUrl:    raw.workerUrl    ?? state.workerUrl ?? '',
      authMethod:   raw.authMethod   ?? 'token',
      linkedGoogle: raw.linkedGoogle ?? null,
      createdAt:    raw.createdAt    ?? Date.now(),
    }),
    onSignedIn: async (data, isNewAccount) => {
      if (data.userToken    !== undefined) state.token        = data.userToken;
      if (data.workerUrl    !== undefined) state.workerUrl    = data.workerUrl;
      if (data.authMethod   !== undefined) state.authMethod   = data.authMethod;
      if (data.linkedGoogle !== undefined) state.linkedGoogle = data.linkedGoogle;
      if (data.createdAt    !== undefined) state.createdAt    = data.createdAt;
      saveSettings();
      if (!isNewAccount) {
        await loadProfileFromKV();
        await pullIncidentsFromWorker();
        applyDarkMode();
      }
      renderMapPins();
      renderMobileFeed();
      updateFriendsBadge();
      showToast('Welcome to Road Rant 🚗');
    },
    onGuestReady: (data) => {
      if (data.authMethod !== undefined) state.authMethod = data.authMethod;
      saveSettings();
      renderMapPins();
      renderMobileFeed();
    },
    onSessionExpired: () => {},
    pushToWorker:  () => saveProfileToKV(),
    startSyncPing: () => {},
    openModal,
    closeModal,
    toast:    (msg) => showToast(msg),
    appName:  'Road Rant',
    appEmoji: '🚗',
  });

  // Load plates config
  await loadPlatesConfig();

  // First run?
  const isFirstRun = !state.token && !state.authMethod;
  if (isFirstRun) {
    initMainMap();
    renderMapPins();
    renderMobileFeed();
    Auth.showAccountSetup();
    return;
  }

  // Existing session
  if (state.workerUrl && !Auth.isGuest()) {
    await loadProfileFromKV();
    applyDarkMode();
    const shouldContinue = await Auth.bootCheck(state.token);
    if (!shouldContinue) { initMainMap(); return; }
    await pullIncidentsFromWorker();
  }

  initMainMap();
  renderMapPins();
  renderMobileFeed();
  updateFriendsBadge();

  // Periodic sync every 60s
  setInterval(async () => {
    if (state.workerUrl && !Auth.isGuest()) {
      await pullIncidentsFromWorker();
      renderMapPins();
      renderMobileFeed();
    }
  }, 60000);
});
