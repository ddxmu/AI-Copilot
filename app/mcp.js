// MCP（Model Context Protocol）客户端 —— 主进程运行
// 说明：不依赖任何外部 npm 包，使用 Node 内置 child_process + 换行分隔 JSON-RPC 2.0
// 传输：stdio（MCP 规范：每条消息一行 JSON，消息内不得含裸换行）
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
    const conn = new McpConnection(cfg);
    connections.set(cfg.name, conn);
    await conn.connect();
    results.push(statusOf(conn));
  }
  return results;
}

function sameConfig(a, b) {
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
  const conn = new McpConnection(cfg);
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
  McpConnection,
};
