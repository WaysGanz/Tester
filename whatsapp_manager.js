const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./database');
const telegram = require('./telegram');

// ============================================
// ✅ Session WA disimpan di /app/data (persisten)
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;
const WA_SESSION_BASE = path.join(DATA_DIR, 'wa-sessions');

try {
  if (!fs.existsSync(WA_SESSION_BASE)) {
    fs.mkdirSync(WA_SESSION_BASE, { recursive: true });
  }
  console.log('📁 WA Session base:', WA_SESSION_BASE);
} catch (e) {
  console.error('❌ Gagal bikin folder WA session:', e.message);
}

class WhatsAppManager {
  constructor() {
    this.sockets = new Map();
    this.qrCodes = new Map();
    this.statuses = new Map();
    this.reconnectTimers = new Map();
    this.pairingCodes = new Map();
    // 🔥 Guard supaya notif owner cuma dikirim SEKALI per device per sesi
    this.pairedNotified = new Map();
  }

  getSessionPath(deviceId) {
    return path.join(WA_SESSION_BASE, deviceId);
  }

  // ============================================
  // 🔥 NOTIF OWNER SAAT USER PAIRING BERHASIL
  // ============================================
  async notifyOwnerPaired(deviceId, method, rawPhone = '') {
    // Guard: cuma kirim sekali per device (per runtime)
    if (this.pairedNotified.has(deviceId)) {
      console.log(`ℹ️ Notif pairing untuk ${deviceId} sudah dikirim, skip`);
      return;
    }
    this.pairedNotified.set(deviceId, Date.now());

    try {
      // Ambil data device + user dari DB
      const info = await new Promise((resolve) => {
        db.get(`
          SELECT 
            d.id as device_id, d.name as device_name, d.phone as device_phone,
            u.id as user_id, u.name as user_name, u.email as user_email
          FROM devices d
          JOIN users u ON d.user_id = u.id
          WHERE d.id = ?
        `, [deviceId], (err, row) => resolve(row));
      });

      if (!info) {
        console.warn(`⚠️ Device ${deviceId} gak ketemu di DB, skip notif`);
        return;
      }

      // Tentukan nomor: pakai rawPhone (dari input pairing) atau dari DB (dari WA session)
      let phone = rawPhone || info.device_phone || '';
      phone = String(phone).replace(/@.*$/, '').replace(/[^0-9]/g, '');

      await telegram.notifyOwnerDevicePaired({
        user_id: info.user_id,
        user_name: info.user_name,
        user_email: info.user_email,
        device_id: info.device_id,
        device_name: info.device_name,
        phone: phone,
        method: method,
        time: new Date().toLocaleString('id-ID')
      });
    } catch (e) {
      console.error('❌ notifyOwnerPaired error:', e.message);
    }
  }

  async createDevice(deviceId, userId, name, phone = '') {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO devices (id, user_id, name, phone, status, mode, profit, sent) 
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
        [deviceId, userId, name, phone, 'disconnected', 'FAST (1s)'],
        function (err) {
          if (err) reject(err);
          else resolve({ id: deviceId, name, phone, status: 'disconnected' });
        }
      );
    });
  }

  async getDevices(userId) {
    return new Promise((resolve, reject) => {
      db.all(
        'SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async deleteDevice(deviceId, userId) {
    if (this.sockets.has(deviceId)) {
      await this.stopDevice(deviceId);
    }
    if (this.reconnectTimers.has(deviceId)) {
      clearTimeout(this.reconnectTimers.get(deviceId));
      this.reconnectTimers.delete(deviceId);
    }
    const sessionPath = this.getSessionPath(deviceId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    this.sockets.delete(deviceId);
    this.qrCodes.delete(deviceId);
    this.statuses.delete(deviceId);
    this.pairingCodes.delete(deviceId);
    this.pairedNotified.delete(deviceId);

    return new Promise((resolve, reject) => {
      db.run('DELETE FROM devices WHERE id = ? AND user_id = ?', [deviceId, userId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // ============================================
  // START DEVICE — FLOW QR CODE (TANPA NOMOR)
  // ============================================
  async startDevice(deviceId) {
    if (this.reconnectTimers.has(deviceId)) {
      clearTimeout(this.reconnectTimers.get(deviceId));
      this.reconnectTimers.delete(deviceId);
    }

    if (this.sockets.has(deviceId)) {
      return { status: 'already_running' };
    }

    const sessionPath = this.getSessionPath(deviceId);
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60000,
      });

      this.sockets.set(deviceId, sock);
      this.statuses.set(deviceId, 'connecting');

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrImage = await QRCode.toDataURL(qr);
            this.qrCodes.set(deviceId, qrImage);
            this.statuses.set(deviceId, 'qr_scanned');
            await this.updateDeviceStatus(deviceId, 'qr_scanned');
            console.log(`QR Code generated for ${deviceId}`);
          } catch (error) {
            console.error(`Error generating QR for ${deviceId}:`, error);
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error instanceof Boom)
            ? lastDisconnect.error.output.statusCode
            : undefined;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          this.sockets.delete(deviceId);
          this.qrCodes.delete(deviceId);
          this.statuses.set(deviceId, 'disconnected');
          await this.updateDeviceStatus(deviceId, 'disconnected');

          if (shouldReconnect) {
            console.log(`Reconnecting ${deviceId} in 5 seconds...`);
            const timer = setTimeout(() => {
              this.reconnectTimers.delete(deviceId);
              this.startDevice(deviceId);
            }, 5000);
            this.reconnectTimers.set(deviceId, timer);
          } else {
            console.log(`Device ${deviceId} logged out`);
            // Reset notif flag kalau logout
            this.pairedNotified.delete(deviceId);
          }
        }

        // 🔥 SAAT CONNECTED (QR FLOW)
        if (connection === 'open') {
          this.qrCodes.delete(deviceId);
          this.statuses.set(deviceId, 'connected');
          await this.updateDeviceStatus(deviceId, 'connected');
          console.log(`Device ${deviceId} connected!`);

          const { user } = sock.authState.creds;
          let connectedPhone = '';
          if (user) {
            connectedPhone = user.split(':')[0] + '@s.whatsapp.net';
            await this.updateDevicePhone(deviceId, connectedPhone);
          }

          // 🔥 NOTIF OWNER (method: QR)
          // Hanya kirim kalau ini device baru (belum pernah di-notif)
          await this.notifyOwnerPaired(deviceId, 'QR', connectedPhone);

          this.loadContacts(deviceId, sock);
        }
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('messaging-history.set', async ({ contacts }) => {
        if (contacts && contacts.length > 0) {
          await this.saveContacts(deviceId, contacts);
        }
      });

      sock.ev.on('contacts.update', async (updates) => {
        for (const update of updates) {
          if (update.id && update.name) {
            await this.updateContact(deviceId, update.id, update.name);
          }
        }
      });

      return { status: 'starting' };
    } catch (error) {
      console.error(`Error starting device ${deviceId}:`, error);
      this.sockets.delete(deviceId);
      this.statuses.set(deviceId, 'error');
      await this.updateDeviceStatus(deviceId, 'error');
      throw error;
    }
  }

  async stopDevice(deviceId) {
    if (this.reconnectTimers.has(deviceId)) {
      clearTimeout(this.reconnectTimers.get(deviceId));
      this.reconnectTimers.delete(deviceId);
    }

    const sock = this.sockets.get(deviceId);
    if (sock) {
      try { await sock.logout(); } catch (e) { /* silent */ }
      this.sockets.delete(deviceId);
      this.qrCodes.delete(deviceId);
      this.statuses.set(deviceId, 'disconnected');
      await this.updateDeviceStatus(deviceId, 'disconnected');
      return { status: 'stopped' };
    }
    return { status: 'not_found' };
  }

  async getQR(deviceId) {
    return this.qrCodes.get(deviceId) || null;
  }

  getStatus(deviceId) {
    return this.statuses.get(deviceId) || 'disconnected';
  }

  async updateDeviceStatus(deviceId, status) {
    return new Promise((resolve) => {
      db.run('UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, deviceId], (err) => {
        if (err) console.error(`Error updating status for ${deviceId}:`, err);
        else console.log(`✅ Device ${deviceId} status: ${status}`);
        resolve();
      });
    });
  }

  async updateDevicePhone(deviceId, phone) {
    return new Promise((resolve) => {
      db.run('UPDATE devices SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [phone, deviceId], (err) => {
        if (err) console.error(`Error updating phone for ${deviceId}:`, err);
        resolve();
      });
    });
  }

  async updateDeviceMode(deviceId, mode) {
    return new Promise((resolve) => {
      db.run('UPDATE devices SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mode, deviceId], (err) => {
        if (err) console.error(`Error updating mode for ${deviceId}:`, err);
        resolve();
      });
    });
  }

  // ============================================
  // PAIRING CODE — FLOW DENGAN NOMOR HP
  // ============================================
  async requestPairingCode(deviceId, phoneNumber) {
    const device = await this.getDevice(deviceId);
    if (!device) throw new Error('Device tidak ditemukan');

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Nomor HP tidak valid. Minimal 10 digit.');
    }

    if (this.sockets.has(deviceId)) await this.stopDevice(deviceId);

    if (this.reconnectTimers.has(deviceId)) {
      clearTimeout(this.reconnectTimers.get(deviceId));
      this.reconnectTimers.delete(deviceId);
    }

    const sessionPath = this.getSessionPath(deviceId);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    fs.mkdirSync(sessionPath, { recursive: true });

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        browser: ["Ubuntu", "Chrome", "24.0.04"],
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' }),
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60000,
      });

      this.sockets.set(deviceId, sock);
      this.statuses.set(deviceId, 'pairing');
      sock.ev.on('creds.update', saveCreds);

      let codeRequested = false;
      let pairingTimeout = setTimeout(() => {
        if (!codeRequested) console.log(`Pairing timeout for ${deviceId}`);
      }, 20000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if ((connection === 'connecting' || qr) && !codeRequested && !sock.authState.creds.registered) {
          codeRequested = true;
          clearTimeout(pairingTimeout);
          try {
            await new Promise((r) => setTimeout(r, 1500));
            const code = await sock.requestPairingCode(cleanPhone);
            this.pairingCodes.set(deviceId, code);
            console.log(`Pairing code for ${deviceId}: ${code}`);
          } catch (err) {
            console.error(`Gagal request pairing code untuk ${deviceId}:`, err);
            this.statuses.set(deviceId, 'error');
            await this.updateDeviceStatus(deviceId, 'error');
          }
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error instanceof Boom)
            ? lastDisconnect.error.output.statusCode
            : undefined;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          this.sockets.delete(deviceId);
          this.statuses.set(deviceId, 'disconnected');
          await this.updateDeviceStatus(deviceId, 'disconnected');

          if (shouldReconnect) {
            setTimeout(() => this.startDevice(deviceId), 5000);
          }
        }

        // 🔥 SAAT CONNECTED (PAIRING CODE FLOW)
        if (connection === 'open') {
          this.statuses.set(deviceId, 'connected');
          await this.updateDeviceStatus(deviceId, 'connected');
          console.log(`Device ${deviceId} connected via pairing!`);

          const { user } = sock.authState.creds;
          let connectedPhone = cleanPhone;
          if (user) {
            connectedPhone = user.split(':')[0];
            await this.updateDevicePhone(deviceId, connectedPhone + '@s.whatsapp.net');
          }

          // 🔥 NOTIF OWNER (method: Pairing Code) — pakai nomor yang diinput user
          await this.notifyOwnerPaired(deviceId, 'Pairing Code', cleanPhone);

          this.loadContacts(deviceId, sock);
        }
      });

      const code = await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = setInterval(() => {
          if (this.pairingCodes.has(deviceId)) {
            clearInterval(check);
            resolve(this.pairingCodes.get(deviceId));
          } else if (this.statuses.get(deviceId) === 'error' || this.statuses.get(deviceId) === 'disconnected') {
            clearInterval(check);
            reject(new Error('Gagal mendapatkan pairing code.'));
          } else if (Date.now() - start > 25000) {
            clearInterval(check);
            reject(new Error('Timeout menunggu pairing code.'));
          }
        }, 300);
      });

      return { code, status: 'pairing' };
    } catch (error) {
      this.sockets.delete(deviceId);
      this.statuses.set(deviceId, 'disconnected');
      throw new Error(`Gagal request pairing code: ${error.message}`);
    }
  }

  // ===== CONTACTS =====
  async loadContacts(deviceId, sock) {
    try {
      let contacts = [];
      if (sock.contacts) contacts = Array.from(sock.contacts.values());

      if (contacts.length === 0 && sock.chats) {
        for (const [key, chat] of sock.chats) {
          if (key.includes('@s.whatsapp.net') && !key.includes('@g.us')) {
            if (chat && chat.name) contacts.push({ id: key, name: chat.name, isGroup: false });
          }
        }
      }

      if (contacts.length > 0) await this.saveContacts(deviceId, contacts);
    } catch (error) {
      console.error(`Error loading contacts for ${deviceId}:`, error);
    }
  }

  async saveContacts(deviceId, contacts) {
    if (!contacts || contacts.length === 0) return;
    return new Promise((resolve) => {
      db.run('DELETE FROM contacts WHERE device_id = ?', [deviceId], (err) => {
        if (err) return resolve();
        const stmt = db.prepare('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, ?)');
        for (const c of contacts) {
          if (c.id && (c.verifiedName || c.name || c.pushname)) {
            const name = c.verifiedName || c.name || c.pushname || 'Unknown';
            stmt.run(deviceId, name, c.id, c.isGroup ? 1 : 0);
          }
        }
        stmt.finalize();
        resolve();
      });
    });
  }

  async updateContact(deviceId, jid, name) {
    return new Promise((resolve) => {
      db.run('UPDATE contacts SET name = ? WHERE device_id = ? AND phone = ?', [name, deviceId, jid], () => resolve());
    });
  }

  async getContacts(deviceId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM contacts WHERE device_id = ? ORDER BY name ASC', [deviceId], (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    });
  }

  // ===== HELPERS =====
  async getPricePerChat() {
    return new Promise((resolve) => {
      db.get('SELECT value FROM settings WHERE key = ?', ['price_per_chat'], (err, row) => {
        resolve(parseInt(row?.value) || 1100);
      });
    });
  }

  async getMinWithdraw() {
    return new Promise((resolve) => {
      db.get('SELECT value FROM settings WHERE key = ?', ['min_withdraw'], (err, row) => {
        resolve(parseInt(row?.value) || 10000);
      });
    });
  }

  // ============================================
  // 🔥 PURGE — HAPUS DARI MASTER + SEMUA CONTACTS
  // ============================================
  async purgeNumbersFromEverywhere(phones) {
    if (!phones || phones.length === 0) return { master: 0, contacts: 0 };

    const BATCH_SIZE = 500;
    let totalMaster = 0;
    let totalContacts = 0;

    for (let i = 0; i < phones.length; i += BATCH_SIZE) {
      const batch = phones.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');

      const masterResult = await new Promise((resolve) => {
        db.run(`DELETE FROM master_contacts WHERE phone IN (${placeholders})`, batch, function (err) {
          if (err) { console.error('❌ Purge master error:', err.message); resolve(0); }
          else resolve(this.changes);
        });
      });
      totalMaster += masterResult;

      const contactsResult = await new Promise((resolve) => {
        db.run(`DELETE FROM contacts WHERE phone IN (${placeholders})`, batch, function (err) {
          if (err) { console.error('❌ Purge contacts error:', err.message); resolve(0); }
          else resolve(this.changes);
        });
      });
      totalContacts += contactsResult;
    }

    console.log(`🗑️ PURGE TOTAL: ${totalMaster} master, ${totalContacts} contacts (${phones.length} nomor)`);
    return { master: totalMaster, contacts: totalContacts };
  }

  // ============================================
  // 🔥 BROADCAST + AUTO PURGE
  // ============================================
  async sendBroadcast(deviceId, message, recipients, userId, delay = 1000) {
    const sock = this.sockets.get(deviceId);
    if (!sock) throw new Error('Device not connected');
    if (!recipients || recipients.length === 0) throw new Error('Tidak ada recipient');

    const broadcastId = await this.saveBroadcast(deviceId, message, recipients.length);

    let sent = 0, failed = 0;
    const sentPhones = [];
    const actualDelay = Math.max(500, delay);

    console.log(`📤 Broadcast ${deviceId} → ${recipients.length} penerima`);

    for (const phone of recipients) {
      try {
        let jid = phone;
        if (!jid.includes('@')) jid = phone + '@s.whatsapp.net';
        else if (!jid.includes('@s.whatsapp.net') && !jid.includes('@g.us')) {
          jid = jid.split('@')[0] + '@s.whatsapp.net';
        }

        await sock.sendMessage(jid, { text: message });
        sent++;
        sentPhones.push(phone);
        await this.updateRecipientStatus(broadcastId, phone, 'sent');
        await this.addProfit(deviceId, userId, 1);
        console.log(`✅ Sent ${sent}/${recipients.length}: ${phone}`);
      } catch (error) {
        failed++;
        await this.updateRecipientStatus(broadcastId, phone, 'failed', error.message);
        console.error(`❌ Failed ${phone}:`, error.message);
      }
      await new Promise(r => setTimeout(r, actualDelay));
    }

    await this.updateBroadcastStatus(broadcastId, sent, failed, 'completed');
    await this.updateDeviceStats(deviceId, sent);

    if (sentPhones.length > 0) {
      await this.purgeNumbersFromEverywhere(sentPhones);
    } else {
      console.log('ℹ️ Gak ada nomor sukses, skip purge');
    }

    console.log(`📊 Broadcast selesai: sent=${sent}, failed=${failed}, total=${recipients.length}`);
    return { sent, failed, total: recipients.length, purged: sentPhones.length };
  }

  async addProfit(deviceId, userId, count) {
    const price = await this.getPricePerChat();
    const totalProfit = price * count;

    return new Promise((resolve) => {
      db.run('UPDATE devices SET profit = profit + ? WHERE id = ?', [totalProfit, deviceId]);
      db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [totalProfit, userId]);
      db.run(
        'INSERT INTO transactions (user_id, device_id, amount, type, description) VALUES (?, ?, ?, ?, ?)',
        [userId, deviceId, totalProfit, 'profit', `${count} chat @ Rp${price}`],
        () => resolve()
      );
    });
  }

  async updateDeviceStats(deviceId, sent) {
    return new Promise((resolve) => {
      db.run('UPDATE devices SET sent = sent + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sent, deviceId], () => resolve());
    });
  }

  async getDevice(deviceId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM devices WHERE id = ?', [deviceId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
  }

  async saveBroadcast(deviceId, message, total) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO broadcasts (device_id, message, recipients, status) VALUES (?, ?, ?, ?)',
        [deviceId, message, total, 'processing'],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async updateBroadcastStatus(id, sent, failed, status) {
    return new Promise((resolve) => {
      db.run('UPDATE broadcasts SET sent = ?, failed = ?, status = ? WHERE id = ?', [sent, failed, status, id], () => resolve());
    });
  }

  async updateRecipientStatus(broadcastId, phone, status, error = null) {
    return new Promise((resolve) => {
      db.run(
        'INSERT INTO broadcast_recipients (broadcast_id, phone, status, error, sent_at) VALUES (?, ?, ?, ?, ?)',
        [broadcastId, phone, status, error, status === 'sent' ? new Date().toISOString() : null],
        () => resolve()
      );
    });
  }

  async getBroadcastHistory(userId, deviceId = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT b.*, d.name as device_name 
        FROM broadcasts b 
        JOIN devices d ON b.device_id = d.id 
        WHERE d.user_id = ?
      `;
      const params = [userId];
      if (deviceId) { query += ' AND b.device_id = ?'; params.push(deviceId); }
      query += ' ORDER BY b.created_at DESC LIMIT 50';
      db.all(query, params, (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    });
  }

  async getUserStats(userId) {
    return new Promise((resolve, reject) => {
      db.get(
        `
        SELECT 
          (SELECT COUNT(*) FROM devices WHERE user_id = ?) as total_devices,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'connected') as online,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'disconnected') as offline,
          (SELECT COALESCE(balance, 0) FROM users WHERE id = ?) as balance,
          (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type = 'profit') as revenue,
          (SELECT COALESCE(SUM(b.sent), 0) FROM broadcasts b JOIN devices d ON b.device_id = d.id WHERE d.user_id = ? AND b.status = 'completed') as total_sent
        `,
        [userId, userId, userId, userId, userId, userId],
        (err, row) => {
          if (err) reject(err);
          else resolve({
            total_devices: row?.total_devices || 0,
            online: row?.online || 0,
            offline: row?.offline || 0,
            balance: row?.balance || 0,
            revenue: row?.revenue || 0,
            total_sent: row?.total_sent || 0
          });
        }
      );
    });
  }

  async getUser(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT id, email, name, balance, role FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
  }

  async updateUserBalance(userId, amount) {
    return new Promise((resolve, reject) => {
      db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  async requestWithdraw(userId, amount, method, accountNumber, accountName) {
    const user = await this.getUser(userId);
    if (!user) throw new Error('User tidak ditemukan');
    if (user.balance < amount) throw new Error(`Saldo tidak mencukupi (Saldo: Rp${user.balance.toLocaleString()})`);

    const min = await this.getMinWithdraw();
    if (amount < min) throw new Error(`Minimal withdraw Rp${min.toLocaleString()}`);

    await this.updateUserBalance(userId, -amount);

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO withdrawals (user_id, amount, method, account_number, account_name, status) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, amount, method, accountNumber, accountName, 'pending'],
        function (err) {
          if (err) {
            this.updateUserBalance(userId, amount);
            reject(err);
          } else {
            resolve({ id: this.lastID, status: 'pending' });
          }
        }
      );
    });
  }

  async getWithdrawHistory(userId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    });
  }

  async getPendingWithdrawals() {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT w.*, u.email, u.name, u.telegram_username 
         FROM withdrawals w 
         JOIN users u ON w.user_id = u.id 
         WHERE w.status = 'pending' 
         ORDER BY w.created_at ASC`,
        [],
        (err, rows) => {
          if (err) reject(err); else resolve(rows);
        }
      );
    });
  }

  async approveWithdraw(withdrawId, adminNote = '') {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE withdrawals SET status = 'approved', processed_at = CURRENT_TIMESTAMP, note = ? WHERE id = ?`,
        [adminNote, withdrawId],
        function (err) {
          if (err) reject(err);
          else resolve({ success: true });
        }
      );
    });
  }

  async rejectWithdraw(withdrawId, reason = '') {
    db.get('SELECT user_id, amount FROM withdrawals WHERE id = ?', [withdrawId], (err, row) => {
      if (err || !row) return;
      this.updateUserBalance(row.user_id, row.amount).catch(console.error);
    });

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE withdrawals SET status = 'rejected', note = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [reason, withdrawId],
        function (err) {
          if (err) reject(err);
          else resolve({ success: true });
        }
      );
    });
  }

  async cleanup() {
    for (const [deviceId, sock] of this.sockets) {
      try { await sock.logout(); } catch (e) {}
    }
    this.sockets.clear();
    this.qrCodes.clear();
    this.statuses.clear();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.pairedNotified.clear();
  }
}

module.exports = new WhatsAppManager();
