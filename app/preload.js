const { contextBridge, ipcRenderer } = require('electron');

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
  aiFetchModels: (profile) => ipcRenderer.invoke('ai-fetch-models', profile),
  aiTestConnection: (profile) => ipcRenderer.invoke('ai-test-connection', profile),
  // MCP 服务器
  mcpGet: () => ipcRenderer.invoke('mcp-get'),
  mcpSave: (server) => ipcRenderer.invoke('mcp-save', server),
  mcpDelete: (id) => ipcRenderer.invoke('mcp-delete', id),
  mcpRefresh: () => ipcRenderer.invoke('mcp-refresh'),
  mcpTest: (server) => ipcRenderer.invoke('mcp-test', server),
  onMcpStatusChanged: (cb) => ipcRenderer.on('mcp-status-changed', (_e, s) => cb(s)),
  // AI 助手（智能体对话）
  aiChat: (history, text) => ipcRenderer.invoke('ai-chat', { history, text }),
  aiConfirmReply: (ok, remember) => ipcRenderer.invoke('ai-chat-confirm-reply', ok, remember),
  setPermissionMode: (mode) => ipcRenderer.invoke('set-permission-mode', mode),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('set-mcp-enabled', enabled),
  setMcpServer: (name) => ipcRenderer.invoke('set-mcp-server', name),
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
});
