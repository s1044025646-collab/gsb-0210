import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SavedStack {
  id: number;
  name: string;
  version: number;
  snapshot: unknown;
  createdAt: string;
}

export interface SavedScan {
  id: number;
  kind: string;
  params: unknown;
  result: unknown;
  createdAt: string;
}

export function openDatabase(filePath = "data/optics.sqlite"): DatabaseSync {
  const absolute = resolve(filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const db = new DatabaseSync(absolute);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      refractive_index_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS stacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      params_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function saveMaterial(db: DatabaseSync, name: string, refractiveIndex: unknown): SavedStack["version"] {
  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM materials WHERE name = ?").get(name) as { version: number };
  const version = current.version + 1;
  db.prepare("INSERT INTO materials(name, version, refractive_index_json) VALUES (?, ?, ?)").run(name, version, JSON.stringify(refractiveIndex));
  return version;
}

export function saveStack(db: DatabaseSync, name: string, snapshot: unknown): number {
  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM stacks WHERE name = ?").get(name) as { version: number };
  const version = current.version + 1;
  db.prepare("INSERT INTO stacks(name, version, snapshot_json) VALUES (?, ?, ?)").run(name, version, JSON.stringify(snapshot));
  return version;
}

export function getStack(db: DatabaseSync, name: string, version?: number): SavedStack {
  const row = version
    ? (db.prepare("SELECT * FROM stacks WHERE name = ? AND version = ?").get(name, version) as Record<string, unknown> | undefined)
    : (db.prepare("SELECT * FROM stacks WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as Record<string, unknown> | undefined);
  if (!row) throw new Error(`未找到膜系 ${name}${version ? ` 版本 ${version}` : ""}`);
  return {
    id: Number(row.id),
    name: String(row.name),
    version: Number(row.version),
    snapshot: JSON.parse(String(row.snapshot_json)),
    createdAt: String(row.created_at)
  };
}

export function listStacks(db: DatabaseSync): SavedStack[] {
  const rows = db.prepare("SELECT * FROM stacks ORDER BY name, version").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    version: Number(row.version),
    snapshot: JSON.parse(String(row.snapshot_json)),
    createdAt: String(row.created_at)
  }));
}

export function listMaterials(db: DatabaseSync): Array<{ name: string; version: number; refractiveIndex: unknown; createdAt: string }> {
  const rows = db.prepare("SELECT * FROM materials ORDER BY name, version").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    name: String(row.name),
    version: Number(row.version),
    refractiveIndex: JSON.parse(String(row.refractive_index_json)),
    createdAt: String(row.created_at)
  }));
}

export function saveScan(db: DatabaseSync, kind: string, params: unknown, result: unknown): number {
  const resultRun = db
    .prepare("INSERT INTO scans(kind, params_json, result_json) VALUES (?, ?, ?)")
    .run(kind, JSON.stringify(params), JSON.stringify(result));
  return Number(resultRun.lastInsertRowid);
}

export function getScan(db: DatabaseSync, id: number): SavedScan {
  const row = db.prepare("SELECT * FROM scans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`未找到扫描结果 ${id}`);
  return {
    id: Number(row.id),
    kind: String(row.kind),
    params: JSON.parse(String(row.params_json)),
    result: JSON.parse(String(row.result_json)),
    createdAt: String(row.created_at)
  };
}

export function listScans(db: DatabaseSync, limit = 50): SavedScan[] {
  const rows = db.prepare("SELECT id, kind, params_json, result_json, created_at FROM scans ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: Number(row.id),
    kind: String(row.kind),
    params: JSON.parse(String(row.params_json)),
    result: JSON.parse(String(row.result_json)),
    createdAt: String(row.created_at)
  }));
}
