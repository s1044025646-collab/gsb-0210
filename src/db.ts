// SQLite 持久化：冻结材料版本、扫描参数与结果快照。
// 使用 Node 内置 node:sqlite（Node >=22.5，DatabaseSync），无需原生编译，离线可用。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PointResult } from "./optics.js";

export interface StoredStack {
  id: number;
  name: string;
  payloadJson: string;
  createdAt: string;
}

export interface ScanRecord {
  id: number;
  kind: string;
  paramsJson: string;
  resultsJson: string;
  createdAt: string;
  note?: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        params_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  saveStack(name: string, payload: unknown): number {
    const stmt = this.db.prepare("INSERT INTO stacks(name, payload_json) VALUES (?, ?)");
    const info = stmt.run(name, JSON.stringify(payload)) as { lastInsertRowid: number | bigint };
    return Number(info.lastInsertRowid);
  }

  getStack(id: number): StoredStack | undefined {
    const row = this.db
      .prepare("SELECT id, name, payload_json AS payloadJson, created_at AS createdAt FROM stacks WHERE id = ?")
      .get(id) as StoredStack | undefined;
    return row;
  }

  listStacks(): StoredStack[] {
    return this.db
      .prepare("SELECT id, name, payload_json AS payloadJson, created_at AS createdAt FROM stacks ORDER BY id")
      .all() as unknown as StoredStack[];
  }

  freezeMaterial(name: string, spec: unknown): number {
    const verRow = this.db
      .prepare("SELECT COALESCE(MAX(version),0) AS v FROM materials WHERE name = ?")
      .get(name) as { v: number };
    const version = verRow.v + 1;
    this.db
      .prepare("INSERT INTO materials(name, version, spec_json) VALUES (?,?,?)")
      .run(name, version, JSON.stringify(spec));
    return version;
  }

 getMaterial(name: string, version?: number): { version: number; spec: unknown } | undefined {
    const row = version
      ? (this.db
          .prepare("SELECT version, spec_json AS spec FROM materials WHERE name=? AND version=?")
          .get(name, version) as { version: number; spec: string } | undefined)
      : (this.db
          .prepare("SELECT version, spec_json AS spec FROM materials WHERE name=? ORDER BY version DESC LIMIT 1")
          .get(name) as { version: number; spec: string } | undefined);
    return row ? { version: row.version, spec: JSON.parse(row.spec) } : undefined;
  }

  saveScan(
    kind: "point" | "wavelength" | "angle" | "diff",
    params: unknown,
    results: PointResult[] | unknown,
    note?: string,
  ): number {
    const info = this.db
      .prepare("INSERT INTO scans(kind, params_json, results_json, note) VALUES (?,?,?,?)")
      .run(kind, JSON.stringify(params), JSON.stringify(results), note ?? null) as {
      lastInsertRowid: number | bigint;
    };
    return Number(info.lastInsertRowid);
  }

  getScan(id: number): ScanRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id, kind, params_json AS paramsJson, results_json AS resultsJson, note, created_at AS createdAt FROM scans WHERE id=?",
      )
      .get(id) as ScanRecord | undefined;
    return row;
  }

  listScans(kind?: string): ScanRecord[] {
    const rows = kind
      ? (this.db
          .prepare(
            "SELECT id, kind, params_json AS paramsJson, results_json AS resultsJson, note, created_at AS createdAt FROM scans WHERE kind=? ORDER BY id",
          )
          .all(kind) as unknown as ScanRecord[])
      : (this.db
          .prepare(
            "SELECT id, kind, params_json AS paramsJson, results_json AS resultsJson, note, created_at AS createdAt FROM scans ORDER BY id",
          )
          .all() as unknown as ScanRecord[]);
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
