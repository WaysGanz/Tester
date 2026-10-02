// ============================================
// BastardBlast Admin — SPA Frontend
// ============================================

const API = {
  async get(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request gagal');
    return data;
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (res.status === 401) { window.location.href = '/'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request gagal');
    return data;
  },
  async put(url, body) {
    const res = await fetch(url, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (res.status === 401) { window.location.href = '/'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request gagal');
    return data;
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
    if (res.status === 401) { window.location.href = '/'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request gagal');
    return data;
  }
};

// ============================================
// STATE
// ============================================
const state = {
  admin: null,
  permissions: [],
  currentPage: 'ringkasan',
  pageParams: {},
  sidebarOpen: false
};

const MENU = [
  { section: 'Operasional' },
  { key: 'ringkasan', label: 'Ringkasan',         icon: 'fa-gauge-high' },
  { key: 'penarikan', label: 'Penarikan',         icon: 'fa-money-bill-transfer', badge: 'wdPending', perm: 'withdrawal.approve' },
  { key: 'risiko',    label: 'Tinjauan Risiko',   icon: 'fa-shield-halved', badge: 'riskHigh' },
  { section: 'Data & Kampanye' },
  { key: 'kampanye',  label: 'Kampanye',          icon: 'fa-bullhorn' },
  { key: 'nomor',     label: 'Data Nomor',        icon: 'fa-address-book' },
  { key: 'perangkat', label: 'Perangkat',         icon: 'fa-mobile-screen-button' },
  { key: 'pengguna',  label: 'Pengguna',          icon: 'fa-users' },
  { section: 'Komunikasi' },
  { key: 'inbox',     label: 'Kotak Masuk',       icon: 'fa-inbox', badge: 'inboxUnread' },
  { key: 'tiket',     label: 'Tiket Bantuan',     icon: 'fa-headset' },
  { section: 'Analitik & Keuangan' },
  { key: 'laporan',   label: 'Laporan Pengiriman', icon: 'fa-chart-line' },
  { key: 'keuangan',  label: 'Keuangan',          icon: 'fa-wallet', perm: 'finance.view' },
  { section: 'Sistem' },
  { key: 'audit',     label: 'Log Audit',         icon: 'fa-scroll', perm: 'audit.view' },
  { key: 'pengaturan',label: 'Pengaturan Platform',icon: 'fa-sliders', perm: 'settings.manage' },
  { key: 'tim',       label: 'Tim & Akses',       icon: 'fa-user-shield', perm: 'admin.manage' }
];

// ============================================
// HELPERS
// ============================================
function rp(n) { return 'Rp ' + (Number(n) || 0).toLocaleString('id-ID'); }
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtAgo(s) {
  if (!s) return '-';
  const diff = (Date.now() - new Date(s).getTime()) / 1000;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return Math.floor(diff / 60) + ' menit lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  return Math.floor(diff / 86400) + ' hari lalu';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function hasPerm(key) {
  if (!state.admin) return false;
  if (state.admin.role === 'owner') return true;
  const p = state.permissions.find(x => x.key === key);
  return p && p.allowed;
}

// ============================================
// TOAST
// ============================================
function toast(type, title, msg = '') {
  const w = document.getElementById('toastWrap');
  const icons = { success: 'fa-check', error: 'fa-times', warning: 'fa-exclamation', info: 'fa-info' };
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML =
    '<div class="toast-icon"><i class="fas ' + (icons[type] || 'fa-info') + '"></i></div>' +
    '<div class="toast-body">' +
      '<div class="toast-title">' + esc(title) + '</div>' +
      (msg ? '<div class="toast-msg">' + esc(msg) + '</div>' : '') +
    '</div>';
  w.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s, transform .25s';
    t.style.opacity = '0';
    t.style.transform = 'translateX(20px)';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

// ============================================
// MODAL
// ============================================
function openModal({ title, sub = '', bodyHtml, footHtml = '', size = '' }) {
  const m = document.getElementById('modalBox');
  m.className = 'modal ' + size;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent = sub;
  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modalFoot').innerHTML = footHtml;
  document.getElementById('modalBackdrop').classList.add('active');
}
function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('active');
}
function confirmModal({ title, message, confirmText = 'Konfirmasi', danger = false, onConfirm }) {
  openModal({
    title,
    bodyHtml: '<p style="font-size:13.5px;color:var(--text-2);line-height:1.6;">' + esc(message) + '</p>',
    footHtml:
      '<button class="btn btn-secondary" onclick="closeModal()">Batal</button>' +
      '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" id="modalConfirmBtn">' + esc(confirmText) + '</button>'
  });
  document.getElementById('modalConfirmBtn').onclick = async () => {
    const btn = document.getElementById('modalConfirmBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memproses...';
    try { await onConfirm(); closeModal(); }
    catch (e) { toast('error', 'Gagal', e.message); btn.disabled = false; btn.textContent = confirmText; }
  };
}

// ============================================
// SIDEBAR RENDER
// ============================================
function renderSidebar(counts = {}) {
  const nav = document.getElementById('sidebarNav');
  let html = '';
  MENU.forEach(m => {
    if (m.section) {
      html += '<div class="nav-section">' + m.section + '</div>';
      return;
    }
    if (m.perm && !hasPerm(m.perm)) return;
    let badge = '';
    if (m.badge && counts[m.badge] > 0) badge = '<span class="nav-badge">' + counts[m.badge] + '</span>';
    const active = state.currentPage === m.key ? ' active' : '';
    html += '<div class="nav-item' + active + '" onclick="navigate(\'' + m.key + '\')">' +
      '<i class="fas ' + m.icon + '"></i><span>' + m.label + '</span>' + badge +
    '</div>';
  });
  nav.innerHTML = html;
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ============================================
// NAVIGATION
// ============================================
async function navigate(page, params = {}) {
  state.currentPage = page;
  state.pageParams = params;
  document.getElementById('sidebar').classList.remove('open');
  if (window.innerWidth < 900) toggleSidebarState(false);
  await renderPage();
  await refreshBadges();
}

function toggleSidebarState(v) {
  document.getElementById('sidebar').classList.toggle('open', v);
}

// ============================================
// PAGE RENDER
// ============================================
const PAGES = {
  ringkasan: renderRingkasan,
  penarikan: renderPenarikan,
  risiko: renderRisiko,
  pengguna: renderPengguna,
  kampanye: renderKampanye,
  nomor: renderNomor,
  perangkat: renderPerangkat,
  inbox: renderInbox,
  tiket: renderTiket,
  laporan: renderLaporan,
  keuangan: renderKeuangan,
  audit: renderAudit,
  pengaturan: renderPengaturan,
  tim: renderTim
};

async function renderPage() {
  const content = document.getElementById('pageContent');
  content.innerHTML = skeletonPage();
  const fn = PAGES[state.currentPage] || renderRingkasan;
  try { await fn(content); }
  catch (e) {
    content.innerHTML = '<div class="empty"><div class="empty-icon"><i class="fas fa-triangle-exclamation"></i></div>' +
      '<div class="empty-title">Terjadi kesalahan saat memuat data</div>' +
      '<div class="empty-sub">' + esc(e.message) + '</div></div>';
  }
}

function skeletonPage() {
  return '<div class="page-head"><div class="skeleton" style="width:180px;height:20px;margin-bottom:8px;"></div>' +
    '<div class="skeleton" style="width:320px;height:32px;margin-bottom:6px;"></div>' +
    '<div class="skeleton" style="width:260px;height:14px;"></div></div>' +
    '<div class="stats-grid">' + Array(4).fill(0).map(() => '<div class="skeleton skeleton-stat"></div>').join('') + '</div>' +
    '<div class="skeleton" style="height:300px;border-radius:12px;"></div>';
}

// ============================================
// PAGE: RINGKASAN
// ============================================
async function renderRingkasan(el) {
  const d = await API.get('/api/dashboard');
  const c = d.cards;
  const today = new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  el.innerHTML =
    '<div class="page-head">' +
      '<div class="breadcrumb"><span>BastardBlast</span><i class="fas fa-chevron-right"></i><span class="current">Ringkasan</span></div>' +
      '<div class="page-head-row">' +
        '<div>' +
          '<h1 class="page-title">Ringkasan</h1>' +
          '<p class="page-sub">Ketahui apa yang perlu diputuskan hari ini dan kondisi platform.</p>' +
        '</div>' +
        '<div class="text-muted text-sm"><i class="fas fa-calendar"></i> ' + today + '</div>' +
      '</div>' +
    '</div>' +

    '<h3 style="font-size:13px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px;">Perlu Perhatian Anda</h3>' +
    '<div class="action-grid">' +
      // Penarikan
      '<div class="action-card alert">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon warning"><i class="fas fa-money-bill-transfer"></i></div>' +
          '<div><div class="action-card-title">Penarikan Menunggu</div><div class="action-card-sub">Perlu persetujuan</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.withdrawals.c || 0) + '</div>' +
        '<div class="action-card-meta"><div>Total: <b>' + rp(c.withdrawals.total) + '</b></div>' +
        '<div>Terlama: <b>' + (c.withdrawals.oldest ? fmtAgo(c.withdrawals.oldest) : '-') + '</b></div></div>' +
        '<div class="action-card-foot"><button class="btn btn-primary btn-sm btn-block" onclick="navigate(\'penarikan\')">Buka Antrean <i class="fas fa-arrow-right"></i></button></div>' +
      '</div>' +
      // Risiko
      '<div class="action-card danger">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon danger"><i class="fas fa-shield-halved"></i></div>' +
          '<div><div class="action-card-title">Tinjauan Risiko</div><div class="action-card-sub">Belum ditinjau</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.risk.total || 0) + '</div>' +
        '<div class="action-card-meta"><div>Prioritas tinggi: <b style="color:var(--danger)">' + (c.risk.high || 0) + '</b></div></div>' +
        '<div class="action-card-foot"><button class="btn btn-primary btn-sm btn-block" onclick="navigate(\'risiko\')">Tinjau <i class="fas fa-arrow-right"></i></button></div>' +
      '</div>' +
      // Kampanye
      '<div class="action-card info">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon info"><i class="fas fa-bullhorn"></i></div>' +
          '<div><div class="action-card-title">Kampanye Aktif</div><div class="action-card-sub">Sedang berjalan</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.campaigns.active || 0) + '</div>' +
        '<div class="action-card-meta"><div>Total user: <b>' + c.users.total + '</b></div></div>' +
        '<div class="action-card-foot"><button class="btn btn-secondary btn-sm btn-block" onclick="navigate(\'kampanye\')">Lihat Kampanye</button></div>' +
      '</div>' +
      // Device
      '<div class="action-card success">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon success"><i class="fas fa-mobile-screen-button"></i></div>' +
          '<div><div class="action-card-title">Perangkat</div><div class="action-card-sub">Total terdaftar</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.devices.total || 0) + '</div>' +
        '<div class="action-card-meta">' +
          '<div><i class="badge-dot" style="background:var(--success)"></i> Tersambung: <b>' + (c.devices.connected || 0) + '</b></div>' +
          '<div><i class="badge-dot" style="background:var(--danger)"></i> Terputus: <b>' + (c.devices.disconnected || 0) + '</b></div>' +
        '</div>' +
        '<div class="action-card-foot"><button class="btn btn-secondary btn-sm btn-block" onclick="navigate(\'perangkat\')">Kelola</button></div>' +
      '</div>' +
      // Data Nomor
      '<div class="action-card">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon"><i class="fas fa-address-book"></i></div>' +
          '<div><div class="action-card-title">Data Nomor</div><div class="action-card-sub">Database kontak</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.numbers.total || 0) + '</div>' +
        '<div class="action-card-meta">' +
          '<div>Tersedia: <b style="color:var(--success)">' + (c.numbers.available || 0) + '</b></div>' +
          '<div>Terpakai: <b>' + (c.numbers.used || 0) + '</b> • Gagal: <b style="color:var(--danger)">' + (c.numbers.failed || 0) + '</b></div>' +
        '</div>' +
        '<div class="action-card-foot"><button class="btn btn-secondary btn-sm btn-block" onclick="navigate(\'nomor\')">Kelola</button></div>' +
      '</div>' +
      // Inbox
      '<div class="action-card">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon"><i class="fas fa-inbox"></i></div>' +
          '<div><div class="action-card-title">Kotak Masuk</div><div class="action-card-sub">Percakapan</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.inbox.unread || 0) + '</div>' +
        '<div class="action-card-meta"><div>Conversation aktif: <b>' + (c.inbox.total || 0) + '</b></div></div>' +
        '<div class="action-card-foot"><button class="btn btn-secondary btn-sm btn-block" onclick="navigate(\'inbox\')">Buka Inbox</button></div>' +
      '</div>' +
      // Tiket
      '<div class="action-card">' +
        '<div class="action-card-head">' +
          '<div class="action-card-icon"><i class="fas fa-headset"></i></div>' +
          '<div><div class="action-card-title">Tiket Bantuan</div><div class="action-card-sub">Dukungan user</div></div>' +
        '</div>' +
        '<div class="action-card-value">' + (c.tickets.open || 0) + '</div>' +
        '<div class="action-card-meta"><div>Menunggu balasan: <b style="color:var(--warning)">' + (c.tickets.waiting || 0) + '</b></div></div>' +
        '<div class="action-card-foot"><button class="btn btn-secondary btn-sm btn-block" onclick="navigate(\'tiket\')">Buka Tiket</button></div>' +
      '</div>' +
    '</div>' +

    '<h3 style="font-size:13px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.6px;margin:26px 0 12px;">Platform Saat Ini</h3>' +
    '<div class="stats-grid">' +
      statCard('Perangkat Tersambung', c.devices.connected || 0, 'fa-mobile-screen-button', 'success') +
      statCard('Perangkat Terputus', c.devices.disconnected || 0, 'fa-plug-circle-xmark', 'danger') +
      statCard('Perlu Reconnect', c.devices.need_reconnect || 0, 'fa-rotate', 'warning') +
      statCard('Kampanye Aktif', c.campaigns.active || 0, 'fa-bullhorn', 'info') +
      statCard('Total Nomor', c.numbers.total || 0, 'fa-address-book') +
      statCard('User Aktif', c.users.total || 0, 'fa-users') +
    '</div>' +

    '<div class="grid-2 mt-3">' +
      '<div class="card">' +
        '<div class="card-head"><div><div class="card-title">Aktivitas Terbaru</div><div class="card-sub">15 aksi terakhir</div></div>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigate(\'audit\')">Semua</button></div>' +
        '<div class="card-body" style="padding:0;">' +
          (d.activity.length === 0 ? emptyState('Belum ada aktivitas') :
          '<table class="tbl"><tbody>' +
            d.activity.map(a =>
              '<tr><td style="width:36px;"><div class="avatar sm gray">' + esc((a.actor_email || 'S')[0].toUpperCase()) + '</div></td>' +
              '<td><div class="td-strong">' + esc(a.action) + '</div><div class="td-muted">' + esc(a.actor_email || '-') + '</div></td>' +
              '<td class="td-muted" style="text-align:right;">' + fmtAgo(a.created_at) + '</td></tr>'
            ).join('') +
          '</tbody></table>') +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div><div class="card-title">Alert Sistem</div><div class="card-sub">Perlu tindakan</div></div></div>' +
        '<div class="card-body">' +
          alertRow('Perangkat perlu dipasang ulang', (c.devices.need_reconnect || 0) + ' perangkat', 'warning', 'perangkat') +
          alertRow('Risiko tinggi terdeteksi', (c.risk.high || 0) + ' insiden', 'danger', 'risiko') +
          alertRow('Nomor gagal / invalid', ((c.numbers.failed || 0) + (c.numbers.invalid || 0)) + ' nomor', 'warning', 'nomor') +
          alertRow('Tiket menunggu balasan', (c.tickets.waiting || 0) + ' tiket', 'info', 'tiket') +
        '</div>' +
      '</div>' +
    '</div>';
}

function statCard(label, value, icon, tone = '') {
  return '<div class="stat-card">' +
    '<div class="stat-head">' +
      '<div class="stat-label">' + label + '</div>' +
      '<div class="stat-icon ' + tone + '"><i class="fas ' + icon + '"></i></div>' +
    '</div>' +
    '<div class="stat-value">' + (typeof value === 'number' ? value.toLocaleString('id-ID') : value) + '</div>' +
  '</div>';
}

function alertRow(title, sub, tone, page) {
  return '<div class="flex-between" style="padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer;" onclick="navigate(\'' + page + '\')">' +
    '<div class="flex-center gap-1">' +
      '<span class="badge-dot" style="background:var(--' + (tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info') + ');width:8px;height:8px;"></span>' +
      '<div><div style="font-size:13px;font-weight:600;color:var(--text);">' + esc(title) + '</div>' +
      '<div class="text-muted text-xs">' + esc(sub) + '</div></div>' +
    '</div>' +
    '<i class="fas fa-chevron-right text-muted" style="font-size:11px;"></i>' +
  '</div>';
}

function emptyState(msg = 'Belum ada data') {
  return '<div class="empty"><div class="empty-icon"><i class="fas fa-inbox"></i></div>' +
    '<div class="empty-title">' + esc(msg) + '</div>' +
    '<div class="empty-sub">Data akan muncul di sini</div></div>';
}

// ============================================
// PAGE: PENARIKAN
// ============================================
async function renderPenarikan(el) {
  const q = { status: state.pageParams.status || 'all', page: state.pageParams.page || 1, search: state.pageParams.search || '' };
  const d = await API.get('/api/withdrawals?' + new URLSearchParams(q));
  const statMap = {};
  d.stats.forEach(s => statMap[s.status] = s);

  el.innerHTML =
    pageHead('Penarikan', 'Kelola permintaan penarikan saldo pengguna.', 'Operasional', 'Penarikan') +
    '<div class="stats-grid mb-3">' +
      statCard('Pending', (statMap.pending?.c || 0), 'fa-clock', 'warning') +
      statCard('Disetujui', (statMap.approved?.c || 0), 'fa-check', 'info') +
      statCard('Ditolak', (statMap.rejected?.c || 0), 'fa-xmark', 'danger') +
      statCard('Dibayar', (statMap.paid?.c || 0), 'fa-circle-check', 'success') +
    '</div>' +

    '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
        '<div class="toolbar-search"><i class="fas fa-magnifying-glass"></i>' +
        '<input type="text" id="wdSearch" placeholder="Cari nama/email/rekening..." value="' + esc(q.search) + '"></div>' +
        '<select class="toolbar-select" id="wdStatus">' +
          ['all','pending','approved','rejected','paid'].map(s =>
            '<option value="' + s + '"' + (q.status === s ? ' selected' : '') + '>' + (s === 'all' ? 'Semua Status' : s.charAt(0).toUpperCase() + s.slice(1)) + '</option>'
          ).join('') +
        '</select>' +
        '<div class="grow"></div>' +
        '<button class="btn btn-secondary btn-sm" onclick="applyWdFilter()"><i class="fas fa-filter"></i> Filter</button>' +
      '</div>' +
      '<div class="table-scroll">' +
        '<table class="tbl"><thead><tr>' +
          '<th>ID</th><th>Pengguna</th><th>Nominal</th><th>Metode</th><th>Rekening</th><th>Tanggal</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' +
        (d.data.length === 0 ? '<tr><td colspan="8">' + emptyState('Belum ada penarikan') + '</td></tr>' :
          d.data.map(w => {
            const statusBadge = wdStatusBadge(w.status);
            const actions = w.status === 'pending' && hasPerm('withdrawal.approve')
              ? '<button class="btn btn-success btn-sm" onclick="wdAction(' + w.id + ',\'approve\')"><i class="fas fa-check"></i></button>' +
                '<button class="btn btn-danger btn-sm" onclick="wdAction(' + w.id + ',\'reject\')" style="margin-left:4px;"><i class="fas fa-xmark"></i></button>'
              : w.status === 'approved' && hasPerm('withdrawal.approve')
                ? '<button class="btn btn-primary btn-sm" onclick="wdAction(' + w.id + ',\'paid\')">Tandai Dibayar</button>'
                : '<button class="btn btn-ghost btn-sm" onclick="wdDetail(' + w.id + ')"><i class="fas fa-eye"></i></button>';
            return '<tr>' +
              '<td class="td-mono">#' + w.id + '</td>' +
              '<td><div class="td-strong">' + esc(w.user_name) + '</div><div class="td-muted">' + esc(w.user_email) + '</div></td>' +
              '<td class="td-strong">' + rp(w.amount) + '</td>' +
              '<td>' + esc((w.method || '').toUpperCase()) + '</td>' +
              '<td class="td-mono">' + esc(w.account_number || '-') + '<div class="td-muted">' + esc(w.account_name || '') + '</div></td>' +
              '<td class="td-muted">' + fmtDate(w.created_at) + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td style="text-align:right;">' + actions + '</td>' +
            '</tr>';
          }).join('')) +
        '</tbody></table>' +
      '</div>' +
      paginationBar(d, 'penarikan') +
    '</div>';

  document.getElementById('wdStatus').onchange = () => applyWdFilter();
  document.getElementById('wdSearch').onkeydown = (e) => { if (e.key === 'Enter') applyWdFilter(); };
}

function wdStatusBadge(s) {
  const map = {
    pending:  ['warning', 'fa-clock', 'Pending'],
    approved: ['info', 'fa-check', 'Disetujui'],
    rejected: ['danger', 'fa-xmark', 'Ditolak'],
    paid:     ['success', 'fa-circle-check', 'Dibayar']
  };
  const v = map[s] || ['gray', 'fa-circle', s];
  return '<span class="badge badge-' + v[0] + '"><i class="fas ' + v[1] + '"></i> ' + v[2] + '</span>';
}

function applyWdFilter() {
  navigate('penarikan', {
    status: document.getElementById('wdStatus').value,
    search: document.getElementById('wdSearch').value.trim(),
    page: 1
  });
}

function wdAction(id, action) {
  const label = { approve: 'Setujui', reject: 'Tolak', paid: 'Tandai dibayar' }[action];
  confirmModal({
    title: label + ' Penarikan #' + id,
    message: 'Anda yakin ingin ' + label.toLowerCase() + ' penarikan ini? Aksi ini akan tercatat di log audit.',
    confirmText: label, danger: action === 'reject',
    onConfirm: async () => {
      await API.post('/api/withdrawals/' + id + '/' + action, {});
      toast('success', 'Berhasil', 'Penarikan berhasil di-' + label.toLowerCase());
      renderPage();
      refreshBadges();
    }
  });
}

function wdDetail(id) {
  toast('info', 'Detail', 'Drawer detail akan segera hadir');
}

// ============================================
// PAGE: RISIKO
// ============================================
async function renderRisiko(el) {
  const q = { severity: state.pageParams.severity || 'all', status: state.pageParams.status || 'all', page: 1 };
  const d = await API.get('/api/risk?' + new URLSearchParams(q));
  const statMap = d.stats;

  el.innerHTML =
    pageHead('Tinjauan Risiko', 'Pantau dan tindak lanjuti indikasi risiko pada platform.', 'Operasional', 'Risiko') +
    '<div class="stats-grid mb-3">' +
      statCard('Prioritas Tinggi', statMap.high || 0, 'fa-fire', 'danger') +
      statCard('Prioritas Sedang', statMap.medium || 0, 'fa-exclamation', 'warning') +
      statCard('Prioritas Rendah', statMap.low || 0, 'fa-info', 'info') +
      statCard('Sudah Ditinjau', statMap.reviewed || 0, 'fa-check', 'success') +
    '</div>' +
    '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
        '<select class="toolbar-select" id="rkSeverity" onchange="applyRkFilter()">' +
          ['all','high','medium','low'].map(s => '<option value="' + s + '"' + (q.severity === s ? ' selected' : '') + '>' + (s === 'all' ? 'Semua Severity' : s.toUpperCase()) + '</option>').join('') +
        '</select>' +
        '<select class="toolbar-select" id="rkStatus" onchange="applyRkFilter()">' +
          ['all','unreviewed','reviewed','safe','ignored','restricted'].map(s => '<option value="' + s + '"' + (q.status === s ? ' selected' : '') + '>' + (s === 'all' ? 'Semua Status' : s) + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="table-scroll"><table class="tbl"><thead><tr>' +
        '<th>Severity</th><th>User</th><th>Rule</th><th>Evidence</th><th>Waktu</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' +
      (d.data.length === 0 ? '<tr><td colspan="7">' + emptyState('Tidak ada risiko') + '</td></tr>' :
        d.data.map(r => {
          const sev = { high: ['danger','fa-fire','Tinggi'], medium: ['warning','fa-exclamation','Sedang'], low: ['info','fa-info','Rendah'] }[r.severity] || ['gray','fa-circle','-'];
          return '<tr>' +
            '<td><span class="badge badge-' + sev[0] + '"><i class="fas ' + sev[1] + '"></i> ' + sev[2] + '</span></td>' +
            '<td><div class="td-strong">' + esc(r.user_name || '-') + '</div><div class="td-muted">' + esc(r.user_email || '') + '</div></td>' +
            '<td><div class="td-strong">' + esc(r.rule) + '</div><div class="td-muted">' + esc(r.reason || '') + '</div></td>' +
            '<td class="td-mono text-xs">' + esc(r.evidence || '-') + '</td>' +
            '<td class="td-muted">' + fmtAgo(r.created_at) + '</td>' +
            '<td><span class="badge badge-' + (r.status === 'unreviewed' ? 'warning' : r.status === 'restricted' ? 'danger' : 'gray') + '">' + r.status + '</span></td>' +
            '<td style="text-align:right;">' + (r.status === 'unreviewed' ? '<button class="btn btn-primary btn-sm" onclick="rkAction(' + r.id + ',\'review\')">Tinjau</button>' : '<span class="text-muted text-xs">Selesai</span>') + '</td>' +
          '</tr>';
        }).join('')) +
      '</tbody></table></div>' +
    '</div>';
}

function applyRkFilter() {
  navigate('risiko', {
    severity: document.getElementById('rkSeverity').value,
    status: document.getElementById('rkStatus').value
  });
}

function rkAction(id, action) {
  const label = { review: 'tinjau', safe: 'tandai aman', ignore: 'abaikan', restrict: 'batasi akun' }[action];
  confirmModal({
    title: 'Tindak Lanjuti Risiko',
    message: 'Anda yakin ingin ' + label + ' item risiko #' + id + '?',
    onConfirm: async () => {
      await API.post('/api/risk/' + id + '/' + action, {});
      toast('success', 'Berhasil', 'Risiko telah di-' + label);
      renderPage();
    }
  });
}

// ============================================
// PAGE: PENGGUNA
// ============================================
async function renderPengguna(el) {
  const q = { status: state.pageParams.status || 'all', page: state.pageParams.page || 1, search: state.pageParams.search || '' };
  const d = await API.get('/api/users?' + new URLSearchParams(q));
  const st = d.stats;

  el.innerHTML =
    pageHead('Pengguna', 'Kelola akun pengguna platform.', 'Data', 'Pengguna') +
    '<div class="stats-grid mb-3">' +
      statCard('Total User', st.total || 0, 'fa-users') +
      statCard('Aktif', st.active || 0, 'fa-circle-check', 'success') +
      statCard('Suspended', st.suspended || 0, 'fa-ban', 'danger') +
      statCard('Pending', st.pending || 0, 'fa-clock', 'warning') +
    '</div>' +
    '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
        '<div class="toolbar-search"><i class="fas fa-magnifying-glass"></i>' +
        '<input type="text" id="usSearch" placeholder="Cari nama, email, atau telepon..." value="' + esc(q.search) + '"></div>' +
        '<select class="toolbar-select" id="usStatus" onchange="applyUsFilter()">' +
          ['all','active','suspended','pending'].map(s => '<option value="' + s + '"' + (q.status === s ? ' selected' : '') + '>' + (s === 'all' ? 'Semua Status' : s.charAt(0).toUpperCase() + s.slice(1)) + '</option>').join('') +
        '</select>' +
        '<button class="btn btn-secondary btn-sm" onclick="applyUsFilter()"><i class="fas fa-filter"></i> Filter</button>' +
      '</div>' +
      '<div class="table-scroll"><table class="tbl"><thead><tr>' +
        '<th>Nama</th><th>Kontak</th><th>Status</th><th>Saldo</th><th>Kampanye</th><th>Dibuat</th><th></th>' +
      '</tr></thead><tbody>' +
      (d.data.length === 0 ? '<tr><td colspan="7">' + emptyState('Belum ada pengguna') + '</td></tr>' :
        d.data.map(u => {
          const badge = u.status === 'active' ? 'success' : u.status === 'suspended' ? 'danger' : 'warning';
          return '<tr class="clickable" onclick="showUserDetail(' + u.id + ')">' +
            '<td><div class="flex-center gap-1"><div class="avatar sm">' + esc((u.name || 'U')[0].toUpperCase()) + '</div>' +
            '<div class="td-strong">' + esc(u.name) + '</div></div></td>' +
            '<td><div>' + esc(u.email) + '</div><div class="td-muted">' + esc(u.phone || '-') + '</div></td>' +
            '<td><span class="badge badge-' + badge + '">' + u.status + '</span></td>' +
            '<td class="td-strong">' + rp(u.balance) + '</td>' +
            '<td>' + (u.total_campaigns || 0) + '</td>' +
            '<td class="td-muted">' + fmtDate(u.created_at) + '</td>' +
            '<td style="text-align:right;" onclick="event.stopPropagation()">' +
              '<button class="btn btn-ghost btn-sm" onclick="showUserDetail(' + u.id + ')"><i class="fas fa-eye"></i></button>' +
              (hasPerm('balance.edit') ? '<button class="btn btn-ghost btn-sm" onclick="editBalance(' + u.id + ',\'' + esc(u.name) + '\',' + (u.balance || 0) + ')" title="Ubah saldo"><i class="fas fa-pen"></i></button>' : '') +
              (hasPerm('user.suspend') ? (u.status === 'active'
                ? '<button class="btn btn-ghost btn-sm" onclick="userStatus(' + u.id + ',\'suspend\')" title="Suspend" style="color:var(--danger)"><i class="fas fa-ban"></i></button>'
                : '<button class="btn btn-ghost btn-sm" onclick="userStatus(' + u.id + ',\'activate\')" title="Aktifkan" style="color:var(--success)"><i class="fas fa-circle-check"></i></button>') : '') +
            '</td>' +
          '</tr>';
        }).join('')) +
      '</tbody></table></div>' +
      paginationBar(d, 'pengguna') +
    '</div>';

  document.getElementById('usSearch').onkeydown = (e) => { if (e.key === 'Enter') applyUsFilter(); };
}

function applyUsFilter() {
  navigate('pengguna', {
    status: document.getElementById('usStatus').value,
    search: document.getElementById('usSearch').value.trim(),
    page: 1
  });
}

async function showUserDetail(id) {
  try {
    const d = await API.get('/api/users/' + id);
    const u = d.user;
    openModal({
      title: u.name,
      sub: u.email,
      size: 'lg',
      bodyHtml:
        '<div class="tabs" id="userTabs">' +
          '<button class="tab active" data-tab="profil">Profil</button>' +
          '<button class="tab" data-tab="saldo">Saldo</button>' +
          '<button class="tab" data-tab="campaign">Kampanye</button>' +
          '<button class="tab" data-tab="device">Perangkat</button>' +
        '</div>' +
        '<div id="userTabContent">' + userProfilTab(u, d) + '</div>',
      footHtml: '<button class="btn btn-secondary" onclick="closeModal()">Tutup</button>'
    });
    document.querySelectorAll('#userTabs .tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('#userTabs .tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        const which = t.dataset.tab;
        const c = document.getElementById('userTabContent');
        if (which === 'profil') c.innerHTML = userProfilTab(u, d);
        if (which === 'saldo') c.innerHTML = userSaldoTab(d);
        if (which === 'campaign') c.innerHTML = userCampaignTab(d);
        if (which === 'device') c.innerHTML = userDeviceTab(d);
      };
    });
  } catch (e) { toast('error', 'Gagal', e.message); }
}

function userProfilTab(u, d) {
  return '<div class="grid-2">' +
    '<div><div class="form-row"><label>Nama</label><div class="td-strong">' + esc(u.name) + '</div></div>' +
    '<div class="form-row"><label>Email</label><div>' + esc(u.email) + '</div></div>' +
    '<div class="form-row"><label>Telepon</label><div>' + esc(u.phone || '-') + '</div></div></div>' +
    '<div><div class="form-row"><label>Status</label><div><span class="badge badge-' + (u.status === 'active' ? 'success' : 'danger') + '">' + u.status + '</span></div></div>' +
    '<div class="form-row"><label>Saldo</label><div class="td-strong">' + rp(u.balance) + '</div></div>' +
    '<div class="form-row"><label>Dibuat</label><div>' + fmtDate(u.created_at) + '</div></div></div>' +
  '</div>';
}
function userSaldoTab(d) {
  if (!d.transactions.length) return emptyState('Belum ada transaksi');
  return '<table class="tbl"><thead><tr><th>Tanggal</th><th>Tipe</th><th>Nominal</th><th>Keterangan</th></tr></thead><tbody>' +
    d.transactions.map(t => '<tr><td>' + fmtDate(t.created_at) + '</td>' +
      '<td><span class="badge badge-' + (t.amount >= 0 ? 'success' : 'danger') + '">' + t.type + '</span></td>' +
      '<td class="td-strong">' + rp(t.amount) + '</td>' +
      '<td class="td-muted">' + esc(t.description || '-') + '</td></tr>').join('') + '</tbody></table>';
}
function userCampaignTab(d) {
  if (!d.campaigns.length) return emptyState('Belum ada kampanye');
  return '<table class="tbl"><thead><tr><th>Nama</th><th>Status</th><th>Sent</th><th>Failed</th></tr></thead><tbody>' +
    d.campaigns.map(c => '<tr><td class="td-strong">' + esc(c.name) + '</td>' +
      '<td><span class="badge badge-gray">' + c.status + '</span></td>' +
      '<td>' + c.sent + ' / ' + c.total_recipients + '</td>' +
      '<td style="color:var(--danger)">' + c.failed + '</td></tr>').join('') + '</tbody></table>';
}
function userDeviceTab(d) {
  if (!d.devices.length) return emptyState('Belum ada perangkat');
  return '<table class="tbl"><thead><tr><th>Device ID</th><th>Nomor</th><th>Status</th><th>Last</th></tr></thead><tbody>' +
    d.devices.map(dv => '<tr><td class="td-mono">' + esc(dv.device_uid) + '</td>' +
      '<td>' + esc(dv.phone) + '</td>' +
      '<td><span class="badge badge-' + (dv.status === 'connected' ? 'success' : 'danger') + '">' + dv.status + '</span></td>' +
      '<td class="td-muted">' + fmtAgo(dv.last_activity) + '</td></tr>').join('') + '</tbody></table>';
}

function userStatus(id, action) {
  const label = action === 'suspend' ? 'Suspend' : 'Aktifkan';
  confirmModal({
    title: label + ' Pengguna',
    message: label + ' user ini? Aksi tercatat di audit log.',
    confirmText: label, danger: action === 'suspend',
    onConfirm: async () => {
      await API.post('/api/users/' + id + '/' + action, {});
      toast('success', 'Berhasil', 'User di-' + action);
      renderPage();
    }
  });
}

function editBalance(userId, userName, currentBalance) {
  openModal({
    title: 'Ubah Saldo — ' + userName,
    sub: 'Perubahan akan dicatat di log audit',
    bodyHtml:
      '<div class="form-row"><label>Saldo Saat Ini</label>' +
        '<div class="td-strong" id="curBalance" style="font-size:18px;">' + rp(currentBalance) + '</div>' +
        '<input type="hidden" id="curBalanceVal" value="' + currentBalance + '">' +
      '</div>' +
      '<div class="form-row"><label>Tipe Perubahan <span class="req">*</span></label>' +
        '<select class="input" id="balType">' +
          '<option value="add">Tambah (+)</option>' +
          '<option value="subtract">Kurangi (−)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-row"><label>Nominal (Rp) <span class="req">*</span></label>' +
        '<input type="number" class="input" id="balAmount" placeholder="25000" min="0" oninput="updateBalPreview()">' +
      '</div>' +
      '<div class="form-row"><label>Alasan <span class="req">*</span></label>' +
        '<textarea class="input" id="balReason" placeholder="Contoh: Bonus referral" style="min-height:60px;"></textarea>' +
      '</div>' +
      '<div style="background:var(--bg-subtle);border:1px solid var(--border);border-radius:10px;padding:14px;">' +
        '<div class="flex-between" style="margin-bottom:6px;"><span class="text-muted text-sm">Saldo Baru</span>' +
        '<span class="td-strong" id="balPreview" style="font-size:18px;">' + rp(currentBalance) + '</span></div>' +
        '<div class="text-muted text-xs">Perubahan ini tercatat dengan admin, timestamp, dan IP.</div>' +
      '</div>',
    footHtml:
      '<button class="btn btn-secondary" onclick="closeModal()">Batal</button>' +
      '<button class="btn btn-primary" id="balSaveBtn">Simpan Perubahan</button>'
  });
  document.getElementById('balSaveBtn').onclick = async () => {
    const type = document.getElementById('balType').value;
    const amount = parseInt(document.getElementById('balAmount').value);
    const reason = document.getElementById('balReason').value.trim();
    if (!amount || amount <= 0) return toast('error', 'Nominal tidak valid');
    if (!reason) return toast('error', 'Alasan wajib diisi');
    const btn = document.getElementById('balSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menyimpan...';
    try {
      const res = await API.post('/api/users/' + userId + '/balance', { type, amount, reason });
      toast('success', 'Saldo diperbarui', 'Sebelum ' + rp(res.before) + ' → Setelah ' + rp(res.after));
      closeModal();
      renderPage();
    } catch (e) {
      toast('error', 'Gagal', e.message);
      btn.disabled = false;
      btn.textContent = 'Simpan Perubahan';
    }
  };
}
function updateBalPreview() {
  const cur = parseFloat(document.getElementById('curBalanceVal').value) || 0;
  const amt = parseFloat(document.getElementById('balAmount').value) || 0;
  const type = document.getElementById('balType').value;
  const next = type === 'subtract' ? cur - amt : cur + amt;
  document.getElementById('balPreview').textContent = rp(Math.max(0, next));
}

// ============================================
// PAGE: KAMPANYE
// ============================================
async function renderKampanye(el) {
  const q = { status: state.pageParams.status || 'all', page: 1 };
  const d = await API.get('/api/campaigns?' + new URLSearchParams(q));
  el.innerHTML =
    pageHead('Kampanye', 'Kelola kampanye pengiriman pesan WhatsApp.', 'Data', 'Kampanye') +
    '<div class="tabs">' +
      ['all','active','paused','completed','draft'].map(s =>
        '<button class="tab' + (q.status === s ? ' active' : '') + '" onclick="navigate(\'kampanye\',{status:\'' + s + '\'})">' +
        (s === 'all' ? 'Semua' : s.charAt(0).toUpperCase() + s.slice(1)) + '</button>').join('') +
    '</div>' +
    '<div class="table-wrap"><div class="table-scroll"><table class="tbl"><thead><tr>' +
      '<th>Nama</th><th>User</th><th>Recipient</th><th>Sent</th><th>Failed</th><th>Rate</th><th>Status</th><th>Dibuat</th><th></th>' +
    '</tr></thead><tbody>' +
    (d.data.length === 0 ? '<tr><td colspan="9">' + emptyState('Belum ada kampanye') + '</td></tr>' :
      d.data.map(c => {
        const rate = c.total_recipients ? Math.round((c.sent / c.total_recipients) * 100) : 0;
        const tone = rate >= 80 ? 'success' : rate >= 50 ? 'warning' : 'danger';
        const actions = hasPerm('campaign.manage')
          ? (c.status === 'active'
              ? '<button class="btn btn-warning btn-sm" onclick="campAction(' + c.id + ',\'pause\')"><i class="fas fa-pause"></i></button>'
              : c.status === 'paused'
                ? '<button class="btn btn-success btn-sm" onclick="campAction(' + c.id + ',\'resume\')"><i class="fas fa-play"></i></button>'
                : '<span class="text-muted text-xs">-</span>')
          : '<span class="text-muted text-xs">-</span>';
        return '<tr>' +
          '<td class="td-strong">' + esc(c.name) + '</td>' +
          '<td>' + esc(c.user_name || '-') + '</td>' +
          '<td>' + (c.total_recipients || 0).toLocaleString('id-ID') + '</td>' +
          '<td>' + (c.sent || 0).toLocaleString('id-ID') + '</td>' +
          '<td style="color:var(--danger)">' + (c.failed || 0).toLocaleString('id-ID') + '</td>' +
          '<td><span class="badge badge-' + tone + '">' + rate + '%</span></td>' +
          '<td><span class="badge badge-gray">' + c.status + '</span></td>' +
          '<td class="td-muted">' + fmtDate(c.created_at) + '</td>' +
          '<td style="text-align:right;">' + actions + '</td>' +
        '</tr>';
      }).join('')) +
    '</tbody></table></div>' +
    paginationBar(d, 'kampanye') + '</div>';
}
function campAction(id, action) {
  const label = { pause: 'jeda', resume: 'lanjutkan', stop: 'hentikan' }[action];
  confirmModal({
    title: 'Kampanye',
    message: 'Yakin ingin ' + label + ' kampanye #' + id + '?',
    onConfirm: async () => {
      await API.post('/api/campaigns/' + id + '/' + action, {});
      toast('success', 'Berhasil', 'Kampanye di-' + label);
      renderPage();
    }
  });
}

// ============================================
// PAGE: NOMOR
// ============================================
async function renderNomor(el) {
  const q = { status: state.pageParams.status || 'all', page: 1, search: state.pageParams.search || '' };
  const d = await API.get('/api/numbers?' + new URLSearchParams(q));
  const s = d.stats;
  el.innerHTML =
    pageHead('Data Nomor', 'Database nomor WhatsApp.', 'Data', 'Nomor') +
    '<div class="stats-grid mb-3">' +
      statCard('Total', s.total || 0, 'fa-address-book') +
      statCard('Tersedia', s.available || 0, 'fa-circle-check', 'success') +
      statCard('Terpakai', s.used || 0, 'fa-circle-dot', 'info') +
      statCard('Blocked', s.blocked || 0, 'fa-ban', 'danger') +
      statCard('Invalid', s.invalid || 0, 'fa-triangle-exclamation', 'warning') +
      statCard('Gagal', s.failed || 0, 'fa-circle-xmark', 'danger') +
    '</div>' +
    '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
        '<div class="toolbar-search"><i class="fas fa-magnifying-glass"></i>' +
        '<input type="text" id="numSearch" placeholder="Cari nomor atau nama..." value="' + esc(q.search) + '"></div>' +
        '<select class="toolbar-select" id="numStatus" onchange="applyNumFilter()">' +
          ['all','available','used','blocked','invalid','failed'].map(x => '<option value="' + x + '"' + (q.status === x ? ' selected' : '') + '>' + (x === 'all' ? 'Semua Status' : x) + '</option>').join('') +
        '</select>' +
        '<button class="btn btn-secondary btn-sm" onclick="applyNumFilter()"><i class="fas fa-filter"></i> Filter</button>' +
      '</div>' +
      '<div class="table-scroll"><table class="tbl"><thead><tr>' +
        '<th>Nomor</th><th>Nama</th><th>Status</th><th>Terakhir Dipakai</th><th></th>' +
      '</tr></thead><tbody>' +
      (d.data.length === 0 ? '<tr><td colspan="5">' + emptyState('Belum ada nomor') + '</td></tr>' :
        d.data.map(n => {
          const tone = { available: 'success', used: 'info', blocked: 'danger', invalid: 'warning', failed: 'danger' }[n.status] || 'gray';
          return '<tr>' +
            '<td class="td-mono">' + esc(n.phone) + '</td>' +
            '<td>' + esc(n.name || '-') + '</td>' +
            '<td><span class="badge badge-' + tone + '">' + n.status + '</span></td>' +
            '<td class="td-muted">' + (n.last_used ? fmtAgo(n.last_used) : 'Belum pernah') + '</td>' +
            '<td style="text-align:right;">' +
              (n.status !== 'blocked'
                ? '<button class="btn btn-ghost btn-sm" onclick="numBlock(' + n.id + ')" title="Block"><i class="fas fa-ban"></i></button>'
                : '<span class="text-muted text-xs">blocked</span>') +
              '<button class="btn btn-ghost btn-sm" onclick="numDelete(' + n.id + ')" style="color:var(--danger)" title="Hapus"><i class="fas fa-trash"></i></button>' +
            '</td>' +
          '</tr>';
        }).join('')) +
      '</tbody></table></div>' +
      paginationBar(d, 'nomor') +
    '</div>';
  document.getElementById('numSearch').onkeydown = (e) => { if (e.key === 'Enter') applyNumFilter(); };
}
function applyNumFilter() {
  navigate('nomor', { status: document.getElementById('numStatus').value, search: document.getElementById('numSearch').value.trim() });
}
function numBlock(id) {
  confirmModal({ title: 'Block Nomor', message: 'Block nomor #' + id + '?',
    onConfirm: async () => { await API.post('/api/numbers/' + id + '/block', {}); toast('success', 'Nomor diblokir'); renderPage(); }});
}
function numDelete(id) {
  confirmModal({ title: 'Hapus Nomor', message: 'Hapus nomor #' + id + '? Aksi ini permanen.', danger: true,
    onConfirm: async () => { await API.del('/api/numbers/' + id); toast('success', 'Nomor dihapus'); renderPage(); }});
}

// ============================================
// PAGE: PERANGKAT
// ============================================
async function renderPerangkat(el) {
  const q = { status: state.pageParams.status || 'all', page: 1 };
  const d = await API.get('/api/devices?' + new URLSearchParams(q));
  const s = d.stats;
  el.innerHTML =
    pageHead('Perangkat WhatsApp', 'Kelola perangkat/session WhatsApp.', 'Data', 'Perangkat') +
    '<div class="stats-grid mb-3">' +
      statCard('Total', s.total || 0, 'fa-mobile-screen-button') +
      statCard('Connected', s.connected || 0, 'fa-plug-circle-check', 'success') +
      statCard('Disconnected', s.disconnected || 0, 'fa-plug-circle-xmark', 'danger') +
      statCard('Need Reconnect', s.need_reconnect || 0, 'fa-rotate', 'warning') +
      statCard('Restricted', s.restricted || 0, 'fa-ban', 'danger') +
    '</div>' +
    '<div class="table-wrap">' +
      '<div class="table-toolbar">' +
        '<select class="toolbar-select" id="devStatus" onchange="applyDevFilter()">' +
          ['all','connected','disconnected','need_reconnect','restricted'].map(x => '<option value="' + x + '"' + (q.status === x ? ' selected' : '') + '>' + (x === 'all' ? 'Semua Status' : x) + '</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="table-scroll"><table class="tbl"><thead><tr>' +
        '<th>Device ID</th><th>Nomor</th><th>Pemilik</th><th>Status</th><th>Platform</th><th>Terakhir</th><th></th>' +
      '</tr></thead><tbody>' +
      (d.data.length === 0 ? '<tr><td colspan="7">' + emptyState('Belum ada perangkat') + '</td></tr>' :
        d.data.map(dv => {
          const tone = { connected: 'success', disconnected: 'danger', need_reconnect: 'warning', restricted: 'danger' }[dv.status] || 'gray';
          return '<tr>' +
            '<td class="td-mono">' + esc(dv.device_uid) + '</td>' +
            '<td class="td-mono">' + esc(dv.phone || '-') + '</td>' +
            '<td>' + esc(dv.user_name || '-') + '</td>' +
            '<td><span class="badge badge-' + tone + '">' + dv.status + '</span></td>' +
            '<td>' + esc(dv.platform || '-') + '</td>' +
            '<td class="td-muted">' + fmtAgo(dv.last_activity) + '</td>' +
            '<td style="text-align:right;">' +
              (dv.status === 'connected'
                ? '<button class="btn btn-ghost btn-sm" onclick="devAction(' + dv.id + ',\'disconnect\')" title="Disconnect"><i class="fas fa-plug-circle-xmark"></i></button>'
                : '<button class="btn btn-primary btn-sm" onclick="devAction(' + dv.id + ',\'reconnect\')">Reconnect</button>') +
              '<button class="btn btn-ghost btn-sm" onclick="devQR(' + dv.id + ')" title="QR"><i class="fas fa-qrcode"></i></button>' +
            '</td>' +
          '</tr>';
        }).join('')) +
      '</tbody></table></div>' +
      paginationBar(d, 'perangkat') +
    '</div>';
}
function applyDevFilter() { navigate('perangkat', { status: document.getElementById('devStatus').value }); }
function devAction(id, action) {
  confirmModal({
    title: action === 'reconnect' ? 'Reconnect Device' : 'Disconnect Device',
    message: 'Yakin ingin ' + action + ' device #' + id + '?',
    onConfirm: async () => { await API.post('/api/devices/' + id + '/' + action, {}); toast('success', 'Berhasil'); renderPage(); }
  });
}
async function devQR(id) {
  try {
    const d = await API.get('/api/devices/' + id + '/qr');
    openModal({
      title: 'QR Code Device', sub: 'Scan dengan WhatsApp',
      bodyHtml: '<div style="text-align:center;">' +
        (d.qr ? '<img src="' + d.qr + '" style="max-width:240px;border-radius:12px;border:1px solid var(--border);">' : '<p>QR tidak tersedia</p>') +
        '<p class="text-muted text-sm mt-2">Buka WhatsApp → Perangkat Tertaut → Tautkan Perangkat</p>' +
      '</div>',
      footHtml: '<button class="btn btn-secondary" onclick="closeModal()">Tutup</button>'
    });
  } catch (e) { toast('error', 'Gagal', e.message); }
}

// ============================================
// PAGE: INBOX
// ============================================
async function renderInbox(el) {
  el.innerHTML = pageHead('Kotak Masuk', 'Balas pesan pelanggan.', 'Komunikasi', 'Inbox') +
    '<div class="inbox-layout" id="inboxLayout">' +
      '<div class="inbox-conv-list" id="convList"><div class="skeleton skeleton-row"></div></div>' +
      '<div class="inbox-chat" id="chatPane"><div class="empty"><div class="empty-icon"><i class="fas fa-comments"></i></div><div class="empty-title">Pilih percakapan</div></div></div>' +
      '<div class="inbox-info" id="custInfo"></div>' +
    '</div>';
  await loadConversations();
}
async function loadConversations() {
  try {
    const d = await API.get('/api/inbox/conversations');
    const list = document.getElementById('convList');
    if (!d.data.length) { list.innerHTML = emptyState('Belum ada percakapan'); return; }
    list.innerHTML = d.data.map(c =>
      '<div class="inbox-conv-item" onclick="openConversation(' + c.id + ')">' +
        '<div class="flex-center gap-1" style="margin-bottom:4px;">' +
          '<div class="avatar sm">' + esc((c.contact_name || 'C')[0].toUpperCase()) + '</div>' +
          '<div class="grow"><div class="td-strong" style="font-size:13px;">' + esc(c.contact_name || '-') + '</div>' +
          '<div class="text-muted text-xs">' + esc(c.contact_phone || '-') + '</div></div>' +
          (c.unread_count > 0 ? '<span class="badge badge-danger">' + c.unread_count + '</span>' : '') +
        '</div>' +
        '<div class="text-muted text-xs" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.last_message || '') + '</div>' +
      '</div>'
    ).join('');
  } catch (e) { toast('error', 'Gagal', e.message); }
}
async function openConversation(id) {
  try {
    const d = await API.get('/api/inbox/conversations/' + id);
    const c = d.conversation;
    document.getElementById('chatPane').innerHTML =
      '<div class="inbox-chat-head">' +
        '<div class="avatar sm">' + esc((c.contact_name || 'C')[0].toUpperCase()) + '</div>' +
        '<div><div class="td-strong">' + esc(c.contact_name || '-') + '</div>' +
        '<div class="text-muted text-xs">' + esc(c.contact_phone || '-') + '</div></div>' +
      '</div>' +
      '<div class="inbox-chat-body" id="chatBody">' +
        d.messages.map(m => '<div class="bubble ' + m.direction + '">' + esc(m.content) +
          '<span class="bubble-time">' + fmtDate(m.created_at) + '</span></div>').join('') +
      '</div>' +
      '<div class="inbox-chat-foot">' +
        '<textarea id="replyBox" placeholder="Tulis balasan..."></textarea>' +
        '<button class="btn btn-primary" onclick="sendReply(' + id + ')"><i class="fas fa-paper-plane"></i></button>' +
      '</div>';
    document.getElementById('chatBody').scrollTop = 9999;
    document.getElementById('custInfo').innerHTML =
      '<div class="card-title mb-2">Info Customer</div>' +
      '<div class="form-row"><label>Nama</label><div>' + esc(c.contact_name || '-') + '</div></div>' +
      '<div class="form-row"><label>Nomor</label><div class="td-mono">' + esc(c.contact_phone || '-') + '</div></div>' +
      '<div class="form-row"><label>Tags</label><div>' + esc(c.tags || '-') + '</div></div>' +
      '<div class="form-row"><label>Notes</label><div class="text-muted text-sm">' + esc(c.notes || '-') + '</div></div>';
  } catch (e) { toast('error', 'Gagal', e.message); }
}
async function sendReply(id) {
  const box = document.getElementById('replyBox');
  const content = box.value.trim();
  if (!content) return;
  try {
    await API.post('/api/inbox/conversations/' + id + '/reply', { content });
    box.value = '';
    openConversation(id);
    toast('success', 'Terkirim');
  } catch (e) { toast('error', 'Gagal', e.message); }
}

// ============================================
// PAGE: TIKET
// ============================================
async function renderTiket(el) {
  const q = { status: state.pageParams.status || 'all', page: 1 };
  const d = await API.get('/api/tickets?' + new URLSearchParams(q));
  const s = d.stats;
  el.innerHTML =
    pageHead('Tiket Bantuan', 'Kelola tiket dukungan pengguna.', 'Komunikasi', 'Tiket') +
    '<div class="stats-grid mb-3">' +
      statCard('Open', s.open || 0, 'fa-envelope-open', 'info') +
      statCard('Pending', s.pending || 0, 'fa-clock', 'warning') +
      statCard('Waiting User', s.waiting_user || 0, 'fa-user-clock', 'warning') +
      statCard('Resolved', s.resolved || 0, 'fa-check', 'success') +
      statCard('Closed', s.closed || 0, 'fa-circle-xmark') +
    '</div>' +
    '<div class="table-wrap"><div class="table-toolbar">' +
      '<select class="toolbar-select" onchange="navigate(\'tiket\',{status:this.value})">' +
        ['all','open','pending','waiting_user','resolved','closed'].map(x => '<option value="' + x + '"' + (q.status === x ? ' selected' : '') + '>' + (x === 'all' ? 'Semua Status' : x) + '</option>').join('') +
      '</select>' +
    '</div><div class="table-scroll"><table class="tbl"><thead><tr>' +
      '<th>Kode</th><th>User</th><th>Subjek</th><th>Prioritas</th><th>Status</th><th>Dibuat</th>' +
    '</tr></thead><tbody>' +
    (d.data.length === 0 ? '<tr><td colspan="6">' + emptyState('Belum ada tiket') + '</td></tr>' :
      d.data.map(t => {
        const prio = { low: 'gray', normal: 'info', high: 'warning', urgent: 'danger' }[t.priority] || 'gray';
        const st = { open: 'info', pending: 'warning', waiting_user: 'warning', resolved: 'success', closed: 'gray' }[t.status] || 'gray';
        return '<tr>' +
          '<td class="td-mono">' + esc(t.code) + '</td>' +
          '<td>' + esc(t.user_name || '-') + '</td>' +
          '<td class="td-strong">' + esc(t.subject) + '</td>' +
          '<td><span class="badge badge-' + prio + '">' + t.priority + '</span></td>' +
          '<td><span class="badge badge-' + st + '">' + t.status + '</span></td>' +
          '<td class="td-muted">' + fmtDate(t.created_at) + '</td>' +
        '</tr>';
      }).join('')) +
    '</tbody></table></div>' + paginationBar(d, 'tiket') + '</div>';
}

// ============================================
// PAGE: LAPORAN
// ============================================
async function renderLaporan(el) {
  const d = await API.get('/api/reports/delivery');
  const maxVal = Math.max(...d.daily.map(x => x.total), 1);
  el.innerHTML =
    pageHead('Laporan Pengiriman', 'Analitik performa pengiriman pesan.', 'Analitik', 'Laporan') +
    '<div class="card mb-3"><div class="card-head"><div><div class="card-title">Pengiriman Harian</div><div class="card-sub">14 hari terakhir</div></div></div>' +
    '<div class="card-body"><div class="chart-box">' +
      d.daily.map(x => '<div class="chart-bar" style="height:' + Math.round((x.total / maxVal) * 100) + '%" data-label="' + String(x.d).slice(5) + '"></div>').join('') +
    '</div></div></div>' +
    '<div class="grid-2">' +
      '<div class="card"><div class="card-head"><div class="card-title">Alasan Gagal</div></div>' +
      '<div class="card-body">' +
        d.failureReasons.map(f => '<div style="margin-bottom:12px;">' +
          '<div class="flex-between" style="font-size:12.5px;margin-bottom:4px;">' +
            '<span>' + esc(f.reason) + '</span><b>' + f.count + '</b></div>' +
          '<div class="progress"><div class="progress-fill danger" style="width:' + Math.min(100, f.count / 4.2) + '%"></div></div>' +
        '</div>').join('') +
      '</div></div>' +
      '<div class="card"><div class="card-head"><div class="card-title">Per Kampanye</div></div>' +
      '<div class="card-body" style="padding:0;"><table class="tbl"><thead><tr><th>Kampanye</th><th>Sent</th><th>Failed</th><th>Rate</th></tr></thead><tbody>' +
        d.campaignStats.map(c => {
          const rate = c.total_recipients ? Math.round((c.sent / c.total_recipients) * 100) : 0;
          const tone = rate >= 80 ? 'success' : rate >= 50 ? 'warning' : 'danger';
          return '<tr><td class="td-strong">' + esc(c.name) + '</td><td>' + c.sent + '</td><td style="color:var(--danger)">' + c.failed + '</td>' +
            '<td><span class="badge badge-' + tone + '">' + rate + '%</span></td></tr>';
        }).join('') +
      '</tbody></table></div></div>' +
    '</div>';
}

// ============================================
// PAGE: KEUANGAN
// ============================================
async function renderKeuangan(el) {
  const d = await API.get('/api/finance/overview');
  el.innerHTML =
    pageHead('Keuangan', 'Ringkasan keuangan dan arus kas.', 'Keuangan', 'Keuangan') +
    '<div class="stats-grid mb-3">' +
      statCard('Gross Revenue', rp(d.revenue), 'fa-arrow-trend-up', 'success') +
      statCard('Gross Margin', rp(d.grossMargin), 'fa-chart-line', 'info') +
      statCard('Withdrawal', rp(d.withdrawal), 'fa-money-bill-transfer', 'warning') +
      statCard('Pending WD', rp(d.pendingWithdrawal), 'fa-clock', 'warning') +
      statCard('Referral', rp(d.referral), 'fa-gift') +
      statCard('Total Cost', rp(d.cost), 'fa-arrow-trend-down', 'danger') +
    '</div>' +
    '<div class="card"><div class="card-head"><div><div class="card-title">Transaksi Terbaru</div></div></div>' +
    '<div class="table-scroll"><table class="tbl"><thead><tr>' +
      '<th>Tanggal</th><th>User</th><th>Tipe</th><th>Nominal</th><th>Status</th><th>Referensi</th>' +
    '</tr></thead><tbody>' +
    d.transactions.slice(0, 50).map(t => {
      const tone = t.type === 'credit' || t.type === 'referral' ? 'success' : t.type === 'debit' || t.type === 'withdrawal' ? 'danger' : 'gray';
      return '<tr><td class="td-muted">' + fmtDate(t.created_at) + '</td>' +
        '<td>' + esc(t.user_name || '-') + '</td>' +
        '<td><span class="badge badge-' + tone + '">' + t.type + '</span></td>' +
        '<td class="td-strong">' + rp(t.amount) + '</td>' +
        '<td><span class="badge badge-' + (t.status === 'completed' ? 'success' : 'gray') + '">' + t.status + '</span></td>' +
        '<td class="td-mono text-xs">' + esc(t.reference || '-') + '</td></tr>';
    }).join('') +
    '</tbody></table></div></div>';
}

// ============================================
// PAGE: AUDIT
// ============================================
async function renderAudit(el) {
  const q = { page: state.pageParams.page || 1, search: state.pageParams.search || '' };
  const d = await API.get('/api/audit?' + new URLSearchParams(q));
  el.innerHTML =
    pageHead('Log Audit', 'Rekaman semua aktivitas sensitif (immutable).', 'Sistem', 'Audit') +
    '<div class="table-wrap"><div class="table-toolbar">' +
      '<div class="toolbar-search"><i class="fas fa-magnifying-glass"></i>' +
      '<input type="text" id="auSearch" placeholder="Cari actor, action, target..." value="' + esc(q.search) + '"></div>' +
      '<button class="btn btn-secondary btn-sm" onclick="applyAuFilter()"><i class="fas fa-filter"></i> Filter</button>' +
    '</div><div class="table-scroll"><table class="tbl"><thead><tr>' +
      '<th>Waktu</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th><th>Status</th>' +
    '</tr></thead><tbody>' +
    (d.data.length === 0 ? '<tr><td colspan="7">' + emptyState('Belum ada log') + '</td></tr>' :
      d.data.map(a => '<tr>' +
        '<td class="td-muted">' + fmtDate(a.created_at) + '</td>' +
        '<td class="td-strong">' + esc(a.actor_email || '-') + '</td>' +
        '<td><span class="badge badge-gray">' + esc(a.action) + '</span></td>' +
        '<td class="td-mono text-xs">' + esc(a.target || '-') + '</td>' +
        '<td class="td-muted text-xs" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(a.detail || '-') + '</td>' +
        '<td class="td-mono text-xs">' + esc(a.ip || '-') + '</td>' +
        '<td><span class="badge badge-' + (a.status === 'success' ? 'success' : 'danger') + '">' + a.status + '</span></td>' +
      '</tr>').join('')) +
    '</tbody></table></div>' + paginationBar(d, 'audit') + '</div>';
  document.getElementById('auSearch').onkeydown = (e) => { if (e.key === 'Enter') applyAuFilter(); };
}
function applyAuFilter() { navigate('audit', { search: document.getElementById('auSearch').value.trim(), page: 1 }); }

// ============================================
// PAGE: PENGATURAN
// ============================================
async function renderPengaturan(el) {
  const s = await API.get('/api/settings');
  const tabs = ['branding','reward','notifikasi','kepatuhan','perangkat','mode'];
  const current = state.pageParams.tab || 'branding';

  el.innerHTML =
    pageHead('Pengaturan Platform', 'Konfigurasi branding, reward, kepatuhan, dan perilaku platform.', 'Sistem', 'Pengaturan') +
    '<div class="tabs">' +
      tabs.map(t => '<button class="tab' + (current === t ? ' active' : '') + '" onclick="navigate(\'pengaturan\',{tab:\'' + t + '\'})">' + t.charAt(0).toUpperCase() + t.slice(1) + '</button>').join('') +
    '</div>' +
    '<div class="card"><div class="card-body">' + renderSettingTab(current, s) + '</div></div>';

  document.querySelectorAll('#pageContent .card-body input, #pageContent .card-body select, #pageContent .card-body textarea').forEach(inp => {
    inp.addEventListener('change', () => { if (inp.dataset.key) saveSetting(inp.dataset.key, inp.value); });
  });
  document.querySelectorAll('#pageContent .switch input').forEach(inp => {
    inp.addEventListener('change', () => { if (inp.dataset.key) saveSetting(inp.dataset.key, inp.checked ? '1' : '0'); });
  });
}

function renderSettingTab(tab, s) {
  if (tab === 'branding') {
    return settingField('branding_app_name', 'Nama Aplikasi', s.branding_app_name) +
      settingField('branding_tagline', 'Tagline', s.branding_tagline);
  }
  if (tab === 'reward') {
    return settingField('reward_per_message', 'Reward per Pesan Terkirim (Rp)', s.reward_per_message, 'number') +
      settingField('min_withdrawal', 'Minimum Withdrawal (Rp)', s.min_withdrawal, 'number') +
      settingField('referral_reward', 'Referral Reward (Rp)', s.referral_reward, 'number') +
      settingField('commission_pct', 'Komisi (%)', s.commission_pct, 'number');
  }
  if (tab === 'notifikasi') {
    return settingSwitch('notif_email', 'Notifikasi Email', s.notif_email) +
      settingSwitch('notif_telegram', 'Notifikasi Telegram', s.notif_telegram) +
      settingSwitch('notif_inapp', 'Notifikasi In-App', s.notif_inapp);
  }
  if (tab === 'kepatuhan') {
    return settingField('compliance_rate_limit', 'Rate Limit (pesan/menit)', s.compliance_rate_limit, 'number') +
      settingField('compliance_daily_limit', 'Batas Harian (pesan/hari)', s.compliance_daily_limit, 'number');
  }
  if (tab === 'perangkat') {
    return settingField('device_max_per_user', 'Maximum Device per User', s.device_max_per_user, 'number') +
      settingField('device_heartbeat_sec', 'Heartbeat (detik)', s.device_heartbeat_sec, 'number') +
      settingField('device_qr_expiry_sec', 'QR Expiration (detik)', s.device_qr_expiry_sec, 'number');
  }
  if (tab === 'mode') {
    return '<div class="form-row"><label>Mode Platform</label>' +
      '<select class="input" data-key="platform_mode">' +
        ['normal','safe','maintenance'].map(m => '<option value="' + m + '"' + (s.platform_mode === m ? ' selected' : '') + '>' + m + '</option>').join('') +
      '</select></div>';
  }
  return '';
}
function settingField(key, label, value, type = 'text') {
  return '<div class="form-row"><label>' + label + '</label>' +
    '<input type="' + type + '" class="input" data-key="' + key + '" value="' + esc(value || '') + '"></div>';
}
function settingSwitch(key, label, value) {
  const checked = value === '1' ? ' checked' : '';
  return '<div class="form-row"><label class="switch">' +
    '<input type="checkbox" data-key="' + key + '"' + checked + '>' +
    '<span class="switch-track"></span>' +
    '<span class="switch-label">' + label + '</span></label></div>';
}
async function saveSetting(key, value) {
  try {
    await API.put('/api/settings', { key, value });
    toast('success', 'Tersimpan', key + ' diupdate');
  } catch (e) { toast('error', 'Gagal', e.message); }
}

// ============================================
// PAGE: TIM
// ============================================
async function renderTim(el) {
  const d = await API.get('/api/team');
  el.innerHTML =
    pageHead('Tim & Akses', 'Kelola admin, role, dan permission.', 'Sistem', 'Tim') +
    '<div class="card mb-3"><div class="card-head"><div class="card-title">Daftar Admin</div>' +
    '<button class="btn btn-primary btn-sm" onclick="addAdmin()"><i class="fas fa-plus"></i> Tambah Admin</button></div>' +
    '<div class="table-scroll"><table class="tbl"><thead><tr>' +
      '<th>Nama</th><th>Email</th><th>Role</th><th>Status</th><th>Last Login</th><th></th>' +
    '</tr></thead><tbody>' +
    d.admins.map(a => '<tr>' +
      '<td class="td-strong">' + esc(a.name) + '</td>' +
      '<td>' + esc(a.email) + '</td>' +
      '<td><span class="badge badge-info">' + a.role + '</span></td>' +
      '<td><span class="badge badge-' + (a.status === 'active' ? 'success' : 'gray') + '">' + a.status + '</span></td>' +
      '<td class="td-muted">' + (a.last_login ? fmtAgo(a.last_login) : 'Belum pernah') + '</td>' +
      '<td style="text-align:right;">' +
        (a.role !== 'owner' ? '<select class="toolbar-select" onchange="changeRole(' + a.id + ', this.value)" style="font-size:12px;height:28px;">' +
          d.roles.map(r => '<option value="' + r.key + '"' + (r.key === a.role ? ' selected' : '') + '>' + r.name + '</option>').join('') +
        '</select>' : '<span class="text-muted text-xs">owner</span>') +
      '</td>' +
    '</tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><div><div class="card-title">Permission Matrix</div><div class="card-sub">Role vs Permission</div></div></div>' +
    '<div class="table-scroll"><table class="perm-matrix"><thead><tr>' +
      '<th>Permission</th>' + d.roles.map(r => '<th>' + r.name + '</th>').join('') +
    '</tr></thead><tbody>' +
    d.permissions.map(p => '<tr><td>' + p.label + '</td>' +
      d.roles.map(r => '<td>' + (r.permissions.includes(p.key)
        ? '<i class="fas fa-check perm-yes"></i>'
        : '<i class="fas fa-minus perm-no"></i>') + '</td>').join('') +
    '</tr>').join('') +
    '</tbody></table></div></div>';
}
function addAdmin() {
  openModal({
    title: 'Tambah Admin Baru',
    bodyHtml:
      '<div class="form-row"><label>Nama <span class="req">*</span></label><input class="input" id="naName" placeholder="Nama lengkap"></div>' +
      '<div class="form-row"><label>Email <span class="req">*</span></label><input type="email" class="input" id="naEmail" placeholder="admin@bastardblast.local"></div>' +
      '<div class="form-row"><label>Password <span class="req">*</span></label><input type="password" class="input" id="naPass" placeholder="Min 8 karakter"></div>' +
      '<div class="form-row"><label>Role <span class="req">*</span></label><select class="input" id="naRole">' +
        ['admin','finance','support','operator','viewer'].map(r => '<option value="' + r + '">' + r + '</option>').join('') +
      '</select></div>',
    footHtml: '<button class="btn btn-secondary" onclick="closeModal()">Batal</button>' +
      '<button class="btn btn-primary" id="naBtn">Buat Admin</button>'
  });
  document.getElementById('naBtn').onclick = async () => {
    try {
      await API.post('/api/team', {
        name: document.getElementById('naName').value.trim(),
        email: document.getElementById('naEmail').value.trim(),
        password: document.getElementById('naPass').value,
        role: document.getElementById('naRole').value
      });
      toast('success', 'Admin dibuat');
      closeModal(); renderPage();
    } catch (e) { toast('error', 'Gagal', e.message); }
  };
}
function changeRole(id, role) {
  confirmModal({
    title: 'Ubah Role', message: 'Ubah role admin #' + id + ' menjadi ' + role + '?',
    onConfirm: async () => {
      await API.put('/api/team/' + id + '/role', { role });
      toast('success', 'Role diubah');
      renderPage();
    }
  });
}

// ============================================
// UTILITY COMPONENTS
// ============================================
function pageHead(title, sub, section, current) {
  return '<div class="page-head">' +
    '<div class="breadcrumb"><span>' + (section || 'BastardBlast') + '</span><i class="fas fa-chevron-right"></i><span class="current">' + current + '</span></div>' +
    '<h1 class="page-title">' + title + '</h1>' +
    '<p class="page-sub">' + sub + '</p>' +
  '</div>';
}
function paginationBar(d, page) {
  const total = d.totalPages || 1;
  const current = d.page || 1;
  let btns = '';
  for (let i = Math.max(1, current - 2); i <= Math.min(total, current + 2); i++) {
    btns += '<button class="' + (i === current ? 'active' : '') + '" onclick="navigate(\'' + page + '\',Object.assign({},state.pageParams,{page:' + i + '}))">' + i + '</button>';
  }
  return '<div class="pagination">' +
    '<div>Total <b>' + (d.total || 0).toLocaleString('id-ID') + '</b> data</div>' +
    '<div class="pagination-btns">' +
      '<button ' + (current <= 1 ? 'disabled' : '') + ' onclick="navigate(\'' + page + '\',Object.assign({},state.pageParams,{page:' + (current - 1) + '}))"><i class="fas fa-chevron-left"></i></button>' +
      btns +
      '<button ' + (current >= total ? 'disabled' : '') + ' onclick="navigate(\'' + page + '\',Object.assign({},state.pageParams,{page:' + (current + 1) + '}))"><i class="fas fa-chevron-right"></i></button>' +
    '</div>' +
  '</div>';
}

// ============================================
// NOTIFICATIONS
// ============================================
async function showNotifications() {
  try {
    const d = await API.get('/api/notifications');
    openModal({
      title: 'Notifikasi',
      sub: d.unread + ' belum dibaca',
      bodyHtml: d.data.length === 0
        ? emptyState('Belum ada notifikasi')
        : d.data.map(n => '<div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;gap:10px;">' +
            '<div class="stat-icon ' + (n.read ? '' : 'info') + '"><i class="fas fa-bell"></i></div>' +
            '<div class="grow"><div class="td-strong">' + esc(n.title) + '</div>' +
            '<div class="text-muted text-sm">' + esc(n.body || '') + '</div>' +
            '<div class="text-muted text-xs mt-1">' + fmtAgo(n.created_at) + '</div></div>' +
          '</div>').join(''),
      footHtml: '<button class="btn btn-secondary" onclick="closeModal()">Tutup</button>'
    });
  } catch (e) { toast('error', 'Gagal', e.message); }
}

// ============================================
// BADGES / GLOBAL
// ============================================
async function refreshBadges() {
  try {
    const d = await API.get('/api/dashboard');
    const counts = {
      wdPending: d.cards.withdrawals.c || 0,
      riskHigh: d.cards.risk.high || 0,
      inboxUnread: d.cards.inbox.unread || 0
    };
    renderSidebar(counts);
    const notif = await API.get('/api/notifications');
    document.getElementById('notifDot').style.display = notif.unread > 0 ? '' : 'none';
  } catch (e) {}
}

function refreshPage() { renderPage(); toast('info', 'Data diperbarui'); }
function toggleThemeInfo() {
  openModal({
    title: 'BastardBlast Admin',
    bodyHtml: '<p class="text-sm" style="color:var(--text-2);line-height:1.6;">Panel administrasi untuk platform pengiriman pesan WhatsApp. Semua aksi sensitif dicatat di audit log.</p>',
    footHtml: '<button class="btn btn-primary" onclick="closeModal()">Tutup</button>'
  });
}

async function logout() {
  confirmModal({
    title: 'Logout',
    message: 'Yakin ingin keluar dari panel admin?',
    confirmText: 'Logout',
    onConfirm: async () => {
      await API.post('/api/auth/logout', {});
      window.location.href = '/';
    }
  });
}

// ============================================
// INIT
// ============================================
async function init() {
  try {
    const me = await API.get('/api/auth/me');
    state.admin = me.admin;
    state.permissions = me.permissions;
    document.getElementById('sbName').textContent = me.admin.name;
    document.getElementById('sbRole').textContent = me.admin.role;
    document.getElementById('sbAvatar').textContent = (me.admin.name || 'A')[0].toUpperCase();
    renderSidebar();
    await navigate('ringkasan');
    await refreshBadges();
    setInterval(refreshBadges, 30000);

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        document.getElementById('globalSearch').focus();
      }
      if (e.key === 'Escape') closeModal();
    });
  } catch (e) {
    console.error(e);
    if (e.message !== 'Unauthorized') toast('error', 'Gagal memuat', e.message);
  }
}

init();
