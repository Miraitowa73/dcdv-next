'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../cloud-test/vendor/xlsx.full.min');
const { parseCsv, normalizeRows, readFile, template } = require('../cloud-test/roster');
const file = (book, name = 'test.xlsx') => { const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }); return { name, size: bytes.length, arrayBuffer: async () => bytes }; };
const bookWith = sheet => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '名单'); return book; };
test('CSV retains leading zeros, BOM, quotes and embedded commas', () => {
  assert.deepEqual(normalizeRows(parseCsv('\ufeff学号,姓名\r\n00123456,"甲,乙"\r\n')), [{ studentNumber: '00123456', name: '甲,乙' }]);
  assert.throws(() => parseCsv('学号,姓名\n00123456,"未结束'), /引号/);
  assert.throws(() => normalizeRows([['账号', '姓名'], ['00123456', '甲']]), /学号/);
  assert.throws(() => normalizeRows([['学号', '姓名'], ...Array.from({ length: 501 }, () => ['20260001', '甲'])]), /500/);
});
test('Excel templates use text IDs; real XLSX round-trip preserves zeros', async () => {
  const book = template(XLSX); const sheet = book.Sheets['学生名单'];
  assert.equal(sheet.A2.z, '@'); sheet.A2.v = '00123456'; sheet.B2 = { t: 's', v: '张同学' };
  assert.deepEqual(await readFile(file(book), XLSX), [{ studentNumber: '00123456', name: '张同学' }]);
});
test('Excel rejects formulas, unsafe numeric IDs, excess rows and unsupported files', async () => {
  const formula = XLSX.utils.aoa_to_sheet([['学号', '姓名'], ['00123456', '甲']]); formula.A2 = { f: '1+1', t: 'n', v: 2 };
  await assert.rejects(readFile(file(bookWith(formula)), XLSX), /公式/);
  const numeric = XLSX.utils.aoa_to_sheet([['学号', '姓名'], [123456789012345678, '甲']]);
  await assert.rejects(readFile(file(bookWith(numeric)), XLSX), /精度/);
  const tooMany = XLSX.utils.aoa_to_sheet([['学号', '姓名'], ...Array.from({ length: 501 }, () => ['20260001', '甲'])]);
  await assert.rejects(readFile(file(bookWith(tooMany)), XLSX), /500/);
  await assert.rejects(readFile({ name: 'student.xls', size: 10 }, XLSX), /仅支持/);
  await assert.rejects(readFile({ name: 'student.xlsx', size: 3 * 1024 * 1024 }, XLSX), /2 MB/);
});
