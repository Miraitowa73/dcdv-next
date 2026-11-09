(function (root, factory) { const api = factory(); if (typeof module === 'object') module.exports = api; if (root) root.DcdvRoster = api; })(typeof globalThis === 'undefined' ? this : globalThis, function () {
  'use strict';
  function parseCsv(text) {
    text = text.replace(/^\ufeff/, '');
    const rows = []; let row = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
      else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
        row.push(value); value = '';
        if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
      } else value += c;
      if (rows.length > 502) throw new Error('每次最多导入 500 人。');
    }
    if (quoted) throw new Error('CSV 引号不完整，请重新另存为 UTF-8 CSV。');
    if (value || row.length) { row.push(value); rows.push(row); }
    return rows;
  }
  function normalizeRows(matrix) {
    const header = matrix[0]?.map(value => String(value).trim()) || [];
    if (header.filter(value => value === '学号').length !== 1 || header.filter(value => value === '姓名').length !== 1) throw new Error('第一行必须包含且仅包含一列“学号”和一列“姓名”。');
    const numberIndex = header.indexOf('学号'), nameIndex = header.indexOf('姓名');
    const rows = matrix.slice(1).filter(row => row.some(value => String(value ?? '').trim())).map(row => ({ studentNumber: String(row[numberIndex] ?? '').trim(), name: String(row[nameIndex] ?? '').trim() }));
    if (!rows.length || rows.length > 500) throw new Error('名单需包含 1–500 名学生。');
    return rows;
  }
  async function readFile(file, XLSX) {
    if (!file || file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MB 的 XLSX 或 UTF-8 CSV 名单。');
    if (/\.csv$/i.test(file.name)) return normalizeRows(parseCsv(await file.text()));
    if (!/\.xlsx$/i.test(file.name)) throw new Error('仅支持 .xlsx 和 .csv 文件。');
    if (!XLSX) throw new Error('Excel 组件尚未加载，请刷新或改用 CSV。');
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: 502, cellFormula: true, cellText: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
    if (range.e.r > 500 || range.e.c > 30) throw new Error('首个工作表最多包含 500 名学生，请删除额外行列后导入。');
    const matrix = [];
    for (let r = 0; r <= range.e.r; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell?.f) throw new Error(`第 ${r + 1} 行包含公式，请粘贴为文本值后导入。`);
        if (cell?.t === 'n' && (!Number.isSafeInteger(cell.v) || /e[+-]/i.test(cell.w || ''))) throw new Error(`第 ${r + 1} 行数字精度或格式不明确，请将学号设为文本并核对原始学号。`);
        row.push(cell ? String(cell.w ?? cell.v ?? '') : '');
      }
      matrix.push(row);
    }
    return normalizeRows(matrix);
  }
  function template(XLSX) {
    const sheet = XLSX.utils.aoa_to_sheet([['学号', '姓名']]);
    for (let row = 2; row <= 501; row++) sheet[`A${row}`] = { t: 's', v: '', z: '@' };
    sheet['!ref'] = 'A1:B501'; sheet['!cols'] = [{ wch: 28 }, { wch: 20 }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '学生名单');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['填写说明'], ['在首个工作表填写学号和姓名，每次最多 500 人。'], ['学号必须保留前导 0，不要使用公式或科学计数法。'], ['新账号的临时密码为学号后六位，首次登录强制修改。'], ['已有账号保留密码和进度。']]), '填写说明');
    return book;
  }
  return { parseCsv, normalizeRows, readFile, template };
});
