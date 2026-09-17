'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const md = require('./markdown');
const util = require('./util');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ARTICLE_DIR = path.join(DATA_DIR, 'articles');
const HISTORY_DIR = path.join(DATA_DIR, '.history');

const DEFAULTS = {
  site: {
    eyebrow: 'wenwen blog',
    heroTitle: '',
    heroSubtitle: '',
    coverSlug: '',
    about: '',
    footerNote: '',
  },
};

async function ensure() {
  await fsp.mkdir(ARTICLE_DIR, { recursive: true });
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  for (const [name, fallback] of [
    ['site.json', DEFAULTS.site],
    ['notes.json', []],
    ['photos.json', []],
  ]) {
    const file = path.join(DATA_DIR, name);
    try {
      await fsp.access(file);
    } catch {
      await writeJsonAtomic(file, fallback);
    }
  }
}

async function writeFileAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

/* ---------------- frontmatter ---------------- */

function unquote(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(raw) {
  const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/);
  if (!m) return { data: {}, body: text };

  const data = {};
  m[1].split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) return;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((t) => unquote(t))
        .filter(Boolean);
    } else if (value === 'true' || value === 'false') {
      data[key] = value === 'true';
    } else {
      data[key] = unquote(value);
    }
  });

  return { data, body: text.slice(m[0].length) };
}

function serializeFrontmatter(data, body) {
  const lines = ['---'];
  const order = ['title', 'date', 'updated', 'category', 'summary', 'tags', 'draft'];
  const keys = order.concat(Object.keys(data).filter((k) => !order.includes(k)));
  const seen = new Set();
  keys.forEach((key) => {
    if (seen.has(key)) return;
    const value = data[key];
    if (value === undefined || value === null || value === '') return;
    seen.add(key);
    if (Array.isArray(value)) {
      lines.push(key + ': [' + value.join(', ') + ']');
    } else {
      lines.push(key + ': ' + String(value).replace(/\n/g, ' '));
    }
  });
  lines.push('---', '');
  return lines.join('\n') + String(body || '').replace(/^\n+/, '');
}

/* ---------------- 文章 ---------------- */

function articlePath(slug) {
  return path.join(ARTICLE_DIR, slug + '.md');
}

async function listSlugs() {
  try {
    const files = await fsp.readdir(ARTICLE_DIR);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function shape(slug, data, body) {
  const date = util.formatDate(data.date);
  return {
    slug,
    title: data.title || slug,
    date,
    updated: data.updated ? util.formatDate(data.updated) : '',
    category: data.category || 'Essay',
    summary: data.summary || md.excerpt(body, 90),
    tags: Array.isArray(data.tags) ? data.tags : [],
    draft: data.draft === true,
    body: String(body || ''),
    minutes: md.readingMinutes(body),
    chars: md.plainText(body).replace(/\s/g, '').length,
  };
}

async function getArticle(slug) {
  if (!util.isValidSlug(slug)) return null;
  try {
    const raw = await fsp.readFile(articlePath(slug), 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return shape(slug, data, body);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function listArticles(options) {
  const opts = options || {};
  const slugs = await listSlugs();
  const items = await Promise.all(slugs.map((slug) => getArticle(slug)));
  const list = items
    .filter(Boolean)
    .filter((a) => (opts.includeDrafts ? true : !a.draft))
    .sort((a, b) => {
      if (a.date === b.date) return a.slug < b.slug ? 1 : -1;
      return a.date < b.date ? 1 : -1;
    });
  return list;
}

async function snapshot(slug, reason) {
  try {
    const raw = await fsp.readFile(articlePath(slug), 'utf8');
    const dir = path.join(HISTORY_DIR, slug);
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFileAtomic(path.join(dir, stamp + '__' + reason + '.md'), raw);
    await pruneHistory(slug, 40);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

async function listHistory(slug) {
  if (!util.isValidSlug(slug)) return [];
  const dir = path.join(HISTORY_DIR, slug);
  try {
    const files = await fsp.readdir(dir);
    const entries = await Promise.all(
      files
        .filter((f) => f.endsWith('.md'))
        .map(async (file) => {
          const stat = await fsp.stat(path.join(dir, file));
          const parts = file.replace(/\.md$/, '').split('__');
          return {
            file,
            at: parts[0] || '',
            reason: parts[1] || 'save',
            size: stat.size,
          };
        })
    );
    return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function pruneHistory(slug, keep) {
  const entries = await listHistory(slug);
  const extra = entries.slice(keep);
  await Promise.all(
    extra.map((e) => fsp.unlink(path.join(HISTORY_DIR, slug, e.file)).catch(() => {}))
  );
}

// 改 slug 之后，历史版本要跟着文章走，否则旧目录会变成没人认领的孤儿
async function moveHistory(from, to) {
  if (from === to) return;
  const src = path.join(HISTORY_DIR, from);
  const dst = path.join(HISTORY_DIR, to);
  try {
    await fsp.access(src);
  } catch {
    return;
  }
  await fsp.mkdir(dst, { recursive: true });
  const files = await fsp.readdir(src);
  for (const file of files) {
    const target = path.join(dst, file);
    try {
      await fsp.access(target);
      await fsp.rename(path.join(src, file), path.join(dst, Date.now() + '-' + file));
    } catch {
      await fsp.rename(path.join(src, file), target).catch(() => {});
    }
  }
  await fsp.rmdir(src).catch(() => {});
}

const HISTORY_FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z__[a-z-]+\.md$/;

async function restoreHistory(slug, file) {
  if (!util.isValidSlug(slug)) throw Object.assign(new Error('slug 不合法'), { status: 400 });
  const name = String(file || '');
  if (!HISTORY_FILE_RE.test(name) || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('历史文件名不合法'), { status: 400 });
  }
  const target = path.join(HISTORY_DIR, slug, name);
  const raw = await fsp.readFile(target, 'utf8');
  await snapshot(slug, 'before-restore');
  await writeFileAtomic(articlePath(slug), raw);
  return getArticle(slug);
}

async function saveArticle(input) {
  const payload = input || {};
  const slug = String(payload.slug || '').trim();
  const original = String(payload.originalSlug || '').trim();
  if (!util.isValidSlug(slug)) {
    throw Object.assign(new Error('slug 只能用小写字母、数字和连字符'), { status: 400 });
  }

  let createdAt = '';
  if (original && original !== slug && util.isValidSlug(original)) {
    const prev = await getArticle(original);
    if (prev) {
      createdAt = prev.date;
      await snapshot(original, 'renamed');
      await fsp.unlink(articlePath(original)).catch(() => {});
      await moveHistory(original, slug);
    }
  }

  const existing = await getArticle(slug);
  if (existing) {
    createdAt = createdAt || existing.date;
    await snapshot(slug, 'save');
  }

  const body = String(payload.body || '').replace(/\r\n?/g, '\n');
  const data = {
    title: String(payload.title || '').trim() || slug,
    date: util.formatDate(payload.date || createdAt || util.today()),
    category: String(payload.category || 'Essay').trim() || 'Essay',
    summary: String(payload.summary || '').trim(),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((t) => String(t).trim()).filter(Boolean)
      : String(payload.tags || '')
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
    draft: payload.draft === true,
  };
  if (existing) data.updated = util.today();

  await writeFileAtomic(articlePath(slug), serializeFrontmatter(data, body));
  return getArticle(slug);
}

async function deleteArticle(slug) {
  if (!util.isValidSlug(slug)) throw Object.assign(new Error('slug 不合法'), { status: 400 });
  const existing = await getArticle(slug);
  if (!existing) return false;
  await snapshot(slug, 'delete');
  await fsp.unlink(articlePath(slug));
  return true;
}

async function takenSlugs(except) {
  const slugs = await listSlugs();
  return new Set(slugs.filter((s) => s !== except));
}

/* ---------------- 站点设置 / 笔记 / 照片 ---------------- */

async function getSite() {
  const site = await readJson(path.join(DATA_DIR, 'site.json'), DEFAULTS.site);
  return Object.assign({}, DEFAULTS.site, site);
}

async function saveSite(patch) {
  const current = await getSite();
  const next = Object.assign({}, current, patch || {});
  next.eyebrow = String(next.eyebrow || '').slice(0, 60);
  next.heroTitle = String(next.heroTitle || '').slice(0, 120);
  next.heroSubtitle = String(next.heroSubtitle || '').slice(0, 200);
  next.footerNote = String(next.footerNote || '').slice(0, 200);
  next.coverSlug = util.isValidSlug(next.coverSlug) ? next.coverSlug : '';
  next.about = String(next.about || '');
  await writeJsonAtomic(path.join(DATA_DIR, 'site.json'), next);
  return next;
}

async function getNotes() {
  const notes = await readJson(path.join(DATA_DIR, 'notes.json'), []);
  return Array.isArray(notes) ? notes : [];
}

async function saveNotes(notes) {
  const list = (Array.isArray(notes) ? notes : []).map((n) => ({
    id: String(n.id || util.randomId()),
    text: String(n.text || '').trim().slice(0, 300),
    date: n.date ? util.formatDate(n.date) : '',
  })).filter((n) => n.text);
  list.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  await writeJsonAtomic(path.join(DATA_DIR, 'notes.json'), list);
  return list;
}

async function getPhotos() {
  const photos = await readJson(path.join(DATA_DIR, 'photos.json'), []);
  return Array.isArray(photos) ? photos : [];
}

async function savePhotos(photos) {
  const list = (Array.isArray(photos) ? photos : []).map((p) => ({
    id: String(p.id || util.randomId()),
    title: String(p.title || '').trim().slice(0, 80),
    caption: String(p.caption || '').trim().slice(0, 400),
    date: p.date ? util.formatDate(p.date) : '',
    src: String(p.src || '').trim().slice(0, 400),
  })).filter((p) => p.title || p.caption);
  await writeJsonAtomic(path.join(DATA_DIR, 'photos.json'), list);
  return list;
}

module.exports = {
  ROOT,
  DATA_DIR,
  ARTICLE_DIR,
  HISTORY_DIR,
  ensure,
  parseFrontmatter,
  serializeFrontmatter,
  getSite,
  saveSite,
  getNotes,
  saveNotes,
  getPhotos,
  savePhotos,
  listArticles,
  getArticle,
  saveArticle,
  deleteArticle,
  listHistory,
  restoreHistory,
  takenSlugs,
};
