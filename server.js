require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const wa = require('./whatsapp_manager');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const telegram = require('./telegram');

const app = express();
const PORT = process.env.PORT || 1901;

app.set('trust proxy', 1);

// ============================================
// FOLDER DATA & SESSION
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/home/data' : __dirname;
const SESSION_DIR = path.join(DATA_DIR, 'sessions-store');

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log('📁 Data dir   :', DATA_DIR);
  console.log('📁 Session dir:', SESSION_DIR);
} catch (e) { console.error('❌ Gagal bikin folder:', e.message); }

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

let useFileStore = false;
try {
  if (fs.existsSync(SESSION_DIR)) {
    const testFile = path.join(SESSION_DIR, '.write-test-' + Date.now());
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    useFileStore = true;
    console.log('✅ SESSION_DIR writable');
  }
} catch (e) { console.error('⚠️ SESSION_DIR gak writable:', e.message); }

const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'sewawa_secret_2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false, sameSite: 'lax', httpOnly: true }
};

if (useFileStore) {
  sessionOptions.store = new FileStore({
    path: SESSION_DIR, retries: 0, ttl: 7 * 24 * 60 * 60, reapInterval: 3600, logFn: () => {}
  });
}

app.use(session(sessionOptions));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// HELPERS
// ============================================
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || row.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function getWithdrawWithUser(wdId) {
  return new Promise((resolve) => {
    db.get(
      'SELECT w.*, u.name as user_name, u.email as user_email, u.telegram_username, ' +
      '(SELECT telegram_id FROM user_wallets WHERE user_id = u.id) as telegram_id ' +
      'FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = ?',
      [wdId], (err, row) => resolve(row || null)
    );
  });
}

// ============================================
// WITHDRAW SCHEDULE — WIB (UTC+7)
// ============================================
const WITHDRAW_WINDOWS = [
  { start: '10:30', end: '13:00', label: '10.30 - 13.00 Siang' },
  { start: '22:00', end: '01:00', label: '22.00 - 01.00 Malam' }
];

function getWIBMinutes() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(now);
  let h = 0, m = 0;
  parts.forEach(p => {
    if (p.type === 'hour') h = parseInt(p.value);
    if (p.type === 'minute') m = parseInt(p.value);
  });
  return h * 60 + m;
}

function isWithdrawOpen() {
  const total = getWIBMinutes();
  if (total >= 630 && total < 780) return true;   // 10:30 - 13:00
  if (total >= 1320 || total < 60) return true;    // 22:00 - 01:00
  return false;
}

function getNextWithdrawWindow() {
  const total = getWIBMinutes();
  if (total < 630) return { start: '10:30', when: 'hari ini' };
  if (total >= 780 && total < 1320) return { start: '22:00', when: 'hari ini' };
  if (total >= 60 && total < 630) return { start: '10:30', when: 'hari ini' };
  return { start: '10:30', when: 'besok' };
}

// ============================================
// TELEGRAM WEBHOOK
// ============================================
app.post('/api/telegram/webhook', async (req, res) => {
  res.json({ ok: true });
  try {
    const update = req.body;
    if (!update || !update.callback_query) return;
    const cq = update.callback_query;
    const data = cq.data || '';
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const messageId = cq.message && cq.message.message_id;
    const callbackId = cq.id;

    if (data.startsWith('wd_acc_')) {
      await handleApproveFromTelegram(data.replace('wd_acc_', ''), chatId, messageId, callbackId);
    } else if (data.startsWith('wd_rej_')) {
      await handleRejectFromTelegram(data.replace('wd_rej_', ''), chatId, messageId, callbackId);
    } else {
      await telegram.answerCallbackQuery(callbackId, 'Aksi tidak dikenal');
    }
  } catch (e) { console.error('Webhook:', e.message); }
});

async function handleApproveFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    if (!isWithdrawOpen()) {
      const next = getNextWithdrawWindow();
      return telegram.answerCallbackQuery(callbackId, 'Di luar jam proses! Buka ' + next.when + ' jam ' + next.start + ' WIB', true);
    }
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, 'WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, 'WD sudah di-' + wdInfo.status, true);
    await wa.approveWithdraw(wdId, 'Approved via Telegram');
    await telegram.answerCallbackQuery(callbackId, 'Withdraw di-ACC!');
    const newText = '<b>WITHDRAW DI-ACC</b>\n\n' +
      '👤 ' + (wdInfo.user_name || 'Unknown') + '\n' +
      '💰 ' + telegram.rp(wdInfo.amount) + '\n' +
      '💳 ' + String(wdInfo.method || '').toUpperCase() + '\n\n' +
      '✅ APPROVED\n🕐 ' + new Date().toLocaleString('id-ID');
    await telegram.editMessageText(chatId, messageId, newText);
    await telegram.notifyChannelWithdrawSuccess(wdInfo);
  } catch (e) { try { await telegram.answerCallbackQuery(callbackId, 'Error', true); } catch (_) {} }
}

async function handleRejectFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, 'WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, 'WD sudah di-' + wdInfo.status, true);
    await wa.rejectWithdraw(wdId, 'Ditolak via Telegram');
    await telegram.answerCallbackQuery(callbackId, 'Withdraw ditolak');
    const newText = '<b>WITHDRAW DITOLAK</b>\n\n' +
      '👤 ' + (wdInfo.user_name || 'Unknown') + '\n' +
      '💰 ' + telegram.rp(wdInfo.amount) + '\n\n' +
      '❌ REJECTED\n🕐 ' + new Date().toLocaleString('id-ID');
    await telegram.editMessageText(chatId, messageId, newText);
  } catch (e) { try { await telegram.answerCallbackQuery(callbackId, 'Error', true); } catch (_) {} }
}

// ============================================
// AUTH
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('🔑 Login:', email);
    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

    db.get('SELECT * FROM users WHERE email = ? OR name = ?', [email, email], async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(401).json({ error: 'Email atau password salah' });
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Email atau password salah' });

      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.userRole = user.role;
      req.session.save((e) => {
        if (e) return res.status(500).json({ error: 'Gagal simpan session' });
        console.log('✅ Login:', user.email);
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role } });
      });
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, username, phone, password, ref } = req.body;
    console.log('📝 Register:', email);
    if (!email || !username || !phone || !password) return res.status(400).json({ error: 'Semua field wajib diisi' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
    if (username.length < 5 || username.length > 20) return res.status(400).json({ error: 'Username 5-20 karakter' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username hanya huruf/angka/_' });
    if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Nomor WA tidak valid' });
    if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });

    db.get('SELECT id FROM users WHERE email = ? OR name = ?', [email, username], async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) return res.status(400).json({ error: 'Email/username sudah terdaftar' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const referralCode = username.substring(0, 4).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

      let referrerId = null;
      if (ref) {
        const refRow = await new Promise((resolve) => {
          db.get('SELECT id FROM users WHERE referral_code = ?', [ref], (err, r) => resolve(r || null));
        });
        if (refRow) referrerId = refRow.id;
      }

      db.run(
        'INSERT INTO users (email, password, name, phone, role, referral_code, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [email, hashedPassword, username, phone, 'user', referralCode, referrerId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const newUserId = this.lastID;
          console.log('✅ User baru:', email, 'ID:', newUserId);

          if (referrerId) {
            db.run('UPDATE users SET balance = balance + 50, total_referral = total_referral + 1 WHERE id = ?', [referrerId]);
            db.run('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
              [referrerId, 50, 'bonus', 'Referral dari ' + username]);
            db.run('INSERT INTO referrals (referrer_id, referred_id, bonus_amount, status) VALUES (?, ?, ?, ?)',
              [referrerId, newUserId, 50, 'completed']);
          }

          res.json({ success: true, message: 'Akun berhasil dibuat.' });
        }
      );
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.get('/api/me', requireAuth, (req, res) => {
  db.get('SELECT id, email, name, phone, balance, role, telegram_username FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(user);
  });
});

app.post('/api/user/telegram', requireAuth, (req, res) => {
  const clean = String(req.body.telegram_username || '').replace('@', '').trim();
  if (!clean) return res.status(400).json({ error: 'Wajib diisi' });
  db.run('UPDATE users SET telegram_username = ? WHERE id = ?', [clean, req.session.userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, telegram_username: clean });
  });
});

// ============================================
// REFERRAL
// ============================================
app.get('/api/referral', requireAuth, (req, res) => {
  db.get('SELECT referral_code, total_referral FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'User tidak ditemukan' });
    const baseUrl = req.protocol + '://' + req.get('host');
    res.json({
      code: row.referral_code,
      link: baseUrl + '/register?ref=' + row.referral_code,
      total: row.total_referral || 0
    });
  });
});

app.get('/api/referral/history', requireAuth, (req, res) => {
  db.all(
    'SELECT r.*, u.name as referred_name, u.email as referred_email, u.created_at ' +
    'FROM referrals r JOIN users u ON r.referred_id = u.id ' +
    'WHERE r.referrer_id = ? ORDER BY r.created_at DESC',
    [req.session.userId],
    (err, rows) => { if (err) return res.status(500).json({ error: err.message }); res.json(rows || []); }
  );
});

// ============================================
// FORGOT / RESET PASSWORD
// ============================================
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email wajib' });
    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.json({ success: true, message: 'Jika email terdaftar, link reset dikirim.' });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      db.run('INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)', [email, token, expiresAt], async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        const baseUrl = req.protocol + '://' + req.get('host');
        const resetLink = baseUrl + '/reset-password?token=' + token;
        try {
          await transporter.sendMail({
            from: '"SewaWA" <' + (process.env.SMTP_USER || 'noreply@sewawa.cloud') + '>',
            to: email,
            subject: 'Reset Password SewaWA',
            html: '<div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;">' +
              '<h2 style="color:#3B82F6;">Reset Password</h2>' +
              '<p>Klik link di bawah:</p>' +
              '<div style="text-align:center;margin:30px 0;">' +
              '<a href="' + resetLink + '" style="background:#3B82F6;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:600;">Reset Password</a>' +
              '</div>' +
              '<p>' + resetLink + '</p>' +
              '<p style="font-size:12px;color:#888;">Berlaku 1 jam.</p>' +
              '</div>'
          });
        } catch (e) { console.error('Email:', e.message); }
        res.json({ success: true, message: 'Link reset telah dikirim.' });
      });
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token dan password wajib' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });
    db.get('SELECT email FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0', [token], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(400).json({ error: 'Token tidak valid' });
      const hash = bcrypt.hashSync(newPassword, 10);
      db.run('UPDATE users SET password = ? WHERE email = ?', [hash, row.email], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE password_resets SET used = 1 WHERE token = ?', [token], () => {
          res.json({ success: true, message: 'Password berhasil direset.' });
        });
      });
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// SITES / DATABASES
// ============================================
app.get('/api/sites', requireAuth, (req, res) => {
  db.all('SELECT * FROM sites WHERE is_active = 1 ORDER BY id ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/admin/sites', requireAuth, requireAdmin, (req, res) => {
  db.all(
    'SELECT s.*, ' +
    '(SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id) as total_contacts, ' +
    '(SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id AND status = "sent") as sent_contacts, ' +
    '(SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id AND (status = "available" OR status IS NULL)) as available_contacts, ' +
    '(SELECT COUNT(*) FROM broadcasts WHERE site_id = s.id AND status = "completed") as total_campaigns, ' +
    '(SELECT COUNT(*) FROM devices WHERE site_id = s.id) as total_devices, ' +
    '(SELECT COUNT(*) FROM transactions WHERE site_id = s.id AND type = "profit") as total_chat, ' +
    '(SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE site_id = s.id AND type = "profit") as total_profit ' +
    'FROM sites s WHERE s.is_active = 1 ORDER BY s.id ASC',
    (err, rows) => { if (err) return res.status(500).json({ error: err.message }); res.json(rows || []); }
  );
});

app.get('/api/admin/sites/:id/users-chat', requireAuth, requireAdmin, (req, res) => {
  const siteId = req.params.id;
  db.all(`
    SELECT u.id, u.name, u.email,
      COUNT(t.id) as total_chat,
      COALESCE(SUM(t.amount), 0) as total_profit
    FROM users u
    LEFT JOIN transactions t ON t.user_id = u.id AND t.type = 'profit' AND t.site_id = ?
    WHERE u.role != 'admin'
    GROUP BY u.id
    HAVING total_chat > 0
    ORDER BY total_chat DESC
  `, [siteId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/sites', requireAuth, requireAdmin, (req, res) => {
  const { name, template_text, template_photo, button_text, button_url } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama database wajib' });
  db.run('INSERT INTO sites (name, template_text, template_photo, button_text, button_url, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    [name, template_text || '', template_photo || '', button_text || '', button_url || ''],
    function (err) { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true, id: this.lastID }); });
});

app.put('/api/admin/sites/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, template_text, template_photo, button_text, button_url } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (template_text !== undefined) { updates.push('template_text = ?'); params.push(template_text); }
  if (template_photo !== undefined) { updates.push('template_photo = ?'); params.push(template_photo); }
  if (button_text !== undefined) { updates.push('button_text = ?'); params.push(button_text); }
  if (button_url !== undefined) { updates.push('button_url = ?'); params.push(button_url); }
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada perubahan' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.run('UPDATE sites SET ' + updates.join(', ') + ' WHERE id = ?', params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.delete('/api/admin/sites/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === '1') return res.status(400).json({ error: 'Database 1 tidak bisa dihapus' });
  db.run('UPDATE sites SET is_active = 0 WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/admin/sites/:id/contacts', requireAuth, requireAdmin, (req, res) => {
  const siteId = req.params.id;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'all';
  const search = req.query.search || '';

  let where = 'WHERE site_id = ?';
  const params = [siteId];
  if (status === 'sent') where += ' AND status = "sent"';
  else if (status === 'available') where += ' AND (status = "available" OR status IS NULL)';
  else if (status === 'processing') where += ' AND status = "processing"';
  if (search) { where += ' AND phone LIKE ?'; params.push('%' + search + '%'); }

  db.get('SELECT COUNT(*) as total FROM master_contacts ' + where, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT * FROM master_contacts ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?',
      [...params, limit, offset], (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ total: countRow.total, page, limit, totalPages: Math.ceil(countRow.total / limit) || 1, data: rows || [] });
      });
  });
});

app.post('/api/admin/sites/:id/delete-phones', requireAuth, requireAdmin, (req, res) => {
  const { phones } = req.body;
  if (!phones || !Array.isArray(phones) || phones.length === 0) return res.status(400).json({ error: 'Tidak ada nomor' });
  const ph = phones.map(() => '?').join(',');
  db.run('DELETE FROM master_contacts WHERE site_id = ? AND phone IN (' + ph + ')',
    [req.params.id, ...phones], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
});

app.post('/api/admin/sites/:id/reset-sent', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE master_contacts SET status = "available", sent_at = NULL WHERE site_id = ? AND status = "sent"',
    [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, reset: this.changes });
    });
});

app.post('/api/admin/sites/:id/delete-sent', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM master_contacts WHERE site_id = ? AND status = "sent"',
    [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
});

app.post('/api/admin/sites/:id/delete-bulk', requireAuth, requireAdmin, (req, res) => {
  const { status = 'all', limit = 1000, order = 'DESC' } = req.body || {};
  const siteId = req.params.id;
  const safeLimit = Math.min(Math.max(parseInt(limit) || 1000, 1), 50000);
  const safeOrder = (String(order).toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

  let where = 'site_id = ?';
  const params = [siteId];
  if (status === 'sent') where += ' AND status = "sent"';
  else if (status === 'available') where += ' AND (status = "available" OR status IS NULL)';
  else if (status === 'processing') where += ' AND status = "processing"';

  const sql = 'DELETE FROM master_contacts WHERE id IN (SELECT id FROM master_contacts WHERE ' + where + ' ORDER BY id ' + safeOrder + ' LIMIT ?)';

  db.run(sql, [...params, safeLimit], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

app.post('/api/admin/sites/:id/delete-all', requireAuth, requireAdmin, (req, res) => {
  const { status = 'all' } = req.body || {};
  const siteId = req.params.id;

  let where = 'site_id = ?';
  const params = [siteId];
  if (status === 'sent') where += ' AND status = "sent"';
  else if (status === 'available') where += ' AND (status = "available" OR status IS NULL)';
  else if (status === 'processing') where += ' AND status = "processing"';

  db.run('DELETE FROM master_contacts WHERE ' + where, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
  });
});

// ============================================
// IMPORT CONTACTS
// ============================================
app.post('/api/admin/import-contacts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { siteId, numbers } = req.body;
    if (!siteId) return res.status(400).json({ error: 'Database wajib dipilih' });
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) return res.status(400).json({ error: 'Tidak ada nomor' });
    if (numbers.length > 10000) return res.status(400).json({ error: 'Maksimal 10.000 nomor' });

    const valid = numbers.map(n => String(n).trim().replace(/[^0-9]/g, '')).filter(n => n.length >= 5 && n.length <= 20);
    if (valid.length === 0) return res.status(400).json({ error: 'Tidak ada nomor valid' });

    let inserted = 0, skipped = 0;
    const BS = 500;
    for (let i = 0; i < valid.length; i += BS) {
      const batch = valid.slice(i, i + BS);
      const placeholders = batch.map(() => '(?, ?, ?, "available")').join(',');
      const params = [];
      batch.forEach(num => { params.push(siteId, num, num); });
      const result = await new Promise((resolve) => {
        db.run('INSERT OR IGNORE INTO master_contacts (site_id, phone, name, status) VALUES ' + placeholders, params, function (err) {
          resolve(err ? 0 : this.changes);
        });
      });
      inserted += result;
      skipped += (batch.length - result);
    }
    console.log('✅ Import DB' + siteId + ': ' + inserted + ' baru, ' + skipped + ' skip');
    res.json({ success: true, inserted, skipped, total: valid.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// DEVICES
// ============================================
app.get('/api/devices/summary', requireAuth, (req, res) => {
  const userId = req.session.userId;

  db.all('SELECT id, status FROM devices WHERE user_id = ?', [userId], (err, devices) => {
    if (err) return res.status(500).json({ error: err.message });
    const totalDevices = (devices || []).length;
    const connectedDevices = (devices || []).filter(d => d.status === 'connected').length;

    db.get('SELECT COUNT(*) as total FROM master_contacts WHERE status = "available" OR status IS NULL', (err2, masterRow) => {
      db.get(`
        SELECT COUNT(*) as total_chat, COALESCE(SUM(amount), 0) as total_profit
        FROM transactions WHERE user_id = ? AND type = 'profit'
      `, [userId], (err3, trx) => {
        db.get(`
          SELECT COUNT(*) as total_campaigns, COALESCE(SUM(b.failed), 0) as total_failed
          FROM broadcasts b JOIN devices d ON b.device_id = d.id
          WHERE d.user_id = ? AND b.status = 'completed'
        `, [userId], (err4, bc) => {
          db.get('SELECT COUNT(DISTINCT c.phone) as unique_total FROM contacts c JOIN devices d ON c.device_id = d.id WHERE d.user_id = ?',
            [userId], (err5, contactRow) => {
              const totalChat = trx ? trx.total_chat : 0;
              const totalProfit = trx ? trx.total_profit : 0;
              res.json({
                master_total: masterRow ? masterRow.total : 0,
                devices_total: totalDevices,
                devices_connected: connectedDevices,
                total_sent: totalChat,
                total_chat: totalChat,
                total_profit: totalProfit,
                total_failed: bc ? bc.total_failed : 0,
                total_campaigns: bc ? bc.total_campaigns : 0,
                total_recipients: 0,
                unique_contacts: contactRow ? contactRow.unique_total : 0,
                avg_speed: 0
              });
            });
        });
      });
    });
  });
});

app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const devices = await wa.getDevices(req.session.userId);
    const enriched = devices.map(d => ({ ...d, real_status: wa.getStatus(d.id) || d.status, has_qr: wa.qrCodes.has(d.id) }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices', requireAuth, async (req, res) => {
  try {
    const { name, phone, siteId } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama device wajib diisi' });
    const finalSiteId = parseInt(siteId) || 1;
    const site = await new Promise((resolve) => {
      db.get('SELECT id FROM sites WHERE id = ? AND is_active = 1', [finalSiteId], (err, row) => resolve(row));
    });
    if (!site) return res.status(400).json({ error: 'Database tidak valid' });

    const id = uuidv4().substring(0, 10);
    const device = await wa.createDevice(id, req.session.userId, name, phone || '', finalSiteId);
    await wa.startDevice(id);
    res.json({ ...device, site_id: finalSiteId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/start', requireAuth, async (req, res) => {
  try { res.json(await wa.startDevice(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/stop', requireAuth, async (req, res) => {
  try { res.json(await wa.stopDevice(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  try { await wa.deleteDevice(req.params.id, req.session.userId); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/qr', requireAuth, async (req, res) => {
  try { const qr = await wa.getQR(req.params.id); res.json({ qr: qr || null }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/pairing', requireAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Nomor HP wajib' });
    const device = await wa.getDevice(req.params.id);
    if (!device || device.user_id !== req.session.userId) return res.status(403).json({ error: 'Bukan milik Anda' });
    const result = await wa.requestPairingCode(req.params.id, phoneNumber);
    res.json({ success: true, code: result.code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/devices/:id/mode', requireAuth, async (req, res) => {
  try { await wa.updateDeviceMode(req.params.id, req.body.mode); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/devices/:id/site', requireAuth, async (req, res) => {
  try {
    const { siteId } = req.body;
    if (!siteId) return res.status(400).json({ error: 'Database wajib dipilih' });
    const device = await wa.getDevice(req.params.id);
    if (!device || device.user_id !== req.session.userId) return res.status(403).json({ error: 'Bukan milik Anda' });
    const site = await new Promise((resolve) => {
      db.get('SELECT id, name FROM sites WHERE id = ? AND is_active = 1', [siteId], (err, row) => resolve(row));
    });
    if (!site) return res.status(400).json({ error: 'Database tidak valid' });
    db.run('UPDATE devices SET site_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [siteId, req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('DELETE FROM contacts WHERE device_id = ?', [req.params.id], () => {
        res.json({ success: true, site_id: siteId, site_name: site.name });
      });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/contacts', requireAuth, async (req, res) => {
  try {
    const device = await wa.getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });
    res.json(await wa.getContacts(req.params.id, device.site_id || 1));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// BROADCAST
// ============================================
app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const { deviceId, speed } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib' });

    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== req.session.userId) return res.status(403).json({ error: 'Bukan milik Anda' });

    const status = wa.getStatus(deviceId);
    if (status !== 'connected') return res.status(400).json({ error: 'Device tidak terhubung' });

    const existing = wa.getProgress(deviceId);
    if (existing && existing.running) {
      return res.status(400).json({ error: 'Blast sedang berjalan untuk device ini' });
    }

    const dbWithNumbers = await new Promise((resolve) => {
      db.get('SELECT site_id, COUNT(*) as total FROM master_contacts WHERE status = "available" OR status IS NULL GROUP BY site_id ORDER BY total DESC LIMIT 1',
        (err, row) => resolve(row));
    });

    console.log('🔍 DB available:', dbWithNumbers);

    if (!dbWithNumbers || dbWithNumbers.total === 0) {
      return res.status(400).json({ error: 'Belum ada nomor tersedia.', available_count: 0 });
    }

    const siteId = dbWithNumbers.site_id;
    if (device.site_id !== siteId) {
      await new Promise((resolve) => {
        db.run('UPDATE devices SET site_id = ? WHERE id = ?', [siteId, deviceId], () => resolve());
      });
      console.log('🔄 Auto-switch device ke DB' + siteId);
    }

    const site = await new Promise((resolve) => {
      db.get('SELECT id, name, template_text, template_photo, button_text, button_url FROM sites WHERE id = ?', [siteId], (err, row) => resolve(row));
    });
    if (!site || !site.template_text) return res.status(400).json({ error: 'Database belum ada template.' });

    const availablePhones = await new Promise((resolve) => {
      db.all('SELECT phone FROM master_contacts WHERE site_id = ? AND (status = "available" OR status IS NULL) ORDER BY id ASC LIMIT 10000',
        [siteId], (err, rows) => resolve(rows || []));
    });
    const recipients = availablePhones.map(r => r.phone).filter(p => p);

    const userInfo = await new Promise((resolve) => {
      db.get('SELECT id, name, email, telegram_username FROM users WHERE id = ?', [req.session.userId], (err, row) => resolve(row));
    });

    const speedMs = speed || 1000;
    const estSec = Math.ceil((recipients.length * speedMs) / 1000);
    const estimation = estSec > 60 ? Math.ceil(estSec / 60) + ' menit' : estSec + ' detik';

    telegram.notifyAdminBlastStart({
      user_id: req.session.userId,
      user_name: userInfo ? userInfo.name : 'Unknown',
      user_email: userInfo ? userInfo.email : '',
      telegram_username: userInfo ? userInfo.telegram_username : '',
      device_id: deviceId, device_name: device.name,
      site_name: site.name, total_contacts: recipients.length,
      speed_ms: speedMs, estimation: estimation
    }).catch(() => {});

    console.log('📤 Blast DB' + siteId + ' (' + site.name + '): ' + recipients.length + ' nomor');

    res.json({ status: 'started', total: recipients.length, site_id: siteId, site_name: site.name });

    const startTime = Date.now();
    wa.sendBroadcast(
      deviceId, site.template_text, recipients, req.session.userId,
      speedMs, siteId, site.template_photo || null,
      site.button_text || '', site.button_url || ''
    ).then(async (result) => {
      const duration = (Date.now() - startTime) / 1000;
      const durationStr = duration > 60 ? Math.ceil(duration / 60) + ' menit' : Math.ceil(duration) + ' detik';
      const pricePerChat = await wa.getPricePerChat();

      telegram.notifyAdminBlastFinish({
        user_id: req.session.userId,
        user_name: userInfo ? userInfo.name : 'Unknown',
        telegram_username: userInfo ? userInfo.telegram_username : '',
        device_id: deviceId, device_name: device.name,
        site_name: site.name, speed_ms: speedMs, duration: durationStr,
        sent: result.sent || 0, failed: result.failed || 0, purged: result.purged || 0,
        price_per_chat: pricePerChat
      }).catch(() => {});
      console.log('📊 Background blast selesai:', result);
    }).catch((err) => {
      console.error('❌ Background blast error:', err.message);
    });
  } catch (error) { console.error('❌ Broadcast:', error); res.status(500).json({ error: error.message }); }
});

app.get('/api/broadcast/progress/:deviceId', requireAuth, (req, res) => {
  const p = wa.getProgress(req.params.deviceId);
  if (!p) return res.json({ running: false });
  const percent = p.total > 0 ? Math.floor((p.sent / p.total) * 100) : 0;
  res.json({ running: p.status === 'running', ...p, percent });
});

app.get('/api/broadcast/history', requireAuth, async (req, res) => {
  try { res.json(await wa.getBroadcastHistory(req.session.userId, req.query.deviceId || null)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// STATS
// ============================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const stats = await new Promise((resolve) => {
      db.get(`
        SELECT
          (SELECT COUNT(*) FROM devices WHERE user_id = ?) as total_devices,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'connected') as online,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'disconnected') as offline,
          (SELECT COALESCE(balance, 0) FROM users WHERE id = ?) as balance,
          (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type = 'profit') as revenue,
          (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND type = 'profit') as total_chat
      `, [userId, userId, userId, userId, userId, userId], (err, row) => resolve(row || {}));
    });

    const bcast = await new Promise((resolve) => {
      db.get(`
        SELECT COUNT(*) as total_campaigns, COALESCE(SUM(b.failed), 0) as total_failed
        FROM broadcasts b JOIN devices d ON b.device_id = d.id
        WHERE d.user_id = ? AND b.status = 'completed'
      `, [userId], (err, row) => resolve(row || {}));
    });

    res.json({
      total_devices: stats.total_devices || 0,
      online: stats.online || 0,
      offline: stats.offline || 0,
      balance: stats.balance || 0,
      revenue: stats.revenue || 0,
      total_sent: stats.total_chat || 0,
      total_chat: stats.total_chat || 0,
      total_failed: bcast.total_failed || 0,
      total_campaigns: bcast.total_campaigns || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message, total_devices: 0, online: 0, offline: 0, balance: 0, revenue: 0, total_sent: 0, total_chat: 0 });
  }
});

// ============================================
// SETTINGS
// ============================================
app.get('/api/settings', requireAuth, (req, res) => {
  db.all('SELECT * FROM settings', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const s = {};
    (rows || []).forEach(r => s[r.key] = r.value);
    res.json(s);
  });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const { promo_text, price_per_chat, min_withdraw } = req.body;
    const updates = [];
    if (promo_text !== undefined) updates.push(['promo_text', promo_text]);
    if (price_per_chat) updates.push(['price_per_chat', String(price_per_chat)]);
    if (min_withdraw) updates.push(['min_withdraw', String(min_withdraw)]);
    for (const [k, v] of updates) {
      db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [k, v]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  db.all('SELECT key, value FROM settings', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const out = {};
    (rows || []).forEach(r => { out[r.key] = r.value; });
    res.json(out);
  });
});

app.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const { price_per_chat, min_withdraw } = req.body || {};
  const updates = [];
  if (price_per_chat !== undefined) updates.push(['price_per_chat', String(price_per_chat)]);
  if (min_withdraw !== undefined) updates.push(['min_withdraw', String(min_withdraw)]);
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada data' });

  let done = 0;
  let errored = null;
  for (const [k, v] of updates) {
    db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [k, v], (e) => {
      if (e) errored = e;
      done++;
      if (done === updates.length) {
        if (errored) return res.status(500).json({ error: errored.message });
        res.json({ success: true });
      }
    });
  }
});

// ============================================
// WALLET & PAYMENT
// ============================================
app.get('/api/wallet', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT * FROM user_wallets WHERE user_id = ?', [userId], (err, wallet) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT balance FROM users WHERE id = ?', [userId], (err2, user) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ balance: (user && user.balance) || 0, wallet: wallet || null });
    });
  });
});

app.get('/api/wallet/payment', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT * FROM user_wallets WHERE user_id = ?', [userId], (err, wallet) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!wallet) return res.json(null);
    db.get('SELECT telegram_username FROM users WHERE id = ?', [userId], (err2, user) => {
      res.json({
        telegram_username: user ? user.telegram_username : '',
        telegram_id: wallet.telegram_id || '',
        method: wallet.method || '',
        bank_name: wallet.bank_name || '',
        account_number: wallet.bank_account || '',
        account_name: wallet.bank_holder || ''
      });
    });
  });
});

app.post('/api/wallet/payment', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const { telegram_username, telegram_id, method, bank_name, account_number, account_name } = req.body;

  if (!telegram_username) return res.status(400).json({ error: 'Username Telegram wajib' });
  if (!telegram_id) return res.status(400).json({ error: 'Telegram ID wajib' });
  if (!method) return res.status(400).json({ error: 'Metode wajib' });
  if (!account_number) return res.status(400).json({ error: 'Nomor akun wajib' });
  if (!account_name) return res.status(400).json({ error: 'Nama pemilik wajib' });

  db.run('UPDATE users SET telegram_username = ? WHERE id = ?', [String(telegram_username).replace('@', '').trim(), userId]);

  db.run(
    'INSERT OR REPLACE INTO user_wallets (user_id, telegram_id, method, bank_name, bank_account, bank_holder, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [userId, telegram_id, method, bank_name || null, account_number, account_name],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      console.log('✅ Payment saved user ' + userId);
      res.json({ success: true });
    }
  );
});

// ============================================
// WITHDRAW + SCHEDULE
// ============================================
app.get('/api/withdraw/schedule', requireAuth, (req, res) => {
  const open = isWithdrawOpen();
  const next = getNextWithdrawWindow();
  const wib = getWIBMinutes();
  const wibH = String(Math.floor(wib / 60)).padStart(2, '0');
  const wibM = String(wib % 60).padStart(2, '0');
  res.json({
    open,
    serverTimeWIB: wibH + ':' + wibM,
    windows: WITHDRAW_WINDOWS,
    next,
    canSubmit: true,
    note: open 
      ? 'Jam proses WD sedang buka. WD akan langsung diproses admin.' 
      : 'WD bisa diajukan kapan aja, tapi DIPROSES admin ' + next.when + ' jam ' + next.start + ' WIB.'
  });
});

// ✅ USER: bisa ajuin WD KAPAN AJA (24 jam)
app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });

    // VALIDASI JAM DIHAPUS — user bisa ajuin 24 jam

    const wallet = await new Promise((resolve) => {
      db.get('SELECT * FROM user_wallets WHERE user_id = ?', [userId], (err, row) => resolve(row));
    });
    if (!wallet || !wallet.method || !wallet.bank_account || !wallet.bank_holder) {
      return res.status(400).json({ error: 'Data payment belum lengkap. Isi metode, nomor akun, dan nama pemilik.' });
    }
    if (!wallet.telegram_id) return res.status(400).json({ error: 'Telegram ID wajib diisi.' });

    const min = await wa.getMinWithdraw();
    if (amount < min) return res.status(400).json({ error: 'Minimal withdraw Rp' + min.toLocaleString('id-ID') });

    const user = await wa.getUser(userId);
    if (!user || user.balance < amount) return res.status(400).json({ error: 'Saldo tidak mencukupi' });

    const userFull = await new Promise((resolve) => {
      db.get('SELECT name, email, telegram_username FROM users WHERE id = ?', [userId], (err, row) => resolve(row));
    });

    await wa.updateUserBalance(userId, -amount);

    const wdId = await new Promise((resolve, reject) => {
      db.run('INSERT INTO withdrawals (user_id, amount, method, account_number, account_name, status) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, amount, wallet.method, wallet.bank_account, wallet.bank_holder, 'pending'],
        function (err) {
          if (err) { wa.updateUserBalance(userId, amount); reject(err); }
          else resolve(this.lastID);
        });
    });

    const open = isWithdrawOpen();
    const next = getNextWithdrawWindow();

    telegram.notifyAdminWithdraw({
      id: wdId, user_name: userFull.name, user_email: userFull.email,
      telegram_username: userFull.telegram_username,
      telegram_id: wallet.telegram_id,
      amount, method: wallet.method,
      account_number: wallet.bank_account,
      account_name: wallet.bank_holder,
      outsideHours: !open,
      nextWindow: open ? null : (next.when + ' jam ' + next.start + ' WIB')
    }).catch(() => {});

    res.json({ 
      success: true, 
      id: wdId, 
      status: 'pending',
      processingNote: open 
        ? 'WD akan segera diproses admin.' 
        : 'WD masuk antrian & akan DIPROSES ' + next.when + ' jam ' + next.start + ' WIB.'
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/withdraw/history', requireAuth, async (req, res) => {
  try { res.json(await wa.getWithdrawHistory(req.session.userId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// ADMIN — DEVICES
// ============================================
app.get('/api/admin/devices', requireAuth, requireAdmin, (req, res) => {
  db.all(
    'SELECT d.*, u.name as user_name, u.email as user_email, s.name as site_name ' +
    'FROM devices d LEFT JOIN users u ON d.user_id = u.id LEFT JOIN sites s ON d.site_id = s.id ' +
    'ORDER BY d.created_at DESC',
    (err, rows) => { if (err) return res.status(500).json({ error: err.message }); res.json(rows || []); }
  );
});

app.put('/api/admin/devices/:id/site', requireAuth, requireAdmin, (req, res) => {
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: 'Database wajib dipilih' });
  db.run('UPDATE devices SET site_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [siteId, req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// ============================================
// ADMIN — WITHDRAW (ACC HANYA DI JAM OPERASIONAL)
// ============================================
app.get('/api/admin/withdraw/pending', requireAuth, requireAdmin, async (req, res) => {
  try {
    const data = await wa.getPendingWithdrawals();
    res.json({
      data: data || [],
      canApprove: isWithdrawOpen(),
      serverTimeWIB: (() => {
        const wib = getWIBMinutes();
        return String(Math.floor(wib / 60)).padStart(2, '0') + ':' + String(wib % 60).padStart(2, '0');
      })(),
      next: getNextWithdrawWindow(),
      windows: WITHDRAW_WINDOWS
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/withdraw/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    // ✅ ADMIN: ACC cuma bisa di jam operasional
    if (!isWithdrawOpen()) {
      const next = getNextWithdrawWindow();
      return res.status(400).json({
        error: 'ACC WD hanya bisa di jam operasional. Buka lagi ' + next.when + ' jam ' + next.start + ' WIB.',
        outsideHours: true,
        next
      });
    }

    const { note } = req.body || {};
    const wdId = req.params.id;
    const wdInfo = await getWithdrawWithUser(wdId);
    const result = await wa.approveWithdraw(wdId, note || '');
    if (wdInfo) telegram.notifyChannelWithdrawSuccess(wdInfo).catch(() => {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// REJECT tetep bisa kapan aja (biar bisa reject WD palsu)
app.put('/api/admin/withdraw/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    res.json(await wa.rejectWithdraw(req.params.id, reason || ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// ADMIN — USERS
// ============================================
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  db.all(`
    SELECT
      u.id, u.email, u.name, u.phone, u.telegram_username, u.balance, u.role,
      u.total_referral, u.created_at,
      w.bank_name, w.bank_account, w.bank_holder, w.telegram_id,
      COALESCE((SELECT SUM(amount) FROM transactions WHERE user_id = u.id AND type = 'profit'), 0) as total_profit,
      (SELECT COUNT(*) FROM transactions WHERE user_id = u.id AND type = 'profit') as total_chat,
      (SELECT COUNT(*) FROM devices WHERE user_id = u.id) as total_devices
    FROM users u
    LEFT JOIN user_wallets w ON w.user_id = u.id
    WHERE u.role != 'admin'
    ORDER BY u.created_at DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/admin/users/:id/chat-stats', requireAuth, requireAdmin, (req, res) => {
  const userId = req.params.id;
  db.get('SELECT id, name, email, balance FROM users WHERE id = ?', [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User tidak ditemukan' });

    db.get(`
      SELECT COUNT(*) as total_chat, COALESCE(SUM(amount), 0) as total_profit
      FROM transactions WHERE user_id = ? AND type = 'profit'
    `, [userId], (err2, trx) => {
      db.get(`
        SELECT COUNT(*) as total_campaign, COALESCE(SUM(b.failed), 0) as total_failed
        FROM broadcasts b JOIN devices d ON b.device_id = d.id
        WHERE d.user_id = ? AND b.status = 'completed'
      `, [userId], (err3, bc) => {
        res.json({
          user: user,
          total_chat: trx ? trx.total_chat : 0,
          total_profit: trx ? trx.total_profit : 0,
          total_campaign: bc ? bc.total_campaign : 0,
          total_failed: bc ? bc.total_failed : 0
        });
      });
    });
  });
});

app.post('/api/admin/reset-profit/:deviceId', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE devices SET profit = 0 WHERE id = ?', [req.params.deviceId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Profit reset' });
  });
});

app.post('/api/admin/reset-all-profit', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE devices SET profit = 0', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Semua profit reset' });
  });
});

// ============================================
// TELEGRAM
// ============================================
app.get('/api/telegram/test', requireAuth, requireAdmin, async (req, res) => {
  res.json(await telegram.testBot());
});

app.get('/api/telegram/webhook-info', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await telegram.getWebhookInfo()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// PAGES
// ============================================
app.get('/', (req, res) => {
  if (req.session.userId) res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/register', (req, res) => {
  if (req.session.userId) res.redirect('/dashboard');
  else res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/devices', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'devices.html'));
});

app.get('/wallet', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
});

app.get('/referral', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'referral.html'));
});

app.get('/admin', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || row.role !== 'admin') return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
});

app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.use((req, res) => res.redirect('/'));

// ============================================
// AUTO-RELEASE nomor nyangkut
// ============================================
setInterval(() => {
  db.run(
    "UPDATE master_contacts SET status = 'available', sent_at = NULL WHERE status = 'processing' AND (sent_at IS NULL OR sent_at < datetime('now', '-10 minutes'))",
    function(err) {
      if (!err && this.changes > 0) console.log('🧹 Auto-release ' + this.changes + ' nomor nyangkut');
    }
  );
}, 2 * 60 * 1000);

db.run(
  "UPDATE master_contacts SET status = 'available', sent_at = NULL WHERE status = 'processing' AND (sent_at IS NULL OR sent_at < datetime('now', '-10 minutes'))",
  function(err) {
    if (!err && this.changes > 0) console.log('🧹 Startup: release ' + this.changes + ' nomor nyangkut');
  }
);

// ============================================
// EXPORT & LISTEN
// ============================================
module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log('🚀 SewaWA running on port ' + PORT);
    const PUBLIC_URL = process.env.PUBLIC_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
    if (PUBLIC_URL && process.env.TELEGRAM_BOT_TOKEN) {
      try { await telegram.setWebhook(PUBLIC_URL); } catch (e) { console.error('⚠️ Webhook:', e.message); }
    }
  });
}
