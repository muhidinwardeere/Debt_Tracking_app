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
  var APP_VERSION = '1.9';
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
      dirty: false,  // changed while not signed in, so must be uploaded
      synced: {}     // ids the server has confirmed it has (see applyRemote)
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

  // ---------- Checking records ----------
  // Every record that comes from outside (phone storage, the server, a
  // restored file) is checked here. Bad records are skipped, never trusted.
  // These limits match firestore.rules.
  var LIMITS = { name: 100, phone: 30, place: 200, note: 300, createdAt: 40, shopName: 60, currency: 8 };
  var MAX_AMOUNT = 10000000000000; // in cents (100 billion)
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/; // no leading _ (blocks __proto__)
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

  function cleanCustomer(c) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
    var name = str(c.name, LIMITS.name).trim();
    if (!name) return null;
    return withDeleted({ id: c.id, name: name, phone: str(c.phone, LIMITS.phone), place: str(c.place, LIMITS.place),
      createdAt: str(c.createdAt, LIMITS.createdAt) }, c);
  }

  // deletedAt: when the record was moved to the recycle bin (milliseconds).
  function withDeleted(out, src) {
    var d = Number(src.deletedAt);
    if (isFinite(d) && d > 0) out.deletedAt = Math.round(d);
    return out;
  }

  function cleanEntry(e) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
    if (typeof e.customerId !== 'string' || !ID_RE.test(e.customerId)) return null;
    if (e.type !== 'debt' && e.type !== 'payment') return null;
    var amount = Number(e.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
    if (typeof e.date !== 'string' || !DATE_RE.test(e.date)) return null;
    return withDeleted({ id: e.id, customerId: e.customerId, type: e.type, amount: amount,
      note: str(e.note, LIMITS.note), date: e.date, createdAt: str(e.createdAt, LIMITS.createdAt) }, e);
  }

  function cleanList(list, fn) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(fn).filter(function (x) {
      if (!x || seen[x.id]) return false;
      seen[x.id] = true;
      return true;
    });
  }

  function normalize(d) {
    var base = emptyData();
    if (!d || typeof d !== 'object') return base;
    var s = d.settings && typeof d.settings === 'object' ? d.settings : {};
    if (typeof s.shopName === 'string') base.settings.shopName = s.shopName.slice(0, LIMITS.shopName);
    if (typeof s.currency === 'string') base.settings.currency = s.currency.slice(0, LIMITS.currency);
    if (I18N[s.lang]) base.settings.lang = s.lang;
    base.customers = cleanList(d.customers, cleanCustomer);
    base.entries = cleanList(d.entries, cleanEntry);
    base.lastBackup = typeof d.lastBackup === 'string' ? d.lastBackup : null;
    base.owner = typeof d.owner === 'string' ? d.owner : null;
    base.dirty = !!d.dirty;
    if (d.synced && typeof d.synced === 'object') {
      Object.keys(d.synced).forEach(function (k) { if (ID_RE.test(k)) base.synced[k] = 1; });
    }
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
  var cloudErrorCode = null;   // set while online saving is failing

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
    return withDeleted({ id: c.id, name: c.name || '', phone: c.phone || '', place: c.place || '', createdAt: c.createdAt || '' }, c);
  }
  function normE(e) {
    return withDeleted({ id: e.id, customerId: e.customerId, type: e.type === 'payment' ? 'payment' : 'debt', amount: +e.amount || 0,
      note: e.note || '', date: e.date || '', createdAt: e.createdAt || '' }, e);
  }

  // Combine the server's list with this phone's list without ever losing a
  // record the server has not confirmed. A record is "confirmed" once a
  // server answer includes it with no upload still waiting. Then:
  //  - confirmed here, missing on the server  -> deleted on another phone: remove
  //  - never confirmed, missing on the server -> keep it and upload it again
  //    (its upload was refused or never arrived)
  function mergeRemote(localList, remoteList, clean, fromServer) {
    var out = [];
    var remoteIds = {};
    var needUpload = false;
    remoteList.forEach(function (raw) {
      var item = clean(raw);
      if (!item) return;
      remoteIds[item.id] = true;
      if (fromServer && !raw._pending) data.synced[item.id] = 1;
      out.push(item);
    });
    localList.forEach(function (item) {
      if (remoteIds[item.id]) return;
      if (fromServer && data.synced[item.id]) { delete data.synced[item.id]; return; }
      if (fromServer) needUpload = true;
      out.push(item);
    });
    if (needUpload) data.dirty = true;
    return out;
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
      // Upload only what the server has not confirmed, so records deleted
      // on another phone are not brought back.
      var upload = null;
      if (data.dirty) {
        var notSynced = function (x) { return !data.synced[x.id]; };
        upload = {
          customers: data.customers.filter(notSynced).map(normC),
          entries: data.entries.filter(notSynced).map(normE),
          settings: data.settings
        };
        if (!upload.customers.length && !upload.entries.length && !data.settings.shopName) upload = null;
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
        setTimeout(purgeBin, 4000);
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
          pinSave(null);
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

    applyRemote: function (part, meta) {
      var changedAny = false;
      if (meta && !meta.fromCache && cloudErrorCode) { cloudErrorCode = null; changedAny = true; }
      var fromServer = !!(meta && !meta.fromCache);
      var syncedBefore = JSON.stringify(data.synced);
      if (part.customers) {
        var cs = mergeRemote(data.customers, part.customers, cleanCustomer, fromServer);
        if (!sameList(cs, data.customers.map(normC))) { data.customers = cs; changedAny = true; }
      }
      if (part.entries) {
        var es = mergeRemote(data.entries, part.entries, cleanEntry, fromServer);
        if (!sameList(es, data.entries.map(normE))) { data.entries = es; changedAny = true; }
      }
      if (part.settings) {
        ['shopName', 'currency'].forEach(function (k) {
          var v = str(part.settings[k], LIMITS[k]);
          if (typeof part.settings[k] === 'string' && v !== data.settings[k]) {
            data.settings[k] = v; changedAny = true;
          }
        });
      }
      if (JSON.stringify(data.synced) !== syncedBefore) { save(); }
      if (data.dirty && fromServer) scheduleRetry();
      if (fromServer) scheduleStats();
      if (!changedAny) return;
      save();
      safeRender();
    },

    // Online saving is failing (e.g. database missing or rules not
    // published). Show it clearly until the next good update.
    cloudError: function (e) {
      cloudErrorCode = (e && e.code) || 'unknown';
      if (!cloudErrorShown) { cloudErrorShown = true; toast(t('cloudProblem')); }
      safeRender();
    },

    toastKey: function (key) { toast(t(key)); },

    // An upload was refused: keep the records and remember to try again.
    writeFailed: function (e) {
      data.dirty = true;
      save();
      window.DeynApp.cloudError(e);
    },

    uploadDone: function () {}
  };

  // Try again to upload records the server has not confirmed. Waits a few
  // seconds (so a burst of updates causes one try) and at most once a minute.
  var retryTimer = null, lastRetry = 0;
  function scheduleRetry() {
    if (retryTimer || !cloud()) return;
    var wait = Math.max(3000, 60000 - (Date.now() - lastRetry));
    retryTimer = setTimeout(function () {
      retryTimer = null;
      lastRetry = Date.now();
      if (cloud() && data.dirty) window.DeynCloud.retryUpload();
    }, wait);
  }

  // ---------- Usage counts (for the app owner's admin page) ----------
  // Only the shop name and how many customers/records there are; never
  // names, phone numbers or amounts. At most once every 3 hours.
  var statsTimer = null;
  function scheduleStats() {
    if (statsTimer || !cloud()) return;
    var last = 0;
    try { last = Number(localStorage.getItem('debtbook.statsAt') || 0); } catch (e) {}
    if (Date.now() - last < 3 * 3600000) return;
    statsTimer = setTimeout(function () {
      statsTimer = null;
      var cl = cloud();
      if (!cl || !cl.putStats) return;
      try { localStorage.setItem('debtbook.statsAt', String(Date.now())); } catch (e) {}
      cl.putStats({
        shopName: str(data.settings.shopName, LIMITS.shopName),
        customers: liveCustomers().length,
        entries: liveEntries().length,
        lang: lang(),
        version: APP_VERSION,
        platform: IS_IOS ? 'iphone' : /Android/i.test(navigator.userAgent) ? 'android' : 'computer'
      }).catch(function (e) { console.error(e); });
    }, 5000);
  }

  function isAdmin() {
    return !!(account && Array.isArray(window.DEYN_ADMINS) && window.DEYN_ADMINS.indexOf(account.uid) >= 0);
  }

  function signIn() {
    if (!window.DeynCloud) return;
    signingIn = true;
    window.DeynCloud.signIn().catch(function (e) {
      signingIn = false;
      console.error(e);
      alert(t('signInFailed') + (e && e.code ? '\n\n(' + e.code + ')' : ''));
    });
  }

  // Records on this phone that the server has not confirmed yet.
  function unsyncedCount() {
    return data.customers.concat(data.entries).filter(function (x) { return !data.synced[x.id]; }).length;
  }

  // Sign out only when every record is safely online, because signing out
  // removes the records from this phone.
  function signOut() {
    if (!cloud()) return;
    askPin(t('confirmSignOut')).then(function (ok) { if (ok) signOutConfirmed(); });
  }

  function signOutConfirmed() {
    var cl = window.DeynCloud;
    toast(t('signingOutWait'), 30000);
    if (data.dirty || unsyncedCount()) cl.retryUpload();
    cl.waitUploads(30000).then(function (ok) {
      // Give the "upload confirmed" update a moment to arrive.
      return new Promise(function (res) { setTimeout(function () { res(ok); }, 1200); });
    }).then(function (ok) {
      var left = unsyncedCount();
      if (!ok || left) {
        toast('', 1);
        if (confirm(t('signOutNotSaved', { n: left || '?' }))) backup();
        return;
      }
      signingOut = true;
      return cl.signOut().then(function (done) {
        if (!done) { signingOut = false; toast('', 1); alert(t('signOutOffline')); return; }
        // Start fresh so nothing of the old account stays in memory.
        setTimeout(function () { location.replace(location.pathname + location.search); }, 900);
      });
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
    var cents = Math.round(n * 100);
    return cents > 0 && cents <= MAX_AMOUNT ? cents : null;
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

  // ---------- Recycle bin ----------
  // Deleting only moves records to the bin for BIN_DAYS days; the server
  // refuses permanent deletion before that (firestore.rules).
  var BIN_DAYS = 30;
  var DAY = 864e5;

  function customerGone(id) {
    var c = data.customers.find(function (x) { return x.id === id; });
    return !c || !!c.deletedAt;
  }
  function liveCustomers() { return data.customers.filter(function (c) { return !c.deletedAt; }); }
  function liveEntries() {
    return data.entries.filter(function (e) { return !e.deletedAt && !customerGone(e.customerId); });
  }
  // Records that went to the bin together with their customer (same
  // moment; a little slack because times come from the server).
  function binnedWith(e, c) {
    return e.customerId === c.id && !!e.deletedAt && Math.abs(e.deletedAt - c.deletedAt) < 120000;
  }

  function daysLeft(x) { return Math.max(0, Math.ceil((x.deletedAt + BIN_DAYS * DAY - Date.now()) / DAY)); }

  // Permanently remove what has been in the bin long enough (one extra day
  // of margin so the server agrees it is old enough).
  function purgeBin() {
    var cutoff = Date.now() - (BIN_DAYS + 1) * DAY;
    var old = function (x) { return x.deletedAt && x.deletedAt < cutoff; };
    var gone = data.customers.filter(old).map(function (x) { return ['customers', x.id]; })
      .concat(data.entries.filter(old).map(function (x) { return ['entries', x.id]; }));
    if (!gone.length) return;
    if (data.owner && !cloud()) return; // wait until signed in, so the server copy goes too
    data.customers = data.customers.filter(function (x) { return !old(x); });
    data.entries = data.entries.filter(function (x) { return !old(x); });
    var c = cloud();
    if (c) c.purge(gone);
    save();
  }

  function balanceOf(customerId) {
    var b = 0;
    liveEntries().forEach(function (e) {
      if (e.customerId !== customerId) return;
      b += e.type === 'debt' ? e.amount : -e.amount;
    });
    return b;
  }

  function entriesOf(customerId) {
    return liveEntries()
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
  function toast(msg, ms) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2200);
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

  // Short version for the home screen: icon, one line, Google button.
  function signInCardShortHtml() {
    return '<section class="card cloud short">' +
      '<span class="chip brand">' + icon('cloud') + '</span>' +
      '<div class="body"><p><b>' + esc(t('signInShort')) + '</b></p>' +
      '<button type="button" class="btn block google-btn" data-signin>' + GOOGLE_G + esc(t('signIn')) + '</button></div>' +
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

  function openDialog(html, onSubmit, noFocus) {
    dialogForm.innerHTML = '<div class="grip"></div>' + html;
    dialogForm.onkeydown = null;
    dialogForm.onsubmit = function (ev) {
      var btn = ev.submitter;
      if (btn && btn.value === 'cancel') return; // closes
      ev.preventDefault();
      var ok = onSubmit(new FormData(dialogForm));
      if (ok !== false) dialog.close();
    };
    dialog.showModal();
    var first = dialogForm.querySelector('input:not([type=hidden]), select, textarea');
    if (first && !noFocus) setTimeout(function () { first.focus(); }, 60);
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
      '<input id="f-name" name="name" required maxlength="100" autocomplete="off" value="' + esc(c.name) + '">' +
      '<label for="f-phone">' + esc(t('phoneOpt')) + '</label>' +
      '<input id="f-phone" name="phone" type="tel" inputmode="tel" maxlength="30" autocomplete="off" placeholder="' + esc(t('phonePh')) + '" value="' + esc(c.phone) + '">' +
      '<label for="f-place">' + esc(t('placeOpt')) + '</label>' +
      '<input id="f-place" name="place" maxlength="200" autocomplete="off" value="' + esc(c.place) + '">' +
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

  // Big calculator-style keypad, easier than the phone keyboard for people
  // who do not read well. Whole numbers for shillings; a "." key for
  // currencies that use cents.
  function addEntry(c, type) {
    var isDebt = type === 'debt';
    var cur = data.settings.currency || '';
    var useDot = /[$€£]/.test(cur);
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', useDot ? '.' : '000', '0', 'back'];
    openDialog(
      '<div class="sheet-head"><span class="tx-icon big ' + type + '">' + icon(isDebt ? 'basket' : 'cash') + '</span>' +
        '<div class="grow"><h2>' + esc(isDebt ? t('btnDebt') : t('btnPaid')) + '</h2><div class="sub">' + esc(c.name) + '</div></div>' +
        '<button class="icon-btn plain" value="cancel" formnovalidate aria-label="' + esc(t('cancel')) + '">' + icon('x') + '</button></div>' +
      '<div class="amount-display num ' + type + '" id="amountShow" aria-live="polite"><span class="cur">' + esc(cur) + '</span> <span id="amountNum">0</span></div>' +
      '<input type="hidden" name="amount" id="f-amount" value="">' +
      '<div class="keypad">' + keys.map(function (k) {
        return '<button type="button" class="key' + (k === 'back' ? ' back' : '') + '" data-key="' + k + '"' +
          (k === 'back' ? ' aria-label="' + esc(t('deleteRecord')) + '"' : '') + '>' + (k === 'back' ? icon('backspace') : k) + '</button>';
      }).join('') + '</div>' +
      '<details class="more"><summary>' + icon('edit') + ' ' + esc(t('moreDetails')) + '</summary>' +
        '<label for="f-note">' + esc(isDebt ? t('whatTaken') : t('noteOpt')) + '</label>' +
        '<input id="f-note" name="note" maxlength="300" autocomplete="off" placeholder="' + esc(isDebt ? t('debtPh') : t('payPh')) + '">' +
        '<label for="f-date">' + esc(t('date')) + '</label>' +
        '<input id="f-date" name="date" type="date" required min="2000-01-01" max="2099-12-31" value="' + today() + '">' +
      '</details>' +
      '<button class="btn block save-big ' + (isDebt ? 'owe' : 'paid') + '" value="ok">' + icon('check') + esc(t('save')) + '</button>',
      function (fd) {
        var cents = toCents(fd.get('amount'));
        if (!cents) { shake(document.getElementById('amountShow')); return false; }
        var entry = {
          id: uid(), customerId: c.id, type: type, amount: cents,
          note: String(fd.get('note') || '').trim(), date: DATE_RE.test(String(fd.get('date'))) ? String(fd.get('date')) : today(),
          createdAt: new Date().toISOString()
        };
        data.entries.push(entry);
        changed(function (cl) { cl.putEntry(normE(entry)); });
        render();
        toast((isDebt ? t('debtRecorded') : t('paymentRecorded')) + ' ✔');
      },
      true
    );
    var raw = '';
    var hidden = document.getElementById('f-amount');
    var shown = document.getElementById('amountNum');
    function press(k) {
      if (k === 'back') raw = raw.slice(0, -1);
      else if (k === '.') { if (raw.indexOf('.') < 0) raw = (raw || '0') + '.'; }
      else if (raw.replace('.', '').length < 11) {
        if (/\.\d\d$/.test(raw)) return;           // at most 2 decimals
        raw = (raw === '0' ? '' : raw) + k;
        if (/^0+$/.test(raw)) raw = '0';
      }
      hidden.value = raw;
      var parts = raw.split('.');
      shown.textContent = (Number(parts[0] || 0)).toLocaleString('en-KE') + (parts.length > 1 ? '.' + parts[1] : '');
    }
    dialogForm.querySelectorAll('[data-key]').forEach(function (b) {
      b.addEventListener('click', function () { press(b.dataset.key); });
    });
    // Computer keyboard works too.
    dialogForm.onkeydown = function (e) {
      if (e.target.tagName === 'INPUT') return;
      if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === '.' && useDot) { press('.'); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('back'); e.preventDefault(); }
    };
  }

  function shake(el) {
    if (!el) return;
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
  }

  // ---------- PIN lock ----------
  // A 4-number secret code, kept only on this phone (as a salted PBKDF2
  // hash, never the number itself). Asked when the app opens, after the
  // phone was away for a minute, and before deleting, restoring a backup,
  // signing out or changing the PIN. It stops other people using the
  // phone; the server rules are what protect the records online.
  var PIN_KEY = 'debtbook.pin';
  var PIN_LEN = 4;
  var LOCK_AFTER_MS = 60000;
  var pinUnlocked = false;

  function pinState() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || 'null'); } catch (e) { return null; }
  }
  function pinSave(st) {
    try {
      if (st) localStorage.setItem(PIN_KEY, JSON.stringify(st)); else localStorage.removeItem(PIN_KEY);
    } catch (e) {}
  }
  function hasPin() { var st = pinState(); return !!(st && st.hash); }

  function toHex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function hashPin(pin, saltHex) {
    var salt = new Uint8Array(saltHex.match(/../g).map(function (h) { return parseInt(h, 16); }));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: 150000 }, key, 256);
      }).then(toHex);
  }
  function setNewPin(pin) {
    var salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return hashPin(pin, salt).then(function (h) { pinSave({ hash: h, salt: salt, fails: 0, until: 0 }); });
  }
  // Wrong tries make you wait: 5 -> 30 s, 8 -> 5 min, 10+ -> 30 min.
  function waitAfter(fails) { return fails >= 10 ? 1800000 : fails >= 8 ? 300000 : fails >= 5 ? 30000 : 0; }
  function checkPin(pin) {
    var st = pinState();
    if (!st) return Promise.resolve(true);
    if (Date.now() < (st.until || 0)) return Promise.resolve('wait');
    return hashPin(pin, st.salt).then(function (h) {
      if (h === st.hash) { st.fails = 0; st.until = 0; pinSave(st); return true; }
      st.fails = (st.fails || 0) + 1;
      st.until = Date.now() + waitAfter(st.fails);
      pinSave(st);
      return false;
    });
  }

  // The PIN screen. mode: 'lock' (no way out except the PIN or "forgot"),
  // 'ask' (cancel allowed), 'new' (choose + repeat). Resolves with the PIN
  // typed (for 'new') or true/false.
  var pinScreenOpen = false;
  function pinScreen(mode, message) {
    return new Promise(function (resolve) {
      pinScreenOpen = true;
      var el = document.createElement('div');
      el.className = 'pin-screen';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
      el.innerHTML =
        (mode !== 'lock' ? '<button type="button" class="icon-btn pin-close" aria-label="' + esc(t('cancel')) + '">' + icon('x') + '</button>' : '') +
        '<div class="pin-top"><span class="pin-lock">' + icon('lock') + '</span>' +
        '<div class="pin-title"></div>' +
        (message ? '<div class="pin-msg">' + esc(message) + '</div>' : '') +
        '<div class="pin-dots">' + new Array(PIN_LEN + 1).join('<span></span>') + '</div>' +
        '<div class="pin-note" aria-live="polite"></div></div>' +
        '<div class="keypad pin-keys">' + keys.map(function (k) {
          if (!k) return '<span></span>';
          return '<button type="button" class="key' + (k === 'back' ? ' back' : '') + '" data-k="' + k + '"' +
            (k === 'back' ? ' aria-label="⌫"' : '') + '>' + (k === 'back' ? icon('backspace') : k) + '</button>';
        }).join('') + '</div>' +
        (mode === 'lock' || mode === 'ask' ? '<button type="button" class="link-btn pin-forgot">' + esc(t('pinForgot')) + '</button>' : '');
      document.body.appendChild(el);
      document.body.classList.add('pin-open');

      var typed = '', first = null, busy = false;
      var titleEl2 = el.querySelector('.pin-title');
      var dots = el.querySelectorAll('.pin-dots span');
      var note = el.querySelector('.pin-note');
      function setTitle() {
        titleEl2.textContent = mode === 'new' ? (first ? t('pinAgain') : t('pinChoose')) : t('pinEnter');
      }
      function draw() { dots.forEach(function (d, i) { d.classList.toggle('on', i < typed.length); }); }
      function close(result) {
        document.removeEventListener('keydown', onKey);
        el.remove();
        document.body.classList.remove('pin-open');
        pinScreenOpen = false;
        resolve(result);
      }
      function wrong(msg) {
        typed = ''; draw();
        note.textContent = msg;
        shake(el.querySelector('.pin-dots'));
      }
      function full() {
        if (mode === 'new') {
          if (!first) { first = typed; typed = ''; draw(); setTitle(); note.textContent = ''; return; }
          if (typed !== first) { first = null; setTitle(); wrong(t('pinMismatch')); return; }
          close(typed);
          return;
        }
        busy = true;
        checkPin(typed).then(function (r) {
          busy = false;
          if (r === true) { close(true); return; }
          var st = pinState() || {};
          var secs = Math.ceil(((st.until || 0) - Date.now()) / 1000);
          wrong(secs > 0 ? t('pinWait', { s: secs }) : t('pinWrong'));
        });
      }
      function press(k) {
        if (busy) return;
        if (k === 'back') { typed = typed.slice(0, -1); draw(); return; }
        if (typed.length >= PIN_LEN) return;
        typed += k; draw();
        if (typed.length === PIN_LEN) setTimeout(full, 120);
      }
      function onKey(e) {
        if (/^[0-9]$/.test(e.key)) press(e.key);
        else if (e.key === 'Backspace') press('back');
        else if (e.key === 'Escape' && mode !== 'lock') close(false);
      }
      el.querySelectorAll('[data-k]').forEach(function (b) {
        b.addEventListener('click', function () { press(b.dataset.k); });
      });
      var closeBtn = el.querySelector('.pin-close');
      if (closeBtn) closeBtn.addEventListener('click', function () { close(false); });
      var forgot = el.querySelector('.pin-forgot');
      if (forgot) forgot.addEventListener('click', function () {
        forgotPin().then(function (reset) { if (reset) close(true); });
      });
      document.addEventListener('keydown', onKey);
      setTitle();
    });
  }

  // Ask for the PIN before something risky. Without a PIN, a plain
  // "are you sure?" question is used.
  function askPin(question) {
    if (!hasPin()) return Promise.resolve(confirm(question));
    return pinScreen('ask', question);
  }

  function lockNow() {
    if (!hasPin() || pinScreenOpen) return;
    pinUnlocked = false;
    if (dialog.open) dialog.close();
    pinScreen('lock').then(function () { pinUnlocked = true; });
  }

  // Forgot the PIN: the owner proves who they are with Google (records
  // stay). Without a Google sign-in, the only way is to erase this phone's
  // records (anyone could do that anyway by clearing the browser).
  function forgotPin() {
    var cl = cloud();
    if (cl) {
      if (!confirm(t('pinForgotGoogle'))) return Promise.resolve(false);
      return cl.reauth().then(function (ok) {
        if (!ok) { alert(t('pinForgotFailed')); return false; }
        pinSave(null);
        toast(t('pinRemoved'));
        setTimeout(function () { if (confirm(t('pinSetAgain'))) setupPin(); }, 400);
        return true;
      });
    }
    if (!confirm(t('pinForgotErase')) || !confirm(t('pinForgotErase2'))) return Promise.resolve(false);
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    pinSave(null);
    location.reload();
    return Promise.resolve(false);
  }

  function setupPin() {
    return pinScreen('new').then(function (pin) {
      if (!pin) return false;
      return setNewPin(pin).then(function () {
        toast(t('pinSaved'));
        pinUnlocked = true;
        render();
        return true;
      });
    });
  }

  function changePin() {
    askPin(t('pinChange')).then(function (ok) { if (ok) setupPin(); });
  }

  function removePin() {
    askPin(t('pinTurnOff')).then(function (ok) {
      if (!ok) return;
      pinSave(null);
      toast(t('pinRemoved'));
      render();
    });
  }

  // Lock again when the app comes back after being away for a while.
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lockNow();
  });

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
    { key: 'home', hash: '#/', icon: 'users', label: 'navCustomers' },
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
    syncBadge.classList.toggle('bad', !!cloudErrorCode);
    if (showSync) syncBadge.innerHTML = cloudErrorCode ? icon('alert') + esc(t('notSaving')) : icon('check') + esc(t('synced'));
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
    else if (hash === '#/bin') renderBin();
    else if (hash === '#/admin') renderAdmin();
    else renderHome();
    wire(app);
    app.querySelectorAll('[data-set-pin]').forEach(function (b) { b.addEventListener('click', setupPin); });
    var pc = document.getElementById('pinChangeBtn'); if (pc) pc.addEventListener('click', changePin);
    var po = document.getElementById('pinOffBtn'); if (po) po.addEventListener('click', removePin);
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
    return liveEntries().reduce(function (sum, e) {
      return e.type === type && e.date >= range.start && e.date < range.end ? sum + e.amount : sum;
    }, 0);
  }

  function customerRows() {
    return liveCustomers().map(function (c) {
      return { c: c, bal: balanceOf(c.id), last: lastActivity(c.id) };
    });
  }

  function totals() {
    var total = 0, owing = 0;
    customerRows().forEach(function (r) { if (r.bal > 0) { total += r.bal; owing++; } });
    return { total: total, owing: owing };
  }

  // Each customer gets their own color, so people can be found by color and
  // first letters, without reading.
  var AVATAR_COLORS = [
    ['#dbeafe', '#1d4ed8'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#fce7f3', '#be185d'],
    ['#ede9fe', '#6d28d9'], ['#ffedd5', '#c2410c'], ['#cffafe', '#0e7490'], ['#f1f5f9', '#334155']
  ];
  function avatar(c, cls) {
    var h = 0;
    for (var i = 0; i < c.id.length; i++) h = (h * 31 + c.id.charCodeAt(i)) >>> 0;
    var col = AVATAR_COLORS[h % AVATAR_COLORS.length];
    return '<span class="avatar ' + (cls || '') + '" style="background:' + col[0] + ';color:' + col[1] + '">' + esc(initials(c.name)) + '</span>';
  }

  function customerItem(r) {
    return '<button type="button" class="item big" data-go="#/c/' + esc(encodeURIComponent(r.c.id)) + '">' +
      avatar(r.c) +
      '<span class="main"><div class="title">' + esc(r.c.name) + '</div>' +
      (r.c.phone ? '<div class="meta">' + icon('phone') + ' ' + esc(r.c.phone) + '</div>' : '') + '</span>' +
      (r.bal > 0
        ? '<span class="end"><div class="amount big num owe-text">' + money(r.bal) + '</div></span>'
        : '<span class="end paid-text" aria-label="' + esc(t('clear')) + '">' + icon('checkBig', 'xl') + '</span>') +
      '</button>';
  }

  function entryItem(e, withCustomer, withDelete) {
    var isDebt = e.type === 'debt';
    var c = withCustomer ? findCustomer(e.customerId) : null;
    var title = withCustomer ? (c ? c.name : '?') : (e.note || (isDebt ? t('btnDebt') : t('btnPaid')));
    var meta = withCustomer ? [e.note, niceDate(e.date)].filter(Boolean).join(' · ') : niceDate(e.date);
    var tag = withCustomer && c ? 'button type="button" data-go="#/c/' + esc(encodeURIComponent(c.id)) + '"' : 'div';
    return '<' + tag + ' class="item">' +
      '<span class="tx-icon ' + e.type + '">' + icon(isDebt ? 'basket' : 'cash') + '</span>' +
      '<span class="main"><div class="title">' + esc(title) + '</div><div class="meta">' + esc(meta) + '</div></span>' +
      '<span class="end"><div class="amount big num ' + (isDebt ? 'owe-text' : 'paid-text') + '">' + (isDebt ? '+' : '−') + money(e.amount) + '</div></span>' +
      (withDelete ? '<button type="button" class="del-btn" data-del="' + esc(e.id) + '" aria-label="' + esc(t('deleteRecord')) + '">' + icon('trash') + '</button>' : '') +
      '</' + tag.split(' ')[0] + '>';
  }

  function emptyState(iconName, title, text, withButton) {
    return '<div class="empty"><span class="chip">' + icon(iconName) + '</span>' +
      (title ? '<b>' + esc(title) + '</b>' : '') + esc(text || '') +
      (withButton ? '<div><button type="button" class="btn big-btn" data-add-customer>' + icon('userPlus') + esc(t('addFirst')) + '</button></div>' : '') +
      '</div>';
  }

  function fab() {
    return '<button type="button" class="fab" data-add-customer aria-label="' + esc(t('newCustomer')) + '">' + icon('userPlus') + esc(t('addCustomer').replace(/^\+\s*/, '')) + '</button>';
  }

  // ---------- Home: the customer list ----------
  // Kept very simple for people who do not read well: one big total, then
  // every customer with their color, name and what they owe (red) or a
  // green tick when they owe nothing.
  function renderHome() {
    frame({ title: data.settings.shopName || t('appName'), nav: 'home', flush: true });
    var tot = totals();
    var rows = customerRows();
    var q = query.toLowerCase();
    var shown = rows.filter(function (r) {
      return !q || r.c.name.toLowerCase().indexOf(q) >= 0 || (r.c.phone || '').indexOf(q) >= 0;
    }).sort(function (a, b) {
      if ((a.bal > 0) !== (b.bal > 0)) return a.bal > 0 ? -1 : 1;
      return a.bal > 0 ? b.bal - a.bal : a.c.name.localeCompare(b.c.name);
    });

    var html =
      '<section class="hero simple">' +
        '<div class="label">' + icon('wallet') + esc(t('toCollect')) + '</div>' +
        '<div class="big num">' + money(tot.total) + '</div>' +
        '<div class="sub">' + icon('users') + '<b class="num">' + tot.owing + '</b></div>' +
      '</section>';

    if (IS_IOS && !IS_STANDALONE) html += iosInstallCardHtml();
    if (!data.customers.length) {
      html += '<section class="card"><h3>' + esc(t('chooseLanguage')) + '</h3><div style="margin-top:10px">' + langSegmented() + '</div></section>';
    }
    if (cloudAvailable && authKnown && !account) html += signInCardShortHtml();
    else if (rows.length && !hasPin() && !pinOfferDismissed()) {
      html += '<section class="card cloud short">' +
        '<span class="chip brand">' + icon('lock') + '</span>' +
        '<div class="body"><p><b>' + esc(t('pinOffer')) + '</b></p>' +
        '<div class="btn-row"><button type="button" class="btn" data-set-pin>' + icon('lock') + esc(t('pinTurnOn')) + '</button>' +
        '<button type="button" class="btn ghost" id="pinLaterBtn">' + esc(t('later')) + '</button></div></div></section>';
    }

    if (!rows.length) {
      html += '<div class="list-card">' + emptyState('wallet', t('getStarted'), t('getStartedText'), true) + '</div>';
    } else {
      if (rows.length > 5) {
        html += '<div class="search-wrap">' + icon('search') +
          '<input class="search big" id="search" type="search" placeholder="' + esc(t('searchPh')) + '" value="' + esc(query) + '"></div>';
      }
      html += shown.length
        ? '<div class="list-card">' + shown.map(customerItem).join('') + '</div>'
        : '<div class="list-card">' + emptyState('search', '', t('noMatch', { q: query })) + '</div>';
    }
    html += fab();
    app.innerHTML = html;

    var later = document.getElementById('pinLaterBtn');
    if (later) later.addEventListener('click', function () {
      try { localStorage.setItem('debtbook.pinOfferLater', String(Date.now() + 7 * DAY)); } catch (e) {}
      render();
    });
    var search = document.getElementById('search');
    if (search) search.addEventListener('input', function () {
      query = search.value;
      var pos = search.selectionStart;
      render();
      var s2 = document.getElementById('search');
      s2.focus();
      try { s2.setSelectionRange(pos, pos); } catch (e) {}
    });
  }

  function pinOfferDismissed() {
    try { return Number(localStorage.getItem('debtbook.pinOfferLater') || 0) > Date.now(); } catch (e) { return false; }
  }

  // Old link to the customer list: it is the home screen now.
  function renderCustomers() { location.replace('#/'); }

  // ---------- One customer ----------
  function reminderText(c, bal) {
    var shop = data.settings.shopName ? t('reminderShop', { shop: data.settings.shopName }) : '';
    return t('reminder', { name: c.name, shop: shop, amt: money(bal) });
  }

  function renderCustomer(id) {
    var c = findCustomer(id);
    if (!c || c.deletedAt) { location.hash = '#/'; return; }
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
    }

    var html =
      '<section class="card profile">' +
        avatar(c, 'lg') +
        '<div class="name">' + esc(c.name) + '</div>' +
        (bal > 0
          ? '<div class="balance num owe-text">' + money(bal) + '</div>'
          : '<div class="balance paid-text">' + icon('checkBig', 'xl') + '</div>') +
        (quick ? '<div class="quick">' + quick + '</div>' : '') +
      '</section>' +
      '<div class="actions big">' +
        '<button type="button" class="big-action owe" id="debtBtn">' + icon('basket') + '<span>' + esc(t('btnDebt')) + '</span></button>' +
        '<button type="button" class="big-action paid" id="payBtn">' + icon('cash') + '<span>' + esc(t('btnPaid')) + '</span></button>' +
      '</div>';

    html += list.length
      ? '<div class="section-head"><h2>' + icon('clock') + ' ' + esc(t('history')) + '</h2></div>' +
        '<div class="list-card">' + list.map(function (e) { return entryItem(e, false, true); }).join('') + '</div>'
      : '';

    html += '<div style="margin-top:24px;text-align:center"><button type="button" class="btn danger-text" id="delCustomerBtn">' + icon('trash') + esc(t('deleteCustomer')) + '</button></div>';
    app.innerHTML = html;

    document.getElementById('editBtn').addEventListener('click', function () { editCustomer(c); });
    document.getElementById('debtBtn').addEventListener('click', function () { addEntry(c, 'debt'); });
    document.getElementById('payBtn').addEventListener('click', function () { addEntry(c, 'payment'); });
    app.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = data.entries.find(function (x) { return x.id === b.dataset.del; });
        if (!e) return;
        askPin(t('confirmDelRecord', { amt: money(e.amount) })).then(function (ok) {
          if (!ok) return;
          e.deletedAt = Date.now();
          changed(function (cl) { cl.putEntry(normE(e)); });
          render(); toast(t('movedToBin'));
        });
      });
    });
    document.getElementById('delCustomerBtn').addEventListener('click', function () {
      var q = t('confirmDelCustomer', { name: c.name }) + (bal > 0 ? '\n\n' + t('stillOwes', { amt: money(bal) }) : '');
      askPin(q).then(function (ok) {
        if (!ok) return;
        // The customer and their records go to the bin together (same time),
        // so bringing the customer back also brings back those records.
        var when = Date.now();
        c.deletedAt = when;
        var moved = data.entries.filter(function (x) { return x.customerId === c.id && !x.deletedAt; });
        moved.forEach(function (x) { x.deletedAt = when; });
        changed(function (cl) {
          cl.putBatch({ customers: [normC(c)], entries: moved.map(normE) });
        });
        location.hash = '#/';
        toast(t('movedToBin'));
      });
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
    var recent = liveEntries().sort(function (a, b) {
      return (b.date + b.createdAt).localeCompare(a.date + a.createdAt);
    }).slice(0, 10);
    if (recent.length) {
      html += '<div class="section-head"><h2>' + esc(t('recent')) + '</h2></div>' +
        '<div class="list-card">' + recent.map(function (e) { return entryItem(e, true, false); }).join('') + '</div>';
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

  function binCount() {
    return data.customers.filter(function (c) { return c.deletedAt; }).length +
      data.entries.filter(function (e) { return e.deletedAt && !customerGone(e.customerId); }).length;
  }

  // ---------- Recycle bin page ----------
  function renderBin() {
    frame({ title: t('binTitle'), back: true });
    var cs = data.customers.filter(function (c) { return c.deletedAt; });
    var es = data.entries.filter(function (e) { return e.deletedAt && !customerGone(e.customerId); });
    var html = '<p class="hint" style="margin:0 4px 14px">' + icon('shield') + ' ' + esc(t('binExplain', { n: BIN_DAYS })) + '</p>';
    if (!cs.length && !es.length) {
      html += '<div class="list-card">' + emptyState('trash', '', t('binEmpty')) + '</div>';
    } else {
      var rows = cs.map(function (c) {
        var owed = data.entries.filter(function (e) { return binnedWith(e, c); })
          .reduce(function (sum, e) { return sum + (e.type === 'debt' ? e.amount : -e.amount); }, 0);
        return { at: c.deletedAt, html: '<div class="item big wrap">' + avatar(c) +
          '<span class="main"><div class="title">' + esc(c.name) + '</div><div class="meta">' + esc(t('daysLeft', { n: daysLeft(c) })) + '</div></span>' +
          (owed > 0 ? '<span class="end"><div class="amount num owe-text">' + money(owed) + '</div></span>' : '') +
          '<button type="button" class="btn soft small" data-restore-c="' + esc(c.id) + '">' + icon('undo') + esc(t('restoreItem')) + '</button></div>' };
      }).concat(es.map(function (e) {
        var c = findCustomer(e.customerId);
        var isDebt = e.type === 'debt';
        return { at: e.deletedAt, html: '<div class="item wrap"><span class="tx-icon ' + e.type + '">' + icon(isDebt ? 'basket' : 'cash') + '</span>' +
          '<span class="main"><div class="title">' + esc(c ? c.name : '?') + ' · <span class="num ' + (isDebt ? 'owe-text' : 'paid-text') + '">' + money(e.amount) + '</span></div>' +
          '<div class="meta">' + esc(niceDate(e.date) + ' · ' + t('daysLeft', { n: daysLeft(e) })) + '</div></span>' +
          '<button type="button" class="btn soft small" data-restore-e="' + esc(e.id) + '">' + icon('undo') + esc(t('restoreItem')) + '</button></div>' };
      })).sort(function (a, b) { return b.at - a.at; });
      html += '<div class="list-card">' + rows.map(function (r) { return r.html; }).join('') + '</div>';
    }
    app.innerHTML = html;

    app.querySelectorAll('[data-restore-c]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = findCustomer(b.dataset.restoreC);
        if (!c) return;
        var back = data.entries.filter(function (x) { return binnedWith(x, c); });
        delete c.deletedAt;
        back.forEach(function (x) { delete x.deletedAt; });
        changed(function (cl) {
          cl.putBatch({ customers: [normC(c)], entries: back.map(normE) });
        });
        render(); toast(t('restoredItem'));
      });
    });
    app.querySelectorAll('[data-restore-e]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = data.entries.find(function (x) { return x.id === b.dataset.restoreE; });
        if (!e) return;
        delete e.deletedAt;
        changed(function (cl) { cl.putEntry(normE(e)); });
        render(); toast(t('restoredItem'));
      });
    });
  }

  // ---------- Admin: who uses the app ----------
  var adminCache = null;
  function renderAdmin() {
    frame({ title: t('adminTitle'), back: true });
    if (!isAdmin() || !cloud()) { location.replace('#/settings'); return; }
    if (!adminCache) {
      app.innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>';
      cloud().adminStats().then(function (list) {
        adminCache = { at: Date.now(), list: list };
        if (location.hash === '#/admin') render();
      }).catch(function (e) {
        console.error(e);
        app.innerHTML = '<div class="list-card">' + emptyState('alert', '', t('adminFailed') + ' (' + (e.code || e.message) + ')') + '</div>';
      });
      return;
    }
    var now = Date.now();
    var list = adminCache.list.slice().sort(function (a, b) { return (b.lastOpen || 0) - (a.lastOpen || 0); });
    var within = function (ms) { return list.filter(function (x) { return x.lastOpen && now - x.lastOpen < ms; }).length; };
    var newWeek = list.filter(function (x) { return x.firstSeen && now - x.firstSeen < 7 * DAY; }).length;
    var stat = function (label, val, chip, ic) {
      return '<div class="stat"><div class="top"><span class="chip ' + chip + '">' + icon(ic) + '</span>' + esc(label) + '</div>' +
        '<div class="val num">' + val + '</div></div>';
    };
    var ago = function (ms) {
      if (!ms) return '—';
      var m = Math.round((now - ms) / 60000);
      if (m < 60) return t('agoMin', { n: Math.max(1, m) });
      var h = Math.round(m / 60);
      if (h < 48) return t('agoHour', { n: h });
      return t('agoDay', { n: Math.round(h / 24) });
    };
    var plat = { android: 'Android', iphone: 'iPhone', computer: 'PC' };
    var html =
      '<div class="report-grid">' +
        '<div class="stat wide"><div class="top"><span class="chip brand">' + icon('store') + '</span>' + esc(t('adminShops')) + '</div>' +
          '<div class="val num" style="font-size:30px">' + list.length + '</div>' +
          '<div class="top" style="margin-top:4px">' + esc(t('adminNewWeek', { n: newWeek })) + '</div></div>' +
        stat(t('adminToday'), within(DAY), 'paid', 'check') +
        stat(t('adminWeek'), within(7 * DAY), 'brand', 'users') +
        stat(t('adminMonth'), within(30 * DAY), 'brand', 'chart') +
        stat(t('adminRecords'), list.reduce(function (n, x) { return n + (x.entries || 0); }, 0).toLocaleString('en-KE'), 'owe', 'basket') +
      '</div>' +
      '<div class="section-head"><h2>' + esc(t('adminList')) + '</h2>' +
        '<button type="button" class="link-btn" id="adminRefresh">' + icon('undo') + ' ' + esc(t('refresh')) + '</button></div>';
    html += list.length
      ? '<div class="list-card">' + list.map(function (x) {
          var name = x.shopName || t('adminNoName');
          return '<div class="item wrap"><span class="avatar">' + (x.shopName ? esc(initials(name)) : icon('store')) + '</span>' +
            '<span class="main"><div class="title">' + esc(name) + '</div>' +
            '<div class="meta">' + esc(t('adminCounts', { c: x.customers || 0, e: x.entries || 0 })) + ' · ' +
              esc((plat[x.platform] || '') + (x.version ? ' · v' + x.version : '')) + '</div></span>' +
            '<span class="end"><div class="meta">' + esc(ago(x.lastOpen)) + '</div></span></div>';
        }).join('') + '</div>'
      : '<div class="list-card">' + emptyState('users', '', t('adminEmpty')) + '</div>';
    html += '<p class="hint">' + icon('shield') + ' ' + esc(t('adminPrivacy')) + '</p>';
    app.innerHTML = html;
    document.getElementById('adminRefresh').addEventListener('click', function () { adminCache = null; render(); });
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
            (cloudErrorCode
              ? '<span class="status-pill bad">' + icon('alert') + esc(t('notSaving')) + '</span>' +
                '<div class="meta" style="margin-top:6px">' + esc(t('notSavingHelp', { code: cloudErrorCode })) + '</div>'
              : '<span class="status-pill">' + icon('check') + esc(t('synced')) + '</span>') + '</div></div>' +
          (isAdmin()
            ? '<button type="button" class="row-btn" data-go="#/admin"><span class="chip">' + icon('chart') + '</span>' +
                '<span class="main">' + esc(t('adminTitle')) + '<span class="meta">' + esc(t('adminSub')) + '</span></span>' + icon('chevron') + '</button>'
            : '') +
          '<button type="button" class="row-btn danger" data-signout><span class="chip">' + icon('logout') + '</span>' +
            '<span class="main">' + esc(t('signOut')) + '</span></button>' +
        '</div>';
      } else {
        html += signInCardHtml();
      }
    }

    if (account) html += '<p class="hint">' + icon('shield') + ' ' + esc(t('privacyNote')) + '</p>';

    html += '<div class="group-title">' + esc(t('pinSection')) + '</div>' +
      '<div class="list-card">' + (hasPin()
        ? '<div class="account"><span class="avatar" style="background:var(--paid-soft);color:var(--paid)">' + icon('lock') + '</span>' +
            '<div class="main"><div class="name">' + esc(t('pinOnTitle')) + '</div><div class="meta">' + esc(t('pinOn')) + '</div></div></div>' +
          '<button type="button" class="row-btn" id="pinChangeBtn"><span class="chip">' + icon('edit') + '</span><span class="main">' + esc(t('pinChange')) + '</span>' + icon('chevron') + '</button>' +
          '<button type="button" class="row-btn danger" id="pinOffBtn"><span class="chip">' + icon('x') + '</span><span class="main">' + esc(t('pinTurnOff')) + '</span></button>'
        : '<button type="button" class="row-btn" data-set-pin><span class="chip">' + icon('lock') + '</span>' +
            '<span class="main">' + esc(t('pinTurnOn')) + '<span class="meta">' + esc(t('pinOffExplain')) + '</span></span>' + icon('chevron') + '</button>') +
      '</div>';

    html += '<div class="group-title">' + esc(t('language')) + '</div>' + langSegmented();

    html += '<div class="group-title">' + esc(t('shop')) + '</div>' +
      '<form class="list-card form-pad" id="settingsForm">' +
        '<label for="s-name">' + esc(t('shopName')) + '</label>' +
        '<input id="s-name" name="shopName" maxlength="60" value="' + esc(s.shopName) + '" placeholder="' + esc(t('shopNamePh')) + '">' +
        '<label for="s-cur">' + esc(t('currency')) + '</label>' +
        '<input id="s-cur" name="currency" maxlength="8" value="' + esc(s.currency) + '" placeholder="KSh">' +
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
      '<div class="group-title">' + esc(t('binTitle')) + '</div>' +
      '<div class="list-card"><button type="button" class="row-btn" data-go="#/bin"><span class="chip">' + icon('trash') + '</span>' +
        '<span class="main">' + esc(t('binTitle')) + '<span class="meta">' + esc(t('binCount', { n: binCount() })) + '</span></span>' + icon('chevron') + '</button></div>' +
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
      askPin(t('confirmRestore', { c: incoming.customers.length, e: incoming.entries.length })).then(function (ok) {
      if (!ok) return;
      incoming.owner = data.owner;
      incoming.settings = Object.assign({}, data.settings, raw.settings ? incoming.settings : {}, { lang: data.settings.lang });
      incoming.lastBackup = data.lastBackup;
      data = incoming;
      changed(function (cl) { cl.replaceAll({ customers: data.customers.map(normC), entries: data.entries.map(normE), settings: data.settings }); });
      applyStaticText();
      toast(t('restored'));
      if (location.hash === '#/' || !location.hash) render(); else location.hash = '#/';
      });
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
      var rows = liveCustomers().map(function (c) {
        var taken = 0, paid = 0;
        liveEntries().forEach(function (e) {
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
      liveEntries().sort(function (a, b) {
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
    // Not needed when signed in, and not shown while the sign-in card is
    // (signing in is the better protection and keeps the screen simple).
    var signInOffered = cloudAvailable && authKnown && !account;
    if (account || signInOffered || !data.entries.length || days < BACKUP_REMIND_DAYS) {
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
  purgeBin();
  render();
  lockNow();
})();
