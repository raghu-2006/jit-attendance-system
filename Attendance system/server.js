'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'attendance.sqlite');
const PORT = Number(process.env.PORT || 3000);
const secureCookie = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
const TIME_ZONE = 'Asia/Kolkata';
const CAMPUS = { latitude: 12.8423333333, longitude: 77.5125 };
const STUDENTS = ['Keerthan', 'Sinchana', 'Megha', 'Lekha', 'Tanushri', 'Mounika', 'Sanjana', 'Gowthami', 'Nithin'];
const ADMINS = [
  { username: 'admin', name: 'Admin', password: 'admin@123' },
  { username: 'domodar', name: 'Domodar', password: 'damo@123' },
  { username: 'karan kumar', name: 'Karan Kumar', password: 'karan@123' },
];
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'admin')),
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    work_date TEXT NOT NULL,
    day_in_at TEXT NOT NULL,
    day_in_latitude REAL NOT NULL,
    day_in_longitude REAL NOT NULL,
    day_in_distance_m REAL NOT NULL,
    day_out_at TEXT,
    UNIQUE (user_id, work_date)
  );
  CREATE TABLE IF NOT EXISTS breaks (
    id INTEGER PRIMARY KEY,
    attendance_id INTEGER NOT NULL REFERENCES attendance(id),
    break_type TEXT NOT NULL CHECK (break_type IN ('short', 'lunch')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    start_latitude REAL,
    start_longitude REAL,
    start_distance_m REAL,
    end_latitude REAL,
    end_longitude REAL,
    end_distance_m REAL,
    UNIQUE (attendance_id, break_type)
  );
  CREATE TABLE IF NOT EXISTS attendance_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    work_date TEXT NOT NULL,
    action TEXT NOT NULL,
    break_type TEXT CHECK (break_type IN ('short', 'lunch')),
    recorded_at TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    distance_m REAL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance(work_date);
  CREATE INDEX IF NOT EXISTS events_user_date_idx ON attendance_events(user_id, work_date);
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
`);

const insertUser = db.prepare(`INSERT OR IGNORE INTO users
  (username, full_name, role, password_hash, password_salt, created_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
function passwordDigest(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function seedUser(username, fullName, role, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  insertUser.run(username, fullName, role, passwordDigest(password, salt), salt, new Date().toISOString());
}
for (const name of STUDENTS) {
  seedUser(name.toLowerCase(), name, 'student', `${name.slice(0, 4).toLowerCase()}@123`);
}
for (const admin of ADMINS) seedUser(admin.username, admin.name, 'admin', admin.password);

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function indiaParts(date) {
  return Object.fromEntries(timeFormatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function indiaDate(date) {
  const part = indiaParts(date);
  return `${part.year}-${String(part.month).padStart(2, '0')}-${String(part.day).padStart(2, '0')}`;
}
function indiaMinute(date) {
  const part = indiaParts(date);
  return part.hour * 60 + part.minute + part.second / 60;
}
function haversineMeters(latitude, longitude) {
  const radians = value => value * Math.PI / 180;
  const latDelta = radians(latitude - CAMPUS.latitude);
  const lonDelta = radians(longitude - CAMPUS.longitude);
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(CAMPUS.latitude)) * Math.cos(radians(latitude)) * Math.sin(lonDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function inInclusiveWindow(minutes, start, end) {
  return minutes >= start && minutes <= end;
}
function breakWindow(breakType) {
  return breakType === 'short' ? [10 * 60 + 20, 10 * 60 + 30] : [13 * 60, 14 * 60];
}
function weekdaysInPeriod(year, month, endDay) {
  let days = 0;
  for (let day = 1; day <= endDay; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}
function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify(value));
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}
function cookieValue(request, name) {
  const cookies = (request.headers.cookie || '').split(';');
  const cookie = cookies.map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}
function authenticate(request) {
  const token = cookieValue(request, 'attendance_session');
  if (!token) return null;
  const row = db.prepare(`SELECT users.id, users.username, users.full_name, users.role, users.email, users.phone
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`).get(crypto.createHash('sha256').update(token).digest('hex'), Date.now());
  return row || null;
}
function requireRole(user, role) {
  if (!user) throw Object.assign(new Error('Please sign in to continue.'), { status: 401 });
  if (role && user.role !== role) throw Object.assign(new Error('This page is not available for your account.'), { status: 403 });
}
function todayRecord(userId, date = indiaDate(new Date())) {
  const row = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, date);
  if (!row) return { date, dayInAt: null, dayOutAt: null, breaks: [] };
  const breaks = db.prepare('SELECT break_type, started_at, ended_at FROM breaks WHERE attendance_id = ? ORDER BY id').all(row.id)
    .map(item => ({ type: item.break_type, startedAt: item.started_at, endedAt: item.ended_at }));
  return { date, dayInAt: row.day_in_at, dayOutAt: row.day_out_at, breaks };
}
function recordEvent(userId, date, action, breakType, recordedAt, location) {
  db.prepare(`INSERT INTO attendance_events (user_id, work_date, action, break_type, recorded_at, latitude, longitude, distance_m)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, date, action, breakType, recordedAt,
    location?.latitude ?? null, location?.longitude ?? null, location?.distance ?? null);
}
function closeExpiredBreaks(date, userId = null) {
  const query = `SELECT breaks.id, breaks.break_type, attendance.user_id, attendance.work_date
    FROM breaks JOIN attendance ON attendance.id = breaks.attendance_id
    WHERE breaks.ended_at IS NULL AND attendance.work_date = ?${userId ? ' AND attendance.user_id = ?' : ''}`;
  const rows = userId ? db.prepare(query).all(date, userId) : db.prepare(query).all(date);
  const now = Date.now();
  for (const row of rows) {
    const [, endMinute] = breakWindow(row.break_type);
    const [year, month, day] = row.work_date.split('-').map(Number);
    const endAt = new Date(Date.UTC(year, month - 1, day, 0, endMinute - 330)).toISOString();
    if (now <= Date.parse(endAt)) continue;
    db.prepare('UPDATE breaks SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endAt, row.id);
    recordEvent(row.user_id, row.work_date, 'break_end', row.break_type, endAt, null);
  }
}
function transaction(operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function locationFrom(body, radius) {
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw Object.assign(new Error('Allow location access to record this attendance action.'), { status: 400 });
  }
  const distance = haversineMeters(latitude, longitude);
  if (distance > radius) throw Object.assign(new Error(`You are ${Math.round(distance)} m from campus; this action requires you to be within ${radius} m.`), { status: 403 });
  return { latitude, longitude, distance };
}
function attendanceAction(user, body) {
  const now = new Date();
  const date = indiaDate(now);
  const minutes = indiaMinute(now);
  closeExpiredBreaks(date, user.id);
  const { action, breakType } = body;
  if (!['day_in', 'day_out', 'break_start', 'break_end'].includes(action)) {
    throw Object.assign(new Error('Choose a valid attendance action.'), { status: 400 });
  }
  if (action === 'day_in' && (minutes <= 8 * 60 + 55 || minutes >= 16 * 60)) {
    throw Object.assign(new Error('Day in is available after 8:55 AM and before 4:00 PM IST.'), { status: 403 });
  }
  if (action === 'day_out' && minutes <= 16 * 60) {
    throw Object.assign(new Error('Day out is available after 4:00 PM IST.'), { status: 403 });
  }
  if (action.startsWith('break_')) {
    if (!['short', 'lunch'].includes(breakType)) throw Object.assign(new Error('Choose the short or lunch break.'), { status: 400 });
    const [start, end] = breakWindow(breakType);
    if (!inInclusiveWindow(minutes, start, end)) {
      const label = breakType === 'short' ? '10:20–10:30 AM' : '1:00–2:00 PM';
      throw Object.assign(new Error(`This break is available only between ${label} IST.`), { status: 403 });
    }
  }

  let location = null;
  if (action === 'day_in') location = locationFrom(body, 500);
  if (action.startsWith('break_') && breakType === 'lunch') location = locationFrom(body, 2000);
  const recordedAt = now.toISOString();

  return transaction(() => {
    const attendance = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(user.id, date);
    if (action === 'day_in') {
      if (attendance) throw Object.assign(new Error('Day in has already been recorded for today.'), { status: 409 });
      const result = db.prepare(`INSERT INTO attendance (user_id, work_date, day_in_at, day_in_latitude, day_in_longitude, day_in_distance_m)
        VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, date, recordedAt, location.latitude, location.longitude, location.distance);
      recordEvent(user.id, date, action, null, recordedAt, location);
      return { ok: true, today: todayRecord(user.id, date), attendanceId: result.lastInsertRowid };
    }
    if (!attendance) throw Object.assign(new Error('Record day in before other attendance actions.'), { status: 409 });
    if (action === 'day_out') {
      if (attendance.day_out_at) throw Object.assign(new Error('Day out has already been recorded for today.'), { status: 409 });
      const openBreak = db.prepare('SELECT break_type FROM breaks WHERE attendance_id = ? AND ended_at IS NULL').get(attendance.id);
      if (openBreak) throw Object.assign(new Error('End your active break before recording day out.'), { status: 409 });
      db.prepare('UPDATE attendance SET day_out_at = ? WHERE id = ?').run(recordedAt, attendance.id);
      recordEvent(user.id, date, action, null, recordedAt, null);
      return { ok: true, today: todayRecord(user.id, date) };
    }
    if (attendance.day_out_at) throw Object.assign(new Error('Attendance for today is already complete.'), { status: 409 });
    const existingBreak = db.prepare('SELECT * FROM breaks WHERE attendance_id = ? AND break_type = ?').get(attendance.id, breakType);
    if (action === 'break_start') {
      if (existingBreak) throw Object.assign(new Error('This break has already been recorded today.'), { status: 409 });
      db.prepare(`INSERT INTO breaks (attendance_id, break_type, started_at, start_latitude, start_longitude, start_distance_m)
        VALUES (?, ?, ?, ?, ?, ?)`).run(attendance.id, breakType, recordedAt,
        location?.latitude ?? null, location?.longitude ?? null, location?.distance ?? null);
    } else {
      if (!existingBreak || existingBreak.ended_at) throw Object.assign(new Error('There is no active break to end.'), { status: 409 });
      db.prepare(`UPDATE breaks SET ended_at = ?, end_latitude = ?, end_longitude = ?, end_distance_m = ? WHERE id = ?`)
        .run(recordedAt, location?.latitude ?? null, location?.longitude ?? null, location?.distance ?? null, existingBreak.id);
    }
    recordEvent(user.id, date, action, breakType, recordedAt, location);
    return { ok: true, today: todayRecord(user.id, date) };
  });
}
function monthlyAttendance(user, monthText) {
  if (!/^\d{4}-\d{2}$/.test(monthText || '')) throw Object.assign(new Error('Choose a valid month.'), { status: 400 });
  const [year, month] = monthText.split('-').map(Number);
  if (month < 1 || month > 12) throw Object.assign(new Error('Choose a valid month.'), { status: 400 });
  const today = indiaDate(new Date());
  const currentMonth = today.slice(0, 7);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const throughDay = monthText < currentMonth ? lastDay : monthText > currentMonth ? 0 : Number(today.slice(8, 10));
  const scheduledDays = weekdaysInPeriod(year, month, throughDay);
  const rows = db.prepare(`SELECT work_date, day_in_at, day_out_at FROM attendance
    WHERE user_id = ? AND work_date >= ? AND work_date < ? ORDER BY work_date`)
    .all(user.id, `${monthText}-01`, `${monthText}-32`);
  const presentDays = rows.filter(row => row.day_in_at && row.work_date.slice(8, 10) <= String(throughDay).padStart(2, '0')).length;
  return { month: monthText, scheduledDays, presentDays, percentage: scheduledDays ? Math.round(presentDays / scheduledDays * 1000) / 10 : 0, days: rows };
}
function adminRows(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw Object.assign(new Error('Choose a valid date.'), { status: 400 });
  closeExpiredBreaks(date);
  return db.prepare(`SELECT users.username, users.full_name, users.email, users.phone,
      attendance.day_in_at, attendance.day_out_at,
      (SELECT started_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'short') AS short_break_start,
      (SELECT ended_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'short') AS short_break_end,
      (SELECT started_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'lunch') AS lunch_start,
      (SELECT ended_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'lunch') AS lunch_end
    FROM users LEFT JOIN attendance ON attendance.user_id = users.id AND attendance.work_date = ?
    WHERE users.role = 'student' ORDER BY users.full_name`).all(date);
}
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
function exportCsv(response) {
  for (const row of db.prepare('SELECT DISTINCT work_date FROM attendance').all()) closeExpiredBreaks(row.work_date);
  const rows = db.prepare(`SELECT users.username, users.full_name, users.email, users.phone, attendance.work_date,
      attendance.day_in_at, attendance.day_out_at,
      (SELECT started_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'short') AS short_break_start,
      (SELECT ended_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'short') AS short_break_end,
      (SELECT started_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'lunch') AS lunch_start,
      (SELECT ended_at FROM breaks WHERE attendance_id = attendance.id AND break_type = 'lunch') AS lunch_end
    FROM attendance JOIN users ON users.id = attendance.user_id ORDER BY attendance.work_date DESC, users.full_name`).all();
  const fields = ['username', 'full_name', 'email', 'phone', 'work_date', 'day_in_at', 'day_out_at', 'short_break_start', 'short_break_end', 'lunch_start', 'lunch_end'];
  const csv = [fields, ...rows.map(row => fields.map(field => row[field]))].map(row => row.map(csvCell).join(',')).join('\r\n');
  response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="jit-attendance.csv"', 'Cache-Control': 'no-store' });
  response.end(csv);
}
async function handleApi(request, response, url) {
  const pathname = url.pathname;
  if (request.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(request);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const digest = user ? passwordDigest(password, user.password_salt) : passwordDigest(password, 'invalid-user-salt');
    if (!user || !crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
      throw Object.assign(new Error('The username or password is incorrect.'), { status: 401 });
    }
    const requestedRole = body.portal === 'admin' ? 'admin' : 'student';
    if (user.role !== requestedRole) throw Object.assign(new Error('Use the correct sign-in page for this account.'), { status: 403 });
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(crypto.createHash('sha256').update(token).digest('hex'), user.id, Date.now() + SESSION_DURATION_MS);
    return sendJson(response, 200, { user: { username: user.username, fullName: user.full_name, role: user.role, email: user.email, phone: user.phone } }, {
      'Set-Cookie': `attendance_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}${secureCookie}`,
    });
  }
  if (request.method === 'POST' && pathname === '/api/logout') {
    const token = cookieValue(request, 'attendance_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(token).digest('hex'));
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': `attendance_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}` });
  }
  const user = authenticate(request);
  if (request.method === 'GET' && pathname === '/api/me') {
    requireRole(user);
    if (user.role === 'student') closeExpiredBreaks(indiaDate(new Date()), user.id);
    return sendJson(response, 200, { user, today: user.role === 'student' ? todayRecord(user.id) : null, now: new Date().toISOString() });
  }
  if (request.method === 'GET' && pathname === '/api/student/month') {
    requireRole(user, 'student');
    return sendJson(response, 200, monthlyAttendance(user, url.searchParams.get('month')));
  }
  if (request.method === 'PATCH' && pathname === '/api/student/profile') {
    requireRole(user, 'student');
    const body = await readJson(request);
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
    if (phone.length > 32) throw Object.assign(new Error('Phone number must be 32 characters or fewer.'), { status: 400 });
    const fullName = String(body.fullName || '').trim();
    if (!fullName || fullName.length > 80) throw Object.assign(new Error('Name must be between 1 and 80 characters.'), { status: 400 });
    db.prepare('UPDATE users SET full_name = ?, email = ?, phone = ? WHERE id = ?').run(fullName, email, phone, user.id);
    return sendJson(response, 200, { fullName, email, phone });
  }
  if (request.method === 'POST' && pathname === '/api/student/action') {
    requireRole(user, 'student');
    return sendJson(response, 200, attendanceAction(user, await readJson(request)));
  }
  if (request.method === 'GET' && pathname === '/api/admin/attendance') {
    requireRole(user, 'admin');
    const date = url.searchParams.get('date') || indiaDate(new Date());
    return sendJson(response, 200, { date, students: adminRows(date) });
  }
  if (request.method === 'GET' && pathname === '/api/admin/export') {
    requireRole(user, 'admin');
    return exportCsv(response);
  }
  return sendJson(response, 404, { error: 'Not found.' });
}
function serveStatic(request, response, url) {
  const files = {
    '/': '../index.html',
    '/student': 'student.html',
    '/student.html': 'student.html',
    '/admin': 'admin.html',
    '/admin.html': 'admin.html',
    '/styles.css': 'styles.css',
    '/app.js': 'app.js',
  };
  const filename = files[url.pathname];
  if (!filename) return sendJson(response, 404, { error: 'Not found.' });
  const filePath = path.join(PUBLIC_DIR, filename);
  if (!fs.existsSync(filePath)) return sendJson(response, 503, { error: 'The app interface is not ready yet.' });
  response.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(filePath)],
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(filePath).pipe(response);
}
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (request.method === 'GET') serveStatic(request, response, url);
    else sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'The server could not complete this request.' });
    else response.destroy();
    if (!error.status) console.error(error);
  }
});
server.listen(PORT, () => console.log(`JIT attendance running at http://localhost:${PORT}`));

module.exports = { indiaDate, indiaMinute, haversineMeters, inInclusiveWindow, breakWindow, weekdaysInPeriod, attendanceAction };
