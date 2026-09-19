// ============================================
// TELEGRAM HELPER — Bot, Inline Button, Webhook
// ============================================
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '';

// ============================================
// Generic API call
// ============================================
function apiRequest(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN belum di-set'));

    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || 'Telegram API error'));
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============================================
// Send message (opsional inline keyboard)
// ============================================
function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return apiRequest('sendMessage', payload);
}

// ============================================
// Edit message (buat update status setelah klik button)
// ============================================
function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup || { inline_keyboard: [] }
  };
  return apiRequest('editMessageText', payload);
}

// ============================================
// Jawab callback query (feedback saat button diklik)
// ============================================
function answerCallbackQuery(callbackId, text, showAlert = false) {
  return apiRequest('answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text || 'OK',
    show_alert: !!showAlert
  });
}

// ============================================
// Format rupiah
// ============================================
function rp(n) {
  return 'Rp' + (Number(n) || 0).toLocaleString('id-ID');
}

// ============================================
// NOTIF WD BARU → admin (dengan inline button)
// ============================================
async function notifyAdminWithdraw(w) {
  if (!ADMIN_CHAT_ID) {
    console.warn('⚠️ TELEGRAM_ADMIN_CHAT_ID kosong, skip notif WD');
    return;
  }

  const text = `
<b>🔔 PERMINTAAN WITHDRAW BARU</b>

👤 <b>User:</b> ${w.user_name || 'Unknown'}
📧 <b>Email:</b> ${w.user_email || '-'}
📱 <b>Telegram:</b> ${w.telegram_username ? '@' + String(w.telegram_username).replace('@','') : '-'}

💰 <b>Nominal:</b> ${rp(w.amount)}
💳 <b>Metode:</b> ${String(w.method || '').toUpperCase()}
🏦 <b>Nomor Akun:</b> <code>${w.account_number || '-'}</code>
📝 <b>Nama Pemilik:</b> ${w.account_name || '-'}

🆔 <b>WD ID:</b> <code>${w.id}</code>
🕐 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}

<i>Klik tombol di bawah untuk ACC atau Tolak.</i>
`.trim();

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ACC', callback_data: `wd_acc_${w.id}` },
      { text: '❌ Tolak', callback_data: `wd_rej_${w.id}` }
    ]]
  };

  try {
    const result = await sendTelegramMessage(ADMIN_CHAT_ID, text, keyboard);
    console.log('✅ Notif WD + button terkirim ke admin');
    return result;
  } catch (e) {
    console.error('❌ Gagal kirim notif WD:', e.message);
  }
}

// ============================================
// NOTIF WD SUKSES → channel (tanpa bank/ewallet)
// ============================================
async function notifyChannelWithdrawSuccess(w) {
  if (!CHANNEL_ID) {
    console.warn('⚠️ TELEGRAM_CHANNEL_ID kosong, skip notif channel');
    return;
  }

  const tgName = w.telegram_username
    ? '@' + String(w.telegram_username).replace('@','')
    : (w.user_name || 'User');

  const text = `
<b>✅ WITHDRAW BERHASIL</b>

👤 <b>User:</b> ${tgName}
💰 <b>Nominal:</b> ${rp(w.amount)}
📅 <b>Tanggal:</b> ${new Date().toLocaleString('id-ID')}
🎉 <b>Status:</b> <b>BERHASIL</b>

<i>Pembayaran telah diproses. Terima kasih!</i>
`.trim();

  try {
    await sendTelegramMessage(CHANNEL_ID, text);
    console.log('✅ Notif WD sukses terkirim ke channel');
  } catch (e) {
    console.error('❌ Gagal kirim ke channel:', e.message);
  }
}

// ============================================
// Set webhook (auto dipanggil saat server start)
// ============================================
async function setWebhook(baseUrl) {
  if (!BOT_TOKEN || !baseUrl) {
    console.warn('⚠️ BOT_TOKEN / baseUrl kosong, skip setWebhook');
    return;
  }
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/telegram/webhook`;
  try {
    const result = await apiRequest('setWebhook', {
      url,
      allowed_updates: ['callback_query', 'message'],
      drop_pending_updates: true
    });
    console.log('✅ Telegram webhook set:', url);
    return result;
  } catch (e) {
    console.error('❌ Gagal set webhook:', e.message);
    throw e;
  }
}

// ============================================
// Info webhook (buat debug)
// ============================================
function getWebhookInfo() {
  return apiRequest('getWebhookInfo', {});
}

// ============================================
// Test bot koneksi
// ============================================
async function testBot() {
  try {
    const me = await apiRequest('getMe', {});
    return { ok: true, bot: me };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================
// Hapus webhook (buat debug)
// ============================================
function deleteWebhook() {
  return apiRequest('deleteWebhook', { drop_pending_updates: true });
}

module.exports = {
  sendTelegramMessage,
  editMessageText,
  answerCallbackQuery,
  notifyAdminWithdraw,
  notifyChannelWithdrawSuccess,
  setWebhook,
  getWebhookInfo,
  deleteWebhook,
  testBot,
  rp
};
