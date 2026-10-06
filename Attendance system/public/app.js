'use strict';

const portal = document.body.dataset.portal;
const byId = id => document.getElementById(id);
const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
const deviceTimeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
let currentUser = null;
let today = null;
let serverOffset = 0;
let selectedMonth = new Date().toISOString().slice(0, 7);
let clockTimer = null;
let deviceClockTimer = null;
let refreshTimer = null;

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    const result = type.includes('application/json') ? await response.json() : { error: 'The request could not be completed.' };
    if (response.status === 401 && !url.endsWith('/login')) showAuth();
    throw new Error(result.error || 'The request could not be completed.');
  }
  if (type.includes('text/csv')) return response.blob();
  return response.json();
}
function showError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
}
function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}
function showAuth() {
  clearInterval(refreshTimer);
  clearInterval(clockTimer);
  byId('auth-view').hidden = false;
  byId(portal === 'admin' ? 'admin-view' : 'student-view').hidden = true;
}
function signIn(user) {
  const correctPortal = portal === 'admin' ? user.role === 'admin' : user.role === 'student';
  if (!correctPortal) {
    window.location.assign(user.role === 'admin' ? '/admin' : '/student');
    return;
  }
  byId('auth-view').hidden = true;
  byId(portal === 'admin' ? 'admin-view' : 'student-view').hidden = false;
  currentUser = user;
  if (portal === 'admin') initializeAdmin(user);
  else initializeStudent(user);
}
async function boot() {
  updateDeviceClock();
  deviceClockTimer = setInterval(updateDeviceClock, 1000);
  const loginForm = byId('login-form');
  if (loginForm) loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const error = byId('login-error');
    clearError(error);
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const data = new FormData(event.currentTarget);
    try {
      const result = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: data.get('username'), password: data.get('password'), portal }) });
      signIn(result.user);
    } catch (failure) {
      showError(error, failure.message);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelectorAll('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
    const input = button.closest('.password-wrap').querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'SHOW' : 'HIDE';
    button.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
  }));
  document.querySelectorAll('[data-logout]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await request('/api/logout', { method: 'POST' }); }
    finally { window.location.assign(portal === 'admin' ? '/admin' : '/student'); }
  }));
  if (!loginForm) return;
  try {
    const result = await request('/api/me');
    serverOffset = Date.parse(result.now) - Date.now();
    if (result.user.role === portal) {
      signIn(result.user);
      if (result.today) { today = result.today; renderToday(); }
    }
  } catch (error) {
    if (!error.message.includes('sign in')) console.warn(error.message);
  }
}
function istNow() { return new Date(Date.now() + serverOffset); }
function updateDeviceClock() {
  const clock = byId('device-clock');
  if (clock) clock.textContent = deviceTimeFormatter.format(new Date());
}
function dateInIst(date) { return dateFormatter.format(date); }
function formatTime(isoString) { return isoString ? timeFormatter.format(new Date(isoString)) : '—'; }
function timeParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { hour: values.hour, minute: values.minute, minutes: values.hour * 60 + values.minute };
}
function toast(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
}
function initializeStudent(user) {
  byId('student-name').textContent = user.full_name || user.fullName;
  byId('day-in-button').disabled = true;
  byId('day-out-button').disabled = true;
  const profileDialog = byId('profile-dialog');
  byId('profile-open').addEventListener('click', () => {
    byId('profile-name').value = currentUser.full_name || currentUser.fullName || '';
    byId('profile-email').value = currentUser.email || '';
    byId('profile-phone').value = currentUser.phone || '';
    clearError(byId('profile-error'));
    profileDialog.showModal();
  });
  document.querySelectorAll('[data-dialog-close]').forEach(button => button.addEventListener('click', () => profileDialog.close()));
  byId('profile-form').addEventListener('submit', saveProfile);
  byId('day-in-button').addEventListener('click', () => submitAttendance('day_in'));
  byId('day-out-button').addEventListener('click', () => submitAttendance('day_out'));
  document.querySelectorAll('[data-break-start]').forEach(button => button.addEventListener('click', () => submitAttendance('break_start', button.dataset.breakStart)));
  document.querySelectorAll('[data-break-end]').forEach(button => button.addEventListener('click', () => submitAttendance('break_end', button.dataset.breakEnd)));
  byId('month-prev').addEventListener('click', () => changeMonth(-1));
  byId('month-next').addEventListener('click', () => changeMonth(1));
  selectedMonth = localDateInputValue().slice(0, 7);
  updateClock();
  clockTimer = setInterval(updateClock, 1000);
  refreshStudent();
  loadMonth();
  refreshTimer = setInterval(refreshStudent, 60000);
}
function updateClock() {
  const date = istNow();
  byId('ist-clock').textContent = `${timeFormatter.format(date)} IST`;
  byId('today-date').textContent = dateInIst(date);
  updateButtons();
}
function renderToday() {
  if (!today) return;
  byId('day-in-time').textContent = formatTime(today.dayInAt);
  byId('day-out-time').textContent = formatTime(today.dayOutAt);
  const complete = Boolean(today.dayOutAt);
  const status = today.dayInAt ? complete ? 'DAY COMPLETE' : 'ON CAMPUS' : 'NOT STARTED';
  byId('attendance-status').textContent = status;
  byId('attendance-status').classList.toggle('complete', complete);
  byId('today-status').textContent = status === 'ON CAMPUS' ? 'Day in recorded' : status === 'DAY COMPLETE' ? 'Attendance complete' : 'Not checked in';
  for (const type of ['short', 'lunch']) {
    const record = today.breaks.find(item => item.type === type);
    const state = byId(`${type}-state`);
    const row = document.querySelector(`[data-break="${type}"]`);
    const start = row.querySelector(`[data-break-start="${type}"]`);
    const end = row.querySelector(`[data-break-end="${type}"]`);
    row.classList.toggle('has-break', Boolean(record));
    state.textContent = record ? record.endedAt ? `${formatTime(record.startedAt)} — ${formatTime(record.endedAt)}` : `STARTED ${formatTime(record.startedAt)}` : 'NOT TAKEN';
    start.hidden = Boolean(record);
    end.hidden = !record || Boolean(record.endedAt);
  }
  updateButtons();
}
function updateButtons() {
  if (!currentUser || !today) return;
  const { minutes } = timeParts(istNow());
  byId('day-in-button').disabled = Boolean(today.dayInAt || today.dayOutAt) || minutes <= 535 || minutes >= 960;
  byId('day-out-button').disabled = !today.dayInAt || Boolean(today.dayOutAt) || minutes <= 960 || today.breaks.some(item => !item.endedAt);
  for (const type of ['short', 'lunch']) {
    const [start, end] = type === 'short' ? [620, 630] : [780, 840];
    const record = today.breaks.find(item => item.type === type);
    const inWindow = minutes >= start && minutes <= end;
    const canStart = !record && Boolean(today.dayInAt) && !today.dayOutAt && inWindow;
    const canEnd = Boolean(record && !record.endedAt) && inWindow;
    document.querySelector(`[data-break-start="${type}"]`).disabled = !canStart;
    document.querySelector(`[data-break-end="${type}"]`).disabled = !canEnd;
  }
}
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser does not support location.')); return; }
    navigator.geolocation.getCurrentPosition(position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }), error => {
      const messages = { 1: 'Location permission is blocked. Allow location in your browser settings, then try again.', 2: 'Your current location is unavailable. Check your device settings and try again.', 3: 'Location lookup took too long. Please try again.' };
      reject(new Error(messages[error.code] || 'Could not read your location.'));
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  });
}
async function submitAttendance(action, breakType) {
  const message = byId('student-message');
  message.hidden = true;
  const button = action === 'day_in' ? byId('day-in-button') : action === 'day_out' ? byId('day-out-button') : document.querySelector(`[data-break-${action === 'break_start' ? 'start' : 'end'}="${breakType}"]`);
  button.disabled = true;
  try {
    const needsLocation = action === 'day_in' || (breakType === 'lunch' && action.startsWith('break_'));
    if (action === 'day_in') toast(message, 'Requesting location permission. Choose Allow in your browser to verify your campus location.');
    const location = needsLocation ? await getLocation() : {};
    const result = await request('/api/student/action', { method: 'POST', body: JSON.stringify({ action, breakType, ...location }) });
    today = result.today;
    renderToday();
    toast(message, action === 'day_in' ? 'Day in recorded. Your campus location has been verified.' : 'Attendance update recorded.');
    if (action === 'day_in') loadMonth();
  } catch (error) {
    toast(message, error.message, true);
    updateButtons();
  }
}
async function refreshStudent() {
  try {
    const result = await request('/api/me');
    serverOffset = Date.parse(result.now) - Date.now();
    today = result.today;
    renderToday();
  } catch (error) {
    toast(byId('student-message'), error.message, true);
  }
}
function changeMonth(offset) {
  const [year, month] = selectedMonth.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + offset, 1));
  selectedMonth = `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
  loadMonth();
}
async function loadMonth() {
  try {
    const result = await request(`/api/student/month?month=${encodeURIComponent(selectedMonth)}`);
    renderCalendar(result);
  } catch (error) {
    toast(byId('student-message'), error.message, true);
  }
}
function renderCalendar(result) {
  const [year, month] = result.month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const currentDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(istNow());
  const attendanceDays = new Map(result.days.map(day => [day.work_date, day]));
  const grid = byId('calendar-grid');
  grid.replaceChildren();
  byId('month-label').textContent = monthFormatter.format(new Date(Date.UTC(year, month - 1, 1)));
  byId('attendance-percent').textContent = result.percentage.toFixed(1).replace(/\.0$/, '');
  byId('attendance-count').textContent = `${result.presentDays} of ${result.scheduledDays} days`;
  for (const name of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
    const cell = document.createElement('span');
    cell.className = 'calendar-cell weekday';
    cell.textContent = name;
    grid.append(cell);
  }
  for (let blank = 0; blank < firstDay; blank += 1) {
    const cell = document.createElement('span');
    cell.className = 'calendar-cell';
    cell.setAttribute('aria-hidden', 'true');
    grid.append(cell);
  }
  const elapsedDay = result.month === currentDate.slice(0, 7) ? Number(currentDate.slice(8, 10)) : result.month < currentDate.slice(0, 7) ? dayCount : 0;
  for (let day = 1; day <= dayCount; day += 1) {
    const cell = document.createElement('span');
    const dateText = `${result.month}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const past = dateText <= currentDate;
    cell.className = 'calendar-cell';
    if (dateText === currentDate) cell.classList.add('today');
    if (attendanceDays.has(dateText)) cell.classList.add('present');
    else if (past && weekday !== 0 && weekday !== 6) cell.classList.add('absent');
    else if (weekday === 0 || weekday === 6) cell.classList.add('weekend');
    else cell.classList.add('upcoming');
    cell.textContent = String(day);
    cell.setAttribute('aria-label', `${dateText}: ${attendanceDays.has(dateText) ? 'present' : past && weekday !== 0 && weekday !== 6 ? 'not recorded' : 'upcoming'}`);
    grid.append(cell);
  }
  byId('month-prev').disabled = result.month <= '2020-01';
  byId('month-next').disabled = result.month >= currentDate.slice(0, 7);
}
async function saveProfile(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  clearError(byId('profile-error'));
  try {
    const result = await request('/api/student/profile', { method: 'PATCH', body: JSON.stringify({ fullName: byId('profile-name').value, email: byId('profile-email').value, phone: byId('profile-phone').value }) });
    currentUser.fullName = result.fullName;
    currentUser.email = result.email;
    currentUser.phone = result.phone;
    byId('student-name').textContent = result.fullName;
    byId('profile-dialog').close();
    toast(byId('student-message'), 'Your profile has been updated.');
  } catch (error) {
    showError(byId('profile-error'), error.message);
  } finally {
    button.disabled = false;
  }
}
function localDateInputValue() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function initializeAdmin(user) {
  byId('admin-name').textContent = user.full_name || user.fullName;
  byId('date-picker').value = localDateInputValue();
  byId('date-picker').addEventListener('change', loadAdminRecords);
  byId('refresh-button').addEventListener('click', loadAdminRecords);
  byId('export-button').addEventListener('click', exportAll);
  loadAdminRecords();
  refreshTimer = setInterval(loadAdminRecords, 60000);
}
function cell(text, className = '') {
  const element = document.createElement('td');
  if (className) element.className = className;
  element.textContent = text || '—';
  return element;
}
function renderAdminRecords(result) {
  const table = byId('records-body');
  table.replaceChildren();
  byId('student-total').textContent = String(result.students.length).padStart(2, '0');
  byId('admin-date-title').textContent = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${result.date}T12:00:00Z`));
  for (const student of result.students) {
    const row = document.createElement('tr');
    row.append(cell(student.full_name, 'student-name'));
    row.append(cell([student.email, student.phone].filter(Boolean).join(' · '), 'student-contact'));
    row.append(cell(formatTime(student.day_in_at)));
    row.append(cell(student.short_break_start ? `${formatTime(student.short_break_start)} – ${formatTime(student.short_break_end)}` : '—'));
    row.append(cell(student.lunch_start ? `${formatTime(student.lunch_start)} – ${formatTime(student.lunch_end)}` : '—'));
    row.append(cell(formatTime(student.day_out_at)));
    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `record-status ${student.day_out_at ? 'complete' : student.day_in_at ? 'progress' : ''}`;
    badge.textContent = student.day_out_at ? 'COMPLETE' : student.day_in_at ? 'IN PROGRESS' : 'ABSENT';
    statusCell.append(badge);
    row.append(statusCell);
    table.append(row);
  }
  byId('records-message').hidden = true;
}
async function loadAdminRecords() {
  const message = byId('admin-message');
  message.hidden = true;
  try {
    const date = byId('date-picker').value || localDateInputValue();
    const result = await request(`/api/admin/attendance?date=${encodeURIComponent(date)}`);
    renderAdminRecords(result);
  } catch (error) {
    toast(message, error.message, true);
  }
}
async function exportAll() {
  const button = byId('export-button');
  button.disabled = true;
  try {
    const blob = await request('/api/admin/export');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jit-attendance.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    toast(byId('admin-message'), error.message, true);
  } finally {
    button.disabled = false;
  }
}

boot();
