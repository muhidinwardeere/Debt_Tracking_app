# Deyn Book

A simple phone app for a small shop to replace the paper debt book.

- Add customers (name, phone).
- Record **"Took debt"** (what they took and how much) and **"Paid back"**.
- See each customer's balance and the total that everyone owes.
- Send a reminder by WhatsApp or SMS with one tap.
- **Back up** to WhatsApp, Google Drive or email, and **restore** on a new phone.
- Languages: **Somali (Soomaali)** and **English**; translations are in `i18n.js`.
- Works **without internet** once it has been opened, and can be installed on the home screen.

## Saving online (sign in with Google)

Tap **Ku gal Google / Sign in with Google**. Records are then saved online
automatically (Firebase), and the app still works with no internet: changes
upload when the signal comes back. On a new phone, sign in with the same
Google account and everything comes back. Each account can only see its own
records (see `firestore.rules`).

## Security and data safety

- **Each account sees only its own records.** `firestore.rules` allows a
  signed-in user to read and write only under `users/{their id}/`, and only
  records with the expected fields, types and sizes (amounts must be whole
  positive numbers, dates `YYYY-MM-DD`, limited text lengths). Paste this
  file into Firebase → Firestore → Rules after any change.
- **Records are never lost because of the server.** The app remembers which
  records the server has confirmed. A record the server refused or never
  received stays on the phone and is uploaded again (every minute while the
  problem lasts, and at each start). Only records the server had confirmed
  are removed when they disappear online (deleted on another phone).
- **Everything coming in is checked** (phone storage, the server, restored
  files): bad or oversized records are skipped.
- **Restore reads files with a strict built-in reader**, not SheetJS's reader
  (SheetJS 0.18.5 on npm has known issues reading crafted files).
- **Sign-out** only happens after all changes are uploaded, then removes the
  records and Firebase's offline copy from the phone.
- The values in `firebase-config.js` are public identifiers, not secrets.

## Keeping records safe

Records are saved on the phone itself. To protect them if the phone is lost:

1. Open **⚙ Settings → Back up now**.
2. Send the backup file to yourself (WhatsApp "Message yourself", Google Drive or email).
3. On a new phone, open the app, then **Settings → Restore from a backup file**.

The app reminds you when you have not made a backup for 3 days.

## Install on the phone

Open the app link in Chrome (Android) or Safari (iPhone), then:
- **Android:** menu ⋮ → *Add to Home screen* / *Install app*
- **iPhone:** Share → *Add to Home Screen*

## Development

Plain HTML/CSS/JavaScript. The only built file is `cloud.bundle.js`
(Firebase sign-in and saving), made from `cloud/cloud.src.js`:

```bash
npm install
npm run build
```

Test against local Firebase emulators (needs Java), then open
http://localhost:8000/?emulator=1:

```bash
npm run emulators
```

To run the app locally:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
