/* Excel files for Deyn Book. Built into ../excel.bundle.js (npm run build)
 * and only loaded when someone downloads or restores a file.
 *
 * Every Excel file the app makes is also a backup: besides the sheets people
 * read, it holds a hidden sheet with the exact records, so "Restore" can
 * put them back into the app without losing anything.
 *
 * Writing uses SheetJS. Reading does NOT: SheetJS 0.18.5 (the last version
 * on npm) has known problems when reading crafted files, so files chosen
 * for Restore are read by the small, strict reader below instead.
 */
import { utils, write } from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';

const DATA_SHEET = 'deynbook_data';
const CHUNK = 30000; // Excel cells hold at most 32,767 characters

// sheets: [{ name, rows: [[...header], [...], ...], widths: [chars...] }]
export function makeWorkbook(sheets, backupData) {
  const wb = utils.book_new();
  sheets.forEach((s) => {
    const ws = utils.aoa_to_sheet(s.rows);
    if (s.widths) ws['!cols'] = s.widths.map((w) => ({ wch: w }));
    utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  });
  if (backupData) {
    const json = JSON.stringify(backupData);
    const rows = [['Deyn Book backup - do not edit']];
    for (let i = 0; i < json.length; i += CHUNK) rows.push([json.slice(i, i + CHUNK)]);
    utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), DATA_SHEET);
    wb.Workbook = { Sheets: wb.SheetNames.map((n) => ({ Hidden: n === DATA_SHEET ? 1 : 0 })) };
  }
  const out = write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- Strict .xlsx reader (for Restore) ----------
const MAX_FILE = 20 * 1024 * 1024;      // 20 MB file
const MAX_PART = 60 * 1024 * 1024;      // 60 MB once unzipped (zip-bomb guard)

function readXlsx(arrayBuffer) {
  if (arrayBuffer.byteLength > MAX_FILE) throw new Error('file too large');
  let total = 0;
  const files = unzipSync(new Uint8Array(arrayBuffer), {
    filter: (f) => {
      const want = f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' ||
        f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name);
      if (!want) return false;
      total += f.originalSize;
      if (total > MAX_PART) throw new Error('file too large');
      return true;
    }
  });
  const xml = (name) => files[name] ? new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml') : null;
  const all = (doc, tag) => doc ? Array.from(doc.getElementsByTagNameNS('*', tag)) : [];
  const textOf = (el) => all(el, 't').map((t) => t.textContent).join('');

  const shared = all(xml('xl/sharedStrings.xml'), 'si').map(textOf);
  const rels = {};
  all(xml('xl/_rels/workbook.xml.rels'), 'Relationship').forEach((r) => {
    rels[r.getAttribute('Id')] = r.getAttribute('Target').replace(/^\/?(xl\/)?/, 'xl/');
  });
  const colIndex = (ref) => {
    const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const sheets = [];
  all(xml('xl/workbook.xml'), 'sheet').forEach((sh) => {
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const doc = xml(rels[rid]);
    const rows = [];
    all(doc, 'row').forEach((row) => {
      const r = Number(row.getAttribute('r')) - 1;
      const cells = [];
      all(row, 'c').forEach((c) => {
        const type = c.getAttribute('t');
        const v = all(c, 'v')[0];
        let val;
        if (type === 's') val = shared[Number(v && v.textContent)];
        else if (type === 'inlineStr') val = textOf(c);
        else val = v ? v.textContent : undefined;
        if (val !== undefined) cells[colIndex(c.getAttribute('r') || 'A')] = val;
      });
      if (r >= 0 && r < 1e6) rows[r] = cells;
    });
    sheets.push({ name: sh.getAttribute('name') || '', rows: Array.from(rows, (x) => x || []) });
  });
  return sheets;
}

// Returns the records saved in a Deyn Book Excel file, or null.
// Uses the hidden sheet when present; otherwise rebuilds the records from
// the visible sheets (sheet 1: customers, sheet 2: history), so a file that
// was opened and re-saved in another program still works.
export function readBackup(arrayBuffer, debtLabels, skipNames) {
  const sheets = readXlsx(arrayBuffer);
  const hidden = sheets.find((s) => s.name === DATA_SHEET);
  if (hidden) {
    const json = hidden.rows.slice(1).map((r) => r[0] || '').join('');
    try { return JSON.parse(json); } catch (e) { /* fall through */ }
  }
  const visible = sheets.filter((s) => s.name !== DATA_SHEET);
  if (visible.length < 2) return null;
  const custRows = visible[0].rows.slice(1);
  const histRows = visible[1].rows.slice(1);
  const isDebt = new Set(debtLabels.map((s) => s.toLowerCase()));
  const now = new Date().toISOString();
  let n = 0;
  const id = () => 'x' + Date.now().toString(36) + (n++).toString(36);
  const byName = {};
  const customers = [];
  const addCustomer = (name, phone, place) => {
    const c = { id: id(), name, phone: phone || '', place: place || '', createdAt: now };
    byName[name] = c; customers.push(c); return c;
  };
  const skip = new Set(skipNames.map((s) => s.toLowerCase()));
  custRows.forEach((r) => {
    const name = String(r[0] || '').trim();
    if (!name || byName[name] || skip.has(name.toLowerCase())) return; // empty, repeated or TOTAL row
    addCustomer(name, String(r[1] || '').trim(), String(r[2] || '').trim());
  });
  const entries = [];
  histRows.forEach((r) => {
    const name = String(r[1] || '').trim();
    const amount = Math.round(parseFloat(String(r[3] || '').replace(/,/g, '')) * 100);
    if (!name || !isFinite(amount) || amount <= 0) return;
    const c = byName[name] || addCustomer(name, '', '');
    entries.push({
      id: id(), customerId: c.id,
      type: isDebt.has(String(r[2] || '').trim().toLowerCase()) ? 'debt' : 'payment',
      amount, note: String(r[4] || ''), date: String(r[0] || '').slice(0, 10), createdAt: now
    });
  });
  if (!customers.length && !entries.length) return null;
  return { customers, entries };
}
