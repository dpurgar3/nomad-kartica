// Podatkovni sloj: SQLite baza, migracije i početni podaci.
// Migracije se izvode redom i samo jednom (tablica schema_migrations); nikad ne brišu postojeće podatke.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  {
    id: 1, name: 'pocetna_shema', sql: `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      pin_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    -- kolicine i cijene: cijeli brojevi x10000 (4 decimale); iznosi: centi
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      remaris_code TEXT,
      name TEXT NOT NULL,
      remaris_name TEXT,
      category_id INTEGER REFERENCES categories(id),
      supplier TEXT,
      unit TEXT NOT NULL CHECK (unit IN ('kom','l','ml','dl','kg','g')),
      purchase_price_e4 INTEGER CHECK (purchase_price_e4 IS NULL OR purchase_price_e4 >= 0),
      price_source TEXT,
      vat_rate INTEGER CHECK (vat_rate IS NULL OR vat_rate IN (0,5,13,25)),
      min_qty_e4 INTEGER CHECK (min_qty_e4 IS NULL OR min_qty_e4 >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE packagings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      name TEXT NOT NULL,
      qty_e4 INTEGER NOT NULL CHECK (qty_e4 > 0),
      UNIQUE(article_id, name)
    );
    CREATE TABLE stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES articles(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      type TEXT NOT NULL,
      qty_e4 INTEGER NOT NULL,
      unit_price_e4 INTEGER,
      reason TEXT,
      movement_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      inventory_id INTEGER REFERENCES inventories(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_mov_article ON stock_movements(article_id, location_id);
    CREATE TABLE inventories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      inv_date TEXT NOT NULL,
      location_id INTEGER NOT NULL REFERENCES locations(id),
      status TEXT NOT NULL DEFAULT 'u_tijeku' CHECK (status IN ('u_tijeku','zakljucena')),
      note TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_by INTEGER REFERENCES users(id),
      closed_at TEXT
    );
    CREATE TABLE inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id INTEGER NOT NULL REFERENCES inventories(id),
      article_id INTEGER NOT NULL REFERENCES articles(id),
      expected_qty_e4 INTEGER NOT NULL,
      counted_qty_e4 INTEGER,
      price_e4 INTEGER,
      note TEXT,
      updated_at TEXT,
      UNIQUE(inventory_id, article_id)
    );
    CREATE TABLE inventory_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      input_qty_e4 INTEGER NOT NULL,
      input_label TEXT NOT NULL,
      qty_e4 INTEGER NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE TABLE inventory_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      old_qty_e4 INTEGER,
      new_qty_e4 INTEGER NOT NULL,
      reason TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      reason TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  ` },
];

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
    })();
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { open, migrate, MIGRATIONS };
