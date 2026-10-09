import { describe, expect, test } from "bun:test"
import { analyzeEye } from "../lib/eye"
import { computeSpectrum } from "../lib/spectrum"
import { interpolateWaveform, subtractBaseline, thresholdCrossings, timeWeightedStatistics, validateWaveform, waveformToLegacyGraph, type BaselineIdentity, type Waveform } from "../lib/waveform"

const HASH = "b".repeat(64)
const identity: BaselineIdentity = { victim_source_sha256: HASH, loads_sha256: HASH, timing_sha256: HASH, seed: 42 }

function waveform(values: number[], step = 1e-12): Waveform {
  return {
    format: "simulation_pcb_noise_waveform_json_v1", run_id: "paired-run", observation_name: "victim_far",
    unit: "V", variant: "total", full_resolution: true,
    time: { kind: "uniform", start_s: 0, step_s: step, count: values.length }, values,
    valid_intervals_s: [{ start_s: 0, end_s: (values.length - 1) * step }],
    bandwidth_hz: 1e9, input_sha256: HASH, source_sha256: HASH,
  }
}

function alternating(symbols = 128) {
  const ui = 1e-9
  const step = 5e-12
  const rise = 100e-12
  const count = Math.round(symbols * ui / step)
  return waveform(Array.from({ length: count + 1 }, (_, i) => {
    const time = i * step
    const symbol = Math.floor(time / ui)
    const phase = time - symbol * ui
    const level = symbol % 2
    return phase < rise ? 1 - level + (2 * level - 1) * phase / rise : level
  }), step)
}

const eyeOptions = {
  signal_kind: "active_nrz" as const, rise_time_s: 100e-12, threshold_v: 0.5,
  waveform_sha256: HASH, timing_sha256: HASH,
  timing: { kind: "known_ui" as const, unit_interval_s: 1e-9, epoch_s: 50e-12, sample_offset_s: 0.5e-9 },
}

describe("full-resolution waveform validation and paired baseline", () => {
  test("rejects malformed, display-decimated, nonfinite and unordered samples", () => {
    const good = waveform([0, 0.5, 1])
    expect(validateWaveform(good)).toBe(good)
    expect(() => validateWaveform({ ...good, full_resolution: false } as unknown as Waveform)).toThrow("full-resolution")
    expect(() => validateWaveform({ ...good, values: [0, NaN, 1] })).toThrow("finite")
    expect(() => validateWaveform({ ...good, time: { kind: "explicit", times_s: [0, 1e-12, 1e-12] } })).toThrow("strictly increasing")
    expect(() => validateWaveform({ ...good, time: { kind: "explicit", times_s: [0, 1e-12] } })).toThrow("match")
    expect(() => validateWaveform(good, { max_samples: 2 })).toThrow("sample limit")
  })

  test("explicit gaps are never interpolated, crossed, or included in RMS duration", () => {
    const capture: Waveform = {
      ...waveform([0, 0, 1, 1]), time: { kind: "explicit", times_s: [0, 1e-9, 5e-9, 6e-9] },
      valid_intervals_s: [{ start_s: 0, end_s: 1e-9 }, { start_s: 5e-9, end_s: 6e-9 }],
    }
    validateWaveform(capture, { max_gap_s: 1e-9 })
    expect(() => interpolateWaveform(capture, 3e-9)).toThrow("valid interval")
    expect(thresholdCrossings(capture, 0.5)).toEqual([])
    const statistics = timeWeightedStatistics(capture)
    expect(Math.abs(statistics.duration_s / 2e-9 - 1)).toBeLessThan(1e-12)
    expect(Math.abs(statistics.rms - Math.SQRT1_2)).toBeLessThan(1e-12)
    expect(() => computeSpectrum(capture, { waveform_sha256: HASH, window: "rectangular", dc_treatment: "included", kind: "psd" })).toThrow("gaps")
  })

  test("active sample-gap validation refuses an unresolved gap", () => {
    expect(() => validateWaveform(waveform([0, 1, 0], 1e-9), { max_gap_s: 10e-12 })).toThrow("sample gap")
  })

  test("baseline preserves victim, loads, seed, timing and exact SI timestamps", () => {
    const total = waveform([0.1, 0.5, 0.9])
    const baseline: Waveform = { ...waveform([0, 0.4, 0.8]), run_id: "independent-baseline-run", variant: "baseline", source_sha256: "c".repeat(64) }
    const difference = subtractBaseline(total, baseline, { total: identity, baseline: identity })
    expect(difference.variant).toBe("difference")
    expect(difference.values.every((value) => Math.abs(value - 0.1) < 1e-12)).toBe(true)
    for (const key of ["victim_source_sha256", "loads_sha256", "timing_sha256"] as const) {
      expect(() => subtractBaseline(total, baseline, { total: identity, baseline: { ...identity, [key]: "d".repeat(64) } })).toThrow("preserve")
    }
    expect(() => subtractBaseline(total, baseline, { total: identity, baseline: { ...identity, seed: 43 } })).toThrow("preserve")
    expect(() => subtractBaseline(total, { ...baseline, time: { kind: "uniform", start_s: 0, step_s: 0.9e-12, count: 3 } }, { total: identity, baseline: identity })).toThrow("timestamps")
  })

  test("legacy voltage/current graph adapter converts seconds to milliseconds once", () => {
    const options = { simulation_experiment_id: "simulation_experiment_noise", graph_id: "simulation_transient_voltage_graph_noise" }
    const voltage = waveformToLegacyGraph(waveform([0, 1, 0], 1e-9), options)
    expect(voltage.type).toBe("simulation_transient_voltage_graph")
    expect(voltage.timestamps_ms[0]).toBe(0)
    expect(Math.abs(voltage.timestamps_ms[1]! / 1e-6 - 1)).toBeLessThan(1e-12)
    expect(Math.abs(voltage.timestamps_ms[2]! / 2e-6 - 1)).toBeLessThan(1e-12)
    const current = waveformToLegacyGraph({ ...waveform([0, 1, 0], 1e-9), unit: "A" }, options)
    expect(current.type).toBe("simulation_transient_current_graph")
    expect(current.timestamps_ms).toEqual(voltage.timestamps_ms)
  })
})

describe("fixed physical-time eye gates", () => {
  test("requires 64 complete windows and refuses undersampled edges", () => {
    const short = analyzeEye(alternating(32), eyeOptions)
    expect(short.status).toBe("eye_unavailable")
    if (short.status === "eye_unavailable") expect(short.code).toBe("insufficient_windows")
    const sparse = analyzeEye(waveform(Array.from({ length: 2561 }, (_, i) => i % 2), 50e-12), eyeOptions)
    expect(sparse.status).toBe("eye_unavailable")
    if (sparse.status === "eye_unavailable") expect(sparse.code).toBe("invalid_waveform")
  })

  test("constant delay changes folded phase without inventing timing variation", () => {
    const result = analyzeEye(alternating(), { ...eyeOptions, timing: { ...eyeOptions.timing, epoch_s: 0 } })
    expect(result.status).toBe("eye_available")
    if (result.status === "eye_available") {
      expect(result.eye.metrics.jitter_rms_s).toBeLessThan(1e-18)
      expect(result.eye.resolved_timing.kind).toBe("known_ui")
      if (result.eye.resolved_timing.kind === "known_ui") expect(result.eye.resolved_timing.epoch_s).toBe(0)
    }
  })

  test("one training phase is frozen and requires 32 training transitions", () => {
    const timing = { kind: "known_ui" as const, unit_interval_s: 1e-9, sample_offset_s: 0.5e-9, training_interval_s: { start_s: 0, end_s: 80e-9 } }
    const result = analyzeEye(alternating(), { ...eyeOptions, timing })
    expect(result.status).toBe("eye_available")
    if (result.status === "eye_available" && result.eye.resolved_timing.kind === "known_ui") expect(Math.abs(result.eye.resolved_timing.epoch_s - 50e-12)).toBeLessThan(1e-15)
    const tooShort = analyzeEye(alternating(), { ...eyeOptions, timing: { ...timing, training_interval_s: { start_s: 0, end_s: 10e-9 } } })
    expect(tooShort.status).toBe("eye_unavailable")
    if (tooShort.status === "eye_unavailable") expect(tooShort.code).toBe("insufficient_training")
  })

  test("period errors and missing explicit clock symbols cannot be stretched away", () => {
    const clock = Array.from({ length: 129 }, (_, i) => i * 1e-9)
    clock.splice(60, 1)
    const result = analyzeEye(alternating(), {
      ...eyeOptions, timing: { kind: "explicit_clock", unit_interval_s: 1e-9, sample_offset_s: 0.5e-9,
        clock_edges_s: clock, edge_polarity: "both", symbol_mapping: "one_edge_per_symbol",
        interpretation: "nominal_reference", clock_source: { kind: "authored_edges", source_name: "transmitter_symbols" } },
    })
    expect(result.status).toBe("eye_unavailable")
    if (result.status === "eye_unavailable") expect(result.code).toBe("ambiguous_clock")
  })

  test("data cannot masquerade as its own independent receiver clock", () => {
    const capture = alternating()
    const timing = {
      kind: "explicit_clock" as const, unit_interval_s: 1e-9, sample_offset_s: 0.5e-9,
      clock_edges_s: Array.from({ length: 129 }, (_, i) => i * 1e-9),
      edge_polarity: "both" as const, symbol_mapping: "one_edge_per_symbol" as const,
      interpretation: "actual_receiver_clock" as const,
      clock_source: { kind: "observation" as const, observation_name: capture.observation_name },
    }
    const selfReference = analyzeEye(capture, { ...eyeOptions, timing })
    expect(selfReference.status).toBe("eye_unavailable")
    if (selfReference.status === "eye_unavailable") expect(selfReference.code).toBe("invalid_clock_provenance")
    const equalHash = analyzeEye(capture, { ...eyeOptions, timing: { ...timing, clock_source: { kind: "observation", observation_name: "other_clock_name" }, clock_waveform_sha256: HASH } })
    expect(equalHash.status).toBe("eye_unavailable")
    if (equalHash.status === "eye_unavailable") expect(equalHash.code).toBe("invalid_clock_provenance")
  })
})

describe("window-calibrated spectrum", () => {
  test("periodic Hann preserves peak/RMS units and integrated PSD Parseval identity", () => {
    const count = 2048
    const capture = waveform(Array.from({ length: count }, (_, i) => 2 + 1.5 * Math.sin(2 * Math.PI * 64 * i / count)), 1e-12)
    const options = { waveform_sha256: HASH, window: "hann" as const, dc_treatment: "included" as const }
    const peak = computeSpectrum(capture, { ...options, kind: "amplitude_peak" })
    const rms = computeSpectrum(capture, { ...options, kind: "amplitude_rms" })
    const psd = computeSpectrum(capture, { ...options, kind: "psd" })
    expect(Math.abs(peak.values[64]! - 1.5)).toBeLessThan(1e-10)
    expect(Math.abs(rms.values[64]! - 1.5 / Math.SQRT2)).toBeLessThan(1e-10)
    expect(Math.abs(psd.integrated_power - (4 + 1.5 ** 2 / 2))).toBeLessThan(1e-10)
    expect(psd.parseval_relative_error).toBeLessThan(1e-12)
    expect(psd.coherent_gain).toBeCloseTo(0.5)
    expect(Math.abs(psd.enbw_hz / (1.5e12 / count) - 1)).toBeLessThan(1e-12)
  })

  test("refuses silent adaptive resampling and undersized FFT truncation", () => {
    const capture = { ...waveform([0, 1, 0]), time: { kind: "explicit" as const, times_s: [0, 1e-12, 1.8e-12] } }
    const options = { waveform_sha256: HASH, window: "rectangular" as const, dc_treatment: "included" as const, kind: "psd" as const }
    expect(() => computeSpectrum(capture, options)).toThrow("uniform")
    expect(() => computeSpectrum(waveform([0, 1, 0]), { ...options, fft_length: 2 })).toThrow("covering every sample")
  })
})
