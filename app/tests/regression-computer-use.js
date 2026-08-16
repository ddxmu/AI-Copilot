#!/usr/bin/env node
'use strict';
// ComputerUse 点击/截图回归检查（聚焦）
// ------------------------------------------------------------
// 运行：node app/tests/regression-computer-use.js
//   可选加 --live 执行「真实 Chrome 登录按钮点击」端到端验证（需要辅助功能权限 + Chrome 在前台）。
//
// 覆盖三项关键不变量：
//   1) 截图归一为 72 DPI，使 Retina 下图像像素与逻辑点严格 1:1；
//   2) 左键 click 走 System Events `click at`，带 5 秒 AppleScript 超时，且抑制返回的 accessibility UI 对象；
//   3) 现有坐标映射（coordScale：图像像素→逻辑点）保持不变。
//
// 仅依赖 Node 内置模块 + macOS 自带 sips/osascript，不引入外部依赖，可纳入构建/CI 检查。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 注意：require 时模块不会 auto-start（start() 仅在 require.main === module 时触发）
const cu = require('../mcp-servers/computer-use.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    failures++;
    console.log('  ✗ ' + msg);
  }
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

/* ---------------- 1) 坐标映射保持不变 ---------------- */
section('坐标映射（coordScale）保持不变');
{
  const s = cu.computeShotSize(1512, 982);
  assert(s.imgW === 1366 && s.imgH === 887, `主屏 1512×982 → 图像尺寸 ${s.imgW}×${s.imgH}（预期 1366×887）`);
  // coordScale 必须等于 width/imgW（x、y 同比例缩放，保证 1:1 线性映射）
  const expectScale = 1512 / 1366;
  assert(Math.abs(s.coordScale - expectScale) < 1e-6, `coordScale=${s.coordScale.toFixed(4)} == ${expectScale.toFixed(4)}`);
  // 任意图像点经 coordScale 还原后仍是同比例逻辑点（映射未改方向/未加偏移）
  const lx = 100 * s.coordScale, ly = 200 * s.coordScale;
  assert(Math.abs(lx / 100 - ly / 200) < 1e-9, `坐标等比还原 (100,200)→(${lx.toFixed(1)},${ly.toFixed(1)}) 比例一致`);
  // 上限尺寸不应被放大超过原屏
  const s2 = cu.computeShotSize(800, 600);
  assert(s2.imgW <= 800 && s2.imgH <= 600, `小屏不会放大：${s2.imgW}×${s2.imgH} <= 800×600`);
}

/* ---------------- 2) 左键 click：System Events + 5s 超时 + 抑制返回 ---------------- */
section('左键 click：System Events / 5s 超时 / 抑制返回对象');
{
  const script = cu.mouseClickAppleScript(100, 200);
  assert(/with timeout of 5 seconds/.test(script), 'AppleScript 含 5 秒超时（with timeout of 5 seconds）');
  assert(/click at \{100, 200\}/.test(script), '使用坐标式 System Events 点击（click at {100, 200}）');
  assert(/set ignoredClick to click at/.test(script), '把 click 返回的 accessibility UI 对象捕获到局部变量（suppress）');
  assert(/return ""/.test(script), '脚本显式 return ""（不向外返回 UI 对象）');
  assert(/tell application "System Events"/.test(script), '点击经由 System Events 应用');
  // 反向：不应出现裸 click 而无超时包裹
  assert(!/click at/.test(script.replace(/with timeout of 5 seconds[\s\S]*?end timeout/, '')), '超时块外不存在裸 click');
  // 坐标取整，避免浮点
  assert(cu.mouseClickAppleScript(10.7, 20.4).includes('click at {11, 20}'), '坐标按 Math.round 取整（10.7,20.4）→ {11, 20}');
}

/* ---------------- 3) 截图 72 DPI 归一 ---------------- */
section('截图 72 DPI 归一');
{
  // 生成一张真实尺寸（64×64）的实心 PNG 作为素材：sips 在极小 PNG 上写临时文件会误报，
  // 真实截图路径用全尺寸 PNG，sips 工作正常；这里用 64×64 模拟真实情况。
  const tmp = path.join(os.tmpdir(), 'ai-copilot-regression-' + Date.now() + '.png');
  let made = false;
  // 依次尝试已知 Python 解释器，找到能 import PIL 的那个来生成测试图
  const pyCandidates = [
    process.env.VENV_PYTHON,
    '/Users/dingjunjie/.workbuddy/binaries/python/envs/default/bin/python3',
    '/Users/dingjunjie/.workbuddy/binaries/python/versions/3.13.12/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const cand of pyCandidates) {
    const py = spawnSync(
      cand,
      ['-c', `from PIL import Image; Image.new('RGB',(64,64),(120,160,200)).save(${JSON.stringify(tmp)},'PNG')`],
      { encoding: 'utf8' }
    );
    if (py.status === 0 && fs.existsSync(tmp)) { made = true; break; }
  }
  if (!made) {
    console.log('  · 跳过：未找到可用 Python/PIL 生成测试图（依赖仅用于本自检素材）');
  } else {
    // 关键命令与截图路径完全一致：sips -s dpiWidth 72 -s dpiHeight 72 <file>
    const r = spawnSync('sips', ['-s', 'dpiWidth', '72', '-s', 'dpiHeight', '72', tmp], { encoding: 'utf8' });
    const g = spawnSync('sips', ['-g', 'dpiWidth', '-g', 'dpiHeight', tmp], { encoding: 'utf8' });
    const out = (g.stdout || '') + (g.stderr || '');
    const mw = out.match(/dpiWidth:\s*([\d.]+)/i);
    const mh = out.match(/dpiHeight:\s*([\d.]+)/i);
    assert(r.status === 0 || (mw && mh), 'sips 应用 72 DPI 命令成功（退出码或回读有效）');
    assert(mw && mh && Math.round(parseFloat(mw[1])) === 72 && Math.round(parseFloat(mh[1])) === 72,
      '归一后 DPI 回读为 72（Retina 144 DPI 已消除）');
  }
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
}

/* ---------------- 4) 输入（type）：⌘V 粘贴修复 + 防假报成功 ---------------- */
section('输入（type）：⌘V 粘贴修复 + 防假报成功');
{
  // ⌘V 组合键必须为主键事件注入「正确的 command 修饰掩码」（真实 CoreGraphics CGEventFlags = 0x100000/1048576）。
  // 误用 0x1000(4096) 等非掩码值会导致 Chrome 读不到 ⌘、只落字母 v——这正是 v0.9.54 复现的 Bug。
  const pasteScript = cu.buildKeyScript(cu.CHAR_KEYCODES['v'], ['command']);
  assert(/CGEventSetFlags/.test(pasteScript), '⌘V 为按键事件注入修饰标志（CGEventSetFlags）');
  assert(/55,true/.test(pasteScript), '⌘V 含 command 修饰键 down（key 55）');
  assert(/9,true/.test(pasteScript), '⌘V 含主键 v（key 9，CHAR_KEYCODES["v"]）');
  // 锁定真实 command 掩码 1048576（0x100000 = kCGEventFlagMaskCommand），杜绝再次误用 0x1000(4096) 这类错误值导致「只落 v」
  assert(/CGEventSetFlags\(md55,1048576\)/.test(pasteScript), 'command 修饰掩码为真实值 1048576（0x100000 = kCGEventFlagMaskCommand，非 0x1000）—— 修复「只落字母 v」');
  assert(/CGEventSetFlags\(kd,1048576\)/.test(pasteScript), '主键 v 事件自身携带 command 掩码 1048576（Chrome 据此识别 ⌘V）');
  // 回退命令（CoreGraphics 被拒时的二次尝试）
  assert(/keystroke "v" using command down/.test(cu.pasteAppleScript()), 'pasteAppleScript 回退为 System Events keystroke "v" using command down');
  // 回读判定纯逻辑（严格、不假报成功）：
  //   含待粘贴文本 → ok；读不到字段 → unknown；能读到但内容不对（含空、只落 v）→ fail
  assert(cu.pasteVerificationResult('https://example.com/', 'https://example.com/') === 'ok', '字段含待粘贴文本 → ok');
  assert(cu.pasteVerificationResult('https://example.com/foo', 'https://example.com/') === 'ok', '字段含待粘贴文本（前缀） → ok');
  assert(cu.pasteVerificationResult('', 'https://example.com/') === 'fail', '字段为空 → fail（失败不假报成功）');
  assert(cu.pasteVerificationResult('v', 'https://example.com/') === 'fail', '字段只落字母 v → fail（正是 v0.9.54 复现 Bug 的判定）');
  assert(cu.pasteVerificationResult('chrome://newtab/', 'https://example.com/') === 'fail', '字段为其它错误内容 → fail');
  assert(cu.pasteVerificationResult('随便什么字', 'https://example.com/') === 'fail', '字段为任意其它内容 → fail');
  assert(cu.pasteVerificationResult(null, 'x') === 'unknown', '确实读不到字段内容 → unknown（保守放行）');
  // typeViaClipboard 已导出，与线上代码路径一致，可被端到端调用
  assert(typeof cu.typeViaClipboard === 'function', 'typeViaClipboard 已导出，可被测试/调用');
}

/* ---------------- 5) 真实 Chrome 验证（端到端，可选） ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function execAppleScript(script) {
  const p = spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10000 });
  if (p.status !== 0) throw new Error((p.stderr || p.stdout || '').trim());
  return (p.stdout || '').trim();
}
function execJxa(script) {
  const p = spawnSync('osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 10000 });
  if (p.status !== 0) throw new Error((p.stderr || p.stdout || '').trim());
  return (p.stdout || '').trim();
}

async function runLive() {
  // 5a) 登录按钮点击
  section('真实 Chrome 登录按钮点击（--live）');
  console.log('  · 打开 Chrome 到 github.com，定位「Sign in」按钮并点击，验证跳转到 /login');
  const applescript = `
    with timeout of 5 seconds
      tell application "Google Chrome"
        activate
        if (count of windows) is 0 then make new window
        set URL of active tab of front window to "https://github.com"
      end tell
      delay 1.5
      tell application "System Events"
        tell process "Google Chrome"
          set loginBtn to (first UI element of front window whose name is "Sign in")
          set p to position of loginBtn
          set sz to size of loginBtn
          click at {(item 1 of p) + (item 1 of sz) / 2, (item 2 of p) + (item 2 of sz) / 2}
        end tell
      end tell
      delay 1.5
      tell application "Google Chrome"
        return URL of active tab of front window
      end tell
    end timeout`;
  const res = spawnSync('osascript', ['-e', applescript], { encoding: 'utf8', timeout: 15000 });
  if (res.status !== 0) {
    failures++;
    console.log('  ✗ Chrome 点击验证失败：' + (res.stderr || res.stdout || '').trim());
    console.log('    （请确认已在「系统设置 › 隐私与安全性 › 辅助功能 / 自动化」允许终端/AI Copilot 控制 Chrome）');
  } else {
    const url = (res.stdout || '').trim();
    assert(/github\.com\/login/.test(url), `点击后跳转至登录页（当前 URL: ${url}）`);
  }

  // 5b) 地址栏输入网址并回车（复现并验收 v0.9.54 的「只落字母 v」Bug 修复）
  section('真实 Chrome 地址栏输入网址并回车（--live）');
  console.log('  · 打开 Chrome 新标签 → 聚焦地址栏(⌘L) → type 输入 https://example.com/ → 回车，验证跳转');
  execAppleScript(`
    tell application "Google Chrome"
      activate
      if (count of windows) is 0 then make new window
      tell front window to make new tab
      set URL of active tab of front window to "chrome://newtab/"
    end tell`);
  await sleep(800);
  execJxa(cu.buildKeyScript(cu.CHAR_KEYCODES['l'], ['command'])); // ⌘L 聚焦地址栏
  await sleep(200);
  await cu.typeViaClipboard('https://example.com/'); // 走线上一致路径：⌘V + 回读验证 + 剪贴板还原
  await sleep(300);
  execJxa(cu.buildKeyScript(cu.KEY_CODES['return'], [])); // 回车
  await sleep(1500);
  const url = execAppleScript('tell application "Google Chrome" to return URL of active tab of front window').trim();
  assert(/example\.com/.test(url), `地址栏输入并回车后跳转到 example.com（当前 URL: ${url}）`);
}

function finish() {
  console.log('\n' + (failures === 0 ? 'ALL PASS ✅' : failures + ' FAILED ❌'));
  process.exit(failures === 0 ? 0 : 1);
}

if (process.argv.includes('--live')) {
  runLive().then(finish).catch((e) => { console.log('  ✗ --live 执行异常：' + e.message); failures++; finish(); });
} else {
  console.log('\n（跳过真实 Chrome 验证；加 --live 执行，需授予辅助功能/自动化权限）');
  finish();
}
