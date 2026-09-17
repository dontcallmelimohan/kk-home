'use strict';

// 后台登不上时跑这个。它会从服务器本地逐项检查，并给出结论。
//   node tools/doctor.js                  # 默认探测 127.0.0.1:3000
//   node tools/doctor.js 8080
//   node tools/doctor.js --url http://127.0.0.1:3000

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const auth = require('../lib/auth');
const lab = require('../lib/lab');

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf('--url');
let RAW_URL = urlFlag !== -1 ? argv[urlFlag + 1] : null;
if (!RAW_URL) {
  const port = argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || '3000';
  RAW_URL = 'http://127.0.0.1:' + port;
}
const TARGET = new URL(RAW_URL);

const problems = [];
const notes = [];

function line(label, value) {
  console.log('  ' + label.padEnd(16, ' ') + value);
}

function fail(label, value, fix) {
  console.log('  ✗ ' + label.padEnd(14, ' ') + value);
  problems.push({ label, value, fix });
}

function pass(label, value) {
  console.log('  ✓ ' + label.padEnd(14, ' ') + (value === undefined ? '' : value));
}

function info(label, value) {
  console.log('  · ' + label.padEnd(14, ' ') + value);
}

function request(method, pathname, body, cookie) {
  const client = TARGET.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = client.request(
      {
        host: TARGET.hostname,
        port: TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80),
        path: pathname,
        method,
        headers: Object.assign(
          { Accept: 'application/json' },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          cookie ? { Cookie: cookie } : {}
        ),
        timeout: 6000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('超时（6 秒没响应）')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mask(value) {
  const s = String(value || '');
  if (!s) return '(空)';
  if (s.length <= 4) return s[0] + '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(1, s.length - 4)) + s.slice(-2) + '（' + s.length + ' 位）';
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass('Node 版本', process.version);
  else fail('Node 版本', process.version + '（需要 18 以上）', '升级 Node 到 18+');
}

async function checkFiles() {
  for (const rel of [
    'server.js',
    'public/admin.html',
    'public/assets/site.css',
    'lib/store.js',
    'lib/lab.js',
    'public/lab/_lab.css',
  ]) {
    try {
      await fsp.access(path.join(ROOT, rel));
    } catch {
      fail('缺少文件', rel, '把仓库完整传上去，不要只传 server.js');
    }
  }
  if (!problems.some((p) => p.label === '缺少文件')) pass('代码文件', '关键文件齐全');
}

// 实验区页面在磁盘上，路由却由 server.js 决定 ——
// 少传一个文件、或者静态映射写错，只有真打一遍才知道。
async function checkLab() {
  const broken = [];
  for (const item of lab.ITEMS) {
    try {
      const res = await request('GET', '/lab/' + item.slug);
      if (res.status !== 200) broken.push('/lab/' + item.slug + ' → ' + res.status);
    } catch (e) {
      broken.push('/lab/' + item.slug + ' → ' + (e.code || e.message));
    }
  }
  if (broken.length) {
    fail('实验区页面', broken.length + ' 个打不开', broken.join('，') + '；确认 public/lab/ 传全了');
  } else {
    pass('实验区页面', ' /lab 下 ' + lab.ITEMS.length + ' 个都能打开');
  }

  try {
    const res = await request('GET', '/lab');
    if (res.status === 200) pass('实验区索引', '/lab 可访问');
    else fail('实验区索引', '/lab → HTTP ' + res.status, '确认服务跑的是最新代码');
  } catch (e) {
    fail('实验区索引', '/lab → ' + (e.code || e.message), '服务可能没跑');
  }

  try {
    const probe = path.join(lab.UPLOAD_DIR, '.doctor-probe');
    await fsp.mkdir(lab.UPLOAD_DIR, { recursive: true });
    try {
      await fsp.writeFile(probe, 'ok');
    } finally {
      await fsp.unlink(probe).catch(() => {});
    }
    pass('上传目录可写', lab.UPLOAD_DIR);
  } catch (e) {
    fail(
      '上传目录不可写',
      lab.UPLOAD_DIR + ' → ' + (e.code || e.message),
      'chown -R $(whoami) ' + lab.UPLOAD_DIR + '  或 chmod -R u+w ' + lab.UPLOAD_DIR
    );
  }
}

async function checkDataDir() {
  try {
    const probe = path.join(DATA, '.doctor-probe');
    await fsp.mkdir(DATA, { recursive: true });
    try {
      await fsp.writeFile(probe, 'ok');
    } finally {
      await fsp.unlink(probe).catch(() => {});
    }
    pass('数据目录可写', DATA);
  } catch (e) {
    fail(
      '数据目录不可写',
      DATA + ' → ' + (e.code || e.message),
      'chown -R $(whoami) ' + DATA + '  或 chmod -R u+w ' + DATA
    );
  }

  try {
    const st = await fsp.stat(path.join(DATA, 'articles'));
    if (!st.isDirectory()) throw new Error('不是目录');
  } catch {
    fail('文章目录', 'data/articles 不存在', '启动一次服务会自动创建，或 mkdir -p ' + path.join(DATA, 'articles'));
  }
}

async function checkPassword() {
  const envSet = Boolean(process.env.ADMIN_PASSWORD);
  if (envSet) pass('环境变量', 'ADMIN_PASSWORD 已设置，掩码 ' + mask(process.env.ADMIN_PASSWORD));
  else info('环境变量', 'ADMIN_PASSWORD 未设置');

  let fileValue = '';
  try {
    fileValue = (await fsp.readFile(auth.passwordFilePath(DATA), 'utf8')).trim();
    pass('密码文件', auth.passwordFilePath(DATA) + '，掩码 ' + mask(fileValue));
  } catch (e) {
    if (e.code === 'ENOENT') {
      info('密码文件', '还不存在（服务首次启动会生成，或跑 node tools/set-password.js 自己设一个）');
    } else {
      fail('密码文件读取失败', e.code || e.message, '检查文件权限');
    }
  }

  return { envSet, fileValue };
}

async function checkService() {
  let health;
  try {
    const res = await request('GET', '/api/health');
    if (res.status !== 200) {
      fail('服务响应', TARGET.origin + '/api/health 返回 HTTP ' + res.status, '确认监听的是这个端口，且跑的是本仓库的 server.js');
      return null;
    }
    try {
      health = JSON.parse(res.raw);
    } catch {
      fail(
        '服务响应',
        TARGET.origin + ' 上有东西在跑，但不是本仓库的服务（/api/health 不是 JSON）',
        '可能旧进程还占着端口：lsof -i :' + (TARGET.port || 80) + '，杀掉后重新启动'
      );
      return null;
    }
    pass('服务在跑', TARGET.origin + '（' + health.service + '，已运行 ' + health.uptimeSec + ' 秒）');
  } catch (e) {
    fail(
      '连不上服务',
      TARGET.origin + ' → ' + (e.code || e.message),
      '服务没跑？cd ' + ROOT + ' && node server.js；若服务只监听内网地址，用 --url 指定实际地址'
    );
    return null;
  }

  if (health.service !== 'wenwen-blog') {
    fail('服务身份', '返回的 service 是 ' + health.service, '端口上不是这份代码');
  }
  if (health.dataWritable) pass('服务侧写权限', 'data/ 可写');
  else fail('服务侧写权限', 'data/ 不可写', '登录一定失败、文章一定存不进去：chown -R <运行用户> ' + health.dataDir);

  info('文章数', health.published + ' 篇已发布 / ' + health.drafts.length + ' 篇草稿');
  info('笔记 / 照片', health.notes + ' / ' + health.photos);
  if (health.lab) {
    info('实验区', health.lab.items + ' 个页面 / 留言 ' + health.lab.messages + ' 条 / 体重 ' + health.lab.weights + ' 天');
    if (!health.lab.uploadsWritable) {
      fail('上传目录不可写', health.lab.uploadsError || '未知原因', '相册将无法上传：chown -R <运行用户> ' + lab.UPLOAD_DIR);
    }
  }

  const sourceLabel = { env: '环境变量 ADMIN_PASSWORD', file: 'data/.admin-password', none: '（还没生成）' };
  info('服务用的密码来自', sourceLabel[health.passwordSource] || health.passwordSource);

  if (Array.isArray(health.lockedOut) && health.lockedOut.length) {
    const worst = Math.max.apply(null, health.lockedOut.map((l) => l.until));
    const mins = Math.ceil((worst - Date.now()) / 60000);
    fail(
      '账号被锁',
      '有 ' + health.lockedOut.length + ' 个来源被锁定，最长还需 ' + mins + ' 分钟',
      '锁定只存在内存里 —— 重启一次服务进程即可立刻解锁'
    );
  }

  return health;
}

async function checkLogin(health, creds) {
  if (!health) return;

  let candidate = null;
  if (health.passwordSource === 'env') {
    if (creds.envSet) {
      candidate = process.env.ADMIN_PASSWORD;
      info('登录探测', '用本 shell 的环境变量密码试');
    } else {
      info('登录探测', '跳过：服务用的是环境变量里的密码，本 shell 里没有同一个值，猜不出来');
      notes.push(
        '服务从环境变量取密码（systemd 的 Environment=ADMIN_PASSWORD=… 或启动脚本里的 export），' +
          '跟 data/.admin-password 无关。要么去那台机子的配置里找，要么重启时换成一个你知道的值。'
      );
    }
  } else if (health.passwordSource === 'file') {
    if (!creds.fileValue) {
      info('登录探测', '跳过：密码文件读不到');
    } else if (creds.envSet) {
      info('登录探测', '跳过：本 shell 的环境变量会盖过文件，而服务用的是文件');
      candidate = null;
      notes.push('当前 shell 里设了 ADMIN_PASSWORD，但服务用的是文件 —— 说明服务的进程环境没这个变量，属正常。');
    } else {
      candidate = creds.fileValue;
      info('登录探测', '用 data/.admin-password 里的值试');
    }
  } else {
    info('登录探测', '跳过：服务端还没有可用密码');
  }

  if (candidate === null) return;

  let res;
  try {
    res = await request('POST', '/api/auth/login', { password: candidate });
  } catch (e) {
    fail('登录探测', '请求失败：' + (e.code || e.message), '看服务进程的日志');
    return;
  }

  if (res.status === 200) {
    pass('登录探测', '用这个密码能登进去（HTTP 200）');
    const setCookie = res.headers['set-cookie'];
    if (setCookie && /ww_session=/.test(setCookie[0])) pass('会话 Cookie', '已下发');
    else fail('会话 Cookie', '响应里没有 ww_session', '检查是否有代理把 Set-Cookie 吃掉了');
    const cookie = setCookie ? setCookie[0].split(';')[0] : '';
    const boot = await request('GET', '/api/admin/bootstrap', undefined, cookie);
    if (boot.status === 200) pass('鉴权接口', '带 Cookie 读 bootstrap → 200');
    else fail('鉴权接口', '带 Cookie 读 bootstrap → HTTP ' + boot.status, 'Cookie 没被接受，看是否有代理改写响应头');
    return;
  }

  if (res.status === 401) {
    fail(
      '登录探测',
      '密码对不上（HTTP 401）',
      health.passwordSource === 'env'
        ? '服务用的是环境变量里的密码，改 data/.admin-password 没用'
        : '用 node tools/set-password.js 新密码 重设一个你确定的值'
    );
    return;
  }

  if (res.status === 429) {
    fail('登录探测', '被限流锁定（HTTP 429）', '重启一次服务进程即可立即解锁，不用等 10 分钟');
    return;
  }

  fail('登录探测', 'HTTP ' + res.status + ' → ' + res.raw.slice(0, 200), '看服务进程的日志里的 [login] 行');
}

async function main() {
  console.log('');
  console.log('  wenwen blog 后台体检');
  console.log('  仓库 ' + ROOT);
  console.log('  目标 ' + TARGET.origin);
  console.log('  ───────────────────────────────────────────');

  await checkNode();
  await checkFiles();
  await checkDataDir();
  const creds = await checkPassword();
  const health = await checkService();
  await checkLogin(health, creds);
  await checkLab();

  console.log('');
  console.log('  ───────────────────────────────────────────');
  if (!problems.length) {
    console.log('  结论：没查出问题。');
    console.log('  如果浏览器里还是登不上，按这两点查：');
    console.log('    1. 浏览器访问的地址要和服务实际监听的地址一致（上面那个 target）');
    console.log('    2. 走 Nginx 的话，看访问日志里 /api/auth/login 的返回码 —— 如果返回 200 但');
    console.log('       浏览器没保存 Cookie，通常是代理把响应头 Set-Cookie 吞了');
  } else {
    console.log('  结论：查出 ' + problems.length + ' 个问题，按顺序修：');
    problems.forEach((p, i) => {
      console.log('');
      console.log('   ' + (i + 1) + '. ' + p.label + '：' + p.value);
      if (p.fix) console.log('      → ' + p.fix);
    });
  }
  if (notes.length) {
    console.log('');
    console.log('  另外：');
    notes.forEach((n) => console.log('   · ' + n));
  }
  console.log('');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\n  体检脚本自己出错了：' + (e.stack || e.message) + '\n');
  process.exit(2);
});
