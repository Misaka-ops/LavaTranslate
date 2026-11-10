# LavaTranslate 开发文档

> 面向用户的说明见仓库首页的 [README](../README.md) / [中文 README](../README.zh-CN.md)。

> **本分支说明**：这是一个只保留 DeepSeek、只支持 Windows 的精简分支。服务商目录只剩 DeepSeek，桌面设置合并为「翻译 / 通用 / 关于」3 页；ChatGPT 登录、Key 自动识别、本机凭据导入、模型价格列表、离线翻译意向投票，以及安卓和 macOS 端代码都已删除。

按下快捷键，框选屏幕上任意区域：本地 OCR 找出每一行文字的位置，大模型看着截图纠错、合并段落并翻译，译文按**原来的位置、字号、颜色、粗细、对齐方式**直接覆盖在原文上。

看懂对方的消息后，可以直接用自己的语言写回复：**回复助手**会参照屏幕上的对话语气实时译成对方的语言，并附上回译让你确认意思，`Enter` 复制即可去发送。

## 使用

| 操作 | 说明 |
| --- | --- |
| `Win + Space`（可改） | 进入截图模式 |
| 拖动 / 单击 | 框选区域 / 选中鼠标下的窗口 |
| 拖动选区、拖动手柄 | 移动、调整选区，松开后自动重新翻译 |
| `Space`（按住） | 遮罩透明、鼠标穿透，可以操作下面的软件；松开后重新截图，选区里画面变了就重译同一块。由独立键盘线程跟踪空格，按住期间拦截重复事件；主进程与界面必须持续续期，异常时自动放行。 |
| `Alt`（按住，有选区） | 显示原文、暂停翻译：请求照常进行，渲染进程把翻译事件攒着，松开后按顺序补上 |
| `Tab` | 切换「原位覆盖 / 并排对照」 |
| 单击某段译文 | 复制这一段 |
| `Ctrl C` / `Alt C` | 复制全部译文 / 原文 |
| `Ctrl Shift C` / `Ctrl S` | 复制 / 保存翻译后的截图 |
| `F3` | 钉在桌面（可拖动、滚轮缩放；双击收起为 56×56 DIP 缩略方块，再次双击恢复收起前的尺寸；右键 / Esc 关闭）。收起后仍可拖动，展开时靠近屏幕边缘会移回可见区域。主进程把钉图从选区飞到这块屏幕工作区的左上角，按「没被拖走的钉图占着的位置」依次往右下错开 32px；飞行中置顶，落位后 `setAlwaysOnTop(false)` 停在普通窗口的最上面（钉图工具条可改成始终置顶） |
| `Alt F3`（或按着 Alt / 开着看原文时点钉图按钮） | 钉原图：`PinPayload.original`，不带译文层，复制按钮复制识别出的原文 |
| 双击选区 / 并排面板 | 按当前看到的样子复制成图片并退出（还没有译文、正在看原文时复制原图） |
| `Alt` + 双击 | 复制原图并退出（直接从截图数据裁，物理像素） |
| `Enter` | 复制译文并退出 |
| `R` | 打开 / 聚焦回复框 |
| 右键 / `Esc` | 退出 |

Windows 的 `Win + Space` 由独立线程上的低级键盘钩子处理（`win-space.ts` / `win-space-worker.ts`），因为系统保留键不能用 `globalShortcut.register` 注册。仅拦截该组合，长按不重复触发；录制时转交设置页，改用其他快捷键或退出后恢复系统输入语言切换。旧默认 `Alt + Q` 在加载配置时迁移，其他自定义快捷键保留。

1.4.8 起，普通自定义快捷键后台不安装低级键盘钩子；独立线程通过 Win32 定时器检查主进程与截图界面的 1.5 秒租期，截图启动阶段最多 3 秒。界面每 250ms 续期；多屏必须都正常响应。主进程阻塞也不妨碍释放输入。关闭截图、打开设置、渲染失败、锁屏、休眠会清理状态；Win + 空格用未分配的 VK_E8 屏蔽开始菜单，不再模拟 Ctrl。OCR 改为按需初始化。

`npm run build` 后可在 Windows 运行 `npm run check:win-hotkey`：使用独立数据目录和无窗口进程，短暂模拟 Win + 空格，验证长按、连按、录制、释放按键、不误开开始菜单与退出清理。

工具条上可以切换目标语言（会记住）、显示方式、回复、重新翻译、打开设置。

语言按钮只显示目标语言；紧随其后的勾选框悬停提示「自动翻译」，与设置页的「识别后自动翻译」共用并保存同一设置。切换后当前选区立即重新处理（复用已识别文字）；关闭时只识别，仍可手动点击翻译。设置页和各屏工具条会同步勾选状态。

主要操作按「翻译 → 对话 → 对照」排列。对照是独立切换按钮，开启高亮，再点恢复原位覆盖；按住 Alt 看原文。关闭按钮左侧的问号悬停显示快捷操作列表，屏幕空间不足时可移入列表滚动查看。

`npm run build` 后运行 `npm run check:pin`，用隐藏 Electron 窗口和模拟翻译验证 Alt 钉原图、双击收起/还原、缩放尺寸保留、边缘展开和右键关闭；无需翻译服务。截图输出到 `.scratch/pin-check/`。

### 回复助手

- 模型判断截图是聊天、私信、评论或邮件时，翻译完成后自动在工具条旁弹出回复框（设置 → 翻译 里可关闭；任何时候按 `R` 都能打开）；
- 用自己的语言输入，停顿片刻就开始流式翻译；语气可选「跟随语境 / 正式 / 随意」；
- 目标语言菜单：「自动」+ 全部语言（包括自己的语言）。「自己的语言」取界面语言（`i18n.lang`，默认跟随系统），**不取截图翻译的目标语言**——那个可能被临时改成外语。
  回复的「自动」= 截图识别出的对方语言，对方就是自己的语言时用常用外语（上次译成的外语，没有就英语）；手动选的语言这张截图内有效（`pick` ref，换截图回到自动）。
  输入翻译（连按两次快捷键）的「自动」= 自己的语言 ⇄ 常用外语互译（`ReplyStartMsg.both`，方向交给模型判断）；手动选的语言存在 `localStorage['lens.quick.to']`，一直有效；
- 译文下方附**回译**（再翻回你的语言），不懂对方语言也能确认意思没走样；
- `Enter` 复制并关闭（还没翻完会等翻完再复制）、`Ctrl Enter` 只复制、`Shift Enter` 换行、单击译文复制；`↑ / ↓` 翻看发过的回复；
- 输入框为空时，`Space` / `Enter` / `Tab` 等截图快捷键照常可用；有内容时 `Esc` 先收起回复框（保留草稿），空白时直接退出。

## 翻译服务

服务商目录在 `src/shared/providers.ts`，现在只有 DeepSeek：官方接口 `https://api.deepseek.com`、获取 Key 的网页、三档模型
（`deepseek-flash` / `deepseek-chat` / `deepseek-reasoner`），以及在 Chat Completions 里关掉「思考」的 `thinking: {type: "disabled"}`。
设置只保存 `providers.deepseek = { key, model }`，Key 用 safeStorage 加密（密文绑定数据目录的 Local State，不能跨目录复制）；
旧版多服务商、ChatGPT 登录、离线投票字段在 `settings.load()` 的迁移里丢弃，只保留原来的 DeepSeek Key。

- 全部走 `openai` SDK 的 Chat Completions；模型不能看图时只发 OCR 文本；Key 无效（401）统一提示「API Key 无效」，余额不足（402）提示充值。
- 模型固定三档，设置页不再请求模型列表，也不显示价格。
- **思考对排版的影响**：同一批真实网页开 / 关思考对比，分块、语言、是否对话一致；关思考后模型常把照抄的原文漏标 keep，现由 `BlockParser` 在译文与原文相同时自动保留原图。

## Windows 运行库与启动诊断

- `electron-builder` 的 `afterPack` 钩子（`scripts/windows-runtime.cjs`）把 VC++ x64 DLL 放到 `LavaTranslate.exe` 及 ONNX Runtime 原生模块目录。Node 加载 `.node` 时使用不同的 DLL 搜索路径，仅放在 EXE 旁不够。NSIS 安装、解包版和应用内更新都包含这些文件；用户不需要另行安装运行库，也不增加管理员权限要求。
- 微软官方下载地址、版本和 EXE / DLL 的 SHA-256 固定在 `build/windows-runtime.json`。首次 Windows 打包自动下载并提取，既不运行运行库安装程序，也不读取本机 System32 的 DLL。缺失、损坏或架构不匹配会阻止打包。
- 可提前运行 `npm run runtime:win`。离线机器可设置 `LAVA_VC_REDIST_EXE` 指向同一版本的微软安装包，再运行该命令；校验值必须一致。缓存位于 `build/windows-runtime/`，不提交 Git。升级原生依赖时应同时检查并更新运行库版本、校验值和回归验证；应用自带运行库通过新版应用更新。
- `bootstrap.ts` 在加载原生模块之前注册日志，并捕获同步导入失败和异步启动失败。失败时弹窗显示原因和日志路径，再以非零状态退出。日志默认写到 `%APPDATA%\LavaTranslate\error.log`；目录不可写时回退到 `%TEMP%\LavaTranslate-error.log`。Windows 的页面加载、预加载和渲染进程错误也会记录。
- `npm run check:win-compat` 验证缺 DLL、异步启动失败、日志回退和打包校验；`npm run check:platform` 验证 OCR、坐标和键盘输入的 Windows 回归。仍需在干净的 Windows 10 x64 机器上做安装、首次启动和截图 OCR 验证；开发机加载成功不能代替该验证。
- 打包后运行 `npm run check:win-package -- dist/win-unpacked`：用产物自己的 Electron 加载三个原生模块，检查实际加载的 VC++ DLL 路径，并运行检测、识别模型的 CPU 推理。此检查可发现“开发机有运行库所以误以为安装包完整”的情况。
- 数字签名独立配置；捆绑运行库不能消除 SmartScreen 的未知发布者提示。

微软参考：[本地部署运行库](https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp)、[可再发行文件说明](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files)。

## 自动更新

Windows 安装版通过 GitHub Releases 检查更新，electron-updater 自动下载 NSIS 安装包并在退出时安装；设置中的「自动更新」可以关闭 20 秒启动检查和每 4 小时轮询。

安装版每 4 小时检查一次 GitHub Releases（`Misaka-ops/LavaTranslate`），在后台按块差量下载，下载完成后托盘与设置里出现「重启并更新」，不点也会在下次退出时安装。
发布新版本：`npm run release -- patch|minor|major|current`（需要 `gh auth login`），会升版本号、打包，并用 `gh release create` 上传安装包、blockmap 和 `latest.yml`，发布说明取 `docs/releases/v<版本>.md`。图标：`python scripts/make-icons.py` 一次生成 Windows 桌面（exe、托盘、设置页）的全部图标，图形定义在 `scripts/icons/lava.py`（黑底上一滴朱红到琥珀的发光熔岩，≤32px 用去掉文字的简化版），用 Electron 渲染 SVG。

改名说明：旧名「Lens 截图翻译」的配置会在首次启动时从 `%APPDATA%\Lens 截图翻译` 迁移到 `%APPDATA%\LavaTranslate`。

## 实现

```
快捷键 ──► 截屏 (node-screenshots, DXGI, ~80ms 双屏)
         └► 每个显示器一个预创建的遮罩窗口，透明度 0 → 画好帧 → 1（~150ms 可见）
框选 ──► PP-OCRv6 检测 + 识别（onnxruntime + DirectML GPU，~100–200ms）
         └► 模型（截图 + 每行坐标与 OCR 文字）流式返回 JSON：纠错、分段、语言识别、是否对话、翻译
              └► 每收到一块立刻渲染（见下）
```

**排版还原**（`src/renderer/src/lib/colors.ts`、`fit.ts`、`layout.ts`、`components/TranslationLayer.tsx`）

- 每行原文是一个"槽位"，多行译文按顺序流入这些槽位：绕图排列的段落、首行缩进、居中段落都保持原形状；
- OCR 记录每个字符的横坐标（CTC 时间步），补丁只盖住文字本身——被认成字符的图标（▲ ☆ &lt;&gt;）、没被识别的图标、列表序号都保留可见；
- 字号由笔画实际高度 + 文本里有无上伸/下伸字母推算（比 OCR 框高可靠得多）；
- 文字色逐通道取极值分位数，抵消 ClearType 次像素彩边；行内夹彩色链接时分段取色、以正文为准；
- 粗细用"每个笔画像素横纵连续段较短者"的中位数，方块字横笔不会被误判为粗体；
- 扫描两侧空白：译文更长时先占用空白再缩小字号；两侧空白相等判为居中、右侧贴边判为右对齐；
- 所有补丁画在下层、所有文字画在上层，相邻行的补丁不会遮住文字。
- 整条行高内的所有 OCR 框（包括保留原文、尚未翻译的小字）都参与避让，防止大标题的空白探针漏过旁边的小字；已排好的译文也会占位。
- 字号缩小后的换行限制在原栏和可用高度内，背景补丁裁去邻居范围。取消无限向下换行、无限横向展开以及覆盖图标的兜底。
- 最小字号仍放不下时显示省略号；完整译文保持不变，桌面悬停省略的块可查看，单击复制、并排对照和全部复制仍使用完整译文。极窄且连省略号也放不下的区域保留原图。

`npm run check:layout` 使用隐藏 Electron 窗口、实际 Canvas 字体测量和共享 React 组件运行回归，无需翻译服务或 API Key。
覆盖大标题与小字并排、两列、密集段落、居中/右对齐、OCR 框交叠、长网址、图标和竖排，测试 1 / 1.25 / 1.5 / 2 / 3 倍坐标缩放；
检查译文/补丁不覆盖邻居、译文不越出截图、流式到达不挪动已有块、窄行不会硬塞超宽字符。
目视复查图输出到 `.scratch/layout-check/regression.png`。测试数据随 `scripts/layout.test.tsx` 提交，Windows 使用这一套排版逻辑。

排版回归测试（测试素材在本地 `.scratch/`，未纳入仓库）：`.scratch/pages` 里是真实网页截图，`.scratch/fixtures/*.jsonl` 是按提示词写的模型输出，
`LENS_REVIEW=1 LENS_AUTOTEST_ROOT=. npx electron .` 回放并截图，`python .scratch/compare.py` 生成原图/译图对照。

- **OCR**：PaddleOCR PP-OCRv6 small（50 种语言）。识别模型的输出在图里追加了 `ArgMax`（`scripts/patch-rec.py`），GPU 直接给出逐帧最佳字符，避免回传 N×T×18710 的概率矩阵。OCR 认不出的文字（如韩文）保留位置，由能看图的模型补全。
- **网络**：模型请求都走 Electron `net.fetch`（系统代理、HTTP/2），截图界面一打开就预连接当前服务的地址。
- 界面：Electron + React + Motion；Windows 11 Mica 设置窗口，跟随系统深浅色。

## 开发

打包配置中的 `win.files` 必须保留正向条目 `package.json`。electron-builder 会将根级 `files` 规范化为独立 FileSet；
平台级如果只有排除项，会额外建立一个默认包含 `**/*` 的匹配器，把 `.scratch`、源码和旧安装包也带入应用。
`npm run check:platform` 使用规范化后的实际匹配器检查这条边界；打包后仍应核对 `app.asar` 的文件范围。
```bash
npm install
npm run models   # 下载 OCR 模型（需要 python + onnx 才能打 ArgMax 补丁，否则用原始模型）
npm run dev      # 开发模式
npm run dist     # 打包 NSIS 安装程序到 dist/
```

自测（离屏渲染，不打扰屏幕，使用独立的数据目录）：`LENS_AUTOTEST=1 LENS_MOCK=1 npx electron .`，截图输出到 `.scratch/shots/`；
包括聊天截图 + 回复框、按住空格回来后保留 / 重译选区和设置的三页。
`LENS_AUTOTEST=keys LENS_MOCK=1 npx electron .` 只测框选后按住 Alt（看原文、暂停后补上译文）和双击 / Alt+双击复制图片，
剪贴板里的图存成 `.scratch/shots/keys-*.png`。离屏渲染按 1 倍缩放截图，所以「复制译文图片」比原图小，真窗口是物理像素。

按住空格穿透（真窗口，屏幕会闪几秒）：`LENS_PASSTEST=1 npx electron .`——模拟按下空格、另开一个窗口抢焦点、松开空格，
逐步打印遮罩的透明度、是否穿透、焦点是否抢回、空格有没有临时注册 / 释放。

真实引擎（独立数据目录，Key 不写盘）：
- `LENS_ENGINE_TEST=1 LENS_PROVIDER_KEY=<DeepSeek Key> LENS_OPENAI_MODEL=deepseek-flash npx electron .`
- 可加 `LENS_ENGINE_IMAGE=chat.png`（换测试图）、`LENS_REPLY_TEST="要回复的话"`（同时测回复助手，`LENS_REPLY_TO=<语言>` 改目标、`LENS_REPLY_BOTH=1` 测输入翻译的自动互译）。
- 旧格式设置迁移：`LENS_AUTOTEST=1 LENS_MOCK=1 LENS_AUTOTEST_SEED=<旧 settings.json> npx electron .`

## 说明

- 软件不内置任何 Key，用户填自己的。
- 只有框选的区域（以及你写的回复）会发送给你配置的 DeepSeek；OCR 在本地完成，不保存任何会话记录。
