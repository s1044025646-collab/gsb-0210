// 离线折射率模型。不连接任何外部材料数据库。
// 所有色散模型均为无增益（κ>=0）。

export type DispersionKind = "constant" | "cauchy" | "sellmeier";

// 波长均以 nm 输入，内部转换为 μm 参与经典公式。
export interface MaterialSpec {
  kind: DispersionKind;
  // constant: [n, k]
  // cauchy: n = A + B/λ²(μm) + C/λ⁴ ; k = k0（可选常数吸收）
  // sellmeier: n²-1 = Σ B_i λ²/(λ² - C_i)，λ 用 μm，C_i 单位 μm²
  params: number[];
  k?: number;
}

export function evaluateMaterial(spec: MaterialSpec, wavelengthNm: number): [number, number] {
  const wlUm = wavelengthNm / 1000;
  switch (spec.kind) {
    case "constant": {
      const [n, kk = 0] = spec.params;
      return [n, kk];
    }
    case "cauchy": {
      const [A, B = 0, Cc = 0] = spec.params;
      const n = A + B / (wlUm * wlUm) + Cc / Math.pow(wlUm, 4);
      return [n, spec.k ?? 0];
    }
    case "sellmeier": {
      // params 为 [B1,C1,B2,C2,...]（C 以 μm² 计）
      let s = 1;
      for (let i = 0; i + 1 < spec.params.length; i += 2) {
        const B = spec.params[i];
        const Cc = spec.params[i + 1];
        const denom = wlUm * wlUm - Cc;
        s += (B * wlUm * wlUm) / denom;
      }
      return [Math.sqrt(s), spec.k ?? 0];
    }
    default:
      throw new Error(`未知色散模型: ${String((spec as { kind: string }).kind)}`);
  }
}

// 冻结到 SQLite 的材料（名称 -> 规格）。内置常见离线参考值，仅为演示便利。
export const BUILTIN_MATERIALS: Record<string, MaterialSpec> = {
  air: { kind: "constant", params: [1.0, 0] },
  // BK7：Sellmeier 系数（μm）
  bk7: {
    kind: "sellmeier",
    params: [1.03961217, 0.00600069867, 0.231792344, 0.0200179144, 1.01046945, 103.560653],
  },
  // 熔融石英
  silica: {
    kind: "sellmeier",
    params: [0.6961663, 0.0684043 ** 2, 0.4079426, 0.1162414 ** 2, 0.8974794, 9.896161 ** 2],
  },
  // MgF2 寻常光近似（Cauchy 形式拟合常数，示例用约 1.38@550nm）
  mgf2: { kind: "cauchy", params: [1.36938, 0.003514, 0] },
  // 演示用吸收层：金属风格的复折射率（示例非真实材料档案）
  absorbing_demo: { kind: "constant", params: [2.3, 0.08] },
};
