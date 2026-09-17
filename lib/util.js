'use strict';

const crypto = require('crypto');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(input) {
  const raw = String(input == null ? '' : input).trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toISOString().slice(0, 10);
}

function today() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function slugify(input) {
  return String(input == null ? '' : input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function isValidSlug(slug) {
  return SLUG_RE.test(String(slug || ''));
}

// 中文标题走不了 slugify，退化成日期加序号，保证地址永远可读、可预测
function suggestSlug(title, taken) {
  const ascii = slugify(title);
  if (ascii && ascii.length >= 2 && !/^\d+$/.test(ascii)) {
    let candidate = ascii;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = ascii + '-' + n;
      n++;
    }
    return candidate;
  }
  const base = today().replace(/-/g, '');
  let candidate = 'note-' + base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = 'note-' + base + '-' + n;
    n++;
  }
  return candidate;
}

function randomId() {
  return crypto.randomBytes(6).toString('hex');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': (contentType || 'text/plain') + '; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  const max = limit || 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
  return out;
}

function esc(s) {
  return escapeHtml(s);
}

module.exports = {
  escapeHtml,
  esc,
  formatDate,
  today,
  slugify,
  isValidSlug,
  suggestSlug,
  randomId,
  sendJson,
  sendText,
  readBody,
  parseCookies,
};
