import { describe, expect, test } from "bun:test"
import { compileSource, createPrbsSequence, fullRampDuration, generateSource, generateSymbolClock, type SourceWaveform } from "../lib/sources"

const prbs: Extract<SourceWaveform, { kind: "prbs" }> = { kind: "prbs", order: 7, baud_rate_hz: 1e9, low_voltage_v: 0, high_voltage_v: 1, rise_time_s: 80e-12, fall_time_s: 160e-12, edge_time_convention: "10_90", seed: 127, algorithm: "lfsr_fibonacci", algorithm_version: "1" }

describe("finite deterministic source stimuli", () => {
  test("PRBS7 independent register fixture and full period", () => {
    const bitAt = createPrbsSequence(prbs)
    const fixture = "1111111000000100000110000101000111100100010110011101010011111010"
    expect(Array.from({ length: 64 }, (_, index) => bitAt(index)).join("")).toBe(fixture)
    const states = new Set(Array.from({ length: 127 }, (_, index) => Array.from({ length: 7 }, (_, bit) => bitAt(index + bit)).join("")))
    expect(states.size).toBe(127)
    expect(Array.from({ length: 127 }, (_, index) => bitAt(index))).toEqual(Array.from({ length: 127 }, (_, index) => bitAt(index + 127)))
  })

  test("all polynomial orders match independent bit-array recurrence and high-index periodicity", () => {
    for (const [order, tap] of [[7, 6], [9, 5], [11, 9], [15, 14], [23, 18], [31, 28]] as const) {
      const spec = { ...prbs, order, seed: 5 }
      const bitAt = createPrbsSequence(spec)
      let register = Array.from({ length: order }, (_, index) => (spec.seed >>> (order - index - 1)) & 1)
      for (let index = 0; index < 256; index++) {
        expect(Number(bitAt(index))).toBe(register[0]!)
        const feedback = register[0]! ^ register[order - tap]!
        register = [...register.slice(1), feedback]
      }
      expect(bitAt(2 ** order - 1 + 91)).toBe(bitAt(91))
    }
  })

  test("10–90 rise/fall durations and centered symbol edge timing", () => {
    const compiled = compileSource(prbs)
    expect(fullRampDuration(80e-12, "10_90")).toBeCloseTo(100e-12, 20)
    // The independent PRBS7 fixture first falls at symbol 7, rises at 13.
    expect(compiled.valueAt(7e-9 - 80e-12)).toBeCloseTo(0.9, 12)
    expect(compiled.valueAt(7e-9 + 80e-12)).toBeCloseTo(0.1, 12)
    expect(compiled.valueAt(13e-9 - 40e-12)).toBeCloseTo(0.1, 12)
    expect(compiled.valueAt(13e-9 + 40e-12)).toBeCloseTo(0.9, 12)
    expect(compiled.valueAt(7e-9)).toBeCloseTo(0.5, 12)
    expect(compiled.valueAt(-1e-9)).toBe(1)
    expect(compiled.metadata).toMatchObject({ polynomial: [7, 6, 0], initial_state: 127, output_bit: "most_significant", shift_direction: "left", symbol_boundary_convention: "transition_midpoint", algorithm_version: "1" })
    expect(compiled.minimum_transition_s).toBeCloseTo(100e-12, 20)
  })

  test("DC preserves voltage; sine peak, peak-to-peak, mean and integrated RMS are explicit", () => {
    expect(compileSource({ kind: "dc", voltage_v: -0.75 }).valueAt(1)).toBe(-0.75)
    const peak = compileSource({ kind: "sine", offset_voltage_v: 3, amplitude_v: 2, amplitude_convention: "peak", frequency_hz: 1000, phase_rad: 0 })
    const pp = compileSource({ kind: "sine", offset_voltage_v: 3, amplitude_v: 4, amplitude_convention: "peak_to_peak", frequency_hz: 1000, phase_rad: 0 })
    const values = Array.from({ length: 4096 }, (_, index) => peak.valueAt(index / 4096 / 1000))
    const mean = values.reduce((total, value) => total + value, 0) / values.length
    const rms = Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length)
    expect(peak.valueAt(0.00025)).toBeCloseTo(5, 12)
    expect(pp.valueAt(0.00025)).toBeCloseTo(5, 12)
    expect(mean).toBeCloseTo(3, 12)
    expect(rms).toBeCloseTo(Math.SQRT2, 12)
    expect(peak.metadata.ac_rms_v as number).toBeCloseTo(Math.SQRT2, 12)
  })

  test("PWL interpolation holds endpoints and freezes authored points", () => {
    const spec: Extract<SourceWaveform, { kind: "pwl" }> = { kind: "pwl", interpolation: "linear", points: [{ time_s: 0, voltage_v: 0 }, { time_s: 2e-9, voltage_v: 2 }, { time_s: 3e-9, voltage_v: 0 }] }
    const compiled = compileSource(spec)
    spec.points[1]!.voltage_v = 99
    ;(compiled.metadata.points as typeof spec.points)[1]!.voltage_v = 88
    expect([-1e-9, 1e-9, 2.5e-9, 5e-9].map((time) => compiled.valueAt(time))).toEqual([0, 1, 1, 0])
    expect(compiled.metadata.endpoint_behavior).toBe("hold")
    expect(compiled.metadata.authored_interval_s).toEqual({ start_s: 0, end_s: 3e-9 })
  })

  test("PWL plateau knots do not create a false edge resolution requirement", () => {
    const compiled = compileSource({ kind: "pwl", interpolation: "linear", points: [{ time_s: 0, voltage_v: 0 }, { time_s: 1e-12, voltage_v: 0 }, { time_s: 1e-8, voltage_v: 1 }, { time_s: 1e-8 + 1e-12, voltage_v: 1 }] })
    expect(compiled.minimum_transition_s).toBe(1e-8 - 1e-12)
    expect(compiled.valueAt(1e-12)).toBe(0)
    expect(compiled.valueAt((1e-8 + 1e-12) / 2)).toBeCloseTo(0.5, 12)
    expect(compiled.valueAt(1e-8 + 1e-12)).toBe(1)
    const fastEdge = compileSource({ kind: "pwl", interpolation: "linear", points: [{ time_s: 0, voltage_v: 0 }, { time_s: 1e-12, voltage_v: 1 }] })
    expect(fastEdge.minimum_transition_s).toBe(1e-12)
  })

  test("constant PWL data carries no voltage transition sampling constraint", () => {
    const compiled = compileSource({ kind: "pwl", interpolation: "linear", points: [{ time_s: 0, voltage_v: 0.75 }, { time_s: 1e-12, voltage_v: 0.75 }, { time_s: 1e-8, voltage_v: 0.75 }] })
    expect(compiled.minimum_transition_s).toBeUndefined()
    expect([-1e-9, 0, 1e-12, 5e-9, 1e-8, 1].map((time) => compiled.valueAt(time))).toEqual([0.75, 0.75, 0.75, 0.75, 0.75, 0.75])
  })

  test("pulse finite edges use authored midpoint boundaries", () => {
    const source = compileSource({ kind: "pulse", low_voltage_v: -1, high_voltage_v: 1, delay_s: 1e-9, period_s: 4e-9, high_duration_s: 2e-9, rise_time_s: 160e-12, fall_time_s: 160e-12, edge_time_convention: "10_90" })
    expect(source.valueAt(1e-9)).toBeCloseTo(0, 12)
    expect(source.valueAt(1e-9 - 80e-12)).toBeCloseTo(-0.8, 12)
    expect(source.valueAt(1e-9 + 80e-12)).toBeCloseTo(0.8, 12)
    expect(source.valueAt(3e-9)).toBeCloseTo(0, 12)
    expect(source.valueAt(5e-9)).toBeCloseTo(0, 12)
    expect(source.valueAt(-1)).toBe(-1)
  })

  test("rejects unbounded edges, invalid seeds, algorithms, partial quantities and malformed time grids", () => {
    for (const patch of [{ rise_time_s: 0 }, { fall_time_s: Infinity }, { seed: 0 }, { seed: 128 }, { algorithm_version: "2" }, { rise_time_s: 1e-9 }, { baud_rate_hz: "1GHz trailing" }]) expect(() => compileSource({ ...prbs, ...patch } as SourceWaveform)).toThrow()
    expect(() => compileSource({ kind: "dc", voltage_v: "1V trailing" } as unknown as SourceWaveform)).toThrow("finite SI")
    expect(() => compileSource({ kind: "pwl", interpolation: "linear", points: [{ time_s: 0, voltage_v: 0 }, { time_s: 0, voltage_v: 1 }] })).toThrow("strictly increasing")
    expect(() => generateSource(prbs, [0, 0])).toThrow("strictly increasing")
    expect(() => compileSource({ ...prbs, recovery: "unknown_rate" } as SourceWaveform)).toThrow("Unsupported source field")
    expect(() => compileSource(prbs).valueAt(Infinity)).toThrow("finite SI")
  })

  test("sample generation is reproducible and copies timestamps", () => {
    const times = [0, 6e-9, 7e-9, 8e-9]
    const first = generateSource(prbs, times), second = generateSource(prbs, times)
    expect(first).toEqual(second)
    times[0] = -1
    expect(first.times_s[0]).toBe(0)
    for (const [index, expected] of [1, 1, 0.5, 0].entries()) expect(first.values[index]!).toBeCloseTo(expected, 12)
  })

  test("nominal symbol clock retains stable PRBS symbols without inventing receiver-clock provenance", () => {
    const clock = generateSymbolClock(prbs, 0, 8e-9)
    expect(clock.times_s).toHaveLength(9)
    for (let index = 0; index < clock.times_s.length; index++) expect(clock.times_s[index]!).toBeCloseTo(index * 1e-9, 20)
    expect(compileSource(prbs).valueAt(clock.times_s[2]!)).toBe(1)
    expect(clock.metadata).toMatchObject({ provenance: "prbs_transmitter_symbol_epoch", interpretation: "nominal_reference", edge: "rising", ui_per_selected_edge: 1 })
    expect(() => generateSymbolClock(prbs, -1, 1)).toThrow("positive and ordered")
  })
})
