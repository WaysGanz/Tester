const bcrypt = require('bcryptjs');
const db = require('./database');

const email = 'ways@admin.com';
const username = 'admin';
const phone = '081234567890';
const password = 'ways123';

const hash = bcrypt.hashSync(password, 10);

db.run(
  `INSERT INTO users (email, password, name, phone, role, balance, referral_code, created_at) 
   VALUES (?, ?, ?, ?, 'admin', 0, 'ADMIN01', CURRENT_TIMESTAMP)`,
  [email, hash, username, phone],
  function (err) {
    if (err) console.error('❌ Gagal:', err.message);
    else {
      console.log('✅ Admin dibuat!');
      console.log('   Email:', email);
      console.log('   Password:', password);
    }
    process.exit(0);
  }
);
