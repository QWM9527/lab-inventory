/**
 * 实验室物资清点 —— Cloudflare Workers + D1 云端版
 * ==================================================
 * 和本机版（server.js）功能完全一致，接口路径也一样，前端 web/ 目录两边共用。
 *
 * 和本机版的区别：
 *   1. 数据存在 Cloudflare D1（SQLite 云数据库），不再写本地文件
 *   2. 密码哈希用 Web Crypto 的 PBKDF2（迭代次数按 Workers 免费版 10ms CPU 限制调整）
 *   3. 时间是北京时间（UTC+8），不受服务器时区影响
 *   4. 没有「启动自动备份」，改为随时可导出 CSV；D1 本身有时间点恢复能力
 *
 * 部署见 README 的「云端版」章节。
 */

'use strict';

/* ========================= 配置 ========================= */

const SESSION_DAYS = 7;
const PBKDF2_ROUNDS = 25000;        // 免费版 CPU 限制内的取值（本机版是 20 万）
const TIMEZONE_OFFSET = 8;          // 北京时间 UTC+8
const SUPER_USERNAME = 'root';
const TYPE_LABEL = { in: '入库', out: '领用', adjust: '盘点' };
const MAX_LOGIN_FAIL = 5;
const LOCK_SECONDS = 30;

/* ========================= 小工具 ========================= */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const enc = new TextEncoder();

/** 北京时间字符串 YYYY-MM-DD HH:MM:SS */
function nowStr(offsetMs) {
  const d = new Date(Date.now() + (offsetMs || 0) + TIMEZONE_OFFSET * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPwd(password, salt) {
  salt = salt || randomHex(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    key, 256);
  return salt + '$' + toHex(bits);
}

async function verifyPwd(password, stored) {
  if (typeof stored !== 'string' || stored.indexOf('$') < 0) return false;
  const salt = stored.split('$')[0];
  const calc = await hashPwd(password, salt);
  if (calc.length !== stored.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ stored.charCodeAt(i);
  return diff === 0;
}

function json(data, status, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {});
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function parseCookies(request) {
  const out = {};
  (request.headers.get('Cookie') || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function str(v) { return (v === null || v === undefined ? '' : String(v)).trim(); }
function toInt(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }

function checkUsername(name) {
  if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(name)) {
    throw new ApiError(400, '登录账号需 2-32 位，只能用字母、数字或 _ . @ -');
  }
  return name;
}

function isAdminRole(u) { return !!u && (u.role === 'admin' || u.role === 'super'); }
function isSuper(u) { return !!u && u.role === 'super'; }

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active };
}

/** 时间比较用：现在 - 天数 */
function daysAgoStr(days) {
  return nowStr(-days * 86400000);
}

/* ========================= 数据库辅助 ========================= */

async function getSessionUser(env, request) {
  const token = parseCookies(request).session;
  if (!token) return null;
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  if (!s || s.expires_at < Date.now()) return null;
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.user_id).first();
  if (!u || !u.active) return null;
  return u;
}

async function requireUser(env, request, needAdmin) {
  const u = await getSessionUser(env, request);
  if (!u) throw new ApiError(401, '请先登录');
  if (needAdmin && !isAdminRole(u)) throw new ApiError(403, '只有管理员有权限做这个操作');
  return u;
}

/* ========================= 业务 ========================= */

async function applyRecord(env, item, rtype, qty, note, user) {
  const before = item.qty;
  let after;
  if (rtype === 'in') after = before + qty;
  else if (rtype === 'out') {
    after = before - qty;
    if (after < 0) throw new ApiError(400, `库存不足：现有 ${before} ${item.unit}，无法领用 ${qty} ${item.unit}`);
  } else if (rtype === 'adjust') after = qty;
  else throw new ApiError(400, '操作类型不正确');

  const ts = nowStr();
  await env.DB.prepare('UPDATE items SET qty = ?, updated_at = ? WHERE id = ?').bind(after, ts, item.id).run();
  const r = await env.DB.prepare(
    'INSERT INTO records(item_id, item_name, item_unit, type, qty, before_qty, after_qty, operator, operator_id, note, created_at)' +
    ' VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(item.id, item.name, item.unit, rtype, qty, before, after, user.display_name, user.id, note || '', ts)
    .run();
  return {
    id: r.meta.last_row_id, item_id: item.id, item_name: item.name, item_unit: item.unit,
    type: rtype, qty, before_qty: before, after_qty: after,
    operator: user.display_name, note: note || '', created_at: ts,
  };
}

/* ========================= 路由 ========================= */

async function handleApi(request, env, url) {
  const path = url.pathname;
  const q = url.searchParams;
  const method = request.method;

  /* ---------- 登录 ---------- */
  if (path === '/api/login' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const username = str(b.username);
    const password = b.password || '';
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const fail = await env.DB.prepare('SELECT * FROM login_fail WHERE ip = ?').bind(ip).first();
    if (fail && fail.until > Date.now()) {
      throw new ApiError(429, '失败次数过多，请 ' + Math.ceil((fail.until - Date.now()) / 1000) + ' 秒后再试');
    }

    const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    const ok = u && u.active && (await verifyPwd(password, u.pwd));
    if (!ok) {
      const count = (fail ? fail.count : 0) + 1;
      const until = count >= MAX_LOGIN_FAIL ? Date.now() + LOCK_SECONDS * 1000 : 0;
      await env.DB.prepare('INSERT INTO login_fail(ip,count,until) VALUES(?,?,?)' +
        ' ON CONFLICT(ip) DO UPDATE SET count=?, until=?').bind(ip, count, until, count, until).run();
      throw new ApiError(401, '账号或密码不对');
    }
    await env.DB.prepare('DELETE FROM login_fail WHERE ip = ?').bind(ip).run();

    const token = randomHex(32);
    const expires = Date.now() + SESSION_DAYS * 86400000;
    await env.DB.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)')
      .bind(token, u.id, expires).run();
    return json({ user: publicUser(u) }, 200, {
      'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_DAYS * 86400}`,
    });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = parseCookies(request).session;
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return json({ ok: true }, 200, {
      'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
    });
  }

  if (path === '/api/me' && method === 'GET') {
    const u = await getSessionUser(env, request);
    return json({ user: u ? publicUser(u) : null });
  }

  /* ---------- 我的账号 ---------- */
  if (path === '/api/profile' && method === 'POST') {
    const u = await requireUser(env, request);
    const b = await request.json().catch(() => ({}));
    let username = u.username;
    let displayName = u.display_name;
    if (b.display_name !== undefined) {
      displayName = str(b.display_name);
      if (!displayName) throw new ApiError(400, '姓名不能为空');
    }
    if (b.username !== undefined) {
      username = checkUsername(str(b.username));
      const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, u.id).first();
      if (dup) throw new ApiError(400, '这个登录账号已经有人用了');
    }
    let pwd = u.pwd;
    if (b.new_password) {
      if (!(await verifyPwd(b.old_password || '', u.pwd))) throw new ApiError(400, '原密码不对');
      if (str(b.new_password).length < 6) throw new ApiError(400, '新密码至少 6 位');
      pwd = await hashPwd(b.new_password);
    }
    await env.DB.prepare('UPDATE users SET username=?, display_name=?, pwd=? WHERE id=?')
      .bind(username, displayName, pwd, u.id).run();
    return json({ user: publicUser(Object.assign({}, u, { username, display_name: displayName })) });
  }

  /* ---------- 物资 ---------- */
  if (path === '/api/items' && method === 'GET') {
    await requireUser(env, request);
    const kw = str(q.get('kw')).toLowerCase();
    let sql = 'SELECT * FROM items';
    let rows;
    if (kw) {
      const like = '%' + kw + '%';
      rows = (await env.DB.prepare(sql + ' WHERE lower(name) LIKE ? OR lower(category) LIKE ? OR lower(spec) LIKE ? OR lower(location) LIKE ?')
        .bind(like, like, like, like).all()).results;
    } else {
      rows = (await env.DB.prepare(sql).all()).results;
    }
    rows.sort((a, b) => {
      const la = a.qty <= a.min_qty ? 0 : 1, lb = b.qty <= b.min_qty ? 0 : 1;
      if (la !== lb) return la - lb;
      return String(a.category).localeCompare(String(b.category), 'zh') ||
             String(a.name).localeCompare(String(b.name), 'zh') || a.id - b.id;
    });
    return json({ items: rows.map((it) => Object.assign({}, it, { low: it.qty <= it.min_qty })) });
  }

  if (path === '/api/items' && method === 'POST') {
    const me = await requireUser(env, request, true);
    const b = await request.json().catch(() => ({}));
    const name = str(b.name);
    if (!name) throw new ApiError(400, '物资名称不能为空');
    const qty = Math.max(0, toInt(b.qty, 0));
    const ts = nowStr();
    const unit = str(b.unit) || '个';
    const r = await env.DB.prepare(
      'INSERT INTO items(name,category,spec,unit,location,qty,min_qty,note,created_at,updated_at)' +
      ' VALUES(?,?,?,?,?,0,?,?,?,?)')
      .bind(name, str(b.category), str(b.spec), unit, str(b.location),
            Math.max(0, toInt(b.min_qty, 0)), str(b.note), ts, ts).run();
    const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(r.meta.last_row_id).first();
    if (qty > 0) await applyRecord(env, item, 'in', qty, '新建物资初始数量', me);
    const fresh = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(item.id).first();
    return json({ item: Object.assign({}, fresh, { low: fresh.qty <= fresh.min_qty }) }, 201);
  }

  let m = path.match(/^\/api\/items\/(\d+)$/);
  if (m && method === 'PUT') {
    await requireUser(env, request, true);
    const id = Number(m[1]);
    const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    if (!item) throw new ApiError(404, '物资不存在');
    const b = await request.json().catch(() => ({}));
    const f = {
      name: b.name !== undefined ? str(b.name) : item.name,
      category: b.category !== undefined ? str(b.category) : item.category,
      spec: b.spec !== undefined ? str(b.spec) : item.spec,
      unit: b.unit !== undefined ? (str(b.unit) || '个') : item.unit,
      location: b.location !== undefined ? str(b.location) : item.location,
      min_qty: b.min_qty !== undefined ? Math.max(0, toInt(b.min_qty, 0)) : item.min_qty,
      note: b.note !== undefined ? str(b.note) : item.note,
    };
    if (!f.name) throw new ApiError(400, '物资名称不能为空');
    await env.DB.prepare('UPDATE items SET name=?,category=?,spec=?,unit=?,location=?,min_qty=?,note=?,updated_at=? WHERE id=?')
      .bind(f.name, f.category, f.spec, f.unit, f.location, f.min_qty, f.note, nowStr(), id).run();
    await env.DB.prepare('UPDATE records SET item_name=?, item_unit=? WHERE item_id=?').bind(f.name, f.unit, id).run();
    const fresh = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
    return json({ item: Object.assign({}, fresh, { low: fresh.qty <= fresh.min_qty }) });
  }

  if (m && method === 'DELETE') {
    await requireUser(env, request, true);
    await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(Number(m[1])).run();
    return json({ ok: true });
  }

  /* ---------- 流水 ---------- */
  if (path === '/api/records' && method === 'GET') {
    await requireUser(env, request);
    const where = [];
    const args = [];
    if (q.get('item_id')) { where.push('item_id = ?'); args.push(toInt(q.get('item_id'), -1)); }
    if (TYPE_LABEL[q.get('type')]) { where.push('type = ?'); args.push(q.get('type')); }
    if (q.get('from')) { where.push('created_at >= ?'); args.push(q.get('from') + ' 00:00:00'); }
    if (q.get('to')) { where.push('created_at <= ?'); args.push(q.get('to') + ' 23:59:59'); }
    if (str(q.get('kw'))) {
      const like = '%' + str(q.get('kw')).toLowerCase() + '%';
      where.push('(lower(item_name) LIKE ? OR lower(operator) LIKE ? OR lower(note) LIKE ?)');
      args.push(like, like, like);
    }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM records' + w).bind(...args).first()).c;
    const limit = Math.min(500, Math.max(1, toInt(q.get('limit'), 100)));
    const offset = Math.max(0, toInt(q.get('offset'), 0));
    const rows = (await env.DB.prepare('SELECT * FROM records' + w + ' ORDER BY id DESC LIMIT ? OFFSET ?')
      .bind(...args, limit, offset).all()).results;
    return json({ records: rows, total });
  }

  if (path === '/api/records' && method === 'POST') {
    const me = await requireUser(env, request, true);   // 云端版同样：只有管理员能录入
    const b = await request.json().catch(() => ({}));
    const item = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(toInt(b.item_id, -1)).first();
    if (!item) throw new ApiError(400, '物资不存在');
    const rtype = b.type;
    if (!TYPE_LABEL[rtype]) throw new ApiError(400, '操作类型不正确');
    const qty = toInt(b.qty, NaN);
    if (!Number.isFinite(qty)) throw new ApiError(400, '数量填写不正确');
    if (rtype !== 'adjust' && qty <= 0) throw new ApiError(400, '数量必须大于 0');
    if (rtype === 'adjust' && qty < 0) throw new ApiError(400, '盘点数量不能为负');
    const rec = await applyRecord(env, item, rtype, qty, str(b.note), me);
    return json({ record: rec }, 201);
  }

  /* ---------- 清理流水（仅超级管理员） ---------- */
  if (path === '/api/records/purge' && method === 'POST') {
    const me = await requireUser(env, request);
    if (!isSuper(me)) throw new ApiError(403, '只有超级管理员能清理流水记录');
    const b = await request.json().catch(() => ({}));
    const scope = b.scope, from = str(b.from), to = str(b.to);
    let where, args, desc;
    if (scope === 'all') { where = ''; args = []; desc = '全部记录'; }
    else if (scope === 'before') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, '请选择要清理到哪一天');
      where = ' WHERE created_at <= ?'; args = [to + ' 23:59:59']; desc = to + ' 及之前';
    } else if (scope === 'range') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new ApiError(400, '请选择起止日期');
      if (from > to) throw new ApiError(400, '开始日期不能晚于结束日期');
      where = ' WHERE created_at >= ? AND created_at <= ?';
      args = [from + ' 00:00:00', to + ' 23:59:59']; desc = from + ' 至 ' + to;
    } else throw new ApiError(400, '清理范围不正确');

    const cnt = (await env.DB.prepare('SELECT COUNT(*) AS c FROM records' + where).bind(...args).first()).c;
    const remaining = (await env.DB.prepare('SELECT COUNT(*) AS c FROM records').first()).c;
    if (!cnt) return json({ deleted: 0, remaining, backup: null, message: '这个范围里没有记录，什么都没删' });
    await env.DB.prepare('DELETE FROM records' + where).bind(...args).run();
    return json({ deleted: cnt, remaining: remaining - cnt, backup: null, message: '已清理 ' + cnt + ' 条' });
  }

  /* ---------- 统计 ---------- */
  if (path === '/api/stats' && method === 'GET') {
    await requireUser(env, request);
    const today = nowStr().slice(0, 10);
    const kinds = (await env.DB.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(qty),0) AS total, COALESCE(SUM(qty <= min_qty),0) AS low FROM items').first());
    const tin = (await env.DB.prepare("SELECT COALESCE(SUM(qty),0) AS s FROM records WHERE type='in' AND created_at LIKE ?").bind(today + '%').first()).s;
    const tout = (await env.DB.prepare("SELECT COALESCE(SUM(qty),0) AS s FROM records WHERE type='out' AND created_at LIKE ?").bind(today + '%').first()).s;
    return json({ kinds: kinds.c, total: kinds.total, low: kinds.low, today_in: tin, today_out: tout });
  }

  /* ---------- 导出 ---------- */
  if (path === '/api/export' && method === 'GET') {
    await requireUser(env, request);
    const rows = (await env.DB.prepare('SELECT * FROM records ORDER BY id DESC').all()).results;
    const esc = (v) => '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['时间,物资,类型,数量,单位,变动前,变动后,操作人,备注'];
    rows.forEach((r) => {
      lines.push([r.created_at, r.item_name, TYPE_LABEL[r.type] || r.type, r.qty, r.item_unit,
                  r.before_qty, r.after_qty, r.operator, r.note].map(esc).join(','));
    });
    const fname = '物资流水_' + nowStr().slice(0, 10).replace(/-/g, '') + '.csv';
    return new Response('\ufeff' + lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fname),
        'Cache-Control': 'no-store',
      },
    });
  }

  /* ---------- 人员管理 ---------- */
  if (path === '/api/users' && method === 'GET') {
    await requireUser(env, request, true);
    const rows = (await env.DB.prepare('SELECT * FROM users').all()).results;
    rows.sort((a, b) => (a.role === b.role ? a.id - b.id : (a.role === 'admin' ? -1 : 1)));
    return json({ users: rows.map(publicUser) });
  }

  if (path === '/api/users' && method === 'POST') {
    const me = await requireUser(env, request, true);
    const b = await request.json().catch(() => ({}));
    const username = str(b.username);
    const name = str(b.display_name) || username;
    const pwd = b.password || '';
    const role = b.role === 'admin' ? 'admin' : 'member';
    checkUsername(username);
    if (role === 'admin' && !isSuper(me)) throw new ApiError(403, '只有超级管理员能创建管理员账号，你只能新增普通成员');
    if (String(pwd).length < 6) throw new ApiError(400, '密码至少 6 位');
    const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (dup) throw new ApiError(400, '这个账号已存在');
    await env.DB.prepare('INSERT INTO users(username,display_name,pwd,role,active,created_at) VALUES(?,?,?,?,1,?)')
      .bind(username, name, await hashPwd(pwd), role, nowStr()).run();
    return json({ ok: true }, 201);
  }

  m = path.match(/^\/api\/users\/(\d+)$/);
  if (m && method === 'PUT') {
    const me = await requireUser(env, request, true);
    const uid = Number(m[1]);
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
    if (!target) throw new ApiError(404, '用户不存在');
    const b = await request.json().catch(() => ({}));

    if (isSuper(target)) {
      if (!isSuper(me)) throw new ApiError(403, '超级管理员账号只能由超级管理员本人修改');
      if (b.role !== undefined && b.role !== 'super') throw new ApiError(400, '超级管理员的角色不能修改');
      if (b.active !== undefined && !b.active) throw new ApiError(400, '超级管理员不能被停用');
    }
    if (!isSuper(me) && isAdminRole(target) && target.id !== me.id) {
      throw new ApiError(403, '只有超级管理员能管理管理员账号');
    }
    if (b.role !== undefined && !isSuper(me)) {
      throw new ApiError(403, '只有超级管理员能设置角色（管理员 / 普通成员）');
    }

    let username = target.username;
    if (b.username !== undefined) {
      username = checkUsername(str(b.username));
      const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').bind(username, uid).first();
      if (dup) throw new ApiError(400, '这个登录账号已经有人用了');
    }
    const displayName = (b.display_name !== undefined && str(b.display_name)) ? str(b.display_name) : target.display_name;
    let pwd = target.pwd;
    if (b.password) {
      if (String(b.password).length < 6) throw new ApiError(400, '密码至少 6 位');
      pwd = await hashPwd(b.password);
    }
    let role = target.role;
    if (b.role && uid !== me.id) role = b.role === 'admin' ? 'admin' : 'member';
    else if (b.role && uid === me.id && b.role !== target.role) {
      throw new ApiError(400, '不能修改自己的角色，请让另一位管理员来改');
    }
    let active = target.active;
    if (b.active !== undefined) {
      if (uid === me.id) throw new ApiError(400, '不能停用自己');
      active = b.active ? 1 : 0;
      if (!active) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
    }
    await env.DB.prepare('UPDATE users SET username=?,display_name=?,pwd=?,role=?,active=? WHERE id=?')
      .bind(username, displayName, pwd, role, active, uid).run();
    return json({ ok: true });
  }

  if (m && method === 'DELETE') {
    const me = await requireUser(env, request, true);
    const uid = Number(m[1]);
    if (uid === me.id) throw new ApiError(400, '不能删除自己');
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
    if (!target) throw new ApiError(404, '用户不存在');
    if (isSuper(target)) throw new ApiError(403, '超级管理员账号不能删除（它是最后一把钥匙）');
    if (!isSuper(me) && isAdminRole(target)) throw new ApiError(403, '只有超级管理员能删除管理员账号');
    if (target.role === 'admin') {
      const left = (await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('admin','super') AND active=1 AND id<>?").bind(uid).first()).c;
      if (left === 0) throw new ApiError(400, '至少要保留一个管理员');
    }
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
    return json({ ok: true });
  }

  return null;
}

/* ========================= 入口 ========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // 其余请求交给静态资源（web/ 目录）
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    try {
      const res = await handleApi(request, env, url);
      if (res) return res;
      return json({ error: '接口不存在' }, 404);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      return json({ error: '服务器内部错误：' + e.message }, 500);
    }
  },
};
