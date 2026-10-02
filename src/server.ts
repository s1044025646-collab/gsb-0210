// HTTP API（仅后端，无前端）。纯 Node http，零 Web 框架依赖。
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Store } from "./db.js";
import { importStack, StackDTO } from "./stackio.js";
import { Pol, ValidationError } from "./optics.js";
import { angleScan, diffSpectra, findReflectanceMinima, wavelengthScan } from "./scan.js";
import { resultsToCsv, toJson } from "./exporters.js";
import { computePoint } from "./optics.js";

const PORT = Number(process.env.PORT ?? process.env.THINFILM_PORT ?? 8080);
const DATA_DIR = process.env.THINFILM_DATA_DIR ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "thinfilm.sqlite");

const store = new Store(DB_PATH);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, code: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  const payload = contentType.includes("json") ? toJson(body) : (body as string);
  res.writeHead(code, { "Content-Type": contentType });
  res.end(payload);
}

function sendError(res: ServerResponse, code: number, message: string, detail?: unknown): void {
  send(res, code, { error: message, detail });
}

function polsFrom(body: { pols?: string[]; pol?: string }): Pol[] {
  const list = body.pols ?? (body.pol ? [body.pol] : ["s", "p"]);
  for (const p of list) if (p !== "s" && p !== "p") throw new ValidationError("偏振只能为 s 或 p", "pol");
  return list as Pol[];
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    if (method === "GET" && path === "/health") return send(res, 200, { ok: true, engine: "transfer-matrix v1" });

    // 导入并冻结膜系
    if (method === "POST" && path === "/stacks") {
      const body = (await readJson(req)) as { name?: string; stack: StackDTO };
      const dto = body.stack ?? (body as unknown as StackDTO);
      importStack(dto); // 校验
      const id = store.saveStack(body.name ?? dto.name ?? "stack", dto);
      return send(res, 201, { id });
    }
    if (method === "GET" && path === "/stacks") {
      return send(res, 200, store.listStacks().map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt })));
    }
    const stackGet = path.match(/^\/stacks\/(\d+)$/);
    if (method === "GET" && stackGet) {
      const row = store.getStack(Number(stackGet[1]));
      if (!row) return sendError(res, 404, "膜系不存在");
      return send(res, 200, row);
    }

    // 单点计算
    if (method === "POST" && path === "/compute") {
      const body = (await readJson(req)) as {
        stack: StackDTO; wavelengthNm: number; angleDeg: number; pols?: string[]; save?: boolean;
      };
      const stack = importStack(body.stack);
      const out = polsFrom(body).map((pol) => computePoint(stack, body.wavelengthNm, body.angleDeg ?? 0, pol));
      if (body.save) {
        const id = store.saveScan("point", { stack: body.stack, wavelengthNm: body.wavelengthNm, angleDeg: body.angleDeg ?? 0 }, out);
        return send(res, 200, { scanId: id, results: out });
      }
      return send(res, 200, { results: out });
    }

    // 波长扫描
    if (method === "POST" && path === "/scan/wavelength") {
      const body = (await readJson(req)) as {
        stack: StackDTO; scan: { startNm: number; stopNm: number; stepNm: number };
        angleDeg: number; pols?: string[]; findMinima?: boolean; format?: string;
      };
      const stack = importStack(body.stack);
      const results = wavelengthScan(stack, body.scan, body.angleDeg ?? 0, polsFrom(body));
      const id = store.saveScan("wavelength", { ...body, stack: body.stack }, results);
      if (body.format === "csv") return send(res, 200, resultsToCsv(results), "text/csv; charset=utf-8");
      return send(res, 200, {
        scanId: id,
        results,
        minima: body.findMinima === false ? undefined : findReflectanceMinima(results),
      });
    }

    // 角度扫描
    if (method === "POST" && path === "/scan/angle") {
      const body = (await readJson(req)) as {
        stack: StackDTO; scan: { startDeg: number; stopDeg: number; stepDeg: number };
        wavelengthNm: number; pols?: string[]; format?: string;
      };
      const stack = importStack(body.stack);
      const results = angleScan(stack, body.scan, body.wavelengthNm, polsFrom(body));
      const id = store.saveScan("angle", { ...body, stack: body.stack }, results);
      if (body.format === "csv") return send(res, 200, resultsToCsv(results), "text/csv; charset=utf-8");
      return send(res, 200, { scanId: id, results });
    }

    // 版本/谱差异比较：两套膜系在同一网格
    if (method === "POST" && path === "/compare") {
      const body = (await readJson(req)) as {
        stackA: StackDTO; stackB: StackDTO; mode: "wavelength" | "angle";
        wavelength?: { startNm: number; stopNm: number; stepNm: number; angleDeg: number };
        angle?: { startDeg: number; stopDeg: number; stepDeg: number; wavelengthNm: number };
        pols?: string[];
      };
      const a = importStack(body.stackA);
      const b = importStack(body.stackB);
      const p = polsFrom(body);
      const ra =
        body.mode === "wavelength"
          ? wavelengthScan(a, body.wavelength!, body.wavelength!.angleDeg ?? 0, p)
          : angleScan(a, body.angle!, body.angle!.wavelengthNm, p);
      const rb =
        body.mode === "wavelength"
          ? wavelengthScan(b, body.wavelength!, body.wavelength!.angleDeg ?? 0, p)
          : angleScan(b, body.angle!, body.angle!.wavelengthNm, p);
      const diff = diffSpectra(ra, rb);
      const id = store.saveScan("diff", { mode: body.mode }, diff);
      return send(res, 200, { scanId: id, diff, summary: summarizeDiff(diff) });
    }

    // 守恒核验
    if (method === "POST" && path === "/conserve") {
      const body = (await readJson(req)) as { stack: StackDTO; wavelengthNm: number; angleDeg: number; pols?: string[] };
      const stack = importStack(body.stack);
      const results = polsFrom(body).map((pol) => computePoint(stack, body.wavelengthNm, body.angleDeg ?? 0, pol));
      return send(res, 200, {
        results,
        verdict: results.every((r) => r.converged && (r.balanceResidual ?? 1) < 1e-6) ? "pass" : "check",
      });
    }

    // 历史报告读取（重启后可用）
    if (method === "GET" && path === "/scans") {
      return send(res, 200, store.listScans(url.searchParams.get("kind") ?? undefined).map((s) => ({
        id: s.id, kind: s.kind, createdAt: s.createdAt, note: s.note,
      })));
    }
    const scanGet = path.match(/^\/scans\/(\d+)$/);
    if (method === "GET" && scanGet) {
      const row = store.getScan(Number(scanGet[1]));
      if (!row) return sendError(res, 404, "扫描记录不存在");
      const fmt = url.searchParams.get("format");
      if (fmt === "csv") {
        try {
          return send(res, 200, resultsToCsv(JSON.parse(row.resultsJson)), "text/csv; charset=utf-8");
        } catch {
          return sendError(res, 400, "该记录类型不支持 CSV 导出");
        }
      }
      return send(res, 200, row);
    }

    return sendError(res, 404, "未找到路由");
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, "参数校验失败", err.message);
    if (err instanceof SyntaxError) return sendError(res, 400, "请求体不是合法 JSON", err.message);
    const e = err as Error;
    return sendError(res, 500, "服务器内部错误", e.message);
  }
}

function summarizeDiff(diff: { dR: number; dT: number }[]): { maxAbsDR: number; maxAbsDT: number; meanAbsDR: number } {
  let maxAbsDR = 0, maxAbsDT = 0, sum = 0;
  for (const d of diff) {
    maxAbsDR = Math.max(maxAbsDR, Math.abs(d.dR));
    maxAbsDT = Math.max(maxAbsDT, Math.abs(d.dT));
    sum += Math.abs(d.dR);
  }
  return { maxAbsDR, maxAbsDT, meanAbsDR: sum / Math.max(1, diff.length) };
}

const server = createServer((req, res) => {
  void handler(req, res);
});

server.listen(PORT, () => {
  console.log(`[thinfilm] API 监听 http://localhost:${PORT}`);
  console.log(`[thinfilm] 数据目录: ${DATA_DIR}`);
});

export { server };
