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

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ComputerUse';
const SERVER_VERSION = '1.2.0';

const TMP = path.join(os.tmpdir(), 'ai-copilot-computer-use');
try { fs.mkdirSync(TMP, { recursive: true }); } catch (e) { /* ignore */ }

/* ---------------- 基础工具 ---------------- */

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function logErr(msg) {
  process.stderr.write('[computer-use] ' + msg + '\n');
}

// 运行一段 AppleScript（NSAppleScript 文本），返回 stdout 文本
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
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
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('JXA 执行失败：' + ((err || '').trim() || '未知错误')));
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

/* ---------------- 屏幕尺寸（逻辑点） ---------------- */

let _screenSize = null;
function getScreenSize() {
  return new Promise((resolve, reject) => {
    // 通过 Finder 桌面窗口 bounds 获取主显示器逻辑分辨率（points）
    const p = spawn('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        const detail = (err || '').trim();
        if (/not allowed|not authorized|accessibility|权限违例|-10004/i.test(detail)) {
          return reject(new Error('获取屏幕尺寸被拒绝：请到「系统设置 › 隐私与安全性 › 辅助功能」允许 AI Copilot。'));
        }
        return reject(new Error('获取屏幕尺寸失败：' + detail));
      }
      const m = out.match(/\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/);
      if (!m) return reject(new Error('无法解析屏幕尺寸：' + out));
      const w = parseInt(m[3], 10) - parseInt(m[1], 10);
      const h = parseInt(m[4], 10) - parseInt(m[2], 10);
      resolve({ width: w, height: h });
    });
  });
}

async function ensureScreenSize() {
  if (!_screenSize) _screenSize = await getScreenSize();
  return _screenSize;
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

// 记录鼠标最后位置（逻辑点），用于截图时绘制点击标记
let _lastPos = null;
function setLastPos(x, y) { _lastPos = { x, y }; }

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
    lines.push(`var u${i}=$.CGEventCreateMouseEvent(0,${up},$.CGPointMake(${x},${y}),${btn});`);
    if (n > 1) lines.push(`$.CGEventSetIntegerValueField(u${i},$.kCGMouseEventClickState,${n});`);
    lines.push(`$.CGEventPost($.kCGHIDEventTap,u${i});`);
    if (n > 1 && i === 0) lines.push('$.NSThread.sleepForTimeInterval(0.06);');
  }
  return lines.join('\n');
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

// 组合键：依次 post 修饰键 down → 主键 down/up → 修饰键 up
function buildKeyScript(mainCode, modNames) {
  const MOD_KC = { command: 55, cmd: 55, shift: 56, option: 58, alt: 58, control: 59, ctrl: 59, fn: 63, function: 63 };
  const lines = ['ObjC.import("CoreGraphics");'];
  const modCodes = [];
  for (const m of modNames) {
    const mc = MOD_KC[String(m).toLowerCase()];
    if (mc == null) continue;
    modCodes.push(mc);
    lines.push(`var md${mc}=$.CGEventCreateKeyboardEvent(0,${mc},true);$.CGEventPost($.kCGHIDEventTap,md${mc});`);
  }
  lines.push(`var kd=$.CGEventCreateKeyboardEvent(0,${mainCode},true);$.CGEventPost($.kCGHIDEventTap,kd);`);
  lines.push(`var ku=$.CGEventCreateKeyboardEvent(0,${mainCode},false);$.CGEventPost($.kCGHIDEventTap,ku);`);
  for (let i = modCodes.length - 1; i >= 0; i--) {
    const mc = modCodes[i];
    lines.push(`var mu${mc}=$.CGEventCreateKeyboardEvent(0,${mc},false);$.CGEventPost($.kCGHIDEventTap,mu${mc});`);
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

// 对标 Claude Code computer-use 的 typeViaClipboard：用剪贴板写入文本再 Cmd+V 粘贴，
// 规避 System Events `keystroke` 对中文/长文本丢字、乱序、emoji 截断的问题。
// 流程：①保存用户剪贴板 ②pbcopy 写入 ③pbpaste 回读校验（不一致视为写入失败）
//       ④Cmd+V ⑤sleep 100ms（粘贴生效 vs 还原剪贴板的竞态阈值）⑥finally 还原剪贴板。
// 任何一步失败都抛出，由调用方回退到 keystroke，绝不污染用户剪贴板。
async function typeViaClipboard(text) {
  let saved = null;
  try { saved = await runCmdCapture('pbpaste', []); } catch (e) { /* 读不到就算了 */ }

  try {
    await runCmdCapture('pbcopy', [], text);
    const back = await runCmdCapture('pbpaste', []);
    if (back !== text) throw new Error('剪贴板回读不一致');
    // Cmd+V：主键 'v' 键码 = CHAR_KEYCODES['v']，修饰键 command
    await runJxa(buildKeyScript(CHAR_KEYCODES['v'], ['command']));
    await sleep(100);
  } finally {
    if (saved != null) {
      try { await runCmdCapture('pbcopy', [], saved); } catch (e) { /* 还原失败忽略 */ }
    }
  }
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
  async get_screen_size() {
    const s = await ensureScreenSize();
    return {
      content: [{ type: 'text', text: `主显示器逻辑分辨率：${s.width} × ${s.height}（坐标系：原点在左上角，单位为逻辑点 points）。` }],
    };
  },

  async screenshot() {
    const size = await ensureScreenSize();
    const src = path.join(TMP, `shot_${Date.now()}.png`);
    const dst = path.join(TMP, `shot_${Date.now()}_s.png`);
    // 全屏截图（-C 捕获鼠标光标，-x 静音，png），输出为设备分辨率
    try {
      await spawnAsync('screencapture', ['-x', '-C', '-t', 'png', src]);
    } catch (e) {
      const msg = String(e.message || '');
      if (/privacy|permission|screen recording|权限|录制/i.test(msg)) {
        throw new Error('截图失败：请到「系统设置 › 隐私与安全性 › 屏幕录制」中允许 AI Copilot，并重试。');
      }
      throw new Error('截图失败：' + msg);
    }
    if (!fs.existsSync(src)) throw new Error('截图失败：未能生成图片（请确认已在「屏幕录制」中允许 AI Copilot）。');
    // 等比缩放到逻辑分辨率，使图像像素与逻辑点 1:1 对应
    await spawnAsync('sips', ['-z', String(size.height), String(size.width), src, '--out', dst]);
    const finalFile = fs.existsSync(dst) ? dst : src;
    // 在最近一次鼠标操作点绘制红色点击环（best-effort，失败不影响返回）
    if (_lastPos) {
      try {
        await runJxa(annotateScreenshotJxa(finalFile, _lastPos.x, _lastPos.y));
      } catch (e) {
        logErr('annotate screenshot failed: ' + e.message);
      }
    }
    const b64 = fileToBase64(finalFile);
    try { fs.unlinkSync(src); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(dst); } catch (e) { /* ignore */ }
    const mark = _lastPos ? `截图中已用红圈标出最近一次鼠标操作位置 (${_lastPos.x}, ${_lastPos.y})。` : '';
    return {
      content: [
        { type: 'text', text: `已截取主屏幕，图像尺寸 ${size.width} × ${size.height}（逻辑点），已包含鼠标光标。${mark}请基于该尺寸输出坐标（原点左上角）。` },
        { type: 'image', data: b64, mimeType: 'image/png' },
      ],
    };
  },

  async move(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const from = _lastPos ? _lastPos : { x: 0, y: 0 };
    await runJxa(mouseMoveJxa(x, y, from.x, from.y));
    setLastPos(x, y);
    return okText(`鼠标已移动到 (${x}, ${y})（桌面光标已平滑移动）`);
  },

  async click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const button = String(args.button || 'left').toLowerCase();
    await runJxa(mouseClickJxa(x, y, button, false));
    setLastPos(x, y);
    return okText(`已在 (${x}, ${y}) 点击（${button}键，已发出真实鼠标事件）`);
  },

  async double_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    await runJxa(mouseClickJxa(x, y, 'left', true));
    setLastPos(x, y);
    return okText(`已在 (${x}, ${y}) 双击`);
  },

  async right_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    await runJxa(mouseClickJxa(x, y, 'right', false));
    setLastPos(x, y);
    return okText(`已在 (${x}, ${y}) 右键点击`);
  },

  async drag(args) {
    const fx = Math.round(Number(args.from_x));
    const fy = Math.round(Number(args.from_y));
    const tx = Math.round(Number(args.to_x));
    const ty = Math.round(Number(args.to_y));
    if ([fx, fy, tx, ty].some((v) => !isFinite(v))) throw new Error('拖拽坐标必须是数字');
    // 瞬移到起点（避免中途 hover 触发意外状态），settle 后再按下左键
    await runJxa(mouseMoveInstantJxa(fx, fy));
    await sleep(50);
    await runJxa(mouseDownJxa(fx, fy));
    await sleep(50);
    try {
      // 缓动动画拖到终点；finally 保证左键必定松开，杜绝卡键
      await runJxa(mouseDragMoveJxa(fx, fy, tx, ty));
    } finally {
      await runJxa(mouseUpJxa(tx, ty));
    }
    setLastPos(tx, ty);
    return okText(`已从 (${fx}, ${fy}) 拖拽到 (${tx}, ${ty})（缓动动画，左键已安全松开）`);
  },

  async type(args) {
    const text = String(args.text != null ? args.text : '');
    if (!text) return okText('（未输入任何文字）');
    try {
      await typeViaClipboard(text);
      return okText(`已粘贴输入文字：${text.length > 60 ? text.slice(0, 60) + '…' : text}（剪贴板方式，完整支持中文/长文本/换行）`);
    } catch (e) {
      // 剪贴板方式失败（如辅助功能权限异常）时回退到 System Events keystroke，保留原能力
      logErr('typeViaClipboard 失败，回退 keystroke：' + e.message);
      const lines = text.split('\n');
      const body = lines
        .map((ln) => `  keystroke "${asStrLiteral(ln)}"${ln !== lines[lines.length - 1] ? '\n  keystroke linefeed' : ''}`)
        .join('\n');
      await runAppleScript(`tell application "System Events"\n${body}\nend tell`);
      return okText(`已输入文字：${text.length > 60 ? text.slice(0, 60) + '…' : text}（keystroke 回退）`);
    }
  },

  async key(args) {
    const key = String(args.key || '').toLowerCase();
    const code = KEY_CODES[key];
    if (code == null) throw new Error(`不支持的按键名：${key}（支持 return/tab/space/escape/方向键/command/shift/option/control/f1-f16 等）`);
    const mods = (Array.isArray(args.modifiers) ? args.modifiers : []).map(String);
    if (FN_KEYCODES.has(code)) mods.push('fn'); // 功能键需附带 fn 才能发出真正的 F1-F12（而非媒体键）
    await runJxa(buildKeyScript(code, mods));
    return okText(`已按下按键 ${key}${mods.length ? '（修饰键：' + mods.join('+') + '）' : ''}`);
  },

  async hotkey(args) {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    if (!keys.length) throw new Error('keys 不能为空，例如 ["command","c"]');
    const main = String(keys[keys.length - 1]);
    const mods = keys.slice(0, -1).map(String);
    const mainCode = resolveMainCode(main);
    if (mainCode == null) throw new Error(`不支持的按键：${main}`);
    if (FN_KEYCODES.has(mainCode)) mods.push('fn'); // 功能键自动补 fn
    if (main.length === 1 && main >= 'A' && main <= 'Z') mods.push('shift'); // 大写字母自动补 shift
    await runJxa(buildKeyScript(mainCode, mods));
    return okText(`已触发快捷键 ${keys.join('+')}`);
  },

  async scroll(args) {
    const { x, y } = numPair(args, 'x', 'y');
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
    return okText(`已在 (${x}, ${y}) 向 ${direction} 滚动 ${amount}`);
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

function spawnAsync(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`命令 ${cmd} 失败（code=${code}）：${(err || '').trim()}`));
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
    description: '获取主显示器的逻辑分辨率（宽 × 高，单位为逻辑点 points，原点在左上角）。在截图或点击前建议先调用，以了解坐标范围。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'screenshot',
    description: '截取当前主屏幕全屏，返回一张图片。图像会被缩放到逻辑分辨率，因此你看到的图像像素与后续点击/移动的坐标 1:1 对应。坐标系原点在左上角。每次操作电脑前通常先截图，观察当前界面后再决定下一步动作。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'move',
    description: '把鼠标移动到指定逻辑坐标 (x, y)。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number', description: '横坐标（逻辑点）' }, y: { type: 'number', description: '纵坐标（逻辑点）' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'click',
    description: '在指定逻辑坐标 (x, y) 点击鼠标。button 可选 left/right/middle，默认 left。使用 CoreGraphics 真实鼠标事件，点击可靠落点；下一次截图会用红圈标出点击位置。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（逻辑点）' },
        y: { type: 'number', description: '纵坐标（逻辑点）' },
        button: { type: 'string', description: 'left / right / middle，默认 left', enum: ['left', 'right', 'middle'] },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'double_click',
    description: '在指定逻辑坐标 (x, y) 双击鼠标。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number', description: '横坐标（逻辑点）' }, y: { type: 'number', description: '纵坐标（逻辑点）' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'right_click',
    description: '在指定逻辑坐标 (x, y) 右键点击。',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number', description: '横坐标（逻辑点）' }, y: { type: 'number', description: '纵坐标（逻辑点）' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'drag',
    description: '从 (from_x, from_y) 按住鼠标拖拽到 (to_x, to_y)。',
    inputSchema: {
      type: 'object',
      properties: {
        from_x: { type: 'number' }, from_y: { type: 'number' },
        to_x: { type: 'number' }, to_y: { type: 'number' },
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
    description: '按下单个特殊按键，可同时按住修饰键。key 支持：return/tab/space/escape/left/right/up/down/delete/home/end/pageup/pagedown/f1-f16/command/shift/option/control 等；modifiers 为修饰键数组，如 ["command"]。功能键 F1-F12 会自动附带 fn 修饰键，以发出真正的 F 键而非媒体键。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '按键名' },
        modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键数组，如 ["command","shift"]' },
      },
      required: ['key'],
    },
  },
  {
    name: 'hotkey',
    description: '触发组合快捷键，例如复制 ["command","c"]、保存 ["command","s"]、切换应用 ["command","tab"]。数组中最后一个元素为主键，前面为修饰键。主键为功能键（f1-f12）时会自动附带 fn，大写字母自动补 shift。',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'array', items: { type: 'string' }, description: '按键序列，如 ["command","c"]' } },
      required: ['keys'],
    },
  },
  {
    name: 'scroll',
    description: '在指定坐标处滚动鼠标滚轮。direction 为 up/down/left/right，amount 为滚动量（1-20）。',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '横坐标（逻辑点）' },
        y: { type: 'number', description: '纵坐标（逻辑点）' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: '滚动量 1-20，默认 3' },
      },
      required: ['x', 'y'],
    },
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

module.exports = { start, SERVER_NAME };

// 直接以 `node computer-use.js` 运行时自启动（Electron 子进程由 main.js 早退分支调用 start()，不会触发此分支）
if (require.main === module) start();
