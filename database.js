const dbPath = path.join('/app/data', 'database.db');
const db = new sqlite3.Database(dbPath);
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// ============================================
// ✅ FIX: Bikin folder SEBELUM buka database
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : __dirname;

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('✅ DATA_DIR dibuat:', DATA_DIR);
  } else {
    console.log('✅ DATA_DIR sudah ada:', DATA_DIR);
  }
} catch (e) {
  console.error('❌ Gagal bikin DATA_DIR:', e.message);
}

const dbPath = path.join(DATA_DIR, 'database.db');
console.log('📁 Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Gagal buka database:', err.message);
  } else {
    console.log('✅ Database terbuka:', dbPath);
  }
});

db.serialize(() => {
  // ===== TABEL USERS =====
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      phone TEXT,
      telegram_username TEXT,
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      total_referral INTEGER DEFAULT 0,
      balance INTEGER DEFAULT 0,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (referred_by) REFERENCES users(id)
    )
  `);

  // Auto migration: tambah kolom telegram_username
  db.all("PRAGMA table_info(users)", (err, cols) => {
    if (err) return console.error('Migration error:', err.message);
    const hasTg = cols.some(c => c.name === 'telegram_username');
    if (!hasTg) {
      db.run("ALTER TABLE users ADD COLUMN telegram_username TEXT", (e) => {
        if (e) console.error('❌ Gagal tambah kolom telegram_username:', e.message);
        else console.log('✅ Kolom telegram_username ditambahkan');
      });
    }
  });

  // ===== TABEL LAINNYA =====
  db.run(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER,
      referred_id INTEGER,
      bonus_amount INTEGER DEFAULT 50,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT DEFAULT 'disconnected',
      mode TEXT DEFAULT 'FAST (1s)',
      sent INTEGER DEFAULT 0,
      profit INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      name TEXT,
      phone TEXT,
      is_group BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      message TEXT,
      recipients INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS broadcast_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcast_id INTEGER,
      phone TEXT,
      status TEXT DEFAULT 'pending',
      error TEXT,
      sent_at DATETIME,
      FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id TEXT,
      amount INTEGER,
      type TEXT,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      gopay_phone TEXT,
      ovo_phone TEXT,
      dana_phone TEXT,
      bank_name TEXT,
      bank_account TEXT,
      bank_holder TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      amount INTEGER,
      method TEXT,
      account_number TEXT,
      account_name TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS master_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed admin
  db.get('SELECT id FROM users WHERE email = ?', ['admin@marketingcuan.com'], (err, row) => {
    if (!row) {
      const hash = bcrypt.hashSync('admin123', 10);
      const referralCode = 'ADMIN' + Math.random().toString(36).substring(2, 8).toUpperCase();
      db.run(
        'INSERT INTO users (id, email, password, name, phone, referral_code, balance, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [1, 'admin@marketingcuan.com', hash, 'Administrator', null, referralCode, 0, 'admin']
      );
    }
  });

  // Seed settings
  db.get('SELECT value FROM settings WHERE key = ?', ['promo_text'], (err, row) => {
    if (!row) {
      db.run("INSERT INTO settings (key, value) VALUES ('promo_text', 'Halo! Ini pesan dari MarketingCuan.')");
      db.run("INSERT INTO settings (key, value) VALUES ('price_per_chat', '1100')");
      db.run("INSERT INTO settings (key, value) VALUES ('min_withdraw', '10000')");
    }
  });
});

module.exports = db;
