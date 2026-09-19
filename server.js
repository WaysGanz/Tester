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
// Folder Data & Session
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
const SESSION_DIR = path.join(DATA_DIR, 'sessions-store');
const WA_SESSION_DIR = path.join(DATA_DIR, 'wa-sessions');

try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (!fs.existsSync(WA_SESSION_DIR)) fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
  console.log('📁 Data dir   :', DATA_DIR);
  console.log('📁 Session dir:', SESSION_DIR);
  console.log('📁 WA session :', WA_SESSION_DIR);
} catch (e) {
  console.error('❌ Gagal bikin folder:', e.message);
}

// ============================================
// Email Transporter
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
// Middleware
// ============================================
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// ✅ SESSION — Anti-Gagal, fallback MemoryStore
// ============================================
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
  console.error('   → Fallback MemoryStore (session hilang saat restart)');
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
// Helpers
// ============================================
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || row.role !== 'admin') {
      return res.status(403).json({ error: 'Akses ditolak. Admin only.' });
    }
    next();
  });
}

function syncMasterToDevice(deviceId) {
  return new Promise((resolve) => {
    db.all('SELECT phone, name FROM master_contacts', (err, masters) => {
      if (err || !masters || masters.length === 0) return resolve(0);
      let pending = 0;
      let inserted = 0;
      const total = masters.length;
      if (total === 0) return resolve(0);

      for (const mc of masters) {
        db.get('SELECT id FROM contacts WHERE device_id = ? AND phone = ?',
          [deviceId, mc.phone], (err2, row) => {
            if (err2 || row) {
              pending++;
              if (pending === total) resolve(inserted);
              return;
            }
            db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)',
              [deviceId, mc.name || mc.phone, mc.phone], (err3) => {
                if (!err3) inserted++;
                pending++;
                if (pending === total) resolve(inserted);
              });
          });
      }
    });
  });
}

function getWithdrawWithUser(wdId) {
  return new Promise((resolve) => {
    db.get(`
      SELECT w.*, u.name as user_name, u.email as user_email, u.telegram_username
      FROM withdrawals w
      JOIN users u ON w.user_id = u.id
      WHERE w.id = ?
    `, [wdId], (err, row) => resolve(row || null));
  });
}

// ============================================
// TELEGRAM WEBHOOK
// ============================================
app.post('/api/telegram/webhook', async (req, res) => {
  res.json({ ok: true });

  try {
    const update = req.body;
    if (!update) return;

    if (update.callback_query) {
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
    }
  } catch (e) {
    console.error('❌ Webhook handler error:', e.message);
  }
});

async function handleApproveFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, '❌ WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, `⚠️ WD sudah di-${wdInfo.status}`, true);

    await wa.approveWithdraw(wdId, 'Approved via Telegram Bot');
    console.log(`✅ WD ${wdId} approved via Telegram`);
    await telegram.answerCallbackQuery(callbackId, '✅ Withdraw di-ACC!');

    const newText = `
<b>✅ WITHDRAW DI-ACC</b>

👤 <b>User:</b> ${wdInfo.user_name || 'Unknown'}
💰 <b>Nominal:</b> ${telegram.rp(wdInfo.amount)}
📱 <b>Telegram:</b> ${wdInfo.telegram_username ? '@' + String(wdInfo.telegram_username).replace('@','') : '-'}
💳 <b>Metode:</b> ${String(wdInfo.method || '').toUpperCase()}

✅ <b>Status:</b> APPROVED
🕐 ${new Date().toLocaleString('id-ID')}

<i>Diproses via Telegram Bot.</i>
`.trim();

    await telegram.editMessageText(chatId, messageId, newText);
    await telegram.notifyChannelWithdrawSuccess(wdInfo);
  } catch (e) {
    console.error('❌ Approve error:', e.message);
    try { await telegram.answerCallbackQuery(callbackId, '❌ Error: ' + e.message, true); } catch (_) {}
  }
}

async function handleRejectFromTelegram(wdId, chatId, messageId, callbackId) {
  try {
    const wdInfo = await getWithdrawWithUser(wdId);
    if (!wdInfo) return telegram.answerCallbackQuery(callbackId, '❌ WD tidak ditemukan', true);
    if (wdInfo.status !== 'pending') return telegram.answerCallbackQuery(callbackId, `⚠️ WD sudah di-${wdInfo.status}`, true);

    await wa.rejectWithdraw(wdId, 'Ditolak via Telegram Bot');
    console.log(`❌ WD ${wdId} rejected via Telegram`);
    await telegram.answerCallbackQuery(callbackId, '❌ Withdraw ditolak');

    const newText = `
<b>❌ WITHDRAW DITOLAK</b>

👤 <b>User:</b> ${wdInfo.user_name || 'Unknown'}
💰 <b>Nominal:</b> ${telegram.rp(wdInfo.amount)}
📱 <b>Telegram:</b> ${wdInfo.telegram_username ? '@' + String(wdInfo.telegram_username).replace('@','') : '-'}

❌ <b>Status:</b> REJECTED
🕐 ${new Date().toLocaleString('id-ID')}

<i>Saldo dikembalikan ke user.</i>
`.trim();

    await telegram.editMessageText(chatId, messageId, newText);
  } catch (e) {
    console.error('❌ Reject error:', e.message);
    try { await telegram.answerCallbackQuery(callbackId, '❌ Error: ' + e.message, true); } catch (_) {}
  }
}

// ============================================
// AUTH
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log('🔑 Login attempt:', email);

    if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });

    db.get('SELECT * FROM users WHERE email = ? OR name = ?', [email, email], async (err, user) => {
      if (err) {
        console.error('❌ Login DB error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (!user) {
        console.log('❌ User gak ketemu:', email);
        return res.status(401).json({ error: 'Email atau password salah' });
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        console.log('❌ Password salah untuk:', email);
        return res.status(401).json({ error: 'Email atau password salah' });
      }

      req.session.userId = user.id;
      req.session.userName = user.name;
      req.session.userRole = user.role;

      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('❌ Session save error:', saveErr);
          return res.status(500).json({ error: 'Gagal menyimpan session' });
        }
        console.log('✅ Login sukses:', user.email, '| role:', user.role);
        res.json({
          success: true,
          user: {
            id: user.id, name: user.name, email: user.email,
            balance: user.balance, role: user.role
          }
        });
      });
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, username, phone, password, ref } = req.body;
    console.log('📝 Register attempt:', email, '|', username);

    if (!email || !username || !phone || !password) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
    if (username.length < 5 || username.length > 20) return res.status(400).json({ error: 'Username harus 5-20 karakter' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
    if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (10-15 digit)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });

    db.get('SELECT id FROM users WHERE email = ? OR name = ?', [email, username], async (err, row) => {
      if (err) {
        console.error('❌ Register check error:', err.message);
        return res.status(500).json({ error: err.message });
      }
      if (row) return res.status(400).json({ error: 'Email atau username sudah terdaftar' });

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
          if (err) {
            console.error('❌ Register INSERT error:', err.message);
            console.error('   Data:', { email, username, phone });
            return res.status(500).json({ error: err.message });
          }
          const newUserId = this.lastID;
          console.log('✅ User baru terdaftar:', email, '| ID:', newUserId);

          if (referrerId) {
            db.run('UPDATE users SET balance = balance + 50, total_referral = total_referral + 1 WHERE id = ?', [referrerId]);
            db.run('INSERT INTO transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)',
              [referrerId, 50, 'bonus', `Bonus referral dari ${username}`]);
            db.run('INSERT INTO referrals (referrer_id, referred_id, bonus_amount, status) VALUES (?, ?, ?, ?)',
              [referrerId, newUserId, 50, 'completed']);
          }
          res.json({ success: true, message: 'Akun berhasil dibuat. Silakan login.' });
        }
      );
    });
  } catch (error) {
    console.error('❌ Register error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  db.get('SELECT id, email, name, phone, balance, role, telegram_username FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(user);
  });
});

app.post('/api/user/telegram', requireAuth, (req, res) => {
  const { telegram_username } = req.body;
  const clean = String(telegram_username || '').replace('@', '').trim();
  if (!clean) return res.status(400).json({ error: 'Username Telegram wajib diisi' });
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
      link: `${baseUrl}/register?ref=${row.referral_code}`,
      total: row.total_referral || 0
    });
  });
});

app.get('/api/referral/history', requireAuth, (req, res) => {
  db.all(`
    SELECT r.*, u.name as referred_name, u.email as referred_email, u.created_at
    FROM referrals r
    JOIN users u ON r.referred_id = u.id
    WHERE r.referrer_id = ?
    ORDER BY r.created_at DESC
  `, [req.session.userId], (err, rows) => {
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
    if (!email) return res.status(400).json({ error: 'Email wajib diisi' });

    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim.' });

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString();

      db.run('INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)',
        [email, token, expiresAt],
        async (err) => {
          if (err) return res.status(500).json({ error: err.message });

          const baseUrl = req.protocol + '://' + req.get('host');
          const resetLink = `${baseUrl}/reset-password?token=${token}`;

          try {
            await transporter.sendMail({
              from: '"MarketingCuan" <ryumekmilo@gmail.com>',
              to: email,
              subject: '🔐 Reset Password MarketingCuan',
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                  <h2 style="color: #075E54;">🔐 Reset Password</h2>
                  <p>Halo,</p>
                  <p>Kami menerima permintaan untuk mereset password akun MarketingCuan Anda.</p>
                  <div style="text-align: center; margin: 30px 0;">
                    <a href="${resetLink}" style="background: #075E54; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 600;">Reset Password</a>
                  </div>
                  <p>Atau salin link ini:</p>
                  <p style="background: #f5f5f5; padding: 10px; border-radius: 6px; word-break: break-all; font-size: 14px;">${resetLink}</p>
                  <p style="font-size: 12px; color: #888;">Berlaku 1 jam.</p>
                </div>
              `
            });
            console.log(`✅ Email reset ke ${email}`);
          } catch (emailErr) {
            console.error('❌ Gagal kirim email:', emailErr.message);
          }

          res.json({ success: true, message: 'Link reset password telah dikirim ke email Anda.' });
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token dan password baru wajib diisi' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });

    db.get(
      'SELECT email FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0',
      [token],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(400).json({ error: 'Token tidak valid atau sudah kadaluwarsa' });

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        db.run('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, row.email], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          db.run('UPDATE password_resets SET used = 1 WHERE token = ?', [token], () => {
            res.json({ success: true, message: 'Password berhasil direset. Silakan login.' });
          });
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// DEVICES
// ============================================
app.get('/api/devices/summary', requireAuth, (req, res) => {
  const userId = req.session.userId;

  db.get('SELECT COUNT(*) as total FROM master_contacts', (err, masterRow) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all('SELECT id, status FROM devices WHERE user_id = ?', [userId], (err2, devices) => {
      if (err2) return res.status(500).json({ error: err2.message });

      const totalDevices = (devices || []).length;
      const connectedDevices = (devices || []).filter(d => d.status === 'connected').length;

      db.get(`
        SELECT 
          COALESCE(SUM(b.sent), 0) as total_sent,
          COALESCE(SUM(b.failed), 0) as total_failed,
          COUNT(*) as total_campaigns,
          COALESCE(SUM(b.recipients), 0) as total_recipients
        FROM broadcasts b
        JOIN devices d ON b.device_id = d.id
        WHERE d.user_id = ?
      `, [userId], (err3, hist) => {
        const finish = (sent, failed, camps, recips) => {
          db.get(`
            SELECT COUNT(DISTINCT c.phone) as unique_total
            FROM contacts c JOIN devices d ON c.device_id = d.id
            WHERE d.user_id = ?
          `, [userId], (err5, contactRow) => {
            res.json({
              master_total: masterRow?.total || 0,
              devices_total: totalDevices,
              devices_connected: connectedDevices,
              total_sent: sent || 0,
              total_failed: failed || 0,
              total_campaigns: camps || 0,
              total_recipients: recips || 0,
              unique_contacts: contactRow?.unique_total || 0,
              avg_speed: 0
            });
          });
        };

        if (err3) {
          db.get(`
            SELECT COALESCE(SUM(b.sent), 0) as total_sent, COUNT(*) as total_campaigns,
                   COALESCE(SUM(b.recipients), 0) as total_recipients
            FROM broadcasts b
            JOIN devices d ON b.device_id = d.id
            WHERE d.user_id = ?
          `, [userId], (err4, hist2) => {
            if (err4) return finish(0, 0, 0, 0);
            finish(hist2.total_sent, 0, hist2.total_campaigns, hist2.total_recipients);
          });
          return;
        }
        finish(hist?.total_sent, hist?.total_failed, hist?.total_campaigns, hist?.total_recipients);
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices', requireAuth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'Nama device wajib diisi' });

    const id = uuidv4().substring(0, 10);
    const device = await wa.createDevice(id, req.session.userId, name, phone || '');
    const inserted = await syncMasterToDevice(id);
    if (inserted > 0) console.log(`✅ Copied ${inserted} master contacts to ${id}`);

    await wa.startDevice(id);
    res.json(device);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    if (!phoneNumber) return res.status(400).json({ error: 'Nomor HP wajib diisi' });
    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== req.session.userId) {
      return res.status(403).json({ error: 'Device tidak ditemukan atau bukan milik Anda' });
    }
    const result = await wa.requestPairingCode(deviceId, phoneNumber);
    res.json({ success: true, code: result.code });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/devices/:id/mode', requireAuth, async (req, res) => {
  try { await wa.updateDeviceMode(req.params.id, req.body.mode); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/devices/:id/contacts', requireAuth, async (req, res) => {
  try { res.json(await wa.getContacts(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/devices/:id/sync-contacts', requireAuth, async (req, res) => {
  try {
    const deviceId = req.params.id;
    const userId = req.session.userId;
    const device = await wa.getDevice(deviceId);
    if (!device || device.user_id !== userId) {
      return res.status(403).json({ error: 'Device tidak ditemukan atau bukan milik Anda' });
    }

    const totalMaster = await new Promise((resolve) => {
      db.get('SELECT COUNT(*) as total FROM master_contacts', (err, row) => resolve(row?.total || 0));
    });

    if (totalMaster === 0) {
      return res.json({ success: true, inserted: 0, total: 0, message: 'Belum ada master kontak' });
    }

    const inserted = await syncMasterToDevice(deviceId);
    console.log(`🔄 Sync ${deviceId}: +${inserted} dari ${totalMaster}`);
    res.json({
      success: true,
      inserted,
      total: totalMaster,
      message: inserted > 0 ? `${inserted} kontak baru disync` : 'Semua up-to-date'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CONTACTS SUMMARY
// ============================================
app.get('/api/contacts/summary', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT COUNT(*) as total, MAX(created_at) as last_update FROM master_contacts', (err, masterRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`
      SELECT COUNT(DISTINCT c.phone) as unique_total, COUNT(*) as total
      FROM contacts c JOIN devices d ON c.device_id = d.id WHERE d.user_id = ?
    `, [userId], (err2, userRow) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({
        master_total: masterRow?.total || 0,
        my_unique_contacts: userRow?.unique_total || 0,
        my_total_contacts: userRow?.total || 0,
        last_update: masterRow?.last_update || null
      });
    });
  });
});

// ============================================
// BROADCAST
// ============================================
app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const { deviceId, message, recipients, speed } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib' });
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Minimal 1 penerima' });
    }

    let finalMessage = message;
    if (!finalMessage) {
      const settings = await new Promise((resolve) => {
        db.get('SELECT value FROM settings WHERE key = ?', ['promo_text'], (err, row) => resolve(row));
      });
      finalMessage = settings?.value || 'Pesan broadcast';
    }

    const status = wa.getStatus(deviceId);
    if (status !== 'connected') return res.status(400).json({ error: 'Device tidak terhubung' });

    const result = await wa.sendBroadcast(deviceId, finalMessage, recipients, req.session.userId, speed || 1000);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/broadcast/history', requireAuth, async (req, res) => {
  try {
    const { deviceId } = req.query;
    res.json(await wa.getBroadcastHistory(req.session.userId, deviceId || null));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STATS
// ============================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    res.json(await wa.getUserStats(req.session.userId));
  } catch (error) {
    console.error('❌ /api/stats error:', error);
    res.status(500).json({ error: error.message, total_devices: 0, online: 0, offline: 0, balance: 0, revenue: 0, total_sent: 0 });
  }
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
    if (promo_text) updates.push(['promo_text', promo_text]);
    if (price_per_chat) updates.push(['price_per_chat', String(price_per_chat)]);
    if (min_withdraw) updates.push(['min_withdraw', String(min_withdraw)]);
    for (const [key, value] of updates) {
      db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [key, value]);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    db.run(
      `INSERT OR REPLACE INTO user_wallets 
       (user_id, gopay_phone, ovo_phone, dana_phone, bank_name, bank_account, bank_holder, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId, gopay_phone || null, ovo_phone || null, dana_phone || null,
       bank_name || null, bank_account || null, bank_holder || null],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WITHDRAW
// ============================================
app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { amount, method, account_number, account_name, telegram_username } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
    if (!method) return res.status(400).json({ error: 'Metode wajib dipilih' });
    if (!account_number) return res.status(400).json({ error: 'Nomor akun wajib diisi' });
    if (!account_name) return res.status(400).json({ error: 'Nama pemilik wajib diisi' });

    if (telegram_username) {
      const tgClean = String(telegram_username).replace('@', '').trim();
      await new Promise((resolve) => {
        db.run('UPDATE users SET telegram_username = ? WHERE id = ?', [tgClean, userId], () => resolve());
      });
    }

    const result = await wa.requestWithdraw(userId, amount, method, account_number, account_name);
    const wdId = result.id || result.withdrawId || result.insertId;
    if (!wdId) return res.json(result);

    const wdInfo = await getWithdrawWithUser(wdId);
    if (wdInfo) {
      telegram.notifyAdminWithdraw(wdInfo).catch(e => console.error('Notif WD error:', e.message));
    }

    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/withdraw/history', requireAuth, async (req, res) => {
  try {
    res.json(await wa.getWithdrawHistory(req.session.userId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ADMIN
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/withdraw/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    res.json(await wa.rejectWithdraw(req.params.id, reason || ''));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  db.all(`
    SELECT 
      u.id, u.email, u.name, u.phone, u.telegram_username,
      u.balance, u.role, u.total_referral, u.created_at,
      w.gopay_phone, w.ovo_phone, w.dana_phone,
      w.bank_name, w.bank_account, w.bank_holder
    FROM users u
    LEFT JOIN user_wallets w ON w.user_id = u.id
    WHERE u.role != 'admin'
    ORDER BY u.created_at DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/import-contacts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { deviceId, numbers } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib dipilih' });
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Tidak ada nomor yang di-import' });
    }
    if (numbers.length > 10000) return res.status(400).json({ error: 'Maksimal 10.000 nomor' });

    const validNumbers = numbers.filter(n => /^[0-9]{5,20}$/.test(String(n).trim()));
    if (validNumbers.length === 0) return res.status(400).json({ error: 'Format nomor tidak valid' });

    let inserted = 0, skipped = 0;

    if (deviceId === 'all') {
      for (const num of validNumbers) {
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM master_contacts WHERE phone = ?', [num], (err, row) => resolve(!!row));
        });
        if (!exists) {
          await new Promise((resolve) => {
            db.run('INSERT INTO master_contacts (phone, name) VALUES (?, ?)', [num, num], () => resolve());
          });
          inserted++;
        } else skipped++;
      }

      const allDevices = await new Promise((resolve) => {
        db.all('SELECT id FROM devices', (err, rows) => resolve(rows || []));
      });

      let totalSynced = 0;
      for (const device of allDevices) {
        const ins = await syncMasterToDevice(device.id);
        totalSynced += ins;
      }
      res.json({ success: true, inserted, skipped, total: validNumbers.length, synced_to_devices: allDevices.length, synced_rows: totalSynced });
    } else {
      for (const num of validNumbers) {
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM contacts WHERE device_id = ? AND phone = ?', [deviceId, num], (err, row) => resolve(!!row));
        });
        if (!exists) {
          await new Promise((resolve) => {
            db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)', [deviceId, num, num], () => resolve());
          });
          inserted++;
        } else skipped++;
      }
      res.json({ success: true, inserted, skipped, total: validNumbers.length });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/api/admin/delete-all-contacts', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM contacts', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Semua kontak dihapus' });
  });
});

app.post('/api/admin/delete-contacts/:deviceId', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM contacts WHERE device_id = ?', [req.params.deviceId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `Kontak ${req.params.deviceId} dihapus` });
  });
});

app.post('/api/admin/delete-master-contacts', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM master_contacts', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Master kontak dihapus' });
  });
});

app.get('/api/telegram/test', requireAuth, requireAdmin, async (req, res) => {
  const result = await telegram.testBot();
  res.json(result);
});

app.get('/api/telegram/webhook-info', requireAuth, requireAdmin, async (req, res) => {
  try {
    const info = await telegram.getWebhookInfo();
    res.json(info);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    console.log(` MarketingCuan running on http://localhost:${PORT}`);
    console.log(` WhatsApp Broadcast Platform`);
    console.log(` Rp1100/chat | Min WD Rp10.000`);

    const PUBLIC_URL = process.env.PUBLIC_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');

    if (PUBLIC_URL && process.env.TELEGRAM_BOT_TOKEN) {
      try {
        await telegram.setWebhook(PUBLIC_URL);
      } catch (e) {
        console.error('⚠️ Webhook setup gagal:', e.message);
      }
    } else {
      console.warn('⚠️ PUBLIC_URL / RAILWAY_PUBLIC_DOMAIN belum ada, webhook Telegram tidak di-set');
    }
  });
}
