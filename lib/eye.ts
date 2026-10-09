import { interpolateWaveform, thresholdCrossings, validateWaveform, waveformTimes, type ValidInterval, type Waveform } from "./waveform"

export type EyeTiming =
  | { kind: "known_ui"; unit_interval_s: number; epoch_s?: number; training_interval_s?: ValidInterval; sample_offset_s: number }
  | { kind: "explicit_clock"; unit_interval_s: number; clock_edges_s: number[]; sample_offset_s: number; edge_polarity: "rising" | "falling" | "both"; symbol_mapping: "one_edge_per_symbol";
      interpretation: "actual_receiver_clock" | "nominal_reference";
      clock_source: { kind: "authored_edges"; source_name: string } | { kind: "observation"; observation_name: string };
      clock_waveform_sha256?: string }

export type EyeOptions = {
  signal_kind: "active_nrz" | "quiet" | "analog"
  rise_time_s: number
  threshold_v: number
  timing: EyeTiming
  waveform_sha256: string
  timing_sha256: string
  time_bins?: number
  voltage_bins?: number
  min_voltage_v?: number
  max_voltage_v?: number
}

export type EyeAsset = {
  format: "simulation_pcb_noise_eye_json_v1"
  run_id: string
  observation_name: string
  waveform_sha256: string
  timing_sha256: string
  modulation: "nrz"
  unit_interval_s: number
  extent_ui: 2
  time_bins: number
  voltage_bins: number
  min_voltage_v: number
  max_voltage_v: number
  /** Voltage-major row order, index = voltageBin * time_bins + timeBin. */
  counts: number[]
  complete_window_count: number
  transition_count: number
  excluded_intervals_s: ValidInterval[]
  resolved_timing:
    | { kind: "known_ui"; unit_interval_s: number; epoch_s: number; sample_offset_s: number }
    | (Extract<EyeTiming, { kind: "explicit_clock" }> & { epoch_s: number })
  metrics: { jitter_rms_s: number; jitter_peak_to_peak_s: number; offset_s: number; tie_rms_s: number }
  metric_definitions: Record<string, string>
}

export type EyeAnalysis =
  | { status: "eye_available"; eye: EyeAsset }
  | { status: "eye_unavailable"; code: string; reason: string }

const unavailable = (code: string, reason: string): EyeAnalysis => ({ status: "eye_unavailable", code, reason })
const finitePositive = (value: number) => Number.isFinite(value) && value > 0

/**
 * Folds full-resolution NRZ data on a physical two-UI axis. Known UI is fixed;
 * supplied clock windows translate by physical edges without interval stretching.
 * The result describes this finite capture, not BER or receiver compliance.
 */
export function analyzeEye(waveform: Waveform, options: EyeOptions): EyeAnalysis {
  if (options.signal_kind !== "active_nrz") return unavailable("not_active_nrz", "Quiet victims and analog signals have no declared active NRZ eye")
  if (!["known_ui", "explicit_clock"].includes(options.timing.kind)) return unavailable("unsupported_timing", "Only authored known UI or an explicit symbol clock is supported")
  const timing = options.timing
  const ui = timing.unit_interval_s
  if (!finitePositive(ui) || !finitePositive(options.rise_time_s) ||
    !Number.isFinite(options.threshold_v) || !Number.isFinite(timing.sample_offset_s) ||
    timing.sample_offset_s < 0 || timing.sample_offset_s >= ui ||
    !/^[0-9a-f]{64}$/.test(options.waveform_sha256) || !/^[0-9a-f]{64}$/.test(options.timing_sha256)) {
    return unavailable("invalid_timing", "Positive finite UI/rise time, threshold, hashes and explicit sampling phase are required")
  }
  const maxGap = Math.min(ui / 32, options.rise_time_s / 10)
  try { validateWaveform(waveform, { max_gap_s: maxGap }) }
  catch (error) { return unavailable("invalid_waveform", error instanceof Error ? error.message : String(error)) }
  if (waveform.unit !== "V") return unavailable("wrong_unit", "NRZ eye analysis requires physical voltage samples")
  const times = waveformTimes(waveform)
  const edges = thresholdCrossings(waveform, options.threshold_v)
  if (!edges.length) return unavailable("no_transitions", "The declared active victim has no threshold transitions")
  const timeBins = options.time_bins ?? 256
  const voltageBins = options.voltage_bins ?? 128
  if (!Number.isInteger(timeBins) || timeBins < 32 || timeBins > 512 ||
    !Number.isInteger(voltageBins) || voltageBins < 2 || voltageBins > 256) {
    return unavailable("invalid_bins", "Eye bins must be 32..512 in time and 2..256 in voltage")
  }
  const minVoltage = options.min_voltage_v ?? waveform.values.reduce((a, b) => Math.min(a, b), Infinity)
  const maxVoltage = options.max_voltage_v ?? waveform.values.reduce((a, b) => Math.max(a, b), -Infinity)
  if (!Number.isFinite(minVoltage) || !Number.isFinite(maxVoltage) || minVoltage >= maxVoltage ||
    waveform.values.some((value) => value < minVoltage || value > maxVoltage)) {
    return unavailable("invalid_voltage_range", "Physical voltage bounds must include every full-resolution sample")
  }

  let epoch: number
  const clockByIndex = new Map<number, number>()
  if (timing.kind === "known_ui") {
    if (timing.epoch_s !== undefined && timing.training_interval_s !== undefined) return unavailable("invalid_timing", "Choose an authored epoch or a single training phase estimate")
    if (timing.epoch_s !== undefined) {
      if (!Number.isFinite(timing.epoch_s)) return unavailable("invalid_timing", "Known UI epoch must be finite")
      epoch = timing.epoch_s
    } else {
      const training = timing.training_interval_s
      if (!training || !Number.isFinite(training.start_s) || !Number.isFinite(training.end_s) || training.start_s >= training.end_s) return unavailable("invalid_timing", "Known UI requires an authored epoch or a declared training interval")
      if (!waveform.valid_intervals_s.some((interval) => training.start_s >= interval.start_s && training.end_s <= interval.end_s)) return unavailable("invalid_training", "Phase training must stay within one continuous captured interval")
      const trainingEdges = edges.filter((edge) => edge.time_s >= training.start_s && edge.time_s <= training.end_s)
      if (trainingEdges.length < 32) return unavailable("insufficient_training", "At least 32 transitions are required for one constant phase estimate")
      let cosine = 0
      let sine = 0
      for (const edge of trainingEdges) {
        const angle = (edge.time_s / ui % 1) * 2 * Math.PI
        cosine += Math.cos(angle)
        sine += Math.sin(angle)
      }
      if (Math.hypot(cosine, sine) / trainingEdges.length < 0.9) return unavailable("ambiguous_phase", "Training transitions do not establish one unambiguous fixed UI phase")
      epoch = ((Math.atan2(sine, cosine) / (2 * Math.PI) + 1) % 1) * ui
    }
  } else {
    if (!timing.clock_source || !["authored_edges", "observation"].includes(timing.clock_source.kind) || !["actual_receiver_clock", "nominal_reference"].includes(timing.interpretation) ||
      (timing.clock_source.kind === "authored_edges" && (timing.interpretation !== "nominal_reference" || !timing.clock_source.source_name)) ||
      (timing.clock_source.kind === "observation" && (!timing.clock_source.observation_name || timing.clock_source.observation_name === waveform.observation_name)) ||
      (timing.clock_waveform_sha256 !== undefined && (!/^[0-9a-f]{64}$/.test(timing.clock_waveform_sha256) || timing.clock_waveform_sha256 === options.waveform_sha256))) {
      return unavailable("invalid_clock_provenance", "Explicit clock requires independent clock identity and declared nominal/receiver timing intent")
    }
    if (timing.symbol_mapping !== "one_edge_per_symbol" ||
      !["rising", "falling", "both"].includes(timing.edge_polarity) ||
      !Array.isArray(timing.clock_edges_s) || timing.clock_edges_s.length < 65 ||
      timing.clock_edges_s.some((edge, i) => !Number.isFinite(edge) || (i > 0 && edge <= timing.clock_edges_s[i - 1]!))) {
      return unavailable("invalid_clock", "Explicit clock requires ordered physical edges, polarity and one edge per symbol")
    }
    epoch = timing.clock_edges_s[0]!
    for (let i = 0; i < timing.clock_edges_s.length; i++) {
      const edge = timing.clock_edges_s[i]!
      const index = Math.round((edge - epoch) / ui)
      if (index !== i || Math.abs(edge - (epoch + i * ui)) >= ui / 2 ||
        (i > 0 && (edge - timing.clock_edges_s[i - 1]! <= ui / 2 || edge - timing.clock_edges_s[i - 1]! >= ui * 1.5))) {
        return unavailable("ambiguous_clock", "Missing/extra clock edge or ambiguous nominal symbol association")
      }
      clockByIndex.set(index, edge)
    }
  }

  // Missing NRZ transitions are legitimate integer-UI runs; ringing is not removed.
  const occupied = new Set<number>()
  const tie: number[] = []
  for (const edge of edges) {
    const index = Math.round((edge.time_s - epoch) / ui)
    if (occupied.has(index)) return unavailable("ambiguous_crossings", "Multiple threshold crossings map to one symbol; check ringing or authored UI")
    occupied.add(index)
    const reference = timing.kind === "known_ui" ? epoch + index * ui : clockByIndex.get(index)
    if (reference === undefined) continue
    const residual = edge.time_s - reference
    if (Math.abs(residual) >= ui / 2) return unavailable("ambiguous_crossings", "A transition cannot be associated unambiguously with its symbol reference")
    tie.push(residual)
  }
  if (!tie.length) return unavailable("no_clock_overlap", "No active transitions overlap the supplied symbol clock")

  const centers: number[] = []
  const excluded: ValidInterval[] = []
  for (const [intervalIndex, interval] of waveform.valid_intervals_s.entries()) {
    // Endpoints must also lie inside captured data, rather than the declared interval alone.
    const start = Math.max(interval.start_s, times.find((time) => time >= interval.start_s)!)
    let end = interval.end_s
    for (let i = times.length - 1; i >= 0; i--) if (times[i]! <= interval.end_s) { end = times[i]!; break }
    const first = Math.ceil((start + ui - timing.sample_offset_s - epoch) / ui - 1e-10)
    const last = Math.floor((end - ui - timing.sample_offset_s - epoch) / ui + 1e-10)
    const firstCenter = centers.length
    for (let index = first; index <= last; index++) {
      const edge = timing.kind === "known_ui" ? epoch + index * ui : clockByIndex.get(index)
      if (edge === undefined) continue
      const center = edge + timing.sample_offset_s
      if (center - ui >= start - maxGap * 1e-9 && center + ui <= end + maxGap * 1e-9) centers.push(center)
    }
    if (centers.length === firstCenter) excluded.push({ start_s: start, end_s: end })
    else {
      const coveredStart = centers[firstCenter]! - ui
      const coveredEnd = centers[centers.length - 1]! + ui
      if (coveredStart > start) excluded.push({ start_s: start, end_s: coveredStart })
      if (coveredEnd < end) excluded.push({ start_s: coveredEnd, end_s: end })
    }
    const nextInterval = waveform.valid_intervals_s[intervalIndex + 1]
    if (nextInterval) excluded.push({ start_s: interval.end_s, end_s: nextInterval.start_s })
  }
  if (centers.length < 64) return unavailable("insufficient_windows", "At least 64 complete physical two-UI windows are required")
  if (centers.length * timeBins > 50_000_000) return unavailable("analysis_limit", "Requested full-resolution eye analysis exceeds the explicit work limit")
  const counts = Array<number>(timeBins * voltageBins).fill(0)
  try {
    for (const center of centers) {
      for (let x = 0; x < timeBins; x++) {
        const relativeTime = -ui + (x + 0.5) * 2 * ui / timeBins
        const value = interpolateWaveform(waveform, center + relativeTime, times, maxGap)
        const y = Math.min(voltageBins - 1, Math.floor((value - minVoltage) * voltageBins / (maxVoltage - minVoltage)))
        counts[y * timeBins + x]!++
      }
    }
  } catch (error) { return unavailable("waveform_gap", error instanceof Error ? error.message : String(error)) }
  // Constant propagation delay is skew, not jitter. This scalar statistic removes
  // its mean; the physical eye windows and transition associations remain fixed.
  const tieMean = tie.reduce((sum, value) => sum + value, 0) / tie.length
  const jitterRms = Math.sqrt(tie.reduce((sum, value) => sum + (value - tieMean) ** 2, 0) / tie.length)
  return {
    status: "eye_available",
    eye: {
      format: "simulation_pcb_noise_eye_json_v1", run_id: waveform.run_id,
      observation_name: waveform.observation_name, waveform_sha256: options.waveform_sha256,
      timing_sha256: options.timing_sha256, modulation: "nrz", unit_interval_s: ui, extent_ui: 2,
      time_bins: timeBins, voltage_bins: voltageBins, min_voltage_v: minVoltage, max_voltage_v: maxVoltage,
      counts, complete_window_count: centers.length, transition_count: tie.length,
      excluded_intervals_s: excluded,
      resolved_timing: timing.kind === "known_ui"
        ? { kind: "known_ui", unit_interval_s: ui, epoch_s: epoch, sample_offset_s: timing.sample_offset_s }
        : { ...timing, epoch_s: epoch },
      metrics: {
        jitter_rms_s: jitterRms,
        jitter_peak_to_peak_s: tie.reduce((a, b) => Math.max(a, b), -Infinity) - tie.reduce((a, b) => Math.min(a, b), Infinity),
        offset_s: tieMean,
        tie_rms_s: Math.sqrt(tie.reduce((sum, value) => sum + value * value, 0) / tie.length),
      },
      metric_definitions: {
        jitter_rms_s: "Standard deviation of threshold crossing TIE; constant propagation skew is removed only from this scalar statistic",
        offset_s: "Mean threshold crossing TIE relative to declared physical symbol references",
        tie_rms_s: "Uncentered RMS threshold crossing TIE, including constant skew",
        density: "Equal-time samples per physical two-UI window; no per-transition data alignment, time stretching, or BER inference",
      },
    },
  }
}
