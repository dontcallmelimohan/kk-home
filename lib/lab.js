'use strict';

// 实验区（/lab）的存储层。
//
// 这里的东西和博客正文分开存：
//   data/lab/messages.json  留言板 —— 访客公开可写，所以要限流、限长、限总量
//   data/lab/weights.json   体重记录 —— 个人数据，全程需要登录
//   data/uploads/           上传的照片文件本体（博客的 /photos 与实验区相册共用一份）
//
// 写入一律走 tmp + rename，不允许出现写坏一半的 JSON。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('./util');
const store = require('./store');

const LAB_DATA_DIR = path.join(store.DATA_DIR, 'lab');
const UPLOAD_DIR = path.join(store.DATA_DIR, 'uploads');
const MESSAGES_FILE = path.join(LAB_DATA_DIR, 'messages.json');
const WEIGHTS_FILE = path.join(LAB_DATA_DIR, 'weights.json');

const LIMITS = {
  messageLen: 200,
  messagesTotal: 500,
  messagePerMinute: 3,
  weightNote: 60,
  weightPerMinute: 30,
  weightsTotal: 5000,
  uploadBytes: 6 * 1024 * 1024,
  uploadsTotal: 400,
  markdownChars: 20000,
  markdownPerMinute: 60,
};

// 上传白名单：只收浏览器能安全内联显示的位图格式。
// 刻意不收 SVG —— 它能内嵌 <script>，一旦被当图片直接打开就是任意脚本执行点。
const UPLOAD_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
};

const UPLOAD_NAME_RE = /^[a-z0-9][a-z0-9-]*\.(png|jpg|gif|webp|avif)$/;

// 实验区目录。索引页、冒烟测试、体检脚本都从这里取，
// 免得漏加一个页面之后只有人肉点一遍才发现。
const ITEMS = [
  {
    slug: '2048',
    kicker: 'Game',
    title: '2048',
    note: '把相同的数字推到一起。纯前端，最高分存在你自己的浏览器里。',
    hint: '方向键或滑动',
    home: true,
  },
  {
    slug: 'markdown',
    kicker: 'Tool',
    title: 'Markdown 编辑器',
    note: '左边写、右边实时预览。用的是这个站自己的渲染器，所以在这里看到的样子就是文章发出去的样子。',
    hint: '草稿留在浏览器',
  },
  {
    slug: 'note',
    kicker: 'Public',
    title: '留言板',
    note: '谁都能留一句，存在服务器上。带频率限制，登录之后可以删。',
    hint: '公开可写',
  },
  {
    slug: 'photo',
    kicker: 'Album',
    title: '相册',
    note: '传上来的照片直接进站点的照片墙，和 Photos 是同一份数据。',
    hint: '上传需登录',
  },
  {
    slug: 'weight',
    kicker: 'Private',
    title: '体重记录',
    note: '一天一条，折线看趋势。数据只落在你自己的服务器上。',
    hint: '需登录',
  },
  {
    slug: 'draw',
    kicker: 'Tool',
    title: '画板',
    note: '涂两笔，撤销重做，存成 PNG。触屏和鼠标都能画。',
    hint: '支持触屏',
    home: true,
  },
  {
    slug: 'glass',
    kicker: 'Device',
    title: '触感玻璃键盘',
    note: '3×3 毛玻璃按键，按下去有回弹和震动。',
    hint: '建议用手机',
  },
];

/* ---------------- 基础设施 ---------------- */

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
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function ensure() {
  await fsp.mkdir(LAB_DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  for (const [file, fallback] of [
    [MESSAGES_FILE, []],
    [WEIGHTS_FILE, []],
  ]) {
    try {
      await fsp.access(file);
    } catch {
      await writeJsonAtomic(file, fallback);
    }
  }
}

function bad(message, status) {
  return Object.assign(new Error(message), { status: status || 400 });
}

// 内存里的滑动窗口限流。公开可写的接口必须有个闸，
// 否则一个脚本就能把留言板刷满、或者把 Markdown 渲染接口当成免费算力。
const hits = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return { ok: false, retryAfterMs: windowMs - (now - list[0]) };
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) {
    hits.forEach((v, k) => {
      if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    });
  }
  return { ok: true };
}

/* ---------------- 留言板 ---------------- */

async function getMessages() {
  const list = await readJson(MESSAGES_FILE, []);
  return Array.isArray(list) ? list : [];
}

async function addMessage(raw, ip) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!text) throw bad('留言不能是空的');
  if (text.length > LIMITS.messageLen) {
    throw bad('留言最长 ' + LIMITS.messageLen + ' 个字');
  }

  const gate = rateLimit('msg:' + ip, LIMITS.messagePerMinute, 60 * 1000);
  if (!gate.ok) {
    throw bad('发得太快了，' + Math.ceil(gate.retryAfterMs / 1000) + ' 秒后再试', 429);
  }

  const list = await getMessages();
  if (list.length >= LIMITS.messagesTotal) {
    throw bad('留言已经到上限（' + LIMITS.messagesTotal + ' 条），去后台清一清', 429);
  }

  const item = { id: util.randomId(), content: text, at: new Date().toISOString() };
  list.unshift(item);
  await writeJsonAtomic(MESSAGES_FILE, list);
  return { message: item, messages: list };
}

async function deleteMessage(id) {
  const key = String(id || '');
  if (!key) throw bad('缺少留言 id');
  const list = await getMessages();
  const next = list.filter((m) => m.id !== key);
  if (next.length === list.length) throw bad('这条留言已经不在了', 404);
  await writeJsonAtomic(MESSAGES_FILE, next);
  return { removed: true, messages: next };
}

/* ---------------- 体重记录 ---------------- */

async function getWeights() {
  const list = await readJson(WEIGHTS_FILE, []);
  const items = Array.isArray(list) ? list : [];
  return items.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

async function saveWeight(input, ip) {
  const payload = input || {};
  const kg = Number(payload.kg);
  if (!Number.isFinite(kg)) throw bad('体重得是个数字');
  if (kg < 20 || kg > 400) throw bad('体重超出合理范围（20–400 kg）');
  const rounded = Math.round(kg * 10) / 10;

  const gate = rateLimit('kg:' + ip, LIMITS.weightPerMinute, 60 * 1000);
  if (!gate.ok) throw bad('操作太频繁了，稍等一下', 429);

  const date = util.formatDate(payload.date || util.today());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('日期格式要对，例如 2026-09-17');

  const note = String(payload.note || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.weightNote);

  // 一天一条：同一天再填就是修正当天的记录，而不是又堆一条出来。
  // 否则手抖点两下提交，折线图上就会多出一个假的坑。
  const list = await getWeights();
  const existing = list.find((w) => w.date === date);
  if (existing) {
    existing.kg = rounded;
    existing.note = note;
    existing.updatedAt = new Date().toISOString();
    await writeJsonAtomic(WEIGHTS_FILE, list);
    return { weight: existing, replaced: true, weights: list };
  }

  if (list.length >= LIMITS.weightsTotal) {
    throw bad('记录太多了（上限 ' + LIMITS.weightsTotal + ' 条）', 429);
  }
  const item = { id: util.randomId(), date, kg: rounded, note, at: new Date().toISOString() };
  list.push(item);
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await writeJsonAtomic(WEIGHTS_FILE, list);
  return { weight: item, replaced: false, weights: list };
}

async function deleteWeight(id) {
  const key = String(id || '');
  if (!key) throw bad('缺少记录 id');
  const list = await getWeights();
  const next = list.filter((w) => w.id !== key);
  if (next.length === list.length) throw bad('这条记录已经不在了', 404);
  await writeJsonAtomic(WEIGHTS_FILE, next);
  return { removed: true, weights: next };
}

async function clearWeights() {
  await writeJsonAtomic(WEIGHTS_FILE, []);
  return { removed: true, weights: [] };
}

/* ---------------- 相册 ---------------- */

function uploadPath(name) {
  return path.join(UPLOAD_DIR, name);
}

// 只接受我们自己生成的形状：小写字母数字加连字符 + 白名单扩展名。
// 任何带斜杠、点开头、或者别的扩展名的名字一律不认，路径穿越就没入口。
function isSafeUploadName(name) {
  return UPLOAD_NAME_RE.test(String(name || ''));
}

function uploadMime(name) {
  const ext = path.extname(String(name)).toLowerCase();
  const found = Object.keys(UPLOAD_TYPES).find((k) => UPLOAD_TYPES[k] === ext);
  return found || 'application/octet-stream';
}

function uploadSrc(name) {
  return '/uploads/' + name;
}

function uploadNameFromSrc(src) {
  const s = String(src || '');
  if (!s.startsWith('/uploads/')) return null;
  const name = s.slice('/uploads/'.length);
  return isSafeUploadName(name) ? name : null;
}

// src 不带扩展名时按 URL 去重，带扩展名时再比文件名
async function addPhoto(buffer, contentType, originalName) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[type];
  if (!ext) {
    throw bad('只支持 PNG / JPEG / GIF / WebP / AVIF，收到的是 ' + (type || '未知类型'), 415);
  }
  if (!buffer || !buffer.length) throw bad('文件是空的');
  if (buffer.length > LIMITS.uploadBytes) {
    throw bad('文件太大（上限 ' + Math.round(LIMITS.uploadBytes / 1024 / 1024) + ' MB）', 413);
  }

  const photos = await store.getPhotos();
  if (photos.length >= LIMITS.uploadsTotal) {
    throw bad('照片已经到上限（' + LIMITS.uploadsTotal + ' 张）', 429);
  }

  const stamp = util.today().replace(/-/g, '');
  const name = stamp + '-' + util.randomId() + ext;
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const tmp = uploadPath(name) + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, uploadPath(name));

  // 原始文件名去掉扩展名当作标题，这样前台 alt 文本不是空的
  const title = String(originalName || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const entry = {
    id: util.randomId(),
    title: title || '照片',
    caption: '',
    date: util.today(),
    src: uploadSrc(name),
  };
  const next = await store.savePhotos(photos.concat([entry]));
  return { photo: entry, photos: next, bytes: buffer.length };
}

async function deletePhoto(id) {
  const key = String(id || '');
  if (!key) throw bad('缺少照片 id');
  const photos = await store.getPhotos();
  const target = photos.find((p) => p.id === key);
  if (!target) throw bad('这张照片已经不在了', 404);

  const next = photos.filter((p) => p.id !== key);
  await store.savePhotos(next);

  // 只有没有任何一条记录还引用这个文件时才真删。
  // 后台可以给同一张图建多条记录，贸然删文件会把别人的图弄成裂图。
  const name = uploadNameFromSrc(target.src);
  if (name && !next.some((p) => p.src === target.src)) {
    await fsp.unlink(uploadPath(name)).catch(() => {});
  }
  return { removed: true, photos: next };
}

module.exports = {
  LAB_DATA_DIR,
  UPLOAD_DIR,
  MESSAGES_FILE,
  WEIGHTS_FILE,
  LIMITS,
  UPLOAD_TYPES,
  ITEMS,
  ensure,
  rateLimit,
  getMessages,
  addMessage,
  deleteMessage,
  getWeights,
  saveWeight,
  deleteWeight,
  clearWeights,
  isSafeUploadName,
  uploadMime,
  uploadPath,
  uploadSrc,
  addPhoto,
  deletePhoto,
};
