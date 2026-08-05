# AI Copilot

macOS 桌面应用（Electron，Apple Silicon / Intel 通用 dmg）。选择文件或文件夹，按规则批量替换文件内容；内置 AI 智能体，可对话式指挥处理本机文件。

> 仓库地址：https://github.com/ddxmu/AI-Copilot

## 功能

- **按规则替换文件**：选文件/文件夹 → 设 find→replace 规则（可启用/停用，空替换=删除）→ 输出到新目录或覆盖原文件。
- **AI 助手**：内嵌智能体（类 Claude Code 架构），可读取/写入/搜索/替换本机文件，支持子代理、技能包、TodoWrite、上下文自动压缩。
- **AI 设置**：支持 Anthropic / OpenAI / DeepSeek / MiniMax / Moonshot / Zhipu / Qwen / Doubao / 自定义厂商；可开启「AI 助手联网」让 AI 联网搜索与读取网页。
- **推荐技能**：内置多个实用技能（PDF 工具包、浏览器自动化、深度研究、批量处理、文档翻译等），一键安装；AI 执行中遇到需要的能力可弹窗授权自动安装。
- **其它模块**：文件名修改、文件格式转换、PDF 去水印、文件自动化、PPT 写手。
- **自动更新**：启动静默检查 GitHub 上的 `latest.json`，发现新版本可在「AI 设置 → 软件更新」一键下载安装。

## 仓库结构

```
AI-Copilot/
├── app/                  # 应用源码（即 .app/Contents/Resources/app 的内容）
│   ├── main.js           # 主进程：文件扫描/替换、AI 对话、更新 IPC、权限闸门
│   ├── preload.js        # contextBridge 桥接
│   ├── agent.js          # AI 智能体核心（agent loop + 工具 + 技能）
│   ├── ai-config.js      # AI 配置本地持久化
│   ├── updater.js        # 自动更新器（检查/下载/安装）
│   ├── filetypes.js      # 支持的文件类型
│   ├── office-replace.js # Office(zip) 文本替换引擎
│   ├── pdf-watermark.js  # PDF 水印去除引擎
│   ├── package.json      # 应用元信息 + electron-builder 配置
│   ├── CHANGELOG.md      # 版本记录
│   └── renderer/         # 界面（index.html / app.js / style.css / assets）
├── dmg-assets/           # DMG 品牌资源（背景图、卷标图标、.DS_Store 参考、使用说明）
├── make_dmg.py           # 品牌化 DMG 打包脚本
├── publish_release.py    # 发布脚本：同步源码→打包→建 Release→更新 latest.json→推送
├── latest.json           # 更新清单（App 启动时读取）
├── 配置说明.md            # 配置项说明
└── README.md
```

> 说明：仓库存放**源码 + 构建脚本 + 文档**；每个版本的 **DMG 安装包**发到 GitHub Releases（不进 git，避免仓库臃肿）。

## 本地构建

需要 Node（建议 22+）与 Python 3（用于 `make_dmg.py`）。

```bash
cd app
npm install              # 安装 electron / electron-builder（开发依赖）
npm run dist:arm         # 产出 .app（在 release/ 下）
# 然后用 make_dmg.py 打成品牌化 DMG
python3 make_dmg.py      # 产物：~/Downloads/AI Copilot-x.y.z-arm64.dmg
```

当前构建流程在开发机上以 `/tmp/AIReplace/` 为工作区：`make_dmg.py` 直接拷贝已构建好的
`AI Copilot.app` 并套用 `dmg-assets` 品牌布局。普通用户无需本地构建，直接从 Release 下载 DMG 安装即可。

## 自动更新机制

- `app/updater.js` 在启动时从 `https://raw.githubusercontent.com/ddxmu/AI-Copilot/main/latest.json` 拉取清单，与 `app.getVersion()` 比对。
- 有更新时：设置页「软件更新」卡片显示新版本与更新内容，可点「下载并安装」。
- 安装流程：下载 Release 里的 DMG → 挂载 → 拷贝新 `.app` 到暂存区 → 退出后由独立脚本替换并重启（适配未签名 DMG 分发）。
- 仅检查与下载需要网络；Release 为公开仓库，无需登录。

## 发布新版本

由维护者（AI 助手）执行。每次升级只需一条命令：

```bash
export GITHUB_TOKEN="ghp_xxx"   # 需要 repo 权限的个人访问令牌
python3 publish_release.py
```

脚本会自动：① 将最新源码从构建工作区同步进 `app/` ②（若需要）调用 `make_dmg.py` 打包
③ 在 GitHub 创建 `vX.Y.Z` Release 并上传 DMG ④ 生成 `latest.json`（含下载地址与 sha256）
⑤ `git commit` + `git push`。App 端下次启动即能检测到新版本。

## 许可证

MIT
