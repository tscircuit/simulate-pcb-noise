import { describe, expect, test } from "bun:test"
import { compileNoiseSource, compileNoiseSources, seededNoisePhases, type NoiseSource } from "../lib/noise"

const source: NoiseSource = { kind: "stochastic_noise", distribution: "random_phase_multisine", mean_voltage_v: 0.4, peak_bound_v: 0.1, bandwidth_hz: 1e6, tone_count: 16, seed: 1, algorithm: "xorshift32", algorithm_version: "1", correlation: { kind: "independent" } }

describe("declared bounded stochastic source", () => {
  test("xorshift32 independent uint32 fixture and seed reproducibility", () => {
    // Independently tabulated shift/XOR recurrence, before angle conversion.
    expect(seededNoisePhases(1, 3).map((phase) => Math.round(phase * 2 ** 32 / (2 * Math.PI)))).toEqual([270369, 67634689, 2647435461])
    const first = compileNoiseSource(source), second = compileNoiseSource(source), different = compileNoiseSource({ ...source, seed: 2 })
    const times = Array.from({ length: 256 }, (_, index) => index * 1e-8)
    expect(times.map((time) => first.valueAt(time))).toEqual(times.map((time) => second.valueAt(time)))
    expect(times.map((time) => first.valueAt(time))).not.toEqual(times.map((time) => different.valueAt(time)))
  })

  test("bounded magnitude and discrete PSD integral match authored RMS over one period", () => {
    const compiled = compileNoiseSource(source), count = 4096, period = source.tone_count / source.bandwidth_hz
    const values = Array.from({ length: count }, (_, index) => compiled.valueAt(period * index / count))
    expect(values.every((value) => Math.abs(value - source.mean_voltage_v) <= source.peak_bound_v + 1e-15)).toBe(true)
    const mean = values.reduce((sum, value) => sum + value, 0) / count
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count
    const expected = source.peak_bound_v ** 2 / (2 * source.tone_count)
    expect(mean).toBeCloseTo(source.mean_voltage_v, 12)
    expect(variance).toBeCloseTo(expected, 12)
    const spectrum = compiled.metadata.spectrum as { frequencies_hz: number[]; power_per_tone_v2: number }
    expect(spectrum.frequencies_hz[15]).toBe(source.bandwidth_hz)
    expect(spectrum.power_per_tone_v2 * spectrum.frequencies_hz.length).toBeCloseTo(variance, 12)
    expect(compiled.metadata).toMatchObject({ source_model: "authored_synthetic_voltage", distribution: "random_phase_multisine", filter: "finite_cosine_basis", algorithm_version: "1" })
    expect(compiled.metadata.assumptions).toContain("no inferred thermal or flicker noise calibration")
  })

  test("declared shared positive/negative correlation preserves the exact common realization", () => {
    const [positive, negative] = compileNoiseSources([
      { ...source, mean_voltage_v: 0, correlation: { kind: "shared", group_id: "rail", polarity: 1 } },
      { ...source, mean_voltage_v: 1, peak_bound_v: 0.2, correlation: { kind: "shared", group_id: "rail", polarity: -1 } },
    ])
    for (let index = 0; index < 100; index++) expect(negative!.valueAt(index * 1e-8) - 1).toBeCloseTo(-2 * positive!.valueAt(index * 1e-8), 12)
    expect(() => compileNoiseSources([source, source])).toThrow("distinct seeds")
    expect(() => compileNoiseSources([{ ...source, correlation: { kind: "shared", group_id: "rail", polarity: 1 } }, { ...source, bandwidth_hz: 2e6, correlation: { kind: "shared", group_id: "rail", polarity: 1 } }])).toThrow("identical seed, spectrum")
    expect(() => compileNoiseSources([source, { ...source, correlation: { kind: "shared", group_id: "independent", polarity: 1 } }])).toThrow("distinct seeds")
  })

  test("rejects undeclared distributions, invalid seeds and implicit correlation", () => {
    for (const patch of [{ seed: 0 }, { seed: 2 ** 32 }, { tone_count: 0 }, { bandwidth_hz: 0 }, { distribution: "thermal" }, { algorithm_version: "2" }, { correlation: undefined }, { correlation: { kind: "shared", group_id: "", polarity: 1 } }]) expect(() => compileNoiseSource({ ...source, ...patch } as NoiseSource)).toThrow()
    expect(() => compileNoiseSource(source).valueAt(NaN)).toThrow("finite")
  })

  test("compiled noise preserves authored values when metadata or input is edited", () => {
    const authored = { ...source }, compiled = compileNoiseSource(authored), original = compiled.valueAt(0)
    authored.mean_voltage_v = 99
    ;(compiled.metadata.phases_rad as number[])[0] = Math.PI
    expect(compiled.valueAt(0)).toBe(original)
    expect(() => compileNoiseSource({ ...source, bandwidth_hz: Number.MIN_VALUE })).toThrow("representable")
    expect(Number.isFinite(compileNoiseSource({ ...source, bandwidth_hz: 1e308 }).valueAt(1e-307))).toBe(true)
  })

  test("spectral power rejects overflow and underflow without rejecting a representable large tone", () => {
    for (const peak_bound_v of [1e200, 1e-200]) expect(() => compileNoiseSource({ ...source, tone_count: 1, peak_bound_v })).toThrow("representable")
    expect(() => compileNoiseSource({ ...source, tone_count: 2, peak_bound_v: Number.MIN_VALUE })).toThrow("representable")
    const compiled = compileNoiseSource({ ...source, tone_count: 1, peak_bound_v: 1.5e154 })
    expect(Math.abs((compiled.metadata.spectrum as { power_per_tone_v2: number }).power_per_tone_v2 / 1.125e308 - 1)).toBeLessThan(4 * Number.EPSILON)
    expect(Number.isFinite(compiled.valueAt(0))).toBe(true)
    expect(JSON.stringify(compiled.metadata)).not.toContain("null")
  })
})
