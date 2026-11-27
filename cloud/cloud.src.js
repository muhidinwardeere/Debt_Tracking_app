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
  signInWithRedirect, signOut, connectAuthEmulator, signInWithCredential
} from 'firebase/auth';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, setDoc, deleteDoc,
  waitForPendingWrites, connectFirestoreEmulator, getDocs
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

  const userPath = (...parts) => ['users', user.uid, ...parts].join('/');
  const MAX_BATCH = 400;

  // Firestore refuses `undefined`, so keep only plain values.
  function clean(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => {
      if (k === 'id') return;
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
  function quiet(p) { p.catch((e) => console.error('Cloud write failed', e)); }

  function stopListening() {
    unsubs.forEach((u) => u());
    unsubs = [];
  }

  function listen() {
    stopListening();
    const onErr = (e) => { console.error(e); App.cloudError(e); };
    unsubs.push(onSnapshot(collection(db, userPath('customers')), (snap) => {
      App.applyRemote({ customers: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }, snap.metadata);
    }, onErr));
    unsubs.push(onSnapshot(collection(db, userPath('entries')), (snap) => {
      App.applyRemote({ entries: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }, snap.metadata);
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

  onAuthStateChanged(auth, (u) => {
    const prev = user;
    user = u;
    if (!u) {
      stopListening();
      App.onAuth(null);
      return;
    }
    const local = App.takeLocalForUpload(u.uid);
    if (local) {
      App.toastKey('uploading');
      uploadLocal(local).then(() => App.toastKey('uploaded')).catch((e) => console.error(e));
    }
    App.onAuth({ uid: u.uid, email: u.email, name: u.displayName }, !prev);
    listen();
  });

  window.DeynCloud = {
    isSignedIn: () => !!user,

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
    async signOut() {
      const timeout = new Promise((res) => setTimeout(() => res('timeout'), 6000));
      const done = await Promise.race([waitForPendingWrites(db).then(() => 'ok'), timeout]);
      if (done !== 'ok') return false;
      stopListening();
      await signOut(auth);
      return true;
    },

    putCustomer(c) { quiet(setDoc(doc(db, userPath('customers', c.id)), clean(c))); },
    putEntry(e) { quiet(setDoc(doc(db, userPath('entries', e.id)), clean(e))); },
    deleteEntry(id) { quiet(deleteDoc(doc(db, userPath('entries', id)))); },

    deleteCustomer(id, entryIds) {
      const ops = [(b) => b.delete(doc(db, userPath('customers', id)))];
      entryIds.forEach((eid) => ops.push((b) => b.delete(doc(db, userPath('entries', eid)))));
      quiet(commitInChunks(ops));
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
      cs.docs.forEach((d) => { if (!keepC.has(d.id)) ops.push((b) => b.delete(d.ref)); });
      es.docs.forEach((d) => { if (!keepE.has(d.id)) ops.push((b) => b.delete(d.ref)); });
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
