'use strict';

const md = require('./markdown');
const util = require('./util');

const esc = util.escapeHtml;

const NAV = [
  { href: '/articles', label: 'Articles' },
  { href: '/notes', label: 'Notes' },
  { href: '/photos', label: 'Photos' },
  { href: '/about', label: 'About' },
];

function head(options) {
  const o = options || {};
  const parts = [
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>' + esc(o.title || 'wenwen blog') + '</title>',
  ];
  if (o.description) {
    parts.push('<meta name="description" content="' + esc(o.description) + '">');
  }
  if (o.canonical) {
    parts.push('<link rel="canonical" href="' + esc(o.canonical) + '">');
    parts.push('<meta property="og:url" content="' + esc(o.canonical) + '">');
  }
  parts.push('<meta property="og:type" content="' + esc(o.ogType || 'website') + '">');
  parts.push('<meta property="og:site_name" content="' + esc(o.siteName || 'wenwen blog') + '">');
  parts.push('<meta property="og:title" content="' + esc(o.title || 'wenwen blog') + '">');
  if (o.description) {
    parts.push('<meta property="og:description" content="' + esc(o.description) + '">');
  }
  parts.push('<meta name="twitter:card" content="summary">');
  if (!o.noIndex) parts.push('<meta name="robots" content="index,follow">');
  if (o.noIndex) parts.push('<meta name="robots" content="noindex,nofollow">');
  parts.push('<link rel="alternate" type="application/rss+xml" title="wenwen blog" href="/feed.xml">');
  parts.push('<link rel="stylesheet" href="/assets/site.css">');
  if (o.jsonLd) {
    parts.push(
      '<script type="application/ld+json">' +
        JSON.stringify(o.jsonLd).replace(/</g, '\\u003c') +
        '</script>'
    );
  }
  return parts.join('\n');
}

function header(site, active, loggedIn) {
  const nav = NAV.map((item) => {
    const isActive = item.href === active;
    return (
      '<span><a href="' +
      item.href +
      '"' +
      (isActive ? ' class="is-active" aria-current="page"' : '') +
      '>' +
      esc(item.label) +
      '</a> / </span>'
    );
  }).join('');
  const tail = loggedIn
    ? '<span><a class="admin-entry" href="/admin">后台</a></span>'
    : '';
  return [
    '<header class="site-header">',
    '<div class="site-header__top">',
    '<span class="site-header__eyebrow">' + esc(site.eyebrow) + '</span>',
    '<span class="language-switch" title="英文版尚未上线">Zh / En</span>',
    '</div>',
    '<nav aria-label="Primary" class="site-header__nav">' + nav + tail + '</nav>',
    '<div aria-hidden="true" class="editorial-rule"></div>',
    '</header>',
  ].join('\n');
}

function footer(site) {
  const year = new Date().getFullYear();
  const parts = ['<footer class="site-footer">', '<div aria-hidden="true" class="editorial-rule"></div>'];
  parts.push('<div class="site-footer__row">');
  parts.push('<span>© ' + year + ' ' + esc(site.eyebrow) + '</span>');
  parts.push('<span><a href="/feed.xml">RSS</a> / <a href="/sitemap.xml">Sitemap</a></span>');
  parts.push('</div>');
  if (site.footerNote) {
    parts.push('<p class="site-footer__note">' + esc(site.footerNote) + '</p>');
  }
  parts.push('</footer>');
  return parts.join('\n');
}

function layout(options) {
  const o = options || {};
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    head(o),
    '</head>',
    '<body>',
    '<div class="page-shell">',
    header(o.site, o.active, o.loggedIn),
    o.body,
    footer(o.site),
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}

function articleRow(article) {
  return [
    '<li class="article-row">',
    '<div class="article-row__meta">' + esc(article.category) + '</div>',
    '<div class="article-row__body">',
    '<h3><a href="/articles/' + esc(article.slug) + '">' + esc(article.title) + '</a></h3>',
    article.summary ? '<p>' + esc(article.summary) + '</p>' : '',
    '</div>',
    '<div class="article-row__meta article-row__date">' + esc(article.date) + '</div>',
    '</li>',
  ]
    .filter(Boolean)
    .join('\n');
}

function sideModules(notes, photos) {
  const noteItems = notes
    .slice(0, 3)
    .map((n) => '<li><strong>' + esc(n.text) + '</strong></li>')
    .join('\n');

  const photoItems = photos
    .slice(0, 2)
    .map((p) => {
      const img = p.src
        ? '<img class="photo-thumb" src="' + esc(p.src) + '" alt="' + esc(p.title) + '" loading="lazy">'
        : '';
      return (
        '<li>' +
        img +
        '<strong>' +
        esc(p.title) +
        '</strong>' +
        (p.caption ? '<p>' + esc(p.caption) + '</p>' : '') +
        '</li>'
      );
    })
    .join('\n');

  return [
    '<div class="home-grid__side">',
    '<section aria-label="Notes" class="side-module">',
    '<p class="kicker"><a href="/notes">Notes</a></p>',
    noteItems
      ? '<ul class="side-module__list">' + noteItems + '</ul>'
      : '<p class="empty">还没有笔记</p>',
    '</section>',
    '<section aria-label="Photos" class="side-module">',
    '<p class="kicker"><a href="/photos">Photos</a></p>',
    photoItems
      ? '<ul class="side-module__list">' + photoItems + '</ul>'
      : '<p class="empty">还没有照片</p>',
    '</section>',
    '</div>',
  ].join('\n');
}

function homePage(ctx) {
  const { site, cover, articles, notes, photos, base, loggedIn } = ctx;

  const coverBlock = cover
    ? [
        '<article class="cover-story">',
        '<p class="kicker">Cover Story</p>',
        '<h2><a href="/articles/' + esc(cover.slug) + '">' + esc(cover.title) + '</a></h2>',
        cover.summary ? '<p class="summary">' + esc(cover.summary) + '</p>' : '',
        '<div class="meta">',
        '<span>' + esc(cover.category) + '</span>',
        '<span>' + cover.minutes + ' min read</span>',
        '<span>' + esc(cover.date) + '</span>',
        '</div>',
        '<a class="text-link" href="/articles/' + esc(cover.slug) + '">Read article →</a>',
        '</article>',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        '<article class="cover-story">',
        '<p class="kicker">Cover Story</p>',
        '<h2>还没有置顶文章</h2>',
        '<p class="summary">进后台写第一篇，它会自动出现在这里。</p>',
        loggedIn ? '<a class="text-link" href="/admin">去写 →</a>' : '',
        '</article>',
      ]
        .filter(Boolean)
        .join('\n');

  const recent = articles.slice(0, 5);

  const body = [
    '<section class="home-hero">',
    '<h1>' + esc(site.heroTitle || '在公开写作里，慢慢整理自己的生活秩序') + '</h1>',
    site.heroSubtitle ? '<p>' + esc(site.heroSubtitle) + '</p>' : '',
    '</section>',
    '<section class="home-grid">',
    coverBlock,
    sideModules(notes, photos),
    '</section>',
    '<section class="article-list">',
    '<div class="section-header">',
    '<h2>Recent Articles</h2>',
    '<a href="/articles">View all</a>',
    '</div>',
    recent.length
      ? '<ul class="article-list__items">' + recent.map(articleRow).join('\n') + '</ul>'
      : '<p class="empty">还没有发布文章。</p>',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');

  return layout({
    site,
    active: '/',
    loggedIn,
    title: site.eyebrow + ' · ' + (site.heroSubtitle || '长期写作'),
    description: site.heroSubtitle || site.heroTitle,
    canonical: base + '/',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: site.eyebrow,
      url: base + '/',
      description: site.heroSubtitle || site.heroTitle,
      blogPost: recent.map((a) => ({
        '@type': 'BlogPosting',
        headline: a.title,
        url: base + '/articles/' + a.slug,
        datePublished: a.date,
      })),
    },
  });
}

function articlesPage(ctx) {
  const { site, articles, base, loggedIn } = ctx;
  const body = [
    '<section class="home-hero home-hero--compact">',
    '<h1>Articles</h1>',
    '<p>共 ' + articles.length + ' 篇，按时间倒序。</p>',
    '</section>',
    '<section class="article-list">',
    '<div class="section-header">',
    '<h2>All articles</h2>',
    '<a href="/feed.xml">RSS</a>',
    '</div>',
    articles.length
      ? '<ul class="article-list__items">' + articles.map(articleRow).join('\n') + '</ul>'
      : '<p class="empty">还没有发布文章。</p>',
    '</section>',
  ].join('\n');

  return layout({
    site,
    active: '/articles',
    loggedIn,
    title: 'Articles · ' + site.eyebrow,
    description: '全部文章列表，共 ' + articles.length + ' 篇。',
    canonical: base + '/articles',
    body,
  });
}

function articlePage(ctx) {
  const { site, article, base, loggedIn, newer, older } = ctx;
  const html = md.render(article.body);

  const body = [
    '<article class="post">',
    '<div class="post__head">',
    '<div class="section-header">',
    '<h2>' + esc(article.category) + '</h2>',
    loggedIn
      ? '<a class="admin-entry" href="/admin#/article/' + esc(article.slug) + '">编辑这篇</a>'
      : '<a href="/articles">全部文章</a>',
    '</div>',
    '<h1 class="post__title">' + esc(article.title) + '</h1>',
    '<div class="post__meta">',
    '<span>' + esc(article.date) + '</span>',
    '<span>' + article.minutes + ' min read</span>',
    '<span>' + article.chars + ' 字</span>',
    article.draft ? '<span class="draft-flag">草稿</span>' : '',
    '</div>',
    article.tags.length
      ? '<div class="post__tags">' + article.tags.map((t) => '<span>#' + esc(t) + '</span>').join('') + '</div>'
      : '',
    '</div>',
    '<div class="prose">' + html + '</div>',
    '<nav class="post__nav">',
    older
      ? '<a href="/articles/' + esc(older.slug) + '">← ' + esc(older.title) + '</a>'
      : '<span></span>',
    newer
      ? '<a class="post__nav-next" href="/articles/' + esc(newer.slug) + '">' + esc(newer.title) + ' →</a>'
      : '<span></span>',
    '</nav>',
    '</article>',
  ]
    .filter(Boolean)
    .join('\n');

  return layout({
    site,
    active: '/articles',
    loggedIn,
    title: article.title + ' · ' + site.eyebrow,
    description: article.summary,
    canonical: base + '/articles/' + article.slug,
    ogType: 'article',
    noIndex: article.draft,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: article.title,
      datePublished: article.date,
      dateModified: article.updated || article.date,
      description: article.summary,
      keywords: article.tags.join(','),
      url: base + '/articles/' + article.slug,
      mainEntityOfPage: base + '/articles/' + article.slug,
      author: { '@type': 'Person', name: site.eyebrow },
      wordCount: article.chars,
    },
  });
}

function notesPage(ctx) {
  const { site, notes, base, loggedIn } = ctx;
  const items = notes
    .map(
      (n) =>
        '<li class="note-item">' +
        (n.date ? '<div class="note-item__date">' + esc(n.date) + '</div>' : '<div></div>') +
        '<div class="note-item__text">' +
        esc(n.text) +
        '</div></li>'
    )
    .join('\n');

  const body = [
    '<section class="home-hero home-hero--compact">',
    '<h1>Notes</h1>',
    '<p>短句、碎片、随手记下的判断。</p>',
    '</section>',
    '<section class="article-list">',
    '<div class="section-header">',
    '<h2>All notes</h2>',
    '<span>' + notes.length + ' 条</span>',
    '</div>',
    notes.length ? '<ul class="note-list">' + items + '</ul>' : '<p class="empty">还没有笔记。</p>',
    '</section>',
  ].join('\n');

  return layout({
    site,
    active: '/notes',
    loggedIn,
    title: 'Notes · ' + site.eyebrow,
    description: '随手记下的短笔记。',
    canonical: base + '/notes',
    body,
  });
}

function photosPage(ctx) {
  const { site, photos, base, loggedIn } = ctx;
  const items = photos
    .map((p) => {
      const img = p.src
        ? '<img class="photo-card__img" src="' + esc(p.src) + '" alt="' + esc(p.title) + '" loading="lazy">'
        : '<div class="photo-card__placeholder" aria-hidden="true"></div>';
      return (
        '<li class="photo-card">' +
        img +
        '<div class="photo-card__body">' +
        '<strong>' +
        esc(p.title) +
        '</strong>' +
        (p.caption ? '<p>' + esc(p.caption) + '</p>' : '') +
        (p.date ? '<span class="photo-card__date">' + esc(p.date) + '</span>' : '') +
        '</div></li>'
      );
    })
    .join('\n');

  const body = [
    '<section class="home-hero home-hero--compact">',
    '<h1>Photos</h1>',
    '<p>路过时拍下的东西。</p>',
    '</section>',
    '<section class="article-list">',
    '<div class="section-header">',
    '<h2>All photos</h2>',
    '<span>' + photos.length + ' 张</span>',
    '</div>',
    photos.length ? '<ul class="photo-grid">' + items + '</ul>' : '<p class="empty">还没有照片。</p>',
    '</section>',
  ].join('\n');

  return layout({
    site,
    active: '/photos',
    loggedIn,
    title: 'Photos · ' + site.eyebrow,
    description: '照片与随手拍。',
    canonical: base + '/photos',
    body,
  });
}

function aboutPage(ctx) {
  const { site, base, loggedIn } = ctx;
  const content = site.about
    ? md.render(site.about)
    : '<p>这里还没写自我介绍。进后台「站点设置」补上就行。</p>';

  const body = [
    '<section class="home-hero home-hero--compact">',
    '<h1>About</h1>',
    '</section>',
    '<article class="post">',
    '<div class="prose">' + content + '</div>',
    '</article>',
  ].join('\n');

  return layout({
    site,
    active: '/about',
    loggedIn,
    title: 'About · ' + site.eyebrow,
    description: '关于这个站和写它的人。',
    canonical: base + '/about',
    body,
  });
}

function notFoundPage(ctx) {
  const { site, base, loggedIn } = ctx;
  const body = [
    '<section class="home-hero">',
    '<h1>404</h1>',
    '<p>这个地址没有内容。可能是链接写错了，或者这篇文章已经撤下。</p>',
    '<p class="text-link"><a href="/">返回首页 →</a></p>',
    '</section>',
  ].join('\n');

  return layout({
    site,
    active: '',
    loggedIn,
    title: '404 · ' + site.eyebrow,
    description: '页面不存在。',
    canonical: base + '/404',
    noIndex: true,
    body,
  });
}

function errorPage(ctx) {
  const { site, loggedIn } = ctx;
  const body = [
    '<section class="home-hero">',
    '<h1>服务器出错了</h1>',
    '<p>刚刚这个请求没有处理成功。刷新一下试试，或者回首页。</p>',
    '<p class="text-link"><a href="/">返回首页 →</a></p>',
    '</section>',
  ].join('\n');

  return layout({
    site,
    active: '',
    loggedIn,
    title: '出错了 · ' + site.eyebrow,
    noIndex: true,
    body,
  });
}

function feed(site, articles, base) {
  const items = articles
    .slice(0, 20)
    .map(
      (a) =>
        '    <item>\n' +
        '      <title>' +
        escXml(a.title) +
        '</title>\n' +
        '      <link>' +
        base +
        '/articles/' +
        a.slug +
        '</link>\n' +
        '      <guid isPermaLink="true">' +
        base +
        '/articles/' +
        a.slug +
        '</guid>\n' +
        '      <pubDate>' +
        new Date(a.date + 'T00:00:00Z').toUTCString() +
        '</pubDate>\n' +
        (a.summary ? '      <description>' + escXml(a.summary) + '</description>\n' : '') +
        '    </item>'
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    '    <title>' + escXml(site.eyebrow) + '</title>',
    '    <link>' + base + '/</link>',
    '    <description>' + escXml(site.heroSubtitle || site.heroTitle) + '</description>',
    '    <language>zh-CN</language>',
    '    <lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>',
    items,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sitemap(site, articles, notes, photos, base) {
  const urls = [
    { loc: base + '/', pri: '1.0' },
    { loc: base + '/articles', pri: '0.9' },
    { loc: base + '/notes', pri: '0.7' },
    { loc: base + '/photos', pri: '0.6' },
    { loc: base + '/about', pri: '0.5' },
  ]
    .concat(
      articles.map((a) => ({
        loc: base + '/articles/' + a.slug,
        pri: '0.8',
        lastmod: a.updated || a.date,
      }))
    );

  void notes;
  void photos;
  void site;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls
      .map(
        (u) =>
          '  <url><loc>' +
          escXml(u.loc) +
          '</loc>' +
          (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') +
          '<priority>' +
          u.pri +
          '</priority></url>'
      )
      .join('\n'),
    '</urlset>',
    '',
  ].join('\n');
}

function robots(base) {
  return ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api/', 'Sitemap: ' + base + '/sitemap.xml', ''].join(
    '\n'
  );
}

module.exports = {
  layout,
  head,
  header,
  footer,
  homePage,
  articlesPage,
  articlePage,
  notesPage,
  photosPage,
  aboutPage,
  notFoundPage,
  errorPage,
  feed,
  sitemap,
  robots,
};
