/* Excel files for Deyn Book. Built into ../excel.bundle.js (npm run build)
 * and only loaded when someone downloads or restores a file.
 *
 * Every Excel file the app makes is also a backup: besides the sheets people
 * read, it holds a hidden sheet with the exact records, so "Restore" can
 * put them back into the app without losing anything.
 */
import { utils, write, read } from 'xlsx';

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

// Returns the records saved in a Deyn Book Excel file, or null.
// Uses the hidden sheet when present; otherwise rebuilds the records from
// the visible sheets (sheet 1: customers, sheet 2: history), so a file that
// was opened and re-saved in another program still works.
export function readBackup(arrayBuffer, debtLabels, skipNames) {
  const wb = read(arrayBuffer, { type: 'array' });
  const hidden = wb.Sheets[DATA_SHEET];
  if (hidden) {
    const rows = utils.sheet_to_json(hidden, { header: 1 });
    const json = rows.slice(1).map((r) => r[0] || '').join('');
    try { return JSON.parse(json); } catch (e) { /* fall through */ }
  }
  if (wb.SheetNames.length < 2) return null;
  const custRows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }).slice(1);
  const histRows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[1]], { header: 1, raw: false }).slice(1);
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
