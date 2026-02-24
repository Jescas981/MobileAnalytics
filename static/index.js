/* ══════════════════════════════════════════════════════════
   VehicleSense Dashboard JS
   ══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
const state = {
  minutes:       30,
  fromDt:        null,
  toDt:          null,
  mode:          'minutes',   // 'minutes' | 'day'
  session:       'all',
  activeSection: 'dashboard',
};

// ── Chart / map instances ─────────────────────────────────
let charts = {};
let maps   = {};

// ── Chart defaults ────────────────────────────────────────
Chart.defaults.color       = '#556677';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'Share Tech Mono', monospace";
Chart.defaults.font.size   = 11;

function timeAxis() {
  return {
    type: 'time',
    time: {
      tooltipFormat: 'HH:mm:ss',
      displayFormats: { second: 'HH:mm:ss', minute: 'HH:mm', hour: 'HH:mm' },
    },
    ticks: { maxTicksLimit: 8, color: '#4a5568' },
    grid:  { color: 'rgba(255,255,255,0.04)' },
  };
}

function yAxis(label) {
  return {
    ticks: { color: '#4a5568' },
    grid:  { color: 'rgba(255,255,255,0.04)' },
    title: label ? { display: true, text: label, color: '#4a5568', font: { size: 10 } } : undefined,
  };
}

function makeLineChart(id, datasets, opts = {}) {
  const ctx = document.getElementById(id);
  if (!ctx) return null;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { labels: { color: '#8899aa', boxWidth: 10, padding: 14, font: { size: 11 } } },
        tooltip: {
          mode: 'index', intersect: false,
          backgroundColor: '#131920', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
        },
        ...opts.plugins,
      },
      scales: { x: timeAxis(), y: yAxis(opts.yLabel) },
      elements: { point: { radius: 0, hitRadius: 6 }, line: { tension: 0.2, borderWidth: 1.5 } },
    },
  });
  return charts[id];
}

function makeBarChart(id, labels, data, color, label) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label, data, backgroundColor: color + '55', borderColor: color, borderWidth: 1 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 5, color: '#4a5568' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#4a5568' }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

function toPoints(docs, key) {
  return docs.map(d => ({ x: new Date(d.received_at), y: d[key] }));
}

// ── API helper ────────────────────────────────────────────
async function apiFetch(path) {
  const params = new URLSearchParams();
  if (state.mode === 'minutes') {
    params.set('minutes', state.minutes);
    params.set('limit', 5000);
  } else if (state.fromDt) {
    params.set('from_dt', state.fromDt);
    if (state.toDt) params.set('to_dt', state.toDt);
    params.set('limit', 10000);
  }
  if (state.session !== 'all') params.set('session', state.session);

  const res = await fetch(`${path}?${params}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── Helpers ───────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('clock');
  setInterval(() => { el.textContent = new Date().toLocaleTimeString(); }, 1000);
}

function setStatus(ok, text) {
  document.getElementById('statusDot').className = 'status-dot ' + (ok ? 'ok' : 'err');
  document.getElementById('statusText').textContent = text;
}

function subsample(arr, maxPts = 1500) {
  if (arr.length <= maxPts) return arr;
  const step = Math.ceil(arr.length / maxPts);
  return arr.filter((_, i) => i % step === 0);
}

function buildHistogram(values, bins = 30) {
  if (!values.length) return { labels: [], data: [] };
  const mn = Math.min(...values), mx = Math.max(...values);
  const w  = (mx - mn) / bins || 1;
  const counts = new Array(bins).fill(0);
  values.forEach(v => { const i = Math.min(Math.floor((v - mn) / w), bins - 1); counts[i]++; });
  const labels = counts.map((_, i) => (mn + i * w).toFixed(3));
  return { labels, data: counts };
}

const fmt    = v => (typeof v === 'number' ? v.toFixed(4) : '—');
const fmtInt = v => (typeof v === 'number' ? Math.round(v).toLocaleString() : '—');

// ── Stats card builder ────────────────────────────────────
function buildStatsRow(containerId, axes, stats, prefix, colorMap) {
  const row = document.getElementById(containerId);
  row.innerHTML = '';
  axes.forEach(axis => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const cls = { x: 'x', y: 'y', z: 'z' }[axis] || axis;
    card.innerHTML = `
      <div class="stat-axis ${cls}" style="color:${colorMap[axis]}">AXIS ${axis.toUpperCase()}</div>
      <div class="stat-values">
        <div class="stat-val"><span class="stat-key">AVG</span>${fmt(stats[`${prefix}${axis}_avg`])}</div>
        <div class="stat-val"><span class="stat-key">MIN</span>${fmt(stats[`${prefix}${axis}_min`])}</div>
        <div class="stat-val"><span class="stat-key">MAX</span>${fmt(stats[`${prefix}${axis}_max`])}</div>
      </div>`;
    row.appendChild(card);
  });
}

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const [imuData, gpsData, imuStats, summary, latestGps] = await Promise.all([
      apiFetch('/api/imu'),
      apiFetch('/api/gps'),
      apiFetch('/api/imu/stats'),
      apiFetch('/api/summary'),
      apiFetch('/api/gps/latest'),
    ]);

    // KPIs
    document.getElementById('kpiImu').textContent   = fmtInt(summary.imu_count);
    document.getElementById('kpiGps').textContent   = fmtInt(summary.gps_count);
    document.getElementById('kpiAxAvg').textContent = fmt(imuStats.ax_avg);
    document.getElementById('kpiAzAvg').textContent = fmt(imuStats.az_avg);
    document.getElementById('kpiGzAvg').textContent = fmt(imuStats.gz_avg);
    if (latestGps) {
      document.getElementById('kpiLastGps').textContent =
        `${latestGps.lat?.toFixed(5)}, ${latestGps.lon?.toFixed(5)}`;
    }

    const sampled = subsample(imuData);

    // Accel chart
    makeLineChart('imuChart', [
      { label: 'ax', data: toPoints(sampled, 'ax'), borderColor: '#00e5ff', backgroundColor: 'transparent' },
      { label: 'ay', data: toPoints(sampled, 'ay'), borderColor: '#ff6b35', backgroundColor: 'transparent' },
      { label: 'az', data: toPoints(sampled, 'az'), borderColor: '#a78bfa', backgroundColor: 'transparent' },
    ]);

    // Gyro chart (dashboard)
    makeLineChart('gyroChartDash', [
      { label: 'gx', data: toPoints(sampled, 'gx'), borderColor: '#f59e0b', backgroundColor: 'transparent' },
      { label: 'gy', data: toPoints(sampled, 'gy'), borderColor: '#34d399', backgroundColor: 'transparent' },
      { label: 'gz', data: toPoints(sampled, 'gz'), borderColor: '#f472b6', backgroundColor: 'transparent' },
    ], { yLabel: 'rad/s' });

    // Magnitude
    const magData = sampled.map(d => ({
      x: new Date(d.received_at),
      y: Math.sqrt((d.ax||0)**2 + (d.ay||0)**2 + (d.az||0)**2),
    }));
    makeLineChart('magChart', [
      { label: '|a|', data: magData, borderColor: '#39ff14', backgroundColor: 'rgba(57,255,20,0.05)', fill: true },
    ], { yLabel: 'm/s²' });

    renderMap('miniMap', gpsData, { mini: true });
    setStatus(true, 'Live · OK');
  } catch (e) {
    console.error(e);
    setStatus(false, 'Error');
  }
}

// ══════════════════════════════════════════════════════════
// ACCELEROMETER
// ══════════════════════════════════════════════════════════
async function loadImu() {
  try {
    const [imuData, stats] = await Promise.all([apiFetch('/api/imu'), apiFetch('/api/imu/stats')]);
    const ACC_COLORS = { x: '#00e5ff', y: '#ff6b35', z: '#a78bfa' };

    buildStatsRow('imuStatsRow', ['x', 'y', 'z'], stats, 'a', ACC_COLORS);

    const sampled = subsample(imuData, 2000);
    makeLineChart('imuChartFull', [
      { label: 'ax', data: toPoints(sampled, 'ax'), borderColor: ACC_COLORS.x, backgroundColor: 'transparent' },
      { label: 'ay', data: toPoints(sampled, 'ay'), borderColor: ACC_COLORS.y, backgroundColor: 'transparent' },
      { label: 'az', data: toPoints(sampled, 'az'), borderColor: ACC_COLORS.z, backgroundColor: 'transparent' },
    ]);

    ['x', 'y', 'z'].forEach((axis, i) => {
      const { labels, data } = buildHistogram(imuData.map(d => d[`a${axis}`]).filter(v => v != null));
      const colors = [ACC_COLORS.x, ACC_COLORS.y, ACC_COLORS.z];
      makeBarChart(`hist${axis.toUpperCase()}`, labels, data, colors[i], `a${axis}`);
    });

    setStatus(true, 'Live · OK');
  } catch (e) { console.error(e); setStatus(false, 'Error'); }
}

// ══════════════════════════════════════════════════════════
// GYROSCOPE
// ══════════════════════════════════════════════════════════
async function loadGyro() {
  try {
    const [imuData, stats] = await Promise.all([apiFetch('/api/imu'), apiFetch('/api/imu/stats')]);
    const GYRO_COLORS = { x: '#f59e0b', y: '#34d399', z: '#f472b6' };

    buildStatsRow('gyroStatsRow', ['x', 'y', 'z'], stats, 'g', GYRO_COLORS);

    const sampled = subsample(imuData, 2000);
    makeLineChart('gyroChartFull', [
      { label: 'gx', data: toPoints(sampled, 'gx'), borderColor: GYRO_COLORS.x, backgroundColor: 'transparent' },
      { label: 'gy', data: toPoints(sampled, 'gy'), borderColor: GYRO_COLORS.y, backgroundColor: 'transparent' },
      { label: 'gz', data: toPoints(sampled, 'gz'), borderColor: GYRO_COLORS.z, backgroundColor: 'transparent' },
    ], { yLabel: 'rad/s' });

    ['x', 'y', 'z'].forEach((axis, i) => {
      const { labels, data } = buildHistogram(imuData.map(d => d[`g${axis}`]).filter(v => v != null));
      const colors = [GYRO_COLORS.x, GYRO_COLORS.y, GYRO_COLORS.z];
      makeBarChart(`histG${axis.toUpperCase()}`, labels, data, colors[i], `g${axis}`);
    });

    setStatus(true, 'Live · OK');
  } catch (e) { console.error(e); setStatus(false, 'Error'); }
}

// ══════════════════════════════════════════════════════════
// GPS
// ══════════════════════════════════════════════════════════
async function loadGps() {
  try {
    const gpsData = await apiFetch('/api/gps');
    const row = document.getElementById('gpsKpiRow');

    if (gpsData.length) {
      const lats = gpsData.map(d => d.lat);
      const lons = gpsData.map(d => d.lon);
      row.innerHTML = `
        <div class="kpi-card"><span class="kpi-label">Points</span><span class="kpi-value">${fmtInt(gpsData.length)}</span></div>
        <div class="kpi-card"><span class="kpi-label">Lat range</span><span class="kpi-value" style="font-size:1rem">${Math.min(...lats).toFixed(4)} → ${Math.max(...lats).toFixed(4)}</span></div>
        <div class="kpi-card"><span class="kpi-label">Lon range</span><span class="kpi-value" style="font-size:1rem">${Math.min(...lons).toFixed(4)} → ${Math.max(...lons).toFixed(4)}</span></div>
      `;
    } else {
      row.innerHTML = `<div class="kpi-card"><span class="kpi-label">Points</span><span class="kpi-value">0</span></div>`;
    }

    renderMap('fullMap', gpsData, { mini: false });

    makeLineChart('latChart', [
      { label: 'Latitude', data: gpsData.map(d => ({ x: new Date(d.received_at), y: d.lat })), borderColor: '#00e5ff', backgroundColor: 'transparent' },
    ]);
    makeLineChart('lonChart', [
      { label: 'Longitude', data: gpsData.map(d => ({ x: new Date(d.received_at), y: d.lon })), borderColor: '#ff6b35', backgroundColor: 'transparent' },
    ]);

    setStatus(true, 'Live · OK');
  } catch (e) { console.error(e); setStatus(false, 'Error'); }
}

// ── Map renderer ──────────────────────────────────────────
function renderMap(containerId, gpsData, { mini = false } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (maps[containerId]) { maps[containerId].remove(); delete maps[containerId]; }

  if (!gpsData?.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#4a5568;font-family:var(--font-mono);font-size:0.75rem;">No GPS data</div>';
    return;
  }

  const map = L.map(containerId, { zoomControl: !mini, scrollWheelZoom: !mini, dragging: !mini });
  maps[containerId] = map;

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', maxZoom: 19,
  }).addTo(map);

  const coords = gpsData.map(d => [d.lat, d.lon]);
  L.polyline(coords, { color: '#00e5ff', weight: mini ? 2 : 3, opacity: 0.8 }).addTo(map);

  L.circleMarker(coords[0], { radius: mini ? 4 : 7, color: '#39ff14', fillColor: '#39ff14', fillOpacity: 1, weight: 2 })
    .addTo(map).bindPopup(`Start — session ${gpsData[0]?.session ?? '?'}`);
  L.circleMarker(coords[coords.length - 1], { radius: mini ? 4 : 7, color: '#ff6b35', fillColor: '#ff6b35', fillOpacity: 1, weight: 2 })
    .addTo(map).bindPopup('Latest');

  map.fitBounds(L.latLngBounds(coords).pad(0.1));
}

// ── Sessions ──────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await fetch('/api/sessions').then(r => r.json());
    console.log(sessions)
    const sel = document.getElementById('sessionSelect');
    // Keep "All sessions" option, rebuild the rest
    sel.innerHTML = '<option value="all">All sessions</option>';
    sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = `Session ${s}`;
      sel.appendChild(opt);
    });
  } catch (e) { /* silent */ }
}

// ── Available days ────────────────────────────────────────
async function loadAvailableDays() {
  try {
    const days = await fetch('/api/days').then(r => r.json());
    const container = document.getElementById('availableDays');
    container.innerHTML = '';
    days.slice(0, 14).forEach(day => {
      const el = document.createElement('div');
      el.className = 'day-chip';
      el.textContent = day;
      el.addEventListener('click', () => {
        document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.preset').forEach(p => p.classList.remove('active'));
        el.classList.add('active');
        document.getElementById('dayPicker').value = day;
        applyDay(day);
      });
      container.appendChild(el);
    });
  } catch (e) { /* silent */ }
}

function applyDay(day) {
  state.mode   = 'day';
  state.fromDt = day + 'T00:00:00Z';
  state.toDt   = day + 'T23:59:59Z';
  document.getElementById('windowLabel').textContent = `Day: ${day}`;
  loadSection(state.activeSection);
}

// ── Section router ────────────────────────────────────────
function loadSection(section) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${section}`).classList.add('active');
  document.getElementById('sectionTitle').textContent =
    { dashboard: 'Dashboard', imu: 'Accelerometer', gyro: 'Gyroscope', gps: 'GPS Track' }[section] || section;
  state.activeSection = section;

  if      (section === 'dashboard') loadDashboard();
  else if (section === 'imu')       loadImu();
  else if (section === 'gyro')      loadGyro();
  else if (section === 'gps')       loadGps();
}

// ── Auto-refresh ──────────────────────────────────────────
let autoTimer = null;
function startAutoRefresh() {
  clearInterval(autoTimer);
  if (state.mode === 'minutes') {
    autoTimer = setInterval(() => loadSection(state.activeSection), 15_000);
  }
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  loadAvailableDays();
  loadSessions();
  loadSection('dashboard');
  startAutoRefresh();

  // Nav links
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      el.classList.add('active');
      loadSection(el.dataset.section);
    });
  });

  // Time presets
  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      state.mode    = 'minutes';
      state.minutes = parseInt(btn.dataset.minutes);
      const labels  = { 30: 'Last 30 minutes', 60: 'Last hour', 180: 'Last 3 hours', 1440: 'Last 24 hours' };
      document.getElementById('windowLabel').textContent = labels[state.minutes] || `Last ${state.minutes} min`;
      loadSection(state.activeSection);
      startAutoRefresh();
    });
  });

  // Day picker
  document.getElementById('applyDay').addEventListener('click', () => {
    const val = document.getElementById('dayPicker').value;
    if (val) {
      document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('active'));
      applyDay(val);
    }
  });

  // Session selector
  document.getElementById('sessionSelect').addEventListener('change', e => {
    state.session = e.target.value;
    loadSection(state.activeSection);
  });

  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    Promise.all([loadAvailableDays(), loadSessions()])
      .then(() => loadSection(state.activeSection));
    setTimeout(() => btn.classList.remove('spinning'), 700);
  });
});