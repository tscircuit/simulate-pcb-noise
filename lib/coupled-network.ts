import { validateCoupledRlgc, type CoupledRlgc, type Matrix2 } from "./coupled-line"
import { finiteCopperTraceImpedance } from "./copper"
import {
  importPassiveNetwork, NetworkValidationError, portBasisToScattering,
  type Complex, type ComplexMatrix, type NetworkPort,
  type NetworkQualificationOptions, type QualifiedPassiveNetwork,
} from "./network"

export interface CoupledCopperOptions {
  width_m: number
  thickness_m: number
  conductivity_s_per_m: number
  relative_permeability: number
  current_distribution: "one_sided" | "symmetric_two_sided"
}

export interface CoupledNetworkCoordinates {
  length_m: number
  /** Ordered [aggressor near, aggressor far, victim near, victim far]. */
  ports: NetworkPort[]
  /** Finite slab internal series impedance; excludes proximity, roughness and ground losses. */
  copper?: CoupledCopperOptions
}
export interface CoupledNetworkOptions extends CoupledNetworkCoordinates {
  frequencies_hz: number[]
}

const c = (real: number, imag = 0): Complex => ({ real, imag })
const plus = (a: Complex, b: Complex) => c(a.real + b.real, a.imag + b.imag)
const minus = (a: Complex, b: Complex) => c(a.real - b.real, a.imag - b.imag)
const scale = (a: Complex, k: number) => c(a.real * k, a.imag * k)
const times = (a: Complex, b: Complex) => c(a.real * b.real - a.imag * b.imag, a.real * b.imag + a.imag * b.real)
const magnitude = (a: Complex) => Math.hypot(a.real, a.imag)
function divide(a: Complex, b: Complex): Complex {
  const m = magnitude(b)
  if (!(m > 0) || !Number.isFinite(m))
    throw new NetworkValidationError("singular_matrix", "Modal transmission-line denominator is singular.")
  const normalized = scale(b, 1 / m)
  return scale(times(a, c(normalized.real, -normalized.imag)), 1 / m)
}
function squareRoot(a: Complex): Complex {
  const m = magnitude(a)
  if (m === 0) return c(0)
  // Recover the small component through 2*Re(root)*Im(root)=Im(a),
  // avoiding cancellation of a weak attenuation term at high frequency.
  if (a.real >= 0) {
    const real = Math.sqrt(m / 2 + a.real / 2)
    return c(real, a.imag / (2 * real))
  }
  const imag = Math.sqrt(m / 2 - a.real / 2)
  return c(Math.abs(a.imag) / (2 * imag), (a.imag < 0 ? -1 : 1) * imag)
}
function expMinus(a: Complex): Complex {
  const amplitude = Math.exp(-a.real)
  return c(amplitude * Math.cos(a.imag), -amplitude * Math.sin(a.imag))
}

function modes(matrix: Matrix2, name: string): [number, number] {
  const norm = Math.max(...matrix.flat().map(Math.abs), Number.MIN_VALUE)
  if (Math.abs(matrix[0][0] - matrix[1][1]) > norm * 1e-7)
    throw new NetworkValidationError("invalid_coordinates", `${name} is not a symmetric equal-trace matrix; even/odd modal extraction is unsupported.`)
  // Only floating-point differences in a verified symmetric geometry are averaged.
  const diagonal = (matrix[0][0] + matrix[1][1]) / 2
  const mutual = (matrix[0][1] + matrix[1][0]) / 2
  return [diagonal + mutual, diagonal - mutual]
}

/** Stable ABCD-to-S for each scalar mode. exp(-gamma*l) avoids cosh overflow. */
function modalScattering(r: number, l: number, g: number, capacitance: number, length: number, frequency: number, seriesCorrection: Complex) {
  const w = 2 * Math.PI * frequency
  const z = plus(c(r, w * l), seriesCorrection), y = c(g, w * capacitance)
  const gamma = squareRoot(times(z, y)), lambda = scale(gamma, length)
  const e = expMinus(lambda)
  let sinhScaledOverGamma: Complex
  if (magnitude(lambda) < 1e-4) {
    const lambda2 = times(lambda, lambda)
    const sinhc = plus(plus(c(1), scale(lambda2, 1 / 6)), scale(times(lambda2, lambda2), 1 / 120))
    sinhScaledOverGamma = scale(times(e, sinhc), length)
  } else sinhScaledOverGamma = divide(scale(minus(c(1), times(e, e)), 0.5), gamma)
  const a = scale(plus(c(1), times(e, e)), 0.5)
  const b = times(z, sinhScaledOverGamma), cc = times(y, sinhScaledOverGamma)
  const denominator = plus(scale(a, 2), plus(scale(b, 1 / 50), scale(cc, 50)))
  const reflection = divide(minus(scale(b, 1 / 50), scale(cc, 50)), denominator)
  const transmission = divide(scale(e, 2), denominator)
  if (![reflection, transmission].every((v) => Number.isFinite(v.real) && Number.isFinite(v.imag)))
    throw new NetworkValidationError("invalid_matrix", "Modal transmission-line response is nonfinite.", { frequency_hz: frequency })
  return [[reflection, transmission], [transmission, reflection]]
}

/** Prevalidated evaluator for broadband synthesis; source/load values stay outside. */
export function createCoupledLineScatteringEvaluator(
  rlgc: CoupledRlgc,
  coordinates: CoupledNetworkCoordinates,
): (frequencyHz: number) => ComplexMatrix {
  validateCoupledRlgc(rlgc)
  if (!Number.isFinite(coordinates.length_m) || coordinates.length_m <= 0 || coordinates.ports.length !== 4)
    throw new NetworkValidationError("invalid_coordinates", "A coupled-line network needs positive length and exactly four ordered ports.")
  const impedances = coordinates.ports.map((p) => p.reference_impedance_ohms)
  if (coordinates.ports.some((p) => typeof p.port_name !== "string" || !p.port_name.trim())
    || new Set(coordinates.ports.map((p) => p.port_name)).size !== 4
    || impedances.some((z) => !Number.isFinite(z) || z <= 0))
    throw new NetworkValidationError("invalid_coordinates", "Coupled-line ports require unique names and finite positive extraction Z0.")
  const resistance = modes(rlgc.R_ohm_per_m, "R"), inductance = modes(rlgc.L_h_per_m, "L")
  const conductance = modes(rlgc.G_s_per_m, "G"), capacitance = modes(rlgc.C_f_per_m, "C")
  const length = coordinates.length_m
  const copper = coordinates.copper && { ...coordinates.copper }
  const traceImpedance = (frequencyHz: number) => finiteCopperTraceImpedance({
    frequencyHz,
    widthM: copper!.width_m, thicknessM: copper!.thickness_m,
    conductivitySPerM: copper!.conductivity_s_per_m,
    relativePermeability: copper!.relative_permeability,
    currentDistribution: copper!.current_distribution,
    lengthM: 1,
  })
  const copperDc = copper ? traceImpedance(0).re : 0
  if (copper && rlgc.R_ohm_per_m.some((row, i) => Math.abs(row[i]! - copperDc) > copperDc * 1e-9))
    throw new NetworkValidationError("invalid_coordinates", "Finite copper requires RLGC diagonal DC resistance to match the authored copper profile.", { copper_dc_ohm_per_m: copperDc })
  return (frequencyHz) => {
    if (!Number.isFinite(frequencyHz) || frequencyHz < 0)
      throw new NetworkValidationError("invalid_coordinates", "Frequency must be finite and nonnegative in Hz.")
    const impedance = copper ? traceImpedance(frequencyHz) : { re: 0, im: 0 }
    const correction = copper ? c(impedance.re - copperDc, impedance.im) : c(0)
    const even = modalScattering(resistance[0], inductance[0], conductance[0], capacitance[0], length, frequencyHz, correction)
    const odd = modalScattering(resistance[1], inductance[1], conductance[1], capacitance[1], length, frequencyHz, correction)
    const normalized = Array.from({ length: 4 }, (_, p) => Array.from({ length: 4 }, (_, q) => {
      const sameLine = Math.floor(p / 2) === Math.floor(q / 2)
      return scale(plus(even[p % 2]![q % 2]!, scale(odd[p % 2]![q % 2]!, sameLine ? 1 : -1)), 0.5)
    }))
    if (impedances.every((z) => z === 50)) return normalized
    // Internal 50-ohm normalization is only a change of basis, never a load.
    const root = Math.sqrt(50)
    const voltages = normalized.map((row, p) => row.map((s, q) => scale(plus(c(p === q ? 1 : 0), s), root)))
    const currents = normalized.map((row, p) => row.map((s, q) => scale(minus(c(p === q ? 1 : 0), s), 1 / root)))
    return portBasisToScattering(voltages, currents, impedances)
  }
}

export function coupledLineScatteringAtFrequency(
  rlgc: CoupledRlgc,
  options: CoupledNetworkCoordinates & { frequency_hz: number },
): ComplexMatrix {
  return createCoupledLineScatteringEvaluator(rlgc, options)(options.frequency_hz)
}

/** Qualified full ordered four-port S samples, including true DC when requested. */
export function createCoupledLineNetwork(
  rlgc: CoupledRlgc,
  options: CoupledNetworkOptions,
  qualification: NetworkQualificationOptions = {},
): QualifiedPassiveNetwork {
  const evaluate = createCoupledLineScatteringEvaluator(rlgc, options)
  return importPassiveNetwork({
    ports: options.ports,
    frequencies_hz: options.frequencies_hz,
    phasor_convention: "exp_positive_j_omega_t", current_sign_convention: "into_pcb",
    dc: options.frequencies_hz[0] === 0 ? { kind: "included" } : { kind: "unavailable", reason: "The requested frequency grid omits the RLGC DC response." },
    representation: "s", matrix_units: "dimensionless",
    matrices: options.frequencies_hz.map(evaluate),
  }, qualification)
}
