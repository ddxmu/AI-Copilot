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
  provider: 'local',      // 'local' 使用系统 speechSynthesis；'minimax' 使用 MiniMax 海螺 TTS
  baseUrl: 'https://api.minimax.chat/v1',
  apiKey: '',
  model: 'speech-2.8-turbo',
  voiceId: '',
  speed: 1.0,
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
  return { ...DEFAULT_VOICE, ...(loadState().voice || {}) };
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
  saveState(state);
  return state.voice;
}

// MiniMax 音色列表：优先读官方 voice_id/voice_identity，兜底返回几个已知公共音色
async function fetchMinimaxVoices(apiKey, baseUrl) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('请先填写 MiniMax API Key');
  const url = String(baseUrl || DEFAULT_VOICE.baseUrl).replace(/\/$/, '');
  const candidates = ['/voice_identity', '/voices', '/voice_id'];
  let lastErr = null;
  for (const p of candidates) {
    try {
      const data = await fetchJson(`${url}${p}`, { 'Authorization': `Bearer ${key}` }, 15000);
      // 官方接口返回格式不确定，兼容几种常见结构
      const list = data?.voices || data?.data?.voices || data?.data || data?.voice_identity || (Array.isArray(data) ? data : null);
      if (Array.isArray(list) && list.length) {
        return list.map((v) => ({
          id: String(v.voice_id || v.id || v.voiceId || v.name || '').trim(),
          name: String(v.name || v.voice_name || v.id || v.voice_id || '').trim(),
        })).filter((v) => v.id);
      }
      // 如果返回了但解析为空，继续尝试下一个端点
      lastErr = new Error('接口返回为空');
    } catch (e) { lastErr = e; }
  }
  // 兜底：返回已知公共音色（截图中的「御姐音」等）
  return [
    { id: 'female-yujie', name: '御姐音' },
    { id: 'male-qn', name: '青年男声' },
    { id: 'female-sx', name: '少女音' },
    { id: 'female-cm', name: '成熟女声' },
    { id: 'male-cm', name: '成熟男声' },
  ];
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
};
