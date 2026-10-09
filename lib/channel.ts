import { createCoupledLineScatteringEvaluator, type CoupledCopperOptions } from "./coupled-network"
import type { CoupledRlgc, LineTestbench } from "./coupled-line"
import type { Complex, ComplexMatrix } from "./network"

export interface ChannelOptions {
  length_m: number
  duration_s: number
  sample_interval_s: number
  initial_condition: "zero" | "dc_equilibrium"
  /** Source final value is held this long before its perturbation is zero padded. */
  padding_duration_s: number
  maximum_wrap_error_v: number
  maximum_wrap_error_a?: number
  maximum_fft_size?: number
  /** Explicit planar internal copper impedance; external/mutual L stays in RLGC. */
  copper?: CoupledCopperOptions
}

export interface ChannelTransient {
  time_s: number[]
  near_voltage_v: [number[], number[]]
  far_voltage_v: [number[], number[]]
  near_current_a: [number[], number[]]
  far_current_a: [number[], number[]]
  diagnostics: {
    method: "exact_modal_frequency_response_radix2_fft"
    fft_size: number
    refined_fft_size: number
    bandwidth_hz: number
    frequency_step_hz: number
    sample_interval_s: number
    sample_count: number
    record_duration_s: number
    padding_duration_s: number
    source_hold_duration_s: number
    port_reference_impedance_ohms: number
    circular_wrap_refinement_max_v: number
    circular_wrap_refinement_max_a: number
    causal_pre_response_max_v: number
    nyquist_projection_bound_v: number
    nyquist_projection_bound_a: number
    maximum_wrap_error_v: number
    maximum_wrap_error_a: number
    initial_condition: "zero" | "dc_equilibrium"
    dc_operating_point: { voltage_v: number[]; inward_current_a: number[] }
    port_order: readonly ["aggressor_near", "aggressor_far", "victim_near", "victim_far"]
    negative_frequencies: "complex_conjugate"
    nyquist_policy: "real_projection_with_reported_error_bound"
    input_sampling: "uniform_samples_without_unsampled_bandwidth_inference"
    copper_model: "fixed_rlgc_resistance" | "finite_slab_internal_impedance"
    copper?: CoupledCopperOptions
  }
}

const complex = (real: number, imag = 0): Complex => ({ real, imag })
const add = (a: Complex, b: Complex) => complex(a.real + b.real, a.imag + b.imag)
const subtract = (a: Complex, b: Complex) => complex(a.real - b.real, a.imag - b.imag)
const multiply = (a: Complex, b: Complex) => complex(a.real * b.real - a.imag * b.imag, a.real * b.imag + a.imag * b.real)
const scale = (a: Complex, k: number) => complex(a.real * k, a.imag * k)
const magnitude = (a: Complex) => Math.hypot(a.real, a.imag)
function divide(a: Complex, b: Complex): Complex {
  const m = magnitude(b)
  if (!(m > 0) || !Number.isFinite(m)) throw new Error("Singular source/load network closure")
  const unit = scale(b, 1 / m)
  return scale(multiply(a, complex(unit.real, -unit.imag)), 1 / m)
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`)
  return value
}

/** In-place DFT convention exp(-j*2*pi*k*n/N); inverse has the sole 1/N scaling. */
export function channelFft(real: Float64Array, imag: Float64Array, inverse = false): void {
  const n = real.length
  if (n < 2 || n !== imag.length || (n & (n - 1)) !== 0 || n > 2 ** 22) throw new RangeError("FFT requires equal power-of-two arrays of length 2 through 4194304")
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const r = real[i]!, q = imag[i]!
      real[i] = real[j]!; imag[i] = imag[j]!
      real[j] = r; imag[j] = q
    }
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / width
    const wr = Math.cos(angle), wi = Math.sin(angle)
    for (let first = 0; first < n; first += width) {
      let tr = 1, ti = 0
      for (let offset = 0; offset < width / 2; offset++) {
        const a = first + offset, b = a + width / 2
        const br = real[b]! * tr - imag[b]! * ti
        const bi = real[b]! * ti + imag[b]! * tr
        real[b] = real[a]! - br; imag[b] = imag[a]! - bi
        real[a] += br; imag[a] += bi
        const next = tr * wr - ti * wi
        ti = tr * wi + ti * wr; tr = next
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n }
}

function solve(matrix: ComplexMatrix, rhs: Complex[]): Complex[] {
  const a = matrix.map((row, i) => [...row.map((value) => ({ ...value })), { ...rhs[i]! }])
  let largestPivot = 0, smallestPivot = Infinity
  for (let column = 0; column < 4; column++) {
    let pivot = column
    for (let row = column + 1; row < 4; row++) if (magnitude(a[row]![column]!) > magnitude(a[pivot]![column]!)) pivot = row
    ;[a[column], a[pivot]] = [a[pivot]!, a[column]!]
    const p = a[column]![column]!, size = magnitude(p)
    largestPivot = Math.max(largestPivot, size); smallestPivot = Math.min(smallestPivot, size)
    if (!(size > 1e-14) || largestPivot / smallestPivot > 1e12) throw new Error("Ill-conditioned source/load network closure")
    for (let j = column; j <= 4; j++) a[column]![j] = divide(a[column]![j]!, p)
    for (let row = column + 1; row < 4; row++) {
      const factor = a[row]![column]!
      for (let j = column; j <= 4; j++) a[row]![j] = subtract(a[row]![j]!, multiply(factor, a[column]![j]!))
    }
  }
  const solution: Complex[] = Array.from({ length: 4 }, () => complex(0))
  for (let row = 3; row >= 0; row--) {
    let value = a[row]![4]!
    for (let j = row + 1; j < 4; j++) value = subtract(value, multiply(a[row]![j]!, solution[j]!))
    solution[row] = value
  }
  return solution
}

function sourceEvaluator(line: LineTestbench): (t: number) => number {
  if ((line.waveform === undefined) === (line.source_voltage === undefined)) throw new Error("Supply exactly one source evaluator or explicit PWL waveform")
  if (line.source_voltage) return line.source_voltage
  const points = line.waveform!
  if (points.length < 1 || points[0]![0] !== 0 || points.length > 100000) throw new Error("PWL requires a time-zero knot and at most 100000 knots")
  for (let i = 0; i < points.length; i++) if (!Number.isFinite(points[i]![0]) || !Number.isFinite(points[i]![1]) || (i && points[i]![0] <= points[i - 1]![0])) throw new Error("PWL knots must be finite and strictly increasing")
  return (time) => {
    let left = 0, right = points.length - 1
    while (right - left > 1) { const middle = (left + right) >> 1; if (points[middle]![0] <= time) left = middle; else right = middle }
    if (time >= points[right]![0]) return points[right]![1]
    const a = points[left]!, b = points[right]!
    return a[1] + (b[1] - a[1]) * (time - a[0]) / (b[0] - a[0])
  }
}

/** Exact uniform-line response sampled at actual FFT frequencies. No fitted or interpolated network. */
export function simulateCoupledChannel(rlgc: CoupledRlgc, lines: [LineTestbench, LineTestbench], options: ChannelOptions): ChannelTransient {
  const length = positive(options.length_m, "length_m")
  const duration = positive(options.duration_s, "duration_s"), dt = positive(options.sample_interval_s, "sample_interval_s")
  const padding = positive(options.padding_duration_s, "padding_duration_s")
  const voltageTolerance = positive(options.maximum_wrap_error_v, "maximum_wrap_error_v")
  const intervals = Math.round(duration / dt)
  if (intervals < 1 || intervals > 100000 || Math.abs(duration / dt - intervals) > 1e-7) throw new Error("Duration must contain 1 through 100000 complete uniform sample intervals")
  const count = intervals + 1, paddingSamples = Math.ceil(padding / dt)
  const maxFft = options.maximum_fft_size ?? 1048576
  if (!Number.isInteger(maxFft) || maxFft < 8 || maxFft > 4194304 || (maxFft & (maxFft - 1)) !== 0) throw new Error("maximum_fft_size must be a power of two from 8 through 4194304")
  let n = 2
  while (n < count + 2 * paddingSamples) n *= 2
  if (2 * n > maxFft) throw new Error("Padded and doubled-padding FFT exceed the declared resource limit")
  const source = lines.map(sourceEvaluator)
  for (const line of lines) {
    positive(line.source_resistance_ohms, "source_resistance_ohms"); positive(line.load_resistance_ohms, "load_resistance_ohms")
    if (!Number.isFinite(line.load_capacitance_f ?? 0) || (line.load_capacitance_f ?? 0) < 0 || !Number.isFinite(line.load_bias_voltage_v ?? 0)) throw new Error("Load capacitance and bias must be finite; capacitance must be nonnegative")
    if (line.minimum_transition_s !== undefined && positive(line.minimum_transition_s, "minimum_transition_s") < 10 * dt * (1 - 1e-12)) throw new Error("Declared source transitions require at least ten uniform samples")
  }
  const currentTolerance = positive(options.maximum_wrap_error_a ?? voltageTolerance / Math.max(...lines.map((line) => line.source_resistance_ohms)), "maximum_wrap_error_a")
  if (options.initial_condition !== "zero" && options.initial_condition !== "dc_equilibrium") throw new Error("Explicit zero or dc_equilibrium initial condition is required")
  const sampled = source.map((evaluate) => Array.from({ length: count }, (_, i) => {
    const value = evaluate(i * dt)
    if (!Number.isFinite(value)) throw new Error("Source evaluator produced a nonfinite voltage")
    return value
  }))
  const initial = sampled.map((values) => values[0]!)
  if (options.initial_condition === "zero" && (initial.some((v) => v !== 0) || lines.some((line) => (line.load_bias_voltage_v ?? 0) !== 0))) throw new Error("Nonzero source/load initial voltage requires dc_equilibrium")
  const portOrder = ["aggressor_near", "aggressor_far", "victim_near", "victim_far"] as const
  // This fixed normalization is a coordinate basis only; actual source/load impedances are below.
  const z0 = 50, rootZ = Math.sqrt(z0)
  const evaluate = createCoupledLineScatteringEvaluator(rlgc, { length_m: length, ports: portOrder.map((port_name) => ({ port_name, reference_impedance_ohms: z0 })), copper: options.copper })
  function close(frequency: number, excitation: Complex[]): { voltage: Complex[]; current: Complex[] } {
    const s = evaluate(frequency)
    const terminal = [complex(lines[0].source_resistance_ohms), divide(complex(1), complex(1 / lines[0].load_resistance_ohms, 2 * Math.PI * frequency * (lines[0].load_capacitance_f ?? 0))), complex(lines[1].source_resistance_ohms), divide(complex(1), complex(1 / lines[1].load_resistance_ohms, 2 * Math.PI * frequency * (lines[1].load_capacitance_f ?? 0)))]
    const reflection = terminal.map((z) => divide(subtract(z, complex(z0)), add(z, complex(z0))))
    const rhs = terminal.map((z, p) => divide(scale(excitation[p]!, rootZ), add(z, complex(z0))))
    const matrix = s.map((row, p) => row.map((value, q) => subtract(complex(p === q ? 1 : 0), multiply(reflection[p]!, value))))
    const incident = solve(matrix, rhs)
    const outgoing = s.map((row) => row.reduce((sum, value, q) => add(sum, multiply(value, incident[q]!)), complex(0)))
    return { voltage: incident.map((a, p) => scale(add(a, outgoing[p]!), rootZ)), current: incident.map((a, p) => scale(subtract(a, outgoing[p]!), 1 / rootZ)) }
  }
  const operating = close(0, [complex(initial[0]!), complex(lines[0].load_bias_voltage_v ?? 0), complex(initial[1]!), complex(lines[1].load_bias_voltage_v ?? 0)])
  if ([...operating.voltage, ...operating.current].some((value) => !Number.isFinite(value.real) || Math.abs(value.imag) > 1e-12)) throw new Error("DC network operating point is nonfinite or complex")
  function synthesize(size: number) {
    const inputs = sampled.map((values, k) => {
      const real = new Float64Array(size), imag = new Float64Array(size)
      for (let i = 0; i < count; i++) real[i] = values[i]! - initial[k]!
      real.fill(values[count - 1]! - initial[k]!, count, count + paddingSamples)
      channelFft(real, imag)
      return { real, imag }
    })
    const output = Array.from({ length: 8 }, () => ({ real: new Float64Array(size), imag: new Float64Array(size) }))
    let nyquistV = 0, nyquistA = 0
    for (let k = 0; k <= size / 2; k++) {
      const f = k / (size * dt)
      const result = close(f, [complex(inputs[0]!.real[k]!, inputs[0]!.imag[k]!), complex(0), complex(inputs[1]!.real[k]!, inputs[1]!.imag[k]!), complex(0)])
      const values = [...result.voltage, ...result.current]
      for (let p = 0; p < 8; p++) {
        const value = values[p]!, channel = output[p]!
        if (!Number.isFinite(value.real) || !Number.isFinite(value.imag)) throw new Error("Frequency channel synthesis produced a nonfinite response")
        channel.real[k] = value.real
        if (k === 0 || k === size / 2) {
          if (k === size / 2) { if (p < 4) nyquistV = Math.max(nyquistV, Math.abs(value.imag) / size); else nyquistA = Math.max(nyquistA, Math.abs(value.imag) / size) }
          channel.imag[k] = 0
        } else {
          channel.imag[k] = value.imag
          channel.real[size - k] = value.real; channel.imag[size - k] = -value.imag
        }
      }
    }
    const values = output.map((channel, p) => {
      channelFft(channel.real, channel.imag, true)
      const dc = p < 4 ? operating.voltage[p]!.real : operating.current[p - 4]!.real
      return Array.from({ length: count }, (_, i) => {
        const value = channel.real[i]! + dc
        if (!Number.isFinite(value) || Math.abs(channel.imag[i]!) > Math.max(1e-12, Math.abs(value) * 1e-10)) throw new Error("Conjugate channel response failed real-IFFT verification")
        return value
      })
    })
    return { values, nyquistV, nyquistA }
  }
  const first = synthesize(n), refined = synthesize(2 * n)
  let wrapV = 0, wrapA = 0
  for (let p = 0; p < 8; p++) for (let i = 0; i < count; i++) {
    const difference = Math.abs(first.values[p]![i]! - refined.values[p]![i]!)
    if (p < 4) wrapV = Math.max(wrapV, difference); else wrapA = Math.max(wrapA, difference)
  }
  const firstChange = Math.min(...sampled.map((values, k) => { const i = values.findIndex((v) => Math.abs(v - initial[k]!) > 1e-12); return i < 0 ? count : i }))
  // Before any source changes, a causal DC-initialized network must remain in its operating point.
  const modalDelays = [1, -1].map((sign) => length * Math.sqrt((rlgc.L_h_per_m[0][0] + sign * rlgc.L_h_per_m[0][1]) * (rlgc.C_f_per_m[0][0] + sign * rlgc.C_f_per_m[0][1])))
  const farFirstArrival = firstChange === count ? count : Math.min(count, Math.max(firstChange, firstChange - 1 + Math.floor(Math.min(...modalDelays) / dt)))
  let precursor = 0
  for (let p = 0; p < 4; p++) for (let i = 0; i < (p % 2 ? farFirstArrival : firstChange); i++) precursor = Math.max(precursor, Math.abs(refined.values[p]![i]! - operating.voltage[p]!.real))
  const nyquistV = Math.max(first.nyquistV, refined.nyquistV), nyquistA = Math.max(first.nyquistA, refined.nyquistA)
  if (wrapV > voltageTolerance || wrapA > currentTolerance || precursor > voltageTolerance || nyquistV > voltageTolerance || nyquistA > currentTolerance) throw new Error(`Channel finite-band/zero-padding qualification failed: wrap ${wrapV} V / ${wrapA} A, precursor ${precursor} V, Nyquist ${nyquistV} V / ${nyquistA} A; increase padding or temporal resolution`)
  const v = refined.values
  return {
    time_s: Array.from({ length: count }, (_, i) => i * dt),
    near_voltage_v: [v[0]!, v[2]!], far_voltage_v: [v[1]!, v[3]!],
    near_current_a: [v[4]!, v[6]!], far_current_a: [v[5]!, v[7]!],
    diagnostics: {
      method: "exact_modal_frequency_response_radix2_fft", fft_size: n, refined_fft_size: 2 * n,
      bandwidth_hz: 1 / (2 * dt), frequency_step_hz: 1 / (2 * n * dt), sample_interval_s: dt, sample_count: count, record_duration_s: duration,
      padding_duration_s: padding, source_hold_duration_s: paddingSamples * dt, port_reference_impedance_ohms: z0,
      circular_wrap_refinement_max_v: wrapV, circular_wrap_refinement_max_a: wrapA, causal_pre_response_max_v: precursor,
      nyquist_projection_bound_v: nyquistV, nyquist_projection_bound_a: nyquistA,
      maximum_wrap_error_v: voltageTolerance, maximum_wrap_error_a: currentTolerance,
      initial_condition: options.initial_condition, dc_operating_point: { voltage_v: operating.voltage.map((value) => value.real), inward_current_a: operating.current.map((value) => value.real) },
      port_order: portOrder, negative_frequencies: "complex_conjugate", nyquist_policy: "real_projection_with_reported_error_bound",
      input_sampling: "uniform_samples_without_unsampled_bandwidth_inference",
      copper_model: options.copper ? "finite_slab_internal_impedance" : "fixed_rlgc_resistance",
      ...(options.copper ? { copper: { ...options.copper } } : {}),
    },
  }
}
