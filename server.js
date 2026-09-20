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
} catch (e) {
  console.error('❌ Gagal bikin folder:', e.message);
}

// ============================================
// EMAIL
// ============================================
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'h11943352@gmail.com',
    pass: process.env.SMTP_PASS || 'djmd ynus ozpd ilbc'
  }
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
    console.log('✅ SESSION_DIR writable — pakai FileStore');
  }
} catch (e) {
  console.error('⚠️ SESSION_DIR gak writable:', e.message);
}

const sessionOptions = {
  secret: process.env.SESSION_SECRET || 'marketingcuan_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true
  }
};

if (useFileStore) {
  sessionOptions.store = new FileStore({
    path: SESSION_DIR,
    retries: 0,
    ttl: 7 * 24 * 60 * 60,
    reapInterval: 3600,
    logFn: () => {}
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
    db.get(`SELECT w.*, u.name as user_name, u.email as user_email, u.telegram_username
            FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = ?`,
      [wdId], (err, row) => resolve(row || null));
  });
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
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    const callbackId = cq.id;

    if (data.startsWith('wd_acc_')) {
      await handleApproveFromTelegram(data.replace('wd_acc_', ''), chatId, messageId, callbackId);
    } else if (data.startsWith('wd_rej_')) {
      await handleRejectFromTelegram(data.replace('wd_rej_', ''), chatId, messageId, callbackId);
    } else {
      await telegram.answerCallbackQuery(callbackId, 'Aksi tidak dikenal');
    }
  } catch (e) { console.error('Webhook error:', e.message); }
});

async function handleApproveFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, '❌ WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, `⚠️ WD sudah di-${wdInfo.status}`, true);
    await wa.approveWithdraw(wdId, 'Approved via Telegram Bot');
    await telegram.answerCallbackQuery(callbackId, '✅ Withdraw di-ACC!');
    const newText = `<b>✅ WITHDRAW DI-ACC</b>\n\n👤 <b>User:</b> ${wdInfo.user_name || 'Unknown'}\n💰 <b>Nominal:</b> ${telegram.rp(wdInfo.amount)}\n💳 <b>Metode:</b> ${String(wdInfo.method || '').toUpperCase()}\n\n✅ <b>Status:</b> APPROVED\n🕐 ${new Date().toLocaleString('id-ID')}`;
    await telegram.editMessageText(chatId, messageId, newText);
    await telegram.notifyChannelWithdrawSuccess(wdInfo);
  } catch (e) { try { await telegram.answerCallbackQuery(callbackId, '❌ Error', true); } catch (_) {} }
}

async function handleRejectFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, '❌ WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, `⚠️ WD sudah di-${wdInfo.status}`, true);
    await wa.rejectWithdraw(wdId, 'Ditolak via Telegram Bot');
    await telegram.answerCallbackQuery(callbackId, '❌ Withdraw ditolak');
    const newText = `<b>❌ WITHDRAW DITOLAK</b>\n\n👤 <b>User:</b> ${wdInfo.user_name || 'Unknown'}\n💰 <b>Nominal:</b> ${telegram.rp(wdInfo.amount)}\n\n❌ <b>Status:</b> REJECTED\n🕐 ${new Date().toLocaleString('id-ID')}`;
    await telegram.editMessageText(chatId, messageId, newText);
  } catch (e) { try { await telegram.answerCallbackQuery(callbackId, '❌ Error', true); } catch (_) {} }
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
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Gagal menyimpan session' });
        console.log('✅ Login sukses:', user.email);
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

      db.run('INSERT INTO users (email, password, name, phone, role, referral_code, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [email, hashedPassword, username, phone, 'user', referralCode, referrerId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const newUserId = this.lastID;
          console.log('✅ User baru:', email, 'ID:', newUserId);
          if (referrerId) {
            db.run('UPDATE users SET balance = balance + 50, total_referral = total_referral + 1 WHERE id = ?', [referrerId]);
            db.run('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)', [referrerId, 50, 'bonus', `Referral dari ${username}`]);
            db.run('INSERT INTO referrals (referrer_id, referred_id, bonus_amount, status) VALUES (?, ?, ?, ?)', [referrerId, newUserId, 50, 'completed']);
          }
          res.json({ success: true, message: 'Akun berhasil dibuat.' });
        });
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
    res.json({ code: row.referral_code, link: `${baseUrl}/register?ref=${row.referral_code}`, total: row.total_referral || 0 });
  });
});

app.get('/api/referral/history', requireAuth, (req, res) => {
  db.all(`SELECT r.*, u.name as referred_name, u.email as referred_email, u.created_at FROM referrals r JOIN users u ON r.referred_id = u.id WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
    [req.session.userId], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
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
        const resetLink = `${baseUrl}/reset-password?token=${token}`;
        try {
          await transporter.sendMail({
            from: '"MarketingCuan" <ryumekmilo@gmail.com>', to: email,
            subject: '🔐 Reset Password MarketingCuan',
            html: `<div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;border:1px solid #e0e0e0;border-radius:10px;"><h2 style="color:#075E54;">🔐 Reset Password</h2><p>Klik link di bawah:</p><div style="text-align:center;margin:30px 0;"><a href="${resetLink}" style="background:#075E54;color:#fff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:600;">Reset Password</a></div><p>${resetLink}</p><p style="font-size:12px;color:#888;">Berlaku 1 jam.</p></div>`
          });
        } catch (e) { console.error('Email error:', e.message); }
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
      if (!row) return res.status(400).json({ error: 'Token tidak valid/kadaluwarsa' });
      const hashedPassword = bcrypt.hashSync(newPassword, 10);
      db.run('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, row.email], (err) => {
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
  db.all(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id) as total_contacts,
      (SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id AND status = 'sent') as sent_contacts,
      (SELECT COUNT(*) FROM master_contacts WHERE site_id = s.id AND (status = 'available' OR status IS NULL)) as available_contacts,
      (SELECT COUNT(*) FROM broadcasts WHERE site_id = s.id AND status = 'completed') as total_campaigns,
      (SELECT COUNT(*) FROM devices WHERE site_id = s.id) as total_devices
    FROM sites s WHERE s.is_active = 1 ORDER BY s.id ASC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/sites', requireAuth, requireAdmin, (req, res) => {
  const { name, template_text, template_photo } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama database wajib diisi' });
  db.run(`INSERT INTO sites (name, template_text, template_photo, is_active) VALUES (?, ?, ?, 1)`,
    [name, template_text || '', template_photo || ''],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    });
});

app.put('/api/admin/sites/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, template_text, template_photo } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (template_text !== undefined) { updates.push('template_text = ?'); params.push(template_text); }
  if (template_photo !== undefined) { updates.push('template_photo = ?'); params.push(template_photo); }
  if (updates.length === 0) return res.status(400).json({ error: 'Tidak ada perubahan' });
  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.run(`UPDATE sites SET ${updates.join(', ')} WHERE id = ?`, params, function (err) {
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

app.post('/api/admin/sites/:id/clear-contacts', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM master_contacts WHERE site_id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, deleted: this.changes });
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

  if (search) { where += ' AND phone LIKE ?'; params.push(`%${search}%`); }

  db.get(`SELECT COUNT(*) as total FROM master_contacts ${where}`, params, (err, countRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all(`SELECT * FROM master_contacts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset], (err2, rows) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ total: countRow.total, page, limit, totalPages: Math.ceil(countRow.total / limit) || 1, data: rows || [] });
      });
  });
});

app.post('/api/admin/sites/:id/delete-phones', requireAuth, requireAdmin, (req, res) => {
  const siteId = req.params.id;
  const { phones } = req.body;
  if (!phones || !Array.isArray(phones) || phones.length === 0) return res.status(400).json({ error: 'Tidak ada nomor' });
  const placeholders = phones.map(() => '?').join(',');
  db.run(`DELETE FROM master_contacts WHERE site_id = ? AND phone IN (${placeholders})`,
    [siteId, ...phones], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, deleted: this.changes });
    });
});

app.post('/api/admin/sites/:id/reset-sent', requireAuth, requireAdmin, (req, res) => {
  db.run(`UPDATE master_contacts SET status = 'available', sent_at = NULL WHERE site_id = ? AND status = 'sent'`,
    [req.params.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, reset: this.changes });
    });
});

app.post('/api/admin/sites/:id/delete-sent', requireAuth, requireAdmin, (req, res) => {
  db.run(`DELETE FROM master_contacts WHERE site_id = ? AND status = 'sent'`,
    [req.params.id], function (err) {
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

    const validNumbers = numbers.map(n => String(n).trim().replace(/[^0-9]/g, '')).filter(n => n.length >= 5 && n.length <= 20);
    if (validNumbers.length === 0) return res.status(400).json({ error: 'Tidak ada nomor valid' });

    let inserted = 0, skipped = 0;
    for (const num of validNumbers) {
      const exists = await new Promise((resolve) => {
        db.get('SELECT id FROM master_contacts WHERE phone = ? AND site_id = ?', [num, siteId], (err, row) => resolve(!!row));
      });
      if (!exists) {
        await new Promise((resolve) => {
          db.run(`INSERT INTO master_contacts (site_id, phone, name, status) VALUES (?, ?, ?, 'available')`, [siteId, num, num], () => resolve());
        });
        inserted++;
      } else skipped++;
    }
    console.log(`✅ Import DB${siteId}: ${inserted} baru, ${skipped} skip`);
    res.json({ success: true, inserted, skipped, total: validNumbers.length });
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
      db.get(`SELECT COALESCE(SUM(b.sent), 0) as total_sent, COALESCE(SUM(b.failed), 0) as total_failed,
              COUNT(*) as total_campaigns, COALESCE(SUM(b.recipients), 0) as total_recipients
              FROM broadcasts b JOIN devices d ON b.device_id = d.id WHERE d.user_id = ?`,
        [userId], (err3, hist) => {
          db.get(`SELECT COUNT(DISTINCT c.phone) as unique_total FROM contacts c JOIN devices d ON c.device_id = d.id WHERE d.user_id = ?`,
            [userId], (err4, contactRow) => {
              res.json({
                master_total: masterRow?.total || 0,
                devices_total: totalDevices,
                devices_connected: connectedDevices,
                total_sent: hist?.total_sent || 0,
                total_failed: hist?.total_failed || 0,
                total_campaigns: hist?.total_campaigns || 0,
                total_recipients: hist?.total_recipients || 0,
                unique_contacts: contactRow?.unique_total || 0,
                avg_speed: 0
              });
            });
        });
    });
  });
});

app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const devices = await wa.getDevices(req.session.userId);
    const enriched = devices.map(d => ({
      ...d,
      real_status: wa.getStatus(d.id) || d.status,
      has_qr: wa.qrCodes.has(d.id)
    }));
    res.json(enriched);
  } catch (error) { res.status(500).json({ error: error.message }); }
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
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/devices/:id/start', requireAuth, async (req, res) => {
  try { res.json(await wa.startDevice(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/stop', requireAuth, async (req, res) => {
  try { res.json(await wa.stopDevice(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  try { await wa.deleteDevice(req.params.id, req.session.userId); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/qr', requireAuth, async (req, res) => {
  try { const qr = await wa.getQR(req.params.id); res.json({ qr: qr || null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/pairing', requireAuth, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Nomor HP wajib' });
    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== req.session.userId) return res.status(403).json({ error: 'Bukan milik Anda' });
    const result = await wa.requestPairingCode(deviceId, phoneNumber);
    res.json({ success: true, code: result.code });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/devices/:id/mode', requireAuth, async (req, res) => {
  try { await wa.updateDeviceMode(req.params.id, req.body.mode); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ USER bisa ganti database device sendiri
app.put('/api/devices/:id/site', requireAuth, async (req, res) => {
  try {
    const { siteId } = req.body;
    if (!siteId) return res.status(400).json({ error: 'Database wajib dipilih' });

    const deviceId = req.params.id;
    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Device tidak ditemukan atau bukan milik Anda' });
    }

    const site = await new Promise((resolve) => {
      db.get('SELECT id, name FROM sites WHERE id = ? AND is_active = 1', [siteId], (err, row) => resolve(row));
    });
    if (!site) return res.status(400).json({ error: 'Database tidak valid' });

    db.run('UPDATE devices SET site_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [siteId, deviceId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run('DELETE FROM contacts WHERE device_id = ?', [deviceId], () => {
          console.log(`🔄 Device ${deviceId} pindah ke DB${siteId} (${site.name})`);
          res.json({ success: true, site_id: siteId, site_name: site.name });
        });
      });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/devices/:id/contacts', requireAuth, async (req, res) => {
  try {
    const device = await wa.getDevice(req.params.id);
    if (!device) return res.status(404).json({ error: 'Device tidak ditemukan' });
    res.json(await wa.getContacts(req.params.id, device.site_id || 1));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ FIX: Blast langsung dari master_contacts
app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const { deviceId, speed } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib' });

    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Device tidak ditemukan atau bukan milik Anda' });
    }

    const siteId = device.site_id || 1;
    const status = wa.getStatus(deviceId);
    if (status !== 'connected') return res.status(400).json({ error: 'Device tidak terhubung' });

    const site = await new Promise((resolve) => {
      db.get('SELECT template_text, template_photo FROM sites WHERE id = ?', [siteId], (err, row) => resolve(row));
    });
    if (!site || !site.template_text) {
      return res.status(400).json({ error: 'Database belum ada template. Hubungi admin.' });
    }

    // ✅ LANGSUNG dari master_contacts
    const availablePhones = await new Promise((resolve) => {
      db.all(
        `SELECT phone FROM master_contacts 
         WHERE site_id = ? 
           AND (status = 'available' OR status IS NULL)
         ORDER BY id ASC
         LIMIT 10000`,
        [siteId],
        (err, rows) => resolve(rows || [])
      );
    });

    if (availablePhones.length === 0) {
      return res.status(400).json({
        error: 'Database ini belum ada nomor tersedia. Tunggu admin upload.',
        available_count: 0
      });
    }

    const recipients = availablePhones.map(r => r.phone).filter(p => p);
    console.log(`📤 Blast DB${siteId}: ${recipients.length} nomor`);

    const result = await wa.sendBroadcast(
      deviceId, site.template_text, recipients,
      req.session.userId, speed || 1000, siteId, site.template_photo || null
    );

    res.json(result);
  } catch (error) {
    console.error('❌ Broadcast error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/broadcast/history', requireAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    res.json(await wa.getBroadcastHistory(req.session.userId, deviceId || null));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// STATS
// ============================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try { res.json(await wa.getUserStats(req.session.userId)); }
  catch (error) { res.status(500).json({ error: error.message, total_devices: 0, online: 0, offline: 0, balance: 0, revenue: 0, total_sent: 0 }); }
});

// ============================================
// SETTINGS
// ============================================
app.get('/api/settings', requireAuth, (req, res) => {
  db.all('SELECT * FROM settings', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const settings = {};
    (rows || []).forEach(row => settings[row.key] = row.value);
    res.json(settings);
  });
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  try {
    const { promo_text, price_per_chat, min_withdraw } = req.body;
    const updates = [];
    if (promo_text !== undefined) updates.push(['promo_text', promo_text]);
    if (price_per_chat) updates.push(['price_per_chat', String(price_per_chat)]);
    if (min_withdraw) updates.push(['min_withdraw', String(min_withdraw)]);
    for (const [key, value] of updates) {
      db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [key, value]);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// WALLET
// ============================================
app.get('/api/wallet', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT * FROM user_wallets WHERE user_id = ?', [userId], (err, wallet) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get('SELECT balance FROM users WHERE id = ?', [userId], (err2, user) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ balance: user?.balance || 0, wallet: wallet || null });
    });
  });
});

app.put('/api/wallet', requireAuth, (req, res) => {
  try {
    const userId = req.session.userId;
    const { gopay_phone, ovo_phone, dana_phone, bank_name, bank_account, bank_holder } = req.body;
    db.run(`INSERT OR REPLACE INTO user_wallets (user_id, gopay_phone, ovo_phone, dana_phone, bank_name, bank_account, bank_holder, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId, gopay_phone || null, ovo_phone || null, dana_phone || null, bank_name || null, bank_account || null, bank_holder || null],
      (err) => { if (err) return res.status(500).json({ error: err.message }); res.json({ success: true }); });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { amount, method, account_number, account_name, telegram_username } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
    if (!method) return res.status(400).json({ error: 'Metode wajib' });
    if (!account_number) return res.status(400).json({ error: 'Nomor akun wajib' });
    if (!account_name) return res.status(400).json({ error: 'Nama pemilik wajib' });

    if (telegram_username) {
      const tgClean = String(telegram_username).replace('@', '').trim();
      await new Promise((resolve) => {
        db.run('UPDATE users SET telegram_username = ? WHERE id = ?', [tgClean, userId], () => resolve());
      });
    }

    const result = await wa.requestWithdraw(userId, amount, method, account_number, account_name);
    const wdId = result.id || result.withdrawId;
    if (wdId) {
      const wdInfo = await getWithdrawWithUser(wdId);
      if (wdInfo) telegram.notifyAdminWithdraw(wdInfo).catch(() => {});
    }
    res.json(result);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/withdraw/history', requireAuth, async (req, res) => {
  try { res.json(await wa.getWithdrawHistory(req.session.userId)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// ADMIN — DEVICES
// ============================================
app.get('/api/admin/devices', requireAuth, requireAdmin, (req, res) => {
  db.all(`SELECT d.*, u.name as user_name, u.email as user_email, s.name as site_name
          FROM devices d LEFT JOIN users u ON d.user_id = u.id LEFT JOIN sites s ON d.site_id = s.id
          ORDER BY d.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
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
// ADMIN — WITHDRAW
// ============================================
app.get('/api/admin/withdraw/pending', requireAuth, requireAdmin, async (req, res) => {
  try { res.json(await wa.getPendingWithdrawals()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/withdraw/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { note } = req.body || {};
    const wdId = req.params.id;
    const wdInfo = await getWithdrawWithUser(wdId);
    const result = await wa.approveWithdraw(wdId, note || '');
    if (wdInfo) telegram.notifyChannelWithdrawSuccess(wdInfo).catch(() => {});
    res.json(result);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/admin/withdraw/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    res.json(await wa.rejectWithdraw(req.params.id, reason || ''));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================
// ADMIN — USERS
// ============================================
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  db.all(`SELECT u.id, u.email, u.name, u.phone, u.telegram_username, u.balance, u.role, u.total_referral, u.created_at,
          w.gopay_phone, w.ovo_phone, w.dana_phone, w.bank_name, w.bank_account, w.bank_holder
          FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id WHERE u.role != 'admin' ORDER BY u.created_at DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    });
});

// ============================================
// ADMIN — PROFIT RESET
// ============================================
app.post('/api/admin/reset-profit/:deviceId', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE devices SET profit = 0 WHERE id = ?', [req.params.deviceId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `Profit ${req.params.deviceId} reset` });
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
  try { res.json(await telegram.getWebhookInfo()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

app.get('/broadcast', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'broadcast.html'));
});

app.get('/wallet', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
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
// EXPORT & LISTEN
// ============================================
module.exports = app;

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 MarketingCuan running on port ${PORT}`);
    const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    if (PUBLIC_URL && process.env.TELEGRAM_BOT_TOKEN) {
      try { await telegram.setWebhook(PUBLIC_URL); }
      catch (e) { console.error('⚠️ Webhook gagal:', e.message); }
    }
  });
}
