const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'contracts.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT NOT NULL,
    client_cedula TEXT NOT NULL,
    client_phone TEXT,
    client_address TEXT,
    prestamo REAL NOT NULL,
    cuota REAL NOT NULL,
    precio REAL NOT NULL,
    deuda_total REAL NOT NULL,
    confianza TEXT NOT NULL CHECK(confianza IN ('Alta', 'Media', 'Baja')),
    cuotas_realizadas INTEGER NOT NULL DEFAULT 0,
    signing_token TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'signed')),
    signature_data TEXT,
    contract_pdf_path TEXT,
    contract_pdf_original_name TEXT,
    contract_pdf_uploaded_at TEXT,
    signed_pdf_path TEXT,
    signed_pdf_generated_at TEXT,
    signed_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// Migration: add cuotas_realizadas if missing
try {
  db.exec(`ALTER TABLE contracts ADD COLUMN cuotas_realizadas INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE contracts ADD COLUMN contract_pdf_path TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE contracts ADD COLUMN contract_pdf_original_name TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE contracts ADD COLUMN contract_pdf_uploaded_at TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE contracts ADD COLUMN signed_pdf_path TEXT`);
} catch (e) {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE contracts ADD COLUMN signed_pdf_generated_at TEXT`);
} catch (e) {
  // Column already exists
}

module.exports = db;
