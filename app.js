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
  var APP_VERSION = '1.3';
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
    var back = document.getElementById('backBtn');
    back.setAttribute('aria-label', t('back'));
    back.innerHTML = icon('back');
    document.getElementById('backupNowBtn').textContent = t('backupNow');
    document.getElementById('backupBannerIcon').innerHTML = icon('alert');
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

  // ---------- Icons ----------
  function icon(name, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (window.ICONS[name] || '') + '</svg>';
  }

  var GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

  // iPhone: Safari and the home-screen app keep separate records, and
  // Safari may delete website data after a few days without use.
  var IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var IS_STANDALONE = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  function iosInstallCardHtml() {
    var share = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
    return '<section class="card cloud">' +
      '<span class="chip brand">' + icon('alert') + '</span>' +
      '<div class="body"><h3>' + esc(t('iosTitle')) + '</h3>' +
      '<p style="margin-bottom:8px">' + esc(t('iosText')) + '</p>' +
      '<p style="margin:0;color:var(--text)"><b>1.</b> ' + esc(t('iosStep1')) + ' ' + share + '<br>' +
      '<b>2.</b> ' + esc(t('iosStep2')) + '<br>' +
      '<b>3.</b> ' + esc(t('iosStep3')) + '</p></div>' +
      '</section>';
  }

  function signInCardHtml() {
    return '<section class="card cloud">' +
      '<span class="chip chip brand">' + icon('cloud') + '</span>' +
      '<div class="body"><p>' + esc(t('signInExplain')) + '</p>' +
      '<button type="button" class="btn block google-btn" data-signin>' + GOOGLE_G + esc(t('signIn')) + '</button></div>' +
      '</section>';
  }

  function langSegmented() {
    return '<div class="segmented" style="margin:0">' + I18N.LANGS.map(function (l) {
      return '<button type="button" data-lang="' + l.code + '" aria-pressed="' + (lang() === l.code) + '">' + esc(l.label) + '</button>';
    }).join('') + '</div>';
  }

  // Buttons anywhere on the page use data-* attributes instead of ids.
  function wire(root) {
    root.querySelectorAll('[data-signin]').forEach(function (b) { b.addEventListener('click', signIn); });
    root.querySelectorAll('[data-signout]').forEach(function (b) { b.addEventListener('click', signOut); });
    root.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.dataset.lang); });
    });
    root.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { location.hash = b.dataset.go; });
    });
    root.querySelectorAll('[data-add-customer]').forEach(function (b) { b.addEventListener('click', addCustomer); });
  }

  // ---------- Dialog (bottom sheet) ----------
  var dialog = document.getElementById('dialog');
  var dialogForm = document.getElementById('dialogForm');

  function openDialog(html, onSubmit) {
    dialogForm.innerHTML = '<div class="grip"></div>' + html;
    dialogForm.onsubmit = function (ev) {
      var btn = ev.submitter;
      if (btn && btn.value === 'cancel') return; // closes
      ev.preventDefault();
      var ok = onSubmit(new FormData(dialogForm));
      if (ok !== false) dialog.close();
    };
    dialog.showModal();
    var first = dialogForm.querySelector('input, select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 60);
  }
  // Tap outside the sheet to close it.
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });

  function dialogButtons(okClass) {
    return '<div class="buttons"><button class="btn ghost" value="cancel" formnovalidate>' + esc(t('cancel')) + '</button>' +
      '<button class="btn ' + (okClass || '') + '" value="ok">' + esc(t('save')) + '</button></div>';
  }

  function customerForm(c) {
    c = c || {};
    return '<div class="sheet-head"><span class="tx-icon" style="background:var(--brand-soft);color:var(--brand-text)">' + icon(c.id ? 'edit' : 'userPlus') + '</span>' +
      '<h2>' + esc(c.id ? t('editCustomer') : t('newCustomer')) + '</h2></div>' +
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
      '<div class="sheet-head"><span class="tx-icon ' + type + '">' + icon(isDebt ? 'debt' : 'payment') + '</span>' +
      '<div><h2>' + esc(isDebt ? t('tookDebt') : t('paidBack')) + '</h2><div class="sub">' + esc(c.name) + '</div></div></div>' +
      '<label for="f-amount">' + esc(t('amount', { cur: data.settings.currency })) + '</label>' +
      '<input id="f-amount" class="amount-input num" name="amount" required inputmode="decimal" autocomplete="off" placeholder="0">' +
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

  // ---------- Page frame (app bar + bottom menu) ----------
  var app = document.getElementById('app');
  var appbar = document.getElementById('appbar');
  var titleEl = document.getElementById('title');
  var backBtn = document.getElementById('backBtn');
  var syncBadge = document.getElementById('syncBadge');
  var appbarAction = document.getElementById('appbarAction');
  var bottomNav = document.getElementById('bottomNav');
  var filter = 'owing';
  var query = '';
  var reportMonth = 0;

  var NAV = [
    { key: 'home', hash: '#/', icon: 'home', label: 'navHome' },
    { key: 'customers', hash: '#/customers', icon: 'users', label: 'navCustomers' },
    { key: 'reports', hash: '#/reports', icon: 'chart', label: 'navReports' },
    { key: 'settings', hash: '#/settings', icon: 'settings', label: 'navSettings' }
  ];

  function frame(opts) {
    titleEl.textContent = opts.title;
    document.title = t('appName');
    backBtn.hidden = !opts.back;
    appbar.classList.toggle('has-back', !!opts.back);
    appbarAction.innerHTML = opts.action || '';
    var showSync = opts.nav === 'home' && cloudAvailable && authKnown && account;
    syncBadge.hidden = !showSync;
    if (showSync) syncBadge.innerHTML = icon('check') + esc(t('synced'));
    app.classList.toggle('flush-top', !!opts.flush);
    if (opts.nav) {
      bottomNav.hidden = false;
      bottomNav.innerHTML = NAV.map(function (n) {
        return '<a href="' + n.hash + '"' + (n.key === opts.nav ? ' aria-current="page"' : '') + '>' +
          '<span class="pill">' + icon(n.icon) + '</span>' + esc(t(n.label)) + '</a>';
      }).join('');
    } else {
      bottomNav.hidden = true;
    }
    document.body.classList.toggle('no-nav', !opts.nav);
  }

  function render() {
    var hash = location.hash || '#/';
    var m = hash.match(/^#\/c\/(.+)$/);
    if (m) renderCustomer(decodeURIComponent(m[1]));
    else if (hash === '#/customers') renderCustomers();
    else if (hash === '#/reports') renderReports();
    else if (hash === '#/settings') renderSettings();
    else renderHome();
    wire(app);
    updateBackupBanner();
  }

  // ---------- Shared bits ----------
  function monthRange(offset) {
    var d = new Date();
    var s = new Date(d.getFullYear(), d.getMonth() + offset, 1);
    var e = new Date(d.getFullYear(), d.getMonth() + offset + 1, 1);
    function fmt(x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-01'; }
    return { start: fmt(s), end: fmt(e) };
  }

  function sumIn(type, range) {
    return data.entries.reduce(function (sum, e) {
      return e.type === type && e.date >= range.start && e.date < range.end ? sum + e.amount : sum;
    }, 0);
  }

  function customerRows() {
    return data.customers.map(function (c) {
      return { c: c, bal: balanceOf(c.id), last: lastActivity(c.id) };
    });
  }

  function totals() {
    var total = 0, owing = 0;
    customerRows().forEach(function (r) { if (r.bal > 0) { total += r.bal; owing++; } });
    return { total: total, owing: owing };
  }

  function customerItem(r) {
    return '<button type="button" class="item" data-go="#/c/' + esc(encodeURIComponent(r.c.id)) + '">' +
      '<span class="avatar">' + esc(initials(r.c.name)) + '</span>' +
      '<span class="main"><div class="title">' + esc(r.c.name) + '</div>' +
      '<div class="meta">' + esc(r.last ? t('lastActivity', { date: niceDate(r.last) }) : (r.c.phone || t('noRecords'))) + '</div></span>' +
      '<span class="end"><div class="amount num ' + (r.bal > 0 ? 'owe-text' : 'paid-text') + '">' + esc(r.bal > 0 ? money(r.bal) : t('clear')) + '</div></span>' +
      '</button>';
  }

  function entryItem(e, withCustomer, withDelete) {
    var isDebt = e.type === 'debt';
    var c = withCustomer ? findCustomer(e.customerId) : null;
    var title = withCustomer ? (c ? c.name : '?') : (e.note || (isDebt ? t('debtOn') : t('paymentOn')));
    var meta = withCustomer ? [e.note || (isDebt ? t('debtOn') : t('paymentOn')), niceDate(e.date)].join(' · ') : niceDate(e.date);
    var tag = withCustomer && c ? 'button type="button" data-go="#/c/' + esc(encodeURIComponent(c.id)) + '"' : 'div';
    return '<' + tag + ' class="item">' +
      '<span class="tx-icon ' + e.type + '">' + icon(isDebt ? 'debt' : 'payment') + '</span>' +
      '<span class="main"><div class="title">' + esc(title) + '</div><div class="meta">' + esc(meta) + '</div></span>' +
      '<span class="end"><div class="amount num ' + (isDebt ? 'owe-text' : 'paid-text') + '">' + (isDebt ? '+' : '−') + money(e.amount) + '</div></span>' +
      (withDelete ? '<button type="button" class="del-btn" data-del="' + esc(e.id) + '" aria-label="' + esc(t('deleteRecord')) + '">' + icon('trash') + '</button>' : '') +
      '</' + tag.split(' ')[0] + '>';
  }

  function emptyState(iconName, title, text, withButton) {
    return '<div class="empty"><span class="chip">' + icon(iconName) + '</span>' +
      (title ? '<b>' + esc(title) + '</b>' : '') + esc(text || '') +
      (withButton ? '<div><button type="button" class="btn" data-add-customer>' + icon('userPlus') + esc(t('addFirst')) + '</button></div>' : '') +
      '</div>';
  }

  function fab() {
    return '<button type="button" class="fab" data-add-customer>' + icon('plus') + esc(t('addCustomer').replace(/^\+\s*/, '')) + '</button>';
  }

  // ---------- Home ----------
  function renderHome() {
    frame({ title: data.settings.shopName || t('appName'), nav: 'home', flush: true });
    var tot = totals();
    var month = monthRange(0);
    var html =
      '<section class="hero">' +
        '<div class="label">' + esc(t('toCollect')) + '</div>' +
        '<div class="big num">' + money(tot.total) + '</div>' +
        '<div class="sub">' + icon('users') + esc(t('owingCustomers', { n: tot.owing })) + '</div>' +
      '</section>' +
      '<div class="stats">' +
        '<div class="stat"><div class="top"><span class="chip paid">' + icon('payment') + '</span>' + esc(t('collectedMonth')) + '</div>' +
          '<div class="val num paid-text">' + money(sumIn('payment', month)) + '</div></div>' +
        '<div class="stat"><div class="top"><span class="chip owe">' + icon('debt') + '</span>' + esc(t('givenMonth')) + '</div>' +
          '<div class="val num owe-text">' + money(sumIn('debt', month)) + '</div></div>' +
      '</div>';

    if (IS_IOS && !IS_STANDALONE) html += iosInstallCardHtml();
    if (!data.customers.length) {
      html += '<section class="card"><h3>' + esc(t('chooseLanguage')) + '</h3><div style="margin-top:10px">' + langSegmented() + '</div></section>';
    }
    if (cloudAvailable && authKnown && !account) html += signInCardHtml();

    if (!data.customers.length) {
      html += '<div class="list-card">' + emptyState('wallet', t('getStarted'), t('getStartedText'), true) + '</div>';
    } else {
      var top = customerRows().filter(function (r) { return r.bal > 0; })
        .sort(function (a, b) { return b.bal - a.bal; }).slice(0, 5);
      if (top.length) {
        html += '<div class="section-head"><h2>' + esc(t('topOwing')) + '</h2>' +
          '<button type="button" class="link-btn" data-go="#/customers">' + esc(t('seeAll')) + '</button></div>' +
          '<div class="list-card">' + top.map(customerItem).join('') + '</div>';
      }
      var recent = data.entries.slice().sort(function (a, b) {
        return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
      }).slice(0, 6);
      html += '<div class="section-head"><h2>' + esc(t('recent')) + '</h2></div>' +
        (recent.length
          ? '<div class="list-card">' + recent.map(function (e) { return entryItem(e, true, false); }).join('') + '</div>'
          : '<div class="list-card">' + emptyState('clock', '', t('noRecords')) + '</div>');
    }
    html += fab();
    app.innerHTML = html;
  }

  // ---------- Customers ----------
  function renderCustomers() {
    frame({ title: t('navCustomers'), nav: 'customers' });
    var rows = customerRows();
    var q = query.toLowerCase();
    var shown = rows.filter(function (r) {
      if (filter === 'owing' && r.bal <= 0) return false;
      if (!q) return true;
      return r.c.name.toLowerCase().indexOf(q) >= 0 || (r.c.phone || '').indexOf(q) >= 0;
    }).sort(function (a, b) {
      return filter === 'owing' ? b.bal - a.bal : a.c.name.localeCompare(b.c.name);
    });

    var html =
      '<div class="search-wrap">' + icon('search') +
        '<input class="search" id="search" type="search" placeholder="' + esc(t('searchPh')) + '" value="' + esc(query) + '"></div>' +
      '<div class="segmented">' +
        '<button type="button" data-filter="owing" aria-pressed="' + (filter === 'owing') + '">' + esc(t('tabOwing')) + '</button>' +
        '<button type="button" data-filter="all" aria-pressed="' + (filter === 'all') + '">' + esc(t('tabAll')) + ' (' + rows.length + ')</button>' +
      '</div>';

    if (!rows.length) {
      html += '<div class="list-card">' + emptyState('users', t('getStarted'), t('getStartedText'), true) + '</div>';
    } else if (!shown.length) {
      html += '<div class="list-card">' + emptyState(q ? 'search' : 'check', '', q ? t('noMatch', { q: query }) : t('nobodyOwes')) + '</div>';
    } else {
      html += '<div class="list-card">' + shown.map(customerItem).join('') + '</div>';
    }
    html += fab();
    app.innerHTML = html;

    var search = document.getElementById('search');
    search.addEventListener('input', function () {
      query = search.value;
      var pos = search.selectionStart;
      render();
      var s2 = document.getElementById('search');
      s2.focus();
      try { s2.setSelectionRange(pos, pos); } catch (e) {}
    });
    app.querySelectorAll('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () { filter = b.dataset.filter; render(); });
    });
  }

  // ---------- One customer ----------
  function reminderText(c, bal) {
    var shop = data.settings.shopName ? t('reminderShop', { shop: data.settings.shopName }) : '';
    return t('reminder', { name: c.name, shop: shop, amt: money(bal) });
  }

  function renderCustomer(id) {
    var c = findCustomer(id);
    if (!c) { location.hash = '#/customers'; return; }
    frame({
      title: c.name, back: true,
      action: '<button type="button" class="icon-btn" id="editBtn" aria-label="' + esc(t('edit')) + '">' + icon('edit') + '</button>'
    });

    var bal = balanceOf(c.id);
    var list = entriesOf(c.id);
    var phone = cleanPhone(c.phone);
    var msg = reminderText(c, bal);

    var quick = '';
    if (phone) {
      quick += '<a href="tel:' + esc(phone) + '"><span class="circle">' + icon('phone') + '</span>' + esc(t('call')) + '</a>';
      if (bal > 0) {
        quick += '<a target="_blank" rel="noopener" href="https://wa.me/' + esc(waNumber(phone)) + '?text=' + encodeURIComponent(msg) + '"><span class="circle wa">' + icon('whatsapp') + '</span>WhatsApp</a>';
        quick += '<a href="sms:' + esc(phone) + '?body=' + encodeURIComponent(msg) + '"><span class="circle">' + icon('sms') + '</span>SMS</a>';
      }
    } else {
      quick += '<button type="button" id="addPhoneBtn"><span class="circle">' + icon('phone') + '</span>' + esc(t('phoneOpt').replace(/\s*\(.*\)/, '')) + '</button>';
    }

    var html =
      '<section class="card profile">' +
        '<div class="avatar lg">' + esc(initials(c.name)) + '</div>' +
        '<div class="name">' + esc(c.name) + '</div>' +
        '<div class="meta">' + esc([c.phone, c.place].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="balance-label">' + esc(bal > 0 ? t('owesYou') : bal < 0 ? t('overpaid') : t('balance')) + '</div>' +
        '<div class="balance num ' + (bal > 0 ? 'owe-text' : 'paid-text') + '">' + esc(bal === 0 ? t('clear') : money(Math.abs(bal))) + '</div>' +
        '<div class="quick">' + quick + '</div>' +
      '</section>' +
      '<div class="actions">' +
        '<button type="button" class="btn owe" id="debtBtn">' + icon('debt') + esc(t('tookDebt')) + '</button>' +
        '<button type="button" class="btn paid" id="payBtn">' + icon('payment') + esc(t('paidBack')) + '</button>' +
      '</div>' +
      '<div class="section-head"><h2>' + esc(t('history')) + '</h2></div>';

    html += list.length
      ? '<div class="list-card">' + list.map(function (e) { return entryItem(e, false, true); }).join('') + '</div>'
      : '<div class="list-card">' + emptyState('clock', '', t('noRecordsCustomer')) + '</div>';

    html += '<div style="margin-top:20px;text-align:center"><button type="button" class="btn danger-text" id="delCustomerBtn">' + icon('trash') + esc(t('deleteCustomer')) + '</button></div>';
    app.innerHTML = html;

    document.getElementById('editBtn').addEventListener('click', function () { editCustomer(c); });
    var addPhone = document.getElementById('addPhoneBtn');
    if (addPhone) addPhone.addEventListener('click', function () { editCustomer(c); });
    document.getElementById('debtBtn').addEventListener('click', function () { addEntry(c, 'debt'); });
    document.getElementById('payBtn').addEventListener('click', function () { addEntry(c, 'payment'); });
    app.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = data.entries.find(function (x) { return x.id === b.dataset.del; });
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
      location.hash = '#/customers';
      toast(t('customerDeleted'));
    });
  }

  // ---------- Reports ----------
  function renderReports() {
    frame({ title: t('navReports'), nav: 'reports' });
    var range = monthRange(reportMonth);
    var given = sumIn('debt', range);
    var paid = sumIn('payment', range);
    var tot = totals();
    var top = customerRows().filter(function (r) { return r.bal > 0; })
      .sort(function (a, b) { return b.bal - a.bal; }).slice(0, 10);

    var html =
      '<div class="segmented">' +
        '<button type="button" data-month="0" aria-pressed="' + (reportMonth === 0) + '">' + esc(t('thisMonth')) + '</button>' +
        '<button type="button" data-month="-1" aria-pressed="' + (reportMonth === -1) + '">' + esc(t('lastMonth')) + '</button>' +
      '</div>' +
      '<div class="report-grid">' +
        '<div class="stat"><div class="top"><span class="chip owe">' + icon('debt') + '</span>' + esc(t('debtGiven')) + '</div>' +
          '<div class="val num owe-text">' + money(given) + '</div></div>' +
        '<div class="stat"><div class="top"><span class="chip paid">' + icon('payment') + '</span>' + esc(t('paymentsReceived')) + '</div>' +
          '<div class="val num paid-text">' + money(paid) + '</div></div>' +
        '<div class="stat wide"><div class="top"><span class="chip brand">' + icon('wallet') + '</span>' + esc(t('stillOutstanding')) + '</div>' +
          '<div class="val num" style="font-size:24px">' + money(tot.total) + '</div>' +
          '<div class="top" style="margin-top:4px">' + esc(t('owingCustomers', { n: tot.owing })) + '</div></div>' +
      '</div>';

    if (top.length) {
      html += '<div class="section-head"><h2>' + esc(t('topOwing')) + '</h2></div>' +
        '<div class="list-card">' + top.map(customerItem).join('') + '</div>';
    }
    html += '<div class="group-title">' + esc(t('exportTitle')) + '</div>' +
      '<div class="list-card"><button type="button" class="row-btn" id="excelBtn"><span class="chip" style="background:#e3f6ec;color:#107c41">' + icon('file') + '</span>' +
      '<span class="main">' + esc(t('excelTitle')) + '<span class="meta">' + esc(t('excelExplain')) + '</span></span>' + icon('chevron') + '</button></div>';
    app.innerHTML = html;

    app.querySelectorAll('[data-month]').forEach(function (b) {
      b.addEventListener('click', function () { reportMonth = +b.dataset.month; render(); });
    });
    document.getElementById('excelBtn').addEventListener('click', exportExcel);
  }

  // ---------- Settings ----------
  function renderSettings() {
    frame({ title: t('navSettings'), nav: 'settings' });
    var s = data.settings;
    var last = data.lastBackup ? niceDateTime(data.lastBackup) : t('never');
    var html = '';

    if (cloudAvailable && authKnown) {
      html += '<div class="group-title" style="margin-top:4px">' + esc(t('accountTitle')) + '</div>';
      if (account) {
        var who = account.name || account.email || '';
        html += '<div class="list-card">' +
          '<div class="account"><span class="avatar">' + esc(initials(who)) + '</span>' +
            '<div class="main"><div class="name">' + esc(account.name || account.email) + '</div>' +
            (account.name && account.email ? '<div class="meta">' + esc(account.email) + '</div>' : '') +
            '<span class="status-pill">' + icon('check') + esc(t('synced')) + '</span></div></div>' +
          '<button type="button" class="row-btn danger" data-signout><span class="chip">' + icon('logout') + '</span>' +
            '<span class="main">' + esc(t('signOut')) + '</span></button>' +
        '</div>';
      } else {
        html += signInCardHtml();
      }
    }

    html += '<div class="group-title">' + esc(t('language')) + '</div>' + langSegmented();

    html += '<div class="group-title">' + esc(t('shop')) + '</div>' +
      '<form class="list-card form-pad" id="settingsForm">' +
        '<label for="s-name">' + esc(t('shopName')) + '</label>' +
        '<input id="s-name" name="shopName" value="' + esc(s.shopName) + '" placeholder="' + esc(t('shopNamePh')) + '">' +
        '<label for="s-cur">' + esc(t('currency')) + '</label>' +
        '<input id="s-cur" name="currency" value="' + esc(s.currency) + '" placeholder="KSh">' +
        '<div style="margin-top:16px"><button class="btn block">' + esc(t('saveSettings')) + '</button></div>' +
      '</form>';

    var backupRows =
      '<div class="list-card">' +
        '<button type="button" class="row-btn" id="backupBtn"><span class="chip">' + icon('upload') + '</span>' +
          '<span class="main">' + esc(t('backupNow')) + '<span class="meta">' + esc(t('lastBackup')) + ' ' + esc(last) + '</span></span>' + icon('chevron') + '</button>' +
        '<button type="button" class="row-btn" id="restoreBtn"><span class="chip">' + icon('download') + '</span>' +
          '<span class="main">' + esc(t('restore')) + '</span>' + icon('chevron') + '</button>' +
      '</div>' +
      '<p class="hint">' + esc(t('backupFileExplain')) + '</p>';
    html += '<div class="group-title">' + esc(t('backupFileTitle')) + '</div>' +
      (account
        ? '<p class="hint" style="margin-top:0">' + icon('cloud') + ' ' + esc(t('backupNotNeeded')) + '</p>' +
          '<details class="more"><summary>' + esc(t('backupAdvanced')) + '</summary>' + backupRows + '</details>'
        : backupRows) +
      '<input type="file" id="restoreFile" accept=".xlsx,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>';

    html += '<div class="footer-note">' + icon('shield', '') + '<br>' + esc(t('securityNote')) + '<br>' + esc(t('version', { v: APP_VERSION })) + '</div>';
    app.innerHTML = html;

    document.getElementById('settingsForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var fd = new FormData(ev.target);
      s.shopName = String(fd.get('shopName')).trim();
      s.currency = String(fd.get('currency')).trim();
      changed(function (cl) { cl.putSettings(s); });
      toast(t('settingsSaved'));
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      render();
    });
    document.getElementById('backupBtn').addEventListener('click', backup);
    var fileInput = document.getElementById('restoreFile');
    document.getElementById('restoreBtn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files[0]) restore(fileInput.files[0]);
      fileInput.value = '';
    });
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
    makeExcel().then(function (blob) {
      return shareOrDownload(blob, excelName(), t('appName'));
    }).then(function (done) {
      if (!done) return;
      data.lastBackup = new Date().toISOString();
      save();
      toast(t('backupMade'));
      render();
    }).catch(function (e) {
      console.error(e);
      alert(t('excelFailed'));
    });
  }

  function readBackupFile(file) {
    var isExcel = /\.xlsx$/i.test(file.name) || /spreadsheet/.test(file.type);
    if (isExcel) {
      return Promise.all([loadExcel(), file.arrayBuffer()]).then(function (r) {
        var labels = [I18N.en.debtOn, I18N.so.debtOn, I18N.en.tagDebt, I18N.so.tagDebt];
        var totalsRow = [I18N.en.totalRow, I18N.so.totalRow];
        return r[0].readBackup(r[1], labels, totalsRow);
      });
    }
    return file.text().then(function (txt) { return JSON.parse(txt); });
  }

  function restore(file) {
    readBackupFile(file).catch(function (e) { console.error(e); return null; }).then(function (raw) {
      var incoming = raw ? normalize(raw) : null;
      if (!incoming || (!incoming.customers.length && !incoming.entries.length)) {
        alert(t('notBackup'));
        return;
      }
      if (!confirm(t('confirmRestore', { c: incoming.customers.length, e: incoming.entries.length }))) return;
      incoming.owner = data.owner;
      incoming.settings = Object.assign({}, data.settings, raw.settings ? incoming.settings : {}, { lang: data.settings.lang });
      incoming.lastBackup = data.lastBackup;
      data = incoming;
      changed(function (cl) { cl.replaceAll({ customers: data.customers.map(normC), entries: data.entries.map(normE), settings: data.settings }); });
      applyStaticText();
      toast(t('restored'));
      if (location.hash === '#/' || !location.hash) render(); else location.hash = '#/';
    });
  }

  // Full records as a real Excel file (two sheets) that anyone can open.
  // Every Excel file is also a backup: it carries the exact records in a
  // hidden sheet, so Restore can read it back.
  var excelLib = null;
  function loadExcel() {
    if (!excelLib) excelLib = import('./excel.bundle.js').catch(function (e) { excelLib = null; throw e; });
    return excelLib;
  }

  function backupData() {
    return Object.assign({}, data, { exportedAt: new Date().toISOString(), owner: null, dirty: false });
  }

  function makeExcel() {
    return loadExcel().then(function (lib) {
      var cur = data.settings.currency || '';
      var amountCol = function (key) { return t(key) + (cur ? ' (' + cur + ')' : ''); };
      var rows = data.customers.map(function (c) {
        var taken = 0, paid = 0;
        data.entries.forEach(function (e) {
          if (e.customerId !== c.id) return;
          if (e.type === 'debt') taken += e.amount; else paid += e.amount;
        });
        return { c: c, taken: taken, paid: paid, bal: taken - paid };
      }).sort(function (a, b) { return b.bal - a.bal || a.c.name.localeCompare(b.c.name); });

      var customers = [[t('colName'), t('colPhone'), t('colPlace'), amountCol('colTaken'), amountCol('colPaid'), amountCol('colBalance'), t('colLast')]];
      var sumT = 0, sumP = 0, sumB = 0;
      rows.forEach(function (r) {
        sumT += r.taken; sumP += r.paid; sumB += r.bal;
        customers.push([r.c.name, r.c.phone || '', r.c.place || '', r.taken / 100, r.paid / 100, r.bal / 100, lastActivity(r.c.id) || '']);
      });
      customers.push([]);
      customers.push([t('totalRow'), '', '', sumT / 100, sumP / 100, sumB / 100, '']);

      // History in date order, with each customer's balance after every record.
      var running = {};
      var history = [[t('colDate'), t('colCustomer'), t('colType'), amountCol('colAmount'), t('colNote'), amountCol('colBalanceAfter')]];
      data.entries.slice().sort(function (a, b) {
        return (a.date + a.createdAt).localeCompare(b.date + b.createdAt);
      }).forEach(function (e) {
        var c = findCustomer(e.customerId);
        running[e.customerId] = (running[e.customerId] || 0) + (e.type === 'debt' ? e.amount : -e.amount);
        history.push([e.date, c ? c.name : '?', e.type === 'debt' ? t('debtOn') : t('paymentOn'),
          e.amount / 100, e.note || '', running[e.customerId] / 100]);
      });

      return lib.makeWorkbook([
        { name: t('sheetCustomers'), rows: customers, widths: [24, 16, 20, 18, 16, 16, 14] },
        { name: t('sheetHistory'), rows: history, widths: [12, 24, 14, 14, 30, 16] }
      ], backupData());
    });
  }

  function excelName() {
    var shop = (data.settings.shopName || 'Deyn-Book').replace(/[^\w\u00C0-\u024F -]+/g, '').trim().replace(/\s+/g, '-');
    return shop + '_' + fileStamp() + '.xlsx';
  }

  // Reports button and Back up button make the same file.
  function exportExcel() {
    makeExcel().then(function (blob) {
      return shareOrDownload(blob, excelName(), t('excelTitle'));
    }).then(function (done) {
      if (!done) return;
      data.lastBackup = new Date().toISOString();
      save();
      render();
    }).catch(function (e) {
      console.error(e);
      alert(t('excelFailed'));
    });
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
  window.addEventListener('hashchange', function () {
    if (dialog.open) dialog.close();
    render();
    window.scrollTo(0, 0);
  });

  // Keep tabs in sync if the app is open twice.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) { data = load(); applyStaticText(); render(); }
  });

  // Offline support. Look for a new version every time the app is opened
  // or brought back to the front, and switch to it straight away.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    var hadController = !!navigator.serviceWorker.controller;
    var reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // Only reload when replacing an older version, never in the middle
      // of typing something.
      if (!hadController || reloaded || dialog.open) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
    }).catch(function () {});
  }

  applyStaticText();
  render();
})();
