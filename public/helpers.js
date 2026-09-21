function showToast(message = '', type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><div>${message}</div>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function safeParse(str, fallback = null) { try { return JSON.parse(str); } catch (e) { console.error('Parse error:', e); return fallback; } }
async function safeFetch(url, options = {}) { try { const response = await fetch(url, options); if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`); return { success: true, data: await response.json() }; } catch (error) { console.error('Fetch error:', error); return { success: false, error: error.message }; } }
function formatIDR(amount) { return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount); }
function debounce(func, wait) { let timeout; return function (...args) { clearTimeout(timeout); timeout = setTimeout(() => func(...args), wait); }; }
function throttle(func, limit) { let inThrottle; return function (...args) { if (!inThrottle) { func.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; }
async function copyToClipboard(text) { try { await navigator.clipboard.writeText(text); showToast('Berhasil disalin', 'success'); return true; } catch (error) { showToast('Gagal menyalin', 'error'); return false; } }
function validatePhone(phone) { const cleaned = phone.replace(/[^0-9]/g, ''); return cleaned.length >= 10 && cleaned.length <= 15; }
function formatPhone(phone) { const cleaned = phone.replace(/[^0-9]/g, ''); if (!cleaned) return ''; if (cleaned.length <= 4) return cleaned; if (cleaned.length <= 8) return cleaned.slice(0, 4) + '-' + cleaned.slice(4); return cleaned.slice(0, 4) + '-' + cleaned.slice(4, 8) + '-' + cleaned.slice(8); }
function getURLParam(paramName) { return new URLSearchParams(window.location.search).get(paramName); }
function isMobile() { return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent); }
function isDarkMode() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }

function injectTelegramChat() {
  if (document.querySelector('.telegram-chat')) return;
  const chat = document.createElement('a');
  chat.className = 'telegram-chat'; chat.href = 'https://t.me/Yianglin1'; chat.target = '_blank'; chat.rel = 'noopener noreferrer';
  chat.setAttribute('aria-label', 'Chat via Telegram'); chat.innerHTML = '<i class="fab fa-telegram-plane"></i><span>Chat via Telegram</span>';
  document.body.appendChild(chat);
}
document.addEventListener('DOMContentLoaded', injectTelegramChat);
if (document.readyState !== 'loading') injectTelegramChat();
