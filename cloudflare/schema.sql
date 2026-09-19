-- ============================================================
--  实验室物资清点 —— Cloudflare D1 数据库结构
--  用法：npx wrangler d1 execute lab-inventory --remote --file=cloudflare/schema.sql
-- ============================================================

DROP TABLE IF EXISTS users;
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  pwd          TEXT    NOT NULL,              -- 格式：盐$PBKDF2哈希
  role         TEXT    NOT NULL DEFAULT 'member',   -- super / admin / member
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);

DROP TABLE IF EXISTS items;
CREATE TABLE items (
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

DROP TABLE IF EXISTS records;
CREATE TABLE records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER,
  item_name   TEXT    NOT NULL,
  item_unit   TEXT    NOT NULL DEFAULT '个',
  type        TEXT    NOT NULL,              -- in 入库 / out 领用 / adjust 盘点
  qty         INTEGER NOT NULL,
  before_qty  INTEGER NOT NULL,
  after_qty   INTEGER NOT NULL,
  operator    TEXT    NOT NULL,
  operator_id INTEGER,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_records_item ON records(item_id);
CREATE INDEX idx_records_time ON records(created_at);

DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                -- 毫秒时间戳
);

-- 登录失败次数（防暴力破解）
DROP TABLE IF EXISTS login_fail;
CREATE TABLE login_fail (
  ip    TEXT    PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);
