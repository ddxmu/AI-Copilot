/* ================= 状态 ================= */
// Office zip 类格式：AI 模式下分流给本地引擎处理
const OFFICE_ZIP_EXTS = new Set([
  'docx', 'docm', 'dotx', 'dotm',
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
  'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm',
]);

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i + 1).toLowerCase();
}

const state = {
  rules: [],          // [{id, name, find, replace, enabled}]
  sourceFolder: null, // 文件夹模式时的路径
  rawFiles: [],       // 扫描/选择得到的全部文件（未按类型过滤）
  exts: [],           // 支持的扩展名（从主进程获取）
  checkedExts: new Set(), // 勾选的扩展名
  filteredFiles: [],  // 当前待处理文件
};

let ruleSeq = 0;

/* ================= 左侧导航 ================= */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('disabled')) return;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    autoGrow(); // 切到面板后重新测量输入框高度（AI 面板隐藏时高度未被正确计算）
  });
});

/* ================= 模块一：替换规则 ================= */
const ruleNameInput = document.getElementById('rule-name');
const ruleFindInput = document.getElementById('rule-find');
const ruleReplaceInput = document.getElementById('rule-replace');
const ruleListEl = document.getElementById('rule-list');
const ruleEmptyEl = document.getElementById('rule-empty');
const ruleCountEl = document.getElementById('rule-count');

function renderRules() {
  ruleListEl.innerHTML = '';
  ruleEmptyEl.style.display = state.rules.length ? 'none' : 'block';
  ruleCountEl.textContent = state.rules.length;

  state.rules.forEach((rule) => {
    const li = document.createElement('li');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rule-enabled';
    cb.checked = rule.enabled;
    cb.title = '启用/停用该规则';
    cb.addEventListener('change', () => { rule.enabled = cb.checked; });

    const body = document.createElement('div');
    body.className = 'rule-body';
    const title = document.createElement('div');
    title.className = 'rule-title';
    title.textContent = rule.name;
    const detail = document.createElement('div');
    detail.className = 'rule-detail';
    const findSpan = document.createElement('span');
    findSpan.textContent = truncate(rule.find, 30);
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const repSpan = document.createElement('span');
    repSpan.textContent = truncate(rule.replace || '（删除）', 30);
    detail.append(findSpan, arrow, repSpan);
    body.append(title, detail);

    const del = document.createElement('button');
    del.className = 'rule-del';
    del.textContent = '✕';
    del.title = '删除规则';
    del.addEventListener('click', () => {
      state.rules = state.rules.filter((r) => r.id !== rule.id);
      renderRules();
    });

    li.append(cb, body, del);
    ruleListEl.appendChild(li);
  });
}

document.getElementById('btn-add-rule').addEventListener('click', () => {
  const find = ruleFindInput.value;
  if (!find) {
    ruleFindInput.focus();
    ruleFindInput.placeholder = '查找内容不能为空！';
    return;
  }
  const name = ruleNameInput.value.trim() || `规则 ${state.rules.length + 1}`;
  state.rules.push({
    id: ++ruleSeq,
    name,
    find,
    replace: ruleReplaceInput.value,
    enabled: true,
  });
  ruleNameInput.value = '';
  ruleFindInput.value = '';
  ruleReplaceInput.value = '';
  ruleFindInput.placeholder = '要查找的原文';
  renderRules();
});

function truncate(s, n) {
  const one = s.replace(/\n/g, '⏎');
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/* ================= 模块二：文件选择 ================= */
const sourceInfoEl = document.getElementById('source-info');
const extListEl = document.getElementById('ext-list');
const fileListEl = document.getElementById('file-list');
const fileEmptyEl = document.getElementById('file-empty');
const fileCountEl = document.getElementById('file-count');

async function initExts() {
  state.exts = await window.api.getSupportedExts();
  state.exts.forEach((ext) => state.checkedExts.add(ext));
  renderExts();
}

function renderExts() {
  extListEl.innerHTML = '';
  state.exts.forEach((ext) => {
    const chip = document.createElement('label');
    chip.className = 'ext-chip' + (state.checkedExts.has(ext) ? ' on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.checkedExts.has(ext);
    cb.addEventListener('change', async () => {
      if (cb.checked) state.checkedExts.add(ext);
      else state.checkedExts.delete(ext);
      chip.classList.toggle('on', cb.checked);
      await refilter();
    });
    chip.append(cb, document.createTextNode('.' + ext));
    extListEl.appendChild(chip);
  });
}

document.getElementById('btn-ext-all').addEventListener('click', async () => {
  state.exts.forEach((e) => state.checkedExts.add(e));
  renderExts();
  await refilter();
});
document.getElementById('btn-ext-none').addEventListener('click', async () => {
  state.checkedExts.clear();
  renderExts();
  await refilter();
});

document.getElementById('btn-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles();
  if (!files.length) return;
  state.sourceFolder = null;
  state.rawFiles = files;
  sourceInfoEl.textContent = `已选择 ${files.length} 个文件`;
  await refilter();
});

document.getElementById('btn-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  state.sourceFolder = folder;
  sourceInfoEl.textContent = '正在扫描：' + folder;
  // 扫描时传入当前勾选类型，减少无用结果
  state.rawFiles = await window.api.scanFolder(folder, [...state.checkedExts]);
  sourceInfoEl.textContent = `文件夹：${folder}（扫描到 ${state.rawFiles.length} 个文件）`;
  await refilter();
});

document.getElementById('btn-clear-files').addEventListener('click', () => {
  state.sourceFolder = null;
  state.rawFiles = [];
  state.filteredFiles = [];
  sourceInfoEl.textContent = '';
  renderFiles();
  hideResults();
});

// 类型勾选变化 / 来源变化后重新过滤
async function refilter() {
  state.filteredFiles = await window.api.filterFiles(state.rawFiles, [...state.checkedExts]);
  renderFiles();
  hideResults();
}

function renderFiles() {
  fileListEl.innerHTML = '';
  fileEmptyEl.style.display = state.filteredFiles.length ? 'none' : 'block';
  fileCountEl.textContent = state.filteredFiles.length;
  state.filteredFiles.forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    fileListEl.appendChild(li);
  });
}

/* ================= 向导导航 ================= */
let currentStep = 1;

function goToStep(n) {
  currentStep = n;
  document.querySelectorAll('.wizard-step').forEach((el) => el.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
  document.querySelectorAll('.stepper .step').forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle('current', s === n);
    el.classList.toggle('done', s < n);
    el.querySelector('.step-num').textContent = s < n ? '✓' : String(s);
  });
  clearStepMsg();
}

function clearStepMsg() {
  ['step1-msg', 'step2-msg', 'step3-msg'].forEach((id) => {
    document.getElementById(id).textContent = '';
  });
}

document.getElementById('btn-to-step2').addEventListener('click', () => {
  if (!state.filteredFiles.length) {
    document.getElementById('step1-msg').textContent = '请先选择要处理的文件';
    return;
  }
  goToStep(2);
});
document.getElementById('btn-back-step1').addEventListener('click', () => goToStep(1));
document.getElementById('btn-to-step3').addEventListener('click', () => {
  const active = state.rules.filter((r) => r.enabled && r.find);
  if (!active.length) {
    document.getElementById('step2-msg').textContent = '请至少添加并启用一条规则';
    return;
  }
  goToStep(3);
});
document.getElementById('btn-back-step2').addEventListener('click', () => goToStep(2));

/* ================= 保存方式 ================= */
const outputDirInput = document.getElementById('output-dir');
let outputDir = null;

function getSaveMode() {
  return document.querySelector('input[name="save-mode"]:checked').value;
}

document.querySelectorAll('input[name="save-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    document.getElementById('output-card').style.opacity = getSaveMode() === 'output' ? '1' : '0.45';
  });
});

document.getElementById('btn-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) {
    outputDir = dir;
    outputDirInput.value = dir;
  }
});
document.getElementById('btn-clear-output').addEventListener('click', () => {
  outputDir = null;
  outputDirInput.value = '';
  outputDirInput.placeholder = '尚未选择输出文件夹';
});

/* ================= 开始处理（含重要提示弹窗） ================= */
const noticeModal = document.getElementById('notice-modal');

document.getElementById('btn-start').addEventListener('click', () => {
  if (getSaveMode() === 'output' && !outputDir) {
    document.getElementById('step3-msg').textContent = '请先选择输出文件夹';
    return;
  }
  noticeModal.classList.remove('hidden');
});
document.getElementById('btn-notice-cancel').addEventListener('click', () => {
  noticeModal.classList.add('hidden');
});
document.getElementById('btn-notice-go').addEventListener('click', async () => {
  noticeModal.classList.add('hidden');
  if (document.getElementById('ai-assist-toggle').checked) {
    await executeReplaceByAI();
  } else {
    await executeReplace();
  }
});

async function executeReplace() {
  const activeRules = state.rules.filter((r) => r.enabled && r.find);
  const saveMode = getSaveMode();
  const keepStructure = document.getElementById('keep-structure').checked;
  document.getElementById('step3-msg').textContent = '';
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-start').textContent = '处理中…';
  const { results, summary } = await window.api.runReplace(
    state.filteredFiles, activeRules, saveMode, outputDir, state.sourceFolder, keepStructure
  );
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-start').textContent = '▶ 开始处理';
  showResults(results, summary);
}

// AI 助手替换：自动分流——Office 文件走本地引擎，文本文件走 AI 智能体
async function executeReplaceByAI() {
  const activeRules = state.rules.filter((r) => r.enabled && r.find);
  const saveMode = getSaveMode();
  const keepStructure = document.getElementById('keep-structure').checked;

  // 分流
  const officeFiles = state.filteredFiles.filter((f) => OFFICE_ZIP_EXTS.has(extOf(f)));
  const textFiles = state.filteredFiles.filter((f) => !OFFICE_ZIP_EXTS.has(extOf(f)));

  // 有文本文件要 AI 处理时才校验 AI 配置
  if (textFiles.length && !(aiState.profiles.length && aiState.activeId)) {
    document.getElementById('step3-msg').textContent = '请先在「AI 设置」中配置并启用一个模型，或关闭 AI 助手替换';
    return;
  }

  // 切到 AI 助手面板，展示执行过程
  switchPanel('ai');
  setSending(true);

  // ① Office 文件走本地引擎
  let officeSummary = null;
  if (officeFiles.length) {
    addBubble('assistant', `检测到 ${officeFiles.length} 个 Office 文件（docx/pptx/xlsx 等），由本地替换引擎处理…`);
    const { summary } = await window.api.runReplace(
      officeFiles, activeRules, saveMode, outputDir, state.sourceFolder, keepStructure
    );
    officeSummary = summary;
    addBubble('assistant', `Office 文件处理完成：共 ${summary.total} 个，成功替换 ${summary.done} 个，累计替换 ${summary.replaced} 处。`);
  }

  // ② 文本文件走 AI 智能体
  if (textFiles.length) {
    const saveDesc = saveMode === 'output'
      ? `替换后输出到目录 ${outputDir}，原文件不要改动。调用 batch_replace 时传 output_dir="${outputDir}"${state.sourceFolder ? `、base_dir="${state.sourceFolder}"（保持目录结构）` : ''}。`
      : '直接覆盖原文件（不传 output_dir）。';
    const rulesDesc = activeRules.map((r, i) => `${i + 1}. 把「${r.find}」替换成「${r.replace}」`).join('\n');
    const fileList = textFiles.slice(0, 300).join('\n');
    const prompt =
      `请对以下 ${textFiles.length} 个文件执行批量文本替换。\n\n` +
      `替换规则：\n${rulesDesc}\n\n` +
      `保存方式：${saveDesc}\n\n` +
      `文件列表：\n${fileList}\n\n` +
      `请用 batch_replace 工具执行，完成后简要汇报处理结果。`;

    ensureActiveChat();
    addBubble('user', `【按规则替换】AI 处理 ${textFiles.length} 个文本文件（${activeRules.length} 条规则）`);
    chatHistory.push({ role: 'user', content: prompt });
    currentAssistantBubble = null;
    chatStatusEl.textContent = 'AI 正在执行替换…';

    const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);

    chatStatusEl.textContent = '';
    if (!r.ok) {
      addBubble('assistant', '出错了：' + (r.error || '未知错误'));
    } else {
      const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
      const last = bubbles[bubbles.length - 1];
      chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
      if (r.usage) {
        sessionUsage.input += r.usage.input;
        sessionUsage.output += r.usage.output;
        chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
      }
    }
    currentAssistantBubble = null;
  } else if (officeSummary) {
    addBubble('assistant', '全部文件均为 Office 格式，已由本地引擎处理完毕。');
  }

  setSending(false);
  persistCurrentChat();
  saveChats();
}// 切换左侧模块（供 AI 替换跳转用）
function switchPanel(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const btn = document.querySelector(`.nav-item[data-panel="${name}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('panel-' + name).classList.add('active');
  autoGrow(); // 面板切换后重新测量输入框高度
}

const resultCard = document.getElementById('result-card');
const resultSummaryEl = document.getElementById('result-summary');
const resultListEl = document.getElementById('result-list');

function showResults(results, summary) {
  resultCard.classList.remove('hidden');
  resultSummaryEl.textContent =
    `共 ${summary.total} 个文件，成功替换 ${summary.done} 个，累计替换 ${summary.replaced} 处。`;
  resultListEl.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + r.status;
    const label = { done: '✔', skipped: '⊘', error: '✖', nochange: '—' }[r.status] || '';
    tag.textContent = label + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    resultListEl.appendChild(li);
  });
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideResults() {
  resultCard.classList.add('hidden');
}

/* ================= AI 设置 ================= */
// 内置厂商：id / 显示名 / 接口类型 / 默认地址（均走 OpenAI 兼容或 Anthropic 协议）
const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic（Claude）', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'minimax', name: 'MiniMax', type: 'openai', baseUrl: 'https://api.minimaxi.com/v1' },
  { id: 'moonshot', name: 'Moonshot（Kimi）', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', name: '智谱（GLM）', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'qwen', name: '通义千问（Qwen）', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'doubao', name: '豆包（火山引擎）', type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'custom', name: '自定义…', type: 'openai', baseUrl: '' },
];

// 已知的模型价格（美元 / 百万 token，input + output），仅作展示参考
const MODEL_PRICES = {
  'claude-opus-4': [15, 75], 'claude-sonnet-4': [3, 15], 'claude-haiku-3.5': [0.8, 4],
  'claude-3-5-sonnet': [3, 15], 'claude-3-5-haiku': [0.8, 4], 'claude-3-opus': [15, 75],
  'deepseek-chat': [0.27, 1.1], 'deepseek-reasoner': [0.55, 2.19],
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6],
  'MiniMax-M2': [0.3, 1.2], 'abab6.5s-chat': [0.14, 0.14],
};

function findPrice(modelId) {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  for (const key of Object.keys(MODEL_PRICES)) {
    if (id.includes(key.toLowerCase())) return MODEL_PRICES[key];
  }
  return null;
}

const aiState = { profiles: [], activeId: null };
let editingId = null;           // 正在编辑的配置 id（null = 新增）
let cachedKey = '';             // 编辑时保留的原 Key

const editorEl = document.getElementById('profile-editor');
const providerSel = document.getElementById('p-provider');
const baseUrlInput = document.getElementById('p-baseurl');
const apiKeyInput = document.getElementById('p-apikey');
const keyHint = document.getElementById('key-hint');
const modelSel = document.getElementById('p-model');
const fetchStatusEl = document.getElementById('fetch-status');
const modelPriceEl = document.getElementById('model-price');

// 初始化厂商下拉
PROVIDERS.forEach((p) => {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.name;
  providerSel.appendChild(opt);
});

providerSel.addEventListener('change', () => {
  const p = PROVIDERS.find((x) => x.id === providerSel.value);
  baseUrlInput.value = p.baseUrl;
  baseUrlInput.readOnly = false;
  baseUrlInput.placeholder = p.id === 'custom' ? '填写你的 API 地址，如 https://xxx.com/v1' : p.baseUrl;
});

function setFetchStatus(text, cls) {
  fetchStatusEl.textContent = text;
  fetchStatusEl.className = 'fetch-status ' + (cls || '');
}

function currentProfileDraft() {
  const p = PROVIDERS.find((x) => x.id === providerSel.value);
  return {
    id: editingId || 'p' + Date.now(),
    provider: p.id,
    providerName: p.name,
    type: p.type,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value || cachedKey,
    model: modelSel.value,
  };
}

// 拉取模型列表
document.getElementById('btn-fetch-models').addEventListener('click', async () => {
  const draft = currentProfileDraft();
  if (!draft.baseUrl) { setFetchStatus('请先填写模型地址', 'err'); return; }
  if (!draft.apiKey) { setFetchStatus('请先填写 API Key', 'err'); return; }
  setFetchStatus('正在拉取模型列表…', 'loading');
  const r = await window.api.aiFetchModels(draft);
  if (!r.ok) { setFetchStatus('拉取失败：' + r.error, 'err'); return; }
  modelSel.innerHTML = '';
  r.models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    modelSel.appendChild(opt);
  });
  if (draft.model && r.models.some((m) => m.id === draft.model)) modelSel.value = draft.model;
  setFetchStatus(`拉取成功，共 ${r.models.length} 个模型，请选择要使用的模型。`, 'ok');
  updatePrice();
});

document.getElementById('btn-test-conn').addEventListener('click', async () => {
  const draft = currentProfileDraft();
  setFetchStatus('正在测试连接…', 'loading');
  const r = await window.api.aiTestConnection(draft);
  setFetchStatus(r.ok ? `连接成功（获取到 ${r.count} 个模型）` : '连接失败：' + r.error, r.ok ? 'ok' : 'err');
});

modelSel.addEventListener('change', updatePrice);

function updatePrice() {
  const price = findPrice(modelSel.value);
  if (price) {
    modelPriceEl.innerHTML =
      `<span class="price-tag">输入 $${price[0]}/M tokens</span><span class="price-tag">输出 $${price[1]}/M tokens</span>（参考价，以厂商实际计费为准）`;
  } else {
    modelPriceEl.textContent = modelSel.value ? '该模型暂无参考价格。' : '';
  }
}

// 保存
document.getElementById('btn-save-profile').addEventListener('click', async () => {
  const draft = currentProfileDraft();
  if (!draft.baseUrl) { setFetchStatus('模型地址不能为空', 'err'); return; }
  if (!draft.apiKey) { setFetchStatus('API Key 不能为空', 'err'); return; }
  const state = await window.api.aiSaveProfile(draft);
  aiState.profiles = state.profiles;
  aiState.activeId = state.activeId;
  closeEditor();
  renderProfiles();
});

document.getElementById('btn-cancel-edit').addEventListener('click', closeEditor);

document.getElementById('btn-new-profile').addEventListener('click', () => openEditor(null));

function openEditor(profile) {
  editingId = profile ? profile.id : null;
  cachedKey = profile ? profile.apiKey : '';
  document.getElementById('editor-title').textContent = profile ? '编辑配置' : '新增配置';
  providerSel.value = profile ? profile.provider : 'anthropic';
  providerSel.dispatchEvent(new Event('change'));
  if (profile) {
    baseUrlInput.value = profile.baseUrl;
    modelSel.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = profile.model;
    opt.textContent = profile.model;
    modelSel.appendChild(opt);
    modelSel.value = profile.model;
  } else {
    modelSel.innerHTML = '<option value="">（先拉取模型）</option>';
  }
  apiKeyInput.value = '';
  keyHint.classList.toggle('hidden', !profile);
  setFetchStatus('', '');
  updatePrice();
  editorEl.classList.remove('hidden');
  editorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEditor() {
  editorEl.classList.add('hidden');
  editingId = null;
  cachedKey = '';
}

// 配置列表渲染
const profileListEl = document.getElementById('profile-list');
const profileEmptyEl = document.getElementById('profile-empty');
const profileCountEl = document.getElementById('profile-count');
const activeProfileSel = document.getElementById('active-profile');

function renderProfiles() {
  profileListEl.innerHTML = '';
  profileEmptyEl.style.display = aiState.profiles.length ? 'none' : 'block';
  profileCountEl.textContent = aiState.profiles.length;

  // 当前使用下拉
  activeProfileSel.innerHTML = '';
  if (!aiState.profiles.length) {
    activeProfileSel.innerHTML = '<option value="">（无配置）</option>';
  }
  aiState.profiles.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.providerName} — ${p.model || '未选模型'}`;
    activeProfileSel.appendChild(opt);
  });
  activeProfileSel.value = aiState.activeId || '';

  aiState.profiles.forEach((p) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'profile-main';
    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = p.providerName;
    if (p.id === aiState.activeId) {
      const tag = document.createElement('span');
      tag.className = 'active-tag';
      tag.textContent = '使用中';
      name.appendChild(tag);
    }
    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = `${p.model || '未选模型'} · ${p.baseUrl}`;
    main.append(name, sub);

    const ops = document.createElement('div');
    ops.className = 'profile-ops';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => openEditor(p));
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.className = 'del';
    delBtn.addEventListener('click', async () => {
      const state = await window.api.aiDeleteProfile(p.id);
      aiState.profiles = state.profiles;
      aiState.activeId = state.activeId;
      renderProfiles();
    });
    ops.append(editBtn, delBtn);
    li.append(main, ops);
    profileListEl.appendChild(li);
  });
  updateModelInfo();
}

activeProfileSel.addEventListener('change', async () => {
  if (!activeProfileSel.value) return;
  const state = await window.api.aiSetActive(activeProfileSel.value, null);
  aiState.activeId = state.activeId;
  renderProfiles();
});

async function initAiSettings() {
  const state = await window.api.aiGetState();
  aiState.profiles = state.profiles;
  aiState.activeId = state.activeId;
  renderProfiles();
  // 联网开关
  const webToggle = document.getElementById('web-access-toggle');
  const webBadge = document.getElementById('web-badge');
  if (webToggle) {
    webToggle.checked = await window.api.aiGetWebAccess();
    if (webBadge) webBadge.classList.toggle('hidden', !webToggle.checked);
    webToggle.addEventListener('change', async () => {
      await window.api.aiSetWebAccess(webToggle.checked);
      if (webBadge) webBadge.classList.toggle('hidden', !webToggle.checked);
    });
  }
  initMcpSettings();
}

/* ================= MCP 服务器配置 ================= */
const mcpState = { servers: [], status: [], editing: null };

// MCP 市场模板：用户选择后自动填充启动命令，只需填必要参数
const MCP_MARKET_TEMPLATES = [
  {
    id: 'fetch',
    name: 'Fetch',
    category: '常用',
    icon: '🌐',
    desc: '让 AI 助手获取任意网页内容（社区 Node 实现 mcp-fetch）。无需 API Key，首次运行会自动下载依赖。',
    command: 'npx',
    args: ['-y', 'mcp-fetch'],
    env: {},
    params: []
  },
  {
    id: 'filesystem',
    name: '文件系统',
    category: '常用',
    icon: '📁',
    desc: '让 AI 助手读取、写入指定目录下的文件。请填入允许访问的目录。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{{path}}'],
    env: {},
    params: [
      { key: 'path', label: '允许访问的目录', placeholder: '/Users/你的用户名/Documents', required: true, type: 'dir' }
    ]
  },
  {
    id: 'github',
    name: 'GitHub',
    category: '开发',
    icon: '🐙',
    desc: '查询仓库、Issue、PR，读写文件，执行 GitHub 自动化操作。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '{{token}}' },
    params: [
      { key: 'token', label: 'GitHub Personal Access Token', placeholder: 'ghp_...', required: true, type: 'password' }
    ]
  },
  {
    id: 'brave-search',
    name: 'Brave 搜索',
    category: '搜索',
    icon: '🔍',
    desc: '让 AI 助手使用 Brave Search API 搜索互联网。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '{{key}}' },
    params: [
      { key: 'key', label: 'Brave API Key', placeholder: 'BS...', required: true, type: 'password' }
    ]
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    category: '数据库',
    icon: '🗄️',
    desc: '让 AI 助手查询本地 SQLite 数据库。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '{{dbPath}}'],
    env: {},
    params: [
      { key: 'dbPath', label: '数据库文件路径', placeholder: '/Users/.../data.db', required: true }
    ]
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: '数据库',
    icon: '🐘',
    desc: '让 AI 助手查询 PostgreSQL 数据库。',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '{{connectionUrl}}'],
    env: {},
    params: [
      { key: 'connectionUrl', label: '数据库连接字符串', placeholder: 'postgresql://user:pass@localhost/db', required: true, type: 'password' }
    ]
  },
  {
    id: 'github-bailian',
    name: 'GitHub（阿里云百炼）',
    category: '开发',
    icon: '🐙',
    transport: 'sse',
    desc: '通过阿里云百炼托管的 GitHub MCP 服务连接 GitHub，无需本地运行 npx，只需填写阿里云 DashScope API Key。',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1/mcps/gitHub/sse',
    headers: { Authorization: 'Bearer ${DASHSCOPE_API_KEY}' },
    env: {},
    params: [
      { key: 'DASHSCOPE_API_KEY', label: 'DashScope API Key', placeholder: 'sk-...', required: true, type: 'password' }
    ]
  }
];

let mcpMarketSelected = null;

function $m(id) { return document.getElementById(id); }

function mcpStatusMeta(st) {
  switch (st) {
    case 'ready': return { text: '已连接', cls: 'ok' };
    case 'connecting': return { text: '连接中…', cls: 'wait' };
    case 'error': return { text: '连接失败', cls: 'err' };
    case 'disabled': return { text: '已禁用', cls: 'off' };
    case 'stopped': return { text: '已停止', cls: 'off' };
    default: return { text: '未连接', cls: 'off' };
  }
}

function renderMcpList() {
  const listEl = $m('mcp-list');
  const emptyEl = $m('mcp-empty');
  const countEl = $m('mcp-count');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (emptyEl) emptyEl.style.display = mcpState.servers.length ? 'none' : 'block';
  if (countEl) countEl.textContent = mcpState.servers.length;

  mcpState.servers.forEach((s) => {
    const st = mcpState.status.find((x) => x.id === s.id || x.name === s.name) || {};
    const meta = mcpStatusMeta(s.enabled === false ? 'disabled' : (st.status || 'idle'));

    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'profile-main';

    const name = document.createElement('div');
    name.className = 'profile-name';
    name.textContent = s.name;
    const dot = document.createElement('span');
    dot.className = 'mcp-status ' + meta.cls;
    dot.textContent = meta.text + (st.toolCount ? ` · ${st.toolCount} 个工具` : '');
    name.appendChild(dot);

    const sub = document.createElement('div');
    sub.className = 'profile-sub';
    sub.textContent = (s.transport === 'sse' ? (s.baseUrl || '') : `${s.command} ${(s.args || []).join(' ')}`).trim().slice(0, 120);
    main.append(name, sub);

    if (st.status === 'error' && st.error) {
      const err = document.createElement('div');
      err.className = 'mcp-error';
      err.textContent = String(st.error).slice(0, 300);
      main.appendChild(err);
    } else if (st.tools && st.tools.length) {
      const tools = document.createElement('div');
      tools.className = 'mcp-tools';
      tools.textContent = '工具：' + st.tools.map((t) => t.name).join('、').slice(0, 240);
      main.appendChild(tools);
    }

    const ops = document.createElement('div');
    ops.className = 'profile-ops';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => openMcpEditor(s));
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.className = 'del';
    delBtn.addEventListener('click', async () => {
      const r = await window.api.mcpDelete(s.id);
      if (r.ok) { mcpState.servers = r.servers; mcpState.status = r.status; renderMcpList(); }
    });
    ops.append(editBtn, delBtn);
    li.append(main, ops);
    listEl.appendChild(li);
  });
}

function toggleMcpTransport() {
  const t = $m('m-transport').value;
  $m('m-stdio-fields').classList.toggle('hidden', t !== 'stdio');
  $m('m-sse-fields').classList.toggle('hidden', t !== 'sse');
}

function openMcpEditor(server) {
  mcpState.editing = server || null;
  const box = $m('mcp-editor');
  if (!box) return;
  $m('mcp-json-editor').classList.add('hidden');
  box.classList.remove('hidden');
  $m('mcp-editor-title').textContent = server ? `编辑：${server.name}` : '新增 MCP 服务器';
  $m('m-name').value = server ? server.name : '';
  const isSse = server && server.transport === 'sse';
  $m('m-transport').value = isSse ? 'sse' : 'stdio';
  $m('m-command').value = !isSse && server ? (server.command || '') : '';
  $m('m-args').value = !isSse && server ? (server.args || []).join('\n') : '';
  $m('m-cwd').value = !isSse && server ? (server.cwd || '') : '';
  $m('m-baseurl').value = isSse ? (server.baseUrl || '') : '';
  $m('m-headers').value = isSse
    ? Object.entries(server.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';
  $m('m-env').value = server
    ? Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`).join('\n')
    : '';
  $m('m-enabled').checked = server ? server.enabled !== false : true;
  $m('mcp-test-status').textContent = '';
  toggleMcpTransport();
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function collectMcpForm() {
  const transport = $m('m-transport').value;
  const name = $m('m-name').value.trim();
  const env = $m('m-env').value;
  const enabled = $m('m-enabled').checked;
  const id = mcpState.editing ? mcpState.editing.id : undefined;
  if (transport === 'sse') {
    const headers = {};
    $m('m-headers').value.split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const i = t.indexOf(':');
      if (i > 0) headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    return { id, name, transport: 'sse', baseUrl: $m('m-baseurl').value.trim(), headers, env, enabled };
  }
  return {
    id, name, transport: 'stdio',
    command: $m('m-command').value.trim(),
    args: $m('m-args').value,
    env,
    cwd: $m('m-cwd').value.trim(),
    enabled,
  };
}

async function refreshMcpState() {
  try {
    const r = await window.api.mcpGet();
    mcpState.servers = r.servers || [];
    mcpState.status = r.status || [];
    renderMcpList();
  } catch (e) { /* ignore */ }
}

function interpolateMcpTemplate(str, values) {
  return String(str).replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? '');
}

function renderMcpMarketList(filter = '', category = '') {
  const listEl = $m('mcp-market-list');
  if (!listEl) return;
  const term = filter.trim().toLowerCase();
  const items = MCP_MARKET_TEMPLATES.filter((t) => {
    if (category && t.category !== category) return false;
    if (!term) return true;
    return (t.name + t.desc + t.category).toLowerCase().includes(term);
  });
  listEl.innerHTML = '';
  if (!items.length) {
    listEl.innerHTML = '<p class="empty">未找到匹配的服务器模板</p>';
    return;
  }
  items.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'mcp-market-card';
    card.innerHTML = `
      <div class="mcp-market-card-head">
        <span class="mcp-market-icon">${t.icon}</span>
        <div>
          <div class="mcp-market-name">${t.name}</div>
          <div class="mcp-market-category">${t.category}</div>
        </div>
      </div>
      <div class="mcp-market-desc">${t.desc}</div>
      <div class="mcp-market-cmd">${t.transport === 'sse' ? '🌐 远程 SSE：' + (t.baseUrl || '') : t.command + ' ' + t.args.join(' ').replace(/\{\{([^}]+)\}\}/g, '<$1>')}</div>
      <button class="btn small mcp-market-add" data-id="${t.id}">配置并添加</button>
    `;
    card.querySelector('.mcp-market-add').addEventListener('click', () => selectMcpMarketTemplate(t));
    listEl.appendChild(card);
  });
}

function selectMcpMarketTemplate(template) {
  mcpMarketSelected = template;
  const paramsBox = $m('mcp-market-params');
  const title = $m('mcp-market-params-title');
  const body = $m('mcp-market-params-body');
  const status = $m('mcp-market-status');
  if (!paramsBox) return;
  title.textContent = `配置：${template.icon} ${template.name}`;
  status.textContent = '';
  body.innerHTML = '';

  if (!template.params || !template.params.length) {
    body.innerHTML = '<p class="hint">该服务器无需额外参数，点击「添加并连接」即可。</p>';
  } else {
    template.params.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'form-cell';
      row.style.marginBottom = '12px';
      const isDir = p.type === 'dir';
      const inputType = p.type === 'password' ? 'password' : 'text';
      row.innerHTML = `
        <label>${p.label}${p.required ? ' <span style="color:#e74c3c">*</span>' : ''}</label>
        <div class="param-input-row">
          <input id="mcp-market-param-${p.key}" type="${inputType}" placeholder="${p.placeholder || ''}" />
          ${isDir ? '<button type="button" class="btn small mcp-browse-dir" data-key="' + p.key + '">浏览…</button>' : ''}
        </div>
      `;
      body.appendChild(row);
    });
    // 绑定目录浏览按钮
    body.querySelectorAll('.mcp-browse-dir').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-key');
        const picked = await window.api.selectFolder();
        if (picked) {
          const el = $m(`mcp-market-param-${key}`);
          if (el) el.value = picked;
        }
      });
    });
  }
  paramsBox.classList.remove('hidden');
  paramsBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function addMcpMarketTemplate() {
  const template = mcpMarketSelected;
  const status = $m('mcp-market-status');
  if (!template) { status.textContent = '请先选择一个模板'; status.className = 'fetch-status err'; return; }

  const values = {};
  for (const p of (template.params || [])) {
    const el = $m(`mcp-market-param-${p.key}`);
    const v = el ? el.value.trim() : '';
    if (p.required && !v) { status.textContent = `请填写 ${p.label}`; status.className = 'fetch-status err'; return; }
    values[p.key] = v;
  }

  const name = template.id;
  const exist = mcpState.servers.find((s) => s.name === name);

  let cfg;
  if (template.transport === 'sse') {
    cfg = {
      id: exist ? exist.id : undefined,
      name,
      transport: 'sse',
      baseUrl: template.baseUrl || '',
      headers: template.headers || {},
      // SSE 用 env 承载 ${KEY} 占位符的真实值（如 API Key）
      env: Object.fromEntries((template.params || []).map((p) => [p.key, values[p.key] || ''])),
      enabled: true,
    };
  } else {
    cfg = {
      id: exist ? exist.id : undefined,
      name,
      transport: 'stdio',
      command: template.command,
      args: (template.args || []).map((a) => interpolateMcpTemplate(a, values)),
      env: Object.fromEntries(Object.entries(template.env || {}).map(([k, v]) => [k, interpolateMcpTemplate(v, values)])),
      cwd: '',
      enabled: true,
    };
  }

  status.textContent = '正在保存并连接…';
  status.className = 'fetch-status';
  const r = await window.api.mcpSave(cfg);
  if (r.ok) {
    await refreshMcpState();
    status.className = 'fetch-status ok';
    status.textContent = '已添加并连接';
    $m('mcp-market-params').classList.add('hidden');
    mcpMarketSelected = null;
  } else {
    status.className = 'fetch-status err';
    status.textContent = '添加失败：' + r.error;
  }
}

function openMcpMarket() {
  $m('mcp-editor').classList.add('hidden');
  $m('mcp-json-editor').classList.add('hidden');
  $m('mcp-market').classList.remove('hidden');
  $m('mcp-market-search').value = '';
  $m('mcp-market-category').value = '';
  $m('mcp-market-params').classList.add('hidden');
  mcpMarketSelected = null;
  renderMcpMarketList();
  $m('mcp-market').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeMcpMarket() {
  $m('mcp-market').classList.add('hidden');
  $m('mcp-market-params').classList.add('hidden');
  mcpMarketSelected = null;
}

function initMcpSettings() {
  if (!$m('mcp-list')) return;
  refreshMcpState();

  $m('btn-new-mcp').addEventListener('click', () => openMcpEditor(null));
  $m('btn-mcp-cancel').addEventListener('click', () => $m('mcp-editor').classList.add('hidden'));
  $m('btn-mcp-browse-cwd').addEventListener('click', async () => {
    const picked = await window.api.selectFolder();
    if (picked) $m('m-cwd').value = picked;
  });
  $m('m-transport').addEventListener('change', toggleMcpTransport);

  // MCP 市场
  $m('btn-mcp-market').addEventListener('click', openMcpMarket);
  $m('btn-mcp-market-cancel').addEventListener('click', closeMcpMarket);
  $m('btn-mcp-market-params-cancel').addEventListener('click', () => {
    $m('mcp-market-params').classList.add('hidden');
    mcpMarketSelected = null;
  });
  $m('btn-mcp-market-add').addEventListener('click', addMcpMarketTemplate);
  $m('mcp-market-search').addEventListener('input', (e) => {
    renderMcpMarketList(e.target.value, $m('mcp-market-category').value);
  });
  $m('mcp-market-category').addEventListener('change', (e) => {
    renderMcpMarketList($m('mcp-market-search').value, e.target.value);
  });

  $m('btn-mcp-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '连接中…';
    const r = await window.api.mcpRefresh();
    if (r.ok) mcpState.status = r.status;
    renderMcpList();
    btn.disabled = false; btn.textContent = '↻ 重新连接';
  });

  $m('btn-mcp-test').addEventListener('click', async () => {
    const cfg = collectMcpForm();
    const status = $m('mcp-test-status');
    if (cfg.transport === 'sse') {
      if (!cfg.baseUrl) { status.textContent = '请先填写服务地址'; status.className = 'fetch-status err'; return; }
    } else if (!cfg.command) {
      status.textContent = '请先填写启动命令'; status.className = 'fetch-status err'; return;
    }
    status.textContent = '正在连接并握手，请稍候…';
    status.className = 'fetch-status';
    const r = await window.api.mcpTest(cfg);
    if (r.ok) {
      status.className = 'fetch-status ok';
      status.textContent = `连接成功，发现 ${r.toolCount} 个工具：` +
        r.tools.map((t) => t.name).join('、').slice(0, 200);
    } else {
      status.className = 'fetch-status err';
      status.textContent = '连接失败：' + r.error;
    }
  });

  $m('btn-mcp-save').addEventListener('click', async () => {
    const cfg = collectMcpForm();
    const status = $m('mcp-test-status');
    if (!cfg.name) { status.textContent = '请填写服务器名称'; status.className = 'fetch-status err'; return; }
    if (cfg.transport === 'sse') {
      if (!cfg.baseUrl) { status.textContent = '请填写服务地址'; status.className = 'fetch-status err'; return; }
    } else if (!cfg.command) {
      status.textContent = '请填写启动命令'; status.className = 'fetch-status err'; return;
    }
    status.textContent = '保存并连接中…';
    status.className = 'fetch-status';
    const r = await window.api.mcpSave(cfg);
    if (r.ok) {
      await refreshMcpState();
      $m('mcp-editor').classList.add('hidden');
    } else {
      status.className = 'fetch-status err';
      status.textContent = '保存失败：' + r.error;
    }
  });

  // JSON 导入
  $m('btn-mcp-json').addEventListener('click', () => {
    $m('mcp-editor').classList.add('hidden');
    $m('mcp-json-editor').classList.remove('hidden');
    $m('mcp-json-status').textContent = '';
  });
  $m('btn-mcp-json-cancel').addEventListener('click', () => $m('mcp-json-editor').classList.add('hidden'));
  $m('btn-mcp-json-save').addEventListener('click', async () => {
    const status = $m('mcp-json-status');
    let data;
    try { data = JSON.parse($m('m-json').value); }
    catch (e) { status.className = 'fetch-status err'; status.textContent = 'JSON 解析失败：' + e.message; return; }
    const map = data.mcpServers || data;
    const entries = Object.entries(map).filter(([, v]) => v && typeof v === 'object');
    if (!entries.length) { status.className = 'fetch-status err'; status.textContent = '未找到有效的服务器配置'; return; }
    status.className = 'fetch-status';
    status.textContent = '导入中…';
    let ok = 0;
    for (const [name, v] of entries) {
      const exist = mcpState.servers.find((s) => s.name === name);
      // 直接把 Cherry Studio / Claude Desktop 的字段透传，由 normalizeMcpServer 判断 stdio / sse
      const r = await window.api.mcpSave({
        ...v,
        id: exist ? exist.id : undefined,
        name,
        enabled: v.isActive !== false && v.enabled !== false,
      });
      if (r.ok) ok++;
    }
    await refreshMcpState();
    status.className = 'fetch-status ok';
    status.textContent = `已导入 ${ok}/${entries.length} 个服务器`;
    if (ok === entries.length) $m('mcp-json-editor').classList.add('hidden');
  });

  if (window.api.onMcpStatusChanged) {
    window.api.onMcpStatusChanged((s) => { mcpState.status = s || []; renderMcpList(); });
  }
}

// 左下角版本号动态同步（从主进程读 package.json）
async function initAppVersion() {
  try {
    const v = await window.api.getAppVersion();
    const el = document.getElementById('footer-version');
    if (el && v) el.textContent = `AI Copilot · v${v}`;
  } catch (e) {}
}

/* ================= 自动更新 ================= */
let pendingUpdate = null; // { version, notes, dmgUrl, ... }

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// 是否可用增量升级：deltas 数组中存在 from === 当前版本，或旧版单一 deltaUrl 匹配
function hasMatchingDelta(res) {
  const cur = res && res.currentVersion;
  if (cur && Array.isArray(res && res.deltas)) {
    if (res.deltas.some((d) => d && d.from && d.from === cur)) return true;
  }
  return !!(res && res.deltaUrl && res.deltaFromVersion === cur);
}

function showSidebarUpdateBox(res) {
  const box = document.getElementById('sidebar-update-box');
  const sub = document.getElementById('sidebar-update-sub');
  const note = document.getElementById('sidebar-update-note');
  if (!box) return;
  if (sub) sub.textContent = `v${res.version} 可用（当前 v${res.currentVersion}）`;
  if (note) {
    const isDelta = hasMatchingDelta(res);
    note.textContent = isDelta
      ? '支持增量升级，点击「立即升级」一键更新。'
      : '点击「立即升级」下载并安装（完整包约 340MB）。';
  }
  const btn = document.getElementById('sidebar-update-now');
  if (btn) { btn.disabled = false; btn.textContent = '立即升级'; }
  box.classList.remove('hidden');
}

function hideSidebarUpdateBox() {
  const box = document.getElementById('sidebar-update-box');
  if (box) box.classList.add('hidden');
}

function revealInstall(res) {
  pendingUpdate = res;
  const ver = document.getElementById('update-version');
  const status = document.getElementById('update-status');
  const installBtn = document.getElementById('btn-install-update');
  const notes = document.getElementById('update-notes');
  if (ver) ver.textContent = 'v' + res.version;
  if (status) {
    const isDelta = hasMatchingDelta(res);
    status.textContent = isDelta ? '有可用更新（支持增量升级）' : '有可用更新';
    status.className = 'update-status has-update';
  }
  if (installBtn) installBtn.classList.remove('hidden');
  if (notes) {
    notes.innerHTML = '<strong>更新内容：</strong><br>' + escapeHtml(res.notes || '（未提供说明）');
    notes.classList.remove('hidden');
  }
  const card = document.getElementById('update-card');
  if (card) {
    card.classList.add('update-card-flash');
    setTimeout(() => card.classList.remove('update-card-flash'), 2000);
  }
}

async function initUpdater() {
  const ver = document.getElementById('update-version');
  if (ver) {
    try { ver.textContent = 'v' + (await window.api.getAppVersion()); } catch (e) {}
  }
  // 事件订阅（来自主进程的更新进度/结果）
  window.api.onUpdateAvailable((res) => {
    if (pendingUpdate && pendingUpdate.version === res.version) return; // 同版本已提示过，避免重复打扰
    showSidebarUpdateBox(res); revealInstall(res);
  });
  window.api.onUpdateProgress((info) => {
    const wrap = document.getElementById('update-progress-wrap');
    const bar = document.getElementById('update-progress-bar');
    const text = document.getElementById('update-progress-text');
    const pct = info && typeof info.percent === 'number' ? info.percent : (typeof info === 'number' ? info : 0);
    if (wrap) wrap.classList.remove('hidden');
    if (bar) bar.style.width = pct + '%';
    if (text && info && typeof info.written === 'number' && info.total) {
      const speed = info.speedBps > 0 ? ` · ${formatBytes(info.speedBps)}/s` : '';
      text.textContent = `${formatBytes(info.written)} / ${formatBytes(info.total)} (${pct}%)${speed}`;
    }
  });
  window.api.onUpdateStage((s) => {
    const t = document.getElementById('update-progress-text');
    if (t) t.textContent = s;
  });
  window.api.onUpdateError((m) => {
    const status = document.getElementById('update-status');
    if (status) { status.textContent = '更新失败：' + m; status.className = 'update-status error'; }
    const wrap = document.getElementById('update-progress-wrap');
    if (wrap) wrap.classList.add('hidden');
    const installBtn = document.getElementById('btn-install-update');
    if (installBtn) installBtn.disabled = false;
    const sbtn = document.getElementById('sidebar-update-now');
    if (sbtn) { sbtn.disabled = false; sbtn.textContent = '立即升级'; }
    const manualWrap = document.getElementById('update-manual-wrap');
    const manualLink = document.getElementById('update-manual-link');
    if (manualWrap) manualWrap.classList.remove('hidden');
    if (manualLink && pendingUpdate && pendingUpdate.dmgUrl) {
      manualLink.href = pendingUpdate.dmgUrl;
      manualLink.textContent = 'GitHub 下载失败？点击手动下载 DMG';
    }
  });

  // 手动检查
  const checkBtn = document.getElementById('btn-check-update');
  if (checkBtn) checkBtn.addEventListener('click', async () => {
    const status = document.getElementById('update-status');
    checkBtn.disabled = true;
    if (status) { status.textContent = '正在检查…'; status.className = 'update-status'; }
    const res = await window.api.checkUpdate();
    checkBtn.disabled = false;
    if (res.error) {
      if (status) { status.textContent = '检查失败：' + res.error; status.className = 'update-status error'; }
      return;
    }
    if (res.updateAvailable) {
      showSidebarUpdateBox(res);
      revealInstall(res);
    } else if (status) {
      status.textContent = '已是最新版本（v' + res.currentVersion + '）';
      status.className = 'update-status ok';
      hideSidebarUpdateBox();
    }
  });

  // 统一的「下载并安装」流程（设置卡片按钮 / 底部版本号升级按钮共用）
  async function startInstall() {
    if (!pendingUpdate || !pendingUpdate.dmgUrl) return;
    const status = document.getElementById('update-status');
    const wrap = document.getElementById('update-progress-wrap');
    const bar = document.getElementById('update-progress-bar');
    // 判断走增量还是完整包
    const curVer = await window.api.getAppVersion().catch(() => '');
    const isDelta = hasMatchingDelta({ ...pendingUpdate, currentVersion: curVer });
    if (status) {
      status.textContent = isDelta ? '正在下载增量更新…' : '正在下载完整安装包…';
      status.className = 'update-status';
    }
    if (wrap) wrap.classList.remove('hidden');
    if (bar) bar.style.width = '0%';
    const manualWrap = document.getElementById('update-manual-wrap');
    if (manualWrap) manualWrap.classList.add('hidden');
    const installBtn = document.getElementById('btn-install-update');
    if (installBtn) installBtn.disabled = true;
    const sbtn = document.getElementById('sidebar-update-now');
    if (sbtn) { sbtn.disabled = true; sbtn.textContent = '升级中…'; }
    await window.api.downloadUpdate(pendingUpdate);
    if (status) status.textContent = '正在安装并重启…';
  }

  // 侧边栏更新信息框：立即升级 / 关闭
  const sidebarUpdateNow = document.getElementById('sidebar-update-now');
  if (sidebarUpdateNow) sidebarUpdateNow.addEventListener('click', startInstall);
  const sidebarUpdateClose = document.getElementById('sidebar-update-close');
  if (sidebarUpdateClose) sidebarUpdateClose.addEventListener('click', hideSidebarUpdateBox);

  // 设置卡片「下载并安装」
  const installBtn = document.getElementById('btn-install-update');
  if (installBtn) installBtn.addEventListener('click', startInstall);
}

/* ================= 外观主题（浅色 / 深色） ================= */
const THEME_KEY = 'aicopilot-theme'; // 'light' | 'dark'
function applyTheme(theme) {
  const root = document.documentElement;
  const seg = document.getElementById('theme-segment');
  if (theme === 'dark') {
    root.classList.add('dark');
    if (seg) seg.classList.add('dark');
  } else {
    root.classList.remove('dark');
    if (seg) seg.classList.remove('dark');
  }
  // 同步 segmented control 的 active 视觉
  document.querySelectorAll('.theme-opt').forEach((b) => {
    const on = b.dataset.theme === theme;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  // 同步到 localStorage（同时尊重系统主题）
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
}
function initTheme() {
  // 1. 启动时立即应用（避免颜色闪烁）
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved !== 'light' && saved !== 'dark') {
    // 未保存过 → 跟随系统
    saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  applyTheme(saved);
  // 2. 绑定按钮
  document.querySelectorAll('.theme-opt').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
  // 3. 监听系统主题变化（仅在用户未显式选择时跟随）
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSysChange = () => {
      let cur = null;
      try { cur = localStorage.getItem(THEME_KEY); } catch (e) {}
      if (cur !== 'light' && cur !== 'dark') applyTheme(mq.matches ? 'dark' : 'light');
    };
    if (mq.addEventListener) mq.addEventListener('change', onSysChange);
  }
}

/* ================= AI 助手（智能体对话） ================= */
const chatMessagesEl = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const chatStatusEl = document.getElementById('chat-status');
const chatUsageEl = document.getElementById('chat-usage');
const confirmBar = document.getElementById('confirm-bar');
const confirmIcon = document.getElementById('confirm-icon');
const confirmTitle = document.getElementById('confirm-title');
const confirmText = document.getElementById('confirm-text');
const rememberBox = document.getElementById('confirm-remember');

const chatHistory = [];   // 发给模型的简版历史 [{role, content}]
let sessionUsage = { input: 0, output: 0 };
let currentAssistantBubble = null;
let sending = false;

/* ==================== AI 助手对话历史管理 ==================== */
let chatList = [];          // 所有对话 [{id,title,messages,createdAt,updatedAt,archived}]
let activeChatId = null;    // 当前活跃对话 ID
const chatHistoryListEl = document.getElementById('chat-history-list');
const btnNewChat = document.getElementById('btn-new-chat');

// 生成对话 ID
function genChatId() {
  return 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
}

// 从首条用户消息生成标题
function genChatTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return '新对话';
  const t = firstUser.content.trim().replace(/\n/g, ' ');
  return t.length > 18 ? t.slice(0, 18) + '…' : t;
}

// 加载持久化数据
async function loadChats() {
  const r = await window.api.chatLoad();
  chatList = r.chats || [];
  activeChatId = r.activeId || null;
  // 恢复活跃对话
  if (activeChatId) {
    const chat = chatList.find((c) => c.id === activeChatId);
    if (chat && chat.messages && chat.messages.length) {
      chatHistory.length = 0;
      chat.messages.forEach((m) => {
        chatHistory.push(m);
        renderHistoryMessage(m);
      });
      removeEmptyAssistantBubbles();
    }
  }
  renderChatList();
}

// 持久化保存
let saveChatsTimer = null;
function saveChats() {
  clearTimeout(saveChatsTimer);
  saveChatsTimer = setTimeout(async () => {
    await window.api.chatSave(chatList, activeChatId);
  }, 500);
}

// 将当前对话状态同步到 chatList
function persistCurrentChat() {
  if (!activeChatId) return;
  const chat = chatList.find((c) => c.id === activeChatId);
  if (!chat) return;
  chat.messages = chatHistory.slice();
  chat.title = genChatTitle(chat.messages);
  chat.updatedAt = Date.now();
  renderChatList();
}

// 新建对话
function createNewChat() {
  const chat = {
    id: genChatId(),
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
  };
  chatList.unshift(chat);
  activeChatId = chat.id;
  // 清空当前界面
  chatHistory.length = 0;
  sessionUsage = { input: 0, output: 0 };
  chatMessagesEl.innerHTML = '';
  todoPanel.classList.add('hidden');
  chatUsageEl.textContent = '';
  renderChatList();
  saveChats();
  switchPanel('ai');
}

// 切换到某个对话
function switchToChat(chatId) {
  const chat = chatList.find((c) => c.id === chatId);
  if (!chat) return;
  activeChatId = chatId;
  // 恢复消息到界面
  chatHistory.length = 0;
  sessionUsage = { input: 0, output: 0 };
  chatMessagesEl.innerHTML = '';
  todoPanel.classList.add('hidden');
  chatUsageEl.textContent = '';
  if (chat.messages && chat.messages.length) {
    chat.messages.forEach((m) => {
      chatHistory.push(m);
      renderHistoryMessage(m);
    });
  }
  removeEmptyAssistantBubbles();
  renderChatList();
  saveChats();
  switchPanel('ai');
}

// 根据消息类型渲染到界面（文本/工具调用/工具结果）
function renderHistoryMessage(m) {
  if (!m) return;
  if (m.role === 'user') {
    // user 消息可能是数组（包含图片），只取文本部分展示
    const text = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
    addBubble('user', text || '（图片）');
  } else if (m.role === 'assistant') {
    const text = typeof m.content === 'string' ? m.content
      : (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '');
    if (text) addBubble('assistant', text);
    if (Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((tc) => {
        try { addToolLine(tc.function.name, toolSummaryFromArgs(tc.function.name, safeJsonParse(tc.function.arguments))); }
        catch (e) { addToolLine(tc.function.name, ''); }
        // tool 结果（紧跟 tool message）
      });
    }
  } else if (m.role === 'tool') {
    const txt = String(m.content || '').slice(0, 200);
    addToolLine('result', txt + (txt.length >= 200 ? '…' : ''));
  } else if (m.role === 'system') {
    // 跳过系统消息（不显示）
  }
}

// 兼容 JSON 解析（agent 返回的可能不是合法 JSON）
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// 从工具调用参数中提取摘要（独立函数，避免循环依赖）
function toolSummaryFromArgs(name, input) {
  if (!input) return '';
  if (name === 'run_command') return String(input.command || '').slice(0, 80);
  const p = input.path || input.folder || (input.files && input.files[0]) || input.pattern || input.name || '';
  const extra = input.files ? `（共 ${input.files.length} 个文件）` : '';
  return (p || JSON.stringify(input).slice(0, 80)) + extra;
}

// 渲染侧边栏列表
function renderChatList() {
  if (!chatHistoryListEl) return;
  const visible = chatList.filter((c) => !c.archived);
  const archived = chatList.filter((c) => c.archived);
  if (!visible.length && !archived.length) {
    chatHistoryListEl.innerHTML = '<div class="chat-history-empty">暂无历史记录</div>';
    return;
  }
  const renderItem = (chat) => {
    const item = document.createElement('div');
    item.className = 'chat-history-item' + (chat.id === activeChatId ? ' active' : '') + (chat.archived ? ' archived' : '');
    const title = document.createElement('span');
    title.className = 'chat-history-item-title';
    title.textContent = chat.title || '新对话';
    title.title = chat.title || '';
    const menuBtn = document.createElement('button');
    menuBtn.className = 'chat-history-item-menu';
    menuBtn.textContent = '⋯';
    menuBtn.title = '更多';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showChatMenu(chat, menuBtn);
    });
    item.appendChild(title);
    item.appendChild(menuBtn);
    item.addEventListener('click', () => switchToChat(chat.id));
    return item;
  };
  chatHistoryListEl.innerHTML = '';
  visible.forEach((c) => chatHistoryListEl.appendChild(renderItem(c)));
  if (archived.length) {
    const sep = document.createElement('div');
    sep.className = 'nav-section-label';
    sep.style.cssText = 'padding:8px 14px 4px;opacity:0.6;';
    sep.textContent = '已归档';
    chatHistoryListEl.appendChild(sep);
    archived.forEach((c) => chatHistoryListEl.appendChild(renderItem(c)));
  }
}

// 弹出操作菜单
let currentMenuPopup = null;
function showChatMenu(chat, anchorEl) {
  // 关闭已有弹窗
  if (currentMenuPopup) { currentMenuPopup.remove(); currentMenuPopup = null; }
  const popup = document.createElement('div');
  popup.className = 'chat-history-menu-popup';
  // 改名
  const btnRename = document.createElement('button');
  btnRename.textContent = '改名';
  btnRename.addEventListener('click', () => {
    popup.remove(); currentMenuPopup = null;
    const newName = prompt('输入新名称：', chat.title || '新对话');
    if (newName && newName.trim()) {
      chat.title = newName.trim();
      renderChatList();
      saveChats();
    }
  });
  // 归档/取消归档
  const btnArchive = document.createElement('button');
  btnArchive.textContent = chat.archived ? '取消归档' : '归档';
  btnArchive.addEventListener('click', () => {
    popup.remove(); currentMenuPopup = null;
    chat.archived = !chat.archived;
    renderChatList();
    saveChats();
  });
  // 删除
  const btnDelete = document.createElement('button');
  btnDelete.className = 'danger';
  btnDelete.textContent = '删除';
  btnDelete.addEventListener('click', () => {
    popup.remove(); currentMenuPopup = null;
    if (!confirm('确定删除此对话？此操作不可撤销。')) return;
    chatList = chatList.filter((c) => c.id !== chat.id);
    if (activeChatId === chat.id) {
      activeChatId = null;
      chatHistory.length = 0;
      chatMessagesEl.innerHTML = '';
      chatUsageEl.textContent = '';
    }
    renderChatList();
    saveChats();
  });
  popup.append(btnRename, btnArchive, btnDelete);
  document.body.appendChild(popup);
  currentMenuPopup = popup;
  // 定位
  const rect = anchorEl.getBoundingClientRect();
  popup.style.left = Math.min(rect.right - popup.offsetWidth, window.innerWidth - 140) + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  // 点击外部关闭
  setTimeout(() => {
    const closeHandler = (ev) => {
      if (!popup.contains(ev.target)) {
        popup.remove(); currentMenuPopup = null;
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    document.addEventListener('mousedown', closeHandler);
  }, 0);
}

/* ---- 输入区 composer：引用文件 / 语音 / 权限 / 模型信息 ---- */
const btnAttach = document.getElementById('btn-attach');
const btnVoice = document.getElementById('btn-voice');
const modelInfoEl = document.getElementById('model-info');
const modelNameEl = document.getElementById('model-name');
const sendIconEl = document.getElementById('send-icon');

// 发送按钮：空闲=箭头图标；AI 运行中（等待）=「运行」图标 + 脉冲光圈
function setSending(v) {
  sending = v;
  btnSend.disabled = v;
  btnSend.classList.toggle('running', v);
  if (sendIconEl) {
    sendIconEl.src = v ? 'assets/icon-running.png' : 'assets/icon-send.png';
    sendIconEl.alt = v ? '运行中' : '发送';
  }
  btnSend.dataset.tip = v ? 'AI 正在运行…' : '发送（Enter）';
  btnSend.title = v ? 'AI 正在运行…' : '发送';
}

// 文本框自动增高（面板 display:none 时 scrollHeight 为 0，不能把高度压成 0）
function autoGrow() {
  chatInput.style.height = 'auto';
  if (chatInput.offsetParent === null) return; // 面板隐藏时不写死高度
  const h = chatInput.scrollHeight;
  chatInput.style.height = h > 0 ? Math.min(h, 160) + 'px' : '';
}
chatInput.addEventListener('input', autoGrow);

// 引用对话文件（＋）
btnAttach.addEventListener('click', async () => {
  const files = await window.api.selectFiles();
  if (!files.length) return;
  for (const f of files) if (!state.rawFiles.includes(f)) state.rawFiles.push(f);
  await refilter();
  addBubble('assistant', `已引用 ${files.length} 个文件，可直接让我对其操作（替换 / 排版 / 打开等）。`);
});

// 语音输入（Web Speech API）
let recognizer = null, recognizing = false;
function buildRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'zh-CN';
  r.interimResults = true;
  r.continuous = false;
  r.onresult = (ev) => {
    let txt = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
    chatInput.value = txt;
    autoGrow();
  };
  r.onend = () => { recognizing = false; btnVoice.classList.remove('listening'); };
  r.onerror = (ev) => { recognizing = false; btnVoice.classList.remove('listening'); chatStatusEl.textContent = '语音识别结束：' + (ev.error || '未知错误'); };
  return r;
}
btnVoice.addEventListener('click', () => {
  if (!recognizer) recognizer = buildRecognizer();
  if (!recognizer) { chatStatusEl.textContent = '当前环境不支持语音输入'; return; }
  if (recognizing) { recognizer.stop(); return; }
  try { recognizing = true; btnVoice.classList.add('listening'); recognizer.start(); }
  catch (e) { recognizing = false; btnVoice.classList.remove('listening'); }
});

// 权限模式下拉
const permEl = document.getElementById('perm');
const permTrigger = document.getElementById('perm-trigger');
const permMenu = document.getElementById('perm-menu');
const permLabel = document.getElementById('perm-label');
const PERM_LABELS = { ask: '默认权限', trust: '信任此会话', deny: '只读模式' };

function setPermMode(mode) {
  permLabel.textContent = PERM_LABELS[mode] || '默认权限';
  permEl.dataset.mode = mode;
  document.querySelectorAll('.perm-item').forEach((it) => it.classList.toggle('active', it.dataset.mode === mode));
  if (window.api.setPermissionMode) window.api.setPermissionMode(mode);
}

permTrigger.addEventListener('click', (e) => { e.stopPropagation(); permMenu.classList.toggle('hidden'); });
permMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.perm-item');
  if (!item) return;
  setPermMode(item.dataset.mode);
  permMenu.classList.add('hidden');
});
document.addEventListener('click', () => permMenu.classList.add('hidden'));
setPermMode('ask'); // 默认：每次询问（同步给主进程）

// MCP 外部工具开关（会话级，默认关闭；开启后可单选一个已连接的 MCP 服务器）
const mcpToggle = document.getElementById('mcp-toggle');
const mcpStateEl = document.getElementById('mcp-state');
const mcpServerSelect = document.getElementById('mcp-server-select');
let mcpEnabled = false;
let mcpSelectedServer = null;

// 用已连接（ready）的 MCP 服务器填充单选下拉；开启 MCP 时显示，关闭时隐藏
async function refreshMcpServerSelect() {
  if (!mcpServerSelect) return;
  let servers = [];
  try {
    const r = await window.api.mcpGet();
    const status = r.status || [];
    // 只列已启用且连接成功的服务器
    servers = status.filter((s) => s.status === 'ready').map((s) => s.name);
  } catch (e) { /* ignore */ }
  mcpServerSelect.innerHTML = '';
  if (!servers.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（无已连接服务器）';
    mcpServerSelect.appendChild(opt);
    mcpServerSelect.disabled = true;
    mcpSelectedServer = null;
    if (window.api.setMcpServer) window.api.setMcpServer(null);
    return;
  }
  mcpServerSelect.disabled = false;
  servers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    mcpServerSelect.appendChild(opt);
  });
  // 保留之前的选择（若仍存在），否则默认第一个
  if (mcpSelectedServer && servers.includes(mcpSelectedServer)) {
    mcpServerSelect.value = mcpSelectedServer;
  } else {
    mcpSelectedServer = servers[0];
    mcpServerSelect.value = mcpSelectedServer;
    if (window.api.setMcpServer) window.api.setMcpServer(mcpSelectedServer);
  }
}

function setMcpEnabled(v) {
  mcpEnabled = !!v;
  mcpToggle.classList.toggle('on', mcpEnabled);
  mcpToggle.classList.toggle('off', !mcpEnabled);
  if (mcpStateEl) mcpStateEl.textContent = mcpEnabled ? '开' : '关';
  const tip = 'MCP 外部工具：' + (mcpEnabled ? '开' + (mcpSelectedServer ? '·' + mcpSelectedServer : '') : '关');
  mcpToggle.dataset.tip = tip;
  mcpToggle.title = tip;
  if (mcpServerSelect) mcpServerSelect.classList.toggle('hidden', !mcpEnabled);
  if (window.api.setMcpEnabled) window.api.setMcpEnabled(mcpEnabled);
  if (mcpEnabled) refreshMcpServerSelect();
}
mcpToggle.addEventListener('click', () => setMcpEnabled(!mcpEnabled));
if (mcpServerSelect) {
  mcpServerSelect.addEventListener('change', () => {
    mcpSelectedServer = mcpServerSelect.value || null;
    if (window.api.setMcpServer) window.api.setMcpServer(mcpSelectedServer);
    const tip = 'MCP 外部工具：开' + (mcpSelectedServer ? '·' + mcpSelectedServer : '');
    mcpToggle.dataset.tip = tip;
    mcpToggle.title = tip;
  });
}
// MCP 服务器连接状态变化时刷新下拉（只在 MCP 开启时）
if (window.api.onMcpStatusChanged) {
  window.api.onMcpStatusChanged(() => { if (mcpEnabled) refreshMcpServerSelect(); });
}
setMcpEnabled(false); // 默认关闭，同步给主进程

// 模型信息显示
function updateModelInfo() {
  const p = aiState.profiles.find((x) => x.id === aiState.activeId);
  if (p && p.model) {
    modelNameEl.textContent = p.model;
    modelInfoEl.title = `模型：${p.model}\n提供商：${p.providerName}\n点击切换模型`;
    modelInfoEl.dataset.tip = `${p.model}`;
    modelInfoEl.classList.remove('warn');
  } else {
    modelNameEl.textContent = '未配置模型';
    modelInfoEl.title = '请到「AI 设置」配置并启用模型';
    modelInfoEl.dataset.tip = '未配置模型';
    modelInfoEl.classList.add('warn');
  }
}

// 模型切换器（右下角弹出菜单）
const modelWrap = document.querySelector('.model-wrap');
const modelMenu = document.getElementById('model-menu');
const modelMenuList = document.getElementById('model-menu-list');

// 根据 provider 取图标样式
function modelIconClass(provider) {
  const map = { anthropic: 'a', openai: 'o', deepseek: 'd', minimax: 'm', moonshot: 'k', zhipu: 'z', qwen: 'q', doubao: 'db' };
  return map[provider] || 'x';
}
// 图标首字母
function modelIconChar(p) {
  const m = { anthropic: 'A', openai: 'O', deepseek: 'D', minimax: 'M', moonshot: 'K', zhipu: 'Z', qwen: 'Q', doubao: 'B' };
  return m[p.provider] || (p.providerName || '?')[0].toUpperCase();
}

function renderModelMenu() {
  if (!aiState.profiles.length) {
    modelMenuList.innerHTML = '<div class="model-menu-empty">暂无模型配置<br><small>请到「AI 设置」添加</small></div>';
    return;
  }
  modelMenuList.innerHTML = '';
  // 按 providerName 分组（每家服务商一组）
  const groups = {};
  aiState.profiles.forEach((p) => {
    const key = p.providerName || '自定义';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  Object.entries(groups).forEach(([name, profiles]) => {
    const g = document.createElement('div');
    g.className = 'model-group';
    if (Object.keys(groups).length > 1) {
      const label = document.createElement('div');
      label.className = 'model-group-label';
      label.textContent = name;
      g.appendChild(label);
    }
    profiles.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'model-item' + (p.id === aiState.activeId ? ' active' : '');
      const isActive = p.id === aiState.activeId;
      item.innerHTML = `
        <div class="model-item-ico ${modelIconClass(p.provider)}">${modelIconChar(p)}</div>
        <div class="model-item-text">
          <div class="model-item-name">${p.model || '（未选模型）'}</div>
          <div class="model-item-desc">${p.providerName} · ${p.type === 'anthropic' ? 'Anthropic' : 'OpenAI'}</div>
        </div>
        <div class="model-item-check">${isActive ? '✓' : ''}</div>`;
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        await switchModel(p.id, p.model);
      });
      g.appendChild(item);
    });
    modelMenuList.appendChild(g);
  });
}

async function switchModel(profileId, model) {
  try {
    const state = await window.api.aiSetActive(profileId, model);
    aiState.profiles = state.profiles;
    aiState.activeId = state.activeId;
    updateModelInfo();
    closeModelMenu();
    // 在聊天区显示切换提示
    const p = aiState.profiles.find((x) => x.id === profileId);
    if (p) addBubble('system', `已切换到 ${p.providerName} 的 ${p.model || '（未选模型）'}`);
  } catch (e) {
    addBubble('system', `切换失败：${e.message}`);
  }
}

function openModelMenu() {
  renderModelMenu();
  modelMenu.classList.remove('hidden');
  modelWrap.classList.add('open');
}
function closeModelMenu() {
  modelMenu.classList.add('hidden');
  modelWrap.classList.remove('open');
}
function toggleModelMenu() {
  if (modelMenu.classList.contains('hidden')) openModelMenu();
  else closeModelMenu();
}

modelInfoEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const p = aiState.profiles.find((x) => x.id === aiState.activeId);
  if (!p || !p.model) {
    // 未配置 → 跳设置
    switchPanel('ai-settings');
  } else {
    toggleModelMenu();
  }
});
// 点击其它地方关闭
document.addEventListener('click', (e) => {
  if (!modelWrap.contains(e.target)) closeModelMenu();
});

function addBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chatMessagesEl.appendChild(wrap);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return bubble;
}

// 清理没有任何文字内容的 AI 气泡（防止流式输出或历史恢复时留下空条）
function removeEmptyAssistantBubbles() {
  if (!chatMessagesEl) return;
  chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble').forEach((b) => {
    if (!b.textContent.trim()) {
      const wrap = b.closest('.chat-msg');
      if (wrap) wrap.remove();
    }
  });
}

function addToolLine(name, detail) {
  const div = document.createElement('div');
  div.className = 'chat-tool';
  const label = document.createElement('span');
  label.className = 'tool-name';
  label.textContent = '⚙ ' + name;
  div.append(label, document.createTextNode(' ' + detail));
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return div;
}

function toolSummary(name, input) {
  if (!input) return '';
  const p = input.path || input.folder || (input.files && input.files[0]) || input.pattern || input.name || '';
  const extra = input.files ? `（共 ${input.files.length} 个文件）` : '';
  return (p || JSON.stringify(input).slice(0, 80)) + extra;
}

// 智能体事件
window.api.onAiText((t) => {
  if (!currentAssistantBubble) currentAssistantBubble = addBubble('assistant', '');
  currentAssistantBubble.textContent += (currentAssistantBubble.textContent ? '\n' : '') + t;
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
});

window.api.onAiToolStart(({ name, input }) => {
  // 助手只调用工具没出文字时，把空文字气泡清掉，避免留下空条
  if (currentAssistantBubble && !currentAssistantBubble.textContent.trim()) {
    const emptyWrap = currentAssistantBubble.closest('.chat-msg');
    if (emptyWrap) emptyWrap.remove();
  }
  currentAssistantBubble = null;
  addToolLine(name, toolSummary(name, input));
});

window.api.onAiToolEnd(({ name, result }) => {
  addToolLine(name + ' ✓', result.slice(0, 200) + (result.length > 200 ? '…' : ''));
});

const CONFIRM_ICONS = { 'write': '✍️', 'edit': '✏️', 'batch': '🔁', 'open-file': '📂', 'open-url': '🌐', 'mcp': '🔌', 'install_dependency': '📦' };
window.api.onAiConfirm((payload) => {
  const type = payload && typeof payload === 'object' ? payload.type : null;
  const title = (payload && payload.title) || '需要授权';
  const desc = (payload && payload.desc) || (typeof payload === 'string' ? payload : '');
  confirmIcon.textContent = CONFIRM_ICONS[type] || '🔒';
  confirmTitle.textContent = title;
  confirmText.textContent = desc;
  rememberBox.checked = false;
  confirmBar.classList.remove('hidden');
});

// Todo 任务清单
const todoPanel = document.getElementById('todo-panel');
const todoListEl = document.getElementById('todo-list');
window.api.onAiTodo((todos) => {
  lastTodos = Array.isArray(todos) ? todos.slice() : [];
  if (!todos.length) { todoPanel.classList.add('hidden'); return; }
  todoPanel.classList.remove('hidden');
  todoListEl.innerHTML = '';
  const icons = { pending: '○', in_progress: '◐', completed: '●' };
  todos.forEach((t) => {
    const li = document.createElement('li');
    const ico = document.createElement('span');
    ico.className = 't-ico t-' + t.status;
    ico.textContent = icons[t.status] || '○';
    const text = document.createElement('span');
    text.className = 't-' + t.status;
    text.textContent = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    li.append(ico, text);
    todoListEl.appendChild(li);
  });
});

// 子代理 / 压缩事件
function addEventLine(text) {
  const div = document.createElement('div');
  div.className = 'chat-event';
  div.textContent = text;
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}
window.api.onAiSubagentStart((d) => addEventLine(`⟶ 启动子代理「${d.description}」（${d.type === 'explore' ? '只读探索' : '通用'}）`));
window.api.onAiSubagentEnd((d) => addEventLine(`⟵ 子代理「${d.description}」完成`));
window.api.onAiCompact(() => addEventLine('⟲ 对话过长，已自动压缩历史'));

document.getElementById('btn-confirm-yes').addEventListener('click', () => {
  const remember = rememberBox.checked;
  confirmBar.classList.add('hidden');
  window.api.aiConfirmReply(true, remember);
});
document.getElementById('btn-confirm-no').addEventListener('click', () => {
  confirmBar.classList.add('hidden');
  window.api.aiConfirmReply(false, false);
});

// 技能安装授权
const installSkillBar = document.getElementById('install-skill-bar');
const installSkillText = document.getElementById('install-skill-text');
window.api.onAiInstallSkill((info) => {
  installSkillText.textContent = `AI 助手请求安装技能「${info.name}」（${info.description}）`;
  installSkillBar.classList.remove('hidden');
});
document.getElementById('btn-install-skill-yes').addEventListener('click', () => {
  installSkillBar.classList.add('hidden');
  window.api.aiInstallSkillReply(true);
});
document.getElementById('btn-install-skill-no').addEventListener('click', () => {
  installSkillBar.classList.add('hidden');
  window.api.aiInstallSkillReply(false);
});

// AI 改了替换规则时，刷新替换框架界面
window.api.onRulesChanged((rules) => {
  state.rules = rules.map((r) => ({ ...r }));
  renderRules();
  window.api.syncRules(state.rules);
});

// 确保有活跃对话（发消息时自动创建）
function ensureActiveChat() {
  if (activeChatId) return;
  const chat = {
    id: genChatId(),
    title: '新对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
  };
  chatList.unshift(chat);
  activeChatId = chat.id;
  renderChatList();
}

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  chatInput.value = '';
  autoGrow();

  // 斜杠命令本地处理
  if (text.startsWith('/')) {
    handleSlashCommand(text);
    return;
  }

  ensureActiveChat();
  setSending(true);
  addBubble('user', text);
  // 存完整消息（含 tool_calls/tool）以便下次续接；初版是简版文本
  chatHistory.push({ role: 'user', content: text });
  currentAssistantBubble = null;
  chatStatusEl.textContent = '智能体工作中…';

  // 「继续」智能注入：如有未完成的任务，把当前 todo 列表拼成上下文
  let augmentedText = text;
  if (/^(继续|continue|next|go on)/i.test(text) && lastTodos && lastTodos.length) {
    const pending = lastTodos.filter((t) => t.status !== 'completed');
    if (pending.length) {
      const todoCtx = pending.map((t) => `- [${t.status === 'in_progress' ? '进行中' : '待办'}] ${t.activeForm || t.content}`).join('\n');
      augmentedText = `${text}\n\n（系统提示：你之前设定了以下任务，请基于此继续：\n${todoCtx}\n请从「进行中」的任务继续，按顺序处理未完成项。）`;
    }
  }

  // 传完整历史（含 tool_calls/tool）；agent loop 会正确清洗
  const r = await window.api.aiChat(chatHistory.slice(0, -1), augmentedText);

  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
    chatHistory.push({ role: 'assistant', content: '出错了：' + (r.error || '未知错误') });
  } else if (r.messages && r.messages.length) {
    // 完整消息回传：用整轮 messages 覆盖 chatHistory（去掉末尾注入的 augmentedText）
    // 找到原始 user text 位置，保留其之前的全部历史 + 完整 agent 输出
    const finalMessages = r.messages;
    // 把简版的 user 消息替换为原始 text（避免被 augmentedText 污染持久化）
    for (let i = finalMessages.length - 1; i >= 0; i--) {
      if (finalMessages[i].role === 'user' && finalMessages[i].content === augmentedText) {
        finalMessages[i] = { role: 'user', content: text };
        break;
      }
    }
    chatHistory.length = 0;
    finalMessages.forEach((m) => chatHistory.push(m));
  } else {
    // 兜底：旧逻辑
    const assistantTexts = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = assistantTexts[assistantTexts.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
  }

  if (r.usage) {
    sessionUsage.input += r.usage.input;
    sessionUsage.output += r.usage.output;
    chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
  }
  currentAssistantBubble = null;
  setSending(false);
  removeEmptyAssistantBubbles();
  persistCurrentChat();
  saveChats();
  chatInput.focus();
}

// 最近一次 Todo 列表（用于「继续」智能注入）
let lastTodos = [];

// 斜杠命令（local 型：本地执行，不发模型）
function handleSlashCommand(text) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  switch (cmd) {
    case 'clear':
      createNewChat();
      addBubble('assistant', '已新建对话。');
      break;
    case 'rules':
      if (!state.rules.length) { addBubble('assistant', '替换框架中还没有规则。'); break; }
      addBubble('assistant', '当前替换框架中的规则：\n' +
        state.rules.map((r, i) => `${i + 1}. [${r.enabled ? '启用' : '停用'}] ${r.name}：「${r.find}」→「${r.replace}」`).join('\n'));
      break;
    case 'files':
      if (!state.filteredFiles.length) { addBubble('assistant', '还没有选择文件。'); break; }
      addBubble('assistant', `当前待处理文件 ${state.filteredFiles.length} 个：\n` + state.filteredFiles.slice(0, 50).join('\n') +
        (state.filteredFiles.length > 50 ? `\n（仅显示前 50 个）` : ''));
      break;
    case 'help':
      addBubble('assistant',
        '可用命令：\n' +
        '/clear — 清空对话和用量统计\n' +
        '/rules — 查看替换框架中的规则\n' +
        '/files — 查看当前待处理文件\n' +
        '/help — 显示本帮助\n\n' +
        '直接输入自然语言即可指挥智能体，例如：\n' +
        '「扫描 ~/Documents 里的 docx」「把这个文件排版一下」「帮我写个 README」');
      break;
    default:
      addBubble('assistant', `未知命令 /${cmd}，输入 /help 查看可用命令。`);
  }
}

btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

/* ================= 文件自动化 ================= */
const auto = {
  template: null,        // { kind:'folder'|'files', folder, files:[] }
  files: [],             // 需编写文件
  rules: [],             // 编写规范 [{id,type,value,enabled}]
  presets: [],           // 已保存预设 [{name, rules:[...]}]
};
let autoRuleSeq = 0;

// 文件整理相关内置技能（自动出现在「文件自动化」技能下拉中）
const AUTO_SKILL_FILE_RELATED = [
  'file-organizer-skill', 'document-converter', 'pdf-to-office',
  'pdf-compress', 'pdf-merge-split', 'batch-rename-company', 'format-convert',
];

// 自动填充「使用技能」下拉：已安装技能 + 文件整理相关内置技能
async function populateAutoSkill() {
  const sel = document.getElementById('auto-skill');
  if (!sel) return;
  sel.innerHTML = '<option value="">（不指定技能，按默认流程）</option>';
  const map = new Map();
  try {
    const { builtin = [], installed = [] } = await window.api.skillsList();
    for (const b of builtin) {
      if (AUTO_SKILL_FILE_RELATED.includes(b.name)) {
        map.set(b.name, { name: b.name, desc: b.description || '', source: 'builtin' });
      }
    }
    for (const i of installed) {
      if (!map.has(i.name)) map.set(i.name, { name: i.name, desc: i.description || '', source: 'installed' });
    }
  } catch (e) { /* 拉取失败则只保留默认项 */ }
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name + (s.source === 'installed' ? '（已安装）' : '（内置）');
    sel.appendChild(o);
  }
}

function getAutoSkillName() {
  const sel = document.getElementById('auto-skill');
  return sel ? sel.value : '';
}

// 在提示词前追加「先加载该技能」的指令，交给 AI 代理按技能指引执行
function withAutoSkill(prompt, skillName) {
  if (!skillName) return prompt;
  return `请先调用 skill 工具加载「${skillName}」技能，获取其详细操作指引，并严格按指引执行本「文件自动化」任务。\n\n` + prompt;
}


const autoTemplateInfo = document.getElementById('auto-template-info');
const autoFileListEl = document.getElementById('auto-file-list');
const autoFileEmptyEl = document.getElementById('auto-file-empty');
const autoFileCountEl = document.getElementById('auto-file-count');
const autoRuleListEl = document.getElementById('auto-rule-list');
const autoRuleEmptyEl = document.getElementById('auto-rule-empty');
const autoRuleCountEl = document.getElementById('auto-rule-count');
const autoMsgEl = document.getElementById('auto-msg');

function setAutoMsg(t) { autoMsgEl.textContent = t || ''; }

/* ---- ① 模版 ---- */
function renderAutoTemplate() {
  if (!auto.template) { autoTemplateInfo.classList.add('hidden'); autoTemplateInfo.textContent = ''; return; }
  autoTemplateInfo.classList.remove('hidden');
  if (auto.template.kind === 'folder') {
    autoTemplateInfo.textContent = '模版文件夹：' + auto.template.folder;
  } else {
    autoTemplateInfo.textContent = `模版文件（${auto.template.files.length} 个）：` + auto.template.files.join('、');
  }
}

document.getElementById('auto-pick-template-file').addEventListener('click', async () => {
  const files = await window.api.selectFiles();
  if (!files.length) return;
  auto.template = { kind: 'files', folder: null, files };
  renderAutoTemplate();
  setAutoMsg('');
});
document.getElementById('auto-pick-template-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  auto.template = { kind: 'folder', folder, files: [] };
  renderAutoTemplate();
  setAutoMsg('');
});
document.getElementById('auto-clear-template').addEventListener('click', () => {
  auto.template = null;
  renderAutoTemplate();
});

/* ---- ② 需编写文件 ---- */
function renderAutoFiles() {
  autoFileListEl.innerHTML = '';
  autoFileEmptyEl.style.display = auto.files.length ? 'none' : 'block';
  autoFileCountEl.textContent = auto.files.length;
  auto.files.forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    autoFileListEl.appendChild(li);
  });
}

document.getElementById('auto-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles();
  if (!files.length) return;
  for (const f of files) if (!auto.files.includes(f)) auto.files.push(f);
  renderAutoFiles();
  setAutoMsg('');
});
document.getElementById('auto-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  setAutoMsg('正在扫描文件夹…');
  const files = await window.api.scanFolder(folder, []);
  auto.files = files;
  renderAutoFiles();
  setAutoMsg(files.length ? '' : '该文件夹下未扫描到文件');
});
document.getElementById('auto-clear-files').addEventListener('click', () => {
  auto.files = [];
  renderAutoFiles();
});

/* ---- ④ 编写规范（规则） ---- */
function renderAutoRules() {
  autoRuleListEl.innerHTML = '';
  autoRuleEmptyEl.style.display = auto.rules.length ? 'none' : 'block';
  autoRuleCountEl.textContent = auto.rules.length;
  auto.rules.forEach((rule) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rule-enabled';
    cb.checked = rule.enabled;
    cb.title = '启用/停用该规范';
    cb.addEventListener('change', () => { rule.enabled = cb.checked; });

    const tag = document.createElement('span');
    tag.className = 'auto-rule-type-tag';
    tag.textContent = rule.type;

    const val = document.createElement('span');
    val.className = 'auto-rule-value';
    val.textContent = rule.value;

    const del = document.createElement('button');
    del.className = 'rule-del';
    del.textContent = '✕';
    del.title = '删除规范';
    del.addEventListener('click', () => {
      auto.rules = auto.rules.filter((r) => r.id !== rule.id);
      renderAutoRules();
    });

    li.append(cb, tag, val, del);
    autoRuleListEl.appendChild(li);
  });
}

document.getElementById('auto-add-rule').addEventListener('click', () => {
  const type = document.getElementById('auto-rule-type').value;
  const valueInput = document.getElementById('auto-rule-value');
  const value = valueInput.value.trim();
  if (!value) { valueInput.focus(); valueInput.placeholder = '规范内容不能为空！'; return; }
  auto.rules.push({ id: ++autoRuleSeq, type, value, enabled: true });
  valueInput.value = '';
  valueInput.placeholder = '规范内容，如：技术部 / 张三 / 在文件头部加上当前日期';
  renderAutoRules();
});

/* ---- 预设：保存 / 调用 / 删除 ---- */
const autoPresetName = document.getElementById('auto-preset-name');
const autoPresetList = document.getElementById('auto-preset-list');

async function loadAutoPresets() {
  auto.presets = await window.api.automationGetPresets() || [];
  renderAutoPresetList();
}
function renderAutoPresetList() {
  autoPresetList.innerHTML = '';
  if (!auto.presets.length) {
    autoPresetList.innerHTML = '<option value="">（无预设）</option>';
    return;
  }
  auto.presets.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    autoPresetList.appendChild(opt);
  });
}
async function persistAutoPresets() {
  await window.api.automationSavePresets(auto.presets);
  renderAutoPresetList();
}

document.getElementById('auto-save-preset').addEventListener('click', async () => {
  const name = autoPresetName.value.trim();
  if (!name) { autoPresetName.focus(); setAutoMsg('请先填写预设名称'); return; }
  const activeRules = auto.rules.map((r) => ({ type: r.type, value: r.value, enabled: r.enabled }));
  if (!activeRules.length) { setAutoMsg('当前没有可保存的编写规范'); return; }
  const idx = auto.presets.findIndex((p) => p.name === name);
  if (idx >= 0) auto.presets[idx].rules = activeRules;
  else auto.presets.push({ name, rules: activeRules });
  await persistAutoPresets();
  autoPresetName.value = '';
  autoPresetList.value = name;
  setAutoMsg('预设已保存：' + name);
});

document.getElementById('auto-load-preset').addEventListener('click', () => {
  const name = autoPresetList.value;
  const preset = auto.presets.find((p) => p.name === name);
  if (!preset) { setAutoMsg('请先选择一个预设'); return; }
  auto.rules = preset.rules.map((r) => ({ id: ++autoRuleSeq, type: r.type, value: r.value, enabled: r.enabled !== false }));
  renderAutoRules();
  setAutoMsg('已调用预设：' + name);
});

document.getElementById('auto-del-preset').addEventListener('click', async () => {
  const name = autoPresetList.value;
  if (!name) { setAutoMsg('请先选择一个预设'); return; }
  auto.presets = auto.presets.filter((p) => p.name !== name);
  await persistAutoPresets();
  setAutoMsg('已删除预设：' + name);
});

/* ---- ⑤ 保存方式 ---- */
let autoOutputDir = null;
function getAutoSaveMode() {
  return document.querySelector('input[name="auto-save-mode"]:checked').value;
}
document.querySelectorAll('input[name="auto-save-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    document.getElementById('auto-output-row').style.opacity = getAutoSaveMode() === 'output' ? '1' : '0.45';
  });
});
document.getElementById('auto-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { autoOutputDir = dir; document.getElementById('auto-output-dir').value = dir; }
});

/* ---- 开始编写（交给 AI 智能体） ---- */
const LAYOUT_DESC = {
  template: '按模版目录结构摆放（目标文件在输出目录中复刻模版的层级）',
  flat: '全部平铺到输出目录（不建子目录）',
  bytype: '按文件类型归类到不同子目录',
};

function buildAutomationPrompt() {
  const layout = LAYOUT_DESC[document.getElementById('auto-layout').value] || LAYOUT_DESC.template;
  const categorize = document.getElementById('auto-categorize').checked;
  const preserve = document.getElementById('auto-preserve').checked;
  const saveMode = getAutoSaveMode();
  const activeRules = auto.rules.filter((r) => r.enabled && r.value);

  let tpl;
  if (auto.template.kind === 'folder') {
    tpl = `模版文件夹：${auto.template.folder}\n（请用 list_dir / glob_files 查看其目录结构与文件，再用 read_file 阅读关键文件，理解其结构与格式。模版仅作参照，不要修改它。）`;
  } else {
    tpl = `模版文件（${auto.template.files.length} 个）：\n${auto.template.files.join('\n')}\n（请用 read_file 阅读，理解其结构与格式。模版仅作参照，不要修改它。）`;
  }

  const rulesDesc = activeRules.length
    ? activeRules.map((r, i) => `  ${i + 1}. [${r.type}] ${r.value}`).join('\n')
    : '  （未额外添加，主要参照模版结构）';

  const saveDesc = saveMode === 'output'
    ? `输出到目录 ${autoOutputDir}（不要改动原文件），保存地址：${autoOutputDir}`
    : '覆盖原文件（直接改写，不传 output_dir）';

  return (
    `请执行「文件自动化」任务：参照【模版】的目录结构，把【需编写文件】按模版位置摆放并编写内容后保存到输出目录。\n\n` +
    `【匹配规则】\n` +
    `- 按关键字把需编写文件匹配到模版对应位置（不是精确文件名匹配，是按文件名中的关键字智能对应）\n` +
    `- 需编写文件匹配到的 → 放到模版对应位置\n` +
    `- 需编写文件中模版没有的 → 不同步到输出目录\n` +
    `- 模版文件本身不要复制到输出目录\n\n` +
    `【模版】（仅作参照，不要修改模版文件本身）\n${tpl}\n\n` +
    `【需编写文件】（共 ${auto.files.length} 个，这些才是要处理和保存的文件）\n${auto.files.slice(0, 400).join('\n')}${auto.files.length > 400 ? '\n（仅列出前 400 个）' : ''}\n\n` +
    `【规范】\n` +
    `- 文件夹摆放格式：${layout}\n` +
    `- 文件归类：${categorize ? '自动按模版文件的目录结构归类文件' : '不启用，按原相对位置'}\n` +
    `- 编写规范：\n${rulesDesc}\n\n` +
    `【内容要求】\n` +
    (preserve
      ? `- 保留每个文件自身的内容与原本内容：不要清空或整段覆盖丢失；在保留原有内容的基础上，按模版结构、格式与上述规范进行调整、补全与归类。\n`
      : `- 可按模版与规范重写内容（用户已允许不保留原内容）。\n`) +
    `\n【保存】\n- ${saveDesc}\n` +
    `- 输出目录中只保存需编写文件，不要把模版文件复制过去，不要放入模版中没有的多余文件。\n\n` +
    `请先查看模版与目标文件、理解模版结构，再逐个处理目标文件。写文件/修改文件前会向我请求授权，你正常调用 write_file / edit_file / batch_replace 等工具即可。完成后简要汇报：处理了几个文件、分别输出到哪里。`
  );
}

document.getElementById('auto-start').addEventListener('click', async () => {
  setAutoMsg('');
  if (!auto.template) { setAutoMsg('请先选择模版文件或模版文件夹'); return; }
  if (!auto.files.length) { setAutoMsg('请先选择需编写文件'); return; }
  if (getAutoSaveMode() === 'output' && !autoOutputDir) { setAutoMsg('请先选择输出文件夹'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setAutoMsg('请先在「AI 设置」中配置并启用一个模型'); return; }

  const prompt = withAutoSkill(buildAutomationPrompt(), getAutoSkillName());
  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【文件自动化】按模版 + 规范处理 ${auto.files.length} 个文件`);
  chatHistory.push({ role: 'user', content: prompt });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在按模版与规范编写文件…';

  const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);

  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
    if (r.usage) {
      sessionUsage.input += r.usage.input;
      sessionUsage.output += r.usage.output;
      chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
    }
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ---- 本地「转换」：不经过 AI，按模版结构原样归类复制（绝不改动文件内容） ---- */
document.getElementById('auto-convert').addEventListener('click', async () => {
  setAutoMsg('');
  if (!auto.files.length) { setAutoMsg('请先选择需编写文件'); return; }
  const layout = document.getElementById('auto-layout').value; // template / flat / bytype
  if (layout === 'template' && (!auto.template || auto.template.kind !== 'folder')) {
    setAutoMsg('「按模版目录结构摆放」需要先选择模版文件夹；或改用平铺/按类型归类');
    return;
  }
  // 转换不改动原文件，必须输出到指定目录
  let outDir = autoOutputDir;
  if (!outDir) {
    outDir = await window.api.selectOutputDir();
    if (!outDir) { setAutoMsg('请先选择输出文件夹'); return; }
    autoOutputDir = outDir;
    document.getElementById('auto-output-dir').value = outDir;
    document.querySelector('input[name="auto-save-mode"][value="output"]').checked = true;
  }

  const btn = document.getElementById('auto-convert');
  btn.disabled = true; btn.textContent = '转换中…';
  const { results, summary } = await window.api.automationConvert(
    auto.template ? auto.template.kind : null,
    auto.template ? auto.template.folder : null,
    auto.files, outDir, layout
  );
  btn.disabled = false; btn.textContent = '⇄ 转换';

  const card = document.getElementById('auto-result-card');
  card.classList.remove('hidden');
  let sumText = `${summary.matched} 个需编写文件按模版结构归类复制到 ${outDir}（模版文件不包含在内）。`;
  if (summary.skipped) sumText += ` ${summary.skipped} 个文件模版无对应位置，已跳过。`;
  document.getElementById('auto-result-summary').textContent = sumText;
  const list = document.getElementById('auto-result-list');
  list.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + (r.status === 'skip' ? 'skip' : r.status);
    const labels = { done: '✔', error: '✖', skip: '⊘' };
    tag.textContent = (labels[r.status] || '') + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    list.appendChild(li);
  });
  setAutoMsg('');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ---- AI 协助转换：先本地转换，再由 AI 核对文件完整性 ---- */
document.getElementById('auto-ai-convert').addEventListener('click', async () => {
  setAutoMsg('');
  if (!auto.files.length) { setAutoMsg('请先选择需编写文件'); return; }
  const layout = document.getElementById('auto-layout').value;
  if (layout === 'template' && (!auto.template || auto.template.kind !== 'folder')) {
    setAutoMsg('「AI 协助转换」需要先选择模版文件夹'); return;
  }
  if (!(aiState.profiles.length && aiState.activeId)) { setAutoMsg('请先在「AI 设置」中配置并启用一个模型'); return; }

  // 输出目录
  let outDir = autoOutputDir;
  if (!outDir) {
    outDir = await window.api.selectOutputDir();
    if (!outDir) { setAutoMsg('请先选择输出文件夹'); return; }
    autoOutputDir = outDir;
    document.getElementById('auto-output-dir').value = outDir;
    document.querySelector('input[name="auto-save-mode"][value="output"]').checked = true;
  }

  // 第一步：本地转换（关键字匹配，只放需编写文件，模版文件不复制）
  const btn = document.getElementById('auto-ai-convert');
  btn.disabled = true; btn.textContent = '转换中…';
  const { results: convResults, summary } = await window.api.automationConvert(
    auto.template ? auto.template.kind : null,
    auto.template ? auto.template.folder : null,
    auto.files, outDir, layout
  );

  // 第二步：取模版与输出目录的文件清单对照
  btn.textContent = 'AI 核对中…';
  const chk = await window.api.automationCheck(
    auto.template && auto.template.kind === 'folder' ? auto.template.folder : null,
    outDir
  );
  btn.disabled = false; btn.textContent = '🤖 AI 协助转换';

  // 收集匹配/跳过的文件清单
  const matchedFiles = convResults
    .filter(r => r.matchType === 'matched')
    .map(r => `  ${r.templateRel} ← ${r.file}`);
  const skippedFiles = convResults
    .filter(r => r.status === 'skip')
    .map(r => `  ${r.file}`);

  const activeRules = auto.rules.filter((r) => r.enabled && r.value);
  const rulesDesc = activeRules.length
    ? activeRules.map((r, i) => `  ${i + 1}. [${r.type}] ${r.value}`).join('\n')
    : '  （未额外添加，主要参照模版结构）';

  // 第三步：交给 AI 核对文件摆放是否正确
  const prompt = withAutoSkill([
    '【文件自动化 · AI 协助转换 · 完整性核对】',
    `已按关键字把需编写文件匹配到模版对应位置并复制到输出目录（模版文件未复制）。请核对文件摆放是否正确。`,
    ``,
    `模版文件夹：${auto.template.folder}`,
    `输出目录：${outDir}`,
    `编写规范：`,
    rulesDesc,
    ``,
    `== 已匹配的需编写文件（${matchedFiles.length}）==`,
    matchedFiles.length ? matchedFiles.join('\n') : '（无）',
    ``,
    `== 跳过的需编写文件（模版无对应位置，${skippedFiles.length}）==`,
    skippedFiles.length ? skippedFiles.join('\n') : '（无）',
    ``,
    `== 模版文件清单（${chk.templateFiles.length}）==`,
    chk.templateFiles.length ? chk.templateFiles.join('\n') : '（无）',
    ``,
    `== 输出目录文件清单（${chk.outputFiles.length}）==`,
    chk.outputFiles.length ? chk.outputFiles.join('\n') : '（无）',
    ``,
    '请输出一份简洁的核对报告：',
    '1. 需编写文件是否都按模版结构正确摆放（关键字匹配是否合理）；',
    '2. 有无需编写文件被遗漏未放入输出目录；',
    '3. 跳过的文件是否确实在模版中无对应位置；',
    '4. 总体结论：完整 / 基本完整 / 有问题，并给出下一步建议。',
    '（本任务只做核对与报告，不要修改、移动或删除任何文件。）',
  ].join('\n'), getAutoSkillName());

  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【AI 协助转换】${summary.matched} 个匹配 + ${summary.skipped} 个跳过`);
  chatHistory.push({ role: 'user', content: prompt });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在核对文件摆放完整性…';

  const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);

  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
    if (r.usage) {
      sessionUsage.input += r.usage.input;
      sessionUsage.output += r.usage.output;
      chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
    }
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ================= PPT 写手（入口页 + 新编写/修改 子面板） ================= */
// 入口页切换
const pptEntryEl = document.getElementById('ppt-entry');
const pptNewPanelEl = document.getElementById('ppt-new-panel');
const pptEditPanelEl = document.getElementById('ppt-edit-panel');

function showPptView(view) {
  pptEntryEl.classList.toggle('hidden', view !== 'entry');
  pptNewPanelEl.classList.toggle('hidden', view !== 'new');
  pptEditPanelEl.classList.toggle('hidden', view !== 'edit');
}
document.getElementById('ppt-entry-new').addEventListener('click', () => showPptView('new'));
document.getElementById('ppt-entry-edit').addEventListener('click', () => showPptView('edit'));
document.getElementById('ppt-new-back').addEventListener('click', () => showPptView('entry'));
document.getElementById('ppt-edit-back').addEventListener('click', () => showPptView('entry'));

// 新编写 PPT 子面板
const pptNew = { template: null, outputDir: null };
const pptNewTemplateInfo = document.getElementById('ppt-new-template-info');
const pptNewOutputDirEl = document.getElementById('ppt-new-output-dir');
const pptNewMsgEl = document.getElementById('ppt-new-msg');
function setPptNewMsg(t) { pptNewMsgEl.textContent = t || ''; }

document.getElementById('ppt-new-pick-template').addEventListener('click', async () => {
  const files = await window.api.selectFiles(['ppt', 'pptx']);
  if (files && files.length) {
    pptNew.template = files[0];
    pptNewTemplateInfo.textContent = `模版 PPT：${pptNew.template}`;
    pptNewTemplateInfo.classList.remove('hidden');
    setPptNewMsg('');
  }
});
document.getElementById('ppt-new-clear-template').addEventListener('click', () => {
  pptNew.template = null;
  pptNewTemplateInfo.classList.add('hidden');
});
document.getElementById('ppt-new-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { pptNew.outputDir = dir; pptNewOutputDirEl.value = dir; setPptNewMsg(''); }
});

// 开始编写 → 跳转 AI 助手
document.getElementById('ppt-new-start').addEventListener('click', async () => {
  if (!pptNew.template) { setPptNewMsg('请先选择模版 PPT'); return; }
  if (!pptNew.outputDir) { setPptNewMsg('请选择保存地址'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setPptNewMsg('请先在「AI 设置」中配置并启用一个模型'); return; }

  const lines = [];
  lines.push('【新编写 PPT】请帮我从零编写一份新的 PPT（.pptx）。');
  lines.push('');
  lines.push(`模版文件（风格参照，不要修改它）：${pptNew.template}`);
  lines.push(`保存地址：${pptNew.outputDir}`);
  lines.push('');
  lines.push('要求：');
  lines.push('1. 先读取模版 PPT 的排版风格（版式、配色、字体、占位文字风格），作为新 PPT 的风格基准。');
  lines.push('2. 我会告诉你 PPT 的主题、页数、章节内容等，请按模版风格编写每一页。');
  lines.push('3. 编写完成后保存到指定目录，文件名按主题命名。');
  lines.push('');
  lines.push('请先告诉我：你想编写什么主题的 PPT？大概需要多少页？包含哪些章节或内容要点？');

  const prompt = withPptSkill(lines.join('\n'), getPptNewSkillName());
  switchPanel('ai');
  addBubble('user', '【新编写 PPT】选择模版，AI 按模版风格从零编写新 PPT');
  addBubble('assistant', prompt);
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ================= 修改 PPT（现有功能） ================= */
const ppt = { template: null, files: [], rules: [] };
let pptRuleSeq = 0;
let pptOutputDir = null;
const pptTemplateInfo = document.getElementById('ppt-template-info');
const pptFileListEl = document.getElementById('ppt-file-list');
const pptFileEmptyEl = document.getElementById('ppt-file-empty');
const pptFileCountEl = document.getElementById('ppt-file-count');
const pptRuleListEl = document.getElementById('ppt-rule-list');
const pptRuleEmptyEl = document.getElementById('ppt-rule-empty');
const pptRuleCountEl = document.getElementById('ppt-rule-count');
const pptMsgEl = document.getElementById('ppt-msg');
function setPptMsg(t) { pptMsgEl.textContent = t || ''; }

const PPT_EXTS = ['ppt', 'pptx'];

/* ---- ① 模版文件 ---- */
function renderPptTemplate() {
  if (!ppt.template) { pptTemplateInfo.classList.add('hidden'); pptTemplateInfo.textContent = ''; return; }
  pptTemplateInfo.classList.remove('hidden');
  pptTemplateInfo.textContent = '模版 PPT：' + ppt.template;
}
document.getElementById('ppt-pick-template').addEventListener('click', async () => {
  const files = await window.api.selectFiles(PPT_EXTS);
  if (!files.length) return;
  ppt.template = files[0];
  renderPptTemplate();
  setPptMsg('');
});
document.getElementById('ppt-clear-template').addEventListener('click', () => {
  ppt.template = null;
  renderPptTemplate();
});

/* ---- ② 需编写文件 ---- */
function renderPptFiles() {
  pptFileListEl.innerHTML = '';
  pptFileEmptyEl.style.display = ppt.files.length ? 'none' : 'block';
  pptFileCountEl.textContent = ppt.files.length;
  ppt.files.forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    pptFileListEl.appendChild(li);
  });
}
document.getElementById('ppt-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles(PPT_EXTS);
  if (!files.length) return;
  for (const f of files) if (!ppt.files.includes(f)) ppt.files.push(f);
  renderPptFiles();
  setPptMsg('');
});
document.getElementById('ppt-clear-files').addEventListener('click', () => {
  ppt.files = [];
  renderPptFiles();
});

/* ---- ③ 保存方式 ---- */
function getPptSaveMode() {
  return document.querySelector('input[name="ppt-save-mode"]:checked').value;
}
document.querySelectorAll('input[name="ppt-save-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    document.getElementById('ppt-output-row').style.opacity = getPptSaveMode() === 'output' ? '1' : '0.45';
  });
});
document.getElementById('ppt-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { pptOutputDir = dir; document.getElementById('ppt-output-dir').value = dir; }
});

/* ---- ④ 编写规范 ---- */
function renderPptRules() {
  pptRuleListEl.innerHTML = '';
  pptRuleEmptyEl.style.display = ppt.rules.length ? 'none' : 'block';
  pptRuleCountEl.textContent = ppt.rules.length;
  ppt.rules.forEach((rule) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'rule-enabled';
    cb.checked = rule.enabled;
    cb.title = '启用/停用该规范';
    cb.addEventListener('change', () => { rule.enabled = cb.checked; });

    const tag = document.createElement('span');
    tag.className = 'auto-rule-type-tag';
    tag.textContent = rule.type;

    const val = document.createElement('span');
    val.className = 'auto-rule-value';
    val.textContent = rule.value;

    const del = document.createElement('button');
    del.className = 'rule-del';
    del.textContent = '✕';
    del.title = '删除规范';
    del.addEventListener('click', () => {
      ppt.rules = ppt.rules.filter((r) => r.id !== rule.id);
      renderPptRules();
    });

    li.append(cb, tag, val, del);
    pptRuleListEl.appendChild(li);
  });
}
document.getElementById('ppt-add-rule').addEventListener('click', () => {
  const type = document.getElementById('ppt-rule-type').value;
  const valueInput = document.getElementById('ppt-rule-value');
  const value = valueInput.value.trim();
  if (!value) { valueInput.focus(); valueInput.placeholder = '规范内容不能为空！'; return; }
  ppt.rules.push({ id: ++pptRuleSeq, type, value, enabled: true });
  valueInput.value = '';
  valueInput.placeholder = '规范内容，如：公司名改为「某某科技」/ 第3页替换为模版第5页版式';
  renderPptRules();
});

/* ---- 构建 PPT 编写 prompt（让 AI 先详细询问） ---- */
function buildPptPrompt() {
  const useLayout = document.getElementById('ppt-use-layout').checked;
  const fillMissing = document.getElementById('ppt-fill-missing').checked;
  const saveMode = getPptSaveMode();
  const activeRules = ppt.rules.filter((r) => r.enabled && r.value);

  const lines = [];
  lines.push('【PPT 写手】依据模版与编写规范，帮我编写 PPT（.ppt / .pptx）。');
  lines.push('');
  if (ppt.template) {
    lines.push(`模版 PPT（参照，勿修改）：${ppt.template}`);
  }
  lines.push(`需编写 PPT（${ppt.files.length} 个）：`);
  ppt.files.forEach((f) => lines.push('  - ' + f));
  lines.push('');
  lines.push(`保存方式：${saveMode === 'overwrite' ? '覆盖原文件（直接改写）' : '输出到指定目录' + (pptOutputDir ? '：' + pptOutputDir : '（尚未选择，请先询问我输出目录）')}`);
  lines.push('');
  if (useLayout || fillMissing) {
    lines.push('依据模版的要求：');
    if (useLayout) lines.push('  · 添加模版文件的主要排版和文字——版式、字体、配色、占位文字风格对齐模版。');
    if (fillMissing) lines.push('  · 缺失内容和页面依据模版文件补全——模版有而需编写文件缺失的页面/内容，按模版补齐。');
    lines.push('');
  }
  if (activeRules.length) {
    lines.push(`编写规范（${activeRules.length} 条）：`);
    activeRules.forEach((r) => lines.push(`  · [${r.type}] ${r.value}`));
    lines.push('');
  }
  lines.push('⚠️ 重要——请先不要直接动手改文件。在开始之前，请先在聊天里详细询问我以下几点，等我确认后再执行：');
  lines.push('  1. 这次 PPT 主要想修改/编写了哪些内容？（主题、要表达的重点）');
  lines.push('  2. 修改的方向？（如：更简洁 / 更商务 / 补充数据 / 重做某几页）');
  lines.push('  3. 期望的风格？（配色、版式、字体感觉，是否严格沿用模版）');
  lines.push('  4. 有没有必须保留或必须替换的页面、公司名、logo 等？');
  lines.push('等我回答确认后，再用 read_file 读取模版与需编写文件，依据模版排版与上述规范编写，最后按保存方式保存。涉及写文件前请先向我请求授权。');
  return lines.join('\n');
}

/* ---- AI 助手编辑保存 ---- */
document.getElementById('ppt-ai-save').addEventListener('click', async () => {
  setPptMsg('');
  if (!ppt.files.length) { setPptMsg('请先选择需编写的 PPT 文件'); return; }
  if (getPptSaveMode() === 'output' && !pptOutputDir) { setPptMsg('请先选择输出文件夹'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setPptMsg('请先在「AI 设置」中配置并启用一个模型'); return; }

  const prompt = withPptSkill(buildPptPrompt(), getPptEditSkillName());
  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【PPT 写手】依据模版编写 ${ppt.files.length} 个 PPT 文件`);
  chatHistory.push({ role: 'user', content: prompt });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在了解你的 PPT 修改需求…';

  const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);

  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
    if (r.usage) {
      sessionUsage.input += r.usage.input;
      sessionUsage.output += r.usage.output;
      chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
    }
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ---- 手动保存（不经过 AI，字节级复制） ---- */
document.getElementById('ppt-manual-save').addEventListener('click', async () => {
  setPptMsg('');
  if (!ppt.files.length) { setPptMsg('请先选择需编写的 PPT 文件'); return; }
  const saveMode = getPptSaveMode();
  let outDir = pptOutputDir;
  if (saveMode === 'output' && !outDir) {
    outDir = await window.api.selectOutputDir();
    if (!outDir) { setPptMsg('请先选择输出文件夹'); return; }
    pptOutputDir = outDir;
    document.getElementById('ppt-output-dir').value = outDir;
  }

  const btn = document.getElementById('ppt-manual-save');
  btn.disabled = true; btn.textContent = '保存中…';
  const { results, summary } = await window.api.pptSave(ppt.files, saveMode, outDir);
  btn.disabled = false; btn.textContent = '💾 手动保存';

  const card = document.getElementById('ppt-result-card');
  card.classList.remove('hidden');
  document.getElementById('ppt-result-summary').textContent = saveMode === 'overwrite'
    ? `共 ${summary.total} 个文件，已就覆盖保存处理 ${summary.done} 个（原文件已备份到各自 .backup 目录）。`
    : `共 ${summary.total} 个文件，已原样保存 ${summary.done} 个到 ${outDir}（内容未做任何改动）。`;
  const list = document.getElementById('ppt-result-list');
  list.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + r.status;
    tag.textContent = ({ done: '✔', error: '✖' }[r.status] || '') + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    list.appendChild(li);
  });
  setPptMsg('');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ================= 文件名修改（批量重命名） ================= */
const rn = { files: [], rules: [], outputDir: null };
let rnRuleSeq = 0;
const rnFileListEl = document.getElementById('rename-file-list');
const rnFileEmptyEl = document.getElementById('rename-file-empty');
const rnFileCountEl = document.getElementById('rename-file-count');
const rnRuleListEl = document.getElementById('rename-rule-list');
const rnRuleEmptyEl = document.getElementById('rename-rule-empty');
const rnRuleCountEl = document.getElementById('rename-rule-count');
const rnMsgEl = document.getElementById('rename-msg');
function setRnMsg(t) { rnMsgEl.textContent = t || ''; }

function renderRnFiles() {
  rnFileListEl.innerHTML = '';
  rnFileEmptyEl.style.display = rn.files.length ? 'none' : 'block';
  rnFileCountEl.textContent = rn.files.length;
  rn.files.forEach((f) => { const li = document.createElement('li'); li.textContent = f; rnFileListEl.appendChild(li); });
}
document.getElementById('rename-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles();
  if (!files.length) return;
  for (const f of files) if (!rn.files.includes(f)) rn.files.push(f);
  renderRnFiles(); setRnMsg('');
});
document.getElementById('rename-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  setRnMsg('正在扫描文件夹…');
  rn.files = await window.api.scanFolder(folder, []);
  renderRnFiles(); setRnMsg(rn.files.length ? '' : '该文件夹下未扫描到文件');
});
document.getElementById('rename-clear-files').addEventListener('click', () => { rn.files = []; renderRnFiles(); });

function renderRnRules() {
  rnRuleListEl.innerHTML = '';
  rnRuleEmptyEl.style.display = rn.rules.length ? 'none' : 'block';
  rnRuleCountEl.textContent = rn.rules.length;
  rn.rules.forEach((rule) => {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'rule-enabled'; cb.checked = rule.enabled; cb.title = '启用/停用该规则';
    cb.addEventListener('change', () => { rule.enabled = cb.checked; });
    const body = document.createElement('div');
    body.className = 'rule-body';
    const title = document.createElement('div'); title.className = 'rule-title'; title.textContent = rule.name;
    const detail = document.createElement('div'); detail.className = 'rule-detail';
    const findSpan = document.createElement('span'); findSpan.textContent = truncate(rule.find, 30);
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
    const repSpan = document.createElement('span'); repSpan.textContent = truncate(rule.replace || '（删除）', 30);
    detail.append(findSpan, arrow, repSpan); body.append(title, detail);
    const del = document.createElement('button');
    del.className = 'rule-del'; del.textContent = '✕'; del.title = '删除规则';
    del.addEventListener('click', () => { rn.rules = rn.rules.filter((r) => r.id !== rule.id); renderRnRules(); });
    li.append(cb, body, del);
    rnRuleListEl.appendChild(li);
  });
}
document.getElementById('rename-add-rule').addEventListener('click', () => {
  const find = document.getElementById('rename-rule-find').value;
  if (!find) { document.getElementById('rename-rule-find').focus(); return; }
  const name = document.getElementById('rename-rule-name').value.trim() || `规则 ${rn.rules.length + 1}`;
  rn.rules.push({ id: ++rnRuleSeq, name, find, replace: document.getElementById('rename-rule-replace').value, enabled: true });
  document.getElementById('rename-rule-name').value = '';
  document.getElementById('rename-rule-find').value = '';
  document.getElementById('rename-rule-replace').value = '';
  renderRnRules();
});

function getRnSaveMode() { return document.querySelector('input[name="rename-save-mode"]:checked').value; }
document.querySelectorAll('input[name="rename-save-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    document.getElementById('rename-output-row').style.opacity = getRnSaveMode() === 'copy' ? '1' : '0.45';
  });
});
document.getElementById('rename-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { rn.outputDir = dir; document.getElementById('rename-output-dir').value = dir; }
});

document.getElementById('rename-start').addEventListener('click', async () => {
  setRnMsg('');
  const activeRules = rn.rules.filter((r) => r.enabled && r.find);
  if (!rn.files.length) { setRnMsg('请先选择要重命名的文件'); return; }
  if (!activeRules.length) { setRnMsg('请至少添加并启用一条规则'); return; }
  const saveMode = getRnSaveMode();
  if (saveMode === 'copy' && !rn.outputDir) { setRnMsg('请先选择输出文件夹'); return; }
  const btn = document.getElementById('rename-start');
  btn.disabled = true; btn.textContent = '处理中…';
  const { results, summary } = await window.api.renameFiles(rn.files, activeRules, saveMode, rn.outputDir);
  btn.disabled = false; btn.textContent = '▶ 开始重命名';
  const card = document.getElementById('rename-result-card');
  card.classList.remove('hidden');
  document.getElementById('rename-result-summary').textContent = `共 ${summary.total} 个文件，成功重命名 ${summary.done} 个。`;
  const list = document.getElementById('rename-result-list');
  list.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + r.status;
    tag.textContent = ({ done: '✔', nochange: '—', error: '✖' }[r.status] || '') + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    list.appendChild(li);
  });
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ================= 文件格式转换 ================= */
const cv = { files: [], outputDir: null, sourceFolder: null };
const cvFileListEl = document.getElementById('conv-file-list');
const cvFileEmptyEl = document.getElementById('conv-file-empty');
const cvFileCountEl = document.getElementById('conv-file-count');
const cvMsgEl = document.getElementById('conv-msg');
const cvSrcSel = document.getElementById('conv-src');
const cvDstSel = document.getElementById('conv-dst');
function setCvMsg(t) { cvMsgEl.textContent = t || ''; }

// 源格式（含自动识别）与目标格式
const CV_SRC_FORMATS = [
  { v: 'auto', t: '按文件自动识别' },
  { v: 'pdf', t: 'PDF（.pdf）' },
  { v: 'docx', t: 'Word（.docx）' }, { v: 'doc', t: 'Word 97（.doc）' },
  { v: 'rtf', t: '富文本（.rtf）' }, { v: 'odt', t: 'OpenDocument（.odt）' },
  { v: 'html', t: '网页（.html）' }, { v: 'txt', t: '纯文本（.txt）' },
  { v: 'md', t: 'Markdown（.md）' }, { v: 'json', t: 'JSON（.json）' }, { v: 'csv', t: 'CSV（.csv）' },
];
const CV_DST_FORMATS = [
  { v: 'pdf', t: 'PDF（.pdf）' },
  { v: 'docx', t: 'Word（.docx）' }, { v: 'doc', t: 'Word 97（.doc）' },
  { v: 'rtf', t: '富文本（.rtf）' }, { v: 'odt', t: 'OpenDocument（.odt）' },
  { v: 'html', t: '网页（.html）' }, { v: 'txt', t: '纯文本（.txt）' },
  { v: 'md', t: 'Markdown（.md）' }, { v: 'csv', t: 'CSV（.csv）' }, { v: 'json', t: 'JSON（.json）' },
];
const CONV_SKILLS = [
  { v: 'document-converter', t: 'document-converter（文档格式转换·默认）' },
  { v: 'pdf-to-office', t: 'pdf-to-office（PDF ⇄ Office/图片/文本）' },
  { v: 'pdf-compress', t: 'pdf-compress（PDF 压缩）' },
  { v: 'pdf-merge-split', t: 'pdf-merge-split（PDF 合并/拆分/提取）' },
  { v: 'local', t: '本地引擎（快速，不依赖 AI）' },
];
function populateConvFormats() {
  CV_SRC_FORMATS.forEach((f) => { const o = document.createElement('option'); o.value = f.v; o.textContent = f.t; cvSrcSel.appendChild(o); });
  CV_DST_FORMATS.forEach((f) => { const o = document.createElement('option'); o.value = f.v; o.textContent = f.t; cvDstSel.appendChild(o); });
  cvDstSel.value = 'txt';
  const cvSkillSel = document.getElementById('conv-skill');
  if (cvSkillSel) {
    CONV_SKILLS.forEach((s) => { const o = document.createElement('option'); o.value = s.v; o.textContent = s.t; cvSkillSel.appendChild(o); });
    cvSkillSel.value = 'document-converter';
  }
}

// PDF 引擎信息（启动时拉一次缓存）
let pdfEnginesInfo = { byExt: {}, available: { libreoffice: false, pages: false, numbers: false } };
async function loadPdfEngineInfo() {
  try { pdfEnginesInfo = await window.api.pdfEngineInfo() || pdfEnginesInfo; }
  catch (e) { console.warn('pdfEngineInfo failed', e); }
  updateEngineTip();
}
function updateEngineTip() {
  const tipEl = document.getElementById('conv-engine-tip');
  if (!tipEl) return;
  if (cvDstSel.value !== 'pdf') { tipEl.style.display = 'none'; tipEl.textContent = ''; return; }
  const src = cvSrcSel.value;
  const byExt = pdfEnginesInfo.byExt || {};
  if (src && src !== 'auto') {
    const label = byExt[src] || 'textutil+HTML';
    tipEl.className = 'wizard-tip engine-' + label.toLowerCase().replace(/[+ ]/g, '-');
    tipEl.textContent = `→ PDF 将用 ${label} 引擎渲染（高保真保留字体/表格）`;
  } else {
    // auto：汇总最常见的几个
    const parts = [];
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      const l = byExt[ext]; if (l && !parts.includes(l)) parts.push(l);
    }
    const label = parts.length ? parts.join(' / ') : 'textutil+HTML';
    tipEl.className = 'wizard-tip engine-' + parts[0]?.toLowerCase().replace(/[+ ]/g, '-') || 'engine-textutil-html';
    tipEl.textContent = `→ PDF 引擎：${label}（按源格式自动选最佳）`;
  }
  tipEl.style.display = '';
}
cvDstSel.addEventListener('change', updateEngineTip);
cvSrcSel.addEventListener('change', updateEngineTip);

function renderCvFiles() {
  cvFileListEl.innerHTML = '';
  cvFileEmptyEl.style.display = cv.files.length ? 'none' : 'block';
  cvFileCountEl.textContent = cv.files.length;
  cv.files.forEach((f) => { const li = document.createElement('li'); li.textContent = f; cvFileListEl.appendChild(li); });
}
document.getElementById('conv-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles(['pdf', 'docx', 'doc', 'rtf', 'odt', 'html', 'txt', 'md', 'json', 'csv']);
  if (!files.length) return;
  cv.sourceFolder = null;
  for (const f of files) if (!cv.files.includes(f)) cv.files.push(f);
  renderCvFiles(); setCvMsg('');
});
document.getElementById('conv-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  setCvMsg('正在扫描文件夹…');
  cv.sourceFolder = folder;
  cv.files = await window.api.scanFolder(folder, []);
  renderCvFiles(); setCvMsg(cv.files.length ? '' : '该文件夹下未扫描到文件');
});
document.getElementById('conv-clear-files').addEventListener('click', () => { cv.files = []; cv.sourceFolder = null; renderCvFiles(); });

function getCvSaveMode() { return document.querySelector('input[name="conv-save-mode"]:checked').value; }
document.querySelectorAll('input[name="conv-save-mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    document.getElementById('conv-output-row').style.opacity = getCvSaveMode() === 'output' ? '1' : '0.45';
  });
});
document.getElementById('conv-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { cv.outputDir = dir; document.getElementById('conv-output-dir').value = dir; }
});

document.getElementById('conv-start').addEventListener('click', async () => {
  setCvMsg('');
  if (!cv.files.length) { setCvMsg('请先选择要转换的文件'); return; }
  const cvSkillSel = document.getElementById('conv-skill');
  const skill = cvSkillSel ? (cvSkillSel.value || 'local') : 'local';
  if (skill && skill !== 'local') { await aiConvertWithSkill(skill); return; }
  const saveMode = getCvSaveMode();
  if (saveMode === 'output' && !cv.outputDir) { setCvMsg('请先选择输出文件夹'); return; }
  const btn = document.getElementById('conv-start');
  btn.disabled = true; btn.textContent = '转换中…';
  const keepStructure = document.getElementById('conv-keep-structure').checked;
  const { results, summary } = await window.api.convertFiles(
    cv.files, cvSrcSel.value, cvDstSel.value, saveMode, cv.outputDir, cv.sourceFolder, keepStructure
  );
  btn.disabled = false; btn.textContent = '▶ 开始转换';
  const card = document.getElementById('conv-result-card');
  card.classList.remove('hidden');
  document.getElementById('conv-result-summary').textContent = `共 ${summary.total} 个文件，成功转换 ${summary.done} 个。`;
  const list = document.getElementById('conv-result-list');
  list.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + r.status;
    tag.textContent = ({ done: '✔', error: '✖' }[r.status] || '') + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    list.appendChild(li);
  });
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ---- 技能驱动转换：用选定技能经 AI 代理执行转换 ---- */
async function aiConvertWithSkill(skillName) {
  setCvMsg('');
  if (!cv.files.length) { setCvMsg('请先选择要转换的文件'); return; }
  const saveMode = getCvSaveMode();
  if (saveMode === 'output' && !cv.outputDir) { setCvMsg('请先选择输出文件夹'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setCvMsg('请先在「AI 设置」中配置并启用一个模型'); return; }
  const keepStructure = document.getElementById('conv-keep-structure').checked;
  const srcDesc = cvSrcSel.value === 'auto' ? '按每个文件实际格式' : cvSrcSel.value;
  const dstDesc = cvDstSel.value;
  const saveDesc = saveMode === 'output'
    ? `转换后输出到目录 ${cv.outputDir}${keepStructure && cv.sourceFolder ? `，并按源文件夹 ${cv.sourceFolder} 的子目录结构复刻层级` : ''}（不要改动原文件）`
    : '转换后保存到源文件所在文件夹（新扩展名，不覆盖原文件）';
  const fileList = cv.files.slice(0, 300).join('\n');
  const prompt =
    `请使用「${skillName}」技能完成本次文件格式转换：把以下 ${cv.files.length} 个文件从「${srcDesc}」转换成「${dstDesc}」格式。\n` +
    `第一步：调用 skill 工具加载「${skillName}」技能，获取其详细操作指引，并严格按指引执行。\n\n` +
    `要求：\n` +
    `1. 逐个读取/处理每个源文件，转换成目标格式，保持原有结构与样式、内容一致。\n` +
    `2. ${saveDesc}。\n` +
    `3. 写文件/修改文件前会向我请求授权，你正常调用 write_file / edit_file / run_command 即可。\n\n` +
    `文件列表：\n${fileList}\n\n` +
    `全部转换完成后，简要汇报处理了几个文件、分别输出到哪里、是否遇到无法转换的文件。`;
  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【AI 格式转换 · ${skillName}】${cv.files.length} 个文件 ${srcDesc} → ${dstDesc}`);
  chatHistory.push({ role: 'user', content: prompt });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在转换文件…';
  const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);
  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
}

/* ---- AI 助手转换 ---- */
document.getElementById('conv-ai-start').addEventListener('click', async () => {
  setCvMsg('');
  if (!cv.files.length) { setCvMsg('请先选择要转换的文件'); return; }
  const saveMode = getCvSaveMode();
  if (saveMode === 'output' && !cv.outputDir) { setCvMsg('请先选择输出文件夹'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setCvMsg('请先在「AI 设置」中配置并启用一个模型'); return; }
  const keepStructure = document.getElementById('conv-keep-structure').checked;
  const srcDesc = cvSrcSel.value === 'auto' ? '按每个文件实际格式' : cvSrcSel.value;
  const dstDesc = cvDstSel.value;
  const saveDesc = saveMode === 'output'
    ? `转换后输出到目录 ${cv.outputDir}${keepStructure && cv.sourceFolder ? `，并按源文件夹 ${cv.sourceFolder} 的子目录结构复刻层级` : ''}（不要改动原文件）`
    : '转换后保存到源文件所在文件夹（新扩展名，不覆盖原文件）';
  const fileList = cv.files.slice(0, 300).join('\n');
  const prompt =
    `请执行批量格式转换：把以下 ${cv.files.length} 个文件从「${srcDesc}」转换成「${dstDesc}」格式。\n\n` +
    `要求：\n` +
    `1. 逐个用 read_file 读取每个源文件内容，理解后转换成目标格式（保持原有结构与样式，内容一致）。\n` +
    `2. ${saveDesc}。\n` +
    `3. 写文件/修改文件前会向我请求授权，你正常调用 write_file / edit_file 即可。\n\n` +
    `文件列表：\n${fileList}\n\n` +
    `全部转换完成后，简要汇报处理了几个文件、分别输出到哪里。`;
  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【AI 格式转换】${cv.files.length} 个文件 ${srcDesc} → ${dstDesc}`);
  chatHistory.push({ role: 'user', content: prompt });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在转换文件…';
  const r = await window.api.aiChat(chatHistory.slice(0, -1), prompt);
  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ================= PDF 去水印 ================= */
const wm = { files: [], outputDir: null, candidates: [] };
const wmFileListEl = document.getElementById('wm-file-list');
const wmFileEmptyEl = document.getElementById('wm-file-empty');
const wmFileCountEl = document.getElementById('wm-file-count');
const wmCandListEl = document.getElementById('wm-cand-list');
const wmCandEmptyEl = document.getElementById('wm-cand-empty');
const wmCandCountEl = document.getElementById('wm-cand-count');
const wmMsgEl = document.getElementById('wm-msg');
function setWmMsg(t) { wmMsgEl.textContent = t || ''; }

const WM_KEYWORDS = ['水印', '机密', '保密', '秘密', '内部资料', '内部', '严禁', '禁止', '仅供', '仅限', '草案', '试阅', '样品', '样本', '请勿', '不得', '翻印', '版权', 'draft', 'confidential', 'secret', 'sample', 'watermark', 'internal', 'private', 'do not copy'];

// PDF 去水印：自动列出与「PDF 去水印」相关技能（内置+已安装），默认 pdf-watermark-remover
const WM_SKILL_KEYWORDS = ['watermark', '水印', 'wm-remove', 'wmremove', 'pdf-wm'];
async function populateWmSkill() {
  const sel = document.getElementById('wm-skill');
  if (!sel) return;
  sel.innerHTML = '<option value="">（不指定技能，按默认流程）</option>';
  const map = new Map();
  try {
    const { builtin = [], installed = [] } = await window.api.skillsList();
    const match = (s) => WM_SKILL_KEYWORDS.some((k) => (s.name + ' ' + (s.description || '')).toLowerCase().includes(k));
    for (const b of builtin) if (match(b)) map.set(b.name, { name: b.name, source: 'builtin' });
    for (const i of installed) if (match(i)) map.set(i.name, { name: i.name, source: 'installed' });
  } catch (e) { /* 拉取失败则只保留默认项 */ }
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = s.name + (s.source === 'installed' ? '（已安装）' : '（内置）');
    sel.appendChild(o);
  }
  if (map.has('pdf-watermark-remover')) sel.value = 'pdf-watermark-remover';
}
function getWmSkillName() {
  const sel = document.getElementById('wm-skill');
  return sel ? sel.value : '';
}
function withWmSkill(prompt, skillName) {
  if (!skillName) return prompt;
  return `请先调用 skill 工具加载「${skillName}」技能，获取其详细操作指引，并严格按指引执行本「PDF 去水印」任务。\n\n` + prompt;
}

// PPT 写手：新编写 / 修改 两个子面板共用的「PPT 相关技能」下拉
const PPT_SKILL_KEYWORDS = ['ppt', 'pptx', 'kimi', 'presentation', '演示', '幻灯片', 'open-kimi'];
async function populatePptSkill() {
  const sels = ['ppt-new-skill', 'ppt-edit-skill'].map((id) => document.getElementById(id)).filter(Boolean);
  if (!sels.length) return;
  const map = new Map();
  try {
    const { builtin = [], installed = [] } = await window.api.skillsList();
    const match = (s) => PPT_SKILL_KEYWORDS.some((k) => (s.name + ' ' + (s.description || '')).toLowerCase().includes(k));
    for (const b of builtin) if (match(b)) map.set(b.name, { name: b.name, source: 'builtin' });
    for (const i of installed) if (match(i)) map.set(i.name, { name: i.name, source: 'installed' });
  } catch (e) { /* 拉取失败则只保留默认项 */ }
  for (const sel of sels) {
    sel.innerHTML = '<option value="">（不指定技能，按默认流程）</option>';
    const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const s of list) {
      const o = document.createElement('option');
      o.value = s.name;
      o.textContent = s.name + (s.source === 'installed' ? '（已安装）' : '（内置）');
      sel.appendChild(o);
    }
    if (map.has('open-kimi-ppt')) sel.value = 'open-kimi-ppt';
  }
}
function getPptNewSkillName() {
  const sel = document.getElementById('ppt-new-skill');
  return sel ? sel.value : '';
}
function getPptEditSkillName() {
  const sel = document.getElementById('ppt-edit-skill');
  return sel ? sel.value : '';
}
function withPptSkill(prompt, skillName) {
  if (!skillName) return prompt;
  return `请先调用 skill 工具加载「${skillName}」技能，获取其详细操作指引，并严格按指引执行本 PPT 任务。\n\n` + prompt;
}

function renderWmFiles() {
  wmFileListEl.innerHTML = '';
  wmFileEmptyEl.style.display = wm.files.length ? 'none' : 'block';
  wmFileCountEl.textContent = wm.files.length;
  wm.files.forEach((f) => { const li = document.createElement('li'); li.textContent = f; wmFileListEl.appendChild(li); });
}
document.getElementById('wm-pick-files').addEventListener('click', async () => {
  const files = await window.api.selectFiles(['pdf']); // 只允许选 PDF
  if (!files.length) return;
  const pdfs = files.filter((f) => extOf(f) === 'pdf');
  if (!pdfs.length) { setWmMsg('所选文件中没有 PDF'); return; }
  for (const f of pdfs) if (!wm.files.includes(f)) wm.files.push(f);
  renderWmFiles(); setWmMsg(pdfs.length < files.length ? '已过滤掉非 PDF 文件' : '');
});
document.getElementById('wm-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  setWmMsg('正在扫描文件夹…');
  const files = await window.api.scanFolder(folder, ['pdf']);
  wm.files = files;
  renderWmFiles(); setWmMsg(files.length ? '' : '该文件夹下未找到 PDF');
});
document.getElementById('wm-clear-files').addEventListener('click', () => { wm.files = []; renderWmFiles(); });

function renderWmCandidates() {
  wmCandListEl.innerHTML = '';
  wmCandEmptyEl.style.display = wm.candidates.length ? 'none' : 'block';
  wmCandCountEl.textContent = wm.candidates.length;
  wm.candidates.forEach((c) => {
    const li = document.createElement('li');
    if (c.marked) li.className = 'marked';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = c.marked; cb.title = '勾选=删除该水印';
    cb.addEventListener('change', () => { c.marked = cb.checked; li.className = c.marked ? 'marked' : ''; });
    const txt = document.createElement('span');
    txt.className = 'wm-cand-text'; txt.textContent = c.text;
    const badge = document.createElement('span');
    badge.className = 'wm-cand-count-badge'; badge.textContent = `${c.count} 处`;
    li.append(cb, txt, badge);
    wmCandListEl.appendChild(li);
  });
}

document.getElementById('wm-analyze').addEventListener('click', async () => {
  if (!wm.files.length) { setWmMsg('请先选择 PDF 文件'); return; }
  setWmMsg('正在分析水印…');
  const r = await window.api.pdfAnalyzeWatermark(wm.files);
  wm.candidates = (r.candidates || []).map((c) => ({ ...c, marked: false }));
  renderWmCandidates();
  if (r.errors && r.errors.length) setWmMsg(`已分析，${r.errors.length} 个文件无法解析`);
  else setWmMsg(wm.candidates.length ? '' : '未检测到文字内容');
});

// AI 分析：启发式预勾选 + 交给 AI 给出判断
document.getElementById('wm-ai-analyze').addEventListener('click', async () => {
  if (!wm.files.length) { setWmMsg('请先选择 PDF 文件'); return; }
  if (!wm.candidates.length) {
    setWmMsg('正在分析水印…');
    const r = await window.api.pdfAnalyzeWatermark(wm.files);
    wm.candidates = (r.candidates || []).map((c) => ({ ...c, marked: false }));
  }
  // 启发式：命中水印关键词 或 多处出现 → 预勾选
  wm.candidates.forEach((c) => {
    const low = c.text.toLowerCase();
    c.marked = WM_KEYWORDS.some((k) => low.includes(k.toLowerCase())) || c.count >= 2;
  });
  renderWmCandidates();
  setWmMsg('已按关键词/频次预勾选，可在下方调整；下方同时请 AI 给出判断');

  // 交给 AI 给意见（切到 AI 面板展示）
  if (aiState.profiles.length && aiState.activeId) {
    const list = wm.candidates.slice(0, 40).map((c) => `- "${c.text}"（出现 ${c.count} 处）`).join('\n');
    const prompt = `我从 PDF 中提取到以下文本片段，请判断哪些最可能是需要删除的“水印”文字（如机密/内部/样品/draft 等标记），哪些可能是正文应保留。请只输出一个“应删除”的清单（每行一条原文），没有就说“无”。\n\n${list}`;
    switchPanel('ai');
    setSending(true);
    ensureActiveChat();
    addBubble('user', '【PDF去水印】请帮我判断哪些是水印');
    chatHistory.push({ role: 'user', content: prompt });
    currentAssistantBubble = null;
    chatStatusEl.textContent = 'AI 正在分析水印…';
    const r2 = await window.api.aiChat(chatHistory.slice(0, -1), prompt);
    chatStatusEl.textContent = '';
    if (!r2.ok) addBubble('assistant', '出错了：' + (r2.error || '未知错误'));
    else {
      const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
      const last = bubbles[bubbles.length - 1];
      chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
    }
    currentAssistantBubble = null;
    setSending(false);
    persistCurrentChat();
    saveChats();
  }
});

document.getElementById('wm-pick-output').addEventListener('click', async () => {
  const dir = await window.api.selectOutputDir();
  if (dir) { wm.outputDir = dir; document.getElementById('wm-output-dir').value = dir; }
});

document.getElementById('wm-start').addEventListener('click', async () => {
  setWmMsg('');
  if (!wm.files.length) { setWmMsg('请先选择 PDF 文件'); return; }
  const marks = wm.candidates.filter((c) => c.marked).map((c) => c.text);
  if (!marks.length) { setWmMsg('请先勾选要删除的水印项'); return; }
  if (!wm.outputDir) { setWmMsg('请先选择输出文件夹'); return; }
  const btn = document.getElementById('wm-start');
  btn.disabled = true; btn.textContent = '处理中…';
  const { results, summary } = await window.api.pdfRemoveWatermark(wm.files, marks, wm.outputDir);
  btn.disabled = false; btn.textContent = '▶ 去除水印';
  const card = document.getElementById('wm-result-card');
  card.classList.remove('hidden');
  document.getElementById('wm-result-summary').textContent = `共 ${summary.total} 个 PDF，成功处理 ${summary.done} 个。`;
  const list = document.getElementById('wm-result-list');
  list.innerHTML = '';
  results.forEach((r) => {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'st-' + r.status;
    tag.textContent = ({ done: '✔', error: '✖' }[r.status] || '') + ' ';
    li.append(tag, document.createTextNode(r.file + '　' + r.message));
    list.appendChild(li);
  });
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/* ---- AI 去水印：加载所选技能，由 AI 代理按技能指引移除 PDF 水印 ---- */
document.getElementById('wm-ai-remove').addEventListener('click', async () => {
  setWmMsg('');
  if (!wm.files.length) { setWmMsg('请先选择 PDF 文件'); return; }
  if (!wm.outputDir) { setWmMsg('请先选择输出文件夹'); return; }
  if (!(aiState.profiles.length && aiState.activeId)) { setWmMsg('请先在「AI 设置」中配置并启用一个模型'); return; }
  const marks = wm.candidates.filter((c) => c.marked);
  const markList = marks.length ? marks.map((c) => `- ${c.text}`).join('\n') : '';
  const fileList = wm.files.slice(0, 300).join('\n');
  const skillName = getWmSkillName();
  const prompt = [
    '【PDF 去水印 · AI 处理】',
    `请对以下 ${wm.files.length} 个 PDF 执行去水印处理，结果输出到目录：${wm.outputDir}（不改动原文件）。`,
    '',
    '== 待处理 PDF ==',
    fileList,
    '',
    marks.length
      ? `== 用户已勾选要删除的水印文字（务必删除这些）==\n${markList}`
      : '== 水印清单 ==\n未预先分析，请先用 pdftotext / pypdf 扫描每页文本，识别疑似水印（如 机密/内部/样品/draft/confidential 等标记、多次重复出现的文字），列出候选请用户确认后再删除。',
    '',
    '要求：删除上述水印文字后重新生成 PDF；完成后简要汇报每个文件处理了哪些水印、输出到哪里。',
  ].join('\n');
  const full = withWmSkill(prompt, skillName);
  switchPanel('ai');
  setSending(true);
  ensureActiveChat();
  addBubble('user', `【AI 去水印】${wm.files.length} 个 PDF → ${wm.outputDir}${skillName ? ' · ' + skillName : ''}`);
  chatHistory.push({ role: 'user', content: full });
  currentAssistantBubble = null;
  chatStatusEl.textContent = 'AI 正在去水印…';
  const r = await window.api.aiChat(chatHistory.slice(0, -1), full);
  chatStatusEl.textContent = '';
  if (!r.ok) {
    addBubble('assistant', '出错了：' + (r.error || '未知错误'));
  } else {
    const bubbles = [...chatMessagesEl.querySelectorAll('.chat-msg.assistant .chat-bubble')];
    const last = bubbles[bubbles.length - 1];
    chatHistory.push({ role: 'assistant', content: last ? last.textContent : '' });
    if (r.usage) {
      sessionUsage.input += r.usage.input;
      sessionUsage.output += r.usage.output;
      chatUsageEl.textContent = `本次会话 token：输入 ${sessionUsage.input.toLocaleString()} / 输出 ${sessionUsage.output.toLocaleString()}`;
    }
  }
  currentAssistantBubble = null;
  setSending(false);
  persistCurrentChat();
  saveChats();
});

/* ================= 智能体技能管理 ================= */
const SKILL_BADGES = [
  [/format|convert|转换/i, '⤨'], [/image|img|图/i, '🖼️'], [/terminal|command|命令/i, '⌨️'],
  [/pdf/i, '📄'], [/excel|xlsx|sheet/i, '📊'], [/word|docx/i, '📝'],
  [/batch|批量/i, '📦'], [/polish|润色/i, '✨'], [/reformat|排版/i, '📐'],
  [/summarize|概览/i, '🔎'], [/rename|更名/i, '✎'], [/agent|代理/i, '🤖'],
];
function skillBadge(name) {
  for (const [re, icon] of SKILL_BADGES) if (re.test(name)) return icon;
  return '🧩';
}

const skillListEl = document.getElementById('skill-list');
const skillCountEl = document.getElementById('skill-count');

function makeSkillItem({ badge, name, desc, tag, tagClass, actions }) {
  const li = document.createElement('li');
  li.className = 'skill-item';
  const b = document.createElement('div'); b.className = 'skill-badge'; b.textContent = badge;
  const info = document.createElement('div'); info.className = 'skill-info';
  const n = document.createElement('div'); n.className = 'skill-name'; n.textContent = name;
  const d = document.createElement('div'); d.className = 'skill-desc'; d.textContent = desc; d.title = desc;
  info.append(n, d);
  li.append(b, info);
  if (tag) {
    const t = document.createElement('span'); t.className = 'skill-tag' + (tagClass ? ' ' + tagClass : ''); t.textContent = tag;
    li.appendChild(t);
  }
  if (actions && actions.length) {
    const act = document.createElement('div'); act.className = 'skill-actions';
    actions.forEach((a) => act.appendChild(a));
    li.appendChild(act);
  }
  return li;
}

async function renderSkills() {
  const { builtin, installed } = await window.api.skillsList();
  skillListEl.innerHTML = '';
  skillCountEl.textContent = builtin.length + installed.length;
  const mkDel = (name) => {
    const btn = document.createElement('button');
    btn.className = 'btn small ghost'; btn.textContent = '删除';
    btn.addEventListener('click', async () => { await window.api.skillsDelete(name); renderSkills(); });
    return btn;
  };
  builtin.forEach((s) => skillListEl.appendChild(makeSkillItem({
    badge: skillBadge(s.name), name: s.name, desc: s.description, tag: s.source === 'preset' ? '预置' : '内置',
  })));
  installed.forEach((s) => skillListEl.appendChild(makeSkillItem({
    badge: skillBadge(s.name), name: s.name, desc: s.description, tag: '已安装', tagClass: 'ext', actions: [mkDel(s.name)],
  })));
  if (!builtin.length && !installed.length) {
    skillListEl.innerHTML = '<p class="empty">暂无技能</p>';
  }
}

// 当前正在安装的按钮（用于接收进度推送）
let currentSkillInstallBtn = null;
let currentSkillInstallName = null;
window.api.onSkillInstallProgress((info) => {
  if (!currentSkillInstallBtn || currentSkillInstallName !== info.name) return;
  const mb = (info.bytes / 1024 / 1024).toFixed(1);
  currentSkillInstallBtn.textContent = info.retry ? '重试中…' : `下载中 ${mb}MB…`;
});

/* ---- 推荐技能（一键安装） ---- */
const skillRecommendedListEl = document.getElementById('skill-recommended-list');
async function renderRecommendedSkills() {
  const items = await window.api.skillsListRecommended();
  skillRecommendedListEl.innerHTML = '';
  items.forEach((s) => {
    const actions = [];
    if (s.installed) {
      actions.push(Object.assign(document.createElement('span'), { className: 'skill-tag ext', textContent: '已安装' }));
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn small primary'; btn.textContent = '安装';
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '准备下载…';
        currentSkillInstallBtn = btn;
        currentSkillInstallName = s.name;
        try {
          const res = await window.api.skillsInstallRecommended(s.name);
          if (res.ok) {
            btn.textContent = '✓ 已安装';
            renderSkills();
            renderRecommendedSkills();
          } else {
            btn.disabled = false; btn.textContent = '安装';
            alert('安装失败：' + res.error);
          }
        } catch (e) {
          btn.disabled = false; btn.textContent = '安装';
          alert('安装异常：' + e.message);
        } finally {
          currentSkillInstallBtn = null;
          currentSkillInstallName = null;
        }
      });
      actions.push(btn);
    }
    skillRecommendedListEl.appendChild(makeSkillItem({
      badge: skillBadge(s.name), name: s.name, desc: s.description,
      tag: s.installed ? null : (s.repo ? 'GitHub' : s.category), tagClass: 'cat', actions,
    }));
  });
  if (!items.length) {
    skillRecommendedListEl.innerHTML = '<p class="empty">暂无推荐技能</p>';
  }
}

/* ---- 在线查找 ---- */
const skillSearchListEl = document.getElementById('skill-search-list');
const skillSearchStatusEl = document.getElementById('skill-search-status');
document.getElementById('skill-search-btn').addEventListener('click', async () => {
  const kw = document.getElementById('skill-search-input').value.trim();
  if (!kw) { skillSearchStatusEl.textContent = '请先输入技能类别关键词'; return; }
  skillSearchStatusEl.textContent = '正在 GitHub 上搜索…';
  skillSearchListEl.innerHTML = '';
  const r = await window.api.skillsSearchGithub(kw);
  if (!r.ok) { skillSearchStatusEl.textContent = '搜索失败：' + r.error; return; }
  skillSearchStatusEl.textContent = r.items.length ? `找到 ${r.items.length} 个相关仓库` : '未找到相关仓库，换个关键词试试';
  r.items.forEach((it) => {
    const btn = document.createElement('button');
    btn.className = 'btn small primary'; btn.textContent = '下载并安装';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '准备下载…';
      currentSkillInstallBtn = btn;
      currentSkillInstallName = it.fullName;
      try {
        const res = await window.api.skillsInstallGithub(it.fullName, it.defaultBranch);
        if (res.ok) {
          btn.textContent = '✓ 已安装';
          skillSearchStatusEl.textContent = `已安装技能：${res.installed.join('、')}`;
          renderSkills();
        } else {
          btn.disabled = false; btn.textContent = '下载并安装';
          skillSearchStatusEl.textContent = '安装失败：' + res.error;
        }
      } catch (e) {
        btn.disabled = false; btn.textContent = '下载并安装';
        skillSearchStatusEl.textContent = '安装异常：' + e.message;
      } finally {
        currentSkillInstallBtn = null;
        currentSkillInstallName = null;
      }
    });
    skillSearchListEl.appendChild(makeSkillItem({
      badge: skillBadge(it.fullName + ' ' + it.description),
      name: it.fullName, desc: `${it.description || '(无描述)'} · ★${it.stars}`,
      actions: [btn],
    }));
  });
});
document.getElementById('skill-search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('skill-search-btn').click();
});

/* ---- 本地源码包技能 ---- */
let skillLocalDir = null;
document.getElementById('skill-pick-dir').addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (!dir) return;
  skillLocalDir = dir;
  document.getElementById('skill-local-dir').value = dir;
});
document.getElementById('skill-scan-local').addEventListener('click', async () => {
  const dir = skillLocalDir || document.getElementById('skill-local-dir').value.trim();
  if (!dir) { document.getElementById('skill-local-dir').placeholder = '请先选择源码包目录'; return; }
  skillLocalDir = dir;
  const listEl = document.getElementById('skill-local-list');
  listEl.innerHTML = '<p class="empty">正在扫描…</p>';
  const items = await window.api.skillsScanLocal(skillLocalDir);
  listEl.innerHTML = '';
  if (!items.length) { listEl.innerHTML = '<p class="empty">未在该目录下找到技能定义（需要含 src/skills/bundled 的 Claude Code 源码包）</p>'; return; }
  items.forEach((it) => {
    let btn = null;
    if (!it.installed) {
      btn = document.createElement('button');
      btn.className = 'btn small primary'; btn.textContent = '移植安装';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const md = `---\nname: ${it.name}\ndescription: ${it.description.replace(/\n/g, ' ')}\n---\n# ${it.name}\n\n${it.description}\n\n${it.excerpt ? `## 参考指引（源自 Claude Code 内置技能）\n${it.excerpt}\n` : ''}\n请结合本应用可用工具（read_file/write_file/edit_file/glob_files/grep_files/list_dir/convert_file/view_image/run_command 等）完成该类任务。`;
        await window.api.skillsInstallMd(it.name, md);
        btn.textContent = '✓ 已安装';
        renderSkills();
        it.installed = true;
      });
    }
    document.getElementById('skill-local-list').appendChild(makeSkillItem({
      badge: skillBadge(it.name), name: it.name, desc: it.description,
      tag: it.installed ? '已安装' : null, tagClass: 'ext', actions: btn ? [btn] : [],
    }));
  });
});

/* ================= 初始化 ================= */
initExts();
initAiSettings();
initTheme(); // 外观主题（浅色/深色）—— 必须在面板渲染前，避免颜色闪烁
initAppVersion(); // 左下角版本号动态同步
initUpdater(); // 自动更新（检查/下载/安装）
renderSkills();
renderRecommendedSkills();
renderRules();
renderFiles();
renderAutoFiles();
renderAutoRules();
loadPdfEngineInfo(); // PDF 引擎信息（拉取后填充格式转换面板的提示条）
loadAutoPresets();
renderRnFiles();
renderRnRules();
populateConvFormats();
populateAutoSkill();
populateWmSkill();
populatePptSkill();
renderCvFiles();
renderWmFiles();
renderWmCandidates();
// 加载对话历史
if (btnNewChat) btnNewChat.addEventListener('click', () => createNewChat());
loadChats();
// 规则状态同步给主进程（供智能体使用）
window.api.syncRules(state.rules);
