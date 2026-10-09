import { describe, expect, test } from "bun:test"
import { channelFft, simulateCoupledChannel, type ChannelOptions } from "../lib/channel"
import type { CoupledRlgc, LineTestbench } from "../lib/coupled-line"
import type { CoupledCopperOptions } from "../lib/coupled-network"

const line: CoupledRlgc = {
  R_ohm_per_m: [[0, 0], [0, 0]], G_s_per_m: [[0, 0], [0, 0]],
  L_h_per_m: [[250e-9, 0], [0, 250e-9]], C_f_per_m: [[100e-12, 0], [0, 100e-12]],
}
const settings: ChannelOptions = {
  length_m: 0.2, duration_s: 40e-9, sample_interval_s: 20e-12,
  initial_condition: "zero", padding_duration_s: 20e-9,
  maximum_wrap_error_v: 1e-4, maximum_wrap_error_a: 1e-5, maximum_fft_size: 65536,
}
const ramp = (time: number, start = 10e-9, rise = 1e-9) => Math.max(0, Math.min(1, (time - start) / rise))
const bench = (source_voltage: (t: number) => number, extras: Partial<LineTestbench> = {}): LineTestbench => ({
  source_resistance_ohms: 50, load_resistance_ohms: 50,
  load_capacitance_f: 0, load_bias_voltage_v: 0, source_voltage,
  minimum_transition_s: 1e-9, ...extras,
})
const copper: CoupledCopperOptions = { width_m: 0.00025, thickness_m: 35e-6, conductivity_s_per_m: 5.8e7, relative_permeability: 1, current_distribution: "one_sided" }
const copperDcR = 1 / (copper.conductivity_s_per_m * copper.width_m * copper.thickness_m)
const copperLine: CoupledRlgc = { ...line, R_ohm_per_m: [[copperDcR, 0], [0, copperDcR]] }
function maximumError(actual: number[], expected: (time: number, index: number) => number, times: number[]) {
  let maximum = 0
  for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i]! - expected(times[i]!, i)))
  return maximum
}

/** Independent traveling-wave reflection series, with no production matrix or FFT helpers. */
function reflected(modeL: number, modeC: number, sourceR: number, loadR: number, source: (t: number) => number, time: number, length: number) {
  const z = Math.sqrt(modeL / modeC), delay = length * Math.sqrt(modeL * modeC)
  const sourceReflection = (sourceR - z) / (sourceR + z), loadReflection = (loadR - z) / (loadR + z)
  const launch = z / (sourceR + z), q = sourceReflection * loadReflection
  let far = 0, near = launch * source(time), coefficient = 1
  for (let k = 0; k < 100; k++) {
    far += coefficient * launch * (1 + loadReflection) * source(time - (2 * k + 1) * delay)
    near += coefficient * launch * loadReflection * (1 + sourceReflection) * source(time - (2 * k + 2) * delay)
    coefficient *= q
  }
  return { near, far }
}

/** Independent scalar ABCD reference at the foil's established half-space limit. */
function copperSineTransfer(frequency: number) {
  type C = [number, number]
  const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]]
  const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
  const scale = (a: C, n: number): C => [a[0] * n, a[1] * n]
  const div = (a: C, b: C): C => { const d = b[0] ** 2 + b[1] ** 2; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d] }
  const sqrt = (a: C): C => { const radius = Math.hypot(...a); return [Math.sqrt((radius + a[0]) / 2), Math.sign(a[1]) * Math.sqrt((radius - a[0]) / 2)] }
  const w = 2 * Math.PI * frequency
  const skinR = Math.sqrt(Math.PI * frequency * 4e-7 * Math.PI / copper.conductivity_s_per_m) / copper.width_m
  const series: C = [skinR, skinR + w * 250e-9], shunt: C = [0, w * 100e-12]
  const gamma = scale(sqrt(mul(series, shunt)), 0.2), impedance = sqrt(div(series, shunt))
  const a: C = [Math.cosh(gamma[0]) * Math.cos(gamma[1]), Math.sinh(gamma[0]) * Math.sin(gamma[1])]
  const sinh: C = [Math.sinh(gamma[0]) * Math.cos(gamma[1]), Math.cosh(gamma[0]) * Math.sin(gamma[1])]
  const b = mul(impedance, sinh), cc = div(sinh, impedance)
  const denominator = add(scale(a, 100), add(b, scale(cc, 2500)))
  return { far: div([50, 0], denominator), near: div(add(scale(a, 50), b), denominator) }
}

describe("exact modal FFT channel", () => {
  test("radix2 complex FFT agrees with independent DFT and scales inverse once", () => {
    const n = 32
    const originalReal = Float64Array.from({ length: n }, (_, i) => 2 + Math.cos(2 * Math.PI * 3 * i / n) + (i % 2 ? -0.25 : 0.25))
    const originalImag = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 5 * i / n))
    const real = originalReal.slice(), imag = originalImag.slice()
    channelFft(real, imag)
    for (let k = 0; k < n; k++) {
      let re = 0, im = 0
      for (let j = 0; j < n; j++) {
        const angle = -2 * Math.PI * j * k / n, cs = Math.cos(angle), sn = Math.sin(angle)
        re += originalReal[j]! * cs - originalImag[j]! * sn
        im += originalReal[j]! * sn + originalImag[j]! * cs
      }
      expect(Math.abs(real[k]! - re)).toBeLessThan(3e-13)
      expect(Math.abs(imag[k]! - im)).toBeLessThan(3e-13)
    }
    expect(real[0]).toBeCloseTo(64, 12)
    expect(real[n / 2]).toBeCloseTo(8, 12)
    channelFft(real, imag, true)
    for (let i = 0; i < n; i++) { expect(real[i]).toBeCloseTo(originalReal[i]!, 12); expect(imag[i]).toBeCloseTo(originalImag[i]!, 12) }
  })

  test("matched line reproduces analytic delay and inward currents without spatial dispersion", () => {
    const result = simulateCoupledChannel(line, [bench((t) => ramp(t)), bench(() => 0)], settings)
    const delay = 1e-9
    expect(maximumError(result.near_voltage_v[0], (t) => ramp(t) / 2, result.time_s)).toBeLessThan(2e-12)
    expect(maximumError(result.far_voltage_v[0], (t) => ramp(t - delay) / 2, result.time_s)).toBeLessThan(2e-12)
    expect(maximumError(result.near_current_a[0], (t) => ramp(t) / 100, result.time_s)).toBeLessThan(2e-13)
    expect(maximumError(result.far_current_a[0], (t) => -ramp(t - delay) / 100, result.time_s)).toBeLessThan(2e-13)
    expect(Math.max(...result.near_voltage_v[1].map(Math.abs), ...result.far_voltage_v[1].map(Math.abs))).toBe(0)
    expect(result.diagnostics.causal_pre_response_max_v).toBeLessThan(2e-12)
    expect(result.diagnostics.circular_wrap_refinement_max_v).toBeLessThan(2e-12)
  })

  test("DC operating point preserves nonzero source and remote load bias", () => {
    const lossy = { ...line, R_ohm_per_m: [[10, 0], [0, 10]] as [[number, number], [number, number]] }
    const current = (2 - 0.5) / (25 + 100 + 10 * 0.2)
    const result = simulateCoupledChannel(lossy, [bench(() => 2, { source_resistance_ohms: 25, load_resistance_ohms: 100, load_bias_voltage_v: 0.5 }), bench(() => -1, { load_bias_voltage_v: -1 })], { ...settings, initial_condition: "dc_equilibrium" })
    expect(maximumError(result.near_voltage_v[0], () => 2 - 25 * current, result.time_s)).toBeLessThan(1e-12)
    expect(maximumError(result.far_voltage_v[0], () => 0.5 + 100 * current, result.time_s)).toBeLessThan(1e-12)
    expect(result.near_current_a[0][0]).toBeCloseTo(current, 13)
    expect(result.far_current_a[0][0]).toBeCloseTo(-current, 13)
    expect(result.far_voltage_v[1][0]).toBeCloseTo(-1, 12)
  })

  test("external asymmetric source/load impedances reproduce independent reflection series", () => {
    const source = (t: number) => ramp(t)
    const result = simulateCoupledChannel(line, [bench(source, { source_resistance_ohms: 25, load_resistance_ohms: 100 }), bench(() => 0)], settings)
    const reference = (t: number) => reflected(250e-9, 100e-12, 25, 100, source, t, 0.2)
    expect(maximumError(result.near_voltage_v[0], (t) => reference(t).near, result.time_s)).toBeLessThan(1e-9)
    expect(maximumError(result.far_voltage_v[0], (t) => reference(t).far, result.time_s)).toBeLessThan(1e-9)
    expect(maximumError(result.near_current_a[0], (t) => (source(t) - reference(t).near) / 25, result.time_s)).toBeLessThan(1e-10)
  })

  test("parallel RC termination agrees with analytic delayed first-order ramp response", () => {
    const c = 10e-12, tau = 25 * c, rise = 1e-9
    const result = simulateCoupledChannel(line, [bench((t) => ramp(t), { load_capacitance_f: c }), bench(() => 0)], settings)
    const reference = (t: number) => {
      const x = t - 11e-9
      if (x <= 0) return 0
      if (x <= rise) return 0.5 * (x - tau * (-Math.expm1(-x / tau))) / rise
      return 0.5 * (1 - tau / rise * (Math.exp(-(x - rise) / tau) - Math.exp(-x / tau)))
    }
    expect(maximumError(result.far_voltage_v[0], reference, result.time_s)).toBeLessThan(1e-4)
    expect(result.diagnostics.causal_pre_response_max_v).toBeLessThan(1e-4)
  })

  test("coupled near/far polarity and waveforms agree with an independent modal reflection series", () => {
    const coupled: CoupledRlgc = { ...line, L_h_per_m: [[250e-9, 40e-9], [40e-9, 250e-9]], C_f_per_m: [[100e-12, -10e-12], [-10e-12, 100e-12]] }
    const source = (t: number) => ramp(t)
    const result = simulateCoupledChannel(coupled, [bench(source), bench(() => 0)], settings)
    const reference = (t: number) => {
      const even = reflected(290e-9, 90e-12, 50, 50, source, t, 0.2), odd = reflected(210e-9, 110e-12, 50, 50, source, t, 0.2)
      return { near: [(even.near + odd.near) / 2, (even.near - odd.near) / 2], far: [(even.far + odd.far) / 2, (even.far - odd.far) / 2] }
    }
    for (let k = 0; k < 2; k++) {
      // Fractional-delay ramp corners retain finite-band interpolation error; the 1 V gate is 0.1%.
      expect(maximumError(result.near_voltage_v[k]!, (t) => reference(t).near[k]!, result.time_s)).toBeLessThan(1e-3)
      expect(maximumError(result.far_voltage_v[k]!, (t) => reference(t).far[k]!, result.time_s)).toBeLessThan(1e-3)
    }
    expect(Math.max(...result.near_voltage_v[1])).toBeGreaterThan(0.01)
    expect(Math.min(...result.far_voltage_v[1])).toBeLessThan(-0.01)
  })

  test("steady sine reproduces the analytic delayed peak amplitude and phase", () => {
    const frequency = 200e6
    const source = (t: number) => ramp(t, 0, 2e-9) * Math.sin(2 * Math.PI * frequency * t)
    const result = simulateCoupledChannel(line, [bench(source), bench(() => 0)], settings)
    let error = 0
    for (let i = 200; i < result.time_s.length; i++) error = Math.max(error, Math.abs(result.far_voltage_v[0][i]! - 0.5 * Math.sin(2 * Math.PI * frequency * (result.time_s[i]! - 1e-9))))
    expect(error).toBeLessThan(2e-12)
  })

  test("time-resolution refinement preserves coupled waveforms within the declared error budget", () => {
    const coupled: CoupledRlgc = { ...line, L_h_per_m: [[250e-9, 40e-9], [40e-9, 250e-9]], C_f_per_m: [[100e-12, -10e-12], [-10e-12, 100e-12]] }
    const lines: [LineTestbench, LineTestbench] = [bench((t) => ramp(t)), bench(() => 0)]
    const coarse = simulateCoupledChannel(coupled, lines, settings)
    const fine = simulateCoupledChannel(coupled, lines, { ...settings, sample_interval_s: settings.sample_interval_s / 2 })
    for (let k = 0; k < 2; k++) expect(maximumError(coarse.far_voltage_v[k]!, (_, i) => fine.far_voltage_v[k]![2 * i]!, coarse.time_s)).toBeLessThan(1e-3)
    expect(fine.diagnostics.bandwidth_hz).toBe(2 * coarse.diagnostics.bandwidth_hz)
  })

  test("invalid initial conditions, undersampled transitions and resource overflow fail", () => {
    const lines: [LineTestbench, LineTestbench] = [bench(() => 1), bench(() => 0)]
    expect(() => simulateCoupledChannel(line, lines, settings)).toThrow("dc_equilibrium")
    expect(() => simulateCoupledChannel(line, [bench((t) => ramp(t), { minimum_transition_s: 1e-12 }), bench(() => 0)], settings)).toThrow("ten uniform samples")
    expect(() => simulateCoupledChannel(line, [bench((t) => ramp(t)), bench(() => 0)], { ...settings, maximum_fft_size: 1024 })).toThrow("resource limit")
    expect(() => simulateCoupledChannel(line, [bench((t) => ramp(t)), bench(() => 0)], { ...settings, duration_s: 40.001e-9 })).toThrow("complete uniform")
  })

  test("late propagation cannot wrap into the record and pass qualification", () => {
    expect(() => simulateCoupledChannel(line, [bench((t) => ramp(t)), bench(() => 0)], {
      ...settings, length_m: 20, padding_duration_s: 1e-9,
    })).toThrow("zero-padding qualification failed")
  })

  test("significant imaginary Nyquist response is reported and rejected", () => {
    const source = (time: number) => Math.cos(Math.PI * Math.round(time / settings.sample_interval_s))
    expect(() => simulateCoupledChannel(line, [bench(source, { minimum_transition_s: undefined }), bench(() => 0)], {
      ...settings, length_m: 0.201, initial_condition: "dc_equilibrium",
    })).toThrow("Nyquist")
  })

  test("finite copper retains the independent DC operating point and strict DC-R identity", () => {
    const current = (2 - 0.5) / (25 + 100 + copperDcR * 0.2)
    const result = simulateCoupledChannel(copperLine, [bench(() => 2, { source_resistance_ohms: 25, load_resistance_ohms: 100, load_bias_voltage_v: 0.5 }), bench(() => 0)], { ...settings, initial_condition: "dc_equilibrium", copper })
    expect(maximumError(result.near_voltage_v[0], () => 2 - 25 * current, result.time_s)).toBeLessThan(1e-12)
    expect(maximumError(result.far_voltage_v[0], () => 0.5 + 100 * current, result.time_s)).toBeLessThan(1e-12)
    expect(result.diagnostics.copper_model).toBe("finite_slab_internal_impedance")
    expect(result.diagnostics.copper).toEqual(copper)
    expect(Math.max(...result.far_voltage_v[1].map(Math.abs))).toBe(0)
    expect(() => simulateCoupledChannel(line, [bench(() => 0), bench(() => 0)], { ...settings, copper })).toThrow()
  })

  test("finite copper sine attenuation and phase match independent half-space ABCD", () => {
    const frequency = 1e9
    const source = (time: number) => ramp(time, 0, 4e-9) * Math.sin(2 * Math.PI * frequency * time)
    const result = simulateCoupledChannel(copperLine, [bench(source), bench(() => 0)], { ...settings, duration_s: 100e-9, copper })
    const reference = copperSineTransfer(frequency)
    let maximum = 0
    for (let i = 0; i < result.time_s.length; i++) {
      const time = result.time_s[i]!
      if (time < 50e-9 || time > 90e-9) continue
      const sin = Math.sin(2 * Math.PI * frequency * time), cos = Math.cos(2 * Math.PI * frequency * time)
      maximum = Math.max(maximum, Math.abs(result.far_voltage_v[0][i]! - (reference.far[0] * sin + reference.far[1] * cos)), Math.abs(result.near_voltage_v[0][i]! - (reference.near[0] * sin + reference.near[1] * cos)))
    }
    expect(maximum).toBeLessThan(1e-4)
    expect(result.diagnostics.causal_pre_response_max_v).toBeLessThan(settings.maximum_wrap_error_v)
    expect(result.diagnostics.circular_wrap_refinement_max_v).toBeLessThan(settings.maximum_wrap_error_v)
  })
})
