'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const store = require('./lib/store');
const render = require('./lib/render');
const auth = require('./lib/auth');
const util = require('./lib/util');
const md = require('./lib/markdown');
const lab = require('./lib/lab');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const LAB_DIR = path.join(PUBLIC_DIR, 'lab');

const MIME = {
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.html': 'text/html',
};

// 2048 那套皮肤带着 Clear Sans 的 woff/eot，字体走自己的 MIME 才不会被当成二进制下砸
const MIME_EXTRA = {
  '.woff': 'font/woff',
  '.eot': 'application/vnd.ms-fontobject',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.scss': 'text/plain',
};

const MIME_ALL = Object.assign({}, MIME, MIME_EXTRA);

function contentTypeFor(ext) {
  const base = MIME_ALL[ext] || 'application/octet-stream';
  return base + (base.startsWith('text/') || base === 'application/javascript' || base === 'application/json' ? '; charset=utf-8' : '');
}

function baseUrl(req) {
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return proto + '://' + host;
}

function isSecure(req) {
  return (
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    Boolean(req.socket.encrypted)
  );
}

function sendHtml(res, status, html, extraHeaders) {
  const headers = Object.assign(
    {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-cache, must-revalidate',
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(html);
}

async function loadBase(req) {
  const [site, notes, photos, articles, loggedIn] = await Promise.all([
    store.getSite(),
    store.getNotes(),
    store.getPhotos(),
    store.listArticles(),
    auth.isLoggedIn(req, store.DATA_DIR),
  ]);
  return { site, notes, photos, articles, loggedIn, base: baseUrl(req) };
}

// 静态目录必须钉死在基目录里。resolve 之后再比前缀 + 分隔符，
// 否则 /assets/../server.js 会被 normalize 成仓库里的真文件直接送出去。
function resolveWithin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const clean = String(relPath == null ? '' : relPath).replace(/^\/+/, '');
  const target = path.resolve(base, clean);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

async function firstFile(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
  }
  return null;
}

async function sendFile(res, file, cacheControl) {
  const data = await fsp.readFile(file);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(path.extname(file).toLowerCase()),
    'Content-Length': data.length,
    'Cache-Control': cacheControl || 'public, max-age=300',
  });
  res.end(data);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/assets\/?/, '');
  const target = resolveWithin(path.join(PUBLIC_DIR, 'assets'), rel);
  if (!target) return util.sendText(res, 403, 'Forbidden');
  const file = await firstFile([target]);
  if (!file) return util.sendText(res, 404, 'Not found');
  return sendFile(res, file);
}

// /lab/note → public/lab/note.html
// /lab/2048 → public/lab/2048/index.html
async function serveLab(req, res, pathname) {
  const rel = pathname.slice('/lab/'.length);

  // 带 .html 的地址统一 301 到无扩展名版本，
  // 免得同一页有两个地址，也免得索引页和直接访问页看起来像两份东西
  if (rel.endsWith('.html')) {
    const bare = rel.slice(0, -'.html'.length);
    const dest = bare === 'index' ? '/lab' : '/lab/' + bare.replace(/\/index$/, '');
    res.writeHead(301, { Location: dest });
    return res.end();
  }

  const dir = resolveWithin(LAB_DIR, rel);
  if (!dir) return util.sendText(res, 403, 'Forbidden');
  const file = await firstFile([dir, dir + '.html', path.join(dir, 'index.html')]);
  if (!file) return util.sendText(res, 404, 'Not found');
  return sendFile(res, file);
}

// 上传的照片。文件名由服务端生成，读的时候按同一套形状再校验一次才落盘。
async function serveUpload(req, res, pathname) {
  const name = pathname.slice('/uploads/'.length);
  if (!lab.isSafeUploadName(name)) return util.sendText(res, 404, 'Not found');
  const file = resolveWithin(lab.UPLOAD_DIR, name);
  if (!file || !(await firstFile([file]))) return util.sendText(res, 404, 'Not found');
  return sendFile(res, file, 'public, max-age=31536000, immutable');
}

/* ------------------------------ API ------------------------------ */

function stripBody(article) {
  const clone = Object.assign({}, article);
  delete clone.body;
  return clone;
}

// 数据目录不可写时，读还能用、写一定失败，启动阶段就把它查出来并说清后果。
// 探针用固定文件名 + finally 清理：进程被 kill 在半路时留下的那一个，
// 下次检查会原地覆盖再删掉，不会越积越多。
async function checkWritable(dir) {
  const probe = path.join(dir, '.write-probe');
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, 'ok');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  } finally {
    await fsp.unlink(probe).catch(() => {});
  }
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    const [articles, notes, photos] = await Promise.all([
      store.listArticles({ includeDrafts: true }),
      store.getNotes(),
      store.getPhotos(),
    ]);
    const [messages, weights, uploadsWritable] = await Promise.all([
      lab.getMessages(),
      lab.getWeights(),
      checkWritable(lab.UPLOAD_DIR),
    ]);
    return util.sendJson(res, 200, {
      ok: true,
      service: 'wenwen-blog',
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      dataDir: store.DATA_DIR,
      dataWritable: (await checkWritable(store.DATA_DIR)).ok,
      passwordSource: await auth.passwordSource(store.DATA_DIR),
      articles: articles.length,
      published: articles.filter((a) => !a.draft).length,
      drafts: articles.filter((a) => a.draft).map((a) => a.slug),
      notes: notes.length,
      photos: photos.length,
      lab: {
        items: lab.ITEMS.length,
        messages: messages.length,
        weights: weights.length,
        uploadsWritable: uploadsWritable.ok,
        uploadsError: uploadsWritable.ok ? '' : uploadsWritable.error,
      },
      lockedOut: auth.lockStatus(),
    });
  }

  if (pathname === '/api/auth/status' && method === 'GET') {
    const loggedIn = await auth.isLoggedIn(req, store.DATA_DIR);
    return util.sendJson(res, 200, { loggedIn });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip = auth.clientIp(req);
    const rate = auth.checkRate(ip);
    if (rate.blocked) {
      const mins = Math.ceil(rate.retryAfterMs / 60000);
      console.warn('[login] 拒绝 ' + ip + '：已锁定，还有 ' + mins + ' 分钟');
      return util.sendJson(res, 429, { error: '尝试次数过多，请 ' + mins + ' 分钟后再试（重启服务可立即解锁）' });
    }
    const body = await util.readBody(req, 64 * 1024);
    const { ok, source } = await auth.verifyPassword(store.DATA_DIR, body.password);
    if (!ok) {
      const locked = auth.recordFailure(ip);
      console.warn(
        '[login] 失败 ' + ip + '：密码不匹配（校验对象来自 ' + source + '）' + (locked ? '，已锁定 10 分钟' : '')
      );
      return util.sendJson(res, 401, {
        error: locked ? '密码错误次数过多，已锁定 10 分钟（重启服务可立即解锁）' : '密码不对',
      });
    }
    auth.recordSuccess(ip);
    const token = await auth.issueToken(store.DATA_DIR);
    auth.setSessionCookie(res, token, isSecure(req));
    console.log('[login] 成功 ' + ip);
    return util.sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    auth.clearSessionCookie(res, isSecure(req));
    return util.sendJson(res, 200, { ok: true });
  }

  /* -------- 实验区的公开接口 --------
     留言板和 Markdown 渲染是故意不设登录的 —— 它们本来就是给访客用的。
     所以限流、限长、限总量全在 lib/lab.js 里兜着，不靠前端自觉。 */

  if (pathname === '/api/lab/catalog' && method === 'GET') {
    return util.sendJson(res, 200, { items: lab.ITEMS });
  }

  if (pathname === '/api/lab/messages' && method === 'GET') {
    return util.sendJson(res, 200, { messages: await lab.getMessages() });
  }

  if (pathname === '/api/lab/messages' && method === 'POST') {
    const body = await util.readBody(req, 64 * 1024);
    return util.sendJson(res, 200, await lab.addMessage(body.content, auth.clientIp(req)));
  }

  if (pathname === '/api/lab/markdown' && method === 'POST') {
    const gate = lab.rateLimit('md:' + auth.clientIp(req), lab.LIMITS.markdownPerMinute, 60 * 1000);
    if (!gate.ok) return util.sendJson(res, 429, { error: '渲染太频繁了，缓一下再试' });
    const body = await util.readBody(req, 256 * 1024);
    const text = String(body.text == null ? '' : body.text);
    if (text.length > lab.LIMITS.markdownChars) {
      return util.sendJson(res, 413, { error: '正文太长（上限 ' + lab.LIMITS.markdownChars + ' 字）' });
    }
    return util.sendJson(res, 200, { html: md.render(text) });
  }

  if (pathname === '/api/lab/photos' && method === 'GET') {
    return util.sendJson(res, 200, { photos: await store.getPhotos() });
  }

  const loggedIn = await auth.isLoggedIn(req, store.DATA_DIR);
  if (!loggedIn) return util.sendJson(res, 401, { error: '未登录' });

  /* -------- 实验区里需要登录的部分 -------- */

  const labMessageMatch = pathname.match(/^\/api\/lab\/messages\/([^/]+)$/);
  if (labMessageMatch && method === 'DELETE') {
    return util.sendJson(res, 200, await lab.deleteMessage(decodeURIComponent(labMessageMatch[1])));
  }

  if (pathname === '/api/lab/weights' && method === 'GET') {
    return util.sendJson(res, 200, { weights: await lab.getWeights() });
  }

  if (pathname === '/api/lab/weights' && method === 'POST') {
    const body = await util.readBody(req, 64 * 1024);
    return util.sendJson(res, 200, await lab.saveWeight(body, auth.clientIp(req)));
  }

  if (pathname === '/api/lab/weights/clear' && method === 'POST') {
    return util.sendJson(res, 200, await lab.clearWeights());
  }

  const labWeightMatch = pathname.match(/^\/api\/lab\/weights\/([^/]+)$/);
  if (labWeightMatch && method === 'DELETE') {
    return util.sendJson(res, 200, await lab.deleteWeight(decodeURIComponent(labWeightMatch[1])));
  }

  // 上传：一次一个文件的原始二进制，文件名放请求头。
  // 自己拼 multipart 边界太容易出错，这里不需要那个复杂度。
  if (pathname === '/api/lab/photos' && method === 'POST') {
    const buffer = await util.readRawBody(req, lab.LIMITS.uploadBytes + 1024);
    let name = '';
    try {
      name = decodeURIComponent(req.headers['x-photo-name'] || '');
    } catch {
      name = '';
    }
    return util.sendJson(res, 200, await lab.addPhoto(buffer, req.headers['content-type'], name));
  }

  const labPhotoMatch = pathname.match(/^\/api\/lab\/photos\/([^/]+)$/);
  if (labPhotoMatch && method === 'DELETE') {
    return util.sendJson(res, 200, await lab.deletePhoto(decodeURIComponent(labPhotoMatch[1])));
  }

  if (pathname === '/api/admin/bootstrap' && method === 'GET') {
    const [site, notes, photos, articles] = await Promise.all([
      store.getSite(),
      store.getNotes(),
      store.getPhotos(),
      store.listArticles({ includeDrafts: true }),
    ]);
    return util.sendJson(res, 200, {
      site,
      notes,
      photos,
      articles: articles.map(stripBody),
    });
  }

  if (pathname === '/api/admin/suggest-slug' && method === 'GET') {
    const title = query.get('title') || '';
    const taken = await store.takenSlugs();
    return util.sendJson(res, 200, { slug: util.suggestSlug(title, taken) });
  }

  if (pathname === '/api/admin/preview' && method === 'POST') {
    const body = await util.readBody(req);
    return util.sendJson(res, 200, { html: md.render(body.body || '') });
  }

  if (pathname === '/api/admin/articles' && method === 'GET') {
    const articles = await store.listArticles({ includeDrafts: true });
    return util.sendJson(res, 200, { articles: articles.map(stripBody) });
  }

  if (pathname === '/api/admin/articles' && method === 'POST') {
    const payload = await util.readBody(req);
    const saved = await store.saveArticle(payload);
    const articles = await store.listArticles({ includeDrafts: true });
    return util.sendJson(res, 200, { article: saved, articles: articles.map(stripBody) });
  }

  if (pathname === '/api/admin/notes' && method === 'PUT') {
    const payload = await util.readBody(req);
    const notes = await store.saveNotes(payload.notes);
    return util.sendJson(res, 200, { notes });
  }

  if (pathname === '/api/admin/photos' && method === 'PUT') {
    const payload = await util.readBody(req);
    const photos = await store.savePhotos(payload.photos);
    return util.sendJson(res, 200, { photos });
  }

  if (pathname === '/api/admin/site' && method === 'PUT') {
    const payload = await util.readBody(req);
    const site = await store.saveSite(payload.site);
    return util.sendJson(res, 200, { site });
  }

  const articleMatch = pathname.match(/^\/api\/admin\/articles\/([^/]+)(\/history|\/restore)?$/);
  if (articleMatch) {
    const slug = decodeURIComponent(articleMatch[1]);
    const suffix = articleMatch[2];

    if (!suffix && method === 'GET') {
      const article = await store.getArticle(slug);
      if (!article) return util.sendJson(res, 404, { error: '文章不存在' });
      return util.sendJson(res, 200, { article });
    }

    if (!suffix && method === 'DELETE') {
      const removed = await store.deleteArticle(slug);
      const articles = await store.listArticles({ includeDrafts: true });
      return util.sendJson(res, 200, { removed, articles: articles.map(stripBody) });
    }

    if (suffix === '/history' && method === 'GET') {
      return util.sendJson(res, 200, { history: await store.listHistory(slug) });
    }

    if (suffix === '/restore' && method === 'POST') {
      const payload = await util.readBody(req, 64 * 1024);
      const article = await store.restoreHistory(slug, payload.file);
      return util.sendJson(res, 200, { article });
    }
  }

  return util.sendJson(res, 404, { error: '未知接口' });
}

/* ------------------------------ 页面 ------------------------------ */

async function handlePage(req, res, pathname) {
  if (pathname.startsWith('/assets/')) return serveStatic(req, res, pathname);
  if (pathname.startsWith('/uploads/')) return serveUpload(req, res, pathname);

  // 实验区的静态页在 loadBase 之前就返回了 —— 那些页面不吃站点的数据，
  // 为了一个 CSS 去读一遍全部文章没有道理
  if (pathname.startsWith('/lab/')) return serveLab(req, res, pathname);

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/admin' || pathname === '/admin/') {
    const html = await fsp.readFile(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
    return sendHtml(res, 200, html);
  }

  const ctx = await loadBase(req);

  if (pathname === '/') return sendHtml(res, 200, render.homePage(withCover(ctx)));

  if (pathname === '/articles') return sendHtml(res, 200, render.articlesPage(ctx));

  if (pathname === '/notes') return sendHtml(res, 200, render.notesPage(ctx));

  if (pathname === '/photos') return sendHtml(res, 200, render.photosPage(ctx));

  if (pathname === '/about') return sendHtml(res, 200, render.aboutPage(ctx));

  if (pathname === '/lab') return sendHtml(res, 200, render.labPage(ctx));

  if (pathname === '/feed.xml') {
    const xml = render.feed(ctx.site, ctx.articles, ctx.base);
    return sendHtml(res, 200, xml, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  }

  if (pathname === '/sitemap.xml') {
    const xml = render.sitemap(ctx.site, ctx.articles, ctx.notes, ctx.photos, ctx.base);
    return sendHtml(res, 200, xml, { 'Content-Type': 'application/xml; charset=utf-8' });
  }

  if (pathname === '/robots.txt') {
    return sendHtml(res, 200, render.robots(ctx.base), { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const articleMatch = pathname.match(/^\/articles\/([^/]+)\/?$/);
  if (articleMatch) {
    const slug = decodeURIComponent(articleMatch[1]);
    const article = await store.getArticle(slug);
    if (!article || (article.draft && !ctx.loggedIn)) {
      return sendHtml(res, 404, render.notFoundPage(ctx));
    }
    const list = ctx.articles;
    const idx = list.findIndex((a) => a.slug === slug);
    const newer = idx > 0 ? list[idx - 1] : null;
    const older = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
    return sendHtml(
      res,
      200,
      render.articlePage(Object.assign({}, ctx, { article, newer, older }))
    );
  }

  return sendHtml(res, 404, render.notFoundPage(ctx));
}

function withCover(ctx) {
  const published = ctx.articles;
  let cover = null;
  if (ctx.site.coverSlug) {
    cover = published.find((a) => a.slug === ctx.site.coverSlug) || null;
    if (!cover && ctx.loggedIn) {
      cover = null;
    }
  }
  if (!cover) cover = published[0] || null;
  return Object.assign({}, ctx, { cover });
}

/* ------------------------------ server ------------------------------ */

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const parsed = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(parsed.pathname);
    query = parsed.searchParams;
  } catch {
    return util.sendText(res, 400, 'Bad request');
  }

  if (/[\u0000]/.test(pathname)) return util.sendText(res, 400, 'Bad request');

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, query);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return util.sendText(res, 405, 'Method not allowed');
    }
    return await handlePage(req, res, pathname.endsWith('/') && pathname !== '/' ? pathname.slice(0, -1) : pathname);
  } catch (e) {
    const status = e.status || 500;
    if (pathname.startsWith('/api/')) {
      return util.sendJson(res, status, { error: e.message || '服务器错误' });
    }
    console.error('[error]', req.method, pathname, e);
    try {
      const ctx = await loadBase(req).catch(() => ({
        site: { eyebrow: 'wenwen blog' },
        notes: [],
        photos: [],
        articles: [],
        loggedIn: false,
        base: baseUrl(req),
      }));
      return sendHtml(res, status, render.errorPage(ctx));
    } catch {
      return util.sendText(res, status, 'Server error');
    }
  }
});

(async () => {
  await store.ensure();
  await lab.ensure();
  const writable = await checkWritable(store.DATA_DIR);
  const { password, generated, source } = await auth.getPassword(store.DATA_DIR);

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  wenwen blog 已启动');
    console.log('  ───────────────────────────────────────────');
    console.log('  站点       http://localhost:' + PORT + '/');
    console.log('  实验区     http://localhost:' + PORT + '/lab');
    console.log('  后台       http://localhost:' + PORT + '/admin');
    console.log('  数据目录   ' + store.DATA_DIR);
    console.log('  监听       ' + HOST + ':' + PORT);
    console.log('  健康检查   /api/health');

    if (!writable.ok) {
      console.log('');
      console.log('  ⚠️  数据目录不可写（' + writable.error + '）');
      console.log('     站点能看，但登录一定失败、文章一定存不进去。');
      console.log('     修法：chown -R <运行用户> ' + store.DATA_DIR + '  或  chmod -R u+w ' + store.DATA_DIR);
    }

    console.log('');
    if (generated) {
      console.log('  已生成管理密码（写入 ' + auth.passwordFilePath(store.DATA_DIR) + '）：');
      console.log('    ' + password);
      console.log('  建议改用环境变量 ADMIN_PASSWORD 覆盖它。');
    } else if (source === 'env') {
      console.log('  管理密码来自环境变量 ADMIN_PASSWORD（文件 ' + auth.PASSWORD_FILE + ' 被忽略）。');
    } else {
      console.log('  管理密码来自 ' + auth.passwordFilePath(store.DATA_DIR) + '，');
      console.log('  用 `cat ' + path.join('data', auth.PASSWORD_FILE) + '` 查看，或用 `node tools/set-password.js` 重设。');
      void password;
    }
    console.log('');
  });
})();

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
