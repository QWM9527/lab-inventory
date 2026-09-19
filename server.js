#!/usr/bin/env node
/**
 * 实验室物资清点小程序（单机版 / Node 版）
 * ----------------------------------------
 * 零依赖：只用 Node.js 内置模块（http、crypto、fs），不需要 npm install。
 * 数据保存在 data/db.json，复制走它就是完整备份。
 *
 * 启动：
 *   node server.js                      只允许本机访问
 *   node server.js --host 0.0.0.0       允许同一局域网的手机访问
 *   node server.js --open               启动后自动打开浏览器
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const BASE_DIR = __dirname;
const WEB_DIR = path.join(BASE_DIR, 'web');
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const SESSION_DAYS = 7;
const PBKDF2_ROUNDS = 200000;
const TYPE_LABEL = { in: '入库', out: '领用', adjust: '盘点' };

const SUPER_USERNAME = 'root';                                    // 超级管理员固定账号名
const SUPER_PWD_FILE = path.join(DATA_DIR, '超级管理员初始密码.txt');
let superPwdJustCreated = null;                                   // 本次启动新建超级管理员时的初始密码

/* ========================= 数据层 ========================= */

let db = null;

function emptyDb() {
  return { users: [], items: [], records: [], sessions: {}, seq: { user: 0, item: 0, record: 0 } };
}

/** 每次启动时自动留一份备份（保留最近 10 份），数据误删/损坏时能救回来 */
function backupDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const dir = path.join(DATA_DIR, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = nowStr().replace(/[-: ]/g, '');
    fs.copyFileSync(DB_FILE, path.join(dir, 'db-' + stamp + '.json'));
    pruneBackups(dir);
  } catch (e) {
    console.error('[警告] 自动备份失败：' + e.message);
  }
}

/** 备份目录只保留最近 10 份 */
function pruneBackups(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^(db|purge)-\d+\.json$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - 10))
      .forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ } });
  } catch (e) { /* 忽略 */ }
}

/** 清理流水前先整库备份一份，返回备份文件路径（失败返回 null） */
function backupBeforePurge() {
  try {
    const dir = path.join(DATA_DIR, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = nowStr().replace(/[-: ]/g, '');
    const file = path.join(dir, 'purge-' + stamp + '.json');
    fs.writeFileSync(file, JSON.stringify(db, null, 1), 'utf8');
    pruneBackups(dir);
    return file;
  } catch (e) {
    console.error('[警告] 清理前备份失败：' + e.message);
    return null;
  }
}

/** 清理动作留个日志文件，删掉的流水内容事后还查得到 */
function appendPurgeLog(text) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, '清理日志.txt'),
      nowStr() + '  ' + text + '\r\n', 'utf8');
  } catch (e) { /* 忽略 */ }
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  backupDb();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('[警告] 数据文件损坏，已重命名备份为 db.json.bad，并新建空数据库');
      fs.renameSync(DB_FILE, DB_FILE + '.bad');
      db = emptyDb();
    }
  } else {
    db = emptyDb();
  }
  ['users', 'items', 'records'].forEach((k) => { if (!Array.isArray(db[k])) db[k] = []; });
  if (!db.sessions) db.sessions = {};
  if (!db.seq) db.seq = { user: 0, item: 0, record: 0 };

  // 清掉过期登录态
  const now = Date.now();
  Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].expires < now) delete db.sessions[t]; });

  // 首次运行创建默认管理员
  if (db.users.length === 0) {
    db.users.push({
      id: nextId('user'), username: 'admin', display_name: '管理员',
      pwd: hashPwd('admin123'), role: 'admin', active: 1, created_at: nowStr(),
    });
  }
  ensureSuper();
  saveDb();
}

/**
 * 保证系统里始终有一个「超级管理员」：
 * 账号固定为 root，不能被删除、停用、降级，是最后一把钥匙。
 * 首次创建时随机生成密码：打印在启动窗口里，同时写到 data/超级管理员初始密码.txt。
 */
function ensureSuper() {
  if (db.users.some((u) => u.role === 'super')) return;
  const pwd = crypto.randomBytes(9).toString('base64url').slice(0, 12);
  db.users.push({
    id: nextId('user'), username: SUPER_USERNAME, display_name: '超级管理员',
    pwd: hashPwd(pwd), role: 'super', active: 1, created_at: nowStr(),
  });
  superPwdJustCreated = pwd;
  try {
    fs.writeFileSync(SUPER_PWD_FILE,
      '超级管理员（最高权限，用来开设/管理管理员账号）\r\n' +
      '登录账号：' + SUPER_USERNAME + '\r\n' +
      '初始密码：' + pwd + '\r\n\r\n' +
      '请登录后马上在「我的账号」里改成自己好记的密码。\r\n' +
      '改过密码后本文件就作废了（系统会自动删掉它）。\r\n', 'utf8');
  } catch (e) { /* 写不了就算了，密码会打印在启动窗口 */ }
}

function isAdminRole(u) { return !!u && (u.role === 'admin' || u.role === 'super'); }
function isSuper(u) { return !!u && u.role === 'super'; }

function nextId(kind) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return db.seq[kind];
}

function nowStr(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
         p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 立即原子写入。
 * 这里刻意不做延迟/防抖：宁可每次多花几毫秒，也要保证「界面提示成功 = 数据已经落盘」，
 * 否则窗口被强行关闭或进程被杀时，最后一笔记录会丢。
 */
function saveDb() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[错误] 数据保存失败：' + e.message);
    throw e;
  }
}

/* ========================= 密码 ========================= */

function hashPwd(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const dk = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ROUNDS, 32, 'sha256');
  return salt + '$' + dk.toString('hex');
}

function verifyPwd(password, stored) {
  if (typeof stored !== 'string' || stored.indexOf('$') < 0) return false;
  const salt = stored.split('$')[0];
  const a = Buffer.from(hashPwd(password, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ========================= HTTP 工具 ========================= */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json; charset=utf-8',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, ctype, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = Object.assign({
    'Content-Type': ctype || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res, status, obj, extraHeaders) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extraHeaders);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new ApiError(413, '请求体过大')); req.destroy(); return; }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const o = JSON.parse(raw);
        resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {});
      } catch (e) { reject(new ApiError(400, '请求格式错误')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active };
}

function itemDict(it) {
  return Object.assign({}, it, { low: it.qty <= it.min_qty });
}

function currentUser(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s || s.expires < Date.now()) return null;
  const u = db.users.find((x) => x.id === s.user_id);
  if (!u || !u.active) return null;
  return u;
}

function requireUser(req, needAdmin) {
  const u = currentUser(req);
  if (!u) throw new ApiError(401, '请先登录');
  if (needAdmin && !isAdminRole(u)) throw new ApiError(403, '只有管理员有权限做这个操作');
  return u;
}

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function str(v) { return (v === null || v === undefined ? '' : String(v)).trim(); }

/** 校验登录账号：格式合法且不与他人重复。exceptId = 允许自己保持原来的账号 */
function checkUsername(name, exceptId) {
  if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(name)) {
    throw new ApiError(400, '登录账号需 2-32 位，只能用字母、数字或 _ . @ -');
  }
  if (db.users.some((u) => u.username === name && u.id !== exceptId)) {
    throw new ApiError(400, '这个登录账号已经有人用了');
  }
  return name;
}

/* ========================= 业务 ========================= */

function applyRecord(item, rtype, qty, note, user) {
  const before = item.qty;
  let after;
  if (rtype === 'in') after = before + qty;
  else if (rtype === 'out') {
    after = before - qty;
    if (after < 0) throw new ApiError(400, `库存不足：现有 ${before} ${item.unit}，无法领用 ${qty} ${item.unit}`);
  } else if (rtype === 'adjust') after = qty;
  else throw new ApiError(400, '操作类型不正确');

  const ts = nowStr();
  item.qty = after;
  item.updated_at = ts;
  const rec = {
    id: nextId('record'), item_id: item.id, item_name: item.name, item_unit: item.unit,
    type: rtype, qty: qty, before_qty: before, after_qty: after,
    operator: user.display_name, operator_id: user.id, note: note || '', created_at: ts,
  };
  db.records.push(rec);
  return rec;
}

/* ========================= 路由 ========================= */

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  /* ---------- 登录 ---------- */
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const username = str(body.username);
    const password = body.password || '';
    const ip = req.socket.remoteAddress || '?';
    const rec = loginFail[ip];
    if (rec && rec.until > Date.now()) {
      throw new ApiError(429, `失败次数过多，请 ${Math.ceil((rec.until - Date.now()) / 1000)} 秒后再试`);
    }
    const u = db.users.find((x) => x.username === username);
    if (!u || !u.active || !verifyPwd(password, u.pwd)) {
      const n = (rec ? rec.count : 0) + 1;
      loginFail[ip] = { count: n, until: n >= 5 ? Date.now() + 30000 : 0 };
      throw new ApiError(401, '账号或密码不对');
    }
    delete loginFail[ip];
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = { user_id: u.id, expires: Date.now() + SESSION_DAYS * 86400000 };
    saveDb();
    sendJson(res, 200, { user: publicUser(u) },
      { 'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` });
    return true;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = parseCookies(req).session;
    if (token) { delete db.sessions[token]; saveDb(); }
    sendJson(res, 200, { ok: true },
      { 'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    return true;
  }

  if (pathname === '/api/me' && method === 'GET') {
    const u = currentUser(req);
    sendJson(res, 200, { user: u ? publicUser(u) : null });
    return true;
  }

  if (pathname === '/api/password' && method === 'POST') {
    const u = requireUser(req);
    const body = await readBody(req);
    if (!verifyPwd(body.old_password || '', u.pwd)) throw new ApiError(400, '原密码不对');
    if (str(body.new_password).length < 6) throw new ApiError(400, '新密码至少 6 位');
    u.pwd = hashPwd(body.new_password);
    saveDb();
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* ---------- 我的账号（改姓名 / 改登录账号 / 改密码） ---------- */
  if (pathname === '/api/profile' && method === 'POST') {
    const u = requireUser(req);
    const b = await readBody(req);
    if (b.display_name !== undefined) {
      const dn = str(b.display_name);
      if (!dn) throw new ApiError(400, '姓名不能为空');
      u.display_name = dn;
    }
    if (b.username !== undefined) {
      const nu = str(b.username);
      checkUsername(nu, u.id);
      u.username = nu;
    }
    if (b.new_password) {
      if (!verifyPwd(b.old_password || '', u.pwd)) throw new ApiError(400, '原密码不对');
      if (str(b.new_password).length < 6) throw new ApiError(400, '新密码至少 6 位');
      u.pwd = hashPwd(b.new_password);
      if (isSuper(u)) { try { fs.unlinkSync(SUPER_PWD_FILE); } catch (e) { /* 已经没有就算了 */ } }
    }
    saveDb();
    sendJson(res, 200, { user: publicUser(u) });
    return true;
  }

  /* ---------- 物资 ---------- */
  if (pathname === '/api/items' && method === 'GET') {
    requireUser(req);
    const kw = str(query.kw).toLowerCase();
    let list = db.items.slice();
    if (kw) {
      list = list.filter((it) =>
        (it.name + it.category + it.spec + it.location).toLowerCase().indexOf(kw) >= 0);
    }
    list.sort((a, b) => {
      const la = a.qty <= a.min_qty ? 0 : 1, lb = b.qty <= b.min_qty ? 0 : 1;
      if (la !== lb) return la - lb;
      return (a.category || '').localeCompare(b.category || '', 'zh') ||
             (a.name || '').localeCompare(b.name || '', 'zh') || a.id - b.id;
    });
    sendJson(res, 200, { items: list.map(itemDict) });
    return true;
  }

  if (pathname === '/api/items' && method === 'POST') {
    const u = requireUser(req, true);
    const b = await readBody(req);
    const name = str(b.name);
    if (!name) throw new ApiError(400, '物资名称不能为空');
    const qty = Math.max(0, toInt(b.qty, 0));
    const ts = nowStr();
    const item = {
      id: nextId('item'), name: name, category: str(b.category), spec: str(b.spec),
      unit: str(b.unit) || '个', location: str(b.location), qty: 0,   // 起始为 0，再由下面的入库流水加上去
      min_qty: Math.max(0, toInt(b.min_qty, 0)), note: str(b.note),
      created_at: ts, updated_at: ts,
    };
    db.items.push(item);
    if (qty > 0) applyRecord(item, 'in', qty, '新建物资初始数量', u);
    saveDb();
    sendJson(res, 201, { item: itemDict(item) });
    return true;
  }

  let m = pathname.match(/^\/api\/items\/(\d+)$/);
  if (m && method === 'PUT') {
    requireUser(req, true);
    const item = db.items.find((x) => x.id === Number(m[1]));
    if (!item) throw new ApiError(404, '物资不存在');
    const b = await readBody(req);
    ['name', 'category', 'spec', 'unit', 'location', 'note'].forEach((k) => {
      if (b[k] !== undefined) item[k] = str(b[k]);
    });
    if (!item.name) throw new ApiError(400, '物资名称不能为空');
    if (!item.unit) item.unit = '个';
    if (b.min_qty !== undefined) item.min_qty = Math.max(0, toInt(b.min_qty, 0));
    item.updated_at = nowStr();
    // 同步历史流水里的展示名
    db.records.forEach((r) => {
      if (r.item_id === item.id) { r.item_name = item.name; r.item_unit = item.unit; }
    });
    saveDb();
    sendJson(res, 200, { item: itemDict(item) });
    return true;
  }

  if (m && method === 'DELETE') {
    requireUser(req, true);
    const id = Number(m[1]);
    const i = db.items.findIndex((x) => x.id === id);
    if (i >= 0) db.items.splice(i, 1);
    saveDb();
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* ---------- 出入库流水 ---------- */
  if (pathname === '/api/records' && method === 'GET') {
    requireUser(req);
    let list = db.records.slice();
    if (query.item_id) list = list.filter((r) => r.item_id === toInt(query.item_id, -1));
    if (TYPE_LABEL[query.type]) list = list.filter((r) => r.type === query.type);
    if (query.from) list = list.filter((r) => r.created_at >= query.from + ' 00:00:00');
    if (query.to) list = list.filter((r) => r.created_at <= query.to + ' 23:59:59');
    const kw = str(query.kw).toLowerCase();
    if (kw) {
      list = list.filter((r) =>
        (r.item_name + r.operator + r.note).toLowerCase().indexOf(kw) >= 0);
    }
    const total = list.length;
    list.sort((a, b) => b.id - a.id);
    const limit = Math.min(500, Math.max(1, toInt(query.limit, 100)));
    const offset = Math.max(0, toInt(query.offset, 0));
    sendJson(res, 200, { records: list.slice(offset, offset + limit), total: total });
    return true;
  }

  if (pathname === '/api/records' && method === 'POST') {
    const u = requireUser(req, true);      // 只有管理员能录入出入库
    const b = await readBody(req);
    const item = db.items.find((x) => x.id === toInt(b.item_id, -1));
    if (!item) throw new ApiError(400, '物资不存在');
    const rtype = b.type;
    if (!TYPE_LABEL[rtype]) throw new ApiError(400, '操作类型不正确');
    const qty = toInt(b.qty, NaN);
    if (!Number.isFinite(qty)) throw new ApiError(400, '数量填写不正确');
    if (rtype !== 'adjust' && qty <= 0) throw new ApiError(400, '数量必须大于 0');
    if (rtype === 'adjust' && qty < 0) throw new ApiError(400, '盘点数量不能为负');
    const rec = applyRecord(item, rtype, qty, str(b.note), u);
    saveDb();
    sendJson(res, 201, { record: rec });
    return true;
  }

  /* ---------- 清理流水（只有超级管理员能做） ---------- */
  if (pathname === '/api/records/purge' && method === 'POST') {
    const me = requireUser(req);
    if (!isSuper(me)) throw new ApiError(403, '只有超级管理员能清理流水记录');
    const b = await readBody(req);
    const scope = b.scope;                       // all | before | range
    const from = str(b.from), to = str(b.to);

    let victims;
    let desc;
    if (scope === 'all') {
      victims = db.records.slice();
      desc = '全部记录';
    } else if (scope === 'before') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, '请选择要清理到哪一天');
      victims = db.records.filter((r) => r.created_at <= to + ' 23:59:59');
      desc = to + ' 及之前';
    } else if (scope === 'range') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        throw new ApiError(400, '请选择起止日期');
      }
      if (from > to) throw new ApiError(400, '开始日期不能晚于结束日期');
      victims = db.records.filter((r) => r.created_at >= from + ' 00:00:00' && r.created_at <= to + ' 23:59:59');
      desc = from + ' 至 ' + to;
    } else {
      throw new ApiError(400, '清理范围不正确');
    }

    if (!victims.length) {
      sendJson(res, 200, { deleted: 0, remaining: db.records.length, backup: null, message: '这个范围里没有记录，什么都没删' });
      return true;
    }

    const backup = backupBeforePurge();
    const ids = new Set(victims.map((r) => r.id));
    db.records = db.records.filter((r) => !ids.has(r.id));
    saveDb();
    appendPurgeLog('超级管理员(' + me.username + ') 清理了「' + desc + '」共 ' + victims.length +
                   ' 条流水，清理前备份：' + (backup || '失败'));

    sendJson(res, 200, {
      deleted: victims.length,
      remaining: db.records.length,
      backup: backup,
      message: '已清理 ' + victims.length + ' 条',
    });
    return true;
  }

  /* ---------- 统计 ---------- */
  if (pathname === '/api/stats' && method === 'GET') {
    requireUser(req);
    const today = nowStr().slice(0, 10);
    let total = 0, low = 0;
    db.items.forEach((it) => { total += it.qty; if (it.qty <= it.min_qty) low++; });
    let tin = 0, tout = 0;
    db.records.forEach((r) => {
      if (r.created_at.slice(0, 10) !== today) return;
      if (r.type === 'in') tin += r.qty;
      if (r.type === 'out') tout += r.qty;
    });
    sendJson(res, 200, { kinds: db.items.length, total: total, low: low, today_in: tin, today_out: tout });
    return true;
  }

  /* ---------- 导出 CSV ---------- */
  if (pathname === '/api/export' && method === 'GET') {
    requireUser(req);
    const esc = (v) => '"' + String(v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['时间,物资,类型,数量,单位,变动前,变动后,操作人,备注'];
    db.records.slice().sort((a, b) => b.id - a.id).forEach((r) => {
      lines.push([r.created_at, r.item_name, TYPE_LABEL[r.type] || r.type, r.qty,
                  r.item_unit, r.before_qty, r.after_qty, r.operator, r.note].map(esc).join(','));
    });
    const csv = '\ufeff' + lines.join('\r\n');
    const fname = '物资流水_' + nowStr().slice(0, 10).replace(/-/g, '') + '.csv';
    send(res, 200, csv, 'text/csv; charset=utf-8',
      { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname) });
    return true;
  }

  /* ---------- 人员管理 ---------- */
  if (pathname === '/api/users' && method === 'GET') {
    requireUser(req, true);
    const list = db.users.slice().sort((a, b) => (a.role === b.role ? a.id - b.id : (a.role === 'admin' ? -1 : 1)));
    sendJson(res, 200, { users: list.map(publicUser) });
    return true;
  }

  if (pathname === '/api/users' && method === 'POST') {
    const me = requireUser(req, true);       // 管理员或超级管理员
    const b = await readBody(req);
    const username = str(b.username);
    const name = str(b.display_name) || username;
    const pwd = b.password || '';
    let role = b.role === 'admin' ? 'admin' : 'member';
    checkUsername(username, null);
    // 只有超级管理员能创建管理员账号，普通管理员只能建普通成员
    if (role === 'admin' && !isSuper(me)) {
      throw new ApiError(403, '只有超级管理员能创建管理员账号，你只能新增普通成员');
    }
    if (String(pwd).length < 6) throw new ApiError(400, '密码至少 6 位');
    db.users.push({
      id: nextId('user'), username: username, display_name: name,
      pwd: hashPwd(pwd), role: role, active: 1, created_at: nowStr(),
    });
    saveDb();
    sendJson(res, 201, { ok: true });
    return true;
  }

  m = pathname.match(/^\/api\/users\/(\d+)$/);
  if (m && method === 'PUT') {
    const me = requireUser(req, true);
    const uid = Number(m[1]);
    const target = db.users.find((u) => u.id === uid);
    if (!target) throw new ApiError(404, '用户不存在');
    const b = await readBody(req);
    // 超级管理员是最高权限的保底账号，别人不能改它，它也不能被降级/停用
    if (isSuper(target)) {
      if (!isSuper(me)) throw new ApiError(403, '超级管理员账号只能由超级管理员本人修改');
      if (b.role !== undefined && b.role !== 'super') throw new ApiError(400, '超级管理员的角色不能修改');
      if (b.active !== undefined && !b.active) throw new ApiError(400, '超级管理员不能被停用');
    }
    // 普通管理员只能管普通成员：别的管理员账号（以及角色升降）归超级管理员管
    if (!isSuper(me) && isAdminRole(target) && target.id !== me.id) {
      throw new ApiError(403, '只有超级管理员能管理管理员账号');
    }
    if (b.role !== undefined && !isSuper(me)) {
      throw new ApiError(403, '只有超级管理员能设置角色（管理员 / 普通成员）');
    }
    if (b.display_name !== undefined && str(b.display_name)) target.display_name = str(b.display_name);
    if (b.username !== undefined) {
      const nu = str(b.username);
      checkUsername(nu, uid);
      target.username = nu;
    }
    if (b.password) {
      if (String(b.password).length < 6) throw new ApiError(400, '密码至少 6 位');
      target.pwd = hashPwd(b.password);
    }
    if (b.role && uid !== me.id) target.role = b.role === 'admin' ? 'admin' : 'member';
    else if (b.role && uid === me.id && b.role !== target.role) {
      throw new ApiError(400, '不能修改自己的角色，请让另一位管理员来改');
    }
    if (b.active !== undefined) {
      if (uid === me.id) throw new ApiError(400, '不能停用自己');
      target.active = b.active ? 1 : 0;
      if (!target.active) {
        Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].user_id === uid) delete db.sessions[t]; });
      }
    }
    saveDb();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (m && method === 'DELETE') {
    const me = requireUser(req, true);
    const uid = Number(m[1]);
    if (uid === me.id) throw new ApiError(400, '不能删除自己');
    const target = db.users.find((u) => u.id === uid);
    if (!target) throw new ApiError(404, '用户不存在');
    if (isSuper(target)) throw new ApiError(403, '超级管理员账号不能删除（它是最后一把钥匙）');
    if (!isSuper(me) && isAdminRole(target)) {
      throw new ApiError(403, '只有超级管理员能删除管理员账号');
    }
    if (target.role === 'admin') {
      const left = db.users.filter((u) => isAdminRole(u) && u.active && u.id !== uid).length;
      if (left === 0) throw new ApiError(400, '至少要保留一个管理员');
    }
    Object.keys(db.sessions).forEach((t) => { if (db.sessions[t].user_id === uid) delete db.sessions[t]; });
    db.users = db.users.filter((u) => u.id !== uid);
    saveDb();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

/* ========================= 静态文件 ========================= */

function serveStatic(res, pathname) {
  const rel = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    send(res, 404, '页面不存在');
    return;
  }
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
}

/* ========================= 服务器 ========================= */

const loginFail = {};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;
  const query = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });

  try {
    if (pathname.startsWith('/api/')) {
      const done = await handleApi(req, res, pathname, query);
      if (!done) sendJson(res, 404, { error: '接口不存在' });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, pathname);
    } else {
      send(res, 404, 'Not Found');
    }
  } catch (e) {
    if (e instanceof ApiError) sendJson(res, e.status, { error: e.message });
    else {
      console.error('[错误]', req.method, pathname, e);
      sendJson(res, 500, { error: '服务器内部错误：' + e.message });
    }
  }
});

function lanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function main() {
  // Windows 控制台默认可能是 GBK 代码页，先切到 UTF-8，中文提示才不会变成乱码
  if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
  }

  const argv = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
  };
  const host = getArg('host', '127.0.0.1');
  const port = parseInt(getArg('port', '8000'), 10);
  const open = argv.includes('--open');

  loadDb();

  const url = 'http://127.0.0.1:' + port + '/';
  console.log('='.repeat(58));
  console.log('  实验室物资清点系统 已启动');
  console.log('='.repeat(58));
  console.log('  本机访问  : ' + url);
  if (host === '0.0.0.0') console.log('  局域网访问: http://' + lanIp() + ':' + port + '/   （手机连同一个 WiFi 可打开）');
  console.log('  数据文件  : ' + DB_FILE);
  if (superPwdJustCreated) {
    console.log('');
    console.log('  ★ 已创建超级管理员账号（最高权限，用来开设/管理管理员）');
    console.log('      登录账号 : ' + SUPER_USERNAME);
    console.log('      初始密码 : ' + superPwdJustCreated);
    console.log('      密码也写在: ' + SUPER_PWD_FILE);
    console.log('      登录后请在「我的账号」里改成自己好记的密码。');
    console.log('');
  }
  console.log('  按 Ctrl+C 关闭服务');
  console.log('='.repeat(58));

  server.listen(port, host, () => {
    if (open) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => {});
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('\n[错误] 端口 ' + port + ' 已被占用，请换一个端口，例如：node server.js --port 8001');
    } else {
      console.error('\n[错误] ' + e.message);
    }
    process.exit(1);
  });
}

// Ctrl+C 或被关闭窗口时，确保数据落盘（数据本来就是每次操作即时写入的，这里再加一道保险）
process.on('SIGINT', () => {
  try { saveDb(); } catch (e) { /* 忽略 */ }
  console.log('\n已停止。');
  process.exit(0);
});
process.on('SIGHUP', () => {
  try { saveDb(); } catch (e) { /* 忽略 */ }
  process.exit(0);
});

main();
