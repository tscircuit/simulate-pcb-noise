import { compileNoiseSource, type NoiseSource } from "./noise"

export type PrbsOrder = 7 | 9 | 11 | 15 | 23 | 31
export type SourceWaveform =
  | { kind: "dc"; voltage_v: number }
  | { kind: "sine"; offset_voltage_v: number; amplitude_v: number; amplitude_convention: "peak" | "peak_to_peak"; frequency_hz: number; phase_rad: number }
  | { kind: "pwl"; points: { time_s: number; voltage_v: number }[]; interpolation: "linear" }
  | { kind: "pulse"; low_voltage_v: number; high_voltage_v: number; delay_s: number; period_s: number; high_duration_s: number; rise_time_s: number; fall_time_s: number; edge_time_convention: "10_90" }
  | { kind: "prbs"; order: PrbsOrder; baud_rate_hz: number; low_voltage_v: number; high_voltage_v: number; rise_time_s: number; fall_time_s: number; edge_time_convention: "10_90"; seed: number; algorithm: "lfsr_fibonacci"; algorithm_version: "1" }

export interface CompiledSource {
  valueAt(time_s: number): number
  metadata: Record<string, unknown>
  minimum_transition_s?: number
  unit_interval_s?: number
}

const taps: Record<PrbsOrder, number> = { 7: 6, 9: 5, 11: 9, 15: 14, 23: 18, 31: 28 }

function finite(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite SI number`)
  return value
}

function positive(value: number, name: string): number {
  if (finite(value, name) <= 0) throw new Error(`${name} must be positive`)
  return value
}

function keys(source: object, expected: string[]): void {
  for (const key of Object.keys(source)) if (!expected.includes(key)) throw new Error(`Unsupported source field: ${key}`)
}

/** Linear-ramp full duration; the 10–90% interval covers 80% of that ramp. */
export function fullRampDuration(time_s: number, convention: "10_90"): number {
  if (convention !== "10_90") throw new Error("Only explicit 10_90 edge timing is supported")
  return finite(positive(time_s, "edge time") / 0.8, "full edge time")
}

function checked(valueAt: (time_s: number) => number, metadata: Record<string, unknown>, extra: Partial<CompiledSource> = {}): CompiledSource {
  return { ...extra, metadata, valueAt(time_s) { return finite(valueAt(finite(time_s, "time_s")), "source voltage") } }
}

function levels(source: { low_voltage_v: number; high_voltage_v: number }): [number, number] {
  const low = finite(source.low_voltage_v, "low_voltage_v")
  const high = finite(source.high_voltage_v, "high_voltage_v")
  if (high <= low) throw new Error("high_voltage_v must exceed low_voltage_v")
  finite(high - low, "voltage swing")
  return [low, high]
}

function apply(matrix: number[], state: number): number {
  let result = 0
  for (let bit = 0; bit < matrix.length; bit++) if ((state >>> bit) & 1) result ^= matrix[bit]!
  return result >>> 0
}

/** Version 1: output MSB, left shift, feedback from x^order and x^tap. */
export function createPrbsSequence(source: Extract<SourceWaveform, { kind: "prbs" }>): (index: number) => 0 | 1 {
  if (!(source.order in taps) || !Number.isInteger(source.order)) throw new Error("Unsupported PRBS order")
  if (source.algorithm !== "lfsr_fibonacci" || source.algorithm_version !== "1") throw new Error("Unsupported PRBS algorithm/version")
  const order = source.order, tap = taps[order], seed = source.seed
  const width = 2 ** order
  if (!Number.isInteger(source.seed) || source.seed <= 0 || source.seed >= width) throw new Error("PRBS seed must be a nonzero initial state smaller than 2^order")
  const advance = (state: number) => (state * 2) % width + (((state >>> (order - 1)) ^ (state >>> (tap - 1))) & 1)
  // Powers of the GF(2) state transformation permit order-31 random access
  // without allocating its two-billion-symbol period.
  const powers: number[][] = [Array.from({ length: order }, (_, bit) => advance(2 ** bit))]
  for (let power = 1; power < order; power++) powers.push(powers[power - 1]!.map((column) => apply(powers[power - 1]!, column)))
  return (index) => {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("PRBS symbol index must be a nonnegative safe integer")
    let count = index % (width - 1)
    let state = seed
    let power = 0
    while (count) {
      if (count % 2) state = apply(powers[power]!, state)
      count = Math.floor(count / 2)
      power++
    }
    return ((state >>> (order - 1)) & 1) as 0 | 1
  }
}

export function compileSource(source: SourceWaveform | NoiseSource): CompiledSource {
  if (!source || typeof source !== "object") throw new Error("Source must be an explicit waveform specification")
  switch (source.kind) {
    case "dc": {
      keys(source, ["kind", "voltage_v"])
      const voltage = finite(source.voltage_v, "voltage_v")
      return checked(() => voltage, { ...source, unit: "V", algorithm: "constant", algorithm_version: "1" })
    }
    case "sine": {
      keys(source, ["kind", "offset_voltage_v", "amplitude_v", "amplitude_convention", "frequency_hz", "phase_rad"])
      const offset = finite(source.offset_voltage_v, "offset_voltage_v")
      const amplitude = finite(source.amplitude_v, "amplitude_v")
      if (amplitude < 0) throw new Error("amplitude_v must be nonnegative")
      if (source.amplitude_convention !== "peak" && source.amplitude_convention !== "peak_to_peak") throw new Error("Sine amplitude convention must be explicit")
      const peak = amplitude / (source.amplitude_convention === "peak_to_peak" ? 2 : 1)
      finite(Math.abs(offset) + peak, "sine voltage bound")
      const frequency = positive(source.frequency_hz, "frequency_hz")
      const phase = finite(source.phase_rad, "phase_rad")
      return checked((time) => offset + peak * Math.sin(2 * Math.PI * (time % (1 / frequency)) * frequency + phase), { ...source, unit: "V", peak_amplitude_v: peak, ac_rms_v: peak / Math.SQRT2, waveform_convention: "sin(2*pi*f*t+phase)", algorithm_version: "1" })
    }
    case "pwl": {
      keys(source, ["kind", "points", "interpolation"])
      if (source.interpolation !== "linear") throw new Error("PWL interpolation must be explicitly linear")
      if (!Array.isArray(source.points) || source.points.length < 2 || source.points.length > 1_000_000) throw new Error("PWL requires 2 to 1000000 points")
      const points = source.points.map((point, index) => {
        keys(point, ["time_s", "voltage_v"])
        finite(point.time_s, `points[${index}].time_s`)
        finite(point.voltage_v, `points[${index}].voltage_v`)
        if (index && point.time_s <= source.points[index - 1]!.time_s) throw new Error("PWL times must be strictly increasing")
        return { ...point }
      })
      let minimumSegment = Infinity
      for (let index = 1; index < points.length; index++) {
        const interval = finite(points[index]!.time_s - points[index - 1]!.time_s, "PWL interval")
        if (finite(points[index]!.voltage_v - points[index - 1]!.voltage_v, "PWL voltage change") !== 0) minimumSegment = Math.min(minimumSegment, interval)
      }
      return checked((time) => {
        if (time <= points[0]!.time_s) return points[0]!.voltage_v
        if (time >= points[points.length - 1]!.time_s) return points[points.length - 1]!.voltage_v
        let left = 0, right = points.length - 1
        while (right - left > 1) { const middle = Math.floor((left + right) / 2); if (points[middle]!.time_s <= time) left = middle; else right = middle }
        const first = points[left]!, second = points[right]!
        return first.voltage_v + (second.voltage_v - first.voltage_v) * (time - first.time_s) / (second.time_s - first.time_s)
      }, { kind: "pwl", points: points.map((point) => ({ ...point })), interpolation: "linear", endpoint_behavior: "hold", authored_interval_s: { start_s: points[0]!.time_s, end_s: points[points.length - 1]!.time_s }, unit: "V", algorithm_version: "1" }, Number.isFinite(minimumSegment) ? { minimum_transition_s: minimumSegment } : {})
    }
    case "pulse": {
      keys(source, ["kind", "low_voltage_v", "high_voltage_v", "delay_s", "period_s", "high_duration_s", "rise_time_s", "fall_time_s", "edge_time_convention"])
      const [low, high] = levels(source)
      const rise = fullRampDuration(source.rise_time_s, source.edge_time_convention), fall = fullRampDuration(source.fall_time_s, source.edge_time_convention)
      const period = positive(source.period_s, "period_s"), duration = positive(source.high_duration_s, "high_duration_s"), delay = finite(source.delay_s, "delay_s")
      if (delay < 0 || (rise + fall) / 2 > Math.min(duration, period - duration)) throw new Error("Pulse edge ramps must fit between pulse midpoint boundaries")
      return checked((time) => {
        const cycle = Math.floor((time - delay + rise / 2) / period)
        if (cycle < 0) return low
        const local = time - delay - cycle * period
        if (local < rise / 2) return low + (high - low) * (local + rise / 2) / rise
        if (local < duration - fall / 2) return high
        if (local < duration + fall / 2) return high - (high - low) * (local - duration + fall / 2) / fall
        return low
      }, { ...source, unit: "V", full_rise_time_s: rise, full_fall_time_s: fall, high_duration_convention: "midpoint_to_midpoint", delay_convention: "first_rising_midpoint", edge_shape: "linear", algorithm_version: "1" }, { minimum_transition_s: Math.min(rise, fall) })
    }
    case "prbs": {
      keys(source, ["kind", "order", "baud_rate_hz", "low_voltage_v", "high_voltage_v", "rise_time_s", "fall_time_s", "edge_time_convention", "seed", "algorithm", "algorithm_version"])
      const sequence = createPrbsSequence(source)
      // A bounded direct-mapped cache keeps repeated RK stage evaluations O(1),
      // while preserving arbitrary-index support for long PRBS31 records.
      const indices = new Float64Array(8192).fill(-1), bits = new Uint8Array(8192)
      const bitAt = (index: number) => {
        const slot = index % indices.length
        if (indices[slot] !== index) { bits[slot] = sequence(index); indices[slot] = index }
        return bits[slot]!
      }
      const [low, high] = levels(source), ui = 1 / positive(source.baud_rate_hz, "baud_rate_hz")
      const rise = fullRampDuration(source.rise_time_s, source.edge_time_convention), fall = fullRampDuration(source.fall_time_s, source.edge_time_convention)
      if (Math.max(rise, fall) > ui) throw new Error("PRBS full ramps cannot exceed one unit interval")
      const voltage = (index: number) => low + (high - low) * bitAt(index)
      return checked((time) => {
        if (time <= 0) return voltage(0)
        const symbols = time / ui
        if (!Number.isFinite(symbols) || symbols > Number.MAX_SAFE_INTEGER - 1) throw new Error("Time exceeds precise PRBS symbol indexing")
        const nearest = Math.floor(symbols + 0.5)
        if (nearest > 0) {
          const previous = voltage(nearest - 1), next = voltage(nearest)
          const ramp = next > previous ? rise : fall, relative = time - nearest * ui
          if (next !== previous && Math.abs(relative) <= ramp / 2) return previous + (next - previous) * (relative + ramp / 2) / ramp
        }
        return voltage(Math.floor(symbols))
      }, { ...source, unit: "V", polynomial: [source.order, taps[source.order], 0], initial_state: source.seed, output_bit: "most_significant", shift_direction: "left", period_symbols: 2 ** source.order - 1, epoch_s: 0, prehistory: "hold_first_bit", edge_shape: "linear", symbol_boundary_convention: "transition_midpoint", full_rise_time_s: rise, full_fall_time_s: fall }, { minimum_transition_s: Math.min(rise, fall), unit_interval_s: ui })
    }
    case "stochastic_noise": return compileNoiseSource(source)
    default: throw new Error("Unsupported source waveform kind")
  }
}

export function generateSource(source: SourceWaveform | NoiseSource, times_s: number[]): { times_s: number[]; values: number[]; metadata: Record<string, unknown> } {
  if (!Array.isArray(times_s) || times_s.length < 1 || times_s.length > 1_000_000) throw new Error("Source sampling requires 1 to 1000000 explicit times")
  const compiled = compileSource(source)
  const times = times_s.map((time, index) => { finite(time, `times_s[${index}]`); if (index && time <= times_s[index - 1]!) throw new Error("Source sample times must be strictly increasing"); return time })
  return { times_s: times, values: times.map((time) => compiled.valueAt(time)), metadata: compiled.metadata }
}

/** Nominal transmitter symbol epochs, including symbols without data transitions. */
export function generateSymbolClock(source: Extract<SourceWaveform, { kind: "prbs" }>, start_s: number, end_s: number): { times_s: number[]; metadata: Record<string, unknown> } {
  const compiled = compileSource(source), ui = compiled.unit_interval_s!
  finite(start_s, "clock start_s"); finite(end_s, "clock end_s")
  if (start_s < 0 || end_s <= start_s) throw new Error("Clock interval must be positive and ordered")
  const snap = (value: number) => Math.abs(value - Math.round(value)) <= 8 * Number.EPSILON * Math.max(1, Math.abs(value)) ? Math.round(value) : value
  const first = Math.ceil(snap(start_s / ui)), last = Math.floor(snap(end_s / ui))
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first + 1 > 1_000_000) throw new Error("Clock interval exceeds event precision or count limit")
  const times_s = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => (first + index) * ui)
  return { times_s, metadata: { kind: "authored_symbol_boundary_events", provenance: "prbs_transmitter_symbol_epoch", interpretation: "nominal_reference", epoch_s: 0, ui_s: ui, edge: "rising", ui_per_selected_edge: 1, common_timebase: "simulation_seconds", source_algorithm: source.algorithm, source_algorithm_version: source.algorithm_version } }
}
