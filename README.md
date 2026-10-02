# 多层薄膜反射透射谱与偏振分析后端

本项目是仅包含 API 与 CLI 的 Windows 本地后端，用于计算平面、各向同性、非磁性多层薄膜的相干反射/透射谱。不使用外部材料数据库，也不依赖 Docker、WSL、付费服务或在线 API。

## 物理约定

- 时谐因子：`exp(-iωt)`。
- 复折射率：`n = n′ + iκ`；无源膜层要求 `κ >= 0`。
- 波长与厚度单位均为 `nm`；入射角单位为度。
- 吸收系数按强度衰减定义为 `α = 4πκ/λ`，单位是 `nm^-1`。
- 膜层顺序为入射介质 → 膜层数组 → 基底。
- 入射介质和基底必须是正实折射率；膜层折射率允许无源复数。
- 法向波矢选择满足前向传播/衰减的分支：`Re(q) >= 0`、`Im(q) >= 0`。
- s 偏振 Fresnel 导纳为 `q`；p 偏振总场导纳为 `n²/q`。
- 功率透射率包含法向能流因子：`T = Re(q_sub)/Re(q_inc) |t|²`，全反射时基底 `Re(q)=0`，因此远场 `T=0`。

求解器自行实现复数运算、Fresnel 接口和 2×2 相干传播矩阵；未调用现成薄膜光学求解器。

## 环境与构建

要求 Windows 本地安装 Node.js 25（当前使用 `node:sqlite`，Node 22.5+ 也可尝试加 `--experimental-sqlite`）。

```powershell
npm install
npm run build
npm test
```

启动 API：

```powershell
$env:PORT="8080"
$env:OPTICS_DATA_DIR="data"
npm start
```

也可开发模式运行：

```powershell
npm run dev
```

SQLite 数据库默认在 `data/optics.sqlite`，材料版本、膜系版本、扫描参数和结果均以 JSON 快照冻结。

## CLI

运行内置演示（裸基底、四分之一波抗反射膜、吸收膜、角谱和历史快照）：

```powershell
npm run demo
```

导入膜系、单点计算、波长扫描、比较和导出：

```powershell
npm run cli -- import --input examples/bare-glass.json
npm run cli -- point --input examples/point-ar.json
npm run cli -- scan --input examples/wavelength-scan.json
npm run cli -- compare --left examples/wavelength-scan.json --right examples/bare-spectrum.json --out-json data/diff.json
npm run cli -- history
npm run cli -- export --scan-id 1 --out data/spectrum.csv
```

材料折射率版本：

```powershell
npm run cli -- import-material --input examples/material.json --name demo-material
npm run cli -- materials
```

## HTTP API

- `GET /health`：健康检查与物理约定。
- `POST /api/calculate`：单点复振幅、`R/T/A` 与守恒残差。
- `POST /api/conservation`：仅返回能量守恒核验。
- `POST /api/scans`：波长、角度或二维扫描，返回离散极小点与采样步长。
- `POST /api/compare`：同一采样网格上的两套膜系谱差异。
- `POST /api/stacks/import`：冻结膜系版本。
- `GET /api/stacks`、`GET /api/stacks/:name/:version?`：读取膜系版本。
- `POST /api/materials/import`、`GET /api/materials`：冻结/读取折射率版本。
- `GET /api/scans`、`GET /api/scans/:id`、`GET /api/scans/:id/csv`：历史快照与 CSV 导出。

单点请求示例：

```json
{
  "stack": {
    "incident": { "refractiveIndex": 1 },
    "layers": [
      { "refractiveIndex": 1.224744871391589, "thicknessNm": 81.64965809277261 }
    ],
    "substrate": { "refractiveIndex": 1.5 }
  },
  "wavelengthNm": 400,
  "angleDeg": 0,
  "polarization": "both"
}
```

## 极小点与采样分辨率

扫描结果返回 `sampleResolution` 和离散采样极小点。极小值只在给定采样点中比较；不宣称离散扫描能保证找到连续全局最优。要提高定位可信度，应减小步长或在候选谷附近二次加密扫描。

## 数值范围与限制

- 最多 `100` 层。
- 波长公开稳定范围：`100..1,000,000 nm`。
- 入射角：`0..89.999999°`。
- 折射率模：`|n| <= 100`。
- 单层吸收光学深度阈值：`|2π Im(q)d/λ| <= 650`；超过会明确返回数值不稳定/未收敛错误。
- 扫描点数最多 `100001`。
- 若 `R+T > 1` 超出容差，服务返回错误，不会把负吸收裁剪成 0。
- 相干模型默认所有界面相位稳定；厚层非相干平均、粗糙度、色散模型拟合不在当前范围内。

## 测试

`npm test` 使用独立解析 Fresnel 公式和能量守恒作为参考，包含：

- 裸介面 s/p Fresnel 振幅/功率。
- 无损单层 `R+T=1`。
- 全反射倏逝波 `T=0`。
- 零厚度不变。
- 相邻同折射率层合并不变。
- 法向入射 s/p 功率相同。
- Brewster 角 p 反射谷。
- 四分之一波抗反射膜在设计波长的反射谷。
- 有吸收膜层 `A>0` 且 `R+T+A=1`。
- 负厚度、负 `κ` 和极厚强吸收层错误定位。
