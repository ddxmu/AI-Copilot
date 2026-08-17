## v0.10.10 — 2026-08-18

### 1. ComputerUse 左键点击改回 CGEvent 主路径（反转 v0.10.9 决定）

- 左键主点击由 **System Events 坐标式辅助功能点击** 改回 **CoreGraphics 真实事件（`mouseClickJxa`）**。
- 点击流程：移动到目标 → 等 100ms → `mouseDown` → 50ms → `mouseUp`（与 v0.10.7 一致，`mouseClickJxa` 内已实现）。
- System Events 降为**一次性备用方案**：仅当 CGEvent 抛错时回退一次，**不能连续重复点击同一坐标**。
- 保留现有坐标换算（`modelToTarget` / `target.cg`）、鼠标平滑移动（`movePointerTo`）、光标遮罩与界面逻辑、verifyClick 校验逻辑，**未改动鼠标大小与坐标算法**。
- `double_click` / `right_click` 本就是 CGEvent 主路径，无需调整。
- 同步更新 click 工具的 description（注入给 AI 的 schema），使其与主/备交换后的行为一致。

## v0.10.9 — 2026-08-17

### 1. ComputerUse 重写（用户提供的改版）

- 采用用户修改后的 `computer-use.js`：相比 v0.10.8 有较大量调整（约 146 行新增 / 53 行删除），具体以用户改版为准。
- 左键点击仍为 **System Events 主路径**（延续 v0.10.8 决定）。

### 2. AI 光标遮罩无操作隐藏延长至 10 秒

- `main.js` 中 `CURSOR_IDLE_MS` 由 `5000` 调整为 `10000`：ComputerUse 的 AI 光标遮罩在连续无操作 10 秒后才自动隐藏（有操作即重置）。

### 3. 「智能体工作中…」状态文字改为黑色流光

- 聊天框下方状态栏在智能体运行期间显示「智能体工作中…」时，文字由 v0.10.8 的蓝色渐变改为 **黑色渐变流光**（黑色底 + 极淡深灰流动高光，`background-clip: text` + 流动动画），更克制、与浅色界面更协调。
- 仍通过内层 `<span class="agent-working">` 作用域隔离，且仅在该状态文字出现时显示；适配「减弱动态效果」系统偏好。

## v0.10.8 — 2026-08-17

### 1. 「智能体工作中…」状态文字渐变流光特效

- 聊天框下方状态栏在智能体运行期间显示「智能体工作中…」时，文字改为蓝色渐变流光效果（线性渐变 `#2f6fed → #4f86f0 → #7aa9ff`，`background-clip: text` + 流动动画），视觉上更醒目、贴合产品蓝调。
- 特效通过内层 `<span class="agent-working">` 作用域隔离：仅在该状态文字出现时显示，文字被清空或切换为其它状态时自动移除，不会污染其它状态提示。
- 已适配「减弱动态效果」系统偏好（`prefers-reduced-motion`）——开启时停用动画，仅保留静态渐变。

### 2. ComputerUse 左键点击改回 System Events 主路径（调整 v0.10.7 决定）

- 左键主点击恢复为 **System Events 坐标式辅助功能点击**（对 Chrome / Electron 的 HTML 控件命中更稳）；CGEvent 降为一次性备用，仅当 System Events 抛错时回退一次，不重复点击同一坐标。
- 即 v0.10.7 的「左键改回 CGEvent 主路径」决定在本版被反转。

### 3. 升级后自动重签，修复屏幕录制授权反复弹窗

- `updater.js` 的 OTA 增量覆盖 / 整包替换完成后，新增对目标 App 的 ad-hoc 重签（`codesign --force --sign - --timestamp=none`）；只签顶层 App，避免对 Electron Framework 用 `--deep` 触发 bundle format ambiguous 而留下未更新的资源封套。
- 解决此前升级后 macOS 因资源封套失效、反复弹出屏幕录制授权的现象。

- 注：此前 v0.10.8 草稿中尝试的 Dock 重新显示修复已回退，不在本次发布范围内。

## v0.10.7 — 2026-08-17

### ComputerUse 左键点击改回 CGEvent 主路径

- **左键主点击改回 CoreGraphics（CGEvent）**：`click()` 左键优先用 `mouseClickJxa`（CGEvent 真事件），落点、移动与界面逻辑（光标覆盖层、坐标换算）保持不变。
- **System Events 仅作一次性备用**：仅当 CGEvent 抛错时，在 `catch` 中回退一次 System Events 辅助功能点击；不循环、不重复点击同一坐标。
- **点击时序对齐**：`mouseClickJxa` 改为「移动到目标 → 等待 100ms → mouseDown → 50ms → mouseUp」，与双击/右键共用，落点更可靠。

## v0.10.6 — 2026-08-17

### ComputerUse 点击逻辑修复（SERVER_VERSION 1.5.0 → 1.6.0）

- **点击后等待再判定**：点击后随机等待 800–1500ms，再重新截图并读取真实浏览器 URL / 页面标题，不再立即判定成败。
- **加载中轮询，不误判失败**：若页面正在加载，持续轮询最多 3 秒，把「暂时无变化」与「点击失败」区分开。
- **query_ui 重试 + 优先辅助功能按钮**：读取辅助功能元素时若只拿到窗口控件，等待后重试最多 2 次；反复提示优先用读到的按钮中心坐标点击，不要盲点截图坐标。
- **Chrome 个人资料选择页识别**：识别「打开用户资料 / 继续使用 / 登录」等按钮，显式建议优先点击其控制中心坐标。
- **连续失败计数时机修正**：连续失败计数只在「完整重试（含 3 秒加载轮询）后仍无任何真实变化」时才增加，不会因页面加载慢就触发自动停止。
- **以真实证据验证成功**：最终必须凭真实 Chrome URL / 标题变化、焦点转移或像素变化判定生效，不再只凭「按键已发出」就报告完成。
- **光标只影响显示**：鼠标光标大小 / 红圈尺寸仅作视觉提示，点击落点始终用真实控件坐标，绝不用显示尺寸去修正或偏移点击落点。

## v0.10.5 — 2026-08-17

### ComputerUse 可靠性与灵活性打磨 + 全局硬停止 + 光标/点击红圈视觉微调

**ComputerUse 可靠性（7 项）**
- 会话状态与健壮性基础设施：统一超时、重试、全局 `aborted` 标志与串行工具队列，杜绝并发点击/输入互相打架。
- 点击更可靠：`moveAndSettle`（瞬移后 50ms 再按下）修正落点；点击前临时隐藏覆盖层、点击加 down/up 间隔，避免遮挡导致的误点。
- 输入更稳：`typeViaClipboard`（pbcopy→pbpaste 回读校验→⌘V→还原，治中文/长文本乱码，失败回退 keystroke）。
- 拖拽改 `animatedMove`（ease-out-cubic 60fps，时长随距离自适应）+ `try/finally` 必松左键，杜绝卡键。
- 截图 `screencapture -C` 带光标 + 红圈标点击点；72 DPI 归一化 + 截图降采样上限（超大图缩到目标尺寸，提升小控件识别并回传缩放比）。
- `fetchDisplays` JXA 多显示器取屏修复屏幕尺寸解析 bug；新增 `focus_app` 聚焦目标 App 工具。
- 危险快捷键（⌘Q 等）二次确认拦截。

**ComputerUse 灵活性（6 项）**
- 新增全局停止机制：Esc 或 UI 停止按钮 → IPC 中断当前 Agent 循环、取消进行中的模型 HTTP 请求、清空工具队列。
- 多显示器支持（`get_displays` + 坐标映射指定屏）。
- 截图标注更大更清晰、点击红圈更小更轻（见视觉微调）。
- 截图降采样后回传真实坐标换算比例，模型不再因图过大而点错。
- 功能键 F1–F12 自动补 `fn` 修饰键。
- 工具调用输入回显到「工作完成」面板，过程可见。

**光标 / 点击红圈视觉微调（纯视觉，未改动坐标换算）**
- 鼠标指针直径收敛到 14–18px，清晰可见。
- 点击反馈红圈缩小到直径 32–40px，线宽 2–3px，显示 300–500ms 后淡出。
- 截图中点击标记（红圈）半径减小、透明度降低，不再覆盖按钮文字。
- 鼠标移动保留可视动画。

## v0.10.4 — 2026-08-17

### 修复 v0.10.3 语音设置「保存 / 测试语音」失效，STT 拆为独立区块
- **根因**：v0.10.3 编辑 `initVoiceSettings` 时误删了 `const saveBtn = document.getElementById('btn-voice-save')` 声明，`if (saveBtn)` 引用未定义变量触发 `ReferenceError`，导致整个函数在绑定「保存」与「测试语音」按钮之前就中断，两个按钮均无反应。
- **修复**：
  - 恢复 `saveBtn` 声明，「保存」与「测试语音」功能回归（与 v0.10.2 行为一致）。
  - **语音识别（STT）拆为独立卡片**：UI 分「AI 语音合成（TTS）」与「语音识别（STT）」两块，互不嵌套，STT 有自己的状态提示 `voice-stt-status`，不再与 TTS 的 `voice-fetch-status` 混用。
  - TTS（本地 / MiniMax / 自定义）配置逻辑与「测试语音」**未改动**。

## v0.10.3 — 2026-08-17

### 语音识别（STT）重构：独立 OpenAI 兼容配置，不再误调 MiniMax ASR
- **根因**：旧逻辑按 TTS 的 `provider` 选 STT 端点，MiniMax 走 `/v1/audio/asr`；MiniMax Token Plan Key 无 ASR 权限返回 404，导致麦克风点了识别不到文字。
- **修复**：
  - 语音识别改为**独立配置**（与 TTS 完全解耦）：`sttEnabled` / `sttProvider` / `sttBaseUrl` / `sttKey` / `sttModel`，默认 `sttProvider='openai'`，走 OpenAI 兼容 `/v1/audio/transcriptions`（multipart）。
  - **不再盲目调用 MiniMax `/v1/audio/asr`**：仅当用户在 STT 设置里明确选 `minimax` 才走原生 `/v1/audio/asr`（且复用 MiniMax TTS 的 Key）。
  - MiniMax 的 TTS 配置（endpoint / Key / 音色 / 模型 / 语速）**保持不变**。
  - 录音时显示实时音量波形（AnalyserNode）；支持「按住说话」与「点击开始 / 再点结束」两种停止方式。
  - 识别文字**只填入输入框、不自动发送**。
  - 错误分两类提示：麦克风权限错误（系统设置引导）与接口/网络错误（返回真实原因，401/403 与 404 分别给提示）。

## v0.10.2 — 2026-08-17

### 推荐技能新增 computeruse-file-authoring
- 在「AI 设置 → 智能体技能 → 推荐技能」加入 `computeruse-file-authoring`，用户可一键安装。
- 安装源为 GitHub 仓库 `ddxmu/computeruse-file-authoring-skill`（分支 `main`），从仓库拉取 SKILL.md 到本地技能目录。
- 该技能用于文件自动化：在 macOS 文件夹中理解需求、规划内容、创建或修改文件、专业排版、生成流程图、保存并验证结果，默认使用内置 ComputerUse 操作屏幕。

## v0.10.1 — 2026-08-17

### 修复关闭外部 MCP 后内置 ComputerUse 不可用
- **根因**：聊天栏的 MCP 开关关闭时，`agent.js` 把所有 MCP 工具都从模型工具列表和系统提示词中移除了，导致内置 ComputerUse 也被误判为不可用。
- **修复**：聊天栏开关现在只控制用户配置的外部 MCP；已在 AI 设置中启用的内置 ComputerUse 始终注入主 Agent，并明确提供截图、鼠标移动/点击、键盘输入和打开应用能力。
- **保留**：ComputerUse 原有坐标映射、可见鼠标移动、点击红圈、截图验证和输入校验逻辑不变。

## v0.9.55 — 2026-08-17

### ComputerUse 输入（type）修复：⌘V 只落字母 v、不粘贴
- **根因**：`buildKeyScript` 生成的组合键事件缺少正确的 CoreGraphics 修饰键掩码。主键 `v` 事件自身未携带 `⌘` 标志，Chrome/Electron 把它当成裸 `v` 键击 → 只落一个字母、不粘贴；旧 `typeViaClipboard` 仅凭「剪贴板回读 == 文本」就报成功，未验证 ⌘V 真正进入窗口 → 假报成功。
- **修复**：`MOD_MASK` 恢复为真实 macOS CoreGraphics `CGEventFlags`（`command=1048576`/`shift=131072`/`control=262144`/`option=524288`/`fn=8388608`），并为主键事件本身注入完整修饰掩码（`CGEventSetFlags`），⌘V/⌘C/⌘A/⌘L 在 Chrome、Electron、普通输入框均正确识别。
- **防假报成功**：`typeViaClipboard` 粘贴前 `hasEditableFocus()` 检查聚焦控件；粘贴后 `verifyPasteLanded()` 用 ⌘A+⌘C 回读字段，`pasteVerificationResult()` 严格判定——不含量 → `fail`、确实读不到才 `unknown`、含待粘贴文本才 `ok`；失败时如实上报，不再用 keystroke 重输整段（会丢中文/长文本/换行）。
- **保留**：中文/长文本/换行（剪贴板 ⌘V）、剪贴板 `finally` 还原、点击/坐标映射/72 DPI 截图、System Events 点击 + 5s 超时全部不变。SERVER_VERSION 1.4.1→1.4.2。

## v0.9.54 — 2026-08-17

### Computer Use 修复持久化进源码与构建管线
- 把此前已验证的点击修复从「已安装包热修」正式移植进源码 `app/mcp-servers/computer-use.js`，纳入版本控制与构建流程，后续发版默认可用，不再依赖手工热修。
- **Retina 截图 72 DPI 归一**：`screenshot()` 缩放后追加 `sips -s dpiWidth 72 -s dpiHeight 72`，消除 Retina 下 144 DPI 元数据导致视觉模型把图像坐标缩小一半、点击落点偏移的问题，使「图像像素 ⇔ 逻辑点」严格 1:1。
- **左键点击改走 macOS System Events**：左键 `click` 优先用 `tell application "System Events" to click at {x,y}`（对 Chrome/Electron 等 HTML 控件命中最可靠），被系统拒绝时自动回退 CoreGraphics 真实事件；`click` 前仍临时 `sendCursor('hide')` 避免覆盖层拦截命中测试。
- **5 秒 AppleScript 超时 + 抑制返回对象**：点击 AppleScript 用 `with timeout of 5 seconds` 包裹，并把 `click` 返回的 accessibility UI 对象捕获到局部变量、脚本显式 `return ""`，不向外透出、不参与后续逻辑。
- **坐标映射保持不变**：`computeShotSize` / `coordScale` / `modelToTarget` 未改动，等比换算与红圈标注依旧正确。
- 新增聚焦回归检查 `app/tests/regression-computer-use.js`（坐标映射、System Events 点击/超时/suppress、72 DPI 三项断言），接入 `npm test`，可纳入构建/CI。

## v0.9.53 — 2026-08-16

### Computer Use 修复：点击实施了但无效果
- **根因分析**：
  1. `mouseClickJxa` 中 `LeftMouseDown` 与 `LeftMouseUp` 背靠背发出、中间没有停顿，部分目标应用 / AppKit 的 hit-test 来不及完成，导致事件被忽略。
  2. 光标图标从 64×72 SVG 换成 200×200 PNG 后保持 40×40 显示，且未补偿箭头尖端偏移；实际可见尖端与点击坐标相差约 6 像素，命中小目标时容易点偏。
  3. 透明覆盖层窗口在点击瞬间仍置顶显示，存在拦截命中测试的风险。
- **修复**：
  - 在 `LeftMouseDown` 后插入 40ms 延时再发 `LeftMouseUp`，给目标应用完成状态切换。
  - 光标从 40×40 缩小到 28×28，并在 `cursor-overlay.html` 中按 PNG 实际尖端位置（约 (31,3) @200×200）补偿约 4px 偏移，让可见尖端与真实点击坐标重合。
  - `click` / `double_click` / `right_click` 在真正下发 CGEvent 前临时 `sendCursor('hide')` 并等待覆盖层消失，点击后通过 `sendCursor('click')` 恢复并显示红圈，避免覆盖层拦截。

## v0.9.52 — 2026-08-16

### Computer Use 修复：鼠标工具全部报错回归
- **根因**：v0.9.50 引入多显示器取屏时，`fetchDisplays` 的 JXA 写成 `$.NSScreen.screens`（NSArray 代理不支持数字下标），`screens[0]` 取不到元素，导致 `screens[0].frame` 抛 `TypeError: undefined is not an object (-2700)`。该错误使 `move/click/double_click/right_click/drag` 全部走 `modelToTarget → ensureDisplays → fetchDisplays` 而中断（截图因走带 Finder 回退的 `getDisplaySize` 才勉强成功，所以出现「截图正常但鼠标全报错」的现象）。
- **修复**：JXA 改为 `$.NSScreen.screens.js`（实测唯一可取屏几何的写法），正确枚举主屏/副屏并返回逻辑分辨率与 CoreGraphics 全局原点。所有鼠标工具与多显示器坐标换算恢复正常。
- 已在 macOS 实测：单屏返回 `1512|982|0|0`，解析正确。

## v0.9.51 — 2026-08-16

### Computer Use 光标图标替换
- 用户反馈光标遮罩「太大」：把原来 64×72 的粉渐变 SVG 箭头，替换为用户提供的桌面鼠标指针图标 `鼠标图标-鼠标指针.png`（200×200 透明 PNG，系统箭头样式），显示尺寸缩到 40×40，明显变小、更贴近真实鼠标观感。点击波纹动效保留。
- 图标文件落地 `app/renderer/cursor.png`，由 `cursor-overlay.html` 以 `<img>` 引用。

## v0.9.50 — 2026-08-16

### Computer Use 修复与能力补齐（#342–#346）
- **修复截图「无法解析屏幕尺寸：0, 0, 1512, 982」致命 bug**：取屏方式由 Finder 桌面 bounds（返回无花括号的 `0, 0, 1512, 982`，旧正则强制要求 `{…}` 永远不匹配）改为 **NSScreen JXA**（免辅助功能权限，最稳），并保留 Finder 回退 + 去花括号正则。现在 `screenshot` / `get_screen_size` 不再报错，鼠标截图恢复正常。
- **截图降采样 + 坐标系换算**：截图等比缩放到上限约 1366×887，模型看到的图像像素即坐标空间；`move/click/double_click/right_click/drag/scroll` 自动按 `coordScale` 把图像坐标还原回逻辑点，红圈标注同步落在图像坐标系，彻底消除「坐标对不上」。
- **focus_app（#343）**：新增工具，把指定应用（应用名或 bundle id）切换/启动到前台（NSWorkspace `launchApplication` + AppleScript `activate` 回退）。
- **危险快捷键二次确认（#345）**：`key`/`hotkey` 识别 ⌘Q/⌘W/⌘⇧Q/⌘⌥Esc 等危险组合，未显式 `confirm:true` 时拒绝执行，避免误关应用/退出登录。
- **多显示器支持（#346）**：新增 `get_displays` 枚举所有显示器（逻辑分辨率 / 图像坐标系尺寸 / CoreGraphics 全局原点）；`screenshot` 与所有鼠标工具支持 `display` 参数（1=主屏），截图走 `screencapture -D`，鼠标坐标按各显示器原点与缩放换算。
- **全局停止 / 中断（#342）**：新增 Computer Use 中断机制——`Esc` 或点击发送按钮（AI 在途时）即中断当前在途操作：杀掉在途 osascript、安全释放鼠标左键、下次工具调用返回「操作已被用户中断」。链路 `renderer → preload → main(ipc) → mcp.cancelTool → computer-use(__abort)`。
- ComputerUse MCP `SERVER_VERSION` 1.3.0 → 1.4.0。

## v0.9.49 — 2026-08-16

### Computer Use 光标可视化
- 新增主进程透明置顶遮罩窗口 + Unix socket 通道，Computer Use 操作时显示一个粉色渐变箭头指针跟随 AI 鼠标移动。
- 指针样式参考桌面 GIF（粉白描边箭头），点击/拖拽时带扩散波纹动效；空闲 5 秒自动淡出。
- 截图前临时隐藏遮罩，避免把粉色指针拍进截图干扰模型判断；截图后自动恢复。
- `move`/`click`/`double_click`/`right_click`/`drag`/`scroll` 均上报坐标，`type`/`key`/`hotkey` 保持当前鼠标位置可见。

## v0.9.48 — 2026-08-16
- **Computer Use 对标 Claude Code 内置实现，三项操控改进**：
  - **输入文字（type）改用剪贴板粘贴**：移植 Claude Code 的 `typeViaClipboard`——`pbcopy` 写入后 `pbpaste` 回读校验（不一致即视为失败）、再 `Cmd+V` 粘贴、`sleep 100ms`、`finally` 还原用户剪贴板。完整支持中文/长文本/换行/emoji，不再出现 `System Events keystroke` 的丢字、乱序、emoji 截断；剪贴板方式异常时自动回退 keystroke。
  - **点击加 settle**：`click`/`double_click`/`right_click` 在瞬移与按下之间加 50ms 等待（对标 `moveAndSettle`），给 input→HID→AppKit 一个 round-trip，落点更可靠、避免误触发 hover 状态。
  - **拖拽改缓动动画 + 必定松键**：`drag` 改用 ease-out-cubic、60fps 缓动（时长 = min(距离/2000, 0.5s)，对标 `animatedMove`），让目标应用有时间处理中间 `.leftMouseDragged` 事件；按下后 settle 50ms，并用 `try/finally` 保证左键必定松开，杜绝卡键。
  - ComputerUse MCP `SERVER_VERSION` 1.1.0 → 1.2.0。

## v0.9.47 — 2026-08-16
- **优化 Computer Use 鼠标/点击/功能键（用户反馈）**：把鼠标移动、点击、双击、右键、拖拽从 `System Events` AppleScript 改为 **CoreGraphics CGEvent 真实事件**，桌面光标会真实可见地平滑移动，点击/拖拽对 Electron/WebView 等 App 也能可靠落点。截图增加 `-C` 捕获鼠标光标，并自动在最后一次操作坐标绘制红色圆环，方便在返回图里直观看到鼠标和点击位置。功能键 F1–F12 自动附带 `fn` 修饰键，避免被系统当亮度/音量等媒体键吞掉。

## v0.9.46 — 2026-08-16
- **内置 Computer Use 电脑操控能力（新增）**：AI 设置 › 电脑操控新增独立开关，开启后自动接入内置的 ComputerUse MCP 服务器（stdio，纯 Node 内置模块，零外部依赖），让 AI 能像人一样操控鼠标/键盘、截图、滚动。提供 11 个工具：截图（screenshot）、移动（move）、点击（click）、双击（double_click）、右键（right_click）、拖拽（drag）、输入文字（type）、按键（key）、组合键（hotkey）、滚动（scroll）、获取屏幕尺寸（get_screen_size）。开启时自动把聊天栏 MCP 选到 ComputerUse 并推送连接状态；关闭即断开。macOS 需授予「辅助功能」+「屏幕录制」权限，设置卡片内提供一键跳转系统设置的「打开权限设置」按钮。
- **电脑操控权限引导（新增）**：开关卡片内说明 macOS 辅助功能与屏幕录制权限的用途，并提供「打开权限设置」按钮（`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`）一键跳转系统隐私与安全设置。

## v0.9.45 — 2026-08-16
- **升级提示条仅显示一次且可关闭（用户反馈）**：v0.9.44 的提示条仍位于顶部 drag 区域，关闭按钮继续被系统拖动事件拦截。`style.css` 将 `.upgrade-toast` 的 `top` 从 `16px` 下移到 `56px`，彻底避开 `.topbar` 的 drag 区域；`app.js` 在关闭或 10 秒自动隐藏后把版本号写入 `localStorage`（`aicopilot-upgrade-shown-<version>`），同版本升级提示只会出现一次，重启后不再重复显示。

## v0.9.44 — 2026-08-16
- **修复升级成功提示条无法关闭（用户反馈）**：v0.9.42 隐藏 macOS 原生标题栏后，`.topbar` 设为 `-webkit-app-region: drag`，导致顶部固定定位的升级提示条区域也被系统 drag 处理吞掉点击事件，提示条右上角的 `×` 关闭按钮点不动。`style.css` 给 `.upgrade-toast` 和 `.ut-close` 加 `-webkit-app-region: no-drag` 脱离拖动区域，并增大关闭按钮点击区域；`app.js` 把 `onclick` 改为 `addEventListener('click')`，并阻止事件冒泡/默认行为。

## v0.9.43 — 2026-08-16
- **左侧 logo 下移避让红绿灯（用户反馈）**：v0.9.42 隐藏原生标题栏后，左上角系统红绿灯按钮遮挡了左侧栏顶部的 logo 与「AI Copilot」应用名。`style.css` 将 `.app-title` 的 `padding-top` 从 18px 加大到 38px，让 logo/名字整体下移，不再与红绿灯重叠。

## v0.9.42 — 2026-08-16
- **顶部标题栏改为自定义风格（用户反馈）**：macOS 窗口改为 `titleBarStyle: 'hiddenInset'` 隐藏原生标题栏，左上角保留系统红绿灯按钮并通过 `trafficLightPosition` 上移到 logo 上方；顶部 `.topbar` 统一使用网页主题背景，浅色/深色切换时顶部条自动跟随变深/变浅，不再出现深色模式下顶部仍为浅灰色的割裂感。`.topbar` 设置 `-webkit-app-region: drag` 支持拖动窗口，内部按钮/搜索框设置 `no-drag` 保证可点击。

## v0.9.41 — 2026-08-16
- **外观新增「风格颜色」强调色选项（用户反馈）**：AI 设置 › 外观里新增「风格颜色」卡片，列出 12 种预设强调色（蓝/青/绿/黄/橙/红/粉/紫等），并支持「自定义颜色」取色器；可点「恢复默认」回到蓝色。选中的颜色会立即改变按钮主色（--primary/--primary-hover/--primary-bg）与左侧导航高亮色（--sidebar-active-text/--sidebar-active-bg）并自动保存（localStorage）。深色外观下强调色会自动提亮，保证按钮文字可读。切换浅/深色时按当前主题重算强调色。

## v0.9.40 — 2026-08-16
- **左侧功能图标风格统一（用户反馈）**：把左侧功能栏的 AI 助手、按规则替换文件、文件名修改、文件格式转换、PDF 去水印、文件自动化、PPT 写手、AI 设置这 8 个 PNG 图标全部换成统一线型 SVG，统一使用 `currentColor`。浅色外观下图标随侧边栏文字变成黑灰色；深色外观下图标随文字变成白色；active/hover 状态也会自动跟随主题色。

## v0.9.39 — 2026-08-16
- **历史记录「+ 新建」交互简化（用户反馈）**：v0.9.38 的「+ 新建」下拉框改回直接点击新建对话——去掉下拉箭头和选项菜单，点击「+ 新建」即创建新对话。鼠标悬停「+ 新建」时显示「新建对话」提示框（复用 `.dropdown` 的定位样式，纯 CSS 实现，无需点击外部收起逻辑）。

## v0.9.38 — 2026-08-16
- **历史记录「+」按钮改为下拉「+ 新建」（用户反馈）**：左侧「历史记录」右侧的 `+` 按钮改为带下拉选项的按钮，触发器显示 `+ 新建` 并带小箭头，下拉菜单内提供 `+ 新建` 选项，点击后新建对话。复用现有 `.dropdown` 样式，点击外部自动收起。

## v0.9.37 — 2026-08-16
- **麦克风交互对齐 WorkBuddy（用户反馈）**：点击麦克风开始录音；录音中点击「发送」或按回车、或再次点击麦克风，停止录音并触发语音识别，识别到的文字填入聊天输入框后自动发送。仍仅麦克风发出的消息激活 AI 语音回复。
- **设置文案调整（用户反馈）**：「AI 设置 › 更新日志」导航与标题改名为「更新和日志」；「软件更新」说明中「自动从 GitHub（ddxmu/AI-Copilot）检查新版本」改为「自动检查新版本」。

## v0.9.36 — 2026-08-16
- **麦克风语音输入行为调整（用户反馈）**：点击麦克风→自动识别→文字填入聊天输入框（停留 400ms 便于查看）→说完或再次点击麦克风结束后自动发送。新增 `voiceSendPending` 标记：仅由麦克风发出的消息才激活 AI 语音回复；手动打字（按钮/回车）发送的不朗读，满足「没点麦克风不发送语音」。

## v0.9.35 — 2026-08-16
- **AI 语音开关重构（用户反馈）**：删除总开关，改为本地 / MiniMax 海螺 / 自定义三个来源各自带独立「启用此语音」开关（分别存 `localEnabled`/`minimaxEnabled`/`customEnabled`）。选中的来源即为 AI 回复朗读所用的声音，只有该来源开关打开才播、关闭则不播（与 v0.9.34「只播选中的那一路」一致）。保存时始终带上各来源配置，避免从某一来源保存时清掉其它来源的开关/信息。旧版总开关 `enabled` 按 provider 自动迁移到对应独立开关（无 provider 的旧数据归本地）。

## v0.9.34 — 2026-08-16
- **修复 AI 语音回复「两个声音同时响」（用户反馈）**：`speakText` 在云端 provider（海螺/自定义）播放中途出错时会回退到本地 `speechSynthesis`，导致海螺声还在响、本地声又叠加。现改为只播放「当前保存的 provider」对应的那一路：选本地只播本地，选海螺/自定义只播云端；云端失败不再回退本地（避免两路混播），并在播云端前先 `speechSynthesis.cancel()` 清掉可能残留的本地语音队列。

## v0.9.33 — 2026-08-16
- **修复麦克风语音识别 404（用户反馈）**：聊天框麦克风报「接口返回不是有效 JSON：404 page not found」。根因是 minimax 分支请求了 `api.minimax.chat/v1/audio/transcriptions`（MiniMax **没有** OpenAI 兼容的该端点）。现改为走 MiniMax 原生 ASR 接口 `POST {host}/v1/audio/asr`（JSON body，base64 音频，非 multipart），候选域名 `api.minimax.chat` / `api.minimaxi.com` / `api.minimax.io` 逐个尝试，兼容 `text`/`data.text`/`data.utter`/`data.result` 多种返回结构。「自定义」provider 仍走 OpenAI 兼容 `/audio/transcriptions`（用于 OpenAI / 硅基流动 / 通义等 Whisper）。注意：若 MiniMax Key 不带 ASR 权限（如 sk-cp- Token Plan 仅含 TTS），ASR 会返回 401/403，此时请在「AI 语音 › 自定义」里填一个 OpenAI 兼容 Whisper 地址做语音识别。

## v0.9.32 — 2026-08-16
- **修复 AI 语音三处 bug（用户反馈）**：
  - 海螺测试/朗读「实际是本地语音」：MiniMax T2A V2 返回的音频是 **hex 编码**（output_format=hex），旧代码按 base64 解码导致乱码、播放失败、静默回退到本地语音。现在主进程把 hex 正确转 base64 再回放，海螺音色能正常发声。
  - 海螺「拉取我的音色」数量不对（不足 300+）：旧候选域名含一个重复的 `/v1/v1` 错误项，且国内域名不全，导致拉取失败只保留内置 12 个。改为优先 `api.minimaxi.com`（国内）/ `api.minimax.io`（国际），并兼容多种响应结构（`system_voice`/`voice_cloning`/`voice_generation`/`data`/`output` 包装）、去重、按中文名排序，正常返回 300+ 音色。
  - 切到「自定义」仍显示海螺信息：MiniMax 与自定义共用同一个 `apiKey` 字段，互相串味。现将两者 Key 拆成独立字段 `minimaxKey` / `customKey` 分别保存（旧版共用的 `apiKey` 自动按 provider 迁移），互不干扰。

## v0.9.31 — 2026-08-16
- **AI 语音设置重做：本地 / MiniMax 海螺 / 自定义 三栏**（按截图要求）：
  - 本地（免费 / 离线）：使用 macOS 系统 `speechSynthesis` 语音，无需联网，可选择中文语音；失败无网络依赖。
  - MiniMax 海螺（高质量）：API Key、音色下拉 + 「拉取我的音色」、音质模型选择（speech-2.8-turbo / speech-01-turbo / speech-01）、语速滑块；TTS 走 MiniMax `POST /v1/t2a_v2`。
  - 自定义：保留通用 OpenAI 兼容接口（API 地址 + API Key + 模型下拉 + 拉取模型），走 `POST {base}/audio/speech`。
  - 清空旧版语音数据（无 `provider` 字段时自动重置为本地默认，只保留 enabled 开关）。
  - 云端（MiniMax / 自定义）TTS 播放失败时自动回退到本地声音；本地模式不支持语音识别，使用 MiniMax / 自定义时才可用麦克风识别。

## v0.9.30 — 2026-08-16
- **修复：文件处理完成后自动在右栏「工作完成」打开**（之前只有 AI 对话里助手写/改的文件会进右栏，app 自带文件处理完成不展开右栏）：
  - 抽出共享 `addWorkItem(item)`，AI 对话路径（`captureWorkItem` → `write_file` / `edit_file` / `open_file` / `open_url`）与自带文件处理完成点统一走它，完成即把产出文件写入右栏「工作完成」列表并自动展开右栏、切到「工作完成」标签。
  - 自带文件处理完成点接上：PDF 去水印、格式转换（本地引擎）、文件重命名、规则导出（×2），每个成功产出的文件都会进右栏（点击在 Finder 中定位）。

## v0.9.29 — 2026-08-16
- **AI 语音改为通用 OpenAI 兼容（清空旧的 MiniMax 逻辑）**：
  - 删干净旧的 MiniMax 专用数据：默认接口地址（`https://api.minimax.chat/v1`）、`voiceId` / `voiceName` 音色字段、`speed` 语速、内置 12 条 MiniMax 系统音色、`fetchMinimaxVoices` 拉取接口，以及本地持久化的旧字段全部清空。
  - 新设置面板：**API Key + API 地址 + 语音模型下拉 + 「拉取模型」按钮 + 保存 + 测试语音**，去掉「音色 / 语速」。
  - 点「拉取模型」走 `GET {base}/v1/models`（不带回退到 `{base}/models`），复用 AI 模型拉取的候选兜底逻辑，列出接口可用模型。
  - 朗读与麦克风识别统一走 OpenAI 兼容接口：`POST {base}/audio/speech` 发声、`POST {base}/audio/transcriptions` 识别，适配 OpenAI / SiliconFlow / 任意兼容服务。
  - 自动朗读仍由 enabled 开关控制；测试语音不受 enabled 限制，可直接试听。

- **收起左侧功能栏，聊天界面自动变宽**：
  - 新增 `.sidebar.collapsed ~ .content #panel-ai { max-width:none }`，左侧功能栏收起时 AI 聊天区撑满内容区，自适应整体页面宽度。

## v0.9.28 — 2026-08-15
- **AI 助手「工作完成」自动列表（右栏）**：
  - 新增右栏第二个标签页「工作完成」：当 AI 助手编写/修改一个文件、打开一个文件，或打开一个网页（`write_file` / `edit_file` / `open_file` / `open_url`），都会自动在右栏以**列表形式**展示已完成的文件与网页。
  - 列表项显示类型图标、文件/网页名、路径或地址、完成时间；点击文件项可「在访达中显示」（定位），点击网页项直接在新窗口打开。
  - 完成的操作会自动展开右栏并切到「工作完成」标签；右上角带未读计数徽标；支持「清空」。
  - 失败的调用（错误 / 用户取消 / 用户拒绝 / 工具执行出错）自动过滤，不进列表；单会话上限 200 条。
  - 实现：`agent.js` 的 `tool-end` 事件透传 `input` → 主进程转发 → 渲染端 `onAiToolEnd` 解析 `path`/`url` 并渲染（`captureWorkItem` / `renderWorkList`）。

- **全站悬停提示（tooltip）**：
  - 左侧功能导航按钮、AI 设置按钮、顶栏的「收起侧栏 / 搜索 / 收起右栏」三个按钮、右栏关闭按钮、搜索框，鼠标悬停**立即弹出中文功能说明**。
  - 顶栏与右栏按钮因贴近窗口边缘，新增「下方弹出」变体 `.tip-down`，规避 `.app{overflow:hidden}` 对上方气泡的裁切。
  - 搜索框 `<input>` 无法用 CSS 伪元素提示，故把 tooltip 挂到其容器 `#topbar-search` 上。

## v0.9.27 — 2026-08-15
- **AI 语音整块重做（按用户要求删干净旧的、重建）**：
  - 删除旧的「AI语音（高质量）」双标签（本地/Minimax）、音质模型选择、sttProvider 解耦、clear-key 复选框等所有旧逻辑；统一为纯 MiniMax TTS。
  - 新设置面板：API Key（眼睛按钮显隐）+ 接口地址 + 音色下拉 + 语速 + 保存 + 测试语音。
  - 音色下拉**始终预置真实可用的 MiniMax 系统音色 ID**（御姐音/少女音/青涩青年等），保证不拉取也能选、能发声。
  - 「拉取音色」改为可选刷新：成功则替换为接口返回列表；失败显示真实错误并保留内置列表（**不再假成功**）。拉取端点多候选兜底（`api.minimaxi.com/get_voice`、`/v1/get_voice`、TTS 域名 `/get_voice`）。
  - AI 回复自动朗读开关（enabled）保留；麦克风语音识别改用同一份 AI 语音 Key + 接口地址走 OpenAI 兼容 `/audio/transcriptions`。


- **更新器优化（断点续传 + 一键清理坏缓存）**：
  - 下载前 HEAD 探测服务器文件大小，校验续传偏移——本地半截缓存若已超出服务器大小（坏包）则自动清理从头下；
  - 请求了 Range 但 CDN 返回 200（忽略 Range、给了完整文件）时改成「截断从头写」，不再 append 到半截上（这正是之前累积出 2MB 坏包、最终 416 的根因）；
  - 收到 416（范围越界）立即清理坏缓存并从头重试；致命错误/最终放弃也自动清理坏缓存，避免污染下次更新。
  - 更新失败 UI 新增「清理下载缓存并重试」红色按钮：点击即删除 `.update` 缓存目录（等价于 `rm -f "$HOME/Library/Application Support/AI Copilot/.update/patch.zip"`），随后自动重新更新；仍失败会再次弹此按钮。

## v0.9.25 — 2026-08-15
- **修复 AI 语音「拉取音色」404**：旧代码在 TTS 域名 `api.minimax.chat/v1` 上用 GET 试探 `/get_voice`、`/voice_identity`、`/voices`、`/voice_id` 四个路径，全部 404。经核实，MiniMax 音色列表接口是 **POST `https://api.minimaxi.com/v1/get_voice`**（body `{"voice_type":"all"}`，返回 `system_voice`/`voice_cloning`/`voice_generation`），部署在「语音管理」域名 `api.minimaxi.com`（与 TTS 的 `api.minimax.chat` 不同）。现改为：把用户配置的接口地址映射到语音管理域名，POST 该端点并合并三类音色，兼容 `voice_id`/`voice_name` 字段；404 时给出明确提示（接口地址末尾需为 /v1、Key 需含音色管理权限）。

## v0.9.24 — 2026-08-15
- **修复 AI 语音 API Key 看起来「保存后消失」**：Key 其实一直正确写入本地 `userData/ai-config.json`（已验证持久化有效），但打开设置时密码框从不回填已保存的 Key，只显示一个不起眼的「已保存」小提示，导致关闭/重开后空框被误认为没保存。现已改为：打开设置即用圆点回显已保存的 Key（点眼睛按钮可查看明文），并提示「已保存 API Key（圆点为已保存内容，留空保持原 Key）」；保存成功后也立即回填，确保关掉重开仍能看到。

## v0.9.23 — 2026-08-15
- **彻底修复麦克风语音识别 404（ASR）**：此前 `ai-voice-stt` 的 minimax 分支把请求发到 `api.minimaxi.com/v1/audio/asr`（JSON 格式），该路径并不存在，恒返回 `404 page not found`。经核实，MiniMax 语音识别是 OpenAI 兼容接口，正确地址为 `api.minimax.chat/v1/audio/transcriptions`（与 TTS 同域名，使用 multipart 表单：`file` + `language`）。现已改正：去掉错误的 `api.minimaxi.com` 域名映射与 JSON body，改为在用户配置的「接口地址」后拼接 `/audio/transcriptions` 并以表单提交录音（渲染进程已先把录音转成 16kHz WAV）。仍要注意：MiniMax Token Plan（`sk-cp-` 开头）Key 仅含 TTS 权限、无 ASR 权限，会返回 401/403，需改用含 ASR 权限的按量付费 Key。

## v0.9.22 — 2026-08-15
- **修复 AI 语音「拉取音色」假成功**：此前 `fetchMinimaxVoices` 在官方接口全部失败后，会默默返回 10 个默认公开音色，UI 显示「已拉取 10 个音色」，导致用户误以为配置正确。现已改为：接口拉取失败时明确返回错误，渲染进程显示真实失败原因（如 HTTP 404、地址无效等），同时仅把默认音色作为 fallback 加载并明确提示「拉取失败，已加载默认音色」，避免误导。

## v0.9.21 — 2026-08-15
- **彻底修复麦克风语音识别 404**：MiniMax 的语音识别（ASR）实际部署在 `api.minimaxi.com/v1/audio/asr`（JSON 格式：`audio_format`/`sample_rate`/`language`/`audio_data` base64），既不在 OpenAI 兼容的 `/audio/transcriptions`，也不在 `api.minimax.chat`。现主进程按此真实端点调用（TTS 域名自动映射为 ASR 域名）。注意：MiniMax Token Plan（`sk-cp-` 开头）Key 仅含 TTS 权限、无 ASR 权限，仍会 404，需改用按量付费 Key。
- **AI 助手麦克风与「AI 设置 › AI 语音」解耦**：麦克风改为独立语音输入，不再依赖 AI 语音面板的「启用」开关；点击麦克风不再自动新建对话，识别结果直接填入当前对话并发送。语音朗读（TTS）仍由 AI 语音面板的「启用」开关控制。

## v0.9.20 — 2026-08-15
- **修复麦克风语音识别 404**：MiniMax 实际没有 `/audio/asr` 这个路径，正确是 OpenAI 兼容的 `/audio/transcriptions`。现把语音识别改为走「接口地址 + /audio/transcriptions」（通用 OpenAI 兼容接口，MiniMax / OpenAI 等均支持），不再硬编码域名映射。注意：若 API Key 不含语音识别（ASR）权限（如 MiniMax Token Plan 的 `sk-cp-` Key 仅含 TTS 权限），仍会返回 404，需改用含 ASR 权限的 Key。
- **AI 语音面板去 MiniMax 字样、仅留 API + 接口地址**：标签页「MiniMax 海螺（高质量）」改为「AI语音（高质量）」；删除「语音识别来源」下拉（固定走 AI 语音的 Key + 接口地址）；API Key 输入框旁新增眼睛按钮，可切换明文/密文显示；保存后保留输入框内容便于确认 Key 已写入；拉取音色候选接口加上 `/get_voice`。

## v0.9.19 — 2026-08-15
- **修复 AI 语音测试「音频播放失败」**：渲染进程 CSP 只配置了 `default-src 'self'`，未单独放行 `media-src`，导致 `<audio>` 播放 blob / data / 外部 HTTPS 音频被浏览器拦截。现补充 `media-src 'self' blob: data: https:`，TTS 返回的音频可正常播放。
- **修复麦克风语音识别 404**：MiniMax ASR（语音转文字）接口部署在 `api.minimaxi.com`，而用户配置的是 TTS 所在的 `api.minimax.chat`，导致 `/audio/asr` 返回 `404 page not found`。现自动把 ASR 请求从 `api.minimax.chat` 映射到 `api.minimaxi.com`，TTS 仍走用户配置的地址。

## v0.9.18 — 2026-08-15
- **AI 语音设置独立**：语音识别来源去掉「跟随当前 AI 配置」，固定使用 MiniMax ASR，与上方 AI 语音面板里的 MiniMax Key 一致，不再和「AI 配置」中的 Key 关联。
- **修复语音识别 JSON 解析报错**：v0.9.17 已把语音网络请求迁到主进程，但接口返回非 JSON 时（如 HTML 错误页）会抛出「Unexpected non-whitespace character after JSON…」。现改为先读取响应文本再安全解析 JSON，失败时提示真实响应片段，便于定位。
- **同步微调**：默认 `sttProvider` 改为 `minimax`，旧配置自动归一，避免误走当前 AI 配置的 `/audio/transcriptions`。

## v0.9.17 — 2026-08-15
- **修复语音功能报 Failed to fetch**：v0.9.16 把语音识别/朗读改成调用外部 API（Whisper / MiniMax），但渲染进程的 Content-Security-Policy 限制 `default-src 'self'`，导致 `fetch` 外部接口直接失败，表现为「语音识别失败：Failed to fetch」和「测试失败：Failed to fetch」。现将语音 **TTS、STT 网络请求全部改到主进程** 处理（IPC `ai-voice-tts` / `ai-voice-stt`），渲染进程只负责录音和播放，不再直接 fetch 外部语音接口。
- **AI 助手布局微调**：因 v0.9.13 新增顶部工具栏占掉 48px，聊天卡片底部被截。已将 `.content-body` 顶部内边距收窄 10px，并把 `.chat-card` 高度从 `calc(100vh - 180px)` 调整为 `calc(100vh - 205px)`，使底部输入框和状态栏完整显示。

## v0.9.16 — 2026-08-15
- **修复麦克风语音识别无结果**：v0.9.15 使用 Chromium 的 `webkitSpeechRecognition`（依赖 Google 在线服务），在国内网络下无法识别，导致点击麦克风后提示「未识别到语音」。现彻底替换为 **MediaRecorder 本地录音 + 服务端转写**：点麦克风授权后开始录音，检测到约 1.5 秒静音或再次点击麦克风则自动结束，录音发送给 STT 服务转文字并自动填入输入框、自动发送。
- **新增语音识别来源选择**：在「AI 设置 › AI 语音」中新增「语音识别来源」选项：
  - **跟随当前 AI 配置**：把录音以 `audio/webm` 格式发送到当前 AI 配置的 `/audio/transcriptions` 接口（OpenAI 兼容，模型 `whisper-1`，语言 `zh`）。适合已配置 OpenAI / Azure 等支持 Whisper 的提供商的用户。
  - **MiniMax ASR**：使用上面填写的 MiniMax API Key，将录音重采样为 16kHz WAV 后调用 MiniMax `/v1/audio/asr` 接口转写。
- **修复本地/ MiniMax 测试语音无声音**：
  - 本地模式：原先未等待系统语音列表加载，macOS 上可能直接播放失败。现改为异步等待 `voiceschanged`、自动选择中文语音后再朗读；同时测试按钮不再受「AI 语音」总开关限制，可直接试听。
  - MiniMax 模式：修正默认模型为 `speech-01-turbo`（原 `speech-2.8-turbo` 不是有效模型名），增加 `data.audio` 等嵌套格式兼容，缺少音色时给出明确提示。音色拉取失败兜底列表更新为 MiniMax 官方系统音色 ID。

## v0.9.15 — 2026-08-15
- **新增 AI 语音设置与麦克风联动**：AI 设置左侧栏新增「AI 语音」分类，支持选择「本地（免费/离线）」或「MiniMax 海螺（高质量）」两种模式。MiniMax 模式下可填写 API Key、拉取音色、选择音质模型、调节语速并保存。开启 AI 语音后，点击 AI 助手麦克风会自动创建一条新对话并开始聆听，说话结束后自动发送消息，AI 文本回复完成后会自动用语音朗读（本地模式用系统 speechSynthesis，MiniMax 模式调用其 TTS 接口）。再点麦克风可停止聆听/朗读。关闭 AI 语音开关后，麦克风恢复普通文字输入。

## v0.9.14 — 2026-08-15
- **修复 AI 助手麦克风语音输入**：此前点麦克风说话、输入框不显示识别内容。现已重写为规范流程——① 点麦克风先弹「麦克风权限」授权提示，点「授权」通过 `getUserMedia` 触发系统麦克风授权弹窗，允许后开始聆听；② 识别中把实时文字（已确认 + 临时）显示到输入框，麦克风按钮变红点脉冲表示聆听中；③ 说完话自动发送；④ 识别失败做中文提示（权限被拒 / 服务不可用 / 未检测到语音 / 无麦克风 / 网络异常）。已授权后再次点麦克风直接进入识别，不再弹窗。注意：语音识别走 Chromium 在线服务，国内网络可能不通导致仍不出字，届时需切换为设备端/Whisper 引擎（待用户实测反馈）。

## v0.9.13 — 2026-08-15
- **AI 设置弹窗全屏遮罩 + 分类分页显示**：此前设置窗口被 `.panel` 的 900px 宽度限制只能占半屏；现在解除限制，弹窗铺满整版灰色半透明遮罩、窗口居中。左侧分类改为分页切换——点「联网」只显示联网内容、点「外观」只显示外观内容，不再把所有板块堆在一起滚动。仅改 `renderer/style.css` 与 `renderer/app.js` 的弹窗样式与分页逻辑，未动任何升级/更新链路。

## v0.9.12 — 2026-08-15
- **AI 设置改为独立窗口样式**：点左侧「AI 设置」弹出独立设置窗口——顶部「设置」标题 + 右上角 × 关闭按钮，左侧分类导航（外观、联网、AI配置、记忆、MCP服务器、智能体技能、更新日志），右侧对应内容区，点分类滚动到对应板块，点遮罩或 × 关闭。所有原有设置项 id 不变、功能绑定保持原样。

## v0.9.11 — 2026-08-14
- **修复 AI 纯文本回答切回会话后丢失**：此前问纯知识类问题（AI 不调用工具）时，回答只在界面上临时显示，切到其他会话/功能再切回，AI 回答就不见了。根因是 agent 循环在「无工具调用的纯文本回复」时直接退出、没把 assistant 回复写入返回的会话历史。现已改为每次 API 调用后都落库 assistant 回复（纯文本与工具调用两种场景一致），历史完整、切换后正常渲染。

## v0.9.10 — 2026-08-14
- **修复历史记录「串台」与内容丢失**：此前 AI 执行任务时点开其他历史记录，会把正在进行的活动内容显示到别的会话里，且可能丢失原工作内容。根因是对话内容、流式输出、气泡引用都是全局共享的。现在每个 AI 任务发起时绑定所属会话，流式输出与最终结果只写回发起的那条会话；切换/新建会话前自动保存当前内容。各会话完全隔离、互不影响。
- **功能任务自动生成独立会话**：按规则替换、文件自动化、PPT 编写/修改、格式转换、PDF 去水印等功能调用 AI 时，一律自动新建一条独立会话记录，不再写入当前聊天，互不污染。同一时间只运行一个 AI 任务，任务运行中再发起其他功能会提示稍后重试。
- **修复历史记录「改名」无效并改为行内编辑**：此前点「改名」没反应，根因是 Electron 不支持 `window.prompt()`。现改为行内输入框（标题原地变为高亮输入框），回车或点别处确认、Esc 取消；改名只影响显示标题，不影响聊天内容，也不会被自动标题覆盖。

## v0.9.9 — 2026-08-13
- **更新应用图标与 UI 资源**：把应用主图标（Dock/启动台）、UI 左上角 logo、DMG 卷标图标与 DMG 背景图全部替换为新的图标。原图非正方形，已居中裁剪并生成标准 macOS 多尺寸 `.icns` 图标。仅替换图片资源，未改动任何代码逻辑与升级链路。

## v0.9.8 — 2026-08-13
- **修复历史记录「改名」不生效**：侧边栏历史记录项「⋯」菜单里的「改名」此前点了没用——因为每次同步当前对话时 `persistCurrentChat()` 都会用首条消息自动生成标题，把手动改的标题覆盖掉。现给对话加 `customTitle` 标记，手动改名后不再被自动生成覆盖。仅改 `renderer/app.js`，只影响历史记录显示标题，不影响实际聊天内容。归档、删除原本正常，保持不变。

## v0.9.7 — 2026-08-13
- **「按规则替换文件」技能选择默认改为「不指定技能」**：此前「技能选择（可选）」下拉默认自动选中 `system-data-intelligence`，现改为默认选中「（不指定技能，按默认流程）」，不预先绑定技能、走默认替换流程；用户仍可手动从下拉选择所需技能。仅改 `renderer/app.js` 的 `populateReplaceSkill()` 默认选中逻辑，未动其他代码与升级逻辑。

## v0.9.6 — 2026-08-13
- **改用 ad-hoc 签名，删除「双击安装.command」引导**：v0.9.5 的 .command 引导改为更接近 WorkBuddy 的原生安装体验。根因是 app 的 ad-hoc 签名在 rsync 后失效，失效 + quarantine 会被 Gatekeeper 判为「已损坏」；现在 `make_dmg.py` 每次打包前重新做有效的 ad-hoc 签名（并对 DMG 本身也签名），签名有效后别人下载打开只会提示「无法验证开发者」（不再「已损坏」），用户右键→打开，或到「系统设置 → 隐私与安全性」点「仍要打开」即可——这是 macOS 自带的安全选项。安装方式回到标准：打开 DMG → 把 AI Copilot 拖到「应用程序」→ 首次打开按上述确认。未改动 app 代码与升级逻辑。

## v0.9.5 — 2026-08-13
- **新增 DMG「双击安装.command」引导**：解决把安装包发给别人后，对方打开提示「"AI Copilot"已损坏，无法打开」的问题。现在 DMG 根目录多了一个「双击安装.command」，对方双击它会弹出安全确认（「打开 / 取消」按钮），点「打开」后脚本自动把 app 拷到「应用程序」、解除隔离属性并启动。`.command` 是脚本不会被 Gatekeeper 判为「已损坏」，首次若提示无法验证，右键→打开即可执行。未改动 app 本身代码与升级逻辑。

## v0.9.4 — 2026-08-12
- **新增「生成对话记忆」（WorkBuddy 式长期记忆库）**：在「AI 设置」中新增「生成对话记忆」开关（默认开启）。开启后，每次 AI 助手完成回复会**后台自动**把最近对话发给模型提炼事实/偏好/习惯/项目约定，存入本机 `~/Library/Application Support/AI Copilot/memory.json`；后续对话构建系统提示词时会注入这些记忆，让 AI 越聊越懂你。支持在「AI 设置 → 查看记忆」里查看和删除单条记忆。同时保留对话级记忆的接口（为后续按对话隔离做准备），当前主要使用用户级记忆。
- 实现涉及新增 `app/memory.js` 存储模块、`ai-config.js` 开关持久化、`agent.js` 的提炼与注入、`main.js` 的 IPC、`preload.js` 桥接、渲染端设置页 UI。未改动任何升级/更新相关逻辑。

## v0.9.3 — 2026-08-12
- **修复 `＋` 按钮选文件后聊天框不显示附件**：主进程 `pick-attachments` 处理器里调用了不存在的函数 `mimeFor()`（正确定义名是 `mimeForExt()`），每个文件处理到一半抛 ReferenceError，被静默吞掉后返回空数组，于是文件框选完什么都不显示。本版把两处调用改为 `mimeForExt()`，`＋` 选任意文件/文件夹后立即在输入框上方显示附件条（缩略图/图标 + 文件名 + 大小 + 可移除）。拖拽、粘贴通路不受影响。

## v0.9.2 — 2026-08-12
- **修复「拖入 / 粘贴文件后聊天框不显示附件」**：根因是打包用的 Electron 43 已移除 `File.path`（Electron 32 起废弃并删除），拖拽和从访达粘贴拿到的 `f.path` 为空，`addAttachment` 静默丢弃，导致输入框上方没有任何文件信息显示、无法确认是否选中。本版改用官方替代 API `webUtils.getPathForFile()`（经 preload 暴露），拖拽、访达粘贴都能拿到真实磁盘路径并正常显示附件信息条（缩略图/图标 + 文件名 + 大小 + 可移除）。同时重排粘贴逻辑：访达复制的文件优先走真实路径、截图等无路径图片走临时文件，避免同一图片重复添加、以及空路径时误吞粘贴。
- 核验过全链路：`＋` 选任意文件/文件夹（v0.9.1 已修）、拖拽、⌘V 粘贴（截图 / 访达文件）三条通路都会把附件显示在输入框上方；发送后图片以多模态给模型看、文档（docx/xlsx/pptx/pdf/txt/md 等）提取正文注入对话，AI 能看到文件内容。

## v0.9.1 — 2026-08-12
- **修复 `＋` 按钮「点一下弹两次 / 实际没把文件加成附件」**：v0.9.0 里 `btn-attach` 被注册了两个 click 监听器——旧监听器走「引用对话文件（替换规则）」框架，新监听器走「聊天附件（pickAttachments）」框架，两者同时触发导致行为冲突、文件框弹两次且不进附件列表，表现为粘贴/拖拽/＋ 选文件「不能实现」。本版**删除旧的 `selectFiles` 监听器**，只保留 `pickAttachments` 这一个，`＋` 现在干净地打开系统文件框并把选中的文件/文件夹加入待发送附件，与拖拽、粘贴图片两条通路一致。拖拽（composer drop 事件）、粘贴（`chatInput` paste 事件，含剪贴板图片与 Finder 复制路径）、IPC 桥接（`pick-attachments` / `save-temp-file`）均保持原状未动。

## v0.9.0 — 2026-08-12
- **AI 助手对话框：粘贴图片 + `＋` 选任意文件/文件夹直接发给 AI**。
  - **粘贴图片**：在输入框直接 `⌘V` 粘贴剪贴板里的图片（截图等），图片会以附件形式出现在输入框上方预览，可单独发送，也可先在框里打字再一起发送；从访达（Finder）复制的文件路径也能直接粘贴成附件。
  - **`＋` 按钮**：点击打开系统文件选择框，可选**任意文件（可多选）**，也能选**整个文件夹**——选文件夹时会递归收集里面的文件一并作为附件。桌面、`/Users` 下任意目录都可选（即「授权 AI 看电脑任意位置的文件」通过「你主动选择」这一动作达成）。
  - **发送与读取**：图片以多模态直接给模型看；文档（docx/xlsx/pptx/odt/pdf/txt/md/代码等）主进程提取正文后作为对话内容注入，AI 立即看到全文。附件预览（图片缩略图 / 文件图标 + 名称 + 大小，可单独移除）与历史持久化沿用 v0.8.31 的机制。

## v0.8.32 — 2026-08-12
- **修复在线更新「下载并安装」失败（`ENOENT: .../.update/staging/renderer/`）**：根因是增量包 zip 内含有 `renderer/`、`renderer/assets/` 等目录条目（macOS `zip -r` 默认会为目录建条目），而解压逻辑未跳过目录条目，对 `renderer/` 这种路径调用 `fs.writeFileSync` 时向一个目录路径 `open` 报错。已在 `updater.js` 的 `applyDeltaAndRelaunch` 解压循环里加 `e.name.endsWith('/')` 跳过目录条目。本地用真实增量包模拟解压已验证：3 个目录条目被跳过、29 个文件正确写出、`renderer/` 作为目录正常存在，不再 `ENOENT`。
- **说明（鸡生蛋）**：本 bug 在所有含此解压逻辑的老版本中都存在，且发生在「解压当前下载的更新包」这一步——老版本会用自身坏代码解压、当场崩溃，因此纯在线升级无法自我修复。请手动安装本版（v0.8.32）DMG 一次打破循环；装好后再点「下载并安装」即可正常在线升级。

## v0.8.31 — 2026-08-11
- **AI 助手对话框支持「拖拽文件发送」**：把图片 / 文档（docx、xlsx、pptx、pdf、txt/md/代码等）直接拖到输入框，松手后会在输入框上方显示附件预览（图片缩略图 / 文件图标 + 名称 + 大小，可单独移除），点发送即随消息一起发给 AI。
  - **图片**：以多模态图片直接发送给模型（复用既有 vision 通路，OpenAI 走 `image_url`、Anthropic 走 `image` base64），AI 可直接「看」图。
  - **文档（按用户拍板「直接注入文本内容」）**：发送前主进程提取正文——纯文本类直接读；docx/xlsx/pptx/odt 用内置 zip 解析（复用 `office-replace.js` 的 `readZipEntries`）抽取 XML 文本；PDF 借助 LibreOffice 转 txt 后读取。提取到的全文作为对话内容注入，AI 立即能看到文档内容。
  - **历史持久化**：本轮附件的 user 消息会被清洗为「文本 + 附件元信息」再落盘，避免把大体积 base64 写进本地聊天记录；重新打开对话时仍会显示文件卡片。
  - 拖拽仅监听 composer 区域，纯文本拖拽（如选中文字）不受影响；无附件且输入框为空时不发送。

## v0.8.30 — 2026-08-11
- **恢复「代码级」老格式 `.doc`/`.xls` 处理（确定性，不依赖 AI 是否开启）**：v0.8.29 走的是「加技能、让 AI 按指引转格式」方案，结果依赖 AI 是否听懂并执行。本版把双向转换适配层直接做进替换引擎——`office-replace.js` 新增 `replaceInLegacyFile`：遇到 `.doc`/`.xls` 时，LibreOffice 转 OOXML（`.docx`/`.xlsx`）→ `processOfficeFile` 对内部 XML 做规则替换 → 再 LibreOffice 转回原格式，写回合法的老格式文件。三处入口都已打通：**替换框架 UI**（`main.js` 的 `processFile` 新增 `isLegacy` 分支）、**AI 的 `edit_file`**、**AI 的 `batch_replace`**。`grep_files` 仍按 OLE 二进制乱码搜、老格式不进文本搜索集（符合纪律，未动搜索可见性）。已用真实文件 round-trip 验证（`.doc` 张三→李四、`.xls` 测试→生产，转回后文件合法可读）。

## v0.8.29 — 2026-08-10
- **「按规则替换文件」新增「技能选择（可选）」**：在替换框架规则下方加了一张可选技能卡，默认选中 **system-data-intelligence**（内置智能体技能）。该技能指引 AI 在替换/修改遇到老版二进制格式 `.doc`/`.xls` 时，先转 OOXML（`.docx`/`.xlsx`）再替换、改完转回，从而不再「像没看到一样」丢失文件。下拉其余可选 office 编写相关内置技能（document-converter、format-convert、polish-document、reformat-document、pdf-to-office）。选中技能仅在开启「AI 助手替换」时生效——执行时把「先加载该技能」写入提示词交给 AI 代理按指引执行；未开启时走原本地引擎，行为不变。
- 注：放弃此前在替换引擎里直接做 `.doc`/`.xls` 双向转换（LibreOffice 适配层）的代码方案，改为「加技能、让 AI 按技能指引处理」的更轻方案。

## v0.8.28 — 2026-08-10
- **修复「点升级、装完、自动重启后仍是旧版本，需手动关闭再打开才生效」**：根因是升级脚本用 `open "${target}"` 重启，而 macOS 在旧进程尚未被系统注销时会把 `open` 当作「激活已有实例」——于是把内存里还是旧代码的老进程置前，而非拉起新进程。改为「后台 bash 只负责复制新文件，主进程轮询复制完成标记后调用 `app.relaunch()` + `app.quit()` 托管重启」。`app.relaunch()` 由 Electron 向系统注册「退出后重新启动」，不会激活未退出的旧实例，从根本上消除重启竞态。（无功能改动，仅升级重启机制）

## v0.8.27 — 2026-08-10
- **AI 助手支持读取老格式 `.doc` / `.xls`**：此前 `read_file` 直接按 UTF‑8 读这些 OLE 二进制复合文档会乱码、AI 读不懂内容。本版新增老格式提取层——`.doc` 用系统自带 `textutil -convert txt` 转纯文本（离线秒级、UTF‑8 保真）；`.xls` 用 LibreOffice（`soffice --headless --convert-to csv`，macOS 默认 UTF‑8、中文保真，多 sheet 自动拼接为多个 CSV）。仅改读取入口，不动转换/替换逻辑。

## v0.8.26 — 2026-08-10
- **测试版（极小改动）**：仅升级版本号，用于验证「在线增量升级」机制是否真正生效。无功能改动。

## v0.8.25 — 2026-08-10
- **「文件名修改 → ② 添加重命名规则」新增「导出规则 / 导入规则」**：与「按规则替换文件」一致，支持把重命名规则整批存成 `.xlsx` / `.csv` 表格、也能从表格批量灌进来。复用现有的 `rules-io.js`（零第三方依赖，手写的 xlsx/zip 引擎），弹窗标题与文件名前缀会自动区分「重命名规则」。导出列为「规则名称 / 查找内容 / 替换内容 / 启用」，导入时如有现有规则会询问替换还是追加，并对中英文表头、空白行做容错。
- **修复「点更新、下载完、重启后还是老版本」**：根因是 `main.js` 顶层的 `applyPendingUpdate()` 写成 IIFE，在 `app.whenReady()` 之前就执行，而 `app.getPath('userData')` 在 app 未 ready 时会抛错被 catch 吞掉，导致 `pending-update` 暂存的更新文件永远不被覆盖到 `Resources/app`。改为函数声明，在 `app.whenReady().then()` 内、建窗之前调用——此时 `app.getPath` 已可用，文件覆盖正常执行，升级重启后版本号确实升级。

## v0.8.24 — 2026-08-10
- **修复「AI 助手回复内容出现乱码（如 `（��用了、���。）`）」**：根因是主进程所有 HTTP 响应用 `res.on('data', (c) => data += c)` 逐块把 Buffer 转成字符串再拼接。Node 的 `http` 响应默认以原始 Buffer 分块下发，分块边界会随机切断一个多字节汉字，被切断的字节各自单独按 UTF‑8 解码都会变成 `U+FFFD` 替换字符——于是中文只在「刚好落在分块边界上的字」处乱码，其余正常，表现为偶发、位置不固定。
  - **修法**：所有响应接收改为「先把各块 `Buffer` 攒进数组，等流结束再用 `Buffer.concat(...).toString('utf8')` 一次性解码」，多字节字符跨块也能正确还原，彻底消除乱码。涉及 `agent.js`（AI 回复、联网搜索、读取网页）、`ai-config.js`（模型列表）、`mcp.js`（MCP 工具返回）、`updater.js`（更新检查）、`main.js`（技能市场搜索）共 7 处。
  - **额外加固**：AI 回复请求头加上 `Accept-Encoding: identity`，避免个别反向代理对回包做 gzip 压缩后未解压就当文本解码（那会产生另一种整体乱码）。
  - 已用 Node 脚本复现并验证：在汉字中间人为切断分块，旧写法必出 `U+FFFD`、新写法与原文完全一致。

## v0.8.23 — 2026-08-10
- **「按规则替换文件 → 替换框架」新增「导出规则 / 导入规则」**：「已建规则」卡片右上角新增两个入口，支持把替换规则整批存成表格、也能从表格批量灌进来。以后几十上百条规则不用再一条条手敲，可在 Excel 里编辑好一次性导入，规则集也能保存、复用、发给同事。
  - **导出规则**：点击展开下拉，可选 **Excel 工作簿（.xlsx）** 或 **CSV 文件（.csv）**。导出列为「规则名称 / 查找内容 / 替换内容 / 启用」，表头加粗带底色、列宽已调好、长文本自动换行；导出完成后自动在访达中定位到该文件。
  - **当前没有规则时导出，会生成一份只含表头的空白模板**，填好后直接导入即可，等于内置了一个规则模板。
  - **导入规则**：支持 `.xlsx` / `.xlsm` / `.csv`。导入时若已有规则，会询问是「清空后替换」还是「追加到现有规则之后」。
  - **导入容错做得比较宽**：自动识别中英文表头（如 `查找内容`/`find`、`替换内容`/`replace`）；没有表头时按列位置推断（两列＝查找/替换，多列＝名称/查找/替换/启用）；「启用」列可写 `是/否`、`启用/停用`、`true/false`、`1/0`、`Y/N`；「查找内容」为空的行会被自动跳过并在提示里说明跳过了几行；CSV 支持带引号的字段、字段内逗号与换行，并在检测到疑似 GBK 编码时自动转码。
  - 导出的 CSV 带 UTF-8 BOM，用 Excel 直接双击打开中文不乱码。
- **实现说明**：xlsx 的读写为纯 Node 内置模块手写实现（复用已有的 zip 引擎），未引入任何第三方依赖，不增加安装包体积。生成的文件已通过独立解析器（openpyxl）与系统类型识别校验，可被 Excel / Numbers / WPS 正常打开。

## v0.8.22 — 2026-08-09
- **修复「AI 设置 → MCP 服务器」里「从 JSON 导入」按钮在浅色模式下看不见的问题**：该按钮此前使用 ghost 样式（透明背景 + 透明边框），在浅色主题的白色卡片上几乎完全隐形，用户很难发现这个入口。本版改为与「🏪 从市场添加」一致的标准描边按钮（1.5px 实线外框 + 白色底），并加上 `{ }` 图标以示区分，三个按钮视觉统一、一眼可见。

## v0.8.20 — 2026-08-09
- **彻底修复「点升级按钮必失败 / 卡在『下载中断，1/2 次重试』」的根本原因**：此前更新器在 app **运行时**直接覆盖自身 `Resources/app` 内的文件，macOS 会间歇性拒绝（cp/fs 均报 `Operation not permitted`），导致增量应用失败 → 回退 341MB 完整包 → 完整包下载再失败。v0.8.18 的 `cp -RfX` 方案在真实运行环境同样会触发该保护，并非扩展属性问题。
- 本版改为业界标准做法——**「退出后替换」**：下载增量后先暂存到 app 外部的 `userData/pending-update`，然后重启；由**新进程启动最早期（任何业务模块加载之前）**执行真正的文件覆盖。此时旧进程已完全退出、无任何进程占用 app 文件，覆盖 100% 成功。增量包通常仅几十 KB，因此升级快速、不碰完整包、不报错。
- 完整 DMG 回退路径同样改为退出后替换（只替换 `Resources/app` + `Info.plist`，不碰正在运行的二进制/Framework）。

## v0.8.19 — 2026-08-09
- **修复「升级中卡在『正在安装并重启…』」的界面误导**：此前即使升级失败（如网络错误），界面仍会无条件显示「正在安装并重启…」，让用户误以为在升级、实则已崩。本版在升级调用返回失败时**不再覆盖错误提示**，正确显示失败原因与手动下载链接，便于排查。
- 升级器延续 v0.8.18 的全部修复（`cp -RfX` 应用增量、`downloadFile` 重定向后去掉 `Range` 头、严格的 sha256 校验、升级后 `Info.plist` 版本同步），确保从 v0.8.18 点「下载并安装」能稳定、快速地走增量包升级。

## v0.8.18 — 2026-08-09
- **修复增量更新「应用失败并回退到完整 341MB 包」问题**：v0.8.17 的增量路径使用 `cp -Rf` 覆盖 `Resources/app`，但运行中的 `.app` 目录带有 `com.apple.provenance` 等扩展属性，`cp` 默认尝试复制扩展属性会报 `Operation not permitted`，导致增量应用失败并回退到完整 DMG 下载。本版将覆盖命令改为 `cp -RfX`（不复制扩展属性），并在 `cp` 失败时回退到 Node.js 逐文件复制，确保增量包能真正应用；完整 DMG 回退路径同样使用 `-X` 参数，避免同一问题。

## v0.8.17 — 2026-08-09
- **新增「升级成功提示」**：升级并重启后首次打开时，界面顶部会显示一条绿色提示「已升级到 vX.Y.Z（原 vA.B.C）」，10 秒后自动消失、也可手动关闭。以后升级完一眼就能确认新版本是否真正生效，不用再去翻版本号。
  - 实现方式：主进程把每次运行的版本号记录到 `userData/last-run-version.json`，启动时与当前 `package.json` 版本比对，仅在版本号确实变高时提示（首次安装不提示）。
- 说明：v0.8.16 及以前的版本内置的是有缺陷的更新器，**无法自我升级**，需手动安装一次 v0.8.16 或更新的安装包；从 v0.8.16 起点击升级即可正常生效。

## v0.8.16 — 2026-08-09
- **修复「在线升级永远失败、重启仍是老版本」的根因**：此前更新器依赖 Electron 的 `app.getVersion()` 判断当前版本，但 macOS 打包的 `.app` 中该 API 读取的是 `Info.plist` 的 `CFBundleVersion`（本应用恒为 `0.7.2`，增量更新不覆盖 `Info.plist`），导致版本判断永远错乱——所有增量包（`deltas`）都匹配不上，只能走「完整 DMG」路径；而该路径用 `detached bash + app.quit()` 在 app 退出后子进程被一并杀死、`apply.sh` 从未执行，于是升级永远不生效。
  - 改为更新逻辑直接读取 `Resources/app/package.json` 的真实版本号（`getCurrentVersion()`），增量匹配恢复准确。
  - 增量与「完整 DMG」两种安装路径**统一改为在主进程内同步完成**（下载→`cp -Rf` 原地覆盖文件→`app.relaunch()`+`app.exit(0)`），不再依赖任何会被杀的 `detached bash` / `launchctl` 子进程。
  - **升级完成后同步刷新 `Info.plist` 版本号**：增量包只覆盖 `Resources/app`，此前 `Info.plist` 会永远停留在打包模板的旧版本；现在应用更新后用 `plutil` 把 `CFBundleShortVersionString`/`CFBundleVersion` 一并改为新版本，重新打开后版本号处处一致。
  - **新增「覆盖结果校验」**：应用更新后立刻回读 `package.json`，若版本号没有真正变大则判定为失败并抛错，不再静默重启造成「点了升级还是老版本」的假象；增量应用失败时自动回退到完整安装包路径。
  - 修复 `attachDmg` / `copyApp` 误把异步 `execFile` 写成同步 `execFileSync` 却仍传回调，导致回调永不执行、Promise 永久挂起、完整安装包路径直接卡死的问题。
  - 「完整 DMG」整包覆盖遇到运行中可执行文件被占用（ETXTBSY）时，自动回退为只覆盖 `Resources/app` 与 `Info.plist`，保证版本号仍能正确更新。
  - 新增升级诊断日志：`userData/.update/updater.log` 记录每次下载/应用/重启，便于日后排查。
  - 打包脚本（`make_dmg.py`）新增把 `Info.plist` 版本同步为 `package.json` 版本，避免系统「关于」信息显示错乱。

## v0.8.15 — 2026-08-09
- **AI 设置新增「更新日志」卡片**：在 AI 设置面板最底部新增「更新日志」区块，自动读取本机 `CHANGELOG.md`，按版本倒序展示近期（最近 6 个）版本的升级内容（版本号 + 日期 + 要点列表），浅色/深色主题均适配，便于用户快速了解近期更新。通过新增 `get-changelog` IPC（主进程读取 `app/CHANGELOG.md`）供渲染进程获取原文并解析渲染。

## v0.8.14 — 2026-08-09
- **MCP 开关图标替换**：将聊天栏 MCP 开关的默认插头 emoji（🔌）替换为用户桌面提供的 `插头.png`，复制为 `renderer/assets/icon-mcp.png` 并通过 `<img>` 引用；CSS 固定为 14×14px、object-fit contain、垂直居中，大小随按钮缩放保持一致。

## v0.8.13 — 2026-08-09
- **升级提示增强（三项）**：① 侧边栏「版本号」右上角新增**黄色脉冲提示点**，发现新版本即常驻显示（升级进行中或已是最新时自动隐藏），作为持久提醒；② **程序打开即显示升级提示**——启动静默检查到新版本时，侧边栏更新框（含「立即升级」按钮）自动弹出；③ **闲置后台自动提示**——app 在后台/未聚焦/最小化时检测到更新，弹 macOS 系统通知（每版本仅提示一次，点击通知聚焦 app）。三者共用同一份 `update-available` 事件，互不冲突。

## v0.8.12 — 2026-08-09
- **「文件自动化」技能下拉默认选中 `file-organizer-skill`**：`populateAutoSkill()` 填充完「已安装 + 文件整理相关内置技能」后，若列表里含 `file-organizer-skill` 则自动将其设为默认选中项（不再默认「不指定技能」）。`file-organizer-skill` 本就是智能体内置技能（在 `agent.js` 的 `BUILTIN_SKILLS` 中注册，AI 设置→智能体技能 里带「内置」标签、不可卸载）。

## v0.8.11 — 2026-08-09
- **「PDF 去水印」技能选择器位置调整**：将「AI 去水印」所用的「技能」下拉从执行按钮旁（向导导航栏）移到「③ 保存地址」下方，新增独立卡片「④ 技能选择（可选）」，交互与文案对齐「文件自动化」模块的「⑥ 使用技能（可选）」——更清晰，不再紧贴按钮。

## v0.8.10 — 2026-08-09
- **修复增量更新「点击升级后重启仍是旧版」问题**：根因是 `applyDeltaAndRelaunch` 用 `spawn('bash', [sp], { detached: true })` + `app.quit()`，detached bash 子进程在 app 退出后被 macOS 杀掉，apply.sh 从未执行（delta 下载成功但文件没覆盖）。修复为**同步 `execFileSync('cp')` 在 app 退出前直接覆盖 `Resources/app/` 文件**，然后 `app.relaunch()` + `app.exit(0)` 重启——完全不依赖 detached bash。同步 cp 失败时仍回退到旧 detached bash（加了 `pgrep` 等待 app 退出循环）。完整 DMG 路径（`relaunchAndApply`）同样加了等待 app 退出的循环，避免 rm 运行中 app 导致崩溃。
- **「PPT 写手」两个子面板新增技能选择器**：「新编写 PPT」和「修改 PPT」各新增「使用技能（可选）」下拉，自动列出智能体技能里 PPT 相关的已安装/内置技能（关键词：ppt/pptx/kimi/presentation/演示/幻灯片）。选中技能后点「开始编写」或「AI 助手编辑保存」会先调用 skill 工具加载该技能、按其指引执行；若已安装 `open-kimi-ppt` 则默认选中。

## v0.8.9 — 2026-08-09
- **修复自动更新「跳版必走完整 342MB 包」问题**：更新器现在支持 `latest.json` 中的 `deltas` 数组，会选「`from` 等于当前运行版本」的那个增量包下载应用（并重做 sha256 校验）。发布脚本改为为每个历史版本都生成到最新版的独立增量包（如 `delta-0.8.9-from-0.8.0.zip` … `delta-0.8.9-from-0.8.8.zip`），写入 `latest.json.deltas`。无论你当前停在哪个旧版，在线升级都只会下载几十~几百 KB 的 tiny delta，不再被迫下载 340MB 完整 DMG。仍兼容旧版更新器的单一 `deltaUrl`。

## v0.8.8 — 2026-08-09
- **「PDF 去水印」新增技能选项与「AI 去水印」按钮**：在执行区（「去除水印」左侧）新增「✦ AI 去水印」按钮；在该按钮左侧新增「技能」下拉，自动列出与 PDF 去水印相关的技能（默认选中内置技能 `pdf-watermark-remover`）。点击「AI 去水印」会先调用 skill 工具加载所选技能、由 AI 代理按其指引移除 PDF 水印（输出到指定文件夹）；不指定技能则走默认流程。原「去除水印」（本地引擎）按钮保持不动。
- **新增内置技能 `pdf-watermark-remover`**：作为智能体默认内置技能（始终可用），指引用 pypdf 识别并移除 PDF 文本类水印（机密/内部/样品/draft 等），输出无标记副本。

## v0.8.7 — 2026-08-09
- **「文件自动化」新增技能选项**：在执行区（「开始编写」前）新增「使用技能（可选）」下拉，自动列出「已安装技能」与「文件整理相关内置技能」（`file-organizer-skill`、`document-converter`、`pdf-to-office`、`pdf-compress`、`pdf-merge-split` 等）。选中某技能后，点击「开始编写（AI）」或「AI 协助转换」时，会先调用 skill 工具加载该技能、按其指引执行文件自动化任务；不指定则走默认流程。

## v0.8.6 — 2026-08-09
- **新增默认智能体技能**：将 `file-organizer-skill`、`document-converter` 设为智能体默认技能（内置、始终可用）；并为「文件格式转换」面板新增技能选择器：`document-converter` 为默认，另提供 3 个 PDF 专项技能（`pdf-to-office` PDF 与 Office/图片/文本互转、`pdf-compress` PDF 压缩、`pdf-merge-split` PDF 合并/拆分/提取），以及「本地引擎（快速，不依赖 AI）」兜底选项。点击「开始转换」即使用所选择的技能（经 AI 代理执行），选「本地引擎」则走原内置快速转换。

## v0.8.5 — 2026-08-08
- **修正 `open-kimi-ppt` 技能依赖自检提示**：该技能默认走本地离线导出（纯 python-pptx，无需浏览器/联网/Node），原来的环境依赖却把 Node.js 18+ 标成必装，会导致自动安装提示多此一举地逼用户装 Node。本版将 Node.js 18+ 标记为「可选（仅 Kimi 在线导出兜底才需要）」，Python 3 仍为必装；`check_dependencies` 工具新增对 `optional` 标记的识别——可选依赖缺失时显示「⚪️ 可选缺失」且不计入缺失项、不弹安装确认。注：`open-kimi-ppt` 技能本身由 AI Copilot 从 GitHub（`ddxmu/open-kimi-ppt-skill` main 分支）按需拉取，离线优先的导出逻辑已于今日推送到该仓库，新装用户直接获得离线优先版。

## v0.8.4 — 2026-08-08
- **技能缺失依赖自动检测 + 授权后自动安装**：技能可声明环境依赖（如 `open-kimi-ppt` 需要 Node.js 18+ 与 Python 3）。当模型调用 `skill` 工具加载带依赖的技能时，指引中会自动追加「环境依赖自检」步骤：先调用新增的 `check_dependencies` 工具逐项自检，若发现缺失项，再调用 `install_dependency` 工具——后者会弹出一个授权确认条（📦 图标，文案「授权安装 Node.js 18+」等），用户点击「确定」后 AI 助手自动执行安装命令（如 `brew install node`，超时 10 分钟），装完继续任务；用户拒绝则降级说明。依赖声明集中在 `agent.js` 的 `SKILL_PREREQS`（`RECOMMENDED_SKILLS` 条目带 `prerequisites`），`install_skill` 安装仓库型技能后会写入该映射，使已安装技能同样可用。

## v0.8.3 — 2026-08-08
- **精简 `open-kimi-ppt-skill` 仓库并适配 AI Copilot 安装**：上游仓库 `ddxmu/open-kimi-ppt-skill` 原 codeload 打包约 87MB（含 `docs/` 82MB 图片、`example/` 41MB pptx/媒体、`editor/`+`lib/`+`bin/` 本地浏览器编辑器），导致 AI Copilot 从 GitHub 安装时下载慢、易失败。已将仓库精简为 0.52MB（仅保留自包含技能 `skills/open-kimi-ppt/` 与必要根文件），并移除 `npx open-kimi-ppt-skills serve` 本地浏览器编辑器功能、把硬编码的 `~/.agents/skills/...` 路径改为引用系统提示词「已安装技能目录」。同时本版在 `agent.js` 系统提示词的「环境」段暴露「已安装技能目录」（来自 `SKILLS_DIR`，即 `userData/skills`），使模型能以绝对路径正确运行技能内的 `scripts/export_pptx.py` 等脚本，安装后可直接在 AI 助手对话中使用。

## v0.8.2 — 2026-08-08
- **新增内置技能 `claude-in-chrome`（浏览器自动化）**：将 `claude-in-chrome` 直接内置进 `agent.js` 的 `BUILTIN_SKILLS`，无需安装、始终可用（在 AI 设置 → 智能体技能的「内置」列表中可见，调用 `skill` 工具即可加载指引）。技能来源为社区 `terrense/LilBot-agent` 的 `claude-in-chrome` SKILL.md，内容适配本应用工具集：先检查是否已接入浏览器 / Chrome 类 MCP 服务器（「AI 设置 → MCP 服务器」配置 + 聊天栏开启 MCP 开关并选定服务器）；已接入则优先调用 `mcp__<服务器>__<工具>` 完成页面检查 / 点击 / 输入 / 截图等浏览器操作，未接入则向用户说明缺少连接器并仅用 `web_fetch` / `web_search` 处理公开页面。

## v0.8.1 — 2026-08-08
- **修复推荐技能从 GitHub 安装时一直显示「安装中」**：`open-kimi-ppt` 等仓库型推荐技能点击安装后，因为 `codeload.github.com` 下载较慢（约 2.6MB 需 60-90 秒）且 UI 没有进度反馈，用户会以为卡死。修复：① `httpsDownload` 超时从 120s 延长到 300s；② 主进程在下载过程中通过 `skill-install-progress` 推送已下载字节数；③ 渲染层按钮实时显示「下载中 X.XMB…」；④ 安装按钮逻辑加 try/catch，异常或失败时恢复「安装」状态并弹窗提示。

## v0.8.0 — 2026-08-08
- **推荐技能支持直接从 GitHub 仓库安装**：新增「open-kimi-ppt」推荐技能（Kimi PPT 幻灯片技能，仓库 `ddxmu/open-kimi-ppt-skill`），点击「安装」即从 GitHub 下载并解压 `SKILL.md` 及其引用文件，无需手动复制。推荐技能入口项新增 `repo`/`branch` 字段；主进程 `skills-install-recommended` 在含 `repo` 时走仓库下载安装（复用 `installSkillFromGithub`）；`agent.js` 的 `install_skill` 工具也支持仓库型技能（`ctx.installSkillFromUrl`）。推荐列表对仓库型技能显示「GitHub」徽标。

## v0.7.9 — 2026-08-07
- **修复 MCP 市场「Fetch」模板包名错误**：之前模板使用 `@modelcontextprotocol/server-fetch`，但该包在 npm 上不存在（404），导致添加后连接失败。改为真实存在的社区 Node 包 `mcp-fetch`（`npx -y mcp-fetch`），无需 API Key，首次运行会自动下载依赖。

## v0.7.8 — 2026-08-07
- **AI 助手 MCP 开关默认改为「关」**：之前默认开启会让模型自动调用所有已连接的 MCP 服务器，现在默认关闭，避免不必要的工具注入；需要时点一下开关即可开启。
- **开启 MCP 后可单选一个服务器使用**：开关旁边新增一个下拉，列出当前已连接（ready）的 MCP 服务器，单选其一后本次会话只把该服务器的工具注入给模型（工具列表 + 系统提示词都按选中的服务器过滤）。服务器连接状态变化时下拉自动刷新；无已连接服务器时显示占位并禁用。

## v0.7.7 — 2026-08-07
- **修复深色模式下 AI 助手回复「看不见」的 bug**：用户反馈「聊天里说好对话，点其他模块再回到聊天，AI 恢复的内容不显示」，截图里 AI 一侧只剩浅灰色空条。
  - 根因：`.chat-msg.assistant .chat-bubble` 的背景色写死成 `#f4f5f7`（浅灰），深色模式下没有覆盖；而文字色用了 `var(--text)`，深色模式 `var(--text)` 是浅色。**浅灰背景 + 浅色文字 = 文字完全不可见**，所以所有 AI 回复在深色模式下看起来都像「空条」，切换 tab 后 DOM 没变，看起来像「恢复的内容丢了」。
  - 修复：深色模式覆盖 AI 气泡背景为 `#2a2f3a`（深灰）、边框调整为 `rgba(255,255,255,0.06)`，与浅色文字正常对比。
  - 顺手加防御：新增 `removeEmptyAssistantBubbles()`，在流式输出切换到工具调用（`onAiToolStart`）、对话回合结束（`sendChat`）、恢复历史（`switchToChat` / `loadChats`）时清理真正没有任何文字的 AI 气泡空条，避免残留。

## v0.7.6 — 2026-08-07
- **修复 MCP 市场模板占位符实际从未被替换的 bug**：v0.7.2 加文件系统模板时，`interpolateMcpTemplate` 的正则写错（带多余反斜杠 `/\\{\{...\}\}/g`，实际匹配 `\{\{path\}\}` 带反斜杠的字面量），而模板里是 `{{path}}`（无反斜杠），导致从市场添加任何带 `{{变量}}` 占位符的模板（filesystem、SQLite、PostgreSQL 等）时，占位符都不会被替换、原样写入 `args`/`env`。以前因为没保存校验，问题被掩盖；v0.7.5 的占位符校验暴露了所有之前写坏的配置。这次修复正则，市场流程可以正常替换为用户填入的真实路径/Key。

## v0.7.5 — 2026-08-07
- **修复 MCP 旧配置中未替换的 `{{path}}` 占位符导致文件系统服务器反复连接失败**：
  - 连接 stdio MCP 前，若 `args` 仍含 `{{...}}` 字面占位符，直接报清晰错误：「配置包含未替换占位符（{{path}}）。请删除此服务器，重新从 MCP 市场添加并填写真实值。」不再把 `{{path}}` 当真实路径传给服务器。
  - 保存 MCP 服务器时新增校验：stdio 的 `args` / `env`，SSE 的 `baseUrl` / `headers` 中如果仍含 `{{...}}` 占位符，拒绝保存并提示填写真实值，防止再次把模板占位符固化到配置里。

## v0.7.4 — 2026-08-07
- **调整 AI 助手「MCP 开关」位置**：从底部输入栏右侧移到**左侧「权限」按钮旁边**，并和权限按钮组成一组，避免视觉上过靠中、与右侧模型/联网信息混淆。
  - 布局改为 `.composer-left` 包裹「权限」+「MCP 开关」，右侧仍保留模型切换与联网徽章。
  - 功能与 v0.7.3 完全一致：默认开，点击切换本次会话是否允许 AI 调用已接入的 MCP 外部工具。

## v0.7.3 — 2026-08-07
- **AI 助手聊天界面新增「MCP 开关」**：放在底部输入栏「权限」按钮旁边（🔌 MCP · 开/关）。
  - 默认开启。开启时，AI 助手可调用你在「AI 设置 → MCP 服务器」里已配置并连上的全部 MCP 工具（与之前行为一致，调用前仍弹授权确认）。
  - 关闭后，本次会话不再把任何 MCP 外部工具注入给模型，也不会写进系统提示词——即使 MCP 服务器已连接也不会被调用。适合想临时禁用外部服务、只让 AI 用本机内置工具的场景。
  - 开关为**会话级**：在聊天界面点一下切换，立即对新一轮对话生效；重新打开应用后回到默认「开」。

## v0.7.2 — 2026-08-07
- **修复 MCP 市场「文件系统」模板接入失败**：原模板目录参数为 `{{path}}` 占位符，若未填真实目录就保存，会把字面 `{{path}}` 传给服务器导致「Cannot access directory /Users/xxx/{{path}}」报错。
  - 目录类参数（如文件系统）新增**「浏览…」按钮**，直接调用系统选文件夹弹窗，避免手敲路径出错。
  - 卡片预览不再显示裸 `{{path}}`，改为可读占位 `<path>`，减少误解。
  - 「新增服务器」编辑器的工作目录字段同样加「浏览…」按钮。
  - 文件系统类服务器**不需要 API Key**，只需给一个真实存在的目录即可。

## v0.7.1 — 2026-08-07
- **MCP 新增 SSE（远程服务）传输方式，兼容 Cherry Studio 配置格式**：
  - 此前仅支持 stdio（本地命令）。现在「新增服务器」可选择 **SSE** 传输，填写**服务地址 (baseUrl)、请求头 (headers)** 即可接入远程 MCP 服务，无需本地运行 npx。
  - 自研零依赖 SSE 客户端：GET 建立 `text/event-stream` 流 → 读取 `endpoint` 事件 → POST 发送 JSON-RPC，响应按 id 在流上匹配；支持 `${KEY}` 占位符，运行时用「环境变量」里的值替换（如 `${DASHSCOPE_API_KEY}`）。
  - **从 JSON 导入**现在同时兼容 **Claude Desktop 与 Cherry Studio** 的 `mcpServers` 格式：能自动识别 `type:"sse"` + `baseUrl` + `headers` 配置并正确接入（如阿里云百炼托管的 GitHub MCP 服务）。
  - **MCP 市场**新增模板「GitHub（阿里云百炼）」，点一下填 DashScope API Key 即可用，无需本地环境。
  - 编辑器按传输方式显示不同字段（stdio：命令/参数/目录；SSE：地址/请求头），并自动把 headers 里的 `${KEY}` 占位符预填入环境变量供填写。

## v0.7.0 — 2026-08-05
- **新增 MCP 服务器接入（AI 设置 → MCP 服务器）**：填好连接信息，AI 助手即可直接使用该服务器提供的全部工具。
  - 支持 stdio 方式启动的本地 MCP 服务（npx / uvx / node / python3 等），可配置**启动命令、参数、环境变量、工作目录**，并可单独启用/禁用。
  - **测试连接**按钮：先握手试跑一遍，直接列出发现的工具，确认可用再保存。
  - **从 JSON 导入**：兼容 Claude Desktop 的 `mcpServers` 配置，粘贴即可批量接入。
  - 卡片实时显示每个服务器的连接状态（已连接 / 连接失败 / 未连接）、工具数量与工具名；失败时给出具体原因（找不到命令会提示填写完整路径）。
  - MCP 工具以 `mcp__<服务器名>__<工具名>` 形式加入智能体工具集，并写进系统提示词；**每次调用前仍会弹出授权确认**，与本地工具一致的安全策略。
  - 自研 stdio JSON-RPC 客户端（零外部依赖），自动补全 Homebrew / nvm / uv 等常见可执行路径，避免从 Finder 启动时找不到命令；应用退出时自动清理子进程。

## v0.6.9 — 2026-08-05
- **更新检查更主动（后台静默）**：新增「文件打开即检查」——每当在任意模块选中文件/文件夹（按规则替换、AI 附件、重命名、格式转换、PDF去水印等），后台静默同步一次更新情况，有更新就弹出左侧栏提示，不打扰操作；同时把空闲轮询间隔从 20 分钟缩短为 10 分钟（带 60 秒去抖，避免高频触发反复请求 GitHub）。

## v0.6.8 — 2026-08-05
- **更新提示移入左侧功能栏底部**：发现新版本时，不再弹右下角提示卡片，改为在左侧边栏「版本号」位置直接显示一张贴合功能栏宽度的「对话信息框」（含版本号、「立即升级」「关闭」），不占用主界面、不挤压导航、宽度始终贴合侧边栏。

## v0.6.7 — 2026-08-05
- **右下角新版本提示**：发现新版本时不再在左侧边栏显示横幅，改为弹出右下角小提示卡片，含版本号、「升级」「关闭」按钮，更轻量、不占主界面；支持浅色/深色模式。

## v0.6.6 — 2026-08-05
- **新增增量更新（Delta Update）**：在线升级时，如果当前版本正好是上一版，只下载包含变更文件的小增量包（通常几十 KB ~ 几 MB），秒级完成升级，不再下载 341MB 完整 DMG。
  - 发布脚本自动基于 `git diff` 上一版本 tag 构建增量 zip（改动文件 + 删除清单），上传到同一个 GitHub Release。
  - `latest.json` 新增 `deltaUrl`/`deltaSha256`/`deltaFromVersion` 字段。
  - App 端 `updater.js` 检测到版本匹配时走增量路径：下载 delta.zip → 用 `readZipEntries` 解压到 staging → 写 bash 脚本在退出后覆盖 `Resources/app/` 并重启。
  - 当前版本与增量来源不匹配时自动回退完整 DMG 下载，保证任何版本都能升级。
  - 设置页检测到更新时提示「支持增量升级」。
- **兼容性**：`downloadAndInstall` 接受字符串（旧 dmgUrl）或对象（含 delta 字段），向后兼容。

## v0.6.5 — 2026-08-05
- **修复自动更新下载卡住/无进度**：重写 `updater.js` 下载逻辑。
  - 弃用 `res.pipe()`，改用手动 `out.write(chunk)`，确保进度事件可靠触发。
  - 进度条下方实时显示 **已下载 / 总量 (百分比) · 速度**，例如 `12.5 / 341.6 MB (4%) · 45 KB/s`。
  - 新增 **45 秒假死检测**：超过 45 秒没收到数据自动中断并重试。
  - 新增 **断点续传**：中断后从已下载位置继续，最多重试 2 次。
  - 新增 **手动下载 fallback**：下载失败时显示「GitHub 下载失败？点击手动下载 DMG」链接，点击用系统浏览器打开 Release DMG。
- 软件更新卡片文案增加「完整安装包约 340MB，网络较慢时请耐心等待或手动下载」提示。
- 新增 `shell.openExternal` 处理，点击 `target="_blank"` 的链接会跳转到系统默认浏览器。

## v0.6.4 — 2026-08-05
- **升级提示改为版本号旁小黄点**：按用户截图把左下角版本号旁的「升级」按钮简化为紧贴版本号的黄色脉冲圆点，更直观、不占用边栏空间； hover 放大，点击即开始下载并自动安装重启。
- **新版本不再落本地 Downloads**：构建的 DMG 直接走发布脚本上传 GitHub Release，不在 `~/Downloads` 给用户留安装包；App 内自动升级时也只把临时包下载到 `userData/.update` 并在安装后自动清理。

## v0.6.3 — 2026-08-05
- **版本号旁升级入口**：左下角版本号边新增「升级」按钮——仅在检测到新版本时显示，带黄色脉冲圆点；点击直接下载并自动安装、重启。
- **空闲自动检测**：除启动静默检查外，新增每 20 分钟空闲定时检查 GitHub；有更新即在版本号边显示黄点 + 顶部横幅提示「发现新版本」。
- 同版本重复检测不再重复打扰（避免每轮轮询重置横幅）。
- 设置页「软件更新」卡片的「下载并安装」与底部升级按钮共用同一安装流程。

## v0.6.2 — 2026-08-05
- **新增自动更新**：App 内置更新器，从 GitHub（ddxmu/AI-Copilot）拉取 `latest.json` 检查新版本。
- 启动静默检查（仅在有新版本时提示）；AI 设置 → 软件更新卡片支持「检查更新」与「下载并安装」一键安装。
- 更新流程：下载 Release 里的 DMG → 挂载 → 拷贝新版本 → 退出后自动替换并重启（适配未签名 DMG 分发）。
- 仓库托管完整源码 + 构建脚本 + 文档；DMG 安装包发到 GitHub Releases。

## v0.6.1 — 2026-08-05
- **统一深色模式显示框样式**：修复 AI 设置选择深色模式后，大量卡片/输入框/列表/弹窗/按钮仍保持白色的问题。
- 深色模式下所有显示框统一为黑色/深灰色（`#11141a` / `#1c1f26` / `#2a2f3a`），文字统一为白色/浅灰色。
- 覆盖范围：表单输入框、规则列表、文件列表、技能卡片、模型菜单、权限菜单、步骤条、composer、聊天气泡、授权面板、PDF 候选列表、开关、引擎提示、结果列表等。

## v0.6.0 — 2026-08-05
- **新增「推荐技能」系统**：AI 设置 → 智能体技能区域新增「推荐技能」分区，内置 6 个实用技能，用户点击即可安装：
  - `pdf-toolkit`：PDF 工具包（读取内容、提取页面、合并拆分、压缩、元数据）
  - `browser-automation`：浏览器自动化（搜索 → 读取网页 → 提取数据）
  - `simplify`：代码审查与清理（复用性、质量、效率三维度审查）
  - `deep-research`：深度研究（系统化联网调研，输出研究报告）
  - `batch-process`：批量文件处理（重命名、替换、转换统一流程）
  - `document-translate`：文档翻译（保持格式和术语一致）
- **新增「执行中自动安装技能」功能**：AI 助手执行任务时如发现需要尚未安装的推荐技能，可调用 `install_skill` 工具，弹出授权面板请求用户确认，用户同意后自动安装并启用该技能，无需手动去设置页安装。
- **系统提示词增强**：列出未安装的推荐技能，提示模型可按需安装。
- 授权面板独立于普通操作授权（不受 trust/deny 模式影响，始终需用户确认）。

## v0.5.7 — 2026-08-05
- **新增「AI 助手联网」开关**：在 AI 设置面板新增联网开关，开启后 AI 助手获得两个联网工具：
  - `web_search`：联网搜索互联网信息（DuckDuckGo），返回标题/链接/摘要
  - `web_fetch`：读取网页正文内容（自动去除 HTML 标签，支持重定向）
  - 开关关闭时，联网工具不注册，AI 助手只能操作本机文件
  - AI 助手面板底部显示 🌐 指示器提示联网状态
  - 设置持久化到 ai-config.json

## v0.5.6 — 2026-08-05
- **修复「文件自动化」转换逻辑**：v0.5.5 的模版补位逻辑导致输出目录里出现了模版文件，用户只需要需编写文件按模版位置摆放。
  - **移除模版补位**：模版有但需编写文件没有的 → 不复制模版文件，该位置留空
  - **只放需编写文件**：按关键字匹配到模版位置的需编写文件 → 复制到输出目录对应位置
  - **多余跳过**：需编写文件中模版没有的 → 跳过不同步
  - **AI 协助转换**：改为只核对文件摆放是否正确（不再改写补位文件）
  - 保留 v0.5.5 的关键字模糊匹配逻辑（精确名 > 包含关系 > 关键词重叠率≥50%）

## v0.5.5 — 2026-08-04
- **重写「文件自动化」转换逻辑**：v0.5.4 只移除了模版文件复制但匹配方式仍为精确文件名，大量文件无法正确归类。v0.5.5 彻底重写匹配与补位逻辑：
  - **关键字模糊匹配**：新增 `extractKeywords()` + `matchInputToTemplate()`——按文件名关键字智能匹配（精确名 > 包含关系 > 关键词重叠率≥50%），不再只靠精确文件名
  - **模版补位**：需编写文件缺失的（模版有但需编写文件没有），自动复制模版文件到对应位置，后续由 AI 按编写规范改写（公司名、风格、日期等）
  - **多余不同步**：需编写文件中模版没有的，跳过不放入输出目录
  - **输出 = 模版镜像**：输出目录结构与模版完全一致
  - **AI 协助转换升级**：先本地转换（匹配+补位+跳过），再由 AI 读取补位文件并按编写规范改写（替换公司名/人名/日期等），最后核对完整性
  - **结果展示**：区分 [匹配]、[模版补位]、[跳过] 三类，一目了然
  - **提示词更新**：`buildAutomationPrompt()` 明确匹配规则、补位规则、跳过规则

## v0.5.4 — 2026-08-04
- **修复「文件自动化」模块逻辑错误**：之前转换时先把模版全部文件复制到输出目录（兜底占位），再用需编写文件覆盖——导致输出目录里混入大量模版文件。
  - **修复后逻辑**：模版只作结构参照，输出目录里只放置「需编写文件」，按模版的目录结构摆放。模版文件不再被复制到输出目录。
  - **main.js**：`automation-convert` IPC 移除「先复制模版全部文件」步骤，只复刻模版子目录骨架 + 按模版位置摆放需编写文件。
  - **renderer/app.js**：更新结果摘要文案和 AI 协助转换提示词，不再期望模版文件出现在输出目录。
  - **renderer/index.html**：更新「转换」和「AI 协助转换」按钮的 tooltip 与提示文字，明确说明模版文件不复制。

## v0.5.3 — 2026-08-04
- **修复模型上下文窗口映射不匹配实际模型的问题**：之前 Kimi K3、MiniMax M3、DeepSeek V4 等新模型不在映射表中，走关键词兜底导致上下文被严重低估（如 MiniMax M3 实际 1M 被误判为 245K、DeepSeek V4 实际 1M 被误判为 64K），智能体过早触发上下文压缩，浪费上下文空间。
  - **新增精确映射**：Kimi K3（`k3`/`kimi-k3` → 1M、`k3-256k` → 256K）、MiniMax M3（→ 1M）、MiniMax M2 系列（→ 204800）、DeepSeek V4 全系列（→ 1M）
  - **新增智能名称解析器 `parseContextFromName()`**：自动从模型名中提取上下文大小（如 `k3-256k` → 256K、`foo-1m` → 1M、`bar-512k` → 512K），以后换新模型名也能自动适配
  - **前缀匹配改为大小写不敏感**：修复 `GPT-4o-2024-08-06` 等大写模型名无法匹配的问题
  - **关键词匹配更新**：DeepSeek V4 → 1M（不再走旧的 64K 兜底）、MiniMax M3 → 1M、K3 → 1M

## v0.5.2 — 2026-08-04
- **修复「AI 助手写文件经常一半停止，说『继续』就忘记」的问题**：
  - **根因**：之前 `chatHistory` 只存文本气泡（`{role, content}`），智能体内部的 `messages` 数组（含 `tool_calls` / `tool` 结果）与 chatHistory 互不连通。用户输入「继续」时，agent 只能拿到简化的首尾文本历史，**所有中间工具调用、文件读写、Todo 状态全部丢失**，所以 AI 一无所知。
  - **修复 1（agent.js）**：智能体循环接收完整历史（保留 `tool_calls` / `tool_call_id`），不再只 map `{role, content}`。
  - **修复 2（agent.js → main.js → app.js）**：完整链路透传完整 messages。`runAgentLoop` 返回 `messages`，`runAgent` 透传，主进程 `ai-chat` IPC 返回 `messages`，渲染进程 `sendChat` 用整轮 messages 覆盖 `chatHistory`。
  - **修复 3（renderer）**：新增 `renderHistoryMessage()` 渲染工具调用和工具结果（之前只有 user/assistant 文本气泡）。切换/加载对话时按消息类型分派渲染。
  - **修复 4（智能「继续」）**：用户输入「继续」/「continue」/「next」时，自动把当前未完成的 todo 列表拼成上下文注入，让模型知道之前在做什么。
  - **修复 5（run_command 空命令拦截）**：模型幻觉调用空命令时返回明确指引「请重新整理思路后再调用」，不再让用户授权一个空命令。
  - **修复 6（MAX_TURNS 触达提示）**：当单轮对话超过 40 轮工具调用限制时，agent 自动追加「如需继续请回复『继续』接着处理」的系统提示，用户清楚知道该输入「继续」。
  - **修复 7（系统提示增强）**：在 buildSystemPrompt 加「长任务连续性」一节，告诫模型不要中途停下总结、不要因为工具调用多就主动暂停。
- **持久化兼容**：旧的纯文本 chatHistory 仍能正常加载（按 `m.role` 分派渲染）；新格式（含 tool_calls）即时生效。
- **新增字段**：ai-chat 返回 `messages` / `todos` / `hitMaxTurns`。

## v0.5.1 — 2026-08-04
- **修复 Word/Excel 转 PDF 字体格式不对的问题**：之前走的是「`textutil` 转 HTML → Electron printToPDF」流程，textutil 会强制把所有文字改成默认字体（截图里看到 `font: 12.0px Times`），注入的 CSS 又再次覆盖成 PingFang SC 13px，导致原 docx/xlsx 的字体/字号/颜色/表格/列宽全部丢失。新方案按优先级自动选最佳 PDF 引擎：
  1. **LibreOffice (soffice --headless --convert-to pdf)**——高保真，完整保留 docx/xlsx/pptx 的字体/字号/颜色/表格/列宽/页眉页脚，并嵌入字体到 PDF
  2. **macOS Pages**（doc/docx/rtf/odt 兜底，原生排版还原度高）
  3. **macOS Numbers**（xls/xlsx 兜底）
  4. **textutil + Electron printToPDF**（最终兜底，且不再强制覆盖 textutil 输出的字体——只补 fallback 字体，不覆盖字号颜色）
  5. **cupsfilter**（txt/md/csv/json 纯文本路径不变）
- **PDF 引擎检测**：`app.whenReady()` 时自动检测 LibreOffice/Pages/Numbers 可用性，结果缓存。UI 在格式转换面板「开始转换」按钮旁显示「→ PDF 将用 LibreOffice 引擎渲染（高保真保留字体/表格）」提示条（按源/目标格式动态切换，绿色=LibreOffice/蓝色=Pages/紫色=Numbers/橙色=兜底）。
- **结果展示增强**：转换结果列表里每条成功项显示所用引擎（如 `→ file.pdf [LibreOffice]`），用户能直接看到当前文件用了哪个引擎。
- main.js 加 `pdf-engine-info` IPC，preload.js 暴露 `pdfEngineInfo()`。
- 实际效果验证：用 `1.docx`（中文含宋体标题）转 PDF，**原字体完整保留并嵌入到 PDF**（PDF 包含 STSong 字体子集），中文不乱码，排版与 Word 里看到的一致。

## v0.5.0 — 2026-08-01
- **AI 助手历史记录**：左侧边栏新增对话历史记录区域（导航项与设置按钮之间），自动记录每次 AI 对话。每条记录显示标题（取自首条用户消息），点击切换到对应对话，右侧「⋯」按钮弹出操作菜单：改名、归档/取消归档、删除。
- **对话持久化**：对话历史自动保存到本地文件（chat-history.json），重启应用后恢复上次对话。所有 AI 流程（助手对话、规则替换、文件自动化、PPT 写手、格式转换、PDF 去水印）均自动持久化。
- **新建对话**：侧边栏历史记录区右上角「+」按钮新建对话；/clear 命令改为新建对话。
- **归档对话**：归档后的对话折叠到列表底部「已归档」分组，不显示在主列表中。

---

## v0.4.8 — 2026-08-03
- **修复 PPT 写手显示问题**：入口页和子面板同时显示的 bug——根因是 CSS 缺少全局 .hidden 定义（只在 .card.hidden 等特定选择器下有），导致 classList.toggle('hidden') 不生效。新增全局 .hidden { display: none !important; }。
- **回退对话管理功能**：取消 AI 助手对话列表/新建/切换/删除/改名/归档/置顶功能（用户决定不做）。

---

## v0.4.7 — 2026-08-03
- **PPT 写手重构为入口页**：点击 PPT 写手后显示两个大选项框（40×40 图标卡片）——「新编写 PPT」和「修改 PPT」。
- **新编写 PPT**：简化流程——上传 PPT 模版（风格参照）→ 选择保存地址 → 点击「开始编写」跳转 AI 助手，在聊天框描述主题/页数/章节即可开始编写。
- **修改 PPT**：保留现有完整功能（模版+需编写+规范+保存方式+AI助手编辑/手动保存），入口页右上角返回。

---

## v0.4.6 — 2026-08-02
- **修复请求超时**：API 调用超时从 120 秒增加到 300 秒（5 分钟）；新增自动重试机制（超时/网络错误/429/502/503/504 自动重试最多 2 次，指数退避 1s→2s→4s）；超时错误提示更友好。
- **修复模型图标不显示**：ai智能体.png 处理逻辑修正（原图是透明背景+黑色星星，误把星星也变透明了），重新处理成透明背景+主题蓝四角星（9201 个非透明像素）。

---

## v0.4.5 — 2026-08-02
- **版本号动态同步**：左下角版本号从硬编码改为动态读取 package.json，每次打包自动更新，不再漏改。
- **上下文按模型自动同步**：新增模型上下文窗口映射表（40+ 模型），压缩阈值从固定 90000 改为按模型动态计算（上下文窗口 × 75%）。如模型支持 1M 就用 1M，2M 就用 2M，大幅减少对话过长压缩历史的情况。
- **模型图标替换**：AI 助手右下角模型名前的 🧠 emoji → 桌面 ai智能体.png（蓝色四角星，透明背景，适配浅色/深色主题）。

---

## v0.4.4 — 2026-08-02
- **AI 助手模型切换器**：右下角点击模型名 → 弹出浮层菜单，按服务商分组列出所有已配置模型，点击一键切换（切换后聊天区显示提示气泡）。支持任意多家服务商（DeepSeek/OpenAI/Moonshot/MiniMax/Zhipu/Qwen/Doubao/自定义），当前模型高亮 ✓。
- 接口变更：aiSetActive(id, model) 支持同时切换 profile 和 model；activeProfileSel change 事件同步更新。

---

## v0.4.3 — 2026-08-01
- **外观主题（浅色/深色）**：AI 设置面板新增「外观」卡片，提供 Segmented Control 风格切换：浅色 ☀️ / 深色 🌙。支持 localStorage 持久化 + 首次跟随系统主题 + 系统主题变化自动切换。CSS 变量全量覆盖，深色主题完整适配侧边栏、卡片、表单、按钮、聊天、弹窗、代码块等所有区域。
- **PPT 写手导航图标替换**：原 Python 生成的橙色图标 → 用户桌面 f-ppt.png（3106 字节）。

---

# AI Copilot — 版本记录（CHANGELOG）

> 本文件记录每个版本的变更。**以后每次版本修改都在这里追加。**
> 记录规则：最新版本在最上方；每条含「版本号 / 日期 / 变更类型（新增·修复·样式·调整）/ 简要说明」。
> 原名「AI文件自动替换」，自 v0.1.8 起更名为「AI Copilot」。

---

## v0.4.2 — 2026-08-01

**新增（PPT 写手模块）**：左侧功能栏新增「PPT 写手」（导航图标 ppt.png，橙色演示文稿样式）。
- **① 模版文件**：上传 .ppt / .pptx 作排版与内容参照（不会被修改）。
- **② 需编写文件**：上传 .ppt / .pptx（限 PPT 扩展名），可多选。
- **③ 保存方式**：输出到指定目录（不改动原文件）/ 覆盖原文件（直接改写）。
- **④ 文件编写规范**：下拉类型（自定义 / logo / 替换页面 / 公司名 / 排版 / 配色 / 字体 / 页眉页脚）+ 内容，可逐条添加、启用/停用、删除。
- **⑤ 依据模版**：两个开关——「添加模版文件的主要排版和文字」「缺失内容和页面依据模版文件补全」。
- **✦ AI 助手编辑保存**：把模版 + 需编写文件 + 保存方式 + 规范 + 依据模版要求拼成结构化 prompt，跳转到 AI 助手；prompt 要求 AI **先在聊天界面详细询问**本次 PPT 修改的内容、方向、风格、必留/必换的页面与公司名/logo，确认后再依据模版编写并保存（写文件前请求授权）。
- **💾 手动保存**：不经过 AI，按保存方式把需编写文件**字节级原样保存**（输出目录复制 / 覆盖原文件并先备份到 .backup），不改动内容；新增 `ppt-save` IPC 与结果卡片。

## v0.4.1 — 2026-08-01

**修复 + 新增（文件自动化 · 转换增强）**：
- **修复「转换后文件不全 / 空文件夹」**：按模版结构转换时，先把模版文件夹的**全部文件**原样复制到输出目录（兜底占位），再用「需编写文件」覆盖同位置同名文件（内容以需编写文件为准）。这样模版里有而需编写文件缺失的，自动用模版文件补齐，模版有的输出目录全都有、不留空文件夹。同名匹配按「文件名（不含扩展名，忽略大小写）」。
- **结果汇总更详细**：新增显示「模版总文件数 / 模版独有已补齐数」。
- **新增「🤖 AI 协助转换」按钮**（在「⇄ 转换」右侧）：先执行上述本地转换，再调用 `automation-check` 取「模版文件清单 vs 输出目录文件清单」对照（缺失 / 多余），拼成结构化 prompt 交给 AI 智能体核对文件完整性——输出完整性报告（是否完整、缺失如何补齐、多余是否正常、总体结论与建议）。本任务只核对报告，不改动任何文件。
- 新增 IPC：`automation-check`（列出模版与输出目录文件清单并对照，只读不改文件）；main.js 新增 `collectTemplateFiles()` / `listFilesRecursive()`。

## v0.4.0 — 2026-08-01

**新增（智能体技能系统）**：
- **AI 设置新增「智能体技能」管理区**：已安装技能列表（内置/预置/已安装标记，可删除）；在线查找——输入技能类别关键词自动搜索 GitHub 技能仓库，结果带「下载并安装」；本地源码包技能——扫描 Claude Code 源码包（src/skills/bundled/*.ts），列出技能并可「移植安装」为本应用 SKILL.md。技能安装到 `userData/skills/<name>/SKILL.md`，智能体每次对话动态加载。
- **预置三技能**：format-convert（格式转换）、view-image（看图）、terminal-ops（终端命令）。
- **智能体新增三工具**：`convert_file`（textutil 格式转换，需授权）、`view_image`（查看图片——解析尺寸元数据 + 图片作为视觉输入注入对话，支持 png/jpg/gif/webp/bmp，解决"看不了图"短板）、`run_command`（执行终端命令，需授权）。
- agent.js 技能系统改造：内置技能表 + `loadExternalSkills()` 动态合并外部 SKILL.md（frontmatter name/description 解析，无头部回退 # 标题）。

## v0.3.5 — 2026-08-01

**新增**：
- **文件自动化「⇄ 转换」按钮**（在「开始编写（AI）」右侧）：不经过 AI 的本地归类转换——按模版目录结构（或平铺/按类型）把文件**原样归类复制**到输出目录。字节级复制（`fs.cpSync preserveTimestamps`），文件内容/版面/字体 100% 不改动；复刻模版子目录结构（含空目录）；按扩展名归入模版对应子目录，模版中没有的类型放根目录；重名自动加序号；必须输出到指定目录（绝不动原文件）。新增结果卡片展示。

## v0.3.4 — 2026-08-01
**类型：新增 + 改进**
- 新增：**格式转换保持目录结构**——「另存到文件夹」时可选「保持目录结构」（默认开），按源文件夹的子目录层级在输出目录复刻（如源文件夹有 18 个子文件夹及文档，转换后目录结构一致）。renderer 记录 sourceFolder 传 baseDir，main.js `convert-files` 按相对路径建目录。
- 改进：**转 PDF 保留原格式**——由 cupsfilter 纯文本改为 **HTML → Electron `printToPDF`** 渲染：Office 源经 textutil→html 保留标题/加粗/表格/字号，纯文本包 styled HTML；用隐藏 BrowserWindow（复用单个）渲染成 A4 PDF，中文字体正常、格式与原文件基本一致。
- 新增：**「✦ AI 助手转换」按钮**（在开始转换旁）——把转换任务（文件列表 + 源→目标格式 + 输出目录/结构）交给 AI 智能体逐个转换，切到 AI 面板实时展示。
- 版本号 → 0.3.4

## v0.3.3 — 2026-08-01
**类型：样式 + 新增**
- 样式：**左侧功能图标替换为自定义图片**（来自桌面同名 PNG，存 `renderer/assets/navicons/`）：AI助手(机器人)、按规则替换文件(循环箭头)、文件名修改、文件格式转换、PDF去水印(PDF文档)、文件自动化、AI设置(shezhi 齿轮)。
- 新增：**文件格式转换的「源格式」新增 PDF**——PDF 可转成 txt/md/docx/html/rtf 等。实现：`pdf-watermark.js` 新增 `extractFullText()`，并给提取逻辑加了 **CID/ToUnicode 解码**（解析 CMap，把 CID 字体里的中文 hex 串还原成中文），否则中文提取不到；`convertOne` 遇 PDF 源先提取纯文本再按纯文本转换。已实测中文 PDF 提取正确（个别字如「一/文」可能显示为康熙部首形，是 cupsfilter 生成 PDF 的 CMap 特性，非解析错误）。
- 该 CID 解码同样惠及「PDF 去水印」的候选文字识别（中文水印现在也能被分析出来）。
- 版本号 → 0.3.3

## v0.3.2 — 2026-08-01
**类型：修复**
- 修复：**PDF去水印模块在文件选择框里选不了 PDF（变灰）**。根因：文件选择对话框的类型过滤用的是「支持扩展名列表 ALL_EXTS」，其中不含 pdf。修复：`select-files` IPC 支持传入自定义扩展名，PDF去水印模块只允许选 `.pdf`；顺带让「文件格式转换」的选择器只显示它支持转换的格式（doc/docx/rtf/odt/html/txt/md/json/csv）。
- 版本号 → 0.3.2

## v0.3.1 — 2026-08-01
**类型：新增（格式转换支持 PDF 目标）**
- 文件格式转换的「转成为（目标格式）」新增 **PDF（.pdf）**：可把 doc/docx/rtf/odt/html/txt/md/json/csv 转成 PDF。
- 实现：先提取纯文本（Office 经 textutil 转 txt）→ 用 macOS 自带 `cupsfilter` 生成 PDF（自动嵌入中文字体，**中文不乱码**）。输出为**纯文本排版**的 PDF（不含图片/复杂排版）。
- 已实测 docx→PDF 中文正常。PDF 暂不支持作为「源格式」。
- 版本号 → 0.3.1

## v0.3.0 — 2026-08-01
**类型：新增（三个功能模块）+ 调整**
- 调整：**AI 助手移到侧边栏第一位**，并设为默认启动面板。
- 新增「**文件名修改**」：选文件/文件夹 → 添加重命名规则（查找→替换，界面同「替换框架」）→ 选保存方式（原地改名 / 复制到新文件夹）→ 批量改文件名。main.js `rename-files` IPC，自动处理非法字符与重名冲突。
- 新增「**文件格式转换**」：选文件/文件夹 → 选源格式与目标格式（doc/docx/rtf/odt/html/txt/md/json/csv）→ 覆盖/另存 → 批量转换。引擎：macOS 自带 `textutil`（Office/文本，离线）+ 纯 JS 的 json↔csv 互转；PDF 互转暂不支持（界面已注明）。
- 新增「**PDF 去水印**」：选 PDF/文件夹 → 分析水印（提取候选文字，可 ✦AI 分析预勾选+给意见）→ 勾选要删除的水印 → 去除并保存到目录。纯 JS 解析 PDF 内容流去除文字类水印（新增 `pdf-watermark.js`：解析间接对象/解码 FlateDecode/删文本操作/重建 xref）。支持未加密、内容流为 Flate/未压缩的 PDF；图片水印、加密 PDF、对象流复杂 PDF 会明确提示不支持。
- 版本号 → 0.3.0

## v0.2.1 — 2026-08-01
**类型：样式（应用 Logo）**
- 新增应用 Logo（来自桌面 `OIG05.jpg`，346×346 方形）：
  - **侧边栏标题**：原 ⇄ 图标替换为 Logo 图（`renderer/assets/logo.jpg`），圆角小方块展示
  - **应用图标**：用 sips + iconutil 生成多尺寸 `icon.icns`（16~1024），替换 `Contents/Resources/icon.icns`，Finder/程序坞/Dock 均显示该 Logo
- 版本号 → 0.2.1
- **发行**：自本版起改用 **.dmg 安装包** 分发（替代 .zip）。DMG 窗口做品牌化：背景图（Logo + 浅色现代风 + 拖到 Applications 引导箭头，直接写 `.DS_Store` 设置背景与图标位置）、自定义卷标图标；包内附 **使用说明.html**（自包含，含大概功能、快速上手、搭建基础、隐私安全）。

## v0.2.0 — 2026-08-01
**类型：样式（自定义图标）**
- AI 助手输入区图标替换为自定义图片（来自桌面，复制到 `renderer/assets/`）：
  - 发送按钮（空闲态）：`箭头.png` → `assets/icon-send.png`（替换原 ↑ 字符）
  - 发送按钮（AI 运行中/等待态）：`运行.png` → `assets/icon-running.png`，并加脉冲光圈动画表示「正在运行」
  - 语音按钮：`麦克风.png` → `assets/icon-mic.png`（替换原 🎙️ emoji）
- 发送按钮样式调整：改为图片按钮（透明底，图片即圆形按钮），新增 `setSending()` 统一切换「发送 / 运行中」两态图标与提示
- 版本号 → 0.2.0

## v0.1.9 — 2026-08-01
**类型：新增（功能模块）+ 修复**
- 新增左侧栏「文件自动化」模块（位于「按规则替换文件」与「AI 助手」之间），按模版 + 规范让 AI 自动编写/整理文件：
  - ① 模版文件：可选模版文件或模版文件夹（仅作参照，不修改）
  - ② 需编写文件：可选文件或文件夹（文件夹自动扫描全部文件）
  - ③ 设置规范：文件夹摆放格式（按模版结构/平铺/按类型归类）+ 文件归类开关（自动按模版归类）+ 保留原内容开关
  - ④ 文件编写规范：逐条添加规则（类型：时间/部门/人名/文件名/排版/自定义 + 内容），可启用/停用/删除；**可保存为命名预设并随时调用/删除**（持久化到 userData/automation-presets.json）
  - ⑤ 保存方式：输出到指定目录 / 覆盖原文件 + 输出目录选择
  - 开始编写：构建结构化 prompt 交给 AI 智能体（复用 aiChat），切到 AI 面板实时展示执行过程；写/改/批量替换仍走授权闸门
  - main.js 新增 `automation-get-presets` / `automation-save-presets` IPC；preload.js 暴露 `automationGetPresets` / `automationSavePresets`
- 修复：**AI 智能体对话偶发 `HTTP 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`**。
  - 根因：上下文压缩（累计输入 token 超阈值时触发）用 `messages.slice(-6)` 硬切历史，切点落在「assistant 的 tool_calls」与「tool 结果」之间，导致压缩后的历史以孤儿 tool 消息开头。
  - 修复：新增 `sanitizeMessages()`，每次调用 API 前清洗历史——丢弃无匹配 tool_calls 的孤儿 tool 消息、对「有 tool_calls 却无结果」的 assistant 消息去掉 tool_calls；Anthropic 的孤儿 tool_result 块同样剔除。已附 7 项单元测试全部通过。
- 版本号 → 0.1.9

## v0.1.8 — 2026-08-01
**类型：调整（应用改名）**
- 应用更名：**AI文件自动替换 → AI Copilot**
  - 显示名/窗口标题/侧边栏：AI文件自动替换 → AI Copilot
  - .app 文件夹、可执行文件、Info.plist（CFBundleDisplayName/CFBundleName/CFBundleExecutable）同步更名
  - package.json：name→ai-copilot、productName/dmg.title→AI Copilot
  - 保留 Bundle ID `com.app.aifilereplacer`（不改，避免 macOS 把它当新应用、丢失麦克风/语音识别等已授权权限）
- 新增：改名配置迁移（main.js `migrateLegacyUserData`）——启动时若新 userData（AI Copilot）无配置而旧目录（AI文件自动替换）有，则复制 ai-config.json 过来，**已保存的模型/Key 不丢失**
- package.json build.files 补充 ai-config/agent/filetypes/office-replace/CHANGELOG.md，保证后续自行打包不丢文件
- 版本号 → 0.1.8

## v0.1.7 — 2026-08-01
**类型：新增 + 修复**
- 新增：AI 助手输入区重做为现代 composer（对齐 Codex 风格截图）
  - 权限设置下拉：默认权限·每次询问 / 信任此会话·自动放行 / 只读模式·全部拒绝（main.js 新增 `permissionMode` + IPC `set-permission-mode`，onConfirm 顶部先判模式）
  - 模型信息展示：显示当前激活模型名，未配置时变橙、可点击跳「AI 设置」
  - ＋引用文件、🎙️语音输入（Web Speech API，中文 zh-CN）、↑圆形发送按钮
  - ＋/🎙️/↑/权限触发 全部加自定义提示气泡（.has-tip tooltip）+ 原生 title
  - 输入框改单行自动增高（autoGrow，最多 160px）
  - Info.plist 增加 NSSpeechRecognitionUsageDescription（语音识别权限描述）
- 修复：聊天窗无法输入 —— autoGrow 在 AI 面板 `display:none`（默认显示「按规则替换」面板）时执行，`scrollHeight=0` 导致文本框被写成 0px。改为隐藏时不写高度 + 切换面板时重测 + CSS 加 `min-height:40px`
- 版本号 → 0.1.7（package.json / Info.plist / 侧边栏页脚 / style.css 注释）

## v0.1.6 — 2026-08-01
**类型：新增**
- 新增：AI 助手授权功能
  - 新增两个需授权的系统动作：`open_file`（系统默认应用打开文件/文件夹）、`open_url`（默认浏览器打开网页，仅允许 http/https）
  - main 进程 `execFile('open', [...])` 不经 shell，防命令注入
  - 原「确认条」升级为正式授权面板：按类型显示图标（✍️写入/✏️修改/🔁批量替换/📂打开文件/🌐打开网页）+ 标题 + 操作详情 + 「本次会话对该类操作不再询问」勾选
  - main.js 授权链路 + `sessionApproved` 会话信任集合；agent.js 三处 confirm 改为带 type 的对象
- 版本号 → 0.1.6

## v0.1.5 — 2026-08-01
**类型：样式**
- UI 风格全面改造为浅色现代风格（对齐 Codex/OpenAI 设计语言）
  - style.css 整体重写：白色侧边栏、柔和灰调(#f8f9fa)、大圆角(12–20px)、轻阴影、按钮/卡片/输入框/模态框现代化、自定义滚动条、过渡动画（fadeIn/slideUp/slideDown/modalSlideIn）
  - index.html 微调：侧边栏结构、按钮加 emoji、版本号页脚
- 版本号 → 0.1.5

## v0.1.4 — （改造基线版，已完整阅读）
**类型：调整**
- 相比 0.1.3：ai-config 增强（+903B，模型拉取/厂商兼容完善，含 /v1 自动补足、DeepSeek 特例）
- 本版为后续 UI/功能改造的基线，三大模块已完整：按规则替换（三步向导）+ AI 助手（智能体）+ AI 设置

## v0.1.3
**类型：新增**
- 智能体大幅升级（agent.js +10.7KB：子代理 / 技能包 / TodoWrite / 上下文自动压缩 / 权限闸门等）+ 界面扩充

## v0.1.2
**类型：调整**
- renderer/app.js 小幅调整（+1.2KB）

## v0.1.0
**类型：初始版本**
- 按规则批量替换文件内容 + 内嵌 AI 智能体对话式处理文件 + AI 设置（多厂商模型配置）

---

## 技术栈速览
- **形态**：macOS 桌面应用，Electron（arm64 dmg，electron-builder 构建，脚本也支持 x64）
- **主进程**：`main.js` —— 文件扫描、文本替换、批量替换 IPC、AI 配置/对话 IPC、权限模式与授权闸门
- **预加载**：`preload.js` —— contextBridge 暴露 `window.api.*`（上下文隔离开、nodeIntegration 关）
- **渲染层**：`renderer/`（index.html + app.js + style.css）—— 三模块导航 + 向导 + 对话 + 斜杠命令（/clear /rules /files /help）
- **AI**：`ai-config.js`（配置持久化 userData/ai-config.json + 模型拉取）、`agent.js`（智能体：agent loop + 工具注册表 + 子代理 + 技能包 + TodoWrite + 上下文压缩 + 权限闸门，双协议 Anthropic/OpenAI）
- **替换引擎**：`filetypes.js`（类型表）、`office-replace.js`（纯 Node zlib 解包 Office zip → 替换内部 XML → STORE 不压缩重打包）
- **AppID**：com.app.aifilereplacer

## 各版本源码规模对照（字节）
| 文件 | 0.1.0 | 0.1.2 | 0.1.3 | 0.1.4 | 0.1.5 | 0.1.6 | 0.1.7 |
|---|---|---|---|---|---|---|---|
| main.js | 9748 | 9748 | 9938 | 9938 | 9938 | 10645 | 11173 |
| agent.js | 17800 | 17800 | 28517 | 28598 | 28598 | 31257 | 31257 |
| preload.js | 1808 | 1808 | 2130 | 2130 | 2130 | 2156 | 2236 |
| ai-config.js | 4152 | 4152 | 4152 | 5055 | 5055 | 5055 | 5055 |
| filetypes.js | 1283 | 1283 | 1283 | 1283 | 1283 | 1283 | 1283 |
| office-replace.js | 5902 | 5902 | 5902 | 5902 | 5902 | 5902 | 5902 |
| renderer/index.html | 12614 | 12614 | 12827 | 12827 | 13018 | 13673 | 16060 |
| renderer/app.js | 28773 | 30015 | 33176 | 33176 | 33176 | 33872 | 38224 |
| renderer/style.css | 14076 | 14076 | 14972 | 14972 | 23016 | 23849 | 29186 |
