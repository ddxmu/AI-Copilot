// 替换规则的导入 / 导出：支持 .xlsx 与 .csv
// 零第三方依赖：xlsx 直接手写 OOXML（复用 office-replace 的 zip 读写能力）
const fs = require('fs');
const path = require('path');
const { readZipEntries, writeZipStore } = require('./office-replace');

const HEADERS = ['规则名称', '查找内容', '替换内容', '启用'];

/* ============ 通用工具 ============ */

function xmlEscape(s) {
  return String(s == null ? '' : s)
    // 去掉 XML 1.0 非法控制字符（保留 \t \n \r）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlUnescape(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// 列号 → 字母（1 → A, 27 → AA）
function colName(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 字母 → 列号（A → 1）
function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// 「启用」列的宽松解析：默认启用，只有明确否定才停用
function parseEnabled(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return true;
  return !['否', '停用', '禁用', '关', '关闭', 'false', 'no', 'n', '0', 'off', 'disabled'].includes(s);
}

/* ============ CSV ============ */

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(rules) {
  const lines = [HEADERS.map(csvCell).join(',')];
  for (const r of rules) {
    lines.push([
      csvCell(r.name || ''),
      csvCell(r.find || ''),
      csvCell(r.replace || ''),
      csvCell(r.enabled === false ? '否' : '是'),
    ].join(','));
  }
  // BOM：保证 Excel 打开中文不乱码
  return Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n', 'utf8');
}

// 手写 CSV 解析：支持引号包裹、引号内换行、"" 转义
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* ============ XLSX 写 ============ */

const XLSX_PARTS = {
  '[Content_Types].xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>',

  '_rels/.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>',

  'xl/workbook.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="替换规则" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>',

  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>',

  // 两种单元格格式：0=正文（自动换行+顶端对齐），1=表头（加粗+浅灰底）
  'xl/styles.xml':
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEFF3FB"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">' +
    '<alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>',
};

function buildXlsx(rules) {
  const rows = [HEADERS].concat(
    rules.map((r) => [r.name || '', r.find || '', r.replace || '', r.enabled === false ? '否' : '是'])
  );

  let sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cols>' +
    '<col min="1" max="1" width="22" customWidth="1"/>' +
    '<col min="2" max="2" width="40" customWidth="1"/>' +
    '<col min="3" max="3" width="40" customWidth="1"/>' +
    '<col min="4" max="4" width="10" customWidth="1"/>' +
    '</cols><sheetData>';

  rows.forEach((cells, ri) => {
    const rn = ri + 1;
    const style = ri === 0 ? '1' : '0';
    sheet += `<row r="${rn}">`;
    cells.forEach((val, ci) => {
      const ref = colName(ci + 1) + rn;
      sheet += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
    });
    sheet += '</row>';
  });
  sheet += '</sheetData></worksheet>';

  const entries = Object.entries(XLSX_PARTS).map(([name, xml]) => ({ name, data: Buffer.from(xml, 'utf8') }));
  entries.push({ name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') });
  return writeZipStore(entries);
}

/* ============ XLSX 读 ============ */

// sharedStrings.xml → 字符串数组（rich text 的多段 <t> 需要拼接）
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += xmlUnescape(t[1]);
    out.push(text);
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refM = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = refM ? colIndex(refM[1]) - 1 : cells.length;
      const typeM = /t="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : '';

      let val = '';
      if (type === 'inlineStr') {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) val += xmlUnescape(t[1]);
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vM ? xmlUnescape(vM[1]) : '';
        if (type === 's') {
          const i = parseInt(raw, 10);
          val = Number.isFinite(i) && shared[i] != null ? shared[i] : '';
        } else {
          val = raw;
        }
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function readXlsx(buf) {
  const entries = readZipEntries(buf);
  const find = (n) => entries.find((e) => e.name.toLowerCase() === n);
  const ss = find('xl/sharedstrings.xml');
  const shared = ss ? parseSharedStrings(ss.data.toString('utf8')) : [];

  // 取第一张工作表（优先 sheet1.xml）
  let sheet = find('xl/worksheets/sheet1.xml');
  if (!sheet) {
    sheet = entries
      .filter((e) => /^xl\/worksheets\/.+\.xml$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
  }
  if (!sheet) throw new Error('这个 Excel 里没有找到工作表');
  return parseSheet(sheet.data.toString('utf8'), shared);
}

/* ============ 行 → 规则 ============ */

const H_NAME = ['规则名称', '名称', '规则名', '规则', 'name', 'rule', 'rulename'];
const H_FIND = ['查找内容', '查找', '原文', '原内容', '被替换', '搜索', 'find', 'search', 'from', 'old'];
const H_REPL = ['替换内容', '替换', '新内容', '替换为', '目标', 'replace', 'to', 'new'];
const H_ENAB = ['启用', '是否启用', '状态', 'enabled', 'enable', 'active', 'status'];

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');

function rowsToRules(rows) {
  if (!rows.length) return { rules: [], skipped: 0 };

  // 识别表头
  let map = null;
  let start = 0;
  const first = rows[0].map(norm);
  const hit = (list) => first.findIndex((c) => list.includes(c));
  const iFind = hit(H_FIND);
  if (iFind >= 0) {
    map = { name: hit(H_NAME), find: iFind, replace: hit(H_REPL), enabled: hit(H_ENAB) };
    start = 1;
  } else {
    // 无表头：按列位置推断。2 列 = 查找/替换；3 列及以上 = 名称/查找/替换/启用
    map = rows[0].length <= 2
      ? { name: -1, find: 0, replace: 1, enabled: -1 }
      : { name: 0, find: 1, replace: 2, enabled: 3 };
  }

  const rules = [];
  let skipped = 0;
  const cell = (row, i) => (i >= 0 && row[i] != null ? String(row[i]) : '');

  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    const find = cell(row, map.find);
    if (!find.trim()) { skipped++; continue; }   // 查找内容为空的行无意义
    rules.push({
      name: cell(row, map.name).trim() || `规则 ${rules.length + 1}`,
      find,
      replace: cell(row, map.replace),
      enabled: map.enabled >= 0 ? parseEnabled(cell(row, map.enabled)) : true,
    });
  }
  return { rules, skipped };
}

/* ============ 对外接口 ============ */

function exportRules(rules, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const list = Array.isArray(rules) ? rules : [];
  const buf = ext === '.csv' ? buildCsv(list) : buildXlsx(list);
  fs.writeFileSync(filePath, buf);
  return { ok: true, count: list.length, filePath };
}

function importRules(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let rows;
  if (ext === '.csv') {
    let text = fs.readFileSync(filePath, 'utf8');
    // 粗判 GBK：UTF-8 解码失败会出现大量替换字符
    if ((text.match(/\ufffd/g) || []).length > text.length * 0.02) {
      try {
        text = new TextDecoder('gbk').decode(fs.readFileSync(filePath));
      } catch (_) { /* 保持原文 */ }
    }
    rows = parseCsv(text);
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    rows = readXlsx(fs.readFileSync(filePath));
  } else if (ext === '.xls') {
    throw new Error('不支持旧版 .xls 格式，请用 Excel 另存为 .xlsx 后再导入');
  } else {
    throw new Error(`不支持的文件格式：${ext || '（无扩展名）'}`);
  }

  const { rules, skipped } = rowsToRules(rows);
  return { ok: true, rules, skipped, filePath };
}

module.exports = { exportRules, importRules, HEADERS };
