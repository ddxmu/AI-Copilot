const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSupportedExts: () => ipcRenderer.invoke('get-supported-exts'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getChangelog: () => ipcRenderer.invoke('get-changelog'),
  getUpgradeFlag: () => ipcRenderer.invoke('get-upgrade-flag'),
  selectFiles: (exts) => ipcRenderer.invoke('select-files', exts),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath, exts) => ipcRenderer.invoke('scan-folder', { folderPath, exts }),
  filterFiles: (files, exts) => ipcRenderer.invoke('filter-files', { files, exts }),
  runReplace: (files, rules, saveMode, outputDir, baseDir, keepStructure) =>
    ipcRenderer.invoke('run-replace', { files, rules, saveMode, outputDir, baseDir, keepStructure }),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),
  // 替换规则导入 / 导出（.xlsx / .csv），label 用于区分「替换规则 / 重命名规则」的弹窗标题
  rulesExport: (rules, format, label) => ipcRenderer.invoke('rules-export', { rules, format, label }),
  rulesImport: (label) => ipcRenderer.invoke('rules-import', { label }),
  revealInFolder: (filePath) => ipcRenderer.invoke('reveal-in-folder', filePath),
  renameFiles: (files, rules, saveMode, outputDir) =>
    ipcRenderer.invoke('rename-files', { files, rules, saveMode, outputDir }),
  convertFiles: (files, srcFormat, dstFormat, saveMode, outputDir, baseDir, keepStructure) =>
    ipcRenderer.invoke('convert-files', { files, srcFormat, dstFormat, saveMode, outputDir, baseDir, keepStructure }),
  pdfEngineInfo: () => ipcRenderer.invoke('pdf-engine-info'),
  automationConvert: (templateKind, templateFolder, files, outputDir, layout) =>
    ipcRenderer.invoke('automation-convert', { templateKind, templateFolder, files, outputDir, layout }),
  automationCheck: (templateFolder, outputDir) =>
    ipcRenderer.invoke('automation-check', { templateFolder, outputDir }),
  pptSave: (files, saveMode, outputDir) =>
    ipcRenderer.invoke('ppt-save', { files, saveMode, outputDir }),
  skillsList: () => ipcRenderer.invoke('skills-list'),
  skillsDelete: (name) => ipcRenderer.invoke('skills-delete', name),
  skillsInstallMd: (name, content) => ipcRenderer.invoke('skills-install-md', { name, content }),
  skillsScanLocal: (srcDir) => ipcRenderer.invoke('skills-scan-local', srcDir),
  skillsSearchGithub: (keyword) => ipcRenderer.invoke('skills-search-github', keyword),
  skillsInstallGithub: (fullName, defaultBranch) => ipcRenderer.invoke('skills-install-github', { fullName, defaultBranch }),
  skillsListRecommended: () => ipcRenderer.invoke('skills-list-recommended'),
  skillsInstallRecommended: (name) => ipcRenderer.invoke('skills-install-recommended', name),
  onSkillInstallProgress: (cb) => ipcRenderer.on('skill-install-progress', (_e, info) => cb(info)),
  pdfAnalyzeWatermark: (files) => ipcRenderer.invoke('pdf-analyze-watermark', files),
  pdfRemoveWatermark: (files, watermarks, outputDir) =>
    ipcRenderer.invoke('pdf-remove-watermark', { files, watermarks, outputDir }),
  // AI 设置
  aiGetState: () => ipcRenderer.invoke('ai-get-state'),
  aiSaveProfile: (profile) => ipcRenderer.invoke('ai-save-profile', profile),
  aiDeleteProfile: (id) => ipcRenderer.invoke('ai-delete-profile', id),
  aiSetActive: (id, model) => ipcRenderer.invoke('ai-set-active', { id, model }),
  aiGetWebAccess: () => ipcRenderer.invoke('ai-get-web-access'),
  aiSetWebAccess: (enabled) => ipcRenderer.invoke('ai-set-web-access', enabled),
  aiGetMemoryEnabled: () => ipcRenderer.invoke('memory-enabled-get'),
  aiSetMemoryEnabled: (enabled) => ipcRenderer.invoke('memory-enabled-set', enabled),
  memoryGet: (scope, chatId) => ipcRenderer.invoke('memory-get', { scope, chatId }),
  memorySet: (scope, chatId, entries) => ipcRenderer.invoke('memory-set', { scope, chatId, entries }),
  memoryDelete: (scope, chatId, id) => ipcRenderer.invoke('memory-delete', { scope, chatId, id }),
  aiFetchModels: (profile) => ipcRenderer.invoke('ai-fetch-models', profile),
  aiTestConnection: (profile) => ipcRenderer.invoke('ai-test-connection', profile),
  aiVoiceConfigGet: () => ipcRenderer.invoke('ai-voice-config-get'),
  aiVoiceConfigSet: (cfg) => ipcRenderer.invoke('ai-voice-config-set', cfg),
  aiVoiceFetchVoices: (apiKey, baseUrl) => ipcRenderer.invoke('ai-voice-fetch-voices', { apiKey, baseUrl }),
  aiVoiceDefaultVoices: () => ipcRenderer.invoke('ai-voice-default-voices'),
  aiVoiceFetchModels: (apiKey, baseUrl) => ipcRenderer.invoke('ai-voice-fetch-models', { apiKey, baseUrl }),
  // 语音 TTS / STT 网络请求走主进程，绕过 CSP 限制
  aiVoiceTTS: (payload) => ipcRenderer.invoke('ai-voice-tts', payload),
  aiVoiceSTT: (payload) => ipcRenderer.invoke('ai-voice-stt', payload),
  // MCP 服务器
  mcpGet: () => ipcRenderer.invoke('mcp-get'),
  mcpSave: (server) => ipcRenderer.invoke('mcp-save', server),
  mcpDelete: (id) => ipcRenderer.invoke('mcp-delete', id),
  mcpRefresh: () => ipcRenderer.invoke('mcp-refresh'),
  mcpTest: (server) => ipcRenderer.invoke('mcp-test', server),
  onMcpStatusChanged: (cb) => ipcRenderer.on('mcp-status-changed', (_e, s) => cb(s)),
  // AI 助手（智能体对话）
  aiChat: (history, text, attachments) => ipcRenderer.invoke('ai-chat', { history, text, attachments }),
  // 聊天框「＋」选文件 / 文件夹发给 AI
  pickAttachments: () => ipcRenderer.invoke('pick-attachments'),
  // 剪贴板粘贴图片落临时文件，返回路径
  saveTempFile: (base64, ext) => ipcRenderer.invoke('save-temp-file', { base64, ext }),
  // 拖拽 / 粘贴得到的 File 对象取真实磁盘路径（Electron 32+ 移除了 File.path，须用 webUtils）
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  aiConfirmReply: (ok, remember) => ipcRenderer.invoke('ai-chat-confirm-reply', ok, remember),
  setPermissionMode: (mode) => ipcRenderer.invoke('set-permission-mode', mode),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('set-mcp-enabled', enabled),
  setMcpServer: (name) => ipcRenderer.invoke('set-mcp-server', name),
  setComputerUse: (enabled) => ipcRenderer.invoke('set-computer-use', enabled),
  openComputerUsePerms: () => ipcRenderer.invoke('open-computer-use-perms'),
  // 中断 Computer Use 当前在途操作（Esc / 停止按钮）
  computerUseAbort: () => ipcRenderer.invoke('computer-use-abort'),
  onComputerUseAborted: (cb) => ipcRenderer.on('computer-use-aborted', () => cb()),
  syncRules: (rules) => ipcRenderer.send('sync-rules', rules),
  // 文件自动化：编写规范预设
  automationGetPresets: () => ipcRenderer.invoke('automation-get-presets'),
  automationSavePresets: (presets) => ipcRenderer.invoke('automation-save-presets', presets),
  // 对话历史持久化
  chatLoad: () => ipcRenderer.invoke('chat-load'),
  chatSave: (chats, activeId) => ipcRenderer.invoke('chat-save', { chats, activeId }),
  onAiText: (cb) => ipcRenderer.on('ai-chat-text', (_e, t) => cb(t)),
  onAiToolStart: (cb) => ipcRenderer.on('ai-chat-tool-start', (_e, d) => cb(d)),
  onAiToolEnd: (cb) => ipcRenderer.on('ai-chat-tool-end', (_e, d) => cb(d)),
  onAiConfirm: (cb) => ipcRenderer.on('ai-chat-confirm', (_e, payload) => cb(payload)),
  onAiTodo: (cb) => ipcRenderer.on('ai-chat-todo', (_e, todos) => cb(todos)),
  onAiSubagentStart: (cb) => ipcRenderer.on('ai-chat-subagent-start', (_e, d) => cb(d)),
  onAiSubagentEnd: (cb) => ipcRenderer.on('ai-chat-subagent-end', (_e, d) => cb(d)),
  onAiCompact: (cb) => ipcRenderer.on('ai-chat-compact', () => cb()),
  onAiInstallSkill: (cb) => ipcRenderer.on('ai-chat-install-skill', (_e, info) => cb(info)),
  aiInstallSkillReply: (ok) => ipcRenderer.invoke('ai-chat-install-skill-reply', ok),
  onRulesChanged: (cb) => ipcRenderer.on('rules-changed', (_e, rules) => cb(rules)),
  // 自动更新
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: (manifest) => ipcRenderer.invoke('download-update', manifest),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, res) => cb(res)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateStage: (cb) => ipcRenderer.on('update-stage', (_e, s) => cb(s)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, m) => cb(m)),
  clearUpdateCache: () => ipcRenderer.invoke('clear-update-cache'),
  // Computer Use 光标遮罩事件
  cursorMove: (cb) => ipcRenderer.on('cursor-move', (_e, d) => cb(d)),
  cursorAction: (cb) => ipcRenderer.on('cursor-action', (_e, d) => cb(d)),
  cursorShow: (cb) => ipcRenderer.on('cursor-show', () => cb()),
  cursorHide: (cb) => ipcRenderer.on('cursor-hide', () => cb()),
});
