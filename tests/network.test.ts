import { describe, expect, test } from "bun:test"
import {
  getNetworkFrequencySample,
  importPalacePortBasisNetwork,
  importPassiveNetwork,
  importPortBasisNetwork,
  NetworkValidationError,
  type Complex,
  type ComplexMatrix,
  type NetworkCoordinates,
  type NetworkDiagnosticCode,
  type PassiveNetworkInput,
} from "../lib/network"

const c = (real: number, imag = 0): Complex => ({ real, imag })
// Independent scalar arithmetic for analytic references (no importer helpers).
const sum = (a: Complex, b: Complex) => c(a.real + b.real, a.imag + b.imag)
const times = (a: Complex, b: Complex) => c(
  a.real * b.real - a.imag * b.imag, a.real * b.imag + a.imag * b.real,
)
const divide = (a: Complex, b: Complex) => {
  const d = b.real * b.real + b.imag * b.imag
  return c((a.real * b.real + a.imag * b.imag) / d, (a.imag * b.real - a.real * b.imag) / d)
}
const multiplyReal = (a: Complex, b: number) => c(a.real * b, a.imag * b)

function coordinates(z0 = [50], frequencies = [0]): NetworkCoordinates {
  return {
    ports: z0.map((reference_impedance_ohms, i) => ({ port_name: `p${i}`, reference_impedance_ohms })),
    frequencies_hz: frequencies,
    phasor_convention: "exp_positive_j_omega_t",
    current_sign_convention: "into_pcb",
    dc: frequencies[0] === 0 ? { kind: "included" } : { kind: "unavailable", reason: "Native AC extraction starts above DC." },
  }
}

function sInput(matrix: ComplexMatrix, z0 = matrix.map(() => 50)): PassiveNetworkInput {
  return { ...coordinates(z0), representation: "s", matrix_units: "dimensionless", matrices: [matrix] }
}

function expectComplex(actual: Complex, expected: Complex, digits = 11) {
  expect(actual.real).toBeCloseTo(expected.real, digits)
  expect(actual.imag).toBeCloseTo(expected.imag, digits)
}

function expectCode(run: () => unknown, code: NetworkDiagnosticCode) {
  try {
    run()
    throw new Error(`Expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(NetworkValidationError)
    expect((error as NetworkValidationError).code).toBe(code)
  }
}

describe("passive complex network importer", () => {
  test("resistor S, Z, and Y agree with the analytic reflection including DC", () => {
    for (const resistance of [0, 25, 50, 100, 1e6]) {
      const reflection = (resistance - 50) / (resistance + 50)
      const z = importPassiveNetwork({ ...coordinates(), representation: "z", matrix_units: "ohm", matrices: [[[c(resistance)]]] })
      expectComplex(z.matrices[0]![0]![0]!, c(reflection))
      const s = importPassiveNetwork(sInput([[c(reflection)]]))
      expectComplex(s.matrices[0]![0]![0]!, c(reflection))
      if (resistance > 0) {
        const y = importPassiveNetwork({ ...coordinates(), representation: "y", matrix_units: "S", matrices: [[[c(1 / resistance)]]] })
        expectComplex(y.matrices[0]![0]![0]!, c(reflection))
      }
    }
    const open = importPassiveNetwork({ ...coordinates(), representation: "y", matrix_units: "S", matrices: [[[c(0)]]] })
    expectComplex(open.matrices[0]![0]![0]!, c(1))
  })

  test("positive-frequency RLC network uses the declared +j omega t sign", () => {
    // Series R/L branch in parallel with C: finite physical DC and AC admittance.
    const frequencies = [0, 1e6, 25e6, 1e9]
    const matrices = frequencies.map((f) => {
      const w = 2 * Math.PI * f
      return [[sum(divide(c(1), c(100, w * 20e-9)), c(0, w * 0.5e-12))]]
    })
    const result = importPassiveNetwork({ ...coordinates([50], frequencies), representation: "y", matrix_units: "S", matrices })
    matrices.forEach((matrix, i) => {
      const normalizedY = multiplyReal(matrix[0]![0]!, 50)
      const reference = divide(sum(c(1), multiplyReal(normalizedY, -1)), sum(c(1), normalizedY))
      expectComplex(result.matrices[i]![0]![0]!, reference)
    })
    expect(result.qualification.maximum_singular_value).toBeLessThan(1)
    expect(result.matrices[1]![0]![0]!.imag).toBeGreaterThan(0)
  })

  test("full two-port coupled resistor Y has analytic S with unequal extraction Z0", () => {
    // Grounded resistors 100/200 ohm and a 75 ohm branch between ports.
    const y11 = 1 / 100 + 1 / 75, y22 = 1 / 200 + 1 / 75, y12 = -1 / 75
    const result = importPassiveNetwork({ ...coordinates([40, 90]), representation: "y", matrix_units: "S", matrices: [[[c(y11), c(y12)], [c(y12), c(y22)]]] })
    const a = 1 + 40 * y11, b = Math.sqrt(40 * 90) * y12, d = 1 + 90 * y22
    const determinant = a * d - b * b
    const expected = [[c(2 * d / determinant - 1), c(-2 * b / determinant)], [c(-2 * b / determinant), c(2 * a / determinant - 1)]]
    result.matrices[0]!.forEach((row, i) => row.forEach((v, j) => expectComplex(v, expected[i]![j]!)))
    expect(result.qualification.maximum_reciprocity_error).toBeLessThan(1e-12)
    // A different circuit source/load is outside this bare-network import API.
    expect(result.ports.map((p) => p.reference_impedance_ohms)).toEqual([40, 90])
  })

  test("full complex multiport preserves phase, port ordering and contact metadata", () => {
    const matrix = [[c(0.1, 0.1), c(0.2, -0.1), c(0.05)], [c(0.2, -0.1), c(-0.1, 0.05), c(0, 0.1)], [c(0.05), c(0, 0.1), c(0.2)]]
    const input = sInput(matrix, [40, 50, 90])
    input.ports[1]!.signal_contact = { pcb_port_id: "trace-far" }
    input.ports[1]!.reference_contact = { pcb_port_id: "ground-far" }
    const result = importPassiveNetwork(input)
    expect(result.matrices).toEqual([matrix])
    expect(result.ports[1]!.signal_contact).toEqual({ pcb_port_id: "trace-far" })
    input.matrices[0]![0]![0]!.real = 900
    expect(result.matrices[0]![0]![0]!.real).toBe(0.1)
  })

  test("raw all-port V/I recovers ideal through without singular Y/Z inversion", () => {
    const roots = [Math.sqrt(40), Math.sqrt(90)]
    // Unit incident power-wave at each driven port, reflected wave at opposite port.
    const voltages = [[c(roots[0]!), c(roots[0]!)], [c(roots[1]!), c(roots[1]!)]]
    const currents = [[c(1 / roots[0]!), c(-1 / roots[0]!)], [c(-1 / roots[1]!), c(1 / roots[1]!)]]
    const result = importPortBasisNetwork({ ...coordinates([40, 90]), voltage_matrices_v: [voltages], current_matrices_a: [currents] })
    expect(result.matrices[0]).toEqual([[c(0), c(1)], [c(1), c(0)]])
    expect(result.qualification.maximum_singular_value).toBeCloseTo(1, 12)
  })

  test("Palace driven and passive currents apply the incident subtraction exactly once", () => {
    // A matched lossless through network: V=1 V at each port for each excitation.
    // The passive port current into the PCB is -V/Z0, whereas driven is +V/Z0.
    const result = importPalacePortBasisNetwork({
      ...coordinates([50, 50]),
      voltage_matrices_v: [[[c(1), c(1)], [c(1), c(1)]]],
      termination_current_matrices_a: [[[c(0.02), c(0.02)], [c(0.02), c(0.02)]]],
      incident_current_matrices_a: [[[c(0.02), c(0)], [c(0), c(0.02)]]],
    })
    result.matrices[0]!.forEach((row, i) => row.forEach((v, j) => expectComplex(v, c(i === j ? 0 : 1))))
  })

  test("raw nonorthogonal complex excitation basis yields the same full S", () => {
    const s = [[c(0.15, 0.1), c(0.35, -0.05)], [c(0.35, -0.05), c(-0.1, 0.05)]]
    const a = [[c(1, 0.2), c(0.2)], [c(0, -0.1), c(0.9, 0.1)]]
    const b = s.map((row) => [0, 1].map((j) => sum(times(row[0]!, a[0]![j]!), times(row[1]!, a[1]![j]!))))
    const roots = [Math.sqrt(40), Math.sqrt(80)]
    const v = a.map((row, i) => row.map((value, j) => multiplyReal(sum(value, b[i]![j]!), roots[i]!)))
    const currents = a.map((row, i) => row.map((value, j) => multiplyReal(sum(value, multiplyReal(b[i]![j]!, -1)), 1 / roots[i]!)))
    const result = importPortBasisNetwork({ ...coordinates([40, 80]), voltage_matrices_v: [v], current_matrices_a: [currents] })
    result.matrices[0]!.forEach((row, i) => row.forEach((value, j) => expectComplex(value, s[i]![j]!)))
  })

  test("passivity checks the full singular value, not each entry or column", () => {
    // Every element and column norm is below 1, but the common mode has gain 1.2.
    expectCode(() => importPassiveNetwork(sInput([[c(0.5), c(0.7)], [c(0.7), c(0.5)]])), "nonpassive_network")
    // Complex symmetric response needs S^H S, not S^T S.
    expectCode(() => importPassiveNetwork(sInput([[c(0.7), c(0, 0.7)], [c(0, 0.7), c(-0.7)]])), "nonpassive_network")
    const passive = importPassiveNetwork(sInput([[c(0.5), c(0, 0.7)], [c(0, 0.7), c(0.5)]]))
    expect(passive.qualification.maximum_singular_value).toBeCloseTo(Math.hypot(0.5, 0.7), 12)
  })

  test("reciprocity uses transpose and nonreciprocal passive models require explicit opt-in", () => {
    const isolator = sInput([[c(0), c(0)], [c(0.5), c(0)]])
    expectCode(() => importPassiveNetwork(isolator), "nonreciprocal_network")
    const result = importPassiveNetwork(isolator, { require_reciprocal: false })
    expect(result.qualification.maximum_singular_value).toBeCloseTo(0.5, 12)
    expect(result.qualification.maximum_reciprocity_error).toBe(0.5)
  })

  test("singular and ill-conditioned excitation bases fail without regularization", () => {
    expectCode(() => importPortBasisNetwork({ ...coordinates([50, 50]), voltage_matrices_v: [[[c(1), c(1)], [c(1), c(1)]]], current_matrices_a: [[[c(0.02), c(0.02)], [c(0.02), c(0.02)]]] }), "singular_matrix")
    expectCode(() => importPortBasisNetwork({ ...coordinates([1, 1]), voltage_matrices_v: [[[c(1), c(0)], [c(0), c(1e-10)]]], current_matrices_a: [[[c(1), c(0)], [c(0), c(1e-10)]]] }, { maximum_condition_number: 1e8 }), "ill_conditioned_matrix")
    expectCode(() => importPassiveNetwork({ ...coordinates(), representation: "z", matrix_units: "ohm", matrices: [[[c(-50)]]] }), "singular_matrix")
  })

  test("finite matrices, explicit units, full port order and valid Z0 are mandatory", () => {
    expectCode(() => importPassiveNetwork(sInput([[c(Number.NaN)]])), "invalid_matrix")
    expectCode(() => importPassiveNetwork(sInput([[c(Infinity)]])), "invalid_matrix")
    expectCode(() => importPassiveNetwork({ ...sInput([[c(0)]]), matrix_units: "ohm" }), "invalid_units")
    expectCode(() => importPassiveNetwork({ ...sInput([[c(0)]]), current_sign_convention: "outward" as "into_pcb" }), "invalid_units")
    expectCode(() => importPassiveNetwork(sInput([[c(0)]], [0])), "invalid_coordinates")
    expectCode(() => importPassiveNetwork(sInput([[c(0)]], [Number.NaN])), "invalid_coordinates")
    expectCode(() => importPassiveNetwork({ ...sInput([[c(0), c(0)], [c(0), c(0)]]), ports: [coordinates().ports[0]!, coordinates().ports[0]!] }), "invalid_coordinates")
    expectCode(() => importPassiveNetwork({ ...sInput([[c(0), c(0)], [c(0), c(0)]]), matrices: [[[c(0), c(0)]]] }), "invalid_matrix")
    expectCode(() => importPassiveNetwork(sInput([[c(0)]]), { passivity_tolerance: Number.NaN }), "invalid_coordinates")
  })

  test("frequency band and DC are explicit; no extrapolation or invented samples", () => {
    const input = { ...coordinates([50], [1e6, 2e6]), representation: "s" as const, matrix_units: "dimensionless" as const, matrices: [[[c(0.2)]], [[c(0.3)]]] }
    const network = importPassiveNetwork(input)
    expectComplex(getNetworkFrequencySample(network, 1e6)[0]![0]!, c(0.2))
    expectCode(() => getNetworkFrequencySample(network, 0), "missing_dc")
    expectCode(() => getNetworkFrequencySample(network, 3e6), "out_of_band")
    expectCode(() => getNetworkFrequencySample(network, 1.5e6), "frequency_not_sampled")
    expectCode(() => importPassiveNetwork({ ...input, dc: { kind: "included" } }), "invalid_coordinates")
    expectCode(() => importPassiveNetwork({ ...input, frequencies_hz: [2e6, 1e6] }), "invalid_coordinates")
    expectCode(() => importPassiveNetwork({ ...input, frequencies_hz: [1e6, 1e6] }), "invalid_coordinates")
  })
})
