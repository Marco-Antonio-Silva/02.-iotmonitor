/**
 * IoT Monitor — Frontend Multi-Tenant
 * Fluxo correto: Admin cria Cliente → Dispositivo (tópico MQTT) → Usuário vinculado ao Cliente
 */

const State = {
  token: null, user: null, ws: null,
  charts: {}, panels: [], sensorData: {}, latestValues: {},
  customers: [], currentPeriod: '1h', alertCount: 0,
  refreshTimer: null, clockTimer: null, wsReconnectTimer: null, intentionalLogout: false,
  adminDevices: [], selectedCustomerId: '', selectedDeviceId: '',
};

const $ = id => document.getElementById(id);
const fmt = (n, d = 2) => (n == null || isNaN(n)) ? '--' : parseFloat(n).toFixed(d);
const fmtTime = ts => new Date(ts).toLocaleTimeString('pt-BR');
const fmtDateTime = ts => new Date(ts).toLocaleString('pt-BR');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function historyRangeQuery() {
  const periods = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 };
  const hours = periods[State.currentPeriod] || 1;
  const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

function normalizeTopic(topic) {
  return String(topic || '').trim().replace(/\/+$/, '');
}

function sensorKey(topic, sensorType = 'generic') {
  return `${normalizeTopic(topic)}::${sensorType || 'generic'}`;
}

function sensorLabel(sensorType) {
  const labels = {
    temperature: 'Temperatura',
    humidity: 'Umidade',
    pressure: 'Pressão',
    generic: 'Sensor',
  };
  return labels[sensorType] || sensorType || 'Sensor';
}

function topicMatchesPanel(panelTopic, mqttTopic) {
  const panel = normalizeTopic(panelTopic).replace(/\/#$/, '');
  const topic = normalizeTopic(mqttTopic);
  return topic === panel || topic.startsWith(`${panel}/`);
}

function panelMatchesReading(panel, topic, sensorType) {
  if (!topicMatchesPanel(panel.topic, topic)) return false;
  return !panel.sensorType || panel.sensorType === 'generic' || panel.sensorType === sensorType;
}

function getPanelMemoryPoints(panel) {
  return Object.entries(State.sensorData)
    .filter(([key]) => {
      const [topic, sensorType] = key.split('::');
      return panelMatchesReading(panel, topic, sensorType);
    })
    .flatMap(([, points]) => points)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function hydratePanelFromMemory(panel) {
  const pts = getPanelMemoryPoints(panel).slice(-300);
  if (pts.length === 0) return false;
  const chart = State.charts[panel.id];
  if (!chart) return false;
  chart.data.labels = pts.map(p => fmtTime(p.timestamp));
  chart.data.datasets[0].data = pts.map(p => p.value);
  chart.update('none');
  updatePanelStats(panel.id, pts.map(p => p.value));
  document.getElementById(`${panel.id}-val`).textContent = `${fmt(pts[pts.length-1].value)} ${panel.unit}`;
  return true;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  const icon = document.createElement('span');
  icon.textContent = icons[type] || '📌';
  const text = document.createElement('span');
  text.textContent = msg;
  el.append(icon, text);
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function showModal(title, bodyHTML) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHTML;
  $('modal-overlay').classList.add('open');
}
function closeModal() { $('modal-overlay').classList.remove('open'); }

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { 'Authorization': `Bearer ${State.token}`, 'Content-Type': 'application/json', ...(opts.headers||{}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async r => {
    if (r.status === 401) { logout(); throw new Error('Sessão expirada'); }
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro desconhecido');
    return d;
  });
}

function scopedPath(path) {
  const params = new URLSearchParams();
  if (State.user?.role === 'admin') {
    if (State.selectedCustomerId) params.set('customer_id', State.selectedCustomerId);
    if (State.selectedDeviceId) params.set('device_id', State.selectedDeviceId);
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.textContent = 'Aguarde...'; btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha no login');
    State.token = data.token;
    State.user = { username: data.username, role: data.role, customer_id: data.customer_id, device_id: data.device_id };
    State.intentionalLogout = false;
    localStorage.setItem('iot_token', data.token);
    localStorage.setItem('iot_user', JSON.stringify(State.user));
    initApp();
  } catch (err) {
    $('login-error').textContent = err.message;
    btn.textContent = 'Entrar'; btn.disabled = false;
  }
};

function logout() {
  State.intentionalLogout = true;
  if (State.refreshTimer) clearInterval(State.refreshTimer);
  if (State.clockTimer) clearInterval(State.clockTimer);
  if (State.wsReconnectTimer) clearTimeout(State.wsReconnectTimer);
  if (State.ws) State.ws.close();
  Object.values(State.charts).forEach(chart => chart?.destroy?.());
  Object.assign(State, {
    token: null, user: null, ws: null, panels: [], charts: {},
    latestValues: {}, sensorData: {}, alertCount: 0,
    refreshTimer: null, clockTimer: null, wsReconnectTimer: null,
    adminDevices: [], selectedCustomerId: '', selectedDeviceId: '',
  });
  localStorage.removeItem('iot_token'); localStorage.removeItem('iot_user');
  $('admin-section').style.display = 'none';
  $('btn-add-device') && ($('btn-add-device').style.display = 'none');
  $('btn-add-alert') && ($('btn-add-alert').style.display = 'none');
  $('app').classList.add('hidden');
  $('login-screen').style.display = 'flex';
  $('login-pass').value = '';
}

// Restaurar sessão salva
(function tryRestoreSession() {
  const token = localStorage.getItem('iot_token');
  const user = localStorage.getItem('iot_user');
  if (token && user) {
    try {
      State.token = token; State.user = JSON.parse(user);
      State.intentionalLogout = false;
      api('/api/devices').then(() => initApp()).catch(() => {
        localStorage.removeItem('iot_token'); localStorage.removeItem('iot_user');
        $('login-screen').style.display = 'flex';
      });
    } catch { $('login-screen').style.display = 'flex'; }
  } else { $('login-screen').style.display = 'flex'; }
})();

// ─── App Init ─────────────────────────────────────────────────────────────────
function initApp() {
  if (State.refreshTimer) clearInterval(State.refreshTimer);
  $('login-screen').style.display = 'none';
  $('app').classList.remove('hidden');
  $('sidebar-username').textContent = State.user.username;
  $('admin-section').style.display = 'none';
  $('admin-dashboard').classList.add('hidden');
  $('btn-add-device') && ($('btn-add-device').style.display = 'none');
  $('btn-add-alert') && ($('btn-add-alert').style.display = 'none');
  if (State.user.role === 'admin') {
    $('admin-section').style.display = 'block';
    $('admin-dashboard').classList.remove('hidden');
    $('btn-add-device') && ($('btn-add-device').style.display = 'inline-flex');
    $('btn-add-alert') && ($('btn-add-alert').style.display = 'inline-flex');
    api('/api/customers').then(c => { State.customers = c; }).catch(() => {});
    loadAdminBrowser();
  }
  startClock(); connectWS(); loadDashboard();
  State.refreshTimer = setInterval(() => {
    if ($('page-dashboard').classList.contains('active')) {
      loadDashboard();
      State.panels.forEach(p => loadPanelHistory(p));
    }
    if ($('page-sensors').classList.contains('active')) refreshSensorPage();
  }, 10000);
}

function startClock() {
  if (State.clockTimer) clearInterval(State.clockTimer);
  const el = $('clock');
  const u = () => { el.textContent = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }); };
  u(); State.clockTimer = setInterval(u, 1000);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  if (!State.token || State.intentionalLogout) return;
  if (State.wsReconnectTimer) clearTimeout(State.wsReconnectTimer);
  const dot = $('ws-dot'), label = $('ws-label');
  dot.className = 'status-dot connecting'; label.textContent = 'Conectando...';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  State.ws = new WebSocket(`${proto}://${location.host}/ws?token=${State.token}`);
  State.ws.onopen = () => { dot.className = 'status-dot connected'; label.textContent = 'Conectado'; };
  State.ws.onclose = () => {
    dot.className = 'status-dot'; label.textContent = 'Desconectado';
    if (State.token && !State.intentionalLogout) State.wsReconnectTimer = setTimeout(connectWS, 5000);
  };
  State.ws.onerror = () => { dot.className = 'status-dot'; label.textContent = 'Erro WS'; };
  State.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sensor_data') handleSensorData(msg.data);
      if (msg.type === 'alert') handleAlert(msg.data);
    } catch {}
  };
}

function handleSensorData(data) {
  const { topic, value, unit, sensorType, timestamp } = data;
  const key = sensorKey(topic, sensorType);
  State.latestValues[key] = { topic, value, unit, sensorType, timestamp };
  if (!State.sensorData[key]) State.sensorData[key] = [];
  State.sensorData[key].push({ value, timestamp });
  if (State.sensorData[key].length > 500) State.sensorData[key].shift();
  if ($('page-sensors').classList.contains('active')) updateSensorCard(topic, data);
  State.panels.forEach(p => {
    if (panelMatchesReading(p, topic, sensorType)) pushChartData(p.id, value, timestamp, topic, unit);
  });
  $('stat-topics').textContent = Object.keys(State.latestValues).length;
}

function handleAlert(data) {
  State.alertCount++;
  const badge = $('alert-badge');
  badge.style.display = 'inline'; badge.textContent = State.alertCount;
  const stream = $('active-alerts');
  if (stream) {
    const el = document.createElement('div');
    el.className = 'alert-item';
    el.innerHTML = `<span class="alert-icon">⚠️</span><div class="alert-content">
      <div class="alert-msg">${escapeHTML(data.message || `Alerta: ${data.sensorType} = ${fmt(data.value)} (limiar: ${data.threshold})`)}</div>
      <div class="alert-meta">${escapeHTML(data.sensorType)} · ${fmtDateTime(data.timestamp)}</div></div>`;
    stream.prepend(el);
    if (stream.children.length > 20) stream.lastChild.remove();
  }
  toast(`⚠️ Alerta: ${data.sensorType} = ${fmt(data.value)}`, 'warn');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [topics, devices, alerts] = await Promise.all([
      api('/api/sensors/topics'), api('/api/devices'), api('/api/alerts'),
    ]);
    $('stat-devices').textContent = devices.filter(d => d.active !== false).length;
    $('stat-alerts').textContent = alerts.filter(a => a.active !== false).length;
    $('stat-topics').textContent = topics.length;
    $('stat-readings').textContent = topics.length;
    if (State.panels.length === 0 && topics.length > 0) {
      topics.slice(0, 4).forEach(t => addPanelForTopic(t.topic, t.sensor_type));
    }
  } catch {}
}

document.querySelectorAll('.period-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    State.currentPeriod = btn.dataset.p;
    State.panels.forEach(p => loadPanelHistory(p));
  };
});

// ─── Panels ───────────────────────────────────────────────────────────────────
const COLORS = ['#00d4ff','#00e676','#ffd600','#ff9500','#bd93f9','#ff3d71','#00bcd4','#69ff47'];

async function addPanel() {
  try {
    const topics = await api('/api/sensors/topics');
    const topicFieldHtml = topics.length > 0
      ? `<div class="field-group"><label>Tópico MQTT</label>
           <select id="m-topic-sel">
             ${topics.map(t => `<option value="${encodeURIComponent(t.topic)}|${encodeURIComponent(t.sensor_type)}">${escapeHTML(t.topic)} — ${escapeHTML(sensorLabel(t.sensor_type))}</option>`).join('')}
           </select>
           <small style="color:var(--text-muted);margin-top:6px;display:block">Ou digite um tópico diferente:</small>
           <input type="text" id="m-topic-manual" placeholder="ex: esp/joao/temperatura" style="margin-top:6px">
         </div>`
      : `<div class="field-group"><label>Tópico MQTT</label>
           <input type="text" id="m-topic-manual" placeholder="ex: esp/joao/temperatura">
           <small style="color:var(--accent);margin-top:6px;display:block">
             ⚠️ Nenhum dado recebido ainda. Digite o tópico exato que o ESP publica.
           </small></div>`;
    showModal('Adicionar Painel', `
      ${topicFieldHtml}
      <div class="field-group"><label>Rótulo do painel</label><input type="text" id="m-label" placeholder="Ex: Temperatura João"></div>
      <div class="field-group"><label>Unidade</label><input type="text" id="m-unit" placeholder="Ex: °C, %, m³"></div>
      <div class="modal-footer">
        <button class="btn-sm" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary small" onclick="confirmAddPanel()">Adicionar</button>
      </div>`);
  } catch (err) { toast(err.message, 'error'); }
}

function confirmAddPanel() {
  const manual = document.getElementById('m-topic-manual')?.value?.trim();
  const sel = document.getElementById('m-topic-sel')?.value?.trim() || '';
  const [selectedTopic, selectedSensorType] = sel
    ? sel.split('|').map(v => decodeURIComponent(v || ''))
    : ['', 'generic'];
  const topic = normalizeTopic(manual || selectedTopic || '');
  const sensorType = manual ? 'generic' : selectedSensorType || 'generic';
  const label = document.getElementById('m-label')?.value?.trim() || `${topic.split('/').pop()} ${sensorLabel(sensorType)}`;
  const unit = document.getElementById('m-unit')?.value?.trim() || '';
  if (!topic) { toast('Informe o tópico MQTT', 'warn'); return; }
  if (manual && sensorType === 'generic') {
    addPanelForTopic(topic, 'temperature', 'Temperatura', '°C');
    addPanelForTopic(topic, 'humidity', 'Umidade', '%');
  } else {
    addPanelForTopic(topic, sensorType, label, unit);
  }
  closeModal();
}

function addPanelForTopic(topic, sensorType, label, unit) {
  topic = normalizeTopic(topic);
  sensorType = sensorType || 'generic';
  if (State.panels.find(p => p.topic === topic && p.sensorType === sensorType)) {
    toast(`Painel para "${topic} — ${sensorLabel(sensorType)}" já existe`, 'info');
    return;
  }
  const id = `panel_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const color = COLORS[State.panels.length % COLORS.length];
  const panel = { id, topic, label: label || sensorLabel(sensorType), unit: unit || '', color, sensorType };
  State.panels.push(panel);
  const hint = $('empty-hint'); if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = 'panel'; div.id = id;
  div.innerHTML = `
    <div class="panel-header">
      <div><div class="panel-title">${escapeHTML(panel.label)}</div><div class="panel-meta" id="${id}-topic">${escapeHTML(topic)} — ${escapeHTML(sensorLabel(sensorType))}</div></div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="panel-value" id="${id}-val">--</span>
        <button class="panel-close-btn" onclick="removePanel('${id}')">✕</button>
      </div>
    </div>
    <div class="panel-chart-wrap"><canvas id="${id}-canvas"></canvas></div>
    <div class="panel-footer">
      <span>Min: <strong id="${id}-min">--</strong></span>
      <span>Máx: <strong id="${id}-max">--</strong></span>
      <span>Méd: <strong id="${id}-avg">--</strong></span>
    </div>`;
  $('panels-grid').appendChild(div);
  const ctx = document.getElementById(`${id}-canvas`).getContext('2d');
  State.charts[id] = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ label: panel.label, data: [], borderColor: color, backgroundColor: color+'18', borderWidth:2, pointRadius:0, pointHoverRadius:4, fill:true, tension:0.4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      plugins: { legend: { display:false }, tooltip: { backgroundColor:'#1a1f2e', borderColor:color, borderWidth:1, titleColor:'#7b8aac', bodyColor:'#e2e8f0' } },
      scales: {
        x: { ticks: { color:'#4a5568', font:{ size:10 }, maxTicksLimit:8 }, grid: { color:'rgba(255,255,255,0.04)' } },
        y: { ticks: { color:'#7b8aac', font:{ size:10 } }, grid: { color:'rgba(255,255,255,0.06)' } },
      },
    },
  });
  hydratePanelFromMemory(panel);
  loadPanelHistory(panel);
}

async function loadPanelHistory(panel) {
  try {
    const points = await api(`/api/sensors/history?topic=${encodeURIComponent(panel.topic)}&sensor_type=${encodeURIComponent(panel.sensorType || 'generic')}&${historyRangeQuery()}&limit=300`);
    const chart = State.charts[panel.id];
    if (!chart) return;
    if (points.length === 0) {
      hydratePanelFromMemory(panel);
      return;
    }
    chart.data.labels = points.map(p => fmtTime(p.recorded_at));
    chart.data.datasets[0].data = points.map(p => p.value);
    chart.update('none');
    updatePanelStats(panel.id, points.map(p => p.value));
    document.getElementById(`${panel.id}-val`).textContent = `${fmt(points[points.length-1].value)} ${panel.unit}`;
  } catch {}
}

function pushChartData(panelId, value, timestamp, mqttTopic, unit) {
  const chart = State.charts[panelId]; if (!chart) return;
  const panel = State.panels.find(p => p.id === panelId);
  if (unit && !panel.unit) panel.unit = unit;
  chart.data.labels.push(fmtTime(timestamp));
  chart.data.datasets[0].data.push(value);
  if (chart.data.labels.length > 300) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
  chart.update('none');
  const valEl = document.getElementById(`${panelId}-val`);
  if (valEl) valEl.textContent = `${fmt(value)} ${panel?.unit||''}`;
  const topicEl = document.getElementById(`${panelId}-topic`);
  if (topicEl && mqttTopic && mqttTopic !== panel?.topic) topicEl.textContent = `${mqttTopic} — ${sensorLabel(panel?.sensorType)}`;
  updatePanelStats(panelId, chart.data.datasets[0].data);
}

function updatePanelStats(panelId, values) {
  if (!values.length) return;
  const min = Math.min(...values), max = Math.max(...values), avg = values.reduce((a,b)=>a+b,0)/values.length;
  const el = id => document.getElementById(`${panelId}-${id}`);
  if (el('min')) el('min').textContent = fmt(min);
  if (el('max')) el('max').textContent = fmt(max);
  if (el('avg')) el('avg').textContent = fmt(avg);
}

function removePanel(id) {
  if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
  State.panels = State.panels.filter(p => p.id !== id);
  const el = $(id); if (el) el.remove();
  if (State.panels.length === 0) {
    const hint = document.createElement('div');
    hint.id = 'empty-hint'; hint.className = 'panel empty-panel';
    hint.innerHTML = `<div class="empty-icon">📊</div><p>Nenhum painel configurado</p><p class="empty-sub">Clique em <strong>+ Painel</strong> para adicionar um gráfico</p>`;
    $('panels-grid').appendChild(hint);
  }
}

// ─── Sensor Page ──────────────────────────────────────────────────────────────
function updateSensorCard(topic, data) {
  const safeId = 'sc_' + sensorKey(topic, data.sensorType).replace(/[^a-z0-9]/gi, '_');
  let card = $(safeId);
  if (!card) {
    card = document.createElement('div');
    card.id = safeId; card.className = 'sensor-card';
    card.onclick = () => addPanelForTopic(topic, data.sensorType, sensorLabel(data.sensorType), data.unit || '');
    const list = $('sensor-list');
    const loading = list.querySelector('.loading-text');
    if (loading) loading.remove();
    list.appendChild(card);
  }
  if (!data.stale) { card.classList.add('fresh'); setTimeout(() => card.classList.remove('fresh'), 2000); }
  const valDisplay = data.value != null
    ? `${fmt(data.value)}<span> ${escapeHTML(data.unit||'')}</span>`
    : `<span style="font-size:0.9rem;opacity:0.5">Sem dados recentes</span>`;
  const timeLabel = data.stale ? `Último: ${fmtDateTime(data.timestamp)}` : `Atualizado: ${fmtTime(data.timestamp)}`;
  card.innerHTML = `
    <div class="sensor-topic">${escapeHTML(topic)} — ${escapeHTML(sensorLabel(data.sensorType))}</div>
    <div class="sensor-val">${valDisplay}</div>
    <div class="sensor-type">${escapeHTML(data.sensorType||'sensor')}</div>
    <div class="sensor-time">${timeLabel}</div>
    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px">Clique para ver no dashboard</div>`;
}

async function refreshSensorPage() {
  try {
    const list = $('sensor-list');
    const latest = await api('/api/sensors/latest');
    if (latest.length > 0) {
      latest.forEach(row => updateSensorCard(row.topic, { value: row.value, unit: row.unit, sensorType: row.sensor_type, timestamp: row.recorded_at }));
    } else {
      const topics = await api('/api/sensors/topics');
      if (topics.length === 0) {
        const loading = list.querySelector('.loading-text');
        if (loading) loading.innerHTML = `
          <div style="text-align:center;padding:40px 20px;color:var(--text-muted)">
            <div style="font-size:3rem;margin-bottom:12px">📡</div>
            <p style="font-size:1rem;margin-bottom:8px;color:var(--text-secondary)">Nenhum dado recebido ainda</p>
            <p style="font-size:0.82rem;opacity:0.6;max-width:420px;margin:0 auto">
              Verifique se os dispositivos ESP estão publicando no broker MQTT e
              se os <strong>tópicos estão cadastrados</strong> na aba Dispositivos.
            </p>
          </div>`;
      } else {
        topics.forEach(row => updateSensorCard(row.topic, { value: null, unit: '', sensorType: row.sensor_type, timestamp: row.last_seen, stale: true }));
      }
    }
  } catch {}
}

function filterSensors() {
  const q = $('sensor-search').value.toLowerCase();
  document.querySelectorAll('.sensor-card').forEach(c => {
    const topic = c.querySelector('.sensor-topic')?.textContent?.toLowerCase() || '';
    c.style.display = topic.includes(q) || q === '' ? '' : 'none';
  });
}

// ─── Customers ────────────────────────────────────────────────────────────────
async function loadCustomers() {
  try {
    const customers = await api('/api/customers');
    State.customers = customers;
    $('customers-body').innerHTML = customers.map(c => `
      <tr>
        <td><strong>${escapeHTML(c.name)}</strong></td><td>${escapeHTML(c.email||'-')}</td><td>${escapeHTML(c.phone||'-')}</td>
        <td style="font-size:0.75rem;color:var(--text-muted)">${escapeHTML(c.notes||'-')}</td>
        <td><span class="chip ${c.active?'chip-green':'chip-red'}">${c.active?'Ativo':'Inativo'}</span></td>
        <td>
          <button class="btn-sm" onclick="showEditCustomer('${c.id}')">Editar</button>
          <button class="btn-danger" onclick="deleteCustomer('${c.id}')">Remover</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:40px">Nenhum cliente cadastrado</td></tr>';
  } catch {}
}

function showAddCustomer() {
  showModal('Novo Cliente', `
    <div class="field-group"><label>Nome *</label><input type="text" id="m-cname" placeholder="João Silva"></div>
    <div class="field-group"><label>Email</label><input type="email" id="m-cemail" placeholder="joao@email.com"></div>
    <div class="field-group"><label>Telefone</label><input type="text" id="m-cphone" placeholder="(49) 99999-9999"></div>
    <div class="field-group"><label>Observações</label><input type="text" id="m-cnotes" placeholder="Ex: Galpão 1"></div>
    <div class="modal-footer">
      <button class="btn-sm" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary small" onclick="confirmAddCustomer()">Criar Cliente</button>
    </div>`);
}

async function confirmAddCustomer() {
  try {
    const c = await api('/api/customers', { method:'POST', body: {
      name: document.getElementById('m-cname').value.trim(),
      email: document.getElementById('m-cemail').value.trim(),
      phone: document.getElementById('m-cphone').value.trim(),
      notes: document.getElementById('m-cnotes').value.trim(),
    }});
    toast(`Cliente "${c.name}" criado!`, 'success');
    closeModal(); loadCustomers();
    api('/api/customers').then(cs => { State.customers = cs; });
  } catch (err) { toast(err.message, 'error'); }
}

function showEditCustomer(id) {
  const c = State.customers.find(x => x.id === id); if (!c) return;
  showModal('Editar Cliente', `
    <div class="field-group"><label>Nome *</label><input type="text" id="m-cname" value="${escapeHTML(c.name)}"></div>
    <div class="field-group"><label>Email</label><input type="email" id="m-cemail" value="${escapeHTML(c.email||'')}"></div>
    <div class="field-group"><label>Telefone</label><input type="text" id="m-cphone" value="${escapeHTML(c.phone||'')}"></div>
    <div class="field-group"><label>Observações</label><input type="text" id="m-cnotes" value="${escapeHTML(c.notes||'')}"></div>
    <div class="field-group"><label>Status</label>
      <select id="m-cactive">
        <option value="true" ${c.active?'selected':''}>Ativo</option>
        <option value="false" ${!c.active?'selected':''}>Inativo</option>
      </select></div>
    <div class="modal-footer">
      <button class="btn-sm" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary small" onclick="confirmEditCustomer('${id}')">Salvar</button>
    </div>`);
}

async function confirmEditCustomer(id) {
  try {
    await api(`/api/customers/${id}`, { method:'PUT', body: {
      name: document.getElementById('m-cname').value.trim(),
      email: document.getElementById('m-cemail').value.trim(),
      phone: document.getElementById('m-cphone').value.trim(),
      notes: document.getElementById('m-cnotes').value.trim(),
      active: document.getElementById('m-cactive').value === 'true',
    }});
    toast('Cliente atualizado!', 'success');
    closeModal(); loadCustomers();
    api('/api/customers').then(cs => { State.customers = cs; });
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteCustomer(id) {
  if (!confirm('Remover cliente?')) return;
  try {
    await api(`/api/customers/${id}`, { method:'DELETE' });
    toast('Cliente removido.', 'info'); loadCustomers();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Devices ──────────────────────────────────────────────────────────────────
async function loadDevices() {
  try {
    const devices = await api('/api/devices');
    const isAdmin = State.user.role === 'admin';
    if (devices.length === 0) {
      $('devices-body').innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">
        Nenhum dispositivo cadastrado.<br><small>Clique em "+ Novo Dispositivo" para vincular um ESP ao broker MQTT.</small>
      </td></tr>`;
      return;
    }
    $('devices-body').innerHTML = devices.map(d => `
      <tr>
        <td><strong>${escapeHTML(d.name)}</strong></td>
        <td><code style="color:var(--accent);font-size:0.75rem">${escapeHTML(d.topic_prefix)}/#</code></td>
        <td>${escapeHTML(d.customer_name||'-')}</td>
        <td>${escapeHTML(d.description||'-')}</td>
        <td><span class="chip ${d.active?'chip-green':'chip-red'}">${d.active?'Ativo':'Inativo'}</span></td>
        <td>${isAdmin?`<button class="btn-danger" onclick="deleteDevice('${d.id}')">Remover</button>`:'-'}</td>
      </tr>`).join('');
  } catch {}
}

async function showAddDevice() {
  try {
    const customers = await api('/api/customers');
    State.customers = customers;
    if (customers.length === 0) {
      toast('Cadastre um cliente primeiro!', 'warn'); return;
    }
    const customerOptions = customers.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}</option>`).join('');
    showModal('Novo Dispositivo ESP', `
      <div style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.2);border-radius:8px;padding:12px;margin-bottom:16px;font-size:0.82rem;color:var(--text-muted)">
        <strong style="color:var(--accent)">Como funciona:</strong><br>
        O servidor vai assinar o tópico <strong>prefixo/#</strong> no broker MQTT e receber tudo que o ESP publicar abaixo daquele prefixo.<br><br>
        Exemplo: prefixo <code>esp/joao</code> → assina <code>esp/joao/#</code><br>
        O ESP publica em <code>esp/joao/temperatura</code>, <code>esp/joao/umidade</code>, etc.
      </div>
      <div class="field-group"><label>Cliente *</label><select id="m-dcustomer">${customerOptions}</select></div>
      <div class="field-group"><label>Nome do Dispositivo *</label><input type="text" id="m-dname" placeholder="ESP32 João - Galpão"></div>
      <div class="field-group">
        <label>Prefixo do Tópico MQTT *</label>
        <input type="text" id="m-dtopic" placeholder="esp/joao"
          oninput="const p=document.getElementById('topic-preview');if(p)p.textContent=(this.value||'prefixo')+'/#'">
        <small style="color:var(--text-muted);margin-top:4px;display:block">
          Será assinado: <strong id="topic-preview">esp/joao/#</strong>
        </small>
      </div>
      <div class="field-group"><label>Descrição</label><input type="text" id="m-ddesc" placeholder="Sensor de temperatura e umidade"></div>
      <div class="modal-footer">
        <button class="btn-sm" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary small" onclick="confirmAddDevice()">Cadastrar e Assinar Tópico</button>
      </div>`);
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

async function confirmAddDevice() {
  const customer_id = document.getElementById('m-dcustomer').value;
  const name = document.getElementById('m-dname').value.trim();
  const topic_prefix = document.getElementById('m-dtopic').value.trim().replace(/\/$/, '');
  const description = document.getElementById('m-ddesc').value.trim();
  if (!name) { toast('Informe o nome do dispositivo', 'warn'); return; }
  if (!topic_prefix) { toast('Informe o prefixo do tópico MQTT', 'warn'); return; }
  try {
    await api('/api/devices', { method:'POST', body: { customer_id, name, topic_prefix, description } });
    toast(`✅ "${name}" cadastrado! Assinando ${topic_prefix}/#`, 'success');
    closeModal(); loadDevices();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteDevice(id) {
  if (!confirm('Remover dispositivo? O servidor vai parar de receber dados deste tópico.')) return;
  try {
    await api(`/api/devices/${id}`, { method:'DELETE' });
    toast('Dispositivo removido.', 'info'); loadDevices();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Alerts ───────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const [alerts, devices] = await Promise.all([api('/api/alerts'), api('/api/devices')]);
    const devMap = Object.fromEntries(devices.map(d => [d.id, d.name]));
    const condLabels = { gt:'>', lt:'<', eq:'=', ne:'≠' };
    $('alerts-body').innerHTML = alerts.map(a => `
      <tr>
        <td>${escapeHTML(devMap[a.device_id]||a.device_id||'Qualquer')}</td>
        <td><span class="chip chip-blue">${escapeHTML(a.sensor_type)}</span></td>
        <td>${escapeHTML(condLabels[a.condition_type]||a.condition_type)}</td>
        <td><strong>${a.threshold}</strong></td>
        <td style="font-size:0.75rem">${escapeHTML(a.message||'-')}</td>
        <td><button class="btn-danger" onclick="deleteAlert(${a.id})">Remover</button></td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">Nenhuma regra cadastrada</td></tr>';
  } catch {}
}

async function showAddAlert() {
  try {
    const devices = await api('/api/devices');
    if (devices.length === 0) { toast('Cadastre um dispositivo ativo primeiro.', 'warn'); return; }
    const deviceOptions = devices.map(d => `<option value="${escapeHTML(d.id)}">${escapeHTML(d.name)} (${escapeHTML(d.topic_prefix)})</option>`).join('');
    showModal('Nova Regra de Alerta', `
      <div class="field-group"><label>Dispositivo</label><select id="m-adevice">${deviceOptions}</select></div>
      <div class="field-group"><label>Tipo de Sensor</label>
        <select id="m-astype">
          <option value="temperature">Temperatura</option><option value="humidity">Umidade</option>
          <option value="pressure">Pressão</option><option value="level">Nível</option>
          <option value="voltage">Tensão</option><option value="gas">Gás/CO2</option>
          <option value="generic">Genérico</option>
        </select></div>
      <div class="field-group"><label>Condição</label>
        <select id="m-acond">
          <option value="gt">Maior que (>)</option><option value="lt">Menor que (<)</option>
          <option value="eq">Igual a (=)</option><option value="ne">Diferente de (≠)</option>
        </select></div>
      <div class="field-group"><label>Valor limiar</label><input type="number" id="m-athresh" placeholder="Ex: 30"></div>
      <div class="field-group"><label>Mensagem do alerta</label><input type="text" id="m-amsg" placeholder="Temperatura alta!"></div>
      <div class="modal-footer">
        <button class="btn-sm" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary small" onclick="confirmAddAlert()">Criar Alerta</button>
      </div>`);
  } catch (err) { toast(err.message, 'error'); }
}

async function confirmAddAlert() {
  try {
    const device_id = document.getElementById('m-adevice').value;
    const threshold = parseFloat(document.getElementById('m-athresh').value);
    if (!device_id) { toast('Selecione um dispositivo', 'warn'); return; }
    if (!Number.isFinite(threshold)) { toast('Informe um valor limiar valido', 'warn'); return; }
    await api('/api/alerts', { method:'POST', body: {
      device_id,
      sensor_type: document.getElementById('m-astype').value,
      condition_type: document.getElementById('m-acond').value,
      threshold,
      message: document.getElementById('m-amsg').value,
    }});
    toast('Alerta criado!', 'success'); closeModal(); loadAlerts();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteAlert(id) {
  if (!confirm('Remover alerta?')) return;
  try { await api(`/api/alerts/${id}`, { method:'DELETE' }); toast('Alerta removido.', 'info'); loadAlerts(); }
  catch (err) { toast(err.message, 'error'); }
}

// ─── Users ────────────────────────────────────────────────────────────────────
async function loadUsers() {
  try {
    const users = await api('/api/users');
    $('users-body').innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHTML(u.username)}</strong></td>
        <td><span class="chip ${u.role==='admin'?'chip-blue':'chip-green'}">${u.role}</span></td>
        <td>${u.customer_name ? escapeHTML(u.customer_name) : (u.role==='admin'?'<em style="opacity:.5">Todos os clientes</em>':'-')}</td>
        <td style="font-size:0.75rem">${fmtDateTime(u.created_at)}</td>
        <td style="font-size:0.75rem">${u.last_login?fmtDateTime(u.last_login):'Nunca'}</td>
        <td><button class="btn-danger" onclick="deleteUser(${u.id})">Remover</button></td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:30px">Nenhum usuário</td></tr>';
  } catch {}
}

async function showAddUser() {
  try {
    const customers = await api('/api/customers');
    State.customers = customers;
    const customerOptions = customers.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}</option>`).join('');
    showModal('Novo Usuário', `
      <div style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.2);border-radius:8px;padding:12px;margin-bottom:16px;font-size:0.82rem;color:var(--text-muted)">
        <strong style="color:var(--accent)">Perfis:</strong><br>
        <strong>Admin</strong> — acesso total a todos os clientes e dados.<br>
        <strong>Viewer</strong> — vê apenas os dispositivos e dados do cliente vinculado.
      </div>
      <div class="field-group"><label>Usuário *</label><input type="text" id="m-uname" placeholder="joao.silva"></div>
      <div class="field-group"><label>Senha * (mín. 8 caracteres)</label><input type="password" id="m-upass" placeholder="••••••••"></div>
      <div class="field-group"><label>Perfil</label>
        <select id="m-urole" onchange="toggleCustomerField(this.value)">
          <option value="viewer">Viewer (cliente específico)</option>
          <option value="admin">Admin (acesso total)</option>
        </select></div>
      <div class="field-group" id="customer-field">
        <label>Cliente vinculado *</label>
        ${customerOptions
          ? `<select id="m-ucustomer">${customerOptions}</select>`
          : `<p style="color:#ffd600;font-size:0.82rem">⚠️ Nenhum cliente cadastrado ainda.</p>`}
        <small style="color:var(--text-muted);margin-top:4px;display:block">Este usuário só verá os dados deste cliente.</small>
      </div>
      <div class="modal-footer">
        <button class="btn-sm" onclick="closeModal()">Cancelar</button>
        <button class="btn-primary small" onclick="confirmAddUser()">Criar Usuário</button>
      </div>`);
  } catch (err) { toast('Erro: ' + err.message, 'error'); }
}

function toggleCustomerField(role) {
  const field = document.getElementById('customer-field');
  if (field) field.style.display = role === 'admin' ? 'none' : '';
}

async function confirmAddUser() {
  try {
    const role = document.getElementById('m-urole').value;
    const customer_id = role === 'viewer' ? document.getElementById('m-ucustomer')?.value : null;
    const username = document.getElementById('m-uname').value.trim();
    const password = document.getElementById('m-upass').value;
    if (!username) { toast('Informe o nome de usuário', 'warn'); return; }
    if (!password || password.length < 8) { toast('Senha deve ter ao menos 8 caracteres', 'warn'); return; }
    if (role === 'viewer' && !customer_id) { toast('Selecione o cliente para o Viewer', 'warn'); return; }
    await api('/api/users', { method:'POST', body: { username, password, role, customer_id } });
    toast(`Usuário "${username}" criado!`, 'success'); closeModal(); loadUsers();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteUser(id) {
  if (!confirm('Remover usuário?')) return;
  try { await api(`/api/users/${id}`, { method:'DELETE' }); toast('Usuário removido.', 'info'); loadUsers(); }
  catch (err) { toast(err.message, 'error'); }
}

// ─── Audit ────────────────────────────────────────────────────────────────────
async function loadAudit() {
  try {
    const rows = await api('/api/audit');
    $('audit-body').innerHTML = rows.map(r => `
      <tr>
        <td style="font-size:0.72rem">${fmtDateTime(r.created_at)}</td>
        <td>${escapeHTML(r.username||'-')}</td>
        <td><code style="color:var(--accent);font-size:0.75rem">${escapeHTML(r.action)}</code></td>
        <td style="font-size:0.75rem;color:var(--text-muted)">${escapeHTML(r.details||'-')}</td>
        <td style="font-size:0.72rem">${escapeHTML(r.ip||'-')}</td>
      </tr>`).join('');
  } catch {}
}

// ─── Change Password ──────────────────────────────────────────────────────────
function showChangePassword() {
  showModal('Alterar Senha', `
    <div class="field-group"><label>Senha Atual</label><input type="password" id="m-curpass" placeholder="••••••••"></div>
    <div class="field-group"><label>Nova Senha (mín. 8 caracteres)</label><input type="password" id="m-newpass" placeholder="••••••••"></div>
    <div class="modal-footer">
      <button class="btn-sm" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary small" onclick="confirmChangePassword()">Alterar</button>
    </div>`);
}

async function confirmChangePassword() {
  try {
    await api('/api/auth/change-password', { method:'POST', body: {
      currentPassword: document.getElementById('m-curpass').value,
      newPassword: document.getElementById('m-newpass').value,
    }});
    toast('Senha alterada com sucesso!', 'success'); closeModal();
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const el = $(`page-${page}`); if (el) el.classList.add('active');
  const nav = document.querySelector(`[data-page="${page}"]`); if (nav) nav.classList.add('active');
  const titles = { dashboard:'Dashboard', sensors:'Sensores', devices:'Dispositivos', alerts:'Alertas', customers:'Clientes', users:'Usuários', audit:'Auditoria' };
  $('page-title').textContent = titles[page] || page;
  if (page === 'dashboard') loadDashboard();
  if (page === 'sensors') refreshSensorPage();
  if (page === 'devices') loadDevices();
  if (page === 'alerts') loadAlerts();
  if (page === 'customers') loadCustomers();
  if (page === 'users') loadUsers();
  if (page === 'audit') loadAudit();
}

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('click', e => {
    e.preventDefault();
    showPage(item.dataset.page);
    if (window.innerWidth <= 768) $('sidebar').classList.remove('open');
  });
});

$('sidebar-toggle').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
$('mobile-menu') && $('mobile-menu').addEventListener('click', () => $('sidebar').classList.toggle('open'));
