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

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

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

async function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/assets\/?/, '');
  const target = path.join(PUBLIC_DIR, 'assets', rel);
  const normalized = path.normalize(target);
  if (!normalized.startsWith(path.join(PUBLIC_DIR, 'assets'))) {
    return sendHtml(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  try {
    const data = await fsp.readFile(normalized);
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, {
      'Content-Type': (MIME[ext] || 'application/octet-stream') + (ext === '.css' || ext === '.js' ? '; charset=utf-8' : ''),
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return sendHtml(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    throw e;
  }
}

/* ------------------------------ API ------------------------------ */

function stripBody(article) {
  const clone = Object.assign({}, article);
  delete clone.body;
  return clone;
}

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === '/api/auth/status' && method === 'GET') {
    const loggedIn = await auth.isLoggedIn(req, store.DATA_DIR);
    return util.sendJson(res, 200, { loggedIn });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip = auth.clientIp(req);
    const rate = auth.checkRate(ip);
    if (rate.blocked) {
      const mins = Math.ceil(rate.retryAfterMs / 60000);
      return util.sendJson(res, 429, { error: '尝试次数过多，请 ' + mins + ' 分钟后再试' });
    }
    const body = await util.readBody(req, 64 * 1024);
    const { ok } = await auth.verifyPassword(store.DATA_DIR, body.password);
    if (!ok) {
      const locked = auth.recordFailure(ip);
      return util.sendJson(res, 401, {
        error: locked ? '密码错误次数过多，已锁定 10 分钟' : '密码不对',
      });
    }
    auth.recordSuccess(ip);
    const token = await auth.issueToken(store.DATA_DIR);
    auth.setSessionCookie(res, token, isSecure(req));
    return util.sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    auth.clearSessionCookie(res, isSecure(req));
    return util.sendJson(res, 200, { ok: true });
  }

  const loggedIn = await auth.isLoggedIn(req, store.DATA_DIR);
  if (!loggedIn) return util.sendJson(res, 401, { error: '未登录' });

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
  const { password, generated } = await auth.getPassword(store.DATA_DIR);

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  wenwen blog 已启动');
    console.log('  ───────────────────────────────────────────');
    console.log('  站点       http://localhost:' + PORT + '/');
    console.log('  后台       http://localhost:' + PORT + '/admin');
    console.log('  数据目录   ' + store.DATA_DIR);
    console.log('  监听       ' + HOST + ':' + PORT);
    if (generated) {
      console.log('');
      console.log('  已生成管理密码（写入 data/.admin-password）：');
      console.log('    ' + password);
      console.log('  建议改用环境变量 ADMIN_PASSWORD 覆盖它。');
    } else if (!process.env.ADMIN_PASSWORD) {
      console.log('');
      console.log('  管理密码来自 data/.admin-password。');
    }
    console.log('');
  });
})();

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
