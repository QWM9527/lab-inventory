#!/usr/bin/env node
/**
 * 重置密码工具（忘记密码时用）
 * ---------------------------------
 * 直接改本机的 data/db.json，不需要旧密码，也不联网。
 * 用法：
 *   双击「重置密码.bat」                     交互式选择账号
 *   node reset_password.js root 新密码        直接指定账号和新密码
 *   node reset_password.js root 新密码 --force 程序正在运行也强制重置
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const readline = require('readline');

const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PBKDF2_ROUNDS = 200000;

function setUtf8Console() {
  if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  }
}

function hashPwd(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const dk = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ROUNDS, 32, 'sha256');
  return salt + '$' + dk.toString('hex');
}

/** 程序是不是还在跑？还在跑的话改文件会被它覆盖掉 */
function isServerRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/api/me', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(res.statusCode === 200 && body.indexOf('"user"') >= 0));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/**
 * 自己维护行缓冲来提问。
 * 不用 rl.question 的原因：它只在提问的瞬间监听输入行，
 * 用户一次性粘贴多行、或者用管道喂输入时，多出来的行会被丢掉。
 */
const lineQueue = [];
const waiters = [];
let inputClosed = false;

rl.on('line', (line) => {
  if (waiters.length) waiters.shift()(line);
  else lineQueue.push(line);
});
rl.on('close', () => {
  inputClosed = true;
  while (waiters.length) waiters.shift()(null);   // 输入结束 -> null，表示中断
});

function ask(q) {
  process.stdout.write(q);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => waiters.push(resolve));
}

/** 读一个输入，读到文件结束就退出（避免卡住或静默什么都没做） */
async function need(q) {
  const a = await ask(q);
  if (a === null) die('输入中断，什么都没改。');
  return a;
}

function die(msg) {
  console.log('');
  console.log('  ' + msg);
  console.log('');
  rl.close();
  process.exit(1);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    die('找不到数据文件：' + DB_FILE + '\n  说明这台电脑还没运行过程序，直接双击「启动.bat」即可。');
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    die('数据文件损坏，无法读取：' + e.message);
  }
  if (!Array.isArray(db.users) || !db.users.length) die('数据文件里没有任何账号，无法重置。');
  return db;
}

function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function roleText(r) {
  return r === 'super' ? '超级管理员' : (r === 'admin' ? '管理员' : '普通成员');
}

async function main() {
  setUtf8Console();
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const args = argv.filter((a) => a !== '--force');
  const portArg = args.find((a) => /^\d+$/.test(a) && Number(a) > 1024 && !/^\d{6,}$/.test(a));
  const port = portArg ? Number(portArg) : 8000;
  const clean = args.filter((a) => a !== portArg);

  console.log('');
  console.log('='.repeat(58));
  console.log('  实验室物资清点 —— 重置密码工具');
  console.log('='.repeat(58));

  if (await isServerRunning(port)) {
    if (!force) {
      console.log('');
      console.log('  ✗ 检测到程序正在运行（端口 ' + port + '）。');
      console.log('    如果现在改密码，程序保存数据时会把它覆盖回去。');
      console.log('');
      console.log('    请先关闭程序那个黑色窗口，再重新运行本工具。');
      console.log('    （确实要强行重置，就加参数 --force，然后立刻重启程序）');
      console.log('');
      rl.close();
      process.exit(1);
    }
    console.log('  注意：程序正在运行，本工具的修改会在它下次保存时被覆盖。');
    console.log('        请重置后立刻关闭并重启程序。');
  }

  const db = loadDb();
  let target;
  let newPwd;

  if (clean.length >= 2) {
    target = db.users.find((u) => u.username === clean[0] || String(u.id) === clean[0]);
    if (!target) die('找不到账号：' + clean[0]);
    newPwd = clean[1];
  } else {
    console.log('');
    console.log('  现有账号：');
    db.users.forEach((u, i) => {
      console.log('    ' + (i + 1) + '. ' + u.username + '  （' + u.display_name + ' / ' +
        roleText(u.role) + (u.active ? '' : ' / 已停用') + '）');
    });
    console.log('');
    const pick = await need('  要重置哪个账号？输入前面的序号或账号名：');
    const p = pick.trim();
    target = db.users.find((u) => u.username === p || String(u.id) === p) ||
             db.users[Number(p) - 1];
    if (!target) die('输入有误，没找到这个账号。');
    newPwd = await need('  给「' + target.username + '」设置新密码（至少 6 位）：');
  }

  if (!newPwd || String(newPwd).length < 6) die('密码太短，至少要 6 位。');

  if (clean.length < 2) {
    const again = await need('  再输一次新密码：');
    if (again !== newPwd) die('两次输入不一致，已取消。');
  }

  target.pwd = hashPwd(newPwd);
  target.active = 1;                       // 顺便把停用的账号恢复启用，否则还是登不上
  saveDb(db);

  // 超级管理员的初始密码文件已无意义，删掉免得误导
  const pwdFile = path.join(__dirname, 'data', '超级管理员初始密码.txt');
  if (target.role === 'super' && fs.existsSync(pwdFile)) {
    try { fs.unlinkSync(pwdFile); } catch (e) { /* 忽略 */ }
  }

  console.log('');
  console.log('  ✓ 已重置');
  console.log('      账号：' + target.username);
  console.log('      密码：' + newPwd);
  console.log('      角色：' + roleText(target.role) + (target.active ? '（已启用）' : ''));
  console.log('');
  console.log('  现在关闭这个窗口，双击「启动.bat」，用上面的账号密码登录。');
  console.log('='.repeat(58));
  rl.close();
}

main().catch((e) => {
  console.log('\n  出错了：' + e.message + '\n');
  try { rl.close(); } catch (err) { /* 忽略 */ }
  process.exit(1);
});
