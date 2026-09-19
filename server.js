const express = require('express');
const path = require('path');
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
/*
halaman sigma email admin untuk reset pw
wilzu ganteng @Wilzu22
*/
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: 'h11943352@gmail.com',
    pass: 'djmd ynus ozpd ilbc'  
  }
});

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Ganti FileStore dengan ini untuk testing di Vercel
app.use(session({
  store: new FileStore({
    path: '/app/data/sessions-store', // <-- Arahkan ke volume
    retries: 1,
    ttl: 7 * 24 * 60 * 60
  }),
  secret: process.env.SESSION_SECRET || 'marketingcuan_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: true, sameSite: 'none' }
}));
app.use(express.static(path.join(__dirname, 'public')));

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
      res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, balance: user.balance, role: user.role } });
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email tidak valid' });
    }
    if (username.length < 5 || username.length > 20) {
      return res.status(400).json({ error: 'Username harus 5-20 karakter' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore' });
    }
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ error: 'Nomor WhatsApp tidak valid (10-15 digit)' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }
    db.get('SELECT id FROM users WHERE email = ? OR name = ?', [email, username], async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) return res.status(400).json({ error: 'Email atau username sudah terdaftar' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const referralCode = username.substring(0, 4).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();

      let referrerId = null;

      if (ref) {
        const refRow = await new Promise((resolve, reject) => {
          db.get('SELECT id FROM users WHERE referral_code = ?', [ref], (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
        if (refRow) {
          referrerId = refRow.id;
        }
      }
      db.run(
        'INSERT INTO users (email, password, name, phone, referral_code, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [email, hashedPassword, username, phone, referralCode, referrerId],
        function(err) {
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
app.get('/api/referral', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT referral_code, total_referral FROM users WHERE id = ?', [userId], (err, row) => {
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
  const userId = req.session.userId;
  db.all(`
    SELECT r.*, u.name as referred_name, u.email as referred_email, u.created_at
    FROM referrals r
    JOIN users u ON r.referred_id = u.id
    WHERE r.referrer_id = ?
    ORDER BY r.created_at DESC
  `, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
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

app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email wajib diisi' });

    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      if (!user) {
        return res.json({ success: true, message: 'Jika email terdaftar, link reset akan dikirim.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 jam

      db.run('INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)',
        [email, token, expiresAt],
        async (err) => {
          if (err) return res.status(500).json({ error: err.message });

          const resetLink = `https://cumamarketing.online/reset-password?token=${token}`;
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
                  <p style="font-size: 12px; color: #888; margin-top: 20px;">Link ini berlaku selama 1 jam. Jika Anda tidak meminta reset password, abaikan email ini.</p>
                  <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;">
                  <p style="font-size: 12px; color: #888;">© MarketingCuan - Platform Manajemen Akun WA</p>
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
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token dan password baru wajib diisi' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password minimal 8 karakter' });
    }

    db.get(
      'SELECT email FROM password_resets WHERE token = ? AND expires_at > CURRENT_TIMESTAMP AND used = 0',
      [token],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) {
          return res.status(400).json({ error: 'Token tidak valid atau sudah kadaluwarsa' });
        }

        const hashedPassword = bcrypt.hashSync(newPassword, 10);

        db.run('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, row.email], (err) => {
          if (err) return res.status(500).json({ error: err.message });

          db.run('UPDATE password_resets SET used = 1 WHERE token = ?', [token], (err) => {
            if (err) console.error('Error updating token status:', err);
            res.json({ success: true, message: 'Password berhasil direset. Silakan login.' });
          });
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    const masterContacts = await new Promise((resolve, reject) => {
      db.all('SELECT phone, name FROM master_contacts', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
    if (masterContacts && masterContacts.length > 0) {
      for (const mc of masterContacts) {
        db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)',
          [id, mc.name || mc.phone, mc.phone]);
      }
      console.log(`✅ Copied ${masterContacts.length} master contacts to new device ${id}`);
    }

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

// ===== BROADCAST =====
app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const { deviceId, message, recipients, speed } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID wajib' });
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Minimal 1 penerima' });
    }

    let finalMessage = message;
    if (!finalMessage) {
      const settings = await new Promise((resolve, reject) => {
        db.get('SELECT value FROM settings WHERE key = ?', ['promo_text'], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
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
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    console.log('🔍 Stats request for user:', userId);
    const stats = await wa.getUserStats(userId);
    console.log('📊 Stats result:', stats);
    res.json(stats);
  } catch (error) {
    console.error('❌ Error in /api/stats:', error);
    res.status(500).json({ 
      error: error.message,
      total_devices: 0,
      online: 0,
      offline: 0,
      balance: 0,
      revenue: 0,
      total_sent: 0
    });
  }
});
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    db.all('SELECT * FROM settings', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const settings = {};
      rows.forEach(row => settings[row.key] = row.value);
      res.json(settings);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/settings', requireAuth, requireAdmin, async (req, res) => {
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
app.get('/api/wallet', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    db.get('SELECT * FROM user_wallets WHERE user_id = ?', [userId], (err, wallet) => {
      if (err) return res.status(500).json({ error: err.message });
      db.get('SELECT balance FROM users WHERE id = ?', [userId], (err2, user) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ balance: user?.balance || 0, wallet: wallet || null });
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/wallet', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { gopay_phone, ovo_phone, dana_phone, bank_name, bank_account, bank_holder } = req.body;
    db.run(
      `INSERT OR REPLACE INTO user_wallets 
       (user_id, gopay_phone, ovo_phone, dana_phone, bank_name, bank_account, bank_holder, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [userId, gopay_phone || null, ovo_phone || null, dana_phone || null, bank_name || null, bank_account || null, bank_holder || null],
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
    const userId = req.session.userId;
    const { amount, method, account_number, account_name } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
    if (!method) return res.status(400).json({ error: 'Metode wajib dipilih' });
    if (!account_number) return res.status(400).json({ error: 'Nomor akun wajib diisi' });
    if (!account_name) return res.status(400).json({ error: 'Nama pemilik akun wajib diisi' });
    const result = await wa.requestWithdraw(userId, amount, method, account_number, account_name);
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
    console.log(`✅ Approve withdraw ${req.params.id}`);
    const result = await wa.approveWithdraw(req.params.id, note || '');
    res.json(result);
  } catch (error) {
    console.error('❌ Error approve withdraw:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/withdraw/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {}; 
    console.log(`❌ Reject withdraw ${req.params.id}`);
    const result = await wa.rejectWithdraw(req.params.id, reason || '');
    res.json(result);
  } catch (error) {
    console.error('❌ Error reject withdraw:', error);
    res.status(500).json({ error: error.message });
  }
});
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
    const validNumbers = numbers.filter(n => /^[0-9]{5,20}$/.test(n));
    if (validNumbers.length === 0) {
      return res.status(400).json({ error: 'Format nomor tidak valid! Hanya angka, minimal 5 digit.' });
    }
    let inserted = 0, skipped = 0;
    if (deviceId === 'all') {
      for (const num of validNumbers) {
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM master_contacts WHERE phone = ?', [num], (err, row) => {
            resolve(!!row);
          });
        });
        if (!exists) {
          db.run('INSERT INTO master_contacts (phone, name) VALUES (?, ?)', [num, num]);
          inserted++;
        } else {
          skipped++;
        }
      }

      let devices = await wa.getDevices(req.session.userId);
      if (devices.length === 0) {
        const newDeviceId = uuidv4().substring(0, 10);
        await wa.createDevice(newDeviceId, req.session.userId, 'Master Kontak', '');
        devices = await wa.getDevices(req.session.userId);
      }
      for (const device of devices) {
        for (const num of validNumbers) {
          const exists = await new Promise((resolve) => {
            db.get('SELECT id FROM contacts WHERE device_id = ? AND phone = ?', [device.id, num], (err, row) => {
              resolve(!!row);
            });
          });
          if (!exists) {
            db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)', [device.id, num, num]);
          }
        }
      }
    } else {
      for (const num of validNumbers) {
        const exists = await new Promise((resolve) => {
          db.get('SELECT id FROM contacts WHERE device_id = ? AND phone = ?', [deviceId, num], (err, row) => {
            resolve(!!row);
          });
        });
        if (!exists) {
          db.run('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, 0)', [deviceId, num, num]);
          inserted++;
        } else {
          skipped++;
        }
      }
    }

    res.json({ success: true, inserted, skipped, total: validNumbers.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/admin/reset-profit/:deviceId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { deviceId } = req.params;
    db.run('UPDATE devices SET profit = 0 WHERE id = ?', [deviceId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: `Profit device ${deviceId} direset ke 0` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/reset-all-profit', requireAuth, requireAdmin, async (req, res) => {
  try {
    db.run('UPDATE devices SET profit = 0', function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Semua profit device direset ke 0' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/admin/delete-all-contacts', requireAuth, requireAdmin, async (req, res) => {
  try {
    db.run('DELETE FROM contacts', function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Semua kontak target blast berhasil dihapus!' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/delete-contacts/:deviceId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { deviceId } = req.params;
    db.run('DELETE FROM contacts WHERE device_id = ?', [deviceId], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: `Kontak device ${deviceId} berhasil dihapus!` });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/delete-master-contacts', requireAuth, requireAdmin, async (req, res) => {
  try {
    db.run('DELETE FROM master_contacts', function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: 'Master kontak berhasil dihapus!' });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/*
exceut by wilzu get base https
nyoli 1100x
*/
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

app.use((req, res) => {
  res.redirect('/');
});
// ✅ GANTI JADI INI
module.exports = app;

// Supaya tetap bisa jalan lokal pakai `node server.js`
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(` MarketingCuan running on http://localhost:${PORT}`);
  console.log(`WhatsApp Broadcast Platform with Monetization`);
  console.log(`Rp600/chat | Min WD Rp10.000`);
  console.log(`Tampilan Fullwidth (ＴＥＸＴ　ＦＯＮＴ)`);
  console.log(` Login: admin@marketingcuan.com / admin123`);
});
}
