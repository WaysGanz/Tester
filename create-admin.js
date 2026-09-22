require('dotenv').config();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// ============================================
// CONFIG — dari .env
// ============================================
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/home/data' : __dirname;
const DB_PATH = path.join(DATA_DIR, 'database.db');

const email = process.env.ADMIN_EMAIL;
const username = process.env.ADMIN_NAME || 'admin';
const phone = process.env.ADMIN_PHONE || '081234567890';
const password = process.env.ADMIN_PASSWORD;

// ============================================
// VALIDASI
// ============================================
if (!email || !password) {
  console.error('❌ ADMIN_EMAIL & ADMIN_PASSWORD wajib di-set di .env');
  console.error('');
  console.error('Contoh isi .env:');
  console.error('  ADMIN_EMAIL=ways@admin.com');
  console.error('  ADMIN_PASSWORD=passwordKuat123!');
  console.error('  ADMIN_NAME=ways');
  console.error('  ADMIN_PHONE=081234567890');
  process.exit(1);
}

if (password.length < 8) {
  console.error('❌ ADMIN_PASSWORD minimal 8 karakter');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ Database gak ditemukan di:', DB_PATH);
  process.exit(1);
}

console.log('📁 DB path:', DB_PATH);
console.log('👤 Email :', email);

// ============================================
// PROSES
// ============================================
const db = new sqlite3.Database(DB_PATH);

(async () => {
  try {
    const hash = await bcrypt.hash(password, 10);
    console.log('🔐 Hash generated');

    db.get('SELECT id, email FROM users WHERE email = ?', [email], (err, row) => {
      if (err) {
        console.error('❌ DB error:', err.message);
        process.exit(1);
      }

      if (row) {
        // User udah ada → UPDATE password & role
        db.run(
          'UPDATE users SET password = ?, name = ?, role = ? WHERE email = ?',
          [hash, username, 'admin', email],
          function (e) {
            if (e) {
              console.error('❌ Update gagal:', e.message);
              process.exit(1);
            }
            console.log('');
            console.log('✅ User di-UPDATE (ID: ' + row.id + ')');
            console.log('   Email    :', email);
            console.log('   Username :', username);
            console.log('   Role     : admin');
            console.log('   Password : (dari .env — ' + password.length + ' karakter)');
            db.close();
          }
        );
      } else {
        // User baru → INSERT
        const referralCode = 'ADMIN' + Math.random().toString(36).substring(2, 8).toUpperCase();
        db.run(
          `INSERT INTO users (email, password, name, phone, role, referral_code, balance, total_referral, created_at)
           VALUES (?, ?, ?, ?, 'admin', ?, 0, 0, CURRENT_TIMESTAMP)`,
          [email, hash, username, phone, referralCode],
          function (e) {
            if (e) {
              console.error('❌ Insert gagal:', e.message);
              process.exit(1);
            }
            console.log('');
            console.log('✅ Admin BARU dibuat (ID: ' + this.lastID + ')');
            console.log('   Email    :', email);
            console.log('   Username :', username);
            console.log('   Role     : admin');
            console.log('   Password : (dari .env — ' + password.length + ' karakter)');
            db.close();
          }
        );
      }
    });
  } catch (e) {
    console.error('❌ Fatal:', e.message);
    process.exit(1);
  }
})();
