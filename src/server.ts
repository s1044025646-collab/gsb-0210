import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { getScan, getStack, listMaterials, listScans, listStacks, openDatabase, saveMaterial, saveScan, saveStack } from "./db.js";
import { PointRequest, calculatePoint, validateStack, ValidationError, NumericalError } from "./optics.js";
import { ScanRequest, compareScans, findMinima, flattenCsv, runScan } from "./scan.js";

const port = Number(process.env.PORT ?? process.env.OPTICS_PORT ?? 8080);
const dataDir = process.env.OPTICS_DATA_DIR ?? "data";
const db = openDatabase(resolve(dataDir, "optics.sqlite"));

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(contentType.startsWith("application/json") ? JSON.stringify(body, null, 2) : String(body));
}

function errorResponse(res: ServerResponse, error: unknown): void {
  if (error instanceof SyntaxError) return send(res, 400, { error: "JSON 解析失败", detail: error.message });
  if (error instanceof ValidationError) return send(res, 400, { error: error.message, field: error.field });
  if (error instanceof NumericalError) return send(res, 422, { error: error.message });
  const message = error instanceof Error ? error.message : String(error);
  return send(res, 500, { error: message });
}

function pointResponse(body: unknown) {
  const request = body as PointRequest;
  const result = calculatePoint(request);
  return result;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") return send(res, 200, { ok: true, convention: "exp(-iωt), n=n'+iκ", units: "wavelength and thickness in nm, angle in degrees" });

  if (method === "POST" && path === "/api/stacks/import") {
    const body = readJson(req) as Promise<{ name?: string; stack?: unknown }>;
    const { name, stack } = await body;
    if (!name) throw new ValidationError("name", "膜系名称缺失");
    validateStack(stack as never);
    const version = saveStack(db, name, stack);
    return send(res, 201, { name, version, frozen: true });
  }
  if (method === "GET" && path === "/api/stacks") return send(res, 200, listStacks(db));

  if (method === "POST" && path === "/api/materials/import") {
    const body = (await readJson(req)) as { name?: string; refractiveIndex?: unknown };
    if (!body.name) throw new ValidationError("name", "材料名称缺失");
    const version = saveMaterial(db, body.name, body.refractiveIndex);
    return send(res, 201, { name: body.name, version, frozen: true });
  }
  if (method === "GET" && path === "/api/materials") return send(res, 200, listMaterials(db));
  const stackMatch = path.match(/^\/api\/stacks\/([^/]+)(?:\/(\d+))?$/);
  if (method === "GET" && stackMatch) {
    const name = decodeURIComponent(stackMatch[1]!);
    const version = stackMatch[2] ? Number(stackMatch[2]) : undefined;
    return send(res, 200, getStack(db, name, version));
  }

  if (method === "POST" && path === "/api/calculate") return send(res, 200, pointResponse(await readJson(req)));

  if (method === "POST" && path === "/api/conservation") {
    const result = pointResponse(await readJson(req));
    const entries = Array.isArray(Object.values(result)) ? Object.values(result) : [result];
    return send(res, 200, entries.map((x) => ({ polarization: x.polarization, R: x.R, T: x.T, A: x.A, sum: x.R + x.T + x.A, energyResidual: x.energyResidual })));
  }

  if (method === "POST" && path === "/api/scans") {
    const body = (await readJson(req)) as ScanRequest & { name?: string };
    const scan = runScan(body);
    const minima = findMinima(scan.points);
    const result = { ...scan, minima, samplingNotice: "极小值仅在离散采样点中选择；离散扫描不保证找到连续全局最优。" };
    const id = saveScan(db, "scan", { name: body.name, ...body }, result);
    return send(res, 201, { id, ...result });
  }

  if (method === "POST" && path === "/api/compare") {
    const body = (await readJson(req)) as { left: ScanRequest; right: ScanRequest };
    if (!body.left || !body.right) throw new ValidationError("left/right", "必须提供两套膜系扫描");
    const left = runScan(body.left).points;
    const right = runScan(body.right).points;
    const difference = compareScans(left, right);
    const id = saveScan(db, "compare", body, difference);
    return send(res, 201, { id, points: difference });
  }

  const scanMatch = path.match(/^\/api\/scans\/(\d+)(?:\/(csv|json))?$/);
  if (method === "GET" && scanMatch) {
    const scan = getScan(db, Number(scanMatch[1]));
    if (scanMatch[2] === "csv") {
      const result = scan.result as { points?: Parameters<typeof flattenCsv>[0] };
      return send(res, 200, flattenCsv(result.points ?? []), "text/csv; charset=utf-8");
    }
    return send(res, 200, scan);
  }
  if (method === "GET" && path === "/api/scans") return send(res, 200, listScans(db, Number(url.searchParams.get("limit") ?? 50)));

  return send(res, 404, { error: "未找到路由" });
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => errorResponse(res, error));
});

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  server.listen(port, () => console.log(JSON.stringify({ listening: true, port, dataDir })));
}

export { server, db };
