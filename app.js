/* Debt Book - a simple shop debt record that replaces the paper book.
 * All data is kept on the phone (localStorage). Use "Back up" regularly
 * to save a copy (WhatsApp to yourself, Google Drive, email...).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'debtbook.v1';
  var BACKUP_REMIND_DAYS = 3;

  // ---------- Data ----------
  function emptyData() {
    return {
      version: 1,
      settings: { shopName: '', currency: '$', ownerPhone: '' },
      customers: [],
      entries: [],
      lastBackup: null
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyData();
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.error(e);
      return emptyData();
    }
  }

  function normalize(d) {
    var base = emptyData();
    if (!d || typeof d !== 'object') return base;
    base.settings = Object.assign(base.settings, d.settings || {});
    base.customers = Array.isArray(d.customers) ? d.customers : [];
    base.entries = Array.isArray(d.entries) ? d.entries : [];
    base.lastBackup = d.lastBackup || null;
    return base;
  }

  var data = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      alert('Could not save! Phone storage may be full. Please make a backup now.');
    }
    updateBackupBanner();
  }

  // Ask the browser not to clear our data when storage is low.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Amounts are stored as whole cents to avoid rounding errors.
  function toCents(str) {
    var n = parseFloat(String(str).replace(/,/g, ''));
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }

  function money(cents) {
    var neg = cents < 0;
    var v = Math.abs(cents) / 100;
    var s = v.toLocaleString(undefined, {
      minimumFractionDigits: v % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
    return (neg ? '-' : '') + (data.settings.currency || '') + s;
  }

  function balanceOf(customerId) {
    var b = 0;
    data.entries.forEach(function (e) {
      if (e.customerId !== customerId) return;
      b += e.type === 'debt' ? e.amount : -e.amount;
    });
    return b;
  }

  function entriesOf(customerId) {
    return data.entries
      .filter(function (e) { return e.customerId === customerId; })
      .sort(function (a, b) { return (b.date + b.createdAt).localeCompare(a.date + a.createdAt); });
  }

  function lastActivity(customerId) {
    var list = entriesOf(customerId);
    return list.length ? list[0].date : null;
  }

  function findCustomer(id) {
    return data.customers.find(function (c) { return c.id === id; });
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function niceDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ---------- Helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || '?';
  }

  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function cleanPhone(p) {
    return String(p || '').replace(/[^\d+]/g, '');
  }

  // ---------- Dialog ----------
  var dialog = document.getElementById('dialog');
  var dialogForm = document.getElementById('dialogForm');

  function openDialog(html, onSubmit) {
    dialogForm.innerHTML = html;
    dialogForm.onsubmit = function (ev) {
      var btn = ev.submitter;
      if (btn && btn.value === 'cancel') return; // closes
      ev.preventDefault();
      var ok = onSubmit(new FormData(dialogForm));
      if (ok !== false) dialog.close();
    };
    dialog.showModal();
    var first = dialogForm.querySelector('input, select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 50);
  }

  function customerForm(c) {
    c = c || {};
    return '<h2>' + (c.id ? 'Edit customer' : 'New customer') + '</h2>' +
      '<label for="f-name">Name</label>' +
      '<input id="f-name" name="name" required autocomplete="off" value="' + esc(c.name) + '">' +
      '<label for="f-phone">Phone (optional)</label>' +
      '<input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="off" value="' + esc(c.phone) + '">' +
      '<label for="f-place">Address / note (optional)</label>' +
      '<input id="f-place" name="place" autocomplete="off" value="' + esc(c.place) + '">' +
      '<div class="buttons"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button>' +
      '<button class="btn" value="ok">Save</button></div>';
  }

  function addCustomer() {
    openDialog(customerForm(), function (fd) {
      var name = String(fd.get('name')).trim();
      if (!name) return false;
      var c = { id: uid(), name: name, phone: String(fd.get('phone')).trim(), place: String(fd.get('place')).trim(), createdAt: new Date().toISOString() };
      data.customers.push(c);
      save();
      location.hash = '#/c/' + c.id;
      toast('Customer added');
    });
  }

  function editCustomer(c) {
    openDialog(customerForm(c), function (fd) {
      var name = String(fd.get('name')).trim();
      if (!name) return false;
      c.name = name;
      c.phone = String(fd.get('phone')).trim();
      c.place = String(fd.get('place')).trim();
      save();
      render();
      toast('Saved');
    });
  }

  function addEntry(c, type) {
    var isDebt = type === 'debt';
    openDialog(
      '<h2>' + (isDebt ? 'Took on debt' : 'Paid back') + '</h2>' +
      '<p style="margin:0;color:var(--muted)">' + esc(c.name) + '</p>' +
      '<label for="f-amount">Amount (' + esc(data.settings.currency) + ')</label>' +
      '<input id="f-amount" name="amount" required inputmode="decimal" autocomplete="off" placeholder="0">' +
      '<label for="f-note">' + (isDebt ? 'What did they take? (optional)' : 'Note (optional)') + '</label>' +
      '<input id="f-note" name="note" autocomplete="off" placeholder="' + (isDebt ? 'e.g. rice 5kg, sugar, oil' : 'e.g. cash, mobile money') + '">' +
      '<label for="f-date">Date</label>' +
      '<input id="f-date" name="date" type="date" required value="' + today() + '">' +
      '<div class="buttons"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button>' +
      '<button class="btn ' + (isDebt ? 'owe' : 'paid') + '" value="ok">Save</button></div>',
      function (fd) {
        var cents = toCents(fd.get('amount'));
        if (!cents) { alert('Please enter an amount bigger than 0.'); return false; }
        data.entries.push({
          id: uid(), customerId: c.id, type: type, amount: cents,
          note: String(fd.get('note')).trim(), date: String(fd.get('date')) || today(),
          createdAt: new Date().toISOString()
        });
        save();
        render();
        toast(isDebt ? 'Debt recorded' : 'Payment recorded');
      }
    );
  }

  // ---------- Views ----------
  var app = document.getElementById('app');
  var titleEl = document.getElementById('title');
  var backBtn = document.getElementById('backBtn');
  var filter = 'owing';
  var query = '';

  function render() {
    var hash = location.hash || '#/';
    var m = hash.match(/^#\/c\/(.+)$/);
    if (m) return renderCustomer(decodeURIComponent(m[1]));
    if (hash === '#/settings') return renderSettings();
    renderHome();
  }

  function renderHome() {
    titleEl.textContent = data.settings.shopName || 'Debt Book';
    backBtn.hidden = true;

    var rows = data.customers.map(function (c) {
      return { c: c, bal: balanceOf(c.id), last: lastActivity(c.id) };
    });
    var total = 0, owingCount = 0;
    rows.forEach(function (r) { if (r.bal > 0) { total += r.bal; owingCount++; } });

    var q = query.toLowerCase();
    var shown = rows.filter(function (r) {
      if (filter === 'owing' && r.bal <= 0) return false;
      if (!q) return true;
      return r.c.name.toLowerCase().indexOf(q) >= 0 || (r.c.phone || '').indexOf(q) >= 0;
    });
    shown.sort(function (a, b) {
      if (filter === 'owing') return b.bal - a.bal;
      return a.c.name.localeCompare(b.c.name);
    });

    var html =
      '<section class="summary">' +
        '<div class="label">Total customers owe you</div>' +
        '<div class="big">' + money(total) + '</div>' +
        '<div class="sub">' + owingCount + ' of ' + data.customers.length + ' customers owe money</div>' +
      '</section>' +
      '<input class="search" id="search" type="search" placeholder="Search name or phone…" value="' + esc(query) + '">' +
      '<div class="tabs">' +
        '<button class="tab" data-filter="owing" aria-pressed="' + (filter === 'owing') + '">Owing</button>' +
        '<button class="tab" data-filter="all" aria-pressed="' + (filter === 'all') + '">All customers</button>' +
      '</div>';

    if (!data.customers.length) {
      html += '<div class="empty">No customers yet.<br>Tap <b>+ Customer</b> to add the first one from your book.</div>';
    } else if (!shown.length) {
      html += '<div class="empty">' + (q ? 'No customer matches “' + esc(query) + '”.' : 'Nobody owes money right now. 🎉') + '</div>';
    } else {
      html += '<ul class="list">' + shown.map(function (r) {
        return '<li><button class="row" data-id="' + esc(r.c.id) + '">' +
          '<span class="avatar">' + esc(initials(r.c.name)) + '</span>' +
          '<span class="main"><div class="name">' + esc(r.c.name) + '</div>' +
          '<div class="meta">' + (r.last ? 'Last: ' + niceDate(r.last) : 'No records yet') + '</div></span>' +
          '<span class="amount ' + (r.bal > 0 ? 'owe' : 'clear') + '">' + (r.bal > 0 ? money(r.bal) : 'Clear') + '</span>' +
          '</button></li>';
      }).join('') + '</ul>';
    }

    html += '<button class="fab" id="addCustomerBtn">+ Customer</button>';
    app.innerHTML = html;

    var search = document.getElementById('search');
    search.addEventListener('input', function () {
      query = search.value;
      var pos = search.selectionStart;
      renderHome();
      var s2 = document.getElementById('search');
      s2.focus();
      try { s2.setSelectionRange(pos, pos); } catch (e) {}
    });
    app.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.dataset.filter; renderHome(); });
    });
    app.querySelectorAll('.row').forEach(function (b) {
      b.addEventListener('click', function () { location.hash = '#/c/' + encodeURIComponent(b.dataset.id); });
    });
    document.getElementById('addCustomerBtn').addEventListener('click', addCustomer);
  }

  function reminderText(c, bal) {
    var shop = data.settings.shopName ? ' from ' + data.settings.shopName : '';
    return 'Hello ' + c.name + ', this is a friendly reminder' + shop +
      '. Your balance is ' + money(bal) + '. Thank you!';
  }

  function renderCustomer(id) {
    var c = findCustomer(id);
    if (!c) { location.hash = '#/'; return; }
    titleEl.textContent = c.name;
    backBtn.hidden = false;

    var bal = balanceOf(c.id);
    var list = entriesOf(c.id);
    var phone = cleanPhone(c.phone);
    var waPhone = phone.replace(/^\+/, '');

    var html =
      '<section class="summary">' +
        '<div class="label">' + (bal > 0 ? 'Owes you' : bal < 0 ? 'You owe them (overpaid)' : 'Balance') + '</div>' +
        '<div class="big" style="color:' + (bal > 0 ? 'var(--owe)' : 'var(--paid)') + '">' + (bal === 0 ? 'Clear' : money(Math.abs(bal))) + '</div>' +
        '<div class="sub">' + esc([c.phone, c.place].filter(Boolean).join(' · ')) + '</div>' +
      '</section>' +
      '<div class="actions">' +
        '<button class="btn owe" id="debtBtn">+ Took debt</button>' +
        '<button class="btn paid" id="payBtn">− Paid back</button>' +
      '</div>' +
      '<div class="links">' +
        (phone ? '<a class="btn ghost small" href="tel:' + esc(phone) + '">📞 Call</a>' : '') +
        (phone && bal > 0 ? '<a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/' + esc(waPhone) + '?text=' + encodeURIComponent(reminderText(c, bal)) + '">💬 WhatsApp reminder</a>' : '') +
        (phone && bal > 0 ? '<a class="btn ghost small" href="sms:' + esc(phone) + '?body=' + encodeURIComponent(reminderText(c, bal)) + '">✉️ SMS reminder</a>' : '') +
        '<button class="btn ghost small" id="editBtn">✏️ Edit</button>' +
      '</div>' +
      '<div class="section-title">History</div>';

    if (!list.length) {
      html += '<div class="empty">No records yet for this customer.</div>';
    } else {
      html += '<ul class="list">' + list.map(function (e) {
        return '<li class="entry ' + e.type + '">' +
          '<span class="tag">' + (e.type === 'debt' ? 'DEBT' : 'PAID') + '</span>' +
          '<div class="main"><div class="amount">' + money(e.amount) + '</div>' +
          (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
          '<div class="meta">' + niceDate(e.date) + '</div></div>' +
          '<button class="del" data-id="' + esc(e.id) + '" aria-label="Delete record">🗑</button>' +
          '</li>';
      }).join('') + '</ul>';
    }

    html += '<div style="margin-top:24px"><button class="btn danger block" id="delCustomerBtn">Delete this customer</button></div>';
    app.innerHTML = html;

    document.getElementById('debtBtn').addEventListener('click', function () { addEntry(c, 'debt'); });
    document.getElementById('payBtn').addEventListener('click', function () { addEntry(c, 'payment'); });
    document.getElementById('editBtn').addEventListener('click', function () { editCustomer(c); });
    app.querySelectorAll('.del').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = data.entries.find(function (x) { return x.id === b.dataset.id; });
        if (!e) return;
        if (!confirm('Delete this record of ' + money(e.amount) + '?')) return;
        data.entries = data.entries.filter(function (x) { return x.id !== e.id; });
        save(); render(); toast('Record deleted');
      });
    });
    document.getElementById('delCustomerBtn').addEventListener('click', function () {
      var msg = 'Delete ' + c.name + ' and all their records?' + (bal > 0 ? '\n\nThey still owe ' + money(bal) + '!' : '');
      if (!confirm(msg)) return;
      data.customers = data.customers.filter(function (x) { return x.id !== c.id; });
      data.entries = data.entries.filter(function (x) { return x.customerId !== c.id; });
      save();
      location.hash = '#/';
      toast('Customer deleted');
    });
  }

  function renderSettings() {
    titleEl.textContent = 'Settings & Backup';
    backBtn.hidden = false;
    var s = data.settings;
    var last = data.lastBackup ? new Date(data.lastBackup).toLocaleString() : 'Never';

    app.innerHTML =
      '<section class="card">' +
        '<div class="section-title" style="margin-top:0">Backup — keep your records safe</div>' +
        '<p>Your records are saved on this phone. If the phone is lost or broken, you need a backup. ' +
        'Tap <b>Back up now</b> and send the file to yourself on WhatsApp, Google Drive or email.</p>' +
        '<p>Last backup: <b>' + esc(last) + '</b></p>' +
        '<button class="btn block" id="backupBtn">⬆️ Back up now</button>' +
        '<button class="btn ghost block" id="restoreBtn">⬇️ Restore from a backup file</button>' +
        '<input type="file" id="restoreFile" accept=".json,application/json" hidden>' +
      '</section>' +
      '<form class="card" id="settingsForm">' +
        '<div class="section-title" style="margin-top:0">Shop</div>' +
        '<label for="s-name">Shop name</label>' +
        '<input id="s-name" name="shopName" value="' + esc(s.shopName) + '" placeholder="e.g. Hooyo Shop">' +
        '<label for="s-cur">Money symbol</label>' +
        '<input id="s-cur" name="currency" value="' + esc(s.currency) + '" placeholder="$, KSh, Sh…">' +
        '<div style="margin-top:14px"><button class="btn block">Save settings</button></div>' +
      '</form>' +
      '<section class="card">' +
        '<div class="section-title" style="margin-top:0">Reports</div>' +
        '<p>Download a spreadsheet (CSV) of everyone who owes money. Opens in Excel or Google Sheets.</p>' +
        '<button class="btn ghost block" id="csvBtn">📄 Download list of debts</button>' +
      '</section>';

    document.getElementById('settingsForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(ev.target);
      s.shopName = String(fd.get('shopName')).trim();
      s.currency = String(fd.get('currency')).trim();
      save(); toast('Settings saved'); render();
    });
    document.getElementById('backupBtn').addEventListener('click', backup);
    var fileInput = document.getElementById('restoreFile');
    document.getElementById('restoreBtn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) restore(fileInput.files[0]);
      fileInput.value = '';
    });
    document.getElementById('csvBtn').addEventListener('click', exportCsv);
  }

  // ---------- Backup / restore ----------
  function fileStamp() {
    var d = new Date();
    return today() + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function shareOrDownload(blob, filename, title) {
    var file;
    try { file = new File([blob], filename, { type: blob.type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: title }).then(function () { return true; })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return false;
          download(blob, filename); return true;
        });
    }
    download(blob, filename);
    return Promise.resolve(true);
  }

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function backup() {
    var copy = Object.assign({}, data, { exportedAt: new Date().toISOString() });
    var blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
    shareOrDownload(blob, 'debt-book-backup_' + fileStamp() + '.json', 'Debt Book backup').then(function (done) {
      if (!done) return;
      data.lastBackup = new Date().toISOString();
      save();
      toast('Backup made ✔');
      render();
    });
  }

  function restore(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = normalize(JSON.parse(reader.result)); } catch (e) { incoming = null; }
      if (!incoming || (!incoming.customers.length && !incoming.entries.length)) {
        alert('This file is not a Debt Book backup, or it is empty.');
        return;
      }
      var msg = 'Restore this backup?\n\n' + incoming.customers.length + ' customers, ' + incoming.entries.length +
        ' records.\n\nThis REPLACES what is on this phone now.';
      if (!confirm(msg)) return;
      data = incoming;
      save();
      toast('Backup restored ✔');
      location.hash = '#/';
      render();
    };
    reader.readAsText(file);
  }

  function exportCsv() {
    function cell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [['Customer', 'Phone', 'Balance owed', 'Last activity'].join(',')];
    data.customers
      .map(function (c) { return { c: c, bal: balanceOf(c.id) }; })
      .filter(function (r) { return r.bal > 0; })
      .sort(function (a, b) { return b.bal - a.bal; })
      .forEach(function (r) {
        lines.push([cell(r.c.name), cell(r.c.phone), (r.bal / 100).toFixed(2), cell(lastActivity(r.c.id))].join(','));
      });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    shareOrDownload(blob, 'debts_' + today() + '.csv', 'Debt list');
  }

  // ---------- Backup reminder ----------
  var banner = document.getElementById('backupBanner');
  function updateBackupBanner() {
    if (!data.entries.length) { banner.hidden = true; document.body.classList.remove('has-banner'); return; }
    var days = data.lastBackup ? (Date.now() - new Date(data.lastBackup).getTime()) / 864e5 : Infinity;
    if (days < BACKUP_REMIND_DAYS) { banner.hidden = true; document.body.classList.remove('has-banner'); return; }
    document.getElementById('backupBannerText').textContent = data.lastBackup
      ? 'No backup for ' + Math.floor(days) + ' days.'
      : 'You have not made a backup yet.';
    banner.hidden = false;
    document.body.classList.add('has-banner');
  }
  document.getElementById('backupNowBtn').addEventListener('click', backup);

  // ---------- Wiring ----------
  backBtn.addEventListener('click', function () {
    if (history.length > 1) history.back(); else location.hash = '#/';
  });
  document.getElementById('settingsBtn').addEventListener('click', function () { location.hash = '#/settings'; });
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });

  // Keep tabs in sync if the app is open twice.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) { data = load(); render(); updateBackupBanner(); }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  render();
  updateBackupBanner();
})();
