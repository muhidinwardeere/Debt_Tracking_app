/* Excel export for Deyn Book. Built into ../excel.bundle.js (npm run build)
 * and only loaded when someone taps "Download Excel". */
import { utils, write } from 'xlsx';

// sheets: [{ name, rows: [[...header], [...], ...], widths: [chars...] }]
export function makeWorkbook(sheets) {
  const wb = utils.book_new();
  sheets.forEach((s) => {
    const ws = utils.aoa_to_sheet(s.rows);
    if (s.widths) ws['!cols'] = s.widths.map((w) => ({ wch: w }));
    utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  });
  const out = write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
