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

## 验证约定
- 任何改动后跑 `node tools/smoke-test.js <port>`，要求 **61 项全绿**。
- 冒烟测试会真实起子进程、真实打 HTTP、真实读写 `data/`，并自动清理测试产物。
- 注意：本机沙箱下**跨 Bash 调用**访问别处启动的 localhost 端口会被拦（同一调用内自连正常），所以临时验证要在同一个命令里起服务再打请求。
