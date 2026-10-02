#!/usr/bin/env node
// 命令行接口：导入膜系、单点、扫描、比较、守恒核验、导出与历史读取。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./db.js";
import { importStack, mergeAdjacentEqual, StackDTO } from "./stackio.js";
import { computePoint, Pol } from "./optics.js";
import { angleScan, diffSpectra, findReflectanceMinima, wavelengthScan } from "./scan.js";
import { resultsToCsv, toJson } from "./exporters.js";

const DATA_DIR = process.env.THINFILM_DATA_DIR ?? join(process.cwd(), "data");
const store = new Store(join(DATA_DIR, "thinfilm.sqlite"));

function parseArgs(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(key, "true");
      else {
        flags.set(key, next);
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

function loadStack(path: string): StackDTO {
  return JSON.parse(readFileSync(path, "utf8")) as StackDTO;
}

function parsePols(v: string | undefined): Pol[] {
  if (!v) return ["s", "p"];
  const list = v.split(",").map((s) => s.trim());
  for (const p of list) if (p !== "s" && p !== "p") throw new Error("偏振只能是 s 或 p");
  return list as Pol[];
}

function emit(data: unknown, format: string, out?: string): void {
  const text = format === "csv" && Array.isArray(data) ? resultsToCsv(data as never) : toJson(data);
  if (out) {
    writeFileSync(out, text, "utf8");
    console.error(`已写入 ${out}`);
  } else process.stdout.write(text + "\n");
}

function help(): void {
  console.log(`thinfilm — 多层薄膜反射/透射/偏振分析 CLI

用法:
  thinfilm import  --file stack.json [--name 名称]
  thinfilm point   --file stack.json --wl 550 [--angle 0] [--pol s,p] [--save]
  thinfilm scan    --file stack.json --mode wavelength|angle
                   --start A --stop B --step C --fixed X [--pol s,p] [--minima] [--save]
  thinfilm compare --fileA a.json --fileB b.json --mode wavelength|angle
                   --start A --stop B --step C --fixed X [--pol s,p]
  thinfilm conserve --file stack.json --wl 550 [--angle 0]
  thinfilm merge-test --file stack.json --wl 550 --angle 0
  thinfilm history [--kind point|wavelength|angle|diff]
  thinfilm get --id N [--format csv]

通用选项:
  --format json|csv   输出格式（默认 json）
  --out path          写入文件而非标准输出
  --data-dir dir      数据目录（默认 ./data）
`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  if (!cmd || cmd === "help" || cmd === "--help") return help();
  const format = flags.get("format") ?? "json";
  const out = flags.get("out");

  switch (cmd) {
    case "import": {
      const dto = loadStack(required(flags, "file"));
      importStack(dto);
      const id = store.saveStack(flags.get("name") ?? dto.name ?? "stack", dto);
      return emit({ id, status: "frozen" }, format, out);
    }
    case "point": {
      const dto = loadStack(required(flags, "file"));
      const stack = importStack(dto);
      const wl = Number(required(flags, "wl"));
      const angle = Number(flags.get("angle") ?? "0");
      const results = parsePols(flags.get("pol")).map((p) => computePoint(stack, wl, angle, p));
      if (flags.has("save")) {
        const id = store.saveScan("point", { file: flags.get("file"), wl, angle }, results);
        return emit({ scanId: id, results }, format, out);
      }
      return emit(results, format, out);
    }
    case "scan": {
      const dto = loadStack(required(flags, "file"));
      const stack = importStack(dto);
      const mode = flags.get("mode") ?? "wavelength";
      const start = Number(required(flags, "start"));
      const stop = Number(required(flags, "stop"));
      const step = Number(required(flags, "step"));
      const fixed = Number(flags.get("fixed") ?? "0");
      const pols = parsePols(flags.get("pol"));
      const results =
        mode === "wavelength"
          ? wavelengthScan(stack, { startNm: start, stopNm: stop, stepNm: step }, fixed, pols)
          : angleScan(stack, { startDeg: start, stopDeg: stop, stepDeg: step }, fixed, pols);
      const id = store.saveScan(mode === "wavelength" ? "wavelength" : "angle", { mode, start, stop, step, fixed }, results);
      const payload: unknown = flags.has("minima")
        ? { scanId: id, results, minima: findReflectanceMinima(results) }
        : { scanId: id, results };
      return emit(payload, format, out);
    }
    case "compare": {
      const a = importStack(loadStack(required(flags, "fileA")));
      const b = importStack(loadStack(required(flags, "fileB")));
      const mode = flags.get("mode") ?? "wavelength";
      const start = Number(required(flags, "start"));
      const stop = Number(required(flags, "stop"));
      const step = Number(required(flags, "step"));
      const fixed = Number(flags.get("fixed") ?? "0");
      const pols = parsePols(flags.get("pol"));
      const ra =
        mode === "wavelength"
          ? wavelengthScan(a, { startNm: start, stopNm: stop, stepNm: step }, fixed, pols)
          : angleScan(a, { startDeg: start, stopDeg: stop, stepDeg: step }, fixed, pols);
      const rb =
        mode === "wavelength"
          ? wavelengthScan(b, { startNm: start, stopNm: stop, stepNm: step }, fixed, pols)
          : angleScan(b, { startDeg: start, stopDeg: stop, stepDeg: step }, fixed, pols);
      const diff = diffSpectra(ra, rb);
      const id = store.saveScan("diff", { mode, start, stop, step, fixed }, diff);
      return emit({ scanId: id, diff }, format, out);
    }
    case "conserve": {
      const stack = importStack(loadStack(required(flags, "file")));
      const wl = Number(required(flags, "wl"));
      const angle = Number(flags.get("angle") ?? "0");
      const results = parsePols(flags.get("pol")).map((p) => computePoint(stack, wl, angle, p));
      const ok = results.every((r) => r.converged && (r.balanceResidual ?? 1) < 1e-6);
      return emit({ verdict: ok ? "pass" : "check", results }, format, out);
    }
    case "merge-test": {
      const wl = Number(flags.get("wl") ?? "550");
      const angle = Number(flags.get("angle") ?? "0");
      const stack = importStack(loadStack(required(flags, "file")));
      const merged = mergeAdjacentEqual(stack, wl);
      const before = (["s", "p"] as Pol[]).map((p) => computePoint(stack, wl, angle, p));
      const after = (["s", "p"] as Pol[]).map((p) => computePoint(merged, wl, angle, p));
      return emit({ layersBefore: stack.layers.length, layersAfter: merged.layers.length, before, after }, format, out);
    }
    case "history": {
      return emit(
        store.listScans(flags.get("kind") as never).map((s) => ({ id: s.id, kind: s.kind, createdAt: s.createdAt, note: s.note })),
        format,
        out,
      );
    }
    case "get": {
      const row = store.getScan(Number(required(flags, "id")));
      if (!row) throw new Error("记录不存在");
      if (format === "csv") return emit(JSON.parse(row.resultsJson), "csv", out);
      return emit(row, "json", out);
    }
    default:
      help();
  }
}

function required(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new Error(`缺少必需参数 --${key}`);
  return v;
}

try {
  main();
} catch (err) {
  console.error(`错误: ${(err as Error).message}`);
  process.exit(1);
}
