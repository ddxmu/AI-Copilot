// 内置 Computer Use MCP 服务器（macOS 原生实现）
// ------------------------------------------------------------
// 通过 MCP stdio 协议（每行一条 JSON-RPC 2.0）与主进程通信，提供一套
// 「模拟鼠标/键盘操作电脑」的工具：截图、移动、点击、拖拽、输入文字、按键、滚动。
// 仅依赖 Node 内置模块（child_process / fs / os / path），不引入任何外部依赖。
//
// 主进程以 `process.execPath --run-computer-use <本文件路径>` 启动本模块：
// main.js 顶部检测到 --run-computer-use 后早退（不创建窗口），require 本模块并调用 start()。
//
// 坐标系说明：所有坐标均为「主显示器逻辑点（points）」，原点在屏幕左上角。
// 截图会被等比缩放到逻辑分辨率，因此模型看到的图像像素与点击坐标 1:1 对应。
//
// 权限要求（macOS）：
//   1) 辅助功能（Accessibility）：控制鼠标/键盘必需，在「系统设置 › 隐私与安全性 › 辅助功能」允许 AI Copilot。
//   2) 屏幕录制（Screen Recording）：截图必需，在「系统设置 › 隐私与安全性 › 屏幕录制」允许 AI Copilot。
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ComputerUse';
const SERVER_VERSION = '1.6.3';

const TMP = path.join(os.tmpdir(), 'ai-copilot-computer-use');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) { /* ignore */ }

/* ---------------- 基础工具 ---------------- */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function logErr(msg) {
  process.stderr.write('[computer-use] ' + msg + '\n');
}

/* ---------------- 光标事件上报（让主进程遮罩显示 AI 鼠标） ---------------- */
let cursorSocket = null;
let cursorSocketReady = false;

function connectCursorSocket() {
  if (cursorSocket || cursorSocketReady) return;
  const sockPath = process.env.AI_COPILOT_CURSOR_SOCK;
  if (!sockPath) return;
  try {
    const s = net.createConnection(sockPath);
    s.on('connect', () => { cursorSocketReady = true; });
    s.on('error', () => { cursorSocketReady = false; cursorSocket = null; });
    s.on('close', () => { cursorSocketReady = false; cursorSocket = null; });
    cursorSocket = s;
  } catch (e) { cursorSocket = null; }
}

function sendCursor(t, x, y) {
  connectCursorSocket();
  if (!cursorSocketReady || !cursorSocket) return;
  const obj = { t };
  if (x != null) obj.x = Math.round(x);
  if (y != null) obj.y = Math.round(y);
  try { cursorSocket.write(JSON.stringify(obj) + '\n'); } catch (e) {
    cursorSocketReady = false; cursorSocket = null;
  }
}

// 运行一段 AppleScript（NSAppleScript 文本），返回 stdout 文本
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    setCurrentChild(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearCurrentChild(p); reject(e); });
    p.on('close', (code) => {
      clearCurrentChild(p);
      if (code !== 0) {
        if (_abortKill) { _abortKill = false; return reject(new Error('操作已被用户中断（Esc / 停止按钮）')); }
        const detail = (err || '').trim() || '未知错误';
        if (/not allowed|not authorized|accessibility|Automation|权限违例|-10004/i.test(detail)) {
          return reject(new Error('操作被系统拒绝：请到「系统设置 › 隐私与安全性 › 辅助功能」中允许 AI Copilot，并重试。'));
        }
        return reject(new Error('AppleScript 执行失败：' + detail));
      }
      resolve(out);
    });
  });
}

// 运行一段 JXA（JavaScript for Automation），返回 stdout 文本
function runJxa(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-l', 'JavaScript', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    setCurrentChild(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearCurrentChild(p); reject(e); });
    p.on('close', (code) => {
      clearCurrentChild(p);
      if (code !== 0) {
        if (_abortKill) { _abortKill = false; return reject(new Error('操作已被用户中断（Esc / 停止按钮）')); }
        return reject(new Error('JXA 执行失败：' + ((err || '').trim() || '未知错误')));
      }
      resolve(out);
    });
  });
}

function fileToBase64(file) {
  return fs.readFileSync(file).toString('base64');
}

// 把字符串安全转成 AppleScript 双引号字面量
function asStrLiteral(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '');
}

/* ---------------- 屏幕尺寸 / 多显示器（逻辑点） ---------------- */

// 截图降采样上限：把截图等比缩到该尺寸以内，既控制发给模型的图片体积/令牌，
// 又让模型输出坐标时工作在一个固定、较小的「图像坐标系」里；鼠标工具再按 coordScale 还原回逻辑点。
const MAX_SHOT_W = 1372;
const MAX_SHOT_H = 887;

// 显示器缓存（2s 内复用，避免每次操作都枚举）
let _displays = null;
let _displaysTime = 0;

// 通过 NSScreen(JXA) 枚举显示器：返回 [{width,height,originX,originY}]
// 坐标为 CoreGraphics 全局坐标系（原点在主显示器左上角，y 向下）。
// 关键：NSScreen 不需要辅助功能权限，是最稳的取屏方式；
// 旧实现用 Finder 桌面窗口 bounds 返回 0, 0, 1512, 982（无花括号），
// 而解析正则强制要求 {…}，导致永远匹配失败、报「无法解析屏幕尺寸」。
async function fetchDisplays() {
  const out = await runJxa(
    `ObjC.import('Cocoa');\n` +
    `var screens = $.NSScreen.screens.js;\n` + // 关键：.js 转成真实 JS 数组，否则 screens[0] 取不到元素（JXA 的 NSArray 代理不支持数字下标）
    `var primary = screens[0].frame;\n` +
    `var ph = Math.round(primary.size.height);\n` +
    `var res = [];\n` +
    `for (var i=0;i<screens.length;i++){\n` +
    `  var f = screens[i].frame;\n` +
    `  var w = Math.round(f.size.width);\n` +
    `  var h = Math.round(f.size.height);\n` +
    `  var ox = Math.round(f.origin.x);\n` +
    `  var oy = ph - (Math.round(f.origin.y) + h);\n` +
    `  res.push(w + '|' + h + '|' + ox + '|' + oy);\n` +
    `}\n` +
    `res.join(';');`
  );
  const list = out.trim().split(';').filter(Boolean).map((s) => {
    const p = s.split('|').map(Number);
    return { width: p[0], height: p[1], originX: p[2], originY: p[3] };
  });
  if (!list.length) throw new Error('未能枚举到任何显示器');
  return list;
}

async function ensureDisplays(force) {
  const now = Date.now();
  if (_displays && !force && now - _displaysTime < 2000) return _displays;
  _displays = await fetchDisplays();
  _displaysTime = now;
  return _displays;
}

function getDisplay(idx) {
  const i = Math.max(1, parseInt(idx, 10) || 1);
  if (_displays && _displays[i - 1]) return _displays[i - 1];
  return _displays ? _displays[0] : null;
}

// 把逻辑分辨率等比缩放到截图上限，返回图像尺寸与坐标换算比例（逻辑 / 图像）。
function computeShotSize(width, height) {
  const s = Math.min(MAX_SHOT_W / width, MAX_SHOT_H / height, 1);
  const imgW = Math.max(1, Math.round(width * s));
  const imgH = Math.max(1, Math.round(height * s));
  return { imgW, imgH, coordScale: width / imgW };
}

// 取指定显示器（1=主屏）的逻辑尺寸。NSScreen 优先，失败回退 Finder 桌面 bounds。
async function getDisplaySize(display) {
  const idx = Math.max(1, parseInt(display, 10) || 1);
  try {
    const displays = await ensureDisplays();
    const d = displays[idx - 1] || displays[0];
    return { width: d.width, height: d.height };
  } catch (e) {
    // 回退：Finder 桌面窗口 bounds（注意返回形如 0, 0, 1512, 982，无花括号）
    const out = await runAppleScript('tell application "Finder" to get bounds of window of desktop');
    const m = out.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) throw new Error('无法解析屏幕尺寸：' + out);
    return { width: parseInt(m[3], 10) - parseInt(m[1], 10), height: parseInt(m[4], 10) - parseInt(m[2], 10) };
  }
}

function getScreenSize() {
  return getDisplaySize(1);
}

// 将模型给出的「图像坐标系」坐标（按 display 的降采样尺寸）换算为 CoreGraphics 全局坐标，
// 供鼠标事件使用；同时返回该点在主屏图像坐标系中的位置用于截图红圈标注。
async function modelToTarget(modelX, modelY, display) {
  const displays = await ensureDisplays();
  const idx = Math.max(1, parseInt(display, 10) || 1);
  const d = displays[idx - 1] || displays[0];
  const shot = computeShotSize(d.width, d.height);
  const lx = modelX * shot.coordScale;
  const ly = modelY * shot.coordScale;
  return {
    display: idx,
    cg: { x: Math.round(d.originX + lx), y: Math.round(d.originY + ly) }, // CoreGraphics 全局坐标
    logical: { x: lx, y: ly }, // 该显示器内逻辑点（相对显示器左上角）
  };
}

/* ---------------- 中断（Esc / 停止按钮 / MCP cancelled） ---------------- */
let _aborted = false;
let _abortKill = false;
let _currentChild = null;
let _lastCg = { x: 0, y: 0 }; // 最近一次真实鼠标事件的 CG 坐标（用于中断时安全松键）

function setCurrentChild(p) { _currentChild = p; }
function clearCurrentChild(p) { if (_currentChild === p) _currentChild = null; }

// 中断当前操作：杀掉在途 osascript，并尽力释放鼠标左键（防 drag 中途被杀卡键）。
// 同时置位「会话级硬停止」——即使主进程侧还有排队中的 tools/call 抵达，也一律拒绝，
// 不再截图 / 点击 / 输入（对应需求 1：点停止后立即取消后续操作）。
function abortCurrent() {
  _aborted = true;
  _abortKill = true;
  _sessionStopped = true;
  if (_lastCg) runJxa(mouseUpJxa(_lastCg.x, _lastCg.y)).catch(() => {});
  if (_currentChild) {
    try { _currentChild.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
}

/* ---------------- 会话状态与健壮性基础设施（v1.5.0） ---------------- */

// 目标应用：focus_app 成功后记录（仅记录用，不再做自动重聚焦校验）。
let _targetApp = null;
// 连续失败计数：定位/点击/输入连续失败达阈值即停止并报告原因，避免盲目循环。
let _consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 2;
// 会话级硬停止：用户点「停止」后置位，任何后续工具调用立即拒绝，直到主进程下发 __reset。
let _sessionStopped = false;
// 内部截图文件（仅用于变化验证，不回传模型），限制数量避免堆积占盘。
const _shotFiles = [];
const MAX_SHOT_FILES = 6;

// 主进程在新一轮用户指令开始时下发 __reset，清空停止标记与失败计数。
function resetSession() {
  _sessionStopped = false;
  _consecutiveFailures = 0;
  _aborted = false;
  _abortKill = false;
  pruneShotHistory(0);
}

function trackShotFile(file) {
  if (!file) return;
  _shotFiles.push(file);
  pruneShotHistory();
}

// 只保留最近 MAX_SHOT_FILES 张内部截图，其余删除（需求：截图只保留最近几张）。
function pruneShotHistory(keep) {
  const limit = keep == null ? MAX_SHOT_FILES : keep;
  while (_shotFiles.length > limit) {
    const old = _shotFiles.shift();
    try { fs.unlinkSync(old); } catch (e) { /* ignore */ }
  }
}

function markSuccess() { _consecutiveFailures = 0; }
function markFailure() { _consecutiveFailures += 1; }

// 每个工具执行前的统一守卫（简化版，删除自动重聚焦等复杂校验）：
//   ① 会话已被用户停止 → 立即拒绝（硬停止）
//   ② 连续失败已达阈值 → 停止并报告原因（不盲目循环）
async function guard() {
  if (_sessionStopped) {
    throw new Error('会话已被用户停止（点击了「停止」）。本轮不再执行任何截图/点击/输入操作。');
  }
  if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    _sessionStopped = true;
    throw new Error(
      `已连续 ${_consecutiveFailures} 次定位/操作失败，为避免盲目循环已停止本轮操作。` +
      `请向用户说明失败原因（坐标定位不准 / 目标控件未出现 / 权限不足），并建议改用键盘快捷键或先 focus_app 重新定位，等用户确认后再继续。`
    );
  }
}

// 读取当前前台应用名（best-effort，读不到返回空串）
async function getFrontAppName() {
  try {
    const out = await runAppleScript('tell application "System Events" to get name of first process whose frontmost is true');
    return (out || '').trim();
  } catch (e) {
    return '';
  }
}

// 前台应用名与目标名的宽松匹配（兼容 bundle id、"Google Chrome" vs "Chrome" 等）
function frontMatches(front, target) {
  const a = String(front || '').trim().toLowerCase();
  const b = String(target || '').trim().toLowerCase();
  if (!a || !b) return true; // 读不到就不判定漂移，避免误伤
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const tail = b.split('.').pop(); // com.google.Chrome -> chrome
  if (tail && tail.length >= 3 && a.includes(tail)) return true;
  return false;
}

// 聚焦/启动应用（简化版）：只按 bundle id 用 open -b 激活，再简单确认一次前台。
//   - 不做窗口稳定 / 辅助功能树 / 连续轮询等复杂校验：发 open -b 后短暂等待，
//     前台应用名匹配 bundle id 即视为成功（最多尝试 3 次，约 2s 内确认）。
//   - 未确认前台则返回 false：调用方（focus_app）立即失败并禁止后续点击/输入。
async function focusAppByName(bundleId) {
  const nm = String(bundleId || '').trim();
  if (!nm) return false;
  try {
    await runCmdCapture('open', ['-b', nm]);
  } catch (e) {
    logErr('focusAppByName open -b 失败：' + e.message);
    return false;
  }
  // 简单确认前台：最多 3 次（每次等 600ms，共 ~2s），前台名匹配 bundle id 即成功
  for (let i = 0; i < 3; i++) {
    await sleep(600);
    const front = await getFrontAppName();
    if (front && frontMatches(front, nm)) return true;
  }
  return false;
}

// 浏览器地址栏：只发送 ⌘L（不做 AX 焦点检测等复杂校验）；网址由 type 用剪贴板 + ⌘V 输入
async function focusAddressBar() {
  await runJxa(buildKeyScript(CHAR_KEYCODES['l'], ['command']));
  await sleep(180);
}

// 变化判定网格：截图统一重采样到 SIG_GRID × SIG_GRID 灰度格，比较各格灰度差。
// 32×32 = 1024 格：既能让「弹出菜单 / 页面跳转」这类真实变化落到足够多格上，
// 又能让「文本光标闪烁 / 菜单栏时钟跳秒」这类噪声被格内均值吃掉（不误判为变化）。
const SIG_GRID = 32;
const SIG_DELTA = 10;      // 单格灰度差阈值（0-255）
const SIG_MIN_FRAC = 0.005; // 变化格占比阈值：≥0.5%（约 6/1024 格）才算界面真的变了

// 内部验证截图：截屏 → 重采样到 32×32（仅用于变化比对，不标注、不回传模型、不计入上下文）
async function captureShotFile(display) {
  const idx = Math.max(1, parseInt(display, 10) || 1);
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const src = path.join(TMP, `verify_${stamp}.png`);
  const capArgs = ['-x', '-t', 'png'];
  if (idx > 1) capArgs.unshift('-D', String(idx));
  await spawnAsync('screencapture', capArgs.concat([src]));
  if (!fs.existsSync(src)) throw new Error('验证截图未生成');
  trackShotFile(src);
  const dst = path.join(TMP, `verify_${stamp}_s.png`);
  // -z 强制重采样到固定 32×32（不保持长宽比），保证两次采样网格严格可比
  await spawnAsync('sips', ['-z', String(SIG_GRID), String(SIG_GRID), src, '--out', dst]);
  if (!fs.existsSync(dst)) throw new Error('验证截图重采样失败');
  trackShotFile(dst);
  return dst;
}

// 极简 PNG 解码（8bit、非隔行，灰度/灰度+A/RGB/RGBA）→ 逐像素灰度数组。
// 只用 Node 内置 zlib，无外部依赖；比走 osascript 取色快一个数量级，且不需要任何系统授权。
// 注：JXA 并未桥接 NSBitmapImageRep 的 colorAtX:y:（调用会报 not a function），故不能走 JXA 取色。
function decodePngGray(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null; // PNG 签名
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.slice(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // 跳过 CRC
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0 || !idat.length) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) return null; // 调色板（colorType 3）等不支持
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const gray = new Array(width * height);
  let prev = Buffer.alloc(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off]; off += 1;
    const line = Buffer.from(raw.slice(off, off + stride)); off += stride;
    if (!unfilterPngLine(filter, line, prev, channels)) return null;
    for (let x = 0; x < width; x++) {
      const i = x * channels;
      gray[y * width + x] = channels >= 3
        ? Math.round((line[i] + line[i + 1] + line[i + 2]) / 3)
        : line[i];
    }
    prev = line;
  }
  return { width, height, gray };
}

// PNG 行滤波还原（None/Sub/Up/Average/Paeth），原地改写 line
function unfilterPngLine(type, line, prev, bpp) {
  const n = line.length;
  if (type === 0) return true;
  if (type === 1) { for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255; return true; }
  if (type === 2) { for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255; return true; }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255;
    }
    return true;
  }
  if (type === 4) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      line[i] = (line[i] + pr) & 255;
    }
    return true;
  }
  return false; // 未知滤波类型
}

// 读取 32×32 灰度指纹（失败返回 null → 判定为 unknown，保守放行而非误杀）
function imageSignature(file) {
  try {
    const res = decodePngGray(fs.readFileSync(file));
    if (!res || !res.gray || res.gray.length < 64) return null;
    return res.gray;
  } catch (e) {
    return null;
  }
}

// 纯函数：比较两张截图指纹，判断界面是否发生了可见变化（可单测，无需 macOS）。
// 返回 null 表示无法判定；differ=true 表示界面确实变了。
function signaturesDiffer(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > SIG_DELTA) changed += 1;
  }
  const frac = changed / a.length;
  return { changed, total: a.length, frac, differ: frac >= SIG_MIN_FRAC };
}

// 读取「当前焦点」描述串（前台应用 + 焦点控件角色/说明/取值）。
// 用于像素几乎无变化、但焦点确实转移了的场景（例如点进一个输入框），避免误判为点击失败。
async function focusDescriptor() {
  try {
    const out = await runAppleScript(
      'tell application "System Events"\n' +
      '  set p to first process whose frontmost is true\n' +
      '  set d to (name of p)\n' +
      '  try\n' +
      '    set fe to focused UI element of p\n' +
      '    set d to d & "|" & (role of fe)\n' +
      '    try\n' +
      '      set d to d & "|" & (description of fe)\n' +
      '    end try\n' +
      '    try\n' +
      '      set d to d & "|" & (value of fe as text)\n' +
      '    end try\n' +
      '  end try\n' +
      '  return d\n' +
      'end tell'
    );
    return (out || '').trim();
  } catch (e) {
    return '';
  }
}

// 读取浏览器当前前台窗口的活动标签 URL 与标题（best-effort）。
// 用于点击后「以真实 URL/标题变化」作为成功证据，而非仅凭「按键已发出」就报告完成（需求 #6）。
// 读不到（非浏览器 / 未授权 AppleScript / 个人资料选择等无标签窗口）时返回 null → 不参与判定。
async function readBrowserState() {
  const front = await getFrontAppName();
  if (!front) return null;
  if (!/chrome|chromium|edge|brave|safari|firefox|arc|opera|qqbrowser|360/i.test(front)) return null;
  try {
    const out = await runAppleScript(
      `tell application "${asStrLiteral(front)}"\n` +
      `  if (count of windows) is 0 then return "NOTITLE|NOURL"\n` +
      `  try\n` +
      `    set t to title of active tab of front window\n` +
      `  on error\n` +
      `    set t to ""\n` +
      `  end try\n` +
      `  try\n` +
      `    set u to URL of active tab of front window\n` +
      `  on error\n` +
      `    set u to ""\n` +
      `  end try\n` +
      `  return t & "|" & u\n` +
      `end tell`
    );
    const s = (out || '').trim();
    if (!s) return null;
    const idx = s.lastIndexOf('|');
    const title = idx >= 0 ? s.slice(0, idx) : s;
    const url = idx >= 0 ? s.slice(idx + 1) : '';
    return { app: front, title: title, url: url };
  } catch (e) {
    return null; // 读不到就保守退出，不阻断主流程
  }
}

// 判断浏览器状态是否相对点击前发生了变化（URL 或标题任一不同即视为导航/加载生效）。
// before 为 null（之前读不到）而 after 读到了 → 视为变化（保守放行，因很可能正从个人资料页跳走）。
function browserStateChanged(before, after) {
  if (!after) return false;
  if (!before) return true;
  if (before.url && after.url && before.url !== after.url) return true;
  if (before.title && after.title && before.title !== after.title) return true;
  return false;
}

// 抓取操作前的状态基线（截图指纹 + 焦点描述 + 真实浏览器 URL/标题）
async function captureState(display) {
  const st = { sig: null, focus: '', browser: null };
  try {
    const f = await captureShotFile(display);
    st.sig = imageSignature(f);
  } catch (e) { /* 抓不到基线 → 后续判为 unknown */ }
  st.focus = await focusDescriptor();
  try { st.browser = await readBrowserState(); } catch (e) { st.browser = null; }
  return st;
}

// 点击后验证（需求 #1/#2/#5/#6 强化）：
//   ① 点击后不立即判定：随机等待 800~1500ms，给页面反应时间；
//   ② 重新截图比对像素 + 读焦点描述 + 读真实浏览器 URL/标题；
//   ③ 若页面仍在加载（暂时无变化），继续轮询最多 3 秒，不把「暂时无变化」当失败；
//   ④ 只有「完整重试（含 3 秒轮询）后」仍无任何真实证据变化，才返回 nochange；
//   ⑤ 成功必须由真实证据支撑：像素变化 / 焦点转移 / 浏览器 URL 或标题变化
//      （需求 #6，绝不只凭「按键已发出」就报告完成）。
// 返回 { result: 'ok'|'nochange'|'unknown', reason, browser? }
async function verifyClick(display, before) {
  if (!before) return { result: 'unknown', reason: 'nobaseline' };
  // ① 初始等待 800~1500ms（随机，避免每次固定节奏被页面动画误判）
  await sleep(800 + Math.floor(Math.random() * 700));
  const deadline = Date.now() + 3000; // ② 最多再轮询 3 秒
  let lastD = null;
  let lastBrowser = null;
  while (true) {
    // 重新截图比对像素
    let afterSig = null;
    try {
      const f = await captureShotFile(display);
      afterSig = imageSignature(f);
    } catch (e) { /* 截不到 → 靠焦点/浏览器判定 */ }
    const d = signaturesDiffer(before.sig, afterSig);
    lastD = d;
    // 读焦点变化（聚焦输入框这类视觉变化极小但确实生效）
    const afterFocus = await focusDescriptor();
    // 读真实浏览器 URL/标题（最强证据）
    let afterBrowser = null;
    try { afterBrowser = await readBrowserState(); } catch (e) { afterBrowser = null; }
    lastBrowser = afterBrowser;
    // ⑤ 真实证据之一即判成功
    if (d && d.differ) return { result: 'ok', reason: 'pixel' };
    if (before.focus && afterFocus && before.focus !== afterFocus) return { result: 'ok', reason: 'focus' };
    if (browserStateChanged(before.browser, afterBrowser)) return { result: 'ok', reason: 'browser', browser: afterBrowser };
    // ③ 仍在加载/暂时无变化：若还有时间则继续轮询，不把「暂时无变化」当失败
    if (Date.now() >= deadline) break;
    await sleep(400);
  }
  // ④ 完整重试（含 3 秒轮询）后仍无变化
  if (!lastD) return { result: 'unknown', reason: 'noread' };
  return { result: 'nochange', reason: 'none', browser: lastBrowser };
}

// 每一步的状态行：当前应用 / 当前动作 / 目标位置 / 验证结果（需求：为每一步显示这四项）
function stepStatus(app, action, target, verify) {
  const parts = ['应用:' + (app || '未知'), '动作:' + (action || '-')];
  parts.push('目标:' + (target || '-'));
  parts.push('验证:' + (verify || '未验证'));
  return '【' + parts.join(' | ') + '】';
}

/* ---------------- 按键 / 鼠标映射与 CoreGraphics 实现 ---------------- */

const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  forwarddelete: 117, help: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 113, f14: 115, f15: 118, f16: 121,
  command: 55, cmd: 55, shift: 56, capslock: 57, option: 58, alt: 58, control: 59, ctrl: 59,
};

// 可打印字符 -> macOS 虚拟键码（ANSI 布局），用于热键里的字母/数字
const CHAR_KEYCODES = {
  a:0,b:11,c:8,d:2,e:14,f:3,g:5,h:4,i:34,j:38,k:40,l:37,m:46,n:45,o:31,p:35,q:12,r:15,s:1,t:17,u:32,v:9,w:13,x:7,y:16,z:6,
  '0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25,
  '-':27,'=':24,'[':33,']':30,'\\':42,';':41,"'":39,',':43,'.':47,'/':44,'`':50,' ':49,
};

function toModDown(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'command' || n === 'cmd') return 'command down';
  if (n === 'control' || n === 'ctrl') return 'control down';
  if (n === 'shift') return 'shift down';
  if (n === 'option' || n === 'alt') return 'option down';
  return null;
}

// CoreGraphics 修饰键位掩码（kCGEventFlagMask*）
const MOD_MASKS = {
  command: 1048576, cmd: 1048576,
  shift: 131072,
  option: 524288, alt: 524288,
  control: 262144, ctrl: 262144,
  fn: 8388608, function: 8388608,
};
const FN_KEY_MASK = 8388608;

// F1-F12 默认被 macOS 当作媒体键，需额外按下 fn 才能发出真正的 F 键
const FN_KEYCODES = new Set([122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]);

// 记录鼠标最后位置（图像坐标系，即模型看到的坐标空间）与所在显示器，
// 用于截图时在该显示器图像上绘制点击红圈；_lastCg 记录最近一次真实鼠标事件的
// CoreGraphics 全局坐标，供中断时安全释放左键。
let _lastPos = null;
let _lastDisplay = 1;
function setLastPos(x, y, display) { _lastPos = { x, y }; _lastDisplay = display || 1; }

/* ---------- CoreGraphics (JXA) 鼠标/键盘事件 ---------- */

// 平滑移动：从 from 逐帧插值到 to，桌面光标可见且连续移动
function mouseMoveJxa(tx, ty, fx, fy) {
  const lines = ['ObjC.import("CoreGraphics");'];
  if (!isFinite(fx) || !isFinite(fy)) { fx = tx; fy = ty; }
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fx + (tx - fx) * i / steps);
    const y = Math.round(fy + (ty - fy) * i / steps);
    lines.push(`var e${i}=$.CGEventCreateMouseEvent(0,$.kCGEventMouseMoved,$.CGPointMake(${x},${y}),0);$.CGEventPost($.kCGHIDEventTap,e${i});`);
  }
  return lines.join('\n');
}

function mouseClickJxa(x, y, button, isDouble) {
  const btn = button === 'right' ? '$.kCGMouseButtonRight' : button === 'middle' ? '$.kCGMouseButtonCenter' : '$.kCGMouseButtonLeft';
  const down = button === 'right' ? '$.kCGEventRightMouseDown' : button === 'middle' ? '$.kCGEventOtherMouseDown' : '$.kCGEventLeftMouseDown';
  const up = button === 'right' ? '$.kCGEventRightMouseUp' : button === 'middle' ? '$.kCGEventOtherMouseUp' : '$.kCGEventLeftMouseUp';
  const lines = ['ObjC.import("CoreGraphics");', 'ObjC.import("Foundation");'];
  lines.push(`var mv=$.CGEventCreateMouseEvent(0,$.kCGEventMouseMoved,$.CGPointMake(${x},${y}),0);$.CGEventPost($.kCGHIDEventTap,mv);`);
  // 移动到目标后等 100ms：给 input→HID→AppKit 一个 round-trip，
  // 让目标应用 hover 状态稳定、clickCount 计时正确，落点更可靠。
  lines.push('$.NSThread.sleepForTimeInterval(0.1);');
  const n = isDouble ? 2 : 1;
  for (let i = 0; i < n; i++) {
    lines.push(`var d${i}=$.CGEventCreateMouseEvent(0,${down},$.CGPointMake(${x},${y}),${btn});`);
    if (n > 1) lines.push(`$.CGEventSetIntegerValueField(d${i},$.kCGMouseEventClickState,${n});`);
    lines.push(`$.CGEventPost($.kCGHIDEventTap,d${i});`);
    // 目标应用需要一小段时间完成 hit-test 与状态切换；down 后等 50ms 再 up，避免被忽略
    lines.push('$.NSThread.sleepForTimeInterval(0.05);');
    lines.push(`var u${i}=$.CGEventCreateMouseEvent(0,${up},$.CGPointMake(${x},${y}),${btn});`);
    if (n > 1) lines.push(`$.CGEventSetIntegerValueField(u${i},$.kCGMouseEventClickState,${n});`);
    lines.push(`$.CGEventPost($.kCGHIDEventTap,u${i});`);
    if (n > 1 && i === 0) lines.push('$.NSThread.sleepForTimeInterval(0.06);');
  }
  return lines.join('\n');
}

// System Events 辅助功能点击（click at 坐标入口）：仅在左键 CGEvent 主路径失败时
// 作为一次备用兜底（对部分 Chrome / Electron 的 HTML 控件仍可命中）。
//   with timeout of 5 seconds —— 限制本次点击最多 5 秒，超时由 AppleScript 自身抛错；
//   set ignoredClick to click at {x, y} —— 把 click 返回的 accessibility UI 对象捕获到
//     局部变量，确保它不被透出 / 不参与后续逻辑（suppress）；
//   return "" —— 脚本显式返回空，避免返回 UI 对象引用。
function mouseClickAppleScript(x, y) {
  return (
    `with timeout of 5 seconds\n` +
    `  tell application "System Events"\n` +
    `    set ignoredClick to click at {${Math.round(x)}, ${Math.round(y)}}\n` +
    `  end tell\n` +
    `end timeout\n` +
    `return ""`
  );
}

function mouseMoveInstantJxa(x, y) {
  return `ObjC.import("CoreGraphics");\nvar mv=$.CGEventCreateMouseEvent(0,$.kCGEventMouseMoved,$.CGPointMake(${x},${y}),0);$.CGEventPost($.kCGHIDEventTap,mv);`;
}

function mouseDownJxa(x, y) {
  return `ObjC.import("CoreGraphics");\nvar dn=$.CGEventCreateMouseEvent(0,$.kCGEventLeftMouseDown,$.CGPointMake(${x},${y}),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,dn);`;
}

function mouseUpJxa(x, y) {
  return `ObjC.import("CoreGraphics");\nvar up=$.CGEventCreateMouseEvent(0,$.kCGEventLeftMouseUp,$.CGPointMake(${x},${y}),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,up);`;
}

// 对标 Claude Code animatedMove：ease-out-cubic 缓动，60fps，时长 = min(距离/2000, 0.5s)。
// 慢速中间帧让目标应用有时间处理 .leftMouseDragged 事件（滚动条拖动、窗口缩放等）。
function mouseDragMoveJxa(fx, fy, tx, ty) {
  const dist = Math.hypot(tx - fx, ty - fy);
  const durationSec = Math.min(dist / 2000, 0.5);
  const totalFrames = Math.max(1, Math.floor(durationSec * 60));
  const lines = ['ObjC.import("CoreGraphics");'];
  for (let f = 1; f <= totalFrames; f++) {
    const t = f / totalFrames;
    const eased = 1 - Math.pow(1 - t, 3);
    const x = Math.round(fx + (tx - fx) * eased);
    const y = Math.round(fy + (ty - fy) * eased);
    lines.push(`var dr${f}=$.CGEventCreateMouseEvent(0,$.kCGEventLeftMouseDragged,$.CGPointMake(${x},${y}),$.kCGMouseButtonLeft);$.CGEventPost($.kCGHIDEventTap,dr${f});`);
  }
  return lines.join('\n');
}

// 组合键：依次 post 修饰键 down → 主键 down/up → 修饰键 up。
// 关键修复：每个事件都要用 CGEventSetFlags 注入「当前已按下的修饰键掩码」。
// 旧实现只单独 post 修饰键 down/up，主键事件自身不带修饰标志，导致 Chrome/Electron
// 这类「按事件自身的 flags 判定修饰键」的应用把 ⌘V 误判为裸 v（只落一个字符、不粘贴）。
function buildKeyScript(mainCode, modNames) {
  const MOD_KC = { command: 55, cmd: 55, shift: 56, option: 58, alt: 58, control: 59, ctrl: 59, fn: 63, function: 63 };
  // 关键：MOD_MASK 必须是真实的 CoreGraphics 修饰键掩码（CGEventFlags），而非 keycode！
  //   正确值（macOS CoreGraphics，CGEventFlags 位定义）：
  //     kCGEventFlagMaskCommand     = 0x100000 (1048576)
  //     kCGEventFlagMaskShift       = 0x20000  (131072)
  //     kCGEventFlagMaskControl     = 0x40000  (262144)
  //     kCGEventFlagMaskAlternate   = 0x80000  (524288)  // option / alt
  //     kCGEventFlagMaskSecondaryFn = 0x800000 (8388608)  // fn
  //   误用 0x1000(4096) 等非掩码值会导致 Chrome/Electron 读不到 ⌘、把 ⌘V 当成裸 v（只落一个字符、不粘贴）。
  const MOD_MASK = { command: 1048576, cmd: 1048576, shift: 131072, option: 524288, alt: 524288, control: 262144, ctrl: 262144, fn: 8388608, function: 8388608 };
  const lines = ['ObjC.import("CoreGraphics");'];
  let flags = 0;
  const modCodes = [];
  const modMasks = [];
  for (const m of modNames) {
    const key = String(m).toLowerCase();
    const mc = MOD_KC[key];
    if (mc == null) continue;
    const mask = MOD_MASK[key] || 0;
    modCodes.push(mc);
    modMasks.push(mask);
    flags |= mask;
    lines.push(`var md${mc}=$.CGEventCreateKeyboardEvent(0,${mc},true);$.CGEventSetFlags(md${mc},${flags});$.CGEventPost($.kCGHIDEventTap,md${mc});`);
    lines.push('$.NSThread.sleepForTimeInterval(0.01);');
  }
  // 主键事件自身携带完整的修饰键掩码，应用才会将其识别为 ⌘V / ⌘C 等组合键
  lines.push(`var kd=$.CGEventCreateKeyboardEvent(0,${mainCode},true);$.CGEventSetFlags(kd,${flags});$.CGEventPost($.kCGHIDEventTap,kd);`);
  lines.push('$.NSThread.sleepForTimeInterval(0.01);');
  lines.push(`var ku=$.CGEventCreateKeyboardEvent(0,${mainCode},false);$.CGEventSetFlags(ku,${flags});$.CGEventPost($.kCGHIDEventTap,ku);`);
  // 松开修饰键时同步递减 flags
  for (let i = modCodes.length - 1; i >= 0; i--) {
    const mc = modCodes[i];
    flags &= ~modMasks[i];
    lines.push(`var mu${mc}=$.CGEventCreateKeyboardEvent(0,${mc},false);$.CGEventSetFlags(mu${mc},${flags});$.CGEventPost($.kCGHIDEventTap,mu${mc});`);
  }
  return lines.join('\n');
}

function resolveMainCode(main) {
  if (KEY_CODES[main] != null) return KEY_CODES[main];
  if (main.length === 1 && CHAR_KEYCODES[main.toLowerCase()] != null) return CHAR_KEYCODES[main.toLowerCase()];
  const num = parseInt(main, 10);
  if (isFinite(num)) return num;
  return null;
}

// 对标 Claude Code computer-use 的 typeViaClipboard：用剪贴板写入文本再 ⌘V 粘贴，
// 规避 System Events `keystroke` 对中文/长文本丢字、乱序、emoji 截断的问题。
// （简化版：不做 AX 焦点检测等复杂校验，直接粘贴，由回读验证兜底判定）
//
// 流程与「防假报成功」保证：
//   ① 保存用户剪贴板（finally 还原，不污染）
//   ② pbcopy 写入 + pbpaste 回读校验（不一致视为写入失败）
//   ③ ⌘V 粘贴：主键事件已通过 CGEventSetFlags 注入 command 修饰标志（见 buildKeyScript），
//      解决 Chrome/Electron 把 ⌘V 误判为裸 v、只落一个字符的问题；CoreGraphics 失败时
//      回退 System Events `keystroke "v" using command down`（同一环境变量下更稳）
//   ④ 按文本长度充分等待，避免 finally 还原剪贴板截断正在进行的粘贴
//   ⑤ 尽力回读目标字段内容（⌘A+⌘C 读出），确认确实进入窗口（verifyPasteLanded）；
//      若明确为空则抛错（失败不假报成功），读不到则保守放行（不误杀）
//   任何一步失败都抛出；调用方不再用 keystroke 重输整段（那会丢中文/长文本/换行且假报成功）。
async function typeViaClipboard(text) {
  let saved = null;
  try { saved = await runCmdCapture('pbpaste', []); } catch (e) { /* 读不到就算了 */ }

  try {
    // ① 写入剪贴板
    await runCmdCapture('pbcopy', [], text);
    const back = await runCmdCapture('pbpaste', []);
    if (back !== text) throw new Error('剪贴板写入/回读不一致，放弃粘贴');

    // ③ 粘贴：⌘V（不做 AX 焦点检测等复杂校验，直接粘贴，由 ⑥ 回读验证兜底判定）
    try {
      await runJxa(buildKeyScript(CHAR_KEYCODES['v'], ['command']));
    } catch (e) {
      logErr('CoreGraphics ⌘V 失败，回退 System Events：' + e.message);
      await runAppleScript(pasteAppleScript());
    }

    // ④ 等粘贴真正落盘（按文本长度给足时间），避免 finally 还原剪贴板截断正在进行的粘贴
    await sleep(Math.min(2000, 120 + text.length * 6));

    // ⑤ 回读目标字段，确认内容确实进入窗口
    const verdict = await verifyPasteLanded(text);
    if (verdict === 'fail') {
      throw new Error('粘贴后目标输入框未出现预期内容（焦点丢失或被拦截），输入未生效。');
    }
  } finally {
    if (saved != null) {
      try { await runCmdCapture('pbcopy', [], saved); } catch (e) { /* 还原失败忽略 */ }
    }
  }
}

// 粘贴兜底命令：System Events `keystroke "v" using command down`（⌘V）。
// 用于 CoreGraphics 路径在个别环境下被拒时的二次尝试，也便于单测断言。
function pasteAppleScript() {
  return 'tell application "System Events" to keystroke "v" using command down';
}

// 回读目标字段内容，确认粘贴生效（best-effort）：
//   通过 ⌘A（全选）+ ⌘C（复制）读出字段内容，与待粘贴文本比较。
//   返回 'ok'（字段含待粘贴文本）/ 'fail'（字段为空）/ 'unknown'（无法读取，不判定）。
// 注：⌘A/⌘C 均在字段内，不改变已粘贴结果；字段内容随后由 finally 还原剪贴板覆盖。
async function verifyPasteLanded(text) {
  try {
    await runJxa(buildKeyScript(CHAR_KEYCODES['a'], ['command'])); // ⌘A 全选
    await sleep(40);
    await runJxa(buildKeyScript(CHAR_KEYCODES['c'], ['command'])); // ⌘C 复制字段内容
    await sleep(60);
    const field = await runCmdCapture('pbpaste', []);
    return pasteVerificationResult(field, text);
  } catch (e) {
    return 'unknown';
  }
}

// 纯函数：根据回读到的字段内容对待粘贴文本做判定（可单测，无需 macOS）。
// 规则（严格、不假报成功）：
//   - fieldContent 为 null（确实读不到字段内容）→ 'unknown'，交由上层保守处理；
//   - 字段含待粘贴文本 → 'ok'；
//   - 只要能读到字段、但内容不含待粘贴文本（含空字段、只落了 'v' 等）→ 'fail'。
function pasteVerificationResult(fieldContent, pasted) {
  if (fieldContent == null) return 'unknown';            // 确实无法读取字段内容
  if (fieldContent.includes(pasted)) return 'ok';        // 字段含待粘贴文本
  return 'fail';                                          // 能读到字段但内容不对 → 明确失败（不假报成功）
}

// ASCII 兜底输入：剪贴板路径失败时的「换一条路」重试（仅限可打印 ASCII；
// 中文/emoji 走 keystroke 会丢字，故非 ASCII 不用这条路）。
async function typeAsciiKeystroke(text) {
  await runAppleScript(`tell application "System Events" to keystroke "${asStrLiteral(text)}"`);
  await sleep(Math.min(1500, 80 + text.length * 12));
}

// 读取前台应用的可交互辅助功能元素（角色/名称/位置/尺寸/状态），并把全局逻辑点坐标
// 换算成「图像坐标系」的控件中心，供 click 直接使用（优先元素定位，读不到再回退截图坐标）。
// 深度与数量都做了硬上限，避免在复杂界面上无限递归/卡死。
async function queryUiElements(display) {
  const idx = Math.max(1, parseInt(display, 10) || 1);
  const displays = await ensureDisplays();
  const d = displays[idx - 1] || displays[0];
  const shot = computeShotSize(d.width, d.height);
  const script = `function safe(fn){ try { return fn(); } catch (e) { return null; } }
var se = Application('System Events');
var procs = safe(function(){ return se.processes.whose({ frontmost: true })(); }) || [];
var result;
if (!procs.length) {
  result = 'NOPROC';
} else {
  var proc = procs[0];
  var appName = safe(function(){ return proc.name(); }) || '';
  var wins = safe(function(){ return proc.windows(); }) || [];
  if (!wins.length) {
    result = 'APP:' + appName + '\\nNOWIN';
  } else {
    var WANTED = {
      'button': 1, 'text field': 1, 'text area': 1, 'pop up button': 1, 'menu button': 1,
      'checkbox': 1, 'radio button': 1, 'link': 1, 'combo box': 1, 'search field': 1,
      'tab group': 1, 'slider': 1, 'incrementor': 1, 'menu item': 1, 'static text': 0
    };
    var out = [];
    var CAP = 60, MAX_DEPTH = 5;
    function walk(el, depth) {
      if (out.length >= CAP || depth > MAX_DEPTH) return;
      var kids = safe(function(){ return el.uiElements(); }) || [];
      for (var i = 0; i < kids.length && out.length < CAP; i++) {
        var k = kids[i];
        var role = safe(function(){ return k.role(); }) || '';
        var rl = String(role).toLowerCase().replace(/^ax/, '');
        if (WANTED[rl]) {
          var pos = safe(function(){ return k.position(); });
          var sz = safe(function(){ return k.size(); });
          if (pos && sz && pos.length === 2 && sz.length === 2 && sz[0] > 0 && sz[1] > 0) {
            var name = safe(function(){ return k.title(); }) || safe(function(){ return k.name(); }) ||
                       safe(function(){ return k.description(); }) || safe(function(){ return k.value(); }) || '';
            var en = safe(function(){ return k.enabled(); });
            if (en === null) en = true;
            var fc = safe(function(){ return k.focused(); }) || false;
            out.push([rl, String(name).replace(/[\\t\\n]/g, ' ').slice(0, 40),
                      Math.round(pos[0]), Math.round(pos[1]),
                      Math.round(sz[0]), Math.round(sz[1]),
                      en ? 1 : 0, fc ? 1 : 0].join('\\t'));
          }
        }
        walk(k, depth + 1);
      }
    }
    walk(wins[0], 0);
    result = 'APP:' + appName + '\\n' + out.join('\\n');
  }
}
result;`;
  const raw = String(await runJxa(script) || '').trim();
  if (raw === 'NOPROC') return { status: 'NOPROC', appName: '', items: [] };
  const lines = raw.split('\n');
  let appName = '';
  const items = [];
  for (const ln of lines) {
    if (ln.indexOf('APP:') === 0) { appName = ln.slice(4); continue; }
    if (ln === 'NOWIN') return { status: 'NOWIN', appName, items: [] };
    const p = ln.split('\t');
    if (p.length < 8) continue;
    const gx = Number(p[2]); const gy = Number(p[3]);
    const w = Number(p[4]); const h = Number(p[5]);
    if (![gx, gy, w, h].every(isFinite)) continue;
    // 控件中心（全局逻辑点）→ 该显示器图像坐标系；与 modelToTarget 严格互逆
    const cx = (gx + w / 2 - d.originX) / shot.coordScale;
    const cy = (gy + h / 2 - d.originY) / shot.coordScale;
    items.push({
      role: p[0], name: p[1],
      cx: Math.round(cx), cy: Math.round(cy),
      enabled: p[6] === '1', focused: p[7] === '1',
    });
  }
  return { status: 'OK', appName, items };
}

// 在截图上绘制红色点击环（best-effort，失败不影响主流程）
// 注（需求 #7）：红圈半径/线宽仅影响「视觉提示」大小，圆心 (x, y) 始终是真实点击坐标，
// 绝不用光标/红圈的显示尺寸去修正或偏移点击落点 —— 点击落点只由 modelToTarget 的 CG 坐标决定。
function annotateScreenshotJxa(png, x, y) {
  const j = JSON.stringify(png);
  return `ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
var EMPTY = $({});
var path = $( ${j} );
var img = $.NSImage.alloc.initWithContentsOfFile(path);
if (!img) { throw new Error('img load fail'); }
var size = img.size;
var tiff = img.TIFFRepresentation;
if (!tiff) { throw new Error('tiff fail'); }
var rep0 = $.NSBitmapImageRep.alloc.initWithData(tiff);
var cg = rep0.CGImage;
if (!cg) { throw new Error('cg fail'); }
var w = Math.round(size.width), h = Math.round(size.height);
var cs = $.CGColorSpaceCreateDeviceRGB();
var ctx = $.CGBitmapContextCreate(0, w, h, 8, 4 * w, cs, 1);
if (!ctx) { throw new Error('ctx fail'); }
$.CGContextDrawImage(ctx, $.CGRectMake(0,0,w,h), cg);
// 红圈标记仅作视觉提示：缩小半径、减细线宽、半透明，避免覆盖按钮文字。
// 圆心仍为真实点击坐标（x, y），不改动任何坐标换算。
var r = Math.max(9, Math.min(w, h) * 0.014);
$.CGContextSetStrokeColorWithColor(ctx, $.CGColorCreateGenericRGB(1,0,0,0.85));
$.CGContextSetLineWidth(ctx, 3);
$.CGContextStrokeEllipseInRect(ctx, $.CGRectMake(${x} - r, h - ${y} - r, 2 * r, 2 * r));
var out = $.CGBitmapContextCreateImage(ctx);
var rep = $.NSBitmapImageRep.alloc.initWithCGImage(out);
var data = rep.representationUsingTypeProperties($.NSPNGFileType, EMPTY);
data.writeToFileAtomically(path, true);
`;
}

/* ---------------- 工具实现 ---------------- */

const TOOLS = {
  async get_screen_size(args) {
    await guard();
    const display = Math.max(1, parseInt(args && args.display, 10) || 1);
    const size = await getDisplaySize(display);
    const shot = computeShotSize(size.width, size.height);
    const total = _displays ? _displays.length : 1;
    return {
      content: [{
        type: 'text',
        text:
          `显示器 ${display}/${total} 图像坐标系尺寸：${shot.imgW} × ${shot.imgH}（逻辑分辨率 ${size.width} × ${size.height}）。` +
          `后续所有鼠标/点击坐标请基于该图像尺寸输出（原点在左上角，单位=图像像素）。` +
          (total > 1 ? ` 当前共 ${total} 个显示器；若需操作其它显示器，请先调用 get_displays 查看坐标，并在工具中传 display 参数。` : ''),
      }],
    };
  },

  async screenshot(args) {
    await guard();
    pruneShotHistory();
    const display = Math.max(1, parseInt(args && args.display, 10) || 1);
    const size = await getDisplaySize(display);
    const shot = computeShotSize(size.width, size.height);
    const src = path.join(TMP, `shot_${Date.now()}.png`);
    const dst = path.join(TMP, `shot_${Date.now()}_s.png`);
    // 截图前临时隐藏 AI 光标遮罩，避免把粉色指针拍进截图干扰模型判断
    sendCursor('hide');
    // 指定显示器截图（-D n，1=主屏；-C 捕获鼠标光标，-x 静音，png）
    const capArgs = ['-x', '-C', '-t', 'png'];
    if (display > 1) capArgs.unshift('-D', String(display));
    try {
      await spawnAsync('screencapture', capArgs.concat([src]));
    } catch (e) {
      sendCursor('show');
      const msg = String(e.message || '');
      if (/privacy|permission|screen recording|权限|录制/i.test(msg)) {
        throw new Error('截图失败：请到「系统设置 › 隐私与安全性 › 屏幕录制」中允许 AI Copilot，并重试。');
      }
      throw new Error('截图失败：' + msg);
    }
    if (!fs.existsSync(src)) {
      sendCursor('show');
      throw new Error('截图失败：未能生成图片（请确认已在「屏幕录制」中允许 AI Copilot）。');
    }
    // 等比缩放到上限尺寸，使图像像素落在「图像坐标系」内，与坐标换算比例 coordScale 对应
    await spawnAsync('sips', ['-z', String(shot.imgH), String(shot.imgW), src, '--out', dst]);
    const finalFile = fs.existsSync(dst) ? dst : src;
    // Retina 屏上 screencapture 默认保留 144 DPI；视觉模型按该元数据读取时会把
    // 1366×887 图像当成约 683×443 points，导致点击落点缩小一半。
    // 统一归一为 72 DPI，保证「图像像素」与「工具坐标空间（逻辑点）」严格 1:1。
    await spawnAsync('sips', ['-s', 'dpiWidth', '72', '-s', 'dpiHeight', '72', finalFile]);
    // 在最近一次同显示器鼠标操作点绘制红色点击环（图像坐标系，best-effort）
    if (_lastPos && _lastDisplay === display) {
      try {
        await runJxa(annotateScreenshotJxa(finalFile, _lastPos.x, _lastPos.y));
      } catch (e) {
        logErr('annotate screenshot failed: ' + e.message);
      }
    }
    const b64 = fileToBase64(finalFile);
    try { fs.unlinkSync(src); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(dst); } catch (e) { /* ignore */ }
    const mark = _lastPos && _lastDisplay === display ? `截图中已用红圈标出最近一次鼠标操作位置 (${_lastPos.x}, ${_lastPos.y})。` : '';
    sendCursor('show');
    const frontApp = await getFrontAppName();
    const status = stepStatus(frontApp, '截图', `显示器${display}`, `${shot.imgW}×${shot.imgH}`);
    return {
      content: [
        { type: 'text', text: `${status} 已截取显示器 ${display} 全屏，图像尺寸 ${shot.imgW} × ${shot.imgH}（逻辑分辨率 ${size.width} × ${size.height}），已包含鼠标光标。${mark}请基于此图像尺寸输出坐标（原点左上角），点击时务必取控件中心而非边缘。` },
        { type: 'image', data: b64, mimeType: 'image/png' },
      ],
    };
  },

  async move(args) {
    await guard();
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    const from = _lastCg && isFinite(_lastCg.x) ? _lastCg : { x: target.cg.x, y: target.cg.y };
    _lastCg = target.cg;
    sendCursor('move', target.cg.x, target.cg.y);
    await runJxa(mouseMoveJxa(target.cg.x, target.cg.y, from.x, from.y));
    setLastPos(x, y, target.display);
    return okText(`鼠标已移动到图像坐标 (${x}, ${y})（显示器 ${target.display}，逻辑点 ${Math.round(target.logical.x)}, ${Math.round(target.logical.y)}）`);
  },

  // 点击流程（简化版）：
  //   guard() 校验停止标记 / 连续失败
  //   → 抓操作前基线（像素指纹 + 焦点 + 真实浏览器 URL/标题）
  //   → 点击 → verifyClick：先随机等 800~1500ms 再重截 + 读 URL/标题，页面加载则轮询最多 3 秒，
  //     不把「暂时无变化」当失败；只有完整重试后仍无真实证据变化才计入连续失败（需求 #5）。
  //   成功必须由真实证据支撑（像素/焦点/URL/标题），绝不只凭「按键已发出」（需求 #6）。
  //   注（需求 #7）：AI 光标遮罩大小只影响显示，点击坐标一律用真实 CG 坐标 target.cg，
  //   绝不用光标尺寸去「修正」点击落点 —— 见下方 annotateScreenshotJxa 的圆心说明。
  async click(args) {
    await guard();
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    const button = String(args.button || 'left').toLowerCase();
    const display = target.display;
    const before = await captureState(display);
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    // 真正点击前隐藏覆盖层，避免透明窗口拦截命中测试
    sendCursor('hide');
    await sleep(40);
    try {
      if (button === 'left') {
        // 左键主路径走 CoreGraphics 真实鼠标事件（mouseClickJxa）：
        //   鼠标移动 → 左键按下 → 等待约 50ms → 左键抬起，光标真实移动、落点可靠。
        // System Events 辅助功能点击（mouseClickAppleScript）仅保留一次作为备用，
        // 只在 CGEvent 主路径失败时兜底尝试，不重复连续点击同一坐标。
        try {
          await runJxa(mouseClickJxa(target.cg.x, target.cg.y, button, false));
        } catch (e) {
          logErr('CoreGraphics 点击失败，回退 System Events（一次性，不重复）：' + e.message);
          await runAppleScript(mouseClickAppleScript(target.cg.x, target.cg.y));
        }
      } else {
        await runJxa(mouseClickJxa(target.cg.x, target.cg.y, button, false));
      }
    } catch (e) {
      markFailure();
      sendCursor('show');
      throw new Error(`点击失败：${e.message}（已记为第 ${_consecutiveFailures} 次失败；禁止用同一坐标重试，请改用键盘快捷键或重新定位控件中心）`);
    }
    setLastPos(x, y, display);
    sendCursor('click', target.cg.x, target.cg.y);
    const v = await verifyClick(display, before);
    let verify;
    if (v.result === 'ok') {
      const reasonText = v.reason === 'pixel' ? '像素已变化'
        : v.reason === 'focus' ? '焦点已转移'
        : '浏览器 URL/标题已变化';
      verify = `已验证生效（${reasonText}${v.browser && v.browser.url ? '，当前 URL:' + v.browser.url : ''}）`;
      markSuccess();
    } else if (v.result === 'nochange') {
      verify = '完整重试（含 3 秒加载轮询）后仍无任何真实变化（像素/焦点/URL/标题）→ 判定未生效';
      markFailure();
    } else {
      verify = '无法验证（保守视为已执行）';
      markSuccess();
    }
    const frontApp = await getFrontAppName();
    const status = stepStatus(frontApp, `${button}键点击`, `(${x}, ${y}) 显示器${display}`, verify);
    const tip = v.result === 'nochange'
      ? ` 本次点击在多次轮询后仍未产生真实变化，很可能落在控件边缘或目标不可点击。禁止用同一坐标重复点击：请改用键盘快捷键（浏览器地址栏用 focus_address_bar 即 ⌘L），或先 query_ui 读取控件中心坐标，或重新截图定位控件中心。已累计 ${_consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} 次失败，再失败一次将自动停止并需向用户报告原因。`
      : '';
    return okText(`${status} 已在图像坐标 (${x}, ${y}) 点击（${button}键，显示器 ${display}）。${tip}`);
  },

  async double_click(args) {
    await guard();
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    const display = target.display;
    const before = await captureState(display);
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    sendCursor('hide');
    await sleep(40);
    try {
      await runJxa(mouseClickJxa(target.cg.x, target.cg.y, 'left', true));
    } catch (e) {
      markFailure();
      sendCursor('show');
      throw new Error(`双击失败：${e.message}（已记为第 ${_consecutiveFailures} 次失败）`);
    }
    setLastPos(x, y, display);
    sendCursor('click', target.cg.x, target.cg.y);
    const v = await verifyClick(display, before);
    let verify;
    if (v.result === 'ok') { verify = '界面已变化，双击生效'; markSuccess(); }
    else if (v.result === 'nochange') { verify = '完整重试后仍无真实变化 → 判定未生效'; markFailure(); }
    else { verify = '无法验证（保守视为已执行）'; markSuccess(); }
    const frontApp = await getFrontAppName();
    const status = stepStatus(frontApp, '双击', `(${x}, ${y}) 显示器${display}`, verify);
    return okText(`${status} 已在图像坐标 (${x}, ${y}) 双击（显示器 ${display}）。`);
  },

  async right_click(args) {
    await guard();
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    const display = target.display;
    const before = await captureState(display);
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    sendCursor('hide');
    await sleep(40);
    try {
      await runJxa(mouseClickJxa(target.cg.x, target.cg.y, 'right', false));
    } catch (e) {
      markFailure();
      sendCursor('show');
      throw new Error(`右键点击失败：${e.message}（已记为第 ${_consecutiveFailures} 次失败）`);
    }
    setLastPos(x, y, display);
    sendCursor('click', target.cg.x, target.cg.y);
    const v = await verifyClick(display, before);
    let verify;
    if (v.result === 'ok') { verify = '右键菜单已出现'; markSuccess(); }
    else if (v.result === 'nochange') { verify = '完整重试后仍无真实变化 → 判定未生效'; markFailure(); }
    else { verify = '无法验证（保守视为已执行）'; markSuccess(); }
    const frontApp = await getFrontAppName();
    const status = stepStatus(frontApp, '右键点击', `(${x}, ${y}) 显示器${display}`, verify);
    return okText(`${status} 已在图像坐标 (${x}, ${y}) 右键点击（显示器 ${display}）。`);
  },

  async drag(args) {
    await guard();
    const f = await modelToTarget(args.from_x, args.from_y, args.display);
    const t = await modelToTarget(args.to_x, args.to_y, args.display);
    _lastCg = t.cg;
    // 瞬移到起点（避免中途 hover 触发意外状态），settle 后再按下左键
    sendCursor('move', f.cg.x, f.cg.y);
    await runJxa(mouseMoveInstantJxa(f.cg.x, f.cg.y));
    await sleep(50);
    sendCursor('down', f.cg.x, f.cg.y);
    await runJxa(mouseDownJxa(f.cg.x, f.cg.y));
    await sleep(50);
    try {
      // 缓动动画拖到终点；finally 保证左键必定松开，杜绝卡键
      await runJxa(mouseDragMoveJxa(f.cg.x, f.cg.y, t.cg.x, t.cg.y));
      sendCursor('move', t.cg.x, t.cg.y);
    } finally {
      await runJxa(mouseUpJxa(t.cg.x, t.cg.y));
      sendCursor('up', t.cg.x, t.cg.y);
    }
    setLastPos(args.to_x, args.to_y, t.display);
    return okText(`已从 (${args.from_x}, ${args.from_y}) 拖拽到 (${args.to_x}, ${args.to_y})（显示器 ${t.display}）`);
  },

  // 输入（v1.5.0 强化）：失败最多重试一次，且第二次必须换路径——
  //   ASCII 文本改用 System Events keystroke；非 ASCII 则重新确认输入焦点后再粘贴一次。
  //   两次都失败即计入连续失败并如实报错，要求改用快捷键或重新定位，绝不用同一坐标死循环。
  async type(args) {
    await guard();
    const text = String(args.text != null ? args.text : '');
    if (!text) return okText('（未输入任何文字）');
    if (_lastPos) sendCursor('move', _lastPos.x, _lastPos.y);
    const brief = text.length > 60 ? text.slice(0, 60) + '…' : text;
    const isAscii = /^[\x20-\x7E\n\r\t]*$/.test(text);
    let firstErr = null;
    try {
      await typeViaClipboard(text);
      markSuccess();
      const frontApp = await getFrontAppName();
      return okText(`${stepStatus(frontApp, '输入文字', '当前焦点输入框', '已回读确认内容落入输入框')} 已粘贴输入：${brief}（剪贴板方式，完整支持中文/长文本/换行）`);
    } catch (e) {
      firstErr = e;
      logErr('type 第一次失败：' + e.message);
    }

    // ---- 唯一一次重试：必须换路径 ----
    try {
      if (isAscii) {
        await typeAsciiKeystroke(text);
        markSuccess();
        const frontApp = await getFrontAppName();
        return okText(`${stepStatus(frontApp, '输入文字(重试)', '当前焦点输入框', '剪贴板路径失败，已改用键盘逐字输入')} 已输入：${brief}`);
      }
      await typeViaClipboard(text);
      markSuccess();
      const frontApp = await getFrontAppName();
      return okText(`${stepStatus(frontApp, '输入文字(重试)', '当前焦点输入框', '第二次粘贴已回读确认')} 已粘贴输入：${brief}`);
    } catch (e2) {
      markFailure();
      const msg = String((firstErr && firstErr.message) || e2.message || '');
      const hint =
        ` 已重试 1 次仍失败（累计 ${_consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} 次）。` +
        `禁止再用同一坐标点击后重输：请改用键盘快捷键聚焦目标（浏览器地址栏用 focus_address_bar 即 ⌘L；表单用 tab 键切换焦点），` +
        `或先 query_ui 读取输入框中心坐标重新定位。`;
      if (/辅助功能|Automation|accessibility|-10004|not allowed|not authorized|权限/i.test(msg)) {
        throw new Error('输入失败：请到「系统设置 › 隐私与安全性 › 辅助功能 / 自动化」中允许 AI Copilot 控制「系统事件」，并重试。' + hint);
      }
      throw new Error('输入失败：' + msg + hint);
    }
  },

  async key(args) {
    await guard();
    const key = String(args.key || '').toLowerCase();
    const code = KEY_CODES[key];
    if (code == null) throw new Error(`不支持的按键名：${key}（支持 return/tab/space/escape/方向键/command/shift/option/control/f1-f16 等）`);
    const mods = (Array.isArray(args.modifiers) ? args.modifiers : []).map(String);
    if (FN_KEYCODES.has(code)) mods.push('fn'); // 功能键需附带 fn 才能发出真正的 F1-F12（而非媒体键）
    const danger = isDangerousCombo(key, mods);
    if (danger && !args.confirm) {
      throw new Error(`危险操作已拦截：${danger}。若你确认要执行，请在同一调用中加上 confirm: true 再次发起。`);
    }
    if (_lastCg && isFinite(_lastCg.x)) sendCursor('move', _lastCg.x, _lastCg.y);
    try {
      await runJxa(buildKeyScript(code, mods));
    } catch (e) {
      markFailure();
      throw new Error(`按键失败：${e.message}（已记为第 ${_consecutiveFailures} 次失败）`);
    }
    markSuccess();
    const frontApp = await getFrontAppName();
    const combo = `${mods.length ? mods.join('+') + '+' : ''}${key}`;
    return okText(`${stepStatus(frontApp, '按键 ' + combo, '当前焦点', '按键事件已发出')} 已按下按键 ${key}${mods.length ? '（修饰键：' + mods.join('+') + '）' : ''}${danger ? '（已确认执行危险操作）' : ''}`);
  },

  async hotkey(args) {
    await guard();
    const keys = Array.isArray(args.keys) ? args.keys : [];
    if (!keys.length) throw new Error('keys 不能为空，例如 ["command","c"]');
    const main = String(keys[keys.length - 1]);
    const mods = keys.slice(0, -1).map(String);
    const mainCode = resolveMainCode(main);
    if (mainCode == null) throw new Error(`不支持的按键：${main}`);
    const danger = isDangerousCombo(main, mods);
    if (danger && !args.confirm) {
      throw new Error(`危险操作已拦截：${danger}。若你确认要执行，请在同一调用中加上 confirm: true 再次发起。`);
    }
    if (FN_KEYCODES.has(mainCode)) mods.push('fn'); // 功能键自动补 fn
    if (main.length === 1 && main >= 'A' && main <= 'Z') mods.push('shift'); // 大写字母自动补 shift
    if (_lastCg && isFinite(_lastCg.x)) sendCursor('move', _lastCg.x, _lastCg.y);
    try {
      await runJxa(buildKeyScript(mainCode, mods));
    } catch (e) {
      markFailure();
      throw new Error(`快捷键失败：${e.message}（已记为第 ${_consecutiveFailures} 次失败）`);
    }
    markSuccess();
    const frontApp = await getFrontAppName();
    return okText(`${stepStatus(frontApp, '快捷键 ' + keys.join('+'), '当前焦点', '快捷键事件已发出')} 已触发快捷键 ${keys.join('+')}${danger ? '（已确认执行危险操作）' : ''}`);
  },

  async scroll(args) {
    await guard();
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    sendCursor('move', target.cg.x, target.cg.y);
    const direction = String(args.direction || 'down').toLowerCase();
    const amount = Math.max(1, Math.min(20, parseInt(args.amount, 10) || 3));
    const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const jxa =
      `ObjC.import('CoreGraphics');\n` +
      `var ev = $.CGEventCreateScrollWheelEvent(0, 1, 2, ${dy}, ${dx});\n` +
      `$.CGEventPost($.kCGHIDEventTap, ev);`;
    try {
      await runJxa(jxa);
    } catch (e) {
      // 兜底：部分 macOS 下 CoreGraphics 桥接不可用，给出清晰提示
      markFailure();
      throw new Error('滚动失败：' + e.message + '（部分系统需辅助功能权限，或暂不支持编程滚动）');
    }
    markSuccess();
    const frontApp = await getFrontAppName();
    return okText(`${stepStatus(frontApp, `滚动 ${direction} ${amount}`, `(${x}, ${y}) 显示器${target.display}`, '滚轮事件已发出')} 已在图像坐标 (${x}, ${y}) 向 ${direction} 滚动 ${amount}（显示器 ${target.display}）`);
  },

  // 聚焦应用（简化版）：只按 bundle id 用 open -b 激活，简单确认一次前台。
  //   - 不做窗口稳定 / 辅助功能树 / 自动重聚焦等复杂校验。
  //   - 未确认前台 → 立即失败并中止本轮（不记录目标、后续点击/输入禁止）。
  //   - 确认前台 → 清空旧截图坐标（焦点已切换，必须重新截图，绝不复用旧坐标）。
  async focus_app(args) {
    await guard();
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name 不能为空，请输入 bundle id，例如 "com.apple.Safari" / "com.google.Chrome"');
    const stable = await focusAppByName(name);
    const frontApp = await getFrontAppName();
    if (!stable) {
      markFailure();
      _targetApp = null;   // 聚焦失败：不记录目标应用
      _lastPos = null;     // 旧坐标作废
      _sessionStopped = true; // 立即失败并中止本轮：禁止继续任何点击/输入，直到新一轮指令重置
      throw new Error(
        `${stepStatus(frontApp, '聚焦应用', name, '未确认到前台')} ` +
        `「${name}」未能在约 2 秒内确认为前台应用（当前前台：${frontApp || '未知'}）。` +
        `已中止本轮操作，禁止继续点击/输入。请确认 bundle id 是否正确` +
        `（可用 get_front_app 查看真实前台名），或在「系统设置 › 隐私与安全性 › 辅助功能 / 自动化」` +
        `中允许 AI Copilot 后重试。已累计 ${_consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} 次失败。`
      );
    }
    // 成功：记录目标应用 + 清空旧截图坐标（焦点已切换，旧坐标作废，必须重新截图）
    _targetApp = name;
    _lastPos = null;
    _lastCg = { x: 0, y: 0 };
    markSuccess();
    return okText(
      `${stepStatus(frontApp, '聚焦应用', name, '已确认在前台')} 「${name}」已在前台。` +
      `⚠️ 焦点已切换：旧截图坐标一律作废，请先重新 screenshot 获取最新画面，再基于新截图坐标点击/输入。`
    );
  },

  // 读取当前前台应用名：定位前先确认「我在跟哪个应用打交道」
  async get_front_app() {
    await guard();
    const frontApp = await getFrontAppName();
    if (!frontApp) return okText('无法读取前台应用名（可能未授权辅助功能）。');
    const targetNote = _targetApp ? `（本轮目标应用：${_targetApp}${frontMatches(frontApp, _targetApp) ? '，焦点一致' : '，焦点不一致'}）` : '';
    return okText(`${stepStatus(frontApp, '读取前台应用', '-', '已读取')} 当前前台应用：${frontApp}${targetNote}`);
  },

  // 浏览器地址栏（简化版）：只发送 ⌘L，不做任何 AX 焦点检测/剪贴板粘贴——
  // 网址由 type 工具用剪贴板 + ⌘V 输入。
  async focus_address_bar() {
    await guard();
    await focusAddressBar(); // 只发 ⌘L
    const frontApp = await getFrontAppName();
    markSuccess();
    return okText(`${stepStatus(frontApp, '聚焦地址栏(⌘L)', '浏览器地址栏', '⌘L 已发送')} 已发送 ⌘L。请调用 type 输入网址（type 使用剪贴板 + ⌘V），再用 key(return) 回车。`);
  },

  // 读取辅助功能元素（优先于截图坐标）：返回控件角色/名称/中心坐标（已换算为图像坐标系）/状态
  // （v1.6.0 强化，对接需求 #3/#4）：
  //   - 若只读到窗口控件 / 未枚举到可交互元素，等待后重试最多 2 次（共 3 次），给慢速界面/弹窗响应时间；
  //   - 优先使用读到的辅助功能按钮中心点击，反复提示「不要盲点截图坐标」；
  //   - 识别 Chrome 个人资料选择页的「打开用户资料 / 继续使用」等按钮，显式建议优先点击其坐标。
  async query_ui(args) {
    await guard();
    const display = Math.max(1, parseInt(args && args.display, 10) || 1);
    const frontApp = await getFrontAppName();
    let parsed = null;
    let lastErr = null;
    // ③ 若只读到窗口控件 / 未枚举到可交互元素，等待后重试最多 2 次（共 3 次尝试）
    const TRIES = 3;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        parsed = await queryUiElements(display);
        lastErr = null;
      } catch (e) {
        lastErr = e;
        parsed = null;
      }
      // 成功拿到可交互元素即停止重试
      if (parsed && parsed.status === 'OK' && parsed.items.length) break;
      if (attempt < TRIES) await sleep(500); // 等待界面响应后再重试
    }
    // 读取彻底失败（权限/异常）
    if (!parsed) {
      return okText(
        `${stepStatus(frontApp, '读取辅助功能元素', `显示器${display}`, '读取失败')} ` +
        `无法读取辅助功能元素（${lastErr ? lastErr.message : '未知错误'}）。请改用 screenshot 观察界面，并点击控件中心（不要点边缘）。`
      );
    }
    if (parsed.status === 'NOPROC') {
      return okText(`${stepStatus(frontApp, '读取辅助功能元素', `显示器${display}`, '无前台进程')} 未获取到前台应用，请先 focus_app。`);
    }
    if (parsed.status === 'NOWIN') {
      return okText(`${stepStatus(parsed.appName || frontApp, '读取辅助功能元素', `显示器${display}`, '无可读窗口')} 该应用当前无可读窗口，请改用 screenshot 观察。`);
    }
    if (!parsed.items.length) {
      return okText(
        `${stepStatus(parsed.appName || frontApp, '读取辅助功能元素', `显示器${display}`, `连续 ${TRIES} 次未枚举到可交互元素`)} ` +
        `连续 ${TRIES} 次都未读到可交互元素（该应用可能未暴露辅助功能树，如 Chrome 网页正文）。` +
        `⚠️ 请勿盲点截图坐标：优先用 query_ui 反复读取、或 focus_app 后重试；若界面出现按钮` +
        `（尤其 Chrome 个人资料选择页的「打开用户资料 / 继续使用」等），务必用 query_ui 读到的按钮中心坐标点击，而不是凭截图估计落点。`
      );
    }
    // ④ 识别疑似浏览器个人资料/登录选择按钮，显式建议优先点击
    const profileBtns = parsed.items.filter((it) =>
      /打开用户资料|继续使用|选择资料|use profile|continue|profile|资料|登录|sign ?in|登录到|add profile/i.test(it.name || '')
    );
    const lines = parsed.items.slice(0, 50).map((it) =>
      `${it.focused ? '★' : ' '}[${it.role}] ${it.name || '(无名)'} 中心≈(${it.cx}, ${it.cy})${it.enabled ? '' : ' 已禁用'}`
    );
    let header =
      `${stepStatus(parsed.appName || frontApp, '读取辅助功能元素', `显示器${display}`, `读到 ${parsed.items.length} 个控件`)} ` +
      `前台应用「${parsed.appName || frontApp}」可交互元素（坐标已换算为图像坐标系，且均为控件中心，可直接传给 click；★=当前焦点）：\n` +
      lines.join('\n') +
      `\n优先使用上面给出的中心坐标点击（尤其按钮）；这里读不到的（如 Chrome 网页正文）再回退 screenshot 坐标。`;
    if (profileBtns.length) {
      header +=
        `\n\n检测到疑似浏览器个人资料/登录选择按钮，请优先用其控制中心坐标点击：` +
        profileBtns.map((b) => `「${b.name}」(${b.cx}, ${b.cy})`).join('、') + `。`;
    }
    return okText(header);
  },

  // 清除停止标记与连续失败计数（新一轮用户指令开始时由主进程自动下发，也可由模型显式调用）
  async reset_computer_use() {
    const wasStopped = _sessionStopped;
    const fails = _consecutiveFailures;
    resetSession();
    _targetApp = null;
    return okText(`已重置 Computer Use 会话状态（原停止标记=${wasStopped ? '已停止' : '正常'}，原连续失败=${fails}）。`);
  },

  async get_displays() {
    const displays = await ensureDisplays(true);
    const lines = displays.map((d, i) => {
      const shot = computeShotSize(d.width, d.height);
      return `显示器 ${i + 1}：逻辑 ${d.width}×${d.height}，图像坐标系 ${shot.imgW}×${shot.imgH}，全局原点 (${d.originX}, ${d.originY})`;
    });
    return {
      content: [{
        type: 'text',
        text:
          `共 ${displays.length} 个显示器（CoreGraphics 全局坐标系，原点在主屏左上角，y 向下）：\n` + lines.join('\n') +
          `\n提示：截图/鼠标工具可传 display 参数（1=主屏）指定显示器；鼠标坐标请用对应显示器的「图像坐标系」尺寸。`,
      }],
    };
  },
};

function numPair(args, kx, ky) {
  const x = Math.round(Number(args[kx]));
  const y = Math.round(Number(args[ky]));
  if (!isFinite(x) || !isFinite(y)) throw new Error(`${kx}/${ky} 必须是数字坐标`);
  return { x, y };
}

function okText(t) {
  return { content: [{ type: 'text', text: t }] };
}

// 识别危险快捷键组合（退出/关闭窗口/注销/强制退出等），返回中文原因，否则 null。
// 仅当组合含 command(⌘) 且主键命中受保护键时判定为危险；需模型显式 confirm:true 才放行。
function isDangerousCombo(main, mods) {
  const m = String(main || '').toLowerCase();
  const list = (Array.isArray(mods) ? mods : []).map(String).map((s) => s.toLowerCase());
  const has = (k) => list.includes(k);
  const cmd = has('command') || has('cmd');
  if (!cmd) return null;
  if (m === 'q') {
    if (has('shift')) return '退出登录（⌘⇧Q）';
    return '退出当前应用（⌘Q）';
  }
  if (m === 'w') return '关闭当前窗口（⌘W）';
  if (m === 'escape' || m === 'esc') {
    if (has('option') || has('alt')) return '强制退出应用（⌘⌥Esc）';
  }
  return null;
}

function spawnAsync(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    setCurrentChild(p);
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearCurrentChild(p); reject(e); });
    p.on('close', (code) => {
      clearCurrentChild(p);
      if (code !== 0) {
        if (_abortKill) { _abortKill = false; return reject(new Error('操作已被用户中断（Esc / 停止按钮）')); }
        return reject(new Error(`命令 ${cmd} 失败（code=${code}）：${(err || '').trim()}`));
      }
      resolve();
    });
  });
}

// 运行命令并捕获 stdout（用于 pbpaste 读剪贴板）；可选 inputText 写入 stdin（用于 pbcopy）
function runCmdCapture(cmd, cmdArgs, inputText) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    if (inputText != null) {
      p.stdin.write(inputText);
      p.stdin.end();
    }
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`命令 ${cmd} 失败（code=${code}）：${(err || '').trim()}`));
      resolve(out);
    });
  });
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ---------------- 工具定义（inputSchema） ---------------- */

const TOOL_DEFS = [
  {
    name: 'get_screen_size',
    description: '获取指定显示器的「图像坐标系」尺寸（即你截图中看到的像素尺寸，原点左上角）。截图或点击前建议先调用以了解坐标范围；多显示器时传 display 选择显示器（1=主屏）。后续所有坐标都基于此尺寸输出。',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'number', description: '显示器序号，1=主屏，默认 1' } },
    },
  },
  {
    name: 'screenshot',
    description: '截取指定显示器全屏并返回一张图片。图像会被等比缩放到上限尺寸（约 1366×887），因此你看到的图像像素即为坐标空间，后续点击/移动请基于该图像尺寸（用 get_screen_size 获取精确值）输出坐标，原点在左上角。多显示器时传 display（1=主屏）。截图坐标是「最后手段」：能用快捷键就用快捷键，能用 query_ui 读到控件中心就用 query_ui；必须用坐标时，务必取控件几何中心，不要点边缘。',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'number', description: '显示器序号，1=主屏，默认 1' } },
    },
  },
  {
    name: 'move',
    description: '把鼠标移动到指定图像坐标 (x, y)（与截图图像尺寸一致，原点左上角）。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（图像像素，与截图尺寸一致）' },
        y: { type: 'number', description: '纵坐标（图像像素，与截图尺寸一致）' },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'click',
    description: '在指定图像坐标 (x, y) 点击鼠标。button 可选 left/right/middle，默认 left。坐标必须是控件的几何中心，不能是边缘（可先用 query_ui 拿到精确中心）。点击后会自动验证：先随机等待 800~1500ms 再重新截图比对像素，并读取真实浏览器 URL/标题与焦点状态；若页面仍在加载（暂时无变化）会继续轮询最多 3 秒，不会把「暂时无变化」误判为点击失败；只有「完整重试后仍无任何真实变化」才判定本次点击「未生效」并计入连续失败——此时禁止用同一坐标重试，应改用键盘快捷键或重新定位；连续 2 次失败会自动停止并要求你向用户报告原因。成功一律以真实证据（像素/焦点/URL/标题变化）为准，不会只因「按键已发出」就报完成。左键主路径走 CoreGraphics 真实鼠标事件（鼠标移动 → 左键按下 → 等待约 50ms → 左键抬起，光标真实移动、落点可靠），失败时仅回退一次 System Events 辅助功能点击（不重复连续点击）。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（图像像素，与截图尺寸一致）' },
        y: { type: 'number', description: '纵坐标（图像像素，与截图尺寸一致）' },
        button: { type: 'string', description: 'left / right / middle，默认 left', enum: ['left', 'right', 'middle'] },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'double_click',
    description: '在指定图像坐标 (x, y) 双击鼠标。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（图像像素，与截图尺寸一致）' },
        y: { type: 'number', description: '纵坐标（图像像素，与截图尺寸一致）' },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'right_click',
    description: '在指定图像坐标 (x, y) 右键点击。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（图像像素，与截图尺寸一致）' },
        y: { type: 'number', description: '纵坐标（图像像素，与截图尺寸一致）' },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'drag',
    description: '从图像坐标 (from_x, from_y) 按住鼠标拖拽到 (to_x, to_y)。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        from_x: { type: 'number', description: '起点横坐标（图像像素）' },
        from_y: { type: 'number', description: '起点纵坐标（图像像素）' },
        to_x: { type: 'number', description: '终点横坐标（图像像素）' },
        to_y: { type: 'number', description: '终点纵坐标（图像像素）' },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
  },
  {
    name: 'type',
    description: '在当前焦点处输入一段文字（支持中文/长文本/换行）。走剪贴板 ⌘V 并回读校验，确保内容真的落进输入框（不做 AX 焦点检测等复杂校验，粘贴后由回读验证兜底判定，绝不假报成功）。调用前请先确保目标已聚焦（浏览器地址栏先 focus_address_bar 发送 ⌘L，再调用本工具输入网址；表单可用 key(tab) 切换焦点）。失败时本工具只会换路径重试一次（ASCII 改用键盘逐字输入），仍失败则如实报错——此时不要用同一坐标点一遍再输一遍，请改用快捷键或 query_ui 重新定位输入框。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要输入的文字' } },
      required: ['text'],
    },
  },
  {
    name: 'key',
    description: '按下单个特殊按键，可同时按住修饰键。key 支持：return/tab/space/escape/left/right/up/down/delete/home/end/pageup/pagedown/f1-f16/command/shift/option/control 等；modifiers 为修饰键数组，如 ["command"]。功能键 F1-F12 会自动附带 fn 修饰键，以发出真正的 F 键而非媒体键。注意：⌘Q/⌘W/⌘⇧Q/⌘⌥Esc 等危险组合会被拦截，需 confirm:true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键数组，如 ["command","shift"]' },
        confirm: { type: 'boolean', description: '对危险组合（如 ⌘Q 退出应用）显式二次确认，true 才放行' },
      },
      required: ['key'],
    },
  },
  {
    name: 'hotkey',
    description: '触发组合快捷键。凡是能用快捷键完成的操作都优先用本工具，而不是截图找坐标点击：地址栏 ["command","l"]（也可直接用 focus_address_bar）、新标签页 ["command","t"]、刷新 ["command","r"]、复制 ["command","c"]、粘贴 ["command","v"]、全选 ["command","a"]、保存 ["command","s"]、查找 ["command","f"]、切换应用 ["command","tab"]、Spotlight ["command","space"]。数组中最后一个元素为主键，前面为修饰键。主键为功能键（f1-f12）时自动附带 fn，大写字母自动补 shift。注意：含 ⌘Q/⌘W/⌘⇧Q/⌘⌥Esc 的危险组合会被拦截，需 confirm:true 才执行。',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: '按键序列，如 ["command","c"]' },
        confirm: { type: 'boolean', description: '对危险组合（如 ⌘Q 退出应用）显式二次确认，true 才放行' },
      },
      required: ['keys'],
    },
  },
  {
    name: 'scroll',
    description: '在指定图像坐标处滚动鼠标滚轮。direction 为 up/down/left/right，amount 为滚动量（1-20）。多显示器时传 display（1=主屏）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（图像像素，与截图尺寸一致）' },
        y: { type: 'number', description: '纵坐标（图像像素，与截图尺寸一致）' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: '滚动量 1-20，默认 3' },
        display: { type: 'number', description: '显示器序号，1=主屏，默认 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'focus_app',
    description: '将指定应用按 **bundle id** 激活到前台（open -b，如 "com.apple.Safari" / "com.google.Chrome"），随后简单确认一次前台；约 2 秒内确认失败则**立即失败并中止本轮**——禁止继续任何点击/输入。成功后该应用被记为「本轮目标应用」。⚠️ 成功后焦点已切换，**旧截图坐标一律作废**，必须先重新 screenshot 再基于新截图坐标点击/输入。开始任何一串操作前都应先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '应用名或 bundle id，如 "Safari" / "Google Chrome" / "com.apple.Safari"' } },
      required: ['name'],
    },
  },
  {
    name: 'get_front_app',
    description: '读取当前前台应用的真实名称，并报告它与「本轮目标应用」是否一致。用于操作前确认焦点、或 focus_app 报名称不符时查真名。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'focus_address_bar',
    description: '聚焦浏览器地址栏：只发送 ⌘L，不做任何 AX 焦点检测/剪贴板粘贴（简化版）。操作 Chrome/Safari/Edge 地址栏时必须用本工具，禁止用截图坐标去点地址栏。发送 ⌘L 后请调用 type 输入网址（type 使用剪贴板 + ⌘V），再 key(return) 回车。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_ui',
    description: '读取前台应用的可交互辅助功能元素（按钮/输入框/下拉/复选框/链接等）的角色、名称、启用与聚焦状态，以及已换算好的「控件中心」图像坐标，可直接传给 click。定位控件时优先用本工具，读不到（如 Chrome 网页正文不暴露 AX 树）再回退 screenshot 看图取坐标。若首次只读到窗口控件/未枚举到可交互元素，本工具会自动等待并重试最多 2 次（给慢速弹窗/界面响应时间），请勿盲点截图坐标——尤其 Chrome 个人资料选择页的「打开用户资料 / 继续使用」等按钮，若本工具能读到，务必用其控制中心坐标点击。',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'number', description: '显示器序号，1=主屏，默认 1' } },
    },
  },
  {
    name: 'reset_computer_use',
    description: '重置 Computer Use 会话状态（清除停止标记、连续失败计数与目标应用）。用户点「停止」后本轮会拒绝所有操作，正常情况下新一轮指令由主进程自动重置，一般无需手动调用。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_displays',
    description: '枚举所有显示器（数量、逻辑分辨率、图像坐标系尺寸、CoreGraphics 全局原点）。多显示器环境下用于确定各显示器坐标范围与 display 序号，便于截图/鼠标操作指定显示器。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ---------------- MCP 协议处理 ---------------- */

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return; // 通知无需回复
  }

  // 控制消息：用户中断（Esc / 停止按钮）通过 stdin 注入 __abort，或 MCP cancelled 通知
  if (msg.__abort) { abortCurrent(); return; }
  if (msg.method === 'notifications/cancelled') { abortCurrent(); return; }
  // 控制消息：新一轮用户指令开始，主进程注入 __reset 清除停止标记与失败计数
  if (msg.__reset) { resetSession(); return; }

  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOL_DEFS } });
    return;
  }

  if (msg.method === 'tools/call') {
    handleToolCall(msg);
    return;
  }
  // 其它方法（ping 等）忽略
}

async function handleToolCall(msg) {
  const name = msg.params && msg.params.name;
  const args = (msg.params && msg.params.arguments) || {};
  // 新请求开始：清除上一次中断标记（中断只作用于当时在途的那个操作）
  _aborted = false;
  _abortKill = false;
  let result;
  const fn = TOOLS[name];
  if (!fn) {
    result = { isError: true, content: [{ type: 'text', text: '未知工具：' + name }] };
  } else {
    try {
      result = await fn(args);
    } catch (e) {
      result = { isError: true, content: [{ type: 'text', text: '执行出错：' + e.message }] };
    }
  }
  send({ jsonrpc: '2.0', id: msg.id, result });
}

/* ---------------- 入口 ---------------- */

function start() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; } // 忽略非 JSON 噪声
      try { handleMessage(msg); } catch (e) { logErr('handle error: ' + e.stack); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  // 防止未捕获异常导致子进程崩溃（返回错误而非退出）
  process.on('uncaughtException', (e) => logErr('uncaught: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => logErr('unhandledRejection: ' + (e && e.stack || e)));
  // 收到 SIGTERM 时干净退出（与主进程断开联动）
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = {
  start, SERVER_NAME, SERVER_VERSION, computeShotSize, mouseClickAppleScript, MAX_SHOT_W, MAX_SHOT_H,
  buildKeyScript, pasteAppleScript, pasteVerificationResult, typeViaClipboard,
  KEY_CODES, CHAR_KEYCODES,
  // v1.5.0 健壮性相关（纯函数，便于单测）
  signaturesDiffer, frontMatches, stepStatus, MAX_CONSECUTIVE_FAILURES, TOOL_DEFS,
};

// 直接以 `node computer-use.js` 运行时自启动（Electron 子进程由 main.js 早退分支调用 start()，不会触发此分支）
if (require.main === module) start();
