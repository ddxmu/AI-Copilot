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
const SERVER_VERSION = '1.0.0';

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

/* ---------------- 按键映射 ---------------- */

const KEY_CODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  forwarddelete: 117, help: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 113, f14: 115, f15: 118, f16: 121,
  command: 55, cmd: 55, shift: 56, capslock: 57, option: 58, alt: 58, control: 59, ctrl: 59,
};

function toModDown(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'command' || n === 'cmd') return 'command down';
  if (n === 'control' || n === 'ctrl') return 'control down';
  if (n === 'shift') return 'shift down';
  if (n === 'option' || n === 'alt') return 'option down';
  return null;
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
    // 全屏截图（静音、png），输出为设备分辨率
    try {
      await spawnAsync('screencapture', ['-x', '-t', 'png', src]);
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
    const b64 = fileToBase64(finalFile);
    try { fs.unlinkSync(src); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(dst); } catch (e) { /* ignore */ }
    return {
      content: [
        { type: 'text', text: `已截取主屏幕，图像尺寸 ${size.width} × ${size.height}（逻辑点）。请基于该尺寸输出坐标（原点左上角）。` },
        { type: 'image', data: b64, mimeType: 'image/png' },
      ],
    };
  },

  async move(args) {
    const { x, y } = numPair(args, 'x', 'y');
    await runAppleScript(`tell application "System Events" to set position of mouse to {${x}, ${y}}`);
    return okText(`鼠标已移动到 (${x}, ${y})`);
  },

  async click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    const button = String(args.button || 'left').toLowerCase();
    const prefix = button === 'right' ? '(button 2) ' : button === 'middle' ? '(button 3) ' : '';
    await runAppleScript(`tell application "System Events" to click ${prefix}at {${x}, ${y}}`);
    return okText(`已在 (${x}, ${y}) 点击（${button}键）`);
  },

  async double_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    await runAppleScript(
      `tell application "System Events"\n  click at {${x}, ${y}}\n  delay 0.05\n  click at {${x}, ${y}}\nend tell`
    );
    return okText(`已在 (${x}, ${y}) 双击`);
  },

  async right_click(args) {
    const { x, y } = numPair(args, 'x', 'y');
    await runAppleScript(`tell application "System Events" to click (button 2) at {${x}, ${y}}`);
    return okText(`已在 (${x}, ${y}) 右键点击`);
  },

  async drag(args) {
    const fx = Math.round(Number(args.from_x));
    const fy = Math.round(Number(args.from_y));
    const tx = Math.round(Number(args.to_x));
    const ty = Math.round(Number(args.to_y));
    if ([fx, fy, tx, ty].some((v) => !isFinite(v))) throw new Error('拖拽坐标必须是数字');
    await runAppleScript(
      `tell application "System Events"\n  set position of mouse to {${fx}, ${fy}}\n  delay 0.05\n  mouse down\n  set position of mouse to {${tx}, ${ty}}\n  delay 0.05\n  mouse up\nend tell`
    );
    return okText(`已从 (${fx}, ${fy}) 拖拽到 (${tx}, ${ty})`);
  },

  async type(args) {
    const text = String(args.text != null ? args.text : '');
    if (!text) return okText('（未输入任何文字）');
    const lines = text.split('\n');
    const body = lines
      .map((ln) => `  keystroke "${asStrLiteral(ln)}"${ln !== lines[lines.length - 1] ? '\n  keystroke linefeed' : ''}`)
      .join('\n');
    await runAppleScript(`tell application "System Events"\n${body}\nend tell`);
    return okText(`已输入文字：${text.length > 60 ? text.slice(0, 60) + '…' : text}`);
  },

  async key(args) {
    const key = String(args.key || '').toLowerCase();
    const code = KEY_CODES[key];
    if (code == null) throw new Error(`不支持的按键名：${key}（支持 return/tab/space/escape/方向键/command/shift/option/control/f1-f16 等）`);
    const mods = (Array.isArray(args.modifiers) ? args.modifiers : []).map(toModDown).filter(Boolean);
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    await runAppleScript(`tell application "System Events"\n  key code ${code}${using}\nend tell`);
    return okText(`已按下按键 ${key}${mods.length ? '（修饰键：' + mods.join('+') + '）' : ''}`);
  },

  async hotkey(args) {
    const keys = Array.isArray(args.keys) ? args.keys : [];
    if (!keys.length) throw new Error('keys 不能为空，例如 ["command","c"]');
    const main = String(keys[keys.length - 1]);
    const mods = keys.slice(0, -1).map(toModDown).filter(Boolean);
    const using = mods.length ? ` using {${mods.join(', ')}}` : '';
    let script;
    if (main.length === 1 && KEY_CODES[main] == null) {
      // 单个可打印字符（如 c、a），用 keystroke
      script = `tell application "System Events"\n  keystroke "${asStrLiteral(main)}"${using}\nend tell`;
    } else {
      const code = KEY_CODES[main] != null ? KEY_CODES[main] : parseInt(main, 10);
      if (!isFinite(code)) throw new Error(`不支持的按键：${main}`);
      script = `tell application "System Events"\n  key code ${code}${using}\nend tell`;
    }
    await runAppleScript(script);
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
    description: '在指定逻辑坐标 (x, y) 点击鼠标。button 可选 left/right/middle，默认 left。',
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
    description: '按下单个特殊按键，可同时按住修饰键。key 支持：return/tab/space/escape/left/right/up/down/delete/home/end/pageup/pagedown/f1-f16/command/shift/option/control 等；modifiers 为修饰键数组，如 ["command"]。',
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
    description: '触发组合快捷键，例如复制 ["command","c"]、保存 ["command","s"]、切换应用 ["command","tab"]。数组中最后一个元素为主键，前面为修饰键。',
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
