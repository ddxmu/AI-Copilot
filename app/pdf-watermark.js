// PDF 文字水印分析与去除（纯 Node，无外部依赖）
// 适用范围：未加密、内容流为 FlateDecode 或未压缩的经典 PDF。
// 原理：解析间接对象 → 解码内容流 → 提取/移除文本绘制操作（Tj / TJ）→ 重建 xref 表。
// 对图片水印、加密 PDF、对象流(xref stream)较新的复杂 PDF 可能无法处理，会给出明确提示。
const fs = require('fs');
const zlib = require('zlib');

/* ================= 基础解析 ================= */
// 解析所有间接对象，保留原始字节块 raw，便于未修改的对象原样回写
function parseObjects(text) {
  const objects = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const marks = [];
  while ((m = re.exec(text))) {
    marks.push({ num: +m[1], gen: +m[2], start: m.index, bodyStart: m.index + m[0].length });
  }
  for (const mk of marks) {
    const endIdx = text.indexOf('endobj', mk.bodyStart);
    if (endIdx < 0) continue;
    const body = text.slice(mk.bodyStart, endIdx);
    const obj = { num: mk.num, gen: mk.gen, dict: '', stream: null, isStream: false, raw: text.slice(mk.start, endIdx + 6) };
    const sIdx = body.indexOf('stream');
    if (sIdx >= 0) {
      obj.isStream = true;
      obj.dict = body.slice(0, sIdx);
      let ds = sIdx + 6;
      if (body[ds] === '\r' && body[ds + 1] === '\n') ds += 2;
      else if (body[ds] === '\n' || body[ds] === '\r') ds += 1;
      const de = body.indexOf('endstream', ds);
      obj.stream = body.slice(ds, de); // latin1 字符串，1:1 对应字节
    } else {
      obj.dict = body;
    }
    objects.push(obj);
  }
  return objects;
}

function getFilter(dict) {
  const m = dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function isFlate(dict) {
  return /FlateDecode|\/Fl\b/.test(dict);
}

function isEncrypted(text) {
  return /\/Encrypt\b/.test(text);
}

function getRootRef(text) {
  // 从 trailer 提取 /Root N G R
  const m = text.match(/\/Root\s+(\d+)\s+(\d+)\s+R/);
  return m ? `${m[1]} ${m[2]} R` : null;
}

/* ================= 文本提取（分析） ================= */
// 解码 PDF 字面字符串（处理转义与八进制）
function decodePdfString(s) {
  // s 形如 "(...)"，去掉首尾括号
  let inner = s;
  if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { out += c; continue; }
    const n = inner[i + 1];
    if (n === 'n') { out += '\n'; i++; }
    else if (n === 'r') { out += '\r'; i++; }
    else if (n === 't') { out += '\t'; i++; }
    else if (n === 'b') { out += '\b'; i++; }
    else if (n === 'f') { out += '\f'; i++; }
    else if (n === '(' || n === ')' || n === '\\') { out += n; i++; }
    else if (n >= '0' && n <= '7') {
      let oct = n; let j = i + 2;
      while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') { oct += inner[j]; j++; }
      out += String.fromCharCode(parseInt(oct, 8)); i = j - 1;
    } else { out += n; i++; }
  }
  return out;
}

/* ================= CID / ToUnicode（中文等 CID 字体解码） ================= */
// hex 串按 UTF-16BE 每 4 位一个码元转 Unicode
function hexToUnicode(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
  return out;
}

// 解析所有 ToUnicode CMap，构建 CID(数值)→Unicode 字符串 映射
function buildCidMap(objects) {
  const map = new Map();
  for (const obj of objects) {
    if (!obj.isStream) continue;
    const content = decodeStreamText(obj);
    if (!content || (!content.includes('beginbfchar') && !content.includes('beginbfrange'))) continue;
    const lines = content.split('\n');
    let mode = null;
    for (const line of lines) {
      if (line.includes('beginbfchar')) { mode = 'char'; continue; }
      if (line.includes('endbfchar')) { mode = null; continue; }
      if (line.includes('beginbfrange')) { mode = 'range'; continue; }
      if (line.includes('endbfrange')) { mode = null; continue; }
      if (!mode) continue;
      const toks = [...line.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
      if (mode === 'char' && toks.length >= 2) {
        map.set(parseInt(toks[0], 16), hexToUnicode(toks[1]));
      } else if (mode === 'range' && toks.length >= 3) {
        const start = parseInt(toks[0], 16);
        const end = parseInt(toks[1], 16);
        if (line.includes('[')) {
          const dsts = toks.slice(2);
          for (let i = 0; i < dsts.length && (start + i) <= end; i++) map.set(start + i, hexToUnicode(dsts[i]));
        } else {
          const dstStart = parseInt(toks[2], 16);
          for (let c = start; c <= end; c++) map.set(c, String.fromCharCode(dstStart + (c - start)));
        }
      }
    }
  }
  return map;
}

// 把内容流里的 hex 字符串按 CID 解码（每 4 hex=2 字节一个 CID）
function decodeHexString(hex, cidMap) {
  let out = '';
  for (let i = 0; i + 3 < hex.length; i += 4) {
    const cid = parseInt(hex.substr(i, 4), 16);
    if (cidMap && cidMap.has(cid)) out += cidMap.get(cid);
  }
  return out;
}

// 从一个内容流中提取所有显示的文本（字面串 (...) 与 CID hex 串 <...>）
function extractTextFromContent(content, cidMap) {
  const texts = [];
  const re = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\]])*\]\s*TJ/g;
  let m;
  while ((m = re.exec(content))) {
    const seg = m[0];
    const strRe = /\((?:\\.|[^\\()])*\)/g;
    let sm;
    while ((sm = strRe.exec(seg))) {
      const t = decodePdfString(sm[0]).trim();
      if (t) texts.push(t);
    }
  }
  if (cidMap && cidMap.size) {
    const hexRe = /<([0-9A-Fa-f]+)>\s*Tj|\[((?:[^\]])*)\]\s*TJ/g;
    let hm;
    while ((hm = hexRe.exec(content))) {
      const seg = hm[0];
      const hxRe = /<([0-9A-Fa-f]+)>/g;
      let xm;
      while ((xm = hxRe.exec(seg))) {
        const t = decodeHexString(xm[1], cidMap).trim();
        if (t) texts.push(t);
      }
    }
  }
  return texts;
}

// 解码某对象的内容流为文本（若可解）
function decodeStreamText(obj) {
  if (!obj.isStream) return null;
  const buf = Buffer.from(obj.stream, 'latin1');
  if (isFlate(obj.dict)) {
    try { return zlib.inflateSync(buf).toString('latin1'); } catch (e) { return null; }
  }
  const f = getFilter(obj.dict);
  if (!f) return obj.stream; // 未压缩
  return null; // 其它滤镜（图片等）不解
}

/* ================= 分析候选水印 ================= */
// 返回 { ok, candidates: [{text, count, pages}], warning }
function analyze(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'latin1'); } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
  if (isEncrypted(text)) return { ok: false, error: '该 PDF 已加密，暂不支持' };
  const objects = parseObjects(text);
  const cidMap = buildCidMap(objects);
  const counts = new Map();
  let decodedStreams = 0;
  for (const obj of objects) {
    const content = decodeStreamText(obj);
    if (!content) continue;
    decodedStreams++;
    const seen = new Set();
    for (const t of extractTextFromContent(content, cidMap)) {
      if (seen.has(t)) continue; // 同一流内只记一次
      seen.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  if (decodedStreams === 0) {
    return { ok: false, error: '未能解析内容流（可能是图片型/对象流 PDF 或已损坏）' };
  }
  const candidates = [...counts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 60);
  return { ok: true, candidates };
}

/* ================= 去除水印并重建 ================= */
// 从内容流中删除包含任一水印串的文本操作
function scrubContent(content, watermarks) {
  // Tj
  let out = content.replace(/\((?:\\.|[^\\()])*\)\s*Tj/g, (m) => {
    const strPart = m.slice(0, m.lastIndexOf(')') + 1);
    const t = decodePdfString(strPart);
    return watermarks.some((w) => t.includes(w)) ? '' : m;
  });
  // TJ 数组：任一元素含水印则整段移除
  out = out.replace(/\[(?:[^\]])*\]\s*TJ/g, (m) => {
    const strRe = /\((?:\\.|[^\\()])*\)/g;
    let sm; let hit = false;
    while ((sm = strRe.exec(m))) {
      const t = decodePdfString(sm[0]);
      if (watermarks.some((w) => t.includes(w))) { hit = true; break; }
    }
    return hit ? '' : m;
  });
  return out;
}

function setLength(dict, newLen) {
  if (/\/Length\s+\d+/.test(dict)) return dict.replace(/\/Length\s+\d+/, '/Length ' + newLen);
  return dict.trimEnd() + '\n/Length ' + newLen + '\n';
}

// 返回 { ok, removed, warning }
function remove(filePath, watermarkStrings, outputPath) {
  let text;
  try { text = fs.readFileSync(filePath, 'latin1'); } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
  if (isEncrypted(text)) return { ok: false, error: '该 PDF 已加密，暂不支持' };
  const header = (text.match(/^%PDF-[\d.]+/) || ['%PDF-1.4'])[0];
  const rootRef = getRootRef(text);
  const objects = parseObjects(text);
  if (!objects.length || !rootRef) return { ok: false, error: 'PDF 结构无法解析' };

  let removed = 0;
  const parts = []; // 每个对象最终输出（latin1 字符串）
  const order = [];
  for (const obj of objects) {
    let emitted = obj.raw;
    if (obj.isStream) {
      const content = decodeStreamText(obj);
      if (content && watermarkStrings.some((w) => content.includes(w))) {
        const scrubbed = scrubContent(content, watermarkStrings);
        if (scrubbed !== content) {
          removed++;
          let data, filterNote = '';
          if (isFlate(obj.dict)) {
            data = zlib.deflateSync(Buffer.from(scrubbed, 'latin1')).toString('latin1');
          } else {
            data = scrubbed;
          }
          const newDict = setLength(obj.dict, Buffer.from(data, 'latin1').length);
          emitted = `${obj.num} ${obj.gen} obj\n${newDict.trim()}\nstream\n${data}\nendstream\nendobj\n`;
        }
      }
    }
    order.push(obj);
    parts.push({ num: obj.num, gen: obj.gen, body: emitted });
  }
  if (removed === 0) {
    return { ok: false, error: '未在内容流中找到所选水印文字（可能是图片水印或已被其它方式嵌入）' };
  }

  // 重建 xref 表
  let out = header + '\n' + '%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (const p of parts) {
    offsets.push({ num: p.num, gen: p.gen, off: Buffer.from(out, 'latin1').length });
    out += p.body;
  }
  const maxNum = Math.max(...parts.map((p) => p.num));
  const offMap = new Map(offsets.map((o) => [o.num, o]));
  const xrefStart = Buffer.from(out, 'latin1').length;
  out += 'xref\n';
  out += `0 ${maxNum + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let n = 1; n <= maxNum; n++) {
    const o = offMap.get(n);
    if (o) out += String(o.off).padStart(10, '0') + ' ' + String(o.gen).padStart(5, '0') + ' n \n';
    else out += '0000000000 65535 f \n';
  }
  out += 'trailer\n';
  out += `<< /Size ${maxNum + 1} /Root ${rootRef} >>\n`;
  out += 'startxref\n' + xrefStart + '\n%%EOF\n';

  try {
    fs.mkdirSync(require('path').dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, out, 'latin1');
  } catch (e) {
    return { ok: false, error: '写入失败：' + e.message };
  }
  return { ok: true, removed };
}

/* ================= 全文本提取（供格式转换 PDF 作源格式用） ================= */
// 提取 PDF 的全部文字内容（按内容流顺序，逐段一行）。未加密、Flate/未压缩 PDF 有效。
function extractFullText(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'latin1'); } catch (e) { return ''; }
  if (isEncrypted(text)) return '';
  const objects = parseObjects(text);
  const cidMap = buildCidMap(objects);
  const lines = [];
  for (const obj of objects) {
    const content = decodeStreamText(obj);
    if (!content) continue;
    for (const t of extractTextFromContent(content, cidMap)) lines.push(t);
  }
  return lines.join('\n');
}

module.exports = { analyze, remove, extractFullText };
