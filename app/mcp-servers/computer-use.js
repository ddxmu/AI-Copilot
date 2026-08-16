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

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ComputerUse';
const SERVER_VERSION = '1.4.2';

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
function abortCurrent() {
  _aborted = true;
  _abortKill = true;
  if (_lastCg) runJxa(mouseUpJxa(_lastCg.x, _lastCg.y)).catch(() => {});
  if (_currentChild) {
    try { _currentChild.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
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
  // 对标 Claude Code moveAndSettle：瞬移后等 50ms，给 input→HID→AppKit 一个 round-trip，
  // 让目标应用 hover 状态稳定、clickCount 计时正确，落点更可靠。
  lines.push('$.NSThread.sleepForTimeInterval(0.05);');
  const n = isDouble ? 2 : 1;
  for (let i = 0; i < n; i++) {
    lines.push(`var d${i}=$.CGEventCreateMouseEvent(0,${down},$.CGPointMake(${x},${y}),${btn});`);
    if (n > 1) lines.push(`$.CGEventSetIntegerValueField(d${i},$.kCGMouseEventClickState,${n});`);
    lines.push(`$.CGEventPost($.kCGHIDEventTap,d${i});`);
    // 目标应用需要一小段时间完成 hit-test 与状态切换；down/up 背靠背容易被忽略
    lines.push('$.NSThread.sleepForTimeInterval(0.04);');
    lines.push(`var u${i}=$.CGEventCreateMouseEvent(0,${up},$.CGPointMake(${x},${y}),${btn});`);
    if (n > 1) lines.push(`$.CGEventSetIntegerValueField(u${i},$.kCGMouseEventClickState,${n});`);
    lines.push(`$.CGEventPost($.kCGHIDEventTap,u${i});`);
    if (n > 1 && i === 0) lines.push('$.NSThread.sleepForTimeInterval(0.06);');
  }
  return lines.join('\n');
}

// 左键点击优先走 macOS System Events 的辅助功能点击（click at 坐标入口），
// 对 Chrome / Electron 的 HTML 控件命中最可靠。
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
//
// 流程与「防假报成功」保证：
//   ① 保存用户剪贴板（finally 还原，不污染）
//   ② pbcopy 写入 + pbpaste 回读校验（不一致视为写入失败）
//   ③ 粘贴前确认前台有「可编辑、聚焦」的文本控件（hasEditableFocus）；若无输入焦点，
//      粘贴注定无处可去，直接抛错，而非假报成功
//   ④ ⌘V 粘贴：主键事件已通过 CGEventSetFlags 注入 command 修饰标志（见 buildKeyScript），
//      解决 Chrome/Electron 把 ⌘V 误判为裸 v、只落一个字符的问题；CoreGraphics 失败时
//      回退 System Events `keystroke "v" using command down`（同一环境变量下更稳）
//   ⑤ 按文本长度充分等待，避免 finally 还原剪贴板截断正在进行的粘贴
//   ⑥ 尽力回读目标字段内容（⌘A+⌘C 读出），确认确实进入窗口（verifyPasteLanded）；
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

    // ③ 粘贴前确认有可编辑输入焦点（防假报成功）
    const focused = await hasEditableFocus();
    if (!focused) {
      throw new Error('当前焦点不在可编辑输入框（地址栏/文本框）。请先用 click 聚焦目标输入控件，再调用 type。');
    }

    // ④ 粘贴：⌘V
    try {
      await runJxa(buildKeyScript(CHAR_KEYCODES['v'], ['command']));
    } catch (e) {
      logErr('CoreGraphics ⌘V 失败，回退 System Events：' + e.message);
      await runAppleScript(pasteAppleScript());
    }

    // ⑤ 等粘贴真正落盘（按文本长度给足时间），避免 finally 还原剪贴板截断正在进行的粘贴
    await sleep(Math.min(2000, 120 + text.length * 6));

    // ⑥ 回读目标字段，确认内容确实进入窗口
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

// 检查前台进程是否有「可编辑、聚焦」的文本控件（AX role 为文本类）。
// 用于粘贴前确认目标能接收输入，避免把内容粘贴到无处 → 假报成功。
// 读取失败（如无辅助功能/自动化授权）时保守返回 true：仍尝试粘贴，由后续回读验证兜底。
async function hasEditableFocus() {
  try {
    const out = await runAppleScript(
      'tell application "System Events"\n' +
      '  set p to first process whose frontmost is true\n' +
      '  set fe to focused UI element of p\n' +
      '  return role of fe\n' +
      'end tell'
    );
    const role = (out || '').trim();
    // 只接受真正的可编辑文本角色，排除 AXStaticText 等只读文本
    return /text field|text area|text view|combo box|search field|AXTextField|AXTextArea|AXTextView|AXComboBox|AXSearchField/i.test(role);
  } catch (e) {
    return true;
  }
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

// 在截图上绘制红色点击环（best-effort，失败不影响主流程）
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
var r = Math.max(16, Math.min(w, h) * 0.035);
$.CGContextSetStrokeColorWithColor(ctx, $.CGColorCreateGenericRGB(1,0,0,1));
$.CGContextSetLineWidth(ctx, 5);
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
    return {
      content: [
        { type: 'text', text: `已截取显示器 ${display} 全屏，图像尺寸 ${shot.imgW} × ${shot.imgH}（逻辑分辨率 ${size.width} × ${size.height}），已包含鼠标光标。${mark}请基于此图像尺寸输出坐标（原点左上角）。` },
        { type: 'image', data: b64, mimeType: 'image/png' },
      ],
    };
  },

  async move(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    const from = _lastCg && isFinite(_lastCg.x) ? _lastCg : { x: target.cg.x, y: target.cg.y };
    _lastCg = target.cg;
    sendCursor('move', target.cg.x, target.cg.y);
    await runJxa(mouseMoveJxa(target.cg.x, target.cg.y, from.x, from.y));
    setLastPos(x, y, target.display);
    return okText(`鼠标已移动到图像坐标 (${x}, ${y})（显示器 ${target.display}，逻辑点 ${Math.round(target.logical.x)}, ${Math.round(target.logical.y)}）`);
  },

  async click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    const button = String(args.button || 'left').toLowerCase();
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    // 真正点击前隐藏覆盖层，避免透明窗口拦截命中测试
    sendCursor('hide');
    await sleep(40);
    if (button === 'left') {
      // 左键优先 System Events 辅助功能点击；若被系统拒绝（权限/特殊 UI）回退 CoreGraphics
      try {
        await runAppleScript(mouseClickAppleScript(target.cg.x, target.cg.y));
      } catch (e) {
        logErr('System Events 辅助功能点击失败，回退 CoreGraphics：' + e.message);
        await runJxa(mouseClickJxa(target.cg.x, target.cg.y, button, false));
      }
    } else {
      await runJxa(mouseClickJxa(target.cg.x, target.cg.y, button, false));
    }
    setLastPos(x, y, target.display);
    sendCursor('click', target.cg.x, target.cg.y);
    return okText(`已在图像坐标 (${x}, ${y}) 点击（${button}键，显示器 ${target.display}）`);
  },

  async double_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    sendCursor('hide');
    await sleep(40);
    await runJxa(mouseClickJxa(target.cg.x, target.cg.y, 'left', true));
    setLastPos(x, y, target.display);
    sendCursor('click', target.cg.x, target.cg.y);
    return okText(`已在图像坐标 (${x}, ${y}) 双击（显示器 ${target.display}）`);
  },

  async right_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const target = await modelToTarget(x, y, args.display);
    _lastCg = target.cg;
    sendCursor('move', target.cg.x, target.cg.y);
    await sleep(30);
    sendCursor('hide');
    await sleep(40);
    await runJxa(mouseClickJxa(target.cg.x, target.cg.y, 'right', false));
    setLastPos(x, y, target.display);
    sendCursor('click', target.cg.x, target.cg.y);
    return okText(`已在图像坐标 (${x}, ${y}) 右键点击（显示器 ${target.display}）`);
  },

  async drag(args) {
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

  async type(args) {
    const text = String(args.text != null ? args.text : '');
    if (!text) return okText('（未输入任何文字）');
    if (_lastPos) sendCursor('move', _lastPos.x, _lastPos.y);
    try {
      await typeViaClipboard(text);
      return okText(`已粘贴输入文字：${text.length > 60 ? text.slice(0, 60) + '…' : text}（剪贴板方式，完整支持中文/长文本/换行）`);
    } catch (e) {
      // 剪贴板（⌘V）已是 Chrome/Electron/普通输入框最可靠的输入路径，失败时不再用 keystroke
      // 重输整段——那会丢中文/长文本/换行，并可能假报成功。如实上报错误并提示授权。
      const msg = String(e.message || '');
      if (/辅助功能|Automation|accessibility|-10004|not allowed|not authorized|权限/i.test(msg)) {
        throw new Error('输入失败：请到「系统设置 › 隐私与安全性 › 辅助功能 / 自动化」中允许 AI Copilot 控制「系统事件」，并重试。');
      }
      throw new Error('输入失败：' + msg);
    }
  },

  async key(args) {
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
    await runJxa(buildKeyScript(code, mods));
    return okText(`已按下按键 ${key}${mods.length ? '（修饰键：' + mods.join('+') + '）' : ''}${danger ? '（已确认执行危险操作）' : ''}`);
  },

  async hotkey(args) {
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
    await runJxa(buildKeyScript(mainCode, mods));
    return okText(`已触发快捷键 ${keys.join('+')}${danger ? '（已确认执行危险操作）' : ''}`);
  },

  async scroll(args) {
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
      throw new Error('滚动失败：' + e.message + '（部分系统需辅助功能权限，或暂不支持编程滚动）');
    }
    return okText(`已在图像坐标 (${x}, ${y}) 向 ${direction} 滚动 ${amount}（显示器 ${target.display}）`);
  },

  async focus_app(args) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('name 不能为空，例如 "Safari"、"Finder"，或 bundle id 如 "com.apple.Safari"');
    let launched = false;
    try {
      const out = await runJxa(
        `ObjC.import('Cocoa');\n` +
        `var ws = $.NSWorkspace.sharedWorkspace;\n` +
        `var ok = ws.launchApplication($(${JSON.stringify(name)}));\n` +
        `ok ? '1' : '0';`
      );
      launched = String(out || '').trim() === '1';
    } catch (e) {
      logErr('focus_app launchApplication failed: ' + e.message);
    }
    if (!launched) {
      // 回退：AppleScript activate（需要「自动化」授权）
      await runAppleScript(`tell application "${asStrLiteral(name)}" to activate`);
    }
    return okText(`已尝试将「${name}」切换/启动到前台（best-effort）。若未生效，请确认应用名称正确，并在「系统设置 › 隐私与安全性 › 辅助功能 / 自动化」中允许 AI Copilot。`);
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
    description: '截取指定显示器全屏并返回一张图片。图像会被等比缩放到上限尺寸（约 1366×887），因此你看到的图像像素即为坐标空间，后续点击/移动请基于该图像尺寸（用 get_screen_size 获取精确值）输出坐标，原点在左上角。多显示器时传 display（1=主屏）。每次操作电脑前通常先截图，观察界面后再决定下一步动作。',
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
    description: '在指定图像坐标 (x, y) 点击鼠标。button 可选 left/right/middle，默认 left。左键优先走 macOS System Events 辅助功能点击（对 Chrome/Electron 等 HTML 控件命中可靠，5 秒超时保护），被系统拒绝时自动回退 CoreGraphics 真实事件；下一次同显示器截图会用红圈标出点击位置。多显示器时传 display（1=主屏）。',
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
    description: '在当前焦点处输入一段文字（支持换行）。',
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
    description: '触发组合快捷键，例如复制 ["command","c"]、保存 ["command","s"]、切换应用 ["command","tab"]。数组中最后一个元素为主键，前面为修饰键。主键为功能键（f1-f12）时会自动附带 fn，大写字母自动补 shift。注意：含 ⌘Q/⌘W/⌘⇧Q/⌘⌥Esc 的危险组合会被拦截，需 confirm:true 才执行。',
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
    description: '将指定应用切换/启动到前台（best-effort）。name 可为应用名（如 "Safari"、"Finder"、"Chrome"）或 bundle id（如 "com.apple.Safari"）。若应用未运行会尝试启动。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '应用名或 bundle id，如 "Safari" / "com.apple.Safari"' } },
      required: ['name'],
    },
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
  start, SERVER_NAME, computeShotSize, mouseClickAppleScript, MAX_SHOT_W, MAX_SHOT_H,
  buildKeyScript, pasteAppleScript, pasteVerificationResult, typeViaClipboard,
  KEY_CODES, CHAR_KEYCODES,
};

// 直接以 `node computer-use.js` 运行时自启动（Electron 子进程由 main.js 早退分支调用 start()，不会触发此分支）
if (require.main === module) start();
