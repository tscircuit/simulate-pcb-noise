/** Browser-compatible qualification of a bare, linear passive port network. */
export interface Complex {
  real: number
  imag: number
}

export type ComplexMatrix = Complex[][]
export type NetworkRepresentation = "s" | "y" | "z"
export interface NetworkPort {
  port_name: string
  reference_impedance_ohms: number
  [metadata: string]: unknown
}
export type NetworkDcPolicy =
  | { kind: "included" }
  | { kind: "unavailable"; reason: string }

export interface NetworkCoordinates {
  ports: NetworkPort[]
  frequencies_hz: number[]
  phasor_convention: "exp_positive_j_omega_t"
  current_sign_convention: "into_pcb"
  dc: NetworkDcPolicy
}

/** Rows are observed ports; columns are incident/driven ports, in ports order. */
export interface PassiveNetworkInput extends NetworkCoordinates {
  representation: NetworkRepresentation
  matrix_units: "dimensionless" | "S" | "ohm"
  matrices: ComplexMatrix[]
}

export interface PortBasisNetworkInput extends NetworkCoordinates {
  voltage_matrices_v: ComplexMatrix[]
  current_matrices_a: ComplexMatrix[]
}

/** Palace termination current is V/Z0, not the signed net current into copper. */
export interface PalacePortBasisNetworkInput extends NetworkCoordinates {
  voltage_matrices_v: ComplexMatrix[]
  termination_current_matrices_a: ComplexMatrix[]
  incident_current_matrices_a: ComplexMatrix[]
}

export interface NetworkQualificationOptions {
  /** Lossless numerical responses may exceed unity by this absolute margin. */
  passivity_tolerance?: number
  reciprocity_tolerance?: number
  require_reciprocal?: boolean
  maximum_condition_number?: number
}

export interface QualifiedPassiveNetwork extends NetworkCoordinates {
  representation: "s"
  matrix_units: "dimensionless"
  matrices: ComplexMatrix[]
  normalization: "power_waves_real_positive_z0"
  band_hz: { minimum: number; maximum: number }
  qualification: {
    maximum_singular_value: number
    maximum_reciprocity_error: number
    passivity_tolerance: number
    reciprocity_tolerance: number
    require_reciprocal: boolean
  }
}

export type NetworkDiagnosticCode =
  | "invalid_coordinates"
  | "invalid_units"
  | "invalid_matrix"
  | "singular_matrix"
  | "ill_conditioned_matrix"
  | "nonpassive_network"
  | "nonreciprocal_network"
  | "out_of_band"
  | "missing_dc"
  | "frequency_not_sampled"

export class NetworkValidationError extends Error {
  constructor(
    readonly code: NetworkDiagnosticCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "NetworkValidationError"
  }
}

const c = (real: number, imag = 0): Complex => ({ real, imag })
const add = (a: Complex, b: Complex) => c(a.real + b.real, a.imag + b.imag)
const sub = (a: Complex, b: Complex) => c(a.real - b.real, a.imag - b.imag)
const mul = (a: Complex, b: Complex) =>
  c(a.real * b.real - a.imag * b.imag, a.real * b.imag + a.imag * b.real)
const scale = (a: Complex, k: number) => c(a.real * k, a.imag * k)
const magnitude = (a: Complex) => Math.hypot(a.real, a.imag)
const conj = (a: Complex) => c(a.real, -a.imag)
const finite = (a: Complex) =>
  a != null && Number.isFinite(a.real) && Number.isFinite(a.imag)

function fail(
  code: NetworkDiagnosticCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new NetworkValidationError(code, message, details)
}

function identity(n: number): ComplexMatrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => c(i === j ? 1 : 0)),
  )
}

function matrixAdd(a: ComplexMatrix, b: ComplexMatrix, sign = 1): ComplexMatrix {
  return a.map((row, i) => row.map((v, j) => add(v, scale(b[i]![j]!, sign))))
}

function matrixMultiply(a: ComplexMatrix, b: ComplexMatrix): ComplexMatrix {
  return a.map((row) =>
    b[0]!.map((_, j) =>
      row.reduce((sum, v, k) => add(sum, mul(v, b[k]![j]!)), c(0)),
    ),
  )
}

function infinityNorm(a: ComplexMatrix): number {
  return Math.max(...a.map((row) => row.reduce((sum, v) => sum + magnitude(v), 0)))
}

/** Scaled pivoting plus an explicit norm condition check; never regularizes. */
function inverse(a: ComplexMatrix, maximumCondition: number, referenceNorm = infinityNorm(a)): ComplexMatrix {
  const norm = infinityNorm(a)
  if (!(norm > Number.EPSILON * a.length * referenceNorm) || !Number.isFinite(norm))
    fail("singular_matrix", "The port-basis or conversion matrix is singular.")
  const n = a.length
  const left = a.map((row) => row.map((v) => scale(v, 1 / norm)))
  const right = identity(n)
  for (let k = 0; k < n; k++) {
    let pivot = k
    for (let i = k + 1; i < n; i++)
      if (magnitude(left[i]![k]!) > magnitude(left[pivot]![k]!)) pivot = i
    const p = left[pivot]![k]!
    const pMagnitude = magnitude(p)
    if (!(pMagnitude > Number.EPSILON * n))
      fail("singular_matrix", "The port-basis or conversion matrix has a zero pivot.", { pivot: k })
    ;[left[k], left[pivot]] = [left[pivot]!, left[k]!]
    ;[right[k], right[pivot]] = [right[pivot]!, right[k]!]
    // Conjugate/magnitude division avoids squaring a large or tiny raw pivot.
    const reciprocal = scale(conj(scale(p, 1 / pMagnitude)), 1 / pMagnitude)
    for (let j = 0; j < n; j++) {
      left[k]![j] = mul(left[k]![j]!, reciprocal)
      right[k]![j] = mul(right[k]![j]!, reciprocal)
    }
    for (let i = 0; i < n; i++) {
      if (i === k) continue
      const factor = left[i]![k]!
      for (let j = 0; j < n; j++) {
        left[i]![j] = sub(left[i]![j]!, mul(factor, left[k]![j]!))
        right[i]![j] = sub(right[i]![j]!, mul(factor, right[k]![j]!))
      }
    }
  }
  const result = right.map((row) => row.map((v) => scale(v, 1 / norm)))
  const condition = norm * infinityNorm(result)
  if (!Number.isFinite(condition) || condition > maximumCondition)
    fail("ill_conditioned_matrix", "The port-basis or conversion matrix is ill-conditioned.", {
      condition_number: condition,
      maximum_condition_number: maximumCondition,
    })
  return result
}

function validateCoordinates(input: NetworkCoordinates): void {
  if (!Array.isArray(input.ports) || input.ports.length < 1 || input.ports.length > 32)
    fail("invalid_coordinates", "A network must contain between 1 and 32 explicitly ordered ports.")
  const names = new Set<string>()
  for (const port of input.ports) {
    if (!port || typeof port.port_name !== "string" || !port.port_name.trim() || names.has(port.port_name))
      fail("invalid_coordinates", "Network port names must be nonempty and unique.")
    if (!Number.isFinite(port.reference_impedance_ohms) || port.reference_impedance_ohms <= 0)
      fail("invalid_coordinates", "Each port requires a finite, real, positive reference impedance.")
    names.add(port.port_name)
  }
  if (input.phasor_convention !== "exp_positive_j_omega_t" || input.current_sign_convention !== "into_pcb")
    fail("invalid_units", "Use exp(+j omega t) phasors and current directed into the PCB at every port.")
  if (!Array.isArray(input.frequencies_hz) || input.frequencies_hz.length < 1)
    fail("invalid_coordinates", "Explicit frequency samples in Hz are required.")
  for (let i = 0; i < input.frequencies_hz.length; i++) {
    const f = input.frequencies_hz[i]!
    if (!Number.isFinite(f) || f < 0 || (i > 0 && f <= input.frequencies_hz[i - 1]!))
      fail("invalid_coordinates", "Frequency samples must be finite, nonnegative, and strictly increasing in Hz.")
  }
  if (input.dc?.kind === "included") {
    if (input.frequencies_hz[0] !== 0)
      fail("invalid_coordinates", "An included DC policy requires an actual 0 Hz sample.")
  } else if (input.dc?.kind === "unavailable") {
    if (typeof input.dc.reason !== "string" || !input.dc.reason.trim() || input.frequencies_hz[0] === 0)
      fail("invalid_coordinates", "Unavailable DC requires a reason and excludes a 0 Hz sample.")
  } else fail("invalid_coordinates", "Declare whether DC is included or unavailable.")
}

function validateMatrices(matrices: ComplexMatrix[], input: NetworkCoordinates, label: string): void {
  const n = input.ports.length
  if (!Array.isArray(matrices) || matrices.length !== input.frequencies_hz.length)
    fail("invalid_matrix", `${label} must contain one complete matrix per frequency.`)
  for (let sample = 0; sample < matrices.length; sample++) {
    const matrix = matrices[sample]!
    if (!Array.isArray(matrix) || matrix.length !== n || matrix.some((row) =>
      !Array.isArray(row) || row.length !== n || row.some((v) => !finite(v))))
      fail("invalid_matrix", `${label} must contain finite, square, full ordered complex matrices.`, {
        sample, frequency_hz: input.frequencies_hz[sample],
      })
  }
}

function optionsWithDefaults(options: NetworkQualificationOptions) {
  const resolved = {
    passivity_tolerance: options.passivity_tolerance ?? 1e-3,
    reciprocity_tolerance: options.reciprocity_tolerance ?? 1e-3,
    require_reciprocal: options.require_reciprocal ?? true,
    maximum_condition_number: options.maximum_condition_number ?? 1e12,
  }
  if (![resolved.passivity_tolerance, resolved.reciprocity_tolerance].every((v) => Number.isFinite(v) && v >= 0)
    || !Number.isFinite(resolved.maximum_condition_number) || resolved.maximum_condition_number < 1
    || typeof resolved.require_reciprocal !== "boolean")
    fail("invalid_coordinates", "Qualification tolerances and condition limits must be finite and nonnegative.")
  return resolved
}

/** Largest eigenvalue of a real symmetric matrix, using Jacobi rotations. */
function largestEigenvalue(a: number[][]): number {
  const n = a.length
  const tolerance = 1e-14 * Math.max(1, ...a.map((row, i) => Math.abs(row[i]!)))
  for (let iteration = 0; iteration < 40 * n * n; iteration++) {
    let p = 0, q = 1, off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++)
      if (Math.abs(a[i]![j]!) > off) { p = i; q = j; off = Math.abs(a[i]![j]!) }
    if (off <= tolerance) return Math.max(...a.map((row, i) => row[i]!))
    const theta = 0.5 * Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!)
    const cs = Math.cos(theta), sn = Math.sin(theta)
    const app = a[p]![p]!, aqq = a[q]![q]!, apq = a[p]![q]!
    a[p]![p] = cs * cs * app - 2 * sn * cs * apq + sn * sn * aqq
    a[q]![q] = sn * sn * app + 2 * sn * cs * apq + cs * cs * aqq
    a[p]![q] = a[q]![p] = 0
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue
      const akp = a[k]![p]!, akq = a[k]![q]!
      a[k]![p] = a[p]![k] = cs * akp - sn * akq
      a[k]![q] = a[q]![k] = sn * akp + cs * akq
    }
  }
  fail("invalid_matrix", "Passivity eigenvalue qualification failed to converge.")
}

function maximumSingularValue(s: ComplexMatrix): number {
  const n = s.length
  const h = s[0]!.map((_, i) => s[0]!.map((_, j) =>
    s.reduce((sum, row) => add(sum, mul(conj(row[i]!), row[j]!)), c(0))))
  // Hermitian H has the same eigenvalues as [Re H, -Im H; Im H, Re H].
  const realBlock = Array.from({ length: 2 * n }, (_, i) =>
    Array.from({ length: 2 * n }, (_, j) => {
      const v = h[i % n]![j % n]!
      return (i < n) === (j < n) ? v.real : (i < n ? -v.imag : v.imag)
    }))
  return Math.sqrt(Math.max(0, largestEigenvalue(realBlock)))
}

function qualify(
  input: NetworkCoordinates,
  matrices: ComplexMatrix[],
  options: ReturnType<typeof optionsWithDefaults>,
): QualifiedPassiveNetwork {
  validateMatrices(matrices, input, "Scattering response")
  let maximumSingular = 0, maximumReciprocity = 0
  for (let sample = 0; sample < matrices.length; sample++) {
    const s = matrices[sample]!
    const singular = maximumSingularValue(s)
    let reciprocity = 0
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++)
      reciprocity = Math.max(reciprocity, magnitude(sub(s[i]![j]!, s[j]![i]!)))
    const details = { sample, frequency_hz: input.frequencies_hz[sample] }
    if (!Number.isFinite(singular) || singular > 1 + options.passivity_tolerance)
      fail("nonpassive_network", "The network exceeds the passive scattering singular-value limit.", {
        ...details, maximum_singular_value: singular,
      })
    if (options.require_reciprocal && reciprocity > options.reciprocity_tolerance)
      fail("nonreciprocal_network", "The network exceeds the reciprocal scattering transpose-error limit.", {
        ...details, reciprocity_error: reciprocity,
      })
    maximumSingular = Math.max(maximumSingular, singular)
    maximumReciprocity = Math.max(maximumReciprocity, reciprocity)
  }
  return {
    ports: input.ports.map((p) => ({ ...p })),
    frequencies_hz: [...input.frequencies_hz],
    phasor_convention: input.phasor_convention,
    current_sign_convention: input.current_sign_convention,
    dc: { ...input.dc },
    representation: "s", matrix_units: "dimensionless", matrices,
    normalization: "power_waves_real_positive_z0",
    band_hz: { minimum: input.frequencies_hz[0]!, maximum: input.frequencies_hz.at(-1)! },
    qualification: {
      maximum_singular_value: maximumSingular,
      maximum_reciprocity_error: maximumReciprocity,
      passivity_tolerance: options.passivity_tolerance,
      reciprocity_tolerance: options.reciprocity_tolerance,
      require_reciprocal: options.require_reciprocal,
    },
  }
}

/** Imports S/Y/Z into power-wave S without adding any source/load termination. */
export function importPassiveNetwork(
  input: PassiveNetworkInput,
  options: NetworkQualificationOptions = {},
): QualifiedPassiveNetwork {
  validateCoordinates(input)
  const resolved = optionsWithDefaults(options)
  const units = { s: "dimensionless", y: "S", z: "ohm" } as const
  if (!(input.representation in units) || input.matrix_units !== units[input.representation])
    fail("invalid_units", "S, Y, and Z require dimensionless, S, and ohm matrix units respectively.")
  validateMatrices(input.matrices, input, "Network response")
  const roots = input.ports.map((p) => Math.sqrt(p.reference_impedance_ohms))
  const one = identity(input.ports.length)
  const matrices = input.matrices.map((matrix) => {
    if (input.representation === "s") return matrix.map((row) => row.map((v) => ({ ...v })))
    const normalized = matrix.map((row, i) => row.map((v, j) =>
      scale(v, input.representation === "z" ? 1 / (roots[i]! * roots[j]!) : roots[i]! * roots[j]!)))
    const numerator = input.representation === "z"
      ? matrixAdd(normalized, one, -1) : matrixAdd(one, normalized, -1)
    return matrixMultiply(numerator, inverse(matrixAdd(normalized, one), resolved.maximum_condition_number, Math.max(1, infinityNorm(normalized))))
  })
  return qualify(input, matrices, resolved)
}

/** Full raw V/I basis supports ideal through lines even when Y or Z is singular. */
export function importPortBasisNetwork(
  input: PortBasisNetworkInput,
  options: NetworkQualificationOptions = {},
): QualifiedPassiveNetwork {
  validateCoordinates(input)
  const resolved = optionsWithDefaults(options)
  validateMatrices(input.voltage_matrices_v, input, "Voltage basis")
  validateMatrices(input.current_matrices_a, input, "Inward current basis")
  const matrices = input.voltage_matrices_v.map((v, sample) => portBasisToScattering(
    v, input.current_matrices_a[sample]!, input.ports.map((p) => p.reference_impedance_ohms), resolved.maximum_condition_number,
  ))
  return qualify(input, matrices, resolved)
}

/** Pure V/I-to-S conversion. Qualification of imported responses is separate. */
export function portBasisToScattering(
  voltageMatrixV: ComplexMatrix,
  inwardCurrentMatrixA: ComplexMatrix,
  referenceImpedancesOhms: number[],
  maximumConditionNumber = 1e12,
): ComplexMatrix {
  const coordinates: NetworkCoordinates = {
    ports: referenceImpedancesOhms.map((z, i) => ({ port_name: `p${i}`, reference_impedance_ohms: z })),
    frequencies_hz: [0], dc: { kind: "included" },
    phasor_convention: "exp_positive_j_omega_t", current_sign_convention: "into_pcb",
  }
  validateCoordinates(coordinates)
  validateMatrices([voltageMatrixV], coordinates, "Voltage basis")
  validateMatrices([inwardCurrentMatrixA], coordinates, "Inward current basis")
  const resolved = optionsWithDefaults({ maximum_condition_number: maximumConditionNumber })
  const roots = referenceImpedancesOhms.map(Math.sqrt)
  const voltages = voltageMatrixV.map((row, p) => row.map((value) => scale(value, 1 / roots[p]!)))
  const currents = inwardCurrentMatrixA.map((row, p) => row.map((value) => scale(value, roots[p]!)))
  const incident = matrixAdd(voltages, currents).map((row) => row.map((value) => scale(value, 0.5)))
  const reflected = matrixAdd(voltages, currents, -1).map((row) => row.map((value) => scale(value, 0.5)))
  const scattering = matrixMultiply(reflected, inverse(incident, resolved.maximum_condition_number))
  validateMatrices([scattering], coordinates, "Scattering response")
  return scattering
}

/** Converts Palace's outward termination current exactly once, on every port. */
export function importPalacePortBasisNetwork(
  input: PalacePortBasisNetworkInput,
  options: NetworkQualificationOptions = {},
): QualifiedPassiveNetwork {
  validateCoordinates(input)
  validateMatrices(input.termination_current_matrices_a, input, "Palace termination current basis")
  validateMatrices(input.incident_current_matrices_a, input, "Palace incident current basis")
  const currentMatrices = input.termination_current_matrices_a.map((termination, sample) =>
    input.incident_current_matrices_a[sample]!.map((row, port) => row.map((incident, drive) => {
      if ((port !== drive && magnitude(incident) !== 0) || (port === drive && magnitude(incident) === 0))
        fail("invalid_matrix", "Each Palace basis column must excite its ordered driven port only.")
      return sub(scale(incident, 2), termination[port]![drive]!)
    })))
  return importPortBasisNetwork({ ...input, current_matrices_a: currentMatrices }, options)
}

/** Exact samples only: DC and out-of-band behavior cannot be silently invented. */
export function getNetworkFrequencySample(
  network: QualifiedPassiveNetwork,
  frequencyHz: number,
): ComplexMatrix {
  if (!Number.isFinite(frequencyHz) || frequencyHz < 0)
    fail("invalid_coordinates", "Requested frequency must be finite and nonnegative in Hz.")
  if (frequencyHz === 0 && network.dc.kind !== "included")
    fail("missing_dc", "This extraction has no qualified DC sample.", { reason: network.dc.reason })
  if (frequencyHz < network.band_hz.minimum || frequencyHz > network.band_hz.maximum)
    fail("out_of_band", "The requested frequency is outside the qualified extraction band.", { frequency_hz: frequencyHz })
  const index = network.frequencies_hz.indexOf(frequencyHz)
  if (index < 0)
    fail("frequency_not_sampled", "Interpolation requires a separately qualified broadband realization.", { frequency_hz: frequencyHz })
  return network.matrices[index]!.map((row) => row.map((value) => ({ ...value })))
}
