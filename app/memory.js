// 长期记忆库（本地）：从对话中自动提炼用户偏好、项目约定、关键决策等，
// 注入后续对话的系统提示词，让 AI 越聊越懂你。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function userMemoryPath() {
  return path.join(app.getPath('userData'), 'memory.json');
}

function chatMemoryDir() {
  return path.join(app.getPath('userData'), 'chat-memories');
}

function chatMemoryPath(chatId) {
  return path.join(chatMemoryDir(), `${chatId || 'default'}.json`);
}

function loadJson(p) {
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return [];
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

function loadMemory(scope = 'user', chatId = null) {
  const p = scope === 'chat' ? chatMemoryPath(chatId) : userMemoryPath();
  const list = loadJson(p);
  return Array.isArray(list) ? list : [];
}

function saveMemory(scope = 'user', chatId = null, entries) {
  const p = scope === 'chat' ? chatMemoryPath(chatId) : userMemoryPath();
  saveJson(p, Array.isArray(entries) ? entries : []);
}

function normalizeFact(f) {
  if (!f || typeof f !== 'object') return null;
  const content = String(f.content || '').trim();
  if (!content) return null;
  return {
    scope: f.scope === 'chat' ? 'chat' : 'user',
    category: String(f.category || 'fact').trim() || 'fact',
    content,
    confidence: Number.isFinite(f.confidence) ? Math.max(0, Math.min(1, f.confidence)) : 1,
  };
}

// 合并新提炼出的事实到已有记忆：内容高度相似则更新，否则新增。
function mergeMemory(existing, facts) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  const now = new Date().toISOString();
  for (const f of facts) {
    const fact = normalizeFact(f);
    if (!fact) continue;
    const idx = out.findIndex((e) => {
      if (e.scope !== fact.scope || e.category !== fact.category) return false;
      const a = String(e.content || '').trim();
      const b = fact.content;
      if (!a || !b) return false;
      return a === b || a.length > 10 && b.includes(a) || b.length > 10 && a.includes(b);
    });
    if (idx >= 0) {
      out[idx] = {
        ...out[idx],
        content: fact.content,
        category: fact.category,
        confidence: fact.confidence,
        updatedAt: now,
      };
    } else {
      out.push({
        id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        scope: fact.scope,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return out.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

function deleteMemoryEntry(scope, chatId, id) {
  const entries = loadMemory(scope, chatId);
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length !== entries.length) saveMemory(scope, chatId, filtered);
  return filtered;
}

function formatMemory(scope = 'user', chatId = null, limit = 30) {
  const entries = loadMemory(scope, chatId);
  if (!entries.length) return '';
  const lines = entries.slice(0, limit).map((e) => `- ${e.content}`);
  const title = scope === 'chat' ? '当前对话记忆' : '来自历史对话的记忆';
  return `【${title}】\n${lines.join('\n')}`;
}

module.exports = {
  loadMemory,
  saveMemory,
  mergeMemory,
  deleteMemoryEntry,
  formatMemory,
  userMemoryPath,
  chatMemoryPath,
};
