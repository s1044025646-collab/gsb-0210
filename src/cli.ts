import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getStack, getScan, listMaterials, listScans, listStacks, openDatabase, saveMaterial, saveScan, saveStack } from "./db.js";
import { calculatePoint, ValidationError, validateStack } from "./optics.js";
import { compareScans, findMinima, flattenCsv, runScan } from "./scan.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        options.set(key, next);
        index += 1;
      } else {
        options.set(key, "true");
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional.shift() ?? "help", positional, options };
}

function readJsonFile(file?: string): unknown {
  if (!file) throw new ValidationError("--input", "需要提供 JSON 输入文件");
  return JSON.parse(readFileSync(resolve(file), "utf8"));
}

const bareSubstrate = {
  incident: { name: "air", refractiveIndex: 1 },
  layers: [],
  substrate: { name: "glass", refractiveIndex: 1.5 }
};

const antiReflection = {
  incident: { name: "air", refractiveIndex: 1 },
  layers: [{ name: "MgF2-like quarter-wave", refractiveIndex: Math.sqrt(1.5), thicknessNm: 100 / Math.sqrt(1.5) }],
  substrate: { name: "glass", refractiveIndex: 1.5 }
};

const absorbingFilm = {
  incident: { name: "air", refractiveIndex: 1 },
  layers: [{ name: "absorber", refractiveIndex: { re: 2.2, im: 0.35 }, thicknessNm: 80 }],
  substrate: { name: "glass", refractiveIndex: 1.5 }
};

function writeOutput(path: string | undefined, content: string): void {
  if (!path) {
    console.log(content);
    return;
  }
  const absolute = resolve(path);
  mkdirSync(resolve(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content, "utf8");
  console.log(`已写入 ${absolute}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.options.get("data-dir") ?? "data", "optics.sqlite");
  const db: DatabaseSync = openDatabase(dbPath);

  try {
    if (args.command === "import") {
      const body = readJsonFile(args.options.get("input")) as { name?: string; stack?: unknown };
      const name = args.options.get("name") ?? body.name;
      if (!name) throw new ValidationError("name", "需要 --name 或 JSON.name");
      validateStack(body.stack as never);
      console.log(JSON.stringify({ name, version: saveStack(db, name, body.stack), frozen: true }, null, 2));
    } else if (args.command === "import-material") {
      const body = readJsonFile(args.options.get("input")) as { name?: string; refractiveIndex?: unknown };
      const name = args.options.get("name") ?? body.name;
      if (!name) throw new ValidationError("name", "需要 --name 或 JSON.name");
      console.log(JSON.stringify({ name, version: saveMaterial(db, name, body.refractiveIndex), frozen: true }, null, 2));
    } else if (args.command === "materials") {
      console.log(JSON.stringify(listMaterials(db), null, 2));
    } else if (args.command === "compare") {
      const left = runScan(readJsonFile(args.options.get("left")) as never);
      const right = runScan(readJsonFile(args.options.get("right")) as never);
      const difference = compareScans(left.points, right.points);
      const id = saveScan(db, "compare", { left: args.options.get("left"), right: args.options.get("right") }, difference);
      writeOutput(args.options.get("out-json"), JSON.stringify({ id, points: difference }, null, 2));
    } else if (args.command === "point") {
      const body = readJsonFile(args.options.get("input"));
      console.log(JSON.stringify(calculatePoint(body as never), null, 2));
    } else if (args.command === "scan") {
      const body = readJsonFile(args.options.get("input"));
      const scan = runScan(body as never);
      const result = { ...scan, minima: findMinima(scan.points), samplingNotice: "极小值仅在离散采样点中选择；离散扫描不保证找到连续全局最优。" };
      const id = saveScan(db, "scan", body, result);
      const output = JSON.stringify({ id, ...result }, null, 2);
      writeOutput(args.options.get("out-json"), args.options.get("format") === "csv" ? flattenCsv(scan.points) : output);
    } else if (args.command === "history") {
      if (args.positional[0]) console.log(JSON.stringify(getScan(db, Number(args.positional[0])), null, 2));
      else console.log(JSON.stringify(listScans(db, Number(args.options.get("limit") ?? 50)), null, 2));
    } else if (args.command === "stacks") {
      console.log(JSON.stringify(listStacks(db), null, 2));
    } else if (args.command === "export") {
      const id = Number(args.options.get("scan-id"));
      const scan = getScan(db, id);
      const points = (scan.result as { points?: Parameters<typeof flattenCsv>[0] }).points ?? [];
      writeOutput(args.options.get("out"), args.options.get("format") === "json" ? JSON.stringify(scan, null, 2) : flattenCsv(points));
    } else if (args.command === "demo") {
      const bareVersion = saveStack(db, "bare-glass-demo", bareSubstrate);
      const arVersion = saveStack(db, "quarter-wave-ar-demo", antiReflection);
      const scanBody = { stack: antiReflection, wavelengthStartNm: 300, wavelengthStopNm: 700, wavelengthStepNm: 5, angleDeg: 0 };
      const scan = runScan(scanBody);
      const scanId = saveScan(db, "demo-spectrum", scanBody, { ...scan, minima: findMinima(scan.points) });
      const angle = runScan({ stack: antiReflection, wavelengthNm: 400, angleStartDeg: 0, angleStopDeg: 80, angleStepDeg: 2 });
      const angleId = saveScan(db, "demo-angle", { stack: antiReflection, wavelengthNm: 400 }, angle);
      const absorption = calculatePoint({ stack: absorbingFilm, wavelengthNm: 550, angleDeg: 0, polarization: "both" });
      console.log(JSON.stringify({
        dbPath,
        frozenStacks: { bareGlass: bareVersion, quarterWaveAR: arVersion },
        atDesignWavelength: calculatePoint({ stack: antiReflection, wavelengthNm: 400, angleDeg: 0, polarization: "both" }),
        bareSubstrateAtSameWavelength: calculatePoint({ stack: bareSubstrate, wavelengthNm: 400, angleDeg: 0, polarization: "both" }),
        absorbingFilm: absorption,
        snapshotIds: { spectrum: scanId, angleSpectrum: angleId },
        restartReadCheck: getStack(db, "quarter-wave-ar-demo", arVersion).id > 0
      }, null, 2));
    } else {
      console.log(`多层薄膜光学后端 CLI

命令：
  demo                             写入并计算裸基底、抗反射膜、吸收膜演示
  import --input stack.json --name 名称
  import-material --input material.json --name 名称
  materials
  point --input request.json
  scan --input scan.json [--format csv|json] [--out-json path]
  compare --left scan-a.json --right scan-b.json --out-json difference.json
  stacks
  history [扫描ID]
  export --scan-id ID --out file.csv [--format csv|json]

环境：
  PORT=8080
  OPTICS_DATA_DIR=data`);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
