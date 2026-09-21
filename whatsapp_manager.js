const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./database');
const telegram = require('./telegram');

const DATA_DIR = process.env.NODE_ENV === 'production' ? '/home/data' : __dirname;
const WA_SESSION_BASE = path.join(DATA_DIR, 'wa-sessions');

try {
  if (!fs.existsSync(WA_SESSION_BASE)) fs.mkdirSync(WA_SESSION_BASE, { recursive: true });
  console.log('📁 WA session:', WA_SESSION_BASE);
} catch (e) { console.error('❌ WA session:', e.message); }

class WhatsAppManager {
  constructor() {
    this.sockets = new Map();
    this.qrCodes = new Map();
    this.statuses = new Map();
    this.reconnectTimers = new Map();
    this.pairingCodes = new Map();
    this.pairedNotified = new Map();
  }

  cleanPhone(phone) {
    if (!phone) return '';
    return String(phone).replace(/@.*$/, '').replace(/[^0-9]/g, '');
  }

  getSessionPath(deviceId) { return path.join(WA_SESSION_BASE, deviceId); }

  async notifyOwnerPaired(deviceId, method, rawPhone = '') {
    if (this.pairedNotified.has(deviceId)) return;
    this.pairedNotified.set(deviceId, Date.now());
    try {
      const info = await new Promise((resolve) => {
        db.get(`SELECT d.id as device_id, d.name as device_name, d.phone as device_phone,
                u.id as user_id, u.name as user_name, u.email as user_email
                FROM devices d JOIN users u ON d.user_id = u.id WHERE d.id = ?`,
          [deviceId], (err, row) => resolve(row));
      });
      if (!info) return;
      const phone = this.cleanPhone(rawPhone || info.device_phone || '');
      await telegram.notifyOwnerDevicePaired({
        user_id: info.user_id, user_name: info.user_name, user_email: info.user_email,
        device_id: info.device_id, device_name: info.device_name,
        phone, method, time: new Date().toLocaleString('id-ID')
      });
    } catch (e) { console.error('❌ notifyOwnerPaired:', e.message); }
  }

  async createDevice(deviceId, userId, name, phone = '', siteId = 1) {
    return new Promise((resolve, reject) => {
      db.run(`INSERT INTO devices (id, user_id, site_id, name, phone, status, mode, profit, sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
        [deviceId, userId, siteId, name, phone, 'disconnected', 'FAST (1s)'],
        function (err) {
          if (err) reject(err);
          else resolve({ id: deviceId, name, phone, status: 'disconnected', site_id: siteId });
        });
    });
  }

  async getDevices(userId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC', [userId],
        (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
  }

  async deleteDevice(deviceId, userId) {
    if (this.sockets.has(deviceId)) await this.stopDevice(deviceId);
    if (this.reconnectTimers.has(deviceId)) { clearTimeout(this.reconnectTimers.get(deviceId)); this.reconnectTimers.delete(deviceId); }
    const sp = this.getSessionPath(deviceId);
    if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
    this.sockets.delete(deviceId);
    this.qrCodes.delete(deviceId);
    this.statuses.delete(deviceId);
    this.pairingCodes.delete(deviceId);
    this.pairedNotified.delete(deviceId);
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM devices WHERE id = ? AND user_id = ?', [deviceId, userId], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  }

  async startDevice(deviceId) {
    if (this.reconnectTimers.has(deviceId)) { clearTimeout(this.reconnectTimers.get(deviceId)); this.reconnectTimers.delete(deviceId); }
    if (this.sockets.has(deviceId)) return { status: 'already_running' };
    const sp = this.getSessionPath(deviceId);
    if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });
    try {
      const { state, saveCreds } = await useMultiFileAuthState(sp);
      const { version } = await fetchLatestBaileysVersion();
      const sock = makeWASocket({
        version, auth: state, browser: Browsers.macOS('Desktop'),
        printQRInTerminal: false, logger: require('pino')({ level: 'silent' }),
        defaultQueryTimeoutMs: undefined, connectTimeoutMs: 60000
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
          } catch (e) {}
        }
        if (connection === 'close') {
          const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : undefined;
          const reconn = code !== DisconnectReason.loggedOut;
          this.sockets.delete(deviceId);
          this.qrCodes.delete(deviceId);
          this.statuses.set(deviceId, 'disconnected');
          await this.updateDeviceStatus(deviceId, 'disconnected');
          if (reconn) {
            const timer = setTimeout(() => { this.reconnectTimers.delete(deviceId); this.startDevice(deviceId); }, 5000);
            this.reconnectTimers.set(deviceId, timer);
          } else {
            this.pairedNotified.delete(deviceId);
          }
        }
        if (connection === 'open') {
          this.qrCodes.delete(deviceId);
          this.statuses.set(deviceId, 'connected');
          await this.updateDeviceStatus(deviceId, 'connected');
          console.log('✅ Device ' + deviceId + ' connected!');
          const { user } = sock.authState.creds;
          let cp = '';
          if (user) {
            cp = user.split(':')[0] + '@s.whatsapp.net';
            await this.updateDevicePhone(deviceId, cp);
          }
          await this.notifyOwnerPaired(deviceId, 'QR', cp);
        }
      });
      sock.ev.on('creds.update', saveCreds);
      return { status: 'starting' };
    } catch (e) {
      console.error('❌ startDevice:', e.message);
      this.sockets.delete(deviceId);
      this.statuses.set(deviceId, 'error');
      await this.updateDeviceStatus(deviceId, 'error');
      throw e;
    }
  }

  async stopDevice(deviceId) {
    if (this.reconnectTimers.has(deviceId)) { clearTimeout(this.reconnectTimers.get(deviceId)); this.reconnectTimers.delete(deviceId); }
    const sock = this.sockets.get(deviceId);
    if (sock) {
      try { await sock.logout(); } catch (e) {}
      this.sockets.delete(deviceId);
      this.qrCodes.delete(deviceId);
      this.statuses.set(deviceId, 'disconnected');
      await this.updateDeviceStatus(deviceId, 'disconnected');
      return { status: 'stopped' };
    }
    return { status: 'not_found' };
  }

  async getQR(deviceId) { return this.qrCodes.get(deviceId) || null; }
  getStatus(deviceId) { return this.statuses.get(deviceId) || 'disconnected'; }

  async updateDeviceStatus(deviceId, status) {
    return new Promise((r) => db.run('UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, deviceId], () => r()));
  }
  async updateDevicePhone(deviceId, phone) {
    return new Promise((r) => db.run('UPDATE devices SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [phone, deviceId], () => r()));
  }
  async updateDeviceMode(deviceId, mode) {
    return new Promise((r) => db.run('UPDATE devices SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [mode, deviceId], () => r()));
  }

  // PAIRING
  async requestPairingCode(deviceId, phoneNumber) {
    const device = await this.getDevice(deviceId);
    if (!device) throw new Error('Device tidak ditemukan');
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) throw new Error('Nomor HP tidak valid');
    if (this.sockets.has(deviceId)) await this.stopDevice(deviceId);
    if (this.reconnectTimers.has(deviceId)) { clearTimeout(this.reconnectTimers.get(deviceId)); this.reconnectTimers.delete(deviceId); }
    const sp = this.getSessionPath(deviceId);
    if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
    fs.mkdirSync(sp, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sp);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version, auth: state, browser: ["Ubuntu", "Chrome", "24.0.04"],
      printQRInTerminal: false, logger: require('pino')({ level: 'silent' }),
      defaultQueryTimeoutMs: undefined, connectTimeoutMs: 60000
    });
    this.sockets.set(deviceId, sock);
    this.statuses.set(deviceId, 'pairing');
    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    const timeout = setTimeout(() => {}, 20000);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if ((connection === 'connecting' || qr) && !codeRequested && !sock.authState.creds.registered) {
        codeRequested = true;
        clearTimeout(timeout);
        try {
          await new Promise((r) => setTimeout(r, 1500));
          const code = await sock.requestPairingCode(cleanPhone);
          this.pairingCodes.set(deviceId, code);
          console.log('Pairing code:', code);
        } catch (e) {
          this.statuses.set(deviceId, 'error');
        }
      }
      if (connection === 'close') {
        const sc = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : undefined;
        const reconn = sc !== DisconnectReason.loggedOut;
        this.sockets.delete(deviceId);
        this.statuses.set(deviceId, 'disconnected');
        await this.updateDeviceStatus(deviceId, 'disconnected');
        if (reconn) setTimeout(() => this.startDevice(deviceId), 5000);
      }
      if (connection === 'open') {
        this.statuses.set(deviceId, 'connected');
        await this.updateDeviceStatus(deviceId, 'connected');
        const { user } = sock.authState.creds;
        let cp = cleanPhone;
        if (user) {
          cp = user.split(':')[0];
          await this.updateDevicePhone(deviceId, cp + '@s.whatsapp.net');
        }
        await this.notifyOwnerPaired(deviceId, 'Pairing Code', cleanPhone);
      }
    });

    const code = await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (this.pairingCodes.has(deviceId)) { clearInterval(check); resolve(this.pairingCodes.get(deviceId)); }
        else if (this.statuses.get(deviceId) === 'error' || this.statuses.get(deviceId) === 'disconnected') { clearInterval(check); reject(new Error('Gagal pairing')); }
        else if (Date.now() - start > 25000) { clearInterval(check); reject(new Error('Timeout')); }
      }, 300);
    });
    return { code, status: 'pairing' };
  }

  async getContacts(deviceId, siteId = null) {
    return new Promise((resolve, reject) => {
      let q = 'SELECT * FROM contacts WHERE device_id = ? AND is_group != 2';
      const p = [deviceId];
      if (siteId !== null) { q += ' AND site_id = ?'; p.push(siteId); }
      q += ' ORDER BY name ASC';
      db.all(q, p, (err, rows) => { if (err) reject(err); else resolve(rows); });
    });
  }

  // HELPERS
  async getPricePerChat() {
    return new Promise((r) => db.get('SELECT value FROM settings WHERE key = ?', ['price_per_chat'], (err, row) => r(parseInt(row?.value) || 1100)));
  }
  async getMinWithdraw() {
    return new Promise((r) => db.get('SELECT value FROM settings WHERE key = ?', ['min_withdraw'], (err, row) => r(parseInt(row?.value) || 50000)));
  }

  // LOCK
  async lockNumbers(deviceId, phones, siteId = 1) {
    if (!phones || phones.length === 0) return 0;
    const cp = phones.map(p => this.cleanPhone(p)).filter(p => p);
    if (cp.length === 0) return 0;
    const BS = 200; let total = 0;
    for (let i = 0; i < cp.length; i += BS) {
      const batch = cp.slice(i, i + BS);
      const ph = batch.map(() => '?').join(',');
      const res = await new Promise((r) => {
        db.run(`UPDATE master_contacts SET status = "processing" WHERE phone IN (${ph}) AND site_id = ? AND (status = "available" OR status IS NULL)`,
          [...batch, siteId], function (err) { if (err) r(0); else r(this.changes); });
      });
      total += res;
    }
    return total;
  }

  async getLockedNumbers(deviceId, siteId = 1) {
    return new Promise((r) => db.all('SELECT phone FROM master_contacts WHERE site_id = ? AND status = "processing"', [siteId], (err, rows) => r(rows || [])));
  }
  async unlockNumbers(deviceId, siteId = 1) {
    return new Promise((r) => db.run('UPDATE master_contacts SET status = "available" WHERE site_id = ? AND status = "processing"', [siteId], () => r()));
  }

  // MARK AS SENT
  async markAsSent(phones, siteId = 1) {
    if (!phones || phones.length === 0) return { marked: 0 };
    const cp = phones.map(p => this.cleanPhone(p)).filter(p => p);
    const BS = 500; let total = 0;
    for (let i = 0; i < cp.length; i += BS) {
      const batch = cp.slice(i, i + BS);
      const ph = batch.map(() => '?').join(',');
      const r = await new Promise((res) => {
        db.run(`UPDATE master_contacts SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE phone IN (${ph}) AND site_id = ? AND status IN ("available", "processing")`,
          [...batch, siteId], function (err) { if (err) res(0); else res(this.changes); });
      });
      total += r;
      await new Promise((res) => db.run(`DELETE FROM contacts WHERE phone IN (${ph}) AND site_id = ?`, [...batch, siteId], () => res()));
    }
    console.log('✅ Mark-sent:', total);
    return { marked: total };
  }

  // SEND BROADCAST
  async sendBroadcast(deviceId, message, recipients, userId, delay = 1000, siteId = 1, templatePhoto = null) {
    const sock = this.sockets.get(deviceId);
    if (!sock) throw new Error('Device not connected');
    if (!recipients || recipients.length === 0) throw new Error('Tidak ada recipient');

    const locked = await this.lockNumbers(deviceId, recipients, siteId);
    if (locked === 0) throw new Error('Semua nomor sedang dipakai user lain.');

    const lockedRows = await this.getLockedNumbers(deviceId, siteId);
    const final = lockedRows.map(r => this.cleanPhone(r.phone)).filter(p => p);
    if (final.length === 0) throw new Error('Tidak ada nomor valid');

    const broadcastId = await this.saveBroadcast(deviceId, message, final.length, siteId);

    let sent = 0, failed = 0;
    const sentPhones = [];
    const actualDelay = Math.max(500, delay);

    for (const phone of final) {
      try {
        const jid = phone + '@s.whatsapp.net';
        if (templatePhoto) {
          await sock.sendMessage(jid, { image: { url: templatePhoto }, caption: message });
        } else {
          await sock.sendMessage(jid, { text: message });
        }
        sent++;
        sentPhones.push(phone);
        await this.updateRecipientStatus(broadcastId, phone, 'sent');
        await this.addProfit(deviceId, userId, 1);
        await new Promise((r) => db.run(`UPDATE master_contacts SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE phone = ? AND site_id = ?`, [phone, siteId], () => r()));
        console.log('✅ Sent ' + sent + '/' + final.length + ': ' + phone);
      } catch (e) {
        failed++;
        await this.updateRecipientStatus(broadcastId, phone, 'failed', e.message);
        await new Promise((r) => db.run(`UPDATE master_contacts SET status = 'available' WHERE phone = ? AND site_id = ? AND status = 'processing'`, [phone, siteId], () => r()));
        console.error('❌ Failed ' + phone + ':', e.message);
      }
      await new Promise(r => setTimeout(r, actualDelay));
    }

    await this.updateBroadcastStatus(broadcastId, sent, failed, 'completed');
    await this.updateDeviceStats(deviceId, sent);
    if (failed > 0) await this.unlockNumbers(deviceId, siteId);

    console.log('📊 Selesai: sent=' + sent + ', failed=' + failed);
    return { sent, failed, total: final.length };
  }

  async addProfit(deviceId, userId, count) {
    const price = await this.getPricePerChat();
    const profit = price * count;
    return new Promise((r) => {
      db.run('UPDATE devices SET profit = profit + ? WHERE id = ?', [profit, deviceId]);
      db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [profit, userId]);
      db.run('INSERT INTO transactions (user_id, device_id, amount, type, description) VALUES (?, ?, ?, ?, ?)',
        [userId, deviceId, profit, 'profit', count + ' chat @ Rp' + price], () => r());
    });
  }

  async updateDeviceStats(deviceId, sent) {
    return new Promise((r) => db.run('UPDATE devices SET sent = sent + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sent, deviceId], () => r()));
  }

  async getDevice(deviceId) {
    return new Promise((r, j) => db.get('SELECT * FROM devices WHERE id = ?', [deviceId], (err, row) => { if (err) j(err); else r(row); }));
  }

  async saveBroadcast(deviceId, message, total, siteId = 1) {
    return new Promise((r, j) => db.run('INSERT INTO broadcasts (device_id, site_id, message, recipients, status) VALUES (?, ?, ?, ?, ?)',
      [deviceId, siteId, message, total, 'processing'],
      function (err) { if (err) j(err); else r(this.lastID); }));
  }

  async updateBroadcastStatus(id, sent, failed, status) {
    return new Promise((r) => db.run('UPDATE broadcasts SET sent = ?, failed = ?, status = ? WHERE id = ?', [sent, failed, status, id], () => r()));
  }

  async updateRecipientStatus(bid, phone, status, error = null) {
    return new Promise((r) => db.run('INSERT INTO broadcast_recipients (broadcast_id, phone, status, error, sent_at) VALUES (?, ?, ?, ?, ?)',
      [bid, phone, status, error, status === 'sent' ? new Date().toISOString() : null], () => r()));
  }

  async getBroadcastHistory(userId, deviceId = null) {
    return new Promise((r, j) => {
      let q = 'SELECT b.*, d.name as device_name FROM broadcasts b JOIN devices d ON b.device_id = d.id WHERE d.user_id = ?';
      const p = [userId];
      if (deviceId) { q += ' AND b.device_id = ?'; p.push(deviceId); }
      q += ' ORDER BY b.created_at DESC LIMIT 50';
      db.all(q, p, (err, rows) => { if (err) j(err); else r(rows); });
    });
  }

  async getUserStats(userId) {
    return new Promise((r, j) => {
      db.get(`
        SELECT 
          (SELECT COUNT(*) FROM devices WHERE user_id = ?) as total_devices,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'connected') as online,
          (SELECT COUNT(*) FROM devices WHERE user_id = ? AND status = 'disconnected') as offline,
          (SELECT COALESCE(balance, 0) FROM users WHERE id = ?) as balance,
          (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = ? AND type = 'profit') as revenue,
          (SELECT COALESCE(SUM(b.sent), 0) FROM broadcasts b JOIN devices d ON b.device_id = d.id WHERE d.user_id = ? AND b.status = 'completed') as total_sent
      `, [userId, userId, userId, userId, userId, userId], (err, row) => {
        if (err) j(err);
        else r({
          total_devices: row?.total_devices || 0, online: row?.online || 0, offline: row?.offline || 0,
          balance: row?.balance || 0, revenue: row?.revenue || 0, total_sent: row?.total_sent || 0
        });
      });
    });
  }

  async getUser(userId) {
    return new Promise((r, j) => db.get('SELECT id, email, name, balance, role FROM users WHERE id = ?', [userId], (err, row) => { if (err) j(err); else r(row); }));
  }

  async updateUserBalance(userId, amount) {
    return new Promise((r, j) => db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId], (err) => { if (err) j(err); else r(); }));
  }

  async requestWithdraw(userId, amount, method, accNum, accName) {
    const user = await this.getUser(userId);
    if (!user) throw new Error('User tidak ditemukan');
    if (user.balance < amount) throw new Error('Saldo tidak cukup');
    const min = await this.getMinWithdraw();
    if (amount < min) throw new Error('Minimal withdraw Rp' + min.toLocaleString('id-ID'));
    await this.updateUserBalance(userId, -amount);
    return new Promise((r, j) => {
      db.run('INSERT INTO withdrawals (user_id, amount, method, account_number, account_name, status) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, amount, method, accNum, accName, 'pending'],
        function (err) {
          if (err) { this.updateUserBalance(userId, amount); j(err); }
          else r({ id: this.lastID, status: 'pending' });
        });
    });
  }

  async getWithdrawHistory(userId) {
    return new Promise((r, j) => db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => { if (err) j(err); else r(rows); }));
  }

  async getPendingWithdrawals() {
    return new Promise((r, j) => db.all(`SELECT w.*, u.email, u.name, u.telegram_username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending' ORDER BY w.created_at ASC`, [], (err, rows) => { if (err) j(err); else r(rows); }));
  }

  async approveWithdraw(id, note = '') {
    return new Promise((r, j) => db.run(`UPDATE withdrawals SET status = 'approved', processed_at = CURRENT_TIMESTAMP, note = ? WHERE id = ?`, [note, id], (err) => { if (err) j(err); else r({ success: true }); }));
  }

  async rejectWithdraw(id, reason = '') {
    db.get('SELECT user_id, amount FROM withdrawals WHERE id = ?', [id], (err, row) => {
      if (err || !row) return;
      this.updateUserBalance(row.user_id, row.amount).catch(() => {});
    });
    return new Promise((r, j) => db.run(`UPDATE withdrawals SET status = 'rejected', note = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`, [reason, id], (err) => { if (err) j(err); else r({ success: true }); }));
  }

  async cleanup() {
    for (const [id, sock] of this.sockets) { try { await sock.logout(); } catch (e) {} }
    this.sockets.clear();
    this.qrCodes.clear();
    this.statuses.clear();
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    this.pairedNotified.clear();
  }
}

module.exports = new WhatsAppManager();
