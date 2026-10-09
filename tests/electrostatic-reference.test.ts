import { expect, test } from "bun:test"
import { compareRlgcCoupling, extractCoupledRlgc, type CoupledRlgc } from "../lib/coupled-line"

const reference = await Bun.file(new URL("../fixtures/electrostatic-reference.json", import.meta.url)).json()
const geometry = { width_mm: 0.3, thickness_mm: 0.035, height_mm: 0.2, length_mm: 20, gap_mm: 0.3 }
const material = { relative_permittivity: 4.2, conductivity_s_per_m: 5.8e7 }
test("cross-section agrees with pinned independent SciPy sparse-LU extraction", () => {
  const expected = reference.cases.find((c: any) => c.grid_mm === 0.025 && c.margin_mm === 2)
  const actual = extractCoupledRlgc(geometry, material, { grid_mm: expected.grid_mm, margin_mm: expected.margin_mm, top_mm: expected.top_mm })
  for (const key of ["C_f_per_m", "L_h_per_m", "R_ohm_per_m"] as const) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    expect(Math.abs(actual[key][i][j] - expected[key][i][j])).toBeLessThan(Math.max(1e-18, Math.abs(expected[key][i][j]) * 1e-8))
  }
}, 60000)

// This is an explicit physics verification job rather than an archived snapshot
// being mistaken for a fresh converged solve. Run locally/CI with the env flag.
test.skipIf(process.env.RUN_CROSS_SECTION_CONVERGENCE !== "1")("three meshes and independently expanded domain pass separate weak-mutual gates", () => {
  const runs = [0.025, 0.0125, 0.00625].map((grid_mm) => extractCoupledRlgc(geometry, material, { grid_mm, margin_mm: 4, top_mm: 4 }))
  const expanded = extractCoupledRlgc(geometry, material, { grid_mm: 0.00625, margin_mm: 8, top_mm: 8 })
  const coarse = compareRlgcCoupling(runs[0], runs[1]), fine = compareRlgcCoupling(runs[1], runs[2])
  expect(fine.capacitance.absolute).toBeLessThan(coarse.capacitance.absolute)
  expect(fine.inductance.absolute).toBeLessThan(coarse.inductance.absolute)
  expect(fine.passes).toBe(true)
  expect(compareRlgcCoupling(runs[2], expanded).passes).toBe(true)
  for (const [index, run] of [...runs, expanded].entries()) {
    const grid = index < 3 ? [0.025, 0.0125, 0.00625][index] : 0.00625, domain = index === 3 ? 8 : 4
    const expected = reference.cases.find((c: any) => c.grid_mm === grid && c.margin_mm === domain) as CoupledRlgc
    expect(expected).toBeDefined()
    for (const key of ["C_f_per_m", "L_h_per_m"] as const) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) expect(Math.abs(run[key][i][j] / expected[key][i][j] - 1)).toBeLessThan(1e-7)
  }
}, 180000)
