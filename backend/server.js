/**
 * IoT Monitor — Backend Multi-Tenant
 * Cada cliente vê APENAS seus próprios dispositivos e dados.
 * Admin vê tudo.
 */

require('dotenv').config(); // Carrega variáveis do .env

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mqtt = require('mqtt');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── Configurações ────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 4000,
  JWT_SECRET: process.env.JWT_SECRET || 'S3gr3d0_Ultra_S3cur0_IoTMonitor_2024!@#$%',
  JWT_EXPIRES: '8h',

  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'meu_banco',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  },

  MQTT: {
    host: process.env.MQTT_HOST || 'mqtt.iotgili.com',
    port: process.env.MQTT_PORT || 8883,
    protocol: 'mqtts',
    username: process.env.MQTT_USER || 'SEU_USUARIO_MQTT',
    password: process.env.MQTT_PASS || 'SUA_SENHA_MQTT',
    ca: fs.readFileSync(path.join(__dirname, 'certs', 'isrg_root_x1.pem')),
    rejectUnauthorized: true,
    clientId: `iotmonitor_${uuidv4()}`,
    reconnectPeriod: 5000,
    keepalive: 60,
  },
};

// ─── App Express ──────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-hashes'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend', 'public')));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use(globalLimiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Muitas tentativas. Tente em 15 minutos.' } });

// ─── Banco de Dados ───────────────────────────────────────────────────────────
let db;

async function initDB() {
  db = await mysql.createPool(CONFIG.DB);

  // Usuários — agora com customer_id para separar clientes
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','viewer') DEFAULT 'viewer',
      customer_id VARCHAR(36) NULL,
      device_id VARCHAR(36) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL,
      login_attempts INT DEFAULT 0,
      locked_until TIMESTAMP NULL
    )
  `);

  // Clientes (empresas/pessoas)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150),
      phone VARCHAR(30),
      notes TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Dispositivos vinculados ao cliente
  await db.execute(`
    CREATE TABLE IF NOT EXISTS devices (
      id VARCHAR(36) PRIMARY KEY,
      customer_id VARCHAR(36) NOT NULL,
      name VARCHAR(100) NOT NULL,
      topic_prefix VARCHAR(200) NOT NULL,
      description TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (customer_id)
    )
  `);

  // Dados dos sensores
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(36),
      customer_id VARCHAR(36),
      sensor_type VARCHAR(50) NOT NULL,
      topic VARCHAR(200) NOT NULL,
      value DOUBLE NOT NULL,
      unit VARCHAR(20),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_device_time (device_id, recorded_at),
      INDEX idx_customer_time (customer_id, recorded_at),
      INDEX idx_topic_time (topic, recorded_at)
    )
  `);

  // Alertas por cliente
  await db.execute(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_id VARCHAR(36),
      device_id VARCHAR(36),
      sensor_type VARCHAR(50),
      condition_type ENUM('gt','lt','eq','ne') NOT NULL,
      threshold DOUBLE NOT NULL,
      message TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Auditoria
  await db.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      ip VARCHAR(45),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ─── Migrações automáticas ───────────────────────────────────────────────────
  // Adiciona customer_id na tabela users se ainda não existir (banco legado)
  try {
    const [cols] = await db.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'customer_id'
    `);
    if (cols.length === 0) {
      await db.execute(`ALTER TABLE users ADD COLUMN customer_id VARCHAR(36) NULL`);
      console.log('✅ Migração: coluna customer_id adicionada à tabela users');
    }
  } catch (migErr) {
    console.error('⚠️  Erro na migração de users.customer_id:', migErr.message);
  }

  // Adiciona device_id na tabela users para vincular cada viewer a um ESP especifico.
  try {
    const [deviceCols] = await db.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'device_id'
    `);
    if (deviceCols.length === 0) {
      await db.execute(`ALTER TABLE users ADD COLUMN device_id VARCHAR(36) NULL`);
      console.log('✅ Migração: coluna device_id adicionada à tabela users');
    }
  } catch (migErr) {
    console.error('⚠️  Erro na migração de users.device_id:', migErr.message);
  }

  // Vincula usuarios viewer antigos ao primeiro dispositivo ativo do cliente, se houver.
  try {
    await db.execute(`
      UPDATE users u
      SET u.device_id = (
        SELECT d.id FROM devices d
        WHERE d.customer_id = u.customer_id AND d.active = TRUE
        ORDER BY d.created_at DESC
        LIMIT 1
      )
      WHERE u.role = 'viewer' AND u.device_id IS NULL AND u.customer_id IS NOT NULL
    `);
  } catch (migErr) {
    console.error('⚠️  Erro ao vincular users.device_id legado:', migErr.message);
  }

  // Adiciona customer_id na tabela sensor_data se ainda não existir (banco legado)
  try {
    const [sensorCols] = await db.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensor_data' AND COLUMN_NAME = 'customer_id'
    `);
    if (sensorCols.length === 0) {
      await db.execute(`ALTER TABLE sensor_data ADD COLUMN customer_id VARCHAR(36) NULL`);
      console.log('✅ Migração: coluna customer_id adicionada à tabela sensor_data');
    }

    const [sensorIdx] = await db.execute(`
      SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sensor_data' AND INDEX_NAME = 'idx_customer_time'
    `);
    if (sensorIdx.length === 0) {
      await db.execute(`CREATE INDEX idx_customer_time ON sensor_data (customer_id, recorded_at)`);
      console.log('✅ Migração: índice idx_customer_time adicionado à tabela sensor_data');
    }
  } catch (migErr) {
    console.error('⚠️  Erro na migração de sensor_data.customer_id:', migErr.message);
  }

  // Admin padrão
  const [rows] = await db.execute('SELECT id FROM users WHERE username = ?', ['admin']);
  if (rows.length === 0) {
    const hash = await bcrypt.hash('admin', 12);
    await db.execute(
      'INSERT INTO users (username, password_hash, role, customer_id) VALUES (?, ?, ?, NULL)',
      ['admin', hash, 'admin']
    );
    console.log('✅ Usuário admin criado. Senha: admin');
  }

  console.log('✅ Banco de dados inicializado (multi-tenant)');
}

// ─── MQTT ─────────────────────────────────────────────────────────────────────
let mqttClient;
const subscribedTopics = new Set();
// Mapa: topic_prefix -> { device_id, customer_id }
const topicMap = new Map();

function normalizeTopicPrefix(prefix) {
  return String(prefix || '').trim().replace(/\/+$/, '');
}

function topicMatchesPrefix(topic, prefix) {
  return topic === prefix || topic.startsWith(`${prefix}/`);
}

function findTopicDevice(topic) {
  const prefixes = [...topicMap.keys()].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (topicMatchesPrefix(topic, prefix)) return topicMap.get(prefix);
  }
  return null;
}

function toPositiveInt(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function subscribeTopicFilter(topic) {
  if (!mqttClient || subscribedTopics.has(topic)) return;
  mqttClient.subscribe(topic, { qos: 1 }, err => {
    if (err) {
      console.error(`Erro ao assinar ${topic}:`, err.message);
      return;
    }
    subscribedTopics.add(topic);
    console.log(`📡 Subscribed: ${topic}`);
  });
}

function subscribeDeviceTopic(prefix) {
  subscribeTopicFilter(`${prefix}/#`);
}

function getNumericField(json, keys) {
  for (const key of keys) {
    if (json[key] !== undefined && Number.isFinite(Number(json[key]))) return Number(json[key]);
  }
  return null;
}

function parseMqttReadings(topic, payload) {
  try {
    const json = JSON.parse(payload);
    const readings = [];
    const temperature = getNumericField(json, ['value', 'v', 'data', 'temperature', 'temp', 'temperatura', 't']);
    if (temperature !== null) {
      readings.push({
        topic,
        value: temperature,
        unit: json.temp_unit ?? json.temperature_unit ?? (json.unit && json.type === 'temperature' ? json.unit : '°C'),
        sensorType: 'temperature',
      });
    }

    const humidity = getNumericField(json, ['humidity', 'humid', 'umidade', 'umi', 'h']);
    if (humidity !== null) {
      readings.push({
        topic,
        value: humidity,
        unit: json.humidity_unit ?? (json.unit && json.type === 'humidity' ? json.unit : '%'),
        sensorType: 'humidity',
      });
    }

    if (readings.length > 0) return readings;

    for (const [key, rawValue] of Object.entries(json)) {
      const value = Number(rawValue);
      if (Number.isFinite(value)) {
        const sensorType = json.type ?? json.sensor ?? inferSensorType(`${topic}/${key}`);
        return [{ topic, value, unit: json.unit ?? json.u ?? '', sensorType }];
      }
    }
    return [];
  } catch {
    const value = Number.parseFloat(payload);
    if (!Number.isFinite(value)) return [];
    return [{ topic, value, unit: '', sensorType: inferSensorType(topic) }];
  }
}

function initMQTT() {
  mqttClient = mqtt.connect(CONFIG.MQTT);

  mqttClient.on('connect', () => {
    console.log('✅ MQTT conectado com TLS');
    resubscribeAll().catch(err => console.error('Erro ao reassinar topicos MQTT:', err.message));
  });

  mqttClient.on('error', err => console.error('❌ Erro MQTT:', err.message));
  mqttClient.on('reconnect', () => console.log('🔄 MQTT reconectando...'));

  mqttClient.on('message', async (topic, message) => {
    try {
      const payload = message.toString();
      const readings = parseMqttReadings(topic, payload);
      if (readings.length === 0) return;

      // Encontrar device e customer pelo topico cadastrado.
      const topicInfo = findTopicDevice(topic);
      const deviceId = topicInfo?.device_id || null;
      const customerId = topicInfo?.customer_id || null;

      for (const reading of readings) {
        const { topic: readingTopic, value, unit, sensorType } = reading;
        await db.execute(
          'INSERT INTO sensor_data (device_id, customer_id, sensor_type, topic, value, unit) VALUES (?, ?, ?, ?, ?, ?)',
          [deviceId, customerId, sensorType, readingTopic, value, unit]
        );

        if (deviceId) checkAlerts(deviceId, customerId, sensorType, value).catch(err => {
          console.error('Erro ao verificar alertas:', err.message);
        });

        broadcastSensorData({ topic: readingTopic, value, unit, sensorType, deviceId, customerId, timestamp: new Date().toISOString() });
      }

    } catch (err) {
      console.error('Erro ao processar MQTT:', err.message);
    }
  });
}

function inferSensorType(topic) {
  const t = topic.toLowerCase();
  if (t.includes('temp')) return 'temperature';
  if (t.includes('humid')) return 'humidity';
  if (t.includes('press')) return 'pressure';
  if (t.includes('light') || t.includes('lux')) return 'light';
  if (t.includes('motion') || t.includes('pir')) return 'motion';
  if (t.includes('co2') || t.includes('gas')) return 'gas';
  if (t.includes('volt')) return 'voltage';
  if (t.includes('current') || t.includes('amp')) return 'current';
  if (t.includes('power') || t.includes('watt')) return 'power';
  if (t.includes('gps') || t.includes('lat') || t.includes('lon')) return 'gps';
  return 'generic';
}

async function resubscribeAll() {
  topicMap.clear();
  const [devices] = await db.execute(
    'SELECT id, customer_id, topic_prefix FROM devices WHERE active = TRUE'
  );
  for (const d of devices) {
    const prefix = normalizeTopicPrefix(d.topic_prefix);
    topicMap.set(prefix, { device_id: d.id, customer_id: d.customer_id });
    subscribeDeviceTopic(prefix);
  }

  // Assina apenas topicos cadastrados para evitar leituras duplicadas por filtros sobrepostos.
}

async function checkAlerts(deviceId, customerId, sensorType, value) {
  const [alerts] = await db.execute(
    'SELECT * FROM alerts WHERE device_id = ? AND sensor_type = ? AND active = TRUE',
    [deviceId, sensorType]
  );
  for (const alert of alerts) {
    let triggered = false;
    if (alert.condition_type === 'gt' && value > alert.threshold) triggered = true;
    if (alert.condition_type === 'lt' && value < alert.threshold) triggered = true;
    if (alert.condition_type === 'eq' && value === alert.threshold) triggered = true;
    if (alert.condition_type === 'ne' && value !== alert.threshold) triggered = true;
    if (triggered) {
      broadcastAlert({ alertId: alert.id, deviceId, customerId, sensorType, value, threshold: alert.threshold, message: alert.message, timestamp: new Date().toISOString() });
    }
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
// wsClients: Map de userId -> { ws, role, customer_id }
const wsClients = new Map();

function broadcastSensorData(data) {
  const msg = JSON.stringify({ type: 'sensor_data', data });
  for (const [, client] of wsClients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    // Admin vê tudo; viewer vê só do seu customer
    if (client.role === 'admin' || (client.customer_id === data.customerId && client.device_id === data.deviceId)) {
      client.ws.send(msg);
    }
  }
}

function broadcastAlert(data) {
  const msg = JSON.stringify({ type: 'alert', data });
  for (const [, client] of wsClients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.role === 'admin' || (client.customer_id === data.customerId && client.device_id === data.deviceId)) {
      client.ws.send(msg);
    }
  }
}

// ─── Middleware JWT ───────────────────────────────────────────────────────────
function requireAuth(roles = []) {
  return (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autorizado' });
    try {
      const decoded = jwt.verify(auth.slice(7), CONFIG.JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) return res.status(403).json({ error: 'Acesso negado' });
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  };
}

// Retorna o customer_id do usuário logado (null se admin)
function getUserCustomerId(req) {
  return req.user.role === 'admin' ? null : req.user.customer_id;
}

function getUserDeviceId(req) {
  return req.user.role === 'admin' ? null : req.user.device_id;
}

function sensorScope(req, alias = 'sd') {
  const clauses = [];
  const params = [];

  if (req.user.role === 'admin') {
    if (req.query.customer_id) {
      clauses.push(`${alias}.customer_id = ?`);
      params.push(req.query.customer_id);
    }
    if (req.query.device_id) {
      clauses.push(`${alias}.device_id = ?`);
      params.push(req.query.device_id);
    }
  } else {
    clauses.push(`${alias}.customer_id = ?`);
    params.push(req.user.customer_id);
    clauses.push(`${alias}.device_id = ?`);
    params.push(req.user.device_id || '__no_device_assigned__');
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

async function auditLog(userId, action, details, ip) {
  try {
    await db.execute(
      'INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)',
      [userId, action, details, ip]
    );
  } catch {}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const username = req.body.username?.trim();
    const { password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Dados inválidos' });

    const [rows] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Conta bloqueada temporariamente' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = user.login_attempts + 1;
      const locked = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await db.execute('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?', [attempts, locked, user.id]);
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    await db.execute('UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, customer_id: user.customer_id, device_id: user.device_id },
      CONFIG.JWT_SECRET,
      { expiresIn: CONFIG.JWT_EXPIRES }
    );

    await auditLog(user.id, 'LOGIN', 'Login bem-sucedido', req.ip);
    res.json({ token, username: user.username, role: user.role, customer_id: user.customer_id, device_id: user.device_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/change-password', requireAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Nova senha deve ter ao menos 8 caracteres' });
    }
    const [rows] = await db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(newPassword, 12);
    await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    await auditLog(req.user.id, 'CHANGE_PASSWORD', 'Senha alterada', req.ip);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Clientes (só admin) ──────────────────────────────────────────────────────
app.get('/api/customers', requireAuth(['admin']), async (req, res) => {
  const [rows] = await db.execute('SELECT * FROM customers ORDER BY name ASC');
  res.json(rows);
});

app.post('/api/customers', requireAuth(['admin']), async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
    const id = uuidv4();
    await db.execute(
      'INSERT INTO customers (id, name, email, phone, notes) VALUES (?, ?, ?, ?, ?)',
      [id, name.trim(), email || '', phone || '', notes || '']
    );
    await auditLog(req.user.id, 'CREATE_CUSTOMER', `Cliente: ${name}`, req.ip);
    res.json({ id, name, email, phone, notes });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.put('/api/customers/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const { name, email, phone, notes, active } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
    const [result] = await db.execute(
      'UPDATE customers SET name=?, email=?, phone=?, notes=?, active=? WHERE id=?',
      [name.trim(), email || '', phone || '', notes || '', active !== false, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Cliente nao encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/customers/:id', requireAuth(['admin']), async (req, res) => {
  await db.execute('UPDATE customers SET active = FALSE WHERE id = ?', [req.params.id]);
  await auditLog(req.user.id, 'DELETE_CUSTOMER', `ID: ${req.params.id}`, req.ip);
  res.json({ success: true });
});

// ─── Dispositivos ─────────────────────────────────────────────────────────────
app.get('/api/devices', requireAuth(), async (req, res) => {
  const customerId = getUserCustomerId(req);
  const deviceId = getUserDeviceId(req);
  let rows;
  if (customerId) {
    // Viewer: só o dispositivo vinculado ao usuario
    [rows] = await db.execute(
      'SELECT d.*, c.name as customer_name FROM devices d LEFT JOIN customers c ON d.customer_id = c.id WHERE d.customer_id = ? AND d.id = ? AND d.active = TRUE ORDER BY d.created_at DESC',
      [customerId, deviceId || '__no_device_assigned__']
    );
  } else {
    // Admin: todos
    let query = 'SELECT d.*, c.name as customer_name FROM devices d LEFT JOIN customers c ON d.customer_id = c.id WHERE d.active = TRUE';
    const params = [];
    if (req.query.customer_id) { query += ' AND d.customer_id = ?'; params.push(req.query.customer_id); }
    if (req.query.device_id) { query += ' AND d.id = ?'; params.push(req.query.device_id); }
    query += ' ORDER BY c.name, d.created_at DESC';
    [rows] = await db.execute(query, params);
  }
  res.json(rows);
});

app.post('/api/devices', requireAuth(['admin']), async (req, res) => {
  try {
    const { name, description, customer_id } = req.body;
    const topic_prefix = normalizeTopicPrefix(req.body.topic_prefix);
    if (!name?.trim() || !topic_prefix || !customer_id) {
      return res.status(400).json({ error: 'name, topic_prefix e customer_id são obrigatórios' });
    }
    const [customers] = await db.execute('SELECT id FROM customers WHERE id = ? AND active = TRUE', [customer_id]);
    if (customers.length === 0) return res.status(400).json({ error: 'Cliente invalido ou inativo' });

    const [existing] = await db.execute(
      'SELECT id FROM devices WHERE topic_prefix = ? AND active = TRUE',
      [topic_prefix]
    );
    if (existing.length > 0) return res.status(409).json({ error: 'Ja existe dispositivo ativo com esse topico' });

    const id = uuidv4();
    await db.execute(
      'INSERT INTO devices (id, customer_id, name, topic_prefix, description) VALUES (?, ?, ?, ?, ?)',
      [id, customer_id, name.trim(), topic_prefix, description ?? '']
    );
    // Atualizar mapa e subscribe
    topicMap.set(topic_prefix, { device_id: id, customer_id });
    subscribeDeviceTopic(topic_prefix);
    await auditLog(req.user.id, 'ADD_DEVICE', `${name} → cliente ${customer_id}`, req.ip);
    res.json({ id, name, topic_prefix, description, customer_id });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/devices/:id', requireAuth(['admin']), async (req, res) => {
  const [devices] = await db.execute('SELECT topic_prefix FROM devices WHERE id = ?', [req.params.id]);
  if (devices.length === 0) return res.status(404).json({ error: 'Dispositivo nao encontrado' });
  await db.execute('UPDATE devices SET active = FALSE WHERE id = ?', [req.params.id]);
  topicMap.delete(normalizeTopicPrefix(devices[0].topic_prefix));
  await auditLog(req.user.id, 'DELETE_DEVICE', `ID: ${req.params.id}`, req.ip);
  res.json({ success: true });
});

// ─── Dados dos Sensores ───────────────────────────────────────────────────────
app.get('/api/sensors/latest', requireAuth(), async (req, res) => {
  try {
    const scope = sensorScope(req, 'sd');
    const limit = req.user.role === 'admin' ? 200 : 100;
    const [rows] = await db.execute(`
      SELECT sd.*, d.name as device_name, c.name as customer_name
      FROM sensor_data sd
      LEFT JOIN devices d ON sd.device_id = d.id
      LEFT JOIN customers c ON sd.customer_id = c.id
      WHERE sd.recorded_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
      ${scope.sql}
      ORDER BY sd.recorded_at DESC LIMIT ${limit}
    `, scope.params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/sensors/history', requireAuth(), async (req, res) => {
  try {
    const { topic, sensor_type, from, to, limit = 500 } = req.query;
    if (!topic) return res.status(400).json({ error: 'topic obrigatório' });

    const customerId = getUserCustomerId(req);
    const fromDate = from ? parseDateOrNull(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to ? parseDateOrNull(to) : new Date();
    if (!fromDate || !toDate) return res.status(400).json({ error: 'Periodo invalido' });
    if (fromDate > toDate) return res.status(400).json({ error: 'Data inicial maior que data final' });
    const safeLimit = toPositiveInt(limit, 500, 2000);

    let query, params;
    const topicLike = `${normalizeTopicPrefix(topic)}/%`;
    const sensorFilter = sensor_type ? ' AND sensor_type = ?' : '';
    const scope = sensorScope(req, 'sd');
    if (customerId) {
      // Garante que viewer só acessa dados do próprio customer
      query = `SELECT value, unit, recorded_at FROM (
                 SELECT value, unit, recorded_at FROM sensor_data sd
                 WHERE (sd.topic = ? OR sd.topic LIKE ?) AND sd.recorded_at BETWEEN ? AND ?
                 ${scope.sql}
                 ${sensorFilter}
                 ORDER BY sd.recorded_at DESC LIMIT ?
               ) recent ORDER BY recorded_at ASC`;
      params = sensor_type
        ? [topic, topicLike, fromDate, toDate, ...scope.params, sensor_type, safeLimit]
        : [topic, topicLike, fromDate, toDate, ...scope.params, safeLimit];
    } else {
      query = `SELECT value, unit, recorded_at FROM (
                 SELECT value, unit, recorded_at FROM sensor_data sd
                 WHERE (sd.topic = ? OR sd.topic LIKE ?) AND sd.recorded_at BETWEEN ? AND ?
                 ${scope.sql}
                 ${sensorFilter}
                 ORDER BY sd.recorded_at DESC LIMIT ?
               ) recent ORDER BY recorded_at ASC`;
      params = sensor_type
        ? [topic, topicLike, fromDate, toDate, ...scope.params, sensor_type, safeLimit]
        : [topic, topicLike, fromDate, toDate, ...scope.params, safeLimit];
    }

    const [rows] = await db.execute(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/sensors/topics', requireAuth(), async (req, res) => {
  try {
    const scope = sensorScope(req, 'sd');
    const [rows] = await db.execute(
      `SELECT sd.topic, sd.sensor_type, MAX(sd.recorded_at) as last_seen,
              MAX(c.name) as customer_name, MAX(d.name) as device_name,
              MAX(sd.customer_id) as customer_id, MAX(sd.device_id) as device_id
       FROM sensor_data sd
       LEFT JOIN customers c ON sd.customer_id = c.id
       LEFT JOIN devices d ON sd.device_id = d.id
       WHERE 1=1 ${scope.sql}
       GROUP BY sd.topic, sd.sensor_type
       ORDER BY last_seen DESC`,
      scope.params
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ Erro em /api/sensors/topics:', err.message);
    res.status(500).json({ error: 'Erro interno', detail: err.message });
  }
});

app.get('/api/sensors/stats', requireAuth(), async (req, res) => {
  try {
    const { topic, period = '1h' } = req.query;
    const scope = sensorScope(req, 'sd');
    const intervals = { '1h': 'INTERVAL 1 HOUR', '6h': 'INTERVAL 6 HOUR', '24h': 'INTERVAL 24 HOUR', '7d': 'INTERVAL 7 DAY' };
    const interval = intervals[period] || 'INTERVAL 1 HOUR';

    let query = `SELECT topic, sensor_type,
      MIN(value) as min_val, MAX(value) as max_val, AVG(value) as avg_val, COUNT(*) as total_readings
      FROM sensor_data sd WHERE sd.recorded_at >= DATE_SUB(NOW(), ${interval})`;
    const params = [...scope.params];

    query += scope.sql;
    if (topic) { query += ' AND sd.topic = ?'; params.push(topic); }
    query += ' GROUP BY topic, sensor_type';

    const [rows] = await db.execute(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Alertas ──────────────────────────────────────────────────────────────────
app.get('/api/alerts', requireAuth(), async (req, res) => {
  const customerId = getUserCustomerId(req);
  const deviceId = getUserDeviceId(req);
  let rows;
  if (customerId) {
    [rows] = await db.execute('SELECT * FROM alerts WHERE customer_id = ? AND device_id = ? AND active = TRUE ORDER BY created_at DESC', [customerId, deviceId || '__no_device_assigned__']);
  } else {
    let query = 'SELECT * FROM alerts WHERE active = TRUE';
    const params = [];
    if (req.query.customer_id) { query += ' AND customer_id = ?'; params.push(req.query.customer_id); }
    if (req.query.device_id) { query += ' AND device_id = ?'; params.push(req.query.device_id); }
    query += ' ORDER BY created_at DESC';
    [rows] = await db.execute(query, params);
  }
  res.json(rows);
});

app.post('/api/alerts', requireAuth(['admin']), async (req, res) => {
  try {
    const { device_id, sensor_type, condition_type, message } = req.body;
    const threshold = Number(req.body.threshold);
    const validConditions = new Set(['gt', 'lt', 'eq', 'ne']);
    if (!device_id || !sensor_type || !validConditions.has(condition_type) || !Number.isFinite(threshold)) {
      return res.status(400).json({ error: 'Dados do alerta invalidos' });
    }

    const [devices] = await db.execute(
      'SELECT id, customer_id FROM devices WHERE id = ? AND active = TRUE',
      [device_id]
    );
    if (devices.length === 0) return res.status(400).json({ error: 'Dispositivo invalido ou inativo' });

    const [result] = await db.execute(
      'INSERT INTO alerts (customer_id, device_id, sensor_type, condition_type, threshold, message) VALUES (?, ?, ?, ?, ?, ?)',
      [devices[0].customer_id, device_id, sensor_type, condition_type, threshold, message || '']
    );
    res.json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/alerts/:id', requireAuth(['admin']), async (req, res) => {
  const [result] = await db.execute('UPDATE alerts SET active = FALSE WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Alerta nao encontrado' });
  res.json({ success: true });
});

// ─── Usuários ─────────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth(['admin']), async (req, res) => {
  const [rows] = await db.execute(
    `SELECT u.id, u.username, u.role, u.customer_id, u.device_id, u.created_at, u.last_login,
            c.name as customer_name, d.name as device_name, d.topic_prefix
     FROM users u
     LEFT JOIN customers c ON u.customer_id = c.id
     LEFT JOIN devices d ON u.device_id = d.id`
  );
  res.json(rows);
});

app.post('/api/users', requireAuth(['admin']), async (req, res) => {
  try {
    const { username, password, role = 'viewer', customer_id, device_id } = req.body;
    if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Perfil invalido' });
    if (!username?.trim() || !password || password.length < 8) return res.status(400).json({ error: 'Dados inválidos' });
    if (role === 'viewer' && !customer_id) return res.status(400).json({ error: 'Viewer precisa de um cliente vinculado' });
    if (role === 'viewer' && !device_id) return res.status(400).json({ error: 'Viewer precisa de um ESP vinculado' });
    if (role === 'viewer') {
      const [customers] = await db.execute('SELECT id FROM customers WHERE id = ? AND active = TRUE', [customer_id]);
      if (customers.length === 0) return res.status(400).json({ error: 'Cliente invalido ou inativo' });
      const [devices] = await db.execute(
        'SELECT id FROM devices WHERE id = ? AND customer_id = ? AND active = TRUE',
        [device_id, customer_id]
      );
      if (devices.length === 0) return res.status(400).json({ error: 'ESP invalido para este cliente' });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.execute(
      'INSERT INTO users (username, password_hash, role, customer_id, device_id) VALUES (?, ?, ?, ?, ?)',
      [username.trim(), hash, role, role === 'admin' ? null : customer_id, role === 'admin' ? null : device_id]
    );
    await auditLog(req.user.id, 'CREATE_USER', `Usuário: ${username} | Cliente: ${customer_id || 'admin'} | ESP: ${device_id || 'todos'}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Usuário já existe' });
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.delete('/api/users/:id', requireAuth(['admin']), async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: 'Não pode deletar a si mesmo' });
  await db.execute('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ─── Auditoria ────────────────────────────────────────────────────────────────
app.get('/api/audit', requireAuth(['admin']), async (req, res) => {
  const [rows] = await db.execute(
    'SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 200'
  );
  res.json(rows);
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

function handleStartupError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${CONFIG.PORT} ja esta em uso. Altere PORT no .env ou finalize o processo atual.`);
  } else {
    console.error('Erro no servidor:', err);
  }
  process.exit(1);
}

server.on('error', handleStartupError);
wss.on('error', handleStartupError);

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const token = params.get('token');
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    wsClients.set(decoded.id, { ws, role: decoded.role, customer_id: decoded.customer_id, device_id: decoded.device_id });
    ws.send(JSON.stringify({ type: 'connected', username: decoded.username, role: decoded.role }));
    ws.on('close', () => wsClients.delete(decoded.id));
    ws.on('error', () => wsClients.delete(decoded.id));
  } catch {
    ws.close(1008, 'Unauthorized');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDB();
    initMQTT();
    server.listen(CONFIG.PORT, () => {
      console.log(`🚀 IoT Monitor Multi-Tenant rodando em http://localhost:${CONFIG.PORT}`);
    });
  } catch (err) {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  }
})();
