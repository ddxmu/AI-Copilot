// AI 智能体核心（完整版）
// 架构对齐 Claude Code / WorkBuddy：agent loop + 工具注册表 + 子代理 + 技能包 +
// TodoWrite 任务管理 + 上下文自动压缩 + 权限闸门（allow/ask/deny）
// 双协议适配（Anthropic / OpenAI 兼容），可自主查找、读取、修改、保存本机文件
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile, exec } = require('child_process');
const { ALL_EXTS, ZIP_BASED_OFFICE } = require('./filetypes');
const { LEGACY_OFFICE, replaceInLegacyFile } = require('./office-replace');
const memory = require('./memory');

/* ---------- 图片尺寸解析（纯 JS，无需外部依赖） ---------- */
function imageDims(buf, ext) {
  try {
    if (ext === 'png' && buf.length > 24) {
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buf.length > 4) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return `${buf.readUInt16BE(off + 7)}x${buf.readUInt16BE(off + 5)}`;
        }
        off += 2 + len;
      }
    }
    if (ext === 'gif' && buf.length > 10) {
      return `${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`;
    }
    if (ext === 'bmp' && buf.length > 26) {
      return `${buf.readInt32LE(18)}x${Math.abs(buf.readInt32LE(22))}`;
    }
    if (ext === 'webp' && buf.length > 30) {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8 ') return `${buf.readUInt16LE(26) & 0x3FFF}x${buf.readUInt16LE(28) & 0x3FFF}`;
      if (fourcc === 'VP8L') { const b = buf.readUInt32LE(21); return `${(b & 0x3FFF) + 1}x${((b >> 14) & 0x3FFF) + 1}`; }
      if (fourcc === 'VP8X') return `${(buf.readUIntLE(24, 3)) + 1}x${(buf.readUIntLE(27, 3)) + 1}`;
    }
  } catch (e) {}
  return '';
}

const MAX_TURNS = 40;           // 单轮对话最多工具调用轮数
const SUBAGENT_MAX_TURNS = 20;  // 子代理最多轮数
const KEEP_RECENT_TURNS = 6;    // 压缩时保留最近 N 条消息

// 模型上下文窗口（token）映射表——精确匹配 + 名称解析 + 前缀匹配 + 关键词匹配
const MODEL_CONTEXT_WINDOW = {
  // DeepSeek
  'deepseek-chat': 65536, 'deepseek-reasoner': 65536,
  'deepseek-v4': 1000000, 'deepseek-v4-pro': 1000000, 'deepseek-v4-flash': 1000000,
  // OpenAI
  'gpt-4o': 128000, 'gpt-4o-mini': 128000,
  'o1': 200000, 'o1-mini': 128000, 'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  'gpt-4.1': 1047576, 'gpt-4.1-mini': 1047576, 'gpt-4.1-nano': 1047576,
  // Anthropic
  'claude-3-5-sonnet': 200000, 'claude-3-5-haiku': 200000, 'claude-3-opus': 200000,
  'claude-sonnet-4': 200000, 'claude-opus-4': 200000, 'claude-sonnet-4-5': 200000,
  // Moonshot / Kimi
  'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 131072,
  'kimi-k2': 131072,
  'kimi-k3': 1000000, 'k3': 1000000, 'k3-256k': 262144,
  // MiniMax
  'abab6.5s-chat': 245760, 'MiniMax-M1': 1000000,
  'MiniMax-M3': 1000000,
  'MiniMax-M2': 204800, 'MiniMax-M2.7': 204800, 'MiniMax-M2.5': 204800, 'MiniMax-M2.1': 204800,
  // Zhipu
  'glm-4': 131072, 'glm-4-plus': 131072, 'glm-4-air': 131072, 'glm-4-flash': 131072, 'glm-4.5': 131072,
  // Qwen
  'qwen-turbo': 1000000, 'qwen-plus': 131072, 'qwen-max': 32768, 'qwen-long': 10000000,
  // Doubao
  'doubao-pro-32k': 32768, 'doubao-pro-128k': 131072, 'doubao-pro-256k': 262144,
  'doubao-1.5-pro-32k': 32768, 'doubao-1.5-pro-256k': 262144,
};

// 从模型名中提取上下文大小（如 k3-256k → 262144、model-1m → 1000000、foo-128k → 131072）
function parseContextFromName(model) {
  const m = model.toLowerCase().match(/(\d+(?:\.\d+)?)\s*([km])\b/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (m[2] === 'k') return Math.floor(num * 1024);
  if (m[2] === 'm') return Math.floor(num * 1000000);
  return null;
}

// 根据模型名查上下文窗口，查不到默认 128K
function getContextWindow(model) {
  if (!model) return 128000;
  // 1. 精确匹配
  if (MODEL_CONTEXT_WINDOW[model]) return MODEL_CONTEXT_WINDOW[model];
  // 2. 从模型名解析上下文大小（如 k3-256k → 256K、foo-1m → 1M）
  const parsed = parseContextFromName(model);
  if (parsed) return parsed;
  // 3. 前缀匹配（大小写不敏感，如 gpt-4o-2024-08-06 → gpt-4o）
  const l = model.toLowerCase();
  const keys = Object.keys(MODEL_CONTEXT_WINDOW).sort((a, b) => b.length - a.length);
  for (const k of keys) { if (l.startsWith(k.toLowerCase())) return MODEL_CONTEXT_WINDOW[k]; }
  // 4. 关键词匹配
  if (l.includes('gpt-4.1')) return 1047576;
  if (l.includes('gpt-4o')) return 128000;
  if (l.includes('claude')) return 200000;
  if (l.includes('deepseek-v4')) return 1000000;
  if (l.includes('deepseek')) return 65536;
  if (l.includes('kimi-k3') || l.includes('k3')) return 1000000;
  if (l.includes('moonshot') || l.includes('kimi')) return 131072;
  if (l.includes('qwen-turbo')) return 1000000;
  if (l.includes('qwen')) return 131072;
  if (l.includes('glm')) return 131072;
  if (l.includes('doubao')) return 131072;
  if (l.includes('minimax-m3')) return 1000000;
  if (l.includes('abab') || l.includes('minimax')) return 204800;
  return 128000;
}

// 压缩阈值 = 上下文窗口 × 75%（留 25% 给输出和系统提示）
function getCompactThreshold(model) {
  return Math.floor(getContextWindow(model) * 0.75);
}

function getExt(p) {
  return path.extname(p).replace('.', '').toLowerCase();
}

function scanDir(dirPath, allowedExts, results = []) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (e) { return results; }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      scanDir(full, allowedExts, results);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const ext = getExt(entry.name);
      if (!allowedExts.length || allowedExts.includes(ext)) results.push(full);
    }
  }
  return results;
}

/* ================= 技能包系统（内置 + 动态加载 userData/skills 下各 SKILL.md） ================= */
// 当前会话已安装技能的根目录（运行时由 runAgent 写入），用于系统提示词告知模型技能脚本的绝对路径
let CURRENT_SKILLS_DIR = null;
const BUILTIN_SKILLS = {
  'batch-rename-company': {
    description: '批量替换文件中的公司名/人名等实体，适用于成批文档的统一更名',
    body: `执行批量实体替换时：\n1. 先用 grep_files 确认旧名称在哪些文件中出现、出现多少次\n2. 用 add_replace_rule 建立规则\n3. 用 batch_replace 执行\n4. 汇报每个文件的替换处数`,
  },
  /* ---- 默认技能（按规则替换框架）：智能文档/数据处理 ---- */
  'system-data-intelligence': {
    description: '智能文档/数据处理：理解 Office 文档（Word/Excel/PPT，含旧版 .doc/.xls）与表格结构，按规则智能替换、整理、转换内容；旧版二进制格式先转 OOXML 再处理。',
    body: `执行「按规则替换文件」等文档/数据任务时：
1. 读取替换规则（查找内容 → 替换内容）与各文件路径、用户指定的保存方式。
2. 现代格式（docx/xlsx/pptx/txt/md/csv/json 等）：直接用 batch_replace / edit_file 按规则替换。
3. 旧版二进制格式（.doc / .xls，OLE 复合文档，不可直接按文本读写）：先用转换引擎转成可编辑格式再处理——
   - .doc → 用 textutil -convert docx 或 LibreOffice --headless --convert-to docx；
   - .xls → 用 LibreOffice --headless --convert-to xlsx；
   转换后按规则替换，再按需转回原格式写回。
4. 复杂排版/表格优先用 convert_file 或 LibreOffice（需安装），保持结构与样式；不确定内容时先 read_file 确认。
5. 按保存方式（输出到目录 / 覆盖原文件）写回；完成后简要汇报每个文件的替换处数。`,
  },
  'polish-document': {
    description: '完善/润色文档内容：修正语病、统一格式、补充结构',
    body: `完善文档时：\n1. 先 read_file 通读全文\n2. 保持原文档的格式结构（标题层级、列表样式）\n3. 用 edit_file 逐处修改，不要整篇重写除非用户要求\n4. 修改后说明改了哪些地方`,
  },
  'reformat-document': {
    description: '排版文档：统一标题层级、缩进、列表格式、空行',
    body: `排版文档时：\n1. 先 read_file 看现状\n2. 统一：标题前后空行、列表缩进一致、段落间一个空行、删除多余空行\n3. 用 write_file 输出排版后的完整内容\n4. 不要改动正文措辞`,
  },
  'summarize-folder': {
    description: '概览一个文件夹：统计文件类型分布、列出主要文件、说明用途',
    body: `概览文件夹时：\n1. 用 glob_files 列出文件\n2. 按扩展名分组统计数量\n3. 抽 1-3 个关键文件 read_file 看内容\n4. 给出结构化概览`,
  },
  /* ---- 预置技能（v0.4.0）：格式转换 / 看图 / 终端命令 ---- */
  'format-convert': {
    description: '格式转换技能：doc/docx/rtf/odt/html/txt/md 互转（调用 convert_file 工具）',
    body: `执行文件格式转换时：\n1. 先用 glob_files / list_dir 确认要转换的文件及扩展名\n2. 用 convert_file 逐个转换（指定 path 源文件、to 目标格式、output 输出路径；不指定 output 则输出到源文件同目录）\n3. 支持：doc/docx/rtf/odt/html/txt/md 互转；批量文件逐个处理\n4. 转换后汇报每个文件的输出路径；失败的说明原因`,
  },
  'view-image': {
    description: '看图技能：查看本机图片内容（调用 view_image 工具，支持 png/jpg/jpeg/gif/webp/bmp）',
    body: `用户让你看图片、描述图片内容、读取截图信息时：\n1. 用 view_image 加载图片（会返回图片尺寸等元数据，图片内容随后以视觉输入提供给你）\n2. 仔细描述图片中的内容、文字、布局\n3. 如需处理图片（缩放/转格式），可用 run_command 调 sips（macOS 自带）`,
  },
  'terminal-ops': {
    description: '终端命令技能：执行 macOS 终端命令完成文件/系统操作（调用 run_command 工具，需用户授权）',
    body: `需要用终端命令完成任务时：\n1. 用 run_command 执行命令（用户会收到授权提示，同意后才执行）\n2. 常用命令：sips（图片处理）、textutil（文本转换）、mdls（文件元数据）、find/ditto/zip 等\n3. 命令要简洁、非交互；避免危险命令（rm -rf 等破坏性操作必须用户明确要求）\n4. 执行后解读输出结果给用户`,
  },
  'claude-in-chrome': {
    description: '浏览器自动化（Chrome / 浏览器连接器）：当已接入浏览器类 MCP 服务器时，用其工具检查页面、点击元素、输入文本、捕获页面状态与截图；未接入时仅用网页抓取处理公开页面。',
    body: `协调浏览器辅助工作：

先确认是否已接入浏览器 / Chrome 类 MCP 服务器（在「AI 设置 → MCP 服务器」中配置，并在聊天栏开启 MCP 开关、选定该服务器）。

- 若已接入且工具可用：优先调用 mcp__<服务器>__<工具> 系列工具，完成页面检查、元素点击、文本输入、页面状态 / 截图捕获等浏览器操作。
- 若未接入：向用户说明缺少浏览器连接器，并仅用 web_fetch / web_search 处理公开页面（无法操作需要登录态的页面）。

执行要点：
- 操作前先说明将采用的方式（浏览器自动化 / 网页抓取）。
- 涉及点击、输入、提交、下载等写操作，遵循权限提示，由用户确认后再执行。
- 多步骤任务先用 todo_write 规划，再逐步执行。`,
  },
  /* ---- v0.8.6：默认技能（文件整理 / 文档转换 / PDF 专项） ---- */
  'file-organizer-skill': {
    description: '文件整理：按类型/日期/项目归类、批量重命名、移动到对应文件夹，让目录井然有序',
    body: `执行文件整理任务时：
1. 用 glob_files / list_dir 扫描目标目录，统计文件类型与数量
2. 与用户确认归类规则（按扩展名分组 / 按修改日期 / 按项目名）；规则未明确时先给出建议方案再执行
3. 用 run_command 执行 mv 移动或重命名（用户授权后执行）；批量改名用统一的命名模板
4. 不删除任何文件，只移动/重命名；操作前建议用户备份
5. 完成后列出移动了哪些文件、新建了哪些文件夹`,
  },
  'document-converter': {
    description: '文档格式转换：doc/docx/rtf/odt/html/txt/md/csv/json/pdf 等格式互转，保持结构与样式',
    body: `执行文档格式转换时：
1. 优先用 convert_file 工具处理 doc/docx/rtf/odt/html/txt/md 互转（指定 path、to、output）
2. convert_file 不支持或效果不佳时（如 PDF↔Office、复杂排版）：
   - 用 read_file 读取源内容，理解结构后用 write_file 写出目标格式（保持标题层级、列表、表格）
   - 或用 run_command 调本机引擎：textutil（macOS 文本转换）、libreoffice --headless --convert-to（需安装）
3. PDF 作为源：用 pdftotext / mdls 提取文本与元数据；PDF 作为目标：用文本排版生成（不含图片/复杂格式）
4. 批量文件逐个处理，转换后汇报每个文件输出路径，失败的说明原因`,
  },
  'pdf-to-office': {
    description: 'PDF 与 Office/图片/文本互转：PDF → Word/Excel/PPT/图片/文本；Office/图片 → PDF',
    body: `执行 PDF 与其他格式互转时：
1. PDF → 文本：run_command 执行 pdftotext <file> -（需 poppler）
2. PDF → Word/Excel/PPT/图片：优先 libreoffice --headless --convert-to <fmt> <file>；图片也可用 pdftoppm / pdf2image（Python）
3. Office/图片 → PDF：libreoffice --headless --convert-to pdf，或 macOS 用 textutil / 预览导出
4. 大文件先用 mdls 查页数，避免超时；加密 PDF 用 qpdf --decrypt 先解密
5. 所有命令需用户授权后执行，完成后汇报输出路径`,
  },
  'pdf-compress': {
    description: 'PDF 压缩：减小 PDF 体积，保留文本层与可读性',
    body: `压缩 PDF 时：
1. 优先用 run_command 执行 Ghostscript：gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -o <output> <input>（需安装 ghostscript）
2. 也可用 qpdf --compress-streams=y --object-streams=generate <input> <output>
3. Python 可用 pypdf 重新写入以压缩（需安装 pypdf）
4. 压缩前后对比文件大小，向用户汇报；若压缩后质量不可接受，提供 /screen（更小）与 /printer（更清晰）档位选择
5. 命令需用户授权后执行，不覆盖原文件`,
  },
  'pdf-merge-split': {
    description: 'PDF 合并 / 拆分 / 提取页面 / 旋转：多文件合并、按页范围拆分、抽取指定页',
    body: `处理 PDF 合并与拆分时：
1. 合并：Python pypdf 的 PdfMerger 按指定顺序合并多个 PDF
2. 拆分：按页范围（如 1-5、6-10）或每页一个文件拆分，用 pypdf 提取写入
3. 提取指定页：PdfReader 选页 → PdfWriter 写出
4. 旋转页面：page.rotate_clockwise / rotate_counter_clockwise
5. 用 run_command 或 write_file 执行 Python 脚本（用户授权后）；完成后汇报输出文件与页数`,
  },
  'pdf-watermark-remover': {
    description: 'PDF 去水印：识别并移除 PDF 中的文字类水印（机密/内部/样品/draft 等标记），输出无标记副本',
    body: `执行 PDF 去水印任务时：
1. 先确认待处理 PDF 列表与输出目录（用户已指定，不改动原文件）。
2. 文本类水印优先用 Python pypdf 处理：逐页扫描文本，将命中的水印字符串从页面内容流中移除或遮盖后重新写出（需安装 pypdf：pip install pypdf）
3. 若用户已提供「要删除的水印文字清单」，逐一按清单移除；否则先列出疑似水印文本（如 机密/内部/样品/draft/confidential、同一文字多次重复出现）请用户确认后再删
4. 可用 run_command 调 pdftotext / qpdf 辅助判断水印位置与内容
5. 写文件 / 执行命令前会向用户请求授权，正常调用 run_command / write_file 即可
6. 完成后汇报处理了哪些 PDF、删除了哪些水印、输出到哪里`,
  },
};

/* ================= 推荐技能目录（用户可一键安装） ================= */
const RECOMMENDED_SKILLS = {
  'pdf-toolkit': {
    description: 'PDF 工具包：读取 PDF 内容、提取页面、合并拆分、压缩、提取图片、获取元数据',
    category: '文件处理',
    body: `# PDF 工具包

处理 PDF 文件时，使用以下方法：

## 读取 PDF 内容
- 用 run_command 执行 \`pdftotext <file> -\`（如已安装 poppler）提取文本
- 用 run_command 执行 \`mdls <file>\` 获取 PDF 元数据（页数、作者、创建时间等）
- 用 run_command 执行 \`qlmanage -t -s 1200 -o /tmp <file>\` 生成缩略图预览，再用 view_image 查看

## 提取页面 / 拆分
- 用 run_command 执行 \`python3 -c "import PyPDF2; ..."\` 拆分 PDF（需 PyPDF2）
- 或用 macOS 自带 \`sips\` 处理 PDF 页面图片

## 合并 PDF
- 用 run_command 执行 \`python3 -c "from PyPDF2 import PdfMerger; ..."\` 合并多个 PDF

## PDF 去水印
- 应用内置 PDF 去水印功能（通过「PDF去水印」面板操作），引擎支持删除文本水印

## 压缩 PDF
- 用 run_command 执行 \`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -o output.pdf input.pdf\`（需 Ghostscript）

## 注意事项
- 大 PDF 先用 mdls 查页数，避免处理时间过长
- 加密 PDF 需先解密（可用 qpdf --decrypt）
- 提取图片用 pdfimages（poppler 工具集）
- 所有命令需用户授权后执行`,
  },
  'browser-automation': {
    description: '浏览器自动化：搜索信息、读取网页、提取数据、填写表单（通过 web_search + web_fetch + open_url）',
    category: '联网操作',
    body: `# 浏览器自动化

当你需要自动化浏览器操作时，按以下流程：

## 搜索信息
1. 用 web_search 搜索关键词，获取搜索结果列表（标题、链接、摘要）
2. 从结果中选取最相关的 1-3 个链接

## 读取网页
1. 用 web_fetch 读取选中链接的网页正文内容
2. 如需查看完整页面布局，用 open_url 在浏览器中打开

## 提取数据
1. 从 web_fetch 返回的文本中提取所需信息
2. 如需结构化，用 write_file 保存为 JSON/CSV 格式
3. 多个网页的数据可汇总到一个文件

## 自动化流程示例
- 查找技术文档：web_search → web_fetch → 提取关键代码段 → write_file 保存
- 比价/产品调研：web_search → web_fetch 多个页面 → 汇总对比表
- 新闻摘要：web_search → web_fetch → 提取摘要 → write_file 整理

## 注意事项
- web_fetch 最多返回 5000 字符，长文章需多次调用或分段处理
- 需要登录的页面 web_fetch 无法获取，提示用户手动操作
- open_url 会打开用户默认浏览器，适合需要交互的场景
- 搜索结果可能过时，注意检查内容时效性`,
  },
  'simplify': {
    description: '代码审查与清理：检查代码复用、质量、效率，修复发现的问题',
    category: '代码开发',
    body: `# 代码审查与清理

审查变更的代码文件，检查复用性、质量和效率，修复发现的问题。

## 第一步：识别变更
- 用 read_file 读取用户指定的文件
- 或用 glob_files + grep_files 查找最近修改的文件

## 第二步：三项并行审查

### 代码复用审查
1. 搜索现有工具函数和 helper，检查新代码是否重复了已有功能
2. 标记任何与现有函数功能重复的新函数
3. 标记可用现有工具替代的内联逻辑

### 代码质量审查
1. 冗余状态：重复的状态、可派生的缓存值
2. 参数膨胀：函数参数过多而非结构化
3. 复制粘贴变体：近似重复代码块应统一抽象
4. 泄漏抽象：暴露了应封装的内部细节
5. 字符串硬编码：应用常量/枚举的地方用了原始字符串
6. 不必要的注释：解释 WHAT 的注释（好的命名已说明），保留 WHY（隐藏约束、变通方案）

### 效率审查
1. 不必要的工作：冗余计算、重复文件读取、N+1 模式
2. 错过的并发：独立操作串行而非并行
3. 热路径膨胀：启动/渲染热路径中新增阻塞工作
4. 内存：无界数据结构、缺少清理、事件监听器泄漏

## 第三步：修复
- 聚合所有发现，逐个修复
- 误报或不值得处理的跳过并说明
- 完成后简要总结修复了什么（或确认代码已干净）`,
  },
  'deep-research': {
    description: '深度研究：系统化联网调研某个主题，汇总多方信息输出研究报告',
    category: '联网操作',
    body: `# 深度研究

系统化地进行联网调研，输出结构化研究报告。

## 第一步：规划研究
1. 用 todo_write 拆解研究主题为 3-5 个子问题
2. 每个子问题用 web_search 搜索，获取多个信息源

## 第二步：搜集信息
1. 对每个子问题，用 web_search 搜索（中英文各一轮）
2. 选取 2-3 个高质量来源，用 web_fetch 读取详细内容
3. 用 todo_write 标记完成的子问题

## 第三步：交叉验证
1. 对比多个来源的信息，标记矛盾点
2. 优先采信官方文档、权威媒体、学术论文
3. 标注信息的时效性（发布日期）

## 第四步：输出报告
1. 用 write_file 输出 Markdown 格式研究报告
2. 结构：摘要 → 各子问题发现 → 数据对比 → 结论与建议 → 参考来源
3. 在报告中标注每个关键信息的来源链接

## 注意事项
- 每轮搜索用不同关键词确保覆盖面
- web_fetch 返回内容超过 5000 字符会截断，重要页面可能需分段获取
- 保持客观，区分事实与观点
- 如遇搜索受限，提示用户开启联网开关`,
  },
  'batch-process': {
    description: '批量文件处理：对大量文件执行统一操作（重命名、内容替换、格式转换等）',
    category: '文件处理',
    body: `# 批量文件处理

对大量文件执行统一操作的高效流程。

## 第一步：扫描与分类
1. 用 glob_files 按扩展名扫描目标文件夹
2. 用 list_dir 查看目录结构
3. 按文件类型分组统计数量
4. 用 todo_write 制定处理计划

## 第二步：批量替换
1. 用 add_replace_rule 建立替换规则（可多条）
2. 用 batch_replace 一次性执行所有规则
3. 支持的文件类型：txt/md/代码等文本文件 + docx/pptx/xlsx 等 Office 文件

## 第三步：批量重命名
1. 按规则生成新文件名列表
2. 用 run_command 执行 mv 命令（需用户授权）
3. 或提示用户使用应用的「文件名修改」功能

## 第四步：批量格式转换
1. 用 convert_file 逐个转换文件格式
2. 支持 doc/docx/rtf/odt/html/txt/md 互转
3. 大量文件时可先用 todo_write 跟踪进度

## 第五步：验证与汇报
1. 用 glob_files 确认输出文件数量与输入一致
2. 抽查 2-3 个文件确认结果正确
3. 汇报处理统计：成功/失败/跳过数量

## 注意事项
- 处理前建议用户备份原文件
- Office 文件（docx/pptx/xlsx）走本地引擎，不改原文件格式
- 大批量操作注意性能，避免一次处理过多文件`,
  },
  'document-translate': {
    description: '文档翻译：将文档内容翻译为指定语言，保持格式和术语一致',
    category: '文件处理',
    body: `# 文档翻译

将文档内容翻译为指定语言，保持原文格式和专业术语一致性。

## 翻译流程
1. 用 read_file 读取源文档全文
2. 识别文档类型（技术文档/合同/报告/说明书等）
3. 建立术语表：提取专业术语，确定翻译对应关系
4. 分段翻译：长文档分段处理，保持上下文一致
5. 用 write_file 输出翻译后的文档

## 翻译原则
- 保持原文的格式结构（标题层级、列表样式、表格结构）
- 专业术语首次出现时附注原文，后续统一使用译名
- 代码块、命令、路径不翻译
- 数字、单位按目标语言习惯转换
- 长句可拆分为短句以符合目标语言表达习惯

## 多文件批量翻译
1. 用 glob_files 扫描所有需翻译的文件
2. 用 todo_write 跟踪每个文件的翻译进度
3. 保持所有文件中同一术语的翻译一致
4. 完成后输出术语表文件供用户审阅

## 注意事项
- 翻译前确认目标语言
- 技术文档保留英文专有名词（如 API 名称、产品名）
- 法律/合同类文档需保守翻译，不增减内容
- 翻译完成后提示用户校对`,
  },
  'open-kimi-ppt': {
    description: 'Kimi PPT 幻灯片技能：创建 / 编辑 / 复刻 / 读取并导出 PPT/PPTX（基于 PPTD YAML 中间层，自动生成可编辑 PPTD 项目 + 成品 PPTX）。',
    category: '演示文稿',
    // 无内联 body，安装时从 GitHub 仓库下载
    repo: 'ddxmu/open-kimi-ppt-skill',
    branch: 'main',
    // 环境依赖：技能执行前自检，缺失时由 AI 助手在用户授权后自动安装
    // 默认走本地离线导出（export_pptx_local.py，仅需 python3）；Node.js 仅 Kimi 在线导出兜底才需要（optional）
    prerequisites: [
      {
        id: 'python3',
        name: 'Python 3',
        desc: '默认离线导出（export_pptx_local.py）与 Kimi 在线导出兜底都需要 python3；导出脚本会按需用 pip 安装 python-pptx / PyYAML',
        check: 'command -v python3 >/dev/null 2>&1',
        install: 'if command -v brew >/dev/null 2>&1; then brew install python; else echo "请手动安装 Python 3（https://www.python.org）。"; exit 1; fi',
      },
      {
        id: 'node18',
        name: 'Node.js 18+（可选）',
        desc: '仅在使用 Kimi 在线导出（export_pptx.py 兜底）时需要 Node.js 18 及以上；默认离线导出不需要，可跳过',
        check: 'node -v 2>/dev/null | grep -qE "v(1[89]|[2-9][0-9])"',
        install: 'if command -v brew >/dev/null 2>&1; then brew install node; else echo "未检测到 Homebrew，请到 https://nodejs.org 手动安装 Node.js 18+ 后再试。"; exit 1; fi',
        optional: true,
      },
    ],
  },
  'computeruse-file-authoring': {
    description: '文件自动化：在 macOS 文件夹中理解需求、规划内容、创建或修改文件、专业排版、生成流程图、保存并验证结果；默认使用内置 ComputerUse 操作屏幕',
    category: '文件处理',
    repo: 'ddxmu/computeruse-file-authoring-skill',
    branch: 'main',
  },
};

// 运行时技能表 = 内置 + 外部安装（userData/skills/<name>/SKILL.md）
let SKILLS = { ...BUILTIN_SKILLS };

// 技能环境依赖声明：技能名 -> 依赖数组 [{id,name,desc,check,install,optional}]
// check：shell 命令，退出码 0 表示已满足；install：用户授权后由 AI 助手自动执行的安装命令
const SKILL_PREREQS = {};
for (const [name, def] of Object.entries(RECOMMENDED_SKILLS)) {
  if (Array.isArray(def.prerequisites)) SKILL_PREREQS[name] = def.prerequisites;
}

// 解析 SKILL.md：支持 --- name/description --- 头部 + 正文；无头部则首行 # 标题作名
function parseSkillMd(content, fallbackName) {
  let name = fallbackName, description = '', body = content;
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      if (m[1] === 'name' && m[2].trim()) name = m[2].trim();
      if (m[1] === 'description') description = m[2].trim();
    }
  } else {
    const h = content.match(/^#\s+(.+)$/m);
    if (h && name === fallbackName) name = h[1].trim();
  }
  if (!description) description = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || name;
  return { name, description: description.slice(0, 200), body: body.trim() };
}

// 从目录加载外部技能并合并（外部同名覆盖内置）
function loadExternalSkills(skillsDir) {
  SKILLS = { ...BUILTIN_SKILLS };
  if (!skillsDir) return SKILLS;
  let dirs = [];
  try { dirs = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch (e) { return SKILLS; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const skillFile = path.join(skillsDir, d.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillMd(fs.readFileSync(skillFile, 'utf8'), d.name);
      SKILLS[parsed.name] = { description: parsed.description, body: parsed.body, external: true };
    } catch (e) { /* 跳过损坏技能 */ }
  }
  return SKILLS;
}

/* ================= 工具注册表 ================= */
// 每个工具：{ description, schema, readOnly, permission, run(args, ctx) }
// permission: 'allow' 直接执行 | 'ask' 需用户确认
// ctx: { rules, rulesChanged, confirm(desc)->Promise<bool>, todos, setTodos, emit, profile, depth }

const tools = {

  /* ---------- 文件读取 ---------- */
  read_file: {
    description: '读取文件内容（带行号）。默认最多 2000 行，可用 offset/limit 分段。支持本机任意路径。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        offset: { type: 'number', description: '起始行号（从 1 开始），默认 1' },
        limit: { type: 'number', description: '读取行数，默认 2000' },
      },
      required: ['path'],
    },
    readOnly: true,
    permission: 'allow',
    run({ path: p, offset = 1, limit = 2000 }) {
      if (!fs.existsSync(p)) return '错误：文件不存在 ' + p;
      let content;
      try { content = fs.readFileSync(p, 'utf8'); }
      catch (e) { return '错误：无法按文本读取（可能是二进制文件）'; }
      const lines = content.split('\n');
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
      const more = offset - 1 + limit < lines.length
        ? `\n（共 ${lines.length} 行，已显示到第 ${offset - 1 + slice.length} 行，可用 offset 继续读）` : '';
      return numbered + more;
    },
  },

  /* ---------- 文件写入 ---------- */
  write_file: {
    description: '创建或完整覆写一个文件。目录不存在会自动创建。支持本机任意路径。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ path: p, content }, ctx) {
      const ok = await ctx.confirm({ type: 'write', title: '写入文件', desc: '创建 / 覆写文件：' + p });
      if (!ok) return '用户取消了该操作';
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return `已写入 ${p}（${content.length} 字符）`;
    },
  },

  /* ---------- 局部编辑 ---------- */
  edit_file: {
    description: '精确替换文件中的某段文字（old_string 必须唯一出现）。适合局部修改。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        old_string: { type: 'string', description: '要被替换的原文（须唯一匹配）' },
        new_string: { type: 'string', description: '替换成的新内容' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ path: p, old_string, new_string }, ctx) {
      if (!fs.existsSync(p)) return '错误：文件不存在 ' + p;
      const ext = getExt(p).toLowerCase().replace(/^\./, '');
      if (LEGACY_OFFICE.has(ext)) {
        // .doc/.xls 老格式：走 LibreOffice 双向转换替换（确定性，不依赖 AI 是否开启）
        if (!old_string) return '错误：old_string 不能为空';
        let r;
        try { r = replaceInLegacyFile(p, [{ find: old_string, replace: new_string ?? '' }]); }
        catch (e) { return '错误：老格式处理失败：' + e.message; }
        if (!r.content) return '错误：未找到匹配原文，请先 read_file 确认确切内容';
        const ok = await ctx.confirm({ type: 'edit', title: '修改文件', desc: '修改文件（老格式）：' + p });
        if (!ok) return '用户取消了该操作';
        fs.writeFileSync(p, r.content);
        return `已修改 ${p}`;
      }
      const content = fs.readFileSync(p, 'utf8');
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) return '错误：未找到匹配原文，请先 read_file 确认确切内容';
      if (occurrences > 1) return `错误：原文出现 ${occurrences} 次，不唯一。请扩大 old_string 范围`;
      const ok = await ctx.confirm({ type: 'edit', title: '修改文件', desc: '修改文件：' + p });
      if (!ok) return '用户取消了该操作';
      fs.writeFileSync(p, content.replace(old_string, new_string), 'utf8');
      return `已修改 ${p}`;
    },
  },

  /* ---------- 扫描文件夹 ---------- */
  glob_files: {
    description: '扫描文件夹，递归列出符合扩展名的文件。exts 为空数组表示全部文件。',
    schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '文件夹绝对路径' },
        exts: { type: 'array', items: { type: 'string' }, description: '扩展名过滤，空数组=全部' },
        max_results: { type: 'number', description: '最多返回条数，默认 200' },
      },
      required: ['folder'],
    },
    readOnly: true,
    permission: 'allow',
    run({ folder, exts = [], max_results = 200 }) {
      if (!fs.existsSync(folder)) return '错误：文件夹不存在 ' + folder;
      const files = scanDir(folder, exts);
      return `共找到 ${files.length} 个文件：\n` + files.slice(0, max_results).join('\n') +
        (files.length > max_results ? `\n（仅显示前 ${max_results} 个）` : '');
    },
  },

  /* ---------- 内容搜索 ---------- */
  grep_files: {
    description: '在文件中搜索文本（支持正则），返回文件、行号和所在行。',
    schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: '要搜索的文件夹绝对路径' },
        pattern: { type: 'string', description: '搜索文本或正则' },
        exts: { type: 'array', items: { type: 'string' }, description: '限定扩展名，空数组=全部文本类' },
        max_results: { type: 'number', description: '最多返回匹配行数，默认 100' },
      },
      required: ['folder', 'pattern'],
    },
    readOnly: true,
    permission: 'allow',
    run({ folder, pattern, exts = [], max_results = 100 }) {
      const files = scanDir(folder, exts).filter((f) => !ZIP_BASED_OFFICE.has(getExt(f)));
      let re;
      try { re = new RegExp(pattern); } catch (e) { return '错误：正则无效 ' + e.message; }
      const matches = [];
      outer: for (const f of files) {
        let content;
        try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${f}:${i + 1}: ${lines[i].slice(0, 200)}`);
            if (matches.length >= max_results) break outer;
          }
        }
      }
      return matches.length ? matches.join('\n') : '未找到匹配内容';
    },
  },

  /* ---------- 列目录 ---------- */
  list_dir: {
    description: '列出一个目录下的直接子项（文件和子文件夹），不递归。用于了解目录结构。',
    schema: {
      type: 'object',
      properties: { folder: { type: 'string', description: '目录绝对路径' } },
      required: ['folder'],
    },
    readOnly: true,
    permission: 'allow',
    run({ folder }) {
      if (!fs.existsSync(folder)) return '错误：目录不存在 ' + folder;
      let entries;
      try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
      catch (e) { return '错误：无法读取目录'; }
      const lines = entries
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => (e.isDirectory() ? '📁 ' : '📄 ') + e.name);
      return lines.join('\n') || '（空目录）';
    },
  },

  /* ---------- 添加替换规则 ---------- */
  add_replace_rule: {
    description: '向应用的替换框架添加一条替换规则。',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        find: { type: 'string', description: '查找内容' },
        replace: { type: 'string', description: '替换内容（空=删除）' },
      },
      required: ['name', 'find', 'replace'],
    },
    readOnly: false,
    permission: 'allow',
    run({ name, find, replace }, ctx) {
      ctx.rules.push({ id: 'ai' + Date.now() + Math.floor(Math.random() * 1000), name, find, replace: replace ?? '', enabled: true });
      ctx.rulesChanged();
      return `已添加规则「${name}」`;
    },
  },

  /* ---------- 批量替换 ---------- */
  batch_replace: {
    description: '对指定文本文件批量执行替换（用替换框架启用的规则，或直接给定 find/replace）。可覆盖原文件或输出到新目录。需用户确认。',
    schema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '文件绝对路径列表' },
        find: { type: 'string', description: '可选：直接指定查找内容' },
        replace: { type: 'string', description: '可选：直接指定替换内容' },
        output_dir: { type: 'string', description: '可选：输出到该目录（不改原文件）' },
        base_dir: { type: 'string', description: '可选：配合 output_dir 保持目录结构的基准目录' },
      },
      required: ['files'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ files, find, replace, output_dir, base_dir }, ctx) {
      const rules = find !== undefined
        ? [{ find, replace: replace ?? '' }]
        : ctx.rules.filter((r) => r.enabled && r.find);
      if (!rules.length) return '错误：没有可用的替换规则';
      const where = output_dir ? `输出到 ${output_dir}` : '覆盖原文件';
      const ok = await ctx.confirm({ type: 'batch', title: '批量替换', desc: `对 ${files.length} 个文件执行替换（${where}）` });
      if (!ok) return '用户取消了该操作';
      const results = [];
      let total = 0;
      for (const f of files) {
        const ext = getExt(f).toLowerCase().replace(/^\./, '');
        if (LEGACY_OFFICE.has(ext)) {
          // .doc/.xls 老格式：走 LibreOffice 双向转换替换（确定性）
          let r;
          try { r = replaceInLegacyFile(f, rules); }
          catch (e) { results.push(`老格式处理失败 ${f}：${e.message}`); continue; }
          if (!r.content) { results.push(`— ${f}：无匹配`); continue; }
          let target = f;
          if (output_dir) {
            const base = base_dir && f.startsWith(base_dir) ? base_dir : path.dirname(f);
            target = path.join(output_dir, path.relative(base, f));
          }
          try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, r.content);
            total += r.count;
            results.push(`✔ ${target}（老格式）：${r.count} 处`);
          } catch (e) { results.push(`写入失败 ${f}：${e.message}`); }
          continue;
        }
        let content;
        try { content = fs.readFileSync(f, 'utf8'); } catch (e) { results.push(`读取失败 ${f}`); continue; }
        let count = 0, out = content;
        for (const rule of rules) {
          const parts = out.split(rule.find);
          if (parts.length > 1) { count += parts.length - 1; out = parts.join(rule.replace ?? ''); }
        }
        if (count === 0) { results.push(`— ${f}：无匹配`); continue; }
        let target = f;
        if (output_dir) {
          const base = base_dir && f.startsWith(base_dir) ? base_dir : path.dirname(f);
          target = path.join(output_dir, path.relative(base, f));
        }
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, out, 'utf8');
          total += count;
          results.push(`✔ ${target}：${count} 处`);
        } catch (e) { results.push(`写入失败 ${f}：${e.message}`); }
      }
      return `替换完成，累计 ${total} 处：\n` + results.join('\n');
    },
  },

  /* ---------- 打开文件 / 文件夹（系统默认应用） ---------- */
  open_file: {
    description: '用系统默认应用打开一个文件或文件夹（macOS 的 open 命令）。会先请求你授权，授权后才打开。常用于让智能体把处理好的文件直接展示给你，或打开项目目录。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件或文件夹的绝对路径' },
      },
      required: ['path'],
    },
    readOnly: true,
    permission: 'ask',
    async run({ path: p }, ctx) {
      if (!fs.existsSync(p)) return '错误：路径不存在 ' + p;
      const ok = await ctx.confirm({
        type: 'open-file',
        title: '打开文件 / 文件夹',
        desc: '用系统默认应用打开：' + p,
      });
      if (!ok) return '用户取消了该操作';
      try {
        await new Promise((resolve, reject) =>
          execFile('open', [p], { timeout: 15000 }, (err) => (err ? reject(err) : resolve())));
        return '已请求系统打开：' + p;
      } catch (e) {
        return '打开失败：' + e.message;
      }
    },
  },

  /* ---------- 打开网页（默认浏览器） ---------- */
  open_url: {
    description: '在系统默认浏览器中打开一个网页链接。会先请求你授权，授权后才打开。链接必须以 http:// 或 https:// 开头。常用于打开文档、搜索结果或参考页面。',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整的网页地址（http:// 或 https://）' },
      },
      required: ['url'],
    },
    readOnly: true,
    permission: 'ask',
    async run({ url }, ctx) {
      if (!/^https?:\/\//i.test(url)) return '错误：链接必须以 http:// 或 https:// 开头';
      const ok = await ctx.confirm({
        type: 'open-url',
        title: '打开网页',
        desc: '在默认浏览器中打开：' + url,
      });
      if (!ok) return '用户取消了该操作';
      try {
        await new Promise((resolve, reject) =>
          execFile('open', [url], { timeout: 15000 }, (err) => (err ? reject(err) : resolve())));
        return '已请求浏览器打开：' + url;
      } catch (e) {
        return '打开失败：' + e.message;
      }
    },
  },

  /* ---------- 支持的文件类型 ---------- */
  supported_file_types: {
    description: '获取本应用支持的全部文件扩展名列表。',
    schema: { type: 'object', properties: {} },
    readOnly: true,
    permission: 'allow',
    run() { return ALL_EXTS.join(', '); },
  },

  /* ---------- TodoWrite 任务管理 ---------- */
  todo_write: {
    description: '管理任务清单。当任务需要 3 步以上时使用：拆解为待办、逐步标记完成。输入是全量任务列表。status 只能是 pending / in_progress / completed，同时只允许一个 in_progress。',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述（祈使句）' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string', description: '进行时描述（如「正在扫描文件」）' },
            },
            required: ['content', 'status'],
          },
          description: '全量任务列表（整体替换现有列表）',
        },
      },
      required: ['todos'],
    },
    readOnly: true,
    permission: 'allow',
    run({ todos }, ctx) {
      const old = ctx.todos.slice();
      // 全部完成则清空
      const allDone = todos.length && todos.every((t) => t.status === 'completed');
      ctx.setTodos(allDone ? [] : todos);
      return `任务清单已更新（${todos.filter((t) => t.status === 'completed').length}/${todos.length} 已完成）`;
    },
  },

  /* ---------- 子代理 ---------- */
  agent: {
    description: '启动一个子代理在隔离上下文中处理子任务，只返回最终结果。subagent_type：general（通用，全部工具）/ explore（只读探索：读文件、搜索、扫描，不能写）。适合耗时的探索或需要独立处理的任务。',
    schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-5 词的子任务描述' },
        prompt: { type: 'string', description: '给子代理的完整任务说明' },
        subagent_type: { type: 'string', enum: ['general', 'explore'], description: '默认 general' },
      },
      required: ['description', 'prompt'],
    },
    readOnly: false,
    permission: 'allow',
    async run({ description, prompt, subagent_type = 'general' }, ctx) {
      ctx.emit('subagent-start', { description, type: subagent_type });
      const result = await runAgentLoop(ctx.profile, ctx.apiType, prompt, {
        ...ctx,
        depth: (ctx.depth || 0) + 1,
        system: buildSubagentPrompt(subagent_type),
        allowedTools: subagent_type === 'explore'
          ? ['read_file', 'glob_files', 'grep_files', 'list_dir']
          : null, // general 用全部工具（但不再嵌套子代理）
        maxTurns: SUBAGENT_MAX_TURNS,
        isSubagent: true,
      });
      ctx.emit('subagent-end', { description });
      return result.text || '（子代理无输出）';
    },
  },

  /* ---------- 格式转换（textutil，macOS 自带） ---------- */
  convert_file: {
    description: '转换文件格式（doc/docx/rtf/odt/html/txt/md 互转，本地 textutil 引擎）。PDF 目标/源不支持时改用「文件格式转换」模块。',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '源文件绝对路径' },
        to: { type: 'string', description: '目标格式扩展名，如 docx/html/txt/md/rtf/odt' },
        output: { type: 'string', description: '输出文件绝对路径（可选，默认源文件同目录换扩展名）' },
      },
      required: ['path', 'to'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ path: p, to, output }, ctx) {
      if (!fs.existsSync(p)) return '错误：文件不存在 ' + p;
      const toExt = String(to || '').replace(/^\./, '').toLowerCase();
      const TEXTUTIL = { txt: 'txt', html: 'html', rtf: 'rtf', rtfd: 'rtfd', doc: 'doc', docx: 'docx', odt: 'odt', webarchive: 'webarchive' };
      if (!TEXTUTIL[toExt]) return `错误：不支持的目标格式「${toExt}」。支持：${Object.keys(TEXTUTIL).join('/')}`;
      const dst = output || path.join(path.dirname(p), path.basename(p, path.extname(p)) + '.' + toExt);
      const ok = await ctx.confirm({ type: 'convert_file', title: '格式转换', desc: `${p} → ${dst}` });
      if (!ok) return '已取消：用户未授权该转换';
      return new Promise((resolve) => {
        execFile('textutil', ['-convert', TEXTUTIL[toExt], '-output', dst, p], { timeout: 120000 }, (err, _so, se) => {
          if (err) resolve('转换失败：' + ((se || err.message) + '').trim().slice(0, 200));
          else resolve(`转换完成：${dst}`);
        });
      });
    },
  },

  /* ---------- 看图（视觉输入） ---------- */
  view_image: {
    description: '查看一张图片的内容（png/jpg/jpeg/gif/webp/bmp）。返回图片元数据，图片本身会作为视觉输入提供给你。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '图片文件绝对路径' } },
      required: ['path'],
    },
    readOnly: true,
    permission: 'allow',
    run({ path: p }) {
      if (!fs.existsSync(p)) return '错误：文件不存在 ' + p;
      const ext = path.extname(p).replace('.', '').toLowerCase();
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
      const mime = mimeMap[ext];
      if (!mime) return `错误：不支持的图片格式「${ext}」（支持 png/jpg/jpeg/gif/webp/bmp）`;
      const stat = fs.statSync(p);
      if (stat.size > 10 * 1024 * 1024) return `错误：图片过大（${(stat.size / 1048576).toFixed(1)}MB），请先用 run_command 调 sips 缩小到 10MB 以内再看`;
      let dims = '';
      try { dims = imageDims(fs.readFileSync(p), ext); } catch (e) {}
      const b64 = fs.readFileSync(p).toString('base64');
      return {
        __image: true, mime, base64: b64,
        note: `已加载图片：${p}（${ext}${dims ? '，' + dims : ''}，${(stat.size / 1024).toFixed(0)}KB）。图片内容见随后的视觉输入。`,
      };
    },
  },

  /* ---------- 终端命令（需授权） ---------- */
  run_command: {
    description: '执行 macOS 终端命令（如 sips 图片处理、mdls 元数据、zip 压缩等）。用户会先收到授权提示，同意后才执行。',
    schema: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
      required: ['command'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ command }, ctx) {
      if (!command || !String(command).trim()) return '错误：命令为空（这是常见模型幻觉。请重新整理思路，明确要执行的命令后再调用 run_command；如果你已经完成任务，请用普通文本回复用户。）';
      const ok = await ctx.confirm({ type: 'run_command', title: '执行终端命令', desc: String(command).slice(0, 300) });
      if (!ok) return '已取消：用户未授权该命令';
      return new Promise((resolve) => {
        exec(String(command), { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = (stdout || '').trim();
          const errOut = (stderr || '').trim();
          if (err) resolve(`命令退出码 ${err.code ?? '?'}${errOut ? '：' + errOut.slice(0, 500) : ''}${out ? '\n输出：' + out.slice(0, 2000) : ''}`);
          else resolve(out || '（命令已执行，无输出）' + (errOut ? '\nstderr：' + errOut.slice(0, 300) : ''));
        });
      });
    },
  },

  /* ---------- 技能包 ---------- */
  skill: {
    description: '调用一个技能包来获取专项操作指引。可用技能：' +
      Object.entries(SKILLS).map(([k, v]) => `${k}（${v.description}）`).join('；'),
    schema: {
      type: 'object',
      properties: { skill: { type: 'string', description: '技能名称' } },
      required: ['skill'],
    },
    readOnly: true,
    permission: 'allow',
    run({ skill }) {
      const s = SKILLS[skill];
      if (!s) return `错误：未知技能「${skill}」。可用：${Object.keys(SKILLS).join(', ')}`;
      let body = s.body;
      const prereqs = SKILL_PREREQS[skill] || [];
      if (prereqs.length) {
        const list = prereqs.map((p) => `- ${p.name}（id=${p.id}）：${p.desc}`).join('\n');
        body += `\n\n## 环境依赖自检（执行任务前必须完成）\n本技能依赖以下本地运行环境，请在开始正式任务前先调用 check_dependencies 工具（参数 skill="${skill}"）逐项自检；若返回「缺失」项，请调用 install_dependency 工具（参数 skill="${skill}"、id=该缺失项 id）请求用户授权，用户确认后 AI 助手会自动安装，安装完成后再继续任务。不要跳过自检直接执行导出等步骤。\n依赖清单：\n${list}`;
      }
      return `<skill name="${skill}">\n${body}\n</skill>\n请按以上指引执行。`;
    },
  },

  /* ---------- 安装推荐技能（执行中按需安装） ---------- */
  install_skill: {
    description: '安装一个推荐技能包到本机。当任务需要某个尚未安装的技能时调用此工具，用户确认后自动安装。可用推荐技能：' +
      Object.entries(RECOMMENDED_SKILLS).map(([k, v]) => `${k}（${v.description}）`).join('；'),
    schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '要安装的推荐技能名称' },
      },
      required: ['skill'],
    },
    permission: 'ask',
    async run({ skill }, ctx) {
      const def = RECOMMENDED_SKILLS[skill];
      if (!def) return `错误：未知推荐技能「${skill}」。可用：${Object.keys(RECOMMENDED_SKILLS).join(', ')}`;
      if (SKILLS[skill]) return `技能「${skill}」已安装，可直接用 skill 工具调用。`;
      // 请求用户授权安装
      if (ctx.onInstallSkill) {
        const approved = await ctx.onInstallSkill({ name: skill, description: def.description, category: def.category });
        if (!approved) return `用户拒绝了安装技能「${skill}」。请尝试其他方式完成任务。`;
      }
      // 安装技能：写入 SKILL.md 并重新加载
      if (ctx.skillsDir) {
        let ok = false, errMsg = '';
        if (def.repo) {
          // 仓库型技能：从 GitHub 下载（需主进程支持 installSkillFromUrl）
          if (ctx.installSkillFromUrl) {
            try {
              const r = await ctx.installSkillFromUrl(def.repo, def.branch || 'main', skill);
              if (r && r.ok) ok = true; else errMsg = (r && r.error) || '安装失败（未知原因）';
            } catch (e) { errMsg = e.message; }
          } else {
            errMsg = '当前运行环境不支持从仓库安装，请到「AI 设置 → 智能体技能 → 推荐技能」中点击「安装」。';
          }
        } else {
          // 内联 body 写入
          const dir = path.join(ctx.skillsDir, skill);
          try {
            fs.mkdirSync(dir, { recursive: true });
            const md = `---\nname: ${skill}\ndescription: ${def.description}\n---\n\n${def.body}`;
            fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
            ok = true;
          } catch (e) { errMsg = e.message; }
        }
        if (!ok) return `安装技能「${skill}」失败：${errMsg}`;
        loadExternalSkills(ctx.skillsDir);
        if (def.prerequisites) SKILL_PREREQS[skill] = def.prerequisites;
      }
      return `技能「${skill}」已安装成功！现在可以用 skill 工具调用「${skill}」获取操作指引，然后按指引执行任务。`;
    },
  },

  /* ---------- 技能环境依赖自检 / 自动安装 ---------- */
  check_dependencies: {
    description: '检查某个已安装技能所需的本地运行环境（如 Node.js 18+、Python 3）是否已具备，返回每项依赖的满足 / 缺失状态。当技能带有环境依赖、你正准备执行该技能的任务前，应先调用本工具自检。',
    schema: {
      type: 'object',
      properties: { skill: { type: 'string', description: '技能名称，如 open-kimi-ppt' } },
      required: ['skill'],
    },
    readOnly: true,
    permission: 'allow',
    async run({ skill }, ctx) {
      const prereqs = SKILL_PREREQS[skill] || [];
      if (!prereqs.length) return `技能「${skill}」没有声明需要自检的环境依赖。`;
      const lines = [];
      const missing = [];
      for (const p of prereqs) {
        let ok = false;
        try {
          ok = await new Promise((res) => exec(p.check, { timeout: 20000, windowsHide: true }, (err) => res(!err)));
        } catch { ok = false; }
        const tag = ok ? '✅ 已满足' : (p.optional ? '⚪️ 可选缺失' : '❌ 缺失');
        lines.push(`${tag}  ${p.name}（id=${p.id}）：${p.desc}`);
        if (!ok && !p.optional) missing.push(p.id);
      }
      let out = `技能「${skill}」环境依赖自检：\n` + lines.join('\n');
      out += missing.length
        ? `\n\n缺失项 id：${missing.join('、')}。请调用 install_dependency 工具（skill="${skill}"、id=对应缺失项）请求用户授权后自动安装，装完再继续。`
        : `\n\n全部依赖已满足，可以正常执行任务。`;
      return out;
    },
  },

  install_dependency: {
    description: '为某个已安装技能安装缺失的本地运行环境（如 Node.js 18+）。调用前请先用 check_dependencies 确认该依赖缺失，并把缺失项的 id 传进来。会先请求用户授权，用户确认后由 AI 助手自动执行安装命令（可能需要联网、耗时数分钟）。',
    schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能名称' },
        id: { type: 'string', description: '依赖 id（来自 check_dependencies 返回的缺失项）' },
      },
      required: ['skill', 'id'],
    },
    readOnly: false,
    permission: 'ask',
    async run({ skill, id }, ctx) {
      const prereqs = SKILL_PREREQS[skill] || [];
      const p = prereqs.find((x) => x.id === id);
      if (!p) return `错误：技能「${skill}」没有名为「${id}」的依赖（可用：${(prereqs.map((x) => x.id).join(', ')) || '无'}）。`;
      const approved = await ctx.confirm({
        type: 'install_dependency',
        title: `授权安装 ${p.name}`,
        desc: `「${skill}」需要 ${p.name}。\n${p.desc}\n\n点击「确定」后，AI 助手将自动安装（可能需要联网下载，耗时约数分钟，请耐心等待完成提示）。`,
      });
      if (!approved) return `已取消：用户未授权安装 ${p.name}。`;
      return new Promise((resolve) => {
        exec(p.install, { timeout: 600000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          if (err) resolve(`安装 ${p.name} 失败（退出码 ${err.code ?? '?'}）：${(stderr || err.message || '').slice(0, 800)}\n${(stdout || '').slice(0, 600)}`);
          else resolve(`✅ 已成功安装 ${p.name}。\n${(stdout || '').trim().slice(0, 1500)}`);
        });
      });
    },
  },

  /* ---------- 联网搜索（需开启联网开关） ---------- */
  web_search: {
    description: '联网搜索互联网信息。返回搜索结果列表（标题、链接、摘要）。用于查找最新信息、技术文档、API 用法、新闻等。每次最多返回 8 条结果。',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        max_results: { type: 'number', description: '最大返回条数，默认 8' },
      },
      required: ['query'],
    },
    readOnly: true,
    permission: 'allow',
    needsWeb: true,
    async run({ query, max_results = 8 }) {
      if (!query || !query.trim()) return '错误：搜索关键词不能为空';
      return new Promise((resolve) => {
        const ddgUrl = 'https://html.duckduckgo.com/html/';
        const postData = `q=${encodeURIComponent(query)}&kp=-2&kl=cn-zh`;
        const req = https.request(ddgUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 15000,
        }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const results = [];
              const blocks = body.split(/<div class="result results_links[^"]*">/);
              for (const block of blocks.slice(1)) {
                if (results.length >= max_results) break;
                const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
                const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
                const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
                if (titleMatch && urlMatch) {
                  const title = titleMatch[1].replace(/<[^>]*>/g, '').trim();
                  let url = urlMatch[1];
                  // DuckDuckGo 的链接是跳转链接，提取实际 URL
                  const uddg = url.match(/uddg=([^&]*)/);
                  if (uddg) url = decodeURIComponent(uddg[1]);
                  const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';
                  results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippet}`);
                }
              }
              if (!results.length) {
                resolve(`搜索「${query}」未找到结果。`);
              } else {
                resolve(`搜索「${query}」的结果：\n\n${results.join('\n\n')}`);
              }
            } catch (e) {
              resolve(`搜索出错：${e.message}`);
            }
          });
        });
        req.on('error', (e) => resolve(`搜索请求失败：${e.message}`));
        req.on('timeout', () => { req.destroy(); resolve('搜索超时，请稍后重试'); });
        req.write(postData);
        req.end();
      });
    },
  },

  /* ---------- 联网读取网页（需开启联网开关） ---------- */
  web_fetch: {
    description: '读取一个网页的文本内容。输入 URL，返回网页正文的纯文本（自动去除 HTML 标签、脚本、样式）。用于读取文章、文档、API 响应等。最多返回 8000 字符。',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要读取的网页 URL（http:// 或 https://）' },
        max_length: { type: 'number', description: '最大返回字符数，默认 8000' },
      },
      required: ['url'],
    },
    readOnly: true,
    permission: 'allow',
    needsWeb: true,
    async run({ url, max_length = 8000 }) {
      if (!url || !/^https?:\/\//i.test(url)) return '错误：URL 必须以 http:// 或 https:// 开头';
      return new Promise((resolve) => {
        const u = new URL(url);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(u, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          timeout: 20000,
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // 跟随重定向
            const newUrl = new URL(res.headers.location, url).href;
            res.resume();
            return resolve(this.run({ url: newUrl, max_length }));
          }
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              // 去除 script/style 标签及内容
              let text = body
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                .replace(/<footer[\s\S]*?<\/footer>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '');
              // 去除所有 HTML 标签
              text = text.replace(/<[^>]+>/g, ' ');
              // 解码 HTML 实体
              text = text
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
              // 压缩空白
              text = text.replace(/\s+/g, ' ').trim();
              if (!text) {
                resolve(`网页 ${url} 未提取到文本内容（可能是纯图片/视频页面或需要登录）。`);
              } else {
                const truncated = text.length > max_length ? text.slice(0, max_length) + '\n\n（内容已截断，共 ' + text.length + ' 字符）' : text;
                resolve(`网页 ${url} 的内容：\n\n${truncated}`);
              }
            } catch (e) {
              resolve(`解析网页出错：${e.message}`);
            }
          });
        });
        req.on('error', (e) => resolve(`请求失败：${e.message}`));
        req.on('timeout', () => { req.destroy(); resolve('请求超时，请稍后重试'); });
        req.end();
      });
    },
  },
};

/* ================= 协议适配 ================= */

/* ================= 硬停止（需求 #1：点「停止」立即取消 Agent 循环 + 在途模型请求） ================= */
// 用模块级标志 + AbortController 切断正在飞的 HTTP 请求；ComputerUse 子进程的中断由 main.js 的
// computer-use-abort IPC 另行触发（杀在途 osascript）。两者合力覆盖「停止」语义的全部维度。
let _stopRequested = false;
let _currentAbort = null; // 当前轮次的 AbortController

function requestStop() {
  _stopRequested = true;
  if (_currentAbort && typeof _currentAbort.abort === 'function') {
    try { _currentAbort.abort(); } catch (e) { /* ignore */ }
  }
}
function clearStop() {
  _stopRequested = false;
  _currentAbort = null;
}
function isStopRequested() { return _stopRequested; }

function httpPostJson(urlStr, headers, body, timeoutMs = 300000, signal = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Accept-Encoding': 'identity', ...headers },
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败')); }
          } else {
            let msg = data.slice(0, 300);
            try { msg = JSON.parse(data).error?.message || msg; } catch (e) {}
            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时（模型响应过久，请稍后重试或切换更快的模型）')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 带重试的 API 调用：超时/网络错误自动重试最多 2 次，指数退避
async function httpPostJsonWithRetry(urlStr, headers, body, timeoutMs = 300000, maxRetries = 2, signal = null) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await httpPostJson(urlStr, headers, body, timeoutMs, signal);
    } catch (e) {
      lastErr = e;
      const isRetryable = /请求超时|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|HTTP 429|HTTP 502|HTTP 503|HTTP 504/i.test(e.message);
      if (!isRetryable || attempt === maxRetries) throw e;
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000); // 1s, 2s, 4s... 最多 8s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 把已连接的 MCP 服务器的工具包装成本地工具条目
// serverName 指定时只返回该服务器的工具（用户在聊天栏单选了某个服务器时使用）
function buildMcpToolList(serverName) {
  let defs = [];
  try {
    const mcp = require('./mcp');
    defs = mcp.getMcpToolDefs() || [];
  } catch (e) { return []; }
  if (serverName) defs = defs.filter((d) => d.serverName === serverName);
  return defs.map((d) => ({
    name: d.toolName,
    serverName: d.serverName,
    description: `[MCP·${d.serverName}] ${d.description || d.originalName}`,
    schema: normalizeMcpSchema(d.schema),
    tool: {
      description: d.description,
      schema: normalizeMcpSchema(d.schema),
      readOnly: false,
      permission: 'ask',
      isMcp: true,
      async run(args, ctx) {
        const brief = JSON.stringify(args || {}).slice(0, 300);
        // 内置 Computer Use 服务器：由应用设置统一授权，跳过逐次确认直接执行
        const trusted = d.serverName === 'ComputerUse';
        if (!trusted) {
          const ok = await ctx.confirm({
            type: 'mcp',
            title: `调用 MCP 工具（${d.serverName}）`,
            desc: `${d.originalName}\n参数：${brief}`,
          });
          if (!ok) return '用户取消了该操作';
        }
        try {
          const mcp = require('./mcp');
          return await mcp.callTool(d.serverName, d.originalName, args || {});
        } catch (e) {
          return `MCP 工具调用失败：${e.message}`;
        }
      },
    },
  }));
}

// MCP 的 inputSchema 可能缺字段，补全成各家 API 都能接受的形式
function normalizeMcpSchema(schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  if (s.type !== 'object') s.type = 'object';
  if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  if (s.required && !Array.isArray(s.required)) delete s.required;
  return s;
}

// mcpEnabled=false 时不注入外部 MCP；已开启的内置 ComputerUse 仍默认可用
// mcpServer 指定时只注入该服务器的工具（用户单选了某个服务器）
function buildToolList(allowedTools, isSubagent, webAccess, mcpEnabled = true, mcpServer = null) {
  const local = Object.entries(tools)
    .filter(([name, t]) => {
      if (allowedTools) return allowedTools.includes(name);
      if (isSubagent && name === 'agent') return false; // 子代理不再嵌套子代理
      if (t.needsWeb && !webAccess) return false; // 联网工具需开启开关
      return true;
    })
    .map(([name, t]) => ({ name, description: t.description, schema: t.schema, tool: t }));

  const allowedMcpTool = (t) => !allowedTools || allowedTools.includes(t.name);
  // 内置 ComputerUse 是本机能力，不跟随聊天栏的“外部 MCP”开关隐藏。
  const builtinComputerUse = buildMcpToolList('ComputerUse').filter(allowedMcpTool);
  const externalMcp = mcpEnabled
    ? buildMcpToolList(mcpServer)
        .filter((t) => t.serverName !== 'ComputerUse')
        .filter(allowedMcpTool)
    : [];
  const seen = new Set();
  const mcpTools = builtinComputerUse.concat(externalMcp).filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });

  return local.concat(mcpTools);
}

async function callApi(profile, apiType, system, messages, toolList, signal = null) {
  const base = profile.baseUrl.replace(/\/+$/, '');
  if (apiType === 'anthropic') {
    const msgUrl = /\/v\d+(?:\.\d+)?$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
    const toolDefs = toolList.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
    const resp = await httpPostJsonWithRetry(
      msgUrl,
      { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' },
      { model: profile.model, max_tokens: 8192, system, tools: toolDefs.length ? toolDefs : undefined, messages },
      undefined, undefined, signal
    );
    const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = resp.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return {
      text, toolCalls,
      usage: resp.usage ? { input: resp.usage.input_tokens, output: resp.usage.output_tokens } : null,
      assistantMessage: { role: 'assistant', content: resp.content },
      makeToolResults: (results) => ({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.result).slice(0, 30000) })),
      }),
    };
  }
  // openai 兼容
  const toolDefs = toolList.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const apiMessages = [{ role: 'system', content: system }, ...messages];
  const resp = await httpPostJsonWithRetry(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${profile.apiKey}` },
    { model: profile.model, messages: apiMessages, tools: toolDefs.length ? toolDefs : undefined, tool_choice: 'auto' },
    undefined, undefined, signal
  );
  const choice = resp.choices[0].message;
  const toolCalls = (choice.tool_calls || []).map((tc) => {
    let input = {};
    try { input = JSON.parse(tc.function.arguments); } catch (e) {}
    return { id: tc.id, name: tc.function.name, input };
  });
  return {
    text: choice.content || '',
    toolCalls,
    usage: resp.usage ? { input: resp.usage.prompt_tokens, output: resp.usage.completion_tokens } : null,
    assistantMessage: choice,
    openaiStyle: true,
  };
}

/* ================= 系统提示词 ================= */

function buildSystemPrompt(webAccess, mcpEnabled = true, mcpServer = null, chatId = null) {
  const home = os.homedir();
  const skillList = Object.entries(SKILLS).map(([k, v]) => `- ${k}：${v.description}`).join('\n');
  // 推荐技能：尚未安装的列出来，提示模型可按需安装
  const installedNames = new Set(Object.keys(SKILLS));
  const recommendedList = Object.entries(RECOMMENDED_SKILLS)
    .filter(([k]) => !installedNames.has(k))
    .map(([k, v]) => `- ${k}：${v.description}`)
    .join('\n');
  const recommendedSection = recommendedList
    ? `\n\n## 推荐技能（未安装）\n以下技能尚未安装，如任务需要可调用 install_skill 工具安装（用户确认后生效）：\n${recommendedList}`
    : '';
  const webToolsLine = webAccess
    ? '、联网搜索(web_search)、读取网页(web_fetch)'
    : '';
  const webGuidance = webAccess
    ? `\n- 需要查最新信息、技术文档、新闻时用 web_search 搜索互联网；需要读取某个网页的详细内容时用 web_fetch。`
    : '';
  // 内置 ComputerUse 不受聊天栏 MCP 开关影响；该开关只控制用户配置的外部 MCP。
  // mcpServer 指定时只筛选外部服务器，内置 ComputerUse 仍保留。
  let mcpSection = '';
  try {
    const defs = require('./mcp').getMcpToolDefs() || [];
    const builtinDefs = defs.filter((d) => d.serverName === 'ComputerUse');
    const externalDefs = defs.filter((d) =>
      d.serverName !== 'ComputerUse' && (!mcpServer || d.serverName === mcpServer)
    );
    if (builtinDefs.length) {
      const lines = builtinDefs
        .map((d) => `  - ${d.toolName}：${(d.description || d.originalName).slice(0, 160)}`)
        .join('\n');
      mcpSection += `\n\n## 内置 ComputerUse 工具（默认可用）\n内置 ComputerUse 用于截图、鼠标移动/点击、键盘输入和打开本机应用，不受聊天栏“外部 MCP”开关影响。用户要求操作屏幕时优先使用这些工具，并按截图确认目标、移动后短暂停顿、点击后再次截图验证的流程执行；工具自带可见鼠标效果。\n${lines}`;
    }
    if (mcpEnabled && externalDefs.length) {
      const byServer = {};
      for (const d of externalDefs) {
        (byServer[d.serverName] = byServer[d.serverName] || []).push(
          `  - ${d.toolName}：${(d.description || d.originalName).slice(0, 160)}`
        );
      }
      const lines = Object.entries(byServer)
        .map(([s, arr]) => `- 服务器 ${s}：\n${arr.join('\n')}`)
        .join('\n');
      mcpSection += `\n\n## MCP 外部工具（用户已接入）\n以下工具由用户配置的 MCP 服务器提供，命名规则 mcp__<服务器>__<工具名>，调用前会请求用户授权：\n${lines}\n优先在这些工具能力覆盖的场景使用它们（例如数据库、云服务、第三方 API）。`;
    }
  } catch (e) { /* ignore */ }
  // 长期记忆注入：用户级 + 当前对话级
  const userMem = memory.formatMemory('user', null, 30);
  const chatMem = chatId ? memory.formatMemory('chat', chatId, 15) : '';
  const memorySection = userMem || chatMem
    ? `\n\n## 长期记忆（来自历史对话的总结）\n以下信息是从你与 AI 的历史对话中自动提炼的，回答时请参考，但不必复述给正在看的用户。\n${userMem ? userMem + '\n' : ''}${chatMem ? chatMem + '\n' : ''}`
    : '';
  return `你是「AI Copilot」应用内嵌的智能体，运行在本机（macOS）。你可以自主查找、读取、修改、创建本机文件，帮助用户：替换内容、编写文件、修改文件、完善文件、排版文件。

## 环境
- 用户主目录：${home}
- 桌面：${home}/Desktop，文稿：${home}/Documents，下载：${home}/Downloads
- 已安装技能目录：${CURRENT_SKILLS_DIR || '（暂无，技能安装后位于用户数据目录下的 skills/）'}（每个技能一个子目录，内含 SKILL.md 与 scripts/ 等；运行技能里的脚本时用此目录的绝对路径，例如 <已安装技能目录>/<技能名>/scripts/xxx.py）

## 可用工具
读取(read_file)、编写(write_file)、局部修改(edit_file)、扫描文件夹(glob_files)、搜索内容(grep_files)、列目录(list_dir)、添加替换规则(add_replace_rule)、批量替换(batch_replace)、打开文件(open_file)、打开网页(open_url)、格式转换(convert_file)、查看图片(view_image)、终端命令(run_command)、任务清单(todo_write)、子代理(agent)、技能包(skill)${webToolsLine}。

## 工作指引
- 写文件、修改文件、批量替换、打开文件、打开网页等敏感操作前，工具会向用户请求授权，你正常调用即可；用户拒绝则操作中止。
- 修改文件前先 read_file 确认内容；edit_file 的 old_string 必须唯一匹配。
- 复杂任务（3 步以上）先用 todo_write 拆解任务清单，逐项执行并更新状态。
- 大量文件探索或需要独立处理的子任务，可用 agent 启动子代理（explore 只读 / general 通用）。
- 遇到专项场景（批量更名、润色、排版、概览文件夹、格式转换、看图、终端操作）可用 skill 调用对应技能包获取指引。
- 如果任务需要尚未安装的推荐技能（如 PDF 处理、深度研究、代码审查等），可用 install_skill 安装，用户确认后自动启用。
- 给用户的一批文件做统一替换时，优先 add_replace_rule + batch_replace，与应用「替换框架」联动。
- 格式转换用 convert_file（doc/docx/rtf/odt/html/txt/md 互转）；用户让你看图片时用 view_image；需要系统命令时用 run_command（会请求用户授权）。
- docx/pptx/xlsx 等 Office 压缩格式你无法直接读写内部文本，遇到时告知用户可用「按规则替换文件」向导（本地引擎支持）。
- 回答用中文，简洁。操作完成后简要汇报。${webGuidance}

## 长任务连续性（重要）
- 一次性任务应当一气呵成：建立 todo 后，逐项推进，每完成一项立刻更新 todo 状态，不要中途停下总结、问"是否继续"。
- 若中途遇到错误，记录错误信息继续推进下一项，最后一并汇报。
- 不要因为工具调用多就主动暂停等待用户确认；只有需要授权的敏感操作（写/改/执行命令/打开）才会弹窗，其余自主决策。
- 一次性回复中最多 40 轮工具调用（系统限制），如超出请用普通文本回复用户当前进度，让用户说"继续"再续做。

## 技能包
${skillList}${recommendedSection}${mcpSection}${memorySection}`;
}

async function extractMemoryFacts(profile, apiType, messages) {
  if (!Array.isArray(messages) || messages.length < 3) return;
  // 取最近 12 条（足够提炼，又不浪费 token）
  const recent = messages.slice(-12).map((m) => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return `[${m.role}] ${String(c).slice(0, 1500)}`;
  }).join('\n\n');
  const prompt = `请从以下最近对话中提炼关于用户的长期事实、偏好、习惯、项目约定或关键决策。\n输出严格 JSON，不要任何解释：\n{"facts":[{"category":"preference|habit|project|convention|decision|error|other","content":"简洁的一句话事实","confidence":0.0-1.0}]}\n\n对话记录：\n${recent}`;
  try {
    const r = await callApi(profile, apiType, '你是对话记忆提炼助手。只输出 JSON。', [{ role: 'user', content: prompt }], []);
    const text = (r.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const data = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(data.facts) || !data.facts.length) return;
    const existing = memory.loadMemory('user');
    const merged = memory.mergeMemory(existing, data.facts);
    memory.saveMemory('user', null, merged);
  } catch (e) {
    // 记忆提炼失败不应影响主流程
  }
}

function buildSubagentPrompt(type) {
  const home = os.homedir();
  if (type === 'explore') {
    return `你是一个只读探索子代理，运行在本机（主目录 ${home}）。只能用 read_file、glob_files、grep_files、list_dir 搜索和阅读文件，不能修改任何文件。完成后给出清晰的发现报告。用中文。`;
  }
  return `你是一个通用子代理，运行在本机（主目录 ${home}）。可使用全部文件工具（读/写/改/搜索/扫描）完成交办的任务。写操作需用户确认。完成后简要汇报结果。用中文。`;
}

/* ================= 上下文压缩 ================= */
// 累计输入 token 超阈值时，把历史压缩成摘要 + 保留最近 N 条
async function compactHistory(profile, apiType, messages) {
  const textDump = messages
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${String(c).slice(0, 2000)}`;
    })
    .join('\n\n');
  const summaryPrompt = `请把以下对话历史压缩成一份详细摘要，保留：用户的请求、已完成的操作、涉及的文件路径、替换规则、关键决策、遇到的错误。按时间线梳理，供后续对话无缝衔接。\n\n${textDump.slice(0, 60000)}`;
  try {
    const r = await callApi(profile, apiType, '你是对话摘要助手。只输出摘要，不要调用工具。',
      [{ role: 'user', content: summaryPrompt }], []);
    return r.text || null;
  } catch (e) {
    return null;
  }
}

/* ================= 消息历史清洗（修复 tool/tool_calls 配对） ================= */
// 上下文压缩/裁剪若把「assistant 的 tool_calls」与「对应 tool 结果」拆散，
// 模型 API（DeepSeek/OpenAI 等）会报 HTTP 400:
//   Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
// 这里在每次调用 API 前清洗历史：
//  1. 丢弃没有匹配 tool_calls 的孤儿 tool 消息；
//  2. 对「带了 tool_calls 却没有对应结果」的 assistant 消息，去掉其 tool_calls（退化为普通文本）。
function sanitizeMessages(messages, apiType) {
  if (!Array.isArray(messages)) return messages;

  if (apiType === 'anthropic') {
    // Anthropic：tool_result 块在 user 消息 content 里，需匹配前一条 assistant 的 tool_use
    const out = [];
    let validIds = new Set();
    for (const m of messages) {
      if (m.role === 'assistant') {
        validIds = new Set();
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) if (b && b.type === 'tool_use') validIds.add(b.id);
        out.push(m);
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        const filtered = m.content.filter((b) => !b || b.type !== 'tool_result' || validIds.has(b.tool_use_id));
        if (filtered.length) out.push({ ...m, content: filtered });
        // 若整条都是孤儿 tool_result，则丢弃该消息
      } else {
        validIds = new Set();
        out.push(m);
      }
    }
    return out;
  }

  // openai 兼容
  const out = [];
  let validIds = new Set();
  for (const m of messages) {
    if (m.role === 'assistant') {
      validIds = new Set((Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => tc && tc.id));
      out.push(m);
    } else if (m.role === 'tool') {
      if (validIds.has(m.tool_call_id)) out.push(m); // 合法：紧跟在声明了该 id 的 assistant 之后
      // 否则丢弃孤儿 tool 消息
    } else {
      validIds = new Set();
      out.push(m);
    }
  }
  // 反向：assistant 带 tool_calls 但其后没有对应 tool 结果 → 去掉 tool_calls，避免「tool_calls 后必须跟 tool」类报错
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map((tc) => tc && tc.id);
      const following = new Set();
      for (let j = i + 1; j < out.length && out[j].role === 'tool'; j++) following.add(out[j].tool_call_id);
      const allAnswered = ids.every((id) => following.has(id));
      if (!allAnswered) {
        const { tool_calls, ...rest } = m;
        out[i] = rest;
      }
    }
  }
  return out;
}

/* ================= Agent Loop（核心，主对话与子代理共用） ================= */
// opts: { system, allowedTools, maxTurns, isSubagent }
async function runAgentLoop(profile, apiType, userText, ctx, opts = {}) {
  // 本轮 AbortController：停止时中断正在飞的模型 HTTP 请求
  const ac = new AbortController();
  _currentAbort = ac;
  const system = opts.system || buildSystemPrompt(ctx.webAccess, ctx.mcpEnabled, ctx.mcpServer, ctx.chatId);
  const maxTurns = opts.maxTurns || MAX_TURNS;
  const toolList = buildToolList(opts.allowedTools, opts.isSubagent, ctx.webAccess, ctx.mcpEnabled, ctx.mcpServer);

  // 接收完整消息历史（含 tool_calls/tool/tool_result），不仅取 role+content；
  // 这样续接对话时模型能看到之前的工具调用和结果，不会"忘记"上下文。
  let messages = Array.isArray(ctx.history) ? ctx.history.map((m) => {
    const out = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    return out;
  }) : [];
  // 本轮用户消息：若带附件则构建多模态 content 数组（图片→image，文档→文本块），否则纯文本
  const atts = ctx.attachments || [];
  let userContent;
  if (atts.length) {
    userContent = [{ type: 'text', text: userText || '（请查看附件）' }];
    for (const a of atts) {
      if (a.kind === 'image') {
        if (apiType === 'anthropic') {
          userContent.push({ type: 'image', source: { type: 'base64', media_type: a.mime || 'image/png', data: a.base64 } });
        } else {
          userContent.push({ type: 'image_url', image_url: { url: `data:${a.mime || 'image/png'};base64,${a.base64}` } });
        }
      } else if (a.kind === 'doc' && a.text) {
        userContent.push({ type: 'text', text: `【附件「${a.name || '文档'}」内容】\n${a.text}` });
      } else if (a.error) {
        userContent.push({ type: 'text', text: `【附件「${a.name || '文件'}」无法读取：${a.error}】` });
      }
    }
  } else {
    userContent = userText;
  }
  messages.push({ role: 'user', content: userContent });

  let totalUsage = { input: 0, output: 0 };
  let finalText = '';
  let compacted = false;
  // 根据当前模型动态计算压缩阈值（模型支持 1M 就用 1M，2M 就用 2M）
  const compactThreshold = getCompactThreshold(profile.model);

  for (let turn = 0; turn < maxTurns; turn++) {
    // 需求 #1：停止后不再发起任何模型请求、不再执行工具、不再进入下一轮
    if (_stopRequested) {
      _currentAbort = null;
      return { ok: true, stopped: true, text: (finalText || '') + '\n\n（已按你的要求停止。）', usage: totalUsage, messages };
    }
    // 上下文压缩：主对话且超阈值时触发
    if (!opts.isSubagent && !compacted && totalUsage.input > compactThreshold && messages.length > KEEP_RECENT_TURNS + 2) {
      ctx.emit('compact', {});
      const summary = await compactHistory(profile, apiType, messages);
      if (summary) {
        const tail = messages.slice(-KEEP_RECENT_TURNS);
        messages = [
          { role: 'user', content: `【前情摘要】\n${summary}\n\n（以上为历史对话摘要，请基于此继续）` },
          ...tail,
        ];
        compacted = true;
      }
    }

    // 调用前清洗历史，确保 tool / tool_calls 配对（防压缩导致的 HTTP 400）
    let r;
    try {
      r = await callApi(profile, apiType, system, sanitizeMessages(messages, apiType), toolList, ac.signal);
    } catch (e) {
      // 停止导致的请求中断（AbortError）或已请求停止 → 直接结束，不算异常
      if (_stopRequested || e.name === 'AbortError') {
        _currentAbort = null;
        return { ok: true, stopped: true, text: (finalText || '') + '\n\n（已按你的要求停止。）', usage: totalUsage, messages };
      }
      throw e;
    }
    if (r.usage) { totalUsage.input += r.usage.input; totalUsage.output += r.usage.output; }
    if (r.text) { finalText = r.text; ctx.emit('text', r.text); }

    // 每次调用后都记录 assistant 的回复（纯文本回答也必须落库，否则返回的 messages 里只有用户问题、会话历史缺 AI 回答，切回会话后看不到）
    messages.push(r.assistantMessage);

    if (!r.toolCalls.length) break;

    const results = [];
    const pendingImages = []; // view_image 收集的待注入视觉输入
    for (const call of r.toolCalls) {
      // 停止后不再执行后续工具（不截图、不点击、不输入）
      if (_stopRequested) break;
      const entry = toolList.find((t) => t.name === call.name);
      ctx.emit('tool-start', { name: call.name, input: call.input });
      let result;
      if (!entry) {
        result = `错误：未知工具 ${call.name}`;
      } else {
        try { result = await entry.tool.run(call.input, ctx); }
        catch (e) { result = '工具执行出错：' + e.message; }
      }
      // 图片类结果：工具消息放说明文字，图片本体随后作为视觉输入注入
      if (result && typeof result === 'object' && result.__image) {
        pendingImages.push(result);
        result = result.note;
      }
      ctx.emit('tool-end', { name: call.name, input: call.input, result: String(result).slice(0, 500) });
      results.push({ id: call.id, name: call.name, result });
    }

    if (apiType === 'anthropic') {
      messages.push(r.makeToolResults(results));
      for (const img of pendingImages) {
        messages.push({ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } },
          { type: 'text', text: '（以上为你要查看的图片内容）' },
        ] });
      }
    } else {
      for (const res of results) {
        messages.push({ role: 'tool', tool_call_id: res.id, content: String(res.result).slice(0, 30000) });
      }
      for (const img of pendingImages) {
        messages.push({ role: 'user', content: [
          { type: 'text', text: '（以下为你要查看的图片内容）' },
          { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } },
        ] });
      }
    }
  }

  // 检查是否因 MAX_TURNS 限制退出：最后一轮有 tool calls 但没能产出最终回复
  // 当最后一轮的 assistant 消息带 tool_calls 但没后续普通文本 → 任务未完成
  const lastMsg = messages[messages.length - 1];
  const lastIsToolOnly = lastMsg && lastMsg.role === 'tool';
  const hitMaxTurns = lastIsToolOnly;
  const extra = hitMaxTurns ? '\n\n（系统提示：本轮已达最大工具调用次数（' + maxTurns + '），任务可能未完成。如需继续请回复"继续"接着处理。）' : '';
  _currentAbort = null;
  return { ok: true, text: (finalText || (hitMaxTurns ? '已完成部分操作。' : '')) + extra, usage: totalUsage, messages, hitMaxTurns };
}

/* ================= 对外入口 ================= */
// profile: AI 配置；chatHistory: UI 层简版历史 [{role, content}]; userText: 本轮输入
// callbacks: { onText, onToolStart, onToolEnd, onConfirm, onTodo, onSubagentStart, onSubagentEnd, onCompact, getRules, onRulesChanged }
async function runAgent(profile, chatHistory, userText, callbacks) {
  // 新一轮对话开始：清掉上一次可能残留的停止标志 / AbortController
  clearStop();
  // 动态加载外部技能（userData/skills/*/SKILL.md），合并进技能表
  if (callbacks.skillsDir) {
    CURRENT_SKILLS_DIR = callbacks.skillsDir;
    loadExternalSkills(callbacks.skillsDir);
  }
  const ctx = {
    profile,
    rules: callbacks.getRules ? callbacks.getRules() : [],
    todos: [],
    history: chatHistory,
    confirm: callbacks.onConfirm,
    rulesChanged: callbacks.onRulesChanged || (() => {}),
    webAccess: callbacks.webAccess || false,
    mcpEnabled: callbacks.mcpEnabled === true, // 外部 MCP 开关；内置 ComputerUse 由应用设置控制
    mcpServer: callbacks.mcpServer || null,    // 用户单选的服务器名（null=未指定）
    skillsDir: callbacks.skillsDir || null,
    attachments: callbacks.attachments || [],  // 本轮拖入对话框的附件（图片 base64 / 文档文本）
    chatId: callbacks.chatId || null,          // 当前对话 ID（用于对话级记忆）
    memoryEnabled: callbacks.memoryEnabled === true, // 是否自动生成对话记忆
    onInstallSkill: callbacks.onInstallSkill || null,
    setTodos: (todos) => { ctx.todos = todos; callbacks.onTodo && callbacks.onTodo(todos); },
    emit: (event, data) => {
      const map = {
        text: callbacks.onText,
        'tool-start': callbacks.onToolStart,
        'tool-end': callbacks.onToolEnd,
        'subagent-start': callbacks.onSubagentStart,
        'subagent-end': callbacks.onSubagentEnd,
        compact: callbacks.onCompact,
      };
      if (map[event]) map[event](data);
    },
    depth: 0,
  };
  const apiType = profile.type === 'anthropic' ? 'anthropic' : 'openai';

  try {
    const result = await runAgentLoop(profile, apiType, userText, ctx, {});
    // 后台异步提炼长期记忆，不阻塞回复
    if (ctx.memoryEnabled && Array.isArray(result.messages)) {
      extractMemoryFacts(profile, apiType, result.messages).catch(() => {});
    }
    return { ok: true, stopped: !!result.stopped, usage: result.usage, rules: ctx.rules, todos: ctx.todos, messages: result.messages, hitMaxTurns: result.hitMaxTurns };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { runAgent, sanitizeMessages, SKILLS, BUILTIN_SKILLS, RECOMMENDED_SKILLS, loadExternalSkills, parseSkillMd, getContextWindow, getCompactThreshold, requestStop, clearStop, isStopRequested };
