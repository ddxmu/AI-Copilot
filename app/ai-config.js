// AI 配置管理：本地持久化（userData/ai-config.json）+ 模型列表拉取
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

function configPath() {
  return path.join(app.getPath('userData'), 'ai-config.json');
}

const DEFAULT_STATE = { profiles: [], activeId: null, webAccess: false, mcpServers: [] };

function loadState() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      profiles: Array.isArray(data.profiles) ? data.profiles : [],
      activeId: data.activeId ?? null,
      webAccess: data.webAccess ?? false,
      mcpServers: Array.isArray(data.mcpServers) ? data.mcpServers : [],
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

/* ---------------- MCP 服务器配置 ---------------- */
// 单条结构：
// {
//   id: 'mcp_xxx',
//   name: 'filesystem',          // 唯一标识（用于工具名前缀），仅字母数字下划线短横
//   enabled: true,
//   transport: 'stdio',          // 目前支持 stdio
//   command: 'npx',
//   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
//   env: { KEY: 'value' },
//   cwd: ''                      // 可选工作目录
// }

function normalizeMcpServer(s) {
  const name = String(s.name || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  let args = s.args;
  if (typeof args === 'string') {
    args = args.split('\n').map((x) => x.trim()).filter(Boolean);
  }
  if (!Array.isArray(args)) args = [];
  let env = s.env;
  if (typeof env === 'string') {
    const obj = {};
    env.split('\n').forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const i = t.indexOf('=');
      if (i > 0) obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    });
    env = obj;
  }
  if (!env || typeof env !== 'object') env = {};
  return {
    id: s.id || `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || 'server',
    enabled: s.enabled !== false,
    transport: s.transport || 'stdio',
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
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
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
  getMcpServers,
  upsertMcpServer,
  deleteMcpServer,
  fetchModels,
  testConnection,
};
