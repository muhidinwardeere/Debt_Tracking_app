/* Deyn Book - a simple shop debt record that replaces the paper book.
 * Records are kept on the phone (localStorage). When the owner signs in
 * with Google, cloud.bundle.js (built from cloud/cloud.src.js) also keeps
 * them online in Firestore; this file talks to it through window.DeynCloud
 * and receives updates through window.DeynApp.
 * Text shown to the user lives in i18n.js.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'debtbook.v1';
  var BACKUP_REMIND_DAYS = 3;
  var I18N = window.I18N;

  // ---------- Data ----------
  // Somali by default (the app is made for Somali businesses); English if
  // the phone is set to English and the person has not chosen yet.
  function detectLang() {
    var nav = (navigator.language || '').slice(0, 2).toLowerCase();
    return nav === 'en' ? 'en' : 'so';
  }

  function emptyData() {
    return {
      version: 1,
      settings: { shopName: '', currency: 'KSh', ownerPhone: '', lang: '' },
      customers: [],
      entries: [],
      lastBackup: null,
      owner: null,   // uid of the signed-in account these records belong to
      dirty: false   // changed while not signed in, so must be uploaded
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
    base.owner = d.owner || null;
    base.dirty = !!d.dirty;
    return base;
  }

  var data = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      alert(t('saveFail'));
    }
    updateBackupBanner();
  }

  // ---------- Cloud ----------
  var account = null;       // { uid, email, name } when signed in
  var authKnown = false;    // false until the cloud code has said who is signed in
  var cloudAvailable = false;
  var signingIn = false;
  var signingOut = false;
  var cloudErrorShown = false;

  // The cloud API, only while signed in.
  function cloud() {
    return account && window.DeynCloud && window.DeynCloud.isSignedIn() ? window.DeynCloud : null;
  }

  // Call after every change the user makes. Without the cloud, remember
  // that this phone has changes to upload at the next sign-in.
  function changed(fn) {
    var c = cloud();
    if (c) fn(c); else data.dirty = true;
    save();
  }

  function normC(c) {
    return { id: c.id, name: c.name || '', phone: c.phone || '', place: c.place || '', createdAt: c.createdAt || '' };
  }
  function normE(e) {
    return { id: e.id, customerId: e.customerId, type: e.type === 'payment' ? 'payment' : 'debt', amount: +e.amount || 0,
      note: e.note || '', date: e.date || '', createdAt: e.createdAt || '' };
  }
  function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function sameList(a, b) {
    return JSON.stringify(a.slice().sort(byId)) === JSON.stringify(b.slice().sort(byId));
  }

  // Re-draw without throwing away what the person is typing.
  function safeRender() {
    var active = document.activeElement;
    if (active && active.closest && active.closest('#settingsForm')) return;
    if (dialog.open) { render(); return; }
    var searching = active && active.id === 'search';
    var pos = searching ? active.selectionStart : 0;
    render();
    if (searching) {
      var s2 = document.getElementById('search');
      if (s2) { s2.focus(); try { s2.setSelectionRange(pos, pos); } catch (e) {} }
    }
  }

  window.DeynApp = {
    cloudReady: function () {
      cloudAvailable = true;
      safeRender();
    },

    // Called once a user is signed in, before records are downloaded.
    // Returns this phone's records if they still need to go online.
    takeLocalForUpload: function (uid) {
      if (data.owner && data.owner !== uid) {
        // Records of a different account: never mix them in.
        var keepLang = data.settings.lang;
        data = emptyData();
        data.settings.lang = keepLang;
      }
      var upload = null;
      if (data.dirty && (data.customers.length || data.entries.length || data.settings.shopName)) {
        upload = { customers: data.customers.map(normC), entries: data.entries.map(normE), settings: data.settings };
      }
      data.owner = uid;
      data.dirty = false;
      save();
      return upload;
    },

    onAuth: function (user) {
      authKnown = true;
      if (user) {
        account = user;
        if (signingIn) toast(t('signedIn'));
      } else {
        if (signingOut) {
          // Signed out on purpose (only after everything was uploaded):
          // records are safe online, so remove them from this phone,
          // which may be shared or given away.
          var keepLang = data.settings.lang;
          data = emptyData();
          data.settings.lang = keepLang;
          save();
          toast(t('signedOut'));
        }
        // If the login simply expired, keep the records on the phone;
        // they belong to data.owner and are merged back at the next sign-in.
        account = null;
      }
      signingIn = false;
      signingOut = false;
      updateBackupBanner();
      safeRender();
    },

    applyRemote: function (part) {
      var changedAny = false;
      if (part.customers) {
        var cs = part.customers.map(normC);
        if (!sameList(cs, data.customers.map(normC))) { data.customers = cs; changedAny = true; }
      }
      if (part.entries) {
        var es = part.entries.map(normE);
        if (!sameList(es, data.entries.map(normE))) { data.entries = es; changedAny = true; }
      }
      if (part.settings) {
        ['shopName', 'currency'].forEach(function (k) {
          if (typeof part.settings[k] === 'string' && part.settings[k] !== data.settings[k]) {
            data.settings[k] = part.settings[k]; changedAny = true;
          }
        });
      }
      if (!changedAny) return;
      save();
      safeRender();
    },

    cloudError: function (e) {
      if (cloudErrorShown) return;
      cloudErrorShown = true;
      toast(t('cloudProblem') + (e && e.code ? ' (' + e.code + ')' : ''));
    },

    toastKey: function (key) { toast(t(key)); }
  };

  function signIn() {
    if (!window.DeynCloud) return;
    signingIn = true;
    window.DeynCloud.signIn().catch(function (e) {
      signingIn = false;
      console.error(e);
      alert(t('signInFailed') + (e && e.code ? '\n\n(' + e.code + ')' : ''));
    });
  }

  function signOut() {
    if (!cloud() || !confirm(t('confirmSignOut'))) return;
    signingOut = true;
    window.DeynCloud.signOut().then(function (ok) {
      if (!ok) { signingOut = false; alert(t('signOutOffline')); }
    }).catch(function (e) {
      signingOut = false;
      console.error(e);
      alert(t('signOutOffline'));
    });
  }

  function signInCardHtml() {
    return '<section class="card cloud-card">' +
      '<p>☁️ ' + esc(t('signInExplain')) + '</p>' +
      '<button class="btn block google-btn" data-signin>' + esc(t('signIn')) + '</button>' +
      '</section>';
  }

  function wireCloudButtons(root) {
    root.querySelectorAll('[data-signin]').forEach(function (b) { b.addEventListener('click', signIn); });
    root.querySelectorAll('[data-signout]').forEach(function (b) { b.addEventListener('click', signOut); });
  }

  // Ask the browser not to clear our data when storage is low.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  // ---------- Language ----------
  function lang() {
    var l = data.settings.lang;
    return I18N[l] ? l : detectLang();
  }

  function t(key, vars) {
    var s = (I18N[lang()] && I18N[lang()][key]) || I18N.en[key] || key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    }
    return s;
  }

  function applyStaticText() {
    document.documentElement.lang = lang();
    document.getElementById('backBtn').setAttribute('aria-label', t('back'));
    document.getElementById('settingsBtn').setAttribute('aria-label', t('settings'));
    document.getElementById('backupNowBtn').textContent = t('backupNow');
  }

  function setLang(code) {
    data.settings.lang = code;
    save();
    applyStaticText();
    render();
  }

  // ---------- Helpers ----------
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
    var s = v.toLocaleString('en-KE', {
      minimumFractionDigits: v % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
    var cur = data.settings.currency || '';
    // Put a space after word symbols like "KSh" (KSh 1,200) but not after "$".
    if (/[A-Za-z]$/.test(cur)) cur += ' ';
    return (neg ? '-' : '') + cur + s;
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

  // e.g. "27 Nov 2026". Month names come from i18n.js because phones
  // often have no Somali/Swahili date names built in.
  function niceDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    var months = t('months').split(',');
    return (+p[2]) + ' ' + (months[+p[1] - 1] || p[1]) + ' ' + p[0];
  }

  function niceDateTime(isoTime) {
    var d = new Date(isoTime);
    var day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return niceDate(day) + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

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
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function cleanPhone(p) {
    return String(p || '').replace(/[^\d+]/g, '');
  }

  // Phone number in international form for WhatsApp (Kenya: 07.. -> 2547..).
  function waNumber(p) {
    var n = cleanPhone(p).replace(/^\+/, '');
    if (/^0[17]\d{8}$/.test(n)) n = '254' + n.slice(1);
    return n;
  }

  function langButtons() {
    return '<div class="lang-pick">' + I18N.LANGS.map(function (l) {
      return '<button type="button" class="tab" data-lang="' + l.code + '" aria-pressed="' + (lang() === l.code) + '">' + esc(l.label) + '</button>';
    }).join('') + '</div>';
  }

  function wireLangButtons(root) {
    root.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.dataset.lang); });
    });
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

  function dialogButtons(okClass) {
    return '<div class="buttons"><button class="btn ghost" value="cancel" formnovalidate>' + esc(t('cancel')) + '</button>' +
      '<button class="btn ' + (okClass || '') + '" value="ok">' + esc(t('save')) + '</button></div>';
  }

  function customerForm(c) {
    c = c || {};
    return '<h2>' + esc(c.id ? t('editCustomer') : t('newCustomer')) + '</h2>' +
      '<label for="f-name">' + esc(t('name')) + '</label>' +
      '<input id="f-name" name="name" required autocomplete="off" value="' + esc(c.name) + '">' +
      '<label for="f-phone">' + esc(t('phoneOpt')) + '</label>' +
      '<input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="' + esc(t('phonePh')) + '" value="' + esc(c.phone) + '">' +
      '<label for="f-place">' + esc(t('placeOpt')) + '</label>' +
      '<input id="f-place" name="place" autocomplete="off" value="' + esc(c.place) + '">' +
      dialogButtons();
  }

  function addCustomer() {
    openDialog(customerForm(), function (fd) {
      var name = String(fd.get('name')).trim();
      if (!name) return false;
      var c = { id: uid(), name: name, phone: String(fd.get('phone')).trim(), place: String(fd.get('place')).trim(), createdAt: new Date().toISOString() };
      data.customers.push(c);
      changed(function (cl) { cl.putCustomer(normC(c)); });
      location.hash = '#/c/' + c.id;
      toast(t('customerAdded'));
    });
  }

  function editCustomer(c) {
    openDialog(customerForm(c), function (fd) {
      var name = String(fd.get('name')).trim();
      if (!name) return false;
      c.name = name;
      c.phone = String(fd.get('phone')).trim();
      c.place = String(fd.get('place')).trim();
      changed(function (cl) { cl.putCustomer(normC(c)); });
      render();
      toast(t('saved'));
    });
  }

  function addEntry(c, type) {
    var isDebt = type === 'debt';
    openDialog(
      '<h2>' + esc(isDebt ? t('tookDebt') : t('paidBack')) + '</h2>' +
      '<p style="margin:0;color:var(--muted)">' + esc(c.name) + '</p>' +
      '<label for="f-amount">' + esc(t('amount', { cur: data.settings.currency })) + '</label>' +
      '<input id="f-amount" name="amount" required inputmode="decimal" autocomplete="off" placeholder="0">' +
      '<label for="f-note">' + esc(isDebt ? t('whatTaken') : t('noteOpt')) + '</label>' +
      '<input id="f-note" name="note" autocomplete="off" placeholder="' + esc(isDebt ? t('debtPh') : t('payPh')) + '">' +
      '<label for="f-date">' + esc(t('date')) + '</label>' +
      '<input id="f-date" name="date" type="date" required value="' + today() + '">' +
      dialogButtons(isDebt ? 'owe' : 'paid'),
      function (fd) {
        var cents = toCents(fd.get('amount'));
        if (!cents) { alert(t('amountErr')); return false; }
        var entry = {
          id: uid(), customerId: c.id, type: type, amount: cents,
          note: String(fd.get('note')).trim(), date: String(fd.get('date')) || today(),
          createdAt: new Date().toISOString()
        };
        data.entries.push(entry);
        changed(function (cl) { cl.putEntry(normE(entry)); });
        render();
        toast(isDebt ? t('debtRecorded') : t('paymentRecorded'));
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
    titleEl.textContent = data.settings.shopName || t('appName');
    document.title = t('appName');
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

    var html = '';

    if (!data.customers.length) {
      // First use: let the person pick their language straight away.
      html += '<section class="card"><div class="section-title" style="margin-top:0">' +
        esc(t('chooseLanguage')) + '</div>' + langButtons() + '</section>';
    }

    if (cloudAvailable && authKnown && !account) html += signInCardHtml();

    html +=
      '<section class="summary">' +
        '<div class="label">' + esc(t('totalOwe')) + '</div>' +
        '<div class="big">' + money(total) + '</div>' +
        '<div class="sub">' + esc(t('owingCount', { n: owingCount, total: data.customers.length })) + '</div>' +
      '</section>' +
      '<input class="search" id="search" type="search" placeholder="' + esc(t('searchPh')) + '" value="' + esc(query) + '">' +
      '<div class="tabs">' +
        '<button class="tab" data-filter="owing" aria-pressed="' + (filter === 'owing') + '">' + esc(t('tabOwing')) + '</button>' +
        '<button class="tab" data-filter="all" aria-pressed="' + (filter === 'all') + '">' + esc(t('tabAll')) + '</button>' +
      '</div>';

    if (!data.customers.length) {
      html += '<div class="empty">' + t('emptyNone') + '</div>';
    } else if (!shown.length) {
      html += '<div class="empty">' + (q ? esc(t('noMatch', { q: query })) : esc(t('nobodyOwes'))) + '</div>';
    } else {
      html += '<ul class="list">' + shown.map(function (r) {
        return '<li><button class="row" data-id="' + esc(r.c.id) + '">' +
          '<span class="avatar">' + esc(initials(r.c.name)) + '</span>' +
          '<span class="main"><div class="name">' + esc(r.c.name) + '</div>' +
          '<div class="meta">' + esc(r.last ? t('lastActivity', { date: niceDate(r.last) }) : t('noRecords')) + '</div></span>' +
          '<span class="amount ' + (r.bal > 0 ? 'owe' : 'clear') + '">' + esc(r.bal > 0 ? money(r.bal) : t('clear')) + '</span>' +
          '</button></li>';
      }).join('') + '</ul>';
    }

    html += '<button class="fab" id="addCustomerBtn">' + esc(t('addCustomer')) + '</button>';
    app.innerHTML = html;

    wireLangButtons(app);
    wireCloudButtons(app);
    var search = document.getElementById('search');
    search.addEventListener('input', function () {
      query = search.value;
      var pos = search.selectionStart;
      renderHome();
      var s2 = document.getElementById('search');
      s2.focus();
      try { s2.setSelectionRange(pos, pos); } catch (e) {}
    });
    app.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.dataset.filter; renderHome(); });
    });
    app.querySelectorAll('.row').forEach(function (b) {
      b.addEventListener('click', function () { location.hash = '#/c/' + encodeURIComponent(b.dataset.id); });
    });
    document.getElementById('addCustomerBtn').addEventListener('click', addCustomer);
  }

  function reminderText(c, bal) {
    var shop = data.settings.shopName ? t('reminderShop', { shop: data.settings.shopName }) : '';
    return t('reminder', { name: c.name, shop: shop, amt: money(bal) });
  }

  function renderCustomer(id) {
    var c = findCustomer(id);
    if (!c) { location.hash = '#/'; return; }
    titleEl.textContent = c.name;
    backBtn.hidden = false;

    var bal = balanceOf(c.id);
    var list = entriesOf(c.id);
    var phone = cleanPhone(c.phone);
    var msg = reminderText(c, bal);

    var html =
      '<section class="summary">' +
        '<div class="label">' + esc(bal > 0 ? t('owesYou') : bal < 0 ? t('overpaid') : t('balance')) + '</div>' +
        '<div class="big" style="color:' + (bal > 0 ? 'var(--owe)' : 'var(--paid)') + '">' + esc(bal === 0 ? t('clear') : money(Math.abs(bal))) + '</div>' +
        '<div class="sub">' + esc([c.phone, c.place].filter(Boolean).join(' · ')) + '</div>' +
      '</section>' +
      '<div class="actions">' +
        '<button class="btn owe" id="debtBtn">+ ' + esc(t('tookDebt')) + '</button>' +
        '<button class="btn paid" id="payBtn">− ' + esc(t('paidBack')) + '</button>' +
      '</div>' +
      '<div class="links">' +
        (phone ? '<a class="btn ghost small" href="tel:' + esc(phone) + '">📞 ' + esc(t('call')) + '</a>' : '') +
        (phone && bal > 0 ? '<a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/' + esc(waNumber(phone)) + '?text=' + encodeURIComponent(msg) + '">💬 ' + esc(t('waReminder')) + '</a>' : '') +
        (phone && bal > 0 ? '<a class="btn ghost small" href="sms:' + esc(phone) + '?body=' + encodeURIComponent(msg) + '">✉️ ' + esc(t('smsReminder')) + '</a>' : '') +
        '<button class="btn ghost small" id="editBtn">✏️ ' + esc(t('edit')) + '</button>' +
      '</div>' +
      '<div class="section-title">' + esc(t('history')) + '</div>';

    if (!list.length) {
      html += '<div class="empty">' + esc(t('noRecordsCustomer')) + '</div>';
    } else {
      html += '<ul class="list">' + list.map(function (e) {
        return '<li class="entry ' + e.type + '">' +
          '<span class="tag">' + esc(e.type === 'debt' ? t('tagDebt') : t('tagPaid')) + '</span>' +
          '<div class="main"><div class="amount">' + money(e.amount) + '</div>' +
          (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
          '<div class="meta">' + esc(niceDate(e.date)) + '</div></div>' +
          '<button class="del" data-id="' + esc(e.id) + '" aria-label="' + esc(t('deleteRecord')) + '">🗑</button>' +
          '</li>';
      }).join('') + '</ul>';
    }

    html += '<div style="margin-top:24px"><button class="btn danger block" id="delCustomerBtn">' + esc(t('deleteCustomer')) + '</button></div>';
    app.innerHTML = html;

    document.getElementById('debtBtn').addEventListener('click', function () { addEntry(c, 'debt'); });
    document.getElementById('payBtn').addEventListener('click', function () { addEntry(c, 'payment'); });
    document.getElementById('editBtn').addEventListener('click', function () { editCustomer(c); });
    app.querySelectorAll('.del').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = data.entries.find(function (x) { return x.id === b.dataset.id; });
        if (!e) return;
        if (!confirm(t('confirmDelRecord', { amt: money(e.amount) }))) return;
        data.entries = data.entries.filter(function (x) { return x.id !== e.id; });
        changed(function (cl) { cl.deleteEntry(e.id); });
        render(); toast(t('recordDeleted'));
      });
    });
    document.getElementById('delCustomerBtn').addEventListener('click', function () {
      var q = t('confirmDelCustomer', { name: c.name }) + (bal > 0 ? '\n\n' + t('stillOwes', { amt: money(bal) }) : '');
      if (!confirm(q)) return;
      var entryIds = data.entries.filter(function (x) { return x.customerId === c.id; }).map(function (x) { return x.id; });
      data.customers = data.customers.filter(function (x) { return x.id !== c.id; });
      data.entries = data.entries.filter(function (x) { return x.customerId !== c.id; });
      changed(function (cl) { cl.deleteCustomer(c.id, entryIds); });
      location.hash = '#/';
      toast(t('customerDeleted'));
    });
  }

  function renderSettings() {
    titleEl.textContent = t('settingsTitle');
    backBtn.hidden = false;
    var s = data.settings;
    var last = data.lastBackup ? niceDateTime(data.lastBackup) : t('never');

    var accountHtml = '';
    if (cloudAvailable && authKnown) {
      accountHtml = account
        ? '<section class="card cloud-card">' +
            '<div class="section-title" style="margin-top:0">' + esc(t('accountTitle')) + '</div>' +
            '<p>✅ ' + esc(t('cloudOn')) + '</p>' +
            '<p>' + esc(t('signedInAs', { email: account.email || account.name || '' })) + '</p>' +
            '<button class="btn ghost block" data-signout>' + esc(t('signOut')) + '</button>' +
          '</section>'
        : signInCardHtml();
    }

    app.innerHTML = accountHtml +
      '<section class="card">' +
        '<div class="section-title" style="margin-top:0">' + esc(t('language')) + '</div>' +
        langButtons() +
      '</section>' +
      '<section class="card">' +
        '<div class="section-title" style="margin-top:0">' + esc(t('backupTitle')) + '</div>' +
        '<p>' + t('backupExplain') + '</p>' +
        '<p>' + esc(t('lastBackup')) + ' <b>' + esc(last) + '</b></p>' +
        '<button class="btn block" id="backupBtn">⬆️ ' + esc(t('backupNow')) + '</button>' +
        '<button class="btn ghost block" id="restoreBtn">⬇️ ' + esc(t('restore')) + '</button>' +
        '<input type="file" id="restoreFile" accept=".json,application/json" hidden>' +
      '</section>' +
      '<form class="card" id="settingsForm">' +
        '<div class="section-title" style="margin-top:0">' + esc(t('shop')) + '</div>' +
        '<label for="s-name">' + esc(t('shopName')) + '</label>' +
        '<input id="s-name" name="shopName" value="' + esc(s.shopName) + '" placeholder="' + esc(t('shopNamePh')) + '">' +
        '<label for="s-cur">' + esc(t('currency')) + '</label>' +
        '<input id="s-cur" name="currency" value="' + esc(s.currency) + '" placeholder="KSh">' +
        '<div style="margin-top:14px"><button class="btn block">' + esc(t('saveSettings')) + '</button></div>' +
      '</form>' +
      '<section class="card">' +
        '<div class="section-title" style="margin-top:0">' + esc(t('reports')) + '</div>' +
        '<p>' + esc(t('reportsExplain')) + '</p>' +
        '<button class="btn ghost block" id="csvBtn">📄 ' + esc(t('downloadCsv')) + '</button>' +
      '</section>';

    wireLangButtons(app);
    wireCloudButtons(app);
    document.getElementById('settingsForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(ev.target);
      s.shopName = String(fd.get('shopName')).trim();
      s.currency = String(fd.get('currency')).trim();
      changed(function (cl) { cl.putSettings(s); });
      toast(t('settingsSaved')); render();
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
    shareOrDownload(blob, 'deyn-book-backup_' + fileStamp() + '.json', t('appName')).then(function (done) {
      if (!done) return;
      data.lastBackup = new Date().toISOString();
      save();
      toast(t('backupMade'));
      render();
    });
  }

  function restore(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var incoming;
      try { incoming = normalize(JSON.parse(reader.result)); } catch (e) { incoming = null; }
      if (!incoming || (!incoming.customers.length && !incoming.entries.length)) {
        alert(t('notBackup'));
        return;
      }
      if (!confirm(t('confirmRestore', { c: incoming.customers.length, e: incoming.entries.length }))) return;
      incoming.owner = data.owner;
      incoming.settings.lang = data.settings.lang || incoming.settings.lang;
      data = incoming;
      changed(function (cl) { cl.replaceAll({ customers: data.customers.map(normC), entries: data.entries.map(normE), settings: data.settings }); });
      applyStaticText();
      toast(t('restored'));
      location.hash = '#/';
      render();
    };
    reader.readAsText(file);
  }

  function exportCsv() {
    function cell(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [t('csvHeader')];
    data.customers
      .map(function (c) { return { c: c, bal: balanceOf(c.id) }; })
      .filter(function (r) { return r.bal > 0; })
      .sort(function (a, b) { return b.bal - a.bal; })
      .forEach(function (r) {
        lines.push([cell(r.c.name), cell(r.c.phone), (r.bal / 100).toFixed(2), cell(lastActivity(r.c.id))].join(','));
      });
    // BOM so Excel shows non-English letters correctly.
    var blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
    shareOrDownload(blob, 'debts_' + today() + '.csv', t('downloadCsv'));
  }

  // ---------- Backup reminder ----------
  var banner = document.getElementById('backupBanner');
  function updateBackupBanner() {
    var days = data.lastBackup ? (Date.now() - new Date(data.lastBackup).getTime()) / 864e5 : Infinity;
    if (account || !data.entries.length || days < BACKUP_REMIND_DAYS) {
      banner.hidden = true;
      document.body.classList.remove('has-banner');
      return;
    }
    document.getElementById('backupBannerText').textContent = data.lastBackup
      ? t('noBackupDays', { n: Math.floor(days) })
      : t('noBackupYet');
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
    if (e.key === STORAGE_KEY) { data = load(); applyStaticText(); render(); updateBackupBanner(); }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  applyStaticText();
  render();
  updateBackupBanner();
})();
