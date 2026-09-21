const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '';

function apiRequest(method, payload) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return reject(new Error('TELEGRAM_BOT_TOKEN kosong'));
    const data = JSON.stringify(payload);
    const options = {
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || 'Telegram error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return apiRequest('sendMessage', payload);
}

function editMessageText(chatId, messageId, text, replyMarkup = null) {
  return apiRequest('editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup || { inline_keyboard: [] }
  });
}

function answerCallbackQuery(callbackId, text, showAlert = false) {
  return apiRequest('answerCallbackQuery', {
    callback_query_id: callbackId, text: text || 'OK', show_alert: !!showAlert
  });
}

function rp(n) { return 'Rp' + (Number(n) || 0).toLocaleString('id-ID'); }

// ============================================
// NOTIF WD BARU → admin
// ============================================
async function notifyAdminWithdraw(w) {
  if (!ADMIN_CHAT_ID) return;
  const text = '<b>🔔 PERMINTAAN WITHDRAW BARU</b>\n\n' +
    '👤 <b>User:</b> ' + (w.user_name || 'Unknown') + '\n' +
    '📧 <b>Email:</b> ' + (w.user_email || '-') + '\n' +
    '📱 <b>Telegram:</b> ' + (w.telegram_username ? '@' + String(w.telegram_username).replace('@','') : '-') + '\n' +
    '🆔 <b>Telegram ID:</b> <code>' + (w.telegram_id || '-') + '</code>\n\n' +
    '💰 <b>Nominal:</b> ' + rp(w.amount) + '\n' +
    '💳 <b>Metode:</b> ' + String(w.method || '').toUpperCase() + '\n' +
    '🏦 <b>Nomor Akun:</b> <code>' + (w.account_number || '-') + '</code>\n' +
    '📝 <b>Nama Pemilik:</b> ' + (w.account_name || '-') + '\n\n' +
    '🆔 <b>WD ID:</b> <code>' + w.id + '</code>\n' +
    '🕐 <b>Waktu:</b> ' + new Date().toLocaleString('id-ID') + '\n\n' +
    '<i>Klik tombol di bawah untuk ACC atau Tolak.</i>';

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ ACC', callback_data: 'wd_acc_' + w.id },
      { text: '❌ Tolak', callback_data: 'wd_rej_' + w.id }
    ]]
  };

  try {
    await sendTelegramMessage(ADMIN_CHAT_ID, text, keyboard);
    console.log('✅ Notif WD ke admin');
  } catch (e) { console.error('❌ Notif WD:', e.message); }
}

// ============================================
// NOTIF WD SUKSES → channel
// ============================================
async function notifyChannelWithdrawSuccess(w) {
  if (!CHANNEL_ID) return;
  const tgName = w.telegram_username ? '@' + String(w.telegram_username).replace('@','') : (w.user_name || 'User');
  const text = '<b>✅ WITHDRAW BERHASIL</b>\n\n' +
    '👤 <b>User:</b> ' + tgName + '\n' +
    '💰 <b>Nominal:</b> ' + rp(w.amount) + '\n' +
    '📅 <b>Tanggal:</b> ' + new Date().toLocaleString('id-ID') + '\n' +
    '🎉 <b>Status:</b> <b>BERHASIL</b>\n\n' +
    '<i>Pembayaran telah diproses. Terima kasih!</i>';
  try { await sendTelegramMessage(CHANNEL_ID, text); console.log('✅ Notif channel'); }
  catch (e) { console.error('❌ Channel:', e.message); }
}

// ============================================
// NOTIF PAIRING DEVICE
// ============================================
async function notifyOwnerDevicePaired(info) {
  if (!ADMIN_CHAT_ID) return;
  const methodLabel = info.method === 'QR' ? '📷 QR Code' : '🔗 Pairing Code';
  let phoneDisplay = info.phone || '-';
  if (info.phone && /^\d+/.test(info.phone)) {
    const c = info.phone.replace(/\D/g, '');
    phoneDisplay = c.startsWith('62') ? '+62 ' + c.slice(2,5) + '-' + c.slice(5,9) + '-' + c.slice(9) : '+' + c;
  }
  const text = '<b>🔔 USER PAIRING DEVICE</b>\n\n' +
    '👤 <b>User:</b> ' + (info.user_name || 'Unknown') + '\n' +
    '📧 <b>Email:</b> ' + (info.user_email || '-') + '\n' +
    '🆔 <b>User ID:</b> <code>' + (info.user_id || '-') + '</code>\n\n' +
    '📱 <b>Device:</b> ' + (info.device_name || info.device_id || '-') + '\n' +
    '🔧 <b>Method:</b> ' + methodLabel + '\n' +
    '📞 <b>Nomor WA:</b> <code>' + phoneDisplay + '</code>\n\n' +
    '🕐 <b>Waktu:</b> ' + (info.time || new Date().toLocaleString('id-ID')) + '\n' +
    '✅ <b>Status:</b> <b>CONNECTED</b>';
  try { await sendTelegramMessage(ADMIN_CHAT_ID, text); console.log('✅ Notif pairing'); }
  catch (e) { console.error('❌ Pairing notif:', e.message); }
}

// ============================================
// 🔥 NOTIF BLAST START & FINISH → admin
// ============================================
async function notifyAdminBlastStart(info) {
  if (!ADMIN_CHAT_ID) return;
  const tgUser = info.telegram_username ? '@' + String(info.telegram_username).replace('@','') : (info.user_name || 'User');
  const text = '<b>🚀 BLAST DIMULAI</b>\n\n' +
    '👤 <b>User:</b> ' + (info.user_name || 'Unknown') + '\n' +
    '📱 <b>Telegram:</b> ' + tgUser + '\n' +
    '🆔 <b>User ID:</b> <code>' + (info.user_id || '-') + '</code>\n\n' +
    '📲 <b>Device:</b> ' + (info.device_name || info.device_id || '-') + '\n' +
    '🌐 <b>Database:</b> ' + (info.site_name || '-') + '\n' +
    '📋 <b>Total Kontak:</b> <b>' + (info.total_contacts || 0).toLocaleString('id-ID') + '</b>\n' +
    '⚡ <b>Kecepatan:</b> ' + (info.speed_ms || 0) + 'ms/pesan\n' +
    '⏱️ <b>Estimasi:</b> ~' + (info.estimation || '-') + '\n\n' +
    '🕐 <b>Waktu Mulai:</b> ' + new Date().toLocaleString('id-ID');
  try { await sendTelegramMessage(ADMIN_CHAT_ID, text); console.log('✅ Notif blast start'); }
  catch (e) { console.error('❌ Blast start:', e.message); }
}

async function notifyAdminBlastFinish(info) {
  if (!ADMIN_CHAT_ID) return;
  const tgUser = info.telegram_username ? '@' + String(info.telegram_username).replace('@','') : (info.user_name || 'User');
  const total = (info.sent || 0) + (info.failed || 0);
  const successRate = total > 0 ? ((info.sent / total) * 100).toFixed(1) : 0;
  const duration = info.duration || '-';

  const text = '<b>✅ BLAST SELESAI</b>\n\n' +
    '👤 <b>User:</b> ' + (info.user_name || 'Unknown') + '\n' +
    '📱 <b>Telegram:</b> ' + tgUser + '\n\n' +
    '📲 <b>Device:</b> ' + (info.device_name || info.device_id || '-') + '\n' +
    '🌐 <b>Database:</b> ' + (info.site_name || '-') + '\n' +
    '⚡ <b>Kecepatan:</b> ' + (info.speed_ms || 0) + 'ms/pesan\n' +
    '⏱️ <b>Durasi:</b> ' + duration + '\n\n' +
    '📊 <b>HASIL BLAST:</b>\n' +
    '├ 📋 Total: <b>' + total.toLocaleString('id-ID') + '</b>\n' +
    '├ ✅ Sukses: <b>' + (info.sent || 0).toLocaleString('id-ID') + '</b>\n' +
    '├ ❌ Gagal: <b>' + (info.failed || 0).toLocaleString('id-ID') + '</b>\n' +
    '└ 📈 Success Rate: <b>' + successRate + '%</b>\n\n' +
    '💰 <b>Profit:</b> ' + rp((info.sent || 0) * (info.price_per_chat || 1100)) + '\n' +
    '🗑️ <b>Purged:</b> ' + (info.purged || 0) + ' nomor dari pool\n\n' +
    '🕐 <b>Selesai:</b> ' + new Date().toLocaleString('id-ID');
  try { await sendTelegramMessage(ADMIN_CHAT_ID, text); console.log('✅ Notif blast finish'); }
  catch (e) { console.error('❌ Blast finish:', e.message); }
}

// ============================================
// WEBHOOK SETUP
// ============================================
async function setWebhook(baseUrl) {
  if (!BOT_TOKEN || !baseUrl) return;
  const url = String(baseUrl).replace(/\/$/, '') + '/api/telegram/webhook';
  try {
    const result = await apiRequest('setWebhook', {
      url, allowed_updates: ['callback_query', 'message'], drop_pending_updates: true
    });
    console.log('✅ Webhook set:', url);
    return result;
  } catch (e) { console.error('❌ Webhook:', e.message); throw e; }
}

function getWebhookInfo() { return apiRequest('getWebhookInfo', {}); }
function deleteWebhook() { return apiRequest('deleteWebhook', { drop_pending_updates: true }); }

async function testBot() {
  try { const me = await apiRequest('getMe', {}); return { ok: true, bot: me }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  sendTelegramMessage, editMessageText, answerCallbackQuery,
  notifyAdminWithdraw, notifyChannelWithdrawSuccess,
  notifyOwnerDevicePaired, notifyAdminBlastStart, notifyAdminBlastFinish,
  setWebhook, getWebhookInfo, deleteWebhook, testBot, rp
};
