import { test } from "node:test";
import assert from "node:assert/strict";
import { computePoint, fresnel, Stack, ValidationError } from "../src/optics.js";
import { importStack, mergeAdjacentEqual, StackDTO } from "../src/stackio.js";

// 独立解析参考（不调用被测求解器）。
function snellCos(n1: number, n2: number, theta1Deg: number): { c1: number; c2: number; tir: boolean } {
  const t1 = (theta1Deg * Math.PI) / 180;
  const c1 = Math.cos(t1);
  const sin2 = (n1 * Math.sin(t1)) / n2;
  const tir = sin2 > 1;
  const c2 = tir ? Math.sqrt(1 - sin2 * sin2) : Math.sqrt(Math.max(0, 1 - sin2 * sin2));
  return { c1, c2, tir };
}

// 教科书 Fresnel（实折射率），作为裸界面的独立期望值。
function referenceBare(n1: number, n2: number, theta1Deg: number, pol: "s" | "p") {
  const { c1, c2, tir } = snellCos(n1, n2, theta1Deg);
  let R: number;
  if (pol === "s") {
    const rs = (n1 * c1 - n2 * c2) / (n1 * c1 + n2 * c2);
    R = rs * rs;
  } else {
    const rpMag = Math.abs((n2 * c1 - n1 * c2) / (n2 * c1 + n1 * c2));
    R = rpMag * rpMag;
  }
  // 功率透射（法向能流），TIR 时为 0。
  const T = tir ? 0 : 1 - R;
  return { R, T, tir };
}

const dto = (layers: StackDTO["layers"], nIncident = 1, nSubstrate = 1.5): Stack =>
  importStack({ nIncident, nSubstrate, layers });

test("裸介面 Fresnel：与独立解析参考一致（多角度/双偏振）", () => {
  const stack = dto([]);
  for (const ang of [0, 15, 30, 45, 60]) {
    for (const pol of ["s", "p"] as const) {
      const ref = referenceBare(1, 1.5, ang, pol);
      const got = computePoint(stack, 550, ang, pol);
      assert.ok(Math.abs(got.R - ref.R) < 1e-10, `${pol} R @${ang}: ${got.R} vs ${ref.R}`);
      assert.ok(Math.abs(got.T - ref.T) < 1e-10, `${pol} T @${ang}`);
    }
  }
  // 法向入射 Fresnel 符号：r_s=(n1-n2)/(n1+n2)
  const r0 = fresnel({ re: 1, im: 0 }, { re: 1.5, im: 0 }, { re: 1, im: 0 }, { re: 1, im: 0 }, "s");
  assert.ok(Math.abs(r0.r.re - (1 - 1.5) / (1 + 1.5)) < 1e-12);
});

test("无损膜系 R+T=1（含多层）", () => {
  const stack = dto([
    { thicknessNm: 100, n: [1.38, 0] },
    { thicknessNm: 220, n: [2.0, 0] },
    { thicknessNm: 50, n: [1.7, 0] },
  ]);
  for (const pol of ["s", "p"] as const) {
    const r = computePoint(stack, 633, 25, pol);
    assert.ok(Math.abs(r.R + r.T - 1) < 1e-9, `${pol} R+T=${r.R + r.T}`);
    assert.ok(r.A < 1e-9);
  }
});

test("全反射：T=0、R=1、倏逝分支处理", () => {
  // 从 n=2 介质以 45° 入射到空气，临界角 30°。
  const stack = dto([], 2, 1);
  for (const pol of ["s", "p"] as const) {
    const r = computePoint(stack, 550, 45, pol);
    assert.ok(Math.abs(r.R - 1) < 1e-10, `${pol} R=${r.R}`);
    assert.ok(Math.abs(r.T) < 1e-10, `${pol} T=${r.T}`);
    assert.ok(r.A < 1e-9);
  }
});

test("零厚度层不改变结果", () => {
  const base = dto([{ thicknessNm: 120, n: [1.4, 0] }]);
  const withZero = dto([
    { thicknessNm: 0, n: [3.5, 0] },
    { thicknessNm: 120, n: [1.4, 0] },
    { thicknessNm: 0, n: [2.2, 0.5] },
  ]);
  for (const pol of ["s", "p"] as const) {
    const a = computePoint(base, 500, 20, pol);
    const b = computePoint(withZero, 500, 20, pol);
    assert.ok(Math.abs(a.R - b.R) < 1e-12);
    assert.ok(Math.abs(a.T - b.T) < 1e-12);
  }
});

test("相邻同折射率层合并不变", () => {
  const split = dto([
    { thicknessNm: 80, n: [1.6, 0] },
    { thicknessNm: 70, n: [1.6, 0] },
    { thicknessNm: 50, n: [2.1, 0.1] },
  ]);
  const merged = mergeAdjacentEqual(split, 550);
  assert.equal(merged.layers.length, 2);
  for (const pol of ["s", "p"] as const) {
    const a = computePoint(split, 550, 10, pol);
    const b = computePoint(merged, 550, 10, pol);
    assert.ok(Math.abs(a.R - b.R) < 1e-12);
    assert.ok(Math.abs(a.T - b.T) < 1e-12);
  }
});

test("法向入射 s/p 功率相等", () => {
  const stack = dto([
    { thicknessNm: 95, n: [1.38, 0] },
    { thicknessNm: 140, n: [2.0, 0.05] },
  ]);
  const s = computePoint(stack, 550, 0, "s");
  const p = computePoint(stack, 550, 0, "p");
  assert.ok(Math.abs(s.R - p.R) < 1e-12);
  assert.ok(Math.abs(s.T - p.T) < 1e-12);
});

test("四分之一波抗反射膜在设计波长出现反射谷（独立公式 R=(n0-ns/nf²...)）", () => {
  const n0 = 1, ns = 1.5, nf = Math.sqrt(n0 * ns), lambda0 = 550;
  const d = lambda0 / (4 * nf);
  const stack = dto([{ thicknessNm: d, n: [nf, 0] }], n0, ns);
  const atDesign = computePoint(stack, lambda0, 0, "s");
  // 独立解析：δ=π/2 时等效导纳 Y=nf²/ns，r=(n0-Y)/(n0+Y)
  const Y = (nf * nf) / ns;
  const rRef = (n0 - Y) / (n0 + Y);
  assert.ok(Math.abs(atDesign.R - rRef * rRef) < 1e-10);
  assert.ok(atDesign.R < 1e-10, `设计波长 R 应近零，得到 ${atDesign.R}`);
  // 偏离设计波长反射回升，证明是“谷”
  const off = computePoint(stack, lambda0 - 80, 0, "s");
  assert.ok(off.R > atDesign.R + 1e-4);
});

test("有吸收膜：A>0 且 R+T+A=1（法向能流）", () => {
  const stack = dto([
    { thicknessNm: 200, n: [2.3, 0.08] },
    { thicknessNm: 60, n: [1.5, 0.02] },
  ]);
  for (const pol of ["s", "p"] as const) {
    const r = computePoint(stack, 550, 35, pol);
    assert.ok(r.A > 1e-4, `${pol} A 应显著非零: ${r.A}`);
    assert.ok(Math.abs(r.R + r.T + r.A - 1) < 1e-9);
    assert.ok(r.converged);
  }
});

test("Brewster 角：p 偏振反射在解析角处取极小", () => {
  const n1 = 1, n2 = 1.5;
  const brewster = (Math.atan(n2 / n1) * 180) / Math.PI;
  const stack = dto([], n1, n2);
  const atB = computePoint(stack, 550, brewster, "p");
  assert.ok(atB.R < 1e-12, `Brewster 处 R_p=${atB.R}`);
  const s = computePoint(stack, 550, brewster, "s");
  assert.ok(s.R > 0.05, "同角度 s 偏振应显著反射");
});

test("参数校验：负厚度、增益介质、非法折射率被拒绝并定位", () => {
  assert.throws(
    () => dto([{ thicknessNm: -1, n: [1.5, 0] }]),
    (e: Error) => e instanceof ValidationError && e.message.includes("thickness"),
  );
  assert.throws(
    () => dto([{ thicknessNm: 10, n: [1.5, -0.01] }]),
    (e: Error) => e instanceof ValidationError && e.message.includes("无源"),
  );
  assert.throws(
    () => dto([], -1, 1.5),
    (e: Error) => e instanceof ValidationError && e.message.includes("入射介质"),
  );
  assert.throws(() => computePoint(dto([]), 550, 90, "s"), ValidationError);
});

test("极厚吸收层超稳定范围时报告未收敛而非伪造结果", () => {
  const stack = dto([{ thicknessNm: 1e8, n: [2.0, 1.0] }]);
  const r = computePoint(stack, 500, 0, "s");
  assert.equal(r.converged, false);
  assert.ok(r.warnings.some((w) => w.includes("衰减")));
});
