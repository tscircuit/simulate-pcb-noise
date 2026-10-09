/** Full-resolution SI waveforms. This module has no Node or browser IO. */
export type ValidInterval = { start_s: number; end_s: number }
export type Waveform = {
  format: "simulation_pcb_noise_waveform_json_v1"
  run_id: string
  observation_name: string
  unit: "V" | "A"
  variant: "total" | "baseline" | "difference"
  time:
    | { kind: "uniform"; start_s: number; step_s: number; count: number }
    | { kind: "explicit"; times_s: number[] }
  values: number[]
  valid_intervals_s: ValidInterval[]
  bandwidth_hz: number
  input_sha256: string
  source_sha256: string
  full_resolution: true
  comparison_identity?: string
}

const finite = (value: number) => Number.isFinite(value)
const hashPattern = /^[0-9a-f]{64}$/

export function waveformTimes(waveform: Waveform): number[] {
  const time = waveform.time
  return time.kind === "explicit"
    ? time.times_s
    : Array.from(
        { length: time.count },
        (_, i) => time.start_s + i * time.step_s,
      )
}

/** Throws on malformed data; never repairs, clips, or display-decimates samples. */
export function validateWaveform(
  waveform: Waveform,
  options: { max_samples?: number; max_gap_s?: number } = {},
): Waveform {
  if (options.max_samples !== undefined && (!Number.isSafeInteger(options.max_samples) || options.max_samples < 2)) {
    throw new Error("Sample limit must be a finite positive integer of at least two")
  }
  if (
    !waveform || typeof waveform !== "object" || !waveform.time ||
    waveform.format !== "simulation_pcb_noise_waveform_json_v1" ||
    waveform.full_resolution !== true ||
    !waveform.run_id || !waveform.observation_name ||
    !["V", "A"].includes(waveform.unit) ||
    !["total", "baseline", "difference"].includes(waveform.variant) ||
    !finite(waveform.bandwidth_hz) || waveform.bandwidth_hz <= 0 ||
    !hashPattern.test(waveform.input_sha256) ||
    !hashPattern.test(waveform.source_sha256)
  ) throw new Error("Invalid full-resolution waveform metadata")
  if (!Array.isArray(waveform.values) || waveform.values.length < 2 ||
    waveform.values.length > (options.max_samples ?? 10_000_000) ||
    waveform.values.some((value) => !finite(value))) {
    throw new Error("Waveform values must be finite and within the sample limit")
  }
  if (waveform.time.kind === "uniform") {
    if (!finite(waveform.time.start_s) || !finite(waveform.time.step_s) ||
      waveform.time.step_s <= 0 || !Number.isSafeInteger(waveform.time.count) ||
      waveform.time.count !== waveform.values.length) {
      throw new Error("Invalid uniform time axis in seconds")
    }
  } else if (waveform.time.kind !== "explicit" ||
    !Array.isArray(waveform.time.times_s) ||
    waveform.time.times_s.length !== waveform.values.length) {
    throw new Error("Explicit timestamps must match every waveform value")
  }
  const times = waveformTimes(waveform)
  if (times.some((time, i) => !finite(time) || (i > 0 && time <= times[i - 1]!))) {
    throw new Error("Timestamps must be finite and strictly increasing")
  }
  const intervals = waveform.valid_intervals_s
  if (!Array.isArray(intervals) || !intervals.length || intervals.some((interval, i) =>
    !finite(interval.start_s) || !finite(interval.end_s) ||
    interval.start_s >= interval.end_s ||
    (i > 0 && interval.start_s <= intervals[i - 1]!.end_s))) {
    throw new Error("Valid intervals must be ordered, finite and nonoverlapping")
  }
  if (options.max_gap_s !== undefined &&
    (!finite(options.max_gap_s) || options.max_gap_s <= 0)) {
    throw new Error("Maximum sample gap must be positive finite seconds")
  }
  let intervalIndex = 0
  const intervalCounts = intervals.map(() => 0)
  for (let i = 0; i < times.length; i++) {
    const time = times[i]!
    while (intervalIndex < intervals.length && time > intervals[intervalIndex]!.end_s) intervalIndex++
    const interval = intervals[intervalIndex]
    if (!interval || time < interval.start_s) throw new Error("Sample lies outside valid intervals")
    intervalCounts[intervalIndex] = intervalCounts[intervalIndex]! + 1
    if (i && times[i - 1]! >= interval.start_s && options.max_gap_s !== undefined &&
      time - times[i - 1]! > options.max_gap_s * (1 + 1e-9)) {
      throw new Error("Active waveform sample gap exceeds the declared resolution")
    }
  }
  if (intervalCounts.some((count) => count < 2)) throw new Error("Every valid interval requires at least two samples")
  return waveform
}

function lowerBound(times: number[], time: number): number {
  let low = 0
  let high = times.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (times[middle]! < time) low = middle + 1
    else high = middle
  }
  return low
}

/** Interpolates only within one continuous valid interval, never across a gap. */
export function interpolateWaveform(
  waveform: Waveform,
  time_s: number,
  times = waveformTimes(waveform),
  max_gap_s = Infinity,
): number {
  const interval = waveform.valid_intervals_s.find((range) => time_s >= range.start_s && time_s <= range.end_s)
  if (!interval || !finite(time_s)) throw new Error("Interpolation requested outside a valid interval")
  const next = lowerBound(times, time_s)
  if (times[next] === time_s) return waveform.values[next]!
  if (!next || next === times.length || times[next - 1]! < interval.start_s || times[next]! > interval.end_s ||
    times[next]! - times[next - 1]! > max_gap_s * (1 + 1e-9)) {
    throw new Error("Interpolation would bridge missing samples or a waveform gap")
  }
  const fraction = (time_s - times[next - 1]!) / (times[next]! - times[next - 1]!)
  return waveform.values[next - 1]! * (1 - fraction) + waveform.values[next]! * fraction
}

export function thresholdCrossings(
  waveform: Waveform,
  threshold: number,
  polarity: "rising" | "falling" | "both" = "both",
): { time_s: number; polarity: "rising" | "falling" }[] {
  validateWaveform(waveform)
  if (!finite(threshold)) throw new Error("Crossing threshold must be finite")
  const times = waveformTimes(waveform)
  const edges: { time_s: number; polarity: "rising" | "falling" }[] = []
  for (let i = 1; i < times.length; i++) {
    if (!waveform.valid_intervals_s.some((range) => times[i - 1]! >= range.start_s && times[i]! <= range.end_s)) continue
    const before = waveform.values[i - 1]!
    const after = waveform.values[i]!
    const direction = before < threshold && after >= threshold ? "rising"
      : before >= threshold && after < threshold ? "falling" : undefined
    if (direction && (polarity === "both" || polarity === direction)) {
      edges.push({ time_s: times[i - 1]! + (threshold - before) * (times[i]! - times[i - 1]!) / (after - before), polarity: direction })
    }
  }
  return edges
}

/** Exact time integral for piecewise-linear samples; gaps contribute no duration. */
export function timeWeightedStatistics(waveform: Waveform) {
  validateWaveform(waveform)
  const times = waveformTimes(waveform)
  let duration_s = 0
  let integral = 0
  let squareIntegral = 0
  for (let i = 1; i < times.length; i++) {
    if (!waveform.valid_intervals_s.some((range) => times[i - 1]! >= range.start_s && times[i]! <= range.end_s)) continue
    const step = times[i]! - times[i - 1]!
    const a = waveform.values[i - 1]!
    const b = waveform.values[i]!
    duration_s += step
    integral += step * (a + b) / 2
    squareIntegral += step * (a * a + a * b + b * b) / 3
  }
  const mean = integral / duration_s
  const mean_square = squareIntegral / duration_s
  return { duration_s, mean, mean_square, rms: Math.sqrt(mean_square), ac_rms: Math.sqrt(Math.max(0, mean_square - mean * mean)), peak: waveform.values.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0) }
}

/** Identity excludes only the aggressor activity that defines this comparison. */
export type BaselineIdentity = {
  victim_source_sha256: string
  loads_sha256: string
  timing_sha256: string
  seed: number | string | null
}

export function subtractBaseline(
  total: Waveform,
  baseline: Waveform,
  identity: { total: BaselineIdentity; baseline: BaselineIdentity },
): Waveform {
  validateWaveform(total)
  validateWaveform(baseline)
  const identityKeys = ["victim_source_sha256", "loads_sha256", "timing_sha256", "seed"] as const
  if (!identity || identityKeys.some((key) => identity.total[key] !== identity.baseline[key]) ||
    identityKeys.slice(0, 3).some((key) => !hashPattern.test(String(identity.total[key]))) ||
    total.variant !== "total" || baseline.variant !== "baseline" ||
    total.input_sha256 !== baseline.input_sha256 ||
    total.observation_name !== baseline.observation_name || total.unit !== baseline.unit ||
    total.bandwidth_hz !== baseline.bandwidth_hz ||
    total.comparison_identity !== baseline.comparison_identity ||
    JSON.stringify(total.valid_intervals_s) !== JSON.stringify(baseline.valid_intervals_s)) {
    throw new Error("Baseline must preserve physical input, victim source, loads, seed and timing")
  }
  const times = waveformTimes(total)
  const baselineTimes = waveformTimes(baseline)
  if (times.length !== baselineTimes.length || times.some((time, i) => time !== baselineTimes[i])) {
    throw new Error("Paired baseline timestamps must match exactly")
  }
  return { ...total, variant: "difference", values: total.values.map((value, i) => value - baseline.values[i]!) }
}

/** Legacy graph timestamps use milliseconds; conversion occurs at this boundary. */
export function waveformToLegacyGraph(waveform: Waveform, identity: { simulation_experiment_id: string; graph_id: string; max_preview_samples?: number }) {
  validateWaveform(waveform, { max_samples: identity.max_preview_samples ?? 100_000 })
  if (!identity.simulation_experiment_id || !identity.graph_id) throw new Error("Legacy preview graph requires explicit experiment and graph identity")
  if (waveform.valid_intervals_s.length !== 1) throw new Error("Split burst gaps into separate legacy preview graphs")
  const timestamps_ms = waveformTimes(waveform).map((seconds) => seconds * 1e3)
  const shared = {
    simulation_experiment_id: identity.simulation_experiment_id,
    timestamps_ms, start_time_ms: timestamps_ms[0]!, end_time_ms: timestamps_ms[timestamps_ms.length - 1]!,
    time_per_step: (timestamps_ms[timestamps_ms.length - 1]! - timestamps_ms[0]!) / (timestamps_ms.length - 1),
    name: waveform.observation_name,
  }
  return waveform.unit === "V"
    ? { ...shared, type: "simulation_transient_voltage_graph" as const, simulation_transient_voltage_graph_id: identity.graph_id, voltage_levels: waveform.values.slice() }
    : { ...shared, type: "simulation_transient_current_graph" as const, simulation_transient_current_graph_id: identity.graph_id, current_levels: waveform.values.slice() }
}
