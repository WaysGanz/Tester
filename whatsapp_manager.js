const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('./database');

class WhatsAppManager {
  constructor() {
    this.sockets = new Map();
    this.qrCodes = new Map();
    this.statuses = new Map();
    this.reconnectTimers = new Map();
    this.pairingCodes = new Map();
  }

  getSessionPath(deviceId) {
    return path.join(__dirname, 'sessions', deviceId);
  }

  async createDevice(deviceId, userId, name, phone = '') {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO devices (id, user_id, name, phone, status, mode, profit, sent) 
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`, 
        [deviceId, userId, name, phone, 'disconnected', 'FAST (1s)'],
        function(err) {
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
    
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM devices WHERE id = ? AND user_id = ?', [deviceId, userId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

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
          }
        }

        if (connection === 'open') {
          this.qrCodes.delete(deviceId);
          this.statuses.set(deviceId, 'connected');
          await this.updateDeviceStatus(deviceId, 'connected');
          console.log(`Device ${deviceId} connected!`);
          
          const { user } = sock.authState.creds;
          if (user) {
            const phone = user.split(':')[0] + '@s.whatsapp.net';
            await this.updateDevicePhone(deviceId, phone);
          }
          
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
      try {
        await sock.logout();
      } catch (error) {
        console.error(`Error logging out ${deviceId}:`, error);
      }
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
        console.log(`✅ Device ${deviceId} status updated to: ${status}`);
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

  // ===== PAIRING CODE =====
  async requestPairingCode(deviceId, phoneNumber) {
    const device = await this.getDevice(deviceId);
    if (!device) throw new Error('Device tidak ditemukan');

    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Nomor HP tidak valid. Minimal 10 digit.');
    }

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
        if (!codeRequested) {
          console.log(`Pairing timeout for ${deviceId}, socket never reached 'connecting'`);
        }
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
            console.log(`Reconnecting ${deviceId} after pairing...`);
            setTimeout(() => this.startDevice(deviceId), 5000);
          }
        }

        if (connection === 'open') {
          this.statuses.set(deviceId, 'connected');
          await this.updateDeviceStatus(deviceId, 'connected');
          console.log(`Device ${deviceId} connected via pairing!`);
          
          const { user } = sock.authState.creds;
          if (user) {
            const phone = user.split(':')[0] + '@s.whatsapp.net';
            await this.updateDevicePhone(deviceId, phone);
          }
          
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
            reject(new Error('Gagal mendapatkan pairing code, koneksi terputus.'));
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
      
      if (sock.contacts) {
        contacts = Array.from(sock.contacts.values());
        console.log(`Loaded ${contacts.length} contacts from sock.contacts for ${deviceId}`);
      }
      
      if (contacts.length === 0 && sock.chats) {
        const chatKeys = Array.from(sock.chats.keys());
        for (const key of chatKeys) {
          if (key.includes('@s.whatsapp.net') && !key.includes('@g.us')) {
            const chat = sock.chats.get(key);
            if (chat && chat.name) {
              contacts.push({ id: key, name: chat.name, isGroup: false });
            }
          }
        }
        console.log(`Loaded ${contacts.length} contacts from sock.chats for ${deviceId}`);
      }
      
      if (contacts.length > 0) {
        await this.saveContacts(deviceId, contacts);
      } else {
        console.log(`No contacts found for ${deviceId}, but that's okay.`);
      }
    } catch (error) {
      console.error(`Error loading contacts for ${deviceId}:`, error);
    }
  }

  async saveContacts(deviceId, contacts) {
    if (!contacts || contacts.length === 0) {
      console.log(`No contacts to save for ${deviceId}`);
      return;
    }
    
    return new Promise((resolve) => {
      db.run('DELETE FROM contacts WHERE device_id = ?', [deviceId], (err) => {
        if (err) {
          console.error(`Error deleting contacts for ${deviceId}:`, err);
          resolve();
          return;
        }
        
        const stmt = db.prepare('INSERT INTO contacts (device_id, name, phone, is_group) VALUES (?, ?, ?, ?)');
        let inserted = 0;
        
        for (const c of contacts) {
          if (c.id && (c.verifiedName || c.name || c.pushname)) {
            const name = c.verifiedName || c.name || c.pushname || 'Unknown';
            const isGroup = c.isGroup || false;
            stmt.run(deviceId, name, c.id, isGroup ? 1 : 0);
            inserted++;
          }
        }
        
        stmt.finalize();
        console.log(`Saved ${inserted} contacts for ${deviceId}`);
        resolve();
      });
    });
  }

  async updateContact(deviceId, jid, name) {
    return new Promise((resolve) => {
      db.run(
        'UPDATE contacts SET name = ? WHERE device_id = ? AND phone = ?',
        [name, deviceId, jid],
        (err) => {
          if (err) console.error(`Error updating contact ${jid}:`, err);
          resolve();
        }
      );
    });
  }

  async getContacts(deviceId) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM contacts WHERE device_id = ? ORDER BY name ASC', [deviceId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // ===== BROADCAST =====
  async getPricePerChat() {
    return new Promise((resolve, reject) => {
      db.get('SELECT value FROM settings WHERE key = ?', ['price_per_chat'], (err, row) => {
        if (err) reject(err);
        else resolve(parseInt(row?.value) || 600);
      });
    });
  }

  async getMinWithdraw() {
    return new Promise((resolve, reject) => {
      db.get('SELECT value FROM settings WHERE key = ?', ['min_withdraw'], (err, row) => {
        if (err) reject(err);
        else resolve(parseInt(row?.value) || 10000);
      });
    });
  }

  // ===== 🔥 SEND BROADCAST + HAPUS KONTAK OTOMATIS =====
  // ===== 🔥 PROFIT HANYA UNTUK PESAN BERHASIL, TIDAK 2X LIPAT =====
  async sendBroadcast(deviceId, message, recipients, userId, delay = 1000) {
    const sock = this.sockets.get(deviceId);
    if (!sock) throw new Error('Device not connected');

    if (!recipients || recipients.length === 0) {
      throw new Error('Tidak ada recipient');
    }

    const broadcastId = await this.saveBroadcast(deviceId, message, recipients.length);

    let sent = 0, failed = 0;
    const actualDelay = Math.max(500, delay);

    console.log(`📤 Starting broadcast for device ${deviceId} to ${recipients.length} recipients`);

    for (const phone of recipients) {
      try {
        let jid = phone;
        if (!jid.includes('@')) {
          jid = phone + '@s.whatsapp.net';
        } else if (!jid.includes('@s.whatsapp.net') && !jid.includes('@g.us')) {
          const parts = jid.split('@');
          jid = parts[0] + '@s.whatsapp.net';
        }
        
        await sock.sendMessage(jid, { text: message });
        sent++;
        await this.updateRecipientStatus(broadcastId, phone, 'sent');
        // 🔥 PROFIT HANYA DITAMBAHKAN SAAT PESAN BERHASIL
        await this.addProfit(deviceId, userId, 1);
        console.log(`✅ Sent to ${phone} (${sent}/${recipients.length})`);
      } catch (error) {
        failed++;
        await this.updateRecipientStatus(broadcastId, phone, 'failed', error.message);
        console.error(`❌ Failed to send to ${phone}:`, error.message);
      }
      await new Promise(resolve => setTimeout(resolve, actualDelay));
    }

    await this.updateBroadcastStatus(broadcastId, sent, failed, 'completed');
    await this.updateDeviceStats(deviceId, sent);
    console.log(`📊 Broadcast finished for ${deviceId}: sent=${sent}, failed=${failed}, total=${recipients.length}`);
    for (const phone of recipients) {
      db.run('DELETE FROM contacts WHERE device_id = ? AND phone = ?', [deviceId, phone]);
    }
    console.log(`🧹 Deleted ${recipients.length} contacts from device ${deviceId} after broadcast`);

    return { sent, failed, total: recipients.length };
  }
  async addProfit(deviceId, userId, count) {
    const price = await this.getPricePerChat();
    const totalProfit = price * count;
    
    console.log(`💰 Adding profit: ${totalProfit} (${count} chat @ Rp${price}) to device ${deviceId}`);

    return new Promise((resolve) => {
      db.run('UPDATE devices SET profit = profit + ? WHERE id = ?', [totalProfit, deviceId], (err) => {
        if (err) console.error('Error updating device profit:', err);
      });
      
      db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [totalProfit, userId], (err) => {
        if (err) console.error('Error updating user balance:', err);
      });
      
      db.run(
        'INSERT INTO transactions (user_id, device_id, amount, type, description) VALUES (?, ?, ?, ?, ?)',
        [userId, deviceId, totalProfit, 'profit', `${count} chat terkirim @ Rp${price}/chat`],
        (err) => {
          if (err) console.error('Error inserting transaction:', err);
          resolve();
        }
      );
    });
  }

  async updateDeviceStats(deviceId, sent) {
    return new Promise((resolve) => {
      db.run('UPDATE devices SET sent = sent + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sent, deviceId], (err) => {
        if (err) console.error('Error updating device stats:', err);
        resolve();
      });
    });
  }

  async getDevice(deviceId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM devices WHERE id = ?', [deviceId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async saveBroadcast(deviceId, message, total) {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO broadcasts (device_id, message, recipients, status) VALUES (?, ?, ?, ?)',
        [deviceId, message, total, 'processing'],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async updateBroadcastStatus(id, sent, failed, status) {
    return new Promise((resolve) => {
      db.run('UPDATE broadcasts SET sent = ?, failed = ?, status = ? WHERE id = ?', [sent, failed, status, id], (err) => {
        if (err) console.error('Error updating broadcast status:', err);
        resolve();
      });
    });
  }

  async updateRecipientStatus(broadcastId, phone, status, error = null) {
    return new Promise((resolve) => {
      db.run(
        'INSERT INTO broadcast_recipients (broadcast_id, phone, status, error, sent_at) VALUES (?, ?, ?, ?, ?)',
        [broadcastId, phone, status, error, status === 'sent' ? new Date().toISOString() : null],
        (err) => {
          if (err) console.error('Error updating recipient status:', err);
          resolve();
        }
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
      if (deviceId) {
        query += ' AND b.device_id = ?';
        params.push(deviceId);
      }
      query += ' ORDER BY b.created_at DESC LIMIT 50';
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
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
          if (err) {
            console.error('❌ SQL Error getUserStats:', err);
            reject(err);
          } else {
            const result = {
              total_devices: row?.total_devices || 0,
              online: row?.online || 0,
              offline: row?.offline || 0,
              balance: row?.balance || 0,
              revenue: row?.revenue || 0,
              total_sent: row?.total_sent || 0
            };
            console.log('📊 getUserStats result:', result);
            resolve(result);
          }
        }
      );
    });
  }
  async getUser(userId) {
    return new Promise((resolve, reject) => {
      db.get('SELECT id, email, name, balance, role FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async updateUserBalance(userId, amount) {
    return new Promise((resolve, reject) => {
      db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId], (err) => {
        if (err) reject(err);
        else resolve();
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
        function(err) {
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
      db.all(
        'SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC',
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async getPendingWithdrawals() {
    return new Promise((resolve, reject) => {
      db.all(
        `SELECT w.*, u.email, u.name FROM withdrawals w 
         JOIN users u ON w.user_id = u.id 
         WHERE w.status = 'pending' 
         ORDER BY w.created_at ASC`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async approveWithdraw(withdrawId, adminNote = '') {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE withdrawals SET status = 'approved', processed_at = CURRENT_TIMESTAMP, note = ? WHERE id = ?`,
        [adminNote, withdrawId],
        function(err) {
          if (err) {
            console.error('❌ Error approve withdraw:', err);
            reject(err);
          } else {
            resolve({ success: true });
          }
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
        function(err) {
          if (err) {
            console.error('❌ Error reject withdraw:', err);
            reject(err);
          } else {
            resolve({ success: true });
          }
        }
      );
    });
  }
  async cleanup() {
    for (const [deviceId, sock] of this.sockets) {
      try {
        await sock.logout();
      } catch (error) {
        console.error(`Error cleaning up ${deviceId}:`, error);
      }
    }
    this.sockets.clear();
    this.qrCodes.clear();
    this.statuses.clear();
    
    for (const [deviceId, timer] of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }
}

module.exports = new WhatsAppManager();