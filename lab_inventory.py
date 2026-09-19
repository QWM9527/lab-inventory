#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验室物资清点小程序（单机版）
--------------------------------
零依赖：只用 Python 3 标准库（sqlite3 + http.server），双击即可运行。

功能：
  * 登录 / 退出，密码加密存储（PBKDF2-SHA256 + 随机盐）
  * 管理员 / 普通成员两级权限：
      - 管理员：增删改物资、管理人员账号、查全部流水
      - 普通成员：查看物资、录入领用(出库)与入库，可查流水
  * 物资清单：名称、类别、规格、单位、存放位置、当前数量、库存下限（低于下限高亮预警）
  * 出入库流水：每一笔都记录 时间 / 操作人 / 类型 / 数量 / 变动前后数量 / 备注
  * 盘点：直接修正数量（用错数字时用它改回来，保证账实相符）
  * 流水按物资、类型、日期筛选，支持导出 CSV（Excel 可直接打开）

用法：
    python lab_inventory.py                # 只允许本机访问
    python lab_inventory.py --host 0.0.0.0 # 允许同一局域网内的手机/其他电脑访问
    python lab_inventory.py --port 8000 --open
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "inventory.db")

SESSION_DAYS = 7
PBKDF2_ROUNDS = 200_000
DEFAULT_ADMIN = ("admin", "管理员", "admin123")

_lock = threading.RLock()          # 初始化用
_login_fail = {}                   # ip -> [失败次数, 锁定到期时间戳]
_login_fail_lock = threading.Lock()


# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    pwd          TEXT    NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'member',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT '',
    spec       TEXT    NOT NULL DEFAULT '',
    unit       TEXT    NOT NULL DEFAULT '个',
    location   TEXT    NOT NULL DEFAULT '',
    qty        INTEGER NOT NULL DEFAULT 0,
    min_qty    INTEGER NOT NULL DEFAULT 0,
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER,
    item_name   TEXT    NOT NULL,
    item_unit   TEXT    NOT NULL DEFAULT '个',
    type        TEXT    NOT NULL,          -- in / out / adjust
    qty         INTEGER NOT NULL,
    before_qty  INTEGER NOT NULL,
    after_qty   INTEGER NOT NULL,
    operator    TEXT    NOT NULL,
    operator_id INTEGER,
    note        TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_item ON records(item_id);
CREATE INDEX IF NOT EXISTS idx_records_time ON records(created_at);
"""


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_pwd(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS)
    return "%s$%s" % (salt, dk.hex())


def verify_pwd(password, stored):
    try:
        salt, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(hash_pwd(password, salt), stored)


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with _lock, connect() as conn:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")
        row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
        if row["c"] == 0:
            conn.execute(
                "INSERT INTO users(username, display_name, pwd, role, active, created_at) VALUES(?,?,?,?,1,?)",
                (DEFAULT_ADMIN[0], DEFAULT_ADMIN[1], hash_pwd(DEFAULT_ADMIN[2]), "admin", now_str()),
            )
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_str(),))
        conn.commit()


# --------------------------------------------------------------------------
# 业务逻辑
# --------------------------------------------------------------------------

def get_session_user(conn, token):
    if not token:
        return None
    row = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
    if not row or row["expires_at"] < now_str():
        return None
    u = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    if not u or not u["active"]:
        return None
    return u


def public_user(u):
    return {
        "id": u["id"],
        "username": u["username"],
        "display_name": u["display_name"],
        "role": u["role"],
        "active": u["active"],
    }


def item_dict(r):
    return {
        "id": r["id"],
        "name": r["name"],
        "category": r["category"],
        "spec": r["spec"],
        "unit": r["unit"],
        "location": r["location"],
        "qty": r["qty"],
        "min_qty": r["min_qty"],
        "note": r["note"],
        "updated_at": r["updated_at"],
        "low": r["qty"] <= r["min_qty"],
    }


def record_dict(r):
    return {
        "id": r["id"],
        "item_id": r["item_id"],
        "item_name": r["item_name"],
        "item_unit": r["item_unit"],
        "type": r["type"],
        "qty": r["qty"],
        "before_qty": r["before_qty"],
        "after_qty": r["after_qty"],
        "operator": r["operator"],
        "note": r["note"],
        "created_at": r["created_at"],
    }


TYPE_LABEL = {"in": "入库", "out": "领用", "adjust": "盘点"}


def apply_record(conn, item_id, rtype, qty, note, user):
    """在同一个事务里：改库存 + 写流水。返回流水 dict。"""
    item = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
    if not item:
        raise ValueError("物资不存在")
    before = item["qty"]
    if rtype == "in":
        after = before + qty
    elif rtype == "out":
        after = before - qty
        if after < 0:
            raise ValueError("库存不足：现有 %d %s，无法领用 %d %s" % (before, item["unit"], qty, item["unit"]))
    elif rtype == "adjust":
        after = qty
    else:
        raise ValueError("未知类型")

    ts = now_str()
    conn.execute("UPDATE items SET qty = ?, updated_at = ? WHERE id = ?", (after, ts, item_id))
    cur = conn.execute(
        "INSERT INTO records(item_id, item_name, item_unit, type, qty, before_qty, after_qty,"
        " operator, operator_id, note, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (item_id, item["name"], item["unit"], rtype, qty, before, after,
         user["display_name"], user["id"], note, ts),
    )
    row = conn.execute("SELECT * FROM records WHERE id = ?", (cur.lastrowid,)).fetchone()
    return record_dict(row)


# --------------------------------------------------------------------------
# HTTP 层
# --------------------------------------------------------------------------

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "LabInventory/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------- 基础工具 ----------------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def _cookies(self):
        c = SimpleCookie()
        c.load(self.headers.get("Cookie", ""))
        return c

    def _send(self, status, body=b"", ctype="text/plain; charset=utf-8", extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, data, status=200, extra_headers=None):
        self._send(status, json.dumps(data, ensure_ascii=False), "application/json; charset=utf-8", extra_headers)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise ApiError(400, "请求格式错误")
        if not isinstance(data, dict):
            raise ApiError(400, "请求格式错误")
        return data

    def _auth(self, conn, need_admin=False):
        token = self._cookies().get("session")
        user = get_session_user(conn, token.value if token else None)
        if not user:
            raise ApiError(401, "请先登录")
        if need_admin and user["role"] != "admin":
            raise ApiError(403, "只有管理员有权限做这个操作")
        return user

    # ---------------- 路由 ----------------
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self._api(method, path, query)
            elif method == "GET":
                self._static(path)
            else:
                self._send(404, "Not Found")
        except ApiError as e:
            self._json({"error": e.message}, e.status)
        except ValueError as e:
            self._json({"error": str(e)}, 400)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[error] %s %s -> %r\n" % (method, path, e))
            self._json({"error": "服务器内部错误：%s" % e}, 500)

    # ---------------- 静态文件 ----------------
    def _static(self, path):
        if path in ("/", "/index.html"):
            rel = "index.html"
        else:
            rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            self._send(404, "页面不存在")
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    # ---------------- API ----------------
    def _api(self, method, path, query):
        # ---- 登录相关 ----
        if path == "/api/login" and method == "POST":
            data = self._read_json()
            username = (data.get("username") or "").strip()
            password = data.get("password") or ""
            ip = self.client_address[0]
            with _login_fail_lock:
                fails, until = _login_fail.get(ip, [0, 0])
                if until > time.time():
                    raise ApiError(429, "失败次数过多，请 %d 秒后再试" % int(until - time.time()))
            with connect() as conn:
                row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                if not row or not verify_pwd(password, row["pwd"]) or not row["active"]:
                    with _login_fail_lock:
                        fails += 1
                        _login_fail[ip] = [fails, time.time() + 30 if fails >= 5 else 0]
                    raise ApiError(401, "账号或密码不对")
                with _login_fail_lock:
                    _login_fail.pop(ip, None)
                token = secrets.token_urlsafe(32)
                expires = (datetime.now() + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
                conn.execute("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)", (token, row["id"], expires))
                conn.commit()
            cookie = "session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (token, SESSION_DAYS * 86400)
            self._json({"user": public_user(row)}, extra_headers=[("Set-Cookie", cookie)])
            return

        if path == "/api/logout" and method == "POST":
            token = self._cookies().get("session")
            if token:
                with connect() as conn:
                    conn.execute("DELETE FROM sessions WHERE token = ?", (token.value,))
                    conn.commit()
            cookie = "session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
            self._json({"ok": True}, extra_headers=[("Set-Cookie", cookie)])
            return

        with connect() as conn:
            if path == "/api/me" and method == "GET":
                c = self._cookies()
                user = get_session_user(conn, c["session"].value if "session" in c else None)
                self._json({"user": public_user(user) if user else None})
                return

            if path == "/api/password" and method == "POST":
                user = self._auth(conn)
                data = self._read_json()
                old, new = data.get("old_password") or "", data.get("new_password") or ""
                if not verify_pwd(old, user["pwd"]):
                    raise ApiError(400, "原密码不对")
                if len(new) < 6:
                    raise ApiError(400, "新密码至少 6 位")
                conn.execute("UPDATE users SET pwd = ? WHERE id = ?", (hash_pwd(new), user["id"]))
                conn.commit()
                self._json({"ok": True})
                return

            # ---- 物资 ----
            if path == "/api/items" and method == "GET":
                self._auth(conn)
                kw = (query.get("kw", [""])[0] or "").strip()
                sql = "SELECT * FROM items"
                params = []
                if kw:
                    sql += " WHERE name LIKE ? OR category LIKE ? OR spec LIKE ? OR location LIKE ?"
                    params = ["%%%s%%" % kw] * 4
                sql += " ORDER BY (qty <= min_qty) DESC, category, name, id"
                rows = conn.execute(sql, params).fetchall()
                self._json({"items": [item_dict(r) for r in rows]})
                return

            if path == "/api/items" and method == "POST":
                user = self._auth(conn, need_admin=True)
                d = self._read_json()
                name = (d.get("name") or "").strip()
                if not name:
                    raise ApiError(400, "物资名称不能为空")
                ts = now_str()
                qty = int(d.get("qty") or 0)
                if qty < 0:
                    raise ApiError(400, "数量不能为负")
                cur = conn.execute(
                    "INSERT INTO items(name, category, spec, unit, location, qty, min_qty, note, created_at, updated_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (name, (d.get("category") or "").strip(), (d.get("spec") or "").strip(),
                     (d.get("unit") or "个").strip() or "个", (d.get("location") or "").strip(),
                     0, max(0, int(d.get("min_qty") or 0)), (d.get("note") or "").strip(), ts, ts),
                )
                if qty > 0:
                    conn.execute(
                        "INSERT INTO records(item_id, item_name, item_unit, type, qty, before_qty, after_qty,"
                        " operator, operator_id, note, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (cur.lastrowid, name, (d.get("unit") or "个").strip() or "个", "in", qty, 0, qty,
                         user["display_name"], user["id"], "新建物资初始数量", ts),
                    )
                conn.commit()
                row = conn.execute("SELECT * FROM items WHERE id = ?", (cur.lastrowid,)).fetchone()
                self._json({"item": item_dict(row)}, 201)
                return

            m = re.fullmatch(r"/api/items/(\d+)", path)
            if m and method == "PUT":
                self._auth(conn, need_admin=True)
                iid = int(m.group(1))
                d = self._read_json()
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                if not row:
                    raise ApiError(404, "物资不存在")
                fields = dict(row)
                for k in ("name", "category", "spec", "unit", "location", "note"):
                    if k in d:
                        fields[k] = (d[k] or "").strip()
                if not fields["name"]:
                    raise ApiError(400, "物资名称不能为空")
                fields["unit"] = fields["unit"] or "个"
                if "min_qty" in d:
                    fields["min_qty"] = max(0, int(d["min_qty"] or 0))
                conn.execute(
                    "UPDATE items SET name=?, category=?, spec=?, unit=?, location=?, min_qty=?, note=?, updated_at=? WHERE id=?",
                    (fields["name"], fields["category"], fields["spec"], fields["unit"],
                     fields["location"], fields["min_qty"], fields["note"], now_str(), iid),
                )
                # 名称/单位变了，同步历史流水里的展示名
                conn.execute("UPDATE records SET item_name=?, item_unit=? WHERE item_id=?", (fields["name"], fields["unit"], iid))
                conn.commit()
                row = conn.execute("SELECT * FROM items WHERE id = ?", (iid,)).fetchone()
                self._json({"item": item_dict(row)})
                return

            if m and method == "DELETE":
                self._auth(conn, need_admin=True)
                iid = int(m.group(1))
                conn.execute("DELETE FROM items WHERE id = ?", (iid,))
                conn.commit()
                self._json({"ok": True})
                return

            # ---- 出入库 ----
            if path == "/api/records" and method == "GET":
                self._auth(conn)
                where, params = [], []
                if query.get("item_id", [""])[0]:
                    where.append("item_id = ?")
                    params.append(int(query["item_id"][0]))
                if query.get("type", [""])[0] in TYPE_LABEL:
                    where.append("type = ?")
                    params.append(query["type"][0])
                if query.get("from", [""])[0]:
                    where.append("created_at >= ?")
                    params.append(query["from"][0] + " 00:00:00")
                if query.get("to", [""])[0]:
                    where.append("created_at <= ?")
                    params.append(query["to"][0] + " 23:59:59")
                if query.get("kw", [""])[0].strip():
                    where.append("(item_name LIKE ? OR operator LIKE ? OR note LIKE ?)")
                    params += ["%%%s%%" % query["kw"][0].strip()] * 3
                sql = "SELECT * FROM records"
                if where:
                    sql += " WHERE " + " AND ".join(where)
                total = conn.execute(sql.replace("SELECT *", "SELECT COUNT(*) AS c", 1), params).fetchone()["c"]
                limit = min(500, max(1, int(query.get("limit", ["100"])[0] or 100)))
                offset = max(0, int(query.get("offset", ["0"])[0] or 0))
                sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
                rows = conn.execute(sql, params + [limit, offset]).fetchall()
                self._json({"records": [record_dict(r) for r in rows], "total": total})
                return

            if path == "/api/records" and method == "POST":
                user = self._auth(conn)          # 普通成员也能录入
                d = self._read_json()
                try:
                    item_id = int(d.get("item_id"))
                    qty = int(d.get("qty"))
                except (TypeError, ValueError):
                    raise ApiError(400, "物资或数量填写不正确")
                rtype = d.get("type")
                if rtype not in TYPE_LABEL:
                    raise ApiError(400, "操作类型不正确")
                if rtype != "adjust" and qty <= 0:
                    raise ApiError(400, "数量必须大于 0")
                if rtype == "adjust" and qty < 0:
                    raise ApiError(400, "盘点数量不能为负")
                conn.execute("BEGIN IMMEDIATE")
                rec = apply_record(conn, item_id, rtype, qty, (d.get("note") or "").strip(), user)
                conn.commit()
                self._json({"record": rec}, 201)
                return

            # ---- 统计 ----
            if path == "/api/stats" and method == "GET":
                self._auth(conn)
                items = conn.execute("SELECT COUNT(*) AS kinds, COALESCE(SUM(qty),0) AS total,"
                                     " COALESCE(SUM(qty <= min_qty),0) AS low FROM items").fetchone()
                today = datetime.now().strftime("%Y-%m-%d")
                tin = conn.execute("SELECT COALESCE(SUM(qty),0) AS s FROM records WHERE type='in' AND created_at LIKE ?",
                                   (today + "%",)).fetchone()["s"]
                tout = conn.execute("SELECT COALESCE(SUM(qty),0) AS s FROM records WHERE type='out' AND created_at LIKE ?",
                                    (today + "%",)).fetchone()["s"]
                self._json({"kinds": items["kinds"], "total": items["total"], "low": items["low"],
                            "today_in": tin, "today_out": tout})
                return

            # ---- 导出 ----
            if path == "/api/export" and method == "GET":
                self._auth(conn)
                rows = conn.execute("SELECT * FROM records ORDER BY id DESC").fetchall()
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(["时间", "物资", "类型", "数量", "单位", "变动前", "变动后", "操作人", "备注"])
                for r in rows:
                    w.writerow([r["created_at"], r["item_name"], TYPE_LABEL.get(r["type"], r["type"]), r["qty"],
                                r["item_unit"], r["before_qty"], r["after_qty"], r["operator"], r["note"]])
                data = "\ufeff" + buf.getvalue()          # BOM，Excel 打开不乱码
                filename = "物资流水_%s.csv" % datetime.now().strftime("%Y%m%d_%H%M")
                from urllib.parse import quote
                self._send(200, data.encode("utf-8"), "text/csv; charset=utf-8",
                           [("Content-Disposition", "attachment; filename*=UTF-8''%s" % quote(filename))])
                return

            # ---- 用户管理（仅管理员）----
            if path == "/api/users" and method == "GET":
                self._auth(conn, need_admin=True)
                rows = conn.execute("SELECT * FROM users ORDER BY role, id").fetchall()
                self._json({"users": [public_user(r) for r in rows]})
                return

            if path == "/api/users" and method == "POST":
                self._auth(conn, need_admin=True)
                d = self._read_json()
                username = (d.get("username") or "").strip()
                name = (d.get("display_name") or "").strip() or username
                pwd = d.get("password") or ""
                role = d.get("role") if d.get("role") in ("admin", "member") else "member"
                if not re.fullmatch(r"[A-Za-z0-9_.@-]{2,32}", username):
                    raise ApiError(400, "账号需 2-32 位字母、数字或 _ . @ -")
                if len(pwd) < 6:
                    raise ApiError(400, "密码至少 6 位")
                if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                    raise ApiError(400, "这个账号已存在")
                conn.execute("INSERT INTO users(username, display_name, pwd, role, active, created_at) VALUES(?,?,?,?,1,?)",
                             (username, name, hash_pwd(pwd), role, now_str()))
                conn.commit()
                self._json({"ok": True}, 201)
                return

            m = re.fullmatch(r"/api/users/(\d+)", path)
            if m and method == "PUT":
                me = self._auth(conn, need_admin=True)
                uid = int(m.group(1))
                target = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
                if not target:
                    raise ApiError(404, "用户不存在")
                d = self._read_json()
                if "display_name" in d and (d["display_name"] or "").strip():
                    conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (d["display_name"].strip(), uid))
                if d.get("password"):
                    if len(d["password"]) < 6:
                        raise ApiError(400, "密码至少 6 位")
                    conn.execute("UPDATE users SET pwd = ? WHERE id = ?", (hash_pwd(d["password"]), uid))
                if d.get("role") in ("admin", "member") and uid != me["id"]:
                    conn.execute("UPDATE users SET role = ? WHERE id = ?", (d["role"], uid))
                if "active" in d:
                    if uid == me["id"]:
                        raise ApiError(400, "不能停用自己")
                    conn.execute("UPDATE users SET active = ? WHERE id = ?", (1 if d["active"] else 0, uid))
                    if not d["active"]:
                        conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
                conn.commit()
                self._json({"ok": True})
                return

            if m and method == "DELETE":
                me = self._auth(conn, need_admin=True)
                uid = int(m.group(1))
                if uid == me["id"]:
                    raise ApiError(400, "不能删除自己")
                target = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
                if not target:
                    raise ApiError(404, "用户不存在")
                if target["role"] == "admin":
                    left = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND id<>?", (uid,)).fetchone()["c"]
                    if left == 0:
                        raise ApiError(400, "至少要保留一个管理员")
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
                conn.execute("DELETE FROM users WHERE id = ?", (uid,))
                conn.commit()
                self._json({"ok": True})
                return

        self._json({"error": "接口不存在"}, 404)


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="实验室物资清点小程序")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 表示允许局域网访问")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = parser.parse_args()

    init_db()
    url = "http://127.0.0.1:%d/" % args.port
    print("=" * 58)
    print("  实验室物资清点系统 已启动")
    print("=" * 58)
    print("  本机访问 : %s" % url)
    if args.host == "0.0.0.0":
        print("  局域网访问: http://%s:%d/   （手机连同一个 WiFi 可打开）" % (lan_ip(), args.port))
    print("  数据文件 : %s" % DB_PATH)
    print("  默认管理员: admin / admin123   ← 登录后请立刻改密码")
    print("  按 Ctrl+C 关闭服务")
    print("=" * 58)

    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
