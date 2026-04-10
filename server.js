// ==================== ADVANCED LMS - SERVER.JS (PRODUCTION READY V2.0) ====================
console.log("🚀 Starting Advanced LMS Server v2.0 - Full Feature Update...");

const express = require('express');
const { Pool, Client } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cron = require('node-cron');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const firebaseAdmin = require('firebase-admin');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;

function getConfiguredLogoPath() {
  return String(process.env.LOGO_URL || '/logo.png').trim() || '/logo.png';
}

function isAbsoluteHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

// ==================== CONFIG ====================
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_change_this_in_production';
const DEFAULT_CLASS = process.env.DEFAULT_CLASS_LINK || 'https://us04web.zoom.us/j/7288533155?pwd=Nng5N2l0aU12L0FQK245c0VVVHJBUT09';

// Warn if using default secrets
if (ADMIN_SECRET === 'super_secret_change_this_in_production') {
  console.warn('⚠️  WARNING: Using default ADMIN_SECRET. Set ADMIN_SECRET env variable for production!');
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin123') {
  console.warn('⚠️  WARNING: Using default ADMIN_PASSWORD. Set ADMIN_PASSWORD env variable for production!');
}

// ==================== CLOUDINARY CONFIG ====================
// Configure Cloudinary for persistent file storage
// Support both CLOUDINARY_URL and individual env vars
let cloudName = process.env.CLOUDINARY_CLOUD_NAME;
let apiKey = process.env.CLOUDINARY_API_KEY;
let apiSecret = process.env.CLOUDINARY_API_SECRET;

// Parse CLOUDINARY_URL if individual vars not set (format: cloudinary://api_key:api_secret@cloud_name)
if (!cloudName && process.env.CLOUDINARY_URL) {
  try {
    const url = new URL(process.env.CLOUDINARY_URL.replace('cloudinary://', 'https://'));
    apiKey = url.username;
    apiSecret = url.password;
    cloudName = url.hostname;
    console.log('☁️ Parsed Cloudinary credentials from CLOUDINARY_URL');
  } catch (e) {
    console.error('Failed to parse CLOUDINARY_URL:', e.message);
  }
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret
});

const useCloudinary = !!(cloudName && apiKey && apiSecret);
if (useCloudinary) {
  console.log('☁️ Cloudinary configured for file storage');
} else {
  console.log('📁 Using local file storage (files may be lost on server restart)');
}

// Helper to delete a file from Cloudinary by its URL
async function deleteFromCloudinary(fileUrl) {
  if (!useCloudinary || !fileUrl || !fileUrl.includes('cloudinary.com')) return;
  try {
    // Extract public_id from URL: https://res.cloudinary.com/xxx/image/upload/v123/folder/filename.ext
    const parts = fileUrl.split('/upload/');
    if (parts.length < 2) return;
    const afterUpload = parts[1].replace(/^v\d+\//, ''); // remove version
    const publicId = afterUpload.replace(/\.\w+$/, ''); // remove extension
    const resourceType = fileUrl.includes('/video/') ? 'video' : fileUrl.includes('/raw/') ? 'raw' : 'image';
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    console.log(`🗑️ Deleted from Cloudinary: ${publicId}`);
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
}

// ==================== DATABASE CONNECTION ====================
// Log which database we're connecting to (hide password)
let dbUrl = process.env.DATABASE_URL || '';
const dbHost = dbUrl.includes('@') ? dbUrl.split('@')[1]?.split('/')[0] : 'NOT SET';
console.log(`🔌 Connecting to database: ${dbHost}`);

// Add pgbouncer flag for Supabase transaction pooler (port 6543)
if (dbUrl.includes('pooler.supabase.com') && !dbUrl.includes('pgbouncer=true')) {
  dbUrl += dbUrl.includes('?') ? '&pgbouncer=true' : '?pgbouncer=true';
  console.log('📌 Added pgbouncer=true for Supabase pooler');
}
if (dbUrl.includes('pooler.supabase.com')) {
  if (dbUrl.includes('sslmode=')) {
    dbUrl = dbUrl.replace(/sslmode=[^&]*/g, 'sslmode=no-verify');
  } else {
    dbUrl += dbUrl.includes('?') ? '&sslmode=no-verify' : '?sslmode=no-verify';
  }
  console.log('📌 Enforced sslmode=no-verify for Supabase pooler');
}
if (dbUrl && !dbUrl.includes('application_name=')) {
  dbUrl += dbUrl.includes('?') ? '&application_name=fluentfeathers_lms' : '?application_name=fluentfeathers_lms';
}

const DB_CONNECT_TIMEOUT_MS = Math.max(8000, Number(process.env.DB_CONNECT_TIMEOUT_MS) || 20000);
const DB_STATEMENT_TIMEOUT_MS = Math.max(5000, Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 15000);
const DB_QUERY_TIMEOUT_MS = Math.max(5000, Number(process.env.DB_QUERY_TIMEOUT_MS) || 15000);
const DB_ACTIVE_WINDOW_MS = Math.max(5 * 60 * 1000, Number(process.env.DB_ACTIVE_WINDOW_MS) || 20 * 60 * 1000);
const DB_WAKE_WAIT_MS = Math.max(10000, Number(process.env.DB_WAKE_WAIT_MS) || 45000);
const USE_DEDICATED_DB_PING_CLIENT =
  process.env.DB_DEDICATED_PING_CLIENT === 'true'
    ? true
    : !dbUrl.includes('pooler.supabase.com');

// Robust pool configuration for free-tier hosting with cold starts
const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },  // Always use SSL for Supabase
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Pool configuration optimized for free-tier hosting (Supabase)
  max: 2,                          // Reduce to 2 connections (Supabase pooler limit)
  min: 1,                          // Always keep 1 warm connection (prevents cold TCP setup on every request)
  idleTimeoutMillis: 240000,       // Close EXTRA connections after 4 mins (min:1 is exempt)
  connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
  // allowExitOnIdle removed — keep pool alive so process never idles out
  statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  query_timeout: DB_QUERY_TIMEOUT_MS
});

// Track database readiness
let dbReady = false;
let dbInitializing = false;
let dbReconnectScheduled = false;
let lastDbFailureLogAt = 0;
let schemaInitialized = false;
let schemaInitPromise = null;
let keepAliveStarted = false;
let dbHealthCheckInFlight = false;
let lastDbActivityAt = Date.now();

function markDbActivity() {
  lastDbActivityAt = Date.now();
}

function isTransientDbError(err) {
  if (!err) return false;
  const message = String(err.message || '');
  return (
    err.code === 'ECONNRESET' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNREFUSED' ||
    err.code === '57P01' ||
    err.code === '57P02' ||
    err.code === '57P03' ||
    err.code === '08006' ||
    err.code === '08001' ||
    err.code === '08004' ||
    message.includes('Connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('timeout expired') ||
    message.includes('Client has encountered a connection error') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Connection terminated due to connection timeout')
  );
}

async function waitForDatabaseReady(timeoutMs = DB_WAKE_WAIT_MS) {
  if (dbReady) return true;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const connected = await initializeDatabaseConnection();
      if (connected || dbReady) return true;
    } catch (_) {}

    try {
      await pool.query('SELECT 1');
      dbReady = true;
      markDbActivity();
      return true;
    } catch (_) {}

    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  return dbReady;
}

// Pool error handler - critical for catching connection issues
pool.on('error', (err, client) => {
  console.error('❌ Unexpected database pool error:', err.message);
  dbReady = false;
  // Don't crash - the pool will attempt to reconnect on next query
});

pool.on('connect', (client) => {
  console.log('🔗 New database connection established');
});

pool.on('remove', (client) => {
  console.log('🔌 Database connection removed from pool');
});

// HTML escape utility to prevent XSS in email templates
function escapeHtml(text) {
  if (!text) return '';
  const str = String(text);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Calculate age from date of birth
function calculateAge(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
function getAgeDisplay(student) {
  const age = calculateAge(student.date_of_birth);
  if (age !== null) return age + ' years';
  return student.grade || '-';
}

// Robust query wrapper with retry logic for transient errors
async function executeQuery(queryText, params = [], retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await pool.query(queryText, params);
      // Mark DB as ready on successful query
      if (!dbReady) {
        dbReady = true;
        console.log('✅ Database connection restored');
      }
      markDbActivity();
      return result;
    } catch (err) {
      lastError = err;

      // Check if it's a transient/connection error worth retrying
      const isTransientError = isTransientDbError(err);

      if (isTransientError && attempt < retries) {
        console.warn(`⚠️ Database query failed (attempt ${attempt}/${retries}): ${err.message}`);
        dbReady = false;
        // Longer exponential backoff: 1s, 2s, 4s, 8s for cold starts
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Non-transient error or final attempt, throw
      throw err;
    }
  }

  throw lastError;
}

// Initialize database with retry logic
async function ensureDatabaseSchemaInitialized() {
  if (schemaInitialized) return;
  if (schemaInitPromise) {
    await schemaInitPromise;
    return;
  }

  schemaInitPromise = (async () => {
    await initializeDatabase();
    await runMigrations();
    schemaInitialized = true;
    console.log('✅ Database schema/migrations verified for this process');
  })();

  try {
    await schemaInitPromise;
  } catch (err) {
    schemaInitPromise = null;
    throw err;
  }
}

async function initializeDatabaseConnection() {
  if (dbInitializing) return false;
  dbInitializing = true;

  const maxAttempts = 8;
  const retryDelay = 5000; // 5 seconds

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`🔄 Attempting database connection (attempt ${attempt}/${maxAttempts})...`);

        // Test the connection
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL');

        // Warm up the database with a simple priming query (Supabase cold-start optimization)
        try {
          await client.query('SELECT 1 as warmup');
          console.log('🔥 Database primed (cold-start warmup complete)');
        } catch (e) {
          console.warn('⚠️ Database priming query failed:', e.message);
        }

        client.release();
        dbReady = true;

        // Initialize schema only once per process (avoids heavy repeat work on reconnect)
        await ensureDatabaseSchemaInitialized();

        // One-time retroactive badge award for existing students
        try {
          const students = await pool.query(`
            SELECT s.id, s.name, COALESCE(SUM(cp.points), 0) AS total_points
            FROM students s
            LEFT JOIN class_points cp ON s.id = cp.student_id
            WHERE s.is_active = true
            GROUP BY s.id, s.name
            HAVING COALESCE(SUM(cp.points), 0) > 0
          `);

          let awarded = 0;
          for (const student of students.rows) {
            const total = parseInt(student.total_points);
            if (total % 10 === 0) {
              const badgeType = `class_points_${total}`;
              const existing = await pool.query(
                'SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2',
                [student.id, badgeType]
              );
              if (existing.rows.length === 0) {
                const badgeName = `⭐ ${total} Class Points!`;
                const badgeDesc = `Earned ${total} class points in live classes!`;
                await pool.query(`
                  INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
                  VALUES ($1, $2, $3, $4)
                `, [student.id, badgeType, badgeName, badgeDesc]);
                awarded++;
              }
            }
          }
          if (awarded > 0) {
            console.log(`🏅 Awarded ${awarded} retroactive class points badges to existing students`);
          }
        } catch (err) {
          console.error('Retroactive badge award error:', err.message);
        }

        return true;
      } catch (err) {
        console.error(`❌ Database connection attempt ${attempt} failed:`, err.message);

        if (attempt < maxAttempts) {
          console.log(`⏳ Retrying in ${retryDelay / 1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    console.error('❌ Failed to connect to database after all attempts. Server will retry on first request.');
    return false;
  } finally {
    dbInitializing = false;
  }
}

// Start database connection
initializeDatabaseConnection();

// ==================== MIDDLEWARE ====================
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const pathName = req.path || '';
  if (pathName === '/' || pathName.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});
app.get('/app-icon.png', async (req, res) => {
  try {
    const logoPath = getConfiguredLogoPath();
    if (isAbsoluteHttpUrl(logoPath)) {
      const response = await axios.get(logoPath, { responseType: 'arraybuffer', timeout: 15000 });
      res.set('Content-Type', response.headers['content-type'] || 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(Buffer.from(response.data));
    }

    const normalizedPath = logoPath.startsWith('/') ? logoPath.slice(1) : logoPath;
    const absolutePath = path.join(__dirname, 'public', normalizedPath);
    if (fs.existsSync(absolutePath)) {
      return res.sendFile(absolutePath);
    }

    const fallbackPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(fallbackPath)) {
      return res.sendFile(fallbackPath);
    }

    return res.status(404).send('App icon not found');
  } catch (err) {
    console.warn('App icon fetch failed:', err.message);
    return res.status(502).send('App icon unavailable');
  }
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.send(JSON.stringify({
    name: 'Fluent Feathers Academy LMS',
    short_name: 'Fluent Feathers',
    description: 'Learning Management System for Fluent Feathers Academy',
    start_url: '/',
    display: 'standalone',
    background_color: '#B05D9E',
    theme_color: '#B05D9E',
    orientation: 'portrait-primary',
    icons: [
      { src: '/app-icon.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/app-icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  }));
});

app.get('/firebase-messaging-sw.js', (req, res) => {
  const firebaseCfg = getFirebaseWebConfig();
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host') || '';
  const baseUrl = (process.env.APP_URL || `${proto}://${host}`).replace(/\/$/, '');
  const logoPath = getConfiguredLogoPath();
  const logoAbs = isAbsoluteHttpUrl(logoPath)
    ? logoPath
    : `${baseUrl}${logoPath.startsWith('/') ? '' : '/'}${logoPath}`;

  let js = `
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { body: event.data.text() };
    }
    const data = (payload && typeof payload.data === 'object' && payload.data) ? payload.data : payload;
    const title = (payload.notification && payload.notification.title) || data.title || 'Fluent Feathers Academy';
    const body = (payload.notification && payload.notification.body) || data.body || '';
    const tag = data.notificationTag || data.type || [title, body].filter(Boolean).join('|').slice(0, 180);
    const clickAction = data.click_action || data.url || data.link || '/';
    await self.registration.showNotification(title, {
      body,
      icon: ${JSON.stringify(logoAbs)},
      badge: ${JSON.stringify(logoAbs)},
      tag,
      data: { ...data, click_action: clickAction, url: clickAction, link: clickAction, notificationTag: tag }
    });
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.click_action || data.url || data.link || '/';
  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});
`;

  if (firebaseCfg) {
    js = `
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');
firebase.initializeApp(${JSON.stringify(firebaseCfg)});
const messaging = firebase.messaging();
const recentNotifications = new Map();
function normalizePayloadValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  return value;
}
function normalizeObject(input) {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, normalizePayloadValue(value)]));
}
function shouldSuppressDuplicate(tag) {
  if (!tag) return false;
  const now = Date.now();
  const lastSeen = recentNotifications.get(tag) || 0;
  recentNotifications.set(tag, now);
  for (const [key, ts] of recentNotifications.entries()) {
    if (now - ts > 30000) recentNotifications.delete(key);
  }
  return now - lastSeen < 10000;
}
function parseIncomingPayload(rawPayload) {
  const root = normalizeObject(rawPayload || {});
  const data = normalizeObject(root.data);
  const notification = normalizeObject(root.notification);
  const merged = { ...root, ...data };
  const title = notification.title || merged.title || 'Fluent Feathers Academy';
  const body = notification.body || merged.body || '';
  const tag = merged.notificationTag || merged.type || [title, body].filter(Boolean).join('|').slice(0, 180);
  const clickAction = merged.click_action || merged.url || merged.link || '/';
  return {
    title,
    options: {
      body,
      icon: ${JSON.stringify(logoAbs)},
      badge: ${JSON.stringify(logoAbs)},
      tag,
      renotify: false,
      data: { ...merged, click_action: clickAction, url: clickAction, link: clickAction, notificationTag: tag }
    }
  };
}
function hasDisplayableNotification(rawPayload) {
  const root = normalizeObject(rawPayload || {});
  const notification = normalizeObject(root.notification);
  return !!(notification && (notification.title || notification.body));
}
function showNotificationFromPayload(rawPayload) {
  const parsed = parseIncomingPayload(rawPayload);
  if (!parsed.title || shouldSuppressDuplicate(parsed.options.tag)) return Promise.resolve();
  return self.registration.showNotification(parsed.title, parsed.options);
}
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
messaging.onBackgroundMessage((payload) => {
  if (hasDisplayableNotification(payload)) return;
  showNotificationFromPayload(payload);
});
self.addEventListener('push', (event) => {
  if (!event.data) return;
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { body: event.data.text() };
    }
    if (hasDisplayableNotification(payload)) return;
    await showNotificationFromPayload(payload);
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = normalizeObject(event.notification.data || {});
  const targetUrl = data.click_action || data.url || data.link || '/';
  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        return client.focus();
      }
    }
    return clients.openWindow(targetUrl);
  })());
});
`;
  }

  res.type('application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(js);
});

function getAppBaseUrl() {
  return process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
}

function getJoinClassUrl(sessionId, options = {}) {
  const params = new URLSearchParams();
  if (options.isDemo || options.sessionKind === 'demo') {
    params.set('did', String(sessionId));
    params.set('demo', '1');
  } else {
    params.set('sid', String(sessionId));
  }
  return `${getAppBaseUrl()}/join-class?${params.toString()}`;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'demo-register.html'));
});

app.get('/summer-camp', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'summer-camp-register.html'));
});

app.get('/b/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) {
      return res.status(404).sendFile(path.join(__dirname, 'public', 'birthday-card.html'));
    }

    const result = await executeQuery(`
      SELECT student_name, age, wish_message
      FROM birthday_cards
      WHERE code = $1
      LIMIT 1
    `, [code]);

    if (result.rows.length === 0) {
      return res.status(404).sendFile(path.join(__dirname, 'public', 'birthday-card.html'));
    }

    const row = result.rows[0];
    const params = new URLSearchParams({
      n: row.student_name,
      a: String(row.age),
      w: row.wish_message
    });
    res.redirect(`/birthday-card.html?${params.toString()}`);
  } catch (err) {
    console.error('Birthday short-link redirect error:', err);
    res.status(500).sendFile(path.join(__dirname, 'public', 'birthday-card.html'));
  }
});

// ==================== JOIN CLASS TIME-GATE ====================
function buildUtcInstant(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;
  const dateStr = dateValue instanceof Date
    ? dateValue.toISOString().split('T')[0]
    : String(dateValue).split('T')[0];
  const rawTime = String(timeValue).trim();
  const timeStr = rawTime.length === 5 ? `${rawTime}:00` : rawTime.substring(0, 8);
  const instant = new Date(`${dateStr}T${timeStr}Z`);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

function pickJoinTarget(candidates, now) {
  const phaseWeight = { active: 0, upcoming: 1, ended: 2 };
  const ranked = (candidates || [])
    .filter(Boolean)
    .map((candidate) => {
      const msUntilStart = candidate.start.getTime() - now.getTime();
      const msUntilEnd = candidate.end.getTime() - now.getTime();
      let phase = 'ended';
      if (msUntilStart <= 5 * 60 * 1000 && msUntilEnd >= 0) phase = 'active';
      else if (msUntilStart > 5 * 60 * 1000) phase = 'upcoming';
      return { ...candidate, msUntilStart, msUntilEnd, phase, absStartDiff: Math.abs(msUntilStart) };
    })
    .sort((a, b) => {
      const phaseDiff = phaseWeight[a.phase] - phaseWeight[b.phase];
      if (phaseDiff !== 0) return phaseDiff;
      return a.absStartDiff - b.absStartDiff;
    });
  return ranked[0] || null;
}

// Email buttons point here. Redirects to Zoom only within 5 mins before to class-end.
// Outside that window shows a friendly block page.
app.get('/join-class', async (req, res) => {
  const sid = parseInt(req.query.sid, 10);
  const did = parseInt(req.query.did, 10);
  const preferDemo = req.query.demo === '1' || (!!did && !Number.isNaN(did));
  const lookupId = (!Number.isNaN(did) && did) ? did : sid;
  if (!lookupId || isNaN(lookupId)) {
    return res.status(400).send(joinClassErrorPage('Invalid link', 'This join link is not valid. Please use the Join button in your Parent Portal.'));
  }

  try {
    const currentTime = new Date();
    const candidates = [];

    if (!Number.isNaN(sid) && sid > 0) {
      const sessionResult = await executeQuery(`
        SELECT s.id, s.session_date, s.session_time, s.status,
               COALESCE(s.class_link, st.class_link) AS class_link,
               COALESCE(st.duration, g.duration, '40 mins') AS duration,
               COALESCE(st.name, g.group_name) AS student_name
        FROM sessions s
        LEFT JOIN students st ON s.student_id = st.id
        LEFT JOIN groups g ON s.group_id = g.id
        WHERE s.id = $1
        LIMIT 1
      `, [sid]);

      if (sessionResult.rows.length > 0) {
        const row = sessionResult.rows[0];
        const durationMatch = String(row.duration || '').match(/(\d+)/);
        const durationMins = durationMatch ? parseInt(durationMatch[1], 10) : 40;
        const start = buildUtcInstant(row.session_date, row.session_time);
        if (start) {
          candidates.push({
            kind: 'session',
            studentName: row.student_name,
            classLink: row.class_link || DEFAULT_CLASS,
            joinQuery: `?sid=${encodeURIComponent(String(row.id || sid))}`,
            start,
            end: new Date(start.getTime() + durationMins * 60 * 1000)
          });
        }
      }
    }

    const demoLookupId = (!Number.isNaN(did) && did > 0)
      ? did
      : ((preferDemo && !Number.isNaN(sid) && sid > 0) ? sid : null);

    if (demoLookupId) {
      const demoResult = await executeQuery(`
        SELECT id, demo_date AS session_date, demo_time AS session_time,
               child_name AS student_name, status
        FROM demo_leads
        WHERE id = $1
        LIMIT 1
      `, [demoLookupId]);

      if (demoResult.rows.length > 0) {
        const demoRow = demoResult.rows[0];
        const start = buildUtcInstant(demoRow.session_date, demoRow.session_time);
        if (start) {
          candidates.push({
            kind: 'demo',
            studentName: demoRow.student_name,
            classLink: DEFAULT_CLASS,
            joinQuery: `?did=${encodeURIComponent(String(demoRow.id))}&demo=1`,
            start,
            end: new Date(start.getTime() + 60 * 60 * 1000)
          });
        }
      }
    }

    if (candidates.length === 0) {
      return res.status(404).send(joinClassErrorPage('Session Not Found', 'This session could not be found. Please check your Parent Portal for the correct join link.'));
    }

    const target = pickJoinTarget(candidates, currentTime);
    if (!target) {
      return res.status(404).send(joinClassErrorPage('Session Not Found', 'This session could not be found. Please check your Parent Portal for the correct join link.'));
    }

    if (target.phase === 'active') {
      return res.redirect(target.classLink || DEFAULT_CLASS);
    }

    if (target.phase === 'upcoming') {
      const secondsRemaining = Math.max(1, Math.ceil((target.msUntilStart - 5 * 60 * 1000) / 1000));
      const minsRemaining = Math.ceil(secondsRemaining / 60);
      const hoursRemaining = Math.floor(minsRemaining / 60);
      const minsLeft = minsRemaining % 60;
      const waitMsg = minsRemaining < 60
        ? `${minsRemaining} minute${minsRemaining !== 1 ? 's' : ''}`
        : `${hoursRemaining}h ${minsLeft}m`;
      return res.send(joinClassTooEarlyPage(waitMsg, target.studentName, target.joinQuery, secondsRemaining));
    }

    const endedMessage = target.kind === 'demo'
      ? 'This demo class has already ended.'
      : 'This session has already ended. Please check your Parent Portal for upcoming sessions.';
    return res.send(joinClassErrorPage('Class Has Ended', endedMessage));

    const result = await executeQuery(`
      SELECT s.session_date, s.session_time, s.status,
             COALESCE(s.class_link, st.class_link) AS class_link,
             COALESCE(st.duration, g.duration, '40 mins') AS duration,
             COALESCE(st.name, g.group_name) AS student_name
      FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      LEFT JOIN groups g ON s.group_id = g.id
      WHERE s.id = $1
    `, [sid]);

    if (result.rows.length === 0) {
      // Fallback: check if this is a demo session (demo_leads.id)
      const demoResult = await executeQuery(`
        SELECT demo_date AS session_date, demo_time AS session_time,
               child_name AS student_name, '60 mins' AS duration,
               status
        FROM demo_leads
        WHERE id = $1
      `, [sid]);

      if (demoResult.rows.length === 0) {
        return res.status(404).send(joinClassErrorPage('Session Not Found', 'This session could not be found. Please check your Parent Portal for the correct join link.'));
      }

      const demoRow = demoResult.rows[0];
      const classLink = DEFAULT_CLASS;
      const demoDateStr = demoRow.session_date instanceof Date
        ? demoRow.session_date.toISOString().split('T')[0]
        : String(demoRow.session_date).split('T')[0];
      // Demo dates/times are stored in UTC, same as normal sessions.
      const demoStart = new Date(demoDateStr + 'T' + demoRow.session_time + 'Z');
      const demoEnd = new Date(demoStart.getTime() + 60 * 60 * 1000);
      const nowDemo = new Date();
      const minsUntilDemo = (demoStart - nowDemo) / (1000 * 60);

      if (minsUntilDemo <= 5 && nowDemo <= demoEnd) {
        return res.redirect(classLink);
      }
      if (minsUntilDemo > 5) {
        const minsRemaining = Math.ceil(minsUntilDemo - 5);
        const hoursRemaining = Math.floor(minsRemaining / 60);
        const minsLeft = minsRemaining % 60;
        const waitMsg = minsRemaining < 60
          ? `${minsRemaining} minute${minsRemaining !== 1 ? 's' : ''}`
          : `${hoursRemaining}h ${minsLeft}m`;
        return res.send(joinClassTooEarlyPage(waitMsg, demoRow.student_name, sid, minsRemaining * 60));
      }
      return res.send(joinClassErrorPage('Class Has Ended', 'This demo class has already ended.'));
    }

    const row = result.rows[0];
    const classLink = row.class_link || DEFAULT_CLASS;

    // Parse duration in minutes (e.g. "40 mins" → 40)
    const durationMatch = row.duration ? row.duration.match(/(\d+)/) : null;
    const durationMins = durationMatch ? parseInt(durationMatch[1]) : 40;

    // Build UTC session start time
    const dateStr = row.session_date instanceof Date
      ? row.session_date.toISOString().split('T')[0]
      : String(row.session_date).split('T')[0];
    const sessionStart = new Date(dateStr + 'T' + row.session_time + 'Z');
    const sessionEnd = new Date(sessionStart.getTime() + durationMins * 60 * 1000);
    const now = new Date();
    const minsUntilStart = (sessionStart - now) / (1000 * 60); // positive = future

    // Allow entry from 5 mins before start until class ends
    if (minsUntilStart <= 5 && now <= sessionEnd) {
      return res.redirect(classLink);
    }

    if (minsUntilStart > 5) {
      // Too early
      const minsRemaining = Math.ceil(minsUntilStart - 5);
      const hoursRemaining = Math.floor(minsRemaining / 60);
      const minsLeft = minsRemaining % 60;
      let waitMsg = minsRemaining < 60
        ? `${minsRemaining} minute${minsRemaining !== 1 ? 's' : ''}`
        : `${hoursRemaining}h ${minsLeft}m`;
      return res.send(joinClassTooEarlyPage(waitMsg, row.student_name, sid, minsRemaining * 60));
    }

    // Past class end time
    return res.send(joinClassErrorPage('Class Has Ended', 'This session has already ended. Please check your Parent Portal for upcoming sessions.'));

  } catch (err) {
    console.error('Join-class gate error:', err);
    return res.status(500).send(joinClassErrorPage('Something went wrong', 'Please try again or use the Join button in your Parent Portal.'));
  }
});

function joinClassTooEarlyPage(waitTime, studentName, joinQuery, secondsRemaining) {
  const joinUrl = `/join-class${joinQuery || ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Class Not Open Yet - Fluent Feathers Academy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 20px; padding: 50px 40px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .icon { font-size: 80px; margin-bottom: 20px; display: block; }
    h1 { color: #2d3748; font-size: 26px; margin-bottom: 12px; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; border: 2px solid #f59e0b; border-radius: 30px; padding: 10px 24px; font-size: 15px; font-weight: 700; margin: 16px 0 20px; }
    .countdown { font-size: 32px; font-weight: 900; color: #667eea; margin: 8px 0 20px; letter-spacing: 2px; }
    .info-box { background: #f0f9ff; border: 2px solid #bae6fd; border-radius: 12px; padding: 20px; margin: 20px 0; }
    .info-box p { color: #0369a1; font-size: 15px; line-height: 1.6; margin: 0; }
    .btn-row { display: flex; gap: 12px; justify-content: center; margin-top: 24px; flex-wrap: wrap; }
    .retry-btn { display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 14px 28px; border-radius: 30px; text-decoration: none; font-weight: 700; font-size: 15px; }
    .portal-btn { display: inline-block; background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); color: white; padding: 14px 28px; border-radius: 30px; text-decoration: none; font-weight: 700; font-size: 15px; }
    .auto-msg { margin-top: 16px; color: #718096; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">⏰</span>
    <h1>Class Not Open Yet</h1>
    <div class="badge">Opens in ${waitTime}</div>
    <div class="countdown" id="countdown"></div>
    <div class="info-box">
      <p>👋 Hi${studentName ? ' <strong>' + studentName + '</strong>' : ''}! Your class hasn't started yet.</p>
      <p style="margin-top: 10px;">The join link becomes active <strong>5 minutes before</strong> your class starts.</p>
    </div>
    <div class="btn-row">
      <a href="${joinUrl}" class="retry-btn">🔄 Try Again</a>
      <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" class="portal-btn">🏠 Parent Portal</a>
    </div>
    <p class="auto-msg" id="autoMsg">This page will automatically open the class when it's time.</p>
  </div>
  <script>
    var seconds = ${secondsRemaining || 0};
    var joinUrl = '${joinUrl}';
    function pad(n) { return n < 10 ? '0' + n : n; }
    function tick() {
      if (seconds <= 0) {
        document.getElementById('autoMsg').textContent = 'Opening class now...';
        window.location.href = joinUrl;
        return;
      }
      var h = Math.floor(seconds / 3600);
      var m = Math.floor((seconds % 3600) / 60);
      var s = seconds % 60;
      var display = h > 0 ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
      document.getElementById('countdown').textContent = display;
      seconds--;
      setTimeout(tick, 1000);
    }
    if (seconds > 0) tick();
    else document.getElementById('countdown').style.display = 'none';
  </script>
</body>
</html>`;
}

function joinClassErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Fluent Feathers Academy</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 20px; padding: 50px 40px; max-width: 520px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    .icon { font-size: 80px; margin-bottom: 20px; display: block; }
    h1 { color: #2d3748; font-size: 26px; margin-bottom: 16px; }
    p { color: #4a5568; font-size: 15px; line-height: 1.7; margin-bottom: 24px; }
    .portal-btn { display: inline-block; background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); color: white; padding: 14px 32px; border-radius: 30px; text-decoration: none; font-weight: 700; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">🔒</span>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" class="portal-btn">🏠 Go to Parent Portal</a>
  </div>
</body>
</html>`;
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) markDbActivity();
  next();
});

// DB wake-up handling: wait briefly for the DB instead of surfacing cold-start errors.
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  const alwaysAvailable =
    req.path === '/api/config' ||
    req.path === '/api/health' ||
    req.path === '/api/health/light' ||
    req.path === '/api/db/ping' ||
    req.path === '/api/admin/reconnect-db';

  if (alwaysAvailable) return next();

  if (!dbReady) {
    const warmed = await waitForDatabaseReady();
    if (warmed) return next();

    const failOpenRoutes =
      req.method === 'GET' ||
      req.path.startsWith('/api/public/') ||
      req.path === '/api/parent/login-password';

    if (failOpenRoutes) return next();

    return res.status(503).json({
      error: 'Database is still reconnecting. Please retry in a few seconds.',
      code: 'DB_WAKING_UP'
    });
  }

  next();
});

// Create upload directories
['uploads', 'uploads/materials', 'uploads/homework'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ==================== FILE UPLOAD SETUP ====================
// Local disk storage (fallback when Cloudinary is not configured)
const localDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.body.uploadType === 'homework' ? 'uploads/homework/' : 'uploads/materials/';
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, "_");
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(safeName);
    cb(null, uniqueName);
  }
});

// Cloudinary storage configuration
let cloudinaryStorage = null;
if (useCloudinary) {
  cloudinaryStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
      const folder = req.body.uploadType === 'homework' ? 'fluentfeathers/homework' : 'fluentfeathers/materials';

      // Create unique filename - include extension for raw files (PDFs, docs, etc.)
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
      // For raw files, append extension to public_id so it downloads correctly
      const publicId = (isImage || isVideo) ? uniqueName : uniqueName + ext;

      return {
        folder: folder,
        resource_type: isVideo ? 'video' : isImage ? 'image' : 'raw',
        public_id: publicId,
        allowed_formats: null // Allow all formats
      };
    }
  });
}

// Helper function to get proper download URL from Cloudinary
function getCloudinaryDownloadUrl(url, originalFilename) {
  if (!url || !url.includes('cloudinary')) return url;

  // For Cloudinary URLs, add fl_attachment to force download with proper filename
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    const uploadIndex = pathParts.indexOf('upload');

    if (uploadIndex !== -1) {
      // Insert transformation after 'upload'
      const filename = originalFilename || 'download';
      pathParts.splice(uploadIndex + 1, 0, `fl_attachment:${encodeURIComponent(filename)}`);
      urlObj.pathname = pathParts.join('/');
      return urlObj.toString();
    }
  } catch (e) {
    console.error('Error creating download URL:', e);
  }
  return url;
}

// File filter for security
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const forbidden = ['.exe', '.sh', '.bat', '.cmd', '.php', '.py', '.rb', '.dll', '.msi', '.com', '.scr'];
  if (forbidden.includes(ext)) return cb(new Error('Executable files not allowed'));
  if (file.originalname.includes('..')) return cb(new Error('Invalid filename'));
  cb(null, true);
};

// Use Cloudinary storage if available, otherwise use local disk
const upload = multer({
  storage: useCloudinary ? cloudinaryStorage : localDiskStorage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max for videos
  fileFilter: fileFilter
});

// Wrapper to handle multer upload errors properly
const handleUpload = (fieldName) => {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (err) {
        console.error('❌ Upload error:', err.message, err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
        }
        if (err.message.includes('Cloudinary') || err.message.includes('cloudinary')) {
          return res.status(500).json({ error: 'Cloudinary upload failed: ' + err.message + '. Check Cloudinary credentials in Render.' });
        }
        return res.status(500).json({ error: 'Upload failed: ' + err.message });
      }
      next();
    });
  };
};

// ==================== EXTERNAL PING ENDPOINT ====================
// Add this endpoint to allow external services to ping your app
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbReady ? 'connected' : 'disconnected'
  });
});

// ==================== CONFIG API ====================
// Endpoint to get logo URL and storage status for frontend
app.get('/api/config', (req, res) => {
  try {
    const firebaseWebConfig = getFirebaseWebConfig();
    const firebaseAdminConfigured = !!(
      process.env.FIREBASE_SERVICE_ACCOUNT ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FIREBASE_SERVER_KEY
    );
    res.json({
      logoUrl: '/app-icon.png',
      storageType: useCloudinary ? 'cloudinary' : 'local',
      cloudinaryConfigured: useCloudinary,
      cloudName: useCloudinary ? cloudName : null,
      firebase: firebaseWebConfig,
      firebaseVapidKey: process.env.FIREBASE_VAPID_KEY || null,
      firebaseConfigured: !!firebaseWebConfig,
      pushConfigured: !!(firebaseWebConfig && process.env.FIREBASE_VAPID_KEY),
      adminPushConfigured: firebaseAdminConfigured
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config' });
  }
});

let pushTokenSchemaReady = false;
let pushTokenSchemaInitPromise = null;
async function ensurePushTokenTables() {
  if (pushTokenSchemaReady) return;
  if (pushTokenSchemaInitPromise) {
    await pushTokenSchemaInitPromise;
    return;
  }
  pushTokenSchemaInitPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS parent_fcm_tokens (
        id SERIAL PRIMARY KEY,
        parent_email TEXT NOT NULL,
        fcm_token TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
        id SERIAL PRIMARY KEY,
        fcm_token TEXT NOT NULL UNIQUE,
        user_agent TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_parent_fcm_tokens_email ON parent_fcm_tokens(LOWER(parent_email))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_fcm_tokens_updated_at ON admin_fcm_tokens(updated_at)`);
    pushTokenSchemaReady = true;
  })();
  try {
    await pushTokenSchemaInitPromise;
  } finally {
    pushTokenSchemaInitPromise = null;
  }
}

app.post('/api/admin/register-fcm-token', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'FCM token is required' });
  }
  try {
    await ensurePushTokenTables();
    await pool.query(
      `INSERT INTO admin_fcm_tokens (fcm_token, user_agent, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (fcm_token) DO UPDATE SET user_agent = EXCLUDED.user_agent, updated_at = NOW()`,
      [token, req.headers['user-agent'] || '']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Register FCM token error:', err.message);
    res.status(500).json({ error: 'Failed to register FCM token' });
  }
});

app.post('/api/parent/register-fcm-token', async (req, res) => {
  const { token, email } = req.body;
  if (!token || !email) {
    return res.status(400).json({ error: 'FCM token and email are required' });
  }
  try {
    await ensurePushTokenTables();
    await pool.query(
      `INSERT INTO parent_fcm_tokens (fcm_token, parent_email, user_agent, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (fcm_token) DO UPDATE SET parent_email = EXCLUDED.parent_email, user_agent = EXCLUDED.user_agent, updated_at = NOW()`,
      [token, email.toLowerCase().trim(), req.headers['user-agent'] || '']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Register parent FCM token error:', err.message);
    res.status(500).json({ error: 'Failed to register FCM token' });
  }
});

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === adminPassword) {
    // Generate a session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    // In a real app, you'd store this in a database with expiration
    // For now, we'll just return success
    res.json({ success: true, token: sessionToken });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === adminPassword) {
    // Generate a session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    // In a real app, you'd store this in a database with expiration
    // For now, we'll just return success
    res.json({ success: true, token: sessionToken });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Debug endpoint to check recent file uploads and their URLs
// ==================== ADMIN SETTINGS API ====================
// Get admin settings (bio, name, title)
app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_value;
    });
    res.json(settings);
  } catch (err) {
    res.json({ admin_bio: '', admin_name: 'Aaliya', admin_title: 'Founder & Lead Instructor' });
  }
});

// Update admin settings
app.put('/api/admin/settings', async (req, res) => {
  const { admin_bio, admin_name, admin_title } = req.body;
  try {
    if (admin_bio !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_bio', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_bio]);
    }
    if (admin_name !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_name', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_name]);
    }
    if (admin_title !== undefined) {
      await pool.query(`
        INSERT INTO admin_settings (setting_key, setting_value, updated_at)
        VALUES ('admin_title', $1, CURRENT_TIMESTAMP)
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP
      `, [admin_title]);
    }
    res.json({ success: true, message: 'Settings updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DATABASE BACKUP ENDPOINT ====================
// Export all data as SQL for migration
app.post('/api/backup/export', async (req, res) => {
  try {
    // Verify admin password from request body for security
    const adminPass = req.body.pass;
    if (adminPass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let sql = '-- Fluent Feathers LMS Database Backup\n';
    sql += '-- Generated: ' + new Date().toISOString() + '\n\n';

    // Get all tables
    const tables = ['students', 'groups', 'sessions', 'materials', 'badges', 'assessments', 'announcements', 'events', 'event_registrations', 'email_log', 'class_feedback'];

    for (const table of tables) {
      try {
        const result = await pool.query(`SELECT * FROM ${table}`);

        if (result.rows.length > 0) {
          sql += `-- Table: ${table}\n`;
          sql += `DELETE FROM ${table};\n`;

          for (const row of result.rows) {
            const columns = Object.keys(row).join(', ');
            const values = Object.values(row).map(val => {
              if (val === null) return 'NULL';
              if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
              if (typeof val === 'number') return val;
              if (val instanceof Date) return `'${val.toISOString()}'`;
              // Escape single quotes in strings
              return `'${String(val).replace(/'/g, "''")}'`;
            }).join(', ');

            sql += `INSERT INTO ${table} (${columns}) VALUES (${values});\n`;
          }
          sql += '\n';
        }
      } catch (tableErr) {
        sql += `-- Table ${table} not found or error: ${tableErr.message}\n\n`;
      }
    }

    // Reset sequences for auto-increment IDs
    sql += '-- Reset sequences\n';
    for (const table of tables) {
      sql += `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true);\n`;
    }

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename=fluentfeathers_backup_' + new Date().toISOString().split('T')[0] + '.sql');
    res.send(sql);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SECURITY HELPERS ====================
function generateAdminToken(studentId) {
  const payload = `${studentId}:${Date.now()}`;
  const signature = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

function verifyAdminToken(token) {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return null;
    const [studentId, timestamp, signature] = parts;
    if (!studentId || !timestamp || !signature) return null;
    const payload = `${studentId}:${timestamp}`;
    const expected = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('hex');
    if (expected !== signature) return null;
    if (Date.now() - Number(timestamp) > 10 * 60 * 1000) return null;
    return studentId;
  } catch { return null; }
}

function verifyParentAccess(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return next();
  const studentId = verifyAdminToken(token);
  if (!studentId) return res.status(403).json({ error: 'Invalid or expired admin access token' });
  req.adminStudentId = studentId;
  next();
}

app.use('/api/parent', verifyParentAccess);
app.use('/api/sessions', verifyParentAccess);
app.use('/api/upload', verifyParentAccess);
app.use('/api/events', verifyParentAccess);

// Protect admin-only endpoints: only allow requests from same origin (not external)
function requireSameOrigin(req, res, next) {
  const referer = req.headers.referer || req.headers.origin || '';
  const host = req.headers.host || '';
  // Allow if referer matches host, or if no referer (same-site browser requests)
  if (!referer || referer.includes(host) || referer.includes('localhost') || referer.includes('127.0.0.1')) {
    return next();
  }
  return res.status(403).json({ error: 'Access denied' });
}
app.use('/api/admin', requireSameOrigin);

// ==================== DATABASE INITIALIZATION ====================
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🔧 Checking database tables...');

    // Check if tables already exist
    const checkTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'students'
      );
    `);

    if (checkTable.rows[0].exists) {
      console.log('✅ Database tables already exist. Skipping initialization to preserve data.');
      await client.query('COMMIT');
      return;
    }

    console.log('🔧 Creating new database tables...');

    // 1. Create Tables with ALL required columns from the start
    console.log('🔧 Creating students table...');
    await client.query(`
      CREATE TABLE students (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        grade TEXT NOT NULL,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        primary_contact TEXT,
        alternate_contact TEXT,
        timezone TEXT DEFAULT 'Asia/Kolkata',
        parent_timezone TEXT DEFAULT 'Asia/Kolkata',
        program_name TEXT,
        class_type TEXT,
        duration TEXT,
        currency TEXT DEFAULT '₹',
        per_session_fee DECIMAL(10,2),
        total_sessions INTEGER DEFAULT 0,
        completed_sessions INTEGER DEFAULT 0,
        remaining_sessions INTEGER DEFAULT 0,
        fees_paid DECIMAL(10,2) DEFAULT 0,
        group_id INTEGER,
        group_name TEXT,
        date_of_birth DATE,
        payment_method TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating groups table...');
    await client.query(`
      CREATE TABLE groups (
        id SERIAL PRIMARY KEY,
        group_name TEXT NOT NULL,
        program_name TEXT NOT NULL,
        duration TEXT NOT NULL,
        timezone TEXT DEFAULT 'Asia/Kolkata',
        max_students INTEGER DEFAULT 10,
        current_students INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating sessions table...');
    await client.query(`
      CREATE TABLE sessions (
        id SERIAL PRIMARY KEY,
        student_id INTEGER,
        group_id INTEGER,
        session_type TEXT DEFAULT 'Private',
        session_number INTEGER NOT NULL,
        session_date DATE NOT NULL,
        session_time TIME NOT NULL,
        status TEXT DEFAULT 'Pending',
        attendance TEXT,
        cancelled_by TEXT,
        class_link TEXT,
        teacher_notes TEXT,
        ppt_file_path TEXT,
        recording_file_path TEXT,
        homework_file_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating session_attendance table...');
    await client.query(`
      CREATE TABLE session_attendance (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        attendance TEXT DEFAULT 'Pending',
        homework_grade TEXT,
        homework_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(session_id, student_id)
      )
    `);

    console.log('🔧 Creating materials table...');
    await client.query(`
      CREATE TABLE materials (
        id SERIAL PRIMARY KEY,
        student_id INTEGER,
        group_id INTEGER,
        session_id INTEGER,
        session_date DATE NOT NULL,
        file_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        feedback_grade TEXT,
        feedback_comments TEXT,
        feedback_given INTEGER DEFAULT 0,
        feedback_date TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating makeup_classes table...');
    await client.query(`
      CREATE TABLE makeup_classes (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        original_session_id INTEGER,
        reason TEXT NOT NULL,
        credit_date DATE NOT NULL,
        status TEXT DEFAULT 'Available',
        used_date DATE,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating payment_history table...');
    await client.query(`
      CREATE TABLE payment_history (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        payment_date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        receipt_number TEXT,
        sessions_covered TEXT,
        payment_status TEXT DEFAULT 'Paid',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating events table...');
    await client.query(`
      CREATE TABLE events (
        id SERIAL PRIMARY KEY,
        event_name TEXT NOT NULL,
        event_description TEXT,
        event_date DATE NOT NULL,
        event_time TIME NOT NULL,
        event_duration TEXT,
        target_audience TEXT DEFAULT 'All',
        specific_grades TEXT,
        class_link TEXT,
        max_participants INTEGER,
        current_participants INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating event_registrations table...');
    await client.query(`
      CREATE TABLE event_registrations (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        registration_method TEXT DEFAULT 'Parent',
        attendance TEXT DEFAULT 'Pending',
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(event_id, student_id)
      )
    `);

    console.log('🔧 Creating email_log table...');
    await client.query(`
      CREATE TABLE email_log (
        id SERIAL PRIMARY KEY,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        email_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating demo_leads table...');
    await client.query(`
      CREATE TABLE demo_leads (
        id SERIAL PRIMARY KEY,
        child_name TEXT NOT NULL,
        child_grade TEXT,
        parent_name TEXT NOT NULL,
        parent_email TEXT NOT NULL,
        phone TEXT,
        program_interest TEXT,
        demo_date DATE,
        demo_time TIME,
        student_timezone TEXT DEFAULT 'Asia/Kolkata',
        parent_timezone TEXT DEFAULT 'Asia/Kolkata',
        source TEXT,
        notes TEXT,
        status TEXT DEFAULT 'Scheduled',
        converted_student_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating parent_credentials table...');
    await client.query(`
      CREATE TABLE parent_credentials (
        id SERIAL PRIMARY KEY,
        parent_email TEXT UNIQUE NOT NULL,
        password TEXT,
        otp TEXT,
        otp_expiry TIMESTAMP,
        otp_attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    console.log('🔧 Creating class_feedback table...');
    await client.query(`
      CREATE TABLE class_feedback (
        id SERIAL PRIMARY KEY,
        session_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        feedback_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        UNIQUE(session_id, student_id)
      )
    `);

    console.log('🔧 Creating student_badges table...');
    await client.query(`
      CREATE TABLE student_badges (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        badge_type TEXT NOT NULL,
        badge_name TEXT NOT NULL,
        badge_description TEXT,
        earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating payment_renewals table...');
    await client.query(`
      CREATE TABLE payment_renewals (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        renewal_date DATE NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT NOT NULL,
        sessions_added INTEGER NOT NULL,
        payment_method TEXT,
        notes TEXT,
        status TEXT DEFAULT 'Paid',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating announcements table...');
    await client.query(`
      CREATE TABLE announcements (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        announcement_type TEXT DEFAULT 'General',
        priority TEXT DEFAULT 'Normal',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('🔧 Creating student_certificates table...');
    await client.query(`
      CREATE TABLE student_certificates (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        certificate_type TEXT NOT NULL,
        award_title TEXT NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        issued_date DATE DEFAULT CURRENT_DATE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating monthly_assessments table...');
    await client.query(`
      CREATE TABLE monthly_assessments (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        month INTEGER NOT NULL,
        year INTEGER NOT NULL,
        skills TEXT,
        certificate_title TEXT,
        performance_summary TEXT,
        areas_of_improvement TEXT,
        teacher_comments TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    console.log('🔧 Creating expenses table...');
    await client.query(`
      CREATE TABLE expenses (
        id SERIAL PRIMARY KEY,
        expense_date DATE NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        currency TEXT DEFAULT 'INR',
        payment_method TEXT,
        receipt_url TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    console.log('🔧 Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_students_email ON students(parent_email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_student ON class_feedback(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_badges_student ON student_badges(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_certificates_student ON student_certificates(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_students_birthday ON students(date_of_birth)');

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully with all tables and columns');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization error:', err);
    throw err;
  } finally {
    client.release();
  }
}
// ==================== DATABASE MIGRATION ====================
async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('🔧 Running database migrations...');

    // Migration 1: Add date_of_birth to students
    try {
      await client.query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS date_of_birth DATE;
      `);
      console.log('✅ Added date_of_birth column');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️  date_of_birth column already exists');
      } else {
        console.error('❌ Error adding date_of_birth:', err.message);
      }
    }

    // Migration 2: Add payment_method to students
    try {
      await client.query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS payment_method TEXT;
      `);
      console.log('✅ Added payment_method column');
    } catch (err) {
      if (err.code === '42701') {
        console.log('ℹ️  payment_method column already exists');
      } else {
        console.error('❌ Error adding payment_method:', err.message);
      }
    }

    // Migration 3: Ensure announcements table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS announcements (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          announcement_type TEXT DEFAULT 'General',
          priority TEXT DEFAULT 'Normal',
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Announcements table checked/created');
    } catch (err) {
      console.error('❌ Error with announcements table:', err.message);
    }

    // Migration 4: Ensure student_certificates table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_certificates (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          certificate_type TEXT NOT NULL,
          award_title TEXT NOT NULL,
          month INTEGER NOT NULL,
          year INTEGER NOT NULL,
          issued_date DATE DEFAULT CURRENT_DATE,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Student certificates table checked/created');
    } catch (err) {
      console.error('❌ Error with certificates table:', err.message);
    }

    // Migration 5: Ensure monthly_assessments table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS monthly_assessments (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          month INTEGER NOT NULL,
          year INTEGER NOT NULL,
          skills TEXT,
          certificate_title TEXT,
          performance_summary TEXT,
          areas_of_improvement TEXT,
          teacher_comments TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Monthly assessments table checked/created');
    } catch (err) {
      console.error('❌ Error with assessments table:', err.message);
    }

    // Migration 6: Ensure student_badges table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_badges (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          badge_type TEXT NOT NULL,
          badge_name TEXT NOT NULL,
          badge_description TEXT,
          earned_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_badges_student ON student_badges(student_id)');
      console.log('✅ Student badges table checked/created');
    } catch (err) {
      console.error('❌ Error with badges table:', err.message);
    }

    // Migration 7: Ensure class_feedback table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS class_feedback (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL,
          student_id INTEGER NOT NULL,
          rating INTEGER CHECK (rating >= 1 AND rating <= 5),
          feedback_text TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_session ON class_feedback(session_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_student ON class_feedback(student_id)');
      // Add unique constraint for session_id + student_id
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique ON class_feedback(session_id, student_id)');
      console.log('✅ Class feedback table checked/created');
    } catch (err) {
      console.error('❌ Error with class_feedback table:', err.message);
    }

    // Migration 8: Ensure payment_renewals table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS payment_renewals (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          renewal_date DATE NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          currency TEXT NOT NULL,
          sessions_added INTEGER NOT NULL,
          payment_method TEXT,
          notes TEXT,
          status TEXT DEFAULT 'Paid',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Payment renewals table checked/created');
    } catch (err) {
      console.error('❌ Error with payment_renewals table:', err.message);
    }

    // Migration 9: Ensure demo_leads table exists
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS demo_leads (
          id SERIAL PRIMARY KEY,
          child_name TEXT NOT NULL,
          child_grade TEXT,
          parent_name TEXT NOT NULL,
          parent_email TEXT NOT NULL,
          phone TEXT,
          program_interest TEXT,
          demo_date DATE,
          demo_time TIME,
          student_timezone TEXT DEFAULT 'Asia/Kolkata',
          parent_timezone TEXT DEFAULT 'Asia/Kolkata',
          source TEXT,
          notes TEXT,
          status TEXT DEFAULT 'Scheduled',
          converted_student_id INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Demo leads table checked/created');
    } catch (err) {
      console.error('❌ Error with demo_leads table:', err.message);
    }

    // Migration 10: Weekly challenges table
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS weekly_challenges (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          challenge_type TEXT DEFAULT 'General',
          points INTEGER DEFAULT 10,
          week_start DATE NOT NULL,
          week_end DATE NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS student_challenges (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          challenge_id INTEGER NOT NULL,
          status TEXT DEFAULT 'Assigned',
          completed_at TIMESTAMP,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
          FOREIGN KEY (challenge_id) REFERENCES weekly_challenges(id) ON DELETE CASCADE
        );
      `);
      console.log('✅ Weekly challenges tables checked/created');
    } catch (err) {
      console.error('❌ Error with weekly_challenges tables:', err.message);
    }

    // Migration 11: Parent expectations column
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_expectations TEXT`);
      // Add badge_reward column to weekly_challenges
      await client.query(`ALTER TABLE weekly_challenges ADD COLUMN IF NOT EXISTS badge_reward TEXT DEFAULT '🎯 Challenge Champion'`);
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS renewal_reminder_sent BOOLEAN DEFAULT false`);
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS last_reminder_remaining INTEGER`);
      // Add class_link column to students table
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS class_link TEXT`);
      console.log('✅ Parent expectations, renewal reminder & class_link columns added');
    } catch (err) {
      console.error('❌ Error adding columns:', err.message);
    }

    // Migration 12: Session materials table for multiple files
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS session_materials (
          id SERIAL PRIMARY KEY,
          session_id INTEGER NOT NULL,
          material_type TEXT NOT NULL,
          file_name TEXT,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);
      console.log('✅ Session materials table created');
    } catch (err) {
      console.error('❌ Error creating session_materials table:', err.message);
    }

    // Migration 13: Add columns to makeup_classes for tracking scheduled makeup sessions
    try {
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_session_id INTEGER REFERENCES sessions(id)`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS added_by TEXT DEFAULT 'system'`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_date DATE`);
      await client.query(`ALTER TABLE makeup_classes ADD COLUMN IF NOT EXISTS scheduled_time TIME`);
      console.log('✅ Makeup classes columns added for tracking');
    } catch (err) {
      console.error('❌ Error adding makeup_classes columns:', err.message);
    }

    // Migration 14: Resource Library table
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS resource_library (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          category TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          file_path TEXT,
          external_link TEXT,
          thumbnail_url TEXT,
          grade_level TEXT,
          tags TEXT,
          is_featured BOOLEAN DEFAULT false,
          view_count INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Resource library table created');
    } catch (err) {
      console.error('❌ Error creating resource_library table:', err.message);
    }

    // Migration 15: Add image_url to announcements table
    try {
      await client.query(`ALTER TABLE announcements ADD COLUMN IF NOT EXISTS image_url TEXT`);
      console.log('✅ Announcements image_url column added');
    } catch (err) {
      console.error('❌ Error adding image_url to announcements:', err.message);
    }

    // Migration 16: Admin settings table for bio and other settings
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_settings (
          id SERIAL PRIMARY KEY,
          setting_key TEXT UNIQUE NOT NULL,
          setting_value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Insert default bio if not exists
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_bio', '')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_name', 'Aaliya')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      await client.query(`
        INSERT INTO admin_settings (setting_key, setting_value)
        VALUES ('admin_title', 'Founder & Lead Instructor')
        ON CONFLICT (setting_key) DO NOTHING
      `);
      console.log('✅ Admin settings table created');
    } catch (err) {
      console.error('❌ Error creating admin_settings table:', err.message);
    }

    // Migration 17: Add assessment_type and demo_lead_id columns to monthly_assessments
    try {
      // Add assessment_type column (default 'monthly' for backwards compatibility)
      await client.query(`
        ALTER TABLE monthly_assessments
        ADD COLUMN IF NOT EXISTS assessment_type TEXT DEFAULT 'monthly'
      `);
      // Add demo_lead_id for demo assessments
      await client.query(`
        ALTER TABLE monthly_assessments
        ADD COLUMN IF NOT EXISTS demo_lead_id INTEGER REFERENCES demo_leads(id) ON DELETE SET NULL
      `);
      console.log('✅ Migration 17: Assessment type and demo_lead_id columns added');
    } catch (err) {
      console.error('❌ Migration 17 error:', err.message);
    }

    // Migration 18: Allow NULL student_id for demo assessments
    try {
      await client.query(`
        ALTER TABLE monthly_assessments
        ALTER COLUMN student_id DROP NOT NULL
      `);
      console.log('✅ Migration 18: student_id now allows NULL for demo assessments');
    } catch (err) {
      // Ignore if already nullable or other issues
      console.log('Migration 18 note:', err.message);
    }

    // Migration 19: Allow NULL month/year for demo assessments
    try {
      await client.query(`ALTER TABLE monthly_assessments ALTER COLUMN month DROP NOT NULL`);
      await client.query(`ALTER TABLE monthly_assessments ALTER COLUMN year DROP NOT NULL`);
      console.log('✅ Migration 19: month/year now allow NULL for demo assessments');
    } catch (err) {
      console.log('Migration 19 note:', err.message);
    }

    // Migration 20: Add missed_sessions column to students table
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS missed_sessions INTEGER DEFAULT 0`);
      console.log('✅ Migration 20: Added missed_sessions column to students');
    } catch (err) {
      console.log('Migration 20 note:', err.message);
    }

    // Migration 21: Create expenses table for financial tracking
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          expense_date DATE NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          currency TEXT DEFAULT 'INR',
          payment_method TEXT,
          receipt_url TEXT,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('✅ Migration 21: Created expenses table');
    } catch (err) {
      console.log('Migration 21 note:', err.message);
    }

    // Migration 22: One-time sync of existing student payments to payment_history (only runs if table is empty)
    try {
      const existingPayments = await client.query('SELECT COUNT(*) as count FROM payment_history');
      if (parseInt(existingPayments.rows[0].count) === 0) {
        // Table is empty - this is a fresh setup, sync existing students
        const students = await client.query(`
          SELECT id, name, fees_paid, currency, total_sessions, created_at
          FROM students
          WHERE fees_paid > 0
        `);

        let synced = 0;
        for (const student of students.rows) {
          await client.query(`
            INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
            VALUES ($1, $2, $3, $4, 'Bank Transfer', $5, 'Initial enrollment payment', 'completed')
          `, [student.id, student.created_at || new Date(), student.fees_paid, student.currency || 'INR', student.total_sessions || '']);
          synced++;
        }
        console.log(`✅ Migration 22: Synced ${synced} existing student payments to payment_history`);
      } else {
        console.log('✅ Migration 22: Payment history already has data, skipping sync');
      }
    } catch (err) {
      console.log('Migration 22 note:', err.message);
    }

    // Migration 23: Extend event_registrations for public registrations (Instagram/external)
    try {
      // Make student_id nullable for public registrations
      await client.query(`ALTER TABLE event_registrations ALTER COLUMN student_id DROP NOT NULL`);
      // Add fields for public registrations
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS parent_name TEXT`);
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS child_name TEXT`);
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS child_age TEXT`);
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS email TEXT`);
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS phone TEXT`);
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS registration_source TEXT DEFAULT 'internal'`);
      console.log('✅ Migration 23: Extended event_registrations for public registrations');
    } catch (err) {
      console.log('Migration 23 note:', err.message);
    }

    // Migration 24: Add certificate_sent to event_registrations for participation certificates
    try {
      await client.query(`ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS certificate_sent BOOLEAN DEFAULT FALSE`);
      console.log('✅ Migration 24: Added certificate_sent to event_registrations');
    } catch (err) {
      console.log('Migration 24 note:', err.message);
    }

    // Migration 25: Add file upload columns to student_challenges for challenge submissions
    try {
      await client.query(`ALTER TABLE student_challenges ADD COLUMN IF NOT EXISTS submission_file_path TEXT`);
      await client.query(`ALTER TABLE student_challenges ADD COLUMN IF NOT EXISTS submission_file_name TEXT`);
      console.log('✅ Migration 25: Added submission file columns to student_challenges');
    } catch (err) {
      console.log('Migration 25 note:', err.message);
    }

    // Migration 26: Add unique constraint on student_challenges(student_id, challenge_id)
    try {
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS student_challenges_student_challenge_unique ON student_challenges (student_id, challenge_id)`);
      console.log('✅ Migration 26: Added unique constraint on student_challenges');
    } catch (err) {
      console.log('Migration 26 note:', err.message);
    }

    // Migration 27: Add email_body column to email_log for storing full email content
    try {
      await client.query(`ALTER TABLE email_log ADD COLUMN IF NOT EXISTS email_body TEXT`);
      console.log('✅ Migration 27: Added email_body column to email_log');
    } catch (err) {
      console.log('Migration 27 note:', err.message);
    }

    // Migration 28: Add corrected_file_path column to materials for annotated homework
    try {
      await client.query(`ALTER TABLE materials ADD COLUMN IF NOT EXISTS corrected_file_path TEXT`);
      console.log('✅ Migration 28: Added corrected_file_path column to materials');
    } catch (err) {
      console.log('Migration 28 note:', err.message);
    }

    // Migration 29: Enable Row Level Security on all tables (fixes Supabase security warning)
    try {
      const tables = ['groups', 'group_timings', 'students', 'sessions', 'session_attendance', 'materials', 'events', 'event_registrations', 'email_log', 'announcements', 'parent_credentials', 'class_feedback', 'student_badges', 'monthly_assessments', 'student_certificates', 'payment_history', 'payment_renewals', 'makeup_classes', 'demo_leads', 'weekly_challenges', 'student_challenges', 'session_materials', 'admin_settings', 'expenses', 'resource_library', 'class_points'];
      for (const table of tables) {
        try {
          await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
          await client.query(`DO $$ BEGIN CREATE POLICY "Allow all for service role" ON ${table} FOR ALL USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        } catch (e) { /* table may not exist yet */ }
      }
      console.log('✅ Migration 29: Enabled RLS on all tables');
    } catch (err) {
      console.log('Migration 29 note:', err.message);
    }

    // Migration 30: Add last_reminder_remaining column for renewal reminders
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS last_reminder_remaining INTEGER`);
      console.log('✅ Migration 30: Added last_reminder_remaining column');
    } catch (err) {
      console.log('Migration 30 note:', err.message);
    }

    // Migration 31: Add performance indexes on frequently queried columns
    try {
      await client.query('CREATE INDEX IF NOT EXISTS idx_session_attendance_student_id ON session_attendance(student_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_session_attendance_session_id ON session_attendance(session_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_students_group_id ON students(group_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_students_parent_email ON students(parent_email)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_payment_history_student_id ON payment_history(student_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_student_id ON sessions(student_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_session_date ON sessions(session_date)');
      console.log('✅ Migration 31: Added performance indexes');
    } catch (err) {
      console.log('Migration 31 note:', err.message);
    }

    // Migration 32: Add notes column to sessions table
    try {
      await client.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notes TEXT');
      console.log('✅ Migration 32: Added notes column to sessions');
    } catch (err) {
      console.log('Migration 32 note:', err.message);
    }

    // Migration 33: Clean up duplicate payment_history entries created by old renewal code
    try {
      const dupes = await client.query(`
        DELETE FROM payment_history WHERE id IN (
          SELECT ph.id FROM payment_history ph
          INNER JOIN payment_renewals pr
            ON ph.student_id = pr.student_id
            AND ph.amount = pr.amount
            AND ph.payment_date = pr.renewal_date
            AND ph.notes LIKE 'Renewal%'
        ) RETURNING student_id, amount
      `);
      if (dupes.rows.length > 0) {
        // Recalculate fees_paid for affected students from payment_history + payment_renewals
        const affectedStudents = [...new Set(dupes.rows.map(r => r.student_id))];
        for (const sid of affectedStudents) {
          await client.query(`
            UPDATE students SET fees_paid = COALESCE((
              SELECT SUM(amount) FROM payment_history WHERE student_id = $1
            ), 0) + COALESCE((
              SELECT SUM(amount) FROM payment_renewals WHERE student_id = $1
            ), 0)
            WHERE id = $1
          `, [sid]);
        }
        console.log(`✅ Migration 33: Cleaned up ${dupes.rows.length} duplicate payment_history entries, recalculated fees for ${affectedStudents.length} students`);
      } else {
        console.log('✅ Migration 33: No duplicate payment_history entries found');
      }
    } catch (err) {
      console.log('Migration 33 note:', err.message);
    }

    // Migration 34: Add student_id column to email_log table
    try {
      await client.query('ALTER TABLE email_log ADD COLUMN IF NOT EXISTS student_id INTEGER');
      console.log('✅ Migration 34: Added student_id column to email_log');
    } catch (err) {
      console.log('Migration 34 note:', err.message);
    }

    // Migration 35: Fix currency symbols to currency codes in all tables
    try {
      const currencyMap = [
        ['₹', 'INR'], ['$', 'USD'], ['£', 'GBP'], ['€', 'EUR']
      ];
      let fixed = 0;
      for (const [symbol, code] of currencyMap) {
        const r1 = await client.query('UPDATE students SET currency = $2 WHERE currency = $1', [symbol, code]);
        const r2 = await client.query('UPDATE payment_history SET currency = $2 WHERE currency = $1', [symbol, code]);
        const r3 = await client.query('UPDATE payment_renewals SET currency = $2 WHERE currency = $1', [symbol, code]);
        fixed += r1.rowCount + r2.rowCount + r3.rowCount;
      }
      console.log(`✅ Migration 35: Fixed ${fixed} currency symbol records to currency codes`);
    } catch (err) {
      console.log('Migration 35 note:', err.message);
    }

    // Migration 36: Add parent/student timezone columns for localized demo and portal views
    try {
      await client.query("ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_timezone TEXT DEFAULT 'Asia/Kolkata'");
      await client.query("UPDATE students SET parent_timezone = COALESCE(parent_timezone, timezone, 'Asia/Kolkata') WHERE parent_timezone IS NULL");
      await client.query("ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS student_timezone TEXT DEFAULT 'Asia/Kolkata'");
      await client.query("ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS parent_timezone TEXT DEFAULT 'Asia/Kolkata'");
      await client.query("UPDATE demo_leads SET student_timezone = COALESCE(student_timezone, 'Asia/Kolkata') WHERE student_timezone IS NULL");
      await client.query("UPDATE demo_leads SET parent_timezone = COALESCE(parent_timezone, student_timezone, 'Asia/Kolkata') WHERE parent_timezone IS NULL");
      console.log('✅ Migration 36: Added parent/student timezone columns');
    } catch (err) {
      console.log('Migration 36 note:', err.message);
    }

    // Migration 37: Add parent timezone to event_registrations for localized public event emails/reminders
    try {
      await client.query("ALTER TABLE event_registrations ADD COLUMN IF NOT EXISTS parent_timezone TEXT DEFAULT 'Asia/Kolkata'");
      await client.query("UPDATE event_registrations SET parent_timezone = 'Asia/Kolkata' WHERE parent_timezone IS NULL");
      console.log('✅ Migration 37: Added parent_timezone to event_registrations');
    } catch (err) {
      console.log('Migration 37 note:', err.message);
    }

    // Migration 38: Add composite indexes for upcoming/past classes and parent portal session speed
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_type_status_date_time ON sessions(session_type, status, session_date, session_time)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_student_type_date_time ON sessions(student_id, session_type, session_date, session_time)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_group_type_date_time ON sessions(group_id, session_type, session_date, session_time)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_session_attendance_student_session ON session_attendance(student_id, session_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_events_status_date_time ON events(status, event_date, event_time)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_demo_leads_status_date_time ON demo_leads(status, demo_date, demo_time)`);
      console.log('✅ Migration 38: Added composite performance indexes for class loading');
    } catch (err) {
      console.log('Migration 38 note:', err.message);
    }

    // Migration 39: Add timezone to parent_credentials and backfill from students
    try {
      await client.query(`ALTER TABLE parent_credentials ADD COLUMN IF NOT EXISTS timezone TEXT`);
      await client.query(`
        UPDATE parent_credentials pc
        SET timezone = s.parent_timezone
        FROM (
          SELECT DISTINCT ON (LOWER(parent_email)) LOWER(parent_email) AS email_key, parent_timezone
          FROM students
          WHERE parent_email IS NOT NULL
            AND parent_timezone IS NOT NULL
            AND parent_timezone <> ''
          ORDER BY LOWER(parent_email), created_at DESC
        ) s
        WHERE LOWER(pc.parent_email) = s.email_key
          AND (
            pc.timezone IS NULL
            OR pc.timezone = ''
            OR pc.timezone = 'Asia/Kolkata'
          )
      `);
      console.log('✅ Migration 39: Added parent_credentials.timezone and backfilled values');
    } catch (err) {
      console.log('Migration 39 note:', err.message);
    }

    // Migration 40: Add type column to demo_leads for summer camp
    try {
      await client.query(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'demo'`);
      await client.query(`UPDATE demo_leads SET type = 'demo' WHERE type IS NULL`);
      console.log('✅ Migration 40: Added type column to demo_leads');
    } catch (err) {
      console.log('Migration 40 note:', err.message);
    }

    // Migration 40: Add session_topic column to sessions table
    try {
      await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_topic TEXT`);
      console.log('✅ Migration 40: Added session_topic column to sessions');
    } catch (err) {
      console.log('Migration 40 note:', err.message);
    }

    // Migration 41: Create class_points table for live in-class point tracking
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS class_points (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL,
          session_id INTEGER,
          points INTEGER NOT NULL DEFAULT 1,
          reason TEXT DEFAULT 'Good work!',
          awarded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_class_points_student ON class_points(student_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_class_points_session ON class_points(session_id)`);
      console.log('✅ Migration 41: Created class_points table for live class point tracking');
    } catch (err) {
      console.log('Migration 41 note:', err.message);
    }

    // Migration 42: Add class_link to sessions table (was zoom_link in older schema)
    try {
      await client.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS class_link TEXT`);
      // Backfill class_link from zoom_link if zoom_link exists
      await client.query(`UPDATE sessions SET class_link = zoom_link WHERE class_link IS NULL AND zoom_link IS NOT NULL`).catch(() => {});
      console.log('✅ Migration 42: Added class_link column to sessions');
    } catch (err) {
      console.log('Migration 42 note:', err.message);
    }

    // Migration 43: One-time fix - increment remaining_sessions for existing students who have
    // upcoming scheduled makeup classes that were scheduled before the fix (remaining was never incremented)
    try {
      const fixResult = await client.query(`
        UPDATE students s
        SET remaining_sessions = remaining_sessions + sub.makeup_pending
        FROM (
          SELECT sess.student_id, COUNT(*) AS makeup_pending
          FROM sessions sess
          INNER JOIN makeup_classes mc ON mc.scheduled_session_id = sess.id AND mc.status = 'Scheduled'
          WHERE sess.notes = 'Makeup Class'
            AND sess.status IN ('Scheduled', 'Pending')
            AND sess.session_date >= CURRENT_DATE
          GROUP BY sess.student_id
        ) sub
        WHERE s.id = sub.student_id
        RETURNING s.id, s.name, sub.makeup_pending
      `);
      if (fixResult.rows.length > 0) {
        fixResult.rows.forEach(r => console.log(`  ✅ ${r.name}: remaining_sessions +${r.makeup_pending} (makeup backfill)`));
        console.log(`✅ Migration 43: Fixed remaining_sessions for ${fixResult.rows.length} student(s) with existing scheduled makeup classes`);
      } else {
        console.log('✅ Migration 43: No students needed remaining_sessions makeup backfill');
      }
    } catch (err) {
      console.log('Migration 43 note:', err.message);
    }

    // Migration 44A: Create short birthday card links table
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS birthday_cards (
          id SERIAL PRIMARY KEY,
          code TEXT UNIQUE NOT NULL,
          student_name TEXT NOT NULL,
          age INTEGER NOT NULL,
          wish_message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_birthday_cards_code ON birthday_cards(code)`);
      console.log('✅ Migration 44A: Created birthday_cards table');
    } catch (err) {
      console.log('Migration 44A note:', err.message);
    }

    // Migration 44: Add skill_ratings and deferred columns to monthly_assessments
    try {
      await client.query(`ALTER TABLE monthly_assessments ADD COLUMN IF NOT EXISTS skill_ratings TEXT`);
      await client.query(`ALTER TABLE monthly_assessments ADD COLUMN IF NOT EXISTS deferred BOOLEAN DEFAULT FALSE`);
      console.log('✅ Migration 44: Added skill_ratings and deferred columns to monthly_assessments');
    } catch (err) {
      console.log('Migration 44 note:', err.message);
    }

    // Migration 45: Track when challenges were submitted by parents
    try {
      await client.query(`ALTER TABLE student_challenges ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP`);
      console.log('✅ Migration 45: Added submitted_at to student_challenges');
    } catch (err) {
      console.log('Migration 45 note:', err.message);
    }

    // Migration 46: Harden RLS policies across all public tables
    try {
      const { rows: publicTables } = await client.query(`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `);
      for (const { tablename } of publicTables) {
        try {
          const safeTable = `"${tablename.replace(/"/g, '""')}"`;
          await client.query(`ALTER TABLE ${safeTable} ENABLE ROW LEVEL SECURITY`);
          await client.query(`DROP POLICY IF EXISTS "Allow all for service role" ON ${safeTable}`);
          await client.query(`DROP POLICY IF EXISTS "Service role full access" ON ${safeTable}`);
          await client.query(`DROP POLICY IF EXISTS "Service role only" ON ${safeTable}`);
          await client.query(`CREATE POLICY "Service role only" ON ${safeTable} FOR ALL TO service_role USING (true) WITH CHECK (true)`);
        } catch (e) { /* table may not exist yet */ }
      }
      console.log(`✅ Migration 46: Hardened RLS policies for ${publicTables.length} public table(s)`);
    } catch (err) {
      console.log('Migration 46 note:', err.message);
    }

    // Migration 47: Add is_summer_camp column to students table
    try {
      await client.query(`
        ALTER TABLE students ADD COLUMN IF NOT EXISTS is_summer_camp BOOLEAN DEFAULT false
      `);
      console.log('✅ Migration 47: Added is_summer_camp column to students table');
    } catch (err) {
      console.log('Migration 47 note:', err.message);
    }

    // Migration 48: Ensure push token tables exist for app notifications
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS parent_fcm_tokens (
          id SERIAL PRIMARY KEY,
          parent_email TEXT NOT NULL,
          fcm_token TEXT NOT NULL UNIQUE,
          user_agent TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_fcm_tokens (
          id SERIAL PRIMARY KEY,
          fcm_token TEXT NOT NULL UNIQUE,
          user_agent TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_parent_fcm_tokens_email ON parent_fcm_tokens(LOWER(parent_email))`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_fcm_tokens_updated_at ON admin_fcm_tokens(updated_at)`);
      console.log('✅ Migration 48: Ensured push token tables and indexes');
    } catch (err) {
      console.log('Migration 48 note:', err.message);
    }

    console.log('✅ All database migrations completed successfully!');

    // Auto-sync badges for students who should have them
    try {
      const students = await client.query('SELECT id, completed_sessions FROM students WHERE is_active = true');
      let awarded = 0;

      for (const student of students.rows) {
        const count = student.completed_sessions || 0;
        if (count >= 1) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, 'first_class']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, 'first_class', '🌟 First Class Star', 'Attended first class!']);
            awarded++;
          }
        }
        if (count >= 5) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, '5_classes']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!']);
            awarded++;
          }
        }
        if (count >= 10) {
          const existing = await client.query('SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2', [student.id, '10_classes']);
          if (existing.rows.length === 0) {
            await client.query('INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
              [student.id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!']);
            awarded++;
          }
        }
      }
      if (awarded > 0) console.log(`✅ Auto-synced ${awarded} missing badges`);
    } catch (badgeErr) {
      console.error('Badge sync error:', badgeErr.message);
    }

  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
  }
}
// ==================== HELPERS ====================
function istToUTC(dateStr, timeStr, timezone) {
  try {
    if (!dateStr || !timeStr) throw new Error('Date/Time missing');
    const cleanDate = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    let cleanTime = timeStr.trim();
    if (cleanTime.length === 5) cleanTime += ':00';

    // Default IST path (backward compatible)
    if (!timezone || timezone === 'Asia/Kolkata' || timezone === 'IST') {
      const isoString = `${cleanDate}T${cleanTime}+05:30`;
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return { date: cleanDate, time: cleanTime.substring(0, 5) };
      const utcDate = date.toISOString().split('T')[0];
      const utcTime = date.toISOString().split('T')[1].substring(0, 8);
      return { date: utcDate, time: utcTime };
    }

    // Dynamic timezone conversion for non-IST timezones
    const refUtc = new Date(`${cleanDate}T${cleanTime}Z`);
    const inTz = new Date(refUtc.toLocaleString('en-US', { timeZone: timezone }));
    const inUtc = new Date(refUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = inTz - inUtc;
    const actualUtc = new Date(refUtc.getTime() - offsetMs);
    if (isNaN(actualUtc.getTime())) return { date: cleanDate, time: cleanTime.substring(0, 5) };
    return { date: actualUtc.toISOString().split('T')[0], time: actualUtc.toISOString().split('T')[1].substring(0, 8) };
  } catch (e) { return { date: dateStr, time: timeStr }; }
}

function formatUTCToLocal(utcDateStr, utcTimeStr, timezone) {
  try {
    if (!utcDateStr || !utcTimeStr) {
      console.error('Missing UTC date or time:', utcDateStr, utcTimeStr);
      return { date: 'Invalid Date', time: 'Invalid Time', day: '' };
    }

    // Handle Date objects from PostgreSQL
    let dateInput = utcDateStr;
    if (utcDateStr instanceof Date) {
      dateInput = utcDateStr.toISOString();
    } else if (typeof utcDateStr !== 'string') {
      dateInput = String(utcDateStr);
    }

    const dateStr = dateInput.includes('T') ? dateInput.split('T')[0] : dateInput;
    let timeStr = utcTimeStr.toString().trim();

    // Ensure time is in HH:MM:SS format
    if (timeStr.length === 5) timeStr += ':00';
    else if (timeStr.length === 8) { /* already good */ }
    else timeStr = timeStr.substring(0, 8);

    const isoString = `${dateStr}T${timeStr}Z`;
    const date = new Date(isoString);

    if (isNaN(date.getTime())) {
      console.error('Invalid date created from:', isoString);
      return { date: dateStr, time: timeStr, day: '' };
    }

    const tz = timezone || 'Asia/Kolkata';

    return {
      date: date.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }),
      time: date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }),
      day: date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
    };
  } catch (e) {
    console.error('Error in formatUTCToLocal:', e, 'Date:', utcDateStr, 'Time:', utcTimeStr);
    return { date: utcDateStr, time: utcTimeStr, day: '' };
  }
}

async function renumberPrivateSessionsForStudent(studentId, dbClient = pool) {
  const ordered = await dbClient.query(`
    SELECT id
    FROM sessions
    WHERE student_id = $1 AND session_type = 'Private'
    ORDER BY session_date ASC, session_time ASC, id ASC
  `, [studentId]);

  for (let i = 0; i < ordered.rows.length; i++) {
    await dbClient.query(
      'UPDATE sessions SET session_number = $1 WHERE id = $2',
      [i + 1, ordered.rows[i].id]
    );
  }
}

async function renumberGroupSessionsForGroup(groupId, dbClient = pool) {
  const ordered = await dbClient.query(`
    SELECT id
    FROM sessions
    WHERE group_id = $1 AND session_type = 'Group'
    ORDER BY session_date ASC, session_time ASC, id ASC
  `, [groupId]);

  for (let i = 0; i < ordered.rows.length; i++) {
    await dbClient.query(
      'UPDATE sessions SET session_number = $1 WHERE id = $2',
      [i + 1, ordered.rows[i].id]
    );
  }
}

// Get friendly timezone label from IANA timezone
function getTimezoneLabel(timezone) {
  const tzLabels = {
    // Asia
    'Asia/Kolkata': 'India Time',
    'Asia/Dubai': 'Dubai Time',
    'Asia/Muscat': 'Oman Time',
    'Asia/Riyadh': 'Saudi Time',
    'Asia/Qatar': 'Qatar Time',
    'Asia/Kuwait': 'Kuwait Time',
    'Asia/Bahrain': 'Bahrain Time',
    'Asia/Singapore': 'Singapore Time',
    'Asia/Hong_Kong': 'Hong Kong Time',
    'Asia/Tokyo': 'Tokyo Time',
    'Asia/Seoul': 'Seoul Time',
    'Asia/Shanghai': 'China Time',
    'Asia/Bangkok': 'Bangkok Time',
    'Asia/Jakarta': 'Jakarta Time',
    'Asia/Manila': 'Manila Time',
    'Asia/Karachi': 'Pakistan Time',
    'Asia/Dhaka': 'Bangladesh Time',
    'Asia/Colombo': 'Sri Lanka Time',
    'Asia/Kathmandu': 'Nepal Time',
    'Asia/Tehran': 'Iran Time',
    'Asia/Jerusalem': 'Israel Time',
    // Americas
    'America/New_York': 'New York Time',
    'America/Chicago': 'Chicago Time',
    'America/Denver': 'Denver Time',
    'America/Los_Angeles': 'LA Time',
    'America/Toronto': 'Toronto Time',
    'America/Vancouver': 'Vancouver Time',
    'America/Mexico_City': 'Mexico Time',
    'America/Sao_Paulo': 'Brazil Time',
    'America/Argentina/Buenos_Aires': 'Argentina Time',
    'America/Lima': 'Peru Time',
    'America/Bogota': 'Colombia Time',
    // Europe
    'Europe/London': 'London Time',
    'Europe/Paris': 'Paris Time',
    'Europe/Berlin': 'Berlin Time',
    'Europe/Rome': 'Rome Time',
    'Europe/Madrid': 'Madrid Time',
    'Europe/Amsterdam': 'Amsterdam Time',
    'Europe/Brussels': 'Brussels Time',
    'Europe/Zurich': 'Zurich Time',
    'Europe/Vienna': 'Vienna Time',
    'Europe/Stockholm': 'Stockholm Time',
    'Europe/Oslo': 'Oslo Time',
    'Europe/Copenhagen': 'Copenhagen Time',
    'Europe/Helsinki': 'Helsinki Time',
    'Europe/Athens': 'Athens Time',
    'Europe/Istanbul': 'Istanbul Time',
    'Europe/Moscow': 'Moscow Time',
    'Europe/Warsaw': 'Warsaw Time',
    // Africa
    'Africa/Cairo': 'Cairo Time',
    'Africa/Johannesburg': 'South Africa Time',
    'Africa/Lagos': 'Nigeria Time',
    'Africa/Nairobi': 'Kenya Time',
    'Africa/Casablanca': 'Morocco Time',
    // Oceania
    'Australia/Sydney': 'Sydney Time',
    'Australia/Melbourne': 'Melbourne Time',
    'Australia/Perth': 'Perth Time',
    'Pacific/Auckland': 'Auckland Time',
    'Pacific/Fiji': 'Fiji Time'
  };
  return tzLabels[timezone] || 'Your Local Time';
}

function normalizeTimezone(timezone) {
  try {
    const tz = (timezone || '').toString().trim();
    if (!tz) return null;
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch (_) {
    return null;
  }
}

function pickPreferredTimezone(...timezones) {
  const normalized = timezones
    .map(tz => normalizeTimezone(tz))
    .filter(Boolean);

  // Return the first valid timezone in priority order (no bias against IST).
  // Callers already pass arguments highest-priority first:
  // (parent_timezone, credential_timezone, student timezone, group_timezone)
  return normalized[0] || 'Asia/Kolkata';
}

async function syncParentTimezoneByEmail(email, timezone) {
  try {
    const normalizedTimezone = normalizeTimezone(timezone);
    const normalizedEmail = (email || '').toString().trim().toLowerCase();
    if (!normalizedTimezone || !normalizedEmail) return;

    // Only set timezone if the stored value is not already set (prevent travel/VPN from overwriting the student's home timezone)
    await pool.query(
      `UPDATE students
       SET parent_timezone = $2
       WHERE LOWER(parent_email) = $1
         AND is_active = true
         AND (parent_timezone IS NULL OR TRIM(parent_timezone) = '')`,
      [normalizedEmail, normalizedTimezone]
    );

    await pool.query(
      `UPDATE parent_credentials
       SET timezone = $2
       WHERE LOWER(parent_email) = $1
         AND (timezone IS NULL OR TRIM(timezone) = '')`,
      [normalizedEmail, normalizedTimezone]
    );
  } catch (err) {
    console.warn('Timezone sync warning:', err.message);
  }
}

function stripHtmlSnippet(html, maxLen = 240) {
  if (!html || typeof html !== 'string') return '';
  const t = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

function addInstallAppLinksToPortalEmails(html) {
  if (!html || typeof html !== 'string' || !/href="[^"]*\/parent\.html/i.test(html)) return html;
  const installHref = `${getAppBaseUrl()}/parent.html?install_app=1`;
  const installBtn = `<a href="${installHref}" style="display: inline-block; margin-left: 10px; background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px;">📲 Install App</a>`;

  return html.replace(/(<a\b[^>]*href="[^"]*\/parent\.html(?:\?[^"]*)?"[^>]*>[\s\S]*?<\/a>)/gi, (match) => {
    if (/install_app=1/i.test(match) || /Install App/i.test(match)) return match;
    return `${match}${installBtn}`;
  });
}

async function logPushInEmailLog({ recipientName, recipientEmail, emailType, subject, status, payload }) {
  try {
    await pool.query(
      `INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status, email_body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(recipientName || ''),
        String(recipientEmail || ''),
        String(emailType || 'Push-Notification'),
        String(subject || 'Push Notification'),
        String(status || 'Sent'),
        typeof payload === 'string' ? payload : JSON.stringify(payload || {})
      ]
    );
  } catch (err) {
    console.warn('Push log insert failed:', err.message);
  }
}

function toFcmDataPayload(input = {}) {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
  );
}

function buildWebpushConfig(targetLink, notificationTag, title, body) {
  const baseUrl = getAppBaseUrl().replace(/\/$/, '');
  const iconUrl = `${baseUrl}/app-icon.png`;
  return {
    headers: {
      Urgency: 'high',
      TTL: '86400'
    },
    notification: {
      title,
      body,
      icon: iconUrl,
      badge: iconUrl,
      tag: notificationTag
    },
    fcmOptions: {
      link: targetLink
    }
  };
}

async function sendPushToParentByEmail(parentEmail, title, body, data = {}) {
  try {
    await ensurePushTokenTables();
  } catch (e) {
    console.warn('Push schema ensure failed:', e.message);
    return { sent: 0, reason: 'schema_unavailable' };
  }
  const firebaseMessaging = getFirebaseAdminMessaging();
  const norm = String(parentEmail || '').trim().toLowerCase();
  if (!norm) return { sent: 0, reason: 'invalid_email' };
  let tokens;
  try {
    const r = await pool.query(
      `SELECT fcm_token FROM parent_fcm_tokens WHERE LOWER(parent_email) = $1`,
      [norm]
    );
    tokens = [...new Set(r.rows.map((x) => x.fcm_token).filter(Boolean))];
  } catch (e) {
    console.warn('FCM token lookup:', e.message);
    return { sent: 0, reason: 'lookup_failed' };
  }
  if (tokens.length === 0) return { sent: 0, reason: 'no_tokens' };
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '') || 'https://fluent-feathers-academy-lms.onrender.com';
  const targetLink = String(data.url || data.link || `${appUrl}/parent.html`);
  const safeTitle = String(title || APP_DISPLAY_NAME).slice(0, 200);
  const safeBody = String(body || '').slice(0, 240);
  const notificationTag = String(data.notificationTag || data.type || `${safeTitle}|${safeBody}|${targetLink}`).slice(0, 180);
  const webpushConfig = buildWebpushConfig(targetLink, notificationTag, safeTitle, safeBody);

  if (!firebaseMessaging) {
    const serverKey = process.env.FIREBASE_SERVER_KEY;
    if (!serverKey) return { sent: 0, reason: 'firebase_disabled' };
    try {
      const messageData = Object.fromEntries(
        Object.entries({ ...data, title: safeTitle, body: safeBody, url: targetLink, link: targetLink, click_action: targetLink, notificationTag })
          .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
      );
      const legacyResp = await axios.post('https://fcm.googleapis.com/fcm/send', {
        registration_ids: tokens,
        notification: { title: safeTitle, body: safeBody },
        data: messageData,
        webpush: {
          headers: webpushConfig.headers,
          notification: webpushConfig.notification,
          fcm_options: { link: targetLink }
        }
      }, {
        headers: {
          Authorization: `key ${serverKey}`,
          'Content-Type': 'application/json'
        }
      });

      const results = Array.isArray(legacyResp?.data?.results) ? legacyResp.data.results : [];
      results.forEach((x, i) => {
        if (x && (x.error === 'NotRegistered' || x.error === 'InvalidRegistration')) {
          pool.query('DELETE FROM parent_fcm_tokens WHERE fcm_token = $1', [tokens[i]]).catch(() => {});
        }
      });

      const sent = Number(legacyResp?.data?.success || 0);
      const failed = Number(legacyResp?.data?.failure || Math.max(tokens.length - sent, 0));
      await logPushInEmailLog({
        recipientName: data.parentName || 'Parent',
        recipientEmail: norm,
        emailType: 'Push-Parent',
        subject: `${safeTitle} [PUSH]`,
        status: sent > 0 ? 'Sent' : 'Failed',
        payload: {
          type: data.type || 'parent_push',
          title: safeTitle,
          body: safeBody,
          link: targetLink,
          tokenCount: tokens.length,
          sent,
          failed,
          transport: 'legacy_fcm'
        }
      });
      return { sent, failed };
    } catch (e) {
      console.warn('Legacy FCM send error:', e.message);
      return { sent: 0, reason: 'send_failed' };
    }
  }

  try {
    const messageData = toFcmDataPayload({
      ...data,
      title: safeTitle,
      body: safeBody,
      url: targetLink,
      link: targetLink,
      click_action: targetLink,
      notificationTag
    });
    const resp = await firebaseMessaging.sendEachForMulticast({
      tokens,
      notification: { title: safeTitle, body: safeBody },
      data: messageData,
      webpush: webpushConfig
    });
    resp.responses.forEach((x, i) => {
      if (!x.success && x.error && (x.error.code === 'messaging/registration-token-not-registered' || x.error.code === 'messaging/invalid-registration-token')) {
        pool.query('DELETE FROM parent_fcm_tokens WHERE fcm_token = $1', [tokens[i]]).catch(() => {});
      }
    });
    const sent = resp.successCount || 0;
    const failed = resp.failureCount || 0;
    await logPushInEmailLog({
      recipientName: data.parentName || 'Parent',
      recipientEmail: norm,
      emailType: 'Push-Parent',
      subject: `${safeTitle} [PUSH]`,
      status: sent > 0 ? 'Sent' : 'Failed',
      payload: {
        type: data.type || 'parent_push',
        title: safeTitle,
        body: safeBody,
        link: targetLink,
        tokenCount: tokens.length,
        sent,
        failed
      }
    });
    return { sent, failed };
  } catch (e) {
    console.warn('FCM send error:', e.message);
    await logPushInEmailLog({
      recipientName: data.parentName || 'Parent',
      recipientEmail: norm,
      emailType: 'Push-Parent',
      subject: `${safeTitle} [PUSH]`,
      status: 'Failed',
      payload: {
        type: data.type || 'parent_push',
        title: safeTitle,
        body: safeBody,
        link: targetLink,
        tokenCount: tokens.length,
        reason: 'send_failed',
        error: String(e.message || '')
      }
    });
    return { sent: 0, reason: 'send_failed' };
  }
}

async function notifyParentsTeacherJoinedSession(sessionId) {
  const sid = parseInt(sessionId, 10);
  if (!sid || Number.isNaN(sid)) {
    return { success: false, reason: 'invalid_session' };
  }

  const sessionResult = await pool.query(`
    SELECT s.id, s.session_type, s.session_date, s.session_time, s.status, s.student_id, s.group_id,
           COALESCE(st.duration, g.duration, '40 mins') AS duration,
           st.name AS student_name,
           g.group_name
    FROM sessions s
    LEFT JOIN students st ON s.student_id = st.id
    LEFT JOIN groups g ON s.group_id = g.id
    WHERE s.id = $1
    LIMIT 1
  `, [sid]);

  if (sessionResult.rows.length === 0) {
    return { success: false, reason: 'not_found' };
  }

  const session = sessionResult.rows[0];
  if (String(session.session_type || '').toLowerCase() === 'demo') {
    return { success: false, reason: 'unsupported_session_type' };
  }

  const durationMatch = String(session.duration || '').match(/(\d+)/);
  const durationMins = durationMatch ? parseInt(durationMatch[1], 10) : 40;
  const dateStr = session.session_date instanceof Date
    ? session.session_date.toISOString().split('T')[0]
    : String(session.session_date).split('T')[0];
  const timeStr = String(session.session_time || '00:00:00').substring(0, 8);
  const sessionStart = new Date(`${dateStr}T${timeStr}Z`);
  const sessionEnd = new Date(sessionStart.getTime() + durationMins * 60 * 1000);
  const now = new Date();
  const earlyWindowStart = new Date(sessionStart.getTime() - 5 * 60 * 1000);

  if (now < earlyWindowStart || now > sessionEnd) {
    return { success: false, reason: 'outside_join_window' };
  }

  const sentCheck = await pool.query(
    `SELECT id
     FROM email_log
     WHERE email_type = 'Teacher-Joined-Push'
       AND subject LIKE $1
     LIMIT 1`,
    [`%[SID:${sid}]%`]
  );
  if (sentCheck.rows.length > 0) {
    return { success: true, alreadySent: true, recipients: 0 };
  }

  let recipientRows = [];
  if (session.group_id) {
    const recipients = await pool.query(`
      SELECT DISTINCT ON (LOWER(st.parent_email))
             st.parent_email, st.parent_name, st.name AS student_name
      FROM session_attendance sa
      JOIN students st ON sa.student_id = st.id
      WHERE sa.session_id = $1
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
        AND TRIM(st.parent_email) <> ''
        AND COALESCE(sa.attendance, 'Pending') NOT IN ('Cancelled', 'Cancelled by Parent', 'Excused', 'Unexcused', 'Absent')
      ORDER BY LOWER(st.parent_email), st.id
    `, [sid]);
    recipientRows = recipients.rows;
  } else if (session.student_id) {
    const recipients = await pool.query(`
      SELECT st.parent_email, st.parent_name, st.name AS student_name
      FROM students st
      WHERE st.id = $1
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
        AND TRIM(st.parent_email) <> ''
      LIMIT 1
    `, [session.student_id]);
    recipientRows = recipients.rows;
  }

  if (recipientRows.length === 0) {
    return { success: false, reason: 'no_recipients' };
  }

  const isGroup = !!session.group_id || String(session.session_type || '').toLowerCase() === 'group';
  const title = isGroup
    ? `Teacher joined ${session.group_name || 'the batch'}`
    : 'Teacher has joined the class';
  const body = isGroup
    ? `The teacher has joined ${session.group_name || 'the batch'}. Please join the class now.`
    : `The teacher has joined ${session.student_name || 'your child'}'s class. Please join now.`;
  const joinUrl = getJoinClassUrl(sid);

  const pushResults = await Promise.all(
    recipientRows.map((row) =>
      sendPushToParentByEmail(row.parent_email, title, body, {
        type: 'teacher_joined_session',
        session_id: String(sid),
        session_kind: isGroup ? 'group' : 'private',
        url: joinUrl
      })
    )
  );

  const sentCount = pushResults.reduce((sum, row) => sum + (row?.sent || 0), 0);
  if (sentCount === 0) {
    return { success: false, reason: 'no_active_parent_tokens' };
  }

  await pool.query(
    `INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status, email_body)
     VALUES ($1, $2, $3, $4, 'Sent', $5)`,
    [
      isGroup ? (session.group_name || 'Batch Parents') : (session.student_name || 'Parent'),
      isGroup ? 'group-parent-push' : String(recipientRows[0].parent_email || '').toLowerCase(),
      'Teacher-Joined-Push',
      `${title} [SID:${sid}]`,
      body
    ]
  );

  return { success: true, alreadySent: false, recipients: recipientRows.length, sentCount };
}

async function sendPushToAdmins(title, body, data = {}) {
  try {
    await ensurePushTokenTables();
  } catch (e) {
    console.warn('Push schema ensure failed:', e.message);
    return;
  }
  const firebaseMessaging = getFirebaseAdminMessaging();
  let tokens;
  try {
    const r = await pool.query(`SELECT fcm_token FROM admin_fcm_tokens`);
    tokens = [...new Set(r.rows.map((x) => x.fcm_token).filter(Boolean))];
  } catch (e) {
    console.warn('Admin FCM token lookup:', e.message);
    return;
  }
  if (tokens.length === 0) return;
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '') || 'https://fluent-feathers-academy-lms.onrender.com';
  const targetLink = String(data.url || data.link || `${appUrl}/admin.html`);
  const safeTitle = String(title || APP_DISPLAY_NAME).slice(0, 200);
  const safeBody = String(body || '').slice(0, 240);
  const notificationTag = String(data.notificationTag || data.type || `${safeTitle}|${safeBody}|${targetLink}`).slice(0, 180);
  const webpushConfig = buildWebpushConfig(targetLink, notificationTag, safeTitle, safeBody);

  if (!firebaseMessaging) {
    const serverKey = process.env.FIREBASE_SERVER_KEY;
    if (!serverKey) return;
    try {
      const messageData = Object.fromEntries(
        Object.entries({ ...data, title: safeTitle, body: safeBody, url: targetLink, link: targetLink, click_action: targetLink, notificationTag })
          .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
      );
      const legacyResp = await axios.post('https://fcm.googleapis.com/fcm/send', {
        registration_ids: tokens,
        notification: { title: safeTitle, body: safeBody },
        data: messageData,
        webpush: {
          headers: webpushConfig.headers,
          notification: webpushConfig.notification,
          fcm_options: { link: targetLink }
        }
      }, {
        headers: {
          Authorization: `key ${serverKey}`,
          'Content-Type': 'application/json'
        }
      });

      const results = Array.isArray(legacyResp?.data?.results) ? legacyResp.data.results : [];
      results.forEach((x, i) => {
        if (x && (x.error === 'NotRegistered' || x.error === 'InvalidRegistration')) {
          pool.query('DELETE FROM admin_fcm_tokens WHERE fcm_token = $1', [tokens[i]]).catch(() => {});
        }
      });

      const sent = Number(legacyResp?.data?.success || 0);
      const failed = Number(legacyResp?.data?.failure || Math.max(tokens.length - sent, 0));
      await logPushInEmailLog({
        recipientName: 'Admins',
        recipientEmail: 'admin-push-broadcast',
        emailType: 'Push-Admin',
        subject: `${safeTitle} [PUSH]`,
        status: sent > 0 ? 'Sent' : 'Failed',
        payload: {
          type: data.type || 'admin_push',
          title: safeTitle,
          body: safeBody,
          link: targetLink,
          tokenCount: tokens.length,
          sent,
          failed,
          transport: 'legacy_fcm'
        }
      });
      return;
    } catch (e) {
      console.warn('Admin legacy FCM send error:', e.message);
      return;
    }
  }

  try {
    const messageData = toFcmDataPayload({
      ...data,
      title: safeTitle,
      body: safeBody,
      url: targetLink,
      link: targetLink,
      click_action: targetLink,
      notificationTag
    });
    const resp = await firebaseMessaging.sendEachForMulticast({
      tokens,
      notification: { title: safeTitle, body: safeBody },
      data: messageData,
      webpush: webpushConfig
    });
    resp.responses.forEach((x, i) => {
      if (!x.success && x.error && (x.error.code === 'messaging/registration-token-not-registered' || x.error.code === 'messaging/invalid-registration-token')) {
        pool.query('DELETE FROM admin_fcm_tokens WHERE fcm_token = $1', [tokens[i]]).catch(() => {});
      }
    });
    const sent = resp.successCount || 0;
    const failed = resp.failureCount || 0;
    await logPushInEmailLog({
      recipientName: 'Admins',
      recipientEmail: 'admin-push-broadcast',
      emailType: 'Push-Admin',
      subject: `${safeTitle} [PUSH]`,
      status: sent > 0 ? 'Sent' : 'Failed',
      payload: {
        type: data.type || 'admin_push',
        title: safeTitle,
        body: safeBody,
        link: targetLink,
        tokenCount: tokens.length,
        sent,
        failed
      }
    });
  } catch (e) {
    console.warn('Admin FCM send error:', e.message);
    await logPushInEmailLog({
      recipientName: 'Admins',
      recipientEmail: 'admin-push-broadcast',
      emailType: 'Push-Admin',
      subject: `${safeTitle} [PUSH]`,
      status: 'Failed',
      payload: {
        type: data.type || 'admin_push',
        title: safeTitle,
        body: safeBody,
        link: targetLink,
        tokenCount: tokens.length,
        reason: 'send_failed',
        error: String(e.message || '')
      }
    });
  }
}

async function notifyAdminsStudentSubmission({
  studentId,
  submissionType,
  sessionId = null,
  fileName = '',
  challengeId = null
}) {
  try {
    const normalizedType = String(submissionType || '').trim();
    if (!studentId || !normalizedType) return;

    const studentResult = await pool.query(
      `SELECT id, name FROM students WHERE id = $1`,
      [studentId]
    );
    const student = studentResult.rows[0];
    if (!student) return;

    let detail = '';
    const payload = {
      notificationType: 'student-submission',
      submissionType: normalizedType,
      studentId: String(student.id)
    };

    if (challengeId) {
      const challengeResult = await pool.query(
        `SELECT title FROM weekly_challenges WHERE id = $1`,
        [challengeId]
      );
      const challenge = challengeResult.rows[0];
      payload.challengeId = String(challengeId);
      if (challenge?.title) detail = `Challenge: ${challenge.title}`;
    } else if (sessionId) {
      const sessionResult = await pool.query(
        `SELECT session_number FROM sessions WHERE id = $1`,
        [sessionId]
      );
      const session = sessionResult.rows[0];
      payload.sessionId = String(sessionId);
      if (session?.session_number) detail = `Class #${session.session_number}`;
    }

    const cleanFileName = String(fileName || '').trim();
    const body = [
      `${student.name} submitted ${normalizedType.toLowerCase()}`,
      detail,
      cleanFileName
    ].filter(Boolean).join(' - ');

    await sendPushToAdmins(
      `${student.name} submitted ${normalizedType}`,
      body,
      payload
    );
  } catch (err) {
    console.warn('Admin student submission push error:', err.message);
  }
}

async function sendClassReminderPush(session, hoursBeforeClass) {
  const parentEmail = String(session?.parent_email || '').trim().toLowerCase();
  if (!parentEmail) return { sent: 0, reason: 'missing_parent_email' };

  const isDemo = !!session.is_demo;
  const isGroup = !!session.is_group;
  const joinUrl = getJoinClassUrl(session.id, { isDemo });
  const hourLabel = `${hoursBeforeClass} ${hoursBeforeClass === 1 ? 'hour' : 'hours'}`;
  const title = isDemo
    ? `Demo class starts in ${hourLabel}`
    : isGroup
      ? `Group class starts in ${hourLabel}`
      : `Class starts in ${hourLabel}`;
  const body = isDemo
    ? `Reminder: ${session.student_name || 'Your child'}'s demo class starts in ${hourLabel}.`
    : isGroup
      ? `Reminder: ${session.group_name || 'Your group class'} starts in ${hourLabel}.`
      : `Reminder: ${session.student_name || 'Your child'}'s class starts in ${hourLabel}.`;

  return sendPushToParentByEmail(parentEmail, title, body, {
    type: `class_reminder_${hoursBeforeClass}hr`,
    sessionId: String(session.id),
    sessionKind: isDemo ? 'demo' : (isGroup ? 'group' : 'private'),
    hoursBeforeClass: String(hoursBeforeClass),
    url: joinUrl,
    notificationTag: `class-reminder-${hoursBeforeClass}hr-${session.id}-${parentEmail}`
  });
}

async function sendAdminDemoReminderPush(session, hoursBeforeClass) {
  if (!session?.is_demo || !session?.id) return;

  const hourLabel = `${hoursBeforeClass} ${hoursBeforeClass === 1 ? 'hour' : 'hours'}`;
  const title = `Demo class starts in ${hourLabel}`;
  const body = [
    `${session.student_name || 'Student'} demo class starts in ${hourLabel}`,
    session.parent_name ? `Parent: ${session.parent_name}` : '',
    session.parent_email ? `Email: ${session.parent_email}` : ''
  ].filter(Boolean).join(' - ');
  const appUrl = (process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com').replace(/\/$/, '');

  await sendPushToAdmins(title, body, {
    type: `admin_demo_reminder_${hoursBeforeClass}hr`,
    notificationType: 'demo-reminder',
    sessionId: String(session.id),
    hoursBeforeClass: String(hoursBeforeClass),
    studentName: String(session.student_name || ''),
    parentName: String(session.parent_name || ''),
    parentEmail: String(session.parent_email || ''),
    url: `${appUrl}/admin.html`,
    notificationTag: `admin-demo-reminder-${hoursBeforeClass}hr-${session.id}`
  });
}

async function sendEmail(to, subject, html, recipientName, emailType, options = {}) {
  const normalizedEmailType = String(emailType || '').trim();
  const effectiveSubject =
    normalizedEmailType === 'Classwork-Feedback'
      ? String(subject || '')
          .replaceAll('Homework Feedback', 'Classwork Feedback')
          .replaceAll('Homework Corrected', 'Classwork Corrected')
          .replaceAll("'s Homework Reviewed", "'s Classwork Reviewed")
      : subject;
  let finalHtml = html;
  try {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ BREVO_API_KEY missing. Email not sent.');
      return false;
    }

    const websiteLink = 'https://sites.google.com/view/fluentfeathersacademybyaaliya/home';
    const websiteFooter = `
      <div style="text-align:center;padding:14px 20px 4px;">
        <a href="${websiteLink}" target="_blank" style="display:inline-block;color:#B05D9E;font-size:14px;font-weight:700;text-decoration:none;">
          Visit Our Website: Fluent Feathers Academy
        </a>
      </div>
    `;
    if (typeof finalHtml === 'string' && !finalHtml.includes(websiteLink)) {
      if (finalHtml.includes('</body>')) {
        finalHtml = finalHtml.replace('</body>', `${websiteFooter}\n</body>`);
      } else {
        finalHtml += websiteFooter;
      }
    }

    await axios.post('https://api.brevo.com/v3/smtp/email', { sender: { name: 'Fluent Feathers Academy', email: process.env.EMAIL_USER || 'test@test.com' }, to: [{ email: to, name: recipientName || to }], subject: effectiveSubject, htmlContent: finalHtml }, { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' } });
    await pool.query(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status, email_body) VALUES ($1, $2, $3, $4, 'Sent', $5)`, [recipientName || '', to, emailType, effectiveSubject, finalHtml]);
    if (options.skipPush !== true) {
      const pushTitle = String(effectiveSubject || '').replace(/\s*\[[^\]]+\]\s*$/g, '').trim() || 'Fluent Feathers';
      const pushBody = stripHtmlSnippet(finalHtml);
      sendPushToParentByEmail(to, pushTitle, pushBody, { emailType: emailType || '' }).catch(() => {});
    }
    return true;
  } catch (e) {
    console.error('Email Error:', e.message);
    await pool.query(`INSERT INTO email_log (recipient_name, recipient_email, email_type, subject, status, email_body) VALUES ($1, $2, $3, $4, 'Failed', $5)`, [recipientName || '', to, emailType, effectiveSubject, finalHtml || html || '']);
    // Do not block push fallback on email provider failures.
    const pushTitleFallback = String(effectiveSubject || subject || '').replace(/\s*\[[^\]]+\]\s*$/g, '').trim() || 'Fluent Feathers';
    const pushBodyFallback = stripHtmlSnippet(finalHtml || html || '') || `Update for ${recipientName || 'Parent'}`;
    sendPushToParentByEmail(to, pushTitleFallback, pushBodyFallback, { emailType: emailType || '', fallback: 'email_failed' }).catch(() => {});
    return false;
  }
}

function getFirebaseWebConfig() {
  if (process.env.FIREBASE_CONFIG) {
    try {
      const cfg = JSON.parse(process.env.FIREBASE_CONFIG);
      if (cfg && !cfg.authDomain && cfg.projectId) {
        cfg.authDomain = `${cfg.projectId}.firebaseapp.com`;
      }
      return cfg;
    } catch (err) {
      console.warn('Invalid FIREBASE_CONFIG JSON:', err.message);
    }
  }
  if (process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_MESSAGING_SENDER_ID && process.env.FIREBASE_APP_ID) {
    return {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: process.env.FIREBASE_PROJECT_ID,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID || undefined
    };
  }
  return null;
}

let firebaseAdminMessaging = null;
let firebaseAdminInitAttempted = false;
function getFirebaseAdminMessaging() {
  if (firebaseAdminInitAttempted) return firebaseAdminMessaging;
  firebaseAdminInitAttempted = true;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(serviceAccount) });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      firebaseAdmin.initializeApp();
    } else {
      return null;
    }
    firebaseAdminMessaging = firebaseAdmin.messaging();
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    firebaseAdminMessaging = null;
  }
  return firebaseAdminMessaging;
}

async function sendAdminPushNotification(title, body, data = {}) {
  try {
    await ensurePushTokenTables();
    const result = await pool.query('SELECT fcm_token FROM admin_fcm_tokens');
    const tokens = result.rows.map(row => row.fcm_token).filter(Boolean);
    if (!tokens.length) return false;

    const appUrl = (process.env.APP_URL || process.env.PARENT_PORTAL_URL || 'https://fluent-feathers-academy-lms.onrender.com').replace(/\/$/, '');
    const targetLink = String(data.url || data.link || `${appUrl}/admin.html`);
    const notificationTag = String(data.notificationTag || data.type || `${String(title || '')}|${String(body || '')}|${targetLink}`).slice(0, 180);
    const webpush = buildWebpushConfig(targetLink, notificationTag, String(title || APP_DISPLAY_NAME).slice(0, 200), String(body || '').slice(0, 240));
    const messageData = Object.fromEntries(
      Object.entries({
        ...data,
        title,
        body,
        type: data.type || 'admin_notification',
        url: targetLink,
        link: targetLink,
        click_action: targetLink,
        notificationTag
      }).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
    );

    const firebaseMessaging = getFirebaseAdminMessaging();
    if (firebaseMessaging) {
      const response = await firebaseMessaging.sendMulticast({
        tokens,
        notification: { title, body },
        data: messageData,
        webpush
      });
      if (response.failureCount) {
        const invalidTokens = [];
        response.responses.forEach((resp, index) => {
          if (!resp.success && resp.error && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(resp.error.code)) {
            invalidTokens.push(tokens[index]);
          }
        });
        if (invalidTokens.length) {
          await pool.query('DELETE FROM admin_fcm_tokens WHERE fcm_token = ANY($1)', [invalidTokens]);
        }
      }
      await logPushInEmailLog({
        recipientName: 'Admins',
        recipientEmail: 'admin-push-broadcast',
        emailType: 'Push-Admin',
        subject: `${String(title || 'Admin Notification').slice(0, 200)} [PUSH]`,
        status: (response.successCount || 0) > 0 ? 'Sent' : 'Failed',
        payload: {
          type: data.type || 'admin_notification',
          title: String(title || ''),
          body: String(body || ''),
          tokenCount: tokens.length,
          sent: response.successCount || 0,
          failed: response.failureCount || 0
        }
      });
      return true;
    }

    const serverKey = process.env.FIREBASE_SERVER_KEY;
    if (serverKey) {
      await axios.post('https://fcm.googleapis.com/fcm/send', {
        registration_ids: tokens,
        notification: { title, body },
        data: messageData,
        webpush: {
          headers: webpush.headers,
          notification: webpush.notification,
          fcm_options: { link: targetLink }
        }
      }, {
        headers: {
          Authorization: `key ${serverKey}`,
          'Content-Type': 'application/json'
        }
      });
      await logPushInEmailLog({
        recipientName: 'Admins',
        recipientEmail: 'admin-push-broadcast',
        emailType: 'Push-Admin',
        subject: `${String(title || 'Admin Notification').slice(0, 200)} [PUSH]`,
        status: 'Sent',
        payload: {
          type: data.type || 'admin_notification',
          title: String(title || ''),
          body: String(body || ''),
          tokenCount: tokens.length,
          transport: 'legacy_fcm'
        }
      });
      return true;
    }

    console.warn('No Firebase push configuration available for admin notifications.');
    return false;
  } catch (err) {
    console.error('Admin push notification error:', err.message);
    return false;
  }
}

function getWelcomeEmail(data) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">🎓 Welcome to Fluent Feathers Academy!</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We are thrilled to welcome <strong style="color: #667eea;">${data.student_name}</strong> to our <strong>${data.program_name}</strong> program!
        This is the beginning of an exciting learning journey, and we're here to support every step of the way.
      </p>

      <div style="background: #f7fafc; border-left: 4px solid #667eea; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #667eea; margin-top: 0; margin-bottom: 15px;">📚 What's Next?</h3>
        <ul style="color: #4a5568; line-height: 2; margin: 0; padding-left: 20px;">
          <li>Check your email for class schedule details</li>
          <li>Access the parent portal to view sessions and materials</li>
          <li>Join classes using the Class link provided</li>
          <li>Upload homework and track progress</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="${data.class_link}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.4);">
  🎥 Join Your First Class
</a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>💡 Pro Tip:</strong> Save the Class link for easy access to all your classes. We recommend testing your camera and microphone before the first session.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        If you have any questions or need assistance, feel free to reach out to us anytime. We're excited to work with ${data.student_name}!
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Warm regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getScheduleEmail(data) {
  const timezoneLabel = data.timezone_label || 'Your Local Time';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">📅 Your Class Schedule</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        Great news! We've scheduled the upcoming classes for <strong style="color: #667eea;">${data.student_name}</strong>.
        Please find the complete schedule below:
      </p>

      <table style="width: 100%; border-collapse: collapse; margin: 25px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <thead>
          <tr style="background: #667eea; color: white;">
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">#</th>
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">Date</th>
            <th style="padding: 15px; text-align: left; border-bottom: 2px solid #5568d3;">Time (${timezoneLabel})</th>
          </tr>
        </thead>
        <tbody>
          ${data.schedule_rows}
        </tbody>
      </table>

      <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #2c7a7b; margin-top: 0; margin-bottom: 15px;">🎥 Join Your Classes</h3>
<p style="color: #234e52; margin: 0; font-size: 14px; line-height: 1.8;">
  All classes will use the same Class link. We recommend joining 5 minutes early to ensure a smooth start.
          The link will also be available in your parent portal next to each class.
        </p>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>📌 Important:</strong> If you need to cancel a class, please do so at least 1 hour before the scheduled time to receive a makeup credit.
          You can cancel classes directly from your parent portal.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        Looking forward to seeing ${data.student_name} in class! If you have any questions or need to reschedule, please don't hesitate to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Best regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getAnnouncementEmail(data) {
  const priorityColors = {
    'Urgent': { bg: '#fed7d7', border: '#c53030', text: '#c53030' },
    'High': { bg: '#feebc8', border: '#c05621', text: '#c05621' },
    'Normal': { bg: '#e2e8f0', border: '#718096', text: '#4a5568' }
  };
  const colors = priorityColors[data.priority] || priorityColors['Normal'];

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">📢 Announcement</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${data.parentName}</strong>,</p>

      <div style="background: ${colors.bg}; border-left: 4px solid ${colors.border}; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
          <span style="background: #B05D9E; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px;">${data.type}</span>
          <span style="background: ${colors.border}; color: white; padding: 4px 12px; border-radius: 4px; font-size: 12px;">${data.priority}</span>
        </div>
        <h2 style="color: #2d3748; margin: 0 0 15px; font-size: 22px;">${data.title}</h2>
        <p style="color: #4a5568; margin: 0; font-size: 16px; line-height: 1.8; white-space: pre-wrap;">${data.content}</p>
        ${data.imageUrl ? `<div style="margin-top: 20px; text-align: center;"><img src="${data.imageUrl}" style="max-width: 100%; max-height: 400px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" alt="Announcement Image"></div>` : ''}
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        If you have any questions regarding this announcement, please feel free to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Best regards,<br>
        <strong style="color: #B05D9E;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getDemoConfirmationEmail(data) {
  const parentTimezoneLabel = data.parentTimezoneLabel || 'Your Local Time';
  const displayDemoDate = data.parentDemoDate || data.demoDate;
  const displayDemoTime = data.parentDemoTime || data.demoTime;

  const bioHtml = data.adminBio ? `
    <div style="background: #f7fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border-left: 4px solid #B05D9E;">
      <h3 style="color: #B05D9E; margin: 0 0 15px; font-size: 18px;">👋 Meet Your Instructor</h3>
      <div style="display: flex; align-items: flex-start; gap: 20px;">
        <div style="width: 70px; height: 70px; background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 28px; font-weight: bold; flex-shrink: 0;">
          ${data.adminName ? data.adminName.charAt(0).toUpperCase() : 'A'}
        </div>
        <div style="flex: 1;">
          <h4 style="margin: 0 0 5px; color: #2d3748; font-size: 18px;">${data.adminName || 'Aaliya'}</h4>
          <p style="margin: 0 0 12px; color: #B05D9E; font-size: 14px; font-weight: 600;">${data.adminTitle || 'Founder & Lead Instructor'}</p>
          <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">${data.adminBio}</p>
        </div>
      </div>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Demo Class Confirmed!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 25px;">Hi <strong>${data.parentName}</strong>,</p>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        Thank you for scheduling a demo class for <strong style="color: #B05D9E;">${data.childName}</strong>! We're excited to class you and your child.
      </p>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 25px; margin: 25px 0; border-radius: 12px; text-align: center;">
        <h3 style="margin: 0 0 15px; font-size: 16px; opacity: 0.9;">📅 Demo Class Details</h3>
        <p style="margin: 0 0 8px; font-size: 20px; font-weight: bold;">${displayDemoDate}</p>
        <p style="margin: 0; font-size: 24px; font-weight: bold;">🕐 ${displayDemoTime}</p>
        <p style="margin: 12px 0 0; font-size: 15px; opacity: 0.95;">Parent Local Time (${parentTimezoneLabel})</p>
        <p style="margin: 15px 0 0; font-size: 14px; opacity: 0.9;">Program: ${data.programInterest}</p>
        ${data.classLink ? `<a href="${data.classLink}" style="display: inline-block; margin-top: 20px; background: white; color: #667eea; padding: 14px 35px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px;">🎥 Join Demo Class</a>` : ''}
      </div>

      ${bioHtml}

      <div style="background: #fff8e6; border: 1px solid #f6e05e; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h4 style="color: #744210; margin: 0 0 10px; font-size: 16px;">📝 What to Expect</h4>
        <ul style="color: #744210; margin: 0; padding-left: 20px; line-height: 1.8;">
          <li>Interactive and fun 30-minute session</li>
          <li>Assessment of your child's current level</li>
          <li>Q&A with the instructor</li>
        </ul>
      </div>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        ${data.classLink ? 'Click the "Join Demo Class" button above at the scheduled time to join the demo.' : 'We\'ll send you the classing link closer to the demo time.'} If you have any questions, feel free to reply to this email.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 30px;">
        Looking forward to classing ${data.childName}!<br><br>
        Best regards,<br>
        <strong style="color: #B05D9E;">${data.adminName || 'Aaliya'}</strong><br>
        <span style="color: #718096; font-size: 14px;">${data.adminTitle || 'Fluent Feathers Academy'}</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getRescheduleEmailTemplate(data) {
  // Format dates for display
  const formatDate = (dateStr) => {
    try {
      if (!dateStr) return 'N/A';

      let parsedDate = null;
      if (dateStr instanceof Date) {
        parsedDate = dateStr;
      } else {
        const raw = String(dateStr).trim();
        const dateOnly = raw.includes('T') ? raw.split('T')[0] : raw;

        if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
          parsedDate = new Date(`${dateOnly}T00:00:00`);
        } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateOnly)) {
          const [day, month, year] = dateOnly.split('/');
          parsedDate = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
        } else {
          parsedDate = new Date(raw);
        }
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) return String(dateStr);
      return parsedDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return String(dateStr);
    }
  };

  const formatTime = (timeStr, timezone) => {
    try {
      if (!timeStr) return 'N/A';

      let normalizedTime = String(timeStr).trim();
      if (normalizedTime.length === 5) normalizedTime += ':00';
      if (normalizedTime.length > 8) normalizedTime = normalizedTime.substring(0, 8);

      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(normalizedTime)) return String(timeStr);

      const today = new Date().toISOString().split('T')[0];
      const d = new Date(`${today}T${normalizedTime}Z`);
      if (isNaN(d.getTime())) return String(timeStr);

      return d.toLocaleTimeString('en-US', { timeZone: timezone || 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {
      return String(timeStr);
    }
  };

  const oldDateFormatted = formatDate(data.old_date);
  const newDateFormatted = formatDate(data.new_date);
  const oldTimeFormatted = formatTime(data.old_time, data.timezone);
  const newTimeFormatted = formatTime(data.new_time, data.timezone);
  const timezoneLabel = data.timezoneLabel || getTimezoneLabel(data.timezone || 'Asia/Kolkata');
  const sessionType = data.is_group ? `Group Class (${data.group_name})` : 'Private Class';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">📅 Class Rescheduled</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We wanted to inform you that <strong>${data.student_name}'s</strong> class has been rescheduled.
      </p>

      <!-- Old Schedule (Crossed out) -->
      <div style="background: #fed7d7; padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #c53030;">
        <h3 style="margin: 0 0 15px; color: #c53030; font-size: 16px;">❌ Previous Schedule</h3>
        <p style="margin: 0; color: #742a2a; text-decoration: line-through;">
          📆 ${oldDateFormatted}<br>
          ⏰ ${oldTimeFormatted} (${timezoneLabel})
        </p>
      </div>

      <!-- New Schedule -->
      <div style="background: linear-gradient(135deg, #c6f6d5 0%, #9ae6b4 100%); padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #38a169;">
        <h3 style="margin: 0 0 15px; color: #276749; font-size: 16px;">✅ New Schedule</h3>
        <p style="margin: 0; color: #22543d; font-weight: 600; font-size: 18px;">
          📆 ${newDateFormatted}<br>
          ⏰ ${newTimeFormatted} (${timezoneLabel})
        </p>
      </div>

      <div style="background: #f7fafc; padding: 15px 20px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 14px;">
          <strong>Class Type:</strong> ${sessionType}<br>
          <strong>Reason:</strong> ${data.reason || 'Schedule adjustment'}
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-top: 25px;">
        Please make a note of this change. If you have any questions or need further adjustments, please feel free to contact us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        Thank you for your understanding! 🙏<br><br>
        Best regards,<br>
        <strong style="color: #B05D9E;">Teacher Aaliya</strong><br>
        <span style="color: #718096; font-size: 14px;">Fluent Feathers Academy</span>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getBulkPrivateRescheduleEmailTemplate(data) {
  const parentName = escapeHtml(data.parent_name || 'Parent');
  const studentName = escapeHtml(data.student_name || 'Student');
  const timezoneLabel = escapeHtml(data.timezoneLabel || getTimezoneLabel(data.timezone || 'Asia/Kolkata'));
  const sessionRowsHtml = data.sessionRowsHtml || '<tr><td colspan="3" style="padding:10px; color:#718096;">No sessions found</td></tr>';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color:#f0f4f8;">
  <div style="max-width:600px; margin:20px auto; background:white; border-radius:12px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding:35px 30px; text-align:center;">
      <h1 style="color:white; margin:0; font-size:28px;">📅 Classes Rescheduled</h1>
      <p style="color:rgba(255,255,255,0.9); margin:8px 0 0; font-size:14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding:30px;">
      <p style="font-size:16px; color:#2d3748; margin:0 0 15px;">Dear <strong>${parentName}</strong>,</p>
      <p style="font-size:15px; color:#4a5568; line-height:1.7; margin:0 0 20px;">
        We wanted to inform you that multiple upcoming classes for <strong>${studentName}</strong> have been rescheduled.
      </p>

      <div style="background:#f7fafc; padding:20px; border-radius:10px; margin:20px 0; border-left:4px solid #667eea;">
        <table style="width:100%; border-collapse:collapse; font-size:14px;">
          <thead>
            <tr style="background:#edf2f7;">
              <th style="padding:10px; text-align:left; color:#2d3748;">Session</th>
              <th style="padding:10px; text-align:left; color:#2d3748;">New Date</th>
              <th style="padding:10px; text-align:left; color:#2d3748;">New Time (${timezoneLabel})</th>
            </tr>
          </thead>
          <tbody>
            ${sessionRowsHtml}
          </tbody>
        </table>
      </div>

      <p style="font-size:15px; color:#4a5568; line-height:1.7; margin:20px 0 0;">
        Please update your calendar accordingly. If you need any further adjustments, feel free to contact us.
      </p>
      <p style="font-size:15px; color:#2d3748; margin:20px 0 0;">
        Best regards,<br>
        <strong style="color:#B05D9E;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

function getEventEmail(data) {
  const eventTimezoneLabel = data.event_timezone_label || 'Your Local Time';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 32px;">🎉 ${data.event_name}</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${data.parent_name}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8; margin-bottom: 25px;">
        We're excited to invite you and your child to a special event! This is a wonderful opportunity for learning, fun, and connecting with other students.
      </p>

      ${data.event_description ? `
      <div style="background: #f7fafc; padding: 20px; border-radius: 8px; margin: 25px 0;">
        <h3 style="color: #667eea; margin-top: 0; margin-bottom: 15px;">📝 About This Event</h3>
        <p style="color: #4a5568; margin: 0; line-height: 1.8;">${data.event_description}</p>
      </div>
      ` : ''}

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; margin: 25px 0; color: white;">
        <h3 style="margin-top: 0; margin-bottom: 20px; font-size: 20px;">📅 Event Details</h3>
        <div style="display: flex; align-items: center; margin-bottom: 15px;">
          <span style="font-size: 24px; margin-right: 15px;">📆</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Date</div>
            <div style="opacity: 0.9;">${data.event_date}</div>
          </div>
        </div>
        <div style="display: flex; align-items: center; margin-bottom: 15px;">
          <span style="font-size: 24px; margin-right: 15px;">🕐</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Time (${eventTimezoneLabel})</div>
            <div style="opacity: 0.9;">${data.event_time}</div>
          </div>
        </div>
        ${data.event_duration ? `
        <div style="display: flex; align-items: center;">
          <span style="font-size: 24px; margin-right: 15px;">⏱️</span>
          <div>
            <div style="font-weight: bold; margin-bottom: 5px;">Duration</div>
            <div style="opacity: 0.9;">${data.event_duration}</div>
          </div>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center; margin: 35px 0;">
        <a href="${data.registration_link}" style="display: inline-block; background: linear-gradient(135deg, #38a169 0%, #2f855a 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 15px rgba(56, 161, 105, 0.4);">
          ✅ Register Now
        </a>
      </div>

      ${data.class_link ? `
      <div style="background: #e6fffa; border-left: 4px solid #38b2ac; padding: 20px; margin: 25px 0; border-radius: 8px;">
        <h3 style="color: #2c7a7b; margin-top: 0; margin-bottom: 15px;">🎥 Join Information</h3>
        <p style="color: rgba(255,255,255,0.9); margin: 0 0 15px 0; font-size: 14px;">
  After registering, you'll receive the Class link to join the event. We recommend joining 5 minutes early!
</p>
<a href="${data.class_link}" style="display: inline-block; background: #38b2ac; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px;">
  🔗 Event Class Link
</a>
      </div>
      ` : ''}

      <div style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          <strong>💡 Note:</strong> Spots may be limited! Register early to secure your place.
          You can also register directly from your parent portal in the Events section.
        </p>
      </div>

      <p style="font-size: 16px; color: #4a5568; margin-top: 30px; line-height: 1.8;">
        We can't wait to see you there! If you have any questions about the event, feel free to reach out to us.
      </p>

      <p style="font-size: 16px; color: #2d3748; margin-top: 25px;">
        See you soon!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getPaymentConfirmationEmail(data) {
  const { parentName, studentName, amount, currency, paymentType, sessionsAdded, paymentMethod, receiptNumber } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38a169 0%, #276749 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">✅ Payment Confirmed</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Thank you for your payment!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We have received your payment for <strong>${studentName}</strong>. Here are the details:
      </p>

      <div style="background: #f7fafc; padding: 25px; border-radius: 12px; border-left: 4px solid #38a169; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #4a5568;">Payment Type:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentType}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Amount:</td><td style="padding: 10px 0; font-weight: bold; color: #38a169; font-size: 1.2rem;">${currency} ${amount}</td></tr>
          ${sessionsAdded ? `<tr><td style="padding: 10px 0; color: #4a5568;">Sessions:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentType === 'Renewal' ? '+' : ''}${sessionsAdded} sessions</td></tr>` : ''}
          ${paymentMethod ? `<tr><td style="padding: 10px 0; color: #4a5568;">Payment Method:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${paymentMethod}</td></tr>` : ''}
          ${receiptNumber ? `<tr><td style="padding: 10px 0; color: #4a5568;">Receipt Number:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${receiptNumber}</td></tr>` : ''}
        </table>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions about this payment, please feel free to reach out to us.<br><br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getOTPEmail(data) {
  const { parentName, otp } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">🔐 Login OTP</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Fluent Feathers Academy Parent Portal</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        You have requested to login to the Fluent Feathers Academy Parent Portal. Please use the OTP below to complete your login:
      </p>

      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 12px; text-align: center; margin: 30px 0;">
        <p style="margin: 0 0 10px; color: rgba(255,255,255,0.9); font-size: 14px;">Your One-Time Password</p>
        <h2 style="margin: 0; color: white; font-size: 42px; font-weight: bold; letter-spacing: 8px;">${otp}</h2>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>⚠️ Important:</strong> This OTP is valid for <strong>10 minutes</strong> only. Do not share this code with anyone.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you didn't request this OTP, please ignore this email.<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getClassReminderEmail(data) {
  const { studentName, localDate, localTime, localDay, classLink, hoursBeforeClass, timezoneLabel, isDemo } = data;

  // For demo classes, remove parent portal references and update instructions
  if (isDemo) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">⏰ Demo Class Reminder</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Your demo class is starting ${hoursBeforeClass === 5 ? 'in 5 hours' : 'in 1 hour'}!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Hi <strong>${studentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        This is a friendly reminder that your upcoming <strong>demo class</strong> is ${hoursBeforeClass === 5 ? '<strong>starting in 5 hours</strong>' : '<strong>starting in 1 hour</strong>'}!
      </p>

      <div style="background: linear-gradient(135deg, #f6f9fc 0%, #e9f2ff 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #667eea; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #667eea; font-size: 20px;">📅 Class Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Date:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${localDay}, ${localDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Time:</strong></td>
            <td style="padding: 8px 0; color: #667eea; font-size: 16px; font-weight: bold; text-align: right;">${localTime}${timezoneLabel ? ` <span style=\"font-size: 12px; font-weight: normal; color: #718096;\">(${timezoneLabel})</span>` : ''}</td>
          </tr>
        </table>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${classLink}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.3);">
  🎥 Join Class
</a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>💡 Pro Tip:</strong> Make sure you're in a quiet place with good internet connection. Have your materials ready!
        </p>
        <p style="margin: 10px 0 0; color: #856404; font-size: 13px; line-height: 1.5;">
          <strong>📌 Note:</strong> If you need to cancel or reschedule, please contact your teacher or our team directly before the session starts.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're excited to see you in class!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
  }

  // Default (non-demo) class reminder email
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">⏰ Class Reminder</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Your class is starting ${hoursBeforeClass === 5 ? 'in 5 hours' : 'in 1 hour'}!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Hi <strong>${studentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        This is a friendly reminder that your upcoming class is ${hoursBeforeClass === 5 ? '<strong>starting in 5 hours</strong>' : '<strong>starting in 1 hour</strong>'}!
      </p>

      <div style="background: linear-gradient(135deg, #f6f9fc 0%, #e9f2ff 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #667eea; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #667eea; font-size: 20px;">📅 Class Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Date:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${localDay}, ${localDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Time:</strong></td>
            <td style="padding: 8px 0; color: #667eea; font-size: 16px; font-weight: bold; text-align: right;">${localTime}${timezoneLabel ? ` <span style=\"font-size: 12px; font-weight: normal; color: #718096;\">(${timezoneLabel})</span>` : ''}</td>
          </tr>
        </table>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${classLink}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.3);">
  🎥 Join Class
</a>
      </div>

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>💡 Pro Tip:</strong> Make sure you're in a quiet place with good internet connection. Have your materials ready!
        </p>
        <p style="margin: 10px 0 0; color: #856404; font-size: 13px; line-height: 1.5;">
          <strong>📌 Note:</strong> If you need to cancel, please do so from the Parent Portal at least <strong>1 hour before</strong> the session starts.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're excited to see you in class!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getEventReminderEmail(data) {
  const { childName, eventName, eventDate, eventTime, eventDuration, classLink } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">⏰ Event Starting Soon!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">${eventName}</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Hi! This is a reminder for <strong>${childName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        The event <strong>${eventName}</strong> is <strong>starting in 30 minutes</strong>! Please get ready to join.
      </p>

      <div style="background: linear-gradient(135deg, #f6f9fc 0%, #fce4ec 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #f5576c; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #f5576c; font-size: 20px;">📅 Event Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Event:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${eventName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Date:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${eventDate}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Time:</strong></td>
            <td style="padding: 8px 0; color: #f5576c; font-size: 16px; font-weight: bold; text-align: right;">${eventTime}</td>
          </tr>
          ${eventDuration ? '<tr><td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Duration:</strong></td><td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">' + eventDuration + '</td></tr>' : ''}
        </table>
      </div>

      ${classLink ? `
      <div style="text-align: center; margin: 30px 0;">
        <a href="${classLink}" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #2c7a7b 100%); color: white; padding: 16px 40px; text-decoration: none; border-radius: 8px; font-size: 18px; font-weight: bold; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.3);">
          🎥 Join Event Now
        </a>
      </div>
      ` : ''}

      <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
          <strong>💡 Tip:</strong> Join a few minutes early to make sure everything is working. Have a quiet space and good internet ready!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're excited to see you there!<br>
        <strong style="color: #f5576c;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getHomeworkFeedbackEmail(data) {
  const {
    studentName,
    parentName,
    grade,
    comments,
    fileName,
    workType,
    materialType,
    actionLabel = 'Reviewed'
  } = data;
  const normalizedWorkType = (workType || materialType) === 'Classwork' ? 'Classwork' : 'Homework';
  const lowerWorkType = normalizedWorkType.toLowerCase();
  const typeLabel = normalizedWorkType;

  // Get emoji based on grade
  const g = (grade || '').toLowerCase();
  const gradeEmoji = g.includes('a') || g.includes('excellent') ? '🌟' :
                     g.includes('b') || g.includes('good') ? '👍' :
                     g.includes('c') ? '📝' : '⭐';

  const emailHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38a169 0%, #2f855a 100%); padding: 40px 30px; text-align: center;">
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">📝 ${typeLabel} Reviewed!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Great job on completing your ${typeLabel.toLowerCase()}!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName || studentName + "'s Parent"}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We're happy to let you know that ${studentName}'s ${typeLabel.toLowerCase()} has been reviewed! Here are the details:
      </p>

      <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #38a169; margin-bottom: 25px;">
        <h2 style="margin: 0 0 15px; color: #38a169; font-size: 20px;">📋 ${typeLabel} Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>File:</strong></td>
            <td style="padding: 8px 0; color: #2d3748; font-size: 15px; text-align: right;">${fileName || typeLabel + ' submission'}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #4a5568; font-size: 15px;"><strong>Grade:</strong></td>
            <td style="padding: 8px 0; font-size: 18px; font-weight: bold; text-align: right;">
              <span style="background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; padding: 5px 15px; border-radius: 20px;">
                ${gradeEmoji} ${grade}
              </span>
            </td>
          </tr>
        </table>
      </div>

      ${comments ? `
      <div style="background: #fef5e7; padding: 20px; border-radius: 10px; border-left: 4px solid #f6ad55; margin-bottom: 25px;">
        <h3 style="margin: 0 0 10px; color: #c05621; font-size: 16px;">💬 Teacher's Feedback</h3>
        <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.6; font-style: italic;">
          "${comments}"
        </p>
      </div>
      ` : ''}

      <div style="background: #e6fffa; border: 1px solid #38b2ac; padding: 15px; border-radius: 8px; margin-top: 25px;">
        <p style="margin: 0; color: #234e52; font-size: 14px; line-height: 1.5;">
          <strong>🎯 Keep it up!</strong> Regular ${typeLabel.toLowerCase()} completion helps reinforce learning and build good study habits. We're proud of ${studentName}'s progress!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        Keep up the excellent work!<br>
        <strong style="color: #38a169;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
  return emailHtml
    .replaceAll('Homework Reviewed!', `${normalizedWorkType} ${actionLabel}!`)
    .replaceAll('your homework', `your ${lowerWorkType}`)
    .replaceAll(`${studentName}'s homework has been reviewed`, `${studentName}'s ${lowerWorkType} has been ${actionLabel.toLowerCase()}`)
    .replaceAll('Homework Details', `${normalizedWorkType} Details`)
    .replaceAll('Homework submission', `${normalizedWorkType} submission`)
    .replaceAll('Regular homework completion', `Regular ${lowerWorkType} completion`);
}

function getBirthdayEmail(data) {
  const { studentName } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #FF6B9D 0%, #C06FF9 100%); padding: 50px 30px; text-align: center; position: relative;">
      <div style="font-size: 60px; margin-bottom: 10px;">🎉🎂🎈</div>
      <h1 style="margin: 0; color: white; font-size: 36px; font-weight: bold;">Happy Birthday!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 18px;">Wishing you a fantastic day!</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 18px; color: #2d3748; text-align: center;">
        Dear <strong>${studentName}</strong>,
      </p>
      <div style="text-align: center; font-size: 50px; margin: 20px 0;">🎊🎁🌟</div>
      <p style="margin: 0 0 25px; font-size: 16px; color: #4a5568; line-height: 1.8; text-align: center;">
        Everyone at <strong style="color: #667eea;">Fluent Feathers Academy</strong><br>
        wishes you a very <strong>Happy Birthday</strong>!<br><br>
        May this special day bring you lots of happiness,<br>
        joy, and wonderful memories! 🎈🎂❤️
      </p>

      <div style="background: linear-gradient(135deg, #FFF5E1 0%, #FFE4E1 100%); padding: 25px; border-radius: 10px; border-left: 4px solid #FF6B9D; margin: 30px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 16px; line-height: 1.6; text-align: center;">
          <span style="font-size: 24px;">🌟</span><br>
          <strong style="color: #C06FF9;">You are amazing!</strong><br>
          Keep shining and learning!
        </p>
      </div>

      <div style="text-align: center; margin: 30px 0; font-size: 40px;">
        🎵 🎶 🎉 🎂 🎁 🎈 🎊
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6; text-align: center;">
        With lots of love,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getRenewalReminderEmail(data) {
  const { parentName, studentName, remainingSessions, programName, perSessionFee, currency, makeupCredits } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">⏰</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Session Renewal Reminder</h1>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>

      <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #e53e3e; margin: 25px 0;">
        <p style="margin: 0; font-size: 18px; color: #c53030; font-weight: bold; text-align: center;">
          ⚠️ Only ${remainingSessions} session${remainingSessions > 1 ? 's' : ''} remaining for ${studentName}!
        </p>
      </div>

      <p style="margin: 0 0 20px; font-size: 15px; color: #4a5568; line-height: 1.7;">
        We wanted to remind you that <strong>${studentName}</strong>'s sessions for
        <strong style="color: #667eea;">${programName || 'their program'}</strong> are running low.
      </p>

      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.7;">
        To ensure uninterrupted learning, please consider renewing the sessions soon.
        We'd hate for ${studentName} to miss out on their learning journey! 📚
      </p>

      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px; color: #2d3748; font-size: 16px;">📋 Current Status:</h3>
        <table style="width: 100%; font-size: 14px; color: #4a5568;">
          <tr><td style="padding: 8px 0;">Student:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${studentName}</td></tr>
          <tr><td style="padding: 8px 0;">Program:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${programName || 'N/A'}</td></tr>
          <tr><td style="padding: 8px 0;">Sessions Remaining:</td><td style="padding: 8px 0; text-align: right; font-weight: bold; color: #e53e3e;">${remainingSessions}</td></tr>
          ${makeupCredits > 0 ? `<tr><td style="padding: 8px 0;">Makeup Credits:</td><td style="padding: 8px 0; text-align: right; font-weight: bold; color: #6b46c1;">${makeupCredits} <span style='font-size:12px;'>(contact teacher to book these missed sessions)</span></td></tr>` : ''}
          ${perSessionFee ? `<tr><td style="padding: 8px 0;">Per Session Fee:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${currency || '₹'}${perSessionFee}</td></tr>` : ''}
        </table>
      </div>

      <p style="margin: 25px 0; font-size: 15px; color: #4a5568; line-height: 1.7;">
        To renew, simply reply to this email or contact us directly. We're happy to help! 😊
      </p>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568;">
        Warm regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getSlotsReleasingEmail(data) {
  const { parentName, studentName, programName, perSessionFee, currency, makeupCredits } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🚨</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">All Sessions Completed!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>

      <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #e53e3e; margin: 25px 0;">
        <p style="margin: 0; font-size: 18px; color: #c53030; font-weight: bold; text-align: center;">
          ${studentName}'s all paid sessions have been completed!
        </p>
      </div>

      <p style="margin: 0 0 20px; font-size: 15px; color: #4a5568; line-height: 1.7;">
        We hope <strong>${studentName}</strong> has been enjoying the classes at
        <strong style="color: #667eea;">Fluent Feathers Academy</strong>! All the scheduled sessions for
        <strong>${programName || 'the program'}</strong> have now been completed.
      </p>

      <div style="background: linear-gradient(135deg, #fffaf0 0%, #feebc8 100%); padding: 20px; border-radius: 10px; border-left: 4px solid #f6ad55; margin: 25px 0;">
        <p style="margin: 0; font-size: 15px; color: #744210; line-height: 1.7;">
          <strong>⏳ Please note:</strong> We will be releasing ${studentName}'s slot soon. To continue uninterrupted learning, please renew the sessions at the earliest so we can schedule the next set of classes for ${studentName}.
        </p>
      </div>

      ${makeupCredits > 0 ? `
      <div style="background: #faf5ff; padding: 15px; border-radius: 8px; border-left: 4px solid #805ad5; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #553c9a;">
          <strong>🎫 Note:</strong> ${studentName} has ${makeupCredits} makeup credit${makeupCredits > 1 ? 's' : ''} available. These are bonus classes and will remain valid even after renewal.
        </p>
      </div>
      ` : ''}

      ${perSessionFee ? `
      <div style="background: #f7fafc; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; font-size: 14px; color: #4a5568;">
          <strong>💰 Per Session Fee:</strong> ${currency || '₹'}${perSessionFee}
        </p>
      </div>
      ` : ''}

      <p style="margin: 25px 0; font-size: 15px; color: #4a5568; line-height: 1.7;">
        To renew, simply reply to this email or contact us directly. We look forward to continuing ${studentName}'s learning journey! 😊
      </p>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568;">
        Warm regards,<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getClassCancelledEmail(data) {
  const { parentName, studentName, sessionDate, sessionTime, cancelledBy, reason, hasMakeupCredit } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f56565 0%, #c53030 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">📅</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Class Cancelled</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Session Update Notification</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        We wanted to inform you that <strong>${studentName}</strong>'s scheduled class has been cancelled.
      </p>

      <div style="background: #f7fafc; padding: 25px; border-radius: 12px; border-left: 4px solid #f56565; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #4a5568;">Scheduled Date:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${sessionDate}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Scheduled Time:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${sessionTime}</td></tr>
          <tr><td style="padding: 10px 0; color: #4a5568;">Cancelled By:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${cancelledBy}</td></tr>
          ${reason ? `<tr><td style="padding: 10px 0; color: #4a5568;">Reason:</td><td style="padding: 10px 0; font-weight: bold; color: #2d3748;">${reason}</td></tr>` : ''}
        </table>
      </div>

      ${hasMakeupCredit ? `
      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #38b2ac; margin: 20px 0;">
        <h3 style="margin: 0 0 10px; color: #234e52; font-size: 18px;">🎁 Makeup Credit Added!</h3>
        <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.6;">
          A makeup credit has been added to <strong>${studentName}</strong>'s account. You can use this credit during renewal to book an extra session. The credit will remain available until used.
        </p>
      </div>
      ` : ''}

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions, please don't hesitate to reach out to us.<br><br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getMakeupCreditAddedEmail(data) {
  const { parentName, studentName, reason, notes } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎁</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Missed Class & Extra Session Added</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">Excused Class Notification</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #2d3748;">
        Dear <strong>${parentName}</strong>,
      </p>
      <p style="margin: 0 0 25px; font-size: 15px; color: #4a5568; line-height: 1.6;">
        This is to inform you that <strong>${studentName}</strong> missed a class (excused absence). An extra session (makeup credit) has been added to their account for this missed class.<br><br>
        <strong>Please contact the teacher to schedule this missed session at your convenience.</strong>
      </p>

      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; border-left: 4px solid #38b2ac; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr><td style="padding: 10px 0; color: #234e52;">Credit Type:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">Excused Class / Makeup Session</td></tr>
          <tr><td style="padding: 10px 0; color: #234e52;">Reason:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">${reason || 'Excused by teacher'}</td></tr>
          ${notes ? `<tr><td style="padding: 10px 0; color: #234e52;">Notes:</td><td style="padding: 10px 0; font-weight: bold; color: #234e52;">${notes}</td></tr>` : ''}
          <tr><td style="padding: 10px 0; color: #234e52;">Status:</td><td style="padding: 10px 0; font-weight: bold; color: #38b2ac;">✅ Available</td></tr>
        </table>
      </div>

      <div style="background: #fffbeb; padding: 20px; border-radius: 12px; border-left: 4px solid #f59e0b; margin: 20px 0;">
        <h3 style="margin: 0 0 10px; color: #92400e; font-size: 16px;">📅 How to Use This Session</h3>
        <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
          This makeup session is available for you to book with the teacher. Please coordinate with your teacher to schedule the missed class at a mutually convenient time. The credit will remain in your account until used.
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6;">
        If you have any questions, please don't hesitate to reach out to us.<br><br>
        <strong style="color: #38b2ac;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: #f7fafc; border-radius: 12px; text-align: center;">
        <p style="margin: 0; color: #718096; font-size: 13px;">
          Made with ❤️ By Aaliya
        </p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function getCertificateEmail(data) {
  const { studentName, awardTitle, month, year, description } = data;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%); padding: 50px 30px; text-align: center;">
      <div style="font-size: 60px; margin-bottom: 10px;">🏆</div>
      <h1 style="margin: 0; color: #2d3748; font-size: 32px; font-weight: bold; text-shadow: 1px 1px 2px rgba(255,255,255,0.5);">Certificate of Achievement</h1>
      <p style="margin: 10px 0 0; color: #4a5568; font-size: 16px; font-weight: 600;">${monthNames[month - 1]} ${year}</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="margin: 0 0 20px; font-size: 16px; color: #4a5568; text-align: center;">
        This certificate is proudly presented to
      </p>
      <h2 style="margin: 0 0 30px; font-size: 32px; color: #667eea; text-align: center; font-weight: bold;">${studentName}</h2>

      <div style="background: linear-gradient(135deg, #FFD700 0%, #FFA500 100%); padding: 30px; border-radius: 15px; text-align: center; box-shadow: 0 8px 20px rgba(255, 215, 0, 0.4); margin: 30px 0;">
        <p style="margin: 0 0 10px; color: #2d3748; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Award</p>
        <h3 style="margin: 0; color: #2d3748; font-size: 28px; font-weight: bold; text-shadow: 1px 1px 2px rgba(255,255,255,0.5);">🌟 ${awardTitle} 🌟</h3>
      </div>

      ${description ? `
      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; border-left: 4px solid #667eea; margin: 25px 0;">
        <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.6;">
          ${description}
        </p>
      </div>
      ` : ''}

      <div style="text-align: center; margin: 30px 0; font-size: 36px;">
        ⭐ 🏆 🎖️ 👑 💎
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; line-height: 1.6; text-align: center;">
        Congratulations on your outstanding achievement!<br>
        <strong style="color: #667eea;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

function getMonthlyReportCardEmail(data) {
  const { assessmentId, studentName, month, year, skills, certificateTitle, performanceSummary, areasOfImprovement, teacherComments } = data;
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const skillsList = skills && skills.length > 0 ? skills : [];
  const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
  const certificateUrl = `${appUrl}/monthly-certificate.html?id=${assessmentId}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 700px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">📊</div>
      <h1 style="margin: 0; color: white; font-size: 32px; font-weight: bold;">Monthly Progress Report</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 18px; font-weight: 600;">${monthNames[month - 1]} ${year}</p>
    </div>

    <!-- Student Info -->
    <div style="padding: 30px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <p style="margin: 0 0 5px; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Student Name</p>
        <h2 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">${studentName}</h2>
      </div>

      ${certificateTitle ? `
      <!-- Certificate Award Notice & Download Button -->
      <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px; border: 2px solid #f59e0b;">
        <div style="font-size: 40px; margin-bottom: 10px;">🏆</div>
        <h3 style="margin: 0 0 10px; color: #92400e; font-size: 22px; font-weight: bold;">${certificateTitle}</h3>
        <p style="margin: 0 0 5px; color: #b45309; font-size: 14px;">Congratulations to</p>
        <p style="margin: 0 0 15px; color: #92400e; font-size: 20px; font-weight: bold; text-transform: uppercase;">${studentName}</p>
        <a href="${certificateUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 30px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);">
          📥 Download Certificate
        </a>
        <p style="margin: 15px 0 0; color: #92400e; font-size: 12px;">Click to view and download the full certificate as PDF</p>
      </div>
      ` : ''}

      ${skillsList.length > 0 ? `
      <!-- Skills Assessment -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📝</span> Skills Assessed This Month
        </h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          ${skillsList.map(skill => `
          <div style="background: #f7fafc; padding: 12px; border-radius: 8px; border-left: 4px solid #667eea; font-size: 14px; color: #4a5568; font-weight: 600;">
            ✓ ${skill}
          </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${performanceSummary ? `
      <!-- Performance Summary -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📈</span> Overall Performance Summary
        </h3>
        <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7;">
            ${performanceSummary}
          </p>
        </div>
      </div>
      ` : ''}

      ${areasOfImprovement ? `
      <!-- Areas of Improvement -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📌</span> Areas of Improvement
        </h3>
        <div style="background: #fff5f5; padding: 20px; border-radius: 10px; border-left: 4px solid #fc8181;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7;">
            ${areasOfImprovement}
          </p>
        </div>
      </div>
      ` : ''}

      ${teacherComments ? `
      <!-- Teacher's Comments -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #2d3748; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>💬</span> Teacher's Comments
        </h3>
        <div style="background: #fef5e7; padding: 20px; border-radius: 10px; border-left: 4px solid #f6ad55;">
          <p style="margin: 0; color: #2d3748; font-size: 15px; line-height: 1.7; font-style: italic;">
            "${teacherComments}"
          </p>
        </div>
      </div>
      ` : ''}

      <!-- Motivational Footer -->
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 10px; text-align: center; margin-top: 30px;">
        <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6; font-weight: 500;">
          🌟 Keep up the great work, ${studentName}! 🌟<br>
          <span style="font-size: 14px; opacity: 0.95;">We're proud of your progress and look forward to seeing you continue to grow!</span>
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; text-align: center; line-height: 1.6;">
        With love and encouragement,<br>
        <strong style="color: #667eea; font-size: 16px;">Team Fluent Feathers Academy</strong>
      </p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Google Review Request Email Template
function getGoogleReviewEmail(childName, isDemoParent) {
  const reviewUrl = 'https://g.page/r/CSbRitsYrJWOEBM/review';
  const greeting = isDemoParent
    ? `We hope ${childName} enjoyed the demo class at <strong>Fluent Feathers Academy</strong>!`
    : `Thank you for being a part of the <strong>Fluent Feathers Academy</strong> family! We love watching ${childName} grow and learn.`;
  const message = isDemoParent
    ? `Your feedback means the world to us and helps other parents discover our programs.`
    : `Your continued trust inspires us. A quick review from you would mean so much and help other parents discover our academy!`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">⭐</div>
      <h1 style="margin: 0; color: white; font-size: 26px; font-weight: bold;">We'd Love Your Feedback!</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.9); font-size: 15px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 30px; text-align: center;">
      <p style="font-size: 16px; color: #2d3748; line-height: 1.6; margin: 0 0 15px;">${greeting}</p>
      <p style="font-size: 15px; color: #4a5568; line-height: 1.6; margin: 0 0 25px;">${message}</p>
      <div style="margin: 25px 0;">
        <div style="font-size: 36px; letter-spacing: 5px; margin-bottom: 10px;">⭐⭐⭐⭐⭐</div>
        <p style="font-size: 14px; color: #718096; margin: 0;">Tap below to leave a quick Google review</p>
      </div>
      <a href="${reviewUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #4285f4 0%, #34a853 100%); color: white; padding: 16px 40px; border-radius: 30px; text-decoration: none; font-size: 18px; font-weight: 600; box-shadow: 0 4px 15px rgba(66,133,244,0.4);">
        📝 Leave a Google Review
      </a>
      <p style="font-size: 13px; color: #a0aec0; margin: 25px 0 0; line-height: 1.5;">It only takes a minute and makes a huge difference! 💜</p>
    </div>
    <div style="background: #f7fafc; padding: 20px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #a0aec0; font-size: 12px;">Fluent Feathers Academy By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

// ==================== DEMO FOLLOW-UP EMAIL TEMPLATES ====================

function getDemoFollowUp24hrEmail(data) {
  const { parentName, childName, programInterest } = data;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">💜</div>
      <h1 style="color: white; margin: 0; font-size: 26px;">Thank You for the Demo!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${parentName}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        It was wonderful classing <strong style="color: #B05D9E;">${childName}</strong> yesterday! We truly enjoyed the demo session and hope you and ${childName} did too.
      </p>
      <div style="background: #f7fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border-left: 4px solid #B05D9E;">
        <h3 style="color: #B05D9E; margin: 0 0 15px; font-size: 17px;">✨ What ${childName} Can Look Forward To</h3>
        <ul style="color: #4a5568; margin: 0; padding-left: 20px; line-height: 2;">
          <li>Personalized learning plan tailored to ${childName}'s level</li>
          <li>Fun, interactive sessions that build confidence</li>
          <li>Regular progress reports & assessments</li>
          <li>Homework support & practice materials</li>
          <li>Certificates & badges to celebrate achievements</li>
        </ul>
      </div>
      ${programInterest ? `<p style="font-size: 15px; color: #4a5568; line-height: 1.8;">Based on your interest in <strong>${programInterest}</strong>, we have some great options that would be perfect for ${childName}.</p>` : ''}
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        If you have any questions or would like to discuss the best plan for ${childName}, simply reply to this email. We're happy to help!
      </p>
      <p style="font-size: 16px; color: #2d3748; margin-top: 30px;">
        Warm regards,<br>
        <strong style="color: #B05D9E;">Aaliya</strong><br>
        <span style="color: #718096; font-size: 14px;">Fluent Feathers Academy</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

function getDemoFollowUp3DayEmail(data) {
  const { parentName, childName, programInterest } = data;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🌟</div>
      <h1 style="color: white; margin: 0; font-size: 26px;">We'd Love to Have ${childName} Back!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${parentName}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        Just checking in! We had such a wonderful time with <strong style="color: #667eea;">${childName}</strong> during the demo class. We wanted to share why parents love Fluent Feathers Academy:
      </p>
      <div style="margin: 25px 0;">
        <div style="display: flex; align-items: flex-start; gap: 15px; margin-bottom: 18px;">
          <span style="font-size: 28px;">📚</span>
          <div>
            <strong style="color: #2d3748;">Structured Curriculum</strong>
            <p style="margin: 5px 0 0; color: #718096; font-size: 14px;">Age-appropriate lessons designed to build skills progressively</p>
          </div>
        </div>
        <div style="display: flex; align-items: flex-start; gap: 15px; margin-bottom: 18px;">
          <span style="font-size: 28px;">🎯</span>
          <div>
            <strong style="color: #2d3748;">Small Batch Sizes</strong>
            <p style="margin: 5px 0 0; color: #718096; font-size: 14px;">Personal attention for every child to thrive at their own pace</p>
          </div>
        </div>
        <div style="display: flex; align-items: flex-start; gap: 15px; margin-bottom: 18px;">
          <span style="font-size: 28px;">📊</span>
          <div>
            <strong style="color: #2d3748;">Monthly Assessments</strong>
            <p style="margin: 5px 0 0; color: #718096; font-size: 14px;">Track your child's growth with detailed reports & certificates</p>
          </div>
        </div>
        <div style="display: flex; align-items: flex-start; gap: 15px;">
          <span style="font-size: 28px;">🏆</span>
          <div>
            <strong style="color: #2d3748;">Rewards & Recognition</strong>
            <p style="margin: 5px 0 0; color: #718096; font-size: 14px;">Badges, leaderboards & certificates keep children motivated</p>
          </div>
        </div>
      </div>
      ${programInterest ? `<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; margin: 25px 0;">
        <p style="margin: 0 0 5px; font-size: 14px; opacity: 0.9;">Recommended Program</p>
        <p style="margin: 0; font-size: 20px; font-weight: bold;">${programInterest}</p>
      </div>` : ''}
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        We have flexible scheduling options available. Reply to this email and we'll help you find the perfect slot for ${childName}!
      </p>
      <p style="font-size: 16px; color: #2d3748; margin-top: 30px;">
        Looking forward to hearing from you!<br><br>
        <strong style="color: #B05D9E;">Aaliya</strong><br>
        <span style="color: #718096; font-size: 14px;">Fluent Feathers Academy</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

function getDemoFollowUp7DayEmail(data) {
  const { parentName, childName, programInterest } = data;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎓</div>
      <h1 style="color: white; margin: 0; font-size: 26px;">${childName}'s Spot is Waiting!</h1>
      <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 14px;">Fluent Feathers Academy By Aaliya</p>
    </div>
    <div style="padding: 40px 30px;">
      <p style="font-size: 18px; color: #2d3748; margin-bottom: 20px;">Hi <strong>${parentName}</strong>,</p>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        It's been a week since <strong style="color: #f5576c;">${childName}</strong>'s demo class, and we wanted to reach out one last time. We truly believe ${childName} has great potential, and we'd love to be part of their learning journey!
      </p>
      <div style="background: #fff5f5; border: 2px solid #feb2b2; padding: 20px; border-radius: 12px; margin: 25px 0; text-align: center;">
        <p style="margin: 0 0 8px; font-size: 15px; color: #c53030; font-weight: 600;">⏰ Limited Slots Available</p>
        <p style="margin: 0; font-size: 14px; color: #742a2a;">Our batches fill up quickly. Enroll now to secure ${childName}'s preferred time slot!</p>
      </div>
      <div style="background: #f0fff4; padding: 20px; border-radius: 12px; margin: 25px 0;">
        <h3 style="color: #276749; margin: 0 0 15px; font-size: 16px;">🎁 What You Get When You Enroll</h3>
        <ul style="color: #2f855a; margin: 0; padding-left: 20px; line-height: 2;">
          <li>Flexible scheduling - choose days & times that work for you</li>
          <li>Makeup classes if you miss a session</li>
          <li>Access to homework, recordings & learning materials</li>
          <li>Parent portal to track progress anytime</li>
          <li>Free participation in academy events & competitions</li>
        </ul>
      </div>
      <p style="font-size: 16px; color: #4a5568; line-height: 1.8;">
        If you have any concerns or questions, I'd be happy to discuss them. Just reply to this email or message us - no pressure at all! 😊
      </p>
      <p style="font-size: 16px; color: #2d3748; margin-top: 30px;">
        Hope to see ${childName} soon!<br><br>
        <strong style="color: #B05D9E;">Aaliya</strong><br>
        <span style="color: #718096; font-size: 14px;">Fluent Feathers Academy</span>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

// Demo Assessment Email Template
function getDemoAssessmentEmail(data) {
  const { assessmentId, childName, childGrade, demoDate, skills, certificateTitle, performanceSummary, areasOfImprovement, teacherComments } = data;
  const skillsList = skills && skills.length > 0 ? skills : [];
  const formattedDate = demoDate ? new Date(demoDate).toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'Demo Class';
  const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
  const certificateUrl = `${appUrl}/demo-certificate.html?id=${assessmentId}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 700px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎯</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Demo Class Assessment Report</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 16px;">${formattedDate}</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px;">
      <!-- Child Info -->
      <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 20px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
        <p style="margin: 0 0 5px; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Student</p>
        <h2 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">${childName}</h2>
        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">${childGrade || ''}</p>
      </div>

      <!-- Thank You Message -->
      <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac; margin-bottom: 25px;">
        <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.7;">
          Thank you for attending the demo class with Fluent Feathers Academy! We were delighted to have ${childName} join us. Here's a summary of what we observed during the session.
        </p>
      </div>

      ${certificateTitle ? `
      <!-- Demo Certificate Award Notice & Download Button -->
      <div style="background: linear-gradient(135deg, #e6fffa 0%, #b2f5ea 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px; border: 2px solid #38b2ac;">
        <div style="font-size: 40px; margin-bottom: 10px;">🏆</div>
        <h3 style="margin: 0 0 10px; color: #234e52; font-size: 22px; font-weight: bold;">${certificateTitle}</h3>
        <p style="margin: 0 0 5px; color: #319795; font-size: 14px;">Congratulations to</p>
        <p style="margin: 0 0 15px; color: #234e52; font-size: 20px; font-weight: bold; text-transform: uppercase;">${childName}</p>
        <a href="${certificateUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 30px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(56, 178, 172, 0.4);">
          📥 Download Certificate
        </a>
        <p style="margin: 15px 0 0; color: #234e52; font-size: 12px;">Click to view and download the full certificate as PDF</p>
      </div>
      ` : ''}

      ${skillsList.length > 0 ? `
      <!-- Skills Observed -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📝</span> Skills Observed During Demo
        </h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          ${skillsList.map(skill => `
          <div style="background: #e6fffa; padding: 12px; border-radius: 8px; border-left: 4px solid #38b2ac; font-size: 14px; color: #234e52; font-weight: 600;">
            ✓ ${skill}
          </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      ${performanceSummary ? `
      <!-- Performance Summary -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>📈</span> Demo Session Summary
        </h3>
        <div style="background: #e6fffa; padding: 20px; border-radius: 10px; border-left: 4px solid #38b2ac;">
          <p style="margin: 0; color: #234e52; font-size: 15px; line-height: 1.7;">
            ${performanceSummary}
          </p>
        </div>
      </div>
      ` : ''}

      ${areasOfImprovement ? `
      <!-- Areas to Focus -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>🎯</span> Recommended Focus Areas
        </h3>
        <div style="background: #fefce8; padding: 20px; border-radius: 10px; border-left: 4px solid #eab308;">
          <p style="margin: 0; color: #713f12; font-size: 15px; line-height: 1.7;">
            ${areasOfImprovement}
          </p>
        </div>
      </div>
      ` : ''}

      ${teacherComments ? `
      <!-- Teacher's Comments -->
      <div style="margin-bottom: 30px;">
        <h3 style="color: #234e52; font-size: 20px; margin: 0 0 15px; display: flex; align-items: center; gap: 8px;">
          <span>💬</span> Teacher's Notes
        </h3>
        <div style="background: #faf5ff; padding: 20px; border-radius: 10px; border-left: 4px solid #B05D9E;">
          <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.7; font-style: italic;">
            "${teacherComments}"
          </p>
        </div>
      </div>
      ` : ''}

      <!-- Call to Action -->
      <div style="background: linear-gradient(135deg, #38b2ac 0%, #319795 100%); padding: 25px; border-radius: 10px; text-align: center; margin-top: 30px;">
        <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6; font-weight: 500;">
          🌟 We'd love to have ${childName} join our classes! 🌟<br>
          <span style="font-size: 14px; opacity: 0.95;">Contact us to enroll and continue this learning journey.</span>
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; text-align: center; line-height: 1.6;">
        With warm regards,<br>
        <strong style="color: #38b2ac; font-size: 16px;">Team Fluent Feathers Academy</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

// Event Participation Certificate Email Template
function getEventCertificateEmail(data) {
  const { childName, eventName, eventDate, certificateUrl } = data;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 700px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🏆</div>
      <h1 style="margin: 0; color: white; font-size: 28px; font-weight: bold;">Participation Certificate</h1>
      <p style="margin: 10px 0 0; color: rgba(255,255,255,0.95); font-size: 18px; font-weight: 600;">${eventName}</p>
    </div>

    <!-- Content -->
    <div style="padding: 30px;">
      <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); padding: 25px; border-radius: 12px; text-align: center; margin-bottom: 25px; border: 2px solid #f59e0b;">
        <div style="font-size: 40px; margin-bottom: 10px;">🎉</div>
        <h3 style="margin: 0 0 10px; color: #92400e; font-size: 22px; font-weight: bold;">${eventName}</h3>
        <p style="margin: 0 0 5px; color: #b45309; font-size: 14px;">Congratulations to</p>
        <p style="margin: 0 0 15px; color: #92400e; font-size: 20px; font-weight: bold; text-transform: uppercase;">${childName}</p>
        <p style="margin: 0 0 15px; color: #78716c; font-size: 13px;">${eventDate}</p>
        <a href="${certificateUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); color: white; text-decoration: none; padding: 14px 30px; border-radius: 30px; font-size: 16px; font-weight: 600; box-shadow: 0 4px 15px rgba(139, 92, 246, 0.4);">
          📥 Download Certificate
        </a>
        <p style="margin: 15px 0 0; color: #92400e; font-size: 12px;">Click to view and download the full certificate as PDF</p>
      </div>

      <div style="background: linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%); padding: 25px; border-radius: 10px; text-align: center; margin-top: 30px;">
        <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6; font-weight: 500;">
          🌟 Thank you for participating, ${childName}! 🌟<br>
          <span style="font-size: 14px; opacity: 0.95;">We hope you had a wonderful time and learned something new!</span>
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568; text-align: center; line-height: 1.6;">
        With love and encouragement,<br>
        <strong style="color: #8b5cf6; font-size: 16px;">Team Fluent Feathers Academy</strong>
      </p>
    </div>

    <!-- Footer -->
    <div style="background: #f7fafc; padding: 20px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">
        Made with ❤️ By Aaliya
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ==================== CLASS REMINDER CRON JOB ====================
// Runs every 15 minutes to check for upcoming classes
// Function to check and send class reminders (used by both cron and manual trigger)
async function checkAndSendReminders() {
  const now = new Date();
  console.log('🔔 Checking for upcoming classes to send reminders...');
  console.log(`⏰ Current server time (UTC): ${now.toISOString()}`);

  try {
    // Find all upcoming PRIVATE sessions
    // Use session_date >= CURRENT_DATE - 1 to catch sessions that might span across midnight UTC
    const privateSessions = await pool.query(`
      SELECT s.*, st.name as student_name, st.parent_email, st.parent_name, st.timezone, st.parent_timezone,
             pc.timezone as credential_timezone,
             CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(st.parent_email)
      WHERE s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Private'
        AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
    `);

    // NOTE: Removed auto-creation of session_attendance for group sessions.
    // The group scheduling endpoint (/api/schedule/group-classes) already creates
    // attendance records only for students with allocated sessions (per-student counts).
    // Auto-creating for ALL group students was overriding this and showing sessions
    // to students who weren't scheduled (e.g. students who didn't renew).

    // Find all upcoming GROUP sessions and get enrolled students via session_attendance
        const groupSessions = await pool.query(`
          SELECT s.*, g.group_name, g.timezone as group_timezone,
            st.name as student_name, st.parent_email, st.parent_name, st.timezone, st.parent_timezone,
             pc.timezone as credential_timezone,
             CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      JOIN session_attendance sa ON sa.session_id = s.id
      JOIN students st ON st.id = sa.student_id
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(st.parent_email)
      WHERE s.status IN ('Pending', 'Scheduled')
        AND s.session_type = 'Group'
        AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        AND st.is_active = true
        AND st.parent_email IS NOT NULL
        AND (sa.attendance IS NULL OR sa.attendance NOT IN ('Excused', 'Unexcused'))
    `);

    // Find all upcoming DEMO sessions
    const demoSessions = await pool.query(`
      SELECT id, child_name as student_name, parent_email, parent_name,
             demo_date as session_date, demo_time as session_time,
             CONCAT(demo_date, 'T', demo_time, 'Z') as full_datetime,
             1 as session_number, COALESCE(parent_timezone, student_timezone, 'Asia/Kolkata') as timezone,
             COALESCE(program_interest, 'Demo Class') as program_interest
      FROM demo_leads
      WHERE status IN ('Scheduled', 'Demo Scheduled', 'Pending')
        AND demo_date >= CURRENT_DATE - INTERVAL '1 day'
        AND parent_email IS NOT NULL
        AND demo_date IS NOT NULL AND demo_time IS NOT NULL
    `);

    // Combine all sessions - mark session types for identification
    const markedPrivateSessions = privateSessions.rows.map(s => ({ ...s, is_group: false, is_demo: false }));
    const markedGroupSessions = groupSessions.rows.map(s => ({ ...s, is_group: true, is_demo: false }));
    const markedDemoSessions = demoSessions.rows.map(s => ({ ...s, is_group: false, is_demo: true }));
    const upcomingSessions = { rows: [...markedPrivateSessions, ...markedGroupSessions, ...markedDemoSessions] };

    console.log(`📋 Found ${privateSessions.rows.length} private + ${groupSessions.rows.length} group + ${demoSessions.rows.length} demo = ${upcomingSessions.rows.length} total sessions to check for reminders`);

    for (const session of upcomingSessions.rows) {
      try {
        const sessionDateTime = new Date(session.full_datetime);
        const timeDiff = sessionDateTime - now;
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        // Skip past sessions
        if (hoursDiff < 0) continue;

        // Determine session type label for logging and emails
        const sessionTypeLabel = session.is_demo ? 'Demo' : session.is_group ? `Group (${session.group_name})` : 'Private';

        // Log session details for debugging
        console.log(`📌 ${sessionTypeLabel} Session #${session.session_number} for ${session.student_name}: ${session.full_datetime} (${hoursDiff.toFixed(2)} hours away)`);

        // Check if we need to send 5-hour reminder (widened window: 4.5 to 5.5 hours for reliability)
        if (hoursDiff > 4.5 && hoursDiff <= 5.5) {
          const emailType5hr = session.is_demo ? 'Reminder-5hrs-Demo' : session.is_group ? 'Reminder-5hrs-Group' : 'Reminder-5hrs';
          const sidCheck = session.is_demo ? `DEMO:${session.id}` : session.id;
          const scheduleKey5hr = String(session.full_datetime || '');
          console.log(`⏰ ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id}) is within 5-hour window, checking if reminder already sent...`);
          // Check if 5-hour reminder already sent for this SPECIFIC session using unique session ID
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
                AND email_type IN ('Reminder-5hrs', 'Reminder-5hrs-Group', 'Reminder-5hrs-Demo')
                AND status = 'Sent'
                AND subject LIKE $2
                AND subject LIKE $3`,
            [session.parent_email, `%[SID:${sidCheck}]%`, `%[UTC:${scheduleKey5hr}]%`]
          );

          if (sentCheck.rows.length === 0) {
            // Use parent timezone for parent-facing emails, fallback to student/group timezone
            const parentTimezone = pickPreferredTimezone(
              session.parent_timezone,
              session.credential_timezone,
              session.timezone,
              session.group_timezone
            );
            console.log(`📍 Using parent timezone: ${parentTimezone} for ${session.student_name}`);
            const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
            console.log(`📧 Converted time: ${localTime.date} ${localTime.time} (${localTime.day})`);
            const joinGateUrl5 = getJoinClassUrl(session.id, { isDemo: session.is_demo });
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              classLink: joinGateUrl5,
              hoursBeforeClass: 5,
              timezoneLabel: getTimezoneLabel(parentTimezone)
            });

            const subjectPrefix = session.is_demo ? `🎯 Demo Class Reminder` : session.is_group ? `⏰ Group Class Reminder (${session.group_name})` : '⏰ Class Reminder';
            const sidLabel = session.is_demo ? `DEMO:${session.id}` : session.id;
            const sent = await sendEmail(
              session.parent_email,
              `${subjectPrefix} - Ready for today's class in 5 hours [SID:${sidLabel}] [UTC:${scheduleKey5hr}]`,
              reminderEmailHTML,
              session.parent_name,
              emailType5hr,
              { skipPush: true }
            );
            const pushResult = await sendClassReminderPush(session, 5);
            if (session.is_demo) {
              await sendAdminDemoReminderPush(session, 5);
            }
            if ((pushResult?.sent || 0) > 0) {
              console.log(`✅ Sent 5-hour ${sessionTypeLabel} push reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            } else {
              console.warn(`⚠️ 5-hour ${sessionTypeLabel} push reminder skipped/failed for ${session.parent_email} (reason: ${pushResult?.reason || 'unknown'})`);
            }
            if (sent) {
              console.log(`✅ Sent 5-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            } else {
              console.warn(`⚠️ Failed to send 5-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            }
          } else {
            console.log(`⏭️ 5-hour reminder already sent for ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id})`);
          }
        }

        // Check if we need to send 1-hour reminder (widened window: 0.5 to 1.5 hours for reliability)
        if (hoursDiff > 0.5 && hoursDiff <= 1.5) {
          const emailType1hr = session.is_demo ? 'Reminder-1hr-Demo' : session.is_group ? 'Reminder-1hr-Group' : 'Reminder-1hr';
          const sidCheck1hr = session.is_demo ? `DEMO:${session.id}` : session.id;
          const scheduleKey1hr = String(session.full_datetime || '');
          console.log(`⏰ ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id}) is within 1-hour window, checking if reminder already sent...`);
          // Check if 1-hour reminder already sent for this SPECIFIC session using unique session ID
          const sentCheck = await pool.query(
            `SELECT id FROM email_log
             WHERE recipient_email = $1
                AND email_type IN ('Reminder-1hr', 'Reminder-1hr-Group', 'Reminder-1hr-Demo')
                AND status = 'Sent'
                AND subject LIKE $2
                AND subject LIKE $3`,
            [session.parent_email, `%[SID:${sidCheck1hr}]%`, `%[UTC:${scheduleKey1hr}]%`]
          );

          if (sentCheck.rows.length === 0) {
            // Use parent timezone for parent-facing emails, fallback to student/group timezone
            const parentTimezone = pickPreferredTimezone(
              session.parent_timezone,
              session.credential_timezone,
              session.timezone,
              session.group_timezone
            );
            console.log(`📍 Using parent timezone: ${parentTimezone} for ${session.student_name}`);
            const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
            console.log(`📧 Converted time: ${localTime.date} ${localTime.time} (${localTime.day})`);
            const joinGateUrl1 = getJoinClassUrl(session.id, { isDemo: session.is_demo });
            const reminderEmailHTML = getClassReminderEmail({
              studentName: session.student_name,
              localDate: localTime.date,
              localTime: localTime.time,
              localDay: localTime.day,
              classLink: joinGateUrl1,
              hoursBeforeClass: 1,
              timezoneLabel: getTimezoneLabel(parentTimezone)
            });

            const subjectPrefix1hr = session.is_demo ? `🎯 Demo Class Reminder` : session.is_group ? `⏰ Group Class Reminder (${session.group_name})` : '⏰ Class Reminder';
            const sidLabel1hr = session.is_demo ? `DEMO:${session.id}` : session.id;
            const sent = await sendEmail(
              session.parent_email,
              `${subjectPrefix1hr} - Ready for today's class in 1 hour [SID:${sidLabel1hr}] [UTC:${scheduleKey1hr}]`,
              reminderEmailHTML,
              session.parent_name,
              emailType1hr,
              { skipPush: true }
            );
            const pushResult = await sendClassReminderPush(session, 1);
            if (session.is_demo) {
              await sendAdminDemoReminderPush(session, 1);
            }
            if ((pushResult?.sent || 0) > 0) {
              console.log(`✅ Sent 1-hour ${sessionTypeLabel} push reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            } else {
              console.warn(`⚠️ 1-hour ${sessionTypeLabel} push reminder skipped/failed for ${session.parent_email} (reason: ${pushResult?.reason || 'unknown'})`);
            }
            if (sent) {
              console.log(`✅ Sent 1-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            } else {
              console.warn(`⚠️ Failed to send 1-hour ${sessionTypeLabel} reminder to ${session.parent_email} for Session #${session.session_number} (ID:${session.id})`);
            }
          } else {
            console.log(`⏭️ 1-hour reminder already sent for ${sessionTypeLabel} Session #${session.session_number} (ID:${session.id})`);
          }
        }
      } catch (sessionErr) {
        console.error(`Error processing session ${session.id}:`, sessionErr);
      }
    }
  } catch (err) {
    console.error('❌ Error in class reminder check:', err);
  }
}

// ==================== EVENT REMINDER SYSTEM ====================
// Sends reminder emails 30 minutes before events to all registered participants
async function checkAndSendEventReminders() {
  const now = new Date();
  console.log('🎉 Checking for upcoming events to send reminders...');

  try {
    // Find active events happening today or tomorrow (to cover timezone edge cases)
    const events = await pool.query(`
      SELECT * FROM events
      WHERE status = 'Active'
        AND event_date >= CURRENT_DATE
        AND event_date <= CURRENT_DATE + INTERVAL '1 day'
    `);

    if (events.rows.length === 0) return;

    for (const event of events.rows) {
      try {
        // Construct the event datetime in UTC
        const eventDateTime = new Date(`${event.event_date.toISOString().split('T')[0]}T${event.event_time}Z`);
        const timeDiff = eventDateTime - now;
        const minutesDiff = timeDiff / (1000 * 60);

        // Send reminder if event is 15-45 minutes away (window for 30-min reminder, checked every 15 min)
        if (minutesDiff > 15 && minutesDiff <= 45) {
          console.log(`⏰ Event "${event.event_name}" (ID:${event.id}) is ~30 min away, sending reminders...`);

          // Get all registered participants for this event
          const registrations = await pool.query(`
            SELECT er.*,
                   COALESCE(s.name, er.child_name) as display_child_name,
                   COALESCE(s.parent_email, er.email) as display_email,
                   COALESCE(s.parent_name, er.parent_name) as display_parent_name,
                   s.parent_timezone as student_parent_timezone,
                   s.timezone as student_timezone,
                   er.parent_timezone as registration_timezone,
                   pc.timezone as credential_timezone
            FROM event_registrations er
            LEFT JOIN students s ON er.student_id = s.id
            LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(COALESCE(s.parent_email, er.email))
            WHERE er.event_id = $1
          `, [event.id]);

          for (const reg of registrations.rows) {
            const email = reg.display_email;
            if (!email) continue;

            // Check if reminder already sent for this event + email combo
            const sentCheck = await pool.query(
              `SELECT id FROM email_log
               WHERE recipient_email = $1
                 AND email_type = 'Event-Reminder-30min'
                 AND status = 'Sent'
                 AND subject LIKE $2`,
              [email, `%[EID:${event.id}]%`]
            );

            if (sentCheck.rows.length > 0) continue;

            const participantTimezone = pickPreferredTimezone(
              reg.student_parent_timezone,
              reg.credential_timezone,
              reg.student_timezone,
              reg.registration_timezone
            );
            const localEvent = formatUTCToLocal(event.event_date, event.event_time, participantTimezone);
            const eventDate = `${localEvent.day}, ${localEvent.date}`;
            const formattedTime = `${localEvent.time} (${getTimezoneLabel(participantTimezone)})`;

            const emailHtml = getEventReminderEmail({
              childName: reg.display_child_name || 'Student',
              eventName: event.event_name,
              eventDate: eventDate,
              eventTime: formattedTime,
              eventDuration: event.event_duration,
              classLink: event.class_link
            });

            const sent = await sendEmail(
              email,
              `⏰ Starting Soon: ${event.event_name} - Join in 30 minutes! [EID:${event.id}]`,
              emailHtml,
              reg.display_parent_name || '',
              'Event-Reminder-30min'
            );
            if (sent) {
              console.log(`✅ Sent event reminder to ${email} for "${event.event_name}"`);
            } else {
              console.warn(`⚠️ Failed to send event reminder to ${email} for "${event.event_name}"`);
            }
          }
        }
      } catch (eventErr) {
        console.error(`Error processing event ${event.id}:`, eventErr);
      }
    }
  } catch (err) {
    console.error('❌ Error in event reminder check:', err);
  }
}

// Cron job to run reminders every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    await checkAndSendReminders();
    await checkAndSendEventReminders();
  } catch (err) {
    console.error('❌ Error in reminder cron job:', err);
  }
});

console.log('✅ Class & event reminder system initialized - checking every 15 minutes');

// ==================== BIRTHDAY REMINDER CRON JOB ====================
// Runs daily at 8:00 AM to check for birthdays
cron.schedule('0 8 * * *', async () => {
  try {
    console.log('🎂 Checking for birthdays today...');

    const today = new Date();
    const month = today.getMonth() + 1; // JavaScript months are 0-indexed
    const day = today.getDate();

    // Find students with birthday today
    const birthdayStudents = await pool.query(`
      SELECT id, name, parent_email, parent_name, date_of_birth
      FROM students
      WHERE EXTRACT(MONTH FROM date_of_birth) = $1
        AND EXTRACT(DAY FROM date_of_birth) = $2
        AND is_active = true
        AND date_of_birth IS NOT NULL
    `, [month, day]);

    for (const student of birthdayStudents.rows) {
      try {
        const birthYear = new Date(student.date_of_birth).getFullYear();
        const age = today.getFullYear() - birthYear;

        const birthdayEmailHTML = getBirthdayEmail({
          studentName: student.name,
          age: age
        });

        await sendEmail(
          student.parent_email,
          `🎉 Happy Birthday ${student.name}! 🎂`,
          birthdayEmailHTML,
          student.parent_name,
          'Birthday'
        );

        console.log(`✅ Sent birthday email to ${student.name} (${student.parent_email})`);
      } catch (emailErr) {
        console.error(`Error sending birthday email to ${student.name}:`, emailErr);
      }
    }

    if (birthdayStudents.rows.length === 0) {
      console.log('No birthdays today');
    }
  } catch (err) {
    console.error('❌ Error in birthday cron job:', err);
  }
});

console.log('✅ Birthday reminder system initialized - checking daily at 8:00 AM');

// ==================== PAYMENT RENEWAL REMINDER CRON JOB ====================
// Runs daily at 9:00 AM UTC to check for students with 2 or fewer sessions remaining
// Sends reminders at each level: 2 remaining, 1 remaining, and 0 remaining (slots releasing)
cron.schedule('0 9 * * *', async () => {
  try {
    console.log('💳 Checking for payment renewal reminders...');

    // Find students with 2 or fewer sessions remaining
    // Send reminder if: never reminded OR remaining count dropped since last reminder
    const lowSessionStudents = await pool.query(`
      SELECT s.id, s.name, s.parent_email, s.parent_name, s.remaining_sessions, s.program_name, s.per_session_fee, s.currency,
        s.renewal_reminder_sent, s.last_reminder_remaining,
        COUNT(DISTINCT m.id) as available_makeup_credits
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND LOWER(m.status) = 'available'
      WHERE s.is_active = true
        AND s.remaining_sessions <= 2
        AND s.parent_email IS NOT NULL
        AND s.parent_email != ''
      GROUP BY s.id
    `);

    let sentCount = 0;
    for (const student of lowSessionStudents.rows) {
      try {
        // Skip if already reminded at this exact remaining count
        const lastReminded = student.last_reminder_remaining;
        const current = student.remaining_sessions;
        if (lastReminded !== null && lastReminded !== undefined && lastReminded <= current) {
          continue; // Already sent reminder at this level or lower
        }

        const makeupCredits = parseInt(student.available_makeup_credits) || 0;

        // "0 remaining" can mean the final class is already scheduled, not actually finished.
        // Only send the slots-releasing email when the student has no unresolved sessions left.
        if (current === 0) {
          const unresolvedSessions = await pool.query(`
            SELECT 1
            FROM (
              SELECT s.id
              FROM sessions s
              WHERE s.student_id = $1
                AND s.session_type = 'Private'
                AND s.status IN ('Pending', 'Scheduled')

              UNION

              SELECT s.id
              FROM sessions s
              INNER JOIN session_attendance sa
                ON sa.session_id = s.id
               AND sa.student_id = $1
              WHERE s.session_type = 'Group'
                AND s.status IN ('Pending', 'Scheduled')
                AND COALESCE(sa.attendance, 'Pending') = 'Pending'
            ) unresolved
            LIMIT 1
          `, [student.id]);

          if (unresolvedSessions.rows.length > 0) {
            console.log(`⏭️ Skipping slots-releasing email for ${student.name}: unresolved session(s) still scheduled`);
            continue;
          }
        }

        // Use different email content for 0 remaining (slots releasing)
        let emailHTML, subject;
        if (current === 0) {
          emailHTML = getSlotsReleasingEmail({
            parentName: student.parent_name,
            studentName: student.name,
            programName: student.program_name,
            perSessionFee: student.per_session_fee,
            currency: student.currency,
            makeupCredits: makeupCredits
          });
          subject = `🚨 All Sessions Completed - Slots Releasing Soon for ${student.name}`;
        } else {
          emailHTML = getRenewalReminderEmail({
            parentName: student.parent_name,
            studentName: student.name,
            remainingSessions: current,
            programName: student.program_name,
            perSessionFee: student.per_session_fee,
            currency: student.currency,
            makeupCredits: makeupCredits
          });
          const sessionWord = current === 1 ? 'Session' : 'Sessions';
          subject = `⏰ Renewal Reminder - Only ${current} ${sessionWord} Left for ${student.name}`;
        }

        await sendEmail(
          student.parent_email,
          subject,
          emailHTML,
          student.parent_name,
          'Renewal-Reminder'
        );

        // Track which remaining count was last reminded at
        await pool.query('UPDATE students SET renewal_reminder_sent = true, last_reminder_remaining = $2 WHERE id = $1', [student.id, current]);
        sentCount++;

        console.log(`✅ Sent renewal reminder to ${student.parent_name} for ${student.name} (${current} sessions left, ${makeupCredits} makeup credits)`);
      } catch (emailErr) {
        console.error(`Error sending renewal reminder for ${student.name}:`, emailErr);
      }
    }

    console.log(sentCount > 0 ? `💳 Sent ${sentCount} renewal reminders` : 'No renewal reminders needed today');
  } catch (err) {
    console.error('❌ Error in payment renewal cron job:', err);
  }
});

console.log('✅ Payment renewal reminder system initialized - checking daily at 9:00 AM');

// Student of the Week - every Sunday at 10:30 AM IST (5:00 AM UTC)
cron.schedule('0 5 * * 0', () => awardStudentOfPeriod('week'));
// Student of the Month - 1st of each month at 10:30 AM IST
cron.schedule('0 5 1 * *', () => awardStudentOfPeriod('month'));
// Student of the Year - January 1st at 10:30 AM IST
cron.schedule('0 5 1 1 *', () => awardStudentOfPeriod('year'));
console.log('✅ Student awards system initialized - weekly (Sun), monthly (1st), yearly (Jan 1)');

// ==================== DEMO LEAD FOLLOW-UP CRON JOB ====================
// Runs every hour to check for demo leads that need follow-up emails
// 24hr thank-you, 3-day reminder, 7-day last nudge
async function checkAndSendDemoFollowUps() {
  try {
    console.log('📩 Checking for demo lead follow-ups...');

    // Get all completed/follow-up demo leads that haven't been converted or lost
    const completedLeads = await pool.query(`
      SELECT * FROM demo_leads
      WHERE status IN ('Completed', 'Follow Up')
        AND parent_email IS NOT NULL
        AND demo_date IS NOT NULL
    `);

    if (completedLeads.rows.length === 0) {
      console.log('No completed demo leads needing follow-up');
      return;
    }

    const now = new Date();
    let sentCount = 0;

    for (const lead of completedLeads.rows) {
      try {
        // Calculate hours since demo
        const demoDateTime = new Date(`${lead.demo_date.toISOString().split('T')[0]}T${lead.demo_time || '12:00:00'}Z`);
        const hoursSinceDemo = (now - demoDateTime) / (1000 * 60 * 60);

        // Skip if demo hasn't happened yet
        if (hoursSinceDemo < 0) continue;

        const emailData = {
          parentName: lead.parent_name,
          childName: lead.child_name,
          programInterest: lead.program_interest
        };

        // 24-hour follow-up (window: 20-28 hours after demo)
        if (hoursSinceDemo >= 20 && hoursSinceDemo <= 28) {
          const alreadySent = await pool.query(
            `SELECT id FROM email_log WHERE recipient_email = $1 AND email_type = 'Demo-FollowUp-24hr' AND subject LIKE $2`,
            [lead.parent_email, `%[DLID:${lead.id}]%`]
          );
          if (alreadySent.rows.length === 0) {
            await sendEmail(
              lead.parent_email,
              `💜 Thank you for the demo class, ${lead.parent_name}! [DLID:${lead.id}]`,
              getDemoFollowUp24hrEmail(emailData),
              lead.parent_name,
              'Demo-FollowUp-24hr'
            );
            console.log(`✅ Sent 24hr follow-up to ${lead.parent_email} for ${lead.child_name}`);
            sentCount++;
          }
        }

        // 3-day follow-up (window: 68-76 hours after demo)
        if (hoursSinceDemo >= 68 && hoursSinceDemo <= 76) {
          const alreadySent = await pool.query(
            `SELECT id FROM email_log WHERE recipient_email = $1 AND email_type = 'Demo-FollowUp-3Day' AND subject LIKE $2`,
            [lead.parent_email, `%[DLID:${lead.id}]%`]
          );
          if (alreadySent.rows.length === 0) {
            await sendEmail(
              lead.parent_email,
              `🌟 We'd love to have ${lead.child_name} back! [DLID:${lead.id}]`,
              getDemoFollowUp3DayEmail(emailData),
              lead.parent_name,
              'Demo-FollowUp-3Day'
            );
            console.log(`✅ Sent 3-day follow-up to ${lead.parent_email} for ${lead.child_name}`);
            sentCount++;
          }
        }

        // 7-day follow-up (window: 164-172 hours after demo)
        if (hoursSinceDemo >= 164 && hoursSinceDemo <= 172) {
          const alreadySent = await pool.query(
            `SELECT id FROM email_log WHERE recipient_email = $1 AND email_type = 'Demo-FollowUp-7Day' AND subject LIKE $2`,
            [lead.parent_email, `%[DLID:${lead.id}]%`]
          );
          if (alreadySent.rows.length === 0) {
            await sendEmail(
              lead.parent_email,
              `🎓 ${lead.child_name}'s spot is waiting! [DLID:${lead.id}]`,
              getDemoFollowUp7DayEmail(emailData),
              lead.parent_name,
              'Demo-FollowUp-7Day'
            );
            console.log(`✅ Sent 7-day follow-up to ${lead.parent_email} for ${lead.child_name}`);
            sentCount++;
          }
        }
      } catch (leadErr) {
        console.error(`Error processing follow-up for lead ${lead.id}:`, leadErr);
      }
    }

    console.log(sentCount > 0 ? `📩 Sent ${sentCount} demo follow-up emails` : 'No demo follow-ups needed right now');
  } catch (err) {
    console.error('❌ Error in demo follow-up cron job:', err);
  }
}

// Run demo follow-up check every hour
cron.schedule('30 * * * *', async () => {
  try {
    await checkAndSendDemoFollowUps();
  } catch (err) {
    console.error('❌ Error in demo follow-up cron:', err);
  }
});

console.log('✅ Demo lead follow-up system initialized - checking every hour');

// ==================== API ROUTES ====================

// Currency conversion rates to INR (approximate)
const currencyToINR = {
  INR: 1,
  USD: 83,
  GBP: 105,
  EUR: 90,
  AED: 22,
  SGD: 61,
  CAD: 61,
  SAR: 22,
  BDT: 0.71,
  AUD: 54
};

function convertToINR(amount, currency) {
  const rate = currencyToINR[currency] || currencyToINR[currency?.toUpperCase()] || 1;
  return amount * rate;
}

// ==================== ADMIN DASHBOARD CACHE ====================
let adminUpcomingCache = { data: null, ts: 0 };
let adminPastCache = { data: null, ts: 0 };
const ADMIN_UPCOMING_TTL_MS = 60 * 1000;      // 1 minute (refreshes quickly)
const ADMIN_PAST_TTL_MS = 3 * 60 * 1000;     // 3 minutes

function clearAdminDashboardCache() {
  adminUpcomingCache = { data: null, ts: 0 };
  adminPastCache = { data: null, ts: 0 };
}

app.get('/api/dashboard/stats', async (req, res) => {
  try {
    // Fire all independent queries in parallel for fast load
    const [
      countResult,
      paymentsResult,
      sess,
      g,
      e,
      hw
    ] = await Promise.all([
      executeQuery('SELECT COUNT(*) as total FROM students WHERE is_active = true'),
      executeQuery(`
        SELECT payment_date, amount, currency FROM payment_history
        UNION ALL
        SELECT pr.renewal_date as payment_date, pr.amount, pr.currency
        FROM payment_renewals pr
        WHERE NOT EXISTS (
          SELECT 1 FROM payment_history ph2
          WHERE ph2.student_id = pr.student_id
            AND ph2.payment_date = pr.renewal_date
            AND ph2.amount = pr.amount
            AND ph2.notes LIKE '%Renewal%'
        )
      `),
      executeQuery(`SELECT COUNT(*) as upcoming FROM sessions WHERE status IN ('Pending', 'Scheduled') AND session_date >= CURRENT_DATE`),
      executeQuery('SELECT COUNT(*) as total FROM groups'),
      executeQuery(`SELECT COUNT(*) as total FROM events WHERE status = 'Active'`),
      executeQuery(`SELECT COUNT(*) as pending FROM materials WHERE uploaded_by IN ('Parent', 'Admin') AND file_type = 'Homework' AND (feedback_grade IS NULL OR feedback_grade = '')`)
    ]);

    const monthlyRevenue = {};
    let totalRevenueINR = 0;
    for (const payment of paymentsResult.rows) {
      const amount = parseFloat(payment.amount) || 0;
      const currency = payment.currency || 'INR';
      const inrAmount = convertToINR(amount, currency);
      totalRevenueINR += inrAmount;
      try {
        const paidDate = payment.payment_date ? new Date(payment.payment_date) : new Date();
        const monthKey = `${paidDate.getFullYear()}-${String(paidDate.getMonth() + 1).padStart(2, '0')}`;
        if (!monthlyRevenue[monthKey]) monthlyRevenue[monthKey] = 0;
        monthlyRevenue[monthKey] += inrAmount;
      } catch (e) { /* skip invalid dates */ }
    }

    // These two may fail on tables not yet created — run after main parallel batch
    let pendingChallenges = 0;
    let pendingAssessments = 0;
    await Promise.all([
      executeQuery(`SELECT COUNT(*) as pending FROM student_challenges WHERE status = 'Submitted'`)
        .then(ch => { pendingChallenges = parseInt(ch.rows[0].pending) || 0; })
        .catch(() => {}),
      executeQuery(`
        SELECT COUNT(*) as count FROM (
          SELECT s.id,
            COALESCE(s.completed_sessions, 0) as completed,
            COALESCE(s.remaining_sessions, 0) as remaining,
            COALESCE((SELECT COUNT(*) FROM monthly_assessments ma WHERE ma.student_id = s.id AND ma.assessment_type = 'monthly'), 0) as total_assessments
          FROM students s WHERE s.is_active = true
        ) sub
        WHERE (sub.completed - (sub.total_assessments * 7)) >= 7
          OR (sub.remaining <= 2 AND (sub.completed - (sub.total_assessments * 7)) >= 3)
      `)
        .then(ar => { pendingAssessments = parseInt(ar.rows[0].count) || 0; })
        .catch(e => { console.error('Assessment count error:', e.message); })
    ]);

    res.json({
      totalStudents: parseInt(countResult.rows[0].total)||0,
      totalRevenue: Math.round(totalRevenueINR),
      monthlyRevenue: Object.entries(monthlyRevenue)
        .sort()
        .reduce((acc, [month, revenue]) => { acc[month] = Math.round(revenue); return acc; }, {}),
      upcomingSessions: parseInt(sess.rows[0].upcoming)||0,
      totalGroups: parseInt(g.rows[0].total)||0,
      activeEvents: parseInt(e.rows[0].total)||0,
      pendingHomework: parseInt(hw.rows[0].pending)||0,
      pendingChallenges,
      pendingAssessments
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

// Calendar API - Get all sessions for a date range
app.get('/api/calendar/sessions', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'Start and end dates required' });
    }

    // Get private sessions (student_id set, no group_id - these are 1-on-1 sessions)
    const privateSessions = await pool.query(`
      SELECT s.id, s.student_id, s.group_id, s.session_date, s.session_time, s.session_number, s.status,
             'Private' as session_type,
             st.name as student_name
      FROM sessions s
      JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL
        AND s.group_id IS NULL
        AND s.session_date >= $1 AND s.session_date <= $2
        AND COALESCE(s.status, 'Scheduled') NOT IN ('Cancelled', 'Cancelled by Parent')
      ORDER BY s.session_date, s.session_time
    `, [start, end]);

    // Get group sessions (group_id set - these are group classes)
    const groupSessions = await pool.query(`
      SELECT s.id, s.student_id, s.group_id, s.session_date, s.session_time, s.session_number, s.status,
             'Group' as session_type,
             g.group_name as student_name
      FROM sessions s
      JOIN groups g ON s.group_id = g.id
      WHERE s.group_id IS NOT NULL
        AND s.session_date >= $1 AND s.session_date <= $2
        AND COALESCE(s.status, 'Scheduled') NOT IN ('Cancelled', 'Cancelled by Parent')
      ORDER BY s.session_date, s.session_time
    `, [start, end]);

    // Get demo sessions (show all statuses except not interested so conducted and converted demos stay visible)
    const demoSessions = await pool.query(`
      SELECT id, demo_date as session_date, demo_time as session_time,
             1 as session_number, status, 'Demo' as session_type,
             child_name as student_name
      FROM demo_leads
      WHERE demo_date >= $1 AND demo_date <= $2
        AND status NOT IN ('Not Interested')
      ORDER BY demo_date, demo_time
    `, [start, end]);

    const allSessions = [
      ...privateSessions.rows,
      ...groupSessions.rows,
      ...demoSessions.rows
    ];

    res.json(allSessions);
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/upcoming-classes', async (req, res) => {
  // Serve from cache if fresh
  if (adminUpcomingCache.data && (Date.now() - adminUpcomingCache.ts) < ADMIN_UPCOMING_TTL_MS) {
    res.set('X-Cache', 'HIT');
    return res.json(adminUpcomingCache.data);
  }
  try {
    // Fire all 4 independent queries in parallel
    const [priv, grp, events, demos] = await Promise.all([
      executeQuery(`
        SELECT s.*, st.name as student_name, st.timezone, s.session_number,
        CONCAT(st.program_name, ' - ', st.duration) as class_info,
        'Private' as display_type,
        COALESCE(s.class_link, $1) as class_link
        FROM sessions s
        JOIN students st ON s.student_id = st.id
        WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Private'
          AND st.is_active = true
          AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        ORDER BY s.session_date ASC, s.session_time ASC
      `, [DEFAULT_CLASS]),
      executeQuery(`
        SELECT s.*, g.group_name as student_name, g.timezone, s.session_number,
        CONCAT(g.program_name, ' - ', g.duration) as class_info,
        'Group' as display_type,
        COALESCE(s.class_link, $1) as class_link
        FROM sessions s
        JOIN groups g ON s.group_id = g.id
        WHERE s.status IN ('Pending', 'Scheduled') AND s.session_type = 'Group'
          AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
        ORDER BY s.session_date ASC, s.session_time ASC
      `, [DEFAULT_CLASS]),
      executeQuery(`
        SELECT id,
          event_name as student_name,
          event_date as session_date,
          event_time as session_time,
          event_duration as class_info,
          'Asia/Kolkata' as timezone,
          0 as session_number,
          'Event' as display_type,
          'Event' as session_type,
          COALESCE(e.class_link, '') as class_link
        FROM events e
        WHERE status = 'Active'
          AND event_date >= CURRENT_DATE - INTERVAL '1 day'
        ORDER BY event_date ASC, event_time ASC
      `),
      executeQuery(`
        SELECT id,
          child_name || ' (DEMO)' as student_name,
          demo_date as session_date,
          demo_time as session_time,
          COALESCE(program_interest, 'Demo Class') as class_info,
          'Asia/Kolkata' as timezone,
          0 as session_number,
          'Demo' as display_type,
          'Demo' as session_type,
          $1 as class_link
        FROM demo_leads
        WHERE status = 'Scheduled' AND demo_date IS NOT NULL
          AND demo_date >= CURRENT_DATE - INTERVAL '1 day'
        ORDER BY demo_date ASC, demo_time ASC
      `, [DEFAULT_CLASS])
    ]);

    // Combine all
    const all = [...priv.rows, ...grp.rows, ...events.rows, ...demos.rows];

    // Filter and sort by UTC datetime (since database stores UTC)
    const now = new Date();
    // Keep classes visible for 40 minutes after start time
    const cutoffTime = new Date(now.getTime() - (40 * 60 * 1000));
    const upcoming = all.filter(session => {
      try {
        // Parse date - handle both Date objects and strings
        let dateStr = session.session_date;
        if (dateStr instanceof Date) {
          dateStr = dateStr.toISOString().split('T')[0];
        } else if (typeof dateStr === 'string' && dateStr.includes('T')) {
          dateStr = dateStr.split('T')[0];
        }

        // Parse time
        let timeStr = session.session_time || '00:00:00';
        if (typeof timeStr === 'string') {
          timeStr = timeStr.substring(0, 8);
        }

        const sessionDateTime = new Date(`${dateStr}T${timeStr}Z`);
        // Show classes until 40 minutes after their start time
        return sessionDateTime >= cutoffTime;
      } catch (e) {
        console.error('Error parsing session date/time:', e);
        return false;
      }
    }).sort((a, b) => {
      try {
        // Get date strings
        let dateA = a.session_date;
        let dateB = b.session_date;
        if (dateA instanceof Date) dateA = dateA.toISOString().split('T')[0];
        else if (typeof dateA === 'string' && dateA.includes('T')) dateA = dateA.split('T')[0];
        if (dateB instanceof Date) dateB = dateB.toISOString().split('T')[0];
        else if (typeof dateB === 'string' && dateB.includes('T')) dateB = dateB.split('T')[0];

        // Get time strings
        let timeA = a.session_time || '00:00:00';
        let timeB = b.session_time || '00:00:00';
        if (typeof timeA === 'string') timeA = timeA.substring(0, 8);
        if (typeof timeB === 'string') timeB = timeB.substring(0, 8);

        const dtA = new Date(`${dateA}T${timeA}Z`);
        const dtB = new Date(`${dateB}T${timeB}Z`);
        return dtA - dtB;
      } catch (e) {
        console.error('Error sorting sessions:', e);
        return 0;
      }
    }).slice(0, 9); // Show 9 upcoming classes

   // For group sessions, fetch enrolled students with their attendance/cancellation status
   const groupSessionIds = upcoming.filter(s => s.display_type === 'Group').map(s => s.id);
   if (groupSessionIds.length > 0) {
     const studentRows = await executeQuery(`
       SELECT sa.session_id, sa.attendance, st.name as student_name, st.id as student_id
       FROM session_attendance sa
       JOIN students st ON sa.student_id = st.id
       WHERE sa.session_id = ANY($1)
       ORDER BY st.name
     `, [groupSessionIds]);

     // Build a map of session_id -> students
     const studentMap = {};
     for (const row of studentRows.rows) {
       if (!studentMap[row.session_id]) studentMap[row.session_id] = [];
       studentMap[row.session_id].push({
         name: row.student_name,
         student_id: row.student_id,
         attendance: row.attendance
       });
     }

     // Attach students to each group session
     for (const cls of upcoming) {
       if (cls.display_type === 'Group') {
         cls.enrolled_students = studentMap[cls.id] || [];
       }
     }
   }

   // SUCCESS
  const upcomingResp = { success: true, classes: upcoming };
  adminUpcomingCache = { data: upcomingResp, ts: Date.now() };
res.json(upcomingResp);

  } catch (err) {
    console.error('Error loading upcoming classes:', err);
    // ERROR
  const errResp = { success: false, classes: [] };
  adminUpcomingCache = { data: errResp, ts: Date.now() - ADMIN_UPCOMING_TTL_MS + 10000 }; // retry in 10s
res.status(500).json(errResp);

  }
});

// ==================== DEMO LEADS API ====================
// Get all demo leads
app.get('/api/demo-leads', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM demo_leads ORDER BY created_at DESC');
    // Attach follow-up status for each lead
    const leads = r.rows;
    if (leads.length > 0) {
      const followUpLogs = await pool.query(
        `SELECT email_type, subject FROM email_log WHERE email_type LIKE 'Demo-FollowUp%'`
      );
      for (const lead of leads) {
        const leadLogs = followUpLogs.rows.filter(log => log.subject && log.subject.includes(`[DLID:${lead.id}]`));
        lead.followup_24hr = leadLogs.some(l => l.email_type === 'Demo-FollowUp-24hr');
        lead.followup_3day = leadLogs.some(l => l.email_type === 'Demo-FollowUp-3Day');
        lead.followup_7day = leadLogs.some(l => l.email_type === 'Demo-FollowUp-7Day');
      }
    }
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new demo lead
app.post('/api/demo-leads', async (req, res) => {
  const { child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, student_timezone, parent_timezone, source, notes, send_email } = req.body;
  try {
    // Demo schedule is entered by admin in IST
    const studentTimezone = 'Asia/Kolkata';
    const parentTimezone = parent_timezone || studentTimezone || 'Asia/Kolkata';

    // Convert demo date/time to UTC
    let utcDate = demo_date;
    let utcTime = demo_time;
    if (demo_date && demo_time) {
      const utc = istToUTC(demo_date, demo_time, studentTimezone);
      utcDate = utc.date;
      utcTime = utc.time;
    }

    const r = await pool.query(`
      INSERT INTO demo_leads (child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, student_timezone, parent_timezone, source, notes, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Scheduled')
      RETURNING *
    `, [child_name, child_grade, parent_name, parent_email, phone, program_interest, utcDate, utcTime, studentTimezone, parentTimezone, source, notes]);

    let emailSent = false;

    // Send demo confirmation email if requested
    if (send_email && parent_email && demo_date && demo_time) {
      try {
        // Get admin settings (bio, name, title)
        const settingsResult = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
        const settings = {};
        settingsResult.rows.forEach(row => {
          settings[row.setting_key] = row.setting_value;
        });

        const parentLocal = formatUTCToLocal(utcDate, utcTime, parentTimezone);

        const emailHtml = getDemoConfirmationEmail({
          parentName: parent_name || 'Parent',
          childName: child_name,
          demoDate: parentLocal.date,
          demoTime: parentLocal.time,
          parentDemoDate: parentLocal.date,
          parentDemoTime: parentLocal.time,
          parentTimezoneLabel: getTimezoneLabel(parentTimezone),
          programInterest: program_interest || 'English Communication',
          adminName: settings.admin_name || 'Aaliya',
          adminTitle: settings.admin_title || 'Founder & Lead Instructor',
          adminBio: settings.admin_bio || '',
          classLink: DEFAULT_CLASS
        });

        emailSent = await sendEmail(
          parent_email,
          `🎉 Demo Class Confirmed for ${child_name} - Fluent Feathers Academy`,
          emailHtml,
          parent_name,
          'Demo Confirmation'
        );
      } catch (emailErr) {
        console.error('Demo email error:', emailErr);
      }
    }

    res.json({
      success: true,
      lead: r.rows[0],
      message: emailSent ? 'Demo scheduled and confirmation email sent!' : 'Demo scheduled successfully!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update demo lead status
app.put('/api/demo-leads/:id/status', async (req, res) => {
  const { status, notes } = req.body;
  try {
    const existingNotes = await pool.query('SELECT notes FROM demo_leads WHERE id = $1', [req.params.id]);
    const updatedNotes = existingNotes.rows[0]?.notes
      ? existingNotes.rows[0].notes + '\n[' + new Date().toLocaleDateString() + '] ' + status + (notes ? ': ' + notes : '')
      : notes || '';

    await pool.query(
      'UPDATE demo_leads SET status = $1, notes = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [status, updatedNotes, req.params.id]
    );
    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update demo lead details (edit)
app.put('/api/demo-leads/:id', async (req, res) => {
  const { child_name, child_grade, parent_name, parent_email, phone, program_interest, demo_date, demo_time, student_timezone, parent_timezone, source, status, notes, send_email } = req.body;

  try {
    // Demo schedule is entered by admin in IST
    const studentTimezone = 'Asia/Kolkata';
    const parentTimezone = parent_timezone || studentTimezone || 'Asia/Kolkata';

    // Get original lead data for comparison
    const originalLead = await pool.query('SELECT * FROM demo_leads WHERE id = $1', [req.params.id]);
    if (originalLead.rows.length === 0) {
      return res.status(404).json({ error: 'Demo lead not found' });
    }
    const original = originalLead.rows[0];

    // Convert demo date/time to UTC for storage
    let utcDate = demo_date;
    let utcTime = demo_time;
    if (demo_date && demo_time) {
      const utc = istToUTC(demo_date, demo_time, studentTimezone);
      utcDate = utc.date;
      utcTime = utc.time;
    }

    // Update the demo lead
    const r = await pool.query(`
      UPDATE demo_leads
      SET child_name = $1, child_grade = $2, parent_name = $3, parent_email = $4,
          phone = $5, program_interest = $6, demo_date = $7, demo_time = $8,
          student_timezone = $9, parent_timezone = $10,
          source = $11, status = $12, notes = $13, updated_at = CURRENT_TIMESTAMP
      WHERE id = $14
      RETURNING *
    `, [child_name, child_grade, parent_name, parent_email, phone, program_interest, utcDate, utcTime, studentTimezone, parentTimezone, source, status, notes, req.params.id]);

    // Send updated confirmation email if requested and date/time changed
    let emailSent = false;
    if (send_email && parent_email && (original.demo_date !== utcDate || original.demo_time !== utcTime || original.student_timezone !== studentTimezone || original.parent_timezone !== parentTimezone)) {
      try {
        // Get admin settings for email
        const settingsResult = await pool.query('SELECT setting_key, setting_value FROM admin_settings');
        const settings = {};
        settingsResult.rows.forEach(row => {
          settings[row.setting_key] = row.setting_value;
        });

        const parentLocal = formatUTCToLocal(utcDate, utcTime, parentTimezone);

        const emailHtml = getDemoConfirmationEmail({
          parentName: parent_name || 'Parent',
          childName: child_name,
          demoDate: parentLocal.date,
          demoTime: parentLocal.time,
          parentDemoDate: parentLocal.date,
          parentDemoTime: parentLocal.time,
          parentTimezoneLabel: getTimezoneLabel(parentTimezone),
          programInterest: program_interest || 'English Communication',
          adminName: settings.admin_name || 'Aaliya',
          adminTitle: settings.admin_title || 'Founder & Lead Instructor',
          adminBio: settings.admin_bio || '',
          classLink: DEFAULT_CLASS
        });

        emailSent = await sendEmail(
          parent_email,
          `📅 Updated Demo Class Details for ${child_name} - Fluent Feathers Academy`,
          emailHtml,
          parent_name,
          'Demo Reschedule'
        );
      } catch (emailErr) {
        console.error('Demo update email error:', emailErr);
      }
    }

    res.json({
      success: true,
      lead: r.rows[0],
      message: emailSent ? 'Demo details updated and confirmation email sent!' : 'Demo details updated successfully!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convert demo lead to permanent student
app.post('/api/demo-leads/:id/convert', async (req, res) => {
  const { program_name, duration, per_session_fee, currency, total_sessions, amount_paid, payment_method, timezone, parent_timezone, send_welcome_email, class_type, group_id, is_summer_camp } = req.body;
  try {
    // Get demo lead info
    const lead = await pool.query('SELECT * FROM demo_leads WHERE id = $1', [req.params.id]);
    if (lead.rows.length === 0) {
      return res.status(404).json({ error: 'Demo lead not found' });
    }
    const demoLead = lead.rows[0];

    // Get group info if group student
    let groupName = null;
    if (class_type === 'Group' && group_id) {
      const group = await pool.query('SELECT group_name FROM groups WHERE id = $1', [group_id]);
      if (group.rows.length > 0) groupName = group.rows[0].group_name;
    }

    const studentTimezone = timezone || demoLead.student_timezone || 'Asia/Kolkata';
    const parentTimezone = parent_timezone || demoLead.parent_timezone || studentTimezone || 'Asia/Kolkata';

    // Create new student from demo lead
    const studentResult = await pool.query(`
      INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, timezone, parent_timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, payment_method, is_active, group_id, group_name, is_summer_camp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $13, $14, $15, true, $16, $17, $18)
      RETURNING *
    `, [demoLead.child_name, demoLead.child_grade, demoLead.parent_name, demoLead.parent_email, demoLead.phone, studentTimezone, parentTimezone, program_name, class_type || 'Private', duration, currency, per_session_fee, total_sessions, amount_paid, payment_method, group_id || null, groupName, is_summer_camp || false]);

    const newStudent = studentResult.rows[0];

    // Record the payment in payment_history table
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, 'Initial payment - converted from demo', 'Paid')
    `, [newStudent.id, amount_paid, currency, payment_method, String(total_sessions)]);

    // Update demo lead status to Converted
    await pool.query(
      'UPDATE demo_leads SET status = $1, converted_student_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      ['Converted', newStudent.id, req.params.id]
    );

    // Send emails if requested
    if (send_welcome_email) {
      try {
        // Send payment confirmation email
        const paymentEmailHTML = getPaymentConfirmationEmail({
          parentName: demoLead.parent_name,
          studentName: demoLead.child_name,
          amount: amount_paid,
          currency: currency,
          paymentType: 'Initial Enrollment',
          sessionsAdded: total_sessions,
          paymentMethod: payment_method,
          receiptNumber: `FFA-${Date.now()}`
        });

        await sendEmail(
          demoLead.parent_email,
          `💳 Payment Confirmation - ${demoLead.child_name}`,
          paymentEmailHTML,
          demoLead.parent_name,
          'Payment Confirmation'
        );

        // Send welcome email
        const welcomeEmailHTML = getWelcomeEmail({
          parent_name: demoLead.parent_name,
          student_name: demoLead.child_name,
          program_name,
          class_link: DEFAULT_CLASS
        });

        await sendEmail(
          demoLead.parent_email,
          `🎉 Welcome to Fluent Feathers Academy - ${demoLead.child_name}`,
          welcomeEmailHTML,
          demoLead.parent_name,
          'Welcome'
        );
      } catch (emailErr) {
        console.error('Failed to send emails:', emailErr);
      }
    }

    res.json({ success: true, message: 'Demo lead converted to student', student: newStudent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete demo lead
app.delete('/api/demo-leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM demo_leads WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Demo lead deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STUDENTS API ====================
app.get('/api/students', async (req, res) => {
  try {
    const r = await executeQuery(`
      SELECT s.*,
        COUNT(DISTINCT m.id) as makeup_credits,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions,
        (SELECT MAX(created_at) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as last_assessment_date,
        (SELECT COUNT(*) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as total_assessments,
        CASE WHEN EXISTS (SELECT 1 FROM parent_fcm_tokens WHERE parent_email = s.parent_email) THEN true ELSE false END as parent_push_enabled
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
      WHERE s.is_active = true
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);

    // Calculate assessment due status for each student
    // Due for assessment if: completed 7+ sessions since last assessment (or 7+ total if never assessed)
    // Also due if remaining_sessions <= 2 and they have sessions since last assessment (end-of-package assessment)
    const studentsWithAssessmentStatus = r.rows.map(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;
      const remainingSessions = student.remaining_sessions || 0;

      // Sessions since last assessment = completed - (assessments * 7)
      // This assumes each assessment covers ~7 sessions
      const sessionsAccountedFor = totalAssessments * 7;
      const sessionsSinceAssessment = Math.max(0, completedSessions - sessionsAccountedFor);

      // Assessment is due if:
      // 1. Regular cycle: 7+ sessions since last assessment
      // 2. End-of-package: remaining sessions <= 2 AND at least 3 unassessed sessions
      const regularDue = sessionsSinceAssessment >= 7;
      const endOfPackageDue = remainingSessions <= 2 && sessionsSinceAssessment >= 3;

      return {
        ...student,
        assessment_due: regularDue || endOfPackageDue,
        sessions_since_assessment: sessionsSinceAssessment
      };
    });

    res.json(studentsWithAssessmentStatus);
  } catch (err) {
    console.error('Students list error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

// Get students due for monthly assessment (7+ sessions since last assessment OR remaining <= 2 with unassessed sessions)
app.get('/api/students/due-for-assessment', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.grade, s.date_of_birth, s.program_name, s.completed_sessions, s.remaining_sessions, s.parent_name,
        (SELECT COUNT(*) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as total_assessments,
        (SELECT MAX(created_at) FROM monthly_assessments WHERE student_id = s.id AND assessment_type = 'monthly') as last_assessment_date
      FROM students s
      WHERE s.is_active = true
      ORDER BY s.completed_sessions DESC
    `);

    // Filter to only students due for assessment
    const dueStudents = r.rows.filter(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;
      const remainingSessions = student.remaining_sessions || 0;
      const sessionsAccountedFor = totalAssessments * 7;
      const sessionsSinceAssessment = Math.max(0, completedSessions - sessionsAccountedFor);
      const regularDue = sessionsSinceAssessment >= 7;
      const endOfPackageDue = remainingSessions <= 2 && sessionsSinceAssessment >= 3;
      return regularDue || endOfPackageDue;
    }).map(student => {
      const completedSessions = student.completed_sessions || 0;
      const totalAssessments = parseInt(student.total_assessments) || 0;
      const sessionsAccountedFor = totalAssessments * 7;
      return {
        ...student,
        sessions_since_assessment: Math.max(0, completedSessions - sessionsAccountedFor)
      };
    });

    res.json(dueStudents);
  } catch (err) {
    console.error('Due for assessment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, parent_timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, date_of_birth, payment_method, send_email } = req.body;
  try {
    const studentTimezone = timezone || 'Asia/Kolkata';
    const parentTimezone = parent_timezone || studentTimezone;
    const r = await pool.query(`
      INSERT INTO students (name, grade, parent_name, parent_email, primary_contact, alternate_contact, timezone, parent_timezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, completed_sessions, remaining_sessions, fees_paid, date_of_birth, payment_method, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $14, 0, $15, $16, true)
      RETURNING id
    `, [name, grade, parent_name, parent_email, primary_contact, alternate_contact, studentTimezone, parentTimezone, program_name, class_type, duration, currency, per_session_fee, total_sessions, date_of_birth, payment_method]);

    let emailSent = false;
    if (send_email !== false) {  // Send email by default unless explicitly set to false
      emailSent = await sendEmail(
        parent_email,
        `🎓 Welcome to Fluent Feathers Academy - ${name}`,
        getWelcomeEmail({ parent_name, student_name: name, program_name, class_link: DEFAULT_CLASS }),
        parent_name,
        'Welcome'
      );
    }

    res.json({ success: true, studentId: r.rows[0].id, emailSent: emailSent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const studentId = req.params.id;
    const permanent = req.query.permanent === 'true';

    // Get session IDs for this student (to clean up session_materials)
    const studentSessions = await executeQuery('SELECT id FROM sessions WHERE student_id = $1', [studentId]);
    const sessionIds = studentSessions.rows.map(s => s.id);

    // Delete session_materials for this student's sessions (batch)
    if (sessionIds.length > 0) {
      try {
        await executeQuery('DELETE FROM session_materials WHERE session_id = ANY($1)', [sessionIds]);
      } catch (e) {
        console.log('Note: Could not delete session_materials:', e.message);
      }
    }

    // Delete sessions for this student (removes from calendar)
    await executeQuery('DELETE FROM sessions WHERE student_id = $1', [studentId]);

    if (permanent) {
      // Permanently delete student and all related data
      // Delete from all tables that reference student_id (in case CASCADE isn't set)
      const tablesToClean = [
        'monthly_assessments',
        'session_attendance',
        'materials',
        'makeup_classes',
        'payment_history',
        'payment_renewals',
        'event_registrations',
        'class_feedback',
        'student_badges',
        'student_certificates',
        'monthly_assessments',
        'student_challenges'
      ];

      for (const table of tablesToClean) {
        try {
          await executeQuery(`DELETE FROM ${table} WHERE student_id = $1`, [studentId]);
        } catch (tableErr) {
          // Table might not exist or column might be different - continue
          console.log(`Note: Could not delete from ${table}: ${tableErr.message}`);
        }
      }

      // Finally delete the student
      await executeQuery('DELETE FROM students WHERE id = $1', [studentId]);

      res.json({ success: true, message: 'Student and all related data permanently deleted' });
    } else {
      // Soft delete - mark as inactive (sessions already deleted above)
      await executeQuery('UPDATE students SET is_active = false WHERE id = $1', [studentId]);
      res.json({ success: true, message: 'Student deactivated and sessions removed from calendar' });
    }
  } catch (err) {
    console.error('Error deleting student:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET DELETED/INACTIVE STUDENTS ====================
app.get('/api/students/deleted/all', async (req, res) => {
  try {
    const r = await executeQuery(`
      SELECT s.*,
        COUNT(DISTINCT m.id) as makeup_credits
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND m.status = 'Available'
      WHERE s.is_active = false
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('Error fetching deleted students:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== RESTORE DELETED STUDENT ====================
app.put('/api/students/:id/restore', async (req, res) => {
  try {
    const studentId = req.params.id;
    
    // Restore the student to active status
    await executeQuery('UPDATE students SET is_active = true WHERE id = $1', [studentId]);
    
    res.json({ success: true, message: 'Student restored successfully with all details intact!' });
  } catch (err) {
    console.error('Error restoring student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/payment', async (req, res) => {
  const { amount, currency, payment_method, receipt_number, sessions_covered, notes, send_email } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, receipt_number, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, 'Paid')
    `, [req.params.id, amount, currency, payment_method, receipt_number, sessions_covered, notes]);
    await client.query('UPDATE students SET fees_paid = fees_paid + $1 WHERE id = $2', [amount, req.params.id]);
    await client.query('COMMIT');

    // Send payment confirmation email if requested (outside transaction)
    let emailSent = null;
    if (send_email) {
      const student = await pool.query('SELECT name, parent_name, parent_email FROM students WHERE id = $1', [req.params.id]);
      if (student.rows[0]) {
        const emailHTML = getPaymentConfirmationEmail({
          parentName: student.rows[0].parent_name,
          studentName: student.rows[0].name,
          amount: amount,
          currency: currency,
          paymentType: 'Initial Payment',
          sessionsAdded: sessions_covered,
          paymentMethod: payment_method,
          receiptNumber: receipt_number
        });
        emailSent = await sendEmail(
          student.rows[0].parent_email,
          `✅ Payment Confirmation - Fluent Feathers Academy`,
          emailHTML,
          student.rows[0].parent_name,
          'Payment Confirmation'
        );
      }
    }

    res.json({ success: true, emailSent });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/groups', async (req, res) => {
  try {
    const r = await executeQuery(`
      SELECT g.*, COUNT(DISTINCT s.id) as enrolled_students
      FROM groups g
      LEFT JOIN students s ON g.id = s.group_id AND s.is_active = true
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('Groups list error:', err.message);
    res.status(500).json({ error: 'Database temporarily unavailable. Please refresh.' });
  }
});

app.post('/api/groups', async (req, res) => {
  const { group_name, program_name, duration, timezone, max_students } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO groups (group_name, program_name, duration, timezone, max_students, current_students)
      VALUES ($1, $2, $3, $4, $5, 0)
      RETURNING id
    `, [group_name, program_name, duration, timezone, max_students]);
    res.json({ success: true, groupId: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// New endpoint to enroll student in group (with transaction to prevent race conditions)
app.post('/api/groups/:groupId/enroll', async (req, res) => {
  const { student_id } = req.body;
  const groupId = req.params.groupId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const group = await client.query('SELECT * FROM groups WHERE id = $1 FOR UPDATE', [groupId]);
    if (group.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Group not found' }); }

    const currentCount = await client.query('SELECT COUNT(*) as count FROM students WHERE group_id = $1 AND is_active = true', [groupId]);
    if (parseInt(currentCount.rows[0].count) >= group.rows[0].max_students) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Group is full' });
    }

    await client.query('UPDATE students SET group_id = $1, group_name = $2 WHERE id = $3', [groupId, group.rows[0].group_name, student_id]);
    await client.query('UPDATE groups SET current_students = current_students + 1 WHERE id = $1', [groupId]);
    await client.query('COMMIT');

    res.json({ success: true, message: 'Student enrolled successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get students in a group
app.get('/api/groups/:groupId/students', async (req, res) => {
  try {
    const students = await pool.query(`
      SELECT s.*, COUNT(DISTINCT m.id) as makeup_credits
      FROM students s
      LEFT JOIN makeup_classes m ON s.id = m.student_id AND LOWER(m.status) = 'available'
      WHERE s.group_id = $1 AND s.is_active = true
      GROUP BY s.id
      ORDER BY s.name
    `, [req.params.groupId]);
    res.json(students.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a student to existing upcoming group sessions (supports makeup credits)
// Also adds student to recent past sessions for content access (recordings/HW)
app.post('/api/groups/:groupId/add-to-sessions', async (req, res) => {
  const { student_id, num_sessions, makeup_count, include_past } = req.body;
  const groupId = req.params.groupId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify student belongs to this group
    const student = await client.query('SELECT * FROM students WHERE id = $1 AND group_id = $2', [student_id, groupId]);
    if (student.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Student not found in this group' });
    }

    const today = new Date().toISOString().split('T')[0];

    // If include_past, add student to past sessions they missed (for content access)
    // These don't count against remaining sessions - just so they can view recordings/HW
    let pastSessionsAdded = 0;
    if (include_past) {
      const pastSessions = await client.query(`
        SELECT s.id, s.session_date, s.session_time
        FROM sessions s
        WHERE s.group_id = $1 AND s.session_date < $2
          AND s.id NOT IN (SELECT session_id FROM session_attendance WHERE student_id = $3)
        ORDER BY s.session_date DESC, s.session_time DESC
        LIMIT 10
      `, [groupId, today, student_id]);

      for (const ps of pastSessions.rows) {
        await client.query(
          'INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, $3)',
          [ps.id, student_id, 'Absent']
        );
        pastSessionsAdded++;
      }
    }

    // Get upcoming group sessions that this student is NOT already in
    const upcomingSessions = await client.query(`
      SELECT s.id, s.session_date, s.session_time, s.session_number
      FROM sessions s
      WHERE s.group_id = $1 AND s.session_date >= $2
        AND s.id NOT IN (SELECT session_id FROM session_attendance WHERE student_id = $3)
      ORDER BY s.session_date ASC, s.session_time ASC
    `, [groupId, today, student_id]);

    if (upcomingSessions.rows.length === 0 && pastSessionsAdded === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No upcoming sessions available to add this student to. All sessions already include this student.' });
    }

    const totalToAdd = num_sessions ? parseInt(num_sessions) : upcomingSessions.rows.length;
    const sessionsToAdd = upcomingSessions.rows.slice(0, totalToAdd);
    let makeupNum = parseInt(makeup_count) || 0;
    let regularCount = sessionsToAdd.length - makeupNum;

    // If student has no remaining sessions, force all sessions to be makeup
    if (student.rows[0].remaining_sessions <= 0 && regularCount > 0) {
      makeupNum = sessionsToAdd.length;
      regularCount = 0;
    }

    // Validate makeup credits
    if (makeupNum > 0) {
      const availableCredits = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC',
        [student_id, 'Available']
      );
      if (availableCredits.rows.length < makeupNum) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Not enough makeup credits. Need ${makeupNum} but only ${availableCredits.rows.length} available.` });
      }
      // Consume makeup credits
      for (let i = 0; i < makeupNum; i++) {
        await client.query(
          `UPDATE makeup_classes SET status = 'Scheduled', used_date = CURRENT_DATE WHERE id = $1`,
          [availableCredits.rows[i].id]
        );
      }
    }

    // Check remaining sessions for regular (non-makeup) sessions
    if (regularCount > 0 && student.rows[0].remaining_sessions < regularCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough remaining sessions. Need ${regularCount} regular but only ${student.rows[0].remaining_sessions} remaining. Try using more makeup credits.` });
    }

    // Add attendance records for upcoming sessions
    for (const session of sessionsToAdd) {
      await client.query(
        'INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, $3)',
        [session.id, student_id, 'Pending']
      );
    }

    // Deduct only regular sessions from remaining
    if (regularCount > 0) {
      await client.query(
        'UPDATE students SET remaining_sessions = remaining_sessions - $1 WHERE id = $2',
        [regularCount, student_id]
      );
    }
    // Increment remaining for makeup sessions so they show in the count
    if (makeupNum > 0) {
      await client.query(
        'UPDATE students SET remaining_sessions = remaining_sessions + $1 WHERE id = $2',
        [makeupNum, student_id]
      );
    }

    await client.query('COMMIT');

    const studentName = student.rows[0].name;
    const makeupMsg = makeupNum > 0 ? ` (${makeupNum} using makeup credits)` : '';
    const pastMsg = pastSessionsAdded > 0 ? ` Also added to ${pastSessionsAdded} past session(s) for content access.` : '';
    res.json({
      success: true,
      message: `Added ${studentName} to ${sessionsToAdd.length} upcoming group sessions!${makeupMsg}${pastMsg}`,
      sessionsAdded: sessionsToAdd.length,
      pastSessionsAdded,
      makeupUsed: makeupNum,
      availableRemaining: upcomingSessions.rows.length - sessionsToAdd.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding student to sessions:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_attendance WHERE session_id IN (SELECT id FROM sessions WHERE group_id = $1)', [req.params.id]);
    await client.query('DELETE FROM sessions WHERE group_id = $1', [req.params.id]);
    await client.query('UPDATE students SET group_id = NULL, group_name = NULL WHERE group_id = $1', [req.params.id]);
    await client.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Schedule private classes
app.post('/api/schedule/private-classes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id, classes, send_email } = req.body;
    const student = (await client.query('SELECT * FROM students WHERE id = $1', [student_id])).rows[0];
    if(!student) return res.status(404).json({ error: 'Student not found' });

    // Separate regular and makeup classes
    const regularClasses = classes.filter(c => !c.use_makeup);
    const makeupClasses = classes.filter(c => c.use_makeup);

    // Validate remaining_sessions only against regular classes
    if(student.remaining_sessions < regularClasses.length) {
      return res.status(400).json({ error: `Not enough sessions. Need ${regularClasses.length} regular sessions but only ${student.remaining_sessions} remaining.` });
    }

    // Validate available makeup credits
    if (makeupClasses.length > 0) {
      const availableCredits = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC',
        [student_id, 'Available']
      );
      if (availableCredits.rows.length < makeupClasses.length) {
        return res.status(400).json({ error: `Not enough makeup credits. Need ${makeupClasses.length} but only ${availableCredits.rows.length} available.` });
      }
    }

    const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [student_id])).rows[0].count;
    let sessionNumber = parseInt(count)+1;

    await client.query('BEGIN');

    // Fetch available makeup credit IDs (FIFO - oldest first)
    let makeupCreditIds = [];
    if (makeupClasses.length > 0) {
      const credits = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC LIMIT $3',
        [student_id, 'Available', makeupClasses.length]
      );
      makeupCreditIds = credits.rows.map(r => r.id);
    }
    let makeupCreditIndex = 0;

    const scheduledSessions = [];
    let emailSerial = 1;
    for(const cls of classes) {
      if(!cls.date || !cls.time) continue;
      const utc = istToUTC(cls.date, cls.time);
      const isMakeup = cls.use_makeup === true;

      const result = await client.query(`
        INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, class_link, status, notes)
        VALUES ($1, 'Private', $2, $3::date, $4::time, $5, $6, $7)
        RETURNING id
      `, [student_id, sessionNumber, utc.date, utc.time, student.class_link || DEFAULT_CLASS, isMakeup ? 'Scheduled' : 'Pending', isMakeup ? 'Makeup Class' : null]);

      // If makeup, consume a makeup credit
      if (isMakeup && makeupCreditIndex < makeupCreditIds.length) {
        const creditId = makeupCreditIds[makeupCreditIndex];
        await client.query(`
          UPDATE makeup_classes SET status = 'Scheduled', used_date = CURRENT_DATE, scheduled_session_id = $1, scheduled_date = $2, scheduled_time = $3
          WHERE id = $4
        `, [result.rows[0].id, cls.date, cls.time, creditId]);
        makeupCreditIndex++;
      }

      // Store for email (use serial number, not session_number)
      const display = formatUTCToLocal(utc.date, utc.time, student.parent_timezone || student.timezone || 'Asia/Kolkata');
      const makeupLabel = isMakeup ? ' (Makeup)' : '';
      scheduledSessions.push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">Class ${emailSerial}${makeupLabel}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);

      sessionNumber++;
      emailSerial++;
    }

    // Increment remaining_sessions for makeup classes so they appear in the count
    if (makeupClasses.length > 0) {
      await client.query(
        'UPDATE students SET remaining_sessions = remaining_sessions + $1 WHERE id = $2',
        [makeupClasses.length, student_id]
      );
    }

    await client.query('COMMIT');

    // Send Schedule Email (if enabled)
    let emailSent = null;
    if (send_email !== false) {
      const scheduleHTML = getScheduleEmail({
        parent_name: student.parent_name,
        student_name: student.name,
        schedule_rows: scheduledSessions.join(''),
        timezone_label: getTimezoneLabel(student.parent_timezone || student.timezone || 'Asia/Kolkata')
      });

      emailSent = await sendEmail(
        student.parent_email,
        `📅 Class Schedule for ${student.name}`,
        scheduleHTML,
        student.parent_name,
        'Schedule'
      );
    }

    const makeupMsg = makeupClasses.length > 0 ? ` (${makeupClasses.length} using makeup credits)` : '';
    const emailMsg = emailSent === true ? ' and email sent!' : emailSent === false ? ' (email failed to send)' : '';
    const message = 'Classes scheduled successfully!' + emailMsg + makeupMsg;
    res.json({ success: true, message, emailSent });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Schedule group classes
app.post('/api/schedule/group-classes', async (req, res) => {
  const client = await pool.connect();
  try {
    const { group_id, classes, send_email, student_sessions, makeup_sessions } = req.body;
    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [group_id])).rows[0];
    if(!group) return res.status(404).json({ error: 'Group not found' });

    const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [group_id])).rows[0].count;
    let sessionNumber = parseInt(count)+1;

    // Handle makeup_sessions: [{student_id, count}] - students using makeup credits
    const hasMakeupSessions = makeup_sessions && Array.isArray(makeup_sessions) && makeup_sessions.length > 0;
    const studentMakeupMap = {}; // { student_id: number of sessions to use as makeup }
    if (hasMakeupSessions) {
      for (const ms of makeup_sessions) {
        studentMakeupMap[ms.student_id] = parseInt(ms.count);
      }
    }

    // Validate makeup credits availability before starting
    for (const studentId of Object.keys(studentMakeupMap)) {
      const needed = studentMakeupMap[studentId];
      if (needed > 0) {
        const available = await client.query(
          'SELECT COUNT(*) as count FROM makeup_classes WHERE student_id = $1 AND status = $2',
          [studentId, 'Available']
        );
        if (parseInt(available.rows[0].count) < needed) {
          const studentName = (await client.query('SELECT name FROM students WHERE id = $1', [studentId])).rows[0]?.name || studentId;
          return res.status(400).json({ error: `Not enough makeup credits for ${studentName}. Need ${needed} but only ${available.rows[0].count} available.` });
        }
      }
    }

    // Handle student_sessions: [{student_id, count}] - per-student session limits (-1 = all sessions)
    const hasPerStudentCounts = student_sessions && Array.isArray(student_sessions) && student_sessions.length > 0;
    const studentCountMap = {}; // { student_id: max_sessions (-1 for all) }
    if (hasPerStudentCounts) {
      for (const ss of student_sessions) {
        studentCountMap[ss.student_id] = parseInt(ss.count);
      }
    }

    await client.query('BEGIN');

    // Pre-fetch makeup credit IDs for each student that needs them (FIFO)
    const studentMakeupCredits = {}; // { student_id: [credit_ids] }
    const studentMakeupIndex = {}; // { student_id: current_index }
    for (const studentId of Object.keys(studentMakeupMap)) {
      const needed = studentMakeupMap[studentId];
      if (needed > 0) {
        const credits = await client.query(
          'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC LIMIT $3',
          [studentId, 'Available', needed]
        );
        studentMakeupCredits[studentId] = credits.rows.map(r => r.id);
        studentMakeupIndex[studentId] = 0;
      }
    }

    // Track per-student session counter to determine which sessions are makeup
    const studentSessionCounter = {}; // { student_id: count of sessions enrolled so far }

    const scheduledSessions = [];
    const studentEmailRows = {};
    const studentEmailSerial = {};
    let groupEmailSerial = 1;

    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      if(!cls.date || !cls.time) continue;
      const utc = istToUTC(cls.date, cls.time);
      const r = await client.query(`
        INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, class_link, status)
        VALUES ($1, 'Group', $2, $3::date, $4::time, $5, 'Pending')
        RETURNING id
      `, [group_id, sessionNumber, utc.date, utc.time, DEFAULT_CLASS]);

      const sessionId = r.rows[0].id;
      const sessionIndex = i + 1;

      const students = await client.query('SELECT id FROM students WHERE group_id = $1 AND is_active = true', [group_id]);
      for(const s of students.rows) {
        // Check if student should be scheduled for this session
        const makeupCount = studentMakeupMap[s.id] || 0;
        const sessionIndex = i + 1;

        // If student has makeup sessions specified, only schedule for first N sessions
        if (makeupCount > 0 && sessionIndex > makeupCount) continue;

        // If student has per-student session limit, check that too
        const studentMax = studentCountMap[s.id];
        if (studentMax !== undefined && studentMax !== -1 && sessionIndex > studentMax) continue;

        await client.query('INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, \'Pending\')', [sessionId, s.id]);

        // Track this student's session count
        if (!studentSessionCounter[s.id]) studentSessionCounter[s.id] = 0;
        studentSessionCounter[s.id]++;

        // Check if this session is a makeup session for this student
        const isMakeup = makeupCount > 0 && sessionIndex <= makeupCount;

        if (isMakeup && studentMakeupCredits[s.id] && studentMakeupIndex[s.id] < studentMakeupCredits[s.id].length) {
          const creditId = studentMakeupCredits[s.id][studentMakeupIndex[s.id]];
          await client.query(`
            UPDATE makeup_classes SET status = 'Scheduled', used_date = CURRENT_DATE, scheduled_session_id = $1, scheduled_date = $2, scheduled_time = $3
            WHERE id = $4
          `, [sessionId, cls.date, cls.time, creditId]);
          studentMakeupIndex[s.id]++;
        }

        if (!studentEmailRows[s.id]) { studentEmailRows[s.id] = []; studentEmailSerial[s.id] = 1; }
        const display = formatUTCToLocal(utc.date, utc.time, s.parent_timezone || s.timezone || group.timezone || 'Asia/Kolkata');
        const makeupLabel = isMakeup ? ' (Makeup)' : '';
        studentEmailRows[s.id].push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">Class ${studentEmailSerial[s.id]}${makeupLabel}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);
        studentEmailSerial[s.id]++;
      }

      const display = formatUTCToLocal(utc.date, utc.time, group.timezone || 'Asia/Kolkata');
      scheduledSessions.push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">Class ${groupEmailSerial}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);

      sessionNumber++;
      groupEmailSerial++;
    }

    // Increment remaining_sessions for each student who used makeup credits
    for (const [studentId, idx] of Object.entries(studentMakeupIndex)) {
      if (idx > 0) {
        await client.query(
          'UPDATE students SET remaining_sessions = remaining_sessions + $1 WHERE id = $2',
          [idx, parseInt(studentId)]
        );
      }
    }

    await client.query('COMMIT');

    // Send schedule email to all students in the group (if enabled)
    let emailsSent = 0;
    if (send_email !== false) {
      const students = await client.query('SELECT * FROM students WHERE group_id = $1 AND is_active = true', [group_id]);
      for (const student of students.rows) {
        // Determine which classes this student is scheduled for
        let studentClasses = [];
        const makeupCount = studentMakeupMap[student.id] || 0;
        const studentMax = studentCountMap[student.id];

        if (makeupCount > 0) {
          // Student has makeup sessions - send only their scheduled classes
          studentClasses = studentEmailRows[student.id] || [];
        } else if (studentMax !== undefined && studentMax !== -1) {
          // Student has custom session limit - send only their scheduled classes
          studentClasses = studentEmailRows[student.id] || [];
        } else {
          // Student has paid sessions for all classes - send all classes
          studentClasses = scheduledSessions;
        }

        if (studentClasses.length === 0) continue;

        const scheduleHTML = getScheduleEmail({
          parent_name: student.parent_name,
          student_name: student.name,
          schedule_rows: studentClasses.join(''),
          timezone_label: getTimezoneLabel(student.parent_timezone || student.timezone || group.timezone || 'Asia/Kolkata')
        });

        const sent = await sendEmail(
          student.parent_email,
          `📅 Group Class Schedule for ${student.name}`,
          scheduleHTML,
          student.parent_name,
          'Schedule'
        );
        if (sent) emailsSent++;
      }
    }

    // Build makeup summary
    let makeupMsg = '';
    const makeupUsed = Object.entries(studentMakeupIndex).filter(([_, idx]) => idx > 0);
    if (makeupUsed.length > 0) {
      const totalMakeup = makeupUsed.reduce((sum, [_, idx]) => sum + idx, 0);
      makeupMsg = ` (${totalMakeup} makeup credits used across ${makeupUsed.length} student${makeupUsed.length > 1 ? 's' : ''})`;
    }

    const emailMsg = send_email !== false && emailsSent > 0 ? ` and emails sent to ${emailsSent} students` : '';
    const message = `Group classes scheduled successfully!${emailMsg}${makeupMsg}`;
    res.json({ success: true, message, emailsSent });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Convert private sessions to group sessions for students in a group
app.post('/api/groups/:groupId/convert-private-sessions', async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = req.params.groupId;
    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Get all active students in this group
    const students = (await client.query('SELECT id, name FROM students WHERE group_id = $1 AND is_active = true', [groupId])).rows;
    if (students.length === 0) return res.json({ success: true, message: 'No active students in this group', converted: 0 });

    const studentIds = students.map(s => s.id);

    // Find all private sessions for these students (Pending/Scheduled only)
    const privateSessions = (await client.query(`
      SELECT * FROM sessions
      WHERE student_id = ANY($1)
        AND session_type = 'Private'
        AND status IN ('Pending', 'Scheduled')
      ORDER BY session_date, session_time
    `, [studentIds])).rows;

    if (privateSessions.length === 0) return res.json({ success: true, message: 'No pending private sessions found for group students', converted: 0 });

    await client.query('BEGIN');

    // Group private sessions by (date, time) to merge duplicates
    const dateTimeMap = {}; // key: "date|time" -> [{session, student_id}]
    for (const s of privateSessions) {
      const key = `${s.session_date}|${s.session_time}`;
      if (!dateTimeMap[key]) dateTimeMap[key] = [];
      dateTimeMap[key].push(s);
    }

    // Get current max session_number for this group
    const countResult = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [groupId])).rows[0];
    let sessionNumber = parseInt(countResult.count) + 1;

    let converted = 0;

    for (const key of Object.keys(dateTimeMap)) {
      const sessions = dateTimeMap[key];
      const first = sessions[0];

      // Keep the first session and convert it to group
      await client.query(`
        UPDATE sessions SET
          group_id = $1,
          student_id = NULL,
          session_type = 'Group',
          session_number = $2
        WHERE id = $3
      `, [groupId, sessionNumber, first.id]);

      // Create session_attendance for the first session's student
      await client.query(`
        INSERT INTO session_attendance (session_id, student_id, attendance)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id, student_id) DO NOTHING
      `, [first.id, first.student_id, first.attendance || 'Pending']);

      // For duplicate sessions at same time (other students), migrate materials then delete
      for (let i = 1; i < sessions.length; i++) {
        const dup = sessions[i];

        // Move any materials from the duplicate session to the kept session
        await client.query(`
          UPDATE materials SET session_id = $1 WHERE session_id = $2 AND student_id = $3
        `, [first.id, dup.id, dup.student_id]);

        // Copy over any file paths from duplicate to kept session (if kept session doesn't have them)
        if (dup.ppt_file_path) {
          await client.query(`UPDATE sessions SET ppt_file_path = $1 WHERE id = $2 AND ppt_file_path IS NULL`, [dup.ppt_file_path, first.id]);
        }
        if (dup.recording_file_path) {
          await client.query(`UPDATE sessions SET recording_file_path = $1 WHERE id = $2 AND recording_file_path IS NULL`, [dup.recording_file_path, first.id]);
        }
        if (dup.homework_file_path) {
          await client.query(`UPDATE sessions SET homework_file_path = $1 WHERE id = $2 AND homework_file_path IS NULL`, [dup.homework_file_path, first.id]);
        }

        // Create session_attendance for this student on the kept session
        await client.query(`
          INSERT INTO session_attendance (session_id, student_id, attendance)
          VALUES ($1, $2, $3)
          ON CONFLICT (session_id, student_id) DO NOTHING
        `, [first.id, dup.student_id, dup.attendance || 'Pending']);

        // Delete the duplicate session
        await client.query('DELETE FROM sessions WHERE id = $1', [dup.id]);
      }

      sessionNumber++;
      converted++;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Converted ${converted} private session(s) to group sessions for ${students.map(s => s.name).join(', ')}`,
      converted
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===== NEW GROUP TIMINGS ENDPOINTS =====

// Set recurring class timings for a group
app.post('/api/groups/:groupId/set-timings', async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = req.params.groupId;
    const { startDate, numWeeks, time1, time2, selectedDays } = req.body;

    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    await client.query('BEGIN');

    // Clear existing timings for this group
    await client.query('DELETE FROM group_timings WHERE group_id = $1', [groupId]);

    // Insert new timings
    const start = new Date(startDate);
    for (let week = 0; week < numWeeks; week++) {
      for (const dayInfo of selectedDays) {
        const classDate = new Date(start);
        classDate.setDate(start.getDate() + week * 7 + dayInfo.day);

        const time = dayInfo.timeSlot === 1 ? time1 : (time2 || time1);

        await client.query(`
          INSERT INTO group_timings (group_id, session_date, session_time, day_of_week)
          VALUES ($1, $2, $3, $4)
        `, [groupId, classDate.toISOString().split('T')[0], time, dayInfo.day]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Group timings saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get group timings
app.get('/api/groups/:groupId/timings', async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const timings = (await pool.query(`
      SELECT * FROM group_timings
      WHERE group_id = $1
      ORDER BY session_date, session_time
    `, [groupId])).rows;

    res.json(timings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== NEW GROUP ENROLLMENT ENDPOINTS =====

app.get('/api/groups/:groupId/matching-private-sessions', async (req, res) => {
  try {
    const rows = (await pool.query(`
      SELECT s.id as session_id, s.student_id, s.session_date, s.session_time, s.session_number, s.status,
             st.name as student_name, st.parent_name, st.parent_email
      FROM sessions s
      INNER JOIN students st ON st.id = s.student_id
      WHERE st.group_id = $1
        AND st.is_active = true
        AND s.session_type = 'Private'
        AND s.group_id IS NULL
        AND s.status IN ('Pending', 'Scheduled')
      ORDER BY s.session_date, s.session_time, st.name
    `, [req.params.groupId])).rows;

    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.session_date}|${row.session_time}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          session_date: row.session_date,
          session_time: row.session_time,
          students: []
        });
      }
      grouped.get(key).students.push({
        session_id: row.session_id,
        student_id: row.student_id,
        session_number: row.session_number,
        status: row.status,
        student_name: row.student_name,
        parent_name: row.parent_name,
        parent_email: row.parent_email
      });
    }

    const matches = Array.from(grouped.values())
      .filter(slot => slot.students.length >= 2)
      .map(slot => ({
        ...slot,
        student_count: slot.students.length
      }));

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enroll students in group classes (convert individual sessions to group)
app.post('/api/groups/:groupId/enroll-students', async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = req.params.groupId;
    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Get all active students in this group
    const students = (await client.query('SELECT id, name FROM students WHERE group_id = $1 AND is_active = true', [groupId])).rows;
    if (students.length === 0) return res.json({ success: true, message: 'No active students in this group', enrolled: 0 });

    const studentIds = students.map(s => s.id);

    await client.query('BEGIN');

    // Get current max session_number for this group
    const countResult = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [groupId])).rows[0];
    let sessionNumber = parseInt(countResult.count) + 1;

    let enrolled = 0;

    // Find individual sessions that match group timings
    const groupTimings = (await client.query('SELECT * FROM group_timings WHERE group_id = $1 ORDER BY session_date, session_time', [groupId])).rows;

    for (const timing of groupTimings) {
      // Check if there's already a group session for this timing
      const existingGroupSession = (await client.query(`
        SELECT id FROM sessions
        WHERE group_id = $1 AND session_date = $2 AND session_time = $3 AND session_type = 'Group'
      `, [groupId, timing.session_date, timing.session_time])).rows[0];

      if (existingGroupSession) continue; // Already exists

      // Find individual sessions at this time for group students
      const individualSessions = (await client.query(`
        SELECT s.*, sa.student_id
        FROM sessions s
        INNER JOIN session_attendance sa ON sa.session_id = s.id
        WHERE s.session_date = $1 AND s.session_time = $2
          AND sa.student_id = ANY($3)
          AND s.session_type = 'Private'
          AND s.status IN ('Pending', 'Scheduled')
      `, [timing.session_date, timing.session_time, studentIds])).rows;

      if (individualSessions.length === 0) continue; // No individual sessions to convert

      // Create group session
      const groupSession = (await client.query(`
        INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, class_link, status)
        VALUES ($1, 'Group', $2, $3, $4, $5, 'Pending')
        RETURNING id
      `, [groupId, sessionNumber, timing.session_date, timing.session_time, DEFAULT_CLASS])).rows[0];

      // Convert individual sessions to group attendance
      for (const session of individualSessions) {
        // Move materials to group session
        await client.query(`
          UPDATE materials SET session_id = $1 WHERE session_id = $2 AND student_id = $3
        `, [groupSession.id, session.id, session.student_id]);

        // Create group attendance record
        await client.query(`
          INSERT INTO session_attendance (session_id, student_id, attendance)
          VALUES ($1, $2, $3)
          ON CONFLICT (session_id, student_id) DO UPDATE SET attendance = EXCLUDED.attendance
        `, [groupSession.id, session.student_id, session.attendance || 'Pending']);

        // Delete the individual session
        await client.query('DELETE FROM sessions WHERE id = $1', [session.id]);
      }

      sessionNumber++;
      enrolled++;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: `Successfully enrolled students in ${enrolled} group classes`,
      enrolled
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Get all sessions for a student (including group sessions)
// In-memory sessions cache — serves instant response on repeat loads / cold-start
const sessionsResponseCache = new Map(); // key: `${studentId}:${light}`, value: { data, ts }
const SESSIONS_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
function clearStudentSessionsCache(studentId) {
  sessionsResponseCache.delete(`${studentId}:true`);
  sessionsResponseCache.delete(`${studentId}:false`);
}

app.get('/api/sessions/:studentId', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  const lightMode = String(req.query.light || '') === '1';
  if(req.adminStudentId && req.adminStudentId != req.params.studentId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Serve from server-side cache if fresh (avoids DB hit on rapid reloads / cold starts)
  const cacheKey = `${id}:${lightMode}`;
  const cached = sessionsResponseCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SESSIONS_CACHE_TTL_MS) {
    res.set('X-Cache', 'HIT');
    return res.json(cached.data);
  }

  try {
    // Fire private sessions query and student lookup in parallel (both independent)
    const privateQuery = lightMode
      ? executeQuery(`
          SELECT s.*, 'Private' as source_type,
            NULL::text as homework_submission_path,
            NULL::text as homework_grade,
            NULL::text as homework_feedback,
            false as has_feedback,
            COALESCE(s.class_link, $2) as class_link
          FROM sessions s
          WHERE s.student_id = $1 AND s.session_type = 'Private'
        `, [id, DEFAULT_CLASS])
      : executeQuery(`
          SELECT s.*, 'Private' as source_type,
            COALESCE(ma.hw_submissions, '[]'::json) as hw_submissions,
            CASE WHEN cf.id IS NOT NULL THEN true ELSE false END as has_feedback
          FROM sessions s
          LEFT JOIN LATERAL (
            SELECT json_agg(
              json_build_object(
                'file_path', file_path,
                'feedback_grade', feedback_grade,
                'feedback_comments', feedback_comments,
                'corrected_file_path', corrected_file_path,
                'uploaded_at', uploaded_at,
                'feedback_date', feedback_date,
                'uploaded_by', uploaded_by
              ) ORDER BY uploaded_at ASC NULLS LAST
            ) as hw_submissions
            FROM materials
            WHERE session_id = s.id AND student_id = $1 AND file_type = 'Homework' AND uploaded_by IN ('Parent', 'Admin')
          ) ma ON true
          LEFT JOIN class_feedback cf ON cf.session_id = s.id AND cf.student_id = $1
          WHERE s.student_id = $1 AND s.session_type = 'Private'
        `, [id]);

    const [privateSessions, student] = await Promise.all([
      privateQuery,
      executeQuery('SELECT group_id, created_at FROM students WHERE id = $1', [id])
    ]);

    let groupSessions = [];

    if (student.rows[0] && student.rows[0].group_id) {
      const groupId = student.rows[0].group_id;

      const groupSessionsResult = lightMode
        ? await executeQuery(`
            SELECT s.*, 'Group' as source_type,
              NULL::text as homework_submission_path,
              NULL::text as homework_grade,
              NULL::text as homework_feedback,
              false as has_feedback,
              COALESCE(sa.attendance, 'Pending') as student_attendance,
              COALESCE(s.class_link, $3) as class_link
            FROM sessions s
            INNER JOIN session_attendance sa ON sa.session_id = s.id AND sa.student_id = $1
            WHERE s.group_id = $2 AND s.session_type = 'Group'
          `, [id, groupId, DEFAULT_CLASS])
        : await executeQuery(`
            SELECT s.*, 'Group' as source_type,
              COALESCE(ma.hw_submissions, '[]'::json) as hw_submissions,
              CASE WHEN cf.id IS NOT NULL THEN true ELSE false END as has_feedback,
              COALESCE(sa.attendance, 'Pending') as student_attendance
            FROM sessions s
            INNER JOIN session_attendance sa ON sa.session_id = s.id AND sa.student_id = $1
            LEFT JOIN LATERAL (
              SELECT json_agg(
                json_build_object(
                  'file_path', file_path,
                  'feedback_grade', feedback_grade,
                  'feedback_comments', feedback_comments,
                  'corrected_file_path', corrected_file_path,
                  'uploaded_at', uploaded_at,
                  'feedback_date', feedback_date,
                  'uploaded_by', uploaded_by
                ) ORDER BY uploaded_at ASC NULLS LAST
              ) as hw_submissions
              FROM materials
              WHERE session_id = s.id AND student_id = $1 AND file_type = 'Homework' AND uploaded_by IN ('Parent', 'Admin')
            ) ma ON true
            LEFT JOIN class_feedback cf ON cf.session_id = s.id AND cf.student_id = $1
            WHERE s.group_id = $2 AND s.session_type = 'Group'
          `, [id, groupId]);
      groupSessions = groupSessionsResult.rows;
    }

    // Combine and sort by date ascending, then time ascending
    const allSessions = [...privateSessions.rows, ...groupSessions].sort((a, b) => {
      const dA = new Date(a.session_date).getTime();
      const dB = new Date(b.session_date).getTime();
      if (dA !== dB) return dA - dB;
      return String(a.session_time || '').localeCompare(String(b.session_time || ''));
    });

    // Renumber sessions sequentially per student (1, 2, 3...) instead of using group-level session_number
    allSessions.forEach((s, i) => {
      s.session_number = i + 1;
    });

    // Fix file paths for backwards compatibility
    const fixedSessions = allSessions.map(session => {
      // Helper to check if path needs prefix (skip Cloudinary URLs)
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');

      // Fix PPT file path
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      // Fix Recording file path
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      // Fix Homework file path (teacher uploaded)
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
      // Fix file paths inside hw_submissions array (parent uploads + corrections)
      if (Array.isArray(session.hw_submissions)) {
        session.hw_submissions = session.hw_submissions.map(sub => {
          if (needsPrefix(sub.file_path)) sub.file_path = '/uploads/homework/' + sub.file_path;
          if (needsPrefix(sub.corrected_file_path)) sub.corrected_file_path = '/uploads/homework/' + sub.corrected_file_path;
          return sub;
        });
      }
      return session;
    });

    const responseData = lightMode ? allSessions : fixedSessions;
    // Cache this response so the next request within 3 min is instant
    sessionsResponseCache.set(cacheKey, { data: responseData, ts: Date.now() });
    res.json(responseData);
  } catch (err) {
    console.error('Error fetching sessions:', err);
    // If DB failed but we have stale cache, serve it rather than an error
    const staleCached = sessionsResponseCache.get(cacheKey);
    if (staleCached) {
      console.log(`⚡ Serving stale sessions cache for student ${id} due to DB error`);
      res.set('X-Cache', 'STALE');
      return res.json(staleCached.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// Search sessions by student name (for manual cleanup)
app.get('/api/sessions/search-by-name', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Name parameter required' });
    }

    // Search in sessions table - look for student name in various places
    const result = await pool.query(`
      SELECT s.id, s.session_date, s.session_time, s.session_type, s.student_id,
             COALESCE(st.name, 'Unknown') as student_name
      FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE LOWER(COALESCE(st.name, '')) LIKE LOWER($1)
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT 100
    `, [`%${name}%`]);

    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Search sessions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sessionRes = await client.query('SELECT id, session_type, student_id, group_id FROM sessions WHERE id = $1', [req.params.sessionId]);
    if (sessionRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessionRes.rows[0];

    // Also delete related session_materials
    await client.query('DELETE FROM session_materials WHERE session_id = $1', [req.params.sessionId]);
    await client.query('DELETE FROM sessions WHERE id = $1', [req.params.sessionId]);

    if (session.session_type === 'Group' && session.group_id) {
      await renumberGroupSessionsForGroup(session.group_id, client);
    } else if (session.student_id) {
      await renumberPrivateSessionsForStudent(session.student_id, client);
    }

    await client.query('COMMIT');
    clearAdminDashboardCache();
    res.json({ success: true, message: 'Session deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update a session
app.put('/api/sessions/:sessionId', async (req, res) => {
  const { date, time } = req.body;
  try {
    // Get current session details before updating
    const sessionRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    if (sessionRes.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const session = sessionRes.rows[0];

    // Convert database date objects to ISO string (YYYY-MM-DD)
    let oldDate = session.session_date;
    if (oldDate instanceof Date) {
      oldDate = oldDate.toISOString().split('T')[0];
    }
    let oldTime = session.session_time;
    if (typeof oldTime !== 'string') {
      oldTime = oldTime.toString();
    }

    const utc = istToUTC(date, time);
    await pool.query('UPDATE sessions SET session_date = $1::date, session_time = $2::time WHERE id = $3', [utc.date, utc.time, req.params.sessionId]);

    if (session.session_type === 'Group' && session.group_id) {
      await renumberGroupSessionsForGroup(session.group_id, pool);
    } else if (session.student_id) {
      await renumberPrivateSessionsForStudent(session.student_id, pool);
    }

    const renumberedSessionRes = await pool.query('SELECT session_number FROM sessions WHERE id = $1', [req.params.sessionId]);
    const updatedSessionNumber = renumberedSessionRes.rows[0]?.session_number || session.session_number;

    // Clear old reminder email logs for this session so new reminders can be sent
    await pool.query(
      `DELETE FROM email_log WHERE email_type IN ('Reminder-5hrs', 'Reminder-5hrs-Group', 'Reminder-1hr', 'Reminder-1hr-Group') AND subject LIKE $1`,
      [`%[SID:${req.params.sessionId}]%`]
    );

    // Send reschedule notification email to affected students
    let studentsToNotify = [];
    if (session.session_type === 'Group' && session.group_id) {
      const groupStudents = await pool.query(
        'SELECT s.*, g.group_name FROM students s JOIN groups g ON s.group_id = g.id WHERE s.group_id = $1 AND s.is_active = true',
        [session.group_id]
      );
      studentsToNotify = groupStudents.rows;
    } else if (session.student_id) {
      const student = await pool.query('SELECT * FROM students WHERE id = $1', [session.student_id]);
      studentsToNotify = student.rows;
    }

    let emailsSent = 0;
    for (const student of studentsToNotify) {
      try {
        const sent = await sendEmail(
          student.parent_email,
          'Class Rescheduled - Fluent Feathers Academy',
          getRescheduleEmailTemplate({
            parent_name: student.parent_name,
            student_name: student.name,
            session_number: updatedSessionNumber,
            old_date: oldDate,
            old_time: oldTime,
            new_date: utc.date,
            new_time: utc.time,
            reason: 'Schedule adjustment',
            is_group: session.session_type === 'Group',
            group_name: student.group_name || '',
            timezone: student.parent_timezone || student.timezone || 'Asia/Kolkata'
          }),
          student.parent_name,
          'Reschedule'
        );
        if (sent) emailsSent++;
      } catch (emailErr) {
        console.error('Failed to send reschedule email to', student.parent_email, emailErr.message);
      }
    }

    clearAdminDashboardCache();
    res.json({ success: true, message: `Session updated successfully! ${emailsSent > 0 ? `(${emailsSent} notification${emailsSent > 1 ? 's' : ''} sent)` : ''}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a session (with reason and optional makeup credit)
app.post('/api/sessions/:sessionId/cancel', async (req, res) => {
  const { reason, notes, grant_makeup_credit, session_type } = req.body;
  try {
    // Get session details first
    const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const session = sessionResult.rows[0];

    // Get student details for email
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [session.student_id]);
    const student = studentResult.rows[0];

    // Update session status to Cancelled with cancelled_by = 'Teacher'
    await pool.query(
      'UPDATE sessions SET status = $1, cancelled_by = $2, teacher_notes = COALESCE(teacher_notes, \'\') || $3 WHERE id = $4',
      ['Cancelled', 'Teacher', `\n[Cancelled: ${reason}${notes ? ' - ' + notes : ''}]`, req.params.sessionId]
    );

    // If grant makeup credit is checked, add a makeup credit to the student
    if (grant_makeup_credit) {
      // Add to makeup_classes table
      await pool.query(`
        INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by, notes)
        VALUES ($1, $2, $3, CURRENT_DATE, 'Available', 'admin', $4)
      `, [session.student_id, session.id, reason || 'Teacher cancelled', notes || '']);
    }

    // Decrement remaining_sessions for the student (private sessions only)
    if (session.student_id && session.session_type !== 'Group') {
      await pool.query(
        `UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`,
        [session.student_id]
      );
    }

    // Send cancellation email to parent
    if (student && student.parent_email) {
      try {
        // Convert UTC time to student's local timezone
        const parentTimezone = student.parent_timezone || student.timezone || 'Asia/Kolkata';
        const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
        const timezoneLabel = getTimezoneLabel(parentTimezone);

        const fallbackDate = session.session_date instanceof Date
          ? session.session_date.toISOString().split('T')[0]
          : (typeof session.session_date === 'string' && session.session_date.includes('T')
            ? session.session_date.split('T')[0]
            : String(session.session_date || 'N/A'));
        const fallbackTime = (session.session_time || 'N/A').toString().substring(0, 8);

        const safeSessionDate = localTime && localTime.date && localTime.date !== 'Invalid Date'
          ? `${localTime.day ? `${localTime.day}, ` : ''}${localTime.date}`
          : fallbackDate;
        const safeSessionTime = localTime && localTime.time && localTime.time !== 'Invalid Time'
          ? `${localTime.time} (${timezoneLabel})`
          : `${fallbackTime} (${timezoneLabel})`;

        const emailHTML = getClassCancelledEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          sessionDate: safeSessionDate,
          sessionTime: safeSessionTime,
          cancelledBy: 'Teacher',
          reason: reason,
          hasMakeupCredit: grant_makeup_credit
        });

        await sendEmail(
          student.parent_email,
          `📅 Class Cancelled - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Class-Cancelled'
        );
      } catch (emailErr) {
        console.error('Failed to send cancellation email:', emailErr);
      }
    }

    clearAdminDashboardCache();
    res.json({
      success: true,
      message: `Class cancelled successfully${grant_makeup_credit ? ' (makeup credit granted)' : ''}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually resend a cancellation email to a parent (admin only)
app.post('/api/admin/resend-cancel-email', async (req, res) => {
  const { pass, student_id, session_id } = req.body;
  if (pass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [student_id]);
    const student = studentResult.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });
    if (!student.parent_email) return res.status(400).json({ error: 'Student has no parent email' });

    const sessionResult = await pool.query('SELECT * FROM sessions WHERE id = $1', [session_id]);
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const parentTimezone = student.parent_timezone || student.timezone || 'Asia/Kolkata';
    const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
    const timezoneLabel = getTimezoneLabel(parentTimezone);

    const fallbackDate = session.session_date instanceof Date
      ? session.session_date.toISOString().split('T')[0]
      : (typeof session.session_date === 'string' && session.session_date.includes('T')
        ? session.session_date.split('T')[0]
        : String(session.session_date || 'N/A'));
    const fallbackTime = (session.session_time || 'N/A').toString().substring(0, 8);

    const safeSessionDate = localTime && localTime.date && localTime.date !== 'Invalid Date'
      ? `${localTime.day ? `${localTime.day}, ` : ''}${localTime.date}`
      : fallbackDate;
    const safeSessionTime = localTime && localTime.time && localTime.time !== 'Invalid Time'
      ? `${localTime.time} (${timezoneLabel})`
      : `${fallbackTime} (${timezoneLabel})`;

    const emailHTML = getClassCancelledEmail({
      parentName: student.parent_name || 'Parent',
      studentName: student.name,
      sessionDate: safeSessionDate,
      sessionTime: safeSessionTime,
      cancelledBy: 'Teacher',
      reason: req.body.reason || 'Parent Requested',
      hasMakeupCredit: req.body.has_makeup_credit !== false
    });

    await sendEmail(
      student.parent_email,
      `📅 Class Cancelled - ${student.name}`,
      emailHTML,
      student.parent_name,
      'Class-Cancelled'
    );

    res.json({ success: true, message: `Cancellation email sent to ${student.parent_email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/parent-view-token', async (req, res) => {
  try {
    const { student_id } = req.body;
    const student = await pool.query('SELECT id FROM students WHERE id = $1', [student_id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const token = generateAdminToken(student_id);
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/parent/admin-view', async (req, res) => {
  const studentId = req.adminStudentId;
  if (!studentId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const student = await pool.query(`
      SELECT s.*,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      WHERE s.id = $1 AND s.is_active = true
    `, [studentId]);
    res.json({ student: student.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/details', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId]);
    const session = result.rows[0];

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Fix file paths for backwards compatibility (skip Cloudinary URLs)
    if (session) {
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
    }

    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update session topic
app.put('/api/sessions/:sessionId/topic', async (req, res) => {
  try {
    const { topic } = req.body;
    await pool.query('UPDATE sessions SET session_topic = $1 WHERE id = $2', [topic || null, req.params.sessionId]);
    res.json({ message: 'Session topic saved successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/attendance', async (req, res) => {
  try {
    const { attendance } = req.body;
    const sessionId = req.params.sessionId;

    // Determine session status based on attendance
    let sessionStatus;
    if (attendance === 'Present') {
      sessionStatus = 'Completed';
    } else if (attendance === 'Excused') {
      sessionStatus = 'Excused';
    } else {
      sessionStatus = 'Missed'; // Unexcused or Absent
    }

    // Get previous session status before updating
    const session = await pool.query('SELECT student_id, status FROM sessions WHERE id = $1', [sessionId]);
    const prevStatus = session.rows[0]?.status;

    await pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [sessionStatus, sessionId]);

    if (session.rows[0] && session.rows[0].student_id) {
      const studentId = session.rows[0].student_id;

      // Only update student stats if status actually changed (prevent double-counting)
      const alreadyCounted = prevStatus === 'Completed' || prevStatus === 'Excused' || prevStatus === 'Missed';

      if (attendance === 'Present') {
        if (!alreadyCounted) {
          await pool.query('UPDATE students SET completed_sessions = completed_sessions + 1, remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1', [studentId]);
        } else if (prevStatus !== 'Completed') {
          // Was Excused/Missed before, now Present - add to completed but don't re-decrement remaining
          await pool.query('UPDATE students SET completed_sessions = completed_sessions + 1 WHERE id = $1', [studentId]);
        }

        // Award attendance badges
        const student = await pool.query('SELECT completed_sessions FROM students WHERE id = $1', [studentId]);
        const completedCount = student.rows[0]?.completed_sessions || 0;

        if (completedCount === 1) await awardBadge(studentId, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (completedCount === 5) await awardBadge(studentId, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (completedCount === 10) await awardBadge(studentId, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (completedCount === 25) await awardBadge(studentId, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (completedCount === 50) await awardBadge(studentId, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
      } else if (attendance === 'Excused') {
        if (!alreadyCounted) {
          // First time marking - decrement remaining, grant makeup
          await pool.query('UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1', [studentId]);
        }
        // Grant makeup credit (check if already exists for this session)
        const existingCredit = await pool.query('SELECT id FROM makeup_classes WHERE student_id = $1 AND original_session_id = $2', [studentId, sessionId]);
        if (existingCredit.rows.length === 0) {
          await pool.query(`
            INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by)
            VALUES ($1, $2, 'Excused absence', CURRENT_DATE, 'Available', 'admin')
          `, [studentId, sessionId]);
        }
      } else {
        if (!alreadyCounted) {
          // First time marking - decrement remaining
          await pool.query('UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1', [studentId]);
        }
      }
    }

    const message = attendance === 'Present' ? 'Marked as Present' :
                    attendance === 'Excused' ? 'Marked as Excused (makeup credit granted)' :
                    'Marked as Unexcused (no makeup credit)';

    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  try {
    // First try to get from session_attendance table
    let result = await pool.query(`
      SELECT sa.*, s.name as student_name, s.is_active
      FROM session_attendance sa
      JOIN students s ON sa.student_id = s.id
      WHERE sa.session_id = $1
      ORDER BY s.name
    `, [req.params.sessionId]);

    // If no records exist, get the group_id and create attendance for booked students only
    if (result.rows.length === 0) {
      const session = await pool.query('SELECT group_id, session_date FROM sessions WHERE id = $1', [req.params.sessionId]);
      if (session.rows[0]?.group_id) {
        const groupId = session.rows[0].group_id;
        const sessionDate = session.rows[0].session_date;

        // Check if this group uses session_attendance for booking (has any attendance records for any session)
        const hasBookings = await pool.query(
          'SELECT 1 FROM session_attendance sa JOIN sessions s ON sa.session_id = s.id WHERE s.group_id = $1 LIMIT 1',
          [groupId]
        );

        let students;
        if (hasBookings.rows.length > 0) {
          // Group uses per-student booking - only add students who have attendance records for OTHER sessions in this group
          // (they were booked but not yet for this specific session)
          students = await pool.query(`
            SELECT DISTINCT s.id as student_id, s.name as student_name, 'Pending' as attendance
            FROM students s
            INNER JOIN session_attendance sa2 ON sa2.student_id = s.id
            INNER JOIN sessions s2 ON sa2.session_id = s2.id AND s2.group_id = $1
            WHERE s.group_id = $1 AND s.is_active = true
            ORDER BY s.name
          `, [groupId]);
        } else {
          // Legacy: no booking records exist yet, add all active group members enrolled before session date
          students = await pool.query(`
            SELECT s.id as student_id, s.name as student_name, 'Pending' as attendance
            FROM students s
            WHERE s.group_id = $1 AND s.is_active = true
              AND s.created_at::date <= $2::date
            ORDER BY s.name
          `, [groupId, sessionDate]);
        }

        // Create session_attendance records
        for (const student of students.rows) {
          await pool.query(
            'INSERT INTO session_attendance (session_id, student_id, attendance) VALUES ($1, $2, $3) ON CONFLICT (session_id, student_id) DO NOTHING',
            [req.params.sessionId, student.student_id, 'Pending']
          );
        }

        // Re-fetch the records
        result = await pool.query(`
          SELECT sa.*, s.name as student_name, s.is_active
          FROM session_attendance sa
          JOIN students s ON sa.student_id = s.id
          WHERE sa.session_id = $1
          ORDER BY s.name
        `, [req.params.sessionId]);
      }
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:sessionId/group-attendance', async (req, res) => {
  const client = await pool.connect();
  try {
    const { attendanceData } = req.body;
    // Invalidate sessions cache for all affected students so next load is fresh
    if (Array.isArray(attendanceData)) {
      attendanceData.forEach(r => { if (r.student_id) clearStudentSessionsCache(r.student_id); });
    }
    clearAdminDashboardCache();
    const sessionId = req.params.sessionId;

    await client.query('BEGIN');

    for (const record of attendanceData) {
      const prev = await client.query('SELECT attendance FROM session_attendance WHERE session_id = $1 AND student_id = $2', [sessionId, record.student_id]);
      const prevAttendance = prev.rows[0]?.attendance;

      // Use UPSERT to ensure record exists and is updated
      await client.query(`
        INSERT INTO session_attendance (session_id, student_id, attendance)
        VALUES ($1, $2, $3)
        ON CONFLICT (session_id, student_id)
        DO UPDATE SET attendance = $3
      `, [sessionId, record.student_id, record.attendance]);

      // Handle state transitions
      const wasPresent = prevAttendance === 'Present';
      const wasExcused = prevAttendance === 'Excused';
      const wasPending = !prevAttendance || prevAttendance === 'Pending';

      if (record.attendance === 'Present') {
        // If changing TO Present from non-Present
        if (!wasPresent) {
          await client.query(`UPDATE students SET completed_sessions = completed_sessions + 1 WHERE id = $1`, [record.student_id]);

          // Only decrement remaining if coming from Pending (not already decremented)
          if (wasPending) {
            await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`, [record.student_id]);
          }

          // Award badges for group class attendance
          const student = await client.query('SELECT completed_sessions FROM students WHERE id = $1', [record.student_id]);
          const completedCount = student.rows[0]?.completed_sessions || 0;

          if (completedCount === 1) await awardBadge(record.student_id, 'first_class', '🌟 First Class Star', 'Attended first class!');
          if (completedCount === 5) await awardBadge(record.student_id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
          if (completedCount === 10) await awardBadge(record.student_id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
          if (completedCount === 25) await awardBadge(record.student_id, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
          if (completedCount === 50) await awardBadge(record.student_id, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
        }
      } else if (record.attendance === 'Excused') {
        // Excused absence - grant makeup credit (only if not already excused and not a summer camp student)
        if (!wasExcused) {
          // Check if student is a summer camp student
          const studentCheck = await client.query('SELECT is_summer_camp FROM students WHERE id = $1', [record.student_id]);
          const isSummerCamp = studentCheck.rows.length > 0 && studentCheck.rows[0].is_summer_camp;

          if (!isSummerCamp) {
            await client.query(`
              INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by)
              VALUES ($1, $2, 'Excused absence (group class)', CURRENT_DATE, 'Available', 'admin')
            `, [record.student_id, sessionId]);
          }

          // Decrement remaining sessions if coming from Pending
          if (wasPending) {
            await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`, [record.student_id]);
          }
        }
      } else if (record.attendance === 'Unexcused' || record.attendance === 'Absent') {
        // Unexcused absence - no makeup credit, just decrement remaining sessions if from Pending
        if (wasPending) {
          await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`, [record.student_id]);
        }
      }
    }

    await client.query('UPDATE sessions SET status = $1 WHERE id = $2', ['Completed', sessionId]);
    await client.query('COMMIT');
    res.json({ message: 'Group attendance marked successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Reschedule a session (private or group)
app.post('/api/sessions/:sessionId/reschedule', async (req, res) => {
  const { new_date, new_time, reason } = req.body;
  const sessionId = req.params.sessionId;

  if (!new_date || !new_time) {
    return res.status(400).json({ error: 'New date and time are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get current session details
    const sessionRes = await client.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (sessionRes.rows.length === 0) {
      throw new Error('Session not found');
    }
    const session = sessionRes.rows[0];
    const oldDate = session.session_date;
    const oldTime = session.session_time;

    // Convert to UTC if needed
    const converted = istToUTC(new_date, new_time);

    // Update the session with new date and time
    await client.query(`
  UPDATE sessions SET
    session_date = $1,
    session_time = $2,
    original_date = COALESCE(original_date, $3),
    original_time = COALESCE(original_time, $4)
  WHERE id = $5
`, [converted.date, converted.time, oldDate, oldTime, sessionId]);

    if (session.session_type === 'Group' && session.group_id) {
      await renumberGroupSessionsForGroup(session.group_id, client);
    } else if (session.student_id) {
      await renumberPrivateSessionsForStudent(session.student_id, client);
    }

    const renumberedSession = await client.query('SELECT session_number FROM sessions WHERE id = $1', [sessionId]);
    const updatedSessionNumber = renumberedSession.rows[0]?.session_number || session.session_number;


    // Clear old reminder email logs for this session so new reminders can be sent
    await client.query(
      `DELETE FROM email_log WHERE email_type IN ('Reminder-5hrs', 'Reminder-5hrs-Group', 'Reminder-1hr', 'Reminder-1hr-Group') AND subject LIKE $1`,
      [`%[SID:${sessionId}]%`]
    );

    // Get students to notify
    let studentsToNotify = [];
    if (session.session_type === 'Group' && session.group_id) {
      const groupStudents = await client.query(
        'SELECT s.*, g.group_name FROM students s JOIN groups g ON s.group_id = g.id WHERE s.group_id = $1 AND s.is_active = true',
        [session.group_id]
      );
      studentsToNotify = groupStudents.rows;
    } else if (session.student_id) {
      const student = await client.query('SELECT * FROM students WHERE id = $1', [session.student_id]);
      studentsToNotify = student.rows;
    }

    await client.query('COMMIT');

    // Send reschedule notification emails
    for (const student of studentsToNotify) {
      try {
        await sendEmail(
          student.parent_email,
          'Class Rescheduled - Fluent Feathers Academy',
          getRescheduleEmailTemplate({
            parent_name: student.parent_name,
            student_name: student.name,
            session_number: updatedSessionNumber,
            old_date: oldDate,
            old_time: oldTime,
            new_date: converted.date,
            new_time: converted.time,
            reason: reason || 'Schedule adjustment',
            is_group: session.session_type === 'Group',
            group_name: student.group_name || '',
            timezone: student.parent_timezone || student.timezone || 'Asia/Kolkata'
          }),
          student.parent_name,
          'Reschedule'
        );
      } catch (emailErr) {
        console.error('Failed to send reschedule email to', student.parent_email, emailErr.message);
      }
    }

    clearAdminDashboardCache();
    res.json({
      message: 'Session rescheduled successfully!',
      new_date: converted.date,
      new_time: converted.time,
      students_notified: studentsToNotify.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/sessions/:sessionId/upload', handleUpload('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. If using Cloudinary, check credentials in Render environment variables.' });
  const col = { ppt:'ppt_file_path', recording:'recording_file_path', homework:'homework_file_path' }[req.body.materialType];
  if (!col) return res.status(400).json({ error: 'Invalid type' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Get file path - Cloudinary returns URL in path/secure_url, local storage uses filename
    let filePath;
    if (useCloudinary) {
      // Cloudinary - check multiple possible fields for the URL
      filePath = req.file.path || req.file.secure_url || req.file.url;
      console.log('📁 Cloudinary upload:', { path: req.file.path, secure_url: req.file.secure_url, url: req.file.url, filename: req.file.filename });
      if (!filePath) {
        throw new Error('Cloudinary did not return a file URL. Check your Cloudinary credentials.');
      }
    } else {
      // Local storage - use relative path
      filePath = '/uploads/materials/' + req.file.filename;
    }
    await client.query(`UPDATE sessions SET ${col} = $1 WHERE id = $2`, [filePath, req.params.sessionId]);
    const session = (await client.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId])).rows[0];

    // Also add to session_materials table for multiple file support
    await client.query(`
      INSERT INTO session_materials (session_id, material_type, file_name, file_path, file_size)
      VALUES ($1, $2, $3, $4, $5)
    `, [req.params.sessionId, req.body.materialType.toUpperCase(), req.file.originalname, filePath, req.file.size || 0]);

    const studentsQuery = session.session_type === 'Group' ? `SELECT id FROM students WHERE group_id = $1 AND is_active = true` : `SELECT $1 as id`;
    const students = await client.query(studentsQuery, [session.group_id || session.student_id]);
    for(const s of students.rows) {
      await client.query(`
        INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')
      `, [s.id, session.group_id, req.params.sessionId, session.session_date, req.body.materialType.toUpperCase(), req.file.originalname, filePath]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Material uploaded successfully!', filename: req.file.filename });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put('/api/sessions/:sessionId/notes', async (req, res) => {
  try {
    await pool.query('UPDATE sessions SET teacher_notes = $1 WHERE id = $2', [req.body.teacher_notes, req.params.sessionId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all materials for a session
app.get('/api/sessions/:sessionId/materials', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM session_materials WHERE session_id = $1 ORDER BY material_type, uploaded_at DESC',
      [req.params.sessionId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a specific material
app.delete('/api/session-materials/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT file_path FROM session_materials WHERE id = $1', [req.params.id]);
    if (existing.rows[0]) {
      await deleteFromCloudinary(existing.rows[0].file_path);
    }
    await pool.query('DELETE FROM session_materials WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Material deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save material link (for PPT, Recording, Homework links like Google Drive, YouTube, etc.)
app.post('/api/sessions/:sessionId/save-link', async (req, res) => {
  const { materialType, link } = req.body;
  const col = { ppt:'ppt_file_path', recording:'recording_file_path', homework:'homework_file_path' }[materialType];
  if (!col) return res.status(400).json({ error: 'Invalid material type' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Save link with LINK: prefix to identify it as a link
    await client.query(`UPDATE sessions SET ${col} = $1 WHERE id = $2`, ['LINK:' + link, req.params.sessionId]);

    // Also save to materials table for tracking
    const session = (await client.query('SELECT * FROM sessions WHERE id = $1', [req.params.sessionId])).rows[0];
    const studentsQuery = session.session_type === 'Group' ? `SELECT id FROM students WHERE group_id = $1 AND is_active = true` : `SELECT $1 as id`;
    const students = await client.query(studentsQuery, [session.group_id || session.student_id]);

    for(const s of students.rows) {
      await client.query(`
        INSERT INTO materials (student_id, group_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'Teacher')
      `, [s.id, session.group_id, req.params.sessionId, session.session_date, materialType.toUpperCase(), 'External Link', 'LINK:' + link]);
    }

    await client.query('COMMIT');
    res.json({ message: 'Link saved successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/sessions/:sessionId/grade/:studentId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { grade, comments } = req.body;
    const { sessionId, studentId } = req.params;
    await client.query('BEGIN');
    await client.query('UPDATE session_attendance SET homework_grade = $1, homework_comments = $2 WHERE session_id = $3 AND student_id = $4', [grade, comments, sessionId, studentId]);
    await client.query(`UPDATE materials SET feedback_grade = $1, feedback_comments = $2, feedback_given = 1, feedback_date = CURRENT_TIMESTAMP WHERE session_id = $3 AND student_id = $4 AND file_type = 'Homework'`, [grade, comments, sessionId, studentId]);
    await client.query('COMMIT');
    res.json({ message: 'Homework graded successfully!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/materials/:studentId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM materials WHERE student_id = $1 ORDER BY uploaded_at DESC', [req.params.studentId]);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        // Determine correct folder based on file type
        const folder = row.uploaded_by === 'Parent' ? 'homework' : 'materials';
        row.file_path = `/uploads/${folder}/` + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload/homework/:studentId', handleUpload('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. If using Cloudinary, check credentials in Render environment variables.' });
  try {
    // Duplicate guard: block re-submission of the same filename for the same session
    if (req.body.sessionId) {
      const dup = await pool.query(
        `SELECT id FROM materials WHERE student_id = $1 AND session_id = $2 AND file_name = $3 AND uploaded_by = 'Parent'`,
        [req.params.studentId, req.body.sessionId, req.file.originalname]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'duplicate', message: `'${req.file.originalname}' was already submitted for this session.` });
      }
    }

    // Get file path - Cloudinary returns URL in req.file.path, local storage uses filename
    let filePath;
    if (useCloudinary) {
      // Cloudinary: use secure_url if available, otherwise path
      filePath = req.file.secure_url || req.file.path || req.file.url;
      console.log('📁 Cloudinary homework upload:', { path: req.file.path, secure_url: req.file.secure_url, url: req.file.url });
      if (!filePath) {
        return res.status(500).json({ error: 'Cloudinary did not return file URL. Check your CLOUDINARY_URL or CLOUDINARY_API_KEY/SECRET/CLOUD_NAME in Render.' });
      }
    } else {
      // Local storage - use relative path
      filePath = '/uploads/homework/' + req.file.filename;
    }

    await pool.query(`
      INSERT INTO materials (student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
      VALUES ($1, $2, CURRENT_DATE, 'Homework', $3, $4, 'Parent')
    `, [req.params.studentId, req.body.sessionId, req.file.originalname, filePath]);

    // Award homework submission badge
    await awardBadge(req.params.studentId, 'hw_submit', '📝 Homework Hero', 'Submitted homework on time');

    // Check total homework submissions for milestone badges
    const hwCount = await pool.query('SELECT COUNT(*) as count FROM materials WHERE student_id = $1 AND file_type = \'Homework\'', [req.params.studentId]);
    const count = parseInt(hwCount.rows[0].count);

    if (count === 5) await awardBadge(req.params.studentId, '5_homework', '📚 5 Homework Superstar', 'Submitted 5 homework assignments!');
    if (count === 10) await awardBadge(req.params.studentId, '10_homework', '🎓 10 Homework Champion', 'Submitted 10 homework assignments!');
    if (count === 25) await awardBadge(req.params.studentId, '25_homework', '🏅 25 Homework Master', 'Submitted 25 homework assignments!');

    notifyAdminsStudentSubmission({
      studentId: req.params.studentId,
      submissionType: 'Homework',
      sessionId: req.body.sessionId || null,
      fileName: req.file.originalname || ''
    }).catch((notifyErr) => {
      console.warn('Homework admin push trigger failed:', notifyErr.message);
    });

    res.json({ message: 'Homework uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*, COUNT(DISTINCT er.id) as registered_count
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id
      GROUP BY e.id
      ORDER BY e.event_date DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, class_link, max_participants, send_email } = req.body;
  try {
    const utc = istToUTC(event_date, event_time);
    const result = await pool.query(`
      INSERT INTO events (event_name, event_description, event_date, event_time, event_duration, target_audience, specific_grades, class_link, max_participants, status)
      VALUES ($1, $2, $3::date, $4::time, $5, $6, $7, $8, $9, 'Active')
      RETURNING id
    `, [event_name, event_description || '', utc.date, utc.time, event_duration, target_audience || 'All', specific_grades || '', class_link || DEFAULT_CLASS, max_participants || null]);

    const eventId = result.rows[0].id;
    let students = [];

    if (target_audience === 'All' || !target_audience) {
      students = await pool.query('SELECT * FROM students WHERE is_active = true');
    } else if (target_audience === 'Specific Grades' && specific_grades) {
      students = await pool.query('SELECT * FROM students WHERE is_active = true AND grade = ANY($1)', [specific_grades.split(',').map(g=>g.trim())]);
    }

    let emailsSent = 0;
    if (students?.rows?.length > 0 && send_email !== false) {
      for(const student of students.rows) {
        const display = formatUTCToLocal(utc.date, utc.time, student.parent_timezone || student.timezone || 'Asia/Kolkata');
        const registrationLink = `${req.protocol}://${req.get('host')}/parent.html?event=${eventId}&student=${student.id}`;

        const eventEmailHTML = getEventEmail({
          parent_name: student.parent_name,
          event_name,
          event_description: event_description || '',
          event_date: display.date,
          event_time: display.time,
          event_timezone_label: getTimezoneLabel(student.parent_timezone || student.timezone || 'Asia/Kolkata'),
          event_duration,
          class_link: class_link || DEFAULT_CLASS,
          registration_link: registrationLink
        });

        await sendEmail(
          student.parent_email,
          `🎉 ${event_name} - Registration Open`,
          eventEmailHTML,
          student.parent_name,
          'Event'
        );
        emailsSent++;
      }
    }

    const message = send_email !== false
      ? `Event created and emails sent to ${emailsSent} students!`
      : `Event created successfully!`;
    res.json({ success: true, message, eventId });
  } catch (err) {
    console.error('Event creation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/events/:eventId/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id } = req.body;
    const eventId = req.params.eventId;

    await client.query('BEGIN');
    // Lock the event row to prevent race condition (overbooking)
    const eventResult = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
    const event = eventResult.rows[0];

    if (!event) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }

    if (event.max_participants && (event.current_participants || 0) >= event.max_participants) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Event is full' });
    }

    await client.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Parent')`, [eventId, student_id]);
    await client.query('UPDATE events SET current_participants = COALESCE(current_participants, 0) + 1 WHERE id = $1', [eventId]);
    await client.query('COMMIT');
    res.json({ message: 'Successfully registered for event!' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.constraint === 'event_registrations_event_id_student_id_key') {
      res.status(400).json({ error: 'Already registered for this event' });
    } else {
      res.status(500).json({ error: err.message });
    }
  } finally {
    client.release();
  }
});

app.post('/api/events/:eventId/register-manual', async (req, res) => {
  try {
    await pool.query(`INSERT INTO event_registrations (event_id, student_id, registration_method) VALUES ($1, $2, 'Manual')`, [req.params.eventId, req.body.student_id]);
    await pool.query('UPDATE events SET current_participants = current_participants + 1 WHERE id = $1', [req.params.eventId]);
    res.json({ message: 'Student registered successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:eventId/registrations', async (req, res) => {
  try {
    res.json((await pool.query(`
      SELECT er.*, s.name as student_name, s.grade, s.date_of_birth, s.parent_name, s.parent_email
      FROM event_registrations er
      JOIN students s ON er.student_id = s.id
      WHERE er.event_id = $1
    `, [req.params.eventId])).rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/:eventId/attendance', async (req, res) => {
  try {
    for(const record of req.body.attendanceData) {
      // Support both registration_id (for public registrations) and student_id (legacy)
      if (record.registration_id) {
        await pool.query('UPDATE event_registrations SET attendance = $1 WHERE id = $2 AND event_id = $3', [record.attendance, record.registration_id, req.params.eventId]);
      } else {
        await pool.query('UPDATE event_registrations SET attendance = $1 WHERE event_id = $2 AND student_id = $3', [record.attendance, req.params.eventId, record.student_id]);
      }
    }
    res.json({ message: 'Event attendance marked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/events/:id', async (req, res) => {
  const { event_name, event_description, event_duration, status, max_participants, class_link } = req.body;
  try {
    await pool.query(`
      UPDATE events SET
        event_name = $1,
        event_description = $2,
        event_duration = $3,
        status = $4,
        max_participants = $5,
        class_link = $6
      WHERE id = $7
    `, [event_name, event_description, event_duration, status, max_participants, class_link, req.params.id]);
    res.json({ success: true, message: 'Event updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM event_registrations WHERE event_id = $1', [req.params.id]);
    await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/student/:studentId', async (req, res) => {
  try {
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];
    const today = new Date().toISOString().split('T')[0];

    const events = await pool.query(`
      SELECT e.*,
        CASE WHEN er.id IS NOT NULL THEN true ELSE false END as is_registered
      FROM events e
      LEFT JOIN event_registrations er ON e.id = er.event_id AND er.student_id = $1
      WHERE e.status = 'Active'
        AND e.event_date >= $2
        AND (
          e.target_audience = 'All'
          OR (e.target_audience = 'Specific Grades' AND e.specific_grades LIKE '%' || $3 || '%')
        )
      ORDER BY e.event_date ASC
    `, [req.params.studentId, today, student.grade]);

    res.json(events.rows);
  } catch (err) {
    console.error('Error loading events for student:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PUBLIC EVENT REGISTRATION (No Auth Required) ====================

// Get public event details for registration page
app.get('/api/public/event/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, event_name, event_description, event_date, event_time, event_duration,
             max_participants, current_participants, status, class_link
      FROM events WHERE id = $1 AND status = 'Active'
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found or not active' });
    }

    const event = result.rows[0];
    // Check if event is full
    if (event.max_participants && event.current_participants >= event.max_participants) {
      event.is_full = true;
    } else {
      event.is_full = false;
      event.spots_left = event.max_participants ? event.max_participants - event.current_participants : null;
    }

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public event registration (from Instagram, website, etc.)
app.post('/api/public/event/:id/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { parent_name, child_name, child_age, email, phone, parent_timezone } = req.body;
    const eventId = req.params.id;
    const parentTimezone = parent_timezone || 'Asia/Kolkata';

    // Validate required fields
    if (!parent_name || !child_name || !email || !phone || !parent_timezone) {
      return res.status(400).json({ error: 'Please fill all required fields' });
    }

    await client.query('BEGIN');

    // Lock the event row to prevent race condition (overbooking)
    const eventResult = await client.query('SELECT * FROM events WHERE id = $1 AND status = $2 FOR UPDATE', [eventId, 'Active']);
    const event = eventResult.rows[0];

    if (!event) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found or not active' });
    }

    // Check if event is full
    if (event.max_participants && (event.current_participants || 0) >= event.max_participants) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Sorry, this event is full!' });
    }

    // Check for duplicate registration by email
    const existingReg = await client.query(
      'SELECT id FROM event_registrations WHERE event_id = $1 AND email = $2',
      [eventId, email]
    );
    if (existingReg.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You have already registered for this event with this email' });
    }

    // Insert public registration
    await client.query(`
      INSERT INTO event_registrations (event_id, parent_name, child_name, child_age, email, phone, parent_timezone, registration_source, registration_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'public', 'Public Form')
    `, [eventId, parent_name, child_name, child_age || '', email, phone, parentTimezone]);

    // Update participant count
    await client.query('UPDATE events SET current_participants = COALESCE(current_participants, 0) + 1 WHERE id = $1', [eventId]);

    await client.query('COMMIT');

    // Send confirmation email
    try {
      const localEvent = formatUTCToLocal(event.event_date, event.event_time, parentTimezone);
      const eventDate = `${localEvent.day}, ${localEvent.date}`;
      const eventTime = `${localEvent.time} (${getTimezoneLabel(parentTimezone)})`;

      await sendEmail(email, 'Event Registration Confirmed! 🎉', `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #667eea; margin: 0;">🎉 Registration Confirmed!</h1>
          </div>

          <p style="font-size: 16px; color: #333;">Dear ${escapeHtml(parent_name)},</p>

          <p style="font-size: 16px; color: #333;">Thank you for registering <strong>${escapeHtml(child_name)}</strong> for our event!</p>

          <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 25px; border-radius: 12px; margin: 20px 0; color: white;">
            <h2 style="margin: 0 0 15px; font-size: 22px;">${event.event_name}</h2>
            <p style="margin: 5px 0;"><strong>📅 Date:</strong> ${eventDate}</p>
            <p style="margin: 5px 0;"><strong>🕐 Time:</strong> ${eventTime}</p>
            ${event.event_duration ? `<p style="margin: 5px 0;"><strong>⏱️ Duration:</strong> ${event.event_duration}</p>` : ''}
            ${event.class_link ? `<p style="margin: 15px 0 5px;"><strong>🔗 Join Link:</strong></p><a href="${event.class_link}" style="color: #ffd700; word-break: break-all;">${event.class_link}</a>` : ''}
          </div>

          <p style="font-size: 14px; color: #666;">We look forward to seeing ${escapeHtml(child_name)} at the event!</p>

          <p style="font-size: 14px; color: #666; margin-top: 30px;">
            Warm regards,<br>
            <strong>Fluent Feathers Academy</strong>
          </p>
        </div>
      `);
    } catch (emailErr) {
      console.error('Failed to send confirmation email:', emailErr);
      // Don't fail the registration if email fails
    }

    res.json({
      success: true,
      message: 'Successfully registered! Check your email for confirmation.',
      event_name: event.event_name
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Public registration error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== PUBLIC DEMO REGISTRATION ====================
app.post('/api/public/demo-register', async (req, res) => {
  try {
    const { child_name, child_age, program_interest, parent_name, email, phone, student_timezone, parent_timezone } = req.body;

    // Validate required fields
    if (!child_name || !child_age || !program_interest || !parent_name || !email || !phone || !student_timezone || !parent_timezone) {
      return res.status(400).json({ error: 'All fields are required, including student and parent timezones' });
    }

    // Check for duplicate email in demo_leads (prevent double registrations)
    const existing = await pool.query(
      `SELECT id FROM demo_leads WHERE parent_email = $1 AND status NOT IN ('Converted', 'Not Interested', 'No Show')`,
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You have already registered for a demo class. We will contact you shortly!' });
    }

    const studentTimezone = student_timezone || 'Asia/Kolkata';
    const parentTimezone = parent_timezone || studentTimezone || 'Asia/Kolkata';

    // Insert into demo_leads
    const result = await pool.query(`
      INSERT INTO demo_leads (child_name, child_grade, parent_name, parent_email, phone, program_interest, student_timezone, parent_timezone, source, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Website Form', 'Pending')
      RETURNING *
    `, [child_name, child_age, parent_name, email, phone, program_interest, studentTimezone, parentTimezone]);

    // Send confirmation email
    try {
      const confirmationHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">🎯</div>
      <h1 style="margin: 0; color: white; font-size: 28px;">Free Demo Class Registration</h1>
      <p style="color: rgba(255,255,255,0.9); margin-top: 10px; font-size: 16px;">We're excited to class ${child_name}!</p>
    </div>
    <div style="padding: 30px;">
      <p style="font-size: 16px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${parent_name}</strong>,</p>
      <p style="font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px;">
        Thank you for registering <strong>${child_name}</strong> for a free demo class at <strong style="color: #B05D9E;">Fluent Feathers Academy</strong>!
      </p>

      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px; color: #2d3748; font-size: 16px;">Registration Details:</h3>
        <table style="width: 100%; font-size: 14px; color: #4a5568;">
          <tr><td style="padding: 8px 0;">Child's Name:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${child_name}</td></tr>
          <tr><td style="padding: 8px 0;">Age:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${child_age}</td></tr>
          <tr><td style="padding: 8px 0;">Program:</td><td style="padding: 8px 0; text-align: right; font-weight: bold; color: #B05D9E;">${program_interest}</td></tr>
          <tr><td style="padding: 8px 0;">Student Timezone:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${studentTimezone}</td></tr>
          <tr><td style="padding: 8px 0;">Parent Timezone:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${parentTimezone}</td></tr>
        </table>
      </div>

      <div style="background: linear-gradient(135deg, #e9d8fd 0%, #faf5ff 100%); padding: 20px; border-radius: 10px; border-left: 4px solid #B05D9E; margin: 25px 0;">
        <p style="margin: 0; font-size: 15px; color: #553c9a; line-height: 1.6;">
          <strong>What's next?</strong><br>
          Our team will contact you shortly to schedule a convenient time for ${child_name}'s free demo class. Stay tuned!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568;">
        Warm regards,<br>
        <strong style="color: #B05D9E;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 15px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body></html>`;

      await sendEmail(
        email,
        `🎯 Demo Class Registration Confirmed - ${child_name} | Fluent Feathers Academy`,
        confirmationHTML,
        parent_name,
        'Demo-Registration'
      );
    } catch (emailErr) {
      console.error('Failed to send demo registration email:', emailErr);
      // Registration still succeeds even if email fails
    }

    console.log(`✅ New demo registration from website: ${child_name} (${program_interest}) - ${parent_name} <${email}>`);
    res.json({ success: true, message: 'Demo class registration successful!' });
  } catch (err) {
    console.error('Demo registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Summer Camp Registration
app.post('/api/public/summer-camp-register', async (req, res) => {
  try {
    const { child_name, child_age, parent_name, email, phone, timezone } = req.body;

    // Validate required fields
    if (!child_name || !child_age || !parent_name || !email || !phone || !timezone) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Check for duplicate email in demo_leads (prevent double registrations)
    const existing = await pool.query(
      `SELECT id FROM demo_leads WHERE parent_email = $1 AND type = 'summer_camp' AND status NOT IN ('Converted', 'Not Interested', 'No Show')`,
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You have already registered for summer camp. We will contact you shortly!' });
    }

    // Insert into demo_leads with type summer_camp
    const result = await pool.query(`
      INSERT INTO demo_leads (child_name, child_grade, parent_name, parent_email, phone, student_timezone, parent_timezone, source, status, type)
      VALUES ($1, $2, $3, $4, $5, $6, $6, 'Website Form', 'Pending', 'summer_camp')
      RETURNING *
    `, [child_name, child_age, parent_name, email, phone, timezone]);

    // Send confirmation email
    try {
      const confirmationHTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f0f4f8; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #B05D9E 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
      <div style="font-size: 50px; margin-bottom: 10px;">☀️</div>
      <h1 style="margin: 0; color: white; font-size: 28px;">Summer Camp Registration</h1>
      <p style="color: rgba(255,255,255,0.9); margin-top: 10px; font-size: 16px;">We're excited to have ${child_name} join our summer camp!</p>
    </div>
    <div style="padding: 30px;">
      <p style="font-size: 16px; color: #2d3748; margin-bottom: 20px;">Dear <strong>${parent_name}</strong>,</p>
      <p style="font-size: 15px; color: #4a5568; line-height: 1.7; margin-bottom: 20px;">
        Thank you for registering <strong>${child_name}</strong> for our exciting <strong style="color: #B05D9E;">Summer Camp</strong> at Fluent Feathers Academy!
      </p>
      <div style="background: #f7fafc; padding: 20px; border-radius: 10px; margin: 25px 0;">
        <h3 style="margin: 0 0 15px; color: #2d3748; font-size: 16px;">Registration Details:</h3>
        <table style="width: 100%; font-size: 14px; color: #4a5568;">
          <tr><td style="padding: 8px 0;">Child's Name:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${child_name}</td></tr>
          <tr><td style="padding: 8px 0;">Age:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${child_age}</td></tr>
          <tr><td style="padding: 8px 0;">Timezone:</td><td style="padding: 8px 0; text-align: right; font-weight: bold;">${timezone}</td></tr>
        </table>
      </div>

      <div style="background: linear-gradient(135deg, #e9d8fd 0%, #faf5ff 100%); padding: 20px; border-radius: 10px; border-left: 4px solid #B05D9E; margin: 25px 0;">
        <p style="margin: 0; font-size: 15px; color: #553c9a; line-height: 1.6;">
          <strong>What's next?</strong><br>
          Our team will contact you shortly with more details about the summer camp schedule and activities. Stay tuned!
        </p>
      </div>

      <p style="margin: 25px 0 0; font-size: 15px; color: #4a5568;">
        Warm regards,<br>
        <strong style="color: #B05D9E;">Team Fluent Feathers Academy</strong>
      </p>
    </div>
    <div style="background: #f7fafc; padding: 15px 30px; text-align: center; border-top: 1px solid #e2e8f0;">
      <p style="margin: 0; color: #718096; font-size: 13px;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body></html>`;

      await sendEmail(
        email,
        `☀️ Summer Camp Registration Confirmed - ${child_name} | Fluent Feathers Academy`,
        confirmationHTML,
        parent_name,
        'Summer-Camp-Registration'
      );
    } catch (emailErr) {
      console.error('Failed to send summer camp registration email:', emailErr);
      // Registration still succeeds even if email fails
    }

    console.log(`✅ New summer camp registration from website: ${child_name} - ${parent_name} <${email}>`);
    res.json({ success: true, message: 'Summer camp registration successful!' });
  } catch (err) {
    console.error('Summer camp registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Get summer camp leads
app.get('/api/summer-camp-leads', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM demo_leads WHERE type = 'summer_camp' ORDER BY created_at DESC");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/birthday-cards', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 60);
    const age = parseInt(req.body.age, 10);
    const wish = String(req.body.wish || '').trim().slice(0, 500);

    if (!name) return res.status(400).json({ error: 'Student name is required' });
    if (!age || age < 1 || age > 100) return res.status(400).json({ error: 'Age must be between 1 and 100' });
    if (!wish) return res.status(400).json({ error: 'Birthday wish is required' });

    let code = '';
    for (let i = 0; i < 5; i++) {
      code = crypto.randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
      if (!code) continue;
      const exists = await executeQuery('SELECT 1 FROM birthday_cards WHERE code = $1 LIMIT 1', [code]);
      if (exists.rows.length === 0) break;
      code = '';
    }

    if (!code) return res.status(500).json({ error: 'Could not create a short birthday link' });

    await executeQuery(`
      INSERT INTO birthday_cards (code, student_name, age, wish_message)
      VALUES ($1, $2, $3, $4)
    `, [code, name, age, wish]);

    res.json({
      code,
      url: `${req.protocol}://${req.get('host')}/b/${code}`
    });
  } catch (err) {
    console.error('Create birthday card error:', err);
    res.status(500).json({ error: 'Failed to create birthday card link' });
  }
});

app.get('/api/public/birthday-cards/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const result = await executeQuery(`
      SELECT student_name, age, wish_message
      FROM birthday_cards
      WHERE code = $1
      LIMIT 1
    `, [code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Birthday card not found' });
    }

    const row = result.rows[0];
    res.json({
      name: row.student_name,
      age: row.age,
      wish: row.wish_message
    });
  } catch (err) {
    console.error('Get birthday card error:', err);
    res.status(500).json({ error: 'Failed to load birthday card' });
  }
});

// Get all registrations for an event (including public registrations)
app.get('/api/events/:eventId/all-registrations', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT er.*,
             COALESCE(s.name, er.child_name) as display_child_name,
             COALESCE(s.parent_name, er.parent_name) as display_parent_name,
             COALESCE(s.parent_email, er.email) as display_email,
             COALESCE(
               CASE WHEN s.date_of_birth IS NOT NULL THEN EXTRACT(YEAR FROM AGE(s.date_of_birth))::TEXT || ' years' ELSE s.grade END,
               er.child_age
             ) as display_grade,
             s.primary_contact as student_phone,
             CASE WHEN er.student_id IS NOT NULL THEN 'Existing Student' ELSE 'Public Registration' END as reg_type
      FROM event_registrations er
      LEFT JOIN students s ON er.student_id = s.id
      WHERE er.event_id = $1
      ORDER BY er.registered_at DESC
    `, [req.params.eventId]);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint to get event certificate data (no auth required)
app.get('/api/event-certificate/:registrationId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT er.id, er.event_id, er.certificate_sent,
             COALESCE(s.name, er.child_name) as child_name,
             COALESCE(s.parent_email, er.email) as email,
             e.event_name, e.event_date, e.event_description
      FROM event_registrations er
      LEFT JOIN students s ON er.student_id = s.id
      LEFT JOIN events e ON er.event_id = e.id
      WHERE er.id = $1
    `, [req.params.registrationId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send participation certificates to event attendees
app.post('/api/events/:eventId/send-certificates', async (req, res) => {
  try {
    const { registration_ids } = req.body;
    const event = (await pool.query('SELECT * FROM events WHERE id = $1', [req.params.eventId])).rows[0];
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
    let sent = 0;

    for (const regId of registration_ids) {
      const reg = (await pool.query(`
        SELECT er.id, er.student_id, er.email as reg_email, er.child_name as reg_child_name, er.parent_name as reg_parent_name,
               s.name as student_name, s.parent_email, s.parent_name as student_parent_name
        FROM event_registrations er
        LEFT JOIN students s ON er.student_id = s.id
        WHERE er.id = $1 AND er.event_id = $2
      `, [regId, req.params.eventId])).rows[0];

      if (!reg) continue;

      const childName = reg.student_name || reg.reg_child_name || 'Student';
      const parentEmail = reg.parent_email || reg.reg_email;
      const parentName = reg.student_parent_name || reg.reg_parent_name || '';

      if (!parentEmail) continue;

      const certificateUrl = `${appUrl}/event-certificate.html?id=${regId}`;
      const eventDate = new Date(event.event_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

      const emailHtml = getEventCertificateEmail({
        childName,
        eventName: event.event_name,
        eventDate,
        certificateUrl
      });

      const emailSent = await sendEmail(
        parentEmail,
        `🏆 Participation Certificate - ${event.event_name}`,
        emailHtml,
        parentName,
        'Event Certificate'
      );

      if (emailSent) {
        await pool.query('UPDATE event_registrations SET certificate_sent = TRUE WHERE id = $1', [regId]);
        sent++;
      }
    }

    res.json({ message: `Certificates sent to ${sent} participants!`, sent });
  } catch (err) {
    console.error('Send certificates error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email-logs', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const countResult = await pool.query('SELECT COUNT(*) as total FROM email_log');
    const r = await pool.query('SELECT * FROM email_log ORDER BY sent_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json({ logs: r.rows, total: parseInt(countResult.rows[0].total), page, limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/past/all', async (req, res) => {
  // Only cache the default admin view (limit=120, no other params)
  const isDefaultQuery = !req.query.limit || req.query.limit === '120';
  if (isDefaultQuery && adminPastCache.data && (Date.now() - adminPastCache.ts) < ADMIN_PAST_TTL_MS) {
    res.set('X-Cache', 'HIT');
    return res.json(adminPastCache.data);
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const requestedLimit = Math.min(Math.max(parseInt(req.query.limit) || 50, 10), 300);

    // Compute chronological session numbering per student/group (oldest -> newest)
    const r = await executeQuery(`
      WITH numbered_sessions AS (
        SELECT s.id, s.session_date, s.session_time, s.session_number, s.status, s.session_type,
               s.ppt_file_path, s.recording_file_path, s.homework_file_path,
               s.teacher_notes, s.session_topic, s.student_id, s.group_id,
               COALESCE(st.name, g.group_name, 'Unknown') as student_name,
               COALESCE(st.timezone, g.timezone, 'Asia/Kolkata') as timezone,
               g.group_name,
               ROW_NUMBER() OVER (
                 PARTITION BY s.session_type,
                   COALESCE(CASE WHEN s.session_type = 'Private' THEN s.student_id ELSE s.group_id END, -1)
                 ORDER BY s.session_date ASC, COALESCE(s.session_time, '00:00:00'::time) ASC, s.id ASC
               )::INT AS chronological_session_number
        FROM sessions s
        LEFT JOIN students st ON s.student_id = st.id AND s.session_type = 'Private'
        LEFT JOIN groups g ON s.group_id = g.id AND s.session_type = 'Group'
        WHERE COALESCE(s.status, 'Pending') <> 'Cancelled'
      )
      SELECT *
      FROM numbered_sessions s
      WHERE s.session_date <= $1
      ORDER BY s.session_date DESC, s.session_time DESC
      LIMIT $2
    `, [today, requestedLimit]);

    // Fix file paths for backwards compatibility (skip Cloudinary URLs)
    const fixed = r.rows.map(session => {
      const needsPrefix = (path) => path && !path.startsWith('/uploads/') && !path.startsWith('LINK:') && !path.startsWith('https://') && !path.startsWith('http://');
      if (needsPrefix(session.ppt_file_path)) {
        session.ppt_file_path = '/uploads/materials/' + session.ppt_file_path;
      }
      if (needsPrefix(session.recording_file_path)) {
        session.recording_file_path = '/uploads/materials/' + session.recording_file_path;
      }
      if (needsPrefix(session.homework_file_path)) {
        session.homework_file_path = '/uploads/materials/' + session.homework_file_path;
      }
      return session;
    });

    if (isDefaultQuery) {
      adminPastCache = { data: fixed, ts: Date.now() };
    }
    res.json(fixed);
  } catch (err) {
    // Serve stale cache if DB fails
    if (isDefaultQuery && adminPastCache.data) {
      res.set('X-Cache', 'STALE');
      return res.json(adminPastCache.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// Upcoming private sessions for bulk reschedule student picker
app.get('/api/students/:id/upcoming-sessions', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, session_number, session_date, session_time, status
      FROM sessions
      WHERE student_id = $1
        AND session_type = 'Private'
        AND status IN ('Pending', 'Scheduled')
        AND session_date >= CURRENT_DATE
      ORDER BY session_date ASC, session_time ASC
      LIMIT 200
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel one student from a group session (Excused/Unexcused)
app.post('/api/sessions/:sessionId/group-cancel-student', async (req, res) => {
  const client = await pool.connect();
  try {
    const { student_id, attendance, reason, notes } = req.body;
    const sessionId = req.params.sessionId;

    if (!student_id) return res.status(400).json({ error: 'student_id is required' });
    if (!['Excused', 'Unexcused'].includes(attendance)) return res.status(400).json({ error: 'attendance must be Excused or Unexcused' });

    await client.query('BEGIN');

    const sessionCheck = await client.query('SELECT id FROM sessions WHERE id = $1 AND session_type = $2', [sessionId, 'Group']);
    if (sessionCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Group session not found' });
    }

    const prev = await client.query(
      'SELECT attendance FROM session_attendance WHERE session_id = $1 AND student_id = $2',
      [sessionId, student_id]
    );
    const prevAttendance = prev.rows[0]?.attendance;

    await client.query(`
      INSERT INTO session_attendance (session_id, student_id, attendance)
      VALUES ($1, $2, $3)
      ON CONFLICT (session_id, student_id)
      DO UPDATE SET attendance = EXCLUDED.attendance
    `, [sessionId, student_id, attendance]);

    const wasPresent = prevAttendance === 'Present';
    const wasExcused = prevAttendance === 'Excused';
    const wasPending = !prevAttendance || prevAttendance === 'Pending';

    if (wasPresent) {
      await client.query(`UPDATE students SET completed_sessions = GREATEST(completed_sessions - 1, 0) WHERE id = $1`, [student_id]);
    }

    if (attendance === 'Excused') {
      const existingCredit = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND original_session_id = $2',
        [student_id, sessionId]
      );
      if (existingCredit.rows.length === 0) {
        await client.query(`
          INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by, notes)
          VALUES ($1, $2, $3, CURRENT_DATE, 'Available', 'admin', $4)
        `, [student_id, sessionId, reason || 'Parent requested cancellation (group class)', notes || '']);
      }

      if (wasPending) {
        await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`, [student_id]);
      }
    } else {
      if (wasExcused) {
        await client.query(
          `DELETE FROM makeup_classes WHERE student_id = $1 AND original_session_id = $2 AND status = 'Available'`,
          [student_id, sessionId]
        );
      }

      if (wasPending) {
        await client.query(`UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`, [student_id]);
      }
    }

    await client.query('COMMIT');

    // Send cancellation email to parent
    try {
      const sessionResult = await client.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
      const session = sessionResult.rows[0];
      const studentResult = await client.query('SELECT * FROM students WHERE id = $1', [student_id]);
      const student = studentResult.rows[0];

      if (student && student.parent_email && session) {
        const parentTimezone = student.parent_timezone || student.timezone || 'Asia/Kolkata';
        const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
        const timezoneLabel = getTimezoneLabel(parentTimezone);

        const fallbackDate = session.session_date instanceof Date
          ? session.session_date.toISOString().split('T')[0]
          : (typeof session.session_date === 'string' && session.session_date.includes('T')
            ? session.session_date.split('T')[0]
            : String(session.session_date || 'N/A'));
        const fallbackTime = (session.session_time || 'N/A').toString().substring(0, 8);

        const safeSessionDate = localTime && localTime.date && localTime.date !== 'Invalid Date'
          ? `${localTime.day ? `${localTime.day}, ` : ''}${localTime.date}`
          : fallbackDate;
        const safeSessionTime = localTime && localTime.time && localTime.time !== 'Invalid Time'
          ? `${localTime.time} (${timezoneLabel})`
          : `${fallbackTime} (${timezoneLabel})`;

        const emailHTML = getClassCancelledEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          sessionDate: safeSessionDate,
          sessionTime: safeSessionTime,
          cancelledBy: 'Teacher',
          reason: reason || 'Class cancelled',
          hasMakeupCredit: attendance === 'Excused'
        });

        await sendEmail(
          student.parent_email,
          `📅 Class Cancelled - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Class-Cancelled'
        );
      }
    } catch (emailErr) {
      console.error('Failed to send cancellation email (group):', emailErr);
    }

    res.json({ success: true, message: attendance === 'Excused' ? 'Student marked Excused and makeup credit added' : 'Student marked Unexcused (no makeup credit)' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/parent/cancel-class', async (req, res) => {
  const id = req.adminStudentId || req.body.student_id;
  const client = await pool.connect();
  try {
    // Check if student is a summer camp student
    const studentCheck = await client.query('SELECT is_summer_camp FROM students WHERE id = $1', [id]);
    if (studentCheck.rows.length > 0 && studentCheck.rows[0].is_summer_camp) {
      return res.status(400).json({ error: 'Summer camp students cannot cancel classes. Recordings will be provided for missed sessions.' });
    }

    // Try private session first
    let session = (await client.query('SELECT * FROM sessions WHERE id = $1 AND student_id = $2', [req.body.session_id, id])).rows[0];
    let isGroup = false;
    let prevAttendance = null;

    // If not found, check if it's a group session the student is enrolled in
    if (!session) {
      const groupCheck = await client.query(`
        SELECT s.*, sa.id as attendance_id, sa.attendance as prev_attendance
        FROM sessions s
        JOIN session_attendance sa ON sa.session_id = s.id AND sa.student_id = $2
        WHERE s.id = $1 AND s.session_type = 'Group'
      `, [req.body.session_id, id]);
      if (groupCheck.rows.length > 0) {
        session = groupCheck.rows[0];
        isGroup = true;
        prevAttendance = groupCheck.rows[0].prev_attendance || 'Pending';
      }
    }

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const sessionTime = new Date(`${session.session_date}T${session.session_time}Z`);
    const oneHour = 60 * 60 * 1000;
    if ((sessionTime - new Date()) < oneHour) {
      return res.status(400).json({ error: 'Cannot cancel class less than 1 hour before start.' });
    }

    // Get student details for email
    const studentResult = await client.query('SELECT * FROM students WHERE id = $1', [id]);
    const student = studentResult.rows[0];

    await client.query('BEGIN');

    if (isGroup) {
      // For group sessions: mark this student's attendance as Excused, don't cancel the whole session
      if (prevAttendance === 'Excused') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This class is already cancelled for this student.' });
      }

      await client.query(
        'UPDATE session_attendance SET attendance = $1 WHERE session_id = $2 AND student_id = $3',
        ['Excused', session.id, id]
      );

      // If class was previously counted as completed, reverse completion count.
      if (prevAttendance === 'Present') {
        await client.query(
          'UPDATE students SET completed_sessions = GREATEST(completed_sessions - 1, 0) WHERE id = $1',
          [id]
        );
      }

      // Decrement remaining only when transitioning from Pending/unmarked.
      if (!prevAttendance || prevAttendance === 'Pending') {
        await client.query(
          `UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`,
          [id]
        );
      }
    } else {
      // For private sessions: cancel the entire session and decrement remaining count
      if (session.status === 'Cancelled by Parent' || session.status === 'Cancelled') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'This class is already cancelled.' });
      }

      await client.query('UPDATE sessions SET status = $1, cancelled_by = $2 WHERE id = $3', ['Cancelled by Parent', 'Parent', session.id]);
      await client.query(
        `UPDATE students SET remaining_sessions = GREATEST(remaining_sessions - 1, 0), renewal_reminder_sent = false WHERE id = $1`,
        [id]
      );
    }

    // Give makeup credit in both cases (idempotent for the same session)
    const existingCredit = await client.query(
      'SELECT id FROM makeup_classes WHERE student_id = $1 AND original_session_id = $2',
      [id, session.id]
    );
    if (existingCredit.rows.length === 0) {
      await client.query(
        `INSERT INTO makeup_classes (student_id, original_session_id, reason, credit_date, status, added_by) VALUES ($1, $2, $3, CURRENT_DATE, 'Available', 'parent')`,
        [id, session.id, req.body.reason || 'Parent cancelled']
      );
    }

    await client.query('COMMIT');

    // Send cancellation confirmation email to parent
    if (student && student.parent_email) {
      try {
        const parentTimezone = student.parent_timezone || student.timezone || 'Asia/Kolkata';
        const localTime = formatUTCToLocal(session.session_date, session.session_time, parentTimezone);
        const timezoneLabel = getTimezoneLabel(parentTimezone);

        const emailHTML = getClassCancelledEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          sessionDate: `${localTime.day}, ${localTime.date}`,
          sessionTime: `${localTime.time} (${timezoneLabel})`,
          cancelledBy: 'Parent',
          reason: req.body.reason || 'Parent cancelled',
          hasMakeupCredit: true
        });

        await sendEmail(
          student.parent_email,
          `📅 Class Cancelled - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Class-Cancelled'
        );
      } catch (emailErr) {
        console.error('Failed to send cancellation email:', emailErr);
      }
    }

    res.json({ message: 'Class cancelled! Makeup credit added.' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/students/:studentId/makeup-credits', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  try {
    res.json((await pool.query('SELECT * FROM makeup_classes WHERE student_id = $1 AND status = \'Available\'', [id])).rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get full makeup credit history for a student (including used/scheduled)
app.get('/api/students/:studentId/makeup-history', async (req, res) => {
  const id = req.adminStudentId || req.params.studentId;
  try {
    const result = await pool.query(`
      SELECT m.*, s.session_date as scheduled_session_date, s.session_time as scheduled_session_time
      FROM makeup_classes m
      LEFT JOIN sessions s ON m.scheduled_session_id = s.id
      WHERE m.student_id = $1
      ORDER BY m.created_at DESC
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Manually add makeup credit for a student
app.post('/api/students/:studentId/makeup-credits', async (req, res) => {
  try {
    const { reason, notes } = req.body;
    const studentId = req.params.studentId;

    // Get student details for email
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
    const student = studentResult.rows[0];

    await pool.query(`
      INSERT INTO makeup_classes (student_id, reason, credit_date, status, added_by, notes)
      VALUES ($1, $2, CURRENT_DATE, 'Available', 'admin', $3)
    `, [studentId, reason || 'Emergency - added by admin', notes || '']);

    // Send email to parent about makeup credit
    if (student && student.parent_email) {
      try {
        const emailHTML = getMakeupCreditAddedEmail({
          parentName: student.parent_name || 'Parent',
          studentName: student.name,
          reason: reason || 'Emergency - added by admin',
          notes: notes
        });

        await sendEmail(
          student.parent_email,
          `🎁 Makeup Credit Added - ${student.name}`,
          emailHTML,
          student.parent_name,
          'Makeup-Credit'
        );
      } catch (emailErr) {
        console.error('Failed to send makeup credit email:', emailErr);
      }
    }

    res.json({ success: true, message: 'Makeup credit added successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete a makeup credit
app.delete('/api/makeup-credits/:creditId', async (req, res) => {
  try {
    const { creditId } = req.params;

    // Check if credit exists and is available (not already used)
    const credit = await pool.query('SELECT * FROM makeup_classes WHERE id = $1', [creditId]);
    if (credit.rows.length === 0) {
      return res.status(404).json({ error: 'Makeup credit not found' });
    }

    if (credit.rows[0].status === 'Scheduled' || credit.rows[0].status === 'Used') {
      return res.status(400).json({ error: 'Cannot delete a makeup credit that has already been scheduled or used' });
    }

    await pool.query('DELETE FROM makeup_classes WHERE id = $1', [creditId]);
    res.json({ success: true, message: 'Makeup credit deleted successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Schedule a makeup class using a credit
app.put('/api/makeup-credits/:creditId/schedule', async (req, res) => {
  const client = await pool.connect();
  try {
    const { creditId } = req.params;
    const { session_date, session_time, student_id } = req.body;

    // Check if student is a summer camp student
    const studentCheck = await client.query('SELECT is_summer_camp FROM students WHERE id = $1', [student_id]);
    if (studentCheck.rows.length > 0 && studentCheck.rows[0].is_summer_camp) {
      return res.status(400).json({ error: 'Summer camp students cannot use makeup credits. Recordings are provided for missed sessions.' });
    }

    // Verify credit exists and is available
    const credit = await client.query('SELECT * FROM makeup_classes WHERE id = $1 AND status = $2', [creditId, 'Available']);
    if (credit.rows.length === 0) {
      return res.status(400).json({ error: 'Makeup credit not found or already used' });
    }

    // Get student info for timezone and class link
    const student = await client.query('SELECT * FROM students WHERE id = $1', [student_id]);
    if (student.rows.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }

    await client.query('BEGIN');

    // Convert to UTC
    const utc = istToUTC(session_date, session_time);

    // Get next session number for this student
    const countResult = await client.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [student_id]);
    const sessionNumber = parseInt(countResult.rows[0].count) + 1;

    // Create the makeup session
    const sessionResult = await client.query(`
      INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, class_link, status, notes)
      VALUES ($1, 'Private', $2, $3::date, $4::time, $5, 'Scheduled', 'Makeup Class')
      RETURNING id
    `, [student_id, sessionNumber, utc.date, utc.time, student.rows[0].class_link || DEFAULT_CLASS]);

    const newSessionId = sessionResult.rows[0].id;

    // Mark the credit as used and link to the new session
    await client.query(`
      UPDATE makeup_classes
      SET status = 'Scheduled', used_date = CURRENT_DATE, scheduled_session_id = $1, scheduled_date = $2, scheduled_time = $3
      WHERE id = $4
    `, [newSessionId, session_date, session_time, creditId]);

    // Increment remaining_sessions so the scheduled makeup class shows in the count
    await client.query('UPDATE students SET remaining_sessions = remaining_sessions + 1 WHERE id = $1', [student_id]);

    await renumberPrivateSessionsForStudent(student_id, client);
    const renumbered = await client.query('SELECT session_number FROM sessions WHERE id = $1', [newSessionId]);
    const finalSessionNumber = renumbered.rows[0]?.session_number || sessionNumber;

    await client.query('COMMIT');

    // Send email notification to parent
    const studentData = student.rows[0];
    const localTime = formatUTCToLocal(utc.date, utc.time, studentData.parent_timezone || studentData.timezone || 'Asia/Kolkata');
    const timezoneLabel = getTimezoneLabel(studentData.parent_timezone || studentData.timezone || 'Asia/Kolkata');

    if (studentData.parent_email) {
      const emailHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0; padding:0; font-family: 'Segoe UI', sans-serif; background-color: #f0f4f8;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Makeup Class Scheduled!</h1>
    </div>
    <div style="padding: 30px;">
      <p style="font-size: 16px; color: #2d3748;">Dear <strong>${studentData.parent_name}</strong>,</p>
      <p style="font-size: 15px; color: #4a5568;">Great news! A makeup class has been scheduled for <strong>${studentData.name}</strong>.</p>

      <div style="background: #f7fafc; border-left: 4px solid #f093fb; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <h3 style="color: #f093fb; margin-top: 0;">📅 Class Details</h3>
        <p style="margin: 5px 0;"><strong>Date:</strong> ${localTime.day}, ${localTime.date}</p>
        <p style="margin: 5px 0;"><strong>Time:</strong> ${localTime.time} (${timezoneLabel})</p>
        <p style="margin: 5px 0;"><strong>Type:</strong> Makeup Class</p>
      </div>

      <div style="text-align: center; margin: 25px 0;">
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/join-class?sid=${newSessionId}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 35px; text-decoration: none; border-radius: 25px; font-weight: bold;">🎥 Join Class</a>
      </div>

      <p style="font-size: 14px; color: #718096;">We look forward to seeing ${studentData.name} in class!</p>
      <p style="margin-top: 20px; color: #2d3748;">Best regards,<br><strong style="color: #667eea;">Team Fluent Feathers Academy</strong></p>
    </div>
  </div>
</body>
</html>`;

      await sendEmail(studentData.parent_email, `🎉 Makeup Class Scheduled for ${studentData.name}`, emailHTML, studentData.parent_name, 'Makeup-Schedule');
    }

    res.json({
      success: true,
      message: 'Makeup class scheduled successfully!',
      session_id: newSessionId,
      session_number: finalSessionNumber
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/parent/check-email', async (req, res) => {
  try {
    const parentEmail = (req.body.email || '').toString().trim();
    const s = (await pool.query(`
      SELECT s.*, pc.timezone as credential_timezone
      FROM students s
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(s.parent_email)
      WHERE LOWER(s.parent_email) = LOWER($1) AND s.is_active = true
    `, [parentEmail])).rows;
    if(s.length===0) return res.status(404).json({ error: 'No student found.' });
    const students = s.map(st => ({
      ...st,
      parent_timezone: st.parent_timezone || st.credential_timezone || st.timezone || 'Asia/Kolkata'
    }));
    const c = (await pool.query('SELECT password FROM parent_credentials WHERE LOWER(parent_email) = LOWER($1)', [parentEmail])).rows[0];
    // Include students list for session restoration (persistent login)
    res.json({ hasPassword: c && c.password ? true : false, students });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/parent/setup-password', async (req, res) => {
  try {
    const parentEmail = (req.body.email || '').toString().trim();
    const s = (await pool.query(`
      SELECT s.*, pc.timezone as credential_timezone
      FROM students s
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(s.parent_email)
      WHERE LOWER(s.parent_email) = LOWER($1) AND s.is_active = true
    `, [parentEmail])).rows;
    const h = await bcrypt.hash(req.body.password, 10);
    await pool.query(`INSERT INTO parent_credentials (parent_email, password) VALUES ($1, $2) ON CONFLICT(parent_email) DO UPDATE SET password = $2`, [parentEmail, h]);
    const students = s.map(st => ({
      ...st,
      parent_timezone: st.parent_timezone || st.credential_timezone || st.timezone || 'Asia/Kolkata'
    }));
    res.json({ students });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post('/api/parent/login-password', async (req, res) => {
  try {
    const parentEmail = (req.body.email || '').toString().trim();
    const c = (await pool.query('SELECT password FROM parent_credentials WHERE LOWER(parent_email) = LOWER($1)', [parentEmail])).rows[0];
    if(!c || !(await bcrypt.compare(req.body.password, c.password))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    const s = (await pool.query(`
      SELECT s.*,
        pc.timezone as credential_timezone,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(s.parent_email)
      WHERE LOWER(s.parent_email) = LOWER($1) AND s.is_active = true
    `, [parentEmail])).rows;
    const students = s.map(st => ({
      ...st,
      parent_timezone: st.parent_timezone || st.credential_timezone || st.timezone || 'Asia/Kolkata'
    }));
    res.json({ students });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// OTP rate limiter using database (persists across restarts)
app.post('/api/parent/send-otp', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    // Rate limit: max 3 OTP requests per 10 minutes per email (checked via email_log)
    const recentOtps = await pool.query(
      `SELECT COUNT(*) as count FROM email_log WHERE recipient_email = $1 AND email_type = 'OTP' AND sent_at > NOW() - INTERVAL '10 minutes'`,
      [email]
    );
    if (parseInt(recentOtps.rows[0].count) >= 3) {
      return res.status(429).json({ error: 'Too many OTP requests. Please wait 10 minutes and try again.' });
    }

    const students = (await pool.query('SELECT * FROM students WHERE LOWER(parent_email) = LOWER($1) AND is_active = true', [req.body.email])).rows;
    if (students.length === 0) return res.status(404).json({ error: 'No student found' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(`INSERT INTO parent_credentials (parent_email, otp, otp_expiry, otp_attempts) VALUES ($1, $2, $3, 0) ON CONFLICT(parent_email) DO UPDATE SET otp = $2, otp_expiry = $3, otp_attempts = 0`, [req.body.email, otp, exp]);

    // Send OTP via email
    const parentName = students[0].parent_name || 'Parent';
    const otpEmailHTML = getOTPEmail({ parentName, otp });
    const emailSent = await sendEmail(
      req.body.email,
      `🔐 Your OTP for Fluent Feathers Academy Login`,
      otpEmailHTML,
      parentName,
      'OTP'
    );

    if (emailSent) {
      res.json({ success: true, message: 'OTP sent to your email!' });
    } else {
      res.json({ success: true, message: 'OTP generated. Check your email.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/parent/verify-otp', async (req, res) => {
  try {
    const parentEmail = (req.body.email || '').toString().trim();
    const c = (await pool.query('SELECT otp, otp_expiry, otp_attempts FROM parent_credentials WHERE LOWER(parent_email) = LOWER($1)', [parentEmail])).rows[0];
    if (!c) return res.status(401).json({ error: 'Invalid or Expired OTP' });

    // Block after 5 failed attempts
    if ((c.otp_attempts || 0) >= 5) {
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    }

    if (c.otp !== req.body.otp || new Date() > new Date(c.otp_expiry)) {
      // Increment failed attempts
      await pool.query('UPDATE parent_credentials SET otp_attempts = COALESCE(otp_attempts, 0) + 1 WHERE parent_email = $1', [parentEmail]);
      return res.status(401).json({ error: 'Invalid or Expired OTP' });
    }
    const s = (await pool.query(`
      SELECT s.*,
        pc.timezone as credential_timezone,
        GREATEST(COALESCE(s.missed_sessions, 0), COALESCE((SELECT COUNT(*) FROM sessions WHERE student_id = s.id AND status IN ('Missed', 'Excused', 'Unexcused')), 0)) as missed_sessions
      FROM students s
      LEFT JOIN parent_credentials pc ON LOWER(pc.parent_email) = LOWER(s.parent_email)
      WHERE LOWER(s.parent_email) = LOWER($1) AND s.is_active = true
    `, [parentEmail])).rows;
    await pool.query('UPDATE parent_credentials SET otp = NULL, otp_expiry = NULL, otp_attempts = 0 WHERE LOWER(parent_email) = LOWER($1)', [parentEmail]);
    const students = s.map(st => ({
      ...st,
      parent_timezone: st.parent_timezone || st.credential_timezone || st.timezone || 'Asia/Kolkata'
    }));
    res.json({ students });
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

// Verify OTP for password reset (doesn't log in, just verifies)
app.post('/api/parent/verify-reset-otp', async (req, res) => {
  try {
    const c = (await pool.query('SELECT otp, otp_expiry, otp_attempts FROM parent_credentials WHERE parent_email = $1', [req.body.email])).rows[0];
    if (!c) return res.status(404).json({ error: 'Email not found' });
    if ((c.otp_attempts || 0) >= 5) return res.status(429).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    if (c.otp !== req.body.otp || new Date() > new Date(c.otp_expiry)) {
      await pool.query('UPDATE parent_credentials SET otp_attempts = COALESCE(otp_attempts, 0) + 1 WHERE parent_email = $1', [req.body.email]);
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
    res.json({ success: true, message: 'OTP verified. You can now set a new password.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password after OTP verification
app.post('/api/parent/reset-password', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(`
      UPDATE parent_credentials SET password = $1, otp = NULL, otp_expiry = NULL
      WHERE parent_email = $2
    `, [hashedPassword, email]);
    res.json({ success: true, message: 'Password reset successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PAYMENT RENEWALS ====================
app.post('/api/students/:id/renewal', async (req, res) => {
  const { amount, currency, sessions_added, payment_method, notes, send_email } = req.body;

  // Validate sessions_added bounds
  const sessionsNum = parseInt(sessions_added);
  if (isNaN(sessionsNum) || sessionsNum < 1 || sessionsNum > 200) {
    return res.status(400).json({ error: 'Sessions added must be between 1 and 200.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO payment_renewals (student_id, renewal_date, amount, currency, sessions_added, payment_method, notes)
      VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
    `, [req.params.id, amount, currency, sessionsNum, payment_method, notes]);

    await client.query(`
      UPDATE students SET
        total_sessions = total_sessions + $1,
        remaining_sessions = remaining_sessions + $1,
        fees_paid = fees_paid + $2,
        renewal_reminder_sent = false,
        last_reminder_remaining = NULL
      WHERE id = $3
    `, [sessionsNum, amount, req.params.id]);
    await renumberPrivateSessionsForStudent(req.params.id, client);

    await client.query('COMMIT');

    // Send renewal confirmation email if requested (outside transaction)
    let emailSent = null;
    if (send_email) {
      const student = await pool.query('SELECT name, parent_name, parent_email FROM students WHERE id = $1', [req.params.id]);
      if (student.rows[0]) {
        const emailHTML = getPaymentConfirmationEmail({
          parentName: student.rows[0].parent_name,
          studentName: student.rows[0].name,
          amount: amount,
          currency: currency,
          paymentType: 'Renewal',
          sessionsAdded: sessionsNum,
          paymentMethod: payment_method,
          receiptNumber: null
        });
        emailSent = await sendEmail(
          student.rows[0].parent_email,
          `✅ Renewal Confirmation - Fluent Feathers Academy`,
          emailHTML,
          student.rows[0].parent_name,
          'Renewal Confirmation'
        );
      }
    }

    res.json({ success: true, message: 'Renewal added successfully!', emailSent });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/students/:id/renewals', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payment_renewals WHERE student_id = $1 ORDER BY renewal_date DESC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/payments', async (req, res) => {
  try {
    const payments = await pool.query('SELECT * FROM payment_history WHERE student_id = $1 ORDER BY payment_date DESC', [req.params.id]);
    const renewals = await pool.query('SELECT * FROM payment_renewals WHERE student_id = $1 ORDER BY renewal_date DESC', [req.params.id]);
    res.json({ payments: payments.rows, renewals: renewals.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update payment details (for corrections)
app.post('/api/students/:id/update-payment', async (req, res) => {
  const { fees_paid, currency, total_sessions, reason } = req.body;
  const studentId = req.params.id;

  try {
    // Get current student data
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentResult.rows[0];

    // Calculate remaining sessions
    const completedSessions = student.completed_sessions || 0;
    const newRemaining = Math.max(0, total_sessions - completedSessions);

    // Update student payment info
    await pool.query(`
      UPDATE students SET
        fees_paid = $1,
        currency = $2,
        total_sessions = $3,
        remaining_sessions = $4
      WHERE id = $5
    `, [fees_paid, currency, total_sessions, newRemaining, studentId]);

    // Add entry to payment_history
    await pool.query(`
      INSERT INTO payment_history (student_id, payment_date, amount, currency, payment_method, sessions_covered, notes, payment_status)
      VALUES ($1, CURRENT_TIMESTAMP, $2, $3, 'Bank Transfer', $4, $5, 'completed')
    `, [studentId, fees_paid, currency, total_sessions, reason || '']);

    console.log(`Payment updated for student ${studentId}: ${currency} ${fees_paid}, Sessions: ${total_sessions}, Reason: ${reason || 'No reason provided'}`);

    res.json({ success: true, message: 'Payment updated successfully!' });
  } catch (err) {
    console.error('Error updating payment:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fix session counts (for attendance correction)
app.post('/api/students/:id/fix-sessions', async (req, res) => {
  const { total_sessions, completed_sessions, missed_sessions, remaining_sessions, reason } = req.body;
  const studentId = req.params.id;

  try {
    // Get current student data for logging
    const studentResult = await pool.query('SELECT name, total_sessions, completed_sessions, missed_sessions, remaining_sessions FROM students WHERE id = $1', [studentId]);
    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const oldData = studentResult.rows[0];

    // Update session counts including missed_sessions
    await pool.query(`
      UPDATE students SET
        total_sessions = $1,
        completed_sessions = $2,
        missed_sessions = $3,
        remaining_sessions = $4
      WHERE id = $5
    `, [total_sessions, completed_sessions, missed_sessions || 0, remaining_sessions, studentId]);

    console.log(`⚠️ SESSION FIX for ${oldData.name} (ID: ${studentId})`);
    console.log(`   Old: Total=${oldData.total_sessions}, Completed=${oldData.completed_sessions}, Missed=${oldData.missed_sessions || 0}, Remaining=${oldData.remaining_sessions}`);
    console.log(`   New: Total=${total_sessions}, Completed=${completed_sessions}, Missed=${missed_sessions || 0}, Remaining=${remaining_sessions}`);
    console.log(`   Reason: ${reason || 'No reason provided'}`);

    res.json({ success: true, message: 'Session counts updated successfully!' });
  } catch (err) {
    console.error('Error fixing sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADD EXTRA SESSIONS ====================
// Add extra sessions for an existing student without affecting current schedule
app.post('/api/students/:id/add-extra-sessions', async (req, res) => {
  const client = await pool.connect();
  try {
    const studentId = req.params.id;
    const { classes, deduct_from, send_email } = req.body;
    // deduct_from: 'remaining' | 'makeup' | 'none' (extra paid separately)

    const student = (await client.query('SELECT * FROM students WHERE id = $1', [studentId])).rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });

    if (!classes || classes.length === 0) return res.status(400).json({ error: 'No sessions provided' });

    // Validate based on deduction type
    if (deduct_from === 'remaining') {
      if (student.remaining_sessions < classes.length) {
        return res.status(400).json({ error: `Not enough remaining sessions. Need ${classes.length} but only ${student.remaining_sessions} available.` });
      }
    } else if (deduct_from === 'makeup') {
      const available = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC',
        [studentId, 'Available']
      );
      if (available.rows.length < classes.length) {
        return res.status(400).json({ error: `Not enough makeup credits. Need ${classes.length} but only ${available.rows.length} available.` });
      }
    }

    // Get current session count for numbering
    const count = (await client.query('SELECT COUNT(*) as count FROM sessions WHERE student_id = $1', [studentId])).rows[0].count;
    let sessionNumber = parseInt(count) + 1;

    await client.query('BEGIN');

    // If using makeup credits, fetch IDs
    let makeupCreditIds = [];
    let makeupIdx = 0;
    if (deduct_from === 'makeup') {
      const credits = await client.query(
        'SELECT id FROM makeup_classes WHERE student_id = $1 AND status = $2 ORDER BY credit_date ASC LIMIT $3',
        [studentId, 'Available', classes.length]
      );
      makeupCreditIds = credits.rows.map(r => r.id);
    }

    const scheduledSessions = [];
    let emailSerial = 1;

    for (const cls of classes) {
      if (!cls.date || !cls.time) continue;
      const utc = istToUTC(cls.date, cls.time);
      const isMakeup = deduct_from === 'makeup';
      const notes = deduct_from === 'none' ? 'Extra session (paid separately)' : isMakeup ? 'Makeup Class' : null;

      const result = await client.query(`
        INSERT INTO sessions (student_id, session_type, session_number, session_date, session_time, class_link, status, notes)
        VALUES ($1, 'Private', $2, $3::date, $4::time, $5, $6, $7)
        RETURNING id
      `, [studentId, sessionNumber, utc.date, utc.time, student.class_link || DEFAULT_CLASS, isMakeup ? 'Scheduled' : 'Pending', notes]);

      // Consume makeup credit if applicable
      if (isMakeup && makeupIdx < makeupCreditIds.length) {
        await client.query(`
          UPDATE makeup_classes SET status = 'Scheduled', used_date = CURRENT_DATE, scheduled_session_id = $1, scheduled_date = $2, scheduled_time = $3
          WHERE id = $4
        `, [result.rows[0].id, cls.date, cls.time, makeupCreditIds[makeupIdx]]);
        makeupIdx++;
      }

      const display = formatUTCToLocal(utc.date, utc.time, student.parent_timezone || student.timezone || 'Asia/Kolkata');
      const label = isMakeup ? ' (Makeup)' : deduct_from === 'none' ? ' (Extra)' : '';
      scheduledSessions.push(`<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:15px; color: #4a5568;">Class ${emailSerial}${label}</td><td style="padding:15px; color: #4a5568;">${display.date}</td><td style="padding:15px;"><strong style="color:#667eea;">${display.time}</strong></td></tr>`);

      sessionNumber++;
      emailSerial++;
    }

    // Deduct from remaining sessions if applicable
    if (deduct_from === 'remaining') {
      await client.query(
        'UPDATE students SET remaining_sessions = remaining_sessions - $1 WHERE id = $2',
        [classes.length, studentId]
      );
    } else if (deduct_from === 'makeup') {
      // Increment remaining so scheduled makeup classes appear in the count
      await client.query(
        'UPDATE students SET remaining_sessions = remaining_sessions + $1 WHERE id = $2',
        [classes.length, studentId]
      );
    }

    await client.query('COMMIT');

    // Send schedule email
    let emailSent = null;
    if (send_email !== false && student.parent_email) {
      const scheduleHTML = getScheduleEmail({
        parent_name: student.parent_name,
        student_name: student.name,
        schedule_rows: scheduledSessions.join(''),
        timezone_label: getTimezoneLabel(student.parent_timezone || student.timezone || 'Asia/Kolkata')
      });
      emailSent = await sendEmail(
        student.parent_email,
        `📅 Additional Classes Scheduled for ${student.name}`,
        scheduleHTML,
        student.parent_name,
        'Schedule'
      );
    }

    const deductMsg = deduct_from === 'remaining' ? ` (deducted from remaining)` : deduct_from === 'makeup' ? ` (using makeup credits)` : ` (extra - paid separately)`;
    const emailMsg = emailSent === true ? ' Email sent!' : emailSent === false ? ' (email failed)' : '';
    res.json({ success: true, message: `${classes.length} extra sessions added${deductMsg}.${emailMsg}` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding extra sessions:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== FINANCIAL REPORTS & EXPENSE TRACKER ====================

// Get financial summary (income from payments)
app.get('/api/financial-reports', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let dateFilter = '';
    let params = [];

    if (startDate && endDate) {
  dateFilter = 'WHERE payment_date >= $1::date AND payment_date < ($2::date + INTERVAL \'1 day\')';
  params = [startDate, endDate];
}  else if (year) {
  const fyStart = `${year}-04-01`;
  const fyEnd = `${parseInt(year) + 1}-03-31`;
  dateFilter = 'WHERE payment_date >= $1::date AND payment_date < ($2::date + INTERVAL \'1 day\')';
  params = [fyStart, fyEnd];
}

    // Get all payments from payment_history
    const paymentsQuery = `
      SELECT ph.*, s.name as student_name, s.parent_name
      FROM payment_history ph
      LEFT JOIN students s ON ph.student_id = s.id
      ${dateFilter}
      ORDER BY ph.payment_date DESC
    `;
    const payments = await pool.query(paymentsQuery, params);

    // Get renewal payments not already in payment_history (old renewals before fix)
    let renewalDateFilter = dateFilter.replace(/payment_date/g, 'renewal_date');
    let renewalRows = [];
    try {
      const renewalWhere = renewalDateFilter
        ? renewalDateFilter + ' AND '
        : 'WHERE ';
      const renewalQuery = `
        SELECT pr.id, pr.student_id, pr.renewal_date as payment_date, pr.amount, pr.currency,
               pr.payment_method, CAST(pr.sessions_added AS TEXT) as sessions_covered,
               COALESCE('Renewal - ' || pr.notes, 'Renewal') as notes,
               'Completed' as payment_status, s.name as student_name, s.parent_name
        FROM payment_renewals pr
        LEFT JOIN students s ON pr.student_id = s.id
        ${renewalWhere} NOT EXISTS (
          SELECT 1 FROM payment_history ph2
          WHERE ph2.student_id = pr.student_id
          AND ph2.payment_date = pr.renewal_date
          AND ph2.amount = pr.amount
          AND ph2.notes LIKE '%Renewal%'
        )
        ORDER BY pr.renewal_date DESC
      `;
      const renewalResult = await pool.query(renewalQuery, params);
      renewalRows = renewalResult.rows;
    } catch (e) {
      console.error('Error fetching renewal payments for financial:', e);
    }

    // Merge payments and renewals
    const allPayments = [...payments.rows, ...renewalRows].sort((a, b) =>
      new Date(b.payment_date) - new Date(a.payment_date)
    );

    // Get monthly summary
    const monthlyQuery = `
      SELECT
        EXTRACT(YEAR FROM payment_date) as year,
        EXTRACT(MONTH FROM payment_date) as month,
        currency,
        SUM(amount) as total_amount,
        COUNT(*) as payment_count
      FROM payment_history
      ${dateFilter}
      GROUP BY EXTRACT(YEAR FROM payment_date), EXTRACT(MONTH FROM payment_date), currency
      ORDER BY year DESC, month DESC
    `;
    const monthlySummary = await pool.query(monthlyQuery, params);

    // Add renewal amounts to monthly summary
    for (const r of renewalRows) {
      const d = new Date(r.payment_date);
      const yr = d.getFullYear(), mo = d.getMonth() + 1;
      const existing = monthlySummary.rows.find(m => parseInt(m.year) === yr && parseInt(m.month) === mo && m.currency === r.currency);
      if (existing) {
        existing.total_amount = parseFloat(existing.total_amount) + parseFloat(r.amount);
        existing.payment_count = parseInt(existing.payment_count) + 1;
      } else {
        monthlySummary.rows.push({ year: yr, month: mo, currency: r.currency, total_amount: parseFloat(r.amount), payment_count: 1 });
      }
    }

    // Get total by currency
    const totalQuery = `
      SELECT currency, SUM(amount) as total_amount, COUNT(*) as payment_count
      FROM payment_history
      ${dateFilter}
      GROUP BY currency
    `;
    const totals = await pool.query(totalQuery, params);

    // Add renewal amounts to totals
    for (const r of renewalRows) {
      const existing = totals.rows.find(t => t.currency === r.currency);
      if (existing) {
        existing.total_amount = parseFloat(existing.total_amount) + parseFloat(r.amount);
        existing.payment_count = parseInt(existing.payment_count) + 1;
      } else {
        totals.rows.push({ currency: r.currency, total_amount: parseFloat(r.amount), payment_count: 1 });
      }
    }

    // Get session stats
    const sessionStats = await pool.query(`
      SELECT COUNT(*) as total_sessions,
             COUNT(CASE WHEN status = 'Completed' THEN 1 END) as completed_sessions
      FROM sessions
    `);

    // Get active students count
    const studentCount = await pool.query(`SELECT COUNT(*) as count FROM students WHERE is_active = true`);

    res.json({
      payments: allPayments,
      monthlySummary: monthlySummary.rows,
      totals: totals.rows,
      sessionStats: sessionStats.rows[0],
      activeStudents: parseInt(studentCount.rows[0].count)
    });
  } catch (err) {
    console.error('Error fetching financial reports:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export financial report as CSV
app.get('/api/financial-reports/export', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let dateFilter = '';
    let params = [];

    if (startDate && endDate) {
      dateFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      params = [startDate, endDate];
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      dateFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      params = [fyStart, fyEnd];
    }

    const query = `
      SELECT
        ph.payment_date,
        s.name as student_name,
        s.parent_name,
        ph.amount,
        ph.currency,
        ph.payment_method,
        ph.sessions_covered,
        ph.notes
      FROM payment_history ph
      LEFT JOIN students s ON ph.student_id = s.id
      ${dateFilter}
      ORDER BY ph.payment_date DESC
    `;
    const result = await pool.query(query, params);

    // Also get renewal payments not in payment_history
    let csvRenewalDateFilter = dateFilter.replace(/ph\.payment_date/g, 'pr.renewal_date');
    try {
      const csvRenewalWhere = csvRenewalDateFilter
        ? csvRenewalDateFilter + ' AND '
        : 'WHERE ';
      const renewalCsvQuery = `
        SELECT pr.renewal_date as payment_date, s.name as student_name, s.parent_name,
               pr.amount, pr.currency, pr.payment_method, CAST(pr.sessions_added AS TEXT) as sessions_covered,
               COALESCE('Renewal - ' || pr.notes, 'Renewal') as notes
        FROM payment_renewals pr
        LEFT JOIN students s ON pr.student_id = s.id
        ${csvRenewalWhere} NOT EXISTS (
          SELECT 1 FROM payment_history ph2
          WHERE ph2.student_id = pr.student_id AND ph2.payment_date = pr.renewal_date
          AND ph2.amount = pr.amount AND ph2.notes LIKE '%Renewal%'
        )
        ORDER BY pr.renewal_date DESC
      `;
      const renewalCsvResult = await pool.query(renewalCsvQuery, params);
      result.rows.push(...renewalCsvResult.rows);
      result.rows.sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date));
    } catch (e) {
      console.error('Error fetching renewals for CSV:', e);
    }

    // Create CSV content
    let csv = 'Date,Student Name,Parent Name,Amount,Currency,Payment Method,Sessions,Notes\n';
    result.rows.forEach(row => {
      const date = new Date(row.payment_date).toLocaleDateString('en-IN');
      csv += `"${date}","${row.student_name || ''}","${row.parent_name || ''}","${row.amount}","${row.currency}","${row.payment_method || ''}","${row.sessions_covered || ''}","${(row.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=income_report_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting financial report:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all expenses
app.get('/api/expenses', async (req, res) => {
  try {
    const { startDate, endDate, year, category } = req.query;

    let whereClause = [];
    let params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      whereClause.push(`expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`);
      params.push(startDate, endDate);
      paramIndex += 2;
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      whereClause.push(`expense_date >= $${paramIndex} AND expense_date <= $${paramIndex + 1}`);
      params.push(fyStart, fyEnd);
      paramIndex += 2;
    }

    if (category) {
      whereClause.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    const whereSQL = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

    const expenses = await pool.query(`
      SELECT * FROM expenses ${whereSQL} ORDER BY expense_date DESC
    `, params);

    // Get totals by category
    const categoryTotals = await pool.query(`
      SELECT category, currency, SUM(amount) as total_amount, COUNT(*) as count
      FROM expenses ${whereSQL}
      GROUP BY category, currency
      ORDER BY category
    `, params);

    // Get grand total
    const grandTotal = await pool.query(`
      SELECT currency, SUM(amount) as total_amount
      FROM expenses ${whereSQL}
      GROUP BY currency
    `, params);

    res.json({
      expenses: expenses.rows,
      categoryTotals: categoryTotals.rows,
      grandTotal: grandTotal.rows
    });
  } catch (err) {
    console.error('Error fetching expenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add new expense
app.post('/api/expenses', async (req, res) => {
  try {
    const { expense_date, category, description, amount, currency, payment_method, receipt_url, notes } = req.body;

    const result = await pool.query(`
      INSERT INTO expenses (expense_date, category, description, amount, currency, payment_method, receipt_url, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [expense_date, category, description, amount, currency || 'INR', payment_method, receipt_url, notes]);

    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    console.error('Error adding expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update expense
app.put('/api/expenses/:id', async (req, res) => {
  try {
    const { expense_date, category, description, amount, currency, payment_method, receipt_url, notes } = req.body;

    await pool.query(`
      UPDATE expenses SET
        expense_date = $1, category = $2, description = $3, amount = $4,
        currency = $5, payment_method = $6, receipt_url = $7, notes = $8
      WHERE id = $9
    `, [expense_date, category, description, amount, currency, payment_method, receipt_url, notes, req.params.id]);

    res.json({ success: true, message: 'Expense updated' });
  } catch (err) {
    console.error('Error updating expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete expense
app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Expense deleted' });
  } catch (err) {
    console.error('Error deleting expense:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete payment from history (reverses fees_paid on student)
app.delete('/api/payment-history/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const record = await client.query('SELECT * FROM payment_history WHERE id = $1', [req.params.id]);
    if (record.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Payment record not found' }); }
    const payment = record.rows[0];
    await client.query('DELETE FROM payment_history WHERE id = $1', [req.params.id]);
    await client.query('UPDATE students SET fees_paid = GREATEST(fees_paid - $1, 0) WHERE id = $2', [payment.amount, payment.student_id]);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Payment deleted and fees adjusted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting payment:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete renewal record (reverses fees_paid, total_sessions, remaining_sessions)
app.delete('/api/payment-renewals/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const record = await client.query('SELECT * FROM payment_renewals WHERE id = $1', [req.params.id]);
    if (record.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Renewal record not found' }); }
    const renewal = record.rows[0];
    await client.query('DELETE FROM payment_renewals WHERE id = $1', [req.params.id]);
    // Clean up any legacy payment_history entries that were auto-created by old renewal code
    await client.query(`DELETE FROM payment_history WHERE id = (SELECT id FROM payment_history WHERE student_id = $1 AND amount = $2 AND payment_date = $3 AND notes LIKE 'Renewal%' LIMIT 1)`, [renewal.student_id, renewal.amount, renewal.renewal_date]);
    await client.query(`UPDATE students SET
      fees_paid = GREATEST(fees_paid - $1, 0),
      total_sessions = GREATEST(total_sessions - $2, 0),
      remaining_sessions = GREATEST(remaining_sessions - $2, 0)
      WHERE id = $3`, [renewal.amount, renewal.sessions_added, renewal.student_id]);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Renewal deleted and sessions/fees adjusted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting renewal:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Edit a payment record
app.put('/api/payment-history/:id', async (req, res) => {
  try {
    const { payment_date, amount, currency, payment_method, sessions_covered, notes } = req.body;
    await pool.query(`
      UPDATE payment_history
      SET payment_date = $1, amount = $2, currency = $3, payment_method = $4, sessions_covered = $5, notes = $6
      WHERE id = $7
    `, [payment_date, amount, currency, payment_method, sessions_covered, notes, req.params.id]);
    res.json({ success: true, message: 'Payment updated successfully' });
  } catch (err) {
    console.error('Error updating payment:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export expenses as CSV
app.get('/api/expenses/export', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let whereClause = [];
    let params = [];

    if (startDate && endDate) {
      whereClause.push(`expense_date >= $1 AND expense_date <= $2`);
      params = [startDate, endDate];
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      whereClause.push(`expense_date >= $1 AND expense_date <= $2`);
      params = [fyStart, fyEnd];
    }

    const whereSQL = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

    const result = await pool.query(`SELECT * FROM expenses ${whereSQL} ORDER BY expense_date DESC`, params);

    let csv = 'Date,Category,Description,Amount,Currency,Payment Method,Notes\n';
    result.rows.forEach(row => {
      const date = new Date(row.expense_date).toLocaleDateString('en-IN');
      csv += `"${date}","${row.category}","${(row.description || '').replace(/"/g, '""')}","${row.amount}","${row.currency}","${row.payment_method || ''}","${(row.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=expenses_report_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting expenses:', err);
    res.status(500).json({ error: err.message });
  }
});

// Export merged income + expenses as CSV
app.get('/api/financial-reports/export-merged', async (req, res) => {
  try {
    const { startDate, endDate, year } = req.query;

    let incomeFilter = '';
    let expenseFilter = '';
    let incomeParams = [];
    let expenseParams = [];

    if (startDate && endDate) {
      incomeFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      incomeParams = [startDate, endDate];
      expenseFilter = 'WHERE expense_date >= $1 AND expense_date <= $2';
      expenseParams = [startDate, endDate];
    } else if (year) {
      const fyStart = `${year}-04-01`;
      const fyEnd = `${parseInt(year) + 1}-03-31`;
      incomeFilter = 'WHERE ph.payment_date >= $1 AND ph.payment_date <= $2';
      incomeParams = [fyStart, fyEnd];
      expenseFilter = 'WHERE expense_date >= $1 AND expense_date <= $2';
      expenseParams = [fyStart, fyEnd];
    }

    // Fetch income
    const incomeResult = await pool.query(`
      SELECT ph.payment_date as date, s.name as description, ph.amount, ph.currency, ph.payment_method, ph.notes, 'Income' as type, '' as category
      FROM payment_history ph
      LEFT JOIN students s ON ph.student_id = s.id
      ${incomeFilter}
    `, incomeParams);

    // Fetch expenses
    const expenseResult = await pool.query(`
      SELECT expense_date as date, description, amount, currency, payment_method, notes, 'Expense' as type, category
      FROM expenses
      ${expenseFilter}
    `, expenseParams);

    // Merge and sort by date
    const all = [...incomeResult.rows, ...expenseResult.rows].sort((a, b) => new Date(a.date) - new Date(b.date));

    let csv = 'Type,Date,Description,Category,Amount,Currency,Payment Method,Notes\n';
    all.forEach(row => {
      const date = new Date(row.date).toLocaleDateString('en-IN');
      csv += `"${row.type}","${date}","${(row.description || '').replace(/"/g, '""')}","${row.category || ''}","${row.amount}","${row.currency}","${row.payment_method || ''}","${(row.notes || '').replace(/"/g, '""')}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=financial_report_merged_${new Date().toISOString().split('T')[0]}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting merged report:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get profit/loss summary
app.get('/api/financial-reports/summary', async (req, res) => {
  try {
    const { year } = req.query;
    const currentYear = year || new Date().getFullYear();

    const fyStart = `${currentYear}-04-01`;
    const fyEnd = `${parseInt(currentYear) + 1}-03-31`;

    // Get total income
    const incomeResult = await pool.query(`
      SELECT currency, SUM(amount) as total
      FROM payment_history
      WHERE payment_date >= $1 AND payment_date <= $2
      GROUP BY currency
    `, [fyStart, fyEnd]);

    // Get total expenses
    const expenseResult = await pool.query(`
      SELECT currency, SUM(amount) as total
      FROM expenses
      WHERE expense_date >= $1 AND expense_date <= $2
      GROUP BY currency
    `, [fyStart, fyEnd]);

    res.json({
      financialYear: `${currentYear}-${parseInt(currentYear) + 1}`,
      income: incomeResult.rows,
      expenses: expenseResult.rows
    });
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLEANUP ORPHANED DATA ====================

// Clean up orphaned sessions (sessions where student no longer exists)
app.delete('/api/cleanup/orphaned-sessions', async (req, res) => {
  try {
    // Find ALL sessions where student_id doesn't exist in students table
    const orphanedSessions = await pool.query(`
      SELECT s.id FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL AND st.id IS NULL
    `);

    // Delete session_materials for orphaned sessions
    for (const session of orphanedSessions.rows) {
      await pool.query('DELETE FROM session_materials WHERE session_id = $1', [session.id]);
    }

    // Delete orphaned sessions (any session where student doesn't exist)
    const result = await pool.query(`
      DELETE FROM sessions s
      WHERE s.student_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM students st WHERE st.id = s.student_id)
      RETURNING id
    `);

    console.log(`🧹 Cleaned up ${result.rowCount} orphaned sessions`);
    res.json({
      success: true,
      message: `Cleaned up ${result.rowCount} orphaned sessions`,
      deletedCount: result.rowCount
    });
  } catch (err) {
    console.error('Error cleaning orphaned sessions:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get count of orphaned data
app.get('/api/cleanup/orphaned-count', async (req, res) => {
  try {
    const orphanedSessions = await pool.query(`
      SELECT COUNT(*) as count FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.student_id IS NOT NULL AND st.id IS NULL
    `);

    res.json({
      orphanedSessions: parseInt(orphanedSessions.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDIT & DELETE STUDENT ====================
app.put('/api/students/:id', async (req, res) => {
  const { name, grade, parent_name, parent_email, primary_contact, timezone, parent_timezone, program_name, duration, per_session_fee, currency, date_of_birth, class_link } = req.body;
  try {
    const studentTimezone = timezone || parent_timezone || 'Asia/Kolkata';
    const parentTimezone = studentTimezone; // single timezone — admin sets one value for everything
    await pool.query(`
      UPDATE students SET
        name = $1, grade = $2, parent_name = $3, parent_email = $4,
        primary_contact = $5, timezone = $6, parent_timezone = $7, program_name = $8,
        duration = $9, per_session_fee = $10, currency = $11,
        date_of_birth = $12, class_link = $13
      WHERE id = $14
    `, [name, grade, parent_name, parent_email, primary_contact, studentTimezone, parentTimezone, program_name, duration, per_session_fee, currency, date_of_birth || null, class_link || null, req.params.id]);
    // Sync parent_credentials so the stored value is authoritative
    if (parent_email) {
      await pool.query(
        `UPDATE parent_credentials SET timezone = $2 WHERE LOWER(parent_email) = LOWER($1)`,
        [parent_email.trim(), parentTimezone]
      );
    }
    res.json({ success: true, message: 'Student updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/full', async (req, res) => {
  try {
    const student = await pool.query('SELECT * FROM students WHERE id = $1', [req.params.id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    res.json(student.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/students/:id/status', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  try {
    await pool.query('UPDATE students SET is_active = $1 WHERE id = $2', [is_active, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parent profile update (limited fields for parent self-edit)
app.put('/api/students/:id/profile', async (req, res) => {
  const { parent_name, parent_email, primary_contact, alternate_contact, date_of_birth } = req.body;
  try {
    await pool.query(`
      UPDATE students SET
        parent_name = $1, parent_email = $2, primary_contact = $3,
        alternate_contact = $4, date_of_birth = $5
      WHERE id = $6
    `, [parent_name, parent_email, primary_contact, alternate_contact || null, date_of_birth || null, req.params.id]);
    res.json({ success: true, message: 'Profile updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== EDIT & DELETE GROUP ====================
app.put('/api/groups/:id', async (req, res) => {
  const { group_name, program_name, duration, timezone, max_students } = req.body;
  try {
    await pool.query(`
      UPDATE groups SET
        group_name = $1, program_name = $2, duration = $3, timezone = $4, max_students = $5
      WHERE id = $6
    `, [group_name, program_name, duration, timezone, max_students, req.params.id]);
    res.json({ success: true, message: 'Group updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id/full', async (req, res) => {
  try {
    const group = await pool.query('SELECT * FROM groups WHERE id = $1', [req.params.id]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    res.json(group.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASS FEEDBACK ====================
app.post('/api/sessions/:sessionId/feedback', async (req, res) => {
  const { student_id, rating, feedback_text } = req.body;
  try {
    // Check if feedback already exists
    const existing = await pool.query(
      'SELECT id FROM class_feedback WHERE session_id = $1 AND student_id = $2',
      [req.params.sessionId, student_id]
    );

    if (existing.rows.length > 0) {
      // Update existing feedback
      await pool.query(
        'UPDATE class_feedback SET rating = $1, feedback_text = $2 WHERE session_id = $3 AND student_id = $4',
        [rating, feedback_text, req.params.sessionId, student_id]
      );
    } else {
      // Insert new feedback
      await pool.query(
        'INSERT INTO class_feedback (session_id, student_id, rating, feedback_text) VALUES ($1, $2, $3, $4)',
        [req.params.sessionId, student_id, rating, feedback_text]
      );
    }

    await awardBadge(student_id, 'feedback', '⭐ Feedback Star', 'Shared valuable feedback');

    res.json({ success: true, message: 'Thank you for your feedback!' });
  } catch (err) {
    console.error('Feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/feedbacks', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT cf.*, s.name as student_name
      FROM class_feedback cf
      JOIN students s ON cf.student_id = s.id
      WHERE cf.session_id = $1
      ORDER BY cf.created_at DESC
    `, [req.params.sessionId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:sessionId/has-feedback/:studentId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id FROM class_feedback WHERE session_id = $1 AND student_id = $2',
      [req.params.sessionId, req.params.studentId]
    );
    res.json({ hasFeedback: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== BADGES SYSTEM ====================
async function awardBadge(studentId, badgeType, badgeName, badgeDescription) {
  try {
    const existing = await pool.query(
      'SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2',
      [studentId, badgeType]
    );

    if (existing.rows.length === 0) {
      await pool.query(`
        INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
        VALUES ($1, $2, $3, $4)
      `, [studentId, badgeType, badgeName, badgeDescription]);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Badge award error:', err);
    return false;
  }
}

const CLASS_POINT_BADGE_MILESTONES = {
  10: { name: '⭐ Class Star', desc: 'Earned 10 class points in live classes!' },
  20: { name: '🌟 Double Star', desc: 'Earned 20 class points in live classes!' },
  30: { name: '🔥 On Fire', desc: 'Earned 30 class points in live classes!' },
  50: { name: '🏆 Points Champion', desc: 'Earned 50 class points in live classes!' },
  100: { name: '💎 Points Legend', desc: 'Earned 100 class points in live classes!' }
};

async function backfillClassPointBadges(studentId, totalPoints) {
  const normalizedTotal = parseInt(totalPoints, 10) || 0;
  if (normalizedTotal < 10) return [];

  const awardedBadges = [];
  const endMilestone = Math.floor(normalizedTotal / 10) * 10;
  for (let threshold = 10; threshold <= endMilestone; threshold += 10) {
    const badgeMeta = CLASS_POINT_BADGE_MILESTONES[threshold] || {
      name: `🏅 ${threshold} Point Badge`,
      desc: `Earned ${threshold} class points in live classes!`
    };
    const awarded = await awardBadge(
      studentId,
      `class_points_${threshold}`,
      badgeMeta.name,
      badgeMeta.desc
    );
    if (awarded) awardedBadges.push(badgeMeta.name);
  }
  return awardedBadges;
}

app.get('/api/students/:id/badges', async (req, res) => {
  try {
    const totalResult = await pool.query(
      'SELECT COALESCE(SUM(points), 0) AS total_points FROM class_points WHERE student_id = $1',
      [req.params.id]
    );
    await backfillClassPointBadges(req.params.id, totalResult.rows[0].total_points);

    const result = await pool.query(
      'SELECT * FROM student_badges WHERE student_id = $1 ORDER BY earned_date DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/badges', async (req, res) => {
  const { badge_type, badge_name, badge_description } = req.body;
  try {
    await pool.query(`
      INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, badge_type, badge_name, badge_description]);
    res.json({ success: true, message: 'Badge awarded!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual badge assignment by admin (allows duplicates for class achievements)
app.post('/api/students/:id/badges/assign', async (req, res) => {
  const { badge_type, badge_name, badge_description } = req.body;
  try {
    await pool.query(`
      INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
      VALUES ($1, $2, $3, $4)
    `, [req.params.id, badge_type, badge_name, badge_description]);
    res.json({ success: true, message: 'Badge assigned successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STUDENT OF THE WEEK/MONTH/YEAR ====================

const HOMEWORK_POINT_VALUE = 10;
const CHALLENGE_POINT_VALUE = 10;
const BADGE_POINT_VALUE = 2;

function getAwardCertificateTitle(periodType) {
  if (periodType === 'week') return 'Student of the Week';
  if (periodType === 'month') return 'Student of the Month';
  return 'Student of the Year';
}

function getPodiumEmail(studentName, rank, periodLabel, totalScore, breakdown) {
  const rankLabel = rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd';
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:35px 28px;text-align:center;color:white;">
      <div style="font-size:46px;">${medal}</div>
      <h1 style="margin:8px 0 0;font-size:24px;">Podium Achievement</h1>
      <p style="margin:8px 0 0;opacity:0.95;">${periodLabel}</p>
    </div>
    <div style="padding:28px;">
      <p style="font-size:16px;color:#2d3748;line-height:1.6;">Congratulations! <strong>${studentName}</strong> secured <strong>${rankLabel} place</strong> on the Fluent Feathers podium.</p>
      <div style="background:#f8fafc;border-radius:10px;padding:16px;margin:18px 0;">
        <p style="margin:0 0 8px;color:#4a5568;">Homework: <strong>${breakdown.homework} pts</strong></p>
        <p style="margin:0 0 8px;color:#4a5568;">Challenges: <strong>${breakdown.challenges} pts</strong></p>
        <p style="margin:0;color:#4a5568;">Badges: <strong>${breakdown.badges} pts</strong></p>
        <p style="margin:10px 0 0;font-size:18px;color:#553c9a;font-weight:700;">Total: ${totalScore} points</p>
      </div>
      <p style="font-size:14px;color:#718096;line-height:1.6;">Thank you for supporting your child’s learning journey!</p>
    </div>
  </div>
</body>
</html>`;
}

async function calculateStudentScores(startDate, endDate) {
  const result = await pool.query(`
    WITH homework_pts AS (
      SELECT student_id, COUNT(DISTINCT session_id) * ${HOMEWORK_POINT_VALUE} as pts
      FROM materials
      WHERE file_type = 'Homework'
        AND uploaded_by IN ('Parent', 'Admin')
        AND student_id IS NOT NULL
        AND session_id IS NOT NULL
        AND uploaded_at >= $1::date AND uploaded_at < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    ),
    challenge_pts AS (
      SELECT student_id, COUNT(*) * ${CHALLENGE_POINT_VALUE} as pts
      FROM student_challenges
      WHERE status = 'Completed'
        AND completed_at >= $1::date AND completed_at < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    ),
    badge_pts AS (
      SELECT student_id, COUNT(*) * ${BADGE_POINT_VALUE} as pts
      FROM student_badges
      WHERE earned_date >= $1::date AND earned_date < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    )
    SELECT
      s.id as student_id,
      s.name,
      s.parent_email,
      s.parent_name,
      COALESCE(h.pts, 0) as homework_score,
      COALESCE(c.pts, 0) as challenge_score,
      COALESCE(b.pts, 0) as badge_score,
      COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0) as total_score
    FROM students s
    LEFT JOIN homework_pts h ON s.id = h.student_id
    LEFT JOIN challenge_pts c ON s.id = c.student_id
    LEFT JOIN badge_pts b ON s.id = b.student_id
    WHERE s.is_active = true
      AND (COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0)) > 0
    ORDER BY total_score DESC, homework_score DESC, challenge_score DESC, badge_score DESC, s.name ASC
  `, [startDate, endDate]);
  return result.rows;
}
function getStudentAwardEmail(studentName, awardTitle, periodLabel, totalScore, breakdown, certificateUrl = '') {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);padding:40px 30px;text-align:center;">
      <div style="font-size:60px;margin-bottom:10px;">${awardTitle.includes('Year') ? '🏆' : awardTitle.includes('Month') ? '🏅' : '🌟'}</div>
      <h1 style="margin:0;color:white;font-size:26px;font-weight:bold;">${awardTitle}</h1>
      <p style="margin:10px 0 0;color:rgba(255,255,255,0.95);font-size:16px;">${periodLabel}</p>
    </div>
    <div style="padding:30px;text-align:center;">
      <p style="font-size:16px;color:#2d3748;margin:0 0 10px;">Congratulations! 🎉</p>
      <div style="background:linear-gradient(135deg,#fef3c7,#fde68a);border:2px solid #f59e0b;border-radius:15px;padding:25px;margin:20px 0;">
        <h2 style="margin:0;color:#92400e;font-size:28px;">${studentName}</h2>
        <p style="margin:10px 0 0;color:#b45309;font-size:18px;">has been awarded <strong>${awardTitle}</strong>!</p>
      </div>
      <div style="background:#f7fafc;border-radius:10px;padding:20px;margin:20px 0;text-align:left;">
        <p style="margin:0 0 10px;font-weight:600;color:#2d3748;">Score Breakdown:</p>
        <p style="margin:4px 0;color:#4a5568;">📝 Homework Submitted: <strong>${breakdown.homework} pts</strong></p>
        <p style="margin:4px 0;color:#4a5568;">🎯 Challenges Completed: <strong>${breakdown.challenges} pts</strong></p>
        <p style="margin:4px 0;color:#4a5568;">🏅 Badges Earned: <strong>${breakdown.badges} pts</strong></p>
        <p style="margin:10px 0 0;font-size:18px;font-weight:700;color:#B05D9E;">Total: ${totalScore} points</p>
      </div>
      <p style="font-size:15px;color:#4a5568;line-height:1.6;">Keep up the amazing work! We're so proud of ${studentName}'s dedication and progress at Fluent Feathers Academy. 💜</p>
      ${certificateUrl ? `
      <div style="margin-top:22px;">
        <a href="${certificateUrl}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#38b2ac 0%,#319795 100%);color:white;text-decoration:none;padding:14px 28px;border-radius:30px;font-size:15px;font-weight:700;box-shadow:0 4px 14px rgba(56,178,172,0.4);">📥 Download Award Certificate</a>
      </div>` : ''}
    </div>
    <div style="background:#f7fafc;padding:15px;text-align:center;border-top:1px solid #e2e8f0;">
      <p style="margin:0;color:#a0aec0;font-size:12px;">Fluent Feathers Academy By Aaliya</p>
    </div>
  </div>
</body>
</html>`;
}

async function awardStudentOfPeriod(periodType) {
  try {
    const now = new Date();
    let startDate, endDate, dateKey, periodLabel, awardTitle;

    if (periodType === 'week') {
      const day = now.getUTCDay();
      const sunday = new Date(now);
      sunday.setUTCDate(now.getUTCDate() - day - 7);
      const saturday = new Date(sunday);
      saturday.setUTCDate(sunday.getUTCDate() + 6);
      startDate = sunday.toISOString().split('T')[0];
      endDate = saturday.toISOString().split('T')[0];
      const weekNum = Math.ceil(((sunday - new Date(sunday.getFullYear(), 0, 1)) / 86400000 + 1) / 7);
      dateKey = `${sunday.getFullYear()}_W${String(weekNum).padStart(2, '0')}`;
      periodLabel = `Week ${weekNum}, ${sunday.getFullYear()}`;
      awardTitle = '🌟 Student of the Week';
    } else if (periodType === 'month') {
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
      startDate = prevMonth.toISOString().split('T')[0];
      endDate = lastDay.toISOString().split('T')[0];
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      dateKey = `${prevMonth.getFullYear()}_${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
      periodLabel = `${monthNames[prevMonth.getMonth()]} ${prevMonth.getFullYear()}`;
      awardTitle = '🏅 Student of the Month';
    } else {
      const prevYear = now.getFullYear() - 1;
      startDate = `${prevYear}-01-01`;
      endDate = `${prevYear}-12-31`;
      dateKey = `${prevYear}`;
      periodLabel = `${prevYear}`;
      awardTitle = '🏆 Student of the Year';
    }

    const badgeType = `student_of_${periodType}_${dateKey}`;
    const existing = await pool.query('SELECT id FROM student_badges WHERE badge_type = $1', [badgeType]);
    if (existing.rows.length > 0) {
      console.log(`⏭️ ${awardTitle} for ${periodLabel} already awarded, skipping.`);
      return;
    }

    const scores = await calculateStudentScores(startDate, endDate);
    if (scores.length === 0) {
      console.log(`⏭️ No eligible students for ${awardTitle} (${periodLabel})`);
      return;
    }

    const winner = scores[0];
    const topThree = scores.slice(0, 3);
    const description = `Top scorer for ${periodLabel} with ${winner.total_score} points!`;

    await pool.query(
      'INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description) VALUES ($1, $2, $3, $4)',
      [winner.student_id, badgeType, awardTitle, description]
    );
    console.log(`🏆 ${awardTitle} awarded to ${winner.name} for ${periodLabel} (${winner.total_score} pts)`);

    let certificateUrl = '';
    try {
      const certificateTitle = getAwardCertificateTitle(periodType);
      const certificateSummary = `${awardTitle} (${periodLabel}) with ${winner.total_score} points.`;
      const certInsert = await pool.query(`
        INSERT INTO monthly_assessments
          (assessment_type, student_id, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES
          ('demo', $1, $2, $3, $4, $5, $6)
        RETURNING id
      `, [
        winner.student_id,
        JSON.stringify(['Homework Consistency', 'Challenge Participation', 'Badge Achievement']),
        certificateTitle,
        certificateSummary,
        'Keep up consistent participation and complete challenges regularly.',
        'Outstanding progress and dedication shown this period.'
      ]);

      if (certInsert.rows[0]?.id) {
        const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
        certificateUrl = `${appUrl}/demo-certificate.html?id=${certInsert.rows[0].id}`;
      }
    } catch (certErr) {
      console.error(`Award certificate generation error (${periodType}):`, certErr.message);
    }

    if (winner.parent_email) {
      const winnerEmailHTML = getStudentAwardEmail(winner.name, awardTitle, periodLabel, winner.total_score, {
        homework: winner.homework_score,
        challenges: winner.challenge_score,
        badges: winner.badge_score
      }, certificateUrl);
      await sendEmail(winner.parent_email, `${awardTitle} - ${winner.name} | Fluent Feathers Academy`, winnerEmailHTML, winner.parent_name, 'Student Award');
    }

    for (let index = 1; index < topThree.length; index++) {
      const podiumStudent = topThree[index];
      if (!podiumStudent?.parent_email) continue;
      const rank = index + 1;
      const podiumEmail = getPodiumEmail(
        podiumStudent.name,
        rank,
        periodLabel,
        podiumStudent.total_score,
        {
          homework: podiumStudent.homework_score,
          challenges: podiumStudent.challenge_score,
          badges: podiumStudent.badge_score
        }
      );
      await sendEmail(
        podiumStudent.parent_email,
        `🏆 Podium Achievement (${rank === 2 ? '2nd' : '3rd'} Place) - ${podiumStudent.name}`,
        podiumEmail,
        podiumStudent.parent_name,
        'Podium Achievement'
      );
    }
  } catch (err) {
    console.error(`Error awarding student of ${periodType}:`, err);
  }
}

// Leaderboard - Get all students ranked by same points logic used in awards
// Optional query params: ?start=YYYY-MM-DD&end=YYYY-MM-DD for period filtering
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { start, end } = req.query;
    const useDateFilter = !!(start && end);
    const params = useDateFilter ? [start, end] : [];
    const hwFilter    = useDateFilter ? `AND uploaded_at >= $1::date AND uploaded_at < ($2::date + INTERVAL '1 day')` : '';
    const chFilter    = useDateFilter ? `AND completed_at >= $1::date AND completed_at < ($2::date + INTERVAL '1 day')` : '';
    const bdgFilter   = useDateFilter ? `AND earned_date  >= $1::date AND earned_date  < ($2::date + INTERVAL '1 day')` : '';
    const bdgLatestFilter = useDateFilter ? `AND earned_date >= $1::date AND earned_date < ($2::date + INTERVAL '1 day')` : '';

    const result = await pool.query(`
      WITH homework_pts AS (
        SELECT student_id, COUNT(DISTINCT session_id) * ${HOMEWORK_POINT_VALUE} as pts
        FROM materials
        WHERE file_type = 'Homework'
          AND uploaded_by IN ('Parent', 'Admin')
          AND student_id IS NOT NULL
          AND session_id IS NOT NULL
          ${hwFilter}
        GROUP BY student_id
      ),
      challenge_pts AS (
        SELECT student_id, COUNT(*) * ${CHALLENGE_POINT_VALUE} as pts
        FROM student_challenges
        WHERE status = 'Completed'
          ${chFilter}
        GROUP BY student_id
      ),
      badge_pts AS (
        SELECT student_id, COUNT(*) * ${BADGE_POINT_VALUE} as pts
        FROM student_badges
        WHERE 1=1 ${bdgFilter}
        GROUP BY student_id
      ),
      badge_counts AS (
        SELECT student_id, COUNT(*) as badge_count
        FROM student_badges
        WHERE 1=1 ${bdgFilter}
        GROUP BY student_id
      )
      SELECT
        s.id,
        s.name,
        s.program_name,
        COALESCE(h.pts, 0) as homework_points,
        COALESCE(c.pts, 0) as challenge_points,
        COALESCE(b.pts, 0) as badge_points,
        COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0) as total_score,
        COALESCE(bc.badge_count, 0) as total_badges,
        (SELECT badge_name FROM student_badges WHERE student_id = s.id ${bdgLatestFilter} ORDER BY earned_date DESC LIMIT 1) as latest_badge
      FROM students s
      LEFT JOIN homework_pts h ON s.id = h.student_id
      LEFT JOIN challenge_pts c ON s.id = c.student_id
      LEFT JOIN badge_pts b ON s.id = b.student_id
      LEFT JOIN badge_counts bc ON s.id = bc.student_id
      WHERE s.is_active = true
        AND (COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0)) > 0
      ORDER BY total_score DESC, homework_points DESC, challenge_points DESC, badge_points DESC, s.name ASC
    `, params);
    res.json({ leaderboard: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get score history and score breakdown for a student (parent portal)
app.get('/api/students/:id/score-history', async (req, res) => {
  try {
    const studentId = req.params.id;

    const [totalsResult, historyResult] = await Promise.all([
      pool.query(`
        WITH homework_scores AS (
          SELECT COUNT(*) * ${HOMEWORK_POINT_VALUE} AS points
          FROM (
            SELECT DISTINCT ON (m.session_id) m.session_id
            FROM materials m
            WHERE m.student_id = $1
              AND m.file_type = 'Homework'
              AND m.uploaded_by IN ('Parent', 'Admin')
              AND m.session_id IS NOT NULL
            ORDER BY m.session_id, m.uploaded_at ASC, m.id ASC
          ) first_homework
        ),
        challenge_scores AS (
          SELECT COUNT(*) * ${CHALLENGE_POINT_VALUE} AS points
          FROM student_challenges sc
          WHERE sc.student_id = $1
            AND sc.status = 'Completed'
        ),
        badge_scores AS (
          SELECT COUNT(*) * ${BADGE_POINT_VALUE} AS points
          FROM student_badges sb
          WHERE sb.student_id = $1
        ),
        class_points_total AS (
          SELECT COALESCE(SUM(cp.points), 0) AS points
          FROM class_points cp
          WHERE cp.student_id = $1
        ),
        pending_challenges AS (
          SELECT COUNT(*) AS count
          FROM student_challenges sc
          WHERE sc.student_id = $1
            AND sc.status = 'Submitted'
        )
        SELECT
          COALESCE((SELECT points FROM homework_scores), 0) AS homework_points,
          COALESCE((SELECT points FROM challenge_scores), 0) AS challenge_points,
          COALESCE((SELECT points FROM badge_scores), 0) AS badge_points,
          COALESCE((SELECT points FROM class_points_total), 0) AS class_points,
          COALESCE((SELECT count FROM pending_challenges), 0) AS pending_challenges
      `, [studentId]),
      pool.query(`
        WITH homework_history AS (
          SELECT DISTINCT ON (m.session_id)
            'leaderboard'::text AS score_group,
            'homework'::text AS score_type,
            ${HOMEWORK_POINT_VALUE}::int AS points,
            m.uploaded_at AS occurred_at,
            'Homework submitted'::text AS title,
            COALESCE(
              'Session #' || s.session_number || CASE WHEN s.session_topic IS NOT NULL AND s.session_topic <> '' THEN ' • ' || s.session_topic ELSE '' END,
              m.file_name,
              'Homework upload'
            ) AS detail,
            'awarded'::text AS status
          FROM materials m
          LEFT JOIN sessions s ON s.id = m.session_id
          WHERE m.student_id = $1
            AND m.file_type = 'Homework'
            AND m.uploaded_by IN ('Parent', 'Admin')
            AND m.session_id IS NOT NULL
          ORDER BY m.session_id, m.uploaded_at ASC, m.id ASC
        ),
        completed_challenges AS (
          SELECT
            'leaderboard'::text AS score_group,
            'challenge'::text AS score_type,
            ${CHALLENGE_POINT_VALUE}::int AS points,
            sc.completed_at AS occurred_at,
            'Challenge completed'::text AS title,
            COALESCE(wc.title, 'Weekly challenge') AS detail,
            'awarded'::text AS status
          FROM student_challenges sc
          LEFT JOIN weekly_challenges wc ON wc.id = sc.challenge_id
          WHERE sc.student_id = $1
            AND sc.status = 'Completed'
            AND sc.completed_at IS NOT NULL
        ),
        pending_challenge_history AS (
          SELECT
            'leaderboard'::text AS score_group,
            'challenge'::text AS score_type,
            0::int AS points,
            COALESCE(sc.submitted_at, sc.created_at) AS occurred_at,
            'Challenge submitted'::text AS title,
            COALESCE(wc.title, 'Weekly challenge') || ' • awaiting teacher approval' AS detail,
            'pending'::text AS status
          FROM student_challenges sc
          LEFT JOIN weekly_challenges wc ON wc.id = sc.challenge_id
          WHERE sc.student_id = $1
            AND sc.status = 'Submitted'
        ),
        badge_history AS (
          SELECT
            'leaderboard'::text AS score_group,
            'badge'::text AS score_type,
            ${BADGE_POINT_VALUE}::int AS points,
            sb.earned_date AS occurred_at,
            'Badge earned'::text AS title,
            COALESCE(sb.badge_name, 'Achievement badge') AS detail,
            'awarded'::text AS status
          FROM student_badges sb
          WHERE sb.student_id = $1
        ),
        class_points_history AS (
          SELECT
            'class_points'::text AS score_group,
            'class_points'::text AS score_type,
            cp.points::int AS points,
            cp.awarded_at AS occurred_at,
            'Class points update'::text AS title,
            COALESCE(cp.reason, 'Live class points') AS detail,
            'awarded'::text AS status
          FROM class_points cp
          WHERE cp.student_id = $1
        )
        SELECT *
        FROM (
          SELECT * FROM homework_history
          UNION ALL
          SELECT * FROM completed_challenges
          UNION ALL
          SELECT * FROM pending_challenge_history
          UNION ALL
          SELECT * FROM badge_history
          UNION ALL
          SELECT * FROM class_points_history
        ) history
        ORDER BY occurred_at DESC NULLS LAST
        LIMIT 100
      `, [studentId])
    ]);

    const totalsRow = totalsResult.rows[0] || {};
    const homeworkPoints = parseInt(totalsRow.homework_points) || 0;
    const challengePoints = parseInt(totalsRow.challenge_points) || 0;
    const badgePoints = parseInt(totalsRow.badge_points) || 0;
    const classPoints = parseInt(totalsRow.class_points) || 0;

    res.json({
      totals: {
        leaderboard_total: homeworkPoints + challengePoints + badgePoints,
        homework_points: homeworkPoints,
        challenge_points: challengePoints,
        badge_points: badgePoints,
        class_points: classPoints,
        pending_challenges: parseInt(totalsRow.pending_challenges) || 0
      },
      history: historyResult.rows
    });
  } catch (err) {
    console.error('Error loading student score history:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current award holders (Student of the Week/Month/Year)
// Shows PREVIOUS completed period winners (not live in-progress data)
app.get('/api/awards/current', async (req, res) => {
  try {
    const now = new Date();

    // LAST WEEK range: Monday to Sunday of the previous completed week
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisWeekStart = new Date(now); thisWeekStart.setDate(now.getDate() + diffToMon); thisWeekStart.setHours(0,0,0,0);
    const weekStart = new Date(thisWeekStart); weekStart.setDate(thisWeekStart.getDate() - 7); // Last Monday
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6); weekEnd.setHours(23,59,59,999); // Last Sunday

    // LAST MONTH range
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    // LAST YEAR range
    const yearStart = new Date(now.getFullYear() - 1, 0, 1);
    const yearEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);

    // Query to get student scores for a date range
   const getTopStudent = async (startDate, endDate) => {
    const result = await executeQuery(`
    WITH homework_pts AS (
      SELECT student_id, COUNT(DISTINCT session_date) * ${HOMEWORK_POINT_VALUE} as pts FROM materials
      WHERE file_type = 'Homework' AND uploaded_by IN ('Parent', 'Admin')
        AND uploaded_at >= $1::date AND uploaded_at < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    ),
    challenge_pts AS (
      SELECT student_id, COUNT(*) * ${CHALLENGE_POINT_VALUE} as pts FROM student_challenges
      WHERE status = 'Completed'
        AND completed_at >= $1::date AND completed_at < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    ),
    badge_pts AS (
      SELECT student_id, COUNT(*) * ${BADGE_POINT_VALUE} as pts FROM student_badges
      WHERE earned_date >= $1::date AND earned_date < ($2::date + INTERVAL '1 day')
      GROUP BY student_id
    )
    SELECT s.id, s.name,
      COALESCE(h.pts, 0) as homework,
      COALESCE(c.pts, 0) as challenges,
      COALESCE(b.pts, 0) as badges,
      COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0) as total_score
    FROM students s
    LEFT JOIN homework_pts h ON s.id = h.student_id
    LEFT JOIN challenge_pts c ON s.id = c.student_id
    LEFT JOIN badge_pts b ON s.id = b.student_id
    WHERE s.is_active = true
      AND (COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0)) > 0
    ORDER BY total_score DESC, homework DESC, challenges DESC, badges DESC, s.name ASC
    LIMIT 1
  `, [startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]]);
  return result.rows[0] || null;
};

    const [weekWinner, monthWinner, yearWinner] = await Promise.all([
      getTopStudent(weekStart, weekEnd),
      getTopStudent(monthStart, monthEnd),
      getTopStudent(yearStart, yearEnd)
    ]);

    // Build period labels for display
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const weekLabel = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const monthLabel = `${monthNames[monthStart.getMonth()]} ${monthStart.getFullYear()}`;
    const yearLabel = `${yearStart.getFullYear()}`;

    const formatAward = (winner, label, periodLabel) => {
      if (!winner) return null;
      return {
        name: winner.name,
        studentId: winner.id,
        badge: label,
        period: periodLabel,
        description: `${winner.homework} pts homework, ${winner.challenges} pts challenges, ${winner.badges} pts badges`,
        homework: parseInt(winner.homework),
        challenges: parseInt(winner.challenges),
        badges: parseInt(winner.badges),
        total_score: parseInt(winner.total_score)
      };
    };

    const awards = {
      studentOfWeek: formatAward(weekWinner, 'Student of the Week', weekLabel),
      studentOfMonth: formatAward(monthWinner, 'Student of the Month', monthLabel),
      studentOfYear: formatAward(yearWinner, 'Student of the Year', yearLabel)
    };

    res.json(awards);
  } catch (err) {
    console.error('Error calculating awards:', err);
    const isDbWakeupError = isTransientDbError(err);

    if (isDbWakeupError) {
      const warmed = await waitForDatabaseReady();
      if (warmed) {
        return res.redirect(307, req.originalUrl);
      }
      return res.status(503).json({
        error: 'Database is still reconnecting. Please retry in a few seconds.',
        code: 'DB_WAKING_UP'
      });
    }

    res.status(500).json({ error: err.message });
  }
});

// GET /api/awards/by-period?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns the top student for any arbitrary date range (used by period-picker dropdowns)
app.get('/api/awards/by-period', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });
    const result = await pool.query(`
      WITH homework_pts AS (
        SELECT student_id, COUNT(DISTINCT session_date) * ${HOMEWORK_POINT_VALUE} as pts FROM materials
        WHERE file_type = 'Homework' AND uploaded_by IN ('Parent', 'Admin')
          AND uploaded_at >= $1::date AND uploaded_at < ($2::date + INTERVAL '1 day')
        GROUP BY student_id
      ),
      challenge_pts AS (
        SELECT student_id, COUNT(*) * ${CHALLENGE_POINT_VALUE} as pts FROM student_challenges
        WHERE status = 'Completed'
          AND completed_at >= $1::date AND completed_at < ($2::date + INTERVAL '1 day')
        GROUP BY student_id
      ),
      badge_pts AS (
        SELECT student_id, COUNT(*) * ${BADGE_POINT_VALUE} as pts FROM student_badges
        WHERE earned_date >= $1::date AND earned_date < ($2::date + INTERVAL '1 day')
        GROUP BY student_id
      )
      SELECT s.id, s.name,
        COALESCE(h.pts, 0) as homework,
        COALESCE(c.pts, 0) as challenges,
        COALESCE(b.pts, 0) as badges,
        COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0) as total_score
      FROM students s
      LEFT JOIN homework_pts h ON s.id = h.student_id
      LEFT JOIN challenge_pts c ON s.id = c.student_id
      LEFT JOIN badge_pts b ON s.id = b.student_id
      WHERE s.is_active = true
        AND (COALESCE(h.pts, 0) + COALESCE(c.pts, 0) + COALESCE(b.pts, 0)) > 0
      ORDER BY total_score DESC, homework DESC, challenges DESC, badges DESC, s.name ASC
      LIMIT 1
    `, [start, end]);
    res.json({ winner: result.rows[0] || null });
  } catch (err) {
    console.error('Error in /api/awards/by-period:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== RESEND AWARD CERTIFICATE EMAIL ====================
// POST /api/admin/resend-award-email
// Body: { student_id, period_type: 'week' | 'month' | 'year' }
// Re-sends the Student of the Week/Month/Year award email (with certificate link) to the parent.
app.post('/api/admin/resend-award-email', async (req, res) => {
  try {
    const { student_id, period_type } = req.body;
    if (!student_id || !period_type) {
      return res.status(400).json({ error: 'student_id and period_type are required' });
    }

    // Load student record
    const studentResult = await pool.query('SELECT * FROM students WHERE id = $1', [student_id]);
    if (!studentResult.rows.length) return res.status(404).json({ error: 'Student not found' });
    const student = studentResult.rows[0];
    if (!student.parent_email) return res.status(400).json({ error: 'No parent email on file for this student' });

    // Find the most recent award badge of this period type
    const badgeResult = await pool.query(
      `SELECT * FROM student_badges WHERE student_id = $1 AND badge_type LIKE $2 ORDER BY earned_date DESC LIMIT 1`,
      [student_id, `student_of_${period_type}_%`]
    );
    if (!badgeResult.rows.length) {
      return res.status(404).json({ error: `No "${period_type}" award badge found for ${student.name}. Make sure the award has been given first.` });
    }

    const badge = badgeResult.rows[0];
    const awardTitle = badge.badge_name;

    // Extract period label and reported score from badge description
    // Description format: "Top scorer for PERIOD_LABEL with N points!"
    const descMatch = badge.badge_description?.match(/^Top scorer for (.+?) with (\d+) points!/);
    const periodLabel = descMatch ? descMatch[1] : 'Recent Period';
    let totalScore = descMatch ? parseInt(descMatch[2]) : 0;
    let breakdown = { homework: 0, challenges: 0, badges: 0 };

    // Reconstruct date range from badge_type to re-fetch accurate score breakdown
    // badge_type format: student_of_week_YEAR_WNN  |  student_of_month_YEAR_MM  |  student_of_year_YEAR
    const parts = badge.badge_type.split('_'); // ['student','of','week','2026','W09']
    const yearStr = parts[3];
    const periodKey = parts[4]; // 'W09', '02', or undefined for year
    let startDate = null, endDate = null;

    if (period_type === 'week' && periodKey?.startsWith('W')) {
      const weekNum = parseInt(periodKey.slice(1));
      const jan1 = new Date(parseInt(yearStr), 0, 1);
      // ISO week: find Sunday of that week
      const sunday = new Date(jan1);
      sunday.setDate(jan1.getDate() + (weekNum - 1) * 7 - jan1.getDay());
      const saturday = new Date(sunday);
      saturday.setDate(sunday.getDate() + 6);
      startDate = sunday.toISOString().split('T')[0];
      endDate = saturday.toISOString().split('T')[0];
    } else if (period_type === 'month' && periodKey) {
      const mn = parseInt(periodKey, 10);
      const lastDay = new Date(parseInt(yearStr), mn, 0);
      startDate = `${yearStr}-${periodKey}-01`;
      endDate = `${yearStr}-${periodKey}-${String(lastDay.getDate()).padStart(2, '0')}`;
    } else if (period_type === 'year' && yearStr) {
      startDate = `${yearStr}-01-01`;
      endDate = `${yearStr}-12-31`;
    }

    if (startDate && endDate) {
      const scores = await calculateStudentScores(startDate, endDate);
      const studentScore = scores.find(s => String(s.student_id) === String(student_id));
      if (studentScore) {
        totalScore = studentScore.total_score;
        breakdown = {
          homework: studentScore.homework_score,
          challenges: studentScore.challenge_score,
          badges: studentScore.badge_score
        };
      }
    }

    // Find existing certificate record or create a new one
    let certificateUrl = '';
    const certTitle = getAwardCertificateTitle(period_type);
    const certResult = await pool.query(
      `SELECT id FROM monthly_assessments WHERE assessment_type = 'demo' AND student_id = $1 AND certificate_title = $2 ORDER BY created_at DESC LIMIT 1`,
      [student_id, certTitle]
    );
    if (certResult.rows[0]?.id) {
      const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
      certificateUrl = `${appUrl}/demo-certificate.html?id=${certResult.rows[0].id}`;
    } else {
      const certInsert = await pool.query(`
        INSERT INTO monthly_assessments (assessment_type, student_id, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES ('demo', $1, $2, $3, $4, $5, $6) RETURNING id
      `, [
        student_id,
        JSON.stringify(['Homework Consistency', 'Challenge Participation', 'Badge Achievement']),
        certTitle,
        badge.badge_description || `${awardTitle} (${periodLabel}) with ${totalScore} points.`,
        'Keep up consistent participation and complete challenges regularly.',
        'Outstanding progress and dedication shown this period.'
      ]);
      if (certInsert.rows[0]?.id) {
        const appUrl = process.env.BASE_URL || process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com';
        certificateUrl = `${appUrl}/demo-certificate.html?id=${certInsert.rows[0].id}`;
      }
    }

    // Build the award email with certificate button baked directly in
    const finalEmailHTML = getStudentAwardEmail(student.name, awardTitle, periodLabel, totalScore, breakdown, certificateUrl);

    const sent = await sendEmail(
      student.parent_email,
      `${awardTitle} - ${student.name} | Fluent Feathers Academy`,
      finalEmailHTML,
      student.parent_name,
      'Student Award Resend'
    );

    console.log(`📧 Award email resend for ${student.name} (${period_type}): ${sent ? 'SUCCESS' : 'FAILED'} → ${student.parent_email}`);
    res.json({
      success: sent,
      message: sent
        ? `Award email successfully resent to ${student.parent_email}`
        : 'Email service failed. Check BREVO_API_KEY and server logs.',
      certificateUrl: certificateUrl || null
    });
  } catch (err) {
    console.error('Error resending award email:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync badges for all students based on their completed sessions (run once to fix missing badges)
app.post('/api/badges/sync-all', async (req, res) => {
  try {
    const students = await pool.query('SELECT id, completed_sessions FROM students WHERE is_active = true');
    let awarded = 0;

    for (const student of students.rows) {
      const count = student.completed_sessions || 0;

      if (count >= 1) {
        const result = await awardBadge(student.id, 'first_class', '🌟 First Class Star', 'Attended first class!');
        if (result) awarded++;
      }
      if (count >= 5) {
        const result = await awardBadge(student.id, '5_classes', '🏆 5 Classes Champion', 'Completed 5 classes!');
        if (result) awarded++;
      }
      if (count >= 10) {
        const result = await awardBadge(student.id, '10_classes', '👑 10 Classes Master', 'Completed 10 classes!');
        if (result) awarded++;
      }
      if (count >= 25) {
        const result = await awardBadge(student.id, '25_classes', '🎖️ 25 Classes Legend', 'Completed 25 classes!');
        if (result) awarded++;
      }
      if (count >= 50) {
        const result = await awardBadge(student.id, '50_classes', '💎 50 Classes Diamond', 'Amazing milestone!');
        if (result) awarded++;
      }
    }

    res.json({ success: true, message: `Synced badges! ${awarded} new badges awarded.` });
  } catch (err) {
    console.error('Badge sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/badges/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_badges WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CLASS FEEDBACK/RATINGS ====================
app.get('/api/class-feedback/all', async (req, res) => {
  try {
    const { student_id, rating } = req.query;

    let query = `
      SELECT cf.*, s.session_number, st.name as student_name
      FROM class_feedback cf
      LEFT JOIN sessions s ON cf.session_id = s.id
      LEFT JOIN students st ON cf.student_id = st.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (student_id) {
      query += ` AND cf.student_id = $${paramIndex}`;
      params.push(student_id);
      paramIndex++;
    }
    if (rating) {
      query += ` AND cf.rating = $${paramIndex}`;
      params.push(rating);
      paramIndex++;
    }

    query += ` ORDER BY cf.created_at DESC`;

    const feedbacks = await pool.query(query, params);

    // Get stats
    const statsQuery = await pool.query(`
      SELECT
        COUNT(*) as total,
        AVG(rating) as avg_rating,
        COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star_count
      FROM class_feedback
    `);

    // Get all students for filter dropdown
    const students = await pool.query('SELECT id, name FROM students WHERE is_active = true ORDER BY name');

    res.json({
      feedbacks: feedbacks.rows,
      total: parseInt(statsQuery.rows[0].total) || 0,
      avgRating: parseFloat(statsQuery.rows[0].avg_rating) || 0,
      fiveStarCount: parseInt(statsQuery.rows[0].five_star_count) || 0,
      students: students.rows
    });
  } catch (err) {
    console.error('Error loading class feedback:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== HOMEWORK GRADING ====================
app.post('/api/materials/:id/grade', async (req, res) => {
  const { grade, comments } = req.body;
  try {
    await pool.query(`
      UPDATE materials SET
        feedback_grade = $1,
        feedback_comments = $2,
        feedback_given = 1,
        feedback_date = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [grade, comments, req.params.id]);

    // Get material details with student info for email
    const materialResult = await pool.query(`
      SELECT m.*, s.session_number, st.name as student_name, st.parent_email, st.parent_name
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      LEFT JOIN students st ON m.student_id = st.id
      WHERE m.id = $1
    `, [req.params.id]);

    if (materialResult.rows[0]) {
      const material = materialResult.rows[0];
      const materialType = material.file_type === 'Classwork' ? 'Classwork' : 'Homework';

      // Award badge
      await awardBadge(material.student_id, 'graded_hw', '📚 Homework Hero', 'Received homework feedback');

      // Send email notification to parent
      if (material.parent_email) {
        try {
          const materialType = material.file_type === 'Classwork' ? 'Classwork' : 'Homework';
          const feedbackEmailHTML = getHomeworkFeedbackEmail({
            studentName: material.student_name,
            parentName: material.parent_name,
            grade: grade,
            comments: comments,
            fileName: material.file_name,
            workType: materialType,
            actionLabel: 'Reviewed'
          });

          await sendEmail(
            material.parent_email,
            `📝 ${materialType} Feedback - ${material.student_name}'s ${materialType} Reviewed`,
            feedbackEmailHTML,
            material.parent_name,
            `${materialType}-Feedback`
          );
          console.log(`✅ Sent homework feedback email to ${material.parent_email} for ${material.student_name}`);
        } catch (emailErr) {
          console.error('Error sending work feedback email:', emailErr);
          // Don't fail the request if email fails
        }
      }
    }

    res.json({ success: true, message: 'Homework graded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Annotate homework: receives base64 image, uploads to Cloudinary, saves corrected file + grade
app.post('/api/materials/:id/annotate', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { image_data, grade, comments } = req.body;
    if (!image_data) return res.status(400).json({ error: 'No annotated image data' });

    // Decode base64 to buffer
    const base64Data = image_data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    let correctedUrl;
    if (useCloudinary) {
      // Upload to Cloudinary
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'fluentfeathers/corrections', resource_type: 'image', public_id: 'correction_' + Date.now() },
          (err, result) => err ? reject(err) : resolve(result)
        );
        stream.end(buffer);
      });
      correctedUrl = uploadResult.secure_url;
    } else {
      // Local storage fallback
      const fileName = 'correction_' + Date.now() + '.png';
      const filePath = path.join(__dirname, 'uploads', 'homework', fileName);
      require('fs').writeFileSync(filePath, buffer);
      correctedUrl = '/uploads/homework/' + fileName;
    }

    // Update the material with corrected file and grade
    await pool.query(`
      UPDATE materials SET
        corrected_file_path = $1,
        feedback_grade = $2,
        feedback_comments = $3,
        feedback_given = 1,
        feedback_date = CURRENT_TIMESTAMP
      WHERE id = $4
    `, [correctedUrl, grade || null, comments || null, req.params.id]);

    // Get material details for email
    const materialResult = await pool.query(`
      SELECT m.*, st.name as student_name, st.parent_email, st.parent_name
      FROM materials m
      LEFT JOIN students st ON m.student_id = st.id
      WHERE m.id = $1
    `, [req.params.id]);

    if (materialResult.rows[0]) {
      const material = materialResult.rows[0];
      await awardBadge(material.student_id, 'graded_hw', '📚 Homework Hero', 'Received homework feedback');

      if (material.parent_email) {
        const materialType = material.file_type === 'Classwork' ? 'Classwork' : 'Homework';
        const feedbackEmailHTML = getHomeworkFeedbackEmail({
          studentName: material.student_name,
          parentName: material.parent_name,
          grade: grade,
          comments: (comments || '') + `\n\nYour corrected ${materialType.toLowerCase()} with teacher's annotations is available on the parent portal.`,
          fileName: material.file_name,
          workType: materialType,
          actionLabel: 'Corrected'
        });
        await sendEmail(
          material.parent_email,
          `📝 ${materialType} Corrected - ${material.student_name}'s ${materialType} Reviewed`,
          feedbackEmailHTML,
          material.parent_name,
          `${materialType}-Feedback`
        );
      }
    }

    res.json({ success: true, corrected_url: correctedUrl });
  } catch (err) {
    console.error('Annotation error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/homework', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.*, s.session_number
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      WHERE m.student_id = $1 AND m.file_type IN ('Homework', 'Classwork')
      ORDER BY m.uploaded_at DESC
    `, [req.params.id]);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        row.file_path = '/uploads/homework/' + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI auto-correct homework using GPT-4 Vision
app.post('/api/homework/ai-annotate', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(400).json({ error: 'GROQ_API_KEY is not configured. Add it to your environment variables on Render. Get a free key at console.groq.com' });
    }

    const { image_data, student_name, minimal } = req.body;
    if (!image_data) return res.status(400).json({ error: 'No image data provided' });

    const studentLabel = student_name ? `Student: ${student_name}. ` : '';
    const minimalMode = minimal === true || minimal === 'true';
    const prompt = `You are an English language teacher reviewing a student's creative writing homework image. ${studentLabel}Carefully read ALL the handwritten or typed text in the image.

Find every spelling mistake, grammar error, punctuation error, and capitalisation error.

For each correction, you MUST:
- Set "type" to one of: spelling, grammar, punctuation, capitalization (choose the most specific).
- Set "note" to a short, student-friendly explanation (e.g. "Spelling mistake", "Needs a capital letter", "Check your punctuation").
- For "correct", return only the smallest correction needed near the mistake (prefer a single word or token, do NOT rewrite the whole sentence).
- Do NOT return long explanations in "correct".
${minimalMode ? '- Keep every "correct" answer as short as possible, usually just one word or one punctuation mark.' : ''}

Examples:
  "wrong: 'goed' -> correct: 'went', type: 'spelling', note: 'Spelling mistake'"
  "wrong: 'she go' -> correct: 'goes', type: 'grammar', note: 'Verb agreement'"
  "wrong: missing capital letter -> correct: 'The', type: 'capitalization', note: 'Needs a capital letter'"
  "wrong: missing punctuation -> correct: '.', type: 'punctuation', note: 'Add a period'"

Return ONLY a valid JSON object in this exact format (no other text before or after):
{
  "corrections": [
    {
      "wrong": "the exact wrong word or phrase as written by student",
      "correct": "the corrected word/token only",
      "type": "spelling|grammar|punctuation|capitalization",
      "note": "short student-friendly explanation",
      "x": 45,
      "y": 30
    }
  ],
  "grade": "B+",
  "summary": "One sentence overall feedback addressed to ${student_name ? student_name : 'the student'}"
}

For x and y: estimate the percentage position (0-100) from the TOP-LEFT corner of the image where that error appears visually.
If the writing has no errors, return {"corrections": [], "grade": "A+", "summary": "${student_name ? student_name + ', excellent' : 'Excellent'} work! No errors found."}
Return ONLY the JSON. No markdown. No explanation.`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image_data } }
          ]
        }],
        max_tokens: 4096,
        temperature: 0.1
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` }, timeout: 45000 }
    );

    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(500).json({ error: 'Groq returned empty response' });

    // Extract JSON block, strip markdown fences if present
    let jsonStr = content;
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    else { const braceMatch = content.match(/\{[\s\S]*\}/); if (braceMatch) jsonStr = braceMatch[0]; }

    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt to sanitize common issues: replace unescaped newlines inside strings
      const sanitized = jsonStr.replace(/[\r\n]+/g, ' ').replace(/([^\\])\\'/g, "$1'");
      try { result = JSON.parse(sanitized); }
      catch (e2) { return res.status(500).json({ error: 'AI returned malformed JSON', raw: jsonStr.slice(0, 300) }); }
    }
    const allowedTypes = new Set(['spelling', 'grammar', 'punctuation', 'capitalization']);
    const defaultNotes = {
      spelling: 'Spelling mistake',
      grammar: 'Grammar correction',
      punctuation: 'Check your punctuation',
      capitalization: 'Needs a capital letter'
    };
    const clampPercent = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return 50;
      return Math.max(0, Math.min(100, Math.round(num)));
    };

    const normalizedCorrections = Array.isArray(result?.corrections)
      ? result.corrections.map((item) => {
          const normalizedType = String(item?.type || '').trim().toLowerCase();
          const type = allowedTypes.has(normalizedType) ? normalizedType : 'spelling';
          return {
            wrong: String(item?.wrong || '').trim().slice(0, 120),
            correct: String(item?.correct || '').trim().slice(0, 120),
            type,
            note: String(item?.note || defaultNotes[type]).trim().slice(0, 140) || defaultNotes[type],
            x: clampPercent(item?.x),
            y: clampPercent(item?.y)
          };
        }).filter((item) => item.correct || item.note)
      : [];

    res.json({
      corrections: normalizedCorrections,
      grade: String(result?.grade || '').trim().slice(0, 20),
      summary: String(result?.summary || '').trim().slice(0, 240)
    });
  } catch (err) {
    console.error('AI annotate error:', err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// AI assessment suggestion using Groq
app.post('/api/assessments/ai-suggest', express.json(), async (req, res) => {
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(400).json({ error: 'GROQ_API_KEY not configured on Render. Get a free key at console.groq.com' });
    }

    const { student_id, quick_notes, assessment_type } = req.body;
    if (!quick_notes) return res.status(400).json({ error: 'quick_notes is required' });

    // Fetch student info
    let studentName = 'the student';
    let studentAge = '';
    let pastAssessments = [];
    if (student_id) {
      const sRes = await pool.query('SELECT name, date_of_birth FROM students WHERE id = $1', [student_id]);
      if (sRes.rows[0]) {
        studentName = sRes.rows[0].name;
        const ageVal = calculateAge(sRes.rows[0].date_of_birth);
        studentAge = ageVal !== null ? ` (age ${ageVal})` : '';
      }
      const aRes = await pool.query(
        `SELECT skill_ratings, certificate_title, performance_summary, month, year
         FROM monthly_assessments
         WHERE student_id = $1 AND assessment_type = 'monthly' AND (deferred IS NULL OR deferred = FALSE)
         ORDER BY year DESC, month DESC LIMIT 3`,
        [student_id]
      );
      pastAssessments = aRes.rows;
    }

    const pastContext = pastAssessments.length > 0
      ? pastAssessments.map(a => {
          let r = {};
          try { r = a.skill_ratings ? JSON.parse(a.skill_ratings) : {}; } catch(e) {}
          const rStr = Object.entries(r).map(([k,v]) => `${k}:${v}/5`).join(', ');
          return `- ${a.year}-${String(a.month).padStart(2,'0')}: cert="${a.certificate_title || 'none'}", ratings={${rStr}}, summary="${(a.performance_summary||'').slice(0,80)}..."`;
        }).join('\n')
      : 'No previous assessments.';

    const isDemo = assessment_type === 'demo';
    const prompt = `You are an expert English language teacher's assistant helping fill out a ${isDemo ? 'demo class' : 'monthly'} student assessment.

Student: ${studentName}${studentAge}
Teacher's quick notes about this session: "${quick_notes}"

Past assessment history:
${pastContext}

Based on the teacher's notes and past history, generate a complete assessment suggestion.

Skill categories to rate (1-5 stars, where 1=needs work, 3=average, 5=excellent):
- Phonics
- Reading
- Spoken English
- Grammar
- Vocabulary
- Creative Writing
- Spellings
- Handwriting
- Public Speaking

Only include categories that are relevant given the teacher's notes (minimum 3, maximum 9).

Return ONLY valid JSON in this exact format:
{
  "skill_ratings": {
    "Phonics": 4,
    "Reading": 3
  },
  "certificate_title": "Star of the Month",
  "performance_summary": "A warm, encouraging 2-3 sentence summary written to the parents about their child's progress this month.",
  "grade_suggestion": "A"
}

For certificate_title, choose the most appropriate from: Star of the Month, Most Improved, Creative Writing Star, Reading Champion, Speaking Star, Spelling Bee Champion, Student of the Week, Student of the Month, Handwriting Excellence, Grammar Guru, or leave as empty string if no award is warranted.

Return ONLY JSON. No markdown. No explanation.`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
        temperature: 0.4
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` }, timeout: 20000 }
    );

    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(500).json({ error: 'Groq returned empty response' });
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Unexpected AI response', raw: content });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('AI assess suggest error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// AI homework feedback generator
app.post('/api/homework/ai-feedback', express.json(), async (req, res) => {
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(400).json({ error: 'GROQ_API_KEY not configured on Render.' });
    const { student_name, teacher_notes, file_name } = req.body;
    if (!teacher_notes) return res.status(400).json({ error: 'teacher_notes is required' });

    const firstName = (student_name || 'the student').split(' ')[0];
    const prompt = `You are a warm, encouraging English language teacher writing homework feedback directly to a student.

Student first name: ${firstName}
Homework file: ${file_name || 'submitted homework'}
Teacher's quick notes: "${teacher_notes}"

Write detailed, friendly feedback (4-6 sentences) in second person, addressed directly to the student by their first name (e.g. "Great work, ${firstName}!"). Use a warm, positive tone with interjections like "Awesome!", "Keep it up!", "Fantastic effort!", etc. Be specific, mention what was done well, and give at least one clear suggestion for improvement. End with a motivating, personal closing line.

Also suggest a grade from: A+, A, B+, B, C+, C, Needs Improvement.

Return ONLY valid JSON:
{
  "feedback": "The full feedback text here...",
  "grade": "A"
}
Return ONLY JSON. No markdown.`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.5
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` }, timeout: 15000 }
    );
    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(500).json({ error: 'AI returned empty response' });
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : (content.match(/\{[\s\S]*\}/) || [content])[0];
    res.json(JSON.parse(jsonStr));
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// AI Quick Fill — fills challenge / announcement / resource forms
app.post('/api/ai/quickfill', express.json(), async (req, res) => {
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(400).json({ error: 'GROQ_API_KEY not configured on Render. Get a free key at console.groq.com' });
    const { form_type, prompt } = req.body;
    if (!form_type || !prompt) return res.status(400).json({ error: 'form_type and prompt are required' });

    const systemPrompts = {
      challenge: `You are a helper for a children's English language learning school. Fill in a weekly challenge form based on the teacher's brief description.
Return ONLY valid JSON:
{
  "title": "Challenge title, short and engaging, max 60 chars",
  "type": "one of: Reading, Vocabulary, Speaking, Writing, Homework, Practice, General",
  "description": "2-3 sentences describing what students need to do",
  "badge_reward": "one of: 🎯 Challenge Champion, 📖 Reading Star, 📚 Vocab Master, 🗣️ Speaking Hero, ✍️ Writing Wizard, ⭐ Super Achiever, 🏆 Weekly Winner, 🌟 Shining Star"
}
Return ONLY JSON. No markdown. No explanation.`,
      announcement: `You are a helper for a children's English language learning school. Fill in an announcement form.
Return ONLY valid JSON:
{
  "title": "Clear announcement title, max 80 chars",
  "type": "one of: General, Holiday, Reminder, Update, Challenge Update, Competition Update, Results",
  "priority": "one of: Normal, High, Urgent",
  "content": "Full announcement text in 2-4 sentences, professional and friendly tone for parents"
}
Return ONLY JSON. No markdown. No explanation.`,
      resource: `You are a helper for a children's English language learning school. Fill in a learning resource form.
Return ONLY valid JSON:
{
  "title": "Descriptive resource title, max 80 chars",
  "category": "one of: Videos, Worksheets, PDFs, Practice, Games, Stories, Other",
  "description": "1-2 sentences describing this resource and how students use it",
  "tags": "3-5 comma-separated tags, e.g. phonics, reading, grade 2"
}
Return ONLY JSON. No markdown. No explanation.`
    };

    const sysPrompt = systemPrompts[form_type];
    if (!sysPrompt) return res.status(400).json({ error: 'Unknown form_type: ' + form_type });

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: prompt }
        ],
        max_tokens: 512,
        temperature: 0.45
      },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` }, timeout: 15000 }
    );

    const content = response.data.choices?.[0]?.message?.content?.trim();
    if (!content) return res.status(500).json({ error: 'AI returned empty response' });
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : (content.match(/\{[\s\S]*\}/) || [content])[0];
    res.json(JSON.parse(jsonStr));
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Get all homework submissions (for admin panel)
app.get('/api/homework/all', async (req, res) => {
  try {
    const studentId = req.query.student_id;
    let query = `
      SELECT m.*, s.session_number, s.session_topic, st.name as student_name
      FROM materials m
      LEFT JOIN sessions s ON m.session_id = s.id
      LEFT JOIN students st ON m.student_id = st.id
      WHERE m.file_type IN ('Homework', 'Classwork') AND m.uploaded_by IN ('Parent', 'Admin')
    `;

    const params = [];
    if (studentId) {
      query += ` AND m.student_id = $1`;
      params.push(studentId);
    }

    query += ` ORDER BY m.uploaded_at DESC`;

    const result = await pool.query(query, params);

    // Ensure file paths have correct prefix for backwards compatibility
    const rows = result.rows.map(row => {
      // Skip if already has correct prefix, is a link, or is a Cloudinary/external URL
      if (row.file_path && !row.file_path.startsWith('/uploads/') && !row.file_path.startsWith('LINK:') && !row.file_path.startsWith('https://') && !row.file_path.startsWith('http://')) {
        row.file_path = '/uploads/homework/' + row.file_path;
      }
      return row;
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get sessions for a student (for homework session picker)
app.get('/api/students/:id/sessions', async (req, res) => {
  try {
    // Private sessions
    const priv = await pool.query(`
      SELECT id, session_number, session_date FROM sessions
      WHERE student_id = $1 AND status = 'Completed'
      ORDER BY session_number DESC
    `, [req.params.id]);
    // Group sessions via session_attendance
    const grp = await pool.query(`
      SELECT s.id, s.session_number, s.session_date FROM sessions s
      JOIN session_attendance sa ON sa.session_id = s.id
      WHERE sa.student_id = $1 AND sa.attendance = 'Present'
      ORDER BY s.session_number DESC
    `, [req.params.id]);
    const seen = new Set();
    const all = [...priv.rows, ...grp.rows].filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
    all.sort((a, b) => b.session_number - a.session_number);
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin manually marks homework as done (for Google Docs / offline work)
app.post('/api/homework/mark-done', async (req, res) => {
  try {
    const { student_id, session_id, note } = req.body;
    if (!student_id) return res.status(400).json({ error: 'Student ID required' });

    const sessId = session_id || null;
    const sessDate = sessId
      ? (await pool.query('SELECT session_date FROM sessions WHERE id = $1', [sessId])).rows[0]?.session_date || new Date()
      : new Date();

    await pool.query(`
      INSERT INTO materials (student_id, session_id, session_date, file_type, file_name, file_path, uploaded_by)
      VALUES ($1, $2, $3, 'Homework', $4, 'MANUAL', 'Admin')
    `, [student_id, sessId, sessDate, note || 'Completed offline']);

    // Award homework badges same as parent upload
    await awardBadge(student_id, 'hw_submit', '📝 Homework Hero', 'Submitted homework on time');
    const hwCount = await pool.query("SELECT COUNT(*) as count FROM materials WHERE student_id = $1 AND file_type = 'Homework'", [student_id]);
    const count = parseInt(hwCount.rows[0].count);
    if (count === 5) await awardBadge(student_id, '5_homework', '📚 5 Homework Superstar', 'Submitted 5 homework assignments!');
    if (count === 10) await awardBadge(student_id, '10_homework', '🎓 10 Homework Champion', 'Submitted 10 homework assignments!');
    if (count === 25) await awardBadge(student_id, '25_homework', '🏅 25 Homework Master', 'Submitted 25 homework assignments!');

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete homework submission
app.delete('/api/homework/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the file path before deleting (for Cloudinary cleanup if needed)
    const existing = await pool.query('SELECT file_path, corrected_file_path FROM materials WHERE id = $1', [id]);

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Homework not found' });
    }

    const filePath = existing.rows[0].file_path;
    const correctedPath = existing.rows[0].corrected_file_path;

    // Delete from database
    await pool.query('DELETE FROM materials WHERE id = $1', [id]);

    // Delete files from Cloudinary
    await deleteFromCloudinary(filePath);
    await deleteFromCloudinary(correctedPath);

    res.json({ message: 'Homework deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== WEEKLY CHALLENGES API ====================
// Get all challenges (admin)
app.get('/api/challenges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id) as assigned_count,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id AND sc.status = 'Completed') as completed_count,
        (SELECT COUNT(*) FROM student_challenges sc WHERE sc.challenge_id = c.id AND sc.status = 'Submitted') as submitted_count
      FROM weekly_challenges c
      ORDER BY c.week_start DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new challenge
app.post('/api/challenges', async (req, res) => {
  const { title, description, challenge_type, badge_reward, week_start, week_end, assign_to_all, send_email } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO weekly_challenges (title, description, challenge_type, badge_reward, week_start, week_end)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [title, description, challenge_type || 'General', badge_reward || '🎯 Challenge Champion', week_start, week_end]);

    const challenge = result.rows[0];
    let assignedStudents = [];

    // If assign_to_all, create student_challenges for all active students
    if (assign_to_all) {
      const students = await pool.query('SELECT id FROM students WHERE is_active = true');
      assignedStudents = students.rows;
      for (const student of assignedStudents) {
        await pool.query(`
          INSERT INTO student_challenges (student_id, challenge_id, status)
          VALUES ($1, $2, 'Assigned')
        `, [student.id, challenge.id]);
      }
    }

    // Send email notifications to parents if requested
    let emailsSent = 0;
    if (send_email === true || send_email === 'true') {
      const dueDate = new Date(week_end).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const startDate = new Date(week_start).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      const typeEmojis = { 'Reading': '📖', 'Vocabulary': '📚', 'Speaking': '🗣️', 'Writing': '✍️', 'Homework': '📝', 'Practice': '🎯', 'General': '⭐' };
      const emoji = typeEmojis[challenge_type] || '🎯';

      const parents = await pool.query(`
        SELECT DISTINCT s.parent_email, s.parent_name, s.name as student_name
        FROM students s
        WHERE s.is_active = true AND s.parent_email IS NOT NULL
      `);

      for (const p of parents.rows) {
        const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f0f4f8;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:35px 30px;text-align:center;">
      <div style="font-size:3rem;">${emoji}</div>
      <h1 style="color:white;margin:10px 0 5px;font-size:1.6rem;">New Challenge Assigned!</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;">Fluent Feathers Academy</p>
    </div>
    <div style="padding:30px;">
      <p style="color:#4a5568;font-size:1rem;">Dear <strong>${p.parent_name || 'Parent'}</strong>,</p>
      <p style="color:#4a5568;">A new weekly challenge has been assigned to <strong>${p.student_name}</strong>. Encourage them to complete it before the due date to earn a badge!</p>
      <div style="background:linear-gradient(135deg,#f0f4ff 0%,#faf5ff 100%);border-left:4px solid #667eea;border-radius:8px;padding:20px;margin:20px 0;">
        <h2 style="color:#2d3748;margin:0 0 12px;font-size:1.2rem;">${emoji} ${title}</h2>
        ${description ? `<p style="color:#4a5568;margin:0 0 12px;">${description}</p>` : ''}
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#718096;font-size:0.9rem;">📅 Start Date</td><td style="padding:6px 0;color:#2d3748;font-weight:600;">${startDate}</td></tr>
          <tr><td style="padding:6px 0;color:#718096;font-size:0.9rem;">⏰ Due Date</td><td style="padding:6px 0;color:#e53e3e;font-weight:600;">${dueDate}</td></tr>
          <tr><td style="padding:6px 0;color:#718096;font-size:0.9rem;">🏅 Badge Reward</td><td style="padding:6px 0;color:#2d3748;font-weight:600;">${badge_reward || '🎯 Challenge Champion'}</td></tr>
        </table>
      </div>
      <p style="color:#4a5568;">Once completed, please submit the challenge through the <strong>Parent Portal</strong> so it can be reviewed.</p>
      <div style="text-align:center;margin:25px 0;">
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:12px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:1rem;">🎯 View in Parent Portal</a>
      </div>
    </div>
    <div style="background:#f7fafc;padding:15px;text-align:center;color:#718096;font-size:0.8rem;">
      Fluent Feathers Academy &nbsp;|&nbsp; This is an automated notification<br>
      <span style="font-size:0.75rem;">Made with ❤️ By Aaliya</span>
    </div>
  </div>
</body>
</html>`;
        const sent = await sendEmail(p.parent_email, `🎯 New Challenge: ${title} — Due ${dueDate}`, emailHtml, p.parent_name, 'Challenge Notification');
        if (sent) emailsSent++;
      }
    }

    res.json({ success: true, challenge, emailsSent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign challenge to specific students
app.post('/api/challenges/:id/assign', async (req, res) => {
  const { student_ids } = req.body;
  try {
    for (const studentId of student_ids) {
      await pool.query(`
        INSERT INTO student_challenges (student_id, challenge_id, status)
        VALUES ($1, $2, 'Assigned')
        ON CONFLICT (student_id, challenge_id) DO NOTHING
      `, [studentId, req.params.id]);
    }
    res.json({ success: true, message: 'Challenge assigned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get students assigned to a specific challenge (for tracking)
app.get('/api/challenges/:id/students', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sc.*, s.name as student_name, s.program_name,
        c.week_end,
        CASE
          WHEN sc.status = 'Completed' THEN 'Completed'
          WHEN sc.status = 'Not Approved' THEN 'Not Approved'
          WHEN sc.status = 'Submitted' THEN 'Submitted'
          WHEN c.week_end < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Finished'
          ELSE 'In Progress'
        END as effective_status
      FROM student_challenges sc
      JOIN students s ON sc.student_id = s.id
      JOIN weekly_challenges c ON c.id = sc.challenge_id
      WHERE sc.challenge_id = $1
      ORDER BY sc.status DESC, s.name
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Parent submits challenge as done (awaiting teacher approval)
// Challenge submission with optional file upload
app.post('/api/challenges/:challengeId/student/:studentId/submit', handleUpload('file'), async (req, res) => {
  try {
    const { challengeId, studentId } = req.params;

    // Get file path if file was uploaded
    let filePath = null;
    let fileName = null;
    if (req.file) {
      if (useCloudinary) {
        filePath = req.file.secure_url || req.file.path || req.file.url;
      } else {
        filePath = '/uploads/homework/' + req.file.filename;
      }
      fileName = req.file.originalname;
    }

    // Check if student already has a record for this challenge
    const existing = await pool.query(
      'SELECT id FROM student_challenges WHERE challenge_id = $1 AND student_id = $2',
      [challengeId, studentId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE student_challenges SET status = 'Submitted', submitted_at = CURRENT_TIMESTAMP, notes = 'Submitted by parent on ' || CURRENT_DATE,
         submission_file_path = COALESCE($3, submission_file_path),
         submission_file_name = COALESCE($4, submission_file_name)
         WHERE challenge_id = $1 AND student_id = $2`,
        [challengeId, studentId, filePath, fileName]
      );
    } else {
      await pool.query(
        `INSERT INTO student_challenges (challenge_id, student_id, status, submitted_at, notes, submission_file_path, submission_file_name)
         VALUES ($1, $2, 'Submitted', CURRENT_TIMESTAMP, 'Submitted by parent on ' || CURRENT_DATE, $3, $4)`,
        [challengeId, studentId, filePath, fileName]
      );
    }

    res.json({ success: true, message: 'Challenge submitted for review!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Keep old PUT endpoint for backwards compatibility (no file)
app.put('/api/challenges/:challengeId/student/:studentId/submit', async (req, res) => {
  try {
    const { challengeId, studentId } = req.params;
    const existing = await pool.query(
      'SELECT id FROM student_challenges WHERE challenge_id = $1 AND student_id = $2',
      [challengeId, studentId]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE student_challenges SET status = 'Submitted', submitted_at = CURRENT_TIMESTAMP, notes = 'Submitted by parent on ' || CURRENT_DATE WHERE challenge_id = $1 AND student_id = $2`,
        [challengeId, studentId]
      );
    } else {
      await pool.query(
        `INSERT INTO student_challenges (challenge_id, student_id, status, submitted_at, notes) VALUES ($1, $2, 'Submitted', CURRENT_TIMESTAMP, 'Submitted by parent on ' || CURRENT_DATE)`,
        [challengeId, studentId]
      );
    }

    res.json({ success: true, message: 'Challenge submitted for review!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark student challenge as completed (teacher approval)
app.put('/api/challenges/:challengeId/student/:studentId/complete', async (req, res) => {
  const { badge_reward } = req.body;
  try {
    await pool.query(`
      UPDATE student_challenges
      SET status = 'Completed', completed_at = CURRENT_TIMESTAMP
      WHERE challenge_id = $1 AND student_id = $2
    `, [req.params.challengeId, req.params.studentId]);

    // Award badge for completing challenge
    const challenge = await pool.query('SELECT * FROM weekly_challenges WHERE id = $1', [req.params.challengeId]);
    if (challenge.rows.length > 0) {
      const badgeName = badge_reward || challenge.rows[0].badge_reward || '🎯 Challenge Champion';
      await pool.query(`
        INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
        VALUES ($1, $2, $3, $4)
      `, [req.params.studentId, 'challenge_' + req.params.challengeId, badgeName, 'Completed: ' + challenge.rows[0].title]);

      // Send congratulations email to parent
      try {
        const studentRes = await pool.query(
          'SELECT name, parent_email, parent_name FROM students WHERE id = $1',
          [req.params.studentId]
        );
        if (studentRes.rows.length > 0) {
          const student = studentRes.rows[0];
          const ch = challenge.rows[0];
          const typeEmojis = { 'Reading': '📖', 'Vocabulary': '📚', 'Speaking': '🗣️', 'Writing': '✍️', 'Homework': '📝', 'Practice': '🎯', 'General': '⭐' };
          const emoji = typeEmojis[ch.challenge_type] || '🎯';
          const completedDate = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

          const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f0f4f8;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#f6d365 0%,#fda085 100%);padding:40px 30px;text-align:center;">
      <div style="font-size:4rem;">🎉</div>
      <h1 style="color:white;margin:10px 0 5px;font-size:1.8rem;">Congratulations!</h1>
      <p style="color:rgba(255,255,255,0.9);margin:0;font-size:1rem;">${student.name} has completed a challenge!</p>
    </div>
    <div style="padding:30px;">
      <p style="color:#4a5568;font-size:1rem;">Dear <strong>${student.parent_name || 'Parent'}</strong>,</p>
      <p style="color:#4a5568;font-size:1rem;">We are thrilled to share that <strong>${student.name}</strong> has successfully completed the weekly challenge and earned a badge! 🏅</p>

      <div style="background:linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%);border:2px solid #f59e0b;border-radius:12px;padding:22px;margin:20px 0;text-align:center;">
        <div style="font-size:2.5rem;margin-bottom:8px;">${emoji}</div>
        <h2 style="color:#92400e;margin:0 0 6px;font-size:1.3rem;">${ch.title}</h2>
        ${ch.description ? `<p style="color:#78350f;margin:0 0 12px;font-size:0.9rem;">${ch.description}</p>` : ''}
        <div style="display:inline-block;background:linear-gradient(135deg,#f59e0b 0%,#d97706 100%);color:white;padding:10px 24px;border-radius:25px;font-weight:bold;font-size:1rem;margin-top:8px;">
          🏅 ${badgeName}
        </div>
      </div>

      <div style="background:#f0fff4;border-left:4px solid #38a169;border-radius:8px;padding:16px;margin:20px 0;">
        <p style="color:#276749;margin:0;font-size:0.95rem;">✅ <strong>Completed on:</strong> ${completedDate}</p>
      </div>

      <p style="color:#4a5568;">This achievement reflects <strong>${student.name}</strong>'s dedication and hard work. Please celebrate this moment with them — it means a lot! 🌟</p>
      <p style="color:#4a5568;">Keep encouraging them to take on more challenges and continue growing every week.</p>

      <div style="text-align:center;margin:25px 0;">
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:12px 30px;border-radius:25px;text-decoration:none;font-weight:bold;font-size:1rem;">🏆 View Achievements</a>
      </div>
    </div>
    <div style="background:linear-gradient(135deg,#f6d365 0%,#fda085 100%);padding:15px;text-align:center;">
      <p style="color:white;margin:0;font-size:0.85rem;">With pride &amp; joy 💛 — Fluent Feathers Academy</p>
      <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:0.75rem;">Made with ❤️ By Aaliya</p>
    </div>
  </div>
</body>
</html>`;

          await sendEmail(
            student.parent_email,
            `🎉 ${student.name} completed the challenge & earned ${badgeName}!`,
            emailHtml,
            student.parent_name,
            'Challenge Completion'
          );
        }
      } catch (emailErr) {
        console.error('Challenge completion email error:', emailErr.message);
      }
    }

    res.json({ success: true, message: 'Challenge completed!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject a challenge submission
app.put('/api/challenges/:challengeId/student/:studentId/dont-approve', async (req, res) => {
  try {
    await pool.query(`
      UPDATE student_challenges
      SET status = 'Not Approved'
      WHERE challenge_id = $1 AND student_id = $2
    `, [req.params.challengeId, req.params.studentId]);

    res.json({ success: true, message: 'Challenge submission not approved!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get challenges for a student (parent portal)
app.get('/api/students/:id/challenges', async (req, res) => {
  try {
    // Show ALL active challenges to all students, with their submission status if they have one
    const result = await pool.query(`
      SELECT c.*,
        CASE
          WHEN sc.status IN ('Completed', 'Submitted') THEN sc.status
          WHEN c.week_end < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Finished'
          ELSE 'In Progress'
        END as status,
        sc.status as student_status,
        sc.completed_at,
        sc.notes as completion_notes
      FROM weekly_challenges c
      LEFT JOIN student_challenges sc ON c.id = sc.challenge_id AND sc.student_id = $1
      WHERE c.is_active = true
      ORDER BY c.week_start DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update challenge end date
app.patch('/api/challenges/:id/extend', async (req, res) => {
  try {
    const { week_end } = req.body;
    if (!week_end) return res.status(400).json({ error: 'week_end is required' });
    const result = await pool.query(
      'UPDATE weekly_challenges SET week_end = $1 WHERE id = $2 RETURNING *',
      [week_end, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ success: true, challenge: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete challenge
app.delete('/api/challenges/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_challenges WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Challenge deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PARENT EXPECTATIONS API ====================
// Get student expectations
app.get('/api/students/:id/expectations', async (req, res) => {
  try {
    const result = await pool.query('SELECT parent_expectations FROM students WHERE id = $1', [req.params.id]);
    res.json({ expectations: result.rows[0]?.parent_expectations || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update student expectations (parent or admin)
app.put('/api/students/:id/expectations', async (req, res) => {
  const { expectations, source } = req.body;
  try {
    await pool.query('UPDATE students SET parent_expectations = $1 WHERE id = $2', [expectations, req.params.id]);
    if (source === 'parent') {
      const studentResult = await pool.query('SELECT name, parent_name FROM students WHERE id = $1', [req.params.id]);
      const student = studentResult.rows[0];
      if (student) {
        await sendAdminPushNotification(
          'Parent Expectations Submitted',
          `${student.parent_name || 'A parent'} submitted expectations for ${student.name}.`,
          { studentId: req.params.id, type: 'parent_expectations_submitted' }
        );
      }
    }
    res.json({ success: true, message: 'Expectations updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students/:id/expectations/request', async (req, res) => {
  try {
    const studentResult = await pool.query('SELECT name, parent_name, parent_email FROM students WHERE id = $1', [req.params.id]);
    const student = studentResult.rows[0];
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    if (!student.parent_email) {
      return res.status(400).json({ error: 'Parent email not available' });
    }

    const portalLink = process.env.PARENT_PORTAL_URL || `${req.protocol}://${req.get('host')}/parent.html`;
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 28px 24px; color: white; text-align: center;">
          <h1 style="margin: 0; font-size: 28px;">Parent Expectations</h1>
          <p style="margin: 10px 0 0; font-size: 15px; opacity: 0.95;">Help us understand your goals for ${escapeHtml(student.name)}.</p>
        </div>
        <div style="padding: 28px 24px;">
          <p style="font-size: 16px; color: #2d3748; margin: 0 0 16px;">Dear <strong>${escapeHtml(student.parent_name || 'Parent')}</strong>,</p>
          <p style="font-size: 15px; line-height: 1.7; color: #4a5568; margin: 0 0 14px;">
            We would love to know what you hope ${escapeHtml(student.name)} will gain from classes at Fluent Feathers Academy.
          </p>
          <p style="font-size: 15px; line-height: 1.7; color: #4a5568; margin: 0 0 22px;">
            Please open the parent portal, go to the <strong>Profile / Expectations</strong> section, scroll down, and submit your expectations there. This helps us align lessons with your goals.
          </p>
          <div style="text-align: center; margin: 26px 0;">
            <a href="${portalLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 13px 30px; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px;">
              Open Parent Portal
            </a>
          </div>
          <p style="font-size: 13px; color: #718096; margin: 0;">
            If you already have the app installed, open the parent portal, go to <strong>Profile / Expectations</strong>, scroll down, and submit the expectations there.
          </p>
        </div>
      </div>
    `;

    const sent = await sendEmail(student.parent_email, `Please share your expectations for ${student.name}`, emailHtml, student.parent_name, 'Expectation Request');
    res.json({ success: !!sent, message: sent ? 'Request email sent to parent.' : 'Unable to send the request email right now.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One-time endpoint to award retroactive class points badges
app.post('/api/admin/award-retroactive-badges', async (req, res) => {
  try {
    const students = await pool.query(`
      SELECT s.id, s.name, COALESCE(SUM(cp.points), 0) AS total_points
      FROM students s
      LEFT JOIN class_points cp ON s.id = cp.student_id
      WHERE s.is_active = true
      GROUP BY s.id, s.name
      HAVING COALESCE(SUM(cp.points), 0) > 0
    `);

    let awarded = 0;
    for (const student of students.rows) {
      const total = parseInt(student.total_points);
      if (total % 10 === 0) {
        const badgeType = `class_points_${total}`;
        const existing = await pool.query(
          'SELECT id FROM student_badges WHERE student_id = $1 AND badge_type = $2',
          [student.id, badgeType]
        );
        if (existing.rows.length === 0) {
          const badgeName = `⭐ ${total} Class Points!`;
          const badgeDesc = `Earned ${total} class points in live classes!`;
          await pool.query(`
            INSERT INTO student_badges (student_id, badge_type, badge_name, badge_description)
            VALUES ($1, $2, $3, $4)
          `, [student.id, badgeType, badgeName, badgeDesc]);
          awarded++;
        }
      }
    }

    res.json({ success: true, message: `Awarded ${awarded} retroactive badges` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/announcements', upload.single('image'), async (req, res) => {
  const { title, content, announcement_type, priority, send_email } = req.body;
  try {
    let imageUrl = null;

    // Handle image upload if present
    if (req.file) {
      // When using CloudinaryStorage, file is already uploaded and path contains the URL
      if (req.file.path) {
        imageUrl = req.file.path;
      } else if (req.file.buffer) {
        // Fallback for memory storage - upload to Cloudinary manually
        if (cloudinary) {
          const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              { folder: 'fluentfeathers/announcements', resource_type: 'image' },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(req.file.buffer);
          });
          imageUrl = result.secure_url;
        } else {
          // Save locally
          const fileName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
          const filePath = path.join(__dirname, 'public/uploads/announcements', fileName);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, req.file.buffer);
          imageUrl = '/uploads/announcements/' + fileName;
        }
      }
    }

    const result = await pool.query(`
      INSERT INTO announcements (title, content, announcement_type, priority, is_active, image_url)
      VALUES ($1, $2, $3, $4, true, $5)
      RETURNING *
    `, [title, content, announcement_type || 'General', priority || 'Normal', imageUrl]);

    const announcement = result.rows[0];
    let emailsSent = 0;

    // Send emails if requested
    if (send_email === 'true' || send_email === true) {
      const students = await pool.query(`
        SELECT DISTINCT parent_email, parent_name, name as student_name
        FROM students
        WHERE is_active = true AND parent_email IS NOT NULL
      `);

      for (const student of students.rows) {
        const emailHtml = getAnnouncementEmail({
          title,
          content,
          type: announcement_type || 'General',
          priority: priority || 'Normal',
          parentName: student.parent_name || 'Parent',
          imageUrl: imageUrl
        });

        const sent = await sendEmail(
          student.parent_email,
          `📢 ${title} - Fluent Feathers Academy`,
          emailHtml,
          student.parent_name,
          'Announcement'
        );
        if (sent) emailsSent++;
      }
    }

    res.json({
      ...announcement,
      message: (send_email === 'true' || send_email === true)
        ? `✅ Announcement created and ${emailsSent} email(s) sent!`
        : '✅ Announcement created!'
    });
  } catch (err) {
    console.error('Announcement error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Send announcement email to all active students
app.post('/api/announcements/:id/send-email', async (req, res) => {
  try {
    const announcement = await pool.query('SELECT * FROM announcements WHERE id = $1', [req.params.id]);
    if (announcement.rows.length === 0) {
      return res.status(404).json({ error: 'Announcement not found' });
    }

    const { title, content, announcement_type, priority } = announcement.rows[0];

    const students = await pool.query(`
      SELECT DISTINCT parent_email, parent_name, name as student_name
      FROM students
      WHERE is_active = true AND parent_email IS NOT NULL
    `);

    let emailsSent = 0;
    for (const student of students.rows) {
      const emailHtml = getAnnouncementEmail({
        title,
        content,
        type: announcement_type,
        priority,
        parentName: student.parent_name || 'Parent'
      });

      const sent = await sendEmail(
        student.parent_email,
        `📢 ${title} - Fluent Feathers Academy`,
        emailHtml,
        student.parent_name,
        'Announcement'
      );
      if (sent) emailsSent++;
    }

    res.json({ message: `✅ ${emailsSent} email(s) sent successfully!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/announcements/:id', upload.single('image'), async (req, res) => {
  const { title, content, announcement_type, priority, remove_image } = req.body;
  try {
    let imageUrl = undefined; // undefined means don't update

    // Handle image upload if present
    if (req.file) {
      // When using CloudinaryStorage, file is already uploaded and path contains the URL
      if (req.file.path) {
        imageUrl = req.file.path;
      } else if (req.file.buffer) {
        // Fallback for memory storage
        if (cloudinary) {
          const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
              { folder: 'fluentfeathers/announcements', resource_type: 'image' },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            ).end(req.file.buffer);
          });
          imageUrl = result.secure_url;
        } else {
          const fileName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
          const filePath = path.join(__dirname, 'public/uploads/announcements', fileName);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, req.file.buffer);
          imageUrl = '/uploads/announcements/' + fileName;
        }
      }
    } else if (remove_image === 'true') {
      imageUrl = null; // Remove existing image
    }

    let query, params;
    if (imageUrl !== undefined) {
      query = `UPDATE announcements SET title = $1, content = $2, announcement_type = $3, priority = $4, image_url = $5 WHERE id = $6 RETURNING *`;
      params = [title, content, announcement_type, priority, imageUrl, req.params.id];
    } else {
      query = `UPDATE announcements SET title = $1, content = $2, announcement_type = $3, priority = $4 WHERE id = $5 RETURNING *`;
      params = [title, content, announcement_type, priority, req.params.id];
    }

    const result = await pool.query(query, params);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update announcement error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/announcements/:id', async (req, res) => {
  try {
    await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CERTIFICATES API ====================
app.get('/api/certificates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, s.name as student_name, s.parent_email, s.parent_name
      FROM student_certificates c
      JOIN students s ON c.student_id = s.id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/certificates', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM student_certificates
      WHERE student_id = $1
      ORDER BY year DESC, month DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/certificates', async (req, res) => {
  const { student_id, certificate_type, award_title, month, year, description, send_email } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO student_certificates (student_id, certificate_type, award_title, month, year, description)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [student_id, certificate_type, award_title, month, year, description]);

    // Send email if requested
    if (send_email) {
      const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
      if (student.rows[0]) {
        const certificateEmailHTML = getCertificateEmail({
          studentName: student.rows[0].name,
          awardTitle: award_title,
          month: month,
          year: year,
          description: description
        });

        await sendEmail(
          student.rows[0].parent_email,
          `🏆 Certificate of Achievement - ${award_title}`,
          certificateEmailHTML,
          student.rows[0].parent_name,
          'Certificate'
        );
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/certificates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM student_certificates WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== MONTHLY ASSESSMENTS API ====================
// Monthly assessment dashboard — all active students with current-month status
app.get('/api/assessments/monthly-dashboard', async (req, res) => {
  const now = new Date();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const year = parseInt(req.query.year) || now.getFullYear();
  try {
    // All active students + their completed session count for this month
    const studentsResult = await pool.query(`
      SELECT s.id, s.name, s.parent_email,
             COUNT(CASE WHEN sess.session_date >= $1::date
                         AND sess.session_date < ($1::date + INTERVAL '1 month')
                         AND sess.status = 'Completed' THEN 1 END) as sessions_this_month
      FROM students s
      LEFT JOIN sessions sess ON sess.student_id = s.id
      WHERE s.is_active = true
      GROUP BY s.id, s.name, s.parent_email
      ORDER BY s.name
    `, [`${year}-${String(month).padStart(2,'0')}-01`]);

    const assessmentsResult = await pool.query(
      `SELECT id, student_id, deferred, certificate_title, created_at
       FROM monthly_assessments
       WHERE month = $1 AND year = $2 AND assessment_type = 'monthly'`,
      [month, year]
    );
    const assessmentMap = {};
    assessmentsResult.rows.forEach(a => { assessmentMap[a.student_id] = a; });

    const dashboard = studentsResult.rows.map(s => {
      const a = assessmentMap[s.id];
      let status;
      if (a) { status = a.deferred ? 'deferred' : 'completed'; }
      else { status = parseInt(s.sessions_this_month) >= 4 ? 'due' : 'pending'; }
      return {
        id: s.id, name: s.name, parent_email: s.parent_email,
        sessions_this_month: parseInt(s.sessions_this_month) || 0,
        status, assessment_id: a?.id || null, certificate_title: a?.certificate_title || null
      };
    });
    res.json({ month, year, students: dashboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Defer a student's assessment to next month
app.post('/api/assessments/defer-student', async (req, res) => {
  const { student_id, month, year } = req.body;
  try {
    const existing = await pool.query(
      'SELECT id FROM monthly_assessments WHERE student_id = $1 AND month = $2 AND year = $3 AND assessment_type = $4',
      [student_id, month, year, 'monthly']
    );
    if (existing.rows.length > 0) {
      await pool.query('UPDATE monthly_assessments SET deferred = TRUE WHERE id = $1', [existing.rows[0].id]);
    } else {
      await pool.query(
        'INSERT INTO monthly_assessments (student_id, month, year, assessment_type, deferred) VALUES ($1, $2, $3, $4, TRUE)',
        [student_id, month, year, 'monthly']
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Un-defer a student's assessment
app.post('/api/assessments/undefe-student', async (req, res) => {
  const { student_id, month, year } = req.body;
  try {
    await pool.query(
      'UPDATE monthly_assessments SET deferred = FALSE WHERE student_id = $1 AND month = $2 AND year = $3 AND assessment_type = $4',
      [student_id, month, year, 'monthly']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assessments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             s.name as student_name,
             d.child_name as demo_child_name,
             d.demo_date as demo_date,
             d.parent_email as demo_parent_email
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      ORDER BY a.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/assessments/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
             s.name as student_name,
             d.child_name as demo_child_name,
             d.demo_date as demo_date,
             d.parent_email as demo_parent_email,
             d.parent_name as demo_parent_name
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      WHERE a.id = $1
    `, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint for viewing demo assessment certificates (no auth required)
app.get('/api/demo-assessment/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.assessment_type, a.skills, a.certificate_title,
             a.performance_summary, a.areas_of_improvement, a.teacher_comments, a.created_at,
             COALESCE(d.child_name, s.name) as demo_child_name,
             COALESCE(d.demo_date, a.created_at::date) as demo_date
      FROM monthly_assessments a
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      LEFT JOIN students s ON a.student_id = s.id
      WHERE a.id = $1 AND a.assessment_type = 'demo'
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Demo assessment not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public endpoint for viewing monthly assessment certificates (no auth required)
app.get('/api/monthly-assessment/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.assessment_type, a.month, a.year, a.skills, a.certificate_title,
             a.performance_summary, a.areas_of_improvement, a.teacher_comments, a.created_at,
             s.name as student_name
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      WHERE a.id = $1 AND a.assessment_type = 'monthly'
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Monthly assessment not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id/assessments', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH current_student AS (
        SELECT id, parent_email, name
        FROM students
        WHERE id = $1
      )
      SELECT
        a.*,
        s.name as student_name,
        d.child_name as demo_child_name,
        d.parent_email as demo_parent_email,
        d.parent_name as demo_parent_name,
        d.demo_date as demo_date,
        CASE
          WHEN a.assessment_type = 'monthly' THEN 'monthly'
          WHEN a.certificate_title IN ('Student of the Week', 'Student of the Month', 'Student of the Year') THEN 'award'
          ELSE 'demo'
        END as portal_item_type,
        CASE
          WHEN a.assessment_type = 'monthly' THEN 'monthly'
          ELSE 'demo'
        END as certificate_page_type,
        COALESCE(a.year, EXTRACT(YEAR FROM a.created_at)::int) as period_year,
        COALESCE(a.month, EXTRACT(MONTH FROM a.created_at)::int) as period_month
      FROM monthly_assessments a
      LEFT JOIN students s ON a.student_id = s.id
      LEFT JOIN demo_leads d ON a.demo_lead_id = d.id
      CROSS JOIN current_student cs
      WHERE (
          a.student_id = cs.id
          OR (
            a.assessment_type = 'demo'
            AND a.demo_lead_id IS NOT NULL
            AND cs.parent_email IS NOT NULL
            AND LOWER(COALESCE(d.parent_email, '')) = LOWER(cs.parent_email)
          )
        )
        AND (a.assessment_type <> 'monthly' OR a.deferred IS NULL OR a.deferred = FALSE)
      ORDER BY
        COALESCE(a.year, EXTRACT(YEAR FROM a.created_at)::int) DESC,
        COALESCE(a.month, EXTRACT(MONTH FROM a.created_at)::int) DESC,
        a.created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/merge-matching-sessions', async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = req.params.groupId;
    const group = (await client.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    await client.query('BEGIN');

    const rows = (await client.query(`
      SELECT s.id as session_id, s.student_id, s.session_date, s.session_time, s.session_number, s.status, s.class_link,
             st.name as student_name
      FROM sessions s
      INNER JOIN students st ON st.id = s.student_id
      WHERE st.group_id = $1
        AND st.is_active = true
        AND s.session_type = 'Private'
        AND s.group_id IS NULL
        AND s.status IN ('Pending', 'Scheduled')
      ORDER BY s.session_date, s.session_time, st.name
    `, [groupId])).rows;

    const grouped = new Map();
    for (const row of rows) {
      const key = `${row.session_date}|${row.session_time}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    const sessionCountResult = await client.query('SELECT COUNT(*) as count FROM sessions WHERE group_id = $1', [groupId]);
    let nextSessionNumber = parseInt(sessionCountResult.rows[0].count || 0, 10) + 1;
    let mergedSlots = 0;
    let mergedStudents = 0;
    const affectedStudents = new Set();

    for (const slotRows of grouped.values()) {
      if (slotRows.length < 2) continue;

      const { session_date, session_time } = slotRows[0];
      let groupSession = (await client.query(`
        SELECT id
        FROM sessions
        WHERE group_id = $1
          AND session_type = 'Group'
          AND session_date = $2
          AND session_time = $3
        LIMIT 1
      `, [groupId, session_date, session_time])).rows[0];

      if (!groupSession) {
        groupSession = (await client.query(`
          INSERT INTO sessions (group_id, session_type, session_number, session_date, session_time, class_link, status)
          VALUES ($1, 'Group', $2, $3, $4, $5, 'Pending')
          RETURNING id
        `, [groupId, nextSessionNumber, session_date, session_time, slotRows[0].class_link || DEFAULT_CLASS])).rows[0];
        nextSessionNumber++;
      }

      for (const row of slotRows) {
        await client.query(`
          UPDATE materials
          SET session_id = $1, group_id = $2
          WHERE session_id = $3 AND student_id = $4
        `, [groupSession.id, groupId, row.session_id, row.student_id]);

        await client.query(`
          UPDATE session_materials
          SET session_id = $1
          WHERE session_id = $2
        `, [groupSession.id, row.session_id]);

        await client.query(`
          INSERT INTO session_attendance (session_id, student_id, attendance)
          VALUES ($1, $2, 'Pending')
          ON CONFLICT (session_id, student_id)
          DO UPDATE SET attendance = EXCLUDED.attendance
        `, [groupSession.id, row.student_id]);

        await client.query('DELETE FROM sessions WHERE id = $1', [row.session_id]);
        affectedStudents.add(String(row.student_id));
        mergedStudents++;
      }

      mergedSlots++;
    }

    await client.query('COMMIT');

    affectedStudents.forEach(id => clearStudentSessionsCache(id));
    clearAdminDashboardCache();

    res.json({
      success: true,
      mergedSlots,
      mergedStudents,
      message: mergedSlots > 0
        ? `Merged ${mergedSlots} matching slot${mergedSlots > 1 ? 's' : ''} into group classes for ${mergedStudents} student session${mergedStudents > 1 ? 's' : ''}`
        : 'No matching private sessions found to merge'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/assessments', async (req, res) => {
  const { assessment_type, student_id, demo_lead_id, month, year, skills, skill_ratings, certificate_title, performance_summary, areas_of_improvement, teacher_comments, send_email } = req.body;

  try {
    const isDemo = assessment_type === 'demo';
    let result;

    if (isDemo) {
      // Demo assessment - linked to demo_lead
      result = await pool.query(`
        INSERT INTO monthly_assessments (demo_lead_id, assessment_type, skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [demo_lead_id, 'demo', skills, certificate_title, performance_summary, areas_of_improvement, teacher_comments]);

      // Send demo assessment email if requested
      if (send_email) {
        const lead = await pool.query('SELECT child_name, child_grade, parent_email, parent_name, demo_date FROM demo_leads WHERE id = $1', [demo_lead_id]);
        if (lead.rows[0] && lead.rows[0].parent_email) {
          let skillsArray = [];
          try { if (skills) skillsArray = JSON.parse(skills); } catch(e) { console.error('Invalid skills JSON:', e.message); }
          const demoEmailHTML = getDemoAssessmentEmail({
            assessmentId: result.rows[0].id,
            childName: lead.rows[0].child_name,
            childGrade: lead.rows[0].child_grade,
            demoDate: lead.rows[0].demo_date,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          await sendEmail(
            lead.rows[0].parent_email,
            `🎯 Demo Class Assessment Report - ${lead.rows[0].child_name}`,
            demoEmailHTML,
            lead.rows[0].parent_name,
            'Demo Assessment'
          );

        }
      }
    } else {
      // Monthly assessment - linked to student
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const today = new Date();
      const day = today.getDate();
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const allowedMonth = prev.getMonth() + 1;
      const allowedYear = prev.getFullYear();

      if (day < 1 || day > 10) {
        return res.status(400).json({ error: 'Monthly assessments can only be filled between the 1st and 10th of the next month for the previous month.' });
      }
      if (month !== allowedMonth || year !== allowedYear) {
        return res.status(400).json({ error: `Monthly assessment must be for ${monthNames[allowedMonth - 1]} ${allowedYear} during this window.` });
      }

      result = await pool.query(`
        INSERT INTO monthly_assessments (student_id, assessment_type, month, year, skills, skill_ratings, certificate_title, performance_summary, areas_of_improvement, teacher_comments)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [student_id, 'monthly', month, year, skills, skill_ratings ? JSON.stringify(skill_ratings) : null, certificate_title, performance_summary, areas_of_improvement || '', teacher_comments || '']);

      // Send email if requested
      if (send_email) {
        const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
        if (student.rows[0]) {
          let skillsArray = [];
          try { if (skills) skillsArray = JSON.parse(skills); } catch(e) { console.error('Invalid skills JSON:', e.message); }
          const reportCardEmailHTML = getMonthlyReportCardEmail({
            assessmentId: result.rows[0].id,
            studentName: student.rows[0].name,
            month: month,
            year: year,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
          await sendEmail(
            student.rows[0].parent_email,
            `📊 Monthly Progress Report - ${monthNames[month - 1]} ${year}`,
            reportCardEmailHTML,
            student.rows[0].parent_name,
            'Report Card'
          );

        }
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Assessment creation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual Google review request for demo lead parents
app.post('/api/demo-leads/:id/ask-review', async (req, res) => {
  try {
    const lead = await pool.query('SELECT child_name, parent_email, parent_name FROM demo_leads WHERE id = $1', [req.params.id]);
    if (lead.rows.length === 0) return res.status(404).json({ error: 'Demo lead not found' });
    const { child_name, parent_email, parent_name } = lead.rows[0];
    if (!parent_email) return res.status(400).json({ error: 'No parent email found' });
    const reviewHTML = getGoogleReviewEmail(child_name, true);
    await sendEmail(parent_email, `⭐ How was ${child_name}'s demo class? Share your feedback!`, reviewHTML, parent_name, 'Google Review Request');
    res.json({ success: true });
  } catch (err) {
    console.error('Demo review request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual follow-up email for demo leads
app.post('/api/demo-leads/:id/send-followup', async (req, res) => {
  try {
    const { followup_type } = req.body; // '24hr', '3day', or '7day'
    const lead = await pool.query('SELECT * FROM demo_leads WHERE id = $1', [req.params.id]);
    if (lead.rows.length === 0) return res.status(404).json({ error: 'Demo lead not found' });

    const l = lead.rows[0];
    if (!l.parent_email) return res.status(400).json({ error: 'No parent email found' });

    const emailData = { parentName: l.parent_name, childName: l.child_name, programInterest: l.program_interest };

    let emailHTML, subject, emailType;
    if (followup_type === '3day') {
      emailHTML = getDemoFollowUp3DayEmail(emailData);
      subject = `🌟 We'd love to have ${l.child_name} back! [DLID:${l.id}]`;
      emailType = 'Demo-FollowUp-3Day';
    } else if (followup_type === '7day') {
      emailHTML = getDemoFollowUp7DayEmail(emailData);
      subject = `🎓 ${l.child_name}'s spot is waiting! [DLID:${l.id}]`;
      emailType = 'Demo-FollowUp-7Day';
    } else {
      emailHTML = getDemoFollowUp24hrEmail(emailData);
      subject = `💜 Thank you for the demo class, ${l.parent_name}! [DLID:${l.id}]`;
      emailType = 'Demo-FollowUp-24hr';
    }

    await sendEmail(l.parent_email, subject, emailHTML, l.parent_name, emailType);

    // Append note to demo lead
    const existingNotes = l.notes || '';
    const newNote = existingNotes + '\n[' + new Date().toLocaleDateString() + '] Sent follow-up: ' + (followup_type || '24hr');
    await pool.query('UPDATE demo_leads SET notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newNote, l.id]);

    res.json({ success: true, message: `Follow-up email sent to ${l.parent_email}` });
  } catch (err) {
    console.error('Demo follow-up error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get follow-up status for a demo lead (which emails have been sent)
app.get('/api/demo-leads/:id/followup-status', async (req, res) => {
  try {
    const logs = await pool.query(
      `SELECT email_type, sent_at FROM email_log WHERE subject LIKE $1 AND email_type LIKE 'Demo-FollowUp%' ORDER BY sent_at`,
      [`%[DLID:${req.params.id}]%`]
    );
    res.json({
      sent_24hr: logs.rows.some(r => r.email_type === 'Demo-FollowUp-24hr'),
      sent_3day: logs.rows.some(r => r.email_type === 'Demo-FollowUp-3Day'),
      sent_7day: logs.rows.some(r => r.email_type === 'Demo-FollowUp-7Day'),
      logs: logs.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual Google review request for enrolled student parents
app.post('/api/students/:id/ask-review', async (req, res) => {
  try {
    const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [req.params.id]);
    if (student.rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const { name, parent_email, parent_name } = student.rows[0];
    if (!parent_email) return res.status(400).json({ error: 'No parent email found' });
    const reviewHTML = getGoogleReviewEmail(name, false);
    await sendEmail(parent_email, `⭐ Loving ${name}'s progress? Share your experience!`, reviewHTML, parent_name, 'Google Review Request');
    res.json({ success: true });
  } catch (err) {
    console.error('Student review request error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/assessments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM monthly_assessments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== RESOURCE LIBRARY ====================

// Get all resources (admin)
app.get('/api/resources', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM resource_library ORDER BY is_featured DESC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active resources for parents (filtered by category/grade)
app.get('/api/resources/library', async (req, res) => {
  try {
    const { category, grade } = req.query;
    let query = 'SELECT * FROM resource_library WHERE is_active = true';
    const params = [];

    if (category && category !== 'all') {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    if (grade && grade !== 'all') {
      params.push(grade);
      query += ` AND (grade_level = $${params.length} OR grade_level = 'All Grades' OR grade_level IS NULL)`;
    }

    query += ' ORDER BY is_featured DESC, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get resource categories
app.get('/api/resources/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT category FROM resource_library WHERE is_active = true ORDER BY category');
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new resource
app.post('/api/resources', async (req, res) => {
  const { title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO resource_library (title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, description, category, resource_type, file_path || null, external_link || null, thumbnail_url || null, grade_level || 'All Grades', tags || null, is_featured || false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a resource
app.put('/api/resources/:id', async (req, res) => {
  const { title, description, category, resource_type, file_path, external_link, thumbnail_url, grade_level, tags, is_featured, is_active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE resource_library SET
        title = $1, description = $2, category = $3, resource_type = $4,
        file_path = $5, external_link = $6, thumbnail_url = $7,
        grade_level = $8, tags = $9, is_featured = $10, is_active = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $12 RETURNING *`,
      [title, description, category, resource_type, file_path || null, external_link || null, thumbnail_url || null, grade_level, tags || null, is_featured || false, is_active !== false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Increment view count
app.post('/api/resources/:id/view', async (req, res) => {
  try {
    await pool.query('UPDATE resource_library SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a resource
app.delete('/api/resources/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM resource_library WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload resource file
app.post('/api/resources/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message || 'File upload failed' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    let filePath;
    if (req.file.path && (req.file.path.includes('cloudinary') || req.file.path.includes('res.cloudinary.com'))) {
      filePath = req.file.path;
    } else if (req.file.filename) {
      filePath = '/uploads/materials/' + req.file.filename;
    } else {
      filePath = req.file.path;
    }
    console.log('Resource uploaded:', filePath);
    res.json({ filePath, fileName: req.file.originalname });
  } catch (err) {
    console.error('Resource upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== MANUAL REMINDER TRIGGER ====================
// Endpoint to manually trigger reminder check (useful for testing or if cron misses)
app.post('/api/admin/trigger-reminders', async (req, res) => {
  try {
    console.log('🔔 Manual reminder check triggered');
    await checkAndSendReminders();
    res.json({ success: true, message: 'Reminder check completed. Check server logs for details.' });
  } catch (err) {
    console.error('Error in manual reminder trigger:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/assessments/:id', async (req, res) => {
  const { assessment_type, student_id, demo_lead_id, month, year, skills, skill_ratings, certificate_title, performance_summary, areas_of_improvement, teacher_comments, send_email } = req.body;

  try {
    const existingResult = await pool.query('SELECT * FROM monthly_assessments WHERE id = $1', [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) {
      return res.status(404).json({ error: 'Assessment not found' });
    }

    const isDemo = assessment_type === 'demo';
    let result;

    if (isDemo) {
      result = await pool.query(`
        UPDATE monthly_assessments
        SET demo_lead_id = $1,
            student_id = NULL,
            assessment_type = 'demo',
            month = NULL,
            year = NULL,
            skills = $2,
            skill_ratings = $3,
            certificate_title = $4,
            performance_summary = $5,
            areas_of_improvement = $6,
            teacher_comments = $7,
            deferred = FALSE
        WHERE id = $8
        RETURNING *
      `, [
        demo_lead_id,
        skills,
        skill_ratings ? JSON.stringify(skill_ratings) : null,
        certificate_title,
        performance_summary,
        areas_of_improvement || '',
        teacher_comments || '',
        req.params.id
      ]);

      if (send_email) {
        const lead = await pool.query('SELECT child_name, child_grade, parent_email, parent_name, demo_date FROM demo_leads WHERE id = $1', [demo_lead_id]);
        if (lead.rows[0] && lead.rows[0].parent_email) {
          let skillsArray = [];
          try { if (skills) skillsArray = JSON.parse(skills); } catch (e) { console.error('Invalid skills JSON:', e.message); }
          const demoEmailHTML = getDemoAssessmentEmail({
            assessmentId: result.rows[0].id,
            childName: lead.rows[0].child_name,
            childGrade: lead.rows[0].child_grade,
            demoDate: lead.rows[0].demo_date,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          await sendEmail(
            lead.rows[0].parent_email,
            `🎯 Demo Class Assessment Report - ${lead.rows[0].child_name}`,
            demoEmailHTML,
            lead.rows[0].parent_name,
            'Demo Assessment'
          );
        }
      }
    } else {
      result = await pool.query(`
        UPDATE monthly_assessments
        SET student_id = $1,
            demo_lead_id = NULL,
            assessment_type = 'monthly',
            month = $2,
            year = $3,
            skills = $4,
            skill_ratings = $5,
            certificate_title = $6,
            performance_summary = $7,
            areas_of_improvement = $8,
            teacher_comments = $9,
            deferred = FALSE
        WHERE id = $10
        RETURNING *
      `, [
        student_id,
        month,
        year,
        skills,
        skill_ratings ? JSON.stringify(skill_ratings) : null,
        certificate_title,
        performance_summary,
        areas_of_improvement || '',
        teacher_comments || '',
        req.params.id
      ]);

      if (send_email) {
        const student = await pool.query('SELECT name, parent_email, parent_name FROM students WHERE id = $1', [student_id]);
        if (student.rows[0]) {
          let skillsArray = [];
          try { if (skills) skillsArray = JSON.parse(skills); } catch (e) { console.error('Invalid skills JSON:', e.message); }
          const reportCardEmailHTML = getMonthlyReportCardEmail({
            assessmentId: result.rows[0].id,
            studentName: student.rows[0].name,
            month: month,
            year: year,
            skills: skillsArray,
            certificateTitle: certificate_title,
            performanceSummary: performance_summary,
            areasOfImprovement: areas_of_improvement,
            teacherComments: teacher_comments
          });

          const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
          await sendEmail(
            student.rows[0].parent_email,
            `📊 Monthly Progress Report - ${monthNames[month - 1]} ${year}`,
            reportCardEmailHTML,
            student.rows[0].parent_name,
            'Report Card'
          );
        }
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Assessment update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint: inspect push token readiness for parents/admins
app.post('/api/admin/push-token-status', async (req, res) => {
  const { pass, email } = req.body || {};
  if (pass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await ensurePushTokenTables();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const filterEnabled = normalizedEmail.length > 0;

    const parentTokenSummary = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_tokens,
        COUNT(DISTINCT LOWER(parent_email))::int AS unique_parent_emails,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '30 days')::int AS tokens_updated_last_30d,
        MAX(updated_at) AS latest_parent_token_update
      FROM parent_fcm_tokens
      WHERE ($1 = '' OR LOWER(parent_email) = $1)
      `,
      [normalizedEmail]
    );

    const perParentRows = await pool.query(
      `
      SELECT
        LOWER(parent_email) AS parent_email,
        COUNT(*)::int AS token_count,
        MAX(updated_at) AS latest_token_update
      FROM parent_fcm_tokens
      WHERE ($1 = '' OR LOWER(parent_email) = $1)
      GROUP BY LOWER(parent_email)
      ORDER BY latest_token_update DESC NULLS LAST, parent_email ASC
      `,
      [normalizedEmail]
    );

    const adminTokenSummary = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_tokens,
        COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '30 days')::int AS tokens_updated_last_30d,
        MAX(updated_at) AS latest_admin_token_update
      FROM admin_fcm_tokens
      `
    );

    res.json({
      success: true,
      filter: {
        email: filterEnabled ? normalizedEmail : null
      },
      parent_tokens: parentTokenSummary.rows[0] || {
        total_tokens: 0,
        unique_parent_emails: 0,
        tokens_updated_last_30d: 0,
        latest_parent_token_update: null
      },
      per_parent: perParentRows.rows || [],
      admin_tokens: adminTokenSummary.rows[0] || {
        total_tokens: 0,
        tokens_updated_last_30d: 0,
        latest_admin_token_update: null
      }
    });
  } catch (err) {
    console.error('Push token status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch push token status' });
  }
});

// Debug endpoint: send a test push notification to all admin tokens
app.post('/api/admin/test-push', async (req, res) => {
  const { pass, title, body } = req.body || {};
  if (pass !== (process.env.ADMIN_PASSWORD || 'admin123')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await ensurePushTokenTables();
    const tokenCountResult = await pool.query('SELECT COUNT(*)::int AS count FROM admin_fcm_tokens');
    const tokenCount = tokenCountResult.rows[0]?.count || 0;
    const sent = await sendAdminPushNotification(
      String(title || 'Fluent Feathers Admin Test'),
      String(body || 'If you see this, admin push is working.'),
      { type: 'admin_test_push', url: `${(process.env.APP_URL || '').replace(/\/$/, '') || 'https://fluent-feathers-academy-lms.onrender.com'}/admin.html` }
    );
    res.json({
      success: true,
      sent: !!sent,
      token_count: tokenCount,
      firebase_admin_configured: !!getFirebaseAdminMessaging(),
      legacy_server_key_configured: !!process.env.FIREBASE_SERVER_KEY
    });
  } catch (err) {
    console.error('Admin test push error:', err.message);
    res.status(500).json({ error: 'Failed to send admin test push' });
  }
});

// Bulk sync parent timezones for existing records
// Usage:
// POST /api/admin/sync-parent-timezones
// Body (optional): { overrides: [{ email: "parent@example.com", timezone: "Asia/Muscat" }] }
app.post('/api/admin/sync-parent-timezones', async (req, res) => {
  const client = await pool.connect();
  try {
    const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];

    await client.query('BEGIN');

    let studentsAutoUpdated = 0;
    let demoLeadsAutoUpdated = 0;
    let eventsAutoUpdated = 0;
    let overrideUpdates = 0;

    // 1) Auto-fix student parent timezone from parent_credentials.timezone first, then student timezone
    const autoStudentsFromCredentials = await client.query(`
      UPDATE students s
      SET parent_timezone = pc.timezone
      FROM parent_credentials pc
      WHERE s.parent_email IS NOT NULL
        AND LOWER(s.parent_email) = LOWER(pc.parent_email)
        AND pc.timezone IS NOT NULL
        AND pc.timezone <> ''
        AND COALESCE(NULLIF(s.parent_timezone, ''), 'Asia/Kolkata') = 'Asia/Kolkata'
    `);

    // 1b) Fallback auto-fix from student timezone where parent tz is missing/IST
    const autoStudents = await client.query(`
      UPDATE students
      SET parent_timezone = COALESCE(NULLIF(timezone, ''), parent_timezone, 'Asia/Kolkata')
      WHERE parent_email IS NOT NULL
        AND COALESCE(NULLIF(parent_timezone, ''), 'Asia/Kolkata') = 'Asia/Kolkata'
        AND COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata') <> 'Asia/Kolkata'
    `);
    studentsAutoUpdated = (autoStudentsFromCredentials.rowCount || 0) + (autoStudents.rowCount || 0);

    // 2) Legacy backfill: derive best timezone per parent email from all historical tables
    const legacyBackfill = await client.query(`
      WITH tz_candidates AS (
        SELECT LOWER(parent_email) AS email_key, timezone AS tz, 1 AS priority
        FROM parent_credentials
        WHERE parent_email IS NOT NULL AND timezone IS NOT NULL AND timezone <> ''

        UNION ALL

        SELECT LOWER(parent_email) AS email_key, parent_timezone AS tz, 2 AS priority
        FROM students
        WHERE parent_email IS NOT NULL AND parent_timezone IS NOT NULL AND parent_timezone <> ''

        UNION ALL

        SELECT LOWER(parent_email) AS email_key, timezone AS tz, 3 AS priority
        FROM students
        WHERE parent_email IS NOT NULL AND timezone IS NOT NULL AND timezone <> ''

        UNION ALL

        SELECT LOWER(parent_email) AS email_key, parent_timezone AS tz, 4 AS priority
        FROM demo_leads
        WHERE parent_email IS NOT NULL AND parent_timezone IS NOT NULL AND parent_timezone <> ''

        UNION ALL

        SELECT LOWER(parent_email) AS email_key, student_timezone AS tz, 5 AS priority
        FROM demo_leads
        WHERE parent_email IS NOT NULL AND student_timezone IS NOT NULL AND student_timezone <> ''

        UNION ALL

        SELECT LOWER(email) AS email_key, parent_timezone AS tz, 6 AS priority
        FROM event_registrations
        WHERE email IS NOT NULL AND parent_timezone IS NOT NULL AND parent_timezone <> ''
      ),
      best AS (
        SELECT DISTINCT ON (email_key)
          email_key,
          tz
        FROM tz_candidates
        ORDER BY email_key,
          CASE WHEN tz IN ('Asia/Kolkata', 'IST') THEN 1 ELSE 0 END,
          priority
      )
      UPDATE students s
      SET parent_timezone = b.tz
      FROM best b
      WHERE s.parent_email IS NOT NULL
        AND LOWER(s.parent_email) = b.email_key
        AND COALESCE(NULLIF(s.parent_timezone, ''), 'Asia/Kolkata') <> b.tz
    `);
    studentsAutoUpdated += (legacyBackfill.rowCount || 0);

    // 3) Ensure no student has empty/null parent timezone
    await client.query(`
      UPDATE students
      SET parent_timezone = COALESCE(NULLIF(parent_timezone, ''), NULLIF(timezone, ''), 'Asia/Kolkata')
      WHERE parent_email IS NOT NULL
        AND (parent_timezone IS NULL OR parent_timezone = '')
    `);

    // 4) Propagate parent timezone to demo leads by parent email
    const demoSync = await client.query(`
      UPDATE demo_leads d
      SET parent_timezone = s.parent_timezone
      FROM (
        SELECT DISTINCT ON (LOWER(parent_email)) LOWER(parent_email) AS email_key, parent_timezone
        FROM students
        WHERE parent_email IS NOT NULL
          AND parent_timezone IS NOT NULL
          AND parent_timezone <> ''
          ORDER BY LOWER(parent_email), created_at DESC
      ) s
      WHERE d.parent_email IS NOT NULL
        AND LOWER(d.parent_email) = s.email_key
        AND COALESCE(d.parent_timezone, '') <> COALESCE(s.parent_timezone, '')
    `);
    demoLeadsAutoUpdated = demoSync.rowCount || 0;

    // 5) Propagate parent timezone to event registrations by email
    const eventSync = await client.query(`
      UPDATE event_registrations er
      SET parent_timezone = s.parent_timezone
      FROM (
        SELECT DISTINCT ON (LOWER(parent_email)) LOWER(parent_email) AS email_key, parent_timezone
        FROM students
        WHERE parent_email IS NOT NULL
          AND parent_timezone IS NOT NULL
          AND parent_timezone <> ''
          ORDER BY LOWER(parent_email), created_at DESC
      ) s
      WHERE er.email IS NOT NULL
        AND LOWER(er.email) = s.email_key
        AND COALESCE(er.parent_timezone, '') <> COALESCE(s.parent_timezone, '')
    `);
    eventsAutoUpdated = eventSync.rowCount || 0;

    // 6) Optional explicit overrides (highest priority)
    for (const entry of overrides) {
      const email = (entry?.email || '').toString().trim().toLowerCase();
      const timezone = normalizeTimezone(entry?.timezone);
      if (!email || !timezone) continue;

      const s1 = await client.query(
        `UPDATE students SET parent_timezone = $2 WHERE LOWER(parent_email) = $1`,
        [email, timezone]
      );
      const s2 = await client.query(
        `UPDATE demo_leads SET parent_timezone = $2 WHERE LOWER(parent_email) = $1`,
        [email, timezone]
      );
      const s3 = await client.query(
        `UPDATE event_registrations SET parent_timezone = $2 WHERE LOWER(email) = $1`,
        [email, timezone]
      );
      overrideUpdates += (s1.rowCount || 0) + (s2.rowCount || 0) + (s3.rowCount || 0);
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Parent timezone sync completed',
      summary: {
        studentsAutoUpdated,
        demoLeadsAutoUpdated,
        eventsAutoUpdated,
        overrideUpdates,
        totalTouched: studentsAutoUpdated + demoLeadsAutoUpdated + eventsAutoUpdated + overrideUpdates,
        overridesReceived: overrides.length
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk timezone sync error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// Audit parents that may still be using fallback timezone values
// Usage: GET /api/admin/timezone-fallback-audit?limit=200
app.get('/api/admin/timezone-fallback-audit', async (req, res) => {
  try {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 1000) : 200;

    const summaryResult = await pool.query(`
      WITH latest_per_parent AS (
        SELECT DISTINCT ON (LOWER(parent_email))
          LOWER(parent_email) AS email_key,
          parent_email,
          parent_name,
          parent_timezone,
          timezone,
          name,
          created_at
        FROM students
        WHERE parent_email IS NOT NULL
          AND parent_email <> ''
        ORDER BY LOWER(parent_email), created_at DESC
      )
      SELECT
        COUNT(*) AS total_parents,
        COUNT(*) FILTER (WHERE parent_timezone IS NULL OR parent_timezone = '') AS missing_parent_timezone,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(parent_timezone, ''), 'Asia/Kolkata') IN ('Asia/Kolkata', 'IST')) AS default_ist_parent_timezone,
        COUNT(*) FILTER (
          WHERE (parent_timezone IS NULL OR parent_timezone = '')
             OR COALESCE(NULLIF(parent_timezone, ''), 'Asia/Kolkata') IN ('Asia/Kolkata', 'IST')
        ) AS likely_fallback_count
      FROM latest_per_parent
    `);

    const rowsResult = await pool.query(`
      WITH latest_per_parent AS (
        SELECT DISTINCT ON (LOWER(parent_email))
          LOWER(parent_email) AS email_key,
          parent_email,
          parent_name,
          name AS student_name,
          parent_timezone,
          timezone AS student_timezone,
          created_at
        FROM students
        WHERE parent_email IS NOT NULL
          AND parent_email <> ''
        ORDER BY LOWER(parent_email), created_at DESC
      )
      SELECT
        parent_email,
        parent_name,
        student_name,
        COALESCE(NULLIF(parent_timezone, ''), 'Asia/Kolkata') AS effective_parent_timezone,
        COALESCE(NULLIF(student_timezone, ''), 'Asia/Kolkata') AS student_timezone,
        CASE
          WHEN parent_timezone IS NULL OR parent_timezone = '' THEN 'missing_parent_timezone'
          WHEN parent_timezone IN ('Asia/Kolkata', 'IST') THEN 'default_ist_parent_timezone'
          ELSE 'ok'
        END AS issue_type,
        created_at
      FROM latest_per_parent
      WHERE (parent_timezone IS NULL OR parent_timezone = '')
         OR parent_timezone IN ('Asia/Kolkata', 'IST')
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    const summary = summaryResult.rows[0] || {};
    res.json({
      success: true,
      summary: {
        total_parents: parseInt(summary.total_parents || 0, 10),
        missing_parent_timezone: parseInt(summary.missing_parent_timezone || 0, 10),
        default_ist_parent_timezone: parseInt(summary.default_ist_parent_timezone || 0, 10),
        likely_fallback_count: parseInt(summary.likely_fallback_count || 0, 10),
        sample_limit: limit
      },
      rows: rowsResult.rows
    });
  } catch (err) {
    console.error('Timezone fallback audit error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to manually reconnect database (useful after cold starts)
app.post('/api/admin/reconnect-db', async (req, res) => {
  try {
    console.log('🔄 Manual database reconnection triggered');
    dbReady = false;

    // Try to establish a fresh connection
    await initializeDatabaseConnection();
    const testResult = await executeQuery('SELECT NOW() as current_time');

    res.json({
      success: true,
      message: 'Database reconnected successfully',
      server_time: testResult.rows[0].current_time,
      pool_stats: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    });
  } catch (err) {
    console.error('Database reconnection failed:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      hint: 'Database may be starting up. Try again in a few seconds.'
    });
  }
});

// Lightweight health endpoint for keepalive and uptime checks
// Lightweight health check — responds INSTANTLY without querying DB.
// Used by Render self-ping to keep the service alive. Must never block on DB.
app.get('/api/health/light', (req, res) => {
  res.json({
    status: 'healthy',
    server_time_utc: new Date().toISOString(),
    database: {
      status: dbReady ? 'connected' : 'disconnected',
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount
      },
      ready: dbReady
    }
  });
});

// DB ping — called by browser pages every 30s to keep Supabase warm.
// Runs SELECT 1 against the real pool so the DB connection is never idle.
app.get('/api/db/ping', async (req, res) => {
  try {
    const warmed = await waitForDatabaseReady();
    if (!warmed) {
      return res.status(503).json({ ok: false, dbReady: false });
    }
    await pool.query('SELECT 1');
    if (!dbReady) dbReady = true;
    markDbActivity();
    res.json({ ok: true, dbReady: true });
  } catch (err) {
    try {
      await waitForDatabaseReady();
      await pool.query('SELECT 1');
      dbReady = true;
      markDbActivity();
      return res.json({ ok: true, dbReady: true, recovered: true });
    } catch (_) {
      res.status(503).json({ ok: false, dbReady: false });
    }
  }
});

// Endpoint to check server health and upcoming reminders
app.get('/api/health', async (req, res) => {
  try {
    const now = new Date();
    let dbStatus = 'unknown';
    let dbLatency = null;
    let poolStats = null;

    // Test database connection with timing
    const dbStart = Date.now();
    try {
      await executeQuery('SELECT 1');
      dbLatency = Date.now() - dbStart;
      dbStatus = 'connected';
    } catch (dbErr) {
      dbStatus = 'disconnected';
      console.error('Health check DB error:', dbErr.message);
    }

    // Get pool statistics
    poolStats = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount
    };

    // Get upcoming sessions (only if DB is connected)
    let sessionsWithTimes = [];
    if (dbStatus === 'connected') {
      try {
        const upcoming = await executeQuery(`
          SELECT s.id, s.session_number, s.session_date, s.session_time, s.session_type,
                 COALESCE(st.name, 'Group') as student_name,
                 CONCAT(s.session_date, 'T', s.session_time, 'Z') as full_datetime
          FROM sessions s
          LEFT JOIN students st ON s.student_id = st.id
          WHERE s.status IN ('Pending', 'Scheduled')
            AND s.session_date >= CURRENT_DATE - INTERVAL '1 day'
          ORDER BY s.session_date, s.session_time
          LIMIT 10
        `);

        sessionsWithTimes = upcoming.rows.map(s => {
          const sessionDateTime = new Date(s.full_datetime);
          const hoursDiff = (sessionDateTime - now) / (1000 * 60 * 60);
          return {
            id: s.id,
            session_number: s.session_number,
            student: s.student_name,
            type: s.session_type,
            datetime_utc: s.full_datetime,
            hours_until: hoursDiff.toFixed(2)
          };
        });
      } catch (err) {
        console.error('Error fetching sessions for health check:', err.message);
      }
    }

    const overallStatus = dbStatus === 'connected' ? 'healthy' : 'degraded';

    res.json({
      status: overallStatus,
      server_time_utc: now.toISOString(),
      database: {
        status: dbStatus,
        latency_ms: dbLatency,
        pool: poolStats,
        ready: dbReady
      },
      upcoming_sessions: sessionsWithTimes,
      reminder_windows: {
        '5_hour': '4.5 to 5.5 hours before class',
        '1_hour': '0.5 to 1.5 hours before class'
      }
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: err.message,
      database: { status: 'error', ready: dbReady }
    });
  }
});

// ==================== EXTERNAL PING ENDPOINT ====================
// Add this endpoint to allow external services to ping your app
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbReady ? 'connected' : 'disconnected'
  });
});
// Self-ping every 25 seconds to keep free-tier service and DB awake
const SELF_PING_INTERVAL = Math.max(20 * 1000, Number(process.env.SELF_PING_INTERVAL_MS) || 25 * 1000);
const DB_CHECK_INTERVAL = 25 * 1000;        // Check DB every 25 seconds
const DB_KEEPALIVE_INTERVAL = Math.max(20 * 1000, Number(process.env.DB_KEEPALIVE_INTERVAL_MS) || 30 * 1000);
let selfPingUrl = null;
let selfPingInFlight = false;
const SELF_PING_PATH = '/api/health/light';

function getSelfPingBaseUrl(port) {
  const explicitSelfPingUrl = (process.env.SELF_PING_URL || '').trim().replace(/\/$/, '');
  if (explicitSelfPingUrl) return explicitSelfPingUrl;
  // Default to local loopback so keepalive never depends on Cloudflare/public routing.
  return `http://127.0.0.1:${port}`;
}

// ─── Dedicated persistent ping client ───────────────────────────────────────
// Completely separate from the pool. Leave this off for transaction poolers
// like Supabase because a sticky client can compete with real traffic.
let _pingClient = null;
let _pingConnecting = false;

async function _connectPingClient() {
  if (_pingConnecting) return;
  _pingConnecting = true;
  try {
    if (_pingClient) { try { _pingClient.end(); } catch {} _pingClient = null; }
    const c = new Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
      keepAliveInitialDelayMillis: 0,
      statement_timeout: 4000,
      query_timeout: 4000,
      connectionTimeoutMillis: 8000
    });
    c.on('error', () => {
      _pingClient = null;
      dbReady = false;
      setTimeout(() => {
        checkDatabaseHealth().catch(() => {});
      }, 0);
    });
    await c.connect();
    _pingClient = c;
    console.log('⚡ Persistent DB ping client connected');
    // Mark DB ready as soon as ping client connects
    if (!dbReady) { dbReady = true; console.log('✅ Database ready (via ping client)'); }
  } catch (err) {
    console.warn('⚡ Ping client connect failed:', err.message);
    _pingClient = null;
  } finally {
    _pingConnecting = false;
  }
}

async function _sendDbPing() {
  if (!_pingClient) {
    await _connectPingClient();
    return;
  }
  try {
    await _pingClient.query('SELECT 1');
    markDbActivity();
    if (!dbReady) { dbReady = true; console.log('✅ Database ready (ping ok)'); }
  } catch (err) {
    console.warn('⚡ DB ping failed, will reconnect:', err.message);
    _pingClient = null;
    dbReady = false;
    setTimeout(_connectPingClient, 2000);
    setTimeout(() => {
      checkDatabaseHealth().catch(() => {});
    }, 0);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Pool-based health check — used for reconnect detection and pool validation
async function checkDatabaseHealth() {
  if (dbHealthCheckInFlight) return;
  dbHealthCheckInFlight = true;
  try {
    // Use pool.query directly — no retry delay, doesn't hold connection long
    await pool.query('SELECT 1');
    if (!dbReady) {
      console.log('✅ Database reconnected (pool check)');
      dbReady = true;
    }
    dbReconnectScheduled = false;
  } catch (err) {
    const now = Date.now();
    if (now - lastDbFailureLogAt > 60 * 1000) {
      console.error('❌ Pool health check failed:', err.message);
      lastDbFailureLogAt = now;
    }
    dbReady = false;
    if (!dbReconnectScheduled) {
      dbReconnectScheduled = true;
      setTimeout(async () => {
        try { await initializeDatabaseConnection(); }
        finally { dbReconnectScheduled = false; }
      }, 10000);
    }
  } finally {
    dbHealthCheckInFlight = false;
  }
}

function startKeepAlive() {
  if (keepAliveStarted) return;
  keepAliveStarted = true;

  if (USE_DEDICATED_DB_PING_CLIENT) {
    // Start persistent ping client immediately when the DB type can tolerate it.
    _connectPingClient();
    setInterval(_sendDbPing, 8 * 1000);
  } else {
    console.log('🏓 Dedicated DB ping client disabled for pooled database host; using lightweight keepalive only');
  }

  // Pool health check every 30 seconds — detects pool-level issues
  checkDatabaseHealth();
  setInterval(async () => {
    await checkDatabaseHealth();
  }, DB_CHECK_INTERVAL);

  selfPingUrl = getSelfPingBaseUrl(PORT);
  console.log(`🏓 Keepalive ping enabled for: ${selfPingUrl}${SELF_PING_PATH} every ${Math.round(SELF_PING_INTERVAL / 1000)}s`);
  console.log(`🏓 DB keepalive enabled for: ${selfPingUrl}/api/db/ping every ${Math.round(DB_KEEPALIVE_INTERVAL / 1000)}s`);

  setInterval(async () => {
    if (selfPingInFlight) return;
    selfPingInFlight = true;
    try {
      const response = await axios.get(`${selfPingUrl}${SELF_PING_PATH}`, { timeout: 15000 });
      const data = response.data;
      console.log(`🏓 Keepalive: status=${data?.status || 'unknown'} at ${new Date().toISOString()}`);
    } catch (err) {
      console.log(`🏓 Keepalive ping failed: ${err.message}`);
      if (err?.response?.status === 521 && !selfPingUrl.includes('127.0.0.1')) {
        selfPingUrl = `http://127.0.0.1:${PORT}`;
        console.log(`🏓 Switched keepalive to local loopback after 521: ${selfPingUrl}${SELF_PING_PATH}`);
      }
      checkDatabaseHealth().catch(() => {});
    } finally {
      selfPingInFlight = false;
    }
  }, SELF_PING_INTERVAL);

  // Separate DB keepalive so Postgres stays warm even when HTTP keepalive is lightweight.
  setInterval(async () => {
    try {
      await axios.get(`${selfPingUrl}/api/db/ping`, { timeout: 15000 });
    } catch (err) {
      console.log(`🏓 DB keepalive failed: ${err.message}`);
      if (err?.response?.status === 521 && !selfPingUrl.includes('127.0.0.1')) {
        selfPingUrl = `http://127.0.0.1:${PORT}`;
        console.log(`🏓 Switched DB keepalive to local loopback after 521: ${selfPingUrl}/api/db/ping`);
      }
      checkDatabaseHealth().catch(() => {});
    }
  }, DB_KEEPALIVE_INTERVAL);
}

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('Error closing pool:', err.message);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, closing database pool...');
  try {
    await pool.end();
    console.log('✅ Database pool closed');
  } catch (err) {
    console.error('Error closing pool:', err.message);
  }
  process.exit(0);
});
app.post('/api/sessions/bulk-reschedule', async (req, res) => {
  const { sessions } = req.body;
  // sessions = [{ session_id, new_date, new_time }]
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rescheduled = [];
    const affectedStudents = new Set();
    const affectedGroups = new Set();
    for (const s of sessions) {
      // Get old session
      const old = await client.query('SELECT * FROM sessions WHERE id = $1', [s.session_id]);
      if (old.rows.length === 0) continue;
      const session = old.rows[0];
      if (session.session_type === 'Group' && session.group_id) {
        affectedGroups.add(String(session.group_id));
      } else if (session.student_id) {
        affectedStudents.add(String(session.student_id));
      }

      // Convert to UTC
      const utc = istToUTC(s.new_date, s.new_time);

      // Save old date, update new
      await client.query(`
        UPDATE sessions SET
          session_date = $1,
          session_time = $2,
          original_date = COALESCE(original_date, session_date),
          original_time = COALESCE(original_time, session_time)
        WHERE id = $3
      `, [utc.date, utc.time, s.session_id]);

      // Clear old reminder logs
      await client.query(
        `DELETE FROM email_log WHERE subject LIKE $1`,
        [`%[SID:${s.session_id}]%`]
      );

      rescheduled.push({
        ...session,
        session_date: utc.date,
        session_time: utc.time
      });
    }

    for (const studentId of affectedStudents) {
      await renumberPrivateSessionsForStudent(studentId, client);
    }
    for (const groupId of affectedGroups) {
      await renumberGroupSessionsForGroup(groupId, client);
    }

    await client.query('COMMIT');

    // Send emails if requested
    if (req.body.send_email) {
      // Group sessions by student to send one email per student
      const studentSessions = {};
      for (const session of rescheduled) {
        const sid = session.student_id || session.group_id;
        if (!studentSessions[sid]) studentSessions[sid] = [];
        studentSessions[sid].push(session);
      }

      for (const [sid, sessions] of Object.entries(studentSessions)) {
        const student = await pool.query('SELECT * FROM students WHERE id = $1', [sid]);
        if (!student.rows[0]?.parent_email) continue;

        const s = student.rows[0];
        const sortedSessions = [...sessions].sort((a, b) => {
          const aDateTime = new Date(`${a.session_date}T${(a.session_time || '00:00:00').toString().substring(0, 8)}Z`);
          const bDateTime = new Date(`${b.session_date}T${(b.session_time || '00:00:00').toString().substring(0, 8)}Z`);
          return aDateTime - bDateTime;
        });

        const sessionRows = sortedSessions.map(sess => {
          const local = formatUTCToLocal(sess.session_date, sess.session_time, s.parent_timezone || s.timezone || 'Asia/Kolkata');
          return `<tr>
            <td style="padding:10px;">Session #${sess.session_number}</td>
            <td style="padding:10px;">${local.date}</td>
            <td style="padding:10px;"><strong>${local.time}</strong></td>
          </tr>`;
        }).join('');

        await sendEmail(
          s.parent_email,
          `📅 Classes Rescheduled - ${s.name}`,
          getBulkPrivateRescheduleEmailTemplate({
            parent_name: s.parent_name,
            student_name: s.name,
            sessionRowsHtml: sessionRows,
            timezone: s.parent_timezone || s.timezone || 'Asia/Kolkata'
          }),
          s.parent_name,
          'Reschedule'
        );
      }
    }

    res.json({ success: true, message: `${sessions.length} sessions rescheduled successfully!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
app.post('/api/sessions/bulk-reschedule-group', async (req, res) => {
  const { sessions, send_email } = req.body;
  const client = await pool.connect();
  try {
    const formatEmailDate = (rawDate) => {
      try {
        if (!rawDate) return 'N/A';
        if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
          return rawDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        }

        const input = String(rawDate).trim();
        const dateOnly = input.includes('T') ? input.split('T')[0] : input;

        let parsed = null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
          parsed = new Date(`${dateOnly}T00:00:00`);
        } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateOnly)) {
          const [day, month, year] = dateOnly.split('/');
          parsed = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
        } else {
          parsed = new Date(input);
        }

        if (!parsed || isNaN(parsed.getTime())) return input;
        return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch {
        return String(rawDate);
      }
    };

    await client.query('BEGIN');

    const affectedGroups = new Set();
    for (const s of sessions) {
      const old = await client.query('SELECT group_id FROM sessions WHERE id = $1', [s.session_id]);
      if (old.rows[0]?.group_id) {
        affectedGroups.add(String(old.rows[0].group_id));
      }

      const utc = istToUTC(s.new_date, s.new_time);
      await client.query(`
        UPDATE sessions SET
          session_date = $1,
          session_time = $2,
          original_date = COALESCE(original_date, session_date),
          original_time = COALESCE(original_time, session_time)
        WHERE id = $3
      `, [utc.date, utc.time, s.session_id]);

      // Clear old reminder logs
      await client.query(
        `DELETE FROM email_log WHERE subject LIKE $1`,
        [`%[SID:${s.session_id}]%`]
      );
    }

    for (const groupId of affectedGroups) {
      await renumberGroupSessionsForGroup(groupId, client);
    }

    await client.query('COMMIT');

    // Send ONE email per student in the group
    if (send_email && req.body.group_id) {
      const groupStudents = await pool.query(`
        SELECT s.* FROM students s
        JOIN group_students gs ON gs.student_id = s.id
        WHERE gs.group_id = $1 AND s.is_active = true
      `, [req.body.group_id]);

      const group = await pool.query('SELECT * FROM groups WHERE id = $1', [req.body.group_id]);
      const groupName = group.rows[0]?.group_name || 'Group';

      for (const student of groupStudents.rows) {
        if (!student.parent_email) continue;

        const sessionRows = sessions.map(s => {
          const local = formatUTCToLocal(
            istToUTC(s.new_date, s.new_time).date,
            istToUTC(s.new_date, s.new_time).time,
            student.parent_timezone || student.timezone || 'Asia/Kolkata'
          );
          const timezoneLabel = getTimezoneLabel(student.parent_timezone || student.timezone || 'Asia/Kolkata');
          const oldDateDisplay = formatEmailDate(s.old_date);
          return `<tr>
            <td style="padding:10px;">Session #${s.session_number}</td>
            <td style="padding:10px; color:#718096;">${oldDateDisplay}</td>
            <td style="padding:10px; color:#38a169;"><strong>${local.date}</strong></td>
            <td style="padding:10px;"><strong style="color:#667eea;">${local.time} (${timezoneLabel})</strong></td>
          </tr>`;
        }).join('');

        await sendEmail(
          student.parent_email,
          `📅 Group Classes Rescheduled - ${groupName}`,
          `<!DOCTYPE html>
<html>
<body style="font-family:'Segoe UI',sans-serif; background:#f0f4f8; margin:0; padding:20px;">
  <div style="max-width:600px; margin:0 auto; background:white; border-radius:12px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.1);">
    <div style="background:linear-gradient(135deg,#667eea,#764ba2); padding:30px; text-align:center;">
      <h1 style="color:white; margin:0;">📅 Classes Rescheduled</h1>
      <p style="color:rgba(255,255,255,0.9); margin-top:8px;">${groupName}</p>
    </div>
    <div style="padding:30px;">
      <p>Dear <strong>${student.parent_name}</strong>,</p>
      <p>The following group classes for <strong>${student.name}</strong> have been rescheduled:</p>
      <table style="width:100%; border-collapse:collapse; margin:20px 0;">
        <thead>
          <tr style="background:#f7fafc;">
            <th style="padding:10px; text-align:left;">Session</th>
            <th style="padding:10px; text-align:left;">Old Date</th>
            <th style="padding:10px; text-align:left;">New Date</th>
            <th style="padding:10px; text-align:left;">New Time</th>
          </tr>
        </thead>
        <tbody>${sessionRows}</tbody>
      </table>
      <p style="color:#718096; font-size:14px;">Please update your calendar accordingly.</p>
      <p>Best regards,<br><strong style="color:#B05D9E;">Team Fluent Feathers Academy</strong></p>

      <div style="margin-top: 30px; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; text-align: center;">
        <p style="margin: 0 0 8px 0; color: #ffffff; font-size: 14px; font-weight: 600;">🏠 Access Parent Portal</p>
        <p style="margin: 0 0 16px 0; color: rgba(255,255,255,0.85); font-size: 13px;">Track progress, view materials, check scores & more — all in one place.</p>
        <a href="${process.env.APP_URL || 'https://fluent-feathers-academy-lms.onrender.com'}/parent.html" style="display: inline-block; background: #ffffff; color: #667eea; padding: 12px 32px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">🔗 Open Parent Portal</a>
      </div>
    </div>
  </div>
</body>
</html>`,
          student.parent_name,
          'Reschedule'
        );
      }
    }

    res.json({ success: true, message: `${sessions.length} group sessions rescheduled!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ==================== LIVE CLASS POINTS OVERLAY API ====================

// GET today's sessions (private + group) for the overlay picker
app.get('/api/live-points/today-sessions', async (req, res) => {
  try {
    const tz = req.query.tz || 'Asia/Kolkata';
    const todayUtc = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD in teacher's TZ
    const result = await executeQuery(`
      SELECT
        s.id AS session_id,
        s.session_type,
        s.session_date,
        s.session_time,
        s.status,
        COALESCE(st.name, g.group_name) AS label,
        st.id AS student_id,
        st.name AS student_name,
        g.id AS group_id,
        g.group_name
      FROM sessions s
      LEFT JOIN students st ON s.student_id = st.id
      LEFT JOIN groups g ON s.group_id = g.id
      WHERE s.session_date = $1
        AND s.status NOT IN ('Cancelled')
      ORDER BY s.session_time ASC
    `, [todayUtc]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET students for a group session
app.get('/api/live-points/group/:groupId/students', async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT id, name FROM students WHERE group_id = $1 AND is_active = true ORDER BY name ASC`,
      [req.params.groupId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all active students (for manual / private class picker)
app.get('/api/live-points/all-students', async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT id, name, class_type, group_name FROM students WHERE is_active = true ORDER BY name ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET point totals for a list of students (for overlay live display)
app.get('/api/live-points/totals', async (req, res) => {
  try {
    const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
    if (ids.length === 0) return res.json([]);
    await Promise.all(ids.map(async function(studentId) {
      const totalResult = await pool.query(
        'SELECT COALESCE(SUM(points), 0) AS total_points FROM class_points WHERE student_id = $1',
        [studentId]
      );
      await backfillClassPointBadges(studentId, totalResult.rows[0].total_points);
    }));
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await executeQuery(
      `SELECT student_id, SUM(points) AS total_points
       FROM class_points
       WHERE student_id IN (${placeholders})
       GROUP BY student_id`,
      ids
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST award points to a student
app.post('/api/live-points/award', async (req, res) => {
  try {
    const { student_id, points, reason, session_id } = req.body;
    if (!student_id || points === undefined) {
      return res.status(400).json({ error: 'student_id and points are required' });
    }
    const safePoints = Math.max(-100, Math.min(100, parseInt(points) || 0));
    const result = await executeQuery(
      `INSERT INTO class_points (student_id, session_id, points, reason) VALUES ($1, $2, $3, $4) RETURNING *`,
      [student_id, session_id || null, safePoints, reason || 'Good work!']
    );
    // Return the new running total for this student
    const totalResult = await executeQuery(
      `SELECT COALESCE(SUM(points), 0) AS total_points FROM class_points WHERE student_id = $1`,
      [student_id]
    );
    const totalPoints = parseInt(totalResult.rows[0].total_points);
    const newlyAwardedBadges = await backfillClassPointBadges(student_id, totalPoints);
    const badgeAwarded = newlyAwardedBadges.length > 0 ? newlyAwardedBadges[newlyAwardedBadges.length - 1] : null;

    res.json({ entry: result.rows[0], total_points: totalPoints, badge_awarded: badgeAwarded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a student's full points history and total
app.get('/api/live-points/student/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    const history = await executeQuery(
      `SELECT cp.*, s.name AS student_name
       FROM class_points cp
       JOIN students s ON s.id = cp.student_id
       WHERE cp.student_id = $1
       ORDER BY cp.awarded_at DESC
       LIMIT 100`,
      [id]
    );
    const total = await executeQuery(
      `SELECT COALESCE(SUM(points), 0) AS total_points FROM class_points WHERE student_id = $1`,
      [id]
    );
    res.json({ history: history.rows, total_points: parseInt(total.rows[0].total_points) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET total points awarded on a specific date (admin dashboard stat card)
app.get('/api/live-points/day-total', async (req, res) => {
  try {
    const date = req.query.date; // YYYY-MM-DD
    if (!date) return res.status(400).json({ error: 'date param required' });
    const result = await executeQuery(
      `SELECT COALESCE(SUM(points), 0) AS total FROM class_points WHERE awarded_at::date = $1`,
      [date]
    );
    res.json({ total: parseInt(result.rows[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET class points leaderboard (today / this week / all time)
app.get('/api/live-points/leaderboard', async (req, res) => {
  try {
    const range = req.query.range || 'all'; // today | week | all
    const tz = req.query.tz || 'Asia/Kolkata';
    let whereClause = '';
    if (range === 'today') {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
      whereClause = `WHERE cp.awarded_at AT TIME ZONE '${tz}' >= '${today}'::date AND cp.awarded_at AT TIME ZONE '${tz}' < ('${today}'::date + interval '1 day')`;
    } else if (range === 'week') {
      whereClause = `WHERE cp.awarded_at >= date_trunc('week', NOW() AT TIME ZONE '${tz}')`;
    }
    const result = await executeQuery(
      `SELECT s.id AS student_id, s.name AS student_name, COALESCE(SUM(cp.points), 0) AS total_points
       FROM students s
       JOIN class_points cp ON cp.student_id = s.id
       ${whereClause}
       GROUP BY s.id, s.name
       HAVING COALESCE(SUM(cp.points), 0) > 0
       ORDER BY total_points DESC
       LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 LMS Running on port ${PORT}`);
  startKeepAlive();
});
