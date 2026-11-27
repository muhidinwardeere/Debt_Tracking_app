/* Cloud saving for Deyn Book (Firebase Auth + Firestore).
 *
 * Built into ../cloud.bundle.js with `npm run build` so the app does not
 * depend on Google's script servers and keeps working offline.
 *
 * Talks to app.js through window.DeynApp (the app) and window.DeynCloud
 * (this file). If this file fails to load, the app still works with
 * records kept only on the phone.
 *
 * Layout in Firestore, one folder per signed-in shop owner:
 *   users/{uid}/customers/{id}   name, phone, place, createdAt
 *   users/{uid}/entries/{id}     customerId, type, amount, note, date, createdAt
 *   users/{uid}/meta/settings    shopName, currency
 */
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, signOut, connectAuthEmulator, signInWithCredential,
  reauthenticateWithPopup, reauthenticateWithCredential
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, collectionGroup, doc, onSnapshot, writeBatch, setDoc, deleteDoc, getDoc,
  waitForPendingWrites, connectFirestoreEmulator, getDocs, terminate, clearIndexedDbPersistence,
  serverTimestamp
} from 'firebase/firestore';

const config = window.DEYN_FIREBASE_CONFIG;
const App = window.DeynApp;

if (config && App) start();

function start() {
  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try {
    // Keeps a copy on the phone so it works offline and syncs later.
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    db = initializeFirestore(app, {});
  }

  // Local testing only: http://localhost:8000/?emulator=1
  const emulator = /[?&]emulator=1/.test(location.search) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (emulator) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  let user = null;
  let unsubs = [];
  let relistenTimer = null;
  const RELISTEN_MS = emulatorRelisten() || 60000;
  // Local testing only: ?relisten=4000 shortens the wait.
  function emulatorRelisten() {
    const m = location.search.match(/[?&]relisten=(\d+)/);
    return m && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? Number(m[1]) : 0;
  }

  const userPath = (...parts) => ['users', user.uid, ...parts].join('/');
  const MAX_BATCH = 400;

  // Firestore refuses `undefined`, so keep only plain values.
  // deletedAt (recycle bin) is always set from the server's clock: the
  // rules check it, so nobody can backdate it to delete records early.
  function clean(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => {
      if (k === 'id') return;
      if (k === 'deletedAt') { if (obj.deletedAt) out.deletedAt = serverTimestamp(); return; }
      const v = obj[k];
      if (v === undefined || typeof v === 'function') return;
      out[k] = v;
    });
    return out;
  }

  // All batches are started at once (not one after another), so they all
  // land on the phone copy immediately even when offline.
  function commitInChunks(ops) {
    const commits = [];
    for (let i = 0; i < ops.length; i += MAX_BATCH) {
      const batch = writeBatch(db);
      ops.slice(i, i + MAX_BATCH).forEach((op) => op(batch));
      commits.push(batch.commit());
    }
    return Promise.all(commits);
  }

  // Writes are applied to the phone copy straight away; the returned
  // promise only finishes once the server has them, so callers don't wait.
  // A refused upload is reported to the app, which keeps the record on the
  // phone and tries again later.
  function quiet(p) {
    p.catch((e) => {
      console.error('Cloud write failed', e);
      App.writeFailed(e);
    });
  }

  function stopListening() {
    unsubs.forEach((u) => u());
    unsubs = [];
  }

  // _pending: this record's upload has not been confirmed by the server yet.
  const withMeta = (d) => {
    const x = d.data({ serverTimestamps: 'estimate' });
    if (x.deletedAt && typeof x.deletedAt.toMillis === 'function') x.deletedAt = x.deletedAt.toMillis();
    return { ...x, id: d.id, _pending: d.metadata.hasPendingWrites };
  };

  // Listen for server snapshots including "upload confirmed" changes, so the
  // app learns as soon as a record is safely online.
  const LISTEN = { includeMetadataChanges: true };

  function listen() {
    stopListening();
    // A refused or broken connection stops the live updates; try again in a
    // minute (and retry any uploads then), so a fixed problem heals itself.
    const onErr = (e) => {
      console.error(e);
      App.cloudError(e);
      if (relistenTimer) return;
      relistenTimer = setTimeout(() => {
        relistenTimer = null;
        if (!user) return;
        listen();
        window.DeynCloud.retryUpload();
      }, RELISTEN_MS);
    };
    unsubs.push(onSnapshot(collection(db, userPath('customers')), LISTEN, (snap) => {
      App.applyRemote({ customers: snap.docs.map(withMeta) }, snap.metadata);
    }, onErr));
    unsubs.push(onSnapshot(collection(db, userPath('entries')), LISTEN, (snap) => {
      App.applyRemote({ entries: snap.docs.map(withMeta) }, snap.metadata);
    }, onErr));
    unsubs.push(onSnapshot(doc(db, userPath('meta', 'settings')), (snap) => {
      if (snap.exists()) App.applyRemote({ settings: snap.data() }, snap.metadata);
    }, onErr));
  }

  // First sign-in on this phone: send up what was typed before signing in.
  // Records have unique ids, so this adds to (never overwrites) what is
  // already online from another phone.
  function uploadLocal(local) {
    const ops = [];
    local.customers.forEach((c) => ops.push((b) => b.set(doc(db, userPath('customers', c.id)), clean(c))));
    local.entries.forEach((e) => ops.push((b) => b.set(doc(db, userPath('entries', e.id)), clean(e))));
    if (local.settings && (local.settings.shopName || local.settings.currency)) {
      ops.push((b) => b.set(doc(db, userPath('meta', 'settings')), {
        shopName: local.settings.shopName || '', currency: local.settings.currency || ''
      }, { merge: true }));
    }
    if (!ops.length) return Promise.resolve(0);
    return commitInChunks(ops).then(() => ops.length);
  }

  function startUpload(local) {
    App.toastKey('uploading');
    uploadLocal(local).then((n) => {
      if (n) App.toastKey('uploaded');
      App.uploadDone();
    }).catch((e) => { console.error(e); App.writeFailed(e); });
  }

  onAuthStateChanged(auth, (u) => {
    const prev = user;
    user = u;
    if (!u) {
      stopListening();
      App.onAuth(null);
      return;
    }
    const local = App.takeLocalForUpload(u.uid);
    if (local) startUpload(local);
    App.onAuth({ uid: u.uid, email: u.email, name: u.displayName }, !prev);
    listen();
  });

  window.DeynCloud = {
    isSignedIn: () => !!user,

    // "Forgot PIN": prove you are the owner by signing in with Google
    // again. Resolves true only for the same account (never switches).
    async reauth() {
      if (!auth.currentUser) return false;
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        if (emulator && window.__testReauthEmail) {
          await reauthenticateWithCredential(auth.currentUser, GoogleAuthProvider.credential(
            JSON.stringify({ sub: window.__testReauthEmail, email: window.__testReauthEmail, email_verified: true })));
        } else {
          await reauthenticateWithPopup(auth.currentUser, provider);
        }
        return true;
      } catch (e) {
        console.error(e);
        return false;
      }
    },

    // Send records the server has not confirmed (see app.js mergeRemote).
    retryUpload() {
      if (!user) return;
      const local = App.takeLocalForUpload(user.uid);
      if (local) startUpload(local);
    },

    signIn() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      return signInWithPopup(auth, provider).catch((e) => {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
          return signInWithRedirect(auth, provider);
        }
        if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return null;
        throw e;
      });
    },

    // Refuses (returns false) while changes are still waiting to upload,
    // so signing out never loses records.
    // True once every change made on this phone has reached the server
    // (false if that takes longer than `ms`, e.g. no internet).
    async waitUploads(ms) {
      const timeout = new Promise((res) => setTimeout(() => res('timeout'), ms));
      return (await Promise.race([waitForPendingWrites(db).then(() => 'ok'), timeout])) === 'ok';
    },

    async signOut() {
      if (!(await window.DeynCloud.waitUploads(30000))) return false;
      stopListening();
      await signOut(auth);
      // Also wipe Firebase's own offline copy from this phone, so the next
      // person using it cannot dig the records out. The page reloads after.
      try {
        await terminate(db);
        await clearIndexedDbPersistence(db);
      } catch (e) { console.error(e); }
      return true;
    },

    putCustomer(c) { quiet(setDoc(doc(db, userPath('customers', c.id)), clean(c))); },
    putEntry(e) { quiet(setDoc(doc(db, userPath('entries', e.id)), clean(e))); },
    // Permanent removal of records that have been in the recycle bin long
    // enough (the server refuses anything younger). list: [[collection, id]]
    purge(list) {
      const ops = list.map(([coll, id]) => (b) => b.delete(doc(db, userPath(coll, id))));
      quiet(commitInChunks(ops));
    },

    // Several records in one write, so they get the same server time
    // (a customer and their records moved to / from the bin together).
    putBatch({ customers = [], entries = [] }) {
      const ops = [];
      customers.forEach((c) => ops.push((b) => b.set(doc(db, userPath('customers', c.id)), clean(c))));
      entries.forEach((e) => ops.push((b) => b.set(doc(db, userPath('entries', e.id)), clean(e))));
      quiet(commitInChunks(ops));
    },

    // Usage counts for the app owner's admin page: shop name and how many
    // customers/records, never names or amounts. Written at most every
    // few hours. firstSeen is set once.
    async putStats(st) {
      const ref = doc(db, userPath('stats', 'summary'));
      let isNew = false;
      try { isNew = !(await getDoc(ref)).exists(); } catch (e) { return false; }
      const out = {
        shopName: st.shopName, customers: st.customers, entries: st.entries,
        lang: st.lang, version: st.version, platform: st.platform,
        lastOpen: serverTimestamp()
      };
      if (isNew) out.firstSeen = serverTimestamp();
      // Not a shop record: if it fails, just try again another time
      // (no warning, no re-upload of records).
      // Resolves true once the server has them, false if refused.
      return setDoc(ref, out, { merge: true }).then(() => true, (e) => {
        console.warn('Usage counts not sent', e.code);
        return false;
      });
    },

    // Admin page: every shop's usage counts (the rules allow this only for
    // the accounts listed as admins).
    async adminStats() {
      const snap = await getDocs(collectionGroup(db, 'stats'));
      return snap.docs.map((d) => {
        const x = d.data();
        const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : 0);
        return { ...x, lastOpen: ms(x.lastOpen), firstSeen: ms(x.firstSeen) };
      });
    },

    putSettings(s) {
      quiet(setDoc(doc(db, userPath('meta', 'settings')), {
        shopName: s.shopName || '', currency: s.currency || ''
      }, { merge: true }));
    },

    // Restore from a backup file: make the online copy match it exactly.
    async replaceAll(data) {
      const [cs, es] = await Promise.all([
        getDocs(collection(db, userPath('customers'))),
        getDocs(collection(db, userPath('entries')))
      ]);
      const keepC = new Set(data.customers.map((c) => c.id));
      const keepE = new Set(data.entries.map((e) => e.id));
      const ops = [];
      // Records not in the backup go to the recycle bin (never deleted).
      const toBin = (d) => (b) => b.set(d.ref, { deletedAt: serverTimestamp() }, { merge: true });
      cs.docs.forEach((d) => { if (!keepC.has(d.id) && !d.data().deletedAt) ops.push(toBin(d)); });
      es.docs.forEach((d) => { if (!keepE.has(d.id) && !d.data().deletedAt) ops.push(toBin(d)); });
      data.customers.forEach((c) => ops.push((b) => b.set(doc(db, userPath('customers', c.id)), clean(c))));
      data.entries.forEach((e) => ops.push((b) => b.set(doc(db, userPath('entries', e.id)), clean(e))));
      ops.push((b) => b.set(doc(db, userPath('meta', 'settings')), {
        shopName: data.settings.shopName || '', currency: data.settings.currency || ''
      }, { merge: true }));
      quiet(commitInChunks(ops));
    }
  };

  // Emulator only: sign in as a fake Google user without the popup.
  if (emulator) {
    window.DeynCloud.testSignIn = (email) => signInWithCredential(auth,
      GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: true })));
  }

  App.cloudReady();
}
