'use strict';

// 端到端冒烟测试：起一个真实的 server 子进程，逐条打真实 HTTP 请求。
// 用法：node tools/smoke-test.js [port]

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 3210);
const BASE = 'http://127.0.0.1:' + PORT;
const TEST_SLUG = 'smoke-test-tmp';

let cookie = '';

function request(method, pathname, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      BASE + pathname,
      {
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
      },
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

async function main() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  let exitCode = 1;
  try {
    const up = await waitForServer(12000);
    if (!up) throw new Error('服务没能在 12 秒内起来\n' + serverLog);

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
    check('sitemap 含所有已发布文章', sm.status === 200 && sm.raw.includes('/articles/first-hackathon-retrospective') && !sm.raw.includes(TEST_SLUG));
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
    ]) {
      const r = await json(m, p, b);
      check(m + ' ' + p + ' → 401', r.status === 401, 'HTTP ' + r.status);
    }

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

    console.log('\n— 退出登录 —');
    const out = await json('POST', '/api/auth/logout');
    check('退出 → 200', out.status === 200);
    cookie = '';
    const afterLogout = await json('GET', '/api/admin/bootstrap');
    check('退出后接口重新拒绝', afterLogout.status === 401, 'HTTP ' + afterLogout.status);
    const draftAgain = await request('GET', '/articles/long-term-rhythm');
    check('退出后草稿重新不可见', draftAgain.status === 404);

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
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-tmp'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-renamed'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', '.history', 'smoke-test-xss'), { recursive: true, force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', TEST_SLUG + '.md'), { force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', 'smoke-test-renamed.md'), { force: true });
    await fsp.rm(path.join(ROOT, 'data', 'articles', 'smoke-test-xss.md'), { force: true });
  }
  process.exit(exitCode);
}

main();
