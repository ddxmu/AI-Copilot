/* ================= 定时任务（独立窗口 + 后台调度器） =================
 * 侧边栏「定时任务」点击后打开的独立窗口：像 ChatGPT Tasks 那样安排持续性任务。
 * 主进程内置调度器：每 30 秒对时一次，到点的任务用「AI 设置」里的启用配置自动跑一轮，
 * 结果写进任务历史并按通知设置发系统通知。任务存 userData/scheduled-tasks.json。
 * 不改动任何既有功能面板与升级链路，纯新增模块。
 */
const { BrowserWindow, screen, ipcMain, app, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let timer = null;
const runningSet = new Set(); // 正在执行的任务 id（防止重复触发）

function tasksPath() {
  return path.join(app.getPath('userData'), 'scheduled-tasks.json');
}

function readTasks() {
  try {
    const j = JSON.parse(fs.readFileSync(tasksPath(), 'utf8'));
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.tasks)) return j.tasks;
    return [];
  } catch (e) {
    return [];
  }
}

function writeTasks(list) {
  try {
    fs.mkdirSync(path.dirname(tasksPath()), { recursive: true });
    fs.writeFileSync(tasksPath(), JSON.stringify({ tasks: Array.isArray(list) ? list : [] }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ---------------- 下次运行时间 ---------------- */
function nextRunOf(t, from) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t && t.time || ''));
  const hh = m ? Math.min(23, parseInt(m[1], 10)) : 9;
  const mm = m ? Math.min(59, parseInt(m[2], 10)) : 0;
  const rep = (t && t.repeat) || 'daily';
  if (rep === 'weekly') {
    const wds = Array.isArray(t.weekdays) && t.weekdays.length
      ? t.weekdays.map(Number).filter((x) => x >= 0 && x <= 6) : [1];
    for (let i = 0; i < 8; i++) {
      const cand = new Date(from + i * 86400000);
      cand.setHours(hh, mm, 0, 0);
      if (wds.indexOf(cand.getDay()) >= 0 && cand.getTime() > from) return cand.getTime();
    }
    return from + 7 * 86400000;
  }
  if (rep === 'monthly') {
    const day = Math.min(Math.max(parseInt(t.day, 10) || 1, 1), 28);
    const base = new Date(from);
    for (let i = 0; i < 14; i++) {
      const cand = new Date(base.getFullYear(), base.getMonth(), day, hh, mm, 0, 0);
      cand.setMonth(base.getMonth() + i);
      if (cand.getTime() > from) return cand.getTime();
    }
    return from + 30 * 86400000;
  }
  const cand = new Date(from);
  cand.setHours(hh, mm, 0, 0);
  if (cand.getTime() > from) return cand.getTime();
  return cand.getTime() + 86400000;
}

/* 保存前归一化：补齐缺失字段；nextRun 缺失或已过期（编辑/启用后）推到下一个未来时刻 */
function normalize(list) {
  const now = Date.now();
  return (Array.isArray(list) ? list : []).map((t) => {
    const o = Object.assign({}, t);
    o.id = String(o.id || ('t' + Date.now() + Math.random().toString(36).slice(2, 5)));
    o.name = String(o.name || '未命名任务').slice(0, 60);
    o.icon = String(o.icon || '⏰').slice(0, 8);
    o.prompt = String(o.prompt || '');
    o.repeat = ['daily', 'weekly', 'monthly'].indexOf(o.repeat) >= 0 ? o.repeat : 'daily';
    o.time = /^(\d{1,2}):(\d{2})$/.test(String(o.time)) ? o.time : '09:00';
    if (!Array.isArray(o.history)) o.history = [];
    o.enabled = o.enabled !== false;
    o.localRun = o.localRun !== false;
    o.notify = ['important', 'all', 'none'].indexOf(o.notify) >= 0 ? o.notify : 'important';
    o.web = o.web !== false;
    if (!o.nextRun || o.nextRun <= now) o.nextRun = nextRunOf(o, now);
    return o;
  });
}

/* ---------------- AI 执行 ---------------- */
function skillsDir() {
  return path.join(app.getPath('userData'), 'skills');
}

async function runAi(t) {
  const agent = require('./agent');
  const aiConfig = require('./ai-config');
  const profile = aiConfig.getActiveProfile();
  if (!profile) throw new Error('未启用任何 AI 配置，请到主窗口「AI 设置」添加并启用');
  if (!profile.model) throw new Error('当前 AI 配置未选择模型，请到「AI 设置」选择模型');
  let text = '';
  const result = await agent.runAgent(profile, [], String(t.prompt || ''), {
    skillsDir: skillsDir(),
    attachments: [],
    webAccess: t.web !== false,
    mcpEnabled: false,
    mcpServer: null,
    chatId: null,
    runId: 'sched-' + t.id + '-' + Date.now(),
    memoryEnabled: false,
    onText: (s) => { text += s || ''; },
    // 无人值守：写文件 / 执行命令这类授权一律拒绝，保证定时任务安全
    onConfirm: () => Promise.resolve(false),
    onAskUser: () => Promise.resolve(null),
    onInstallSkill: () => Promise.resolve(false),
    getRules: () => [],
  });
  if (!result || !result.ok) throw new Error((result && result.error) || 'AI 调用失败');
  const out = String(text || '').trim();
  if (!out) throw new Error('AI 没有返回任何内容');
  return out;
}

function notifyTask(t, ok, text) {
  const mode = t.notify || 'important';
  if (mode === 'none') return;
  if (mode === 'important' && ok) return; // 重要更新：只在失败时打扰
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: (ok ? '定时任务完成：' : '定时任务失败：') + (t.name || '未命名任务'),
        body: String(text || '').replace(/\s+/g, ' ').slice(0, 140),
        silent: false,
      }).show();
    }
  } catch (e) { /* ignore */ }
}

async function runTask(id) {
  const list = readTasks();
  const t = list.find((x) => x.id === id);
  if (!t || runningSet.has(id)) return;
  runningSet.add(id);
  broadcast(); // 让界面立刻显示「运行中」
  const started = Date.now();
  let ok = false;
  let text = '';
  try {
    text = await runAi(t);
    ok = true;
  } catch (e) {
    text = (e && e.message) || String(e);
  }
  runningSet.delete(id);
  // 重新读一遍再写，避免覆盖运行期间用户在界面上的保存
  const list2 = readTasks();
  const t2 = list2.find((x) => x.id === id);
  if (t2) {
    t2.lastRun = started;
    if (!Array.isArray(t2.history)) t2.history = [];
    t2.history.unshift({ time: started, ok, text: String(text || '').slice(0, 4000) });
    if (t2.history.length > 20) t2.history.length = 20;
    writeTasks(list2);
  }
  notifyTask(t, ok, text);
  broadcast();
}

/* ---------------- 调度器（每 30 秒对时） ---------------- */
function tick() {
  try {
    const now = Date.now();
    const list = readTasks();
    let changed = false;
    for (const t of list) {
      if (t.enabled === false || t.localRun === false) continue; // 暂停 / 不在本机运行
      if (!t.nextRun) { t.nextRun = nextRunOf(t, now); changed = true; continue; }
      if (t.nextRun <= now) {
        t.nextRun = nextRunOf(t, now); // 先推到下一轮，再异步执行（防止每 30 秒重复触发）
        changed = true;
        runTask(t.id);
      }
    }
    if (changed) writeTasks(list);
  } catch (e) { /* 调度器不允许抛错 */ }
}

function startScheduler() {
  if (timer) return;
  timer = setInterval(tick, 30 * 1000);
  setTimeout(tick, 8 * 1000); // 启动后稍等片刻先对时一次（期间错过的任务补跑一轮）
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ---------------- 窗口 ---------------- */
function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.max(960, Math.min(1240, Math.round(area.width - 140)));
  const h = Math.max(620, Math.min(820, Math.round(area.height - 120)));
  win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    title: '定时任务',
    backgroundColor: '#ffffff',
    minWidth: 880,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'schedule.html'));
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  win.on('closed', () => { win = null; });
  return win;
}

function open() {
  const w = ensureWindow();
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
  return true;
}

function close() {
  if (win && !win.isDestroyed()) { try { win.destroy(); } catch (e) { /* ignore */ } }
  win = null;
}

function broadcast() {
  try { if (win && !win.isDestroyed()) win.webContents.send('schedule-changed'); } catch (e) { /* ignore */ }
}

/* ---------------- IPC ---------------- */
function init() {
  ipcMain.handle('schedule-open', () => open());
  ipcMain.handle('schedule-tasks-get', () => readTasks());
  ipcMain.handle('schedule-tasks-save', (_e, list) => {
    const norm = normalize(list);
    const r = writeTasks(norm);
    broadcast();
    return r;
  });
  // 立即运行：不等下一次到点（手动触发）
  ipcMain.handle('schedule-run-now', (_e, { id } = {}) => {
    if (!id) return { ok: false, error: '缺少任务 id' };
    const t = readTasks().find((x) => x.id === id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (runningSet.has(id)) return { ok: false, error: '该任务正在运行中' };
    runTask(id);
    return { ok: true };
  });
  startScheduler();
}

module.exports = { init, open, close, startScheduler, stopScheduler, readTasks, writeTasks, nextRunOf };
