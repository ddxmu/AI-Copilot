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
  // 用系统默认程序打开文件（「工作完成」面板点「打开」）
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  // 读取文件信息（大小 / 修改时间 / 是否存在），用于「工作完成」面板
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  // 「工作完成」面板内联预览：按文件类型返回预览资源（PDF/图片/文本/Office→PDF/HTML/网页）
  previewFile: (filePath) => ipcRenderer.invoke('preview-file', filePath),
  // 读取「工作完成」面板持久化记录（app 重新打开后恢复）
  loadWorkItems: () => ipcRenderer.invoke('load-work-items'),
  // 保存「工作完成」面板记录到本地
  saveWorkItems: (items) => ipcRenderer.invoke('save-work-items', items),
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
  sessionEventsGet: () => ipcRenderer.invoke('session-events-get'),
  sessionEventsSet: (enabled) => ipcRenderer.invoke('session-events-set', enabled),
  sessionEventsPath: () => ipcRenderer.invoke('session-events-path'),
  sessionEventsClear: () => ipcRenderer.invoke('session-events-clear'),
  petGetConfig: () => ipcRenderer.invoke('pet-get-config'),
  petSetConfig: (patch) => ipcRenderer.invoke('pet-set-config', patch),
  petPickImage: () => ipcRenderer.invoke('pet-pick-image'),
  petShow: () => ipcRenderer.invoke('pet-show'),
  petHide: () => ipcRenderer.invoke('pet-hide'),
  skillsList: () => ipcRenderer.invoke('skills-list'),
  skillsDelete: (name) => ipcRenderer.invoke('skills-delete', name),
  skillsInstallMd: (name, content) => ipcRenderer.invoke('skills-install-md', { name, content }),
  skillsRead: (name) => ipcRenderer.invoke('skills-read', name),
  skillsSaveSelf: (payload) => ipcRenderer.invoke('skills-save-self', payload),
  skillsScanLocal: (srcDir) => ipcRenderer.invoke('skills-scan-local', srcDir),
  skillsSearchGithub: (keyword) => ipcRenderer.invoke('skills-search-github', keyword),
  skillsInstallGithub: (fullName, defaultBranch) => ipcRenderer.invoke('skills-install-github', { fullName, defaultBranch }),
  skillsListRecommended: () => ipcRenderer.invoke('skills-list-recommended'),
  skillsInstallRecommended: (name) => ipcRenderer.invoke('skills-install-recommended', name),
  skillsRunCheck: (name) => ipcRenderer.invoke('skills-run-check', name),
  skillsRunConfig: (name) => ipcRenderer.invoke('skills-run-config', name),
  skillsUninstallCli: (name) => ipcRenderer.invoke('skills-uninstall-cli', name),
  onSkillInstallProgress: (cb) => ipcRenderer.on('skill-install-progress', (_e, info) => cb(info)),
  onSkillsUpdated: (cb) => ipcRenderer.on('skills-updated', () => cb()),
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
  memoryClear: (scope, chatId) => ipcRenderer.invoke('memory-clear', { scope, chatId }),
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
  // opts: { runId, chatId } —— 并发下每个任务实例自带标识，事件回传时据此路由到对应会话
  aiChat: (history, text, attachments, opts) =>
    ipcRenderer.invoke('ai-chat', { history, text, attachments, runId: opts && opts.runId, chatId: opts && opts.chatId }),
  // 引导（steer）：把排队消息插进正在跑的任务，不中断当前轮
  aiChatSteer: (runId, text) => ipcRenderer.invoke('ai-chat-steer', { runId, text }),
  // 只停止指定任务实例（并发下不影响其他会话）
  aiChatAbortRun: (runId) => ipcRenderer.invoke('ai-chat-abort-run', { runId }),
  // 聊天框「＋」选文件 / 文件夹发给 AI
  pickAttachments: () => ipcRenderer.invoke('pick-attachments'),
  // 剪贴板粘贴图片落临时文件，返回路径
  saveTempFile: (base64, ext) => ipcRenderer.invoke('save-temp-file', { base64, ext }),
  // 渲染端按需读取本地图片缩略图
  readImageThumb: (filePath) => ipcRenderer.invoke('read-image-thumb', filePath),
  // 拖拽 / 粘贴得到的 File 对象取真实磁盘路径（Electron 32+ 移除了 File.path，须用 webUtils）
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  aiConfirmReply: (ok, remember, runId) => ipcRenderer.invoke('ai-chat-confirm-reply', ok, remember, runId),
  aiAskUserReply: (answer, runId) => ipcRenderer.invoke('ai-chat-ask-user-reply', answer, runId),
  mcpUpdateCheck: (serverId) => ipcRenderer.invoke('mcp-update-check', serverId),
  mcpUpdateInstall: (payload) => ipcRenderer.invoke('mcp-update-install', payload),
  onMcpUpdateProgress: (cb) => ipcRenderer.on('mcp-update-progress', (_e, d) => cb(d)),
  setPermissionMode: (mode) => ipcRenderer.invoke('set-permission-mode', mode),
  setMcpEnabled: (enabled) => ipcRenderer.invoke('set-mcp-enabled', enabled),
  setMcpServer: (name) => ipcRenderer.invoke('set-mcp-server', name),
  setComputerUse: (enabled) => ipcRenderer.invoke('set-computer-use', enabled),
  openComputerUsePerms: () => ipcRenderer.invoke('open-computer-use-perms'),
  // 已安装技能自动更新（GitHub 来源）开关
  aiGetSkillAutoUpdate: () => ipcRenderer.invoke('skill-auto-update-get'),
  aiSetSkillAutoUpdate: (enabled) => ipcRenderer.invoke('skill-auto-update-set', enabled),
  // 中断 Computer Use 当前在途操作（Esc / 停止按钮）
  computerUseAbort: () => ipcRenderer.invoke('computer-use-abort'),
  onComputerUseAborted: (cb) => ipcRenderer.on('computer-use-aborted', () => cb()),
  onModuleProgress: (cb) => ipcRenderer.on('module-progress', (_e, data) => cb(data)),
  syncRules: (rules) => ipcRenderer.send('sync-rules', rules),
  // 文件自动化：编写规范预设
  automationGetPresets: () => ipcRenderer.invoke('automation-get-presets'),
  automationSavePresets: (presets) => ipcRenderer.invoke('automation-save-presets', presets),
  // 对话历史持久化
  chatLoad: () => ipcRenderer.invoke('chat-load'),
  chatSave: (chats, activeId) => ipcRenderer.invoke('chat-save', { chats, activeId }),
  // 并发（v0.11.27）：所有 AI 事件第二参数为 meta = { runId, chatId }，
  // 渲染端据此判断这条事件属于哪个会话的任务（非当前会话只落库、不渲染）。
  onAiText: (cb) => ipcRenderer.on('ai-chat-text', (_e, t, meta) => cb(t, meta)),
  onAiReasoning: (cb) => ipcRenderer.on('ai-chat-reasoning', (_e, meta) => cb(meta)),
  onAiToolStart: (cb) => ipcRenderer.on('ai-chat-tool-start', (_e, d, meta) => cb(d, meta)),
  onAiToolEnd: (cb) => ipcRenderer.on('ai-chat-tool-end', (_e, d, meta) => cb(d, meta)),
  onAiConfirm: (cb) => ipcRenderer.on('ai-chat-confirm', (_e, payload, meta) => cb(payload, meta)),
  onAiAskUser: (cb) => ipcRenderer.on('ai-chat-ask-user', (_e, payload, meta) => cb(payload, meta)),
  onAiTodo: (cb) => ipcRenderer.on('ai-chat-todo', (_e, todos, meta) => cb(todos, meta)),
  onAiSubagentStart: (cb) => ipcRenderer.on('ai-chat-subagent-start', (_e, d, meta) => cb(d, meta)),
  onAiSubagentEnd: (cb) => ipcRenderer.on('ai-chat-subagent-end', (_e, d, meta) => cb(d, meta)),
  onAiCompact: (cb) => ipcRenderer.on('ai-chat-compact', (_e, meta) => cb(meta)),
  onAiInstallSkill: (cb) => ipcRenderer.on('ai-chat-install-skill', (_e, info, meta) => cb(info, meta)),
  onAiSteerAck: (cb) => ipcRenderer.on('ai-chat-steer-ack', (_e, d, meta) => cb(d, meta)),
  aiInstallSkillReply: (ok, runId) => ipcRenderer.invoke('ai-chat-install-skill-reply', ok, runId),
  onRulesChanged: (cb) => ipcRenderer.on('rules-changed', (_e, rules) => cb(rules)),
  // 自动更新
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: (manifest) => ipcRenderer.invoke('download-update', manifest),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, res) => cb(res)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (_e, p) => cb(p)),
  onUpdateStage: (cb) => ipcRenderer.on('update-stage', (_e, s) => cb(s)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, m) => cb(m)),
  clearUpdateCache: () => ipcRenderer.invoke('clear-update-cache'),
  // 自动化工作流（独立窗口，ComfyUI 风格节点画布）
  openWorkflowWindow: () => ipcRenderer.invoke('workflow-open'),
  workflowFlowsGet: () => ipcRenderer.invoke('workflow-flows-get'),
  workflowFlowsSave: (list) => ipcRenderer.invoke('workflow-flows-save', list),
  wfSelectFiles: () => ipcRenderer.invoke('wf-select-files'),
  wfSelectFolder: () => ipcRenderer.invoke('wf-select-folder'),
  wfSelectOutputDir: () => ipcRenderer.invoke('wf-select-output-dir'),
  wfSaveProjectFile: (payload) => ipcRenderer.invoke('wf-save-project-file', payload),
  wfOpenProjectFile: () => ipcRenderer.invoke('wf-open-project-file'),
  // 节点内的 AI 调用（一次性返回全文，不走聊天流式事件）
  wfAiRun: (payload) => ipcRenderer.invoke('wf-ai-run', payload),
  // 停止当前节点里正在跑的 AI 调用（带 runId）
  wfAiStop: (runId) => ipcRenderer.invoke('wf-ai-stop', { runId }),
  // 模块自定义节点：授权确认框 / AI 提问框的回执
  wfConfirmReply: (payload) => ipcRenderer.invoke('wf-confirm-reply', payload),
  wfAskUserReply: (payload) => ipcRenderer.invoke('wf-ask-user-reply', payload),
  // 模块自定义节点：把 AI 产出的文本写成文件
  wfWriteText: (payload) => ipcRenderer.invoke('wf-write-text', payload),
  onWfAiText: (cb) => ipcRenderer.on('wf-ai-text', (_e, t) => cb(t)),
  onWfConfirm: (cb) => ipcRenderer.on('wf-confirm', (_e, d) => cb(d)),
  onWfAskUser: (cb) => ipcRenderer.on('wf-ask-user', (_e, d) => cb(d)),
  // 定时任务（独立窗口）：任务持久化 + 立即运行
  openScheduleWindow: () => ipcRenderer.invoke('schedule-open'),
  scheduleTasksGet: () => ipcRenderer.invoke('schedule-tasks-get'),
  scheduleTasksSave: (tasks) => ipcRenderer.invoke('schedule-tasks-save', tasks),
  scheduleRunNow: (id) => ipcRenderer.invoke('schedule-run-now', { id }),
  onScheduleChanged: (cb) => ipcRenderer.on('schedule-changed', () => cb()),
  // Computer Use 光标遮罩事件
  cursorMove: (cb) => ipcRenderer.on('cursor-move', (_e, d) => cb(d)),
  cursorAction: (cb) => ipcRenderer.on('cursor-action', (_e, d) => cb(d)),
  cursorShow: (cb) => ipcRenderer.on('cursor-show', () => cb()),
  cursorHide: (cb) => ipcRenderer.on('cursor-hide', () => cb()),
});
