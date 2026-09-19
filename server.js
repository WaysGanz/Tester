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

const app = express();
const PORT = process.env.PORT || 1901;

app.set('trust proxy', 1);

// ============================================
// Folder Data & Session
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
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

app.use(session({
  store: new FileStore({
    path: SESSION_DIR,
    retries: 1,
    ttl: 7 * 24 * 60 * 60
  }),
  secret: process.env.SESSION_SECRET || 'marketingcuan_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    httpOnly: true
  }
}));

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

// Helper: copy master_contacts ke satu device (return jumlah inserted)
function syncMasterToDevice(deviceId) {
  return new Promise((resolve) => {
    db.all('SELECT phone, name FROM master_contacts', (err, masters) => {
      if (err || !masters || masters.length === 0) return resolve(0);
      let pending = 0;
      let inserted = 0;
      const total = masters.length;

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

// ============================================
// AUTH
// ============================================
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
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
        if (saveErr) {
          console.error('❌ Session save error:', saveErr);
          return res.status(500).json({ error: 'Gagal menyimpan session' });
        }
        console.log('✅ Login sukses:', user.email);
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { email, username, phone, password, ref } = req.body;
    if (!email || !username || !phone || !password) {
      return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email tidak valid' });
    if (username.length < 5 || username.length > 20) return res.status(400).json({ error: 'Username harus 5-20 karakter' });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
    if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (10-15 digit)' });
    if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter' });

    db.get('SELECT id FROM users WHERE email = ? OR name = ?', [email, username], async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
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
        'INSERT INTO users (email, password, name, phone, referral_code, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [email, hashedPassword, username, phone, referralCode, referrerId],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });
          const newUserId = this.lastID;
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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  db.get('SELECT id, email, name, phone, balance, role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(user);
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
                  <p>Klik tombol di bawah untuk mengatur password baru:</p>
                  <div style="text-align: center; margin: 30px 0;">
                    <a href="${resetLink}" style="background: #075E54; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                      Reset Password
                    </a>
                  </div>
                  <p>Atau salin link ini ke browser:</p>
                  <p style="background: #f5f5f5; padding: 10px; border-radius: 6px; word-break: break-all; font-size: 14px;">${resetLink}</p>
                  <p style="font-size: 12px; color: #888; margin-top: 20px;">Link ini berlaku selama 1 jam.</p>
                  <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
                  <p style="font-size: 12px; color: #888;">© MarketingCuan</p>
                </div>
              `
            });
            console.log(`✅ Email reset terkirim ke ${email}`);
          } catch (emailErr) {
            console.error('❌ Gagal kirim email:', emailErr);
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

// ⚠️ PENTING: route statis didahulukan supaya gak bentrok
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
          COALESCE(SUM(sent), 0) as total_sent,
          COALESCE(SUM(failed), 0) as total_failed,
          COUNT(*) as total_campaigns,
          COALESCE(SUM(recipients), 0) as total_recipients
        FROM broadcast_history
        WHERE user_id = ?
      `, [userId], (err3, hist) => {
        const finish = (sent, failed, camps, recips) => {
          db.get(`
            SELECT COUNT(DISTINCT c.phone) as unique_total
            FROM contacts c
            JOIN devices d ON c.device_id = d.id
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
          // Fallback tanpa kolom failed
          db.get(`
            SELECT COALESCE(SUM(sent), 0) as total_sent,
                   COUNT(*) as total_campaigns,
                   COALESCE(SUM(recipients), 0) as total_recipients
            FROM broadcast_history WHERE user_id = ?
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

    // Auto-copy master contacts ke device baru
    const inserted = await syncMasterToDevice(id);
    if (inserted > 0) console.log(`✅ Copied ${inserted} master contacts to device ${id}`);

    await wa.startDevice(id);
    res.json(device);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/start', requireAuth, async (req, res) => {
  try {
    const result = await wa.startDevice(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/stop', requireAuth, async (req, res) => {
  try {
    const result = await wa.stopDevice(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    await wa.deleteDevice(req.params.id, req.session.userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/qr', requireAuth, async (req, res) => {
  try {
    const qr = await wa.getQR(req.params.id);
    res.json({ qr: qr || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
  try {
    const { mode } = req.body;
    await wa.updateDeviceMode(req.params.id, mode);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/contacts', requireAuth, async (req, res) => {
  try {
    const contacts = await wa.getContacts(req.params.id);
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SYNC master contacts → device user
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
      return res.json({ success: true, inserted: 0, total: 0, message: 'Belum ada master kontak dari admin' });
    }

    const inserted = await syncMasterToDevice(deviceId);
    console.log(`🔄 Sync device ${deviceId}: +${inserted} dari ${totalMaster} master`);

    res.json({
      success: true,
      inserted,
      total: totalMaster,
      message: inserted > 0
        ? `${inserted} kontak baru disync dari ${totalMaster} master`
        : `Semua kontak sudah up-to-date (${totalMaster} master)`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CONTACTS SUMMARY (dashboard)
// ============================================
app.get('/api/contacts/summary', requireAuth, (req, res) => {
  const userId = req.session.userId;

  db.get('SELECT COUNT(*) as total, MAX(created_at) as last_update FROM master_contacts', (err, masterRow) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(`
      SELECT COUNT(DISTINCT c.phone) as unique_total, COUNT(*) as total
      FROM contacts c
      JOIN devices d ON c.device_id = d.id
      WHERE d.user_id = ?
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
      finalMessage = settings?.value || 'Pesan broadcast dari MarketingCuan';
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
    const history = await wa.getBroadcastHistory(req.session.userId, deviceId || null);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STATS
// ============================================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = await wa.getUserStats(req.session.userId);
    res.json(stats);
  } catch (error) {
    console.error('❌ Error in /api/stats:', error);
    res.status(500).json({
      error: error.message,
      total_devices: 0, online: 0, offline: 0,
      balance: 0, revenue: 0, total_sent: 0
    });
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

app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const { amount, method, account_number, account_name } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
    if (!method) return res.status(400).json({ error: 'Metode wajib dipilih' });
    if (!account_number) return res.status(400).json({ error: 'Nomor akun wajib diisi' });
    if (!account_name) return res.status(400).json({ error: 'Nama pemilik akun wajib diisi' });
    const result = await wa.requestWithdraw(req.session.userId, amount, method, account_number, account_name);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/withdraw/history', requireAuth, async (req, res) => {
  try {
    const history = await wa.getWithdrawHistory(req.session.userId);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ADMIN
// ============================================
app.get('/api/admin/withdraw/pending', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pending = await wa.getPendingWithdrawals();
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/withdraw/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { note } = req.body || {};
    const result = await wa.approveWithdraw(req.params.id, note || '');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/withdraw/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await wa.rejectWithdraw(req.params.id, reason || '');
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IMPORT CONTACTS — sync ke SEMUA device semua user
app.post('/api/admin/import-contacts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { deviceId, numbers } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib dipilih' });
    if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Tidak ada nomor yang di-import' });
    }
    if (numbers.length > 10000) {
      return res.status(400).json({ error: 'Maksimal 10.000 nomor sekali import' });
    }
    const validNumbers = numbers.filter(n => /^[0-9]{5,20}$/.test(String(n).trim()));
    if (validNumbers.length === 0) {
      return res.status(400).json({ error: 'Format nomor tidak valid! Hanya angka, minimal 5 digit.' });
    }

    let inserted = 0, skipped = 0;

    if (deviceId === 'all') {
      // 1. Insert ke master_contacts
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

      // 2. Sync ke SEMUA device milik SEMUA user
      const allDevices = await new Promise((resolve) => {
        db.all('SELECT id FROM devices', (err, rows) => resolve(rows || []));
      });

      let totalSynced = 0;
      for (const device of allDevices) {
        const ins = await syncMasterToDevice(device.id);
        totalSynced += ins;
      }

      console.log(`✅ Admin import: ${inserted} master baru, ${totalSynced} contact rows synced ke ${allDevices.length} device`);

      res.json({
        success: true,
        inserted,
        skipped,
        total: validNumbers.length,
        synced_to_devices: allDevices.length,
        synced_rows: totalSynced
      });
    } else {
      // Import ke device tertentu (langsung ke contacts device itu)
      for (const num of validNumbers) {
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM contacts WHERE device_id = ? AND phone = ?',
            [deviceId, num], (err, row) => resolve(!!row));
        });
        if (!exists) {
          await new Promise((resolve) => {
            db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)',
              [deviceId, num, num], () => resolve());
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
    res.json({ success: true, message: `Profit device ${req.params.deviceId} direset ke 0` });
  });
});

app.post('/api/admin/reset-all-profit', requireAuth, requireAdmin, (req, res) => {
  db.run('UPDATE devices SET profit = 0', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Semua profit device direset ke 0' });
  });
});

app.post('/api/admin/delete-all-contacts', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM contacts', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Semua kontak target blast berhasil dihapus!' });
  });
});

app.post('/api/admin/delete-contacts/:deviceId', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM contacts WHERE device_id = ?', [req.params.deviceId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `Kontak device ${req.params.deviceId} berhasil dihapus!` });
  });
});

app.post('/api/admin/delete-master-contacts', requireAuth, requireAdmin, (req, res) => {
  db.run('DELETE FROM master_contacts', function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Master kontak berhasil dihapus!' });
  });
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(` MarketingCuan running on http://localhost:${PORT}`);
    console.log(` WhatsApp Broadcast Platform with Monetization`);
    console.log(` Rp1100/chat | Min WD Rp10.000`);
    console.log(` Login: admin@marketingcuan.com / admin123`);
  });
}
