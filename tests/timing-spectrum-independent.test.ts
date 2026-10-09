import { describe, expect, test } from "bun:test"
import { analyzeEye } from "../lib/eye"
import { computeSpectrum } from "../lib/spectrum"
import { timeWeightedStatistics, type Waveform } from "../lib/waveform"

// Expected values below come from authored edge times and analytic sine power,
// never from a production crossing, FFT, PRBS, or timing helper.
const HASH = "a".repeat(64)
const UI = 2e-9
const RAMP = 200e-12

function makeWaveform(times: number[], values: number[], step?: number): Waveform {
  return {
    format: "simulation_pcb_noise_waveform_json_v1",
    run_id: "independent-verification",
    observation_name: "victim",
    unit: "V",
    variant: "total",
    time: step === undefined
      ? { kind: "explicit", times_s: times }
      : { kind: "uniform", start_s: times[0]!, step_s: step, count: values.length },
    values,
    valid_intervals_s: [{ start_s: times[0]!, end_s: times.at(-1)! }],
    bandwidth_hz: 25e9,
    input_sha256: HASH,
    source_sha256: HASH,
    full_resolution: true,
  }
}

function alternatingCapture(symbols: number, jitterPeak = 0, adaptive = false): Waveform {
  const edges = Array.from({ length: symbols }, (_, index) => {
    const n = index + 1
    return n * UI + jitterPeak * Math.sin((2 * Math.PI * n) / 16)
  })
  const duration = symbols * UI
  const uniformStep = 4e-12
  const times: number[] = []
  const values: number[] = []
  let nextEdge = 0
  let level = 0
  let time = 0
  const count = Math.round(duration / uniformStep)
  for (let index = 0; ; index++) {
    time = adaptive ? time : index * uniformStep
    if (time > duration) break
    while (nextEdge < edges.length && time > edges[nextEdge]! + RAMP / 2) {
      level = 1 - level
      nextEdge++
    }
    const edge = edges[nextEdge]
    const fraction = edge === undefined ? 0 : Math.max(0, Math.min(1, (time - (edge - RAMP / 2)) / RAMP))
    times.push(time)
    values.push(edge !== undefined && time >= edge - RAMP / 2
      ? level + (1 - 2 * level) * fraction
      : level)
    if (!adaptive && index === count) break
    if (adaptive) {
      if (time === duration) break
      const nearEdge = edge !== undefined && Math.abs(time - edge) <= RAMP
      time = Math.min(duration, time + (nearEdge ? 1e-12 : 6e-12))
    }
  }
  return makeWaveform(times, values, adaptive ? undefined : uniformStep)
}

function eyeOptions(symbols: number, explicit = false) {
  return {
    signal_kind: "active_nrz" as const,
    rise_time_s: RAMP,
    threshold_v: 0.5,
    waveform_sha256: HASH,
    timing_sha256: HASH,
    time_bins: 128,
    voltage_bins: 32,
    min_voltage_v: 0,
    max_voltage_v: 1,
    timing: explicit
      ? {
          kind: "explicit_clock" as const,
          unit_interval_s: UI,
          clock_edges_s: Array.from({ length: symbols + 1 }, (_, n) => n * UI),
          sample_offset_s: UI / 2,
          edge_polarity: "rising" as const,
          symbol_mapping: "one_edge_per_symbol" as const,
          interpretation: "nominal_reference" as const,
          clock_source: { kind: "authored_edges" as const, source_name: "transmitter_symbols" },
        }
      : {
          kind: "known_ui" as const,
          unit_interval_s: UI,
          epoch_s: 0,
          sample_offset_s: UI / 2,
        },
  }
}

function availableEye(result: ReturnType<typeof analyzeEye>) {
  if (result.status !== "eye_available") throw new Error(JSON.stringify(result))
  expect(result.status).toBe("eye_available")
  return result.eye
}

function analyticSine(samples = 1024, amplitude = 1.5, dc = 0.25, bin = 32) {
  const rate = 64e9
  const step = 1 / rate
  const times = Array.from({ length: samples }, (_, index) => index * step)
  const values = times.map((_, index) => dc + amplitude * Math.sin((2 * Math.PI * bin * index) / samples))
  return { waveform: makeWaveform(times, values, step), rate, amplitude, dc, bin }
}

describe("independent timing and spectrum verification", () => {
  test("authored fixed timing retains 30 ps peak sinusoidal jitter", () => {
    // 512 symbols contain 32 full jitter periods. Endpoint treatment can drop
    // one crossing; the 1% gate accounts for that finite-record effect.
    const eye = availableEye(analyzeEye(alternatingCapture(512, 30e-12), eyeOptions(512)))
    const expected = 30e-12 / Math.sqrt(2)
    expect(Math.abs(eye.metrics.jitter_rms_s / expected - 1)).toBeLessThan(0.01)
    expect(eye.transition_count).toBeGreaterThanOrEqual(500)
  })

  test("known UI and an identical authored clock produce the same eye", () => {
    const capture = alternatingCapture(128, 30e-12)
    const fixed = availableEye(analyzeEye(capture, eyeOptions(128)))
    const clocked = availableEye(analyzeEye(capture, eyeOptions(128, true)))
    expect(clocked.counts).toEqual(fixed.counts)
    expect(clocked.complete_window_count).toBe(fixed.complete_window_count)
    expect(clocked.transition_count).toBe(fixed.transition_count)
    expect(Math.abs(clocked.metrics.jitter_rms_s - fixed.metrics.jitter_rms_s)).toBeLessThan(1e-15)
  })

  test("a physical clock sharing the data jitter cancels only relative TIE", () => {
    const options = eyeOptions(128, true)
    const correlated = {
      ...options,
      timing: {
        kind: "explicit_clock" as const,
        unit_interval_s: UI,
        clock_edges_s: Array.from({ length: 129 }, (_, n) =>
          n * UI + 30e-12 * Math.sin((2 * Math.PI * n) / 16)),
        sample_offset_s: UI / 2,
        edge_polarity: "rising" as const,
        symbol_mapping: "one_edge_per_symbol" as const,
        interpretation: "actual_receiver_clock" as const,
        clock_source: { kind: "observation" as const, observation_name: "receiver_clock" },
        clock_waveform_sha256: "b".repeat(64),
      },
    }
    const eye = availableEye(analyzeEye(alternatingCapture(128, 30e-12), correlated))
    expect(eye.metrics.jitter_rms_s).toBeLessThan(1e-15)
  })

  test("adaptive samples do not change normalized eye density", () => {
    const uniform = availableEye(analyzeEye(alternatingCapture(128, 30e-12), eyeOptions(128)))
    const adaptive = availableEye(analyzeEye(alternatingCapture(128, 30e-12, true), eyeOptions(128)))
    expect(adaptive.complete_window_count).toBe(uniform.complete_window_count)
    expect(adaptive.transition_count).toBe(uniform.transition_count)
    const a = uniform.counts.reduce((sum, count) => sum + count, 0)
    const b = adaptive.counts.reduce((sum, count) => sum + count, 0)
    const distance = uniform.counts.reduce((sum, count, index) =>
      sum + Math.abs(count / a - adaptive.counts[index]! / b), 0)
    expect(distance).toBeLessThan(0.015)
    expect(Math.abs(adaptive.metrics.jitter_rms_s - uniform.metrics.jitter_rms_s)).toBeLessThan(0.1e-12)
  })

  test("quiet and analog observations refuse a digital eye", () => {
    const capture = alternatingCapture(128)
    for (const signal_kind of ["quiet", "analog"] as const) {
      const result = analyzeEye(capture, { ...eyeOptions(128), signal_kind })
      expect(result.status).toBe("eye_unavailable")
    }
  })

  test("unknown-rate timing refuses alias-prone automatic recovery", () => {
    // Alternating data admits missing-transition/harmonic interpretations.
    // Without a supported recovery model it must never silently choose a UI.
    const options = {
      ...eyeOptions(128),
      timing: { kind: "recovered_clock", baud_search_range_hz: [250e6, 1e9] },
    } as unknown as Parameters<typeof analyzeEye>[1]
    const result = analyzeEye(alternatingCapture(128), options)
    expect(result.status).toBe("eye_unavailable")
    if (result.status === "eye_unavailable") expect(result.code).toBe("unsupported_timing")
  })

  test("a declared UI with multiple transitions per symbol is refused", () => {
    const options = {
      ...eyeOptions(128),
      timing: { kind: "known_ui" as const, unit_interval_s: UI * 2, epoch_s: 0, sample_offset_s: UI },
    }
    const result = analyzeEye(alternatingCapture(128), options)
    expect(result.status).toBe("eye_unavailable")
    if (result.status === "eye_unavailable") expect(result.code).toBe("ambiguous_crossings")
  })

  test("coherent sine PSD integrates to independently known DC plus AC power", () => {
    const fixture = analyticSine()
    const spectrum = computeSpectrum(fixture.waveform, {
      kind: "psd", window: "rectangular", dc_treatment: "included", waveform_sha256: HASH,
    })
    const expected = fixture.dc ** 2 + fixture.amplitude ** 2 / 2
    expect(Math.abs(spectrum.integrated_power / expected - 1)).toBeLessThan(1e-10)
    expect(spectrum.parseval_relative_error).toBeLessThan(1e-10)
    expect(spectrum.unit).toBe("V^2/Hz")
    const removed = computeSpectrum(fixture.waveform, {
      kind: "psd", window: "rectangular", dc_treatment: "mean_removed", waveform_sha256: HASH,
    })
    expect(Math.abs(removed.integrated_power / (fixture.amplitude ** 2 / 2) - 1)).toBeLessThan(1e-10)
  })

  test("sine amplitude distinguishes peak and RMS while keeping DC undoubled", () => {
    const fixture = analyticSine()
    for (const kind of ["amplitude_peak", "amplitude_rms"] as const) {
      const spectrum = computeSpectrum(fixture.waveform, {
        kind, window: "rectangular", dc_treatment: "included", waveform_sha256: HASH,
      })
      const expected = fixture.amplitude / (kind === "amplitude_rms" ? Math.sqrt(2) : 1)
      expect(Math.abs(spectrum.values[fixture.bin]! / expected - 1)).toBeLessThan(1e-10)
      expect(Math.abs(spectrum.values[0]! - fixture.dc)).toBeLessThan(1e-12)
      expect(Math.abs(spectrum.frequencies_hz[fixture.bin]! / (fixture.rate * fixture.bin / 1024) - 1)).toBeLessThan(1e-14)
    }
  })

  test("Nyquist amplitude is not incorrectly doubled or divided by sqrt(2)", () => {
    const samples = 1024
    const step = 1 / 64e9
    const capture = makeWaveform(
      Array.from({ length: samples }, (_, i) => i * step),
      Array.from({ length: samples }, (_, i) => 0.75 * (i % 2 ? -1 : 1)), step,
    )
    capture.bandwidth_hz = 32e9
    for (const kind of ["amplitude_peak", "amplitude_rms"] as const) {
      const spectrum = computeSpectrum(capture, {
        kind, window: "rectangular", dc_treatment: "included", waveform_sha256: HASH,
      })
      expect(Math.abs(spectrum.values[samples / 2]! - 0.75)).toBeLessThan(1e-12)
    }
  })

  test("time-weighted RMS agrees with analytic sine power within interpolation error", () => {
    const fixture = analyticSine(4096, 1.5, 0, 32)
    const statistics = timeWeightedStatistics(fixture.waveform)
    expect(Math.abs(statistics.rms / (fixture.amplitude / Math.sqrt(2)) - 1)).toBeLessThan(0.001)
  })

  test("full-resolution statistics handle records beyond function argument limits", () => {
    const samples = 300_001
    const step = 1e-12
    const capture = makeWaveform(
      Array.from({ length: samples }, (_, i) => i * step),
      Array.from({ length: samples }, () => -0.75), step,
    )
    const statistics = timeWeightedStatistics(capture)
    expect(statistics.peak).toBe(0.75)
    expect(Math.abs(statistics.rms - 0.75)).toBeLessThan(1e-10)
  })
})
