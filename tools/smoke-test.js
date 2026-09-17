'use strict';

// 端到端冒烟测试：起一个真实的 server 子进程，逐条打真实 HTTP 请求。
// 用法：node tools/smoke-test.js [port]

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 3210);
const BASE = 'http://127.0.0.1:' + PORT;
const TEST_SLUG = 'smoke-test-tmp';

const auth = require('../lib/auth');
const store = require('../lib/store');
const lab = require('../lib/lab');

let cookie = '';
let uploadsBefore = new Set();

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function firstLine(text, needle) {
  const hit = String(text).split('\n').find((l) => l.includes(needle));
  return hit ? hit.trim() : '（没找到含「' + needle + '」的行）';
}

// 用 options 对象而不是拼 URL：拼成字符串的话 WHATWG 解析器会先把 ..
// 段规整掉，路径穿越就永远测不到了，测试会在「其实什么都没发生」的情况下变绿。
function httpOptions(pathname, extra) {
  return Object.assign({ host: '127.0.0.1', port: PORT, path: pathname }, extra || {});
}

function request(method, pathname, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      httpOptions(pathname, {
        method,
        headers: Object.assign(
          {
            Accept: '*/*',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          extraHeaders || {}
        ),
        timeout: 8000,
      }),
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          resolve({ status: res.statusCode, headers: res.headers, raw });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (ok || !detail ? '' : '  ← ' + detail));
}

// 上传走原始二进制，不能走那个会 JSON.stringify 的 request
function requestRaw(method, pathname, buffer, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      httpOptions(pathname, {
        method,
        headers: Object.assign(
          { 'Content-Length': buffer.length, ...(cookie ? { Cookie: cookie } : {}) },
          headers || {}
        ),
        timeout: 8000,
      }),
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0];
          resolve({ status: res.statusCode, headers: res.headers, raw });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// 1×1 的真 PNG，用来验证上传链路
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

async function json(method, pathname, body) {
  const res = await request(method, pathname, body);
  let data = null;
  try { data = JSON.parse(res.raw); } catch (e) { data = null; }
  return { status: res.status, data, raw: res.raw, headers: res.headers };
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/robots.txt');
      if (res.status === 200) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// kill 只是「发出信号」，不代表进程已经没了。
// 后面要往 data/ 里写回用户的数据，而那个目录正是子进程在管的 ——
// 必须先确认它真的退出了，否则可能是它后落盘，把还原覆盖掉。
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve('已退出');
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      resolve('超时，已强杀');
    }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve('已退出'); });
  });
}

// 上一次运行如果被中断，会在 data/ 里留下 smoke-test 开头的文章。
// 其中一篇是「已发布」状态，会立刻污染下一次运行的 sitemap 断言 ——
// 于是测试第一次失败，之后次次失败，而且看起来像是新改坏的。
// 这里先把自家前缀的残留清干净，保证每次运行的起点都一样。
const STALE_PREFIXES = ['smoke-test-tmp', 'smoke-test-renamed', 'smoke-test-xss'];

// 测试自己造的东西长什么样。清扫只认这两个记号，认不出来的一律不碰。
const MSG_MARKER = /^冒烟测试留言/;
const UPLOAD_NAME = /^\d{8}-[0-9a-f]{12}\.png$/;

// 实验区的痕迹也得收，而且不能只靠「跑前清单做差集」。
//
// 那套差集只会删掉本次运行新增的文件：上一轮漏下来的已经在清单里了，
// 于是被当成「本来就有的」永远留着；更糟的是备份也在清扫之后取，
// 残留会被当成用户自己的留言和照片原样还原回去 —— 残留只增不减。
//
// 这里只删能被证明是测试造的东西：
//   1. 正文以测试固定前缀开头的留言；
//   2. 与测试夹具逐字节相同、名字也符合测试生成规则、并且没有被
//      photos.json 引用的上传文件。真被引用的说明是用户自己传的，
//      哪怕内容一模一样也不动。
// 认不出的东西一律保留 —— 宁可漏删，不可误删。
async function sweepLabArtifacts() {
  let removed = 0;

  const rawMsgs = await fsp.readFile(lab.MESSAGES_FILE, 'utf8').catch(() => null);
  if (rawMsgs !== null) {
    try {
      const list = JSON.parse(rawMsgs);
      if (Array.isArray(list)) {
        const kept = list.filter((m) => !(m && MSG_MARKER.test(String(m.content || ''))));
        if (kept.length !== list.length) {
          await fsp.writeFile(lab.MESSAGES_FILE, JSON.stringify(kept, null, 2) + '\n');
          removed += list.length - kept.length;
        }
      }
    } catch (e) { /* 文件坏了不在这里修，交给 doctor 报 */ }
  }

  const referenced = new Set();
  try {
    const list = JSON.parse(await fsp.readFile(path.join(ROOT, 'data', 'photos.json'), 'utf8'));
    if (Array.isArray(list)) {
      for (const p of list) if (p && p.src) referenced.add(path.basename(String(p.src)));
    }
  } catch (e) { /* 同上 */ }

  for (const name of await fsp.readdir(lab.UPLOAD_DIR).catch(() => [])) {
    if (referenced.has(name)) continue;
    if (!UPLOAD_NAME.test(name)) continue;
    const buf = await fsp.readFile(path.join(lab.UPLOAD_DIR, name)).catch(() => null);
    if (buf && buf.equals(TINY_PNG)) {
      await fsp.rm(path.join(lab.UPLOAD_DIR, name), { force: true });
      removed += 1;
    }
  }

  return removed;
}

async function sweepStaleArtifacts() {
  const removed = [];
  for (const slug of STALE_PREFIXES) {
    const file = path.join(ROOT, 'data', 'articles', slug + '.md');
    if (await fsp.access(file).then(() => true).catch(() => false)) {
      await fsp.rm(file, { force: true });
      removed.push(slug + '.md');
    }
    const dir = path.join(ROOT, 'data', '.history', slug);
    if (await fsp.access(dir).then(() => true).catch(() => false)) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
  // 写权限探针是固定文件名，正常路径上写完就删。
  // 如果上一次运行被杀在半路，这里顺手收掉，免得它被当成「本来就有的文件」而一直留着。
  for (const dir of [path.join(ROOT, 'data'), lab.UPLOAD_DIR]) {
    const files = await fsp.readdir(dir).catch(() => []);
    for (const name of files) {
      if (/^\.(write|doctor)-probe/.test(name)) await fsp.rm(path.join(dir, name), { force: true });
    }
  }
  // 必须在取备份之前跑：清完这轮残留，备份里留下的才是用户真正的数据。
  const labRemoved = await sweepLabArtifacts();
  if (labRemoved) console.log('  （清理了上次留下的实验区测试数据：' + labRemoved + ' 项）');
  if (removed.length) console.log('  （清理了上次留下的测试文章：' + removed.join('、') + '）');
}

async function main() {
  await sweepStaleArtifacts();

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  let exitCode = 1;
  let backups = { messages: null, weights: null, photos: null };
  try {
    const up = await waitForServer(12000);
    if (!up) throw new Error('服务没能在 12 秒内起来\n' + serverLog);

    // 实验区的测试会真写真删，先把这三份数据原样留一份，跑完还原。
    // 测试不该在用户的留言、体重和相册里留下痕迹。
    // 必须等服务起来之后再取 —— 那几个 json 是服务启动时创建的，
    // 早一步读会读到「文件还不存在」，于是什么都还原不回去。
    backups = {
      messages: await fsp.readFile(lab.MESSAGES_FILE, 'utf8').catch(() => null),
      weights: await fsp.readFile(lab.WEIGHTS_FILE, 'utf8').catch(() => null),
      photos: await fsp.readFile(path.join(ROOT, 'data', 'photos.json'), 'utf8').catch(() => null),
    };
    uploadsBefore = new Set(await fsp.readdir(lab.UPLOAD_DIR).catch(() => []));

    console.log('\n— 开跑前的环境 —');
    const dirty = (await fsp.readdir(path.join(ROOT, 'data', 'articles'))).filter((f) => /^smoke-test-/.test(f));
    check('没有上次残留的测试文章', dirty.length === 0, dirty.join(', '));

    console.log('\n— 公开页面 —');
    const pages = [
      ['/', ['wenwen blog', '在公开写作里']],
      ['/articles', ['All articles', '复盘']],
      ['/articles/first-hackathon-retrospective', ['回望第一次黑客松', 'prose']],
      ['/articles/harness-to-html', ['harness', 'A畜']],
      ['/notes', ['享受早睡复利', '静夜思']],
      ['/photos', ['街角', '金色花枝']],
      ['/about', ['About']],
    ];
    for (const [p, needles] of pages) {
      const res = await request('GET', p);
      const missing = needles.filter((n) => !res.raw.includes(n));
      check('GET ' + p + ' → 200 且内容正确', res.status === 200 && missing.length === 0,
        res.status !== 200 ? 'HTTP ' + res.status : '缺少内容：' + missing.join(', '));
    }

    console.log('\n— 死链是否清零 —');
    const home = await request('GET', '/');
    const hrefs = Array.from(new Set((home.raw.match(/href="\/[^"#]*"/g) || []).map((h) => h.slice(6, -1))));
    const assetOrApi = hrefs.filter((h) => !h.startsWith('/assets'));
    let broken = [];
    for (const href of assetOrApi) {
      const res = await request('GET', href);
      if (res.status >= 400) broken.push(href + ' → ' + res.status);
    }
    check('首页所有内链都可访问（' + assetOrApi.length + ' 个）', broken.length === 0, broken.join(', '));

    const articleHtml = (await request('GET', '/articles/first-hackathon-retrospective')).raw;
    const navHrefs = Array.from(new Set((articleHtml.match(/href="\/[^"#]*"/g) || []).map((h) => h.slice(6, -1))));
    broken = [];
    for (const href of navHrefs.filter((h) => !h.startsWith('/assets'))) {
      const res = await request('GET', href);
      if (res.status >= 400) broken.push(href + ' → ' + res.status);
    }
    check('文章页所有内链都可访问（' + navHrefs.length + ' 个）', broken.length === 0, broken.join(', '));

    console.log('\n— SEO 产物 —');
    const feed = await request('GET', '/feed.xml');
    check('RSS 含文章条目', feed.status === 200 && feed.raw.includes('<item>') && feed.raw.includes('/articles/harness-to-html'));
    const sm = await request('GET', '/sitemap.xml');
    check('sitemap 含所有已发布文章',
      sm.status === 200 &&
        sm.raw.includes('/articles/first-hackathon-retrospective') &&
        !/smoke-test/.test(sm.raw),
      'HTTP ' + sm.status + (sm.raw.includes('smoke-test') ? '（sitemap 里混进了测试文章）' : ''));
    const rb = await request('GET', '/robots.txt');
    check('robots 屏蔽 /admin 与 /api/', rb.raw.includes('Disallow: /admin') && rb.raw.includes('Sitemap:'));
    check('文章页有 JSON-LD BlogPosting', articleHtml.includes('"@type":"BlogPosting"'));
    check('文章页有 canonical 与 description', articleHtml.includes('rel="canonical"') && articleHtml.includes('name="description"'));

    console.log('\n— 草稿可见性 —');
    const draftRes = await request('GET', '/articles/long-term-rhythm');
    check('未登录访问草稿 → 404', draftRes.status === 404, 'HTTP ' + draftRes.status);

    console.log('\n— 未登录时接口必须拒绝 —');
    for (const [m, p, b] of [
      ['GET', '/api/admin/bootstrap'],
      ['GET', '/api/admin/articles'],
      ['POST', '/api/admin/articles', { title: 'x' }],
      ['PUT', '/api/admin/notes', { notes: [] }],
      ['PUT', '/api/admin/site', { site: {} }],
      // 实验区里写着「需登录」的那几个，一个都不能漏
      ['GET', '/api/lab/weights'],
      ['POST', '/api/lab/weights', { kg: 70 }],
      ['POST', '/api/lab/weights/clear'],
      ['DELETE', '/api/lab/weights/x'],
      ['DELETE', '/api/lab/messages/x'],
      ['POST', '/api/lab/photos', { anything: true }],
      ['DELETE', '/api/lab/photos/x'],
    ]) {
      const r = await json(m, p, b);
      check(m + ' ' + p + ' → 401', r.status === 401, 'HTTP ' + r.status);
    }

    console.log('\n— 实验区公开接口（不登录也该能用） —');
    const pubMessages = await json('GET', '/api/lab/messages');
    check('留言列表公开可读', pubMessages.status === 200 && Array.isArray(pubMessages.data.messages), 'HTTP ' + pubMessages.status);
    const pubPhotos = await json('GET', '/api/lab/photos');
    check('相册公开可读', pubPhotos.status === 200 && Array.isArray(pubPhotos.data.photos), 'HTTP ' + pubPhotos.status);
    const pubCatalog = await json('GET', '/api/lab/catalog');
    check('实验区目录公开可读', pubCatalog.status === 200 && pubCatalog.data.items.length === lab.ITEMS.length);
    const mdRender = await json('POST', '/api/lab/markdown', { text: '# 标题\n\n正文 **粗体**\n\n- 一\n- 二' });
    check('Markdown 渲染走服务端（不依赖任何 CDN）',
      mdRender.status === 200 && mdRender.raw.includes('<h2>标题</h2>') && mdRender.raw.includes('<strong>粗体</strong>'),
      'HTTP ' + mdRender.status + ' ' + mdRender.raw.slice(0, 120));
    check('正文标题整体降一级（页面自己已经有 h1）',
      mdRender.status === 200 && !mdRender.raw.includes('<h1>'));
    const mdXss = await json('POST', '/api/lab/markdown', { text: '<script>alert(1)</script>' });
    check('渲染接口转义原始 HTML', mdXss.status === 200 && !mdXss.raw.includes('<script>alert(1)'));
    const mdTooLong = await json('POST', '/api/lab/markdown', { text: 'x'.repeat(lab.LIMITS.markdownChars + 1) });
    check('超长正文 → 413', mdTooLong.status === 413, 'HTTP ' + mdTooLong.status);

    console.log('\n— 登录 —');
    const pw = (await fsp.readFile(path.join(ROOT, 'data', '.admin-password'), 'utf8')).trim();
    const bad = await json('POST', '/api/auth/login', { password: pw + 'x' });
    check('错误密码 → 401', bad.status === 401, 'HTTP ' + bad.status);
    const good = await json('POST', '/api/auth/login', { password: pw });
    check('正确密码 → 200 且下发会话 Cookie', good.status === 200 && cookie.startsWith('ww_session='), 'HTTP ' + good.status);
    const boot = await json('GET', '/api/admin/bootstrap');
    check('登录后可读 bootstrap', boot.status === 200 && Array.isArray(boot.data.articles), 'HTTP ' + boot.status);
    check('bootstrap 含草稿文章', (boot.data.articles || []).some((a) => a.slug === 'long-term-rhythm' && a.draft));
    check('列表接口不带正文（省流量）', (boot.data.articles || []).every((a) => a.body === undefined));

    const draftAsAdmin = await request('GET', '/articles/long-term-rhythm');
    check('登录后可预览草稿', draftAsAdmin.status === 200, 'HTTP ' + draftAsAdmin.status);

    console.log('\n— 文章增删改 —');
    const created = await json('POST', '/api/admin/articles', {
      slug: TEST_SLUG,
      title: '冒烟测试文章',
      date: '2026-09-17',
      category: 'Test',
      summary: '这是自动化测试建的，马上会删掉。',
      tags: '测试, 自动化',
      draft: true,
      body: '## 小标题\n\n正文一段。\n\n> 引用一句。\n\n- 列表一\n- 列表二\n\n**粗体** 与 [链接](/about)。',
    });
    check('新建草稿文章 → 200', created.status === 200 && created.data.article.slug === TEST_SLUG, 'HTTP ' + created.status);
    check('frontmatter 落盘正确（标签/草稿/日期）',
      created.status === 200 && created.data.article.tags.length === 2 && created.data.article.draft === true && created.data.article.date === '2026-09-17');
    check('阅读时长按正文估算', created.status === 200 && created.data.article.minutes >= 1);
    const draftFile = await fsp.readFile(path.join(ROOT, 'data', 'articles', TEST_SLUG + '.md'), 'utf8');
    check('Markdown 文件结构正确', draftFile.startsWith('---\ntitle: 冒烟测试文章') && draftFile.includes('draft: true'));

    const listAfterCreate = await json('GET', '/api/admin/articles');
    check('新文章出现在后台列表', listAfterCreate.data.articles.some((a) => a.slug === TEST_SLUG));
    const savedCookie = cookie;
    cookie = '';
    const publicWhileDraft = await request('GET', '/articles/' + TEST_SLUG);
    cookie = savedCookie;
    check('草稿不出现在公开站点（未登录访客视角）', publicWhileDraft.status === 404, 'HTTP ' + publicWhileDraft.status);

    const published = await json('POST', '/api/admin/articles', {
      originalSlug: TEST_SLUG,
      slug: TEST_SLUG,
      title: '冒烟测试文章',
      date: '2026-09-17',
      category: 'Test',
      summary: '这是自动化测试建的，马上会删掉。',
      tags: ['测试'],
      draft: false,
      body: '## 小标题\n\n正文一段。\n\n> 引用一句。',
    });
    check('取消草稿 → 转为公开', published.status === 200 && published.data.article.draft === false);
    check('保存后写入 updated 字段', Boolean(published.data.article.updated));
    const nowPublic = await request('GET', '/articles/' + TEST_SLUG);
    check('发布后公开可访问', nowPublic.status === 200 && nowPublic.raw.includes('引用一句'));
    check('Markdown 渲染成正确标签',
      nowPublic.raw.includes('<h3>小标题</h3>') && nowPublic.raw.includes('<blockquote>') && !nowPublic.raw.includes('&lt;h3&gt;'));

    const renamed = await json('POST', '/api/admin/articles', {
      originalSlug: TEST_SLUG,
      slug: 'smoke-test-renamed',
      title: '冒烟测试文章（改名）',
      date: '2026-09-17',
      category: 'Test',
      summary: '改名验证。',
      draft: true,
      body: '改名后的正文。',
    });
    check('改 slug → 200', renamed.status === 200 && renamed.data.article.slug === 'smoke-test-renamed');
    let oldGone = false;
    try { await fsp.access(path.join(ROOT, 'data', 'articles', TEST_SLUG + '.md')); } catch (e) { oldGone = true; }
    check('旧 slug 文件已移除，不会留双份', oldGone);

    const history = await json('GET', '/api/admin/articles/smoke-test-renamed/history');
    check('改 slug 后历史版本跟随文章（不再留在旧目录）', history.status === 200 && history.data.history.length >= 1,
      '历史条数 ' + (history.data.history || []).length);
    const orphanHistory = await fsp.access(path.join(ROOT, 'data', '.history', TEST_SLUG)).then(() => false).catch(() => true);
    check('旧 slug 的历史目录已清理', orphanHistory);
    if (history.data.history.length) {
      const restored = await json('POST', '/api/admin/articles/smoke-test-renamed/restore', { file: history.data.history[0].file });
      check('从历史版本恢复 → 200', restored.status === 200, 'HTTP ' + restored.status);
      const evil = await json('POST', '/api/admin/articles/smoke-test-renamed/restore', { file: '../../site.json' });
      check('拒绝路径穿越的历史文件名', evil.status === 400, 'HTTP ' + evil.status);
    }

    const badSlug = await json('POST', '/api/admin/articles', { slug: '非法 slug!!', title: 'x' });
    check('拒绝非法 slug', badSlug.status === 400, 'HTTP ' + badSlug.status);

    const removed = await json('DELETE', '/api/admin/articles/smoke-test-renamed');
    check('删除文章 → 200', removed.status === 200 && removed.data.removed === true);
    const afterDelete = await request('GET', '/articles/smoke-test-renamed');
    check('删除后公开页 404', afterDelete.status === 404);
    let fileGone = false;
    try { await fsp.access(path.join(ROOT, 'data', 'articles', 'smoke-test-renamed.md')); } catch (e) { fileGone = true; }
    check('删除后文件已移除', fileGone);

    console.log('\n— 笔记 / 照片 / 站点设置 —');
    const notesBefore = (await json('GET', '/api/admin/bootstrap')).data.notes;
    const notesSaved = await json('PUT', '/api/admin/notes', {
      notes: notesBefore.concat([{ text: '冒烟测试笔记', date: '2026-09-17' }]),
    });
    check('新增笔记 → 200', notesSaved.status === 200 && notesSaved.data.notes.some((n) => n.text === '冒烟测试笔记'));
    const notesBack = await json('PUT', '/api/admin/notes', { notes: notesBefore });
    check('笔记恢复原样', notesBack.data.notes.length === notesBefore.length);
    const notesHtml = await request('GET', '/notes');
    check('笔记页渲染现有内容', notesHtml.raw.includes('享受早睡复利'));

    const photosBefore = (await json('GET', '/api/admin/bootstrap')).data.photos;
    const photosSaved = await json('PUT', '/api/admin/photos', { photos: photosBefore.concat([{ title: '测试图', caption: '说明', src: '' }]) });
    check('新增照片 → 200', photosSaved.status === 200 && photosSaved.data.photos.some((p) => p.title === '测试图'));
    await json('PUT', '/api/admin/photos', { photos: photosBefore });

    const siteBefore = (await json('GET', '/api/admin/bootstrap')).data.site;
    const siteSaved = await json('PUT', '/api/admin/site', { site: { eyebrow: '冒烟测试站名' } });
    check('改站名 → 200', siteSaved.status === 200 && siteSaved.data.site.eyebrow === '冒烟测试站名');
    const siteHtml = await request('GET', '/');
    check('首页立即反映改动（SSR 无缓存延迟）', siteHtml.raw.includes('冒烟测试站名'));
    await json('PUT', '/api/admin/site', { site: siteBefore });
    const siteRestored = await request('GET', '/');
    check('站名已还原', siteRestored.raw.includes(siteBefore.eyebrow) && !siteRestored.raw.includes('冒烟测试站名'));

    console.log('\n— 安全边界 —');
    const xss = await json('POST', '/api/admin/articles', {
      slug: 'smoke-test-xss',
      title: '<script>alert(1)</script>',
      date: '2026-09-17',
      draft: false,
      body: '<img src=x onerror=alert(1)>\n\n正文',
    });
    const xssPage = await request('GET', '/articles/smoke-test-xss');
    check('文章标题与正文里的原始 HTML 被转义',
      !xssPage.raw.includes('<script>alert(1)</script>') && !xssPage.raw.includes('onerror=alert(1)>'),
      '存在未转义输出');
    check('转义后仍能看到文字内容', xssPage.raw.includes('&lt;script&gt;'));
    void xss;
    await json('DELETE', '/api/admin/articles/smoke-test-xss');

    const traversal = await request('GET', '/assets/../../server.js');
    check('静态目录拒绝路径穿越', traversal.status === 404 || traversal.status === 403, 'HTTP ' + traversal.status);
    const badJson = await json('POST', '/api/admin/articles', undefined);
    check('空请求体 → 400 而不是 500', badJson.status === 400, 'HTTP ' + badJson.status);

    console.log('\n— 实验区页面 —');
    const labIndex = await request('GET', '/lab');
    check('/lab 索引页 200 且列全了入口',
      labIndex.status === 200 && lab.ITEMS.every((i) => labIndex.raw.includes('/lab/' + i.slug)),
      'HTTP ' + labIndex.status);
    check('索引页用的是站点自己的版式', labIndex.raw.includes('site.css') && labIndex.raw.includes('lab-grid'));

    // 每个实验页必须挂上共享样式和统一的返回入口 —— 否则点进去就回不来了。
    // 这两个正是各 Demo 页面被搬进来时唯一应该被动过的地方。
    const labBroken = [];
    const labNoBack = [];
    for (const item of lab.ITEMS) {
      const res = await request('GET', '/lab/' + item.slug);
      if (res.status !== 200) {
        labBroken.push('/lab/' + item.slug + ' → HTTP ' + res.status);
        continue;
      }
      if (!res.raw.includes('/lab/_lab.css') || !res.raw.includes('href="/lab"')) {
        labNoBack.push(item.slug);
      }
    }
    check('实验区 ' + lab.ITEMS.length + ' 个页面全部可访问', labBroken.length === 0, labBroken.join(', '));
    check('每个实验页都带统一的返回入口', labNoBack.length === 0, labNoBack.join(', '));

    const labCss = await request('GET', '/lab/_lab.css');
    check('实验区共享样式可访问且 MIME 正确',
      labCss.status === 200 && /text\/css/.test(labCss.headers['content-type'] || ''), labCss.headers['content-type']);
    const gameJs = await request('GET', '/lab/2048/js/game_manager.js');
    check('2048 子目录资源可访问', gameJs.status === 200 && /javascript/.test(gameJs.headers['content-type'] || ''));
    const font = await request('GET', '/lab/2048/style/fonts/ClearSans-Regular-webfont.woff');
    check('字体按 woff 下发（没被当成二进制砸）',
      font.status === 200 && /woff/.test(font.headers['content-type'] || ''), font.headers['content-type']);

    const htmlRedirect = await request('GET', '/lab/note.html');
    check('/lab/note.html → 301 归一化到 /lab/note',
      htmlRedirect.status === 301 && htmlRedirect.headers.location === '/lab/note',
      'HTTP ' + htmlRedirect.status + ' → ' + htmlRedirect.headers.location);
    const idxRedirect = await request('GET', '/lab/2048/index.html');
    check('/lab/2048/index.html → 301 到 /lab/2048',
      idxRedirect.status === 301 && idxRedirect.headers.location === '/lab/2048',
      'HTTP ' + idxRedirect.status + ' → ' + idxRedirect.headers.location);

    const labMissing = await request('GET', '/lab/not-a-real-page');
    check('不存在的实验页 → 404', labMissing.status === 404, 'HTTP ' + labMissing.status);

    console.log('\n— 实验区静态服务的安全边界 —');
    for (const [label, bad] of [
      ['/lab 拒绝路径穿越', '/lab/..%2f..%2fserver.js'],
      ['编码过的穿越同样被拒', '/lab/%2e%2e%2f%2e%2e%2fserver.js'],
      ['/assets 拒绝跳出目录', '/assets/..%2fserver.js'],
      ['上传目录拒绝穿越', '/uploads/..%2f.admin-password'],
    ]) {
      const res = await request('GET', bad);
      check(label, res.status === 403 || res.status === 404, 'HTTP ' + res.status);
    }
    const upMissing = await request('GET', '/uploads/nope.png');
    check('不存在的上传文件 → 404', upMissing.status === 404, 'HTTP ' + upMissing.status);

    console.log('\n— 留言板 —');
    const msg1 = await json('POST', '/api/lab/messages', { content: '冒烟测试留言 <b>一</b>' });
    check('留言 → 200 且落盘', msg1.status === 200 && Boolean(msg1.data.message && msg1.data.message.id), 'HTTP ' + msg1.status);
    const msgFile = JSON.parse(await fsp.readFile(lab.MESSAGES_FILE, 'utf8'));
    const msgStored = msgFile.find((m) => m.id === msg1.data.message.id);
    check('留言写进了 data/lab/messages.json', Boolean(msgStored));
    check('留言原样存文本，不预先渲染 HTML', msgStored && msgStored.content === '冒烟测试留言 <b>一</b>');
    const msgEmpty = await json('POST', '/api/lab/messages', { content: '   ' });
    check('空白留言 → 400', msgEmpty.status === 400, 'HTTP ' + msgEmpty.status);
    await json('POST', '/api/lab/messages', { content: '冒烟测试留言 二' });
    const msg3 = await json('POST', '/api/lab/messages', { content: '冒烟测试留言 三' });
    check('第 3 条仍在配额内', msg3.status === 200, 'HTTP ' + msg3.status);
    const msg4 = await json('POST', '/api/lab/messages', { content: '超过频率限制的一条' });
    check('同一来源刷得太快 → 429', msg4.status === 429, 'HTTP ' + msg4.status);
    check('限流提示写明了等待时间', /秒后再试/.test(msg4.data.error || ''), JSON.stringify(msg4.data));
    const msgDeleted = await json('DELETE', '/api/lab/messages/' + msg1.data.message.id);
    check('登录后可以删留言',
      msgDeleted.status === 200 && msgDeleted.data.messages.every((m) => m.id !== msg1.data.message.id));

    console.log('\n— 体重记录 —');
    // 所有条数断言都相对「跑之前已有多少条」来写。
    // 写死成 1 条、2 条的话，只要用户自己已经记过体重，测试就会凭空报红。
    const wBefore = (await json('GET', '/api/lab/weights')).data.weights;
    const baseLen = wBefore.length;
    const takenDates = new Set(wBefore.map((w) => w.date));

    const w1 = await json('POST', '/api/lab/weights', { kg: 70.34, note: '冒烟测试' });
    check('记录体重 → 200，保留一位小数', w1.status === 200 && w1.data.weight.kg === 70.3, JSON.stringify(w1.data.weight || {}));
    check('日期默认落在今天', w1.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(w1.data.weight.date));
    const afterFirst = w1.data.weights.length;
    check('总数只按该加的方式变（当天已有记录就是修正）',
      afterFirst === (takenDates.has(w1.data.weight.date) ? baseLen : baseLen + 1),
      baseLen + ' → ' + afterFirst);
    const w2 = await json('POST', '/api/lab/weights', { kg: 69.8 });
    check('同一天再填是修正，不是又加一条',
      w2.status === 200 && w2.data.replaced === true && w2.data.weights.length === afterFirst,
      '条数 ' + (w2.data.weights || []).length);

    // 挑一个当前没被占用的日期，免得撞上用户已有的记录
    const probeDay = new Date(Date.UTC(2000, 0, 1));
    while (takenDates.has(probeDay.toISOString().slice(0, 10))) probeDay.setUTCDate(probeDay.getUTCDate() + 1);
    const probeDate = probeDay.toISOString().slice(0, 10);
    const w3 = await json('POST', '/api/lab/weights', { kg: 68, date: probeDate });
    check('可以补录指定日期', w3.status === 200 && w3.data.weights.some((w) => w.date === probeDate));
    check('补录后总数 +1', w3.status === 200 && w3.data.weights.length === afterFirst + 1);

    const wBad = await json('POST', '/api/lab/weights', { kg: 999 });
    check('离谱的体重 → 400', wBad.status === 400, 'HTTP ' + wBad.status);
    const wBadNum = await json('POST', '/api/lab/weights', { kg: 'abc' });
    check('非数字体重 → 400', wBadNum.status === 400, 'HTTP ' + wBadNum.status);
    const wList = await json('GET', '/api/lab/weights');
    check('列表按日期升序',
      wList.data.weights.every((w, i, arr) => i === 0 || arr[i - 1].date <= w.date));

    const wDel = await json('DELETE', '/api/lab/weights/' + w3.data.weight.id);
    check('删除单条记录 → 200', wDel.status === 200 && !wDel.data.weights.some((w) => w.date === probeDate));
    check('删除后回到补录前的条数', wDel.status === 200 && wDel.data.weights.length === afterFirst);

    // 清空是真的会删掉用户的记录。测它之前先把原文件落一份到旁边，
    // 万一这次运行被中途打断，那些记录还能从 .smoke-backup 里捞回来。
    await fsp.writeFile(lab.WEIGHTS_FILE + '.smoke-backup', JSON.stringify(wBefore, null, 2) + '\n');
    const wClear = await json('POST', '/api/lab/weights/clear');
    check('清空全部 → 200', wClear.status === 200 && wClear.data.weights.length === 0);

    console.log('\n— 照片上传 —');
    const up1 = await requestRaw('POST', '/api/lab/photos', TINY_PNG, {
      'Content-Type': 'image/png',
      'X-Photo-Name': encodeURIComponent('冒烟 测试图.png'),
    });
    const up1Data = JSON.parse(up1.raw);
    check('上传 PNG → 200', up1.status === 200 && up1Data.photo, 'HTTP ' + up1.status + ' ' + up1.raw.slice(0, 120));
    check('返回的地址在 /uploads/ 下且文件名是服务端生成的',
      up1Data.photo && /^\/uploads\/\d{8}-[0-9a-f]{12}\.png$/.test(up1Data.photo.src), up1Data.photo && up1Data.photo.src);
    check('原始文件名被当作标题保留', up1Data.photo && up1Data.photo.title === '冒烟 测试图', up1Data.photo && up1Data.photo.title);
    const upFileExists = up1Data.photo
      ? await fsp.access(path.join(lab.UPLOAD_DIR, path.basename(up1Data.photo.src))).then(() => true).catch(() => false)
      : false;
    check('文件真的落在 data/uploads/', upFileExists);
    const served = await request('GET', up1Data.photo.src);
    check('上传后能通过 /uploads 取回，且按图片类型下发',
      served.status === 200 && /image\/png/.test(served.headers['content-type'] || ''), served.headers['content-type']);
    const photosJson = JSON.parse(await fsp.readFile(path.join(ROOT, 'data', 'photos.json'), 'utf8'));
    check('照片同时进了站点的照片墙（和 /photos 共用一份数据）',
      photosJson.some((p) => p.src === up1Data.photo.src));

    const upSvg = await requestRaw('POST', '/api/lab/photos', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
      'Content-Type': 'image/svg+xml',
      'X-Photo-Name': 'evil.svg',
    });
    check('拒收 SVG（能内嵌脚本，不能当图片直接放出去）', upSvg.status === 415, 'HTTP ' + upSvg.status);
    const upText = await requestRaw('POST', '/api/lab/photos', Buffer.from('not an image'), {
      'Content-Type': 'text/plain',
      'X-Photo-Name': 'a.txt',
    });
    check('拒收非图片类型', upText.status === 415, 'HTTP ' + upText.status);

    const upDel = await json('DELETE', '/api/lab/photos/' + up1Data.photo.id);
    check('删除照片 → 200', upDel.status === 200 && upDel.data.photos.every((p) => p.id !== up1Data.photo.id));
    const uploadFileGone = await fsp
      .access(path.join(lab.UPLOAD_DIR, path.basename(up1Data.photo.src)))
      .then(() => false)
      .catch(() => true);
    check('删除记录时文件本体也清掉（不留孤儿文件）', uploadFileGone);

    console.log('\n— 健康检查与诊断工具 —');
    const health = await json('GET', '/api/health');
    check('GET /api/health → 200 且身份正确（无需登录）', health.status === 200 && health.data.service === 'wenwen-blog');
    check('health 报告数据目录可写', health.data.dataWritable === true);
    check('health 报告密码来源', ['file', 'env'].includes(health.data.passwordSource), health.data.passwordSource);
    check('health 不泄露密码本身', !health.raw.includes(pw));
    check('health 报告实验区状态',
      health.data.lab && health.data.lab.items === lab.ITEMS.length && health.data.lab.uploadsWritable === true,
      JSON.stringify(health.data.lab || {}));

    const doctorHealthy = run(process.execPath, [path.join(ROOT, 'tools', 'doctor.js'), String(PORT)]);
    check('doctor.js 在健康状态下全绿退出', doctorHealthy.code === 0 && doctorHealthy.out.includes('没查出问题'),
      'exit=' + doctorHealthy.code + ' / ' + firstLine(doctorHealthy.out, '结论'));
    check('doctor.js 能自己完成登录自检', doctorHealthy.out.includes('用这个密码能登进去'));

    const originalPw = pw;
    const rotatedPw = 'rt-' + Math.random().toString(36).slice(2, 10);
    await auth.setPassword(store.DATA_DIR, rotatedPw);
    const rotated = await json('POST', '/api/auth/login', { password: rotatedPw });
    check('重设密码后无需重启即可登录（热生效）', rotated.status === 200, 'HTTP ' + rotated.status);
    const stale = await json('POST', '/api/auth/login', { password: originalPw });
    check('旧密码立即失效', stale.status === 401, 'HTTP ' + stale.status);
    await auth.setPassword(store.DATA_DIR, originalPw);
    cookie = '';
    const restored = await json('POST', '/api/auth/login', { password: originalPw });
    check('密码已还原并可用', restored.status === 200, 'HTTP ' + restored.status);

    let lastFail = null;
    for (let i = 0; i < 5; i++) {
      lastFail = await json('POST', '/api/auth/login', { password: 'definitely-not-the-password' });
    }
    check('连错 5 次仍是普通 401', lastFail.status === 401, 'HTTP ' + lastFail.status);
    lastFail = await json('POST', '/api/auth/login', { password: 'definitely-not-the-password' });
    check('第 6 次失败的同时告知已锁定', lastFail.status === 401 && /锁定/.test(lastFail.data.error || ''), 'HTTP ' + lastFail.status);
    check('锁定提示说明了怎么立即解锁', /重启/.test(lastFail.data && lastFail.data.error || ''), JSON.stringify(lastFail.data));
    const afterLock = await json('POST', '/api/auth/login', { password: 'definitely-not-the-password' });
    check('锁定后继续试 → 429', afterLock.status === 429, 'HTTP ' + afterLock.status);
    const correctWhileLocked = await json('POST', '/api/auth/login', { password: originalPw });
    check('锁定期间正确密码也进不去（防暴力）', correctWhileLocked.status === 429, 'HTTP ' + correctWhileLocked.status);
    const healthLocked = await json('GET', '/api/health');
    check('health 暴露锁定状态（便于远程诊断）',
      Array.isArray(healthLocked.data.lockedOut) && healthLocked.data.lockedOut.length > 0);
    const doctorLocked = run(process.execPath, [path.join(ROOT, 'tools', 'doctor.js'), String(PORT)]);
    check('doctor.js 能诊断出「账号被锁」并给出解锁办法',
      doctorLocked.code === 1 && doctorLocked.out.includes('账号被锁') && doctorLocked.out.includes('重启'),
      'exit=' + doctorLocked.code + ' / ' + firstLine(doctorLocked.out, '结论'));

    console.log('\n— 退出登录 —');
    const out = await json('POST', '/api/auth/logout');
    check('退出 → 200', out.status === 200);
    cookie = '';
    const afterLogout = await json('GET', '/api/admin/bootstrap');
    check('退出后接口重新拒绝', afterLogout.status === 401, 'HTTP ' + afterLogout.status);
    const draftAgain = await request('GET', '/articles/long-term-rhythm');
    check('退出后草稿重新不可见', draftAgain.status === 404);

    console.log('\n— 退出后实验区的写入权限同样收回 —');
    for (const [m, p, b] of [
      ['DELETE', '/api/lab/messages/x'],
      ['GET', '/api/lab/weights'],
      ['POST', '/api/lab/weights', { kg: 70 }],
      ['POST', '/api/lab/weights/clear'],
      ['POST', '/api/lab/photos', { anything: true }],
      ['DELETE', '/api/lab/photos/x'],
    ]) {
      const r = await json(m, p, b);
      check('退出后 ' + m + ' ' + p + ' → 401', r.status === 401, 'HTTP ' + r.status);
    }
    const stillPublic = await json('GET', '/api/lab/messages');
    check('但留言板对访客依然开放（这是它该有的样子）', stillPublic.status === 200, 'HTTP ' + stillPublic.status);

    console.log('\n— 404 与错误页 —');
    const nf = await request('GET', '/no-such-page');
    check('404 页面使用站点样式且有出口', nf.status === 404 && nf.raw.includes('返回首页') && nf.raw.includes('site.css'));

    const failed = results.filter((r) => !r.ok);
    console.log('\n══════════════════════════════════════');
    console.log('  共 ' + results.length + ' 项检查，通过 ' + (results.length - failed.length) + '，失败 ' + failed.length);
    console.log('══════════════════════════════════════\n');
    if (failed.length) {
      failed.forEach((f) => console.log('  失败：' + f.name + (f.detail ? ' — ' + f.detail : '')));
      console.log('');
    }
    exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('\n测试中断：' + e.message);
    console.error(serverLog);
    exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await waitForExit(child, 3000);
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-tmp'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-renamed'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-xss'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', TEST_SLUG + '.md'), { force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', 'smoke-test-renamed.md'), { force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', 'smoke-test-xss.md'), { force: true });

    // 实验区的痕迹：留言、体重、被动过的照片列表，
    // 以及本次运行新产生的上传文件。
    // 用「运行前的清单做差集」而不是记 id：上传失败、重试、或者中途改了
    // 测试步骤都可能让 id 记漏。再跑两遍是为了兜住极端情况下清理早于
    // 最后一次落盘完成的时序（这个竞态观察过一次，之后没能稳定复现）。
    for (let pass = 0; pass < 2; pass++) {
      const uploadsNow = await fsp.readdir(lab.UPLOAD_DIR).catch(() => []);
      for (const name of uploadsNow) {
        if (uploadsBefore.has(name)) continue;
        await fsp.rm(path.join(lab.UPLOAD_DIR, name), { force: true });
      }
      if (pass === 0) await new Promise((r) => setTimeout(r, 150));
    }
    if (backups.messages !== null) await fsp.writeFile(lab.MESSAGES_FILE, backups.messages);
    if (backups.weights !== null) await fsp.writeFile(lab.WEIGHTS_FILE, backups.weights);
    if (backups.photos !== null) await fsp.writeFile(path.join(ROOT, 'data', 'photos.json'), backups.photos);
    // 数据已经还原，"清空全部"那一步留下的临时备份可以撤了
    await fsp.rm(lab.WEIGHTS_FILE + '.smoke-backup', { force: true });

    // 写完读回来核对，对不上就再写一次。
    // 「应该写回去了」和「确实写回去了」不是一回事 ——
    // 这几个文件装的是用户自己的留言、体重和照片，不能靠假设。
    for (const [file, want, label] of [
      [lab.MESSAGES_FILE, backups.messages, '留言'],
      [lab.WEIGHTS_FILE, backups.weights, '体重'],
      [path.join(ROOT, 'data', 'photos.json'), backups.photos, '照片'],
    ]) {
      if (want === null) {
        console.log('  ⚠️ ' + label + '：跑之前没读到文件，跳过还原');
        continue;
      }
      let back = await fsp.readFile(file, 'utf8').catch(() => null);
      if (back !== want) {
        await new Promise((r) => setTimeout(r, 120));
        await fsp.writeFile(file, want);
        back = await fsp.readFile(file, 'utf8').catch(() => null);
      }
      if (back !== want) {
        console.log('  ⚠️ ' + label + '没能还原（备份 ' + want.trim().length + ' 字节，落盘 ' +
          (back === null ? '读不到' : back.trim().length + ' 字节') + '）：请手动检查 ' + file);
      }
    }

    // 还原之后再扫一遍。还原的目标是「跑之前的样子」，万一跑之前就已经带着
    // 上一轮漏下来的测试数据（旧版本留下的），这一步保证终点是干净的，
    // 而不是把脏东西一代代继承下去。它同时也是上传清理的第二道保险：
    // 那些文件在照片列表还原之后就成了没人引用的孤儿。
    const leftOver = await sweepLabArtifacts();
    if (leftOver) console.log('  （顺带清掉了残留在数据里的实验区测试痕迹：' + leftOver + ' 项）');
  }
  process.exit(exitCode);
}

main();
