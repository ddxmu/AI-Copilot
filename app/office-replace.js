// Office zip 类格式（docx/pptx/xlsx 等）的内部文本替换
// 纯 Node 内置 zlib 实现：读 zip → 对 XML 条目做文本替换 → 以 STORE(不压缩) 方式重新打包
// 说明：zip 容器不要求条目必须压缩，STORE 条目同样合法，Office 可正常打开。
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// 可被安全按文本替换的条目：Office 内部几乎都是 XML/rels
function isReplaceableEntry(name) {
  const n = name.toLowerCase();
  return n.endsWith('.xml') || n.endsWith('.rels');
}

// 解析 zip 的所有条目
function readZipEntries(buf) {
  // 找 EOCD（从尾部搜索）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // 从 local header 定位数据
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}（条目 ${name}）`);

    entries.push({ name, data, crc });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 用 STORE 方式重新打包
function writeZipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(e.data) : crc32(e.data);
    const size = e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0, 6);       // flags
    local.writeUInt16LE(0, 8);       // method = STORE
    local.writeUInt16LE(0, 10);      // mod time
    local.writeUInt16LE(0, 12);      // mod date
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(size, 18);   // comp size = size (STORE)
    local.writeUInt32LE(size, 22);   // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);      // extra len
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0);
    central.writeUInt16LE(20, 4);    // version made by
    central.writeUInt16LE(20, 6);    // version needed
    central.writeUInt16LE(0, 8);     // flags
    central.writeUInt16LE(0, 10);    // method = STORE
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);    // extra
    central.writeUInt16LE(0, 32);    // comment
    central.writeUInt16LE(0, 34);    // disk
    central.writeUInt16LE(0, 36);    // internal attrs
    central.writeUInt32LE(0, 38);    // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// 无 zlib.crc32 时的纯 JS CRC32 兜底
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 对 Office 文件做规则替换，返回 { content: Buffer|null, count }
// count=0 表示无匹配（content 为 null）
function processOfficeFile(fileBuf, rules) {
  const entries = readZipEntries(fileBuf);
  let total = 0;
  const newEntries = entries.map((e) => {
    if (!isReplaceableEntry(e.name)) return e;
    let text;
    try { text = e.data.toString('utf8'); } catch (err) { return e; }
    // 简单校验是不是文本 XML（避免误处理二进制条目）
    if (!text.includes('<')) return e;
    let out = text;
    let count = 0;
    for (const rule of rules) {
      if (!rule.find) continue;
      const parts = out.split(rule.find);
      if (parts.length > 1) {
        count += parts.length - 1;
        out = parts.join(rule.replace ?? '');
      }
    }
    if (count === 0) return e;
    total += count;
    return { name: e.name, data: Buffer.from(out, 'utf8') };
  });
  if (total === 0) return { content: null, count: 0 };
  return { content: writeZipStore(newEntries), count: total };
}

/* ===================== 老格式（.doc/.xls）双向转换适配层 ===================== */
// 老格式是 OLE 二进制复合文档（非 zip、非纯文本），无法直接按文本/XML 替换。
// 方案：老格式 → LibreOffice 转 OOXML(.docx/.xlsx) → processOfficeFile 内部 XML 替换 → 再 LibreOffice 转回原格式。

const LEGACY_OFFICE = new Set(['doc', 'xls']);

function findSofficePath() {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// 用 LibreOffice 把 srcPath 转成 fmt 格式（如 'docx' / 'xlsx'），返回输出文件路径
function sofficeConvert(soffice, srcPath, fmt, outDir) {
  const base = path.basename(srcPath, path.extname(srcPath));
  fs.mkdirSync(outDir, { recursive: true });
  try {
    execFileSync(soffice, [
      '--headless',
      '--convert-to', fmt,
      '--outdir', outDir,
      srcPath,
    ], {
      env: { ...process.env, UserInstallation: `file://${os.tmpdir()}/aic-lo-profile` },
      timeout: 120000,
    });
  } catch (e) {
    throw new Error('LibreOffice 转换失败：' + e.message);
  }
  const outPath = path.join(outDir, base + '.' + fmt);
  if (!fs.existsSync(outPath)) throw new Error('LibreOffice 未生成预期输出：' + outPath);
  return outPath;
}

// 老格式 → OOXML
function convertLegacyToOoxml(srcPath, legacyExt) {
  const outDir = path.join(os.tmpdir(), 'aic-lo-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  const fmt = legacyExt === 'doc' ? 'docx' : 'xlsx';
  return sofficeConvert(findSofficePath(), srcPath, fmt, outDir);
}

// OOXML → 老格式，返回 Buffer（调用方负责清理临时 ooxml 源）
function convertOoxmlToLegacy(ooxmlPath, legacyExt) {
  const outDir = path.join(os.tmpdir(), 'aic-lo-back-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  const fmt = legacyExt === 'doc' ? 'doc' : 'xls';
  const out = sofficeConvert(findSofficePath(), ooxmlPath, fmt, outDir);
  const buf = fs.readFileSync(out);
  setTimeout(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} }, 8000);
  return buf;
}

// 对老格式文件做规则替换，返回 { content: Buffer|null, count }
function replaceInLegacyFile(filePath, rules) {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (!LEGACY_OFFICE.has(ext)) throw new Error('replaceInLegacyFile 仅支持 .doc/.xls，收到 .' + ext);
  const soffice = findSofficePath();
  if (!soffice) throw new Error('未找到 LibreOffice（soffice），无法处理老格式 .' + ext + ' 文件');
  const ooxml = convertLegacyToOoxml(filePath, ext);
  let r;
  try {
    r = processOfficeFile(fs.readFileSync(ooxml), rules);
  } finally {
    try { fs.rmSync(path.dirname(ooxml), { recursive: true, force: true }); } catch {}
  }
  if (!r || r.count === 0) return { content: null, count: 0 };
  const outExt = ext === 'doc' ? 'docx' : 'xlsx';
  const tmpOoxml = path.join(os.tmpdir(), `aic-lo-out-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${outExt}`);
  fs.writeFileSync(tmpOoxml, r.content);
  try {
    return { content: convertOoxmlToLegacy(tmpOoxml, ext), count: r.count };
  } finally {
    try { fs.rmSync(tmpOoxml, { force: true }); } catch {}
  }
}

module.exports = { processOfficeFile, readZipEntries, writeZipStore, LEGACY_OFFICE, replaceInLegacyFile };
