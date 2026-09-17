'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const util = require('./util');

const COOKIE_NAME = 'ww_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const LOCK_MS = 10 * 60 * 1000;

const attempts = new Map();

let cachedSecret = null;

async function getSecret(dataDir) {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  const file = path.join(dataDir, '.session-secret');
  try {
    const raw = (await fsp.readFile(file, 'utf8')).trim();
    if (raw.length >= 32) {
      cachedSecret = raw;
      return cachedSecret;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(file, fresh, { encoding: 'utf8', mode: 0o600 });
  cachedSecret = fresh;
  return cachedSecret;
}

// 首次启动若未配置 ADMIN_PASSWORD，就生成一个随机密码落盘并打印，
// 避免出现任何人可猜的默认口令
const PASSWORD_FILE = '.admin-password';

function passwordFilePath(dataDir) {
  return path.join(dataDir, PASSWORD_FILE);
}

// 只报告密码来自哪里，不落盘、不生成
async function passwordSource(dataDir) {
  if (process.env.ADMIN_PASSWORD) return 'env';
  try {
    const raw = (await fsp.readFile(passwordFilePath(dataDir), 'utf8')).trim();
    return raw ? 'file' : 'none';
  } catch (e) {
    if (e.code === 'ENOENT') return 'none';
    throw e;
  }
}

async function getPassword(dataDir) {
  if (process.env.ADMIN_PASSWORD) {
    return { password: process.env.ADMIN_PASSWORD, generated: false, source: 'env' };
  }
  const file = passwordFilePath(dataDir);
  try {
    const raw = (await fsp.readFile(file, 'utf8')).trim();
    if (raw) return { password: raw, generated: false, source: 'file' };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const generated = crypto.randomBytes(9).toString('base64url');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(file, generated, { encoding: 'utf8', mode: 0o600 });
  return { password: generated, generated: true, source: 'file' };
}

// 从命令行重设密码用；环境变量优先级更高，此时文件会被忽略
async function setPassword(dataDir, value) {
  const password = String(value == null ? '' : value).trim();
  if (password.length < 6) throw new Error('密码至少 6 位');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(passwordFilePath(dataDir), password + '\n', { encoding: 'utf8', mode: 0o600 });
  return password;
}

async function verifyPassword(dataDir, candidate) {
  const { password, generated, source } = await getPassword(dataDir);
  const a = Buffer.from(String(candidate == null ? '' : candidate), 'utf8');
  const b = Buffer.from(password, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { ok, generated, source };
}

async function issueToken(dataDir) {
  const secret = await getSecret(dataDir);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

async function verifyToken(dataDir, token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const secret = await getSecret(dataDir);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function isLoggedIn(req, dataDir) {
  const cookies = util.parseCookies(req.headers.cookie);
  return verifyToken(dataDir, cookies[COOKIE_NAME]);
}

function setSessionCookie(res, token, secure) {
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res, secure) {
  const parts = [COOKIE_NAME + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRate(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { blocked: false, remaining: MAX_ATTEMPTS };
  if (entry.until && entry.until > Date.now()) {
    return { blocked: true, retryAfterMs: entry.until - Date.now() };
  }
  if (entry.until && entry.until <= Date.now()) attempts.delete(ip);
  return { blocked: false, remaining: MAX_ATTEMPTS - (attempts.get(ip)?.count || 0) };
}

function recordFailure(ip) {
  const entry = attempts.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.until = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  attempts.set(ip, entry);
  return entry.until > Date.now();
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

// 锁定状态存在内存里：重启进程即可立即解锁
function lockStatus() {
  const now = Date.now();
  const locked = [];
  attempts.forEach((entry, ip) => {
    if (entry.until && entry.until > now) locked.push({ ip, until: entry.until });
  });
  return locked;
}

function clearLocks() {
  attempts.clear();
}

module.exports = {
  COOKIE_NAME,
  PASSWORD_FILE,
  passwordFilePath,
  passwordSource,
  getPassword,
  setPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  isLoggedIn,
  setSessionCookie,
  clearSessionCookie,
  clientIp,
  checkRate,
  recordFailure,
  recordSuccess,
  lockStatus,
  clearLocks,
};
