import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { C } from "../src/complex.js";
import { Coefficients, NumericalError, PointRequest, ValidationError, calculatePoint } from "../src/optics.js";
import { runScan } from "../src/scan.js";

const glass = 1.5;
const bare = {
  incident: { refractiveIndex: 1 },
  layers: [],
  substrate: { refractiveIndex: glass }
};

function both(request: Omit<PointRequest, "polarization">) {
  return calculatePoint({ ...request, polarization: "both" }) as Record<"s" | "p", Coefficients>;
}

function assertPowerClose(actual: Record<"s" | "p", Coefficients>, expected: Record<"s" | "p", Coefficients>, tolerance = 1e-12): void {
  for (const pol of ["s", "p"] as const) {
    for (const key of ["R", "T", "A"] as const) {
      assert.ok(Math.abs(actual[pol][key] - expected[pol][key]) < tolerance, `${pol}.${key}`);
    }
  }
}

describe("独立解析 Fresnel 与法向能流", () => {
  it("裸介面 s/p 系数匹配独立公式，T 使用 q 实部比值", () => {
    const angleDeg = 35;
    const thetaI = (angleDeg * Math.PI) / 180;
    const thetaT = Math.asin(Math.sin(thetaI) / glass);
    const expectedRs = ((Math.cos(thetaI) - glass * Math.cos(thetaT)) / (Math.cos(thetaI) + glass * Math.cos(thetaT))) ** 2;
    const expectedRp = ((glass * Math.cos(thetaI) - Math.cos(thetaT)) / (glass * Math.cos(thetaI) + Math.cos(thetaT))) ** 2;
    const result = both({ stack: bare, wavelengthNm: 500, angleDeg });
    assert.ok(Math.abs(result.s.R - expectedRs) < 1e-12);
    assert.ok(Math.abs(result.p.R - expectedRp) < 1e-12);
    assert.ok(Math.abs(result.s.T - (1 - expectedRs)) < 1e-12);
    assert.ok(Math.abs(result.p.T - (1 - expectedRp)) < 1e-12);
  });

  it("无损单层膜满足 R+T=1", () => {
    const stack = {
      incident: { refractiveIndex: 1 },
      layers: [{ refractiveIndex: 2.1, thicknessNm: 123 }],
      substrate: { refractiveIndex: 1.45 }
    };
    for (const value of Object.values(both({ stack, wavelengthNm: 600, angleDeg: 28 }))) {
      assert.ok(Math.abs(value.R + value.T - 1) < 1e-10);
      assert.ok(Math.abs(value.A) < 1e-10);
    }
  });

  it("全反射时选择倏逝分支且远场透射率为零", () => {
    const stack = { incident: { refractiveIndex: 1.5 }, layers: [], substrate: { refractiveIndex: 1 } };
    const result = both({ stack, wavelengthNm: 500, angleDeg: 60 });
    for (const value of Object.values(result)) {
      assert.ok(Math.abs(value.T) < 1e-14);
      assert.ok(Math.abs(value.R - 1) < 1e-12);
      assert.ok(Math.abs(value.A) < 1e-12);
    }
  });
});

describe("膜系等价与偏振", () => {
  it("零厚度膜层不改变裸基底结果", () => {
    const withZero = { ...bare, layers: [{ refractiveIndex: { re: 0.7, im: 3 }, thicknessNm: 0 }] };
    assertPowerClose(both({ stack: withZero, wavelengthNm: 550, angleDeg: 31 }), both({ stack: bare, wavelengthNm: 550, angleDeg: 31 }));
  });

  it("相邻同折射率层可合并且结果不变", () => {
    const split = { ...bare, layers: [
      { refractiveIndex: 1.8, thicknessNm: 37 },
      { refractiveIndex: 1.8, thicknessNm: 25 },
      { refractiveIndex: 2.4, thicknessNm: 10 }
    ]};
    const merged = { ...bare, layers: [
      { refractiveIndex: 1.8, thicknessNm: 62 },
      { refractiveIndex: 2.4, thicknessNm: 10 }
    ]};
    assertPowerClose(both({ stack: split, wavelengthNm: 500, angleDeg: 20 }), both({ stack: merged, wavelengthNm: 500, angleDeg: 20 }));
  });

  it("法向入射 s 和 p 的功率相等", () => {
    const stack = { ...bare, layers: [{ refractiveIndex: 1.8, thicknessNm: 90 }] };
    const result = both({ stack, wavelengthNm: 500, angleDeg: 0 });
    assert.ok(Math.abs(result.s.R - result.p.R) < 1e-14);
    assert.ok(Math.abs(result.s.T - result.p.T) < 1e-14);
  });

  it("Brewster 角附近 p 反射率达到接近零的极小值", () => {
    const angle = runScan({ stack: bare, wavelengthNm: 500, angleStartDeg: 55, angleStopDeg: 58, angleStepDeg: 0.05 });
    const minimum = Math.min(...angle.points.map((point) => point.p.R));
    const exactBrewster = (Math.atan(glass) * 180) / Math.PI;
    assert.ok(Math.abs(exactBrewster - 56.309932474) < 1e-6);
    assert.ok(minimum < 1e-7);
  });
});

describe("抗反射与吸收", () => {
  it("四分之一波抗反射膜在设计波长形成独立解析反射谷", () => {
    const nFilm = Math.sqrt(glass);
    const wavelengthNm = 400;
    const stack = {
      incident: { refractiveIndex: 1 },
      layers: [{ refractiveIndex: nFilm, thicknessNm: wavelengthNm / (4 * nFilm) }],
      substrate: { refractiveIndex: glass }
    };
    const result = both({ stack, wavelengthNm, angleDeg: 0 });
    assert.ok(result.s.R < 1e-12);
    assert.ok(result.p.R < 1e-12);
    const spectrum = runScan({ stack, wavelengthStartNm: 380, wavelengthStopNm: 420, wavelengthStepNm: 0.5, angleDeg: 0 });
    const center = spectrum.points.find((point) => point.wavelengthNm === 400)!;
    for (const point of spectrum.points) {
      assert.ok(point.s.R >= center.s.R - 1e-14);
      assert.ok(point.p.R >= center.p.R - 1e-14);
    }
  });

  it("无源吸收膜具有非零吸收率且能流守恒", () => {
    const stack = {
      incident: { refractiveIndex: 1 },
      layers: [{ refractiveIndex: { re: 2.2, im: 0.35 }, thicknessNm: 80 }],
      substrate: { refractiveIndex: 1.5 }
    };
    for (const value of Object.values(both({ stack, wavelengthNm: 550, angleDeg: 18 }))) {
      assert.ok(value.A > 0.01);
      assert.ok(Math.abs(value.R + value.T + value.A - 1) < 1e-10);
      assert.ok(value.R >= 0 && value.T >= 0 && value.A <= 1);
    }
  });
});

describe("输入与数值边界", () => {
  it("定位负厚度", () => {
    assert.throws(() => calculatePoint({ stack: { ...bare, layers: [{ refractiveIndex: 1.5, thicknessNm: -1 }] }, wavelengthNm: 500, angleDeg: 0 }), /thicknessNm.*负/);
  });

  it("拒绝增益膜层的负消光系数", () => {
    assert.throws(() => calculatePoint({ stack: { ...bare, layers: [{ refractiveIndex: { re: 1.5, im: -0.1 }, thicknessNm: 10 }] }, wavelengthNm: 500, angleDeg: 0 }), /无源/);
  });

  it("极厚强吸收层超过光学深度时报告未收敛/不稳定而不裁剪", () => {
    const stack = { ...bare, layers: [{ refractiveIndex: { re: 2, im: 50 }, thicknessNm: 1e9 }] };
    assert.throws(() => calculatePoint({ stack, wavelengthNm: 500, angleDeg: 0 }), NumericalError);
  });
});
