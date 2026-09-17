'use strict';

// 重设后台密码。
//   node tools/set-password.js 你的新密码
//   node tools/set-password.js --random
//   node tools/set-password.js --from-file /tmp/pw.txt   # 避免密码进 shell history
//   node tools/set-password.js                           # 交互式输入，不回显

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const auth = require('../lib/auth');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = function (chunk) {
      if (muted) {
        if (chunk.includes('\n')) rl.output.write('\n');
        return;
      }
      rl.output.write(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 9).join('\n'));
    return;
  }

  let password = '';

  if (args.includes('--random')) {
    password = crypto.randomBytes(9).toString('base64url');
  } else {
    const fileIdx = args.indexOf('--from-file');
    if (fileIdx !== -1) {
      const file = args[fileIdx + 1];
      if (!file) throw new Error('--from-file 后面要跟文件路径');
      password = (await fsp.readFile(file, 'utf8')).split('\n')[0].trim();
    } else {
      const positional = args.filter((a) => !a.startsWith('--'));
      if (positional.length) {
        password = positional.join(' ');
      } else if (process.stdin.isTTY) {
        password = await askHidden('新密码（输入不回显）：');
        const again = await askHidden('再输一遍：');
        if (password !== again) throw new Error('两次输入不一致');
      } else {
        password = (await new Promise((resolve) => {
          let buf = '';
          process.stdin.on('data', (d) => { buf += d; });
          process.stdin.on('end', () => resolve(buf));
        })).split('\n')[0].trim();
      }
    }
  }

  await auth.setPassword(DATA, password);
  const source = await auth.passwordSource(DATA);

  console.log('');
  console.log('  密码已写入 ' + auth.passwordFilePath(DATA));
  console.log('  ' + password);
  console.log('');
  if (source === 'env') {
    console.log('  ⚠️  但这个进程的环境里设了 ADMIN_PASSWORD —— 它的优先级更高，');
    console.log('     服务实际会用环境变量里的值，刚写的文件会被忽略。');
    console.log('     要生效：去掉环境变量（systemd 里删掉 Environment=ADMIN_PASSWORD=…），');
    console.log('     或者把环境变量也改成这个密码。');
  } else {
    console.log('  下次登录用它即可，服务不用重启。');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  失败：' + e.message + '\n');
  process.exit(1);
});
