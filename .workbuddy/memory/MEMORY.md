# kk-home（wenwen blog）项目约定

## 定位
用户自己的中文写作博客。原为一个单页静态 `kkhome.html`，2026-09-17 改造为「SSR + 文件存储 + 浏览器可编辑」的自托管站点。原 `kkhome.html` 保留在仓库根目录作为设计参考，不再被服务读取。

## 技术约定
- **零依赖**：只用 Node 内置模块，不允许引入 npm 依赖。服务器上 `node server.js` 直接可跑。
- **SSR 优先**：所有公开页面在服务端渲染成完整 HTML。内容必须出现在 HTML 源码里 —— 这是为了搜索引擎与 AI 检索可达，不要改成前端 fetch 渲染。
- **数据即文件**：文章是 `data/articles/<slug>.md`（frontmatter + Markdown），站点设置是 `data/site.json`，笔记/照片是 `data/notes.json` / `data/photos.json`。可直接在编辑器里手改，也可走后台。
- **写入必须原子**：tmp 文件 + rename，不直接覆盖。
- **不引入富文本编辑器**：正文是 Markdown，后台提供工具栏与实时预览，HTML 直通是刻意关闭的（先转义再拼标签）。

## 设计约定
- 视觉风格来自原 kkhome.html，**不要重做**：纸感底色 `#f7f3eb`、墨色 `#171411`、衬线正文（Georgia 系）、小字号大写字距的 Helvetica eyebrow、1px 细规则线、圆角 8px 的卡片。
- 新增页面沿用既有 class 命名（`home-hero` / `section-header` / `article-row` / `prose` / `kicker`），样式集中在 `public/assets/site.css`。
- 中文以外的地方一律用英文小写标签（Essay / Cover Story / Read article），保持刊物感。

## 内容约定
- **不替用户编正文**。迁移时只搬原文件里真实存在的内容；缺的部分留空或建草稿，明确告知。
- 不编造日期。缺失就留空，渲染层负责不显示。
- 文章 slug 用小写字母+数字+连字符；中文标题自动退化成 `note-<yyyymmdd>`。

## 实验区（/lab）
2026-09-17 把一堆独立的小 Demo 并进站点，作为「实验区」。与写作区分离，但共用同一个进程和域名。

- **入口**：`/lab` 是 SSR 渲染的索引页（用站点自己的版式），入口只挂在**页脚**，不占主导航 —— 目的是不搅乱刊物的导航结构。目录清单的唯一真相是 `lib/lab.js` 的 `ITEMS` 数组，索引页、冒烟测试、体检脚本都从它读，加页面只改一处。
- **路由**：`public/lab/<name>.html` 对应 `/lab/<name>`；`public/lab/2048/` 是唯一带子目录的（游戏本体 + js/style/meta），对应 `/lab/2048`。带 `.html` 的地址一律 301 到无扩展名版本，避免同一页有两个地址。静态服务走 `resolveWithin()` 做路径穿越防护（比前缀 startsWith 更严）。
- **视觉**：各 Demo **保持原样**，只补一个统一的返回入口（`public/lab/_lab.css` 里的 `.lab-back` / `.lab-back-inline`）。不做视觉统一是刻意的 —— 游戏和玻璃质感有它自己的语言。
- **数据**：留言 `data/lab/messages.json`、体重 `data/lab/weights.json`、上传文件 `data/uploads/`（通过 `/uploads/<name>` 访问）。上传的照片**与博客 /photos 共用同一份 `data/photos.json`**。
- **权限模型**（重要，别简化）：留言板**公开可读可写**（所以有限流：同 IP 每分钟 3 条、单条 ≤200 字、总量 ≤500）；相册公开可读、写需登录；体重**全程需登录**。删除一律需登录。
- **上传**：原始二进制 POST + 文件名放 `X-Photo-Name` 头，不走 multipart。白名单只收 PNG/JPEG/GIF/WebP/AVIF —— **刻意不收 SVG**（能内嵌脚本，当图片直接打开就是任意脚本执行点）。
- **零 CDN**：原本依赖 Supabase（留言/相册/体重）与 Chart.js、marked 的页面全部改成本地实现。体重折线图是手写 SVG，不引图表库。

## 验证约定
- 任何改动后跑 `node tools/smoke-test.js <port>`，要求 **145 项全绿**。
- 冒烟测试会真实起子进程、真实打 HTTP、真实读写 `data/`，并自动清理测试产物。它还会反过来调用 `tools/doctor.js` 验证体检工具本身。
- **测试必须对「用户已有数据」无感**：条数断言一律写成相对量（跑之前已有多少条），不要写死 `length === 1`。跑完必须还原 `data/lab/*.json` 与 `data/photos.json`，上传目录按运行前后差集清理。跑前会先扫掉自家 `smoke-test-*` 残留 —— 否则一次被中断的运行会让后续每次测试都失败，看起来像新改坏的。
- **测「清空全部」这类破坏性接口前，先把原文件落一份到 `.smoke-backup`**：中途被打断时用户的数据还能捞回来。
- 注意：本机沙箱下**跨 Bash 调用**访问别处启动的 localhost 端口会被拦（同一调用内自连正常）；`nohup ... &` 起的进程在调用结束时被回收。所以「起服务 + 打请求」必须写在同一次 Bash 调用里。
- 跨 Bash 调用传 glob 给 `rm` 会因为 zsh 无匹配报错 → 用 `find ... -delete` 或先 `setopt nonomatch`。
- **测试残留会自我固化**：备份/差集基线都是在「跑前状态」上取的，所以只要有一轮把测试数据漏在 `data/` 里，之后每一轮都会把它当用户数据原样还原保下来，残留只增不减。因此测试的清扫必须是**幂等的、认内容的**（`sweepLabArtifacts()`：留言按固定正文前缀、上传按「名字格式 + 逐字节等于夹具 + 未被 photos.json 引用」三条同时满足），并且在**跑前和跑后各扫一遍**。改任何涉及 `data/` 的测试时都要守住这条。
- **不要把冒烟测试的输出接 `head`/`tail` 管道**：`head` 提前关管道 → node 收到 SIGPIPE 崩溃 → `finally` 不执行 → 子进程服务遗留在测试端口上，下一次跑就 `ECONNREFUSED`。重定向到文件再读。

## 运维工具（出问题先跑它们，不要靠猜）
- `node tools/doctor.js [端口|--url]` —— 服务器本地一键体检：Node 版本、文件齐全、data 可写、密码来源、服务身份、锁定状态，并用自己找到的凭据真登一次。exit 0 = 没查出问题。
- `node tools/set-password.js 新密码 | --random | --from-file f` —— 重设后台密码，热生效不用重启。
- `GET /api/health` —— 免登录健康检查，含 `passwordSource`、`dataWritable`、`lockedOut`，不含密码本身。
- 登录排查顺序：health 看 passwordSource → 若是 `env` 则改文件无效（去 systemd 的 Environment= 找）→ 429 就是被锁（重启即解锁）→ 500 查 data/ 权限。
- 密码存 `data/.admin-password`（环境变量 `ADMIN_PASSWORD` 优先）。会话密钥 `data/.session-secret`，丢了只是掉登录态。

