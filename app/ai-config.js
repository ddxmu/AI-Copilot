// AI 配置管理：本地持久化（userData/ai-config.json）+ 模型列表拉取
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

function configPath() {
  return path.join(app.getPath('userData'), 'ai-config.json');
}

const DEFAULT_VOICE = {
  enabled: false,
  provider: 'local',      // 'local' 使用系统 speechSynthesis；'minimax' 使用 AI 语音 TTS
  baseUrl: 'https://api.minimax.chat/v1',
  apiKey: '',
  model: 'speech-01-turbo',
  voiceId: '',
  speed: 1.0,
  // 语音识别（STT）固定走 AI 语音的 Key + 接口地址（OpenAI 兼容 /audio/transcriptions）
  sttProvider: 'minimax',
};

const DEFAULT_STATE = {
  profiles: [],
  activeId: null,
  webAccess: false,
  memoryEnabled: true,
  mcpServers: [],
  voice: { ...DEFAULT_VOICE },
};

function loadState() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      activeId: data.activeId ?? null,
      webAccess: data.webAccess ?? false,
      memoryEnabled: data.memoryEnabled ?? true,
      mcpServers: Array.isArray(data.mcpServers) ? data.mcpServers : [],
      voice: { ...DEFAULT_VOICE, ...(data.voice || {}) },
    };
  } catch (e) {
    return { ...DEFAULT_STATE, mcpServers: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(state, null, 2), 'utf8');
}

// 返回给渲染进程的脱敏配置（Key 只回显，不做额外处理——本机存储）
function getState() {
  return loadState();
}

function upsertProfile(profile) {
  const state = loadState();
  const idx = state.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) state.profiles[idx] = profile;
  else state.profiles.push(profile);
  if (!state.activeId) state.activeId = profile.id;
  saveState(state);
  return state;
}

function deleteProfile(id) {
  const state = loadState();
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (state.activeId === id) state.activeId = state.profiles[0]?.id ?? null;
  saveState(state);
  return state;
}

function setActive(id, model) {
  const state = loadState();
  const profile = state.profiles.find((p) => p.id === id);
  if (profile) {
    state.activeId = id;
    // 同时切换该 profile 的当前模型（如果指定）
    if (model && typeof model === 'string') {
      profile.model = model;
    }
    saveState(state);
  }
  return state;
}

function getActiveProfile() {
  const state = loadState();
  return state.profiles.find((p) => p.id === state.activeId) || null;
}

function setWebAccess(enabled) {
  const state = loadState();
  state.webAccess = !!enabled;
  saveState(state);
  return state.webAccess;
}

function getWebAccess() {
  return loadState().webAccess ?? false;
}

function setMemoryEnabled(enabled) {
  const state = loadState();
  state.memoryEnabled = !!enabled;
  saveState(state);
  return state.memoryEnabled;
}

function getMemoryEnabled() {
  return loadState().memoryEnabled ?? true;
}

/* ---------------- AI 语音配置 ---------------- */
function getVoiceConfig() {
  const voice = { ...DEFAULT_VOICE, ...(loadState().voice || {}) };
  // 历史配置里可能有 sttProvider='active'，统一覆盖为 MiniMax，与 AI 配置解耦
  voice.sttProvider = 'minimax';
  return voice;
}

function setVoiceConfig(cfg) {
  const state = loadState();
  state.voice = {
    ...DEFAULT_VOICE,
    ...(state.voice || {}),
    ...(cfg || {}),
  };
  // 类型安全
  state.voice.enabled = !!state.voice.enabled;
  state.voice.provider = state.voice.provider === 'minimax' ? 'minimax' : 'local';
  state.voice.baseUrl = String(state.voice.baseUrl || '').trim() || DEFAULT_VOICE.baseUrl;
  state.voice.apiKey = String(state.voice.apiKey || '').trim();
  state.voice.model = String(state.voice.model || '').trim() || DEFAULT_VOICE.model;
  state.voice.voiceId = String(state.voice.voiceId || '').trim();
  state.voice.speed = Math.max(0.5, Math.min(2.0, parseFloat(state.voice.speed) || 1.0));
  // STT 固定为 MiniMax，避免依赖当前 AI 配置的 Key
  state.voice.sttProvider = 'minimax';
  saveState(state);
  return state.voice;
}

// MiniMax 公开系统音色：接口拉取失败时作为 fallback 展示，避免用户误以为拉取成功
const DEFAULT_MINIMAX_VOICE_IDS = [
  { id: 'female-yujie', name: '御姐音' },
  { id: 'female-shaonv', name: '少女音' },
  { id: 'female-chengshu', name: '成熟女性' },
  { id: 'female-tianmei', name: '甜美女性' },
  { id: 'male-qn-qingse', name: '青涩青年' },
  { id: 'male-qn-jingying', name: '精英青年' },
  { id: 'male-qn-badao', name: '霸道青年' },
  { id: 'male-qn-daxuesheng', name: '青年大学生' },
  { id: 'presenter_male', name: '男性主持人' },
  { id: 'presenter_female', name: '女性主持人' },
];

// MiniMax 音色列表：POST 到语音管理域名 api.minimaxi.com/v1/get_voice（与 TTS 的 api.minimax.chat 不同）
async function fetchMinimaxVoices(apiKey, baseUrl) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('请先填写 API Key');
  // 音色列表接口在「语音管理」域名 api.minimaxi.com，而用户配置的「接口地址」是 TTS 域名 api.minimax.chat，
  // 这里把 TTS 域名映射到语音管理域名，避免 404
  let url = String(baseUrl || DEFAULT_VOICE.baseUrl).replace(/\/$/, '');
  url = url.replace('api.minimax.chat', 'api.minimaxi.com').replace('api.minimax.io', 'api.minimaxi.com');
  const ep = `${url}/get_voice`;
  let data;
  try {
    data = await postJson(ep, { 'Authorization': `Bearer ${key}` }, JSON.stringify({ voice_type: 'all' }), 15000);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (/404/.test(msg)) {
      throw new Error(`${msg}：音色列表接口应为 api.minimaxi.com/v1/get_voice（已自动映射），请确认接口地址末尾为 /v1、且 Key 含音色管理权限`);
    }
    throw e;
  }
  // 接口返回 { system_voice[], voice_cloning[], voice_generation[], base_resp }
  if (data && data.base_resp && data.base_resp.status_code !== 0 && data.base_resp.status_code != null) {
    throw new Error(`拉取音色失败：${data.base_resp.status_msg || '未知错误'}`);
  }
  const groups = ['system_voice', 'voice_cloning', 'voice_generation'];
  const all = [];
  for (const g of groups) {
    const arr = data && data[g];
    if (Array.isArray(arr)) all.push(...arr);
  }
  if (!all.length) throw new Error('接口返回为空，未找到任何音色');
  const mapped = all
    .map((v) => ({
      id: String(v.voice_id || v.id || v.voiceId || '').trim(),
      name: String(v.voice_name || v.name || v.id || v.voice_id || '').trim(),
    }))
    .filter((v) => v.id);
  if (!mapped.length) throw new Error('接口返回的音色缺少 voice_id 字段');
  return mapped;
}

// POST + JSON body 的 HTTP 请求（fetchJson 仅支持 GET，音色列表接口需要 POST）
function postJson(urlStr, headers = {}, bodyStr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('API 地址无效')); }
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          // 用 Buffer.concat 再 toString，避免中文乱码（编码铁律）
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(new Error('响应不是有效 JSON')); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/* ---------------- MCP 服务器配置 ---------------- */
// 单条结构（两种传输）：
//  stdio（默认，本地进程）：
//    { id, name, enabled, transport:'stdio', command, args[], env{}, cwd }
//  sse（远程服务，Cherry Studio / 阿里云百炼等格式）：
//    { id, name, enabled, transport:'sse', baseUrl, headers{}, env{}, description }
//    其中 headers 中的 ${KEY} 会以 env 中对应值（或 process.env）替换，方便填 API Key

function parseKv(str) {
  const obj = {};
  String(str || '').split('\n').forEach((line) => {
    const t = line.trim();
    if (!t) return;
    const i = t.indexOf('=');
    if (i > 0) obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  });
  return obj;
}

function normalizeMcpServer(s) {
  const name = String(s.name || s.id || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'server';
  const transport = s.transport ||
    (s.type === 'stdio' ? 'stdio' :
      (s.type === 'sse' || s.type === 'http' || s.baseUrl || s.url) ? 'sse' : 'stdio');

  // env：stdio 传给本地进程；sse 用于替换 headers/baseUrl 中的 ${KEY}
  let env = s.env;
  if (typeof env === 'string') env = parseKv(env);
  if (!env || typeof env !== 'object') env = {};
  const enabled = s.enabled !== false && s.isActive !== false;

  if (transport === 'sse') {
    const baseUrl = String(s.baseUrl || s.url || '').trim();
    let headers = s.headers;
    if (typeof headers === 'string') headers = (() => {
      const obj = {};
      headers.split('\n').forEach((line) => {
        const t = line.trim();
        if (!t) return;
        const i = t.indexOf(':');
        if (i > 0) obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      });
      return obj;
    })();
    if (!headers || typeof headers !== 'object') headers = {};
    // 自动把 headers / baseUrl 里出现的 ${KEY} 占位符预填入 env（缺省空值），方便用户填写
    const ph = new Set();
    const scan = (str) => String(str || '').replace(/\$\{([^}]+)\}/g, (_, k) => { ph.add(k); return ''; });
    Object.values(headers).forEach(scan);
    scan(baseUrl);
    ph.forEach((k) => { if (!(k in env)) env[k] = ''; });
    return {
      id: s.id || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      enabled,
      transport: 'sse',
      baseUrl,
      headers,
      env,
      description: String(s.description || '').trim(),
    };
  }

  // stdio
  let args = s.args;
  if (typeof args === 'string') args = args.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!Array.isArray(args)) args = [];
  return {
    id: s.id || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    enabled,
    transport: 'stdio',
    command: String(s.command || '').trim(),
    args,
    env,
    cwd: String(s.cwd || '').trim(),
  };
}

function getMcpServers() {
  return loadState().mcpServers || [];
}

function upsertMcpServer(server) {
  const state = loadState();
  const item = normalizeMcpServer(server);
  const list = state.mcpServers || [];
  const idx = list.findIndex((s) => s.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  state.mcpServers = list;
  saveState(state);
  return item;
}

function deleteMcpServer(id) {
  const state = loadState();
  state.mcpServers = (state.mcpServers || []).filter((s) => s.id !== id);
  saveState(state);
  return state.mcpServers;
}

/* ---------------- 模型拉取 ---------------- */

// 通用 HTTPS GET JSON
function fetchJson(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(new Error('API 地址无效')); }
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('响应不是有效 JSON')); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

// 由 baseUrl 推导 /models 地址：
//  - base 已带版本段（…/v1、…/v3、…/v4 等）→ 直接 `${base}/models`
//  - base 不带版本段 → 先补 `/v1`，即 `${base}/v1/models`
//  - DeepSeek 特殊：根路径不带 /v1 也支持 `/models`
function modelsUrlCandidates(profile) {
  const base = (profile.baseUrl || '').replace(/\/+$/, '');
  const hasVersion = /\/v\d+(?:\.\d+)?$/.test(base);
  const urls = [];
  if (hasVersion) {
    urls.push(`${base}/models`);
  } else {
    urls.push(`${base}/v1/models`, `${base}/models`);
  }
  return urls;
}

// 拉取模型列表。type: 'anthropic' | 'openai'
async function fetchModels(profile) {
  const base = (profile.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('请先填写 API 地址');
  if (!profile.apiKey) throw new Error('请先填写 API Key');

  const headers =
    profile.type === 'anthropic'
      ? { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${profile.apiKey}` };

  const candidates = modelsUrlCandidates(profile);
  let lastErr = null;
  for (const url of candidates) {
    try {
      const data = await fetchJson(url, headers);
      const list = data.data || [];
      if (profile.type === 'anthropic') {
        return list.map((m) => ({ id: m.id, name: m.display_name || m.id }));
      }
      return list.map((m) => ({ id: m.id, name: m.id }));
    } catch (e) {
      lastErr = e;
      // 404 说明路径不对，尝试下一个候选；其它错误（401/超时等）直接抛出
      if (!/HTTP 404/.test(e.message)) throw e;
    }
  }
  throw lastErr || new Error('拉取失败');
}

// 连接测试：能拉到模型列表即视为连通
async function testConnection(profile) {
  const models = await fetchModels(profile);
  return { ok: true, count: models.length };
}

module.exports = {
  getState,
  upsertProfile,
  deleteProfile,
  setActive,
  getActiveProfile,
  setWebAccess,
  getWebAccess,
  setMemoryEnabled,
  getMemoryEnabled,
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  normalizeMcpServer,
  fetchModels,
  testConnection,
  getVoiceConfig,
  setVoiceConfig,
  fetchMinimaxVoices,
  DEFAULT_MINIMAX_VOICE_IDS,
};
