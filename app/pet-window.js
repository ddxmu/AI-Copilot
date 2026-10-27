/* ================= 桌面宠物窗口（桌宠显示） =================
 * 一个透明、无边框、置顶的小窗口，显示桌面宠物角色与状态字幕气泡。
 * 状态由主进程在 AI 对话过程中推送（思考中 / 调用工具 / 回答 / 提问 / 完成），
 * 不依赖任何外部应用；同时 AI Copilot 可把同样的状态外发到 session-events.jsonl，
 * 供 VibeCute 等桌面陪伴应用读取（见 session-events.js）。
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const WIDTH = 190;
const HEIGHT = 250;   // 下方 190 为角色区，上方留给气泡
const MARGIN = 24;    // 距屏幕边缘

let win = null;
let cfg = null;       // ai-config 引用
let lastPoint = { x: 0, y: 0 };

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const saved = (cfg && cfg.getPetConfig()) || {};
  const x = typeof saved.x === 'number' ? saved.x : Math.round(area.x + area.width - WIDTH - MARGIN);
  const y = typeof saved.y === 'number' ? saved.y : Math.round(area.y + area.height - HEIGHT - MARGIN);

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x, y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'pet-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'));
  win.setIgnoreMouseEvents(!!(saved.clickThrough !== false), { forward: true });
  win.on('closed', () => { win = null; });
  return win;
}

function isVisible() { return !!(win && !win.isDestroyed() && win.isVisible()); }

function show() {
  const w = ensureWindow();
  if (!w.isVisible()) w.show();
  sendConfig();
  return true;
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
  return true;
}

function close() {
  if (win && !win.isDestroyed()) { win.destroy(); }
  win = null;
}

// 推送配置（角色 / 气泡 / 穿透）到宠物窗口
function sendConfig() {
  if (!win || win.isDestroyed()) return;
  const c = (cfg && cfg.getPetConfig()) || {};
  win.webContents.send('pet-config', c);
}

// 推送状态：status = idle | thinking | working | question | done
function setState(status, text) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  win.webContents.send('pet-state', { status: status || 'idle', text: String(text || '').slice(0, 120) });
}

function applyConfig() {
  if (!cfg) return;
  const c = cfg.getPetConfig() || {};
  if (c.enabled) {
    show();
    sendConfig();
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!c.clickThrough, { forward: true });
  } else {
    hide();
  }
}

function init(aiConfig) {
  cfg = aiConfig;
  ipcMain.handle('pet-show', () => show());
  ipcMain.handle('pet-hide', () => hide());
  ipcMain.handle('pet-state', (_e, s) => setState(s && s.status, s && s.text));
  ipcMain.handle('pet-apply', () => { applyConfig(); return true; });
  // 拖动：由渲染层在鼠标按下后持续上报位移增量
  ipcMain.on('pet-move', (_e, delta) => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    const nx = x + (delta.dx || 0);
    const ny = y + (delta.dy || 0);
    win.setPosition(nx, ny);
    lastPoint = { x: nx, y: ny };
  });
  // 松手后记住位置
  ipcMain.on('pet-move-end', () => {
    if (!cfg || !lastPoint) return;
    cfg.setPetPosition(lastPoint.x, lastPoint.y);
  });
  return { applyConfig };
}

module.exports = { init, show, hide, close, setState, applyConfig, isVisible, sendConfig };
