#!/usr/bin/env node
/**
 * 数据同步工具：本机版 <-> 云端版
 * ================================
 * 本机版数据在 data/db.json，云端版在 Cloudflare D1，两边本来是各存各的。
 * 这个工具让你把「物资 + 出入库流水」整体从一个地方搬到另一个地方。
 *
 * 注意：
 *   · 只同步【物资】和【流水】，不动【账号密码】—— 两边密码各留各的，避免登录乱掉
 *   · 是「整体覆盖」，不是合并：比如「本机 → 云端」就是用本机的账目完全替换云端的
 *   · 覆盖之前会自动备份被覆盖的那一边，随时能还原
 *
 * 用法：双击「同步数据.bat」
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const BASE_DIR = __dirname;
const DB_FILE = path.join(BASE_DIR, 'data', 'db.json');
const CONFIG_FILE = path.join(BASE_DIR, 'sync.config.json');
const BACKUP_DIR = path.join(BASE_DIR, 'data', 'backup');

const API_HOST = 'api.cloudflare.com';
const BATCH = 20;                      // 每条 SQL 最多塞多少行

const ITEM_COLS = ['id', 'name', 'category', 'spec', 'unit', 'location', 'qty', 'min_qty', 'note', 'created_at', 'updated_at'];
const REC_COLS = ['id', 'item_id', 'item_name', 'item_unit', 'type', 'qty', 'before_qty', 'after_qty', 'operator', 'operator_id', 'note', 'created_at'];

/* ---------------- 控制台 ---------------- */

function setUtf8Console() {
  if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lineQueue = [];
const waiters = [];
let inputClosed = false;

rl.on('line', (l) => { if (waiters.length) waiters.shift()(l); else lineQueue.push(l); });
rl.on('close', () => { inputClosed = true; while (waiters.length) waiters.shift()(null); });

function ask(q) {
  process.stdout.write(q);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((res) => waiters.push(res));
}

async function need(q) {
  const a = await ask(q);
  if (a === null) { console.log('\n  输入中断，什么都没做。\n'); rl.close(); process.exit(1); }
  return a;
}

function line() { console.log('-'.repeat(60)); }
function die(msg) { console.log('\n  ' + msg + '\n'); rl.close(); process.exit(1); }

/* ---------------- HTTP ---------------- */

function httpJson(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: API_HOST, path: urlPath, method: method,
      headers: Object.assign({
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 30000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        if (!json) return reject(new Error('接口返回异常（HTTP ' + res.statusCode + '）：' + raw.slice(0, 200)));
        if (!json.success) {
          const msg = (json.errors || []).map((e) => e.message || JSON.stringify(e)).join('; ');
          return reject(new Error(msg || ('请求失败 HTTP ' + res.statusCode)));
        }
        resolve(json);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时（检查网络）')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- 云端 D1 ---------------- */

let cfg = null;

async function d1(sql, params) {
  const p = `/client/v4/accounts/${cfg.account_id}/d1/database/${cfg.database_id}/query`;
  const r = await httpJson('POST', p, cfg.api_token, { sql: sql, params: params || [] });
  const first = (r.result || [])[0] || {};
  if (first.success === false) throw new Error('SQL 执行失败：' + sql.slice(0, 80));
  return first.results || [];
}

async function cloudCounts() {
  const a = await d1('SELECT COUNT(*) AS c FROM items');
  const b = await d1('SELECT COUNT(*) AS c FROM records');
  return { items: a[0].c, records: b[0].c };
}

async function cloudAll() {
  return {
    items: await d1('SELECT * FROM items ORDER BY id'),
    records: await d1('SELECT * FROM records ORDER BY id'),
  };
}

async function cloudReplace(items, records) {
  await d1('DELETE FROM records');
  await d1('DELETE FROM items');
  await insertRows('items', ITEM_COLS, items);
  await insertRows('records', REC_COLS, records);
}

async function insertRows(table, cols, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const sql = 'INSERT INTO ' + table + '(' + cols.join(',') + ') VALUES ' +
      chunk.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
    const params = [];
    chunk.forEach((r) => cols.forEach((c) => params.push(r[c] === undefined ? null : r[c])));
    await d1(sql, params);
    process.stdout.write('\r  已写入 ' + table + ' ' + Math.min(i + BATCH, rows.length) + '/' + rows.length + ' 行   ');
  }
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
}

/* ---------------- 本机数据 ---------------- */

function readLocal() {
  if (!fs.existsSync(DB_FILE)) die('找不到本机数据文件：' + DB_FILE + '\n  请先双击「启动.bat」运行一次。');
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeLocal(db, items, records) {
  const keep = {
    users: db.users || [],
    sessions: db.sessions || {},
    seq: db.seq || { user: 0, item: 0, record: 0 },
  };
  backUp('local', db);
  const maxId = (arr) => arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  const out = {
    users: keep.users,
    items: items,
    records: records,
    sessions: keep.sessions,
    seq: {
      user: Math.max(keep.seq.user || 0, ...keep.users.map((u) => Number(u.id) || 0), 0),
      item: maxId(items),
      record: maxId(records),
    },
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(out, null, 1), 'utf8');
}

function backUp(tag, payload) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    const file = path.join(BACKUP_DIR, tag + '-sync-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(payload, null, 1), 'utf8');
    return file;
  } catch (e) { return null; }
}

/* ---------------- 配置 ---------------- */

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return null;
}

function saveConfig(c) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 1), 'utf8');
}

async function setupConfig() {
  let dbId = '';
  try {
    const wt = fs.readFileSync(path.join(BASE_DIR, 'wrangler.toml'), 'utf8');
    const m = wt.match(/database_id\s*=\s*"([^"]+)"/);
    if (m) dbId = m[1];
  } catch (e) { /* 忽略 */ }

  line();
  console.log('  第一次使用，需要配置 Cloudflare 访问令牌（只配这一次）');
  line();
  console.log('  请按下面步骤创建一个专用令牌：');
  console.log('');
  console.log('   1. 浏览器打开：https://dash.cloudflare.com/profile/api-tokens');
  console.log('   2. 点右上角  Create Token');
  console.log('   3. 拉到页面最下面，选  Create Custom Token');
  console.log('   4. Token name 填：lab-inventory-sync');
  console.log('      Permissions 选：Account  →  D1  →  Edit');
  console.log('      Account Resources 选：你那个账号');
  console.log('   5. 点 Continue to summary → Create Token');
  console.log('   6. 把生成的那一长串复制下来，粘到下面');
  console.log('');

  const acct = (await need('  你的 Account ID（直接回车用默认 ' + (cfgDefault.account_id || '') + '）：')).trim();
  const account_id = acct || cfgDefault.account_id;
  const db = (await need('  数据库 ID（直接回车用 ' + (dbId || cfgDefault.database_id) + '）：')).trim();
  const database_id = db || dbId || cfgDefault.database_id;
  const token = (await need('  粘贴 API 令牌，然后回车：')).trim();

  if (!account_id || !database_id || !token) die('信息不完整，已取消。');

  cfg = { account_id, database_id, api_token: token };
  process.stdout.write('  正在验证令牌...');
  try {
    await d1('SELECT 1 AS ok');
    console.log(' 验证通过 ✓');
  } catch (e) {
    console.log(' 失败');
    die('令牌或数据库 ID 不对：' + e.message);
  }
  saveConfig(cfg);
  console.log('  配置已保存到 sync.config.json（这个文件含有令牌，不要发给别人，也不会提交到 GitHub）');
  console.log('');
}

const cfgDefault = { account_id: 'd0ba0ff2aa40d6a16f1ff47ac28203a8', database_id: '1c8764cf-36f8-40de-a071-d94d725d222b' };

/** 如果这台电脑用 wrangler 登录过，可以直接复用它的登录状态，省去创建令牌 */
function wranglerToken() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'xdg.config', '.wrangler', 'config', 'default.toml'),
    path.join(process.env.HOME || '', '.wrangler', 'config', 'default.toml'),
    path.join(process.env.USERPROFILE || '', '.wrangler', 'config', 'default.toml'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const m = fs.readFileSync(p, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    } catch (e) { /* 忽略 */ }
  }
  return null;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  setUtf8Console();
  console.log('');
  line();
  console.log('  实验室物资清点 —— 本机版 ↔ 云端版 数据同步');
  line();
  console.log('  同步内容：物资清单 + 出入库流水');
  console.log('  不同步：账号和密码（两边各留各的，避免登录乱掉）');
  console.log('  方式是整体覆盖，覆盖前会自动备份。');
  console.log('');

  cfg = loadConfig();
  if (!cfg) {
    // 没配置过：先看这台电脑有没有 wrangler 的登录状态，能直接用就不用麻烦用户建令牌
    const t = wranglerToken();
    if (t) {
      cfg = { account_id: cfgDefault.account_id, database_id: cfgDefault.database_id, api_token: t };
      process.stdout.write('  正在用这台电脑的 Cloudflare 登录状态连接...');
      try {
        await d1('SELECT 1 AS ok');
        console.log(' 成功 ✓');
        saveConfig(cfg);
      } catch (e) {
        console.log(' 失败（登录状态可能已过期）');
        cfg = null;
      }
    }
    if (!cfg) await setupConfig();
  }

  process.stdout.write('  读取本机数据...');
  const local = readLocal();
  console.log(' 完成');
  process.stdout.write('  连接云端数据库...');
  let remote;
  try {
    remote = await cloudCounts();
    console.log(' 完成');
  } catch (e) {
    console.log(' 失败');
    die('连不上云端：' + e.message + '\n  检查电脑能否上网；如果换了令牌，删掉 sync.config.json 重新配置。');
  }

  const lItems = local.items || [], lRecs = local.records || [];
  console.log('');
  line();
  console.log('  当前数据：');
  console.log('    本机版：物资 ' + lItems.length + ' 种，流水 ' + lRecs.length + ' 条');
  console.log('    云端版：物资 ' + remote.items + ' 种，流水 ' + remote.records + ' 条');
  line();
  console.log('  1) 本机 → 云端    （用本机的账目覆盖云端）');
  console.log('  2) 云端 → 本机    （用云端的账目覆盖本机，本机会先备份）');
  console.log('  0) 退出');
  console.log('');

  const pick = (await need('  请选择（0/1/2）：')).trim();
  if (pick !== '1' && pick !== '2') { console.log('\n  已退出，什么都没做。\n'); rl.close(); return; }

  const dir = pick === '1' ? '本机 → 云端' : '云端 → 本机';
  const confirm = (await need('  将执行「' + dir + '」，被覆盖那边会先自动备份。\n  确认请输入 同步 两个字：')).trim();
  if (confirm !== '同步') { console.log('\n  已取消，什么都没做。\n'); rl.close(); return; }

  console.log('');
  try {
    if (pick === '1') {
      const backupCloud = await cloudAll();
      const f = backUp('cloud', backupCloud);
      console.log('  云端原始数据已备份到：' + (f ? path.relative(BASE_DIR, f) : '（备份失败）'));
      process.stdout.write('  正在写入云端...\n');
      await cloudReplace(lItems, lRecs);
      const after = await cloudCounts();
      console.log('  ✓ 同步完成');
      console.log('    云端现在：物资 ' + after.items + ' 种，流水 ' + after.records + ' 条');
    } else {
      process.stdout.write('  正在读取云端数据...');
      const cloud = await cloudAll();
      console.log(' 完成');
      writeLocal(local, cloud.items, cloud.records);
      console.log('  ✓ 同步完成');
      console.log('    本机现在：物资 ' + cloud.items.length + ' 种，流水 ' + cloud.records.length + ' 条');
      console.log('    （本机原数据已备份到 data/backup/local-sync-*.json）');
    }
    console.log('');
    console.log('  提示：两边账号密码没有动，各自还是用原来的账号登录。');
    console.log('');
  } catch (e) {
    console.log('');
    die('同步失败：' + e.message + '\n  被覆盖的那一边已有备份，可从 data/backup 里还原。');
  }
  rl.close();
}

main().catch((e) => {
  console.log('\n  出错了：' + e.message + '\n');
  try { rl.close(); } catch (err) { /* 忽略 */ }
  process.exit(1);
});
