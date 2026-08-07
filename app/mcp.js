// MCP（Model Context Protocol）客户端 —— 主进程运行
// 说明：不依赖任何外部 npm 包，使用 Node 内置 child_process / https / http
// 传输：
//   - stdio：本地进程，每条消息一行 JSON（换行分隔 JSON-RPC 2.0）
//   - sse  ：远程服务，GET 拉取 text/event-stream，POST 发送 JSON-RPC，响应按 id 在流上匹配
//            （Cherry Studio / 阿里云百炼等远程 MCP 服务使用的格式）
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');

// 把字符串里的 ${KEY} 用 envMap（优先）或 process.env（兜底）替换；缺值保留原占位符
function resolveEnv(str, envMap) {
  if (typeof str !== 'string') return str;
  const m = envMap || {};
  return str.replace(/\$\{([^}]+)\}/g, (_, k) => {
    if (m[k] !== undefined && m[k] !== '') return m[k];
    if (process.env[k] !== undefined) return process.env[k];
    return '${' + k + '}';
  });
}

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'AI Copilot', version: '1.0.0' };

// 从 Finder 启动的 App 只有极简 PATH，这里补齐常见的用户/包管理器路径
function buildEnvPath(extra) {
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.deno/bin'),
    path.join(home, '.nvm/versions/node'),
  ];
  const cur = (extra && extra.PATH) || process.env.PATH || '';
  const parts = cur.split(':').filter(Boolean);
  for (const c of candidates) {
    if (!parts.includes(c) && fs.existsSync(c)) parts.push(c);
  }
  // nvm 默认版本
  try {
    const nvmDir = path.join(home, '.nvm/versions/node');
    if (fs.existsSync(nvmDir)) {
      for (const v of fs.readdirSync(nvmDir)) {
        const bin = path.join(nvmDir, v, 'bin');
        if (fs.existsSync(bin) && !parts.includes(bin)) parts.push(bin);
      }
    }
  } catch (e) { /* ignore */ }
  return parts.join(':');
}

/* ---------------- 单个服务器连接 ---------------- */

class McpConnection {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.proc = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.status = 'idle';   // idle | connecting | ready | error | stopped
    this.error = '';
    this.stderrTail = '';
  }

  log(msg) {
    this.stderrTail = (this.stderrTail + msg).slice(-2000);
  }

  async connect(timeoutMs = 30000) {
    if (this.status === 'connecting' || this.status === 'ready') return this;
    this.status = 'connecting';
    this.error = '';
    this.tools = [];

    const cfg = this.config;
    if (!cfg.command) {
      this.status = 'error';
      this.error = '未填写启动命令';
      return this;
    }

    // 旧版市场模板曾把 {{path}} 等占位符直接保存进 args，启动前拦截并给出清晰指引
    const badArg = (cfg.args || []).find((a) => typeof a === 'string' && /\{\{[^}]+\}\}/.test(a));
    if (badArg) {
      this.status = 'error';
      this.error = `配置包含未替换占位符（${badArg.match(/\{\{[^}]+\}\}/)[0]}）。请删除此服务器，重新从「MCP 市场」添加并填写真实值。`;
      return this;
    }

    const env = { ...process.env, ...(cfg.env || {}) };
    env.PATH = buildEnvPath(env);

    try {
      this.proc = spawn(cfg.command, cfg.args || [], {
        cwd: cfg.cwd || os.homedir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.status = 'error';
      this.error = `启动失败：${e.message}`;
      return this;
    }

    this.proc.on('error', (e) => {
      this.status = 'error';
      this.error = `启动失败：${e.message}`;
      this.rejectAll(e);
    });

    this.proc.on('exit', (code, signal) => {
      if (this.status !== 'stopped') {
        this.status = 'error';
        if (!this.error) {
          this.error = `进程退出（code=${code}${signal ? ', signal=' + signal : ''}）` +
            (this.stderrTail ? `：${this.stderrTail.trim().slice(-300)}` : '');
        }
      }
      this.rejectAll(new Error(this.error || '进程已退出'));
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this.log(chunk));

    try {
      // 1) initialize 握手
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { roots: { listChanged: false }, sampling: {} },
        clientInfo: CLIENT_INFO,
      }, timeoutMs);
      // 2) initialized 通知
      this.notify('notifications/initialized', {});
      // 3) 拉取工具列表
      const res = await this.request('tools/list', {}, timeoutMs);
      this.tools = Array.isArray(res && res.tools) ? res.tools : [];
      this.status = 'ready';
    } catch (e) {
      this.status = 'error';
      let msg = e.message;
      if (/ENOENT/.test(msg)) {
        msg = `找不到命令「${cfg.command}」，请填写完整路径（如 /opt/homebrew/bin/npx）或确认已安装`;
      }
      this.error = msg + (this.stderrTail ? `｜${this.stderrTail.trim().slice(-200)}` : '');
      this.kill();
    }
    return this;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; } // 忽略非 JSON 噪声输出
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    // 服务端主动通知：工具列表变更时刷新
    if (msg && msg.method === 'notifications/tools/list_changed') {
      this.request('tools/list', {}, 15000)
        .then((r) => { this.tools = Array.isArray(r && r.tools) ? r.tools : this.tools; })
        .catch(() => {});
    }
  }

  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) return reject(new Error('MCP 服务未运行'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用超时（${method}）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      try {
        this.proc.stdin.write(payload + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    } catch (e) { /* ignore */ }
  }

  rejectAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch (e) { /* ignore */ }
    }
    this.pending.clear();
  }

  async callTool(toolName, args, timeoutMs = 120000) {
    if (this.status !== 'ready') {
      await this.connect();
      if (this.status !== 'ready') throw new Error(this.error || 'MCP 服务未就绪');
    }
    return this.request('tools/call', { name: toolName, arguments: args || {} }, timeoutMs);
  }

  kill() {
    this.status = this.status === 'error' ? 'error' : 'stopped';
    if (this.proc && !this.proc.killed) {
      try { this.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
      const p = this.proc;
      setTimeout(() => { try { if (!p.killed) p.kill('SIGKILL'); } catch (e) {} }, 2000);
    }
    this.proc = null;
  }
}

/* ---------------- SSE 传输（远程 MCP 服务） ---------------- */
// 协议：GET baseUrl 建立 text/event-stream；服务端先发 `endpoint` 事件告知 POST 地址；
// 客户端向该地址 POST JSON-RPC；响应按 id 在 SSE 流上回传。
// 兼容 Cherry Studio / 阿里云百炼等（type:"sse" + baseUrl + headers）。
class McpConnectionSSE {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.status = 'idle';   // idle | connecting | ready | error | stopped
    this.error = '';
    this.sseReq = null;
    this.postUrl = null;
    this.resolvedBaseUrl = '';
    this.buffer = '';
  }

  resolveHeaders() {
    const envMap = { ...(this.config.env || {}) };
    const headers = {};
    const raw = this.config.headers || {};
    for (const [k, v] of Object.entries(raw)) headers[k] = resolveEnv(String(v), envMap);
    return headers;
  }

  _resolveUrl(data) {
    const base = this.resolvedBaseUrl || this.config.baseUrl || '';
    try { return new URL(data, base).toString(); }
    catch (e) { return data; }
  }

  async connect(timeoutMs = 30000) {
    if (this.status === 'connecting' || this.status === 'ready') return this;
    this.status = 'connecting';
    this.error = '';
    this.tools = [];

    const envMap = { ...(this.config.env || {}) };
    const baseUrl = resolveEnv(this.config.baseUrl || '', envMap);
    if (!baseUrl) {
      this.status = 'error';
      this.error = '未填写服务地址 (baseUrl)';
      return this;
    }
    let url;
    try { url = new URL(baseUrl); }
    catch (e) {
      this.status = 'error';
      this.error = '服务地址无效：' + baseUrl;
      return this;
    }
    this.resolvedBaseUrl = baseUrl;
    const headers = this.resolveHeaders();
    const lib = url.protocol === 'http:' ? http : https;
    const self = this;

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (conn) => { if (!settled) { settled = true; resolve(conn); } };

      const req = lib.request({
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...headers },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          self.status = 'error';
          self.error = `连接失败：HTTP ${res.statusCode}` + (res.statusCode === 401 ? '（请检查 API Key）' : '');
          res.resume();
          finish(self);
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => self.onSseData(chunk));
        res.on('end', () => {
          if (self.status === 'connecting') {
            self.status = 'error';
            if (!self.error) self.error = 'SSE 连接已关闭（未获得消息端点）';
            self.rejectAll(new Error(self.error));
            finish(self);
          }
        });
      });
      self.sseReq = req;
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (e) => {
        if (self.status !== 'stopped') {
          self.status = 'error';
          self.error = 'SSE 连接错误：' + e.message;
          self.rejectAll(e);
        }
        finish(self);
      });
      req.end();

      self._waitEndpointAndInit(timeoutMs)
        .then(() => { if (self.status === 'ready' || self.status === 'error') finish(self); })
        .catch((e) => {
          if (self.status !== 'ready') {
            self.status = 'error';
            self.error = e.message || '握手失败';
            self.rejectAll(e);
          }
          finish(self);
        });

      setTimeout(() => {
        if (!settled) {
          self.status = 'error';
          self.error = '握手超时';
          self.rejectAll(new Error('握手超时'));
          finish(self);
        }
      }, timeoutMs + 6000);
    });
  }

  async _waitEndpointAndInit(timeoutMs) {
    const postUrl = await this._waitForPostUrl(6000);
    this.postUrl = postUrl || this.resolvedBaseUrl;
    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: CLIENT_INFO,
    }, timeoutMs);
    this.notify('notifications/initialized', {});
    const res = await this.request('tools/list', {}, timeoutMs);
    this.tools = Array.isArray(res && res.tools) ? res.tools : [];
    this.status = 'ready';
  }

  _waitForPostUrl(timeoutMs) {
    return new Promise((resolve) => {
      if (this.postUrl) return resolve(this.postUrl);
      const start = Date.now();
      const check = () => {
        if (this.postUrl) return resolve(this.postUrl);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(check, 100);
      };
      check();
    });
  }

  onSseData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleSseEvent(rawEvent);
    }
  }

  handleSseEvent(rawEvent) {
    let event = 'message';
    const dataLines = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (!data) return;
    if (event === 'endpoint') {
      this.postUrl = this._resolveUrl(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    this.handleMessage(msg);
  }

  handleMessage(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg && msg.method === 'notifications/tools/list_changed') {
      this.request('tools/list', {}, 15000)
        .then((r) => { this.tools = Array.isArray(r && r.tools) ? r.tools : this.tools; })
        .catch(() => {});
    }
  }

  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.postUrl) return reject(new Error('MCP SSE 未就绪（未获得消息端点）'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用超时（${method}）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { jsonrpc: '2.0', id, method, params: params || {} };
      this._post(payload).catch((e) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  notify(method, params) {
    if (!this.postUrl) return;
    this._post({ jsonrpc: '2.0', method, params: params || {} }).catch(() => {});
  }

  _post(payload) {
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(this.postUrl); } catch (e) { return reject(new Error('消息端点地址无效')); }
      const lib = url.protocol === 'http:' ? http : https;
      const headers = this.resolveHeaders();
      const body = JSON.stringify(payload);
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', ...headers },
        timeout: 60000,
      }, (res) => {
        let respBody = '';
        res.on('data', (c) => (respBody += c));
        res.on('end', () => {
          // 部分实现会把 JSON-RPC 响应直接放在 POST 回包里；若有则优先使用
          if (respBody) {
            try {
              const m = JSON.parse(respBody);
              if (m && m.jsonrpc === '2.0' && m.id !== undefined && this.pending.has(m.id)) {
                const { resolve: r, reject: rj, timer } = this.pending.get(m.id);
                this.pending.delete(m.id);
                clearTimeout(timer);
                if (m.error) rj(new Error(m.error.message || JSON.stringify(m.error)));
                else r(m.result);
              }
            } catch (e) { /* 响应走 SSE 流，忽略 */ }
          }
          resolve();
        });
      });
      req.on('timeout', () => req.destroy(new Error('POST 超时')));
      req.on('error', reject);
      req.end(body);
    });
  }

  rejectAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch (e) { /* ignore */ }
    }
    this.pending.clear();
  }

  async callTool(toolName, args, timeoutMs = 120000) {
    if (this.status !== 'ready') {
      await this.connect();
      if (this.status !== 'ready') throw new Error(this.error || 'MCP 服务未就绪');
    }
    return this.request('tools/call', { name: toolName, arguments: args || {} }, timeoutMs);
  }

  kill() {
    this.status = this.status === 'error' ? 'error' : 'stopped';
    if (this.sseReq && !this.sseReq.destroyed) {
      try { this.sseReq.destroy(); } catch (e) { /* ignore */ }
    }
    this.sseReq = null;
    this.rejectAll(new Error('已断开'));
  }
}

// 按传输方式选择连接实现
function createConnection(cfg) {
  return (cfg.transport === 'sse') ? new McpConnectionSSE(cfg) : new McpConnection(cfg);
}

/* ---------------- 连接池管理 ---------------- */

const connections = new Map(); // name -> McpConnection

function getConfigs() {
  try {
    const aiConfig = require('./ai-config');
    return (aiConfig.getMcpServers() || []).filter((s) => s.enabled !== false);
  } catch (e) {
    return [];
  }
}

// 按配置连接（增量：新增的连、删除的断、变更的重连）
async function connectFromConfig() {
  const configs = getConfigs();
  const wanted = new Set(configs.map((c) => c.name));

  // 断开已移除/禁用的
  for (const [name, conn] of [...connections]) {
    if (!wanted.has(name)) {
      conn.kill();
      connections.delete(name);
    }
  }

  const results = [];
  for (const cfg of configs) {
    const exist = connections.get(cfg.name);
    if (exist && exist.status === 'ready' && sameConfig(exist.config, cfg)) {
      results.push(statusOf(exist));
      continue;
    }
    if (exist) { exist.kill(); connections.delete(cfg.name); }
    const conn = createConnection(cfg);
    connections.set(cfg.name, conn);
    await conn.connect();
    results.push(statusOf(conn));
  }
  return results;
}

function sameConfig(a, b) {
  const ta = a.transport || 'stdio';
  const tb = b.transport || 'stdio';
  if (ta !== tb) return false;
  if (ta === 'sse') {
    return (a.baseUrl || '') === (b.baseUrl || '') &&
      JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {}) &&
      JSON.stringify(a.env || {}) === JSON.stringify(b.env || {});
  }
  return a.command === b.command &&
    JSON.stringify(a.args || []) === JSON.stringify(b.args || []) &&
    JSON.stringify(a.env || {}) === JSON.stringify(b.env || {}) &&
    (a.cwd || '') === (b.cwd || '');
}

function statusOf(conn) {
  return {
    name: conn.name,
    status: conn.status,
    error: conn.error,
    tools: (conn.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
    toolCount: (conn.tools || []).length,
  };
}

function getAllStatus() {
  const cfgList = (() => {
    try { return require('./ai-config').getMcpServers() || []; } catch (e) { return []; }
  })();
  return cfgList.map((cfg) => {
    const conn = connections.get(cfg.name);
    if (!conn) {
      return {
        id: cfg.id, name: cfg.name,
        status: cfg.enabled === false ? 'disabled' : 'idle',
        error: '', tools: [], toolCount: 0,
      };
    }
    return { id: cfg.id, ...statusOf(conn) };
  });
}

// 测试单个服务器（不影响连接池里的常驻连接）
async function testServer(cfg) {
  const conn = createConnection(cfg);
  await conn.connect(30000);
  const res = statusOf(conn);
  conn.kill();
  return res;
}

function disconnectAll() {
  for (const [, conn] of connections) conn.kill();
  connections.clear();
}

/* ---------------- 提供给 agent 的工具定义 ---------------- */

function sanitize(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

// 返回 [{ toolName, serverName, originalName, description, schema }]
function getMcpToolDefs() {
  const defs = [];
  for (const [name, conn] of connections) {
    if (conn.status !== 'ready') continue;
    for (const t of conn.tools || []) {
      defs.push({
        toolName: `mcp__${sanitize(name)}__${sanitize(t.name)}`,
        serverName: name,
        originalName: t.name,
        description: t.description || '',
        schema: t.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  return defs;
}

// 把 MCP 返回的 content 数组转成文本
function contentToText(result) {
  if (!result) return '(无返回)';
  if (result.isError) {
    const txt = extractText(result.content);
    return `工具返回错误：${txt || JSON.stringify(result).slice(0, 500)}`;
  }
  const txt = extractText(result.content);
  if (txt) return txt;
  if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2).slice(0, 20000);
  return JSON.stringify(result).slice(0, 20000);
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image') parts.push('[图片内容，已省略]');
    else if (c.type === 'resource' && c.resource) {
      parts.push(c.resource.text || `[资源 ${c.resource.uri || ''}]`);
    } else parts.push(JSON.stringify(c));
  }
  return parts.join('\n').slice(0, 20000);
}

async function callTool(serverName, toolName, args) {
  const conn = connections.get(serverName);
  if (!conn) throw new Error(`MCP 服务 ${serverName} 未连接`);
  const result = await conn.callTool(toolName, args);
  return contentToText(result);
}

module.exports = {
  connectFromConfig,
  disconnectAll,
  getAllStatus,
  testServer,
  getMcpToolDefs,
  callTool,
  contentToText,
  McpConnection,
  McpConnectionSSE,
};
