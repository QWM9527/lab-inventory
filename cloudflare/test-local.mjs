/**
 * 云端版（Worker）本地自测脚本
 * ==============================
 * 不需要 Cloudflare 账号、不需要 wrangler：用 Node 24 内置的 node:sqlite 顶替 D1，
 * 直接把 cloudflare/worker.js 的 fetch 跑起来，把接口流程完整测一遍。
 *
 * 用法：node cloudflare/test-local.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = (await import('file://' + join(HERE, 'worker.js'))).default;

/* ---------- 用 node:sqlite 模拟 D1 ---------- */
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { const s = new Stmt(this.db, this.sql); s.args = args; return s; }
  async first(...extra) {
    const row = this.db.prepare(this.sql).get(...this.args, ...extra);
    return row === undefined ? null : row;
  }
  async all(...extra) {
    return { results: this.db.prepare(this.sql).all(...this.args, ...extra) };
  }
  async run(...extra) {
    const r = this.db.prepare(this.sql).run(...this.args, ...extra);
    return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
}
class FakeDB {
  constructor(path) { this.raw = new DatabaseSync(path); }
  prepare(sql) { return new Stmt(this.raw, sql); }
  exec(sql) { this.raw.exec(sql); }
}

/* ---------- 环境 ---------- */
const db = new FakeDB(':memory:');
db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
const env = { DB: db };

// 造一个超级管理员（哈希算法与 worker 内一致：PBKDF2-SHA256 / 25000 轮 / 32 字节）
function hash(pw) {
  const salt = randomBytes(16).toString('hex');
  const dk = pbkdf2Sync(pw, salt, 25000, 32, 'sha256');
  return salt + '$' + dk.toString('hex');
}
db.exec("INSERT INTO users(username,display_name,pwd,role,active,created_at) VALUES" +
        "('root','超级管理员','" + hash('root123456') + "','super',1,'2026-01-01 00:00:00')");

/* ---------- 请求辅助（带 Cookie） ---------- */
const jar = {};
async function call(method, path, body, opts) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const cookie = Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
  if (cookie) headers['Cookie'] = cookie;
  const res = await worker.fetch(new Request('https://x.dev' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) {
    const [kv] = setCookie.split(';');
    const i = kv.indexOf('=');
    const name = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
    if (val) jar[name] = val; else delete jar[name];
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, res };
}

let pass = 0, fail = 0;
async function T(name, fn, expect) {
  try {
    const r = await fn();
    const ok = expect === undefined ? true : (r.status === expect);
    if (ok) { console.log('  ✓ ' + name + (expect !== undefined ? '（HTTP ' + r.status + '）' : '')); pass++; }
    else { console.log('  ✗ ' + name + ' -> 期望 ' + expect + '，实际 ' + r.status + ' ' + JSON.stringify(r.data)); fail++; }
  } catch (e) {
    console.log('  ✗ ' + name + ' -> 抛异常: ' + e.message); fail++;
  }
}
async function login(u, p) {
  delete jar.session;
  return call('POST', '/api/login', { username: u, password: p });
}

console.log('\n=== 云端版 Worker 本地自测 ===\n');

console.log('【登录与鉴权】');
await T('未登录访问物资 -> 401', () => call('GET', '/api/items'), 401);
await T('错误密码 -> 401', () => login('root', 'wrong'), 401);
await T('正确密码 root/root123456 -> 200', async () => {
  const r = await login('root', 'root123456');
  if (r.data.user.role !== 'super') throw new Error('角色不对');
  return r;
}, 200);
await T('登录后带 Cookie 访问 /api/me', async () => {
  const r = await call('GET', '/api/me');
  if (!r.data.user || r.data.user.username !== 'root') throw new Error('会话不对');
  return r;
}, 200);

console.log('\n【物资与流水】');
let itemId = null;
await T('新增物资（初始 10 块）-> 201', async () => {
  const r = await call('POST', '/api/items', { name: 'STM32F103C8T6 开发板', category: '单片机', unit: '块', qty: 10, min_qty: 3, location: 'A柜 2 层' });
  itemId = r.data.item.id;
  if (r.data.item.qty !== 10) throw new Error('初始数量错误: ' + r.data.item.qty);
  return r;
}, 201);
await T('领用 1 块 -> 剩余 9', async () => {
  const r = await call('POST', '/api/records', { item_id: itemId, type: 'out', qty: 1, note: '张三做毕设领用' });
  if (r.data.record.after_qty !== 9) throw new Error('数量不对: ' + r.data.record.after_qty);
  return r;
}, 201);
await T('入库 5 块 -> 剩余 14', async () => {
  const r = await call('POST', '/api/records', { item_id: itemId, type: 'in', qty: 5, note: '采购单 CG001' });
  if (r.data.record.after_qty !== 14) throw new Error('数量不对');
  return r;
}, 201);
await T('超量领用 -> 400 且不影响库存', async () => {
  const r = await call('POST', '/api/records', { item_id: itemId, type: 'out', qty: 999 });
  const items = await call('GET', '/api/items');
  if (items.data.items[0].qty !== 14) throw new Error('库存被改坏了');
  return r;
}, 400);
await T('盘点改成 12', async () => {
  const r = await call('POST', '/api/records', { item_id: itemId, type: 'adjust', qty: 12 });
  if (r.data.record.after_qty !== 12) throw new Error('盘点不对');
  return r;
}, 201);
await T('流水查询 total=4', async () => {
  const r = await call('GET', '/api/records?limit=50');
  if (r.data.total !== 4) throw new Error('流水条数: ' + r.data.total);
  return r;
}, 200);
await T('按类型筛选 out 只有 1 条', async () => {
  const r = await call('GET', '/api/records?type=out');
  if (r.data.total !== 1) throw new Error('筛选不对: ' + r.data.total);
  return r;
}, 200);
await T('关键字搜索"张三"', async () => {
  const r = await call('GET', '/api/records?kw=' + encodeURIComponent('张三'));
  if (r.data.total !== 1) throw new Error('搜索不对');
  return r;
}, 200);
await T('统计接口', async () => {
  const r = await call('GET', '/api/stats');
  if (r.data.kinds !== 1 || r.data.total !== 12) throw new Error('统计不对: ' + JSON.stringify(r.data));
  return r;
}, 200);
await T('导出 CSV（带 BOM 和中文表头）', async () => {
  const res = await worker.fetch(new Request('https://x.dev/api/export', {
    headers: { Cookie: 'session=' + jar.session },
  }), env);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)) throw new Error('开头没有 UTF-8 BOM');
  const text = new TextDecoder().decode(bytes);
  if (text.indexOf('时间,物资,类型') < 0) throw new Error('CSV 表头不对');
  if (text.indexOf('张三做毕设领用') < 0) throw new Error('CSV 缺内容');
  return { status: res.status };
}, 200);

console.log('\n【三级权限】');
await T('超级管理员建两个管理员 -> 201', () => call('POST', '/api/users', { username: 'zhangsan', display_name: '张三', password: 'zhang123456', role: 'admin' }), 201);
await T('超级管理员建第二个管理员 -> 201', () => call('POST', '/api/users', { username: 'wangwu', display_name: '王五', password: 'wang123456', role: 'admin' }), 201);
await T('超级管理员建一个普通成员 -> 201', () => call('POST', '/api/users', { username: 'lisi', display_name: '李四', password: 'lisi123456', role: 'member' }), 201);
await T('重复账号 -> 400', () => call('POST', '/api/users', { username: 'zhangsan', display_name: 'x', password: '123456' }), 400);

async function uidOf(username) {
  const r = await call('GET', '/api/users');
  const u = r.data.users.find((x) => x.username === username);
  if (!u) throw new Error('找不到账号 ' + username);
  return u.id;
}
const idWW = await uidOf('wangwu');
const idLS = await uidOf('lisi');
const idZS = await uidOf('zhangsan');

await login('zhangsan', 'zhang123456');
await T('管理员新增管理员 -> 403（关键）', () => call('POST', '/api/users', { username: 'bad', display_name: '坏人', password: 'bad123456', role: 'admin' }), 403);
await T('管理员新增普通成员 -> 201', () => call('POST', '/api/users', { username: 'zhaoliu', display_name: '赵六', password: 'zhao123456', role: 'member' }), 201);
await T('管理员把成员升管理员 -> 403（关键）', () => call('PUT', '/api/users/' + idLS, { role: 'admin' }), 403);
await T('管理员改另一个管理员(王五) -> 403（关键）', () => call('PUT', '/api/users/' + idWW, { display_name: '被改名' }), 403);
await T('管理员改另一个管理员(王五)密码 -> 403', () => call('PUT', '/api/users/' + idWW, { password: 'hack123456' }), 403);
await T('管理员停用另一个管理员 -> 403', () => call('PUT', '/api/users/' + idWW, { active: 0 }), 403);
await T('管理员删另一个管理员 -> 403（关键）', () => call('DELETE', '/api/users/' + idWW), 403);
await T('管理员改自己姓名 -> 200', () => call('PUT', '/api/users/' + idZS, { display_name: '张三（我）' }), 200);
await T('管理员改成员姓名 -> 200', () => call('PUT', '/api/users/' + idLS, { display_name: '李四（改）' }), 200);
await T('管理员录入出入库 -> 201', () => call('POST', '/api/records', { item_id: itemId, type: 'out', qty: 2 }), 201);
await T('管理员清理流水 -> 403（仅超级管理员）', () => call('POST', '/api/records/purge', { scope: 'all' }), 403);
await T('管理员新增物资 -> 201', () => call('POST', '/api/items', { name: '杜邦线', unit: '排', qty: 4 }), 201);

await login('zhaoliu', 'zhao123456');
await T('普通成员查看物资 -> 200', () => call('GET', '/api/items'), 200);
await T('普通成员查看流水 -> 200', () => call('GET', '/api/records'), 200);
await T('普通成员录入领用 -> 403（关键）', () => call('POST', '/api/records', { item_id: itemId, type: 'out', qty: 1 }), 403);
await T('普通成员录入入库 -> 403', () => call('POST', '/api/records', { item_id: itemId, type: 'in', qty: 1 }), 403);
await T('普通成员盘点 -> 403', () => call('POST', '/api/records', { item_id: itemId, type: 'adjust', qty: 99 }), 403);
await T('普通成员看人员列表 -> 403', () => call('GET', '/api/users'), 403);
await T('普通成员新增物资 -> 403', () => call('POST', '/api/items', { name: 'x', qty: 1 }), 403);
await T('普通成员改自己密码 -> 200', () => call('POST', '/api/profile', { old_password: 'zhao123456', new_password: 'newpass999' }), 200);

console.log('\n【超级管理员专属】');
await login('root', 'root123456');
await T('root 把成员升管理员 -> 200', () => call('PUT', '/api/users/' + idLS, { role: 'admin' }), 200);
await T('root 降级一个管理员 -> 200', () => call('PUT', '/api/users/' + idWW, { role: 'member' }), 200);
let qtyBefore = 0;
await T('记录清理前的库存', async () => {
  const r = await call('GET', '/api/items');
  qtyBefore = r.data.items.reduce((s, x) => s + x.qty, 0);
  return { status: 200 };
}, 200);
await T('root 清理全部流水 -> 200 且条数正确', async () => {
  const c = await call('GET', '/api/records?limit=1');
  const before = c.data.total;
  const r = await call('POST', '/api/records/purge', { scope: 'all' });
  if (r.data.deleted !== before) throw new Error('删除条数不对: ' + r.data.deleted + ' 应为 ' + before);
  if (r.data.remaining !== 0) throw new Error('剩余条数不对');
  return r;
}, 200);
await T('清理流水后物资库存不变', async () => {
  const r = await call('GET', '/api/items');
  const now = r.data.items.reduce((s, x) => s + x.qty, 0);
  if (now !== qtyBefore) throw new Error('库存被影响了: ' + qtyBefore + ' -> ' + now);
  return { status: 200 };
}, 200);
await T('root 删超级管理员自己 -> 400/403', () => call('DELETE', '/api/users/1'), 400);
await T('root 停用自己 -> 400', () => call('PUT', '/api/users/1', { active: 0 }), 400);
await T('root 给自己降级 -> 400', () => call('PUT', '/api/users/1', { role: 'member' }), 400);

console.log('\n【登录失败锁定】');
for (let i = 0; i < 5; i++) await login('root', 'wrong' + i);
await T('连续 5 次失败后 -> 429 锁定', () => login('root', 'root123456'), 429);

console.log('\n----------------------------------------');
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('----------------------------------------\n');
process.exit(fail ? 1 : 0);
