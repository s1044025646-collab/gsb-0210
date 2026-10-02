// 端到端演示（同时作为冒烟脚本）：
// 1) 裸基底 vs 四分之一波抗反射膜；2) 偏振随角度变化（含 Brewster）；
// 3) 有吸收膜层的非零 A；4) 写入 SQLite 后“重启”重新打开读取历史。
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Store } from "./db.js";
import { importStack, StackDTO } from "./stackio.js";
import { computePoint } from "./optics.js";
import { angleScan, findReflectanceMinima, wavelengthScan } from "./scan.js";

const DATA_DIR = process.env.THINFILM_DATA_DIR ?? join(process.cwd(), "data");
const DB = join(DATA_DIR, "demo.sqlite");

const n0 = 1.0;
const ns = 1.5;
const lambda0 = 550;
const nFilm = Math.sqrt(n0 * ns); // 理想单层 AR 折射率
const dAR = lambda0 / (4 * nFilm);

const bare: StackDTO = { name: "裸基底", nIncident: n0, nSubstrate: ns, layers: [] };
const ar: StackDTO = {
  name: "四分之一波抗反射膜",
  nIncident: n0,
  nSubstrate: ns,
  layers: [{ name: "AR", thicknessNm: dAR, n: [nFilm, 0] }],
};
const absorbing: StackDTO = {
  name: "吸收膜",
  nIncident: n0,
  nSubstrate: ns,
  layers: [
    { name: "lossy", thicknessNm: 200, n: [2.3, 0.08] },
    { name: "AR", thicknessNm: dAR, n: [nFilm, 0] },
  ],
};

function line(s: string): void {
  console.log("\n=== " + s + " ===");
}

rmSync(DB, { force: true });
let store = new Store(DB);

line("1. 设计波长 " + lambda0 + "nm 处：裸基底 vs 抗反射膜（法向入射）");
const rb = computePoint(importStack(bare), lambda0, 0, "s");
const rar = computePoint(importStack(ar), lambda0, 0, "s");
console.log(`裸基底  R=${rb.R.toFixed(6)}  T=${rb.T.toFixed(6)}  守恒残差=${rb.balanceResidual?.toExponential(2)}`);
console.log(`AR 膜   R=${rar.R.toExponential(3)}  T=${rar.T.toFixed(6)}  厚度=${dAR.toFixed(2)}nm  nFilm=${nFilm.toFixed(5)}`);

line("2. 反射谷扫描（450-700nm，步长 5nm）及采样分辨率说明");
const wlResults = wavelengthScan(importStack(ar), { startNm: 450, stopNm: 700, stepNm: 5 }, 0, ["s", "p"]);
const minima = findReflectanceMinima(wlResults);
console.log("最小 R:", JSON.stringify(minima.minima));
console.log("说明:", minima.note);
store.saveScan("wavelength", { demo: "AR 波长扫描" }, wlResults, "AR 波长扫描");

line("3. 偏振随角度变化（裸界面，0-89°）——观察 Brewster 角 p 反射趋零");
const brewster = (Math.atan(ns / n0) * 180) / Math.PI;
const angResults = angleScan(importStack(bare), { startDeg: 0, stopDeg: 89, stepDeg: 1 }, lambda0, ["s", "p"]);
const atB = angResults.filter((r) => Math.abs(r.angleDeg - Math.round(brewster)) < 0.5);
console.log(`理论 Brewster 角=${brewster.toFixed(3)}°`);
for (const r of atB) console.log(`  ${r.pol} @ ${r.angleDeg}°  R=${r.R.toExponential(3)}`);
store.saveScan("angle", { demo: "Brewster 角扫描" }, angResults, "Brewster 角扫描");

line("4. 吸收膜：非零吸收率与能流守恒");
const ab = computePoint(importStack(absorbing), lambda0, 30, "p");
console.log(`R=${ab.R.toFixed(6)} T=${ab.T.toFixed(6)} A=${ab.A.toFixed(6)} R+T+A=${(ab.R + ab.T + ab.A).toFixed(8)} 收敛=${ab.converged}`);
store.saveScan("point", { demo: "吸收膜 30° p" }, [ab], "吸收膜非零 A");

line("5. 模拟重启：关闭数据库后重新打开，读取历史报告");
store.close();
store = new Store(DB);
const history = store.listScans();
for (const h of history) console.log(`  扫描 #${h.id}  kind=${h.kind}  note=${h.note ?? ""}  at=${h.createdAt}`);
const reloaded = store.getScan(history[0].id)!;
const parsed = JSON.parse(reloaded.resultsJson);
console.log(`重读 #${reloaded.id}：共 ${Array.isArray(parsed) ? parsed.length : 1} 条结果，首条 R=${parsed[0]?.R ?? "n/a"}`);
store.close();
console.log("\n演示完成。");
