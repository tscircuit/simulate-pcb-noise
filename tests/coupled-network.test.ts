import { describe, expect, test } from "bun:test"
import { type CoupledRlgc } from "../lib/coupled-line"
import { createCoupledLineNetwork, createCoupledLineScatteringEvaluator, type CoupledCopperOptions } from "../lib/coupled-network"
import { NetworkValidationError, type Complex, type NetworkPort } from "../lib/network"

const ports = (z0 = [50, 50, 50, 50]): NetworkPort[] =>
  ["a_tx", "a_rx", "v_tx", "v_rx"].map((port_name, i) => ({ port_name, reference_impedance_ohms: z0[i]! }))
const rlgc = (): CoupledRlgc => ({
  R_ohm_per_m: [[0, 0], [0, 0]],
  L_h_per_m: [[250e-9, 0], [0, 250e-9]],
  C_f_per_m: [[100e-12, 0], [0, 100e-12]],
  G_s_per_m: [[0, 0], [0, 0]],
})
const close = (actual: Complex, real: number, imag = 0, digits = 10) => {
  expect(actual.real).toBeCloseTo(real, digits)
  expect(actual.imag).toBeCloseTo(imag, digits)
}
const sum = (a: Complex, b: Complex): Complex => ({ real: a.real + b.real, imag: a.imag + b.imag })
const product = (a: Complex, b: Complex): Complex => ({ real: a.real * b.real - a.imag * b.imag, imag: a.real * b.imag + a.imag * b.real })
const quotient = (a: Complex, b: Complex): Complex => {
  const d = b.real ** 2 + b.imag ** 2
  return { real: (a.real * b.real + a.imag * b.imag) / d, imag: (a.imag * b.real - a.real * b.imag) / d }
}
const factor = (a: Complex, k: number): Complex => ({ real: a.real * k, imag: a.imag * k })
const copperProfile = (current_distribution: CoupledCopperOptions["current_distribution"] = "one_sided"): CoupledCopperOptions => ({
  width_m: 0.3e-3, thickness_m: 35e-6, conductivity_s_per_m: 5.8e7,
  relative_permeability: 1, current_distribution,
})
function copperModel(profile: CoupledCopperOptions): CoupledRlgc {
  const model = rlgc(), resistance = 1 / (profile.conductivity_s_per_m * profile.width_m * profile.thickness_m)
  model.R_ohm_per_m = [[resistance, 0], [0, resistance]]
  return model
}

// Independent unscaled ABCD reference, used where attenuation is modest.
function referenceMode(z: Complex, y: Complex, length: number) {
  const zy = product(z, y), absolute = Math.hypot(zy.real, zy.imag)
  const gamma = { real: Math.sqrt((absolute + zy.real) / 2), imag: Math.sqrt((absolute - zy.real) / 2) }
  const lambda = factor(gamma, length)
  const cosh = { real: Math.cosh(lambda.real) * Math.cos(lambda.imag), imag: Math.sinh(lambda.real) * Math.sin(lambda.imag) }
  const sinh = { real: Math.sinh(lambda.real) * Math.cos(lambda.imag), imag: Math.cosh(lambda.real) * Math.sin(lambda.imag) }
  const b = product(quotient(z, gamma), sinh), cc = product(quotient(y, gamma), sinh)
  const denominator = sum(factor(cosh, 2), sum(factor(b, 1 / 50), factor(cc, 50)))
  const reflection = quotient(sum(factor(b, 1 / 50), factor(cc, -50)), denominator)
  const transmission = quotient({ real: 2, imag: 0 }, denominator)
  return [[reflection, transmission], [transmission, reflection]]
}

describe("exact bare four-port coupled RLGC network", () => {
  test("zero mutual matched lines give exact delay with no crosstalk, including DC", () => {
    const model = rlgc(), length = 0.02, frequencies = [0, 1e6, 1e9, 5e9]
    const response = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: frequencies })
    const delay = length * Math.sqrt(250e-9 * 100e-12)
    frequencies.forEach((f, sample) => {
      const matrix = response.matrices[sample]!, angle = 2 * Math.PI * f * delay
      for (let p = 0; p < 4; p++) for (let q = 0; q < 4; q++) {
        if ((p ^ 1) === q) close(matrix[p]![q]!, Math.cos(angle), -Math.sin(angle))
        else close(matrix[p]![q]!, 0)
      }
    })
    expect(response.dc).toEqual({ kind: "included" })
    expect(response.qualification.maximum_singular_value).toBeCloseTo(1, 10)
  })

  test("true DC series copper resistance agrees with the resistor circuit", () => {
    const model = rlgc()
    model.R_ohm_per_m = [[25, 0], [0, 25]]
    const length = 0.3, resistance = 25 * length
    const response = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: [0, 1e6, 1e9] })
    const dc = response.matrices[0]!
    close(dc[0]![0]!, resistance / (100 + resistance))
    close(dc[0]![1]!, 100 / (100 + resistance))
    close(dc[1]![0]!, 100 / (100 + resistance))
    close(dc[0]![2]!, 0)
    expect(response.qualification.maximum_singular_value).toBeLessThanOrEqual(1 + 1e-12)
  })

  test("true DC distributed ground leakage agrees with the shunt circuit", () => {
    const model = rlgc()
    model.G_s_per_m = [[0.1, 0], [0, 0.1]]
    const length = 0.3, normalizedConductance = length * 0.1 * 50
    const response = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: [0] })
    const dc = response.matrices[0]!
    close(dc[0]![0]!, -normalizedConductance / (2 + normalizedConductance))
    close(dc[0]![1]!, 2 / (2 + normalizedConductance))
    close(dc[0]![2]!, 0)
  })

  test("lossless DC with unequal extraction impedances is reciprocal and power normalized", () => {
    const response = createCoupledLineNetwork(rlgc(), { length_m: 0.02, ports: ports([40, 90, 50, 75]), frequencies_hz: [0] })
    const dc = response.matrices[0]!
    close(dc[0]![0]!, (90 - 40) / (90 + 40))
    close(dc[1]![1]!, (40 - 90) / (40 + 90))
    close(dc[0]![1]!, 2 * Math.sqrt(40 * 90) / (40 + 90))
    close(dc[1]![0]!, dc[0]![1]!.real)
    close(dc[2]![3]!, 2 * Math.sqrt(50 * 75) / 125)
    expect(response.qualification.maximum_singular_value).toBeCloseTo(1, 10)
  })

  test("simultaneous distributed R and G agree with independent real DC ODE", () => {
    const model = rlgc(), r = 12, g = 0.03, length = 0.2
    model.R_ohm_per_m = [[r, 0], [0, r]]
    model.G_s_per_m = [[g, 0], [0, g]]
    const lambda = length * Math.sqrt(r * g), characteristic = Math.sqrt(r / g)
    const a = Math.cosh(lambda), b = characteristic * Math.sinh(lambda), cc = Math.sinh(lambda) / characteristic
    const denominator = 2 * a + b / 50 + cc * 50
    const dc = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: [0] }).matrices[0]!
    close(dc[0]![0]!, (b / 50 - cc * 50) / denominator)
    close(dc[0]![1]!, 2 / denominator)
  })

  test("large attenuation remains finite without hyperbolic overflow", () => {
    const model = rlgc()
    model.R_ohm_per_m = [[1e6, 0], [0, 1e6]]
    model.G_s_per_m = [[1, 0], [0, 1]]
    const response = createCoupledLineNetwork(model, { length_m: 100, ports: ports(), frequencies_hz: [0, 1e9] })
    close(response.matrices[0]![0]![0]!, (1000 - 50) / (1000 + 50))
    close(response.matrices[0]![0]![1]!, 0)
    expect(response.qualification.maximum_singular_value).toBeLessThan(1)
  })

  test("weak high-frequency loss is retained over a long matched line", () => {
    const model = rlgc(), resistance = 1e-5, length = 1e6, frequency = 1e9
    // Distortionless line R/L=G/C has gamma=R/50+j*w*sqrt(L*C).
    model.R_ohm_per_m = [[resistance, 0], [0, resistance]]
    model.G_s_per_m = [[resistance / (50 * 50), 0], [0, resistance / (50 * 50)]]
    const response = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: [frequency] })
    const transmission = response.matrices[0]![0]![1]!
    expect(Math.hypot(transmission.real, transmission.imag)).toBeCloseTo(Math.exp(-resistance * length / 50), 10)
    close(response.matrices[0]![0]![0]!, 0)
  })

  test("evaluator snapshots its passive RLGC values and equals qualified samples", () => {
    const model = rlgc()
    model.L_h_per_m = [[250e-9, 30e-9], [30e-9, 250e-9]]
    model.C_f_per_m = [[110e-12, -10e-12], [-10e-12, 110e-12]]
    const opts = { length_m: 0.025, ports: ports() }
    const evaluator = createCoupledLineScatteringEvaluator(model, opts)
    const expected = createCoupledLineNetwork(model, { ...opts, frequencies_hz: [2e9] }).matrices[0]
    model.C_f_per_m[0][0] = 9
    opts.length_m = 1
    opts.ports[0]!.reference_impedance_ohms = 900
    expect(evaluator(2e9)).toEqual(expected!)
    expect(Math.hypot(expected![0]![2]!.real, expected![0]![2]!.imag)).toBeGreaterThan(1e-4)
  })

  test("asymmetric matrices and invalid coordinates fail explicitly", () => {
    const model = rlgc()
    model.L_h_per_m[1][1] = 300e-9
    expect(() => createCoupledLineScatteringEvaluator(model, { length_m: 0.02, ports: ports() })).toThrow("symmetric equal-trace")
    expect(() => createCoupledLineScatteringEvaluator(rlgc(), { length_m: 0, ports: ports() })).toThrow(NetworkValidationError)
    expect(() => createCoupledLineScatteringEvaluator(rlgc(), { length_m: 0.02, ports: ports().slice(0, 3) })).toThrow(NetworkValidationError)
    const evaluator = createCoupledLineScatteringEvaluator(rlgc(), { length_m: 0.02, ports: ports() })
    expect(() => evaluator(-1)).toThrow(NetworkValidationError)
    expect(() => evaluator(Number.NaN)).toThrow(NetworkValidationError)
  })

  test("finite slab copper has identical DC response without counting resistance twice", () => {
    const copper = copperProfile(), model = copperModel(copper)
    // An independently authored mutual resistive term remains in the modal model.
    model.R_ohm_per_m[0][1] = model.R_ohm_per_m[1][0] = model.R_ohm_per_m[0][0] * 0.1
    const opts = { length_m: 0.025, ports: ports(), frequencies_hz: [0] }
    expect(createCoupledLineNetwork(model, { ...opts, copper }).matrices).toEqual(createCoupledLineNetwork(model, opts).matrices)
    const mismatch = copperModel(copper)
    mismatch.R_ohm_per_m[0][0] *= 1.001
    mismatch.R_ohm_per_m[1][1] *= 1.001
    expect(() => createCoupledLineScatteringEvaluator(mismatch, { length_m: 0.025, ports: ports(), copper })).toThrow("diagonal DC resistance")
  })

  test("one- and two-sided finite slab responses stay passive and reciprocal through 25 GHz", () => {
    for (const distribution of ["one_sided", "symmetric_two_sided"] as const) {
      const copper = copperProfile(distribution), model = copperModel(copper)
      model.L_h_per_m = [[250e-9, 30e-9], [30e-9, 250e-9]]
      model.C_f_per_m = [[110e-12, -10e-12], [-10e-12, 110e-12]]
      const response = createCoupledLineNetwork(model, { length_m: 0.025, ports: ports([40, 90, 50, 75]), copper, frequencies_hz: [0, 1e3, 1e6, 1e9, 5e9, 25e9] })
      expect(response.qualification.maximum_singular_value).toBeLessThanOrEqual(1 + 1e-12)
      expect(response.qualification.maximum_reciprocity_error).toBeLessThan(1e-12)
    }
  })

  test("25 GHz skin benchmark matches independent copper half-space and full modal ABCD", () => {
    const frequency = 25e9, length = 0.02, w = 2 * Math.PI * frequency
    for (const distribution of ["one_sided", "symmetric_two_sided"] as const) {
      const copper = copperProfile(distribution), model = copperModel(copper)
      model.L_h_per_m = [[250e-9, 30e-9], [30e-9, 250e-9]]
      model.C_f_per_m = [[110e-12, -10e-12], [-10e-12, 110e-12]]
      // t/delta>20 even at t/2: finite-slab expression has reached its analytic limit.
      const delta = Math.sqrt(1 / (Math.PI * frequency * 4e-7 * Math.PI * copper.conductivity_s_per_m))
      expect(copper.thickness_m / delta / 2).toBeGreaterThan(20)
      const skinR = 1 / (copper.conductivity_s_per_m * delta * copper.width_m) * (distribution === "one_sided" ? 1 : 0.5)
      const modes = [
        referenceMode({ real: skinR, imag: skinR + w * 280e-9 }, { real: 0, imag: w * 100e-12 }, length),
        referenceMode({ real: skinR, imag: skinR + w * 220e-9 }, { real: 0, imag: w * 120e-12 }, length),
      ]
      const output = createCoupledLineNetwork(model, { length_m: length, ports: ports(), copper, frequencies_hz: [frequency] }).matrices[0]!
      for (let p = 0; p < 4; p++) for (let q = 0; q < 4; q++) {
        const sign = Math.floor(p / 2) === Math.floor(q / 2) ? 1 : -1
        const expected = factor(sum(modes[0]![p % 2]![q % 2]!, factor(modes[1]![p % 2]![q % 2]!, sign)), 0.5)
        close(output[p]![q]!, expected.real, expected.imag, 9)
      }
      const dcOnly = createCoupledLineNetwork(model, { length_m: length, ports: ports(), frequencies_hz: [frequency] }).matrices[0]!
      expect(Math.hypot(output[0]![1]!.real - dcOnly[0]![1]!.real, output[0]![1]!.imag - dcOnly[0]![1]!.imag)).toBeGreaterThan(0.01)
    }
  })

  test("finite copper profile is snapshotted and its invalid parameters reject explicitly", () => {
    const copper = copperProfile(), model = copperModel(copper)
    const evaluate = createCoupledLineScatteringEvaluator(model, { length_m: 0.025, ports: ports(), copper })
    const expected = evaluate(25e9)
    copper.conductivity_s_per_m = 1
    expect(evaluate(25e9)).toEqual(expected)
    expect(() => createCoupledLineScatteringEvaluator(model, { length_m: 0.025, ports: ports(), copper: { ...copperProfile(), relative_permeability: 0 } })).toThrow("relativePermeability")
  })
})
