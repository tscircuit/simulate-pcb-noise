import { expect, test } from "bun:test"
import { compareRlgcCoupling, electrostaticCapacitance, extractCoupledRlgc, simulateCoupledLines, validateCoupledRlgc, type CoupledRlgc } from "../lib/coupled-line"

const EPS0 = 8.8541878128e-12
test("finite-volume common-mode parallel plate agrees with independent analytic C on nonuniform axes", () => {
  const x = [0, 0.1, 0.3, 0.8, 1].map((v) => v * 1e-3), y = [0, 0.03, 0.1, 0.2].map((v) => v * 1e-3)
  const labels = new Int8Array(x.length * y.length).fill(-1)
  labels.fill(0, 0, x.length)
  for (let i = 0; i < x.length; i++) labels[(y.length - 1) * x.length + i] = i < 3 ? 1 : 2
  const result = electrostaticCapacitance(x, y, labels, 1, 4)
  const capacitance = result.capacitance.flat().reduce((a, b) => a + b, 0)
  const independent = 4 * EPS0 * (x.at(-1)! - x[0]) / (y.at(-1)! - y[0])
  expect(Math.abs(capacitance / independent - 1)).toBeLessThan(1e-9)
  expect(result.relative_reciprocity_error).toBeLessThan(1e-10)
})
test("dielectric interface gives series plate capacitance rather than arithmetic-average epsilon", () => {
  const x = [0, 0.1, 0.3, 0.8, 1].map((v) => v * 1e-3), y = [0, 0.03, 0.1, 0.15, 0.2].map((v) => v * 1e-3)
  const labels = new Int8Array(x.length * y.length).fill(-1)
  labels.fill(0, 0, x.length)
  for (let i = 0; i < x.length; i++) labels[(y.length - 1) * x.length + i] = i < 3 ? 1 : 2
  const result = electrostaticCapacitance(x, y, labels, 0.1e-3, 4)
  const capacitance = result.capacitance.flat().reduce((a, b) => a + b, 0)
  const independent = EPS0 * 1e-3 / (0.1e-3 / 4 + 0.1e-3)
  expect(Math.abs(capacitance / independent - 1)).toBeLessThan(1e-9)
})
test("microstrip extraction is reciprocal and passive; missing/nonphysical material is rejected", () => {
  const geometry = { width_mm: 0.3, thickness_mm: 0.035, height_mm: 0.2, length_mm: 20, gap_mm: 0.3 }
  const material = { relative_permittivity: 4.2, conductivity_s_per_m: 5.8e7 }
  const result = extractCoupledRlgc(geometry, material, { grid_mm: 0.05 })
  expect(result.C_f_per_m[0][1]).toBeLessThan(0)
  expect(result.L_h_per_m[0][1]).toBeGreaterThan(0)
  expect(result.diagnostics.relative_residual).toBeLessThan(1e-10)
  expect(result.C_f_per_m[0][0] / result.C_f_per_m[1][1]).toBeCloseTo(1, 9)
  expect(() => validateCoupledRlgc(result)).not.toThrow()
  expect(() => extractCoupledRlgc(geometry, { ...material, conductivity_s_per_m: NaN })).toThrow("conductivity")
  expect(() => extractCoupledRlgc(geometry, { ...material, relative_permittivity: 0.9 })).toThrow("vacuum")
})
test("weak coupling gates cannot disappear inside a large diagonal matrix norm", () => {
  const a: CoupledRlgc = { R_ohm_per_m: [[0, 0], [0, 0]], G_s_per_m: [[0, 0], [0, 0]], L_h_per_m: [[3e-7, 1e-9], [1e-9, 3e-7]], C_f_per_m: [[1e-10, -1e-12], [-1e-12, 1e-10]] }
  const b = structuredClone(a)
  b.C_f_per_m[0][1] = b.C_f_per_m[1][0] = -2e-12
  expect(compareRlgcCoupling(a, b).passes).toBe(false)
  b.C_f_per_m[0][1] = b.C_f_per_m[1][0] = -1.01e-12
  expect(compareRlgcCoupling(a, b).passes).toBe(true)
})
test("DC equilibrium obeys independent source plus line plus load Ohm law and inward terminal signs", () => {
  const rlgc: CoupledRlgc = { R_ohm_per_m: [[10, 0], [0, 10]], G_s_per_m: [[0, 0], [0, 0]], L_h_per_m: [[3e-7, 4e-8], [4e-8, 3e-7]], C_f_per_m: [[1e-10, -6e-12], [-6e-12, 1e-10]] }
  const line = { source_resistance_ohms: 50, load_resistance_ohms: 100, waveform: [[0, 1]] as [number, number][] }
  const result = simulateCoupledLines(rlgc, [line, { ...line, waveform: [[0, 0]] }], { length_m: 0.02, duration_s: 1e-9, sample_interval_s: 20e-12, segments: 16, initial_condition: "dc_equilibrium" })
  const current = 1 / (50 + 0.2 + 100)
  for (let i = 0; i < result.time_s.length; i++) {
    expect(result.near_current_a[0][i]).toBeCloseTo(current, 10)
    expect(result.far_current_a[0][i]).toBeCloseTo(-current, 10)
    expect(result.far_voltage_v[0][i]).toBeCloseTo(current * 100, 9)
    expect(Math.abs(result.far_voltage_v[1][i])).toBeLessThan(1e-12)
  }
  expect(result.time_s.length).toBe(51)
})
test("finite records retain exact requested last time without a floating ratio duplicate", () => {
  const rlgc: CoupledRlgc = { R_ohm_per_m: [[0, 0], [0, 0]], G_s_per_m: [[0, 0], [0, 0]], L_h_per_m: [[3e-7, 0], [0, 3e-7]], C_f_per_m: [[1e-10, 0], [0, 1e-10]] }
  const line = { source_resistance_ohms: 50, load_resistance_ohms: 50, waveform: [[0, 0]] as [number, number][] }
  const result = simulateCoupledLines(rlgc, [line, line], { length_m: 0.02, duration_s: 64e-9, sample_interval_s: 20e-12, segments: 4 })
  expect(result.time_s.length).toBe(3201)
  expect(result.time_s.at(-1)).toBe(64e-9)
  expect(result.time_s.every((t, i) => i === 0 || t > result.time_s[i - 1])).toBe(true)
})
test("load terminal current includes parallel capacitor charging with network-inward polarity", () => {
  const rlgc: CoupledRlgc = { R_ohm_per_m: [[0, 0], [0, 0]], G_s_per_m: [[0, 0], [0, 0]], L_h_per_m: [[3e-7, 0], [0, 3e-7]], C_f_per_m: [[1e-10, 0], [0, 1e-10]] }
  const rise = 500e-12, capacitance = 1e-12, step = 2e-12
  const line = { source_resistance_ohms: 50, load_resistance_ohms: 50, load_capacitance_f: capacitance, source_voltage: (t: number) => t < rise ? (1 - Math.cos(Math.PI * t / rise)) / 2 : 1 }
  const run = simulateCoupledLines(rlgc, [line, { ...line, source_voltage: () => 0 }], { length_m: 0.02, duration_s: 1e-9, sample_interval_s: step, segments: 32 })
  let maximumError = 0, maximumCurrent = 0
  for (let i = 1; i + 1 < run.time_s.length; i++) {
    const independent = capacitance * (run.far_voltage_v[0][i + 1] - run.far_voltage_v[0][i - 1]) / (2 * step)
    const charging = -run.far_current_a[0][i] - run.far_voltage_v[0][i] / 50
    maximumError = Math.max(maximumError, Math.abs(independent - charging))
    maximumCurrent = Math.max(maximumCurrent, Math.abs(charging))
  }
  expect(maximumCurrent).toBeGreaterThan(1e-4)
  expect(maximumError).toBeLessThan(maximumCurrent * 0.01)
})
