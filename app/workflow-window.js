/* ================= 自动化工作流窗口（ComfyUI 风格节点画布） =================
 * 侧边栏「自动化」点击后打开的独立窗口：把「替换文件 / 文件名修改 / 格式转换 /
 * PDF去水印 / 文件自动化 / PPT编写」六大功能拆成可连线的工作流节点，
 * 支持项目保存（userData/workflow-flows.json）、打开、另存为、打开文件。
 * 不改动任何既有功能面板与升级链路，纯新增模块。
 */
const { BrowserWindow, screen, ipcMain, dialog, app } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;

function flowsPath() {
  return path.join(app.getPath('userData'), 'workflow-flows.json');
}

function readFlows() {
  try {
    const j = JSON.parse(fs.readFileSync(flowsPath(), 'utf8'));
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.flows)) return j.flows;
    return [];
  } catch (e) {
    return [];
  }
}

function writeFlows(list) {
  try {
    fs.mkdirSync(path.dirname(flowsPath()), { recursive: true });
    fs.writeFileSync(flowsPath(), JSON.stringify({ flows: Array.isArray(list) ? list : [] }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.max(900, Math.min(1320, Math.round(area.width - 120)));
  const h = Math.max(600, Math.min(880, Math.round(area.height - 110)));

  win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(area.x + (area.width - w) / 2),
    y: Math.round(area.y + (area.height - h) / 2),
    title: '自动化工作流',
    backgroundColor: '#1b1d23',
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
  win.loadFile(path.join(__dirname, 'renderer', 'workflow.html'));
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  win.on('closed', () => { win = null; });
  return win;
}

function parent() { return win && !win.isDestroyed() ? win : null; }

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

function init() {
  ipcMain.handle('workflow-open', () => open());

  // 项目列表持久化（「打开项目」读的就是这里最近保存的项目名）
  ipcMain.handle('workflow-flows-get', () => readFlows());
  ipcMain.handle('workflow-flows-save', (_e, list) => writeFlows(list));

  // 节点里的选文件 / 选文件夹 / 选输出目录：父窗口用工作流窗口，弹窗不会躲到主窗口后面
  ipcMain.handle('wf-select-files', async () => {
    const r = await dialog.showOpenDialog(parent(), {
      title: '选择文件',
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('wf-select-folder', async () => {
    const r = await dialog.showOpenDialog(parent(), {
      title: '选择文件夹',
      properties: ['openDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('wf-select-output-dir', async () => {
    const r = await dialog.showOpenDialog(parent(), {
      title: '选择输出文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 另存为：把当前项目写到用户选的地址（.aiflow）
  ipcMain.handle('wf-save-project-file', async (_e, { defaultPath, content }) => {
    const r = await dialog.showSaveDialog(parent(), {
      title: '另存工作流项目',
      defaultPath: defaultPath || path.join(app.getPath('documents'), 'workflow.aiflow'),
      filters: [{ name: 'AI Copilot 工作流', extensions: ['aiflow'] }, { name: 'JSON 文件', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, String(content || '{}'), 'utf8');
      return { ok: true, filePath: r.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 打开文件：读取 .aiflow / .json 项目文件内容
  ipcMain.handle('wf-open-project-file', async () => {
    const r = await dialog.showOpenDialog(parent(), {
      title: '打开工作流项目',
      properties: ['openFile'],
      filters: [{ name: 'AI Copilot 工作流', extensions: ['aiflow', 'json'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      const raw = fs.readFileSync(r.filePaths[0], 'utf8');
      return { ok: true, filePath: r.filePaths[0], content: raw };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { init, open, close, readFlows, writeFlows };
