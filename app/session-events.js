/* ================= 任务状态事件流（供外部桌面陪伴类应用读取） =================
 * 输出到 userData/session-events.jsonl，每行一个 JSON 事件。
 * 事件语义对齐 VibeCute 的 SessionEvent，便于其直接加一个 Reader 接入：
 *   session_meta {id}                     会话开始（含会话 ID）
 *   started                               任务开始
 *   caption {kind, text}                  字幕：工具调用 / 回答（kind 用中文，VibeCute 的 CaptionKind 原样使用中文 raw value）
 *   question {id, question, options}      AI 向用户提问（等待选择）
 *   questionResolved {id, answer}         用户已作答
 *   finished {outcome}                    任务结束：completed / interrupted / failed
 * 设计原则（重要）：
 *   1) 默认关闭，由 ai-config 的 sessionEvents 开关控制；不开就不写任何文件
 *   2) 只写面向用户的可见文本，绝不写工具原始结果、系统提示词、用户原文
 *   3) 纯 append + 按大小轮转（保留 3 个文件），任何异常一律吞掉，绝不影响主流程
 */
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'session-events.jsonl';
const MAX_BYTES = 8 * 1024 * 1024; // 单文件 8MB 上限，超出轮转
const KEEP = 3;                    // 含当前文件共保留 3 个
const MAX_TEXT = 200;              // 单条字幕最长字符数

let dir = null;
let enabled = false;

function configure(userDataDir, isEnabled) {
  dir = userDataDir || null;
  enabled = !!isEnabled;
}

function setEnabled(v) { enabled = !!v; return enabled; }
function isEnabled() { return enabled; }
function filePath() { return dir ? path.join(dir, FILE_NAME) : null; }

// 超出上限时轮转：x.jsonl -> x.jsonl.1 -> x.jsonl.2（最老丢弃）
function rotate(p) {
  try {
    if (fs.statSync(p).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const src = i === 1 ? p : `${p}.${i - 1}`;
      const dst = `${p}.${i}`;
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) { /* ignore */ }
      try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* 文件不存在等情况忽略 */ }
}

// 归一化：压平换行、截断，避免把大段内容或换行写进事件流
function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function emit(event) {
  if (!enabled || !dir) return;
  const p = filePath();
  if (!p) return;
  try {
    rotate(p);
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: Date.now() }, event)) + '\n', 'utf8');
  } catch (e) { /* 永不因日志影响主流程 */ }
}

function clear() {
  const p = filePath();
  if (!p) return;
  try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
  for (let i = 1; i < KEEP; i++) {
    try { fs.unlinkSync(`${p}.${i}`); } catch (e) { /* ignore */ }
  }
}

module.exports = { configure, setEnabled, isEnabled, emit, clean, clear, filePath, FILE_NAME };
