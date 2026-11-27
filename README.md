# Debt Book

A simple phone app for a small shop to replace the paper debt book.

- Add customers (name, phone).
- Record **"Took debt"** (what they took and how much) and **"Paid back"**.
- See each customer's balance and the total that everyone owes.
- Send a reminder by WhatsApp or SMS with one tap.
- **Back up** to WhatsApp, Google Drive or email, and **restore** on a new phone.
- Works **without internet** once it has been opened, and can be installed on the home screen.

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

Plain HTML/CSS/JavaScript with no build step. To run it locally:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.
