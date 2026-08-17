const { app, BrowserWindow, ipcMain, dialog, shell, Notification, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile } = require('child_process');
const { ALL_EXTS, PLAIN_TEXT_SAFE, ZIP_BASED_OFFICE } = require('./filetypes');
const { processOfficeFile, readZipEntries, LEGACY_OFFICE, replaceInLegacyFile } = require('./office-replace');
const { BUILTIN_SKILLS, RECOMMENDED_SKILLS, parseSkillMd } = require('./agent');
const updater = require('./updater');
const memory = require('./memory');
const https = require('https');
const pdfwm = require('./pdf-watermark');

// 内置 Computer Use MCP 子进程：本进程以 --run-computer-use 启动时，不创建窗口，
// 直接作为 MCP stdio 服务器运行（模拟鼠标/键盘操作电脑）。由 mcp.js 以
// `process.execPath --run-computer-use <脚本>` 拉起，主进程 MCP 连接池复用该子进程。
if (process.argv.includes('--run-computer-use')) {
  try { if (app.dock && app.dock.hide) app.dock.hide(); } catch (e) { /* ignore */ }
  try { require('./mcp-servers/computer-use').start(); } catch (e) {
    process.stderr.write('computer-use start failed: ' + (e && e.stack || e) + '\n');
  }
  return; // 不创建窗口 / 不进入 app.whenReady；stdio 读取维持事件循环
}

let mainWindow = null;
let currentChatId = null; // 当前激活的对话 ID（用于对话级记忆）

/* ---------------- Computer Use 光标遮罩（让用户看得见 AI 鼠标） ---------------- */
let cursorOverlay = null;          // 透明置顶遮罩窗口
let cursorServer = null;           // Unix socket 服务器
let cursorSockPath = '';           // socket 文件路径
let cursorIdleTimer = null;        // 空闲自动隐藏定时器
const CURSOR_IDLE_MS = 10000;      // 无操作 10 秒后隐藏

function getCursorSockPath() {
  return path.join(os.tmpdir(), `ai-copilot-cursor-${process.pid}.sock`);
}

function createCursorOverlay() {
  if (cursorOverlay && !cursorOverlay.isDestroyed()) return cursorOverlay;
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;
  cursorOverlay = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    acceptFirstMouse: false,
    type: 'panel',
    visibleOnAllWorkspaces: true,
    roundedCorners: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try { cursorOverlay.setIgnoreMouseEvents(true); } catch (e) { /* ignore */ }
  cursorOverlay.loadFile(path.join(__dirname, 'renderer', 'cursor-overlay.html'));
  cursorOverlay.on('closed', () => { cursorOverlay = null; });
  return cursorOverlay;
}

function sendCursorToOverlay(channel, data) {
  if (!cursorOverlay || cursorOverlay.isDestroyed()) return;
  try {
    if (cursorOverlay.webContents && !cursorOverlay.webContents.isDestroyed()) {
      cursorOverlay.webContents.send(channel, data);
    }
  } catch (e) { /* ignore */ }
}

function showCursorOverlay() {
  try {
    if (cursorIdleTimer) clearTimeout(cursorIdleTimer);
    const w = createCursorOverlay();
    if (!w.isVisible()) { try { w.showInactive(); } catch (e) {} }
    sendCursorToOverlay('cursor-show');
    cursorIdleTimer = setTimeout(() => {
      sendCursorToOverlay('cursor-hide');
      try { if (cursorOverlay && cursorOverlay.isVisible()) cursorOverlay.hide(); } catch (e) {}
    }, CURSOR_IDLE_MS);
  } catch (e) { /* ignore */ }
}

function handleCursorMessage(msg) {
  if (!msg || !msg.t) return;
  switch (msg.t) {
    case 'move': showCursorOverlay(); sendCursorToOverlay('cursor-move', { x: msg.x, y: msg.y }); break;
    case 'down': showCursorOverlay(); sendCursorToOverlay('cursor-action', { a: 'down', x: msg.x, y: msg.y }); break;
    case 'up': showCursorOverlay(); sendCursorToOverlay('cursor-action', { a: 'up', x: msg.x, y: msg.y }); break;
    case 'click': showCursorOverlay(); sendCursorToOverlay('cursor-action', { a: 'click', x: msg.x, y: msg.y }); break;
    case 'hide': try { if (cursorOverlay && cursorOverlay.isVisible()) cursorOverlay.hide(); } catch (e) {} break;
    case 'show': showCursorOverlay(); break;
  }
}

function startCursorServer() {
  if (cursorServer) return;
  cursorSockPath = getCursorSockPath();
  try { fs.unlinkSync(cursorSockPath); } catch (e) { /* ignore */ }
  cursorServer = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { handleCursorMessage(JSON.parse(line)); } catch (e) { /* ignore */ }
      }
    });
    sock.on('error', () => {});
  });
  cursorServer.listen(cursorSockPath, () => {
    try { fs.chmodSync(cursorSockPath, 0o600); } catch (e) { /* ignore */ }
  });
  cursorServer.on('error', () => {});
  process.env.AI_COPILOT_CURSOR_SOCK = cursorSockPath;
}

function stopCursorServer() {
  try { if (cursorIdleTimer) clearTimeout(cursorIdleTimer); } catch (e) {}
  try { if (cursorOverlay && !cursorOverlay.isDestroyed()) cursorOverlay.close(); } catch (e) {}
  try { if (cursorServer) cursorServer.close(); } catch (e) {}
  try { if (cursorSockPath) fs.unlinkSync(cursorSockPath); } catch (e) {}
  cursorOverlay = null; cursorServer = null; cursorSockPath = '';
}

// 应用改名（AI文件自动替换 → AI Copilot）后，userData 目录随之改变。
// 启动时做一次迁移：新目录无配置而旧目录有，则把旧配置复制过来，避免丢失已保存的模型/Key。
function migrateLegacyUserData() {
  try {
    const newDir = app.getPath('userData'); // ~/Library/Application Support/AI Copilot
    const legacyDir = path.join(app.getPath('appData'), 'AI文件自动替换');
    const newCfg = path.join(newDir, 'ai-config.json');
    const legacyCfg = path.join(legacyDir, 'ai-config.json');
    if (!fs.existsSync(newCfg) && fs.existsSync(legacyCfg)) {
      fs.mkdirSync(newDir, { recursive: true });
      fs.copyFileSync(legacyCfg, newCfg);
    }
  } catch (e) { /* 迁移失败不影响启动 */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    title: 'AI Copilot',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 后台静默检查更新：仅在发现新版本时通知渲染进程，不自动下载。
// 带 60 秒去抖，避免文件选择等高频事件反复查询 GitHub。
let lastBgUpdateCheck = 0;
let lastNotifiedVersion = null; // 同版本系统通知只弹一次

// 闲置后台（app 未聚焦/最小化/隐藏）且发现新版本时，弹 macOS 系统通知提示升级
function notifyUpdateAvailable(res) {
  if (!res || !res.version) return;
  if (res.version === lastNotifiedVersion) return; // 同版本只提示一次
  lastNotifiedVersion = res.version;
  try {
    if (!Notification.isSupported || Notification.isSupported()) {
      const n = new Notification({
        title: `AI Copilot 新版本 v${res.version} 可用`,
        body: '发现新版本，点击查看并升级。',
        silent: false,
      });
      n.on('click', () => {
        if (mainWindow) { try { mainWindow.show(); mainWindow.focus(); } catch (e) {} }
      });
      n.show();
    }
  } catch (e) { /* 通知不可用不影响更新流程 */ }
}

function checkUpdatesInBackground(force = false) {
  const now = Date.now();
  if (!force && now - lastBgUpdateCheck < 60 * 1000) return;
  lastBgUpdateCheck = now;
  updater.checkForUpdates().then((res) => {
    if (res && res.updateAvailable && mainWindow) {
      mainWindow.webContents.send('update-available', res);
      // 程序闲置在后台时，弹系统通知自动提示有升级
      const idle = !mainWindow.isFocused() || mainWindow.isMinimized() || !mainWindow.isVisible();
      if (idle) notifyUpdateAvailable(res);
    }
  }).catch(() => {});
}

app.whenReady().then(() => {
  migrateLegacyUserData();
  detectPdfEngines();
  createWindow();
  // 启动静默检查更新（仅在有新版本时通知渲染进程，不自动下载）
  checkUpdatesInBackground(true);
  // 空闲定时检查更新（每 10 分钟自动查询一次 GitHub）
  setInterval(() => checkUpdatesInBackground(true), 10 * 60 * 1000);
  // 先启 Computer Use 光标 socket（MCP 子进程需要连接它）
  startCursorServer();
  // 按配置连接 MCP 服务器（后台异步）
  initMcpServers();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 显示器参数变化时，重新适配遮罩窗口大小
  try {
    screen.on('display-metrics-changed', () => {
      if (!cursorOverlay || cursorOverlay.isDestroyed()) return;
      try {
        const b = screen.getPrimaryDisplay().bounds;
        cursorOverlay.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- 工具函数 ---------------- */

function getExt(filePath) {
  return path.extname(filePath).replace('.', '').toLowerCase();
}

// 递归扫描文件夹，返回符合扩展名过滤的文件列表
function scanDir(dirPath, allowedExts, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      scanDir(full, allowedExts, results);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const ext = getExt(entry.name);
      if (allowedExts.length === 0 || allowedExts.includes(ext)) {
        results.push(full);
      }
    }
  }
  return results;
}

function replaceInText(content, rules) {
  let count = 0;
  let out = content;
  for (const rule of rules) {
    if (!rule.find) continue;
    const parts = out.split(rule.find);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(rule.replace ?? '');
    }
  }
  return { content: out, count };
}

// 对单个文件执行替换。saveMode: 'overwrite'|'backup'|'output'，opts: { outputDir, baseDir }
// 返回 { status, replacements, message, outputPath }
function processFile(filePath, rules, saveMode = 'overwrite', opts = {}) {
  const ext = getExt(filePath);
  const isOffice = ZIP_BASED_OFFICE.has(ext);
  const isLegacy = LEGACY_OFFICE.has(ext);

  let newContent, count;
  if (isOffice) {
    // docx/pptx/xlsx 等：解包 zip，对内部 XML 做替换后重新打包
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { return { status: 'error', replacements: 0, message: '读取失败' }; }
    let r;
    try { r = processOfficeFile(buf, rules); }
    catch (e) { return { status: 'error', replacements: 0, message: 'Office 解析失败：' + e.message }; }
    if (r.count === 0) return { status: 'nochange', replacements: 0, message: '无匹配内容' };
    newContent = r.content;
    count = r.count;
  } else if (isLegacy) {
    // .doc/.xls 老格式：LibreOffice 转 OOXML → 内部替换 → 转回原格式
    let buf;
    try { buf = fs.readFileSync(filePath); }
    catch (e) { return { status: 'error', replacements: 0, message: '读取失败' }; }
    let r;
    try { r = replaceInLegacyFile(filePath, rules); }
    catch (e) { return { status: 'error', replacements: 0, message: '老格式处理失败：' + e.message }; }
    if (r.count === 0) return { status: 'nochange', replacements: 0, message: '无匹配内容' };
    newContent = r.content;
    count = r.count;
  } else {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      return { status: 'error', replacements: 0, message: '读取失败（可能是二进制或编码问题）' };
    }
    const out = replaceInText(content, rules);
    if (out.count === 0) {
      return { status: 'nochange', replacements: 0, message: '无匹配内容' };
    }
    newContent = Buffer.from(out.content, 'utf8');
    count = out.count;
  }

  let target = filePath;
  if (saveMode === 'backup') {
    // 替换前把原文件备份到同目录 .backup/ 下
    try {
      const backupDir = path.join(path.dirname(filePath), '.backup');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, path.basename(filePath));
      fs.copyFileSync(filePath, backupPath);
    } catch (e) {
      return { status: 'error', replacements: 0, message: '备份失败：' + e.message };
    }
  } else if (saveMode === 'output') {
    // 输出到新目录
    const outDir = opts.outputDir;
    if (!outDir) return { status: 'error', replacements: 0, message: '未指定输出目录' };
    if (opts.keepStructure === false) {
      // 不保持目录结构：全部平铺到输出目录
      target = path.join(outDir, path.basename(filePath));
    } else {
      // 保持目录结构：按相对路径重建
      const base = opts.baseDir && filePath.startsWith(opts.baseDir)
        ? opts.baseDir
        : path.dirname(filePath);
      const rel = path.relative(base, filePath);
      target = path.join(outDir, rel);
    }
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, newContent); // Buffer 写入，兼容文本与 Office 二进制
    const where = saveMode === 'output' ? ` → ${target}` : saveMode === 'backup' ? '（已备份原文件）' : '';
    return { status: 'done', replacements: count, message: `替换 ${count} 处${where}`, outputPath: target };
  } catch (e) {
    return { status: 'error', replacements: 0, message: '写入失败：' + e.message };
  }
}

/* ---------------- IPC ---------------- */

// 获取支持的扩展名列表（供渲染进程渲染类型筛选）
ipcMain.handle('get-supported-exts', () => ALL_EXTS);

// 获取应用版本号（动态读取 package.json，供左下角显示）
ipcMain.handle('get-app-version', () => {
  try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
});

// 读取更新日志（CHANGELOG.md 原文，供 AI 设置「更新日志」卡片渲染）
ipcMain.handle('get-changelog', () => {
  try { return require('fs').readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8'); }
  catch (e) { return ''; }
});

// ===== 升级成功提示 =====
// 记录上次运行的版本号，本次启动若版本变高，说明升级真正生效，通知界面显示提示条。
const lastRunVersionPath = () => path.join(app.getPath('userData'), 'last-run-version.json');
function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
// 判断是否为「老用户」（userData 里已有历史配置），用于首次引入本功能时的兜底提示
function hasExistingUserData() {
  const ud = app.getPath('userData');
  for (const f of ['ai-config.json', 'chat-history.json', 'automation-presets.json', 'skills']) {
    try { if (fs.existsSync(path.join(ud, f))) return true; } catch (e) { /* ignore */ }
  }
  return false;
}
let _upgradeFlag = null;
function computeUpgradeFlag() {
  if (_upgradeFlag) return _upgradeFlag;
  let cur = '0.0.0';
  try { cur = require('./package.json').version; } catch (e) { /* ignore */ }
  let prev = null;
  try { prev = (JSON.parse(fs.readFileSync(lastRunVersionPath(), 'utf8')) || {}).version || null; } catch (e) { /* 首次运行 */ }
  if (prev && cmpSemver(cur, prev) > 0) {
    _upgradeFlag = { upgraded: true, from: prev, to: cur };
  } else if (!prev && hasExistingUserData()) {
    // 老用户首次运行带此功能的版本（如 0.8.16 → 0.8.17）：无历史记录，但确实是升级上来的
    _upgradeFlag = { upgraded: true, from: null, to: cur };
  } else {
    _upgradeFlag = { upgraded: false, from: prev, to: cur };
  }
  try {
    fs.writeFileSync(lastRunVersionPath(), JSON.stringify({ version: cur, at: new Date().toISOString() }, null, 2));
  } catch (e) { /* ignore */ }
  return _upgradeFlag;
}
ipcMain.handle('get-upgrade-flag', () => computeUpgradeFlag());

// ===== 自动更新 =====
ipcMain.handle('check-update', async () => updater.checkForUpdates());

ipcMain.handle('download-update', async (_e, manifest) => {
  const wc = mainWindow && mainWindow.webContents;
  try {
    await updater.downloadAndInstall(manifest, {
      onProgress: (info) => wc && wc.send('update-progress', info),
      onStage: (s) => wc && wc.send('update-stage', s),
    });
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    wc && wc.send('update-error', msg);
    return { ok: false, error: msg };
  }
});

// 一键清理更新缓存（坏掉的半截下载文件），供更新失败 UI 的「清理并重试」按钮调用
ipcMain.handle('clear-update-cache', async () => updater.clearUpdateCache());

// 选择文件（可多选）。可选传入扩展名数组限定可选类型，默认用全部支持类型
ipcMain.handle('select-files', async (_e, exts) => {
  const list = (Array.isArray(exts) && exts.length) ? exts : ALL_EXTS;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的文件', extensions: list },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  const paths = result.canceled ? [] : result.filePaths;
  // 文件被选中后，后台静默同步一次更新情况（有更新才提示，不打扰）
  if (paths.length) checkUpdatesInBackground();
  return paths;
});

// 选择文件夹
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  // 文件夹被选中后，后台静默同步一次更新情况
  checkUpdatesInBackground();
  return result.filePaths[0];
});

// 扫描文件夹（按扩展名过滤），返回文件清单
ipcMain.handle('scan-folder', (_e, { folderPath, exts }) => {
  const allowed = Array.isArray(exts) ? exts : [];
  return scanDir(folderPath, allowed);
});

// ============ 聊天框「＋」选文件发给 AI（任意文件 / 文件夹）============
// 复用附件读取的 IMAGE_EXTS / fileExtOf / mimeFor（见下方 readAttachmentForAi 段）
// 选中后返回附件清单（图片带 dataUrl 缩略图），渲染端直接加入待发送列表
ipcMain.handle('pick-attachments', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要发给 AI 的文件（可多选 / 选文件夹）',
    properties: ['openFile', 'multiSelections', 'openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return [];
  const MAX_FILES = 200;
  const out = [];
  const pushFile = (fp) => {
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) return;
      const name = path.basename(fp);
      const ext = fileExtOf(fp);
      let dataUrl = null;
      if (IMAGE_EXTS.has(ext)) {
        try { dataUrl = 'data:' + mimeForExt(ext) + ';base64,' + fs.readFileSync(fp).toString('base64'); } catch {}
      }
      out.push({ path: fp, name, size: st.size, dataUrl, mime: mimeForExt(ext) });
    } catch {}
  };
  for (const p of result.filePaths) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      // 递归收集文件夹内文件（限数量，避免一次塞太多）
      const queue = [p];
      while (queue.length && out.length < MAX_FILES) {
        const dir = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const en of entries) {
          const fp = path.join(dir, en.name);
          if (en.isDirectory()) queue.push(fp);
          else if (en.isFile() && out.length < MAX_FILES) pushFile(fp);
        }
      }
    } else if (st.isFile()) {
      pushFile(p);
    }
  }
  return out;
});

// 把剪贴板粘贴的图片保存到临时目录，返回可读取的路径（供主进程 readAttachmentForAi 读）
ipcMain.handle('save-temp-file', async (_e, { base64, ext }) => {
  try {
    const dir = path.join(app.getPath('userData'), 'clipboard-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const name = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || 'png'}`;
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, Buffer.from(String(base64 || ''), 'base64'));
    return fp;
  } catch (e) { return null; }
});

// 过滤已有文件列表（手动选文件后按类型勾选过滤）
ipcMain.handle('filter-files', (_e, { files, exts }) => {
  if (!Array.isArray(exts) || exts.length === 0) return files;
  return files.filter((f) => exts.includes(getExt(f)));
});

// 执行批量替换：files + rules + saveMode（overwrite/output）+ keepStructure
ipcMain.handle('run-replace', (_e, { files, rules, saveMode, outputDir, baseDir, keepStructure }) => {
  const results = [];
  let totalReplaced = 0;
  let doneCount = 0;
  for (const file of files) {
    const r = processFile(file, rules, saveMode || 'overwrite', { outputDir, baseDir, keepStructure });
    if (r.status === 'done') { doneCount++; totalReplaced += r.replacements; }
    results.push({ file, ...r });
  }
  return { results, summary: { total: files.length, done: doneCount, replaced: totalReplaced } };
});

// 选择输出目录（保存方式 = 输出到新目录时用）
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择输出文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ===== 替换规则的导出 / 导入（.xlsx / .csv）=====
ipcMain.handle('rules-export', async (_e, { rules, format, label }) => {
  try {
    const kind = label || '替换规则';
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    const stamp = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `导出${kind}`,
      defaultPath: path.join(app.getPath('downloads'), `${kind}-${stamp}.${ext}`),
      filters: ext === 'csv'
        ? [{ name: 'CSV 文件', extensions: ['csv'] }]
        : [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    let target = result.filePath;
    if (!path.extname(target)) target += '.' + ext;

    const { exportRules } = require('./rules-io');
    const r = exportRules(rules || [], target);
    return { ok: true, count: r.count, filePath: target };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('rules-import', async (_e, { label }) => {
  try {
    const kind = label || '替换规则';
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `导入${kind}`,
      properties: ['openFile'],
      filters: [
        { name: '规则表格 (Excel / CSV)', extensions: ['xlsx', 'xlsm', 'csv'] },
        { name: 'Excel 工作簿', extensions: ['xlsx', 'xlsm'] },
        { name: 'CSV 文件', extensions: ['csv'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

    const { importRules } = require('./rules-io');
    const r = importRules(result.filePaths[0]);
    return { ok: true, rules: r.rules, skipped: r.skipped, filePath: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// 在访达中显示某个文件
ipcMain.handle('reveal-in-folder', (_e, filePath) => {
  try { shell.showItemInFolder(filePath); return true; } catch (_) { return false; }
});

// 批量重命名：对文件名（含扩展名）按规则做字符串替换。saveMode: 'inplace'(原地改名) | 'copy'(复制到 outputDir)
ipcMain.handle('rename-files', (_e, { files, rules, saveMode, outputDir }) => {
  const results = [];
  let done = 0;
  for (const f of files) {
    try {
      const dir = path.dirname(f);
      const origName = path.basename(f);
      let newName = origName;
      for (const rule of rules) {
        if (!rule.find) continue;
        newName = newName.split(rule.find).join(rule.replace ?? '');
      }
      newName = newName.replace(/[/:]/g, '_').trim(); // 去掉路径非法字符
      if (!newName || newName === origName) {
        results.push({ file: f, status: 'nochange', message: '文件名无变化' });
        continue;
      }
      if (saveMode === 'copy') {
        if (!outputDir) { results.push({ file: f, status: 'error', message: '未指定输出目录' }); continue; }
        const target = path.join(outputDir, newName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f, target);
        done++;
        results.push({ file: f, status: 'done', message: '→ ' + newName, outputPath: target });
      } else {
        const target = path.join(dir, newName);
        if (fs.existsSync(target)) { results.push({ file: f, status: 'error', message: '目标已存在：' + newName }); continue; }
        fs.renameSync(f, target);
        done++;
        results.push({ file: f, status: 'done', message: '→ ' + newName, outputPath: target });
      }
    } catch (e) {
      results.push({ file: f, status: 'error', message: e.message });
    }
  }
  return { results, summary: { total: files.length, done } };
});

/* ---------------- 文件自动化：本地归类转换（不改动文件内容） ---------------- */
// 把模版文件夹的目录结构（含空目录）复刻到输出目录，并返回 ext→相对子目录映射
function replicateTemplateDirs(templateFolder, outputDir) {
  const extMap = new Map(); // ext -> 相对子目录（'' 表示根目录）
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const rel = path.relative(templateFolder, full);
        try { fs.mkdirSync(path.join(outputDir, rel), { recursive: true }); } catch (e) {}
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        const ext = getExt(entry.name);
        const relDir = path.dirname(path.relative(templateFolder, full));
        const sub = relDir === '.' ? '' : relDir;
        if (ext && !extMap.has(ext)) extMap.set(ext, sub);
      }
    }
  }
  walk(templateFolder);
  return extMap;
}

// 目标已存在时自动追加 (1) (2)…
function uniqueTarget(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 1; i < 1000; i++) {
    const t = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(t)) return t;
  }
  return target;
}

// 递归收集模版文件夹的全部文件（相对路径 → 绝对路径）
function collectTemplateFiles(templateFolder) {
  const list = []; // { rel, abs }
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        list.push({ rel: path.relative(templateFolder, full), abs: full });
      }
    }
  }
  walk(templateFolder);
  return list;
}

// 从文件名（不含扩展名）提取关键字：去常见后缀/前缀，按非字母数字汉字拆分，保留长度≥2 的片段
function extractKeywords(name) {
  const cleaned = name
    .replace(/(v\d+|ver\d+|版本?\d*|最终|final|copy|副本|修改|新建|新|备份|backup)/gi, '')
    .replace(/\d{4}[-/年]\d{1,2}[-/月]/g, '') // 去日期
    .trim();
  return cleaned
    .split(/[\s\-_.,()（）【】\[\]·\-—/\\]+/)
    .filter(s => s.length >= 2)
    .map(s => s.toLowerCase());
}

// 关键字模糊匹配：给每个模版文件找最匹配的需编写文件
// 匹配优先级：精确文件名 > 包含关系 > 关键词重叠率≥50%
function matchInputToTemplate(templateFiles, inputFiles) {
  const matches = []; // { tf, input | null, source: 'input'|'template', score }
  const usedInputs = new Set();

  for (const tf of templateFiles) {
    const tfBase = path.basename(tf.rel, path.extname(tf.rel)).toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    // Pass 1: 精确文件名匹配
    for (const f of inputFiles) {
      if (usedInputs.has(f)) continue;
      const fBase = path.basename(f, path.extname(f)).toLowerCase();
      if (fBase === tfBase) { bestMatch = f; bestScore = 1; break; }
    }

    // Pass 2: 包含关系（一个文件名包含另一个）
    if (!bestMatch) {
      for (const f of inputFiles) {
        if (usedInputs.has(f)) continue;
        const fBase = path.basename(f, path.extname(f)).toLowerCase();
        if (fBase.length >= 2 && (fBase.includes(tfBase) || tfBase.includes(fBase))) {
          const score = Math.min(fBase.length, tfBase.length) / Math.max(fBase.length, tfBase.length);
          if (score > bestScore) { bestScore = score; bestMatch = f; }
        }
      }
    }

    // Pass 3: 关键词重叠率
    if (!bestMatch) {
      const tfKw = extractKeywords(tfBase);
      if (tfKw.length > 0) {
        for (const f of inputFiles) {
          if (usedInputs.has(f)) continue;
          const fBase = path.basename(f, path.extname(f)).toLowerCase();
          const fKw = extractKeywords(fBase);
          if (fKw.length === 0) continue;
          const overlap = tfKw.filter(k => fKw.includes(k));
          const score = overlap.length / Math.max(tfKw.length, fKw.length);
          if (score >= 0.5 && score > bestScore) { bestScore = score; bestMatch = f; }
        }
      }
    }

    if (bestMatch) {
      usedInputs.add(bestMatch);
      matches.push({ tf, input: bestMatch, source: 'input', score: bestScore });
    } else {
      matches.push({ tf, input: null, source: 'template', score: 0 });
    }
  }

  const skipped = inputFiles.filter(f => !usedInputs.has(f));
  return { matches, skipped };
}

// 本地归类转换：
// 按关键字把【需编写文件】匹配到模版对应位置 → 复制到输出目录
// 模版文件本身不复制；需编写文件中模版没有对应位置的 → 跳过
// 输出目录 = 只含需编写文件，按模版目录结构摆放
ipcMain.handle('automation-convert', (_e, { templateKind, templateFolder, files, outputDir, layout }) => {
  const results = [];
  if (!outputDir) {
    for (const f of files) results.push({ file: f, status: 'error', message: '未选择输出目录' });
    return { results, summary: { total: files.length, done: 0, matched: 0, skipped: 0 } };
  }
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {}

  const useTemplate = layout === 'template' && templateKind === 'folder' && templateFolder;
  let templateFiles = [];
  let extMap = new Map();

  if (useTemplate) {
    try { extMap = replicateTemplateDirs(templateFolder, outputDir); } catch (e) {}
    try { templateFiles = collectTemplateFiles(templateFolder); } catch (e) {}
  }

  let matched = 0, skipped = 0;

  if (useTemplate) {
    // 按关键字匹配：需编写文件 → 模版位置
    const { matches, skipped: skippedFiles } = matchInputToTemplate(templateFiles, files);
    skipped = skippedFiles.length;

    for (const m of matches) {
      if (m.source === 'input') {
        // 匹配到 → 复制需编写文件到模版对应位置
        try {
          const target = path.join(outputDir, m.tf.rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.cpSync(m.input, target, { preserveTimestamps: true });
          matched++;
          results.push({
            file: m.input, status: 'done',
            message: `→ ${m.tf.rel}（关键字匹配）`,
            outputPath: target, matchType: 'matched', templateRel: m.tf.rel,
          });
        } catch (e) {
          results.push({ file: m.input, status: 'error', message: e.message });
        }
      }
      // 模版有但需编写文件没有的 → 跳过，不复制模版文件
    }

    // 需编写文件中模版没有对应位置的 → 跳过
    for (const f of skippedFiles) {
      results.push({ file: f, status: 'skip', message: '模版无对应位置，不同步' });
    }
  } else {
    // 非模版结构：平铺 / 按类型
    for (const f of files) {
      try {
        let sub = '';
        if (layout === 'bytype') sub = getExt(f) || '其他';
        const targetDir = sub ? path.join(outputDir, sub) : outputDir;
        fs.mkdirSync(targetDir, { recursive: true });
        const target = uniqueTarget(path.join(targetDir, path.basename(f)));
        fs.cpSync(f, target, { preserveTimestamps: true });
        matched++;
        results.push({ file: f, status: 'done', message: '→ ' + path.relative(outputDir, target), outputPath: target });
      } catch (e) {
        results.push({ file: f, status: 'error', message: e.message });
      }
    }
  }

  return {
    results,
    summary: { total: files.length, done: matched, matched, skipped },
  };
});

// 供 AI 核对完整性：列出某目录下全部文件（相对路径）
function listFilesRecursive(root) {
  const list = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        list.push(path.relative(root, full));
      }
    }
  }
  walk(root);
  return list.sort();
}

// AI 协助转换：返回 模版文件清单 与 输出目录文件清单 的对照（不改动任何文件）
ipcMain.handle('automation-check', (_e, { templateFolder, outputDir }) => {
  const templateFiles = templateFolder ? collectTemplateFiles(templateFolder).map((t) => t.rel) : [];
  const outputFiles = outputDir ? listFilesRecursive(outputDir) : [];
  const tSet = new Set(templateFiles.map((r) => r.toLowerCase()));
  const oSet = new Set(outputFiles.map((r) => r.toLowerCase()));
  const missing = templateFiles.filter((r) => !oSet.has(r.toLowerCase())); // 模版有、输出没有
  const extra = outputFiles.filter((r) => !tSet.has(r.toLowerCase()));     // 输出有、模版没有
  return { templateFiles, outputFiles, missing, extra };
});

/* ---------------- PPT 写手：手动保存（字节级复制，不改动内容） ---------------- */
// saveMode: 'output'(输出到 outputDir) | 'overwrite'(覆盖原文件，先备份到同目录 .backup)
ipcMain.handle('ppt-save', (_e, { files, saveMode, outputDir }) => {
  const results = [];
  let done = 0;
  if (saveMode === 'output' && !outputDir) {
    for (const f of files) results.push({ file: f, status: 'error', message: '未选择输出目录' });
    return { results, summary: { total: files.length, done: 0 } };
  }
  if (saveMode === 'output') { try { fs.mkdirSync(outputDir, { recursive: true }); } catch (e) {} }
  for (const f of files) {
    try {
      if (saveMode === 'overwrite') {
        // 覆盖原文件：先备份到同目录 .backup（若尚无备份）
        const backupDir = path.join(path.dirname(f), '.backup');
        fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, path.basename(f));
        if (!fs.existsSync(backupPath)) fs.copyFileSync(f, backupPath);
        results.push({ file: f, status: 'done', message: '原文件已就绪（备份于 .backup）', outputPath: f });
        done++;
      } else {
        const target = uniqueTarget(path.join(outputDir, path.basename(f)));
        fs.cpSync(f, target, { preserveTimestamps: true }); // 字节级原样复制
        results.push({ file: f, status: 'done', message: '→ ' + path.basename(target), outputPath: target });
        done++;
      }
    } catch (e) {
      results.push({ file: f, status: 'error', message: e.message });
    }
  }
  return { results, summary: { total: files.length, done } };
});

/* ---------------- 智能体技能管理 ---------------- */
const SKILLS_DIR = path.join(app.getPath('userData'), 'skills');
function ensureSkillsDir() { try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); } catch (e) {} }

// 读取已安装的外部技能
function listInstalledSkills() {
  ensureSkillsDir();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const f = path.join(SKILLS_DIR, d.name, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    try {
      const p = parseSkillMd(fs.readFileSync(f, 'utf8'), d.name);
      out.push({ name: p.name, description: p.description, dir: d.name, source: 'installed' });
    } catch (e) {}
  }
  return out;
}

ipcMain.handle('skills-list', () => {
  const builtin = Object.entries(BUILTIN_SKILLS).map(([name, v]) => ({
    name, description: v.description, source: v.external ? 'preset' : 'builtin',
  }));
  return { builtin, installed: listInstalledSkills() };
});

ipcMain.handle('skills-delete', (_e, name) => {
  const dir = path.join(SKILLS_DIR, path.basename(String(name || '')));
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, installed: listInstalledSkills() };
});

// 手动安装一个 SKILL.md（内容由渲染层或本地移植提供）
ipcMain.handle('skills-install-md', (_e, { name, content }) => {
  const safe = path.basename(String(name || 'skill')).replace(/[^\w一-龥-]/g, '-');
  ensureSkillsDir();
  const dir = path.join(SKILLS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
  return { ok: true, installed: listInstalledSkills() };
});

// 扫描本地 Claude Code 源码包里的技能（bundled/*.ts），提取名称与描述
ipcMain.handle('skills-scan-local', (_e, srcDir) => {
  const results = [];
  const roots = [];
  try {
    if (srcDir && fs.existsSync(srcDir)) {
      // 支持直接传 bundled 目录或包根目录（自动找 src/skills/bundled）
      if (fs.existsSync(path.join(srcDir, 'src', 'skills', 'bundled'))) roots.push(path.join(srcDir, 'src', 'skills', 'bundled'));
      else if (fs.existsSync(path.join(srcDir, 'bundled'))) roots.push(path.join(srcDir, 'bundled'));
      else roots.push(srcDir);
    }
  } catch (e) {}
  for (const root of roots) {
    let files = [];
    try { files = fs.readdirSync(root).filter((f) => f.endsWith('.ts')); } catch (e) { continue; }
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(root, f), 'utf8');
        const name = (content.match(/name:\s*['"`]([^'"`]+)['"`]/) || [])[1] || f.replace(/\.ts$/, '');
        let description = (content.match(/description:\s*(?:process[^\n]*?\?\s*['"`]([^'"`]+)['"`]\s*:\s*)?['"`]([^'"`]+)['"`]/s) || [])[2]
          || (content.match(/description:\s*['"`]([^'"`]+)['"`]/) || [])[1] || '';
        // 提取一段正文摘要（第一个模板字符串）
        const bodyMatch = content.match(/(?:WORKER_INSTRUCTIONS|INSTRUCTIONS|PROMPT|buildPrompt[\s\S]{0,80}?=`)\s*=\s*`([\s\S]{0,1500}?)`/) || content.match(/`([\s\S]{200,1500}?)`/);
        results.push({
          name, file: f,
          description: description || `Claude Code 内置技能（${f}）`,
          excerpt: (bodyMatch ? bodyMatch[1] : '').replace(/\$\{[^}]*\}/g, '').slice(0, 600),
          installed: listInstalledSkills().some((s) => s.name === name),
        });
      } catch (e) {}
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
});

// GitHub 搜索技能仓库（公开 API，无需 token，限流 10 次/分钟）
function httpsGetJson(urlStr, redirects = 3) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      method: 'GET', hostname: url.hostname, path: url.pathname + url.search,
      headers: { 'User-Agent': 'AI-Copilot-Skill-Installer', 'Accept': 'application/vnd.github+json' },
      timeout: 30000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirects > 0 && res.headers.location) {
        res.resume();
        return resolve(httpsGetJson(res.headers.location, redirects - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败')); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.end();
  });
}

ipcMain.handle('skills-search-github', async (_e, keyword) => {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, error: '请输入技能类别关键词', items: [] };
  const q = encodeURIComponent(`${kw} skill in:name,description`);
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`;
  try {
    const resp = await httpsGetJson(url);
    const items = (resp.items || []).map((it) => ({
      fullName: it.full_name, description: it.description || '', stars: it.stargazers_count,
      url: it.html_url, defaultBranch: it.default_branch || 'main',
    }));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: e.message, items: [] };
  }
});

// 下载 zipball（跟随重定向，返回 Buffer）。onProgress 接收已下载字节数。
function httpsDownload(urlStr, redirects = 5, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request({
      method: 'GET', hostname: url.hostname, path: url.pathname + url.search,
      headers: { 'User-Agent': 'AI-Copilot-Skill-Installer' }, timeout: 300000,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && redirects > 0 && res.headers.location) {
        res.resume();
        return resolve(httpsDownload(res.headers.location, redirects - 1, onProgress));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (onProgress) onProgress(Buffer.concat(chunks).length);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('下载超时（300s）')); });
    req.end();
  });
}

// 从 GitHub 仓库下载并安装技能：找仓库内的 SKILL.md
async function installSkillFromGithub(fullName, defaultBranch, progressName) {
  const zipUrl = `https://codeload.github.com/${fullName}/zip/refs/heads/${defaultBranch || 'main'}`;
  let buf;
  const sendProgress = (bytes) => {
    if (!progressName || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('skill-install-progress', { name: progressName, bytes });
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('skill-install-progress', { name: progressName, bytes: 0 });
    buf = await httpsDownload(zipUrl, 5, sendProgress);
  }
  catch (e) { // 有些仓库默认分支是 master
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('skill-install-progress', { name: progressName, bytes: 0, retry: true });
    buf = await httpsDownload(`https://codeload.github.com/${fullName}/zip/refs/heads/master`, 5, sendProgress);
  }
  const entries = readZipEntries(buf);
  // 找 SKILL.md（优先根目录 / skills 目录下）
  const skillFiles = entries.filter((en) => /(^|\/)SKILL\.md$/i.test(en.name));
  if (!skillFiles.length) return { ok: false, error: '该仓库中没有找到 SKILL.md' };
  // 可能多个技能目录，全部安装
  const installed = [];
  for (const sf of skillFiles) {
    const content = sf.data.toString('utf8');
    const parsed = parseSkillMd(content, path.basename(path.dirname(sf.name)));
    const safe = path.basename(parsed.name).replace(/[^\w一-龥-]/g, '-');
    ensureSkillsDir();
    const dir = path.join(SKILLS_DIR, safe);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    // 同目录下的引用文件（references/ scripts/ 等）一并解压
    const prefix = sf.name.replace(/SKILL\.md$/i, '');
    for (const en of entries) {
      if (en.name.startsWith(prefix) && en.name !== sf.name && !en.name.endsWith('/')) {
        const rel = en.name.slice(prefix.length);
        if (rel.includes('..')) continue;
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, en.data);
      }
    }
    installed.push(parsed.name);
  }
  return { ok: true, installed, all: listInstalledSkills() };
}

ipcMain.handle('skills-install-github', async (_e, { fullName, defaultBranch }) => {
  try {
    return await installSkillFromGithub(fullName, defaultBranch, fullName);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 推荐技能（可一键安装的预设技能目录） ---------------- */
ipcMain.handle('skills-list-recommended', () => {
  const installed = listInstalledSkills();
  const installedNames = new Set(installed.map((s) => s.name));
  return Object.entries(RECOMMENDED_SKILLS).map(([name, v]) => ({
    name,
    description: v.description,
    category: v.category || '通用',
    repo: v.repo || null,
    installed: installedNames.has(name),
  }));
});

ipcMain.handle('skills-install-recommended', async (_e, name) => {
  const def = RECOMMENDED_SKILLS[name];
  if (!def) return { ok: false, error: '未知推荐技能' };
  // 仓库型技能：从 GitHub 下载安装
  if (def.repo) {
    try {
      return await installSkillFromGithub(def.repo, def.branch || 'main', name);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // 内联型技能：直接写 SKILL.md
  ensureSkillsDir();
  const dir = path.join(SKILLS_DIR, path.basename(String(name)));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const md = `---\nname: ${name}\ndescription: ${def.description}\n---\n\n${def.body}`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
    return { ok: true, installed: listInstalledSkills() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ---------------- 文件格式转换 ---------------- */
// textutil 可识别的格式（macOS 自带，离线）
const TEXTUTIL_FORMATS = {
  txt: 'txt', html: 'html', rtf: 'rtf', rtfd: 'rtfd',
  doc: 'doc', docx: 'docx', wordml: 'wordml', odt: 'odt', webarchive: 'webarchive',
};

function textutilConvert(srcPath, dstPath, dstExt) {
  return new Promise((resolve, reject) => {
    execFile('textutil', ['-convert', TEXTUTIL_FORMATS[dstExt], '-output', dstPath, srcPath],
      { timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().slice(0, 200) || 'textutil 转换失败'));
        else resolve();
      });
  });
}

// 用 macOS 自带 cupsfilter 把纯文本转成 PDF（自动嵌入中文字体，中文不乱码；纯文本排版）
function cupsToPdf(txtPath, pdfPath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/cupsfilter', ['-m', 'application/pdf', txtPath],
      { encoding: 'buffer', timeout: 120000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(((stderr && stderr.toString()) || err.message).slice(0, 200) || 'cupsfilter 转换失败'));
        try { fs.writeFileSync(pdfPath, stdout); resolve(); }
        catch (e) { reject(new Error('写入 PDF 失败：' + e.message)); }
      });
  });
}

/* ---------------- 智能 PDF 引擎 ---------------- */
// 启动时检测一次，结果缓存到 pdfEngines
const pdfEngines = { libreoffice: false, pages: false, numbers: false, sofficePath: null };
function detectPdfEngines() {
  // LibreOffice 常见路径
  const lo = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
  ];
  for (const p of lo) { if (fs.existsSync(p)) { pdfEngines.libreoffice = true; pdfEngines.sofficePath = p; break; } }
  pdfEngines.pages = fs.existsSync('/Applications/Pages.app');
  pdfEngines.numbers = fs.existsSync('/Applications/Numbers.app');
  console.log('[PDF引擎] 检测结果:', JSON.stringify(pdfEngines));
}

// execFile Promise 化
function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 64 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) reject(new Error(((stderr && stderr.toString()) || err.message || '').toString().slice(0, 400) || '执行失败'));
        else resolve({ stdout: stdout?.toString?.() || '', stderr: stderr?.toString?.() || '' });
      });
  });
}

// 选最佳引擎（按 srcExt）：LibreOffice > macOS Pages/Numbers > textutil-html 兜底
function pickPdfEngine(srcExt) {
  const wordExts = ['doc', 'docx', 'rtf', 'odt', 'rtfd', 'wordml', 'webarchive'];
  const excelExts = ['xls', 'xlsx', 'numbers'];
  const pptExts = ['ppt', 'pptx', 'key'];
  if (wordExts.includes(srcExt)) {
    if (pdfEngines.libreoffice) return { engine: 'libreoffice', label: 'LibreOffice' };
    if (pdfEngines.pages) return { engine: 'pages', label: 'Pages' };
    return { engine: 'textutil-html', label: 'textutil+HTML' };
  }
  if (excelExts.includes(srcExt)) {
    if (pdfEngines.libreoffice) return { engine: 'libreoffice', label: 'LibreOffice' };
    if (pdfEngines.numbers) return { engine: 'numbers', label: 'Numbers' };
    return { engine: 'textutil-html', label: 'textutil+HTML' };
  }
  if (pptExts.includes(srcExt)) {
    if (pdfEngines.libreoffice) return { engine: 'libreoffice', label: 'LibreOffice' };
    return { engine: 'textutil-html', label: 'textutil+HTML' };
  }
  if (['html', 'htm'].includes(srcExt)) return { engine: 'electron', label: 'Electron' };
  if (['txt', 'md', 'csv', 'json', 'log', 'xml', 'yaml', 'yml', 'tsv'].includes(srcExt)) {
    return { engine: 'cupsfilter', label: 'cupsfilter' };
  }
  return { engine: 'textutil-html', label: 'textutil+HTML' };
}

// LibreOffice 转 PDF（最高保真：字体/字号/表格/列宽都按原文件渲染）
async function libreofficeToPdf(srcPath, dstPath) {
  if (!pdfEngines.libreoffice) throw new Error('LibreOffice 未安装');
  const outDir = path.dirname(dstPath);
  fs.mkdirSync(outDir, { recursive: true });
  // 临时 user profile 避免多实例冲突（soffice 共享 profile 会报 "source file could not be loaded"）
  const profile = path.join(os.tmpdir(), `lo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const expectedPdf = path.join(outDir, path.basename(srcPath, path.extname(srcPath)) + '.pdf');
  try {
    await execFileP(pdfEngines.sofficePath, [
      '--headless', '--norestore', '--nolockcheck', '--nofirststartwizard',
      '-env:UserInstallation=file://' + profile,
      '--convert-to', 'pdf', '--outdir', outDir, srcPath,
    ], { timeout: 180000 });
  } finally {
    // 延迟清理临时 profile（soffice 可能还没完全释放）
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 8000);
  }
  if (!fs.existsSync(expectedPdf)) throw new Error('LibreOffice 转换未输出 PDF：' + expectedPdf);
  if (path.resolve(expectedPdf) !== path.resolve(dstPath)) fs.renameSync(expectedPdf, dstPath);
}

// AppleScript 通用执行（用临时 .applescript 文件避免命令行转义陷阱）
async function runAppleScript(script) {
  const tmp = path.join(os.tmpdir(), `aicopilot-as-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.applescript`);
  fs.writeFileSync(tmp, script, 'utf8');
  try {
    await execFileP('osascript', [tmp], { timeout: 180000 });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// macOS Pages 转 PDF（doc/docx/rtf/odt 兜底）
async function pagesToPdf(srcPath, dstPath) {
  if (!pdfEngines.pages) throw new Error('Pages 未安装');
  const script = `tell application "Pages"
  activate
  set srcFile to POSIX file "${srcPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  set dstFile to POSIX file "${dstPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  open srcFile
  set theDoc to result
  delay 1
  export theDoc to dstFile as PDF
  close theDoc saving no
end tell
return "ok"`;
  await runAppleScript(script);
  if (!fs.existsSync(dstPath)) throw new Error('Pages 导出 PDF 失败（未生成目标文件）');
}

// macOS Numbers 转 PDF（xls/xlsx 兜底）
async function numbersToPdf(srcPath, dstPath) {
  if (!pdfEngines.numbers) throw new Error('Numbers 未安装');
  const script = `tell application "Numbers"
  activate
  set srcFile to POSIX file "${srcPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  set dstFile to POSIX file "${dstPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
  open srcFile
  set theDoc to result
  delay 1
  export theDoc to dstFile as PDF
  close theDoc saving no
end tell
return "ok"`;
  await runAppleScript(script);
  if (!fs.existsSync(dstPath)) throw new Error('Numbers 导出 PDF 失败（未生成目标文件）');
}

/* ---- 转 PDF（保留格式）：HTML → Electron printToPDF ---- */
let pdfWin = null;
async function getPdfWin() {
  if (pdfWin && !pdfWin.isDestroyed()) return pdfWin;
  pdfWin = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true } });
  return pdfWin;
}
async function htmlToPdf(html, pdfPath) {
  const win = await getPdfWin();
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const data = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  fs.writeFileSync(pdfPath, data);
}

// 生成用于转 PDF 的 HTML：Office 经 textutil→html 保留格式；纯文本包 styled HTML
// 注意：textutil 输出的 HTML 已经带 <style> 定义了 font-family/font-size 等，
// 这里只补 fallback 字体（中文兜底）和基础版式，不覆盖原文件设定的字号字色。
const PDF_BASE_CSS = `body{margin:36px;color:#1f2328;}
body,p,td,th,div,span,li{font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei','STSong','SimSun','Songti SC','Times New Roman','Liberation Serif',serif;}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:0.6em 0 0.3em;}
table{border-collapse:collapse;}td,th{padding:4px 8px;}
pre,code{white-space:pre-wrap;word-wrap:break-word;font-family:inherit;}
img{max-width:100%;height:auto;}
@page{size:A4;margin:1.5cm;}`;
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function buildHtmlForPdf(srcPath, srcExt, tmpDir) {
  // Office / html：textutil 转 html 保留格式
  if (TEXTUTIL_FORMATS[srcExt] && srcExt !== 'txt') {
    const tmpHtml = path.join(tmpDir, `conv_${Date.now()}_${Math.floor(Math.random() * 1e6)}.html`);
    await textutilConvert(srcPath, tmpHtml, 'html');
    let html = fs.readFileSync(tmpHtml, 'utf8');
    // 注入基础样式（确保中文字体与页边距）
    const styleTag = '<meta charset="utf-8"><style>' + PDF_BASE_CSS + '</style>';
    if (/<head>/i.test(html)) html = html.replace(/<head>/i, '<head>' + styleTag);
    else html = styleTag + html;
    return html;
  }
  // 纯文本（txt/md/json/csv 等）：提取文本包成 HTML
  const text = await extractText(srcPath, srcExt, tmpDir);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PDF_BASE_CSS}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

// json → csv（数组对象）
function json2csv(srcPath, dstPath) {
  const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const arr = Array.isArray(data) ? data : [data];
  const keys = [...new Set(arr.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))];
  const esc = (v) => {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.join(',')];
  for (const o of arr) lines.push(keys.map((k) => esc(o ? o[k] : '')).join(','));
  fs.writeFileSync(dstPath, lines.join('\n'), 'utf8');
}

// csv → json（支持引号与逗号）
function csv2json(srcPath, dstPath) {
  const text = fs.readFileSync(srcPath, 'utf8').replace(/\r\n?/g, '\n');
  const rows = [];
  let cur = [''], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cur[cur.length - 1] += '"'; i++; } else inQ = false; }
      else cur[cur.length - 1] += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') cur.push('');
    else if (c === '\n') { rows.push(cur); cur = ['']; }
    else cur[cur.length - 1] += c;
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  const headers = rows[0] || [];
  const out = rows.slice(1).map((r) => { const o = {}; headers.forEach((h, idx) => { o[h] = r[idx] ?? ''; }); return o; });
  fs.writeFileSync(dstPath, JSON.stringify(out, null, 2), 'utf8');
}

// 提取纯文本（textutil 源→txt 再读；纯文本源直接读）
async function extractText(srcPath, srcExt, tmpDir) {
  if (!TEXTUTIL_FORMATS[srcExt]) return fs.readFileSync(srcPath, 'utf8');
  const tmp = path.join(tmpDir, `ext_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
  await textutilConvert(srcPath, tmp, 'txt');
  return fs.readFileSync(tmp, 'utf8');
}

async function convertOne(srcPath, srcExt, dstPath, dstExt, tmpDir) {
  srcExt = srcExt.toLowerCase(); dstExt = dstExt.toLowerCase();
  if (srcExt === dstExt) { fs.copyFileSync(srcPath, dstPath); return { engine: 'copy' }; }
  // PDF 作为源格式：先提取纯文本，再按纯文本继续转换
  if (srcExt === 'pdf') {
    const text = pdfwm.extractFullText(srcPath);
    if (!text || !text.trim()) throw new Error('无法从该 PDF 提取文字（可能是图片型/加密 PDF）');
    srcPath = path.join(tmpDir, `pdfsrc_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
    fs.writeFileSync(srcPath, text, 'utf8');
    srcExt = 'txt';
  }
  if (srcExt === 'json' && dstExt === 'csv') { json2csv(srcPath, dstPath); return { engine: 'json2csv' }; }
  if (srcExt === 'csv' && dstExt === 'json') { csv2json(srcPath, dstPath); return { engine: 'csv2json' }; }
  if (dstExt === 'md' || dstExt === 'txt') {
    const text = await extractText(srcPath, srcExt, tmpDir);
    fs.writeFileSync(dstPath, text, 'utf8'); return { engine: 'textutil' };
  }
  if (dstExt === 'pdf') {
    // 智能选择 PDF 引擎：LibreOffice > macOS Pages/Numbers > textutil-html 兜底
    const { engine, label } = pickPdfEngine(srcExt);
    if (engine === 'libreoffice') {
      await libreofficeToPdf(srcPath, dstPath);
      return { engine, label };
    }
    if (engine === 'pages') {
      await pagesToPdf(srcPath, dstPath);
      return { engine, label };
    }
    if (engine === 'numbers') {
      await numbersToPdf(srcPath, dstPath);
      return { engine, label };
    }
    if (engine === 'cupsfilter') {
      // 纯文本：先提取文本，再走 cupsfilter（自动嵌入中文字体，中文不乱码）
      const text = await extractText(srcPath, srcExt, tmpDir);
      const tmpTxt = path.join(tmpDir, `txt_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
      fs.writeFileSync(tmpTxt, text, 'utf8');
      await cupsToPdf(tmpTxt, dstPath);
      return { engine, label };
    }
    // 兜底：textutil → html → Electron printToPDF（Office/HTML）
    const html = await buildHtmlForPdf(srcPath, srcExt, tmpDir);
    await htmlToPdf(html, dstPath);
    return { engine, label };
  }
  if (TEXTUTIL_FORMATS[dstExt]) {
    let effSrc = srcPath;
    if (!TEXTUTIL_FORMATS[srcExt]) {
      // md/json/csv 等纯文本：先复制为 .txt 临时文件再交给 textutil
      effSrc = path.join(tmpDir, `src_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
      fs.copyFileSync(srcPath, effSrc);
    }
    await textutilConvert(effSrc, dstPath, dstExt);
    return { engine: 'textutil' };
  }
  throw new Error(`不支持该转换：${srcExt} → ${dstExt}`);
}

ipcMain.handle('convert-files', async (_e, { files, srcFormat, dstFormat, saveMode, outputDir, baseDir, keepStructure }) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicopilot-conv-'));
  const results = [];
  let done = 0;
  for (const f of files) {
    try {
      const srcExt = (srcFormat && srcFormat !== 'auto') ? srcFormat : getExt(f);
      const dstExt = dstFormat;
      if (!dstExt) { results.push({ file: f, status: 'error', message: '未选择目标格式' }); continue; }
      const base = path.basename(f, path.extname(f));
      let target;
      if (saveMode === 'output') {
        if (!outputDir) { results.push({ file: f, status: 'error', message: '未指定输出目录' }); continue; }
        if (keepStructure && baseDir && f.startsWith(baseDir)) {
          // 保持目录结构：按相对源文件夹的路径在输出目录复刻子目录
          const rel = path.relative(baseDir, path.dirname(f));
          target = path.join(outputDir, rel, base + '.' + dstExt);
        } else {
          target = path.join(outputDir, base + '.' + dstExt);
        }
      } else {
        target = path.join(path.dirname(f), base + '.' + dstExt);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const r = await convertOne(f, srcExt, target, dstExt, tmpDir);
      done++;
      const relOut = (keepStructure && baseDir && target.startsWith(outputDir)) ? path.relative(outputDir, target) : path.basename(target);
      const engineTag = (r && r.label) ? ` [${r.label}]` : '';
      results.push({ file: f, status: 'done', message: '→ ' + relOut + engineTag, outputPath: target, engine: r && r.label });
    } catch (e) {
      results.push({ file: f, status: 'error', message: e.message });
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  return { results, summary: { total: files.length, done } };
});

// 返回 PDF 引擎检测结果（UI 显示「将使用 X 引擎」）
ipcMain.handle('pdf-engine-info', () => {
  const docx = pickPdfEngine('docx');
  const xlsx = pickPdfEngine('xlsx');
  const pptx = pickPdfEngine('pptx');
  const txt = pickPdfEngine('txt');
  return {
    available: pdfEngines,
    byExt: {
      docx: docx.label, doc: docx.label, rtf: docx.label, odt: docx.label,
      xlsx: xlsx.label, xls: xlsx.label,
      pptx: pptx.label, ppt: pptx.label,
      html: txt.label, htm: txt.label,
      txt: txt.label, md: txt.label, csv: txt.label, json: txt.label,
    }
  };
});

/* ---------------- PDF 去水印 ---------------- */
// 分析多个 PDF 的候选水印（聚合，按出现流数排序）
ipcMain.handle('pdf-analyze-watermark', (_e, files) => {
  const agg = new Map();
  const errors = [];
  try {
    for (const f of (files || [])) {
      let r;
      try {
        r = pdfwm.analyze(f);
      } catch (err) {
        errors.push({ file: f, error: '解析异常：' + (err && err.message ? err.message : err) });
        continue;
      }
      if (!r || !r.ok) { errors.push({ file: f, error: (r && r.error) || '未知错误' }); continue; }
      for (const c of r.candidates) {
        const cur = agg.get(c.text) || { text: c.text, count: 0, files: 0 };
        cur.count += c.count;
        cur.files += 1;
        agg.set(c.text, cur);
      }
    }
  } catch (e) {
    // 整体兜底：绝不让 IPC 调用 reject，否则渲染端会静默无反馈
    errors.push({ file: '(未知)', error: '分析过程异常：' + (e && e.message ? e.message : e) });
  }
  const candidates = [...agg.values()].sort((a, b) => b.count - a.count).slice(0, 80);
  return { ok: true, candidates, errors };
});

// 去除多个 PDF 的水印文字，输出到目录
ipcMain.handle('pdf-remove-watermark', (_e, { files, watermarks, outputDir }) => {
  const results = [];
  let done = 0;
  for (const f of files) {
    const target = path.join(outputDir, path.basename(f));
    const r = pdfwm.remove(f, watermarks, target);
    if (r.ok) { done++; results.push({ file: f, status: 'done', message: `已去除 ${r.removed} 处水印 → ${path.basename(target)}`, outputPath: target }); }
    else results.push({ file: f, status: 'error', message: r.error });
  }
  return { results, summary: { total: files.length, done } };
});

/* ---------------- AI 设置 ---------------- */
const aiConfig = require('./ai-config');

ipcMain.handle('ai-get-state', () => aiConfig.getState());
ipcMain.handle('ai-save-profile', (_e, profile) => aiConfig.upsertProfile(profile));
ipcMain.handle('ai-delete-profile', (_e, id) => aiConfig.deleteProfile(id));
ipcMain.handle('ai-set-active', (_e, { id, model }) => aiConfig.setActive(id, model));
ipcMain.handle('ai-get-web-access', () => aiConfig.getWebAccess());
ipcMain.handle('ai-set-web-access', (_e, enabled) => aiConfig.setWebAccess(enabled));
ipcMain.handle('ai-fetch-models', async (_e, profile) => {
  try {
    const models = await aiConfig.fetchModels(profile);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('ai-test-connection', async (_e, profile) => {
  try {
    const r = await aiConfig.testConnection(profile);
    return { ok: true, count: r.count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------------- MCP 服务器 ---------------- */
const mcp = require('./mcp');

// 启动时按配置连接（异步，不阻塞窗口）
function initMcpServers() {
  mcp.connectFromConfig()
    .then((list) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mcp-status-changed', mcp.getAllStatus());
      }
      const ready = (list || []).filter((s) => s.status === 'ready').length;
      if (list && list.length) console.log(`[MCP] 已连接 ${ready}/${list.length} 个服务器`);
    })
    .catch((e) => console.log('[MCP] 连接失败：' + e.message));
}

ipcMain.handle('mcp-get', () => ({
  servers: aiConfig.getMcpServers(),
  status: mcp.getAllStatus(),
}));

function hasUnresolvedTemplate(v) {
  return typeof v === 'string' && /\{\{[^}]+\}\}/.test(v);
}

ipcMain.handle('mcp-save', async (_e, server) => {
  try {
    // 防止把字面占位符（如 {{path}}）保存进配置
    if (server.transport === 'stdio') {
      for (const a of (server.args || [])) {
        if (hasUnresolvedTemplate(a)) throw new Error('启动参数中仍包含未替换占位符（如 {{path}}），请填写真实值后再保存。');
      }
      for (const v of Object.values(server.env || {})) {
        if (hasUnresolvedTemplate(v)) throw new Error('环境变量中仍包含未替换占位符（如 {{token}}），请填写真实值后再保存。');
      }
    } else if (server.transport === 'sse') {
      if (hasUnresolvedTemplate(server.baseUrl || '')) throw new Error('服务地址中仍包含未替换占位符，请填写真实值后再保存。');
      for (const v of Object.values(server.headers || {})) {
        if (hasUnresolvedTemplate(v)) throw new Error('请求头中仍包含未替换占位符，请填写真实值后再保存。');
      }
    }
    const saved = aiConfig.upsertMcpServer(server);
    await mcp.connectFromConfig();
    return { ok: true, server: saved, status: mcp.getAllStatus() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-delete', async (_e, id) => {
  try {
    aiConfig.deleteMcpServer(id);
    await mcp.connectFromConfig();
    return { ok: true, servers: aiConfig.getMcpServers(), status: mcp.getAllStatus() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mcp-refresh', async () => {
  try {
    await mcp.connectFromConfig();
    return { ok: true, status: mcp.getAllStatus() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 单个服务器连通性测试（用独立进程，不影响常驻连接）
ipcMain.handle('mcp-test', async (_e, server) => {
  try {
    const r = await mcp.testServer(server);
    if (r.status === 'ready') return { ok: true, toolCount: r.toolCount, tools: r.tools };
    return { ok: false, error: r.error || '连接失败' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 内置 Computer Use 总开关：写配置 → 重连 MCP（注入/移除内置服务器）→ 推送最新状态
ipcMain.handle('set-computer-use', async (_e, enabled) => {
  try { aiConfig.setComputerUseEnabled(enabled); } catch (e) { /* ignore */ }
  try { await mcp.connectFromConfig(); } catch (e) { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('mcp-status-changed', mcp.getAllStatus()); } catch (e) { /* ignore */ }
  }
  return !!enabled;
});

// 打开 macOS 系统设置「辅助功能」隐私页（Computer Use 需要辅助功能 + 屏幕录制权限）
ipcMain.handle('open-computer-use-perms', async () => {
  try { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); } catch (e) { /* ignore */ }
  return true;
});

// 中断 Computer Use 当前在途操作（Esc / 停止按钮触发）：杀掉在途 osascript、
// 同时请求 Agent 主循环立即停止（取消在途模型请求、不再执行后续工具与轮次）、
// 并通知渲染进程重置发送状态。三者合力实现需求 #1 的「立即停止」。
ipcMain.handle('computer-use-abort', async () => {
  let ok = false;
  try { ok = mcp.cancelTool('computeruse'); } catch (e) { /* ignore */ }
  try { agent.requestStop(); } catch (e) { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('computer-use-aborted'); } catch (e) { /* ignore */ }
  }
  return !!ok;
});

app.on('before-quit', () => {
  try { mcp.disconnectAll(); } catch (e) { /* ignore */ }
  stopCursorServer();
});

/* ---------------- AI 助手（智能体） ---------------- */
const agent = require('./agent');

// 替换框架的规则共享给智能体（渲染进程同步过来）
let sharedRules = [];
ipcMain.on('sync-rules', (_e, rules) => { sharedRules = rules; });

/* ============ 附件读取（拖入对话框的文件，发送前解析为可给模型看的内容） ============ */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'ico']);
const PLAIN_TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'sh', 'bat', 'ini', 'conf', 'cfg', 'yaml', 'yml', 'toml', 'log', 'tex', 'vue', 'csv', 'rtf']);

function fileExtOf(p) { return (path.extname(p || '') || '').toLowerCase().replace(/^\./, ''); }
function mimeForExt(ext) {
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', ico: 'image/x-icon' };
  return map[ext] || 'application/octet-stream';
}

// 把 Office/ODF 的内部 XML 粗略转成纯文本（保留段落/换行）
function xmlToText(xml) {
  return xml
    .replace(/<\/(w:p|text:p|a:p|p)>/g, '\n')
    .replace(/<(w:br|text:line-break|br)\b[^>]*\/?>/g, '\n')
    .replace(/<\/(tr|table:table-row)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 从 zip 类文档（docx/xlsx/pptx/odt/...）中提取文本
function extractFromZip(buf, nameFilter) {
  try {
    const entries = readZipEntries(buf);
    const wanted = entries.filter((e) => nameFilter(e.name));
    if (!wanted.length) return '';
    return wanted.map((e) => xmlToText(e.data.toString('utf8'))).join('\n\n').slice(0, 60000);
  } catch (e) { return ''; }
}

// PDF → 文本（借助 LibreOffice，转 txt 后读取）
async function pdfToText(srcPath) {
  if (!pdfEngines.sofficePath) return null;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-'));
  const profile = path.join(os.tmpdir(), `lo-${process.pid}-${Date.now()}`);
  try {
    await execFileP(pdfEngines.sofficePath, [
      '--headless', '--norestore', '--nolockcheck', '--nofirststartwizard',
      '-env:UserInstallation=file://' + profile,
      '--convert-to', 'txt:Text', '--outdir', outDir, srcPath,
    ], { timeout: 120000 });
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.txt'));
    if (!files.length) return null;
    return fs.readFileSync(path.join(outDir, files[0]), 'utf8').slice(0, 80000);
  } catch (e) { return null; }
  finally { setTimeout(() => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {} }, 8000); }
}

// 把单个拖入文件解析为模型可见内容：图片→base64，文档→提取文本
async function readAttachmentForAi(item) {
  const p = item && item.path;
  const name = (item && item.name) || (p ? path.basename(p) : '');
  if (!p || !fs.existsSync(p)) return { kind: 'other', name, error: '文件不存在' };
  const ext = fileExtOf(p);
  try {
    if (IMAGE_EXTS.has(ext)) {
      const buf = fs.readFileSync(p);
      return { kind: 'image', name, mime: mimeForExt(ext), base64: buf.toString('base64'), size: buf.length };
    }
    if (PLAIN_TEXT_EXTS.has(ext)) {
      return { kind: 'doc', name, text: fs.readFileSync(p, 'utf8').slice(0, 80000) };
    }
    if (['docx', 'docm', 'dotx', 'dotm'].includes(ext)) {
      const txt = extractFromZip(fs.readFileSync(p), (n) => n === 'word/document.xml');
      return { kind: 'doc', name, text: txt || '（无法从文档提取文本）' };
    }
    if (['xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm'].includes(ext)) {
      const txt = extractFromZip(fs.readFileSync(p), (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
      return { kind: 'doc', name, text: txt || '（无法从表格提取文本）' };
    }
    if (['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(ext)) {
      const txt = extractFromZip(fs.readFileSync(p), (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      return { kind: 'doc', name, text: txt || '（无法从演示文稿提取文本）' };
    }
    if (['odt', 'ods', 'odp'].includes(ext)) {
      const txt = extractFromZip(fs.readFileSync(p), (n) => n === 'content.xml');
      return { kind: 'doc', name, text: txt || '（无法从文档提取文本）' };
    }
    if (ext === 'pdf') {
      const txt = await pdfToText(p);
      return { kind: 'doc', name, text: txt || '（无法从 PDF 提取文本，可能已加密或 LibreOffice 未安装）' };
    }
    // 其它格式（含旧版 .doc/.xls/.ppt 二进制）：尽力按文本读，二进制则放弃
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch { raw = ''; }
    if (raw && raw.slice(0, 200).includes('\u0000')) raw = '';
    return raw ? { kind: 'doc', name, text: raw.slice(0, 80000) } : { kind: 'other', name, error: '暂不支持该格式内联读取' };
  } catch (e) {
    return { kind: 'other', name, error: e.message };
  }
}

ipcMain.handle('ai-chat', async (event, { history, text, attachments }) => {
  const profile = aiConfig.getActiveProfile();
  if (!profile) return { ok: false, error: '请先在「AI 设置」中添加并启用一个 AI 配置' };
  if (!profile.model) return { ok: false, error: '当前 AI 配置未选择模型，请到「AI 设置」拉取并选择模型' };
  const wc = event.sender;
  try {
    let resolvedAttachments = [];
    if (Array.isArray(attachments) && attachments.length) {
      resolvedAttachments = await Promise.all(attachments.map((a) => readAttachmentForAi(a)));
    }
    const activeChatId = currentChatId || null;
    // 新一轮对话开始：清空 ComputerUse 的会话级硬停止 / 连续失败计数（需求：连续两次失败才停、新对话必须真正清理）
    try { mcp.resetTool('computeruse'); } catch (e) { /* ComputerUse 未启用时忽略 */ }
    const result = await agent.runAgent(profile, history, text, {
      skillsDir: SKILLS_DIR,
      attachments: resolvedAttachments,
      webAccess: aiConfig.getWebAccess(),
      mcpEnabled: mcpEnabledMode,
      mcpServer: mcpSelectedServer,
      chatId: activeChatId,
      memoryEnabled: aiConfig.getMemoryEnabled(),
      onText: (t) => wc.send('ai-chat-text', t),
      onToolStart: (d) => wc.send('ai-chat-tool-start', d),
      onToolEnd: (d) => wc.send('ai-chat-tool-end', d),
      onConfirm: (payload) => new Promise((resolve) => {
        const type = payload && typeof payload === 'object' ? payload.type : null;
        const data = {
          type: type || '',
          title: (payload && payload.title) || '',
          desc: (payload && payload.desc) || (typeof payload === 'string' ? payload : ''),
        };
        // 权限模式：deny 全部拒绝，trust 全部放行，ask 才弹窗询问
        if (permissionMode === 'deny') { resolve(false); return; }
        if (permissionMode === 'trust') { resolve(true); return; }
        // 本次会话已勾选「不再询问」的同类操作，直接放行
        if (type && sessionApproved.has(type)) { resolve(true); return; }
        pendingConfirm = (ok, remember) => {
          if (ok && remember && type) sessionApproved.add(type);
          resolve(ok);
          pendingConfirm = null;
        };
        wc.send('ai-chat-confirm', data);
      }),
      onTodo: (todos) => wc.send('ai-chat-todo', todos),
      onSubagentStart: (d) => wc.send('ai-chat-subagent-start', d),
      onSubagentEnd: (d) => wc.send('ai-chat-subagent-end', d),
      onCompact: () => wc.send('ai-chat-compact'),
      onInstallSkill: (info) => new Promise((resolve) => {
        // 安装技能始终需要用户确认（即使 trust 模式也不自动放行）
        pendingInstallSkill = (ok) => {
          resolve(ok);
          pendingInstallSkill = null;
        };
        wc.send('ai-chat-install-skill', info);
      }),
      // 仓库型推荐技能：由主进程从 GitHub 下载安装（供 install_skill 工具调用）
      installSkillFromUrl: async (repo, branch, name) => {
        try { return await installSkillFromGithub(repo, branch, name || repo); }
        catch (e) { return { ok: false, error: e.message }; }
      },
      getRules: () => sharedRules,
      onRulesChanged: () => wc.send('rules-changed', sharedRules),
    });
    return { ok: result.ok, error: result.error, usage: result.usage, messages: result.messages || [], todos: result.todos || [], hitMaxTurns: result.hitMaxTurns || false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 本次会话已授权过的操作类型（勾选「不再询问」后记录）
const sessionApproved = new Set();

// 权限模式：'ask'（每次询问，默认）| 'trust'（本次会话自动放行）| 'deny'（只读，全部拒绝）
let permissionMode = 'ask';
ipcMain.handle('set-permission-mode', (_e, mode) => {
  if (['ask', 'trust', 'deny'].includes(mode)) permissionMode = mode;
  return permissionMode;
});

// MCP 外部工具开关：默认关闭，用户在聊天栏开启后才注入 MCP 工具
let mcpEnabledMode = false;
ipcMain.handle('set-mcp-enabled', (_e, enabled) => {
  mcpEnabledMode = !!enabled;
  return mcpEnabledMode;
});

// 用户在聊天栏单选的 MCP 服务器名（null=未指定，开启 MCP 时注入该服务器的工具）
let mcpSelectedServer = null;
ipcMain.handle('set-mcp-server', (_e, name) => {
  mcpSelectedServer = name || null;
  return mcpSelectedServer;
});

let pendingConfirm = null;
ipcMain.handle('ai-chat-confirm-reply', (_e, ok, remember) => {
  if (pendingConfirm) { pendingConfirm(!!ok, !!remember); }
});

// 技能安装授权回调
let pendingInstallSkill = null;
ipcMain.handle('ai-chat-install-skill-reply', (_e, ok) => {
  if (pendingInstallSkill) { pendingInstallSkill(!!ok); }
});

/* ---------------- 文件自动化：编写规范预设持久化 ---------------- */
const automationPresetsPath = () => path.join(app.getPath('userData'), 'automation-presets.json');
ipcMain.handle('automation-get-presets', () => {
  try { return JSON.parse(fs.readFileSync(automationPresetsPath(), 'utf8')); }
  catch (e) { return []; }
});
ipcMain.handle('automation-save-presets', (_e, presets) => {
  try {
    fs.mkdirSync(path.dirname(automationPresetsPath()), { recursive: true });
    fs.writeFileSync(automationPresetsPath(), JSON.stringify(Array.isArray(presets) ? presets : [], null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- 对话历史持久化 ---------------- */
const chatHistoryPath = () => path.join(app.getPath('userData'), 'chat-history.json');

ipcMain.handle('chat-load', () => {
  try {
    const raw = fs.readFileSync(chatHistoryPath(), 'utf8');
    const data = JSON.parse(raw);
    return { chats: Array.isArray(data.chats) ? data.chats : [], activeId: data.activeId ?? null };
  } catch (e) { return { chats: [], activeId: null }; }
});

ipcMain.handle('chat-save', (_e, { chats, activeId }) => {
  try {
    currentChatId = activeId || null;
    fs.mkdirSync(path.dirname(chatHistoryPath()), { recursive: true });
    fs.writeFileSync(chatHistoryPath(), JSON.stringify({ chats, activeId }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* ---------------- 长期记忆库 ---------------- */
ipcMain.handle('memory-get', (_e, { scope, chatId }) => {
  try { return memory.loadMemory(scope, chatId); }
  catch (e) { return []; }
});
ipcMain.handle('memory-set', (_e, { scope, chatId, entries }) => {
  try { memory.saveMemory(scope, chatId, entries); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('memory-delete', (_e, { scope, chatId, id }) => {
  try { memory.deleteMemoryEntry(scope, chatId, id); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('memory-enabled-get', () => aiConfig.getMemoryEnabled());
ipcMain.handle('memory-enabled-set', (_e, enabled) => aiConfig.setMemoryEnabled(enabled));
ipcMain.handle('ai-voice-config-get', () => aiConfig.getVoiceConfig());
ipcMain.handle('ai-voice-config-set', (_e, cfg) => aiConfig.setVoiceConfig(cfg));
ipcMain.handle('ai-voice-default-voices', () => aiConfig.DEFAULT_MINIMAX_VOICE_IDS || []);
ipcMain.handle('ai-voice-fetch-voices', async (_e, { apiKey, baseUrl }) => {
  try {
    const voices = await aiConfig.fetchMinimaxVoices(apiKey, baseUrl);
    return { ok: true, voices };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('ai-voice-fetch-models', async (_e, { apiKey, baseUrl }) => {
  try {
    const models = await aiConfig.fetchVoiceModels({ apiKey, baseUrl });
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

/* ---------------- AI 语音网络请求（走主进程，绕过 CSP） ---------------- */
// 将 hex 字符串（MiniMax T2A V2 的 audio 默认编码）转成 base64，供渲染进程解码播放
function hexToBase64(hex) {
  const s = String(hex).trim();
  if (!s || s.length % 2 !== 0) throw new Error('音频内容不是有效的 hex 编码');
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = parseInt(s.substr(i * 2, 2), 16);
    if (Number.isNaN(b)) throw new Error('音频内容包含非 hex 字符');
    bytes[i] = b;
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// 先读原始文本再解析 JSON，避免接口返回 HTML/空字符串时直接抛出 JSON.parse 错误
async function readJsonResponse(resp) {
  const text = await resp.text();
  let data = null;
  if (text && text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      const snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
      throw new Error(`接口返回不是有效 JSON：${snippet}`);
    }
  }
  return { status: resp.status, data, raw: text };
}

// MiniMax 原生语音识别（ASR）：接口为 /v1/audio/asr（JSON body，非 multipart），
// 部署在 api.minimaxi.com / api.minimax.io，与 TTS 的 api.minimax.chat 不同。
// 注意：MiniMax 的 OpenAI 兼容 /audio/transcriptions 端点并不存在（会 404），必须用 /audio/asr。
async function fetchMinimaxASR(audioBase64, key) {
  const candidates = [
    'https://api.minimax.chat/v1/audio/asr',
    'https://api.minimaxi.com/v1/audio/asr',
    'https://api.minimax.io/v1/audio/asr',
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          audio_format: 'wav',
          sample_rate: 16000,
          language: 'zh-CN',
          audio_data: audioBase64,
        }),
      });
      const respText = await resp.text();
      if (resp.status === 404) { lastErr = new Error('接口返回 404'); continue; }
      let data = null;
      try { data = JSON.parse(respText); } catch (e) { lastErr = new Error('响应不是有效 JSON：' + respText.slice(0, 120)); continue; }
      if (resp.status < 200 || resp.status >= 300) {
        const msg = (data && data.base_resp && data.base_resp.status_msg)
          || (data && data.error && data.error.message)
          || `HTTP ${resp.status}`;
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(`MiniMax 语音识别失败：${msg}（API Key 可能无 ASR 权限，或 Key 与域名区域不匹配）`);
        }
        lastErr = new Error(msg);
        continue;
      }
      let text = '';
      if (typeof data.text === 'string') text = data.text;
      else if (data.data && typeof data.data.text === 'string') text = data.data.text;
      else if (data.data && typeof data.data.utter === 'string') text = data.data.utter;
      else if (data.data && typeof data.data.result === 'string') text = data.data.result;
      if (!text) throw new Error('MiniMax ASR 响应中未找到识别文本');
      return text;
    } catch (e) {
      if (e.message && e.message.indexOf('MiniMax 语音识别失败') === 0) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('MiniMax 语音识别请求失败');
}

ipcMain.handle('ai-voice-tts', async (_e, { text, config }) => {
  try {
    const provider = config && config.provider;
    const key = String(
      (provider === 'minimax' ? config.minimaxKey : config.customKey) || config.apiKey || ''
    ).trim();

    // 本地语音：由渲染进程用 Web Speech API 处理，主进程不发声
    if (provider === 'local') {
      return { ok: true, local: true };
    }

    // MiniMax 海螺
    if (provider === 'minimax') {
      if (!key) throw new Error('请先填写 MiniMax API Key 并保存');
      const baseUrl = 'https://api.minimax.chat/v1';
      const model = String(config.model || 'speech-2.8-turbo').trim();
      const voiceId = String(config.voiceId || '').trim();
      if (!voiceId) throw new Error('请先选择 MiniMax 音色');
      const speed = Number(config.speed) || 1.0;
      const body = {
        model,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId, speed: Math.max(0.5, Math.min(2, speed)) },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      };
      const resp = await fetch(`${baseUrl}/t2a_v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const { status, data } = await readJsonResponse(resp);
      if (status < 200 || status >= 300 || (data && data.base_resp && data.base_resp.status_code !== 0)) {
        throw new Error((data && data.base_resp && data.base_resp.status_msg) || `HTTP ${status}`);
      }
      // MiniMax T2A V2 的 audio 默认是 hex 编码（output_format=hex），需转成 base64 再回传
      let audioHex = null;
      if (data.audio && typeof data.audio === 'string') audioHex = data.audio;
      else if (data.data && typeof data.data.audio === 'string') audioHex = data.data.audio;
      if (!audioHex) throw new Error('响应中未找到音频内容');
      const audioBase64 = hexToBase64(audioHex);
      return { ok: true, audioBase64, mime: 'audio/mp3' };
    }

    // 自定义 OpenAI 兼容
    if (!key) throw new Error('请先填写 API Key 并保存');
    const baseUrl = String(config.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('请先填写 API 地址并保存');
    const model = String(config.customModel || '').trim();
    if (!model) throw new Error('请先拉取并选择 TTS 模型');
    const body = {
      model,
      input: text,
      voice: 'alloy',
      response_format: 'mp3',
      speed: 1.0,
    };
    const resp = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (resp.status < 200 || resp.status >= 300) {
      let msg = `HTTP ${resp.status}`;
      try {
        const t = await resp.text();
        if (t && t.trim()) {
          const d = JSON.parse(t);
          if (d && d.error && d.error.message) msg = d.error.message;
          else if (typeof d === 'string') msg = d;
        }
      } catch (e) { /* 忽略解析错误，保留 HTTP 状态 */ }
      const tip = resp.status === 404
        ? '：接口不存在，请确认「API 地址」末尾为 /v1（例如 https://api.openai.com/v1）'
        : ((resp.status === 401 || resp.status === 403)
          ? '：API Key 无效或无 TTS 权限'
          : '');
      throw new Error(`语音合成失败（${msg}）${tip}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const audioBase64 = buf.toString('base64');
    if (!audioBase64) throw new Error('响应中未找到音频内容');
    return { ok: true, audioBase64, mime: 'audio/mp3' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 语音识别（STT）走「独立的 OpenAI 兼容配置」，与 TTS 完全解耦：
//  - 默认 sttProvider='openai' → POST {sttBaseUrl}/audio/transcriptions（multipart，兼容 OpenAI / 硅基流动 / 通义等）
//  - 仅当用户明确选择 sttProvider='minimax' 时，才调用 MiniMax 原生 /v1/audio/asr
//    （MiniMax 的 OpenAI 兼容 /audio/transcriptions 不存在，会 404，故绝不作为默认）
ipcMain.handle('ai-voice-stt', async (_e, { audioBase64, mime, config }) => {
  try {
    const sttProvider = (config && config.sttProvider === 'minimax') ? 'minimax' : 'openai';
    // OpenAI 兼容路径使用独立的 sttKey；MiniMax 原生路径复用 MiniMax TTS 的 minimaxKey
    const sttKey = (sttProvider === 'minimax')
      ? String((config && config.minimaxKey) || '').trim()
      : String((config && config.sttKey) || '').trim();

    if (!sttKey) {
      throw new Error('请先在「AI 语音 → 语音识别(STT)」中填写 API Key 并保存');
    }

    // MiniMax 原生 ASR：仅在用户明确选择 minimax 时调用（/v1/audio/asr，JSON body）
    if (sttProvider === 'minimax') {
      const text = await fetchMinimaxASR(audioBase64, sttKey);
      return { ok: true, text: text || '' };
    }

    // OpenAI 兼容 /audio/transcriptions（multipart form），默认路径
    const sttBaseUrl = String((config && config.sttBaseUrl) || '').replace(/\/+$/, '');
    if (!sttBaseUrl) {
      throw new Error('请先填写 STT 接口地址并保存（例如 https://api.openai.com/v1）');
    }
    const sttModel = String((config && config.sttModel) || '').trim();
    if (!sttModel) {
      throw new Error('请先填写 STT 模型名（例如 whisper-1 / gpt-4o-transcribe）');
    }
    const url = `${sttBaseUrl}/audio/transcriptions`;
    const buf = Buffer.from(String(audioBase64 || ''), 'base64');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime || 'audio/wav' }), 'voice.wav');
    form.append('model', sttModel);
    form.append('language', 'zh');
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sttKey}` },
      body: form,
    });
    const { status, data } = await readJsonResponse(resp);
    if (status < 200 || status >= 300) {
      const msg = (data && data.error && data.error.message) || `HTTP ${status}`;
      const tip = status === 404
        ? '：接口不存在，请确认「STT 接口地址」末尾为 /v1（例如 https://api.openai.com/v1）'
        : ((status === 401 || status === 403)
          ? '：API Key 无效或无语音识别(ASR)权限'
          : '');
      throw new Error(`语音识别失败（${msg}）${tip}`);
    }
    return { ok: true, text: (data && data.text) || '' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});
