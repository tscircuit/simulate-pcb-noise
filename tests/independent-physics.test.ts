import { afterAll, describe, expect, test as bunTest } from "bun:test"
import { createHash } from "node:crypto"
import fixture from "../fixtures/physics-reference.json"
import {
  simulateCoupledLines,
  type CoupledRlgc,
  type CoupledTransient,
  type LineTestbench,
} from "../lib/coupled-line"
import { importPassiveNetwork, type ComplexMatrix } from "../lib/network"
import { createCoupledLineNetwork } from "../lib/coupled-network"
import { simulateCoupledChannel } from "../lib/channel"

type Pair = [number, number]
type Waveform = Pair[]
type Excitation = Waveform | ((time: number) => number)

// High refinement checks share CPU with extraction/integration suites in CI.
const passedTests: string[] = []
const measurements: Record<string, unknown> = {}
const receiptPath = process.env.PHYSICS_REFERENCE_RECEIPT_PATH
const receiptGroup = process.env.PHYSICS_REFERENCE_RECEIPT_GROUP ?? "all"
const hashPaths = [
  "tests/independent-physics.test.ts", "fixtures/physics-reference.json",
  "lib/coupled-line.ts", "lib/coupled-network.ts", "lib/network.ts", "lib/channel.ts",
]
const inputHashes = receiptPath ? Object.fromEntries(await Promise.all(hashPaths.map(async (path) => [
  path, createHash("sha256").update(await Bun.file(new URL(`../${path}`, import.meta.url)).text()).digest("hex"),
]))) : undefined
const startedAt = new Date().toISOString()
const test = (name: string, body: () => void) => bunTest(name, () => {
  body()
  passedTests.push(name)
}, 60_000)
afterAll(async () => {
  if (receiptPath && passedTests.length === (receiptGroup === "fft" ? 2 : 11)) {
    const record = {
      status: "passed", started_at: startedAt, completed_at: new Date().toISOString(),
      command: receiptGroup === "fft"
        ? "PHYSICS_REFERENCE_RECEIPT_PATH=../../physics-reference-receipt.json PHYSICS_REFERENCE_RECEIPT_GROUP=fft bun test tests/independent-physics.test.ts --test-name-pattern 'FFT closure'"
        : "PHYSICS_REFERENCE_RECEIPT_PATH=../../physics-reference-receipt.json bun test tests/independent-physics.test.ts",
      reference_method: "Independent lossless even/odd traveling-wave reflection series and scalar ABCD scattering; no production derivation helpers imported.",
      scope: fixture.scope, input_sha256: inputHashes, passed_tests: passedTests,
      acceptance: { signal_swing_fraction: 0.01, crossing_ui_fraction: 0.01,
        weak_coupling_fraction: 0.02, weak_coupling_absolute_floor_v: 1e-5,
        zero_mutual_maximum_v: 1e-6 },
      measurements,
    }
    const receipt = receiptGroup === "fft"
      ? { ...await Bun.file(receiptPath).json(), fft_closure_verification: record }
      : record
    await Bun.write(receiptPath, JSON.stringify(receipt, null, 2) + "\n")
  }
})

// The production provider integrates distributed voltage/current nodes. This
// reference instead diagonalizes the lossless PDE and sums exact delayed waves.
// Equal terminations let even/odd modes close independently; no solver helper is
// imported here. The voltage modes are Va+Vv and Va-Vv, hence the factor 1/2.
function interpolate(waveform: Excitation, time: number): number {
  if (typeof waveform === "function") return waveform(time)
  if (time <= waveform[0]![0]) return waveform[0]![1]
  for (let i = 1; i < waveform.length; i++) {
    const [end, value] = waveform[i]!
    if (time <= end) {
      const [start, previous] = waveform[i - 1]!
      return previous + ((time - start) / (end - start)) * (value - previous)
    }
  }
  return waveform[waveform.length - 1]![1]
}

function modeResponse(
  source: Excitation,
  time: number,
  impedance: number,
  delay: number,
  sourceR: number,
  loadR: number,
): Pair {
  const launch = impedance / (sourceR + impedance)
  const sourceReflection = (sourceR - impedance) / (sourceR + impedance)
  const loadReflection = (loadR - impedance) / (loadR + impedance)
  const roundTrip = sourceReflection * loadReflection
  let near = launch * interpolate(source, time)
  let far = 0
  // A term is zero before its causal arrival. Enumerating all arrivals inside
  // the record is exact; this has no arbitrary tail cutoff or mesh parameter.
  for (let order = 0; (2 * order + 1) * delay <= time; order++) {
    far +=
      launch *
      (1 + loadReflection) *
      roundTrip ** order *
      interpolate(source, time - (2 * order + 1) * delay)
  }
  for (let order = 0; 2 * (order + 1) * delay <= time; order++) {
    near +=
      launch *
      (1 + sourceReflection) *
      loadReflection *
      roundTrip ** order *
      interpolate(source, time - 2 * (order + 1) * delay)
  }
  return [near, far]
}

function symmetricReference(
  time: number,
  source: Excitation,
  loadR: number,
  mutualL = fixture.mutual_inductance_h_per_m,
  mutualC = fixture.mutual_capacitance_f_per_m,
): { near: Pair; far: Pair } {
  const modes = [1, -1].map((sign) => {
    const L = fixture.self_inductance_h_per_m + sign * mutualL
    const C = fixture.self_capacitance_f_per_m + sign * mutualC
    return modeResponse(
      source,
      time,
      Math.sqrt(L / C),
      fixture.length_m * Math.sqrt(L * C),
      fixture.source_resistance_ohms,
      loadR,
    )
  })
  const [even, odd] = modes as [Pair, Pair]
  return {
    near: [(even[0] + odd[0]) / 2, (even[0] - odd[0]) / 2],
    far: [(even[1] + odd[1]) / 2, (even[1] - odd[1]) / 2],
  }
}

function rlgc(mutual = true): CoupledRlgc {
  const L = fixture.self_inductance_h_per_m
  const C = fixture.self_capacitance_f_per_m
  const M = mutual ? fixture.mutual_inductance_h_per_m : 0
  const Cm = mutual ? fixture.mutual_capacitance_f_per_m : 0
  return {
    R_ohm_per_m: [[0, 0], [0, 0]],
    L_h_per_m: [[L, M], [M, L]],
    C_f_per_m: [[C, Cm], [Cm, C]],
    G_s_per_m: [[0, 0], [0, 0]],
  }
}

const source = fixture.source_waveform as Waveform
const quiet: Waveform = [[0, 0], [6e-9, 0]]
const shiftedVictim: Waveform = [[0, 0], [7e-10, 0], [1.1e-9, 1], [3e-9, 1], [3.4e-9, 0], [6e-9, 0]]
const cosineRamp = (time: number) => {
  if (time <= 1e-10) return 0
  if (time < 5e-10) return 0.5 - 0.5 * Math.cos(Math.PI * (time - 1e-10) / 4e-10)
  if (time <= 2e-9) return 1
  if (time < 2.4e-9) return 0.5 + 0.5 * Math.cos(Math.PI * (time - 2e-9) / 4e-10)
  return 0
}

function testbench(waveform: Excitation, loadR: number): LineTestbench {
  return {
    source_resistance_ohms: fixture.source_resistance_ohms,
    load_resistance_ohms: loadR,
    ...(typeof waveform === "function"
      ? { source_voltage: waveform, minimum_transition_s: 4e-10 }
      : { waveform }),
  }
}

const fixtureRuns = new Map<string, CoupledTransient>()
function run(segments: number, loadR = 50, mutual = true, aggressor: Excitation = source, victim: Excitation = quiet) {
  const key = aggressor === source && victim === quiet ? `${segments}/${loadR}/${mutual}` : undefined
  if (key && fixtureRuns.has(key)) return fixtureRuns.get(key)!
  const result = simulateCoupledLines(
    rlgc(mutual),
    [testbench(aggressor, loadR), testbench(victim, loadR)],
    {
      length_m: fixture.length_m,
      duration_s: 6e-9,
      sample_interval_s: 5e-12,
      segments,
    },
  )
  if (key) fixtureRuns.set(key, result)
  return result
}

function maximumDifference(a: number[], b: number[]): number {
  expect(a.length).toBe(b.length)
  return Math.max(...a.map((value, i) => Math.abs(value - b[i]!)))
}

function referenceArrays(time: number[], loadR: number, mutual = true, excitation: Excitation = source) {
  const samples = time.map((t) => symmetricReference(t, excitation, loadR,
    mutual ? fixture.mutual_inductance_h_per_m : 0,
    mutual ? fixture.mutual_capacitance_f_per_m : 0))
  return {
    near: [samples.map((x) => x.near[0]), samples.map((x) => x.near[1])],
    far: [samples.map((x) => x.far[0]), samples.map((x) => x.far[1])],
  }
}

function firstCrossing(time: number[], voltage: number[], threshold: number): number {
  for (let i = 1; i < voltage.length; i++) {
    if (voltage[i - 1]! < threshold && voltage[i]! >= threshold) {
      return time[i - 1]! +
        (time[i]! - time[i - 1]!) *
        (threshold - voltage[i - 1]!) / (voltage[i]! - voltage[i - 1]!)
    }
  }
  throw new Error("Expected waveform crossing was absent")
}

// A=D=cos(theta), B=j Z sin(theta), C=j sin(theta)/Z. Conversion
// from ABCD to power-wave S below is written directly for each scalar mode;
// the physical four-port is their orthonormal even/odd change of basis.
function modalScattering(frequency: number, referenceZ: number): ComplexMatrix {
  const modes = [1, -1].map((sign) => {
    const L = fixture.self_inductance_h_per_m + sign * fixture.mutual_inductance_h_per_m
    const C = fixture.self_capacitance_f_per_m + sign * fixture.mutual_capacitance_f_per_m
    const impedance = Math.sqrt(L / C)
    const theta = 2 * Math.PI * frequency * fixture.length_m * Math.sqrt(L * C)
    const denominatorReal = 2 * Math.cos(theta)
    const denominatorImag = Math.sin(theta) * (impedance / referenceZ + referenceZ / impedance)
    const norm = denominatorReal ** 2 + denominatorImag ** 2
    const reflectionNumerator = Math.sin(theta) * (impedance / referenceZ - referenceZ / impedance)
    return {
      reflection: {
        real: reflectionNumerator * denominatorImag / norm,
        imag: reflectionNumerator * denominatorReal / norm,
      },
      transmission: {
        real: 2 * denominatorReal / norm,
        imag: -2 * denominatorImag / norm,
      },
    }
  })
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => {
    const kind = row % 2 === column % 2 ? "reflection" : "transmission"
    const parity = (row < 2 ? 1 : -1) * (column < 2 ? 1 : -1)
    return {
      real: (modes[0]![kind].real + parity * modes[1]![kind].real) / 2,
      imag: (modes[0]![kind].imag + parity * modes[1]![kind].imag) / 2,
    }
  }))
}

describe("independent lossless coupled-line physics", () => {
  test("reference modal values and delayed-wave DC limit are internally consistent", () => {
    const L = fixture.self_inductance_h_per_m
    const C = fixture.self_capacitance_f_per_m
    const M = fixture.mutual_inductance_h_per_m
    const Cm = fixture.mutual_capacitance_f_per_m
    expect(Math.sqrt((L + M) / (C + Cm))).toBeCloseTo(fixture.modal_reference.even_impedance_ohms, 10)
    expect(Math.sqrt((L - M) / (C - Cm))).toBeCloseTo(fixture.modal_reference.odd_impedance_ohms, 10)
    expect(fixture.length_m * Math.sqrt((L + M) * (C + Cm))).toBeCloseTo(fixture.modal_reference.even_delay_s, 16)
    const step: Waveform = [[0, 0], [1e-10, 1], [20e-9, 1]]
    for (const loadR of fixture.load_resistances_ohms) {
      const dc = symmetricReference(20e-9, step, loadR)
      expect(dc.near[0]).toBeCloseTo(loadR / (50 + loadR), 12)
      expect(dc.far[0]).toBeCloseTo(loadR / (50 + loadR), 12)
      expect(Math.abs(dc.near[1])).toBeLessThan(1e-12)
      expect(Math.abs(dc.far[1])).toBeLessThan(1e-12)
    }
  })

  test("the actual two-line zero-mutual solve preserves independent active and quiet victims", () => {
    const switching = run(128, 50, false)
    const silent = run(128, 50, false, quiet)
    for (const end of ["near_voltage_v", "far_voltage_v"] as const) {
      expect(maximumDifference(switching[end][1], silent[end][1])).toBeLessThanOrEqual(1e-6)
      expect(Math.max(...switching[end][1].map(Math.abs))).toBeLessThanOrEqual(1e-6)
    }
    const active = run(128, 50, false, source, shiftedVictim)
    const activeBaseline = run(128, 50, false, quiet, shiftedVictim)
    expect(Math.max(...active.far_voltage_v[1])).toBeGreaterThan(0.49)
    for (const end of ["near_voltage_v", "far_voltage_v"] as const) {
      expect(maximumDifference(active[end][1], activeBaseline[end][1])).toBeLessThanOrEqual(1e-6)
    }
    measurements.zero_mutual = {
      quiet_victim_peak_v: Math.max(...switching.near_voltage_v[1].map(Math.abs), ...switching.far_voltage_v[1].map(Math.abs)),
      quiet_victim_aggressor_difference_v: Math.max(maximumDifference(switching.near_voltage_v[1], silent.near_voltage_v[1]), maximumDifference(switching.far_voltage_v[1], silent.far_voltage_v[1])),
      active_victim_aggressor_difference_v: Math.max(maximumDifference(active.near_voltage_v[1], activeBaseline.near_voltage_v[1]), maximumDifference(active.far_voltage_v[1], activeBaseline.far_voltage_v[1])),
      active_victim_far_peak_v: Math.max(...active.far_voltage_v[1]),
    }
  })

  test("a matched uncoupled line has causal delay, 1% swing accuracy and 1% UI crossing accuracy", () => {
    const actual = run(512, 50, false)
    const reference = referenceArrays(actual.time_s, 50, false)
    expect(maximumDifference(actual.near_voltage_v[0], reference.near[0]!)).toBeLessThan(0.01)
    expect(maximumDifference(actual.far_voltage_v[0], reference.far[0]!)).toBeLessThan(0.01)
    const expectedCrossing = 1e-10 + 2e-10 + 5e-10
    const crossing = firstCrossing(actual.time_s, actual.far_voltage_v[0], 0.25)
    expect(Math.abs(crossing - expectedCrossing)).toBeLessThan(0.01 * fixture.timing_tolerance_unit_interval_s)
    const beforeArrival = actual.far_voltage_v[0].filter((_, i) => actual.time_s[i]! < 5e-10)
    expect(Math.max(...beforeArrival.map(Math.abs))).toBeLessThan(1e-6)
    measurements.matched_line = {
      near_maximum_error_v: maximumDifference(actual.near_voltage_v[0], reference.near[0]!),
      far_maximum_error_v: maximumDifference(actual.far_voltage_v[0], reference.far[0]!),
      crossing_difference_s: Math.abs(crossing - expectedCrossing),
      declared_ui_s: fixture.timing_tolerance_unit_interval_s,
      prearrival_maximum_voltage_v: Math.max(...beforeArrival.map(Math.abs)),
    }
  })

  for (const loadR of fixture.load_resistances_ohms) {
    test(`equal ${loadR}-ohm loads reproduce independent near/far reflections and coupling`, () => {
      const actual = run(1536, loadR)
      const reference = referenceArrays(actual.time_s, loadR)
      for (let line = 0; line < 2; line++) {
        for (const end of ["near", "far"] as const) {
          const expected = reference[end][line]!
          const peak = Math.max(...expected.map(Math.abs))
          const tolerance = line === 0 ? 0.01 : Math.max(1e-5, 0.02 * peak)
          expect(maximumDifference(actual[`${end}_voltage_v`][line]!, expected)).toBeLessThan(tolerance)
        }
      }
      // Positive inductive and negative capacitive mutual terms give positive
      // initial NEXT; the faster odd mode arrives first, giving negative FEXT.
      const initialNear = actual.near_voltage_v[1].filter((_, i) => actual.time_s[i]! < 6e-10)
      const initialFar = actual.far_voltage_v[1].filter((_, i) => actual.time_s[i]! < 1.1e-9)
      expect(Math.max(...initialNear)).toBeGreaterThan(0.02)
      expect(Math.min(...initialFar)).toBeLessThan(-0.01)
      const actualCrossing = firstCrossing(actual.time_s, actual.far_voltage_v[1].map((v) => -v), 0.01)
      const referenceCrossing = firstCrossing(actual.time_s, reference.far[1]!.map((v) => -v), 0.01)
      expect(Math.abs(actualCrossing - referenceCrossing)).toBeLessThan(0.01 * fixture.timing_tolerance_unit_interval_s)
      measurements[`equal_load_${loadR}_ohms`] = {
        segments: actual.diagnostics.segments,
        near_signal_error_v: maximumDifference(actual.near_voltage_v[0], reference.near[0]!),
        far_signal_error_v: maximumDifference(actual.far_voltage_v[0], reference.far[0]!),
        near_coupling_error_v: maximumDifference(actual.near_voltage_v[1], reference.near[1]!),
        far_coupling_error_v: maximumDifference(actual.far_voltage_v[1], reference.far[1]!),
        near_coupling_reference_peak_v: Math.max(...reference.near[1]!.map(Math.abs)),
        far_coupling_reference_peak_v: Math.max(...reference.far[1]!.map(Math.abs)),
        initial_next_peak_v: Math.max(...initialNear), initial_fext_minimum_v: Math.min(...initialFar),
        far_coupling_crossing_difference_s: Math.abs(actualCrossing - referenceCrossing),
      }
    })
  }

  test("three spatial refinements converge independently in both weak coupling observables", () => {
    const runs = [384, 768, 1536].map((segments) => run(segments))
    const errors = runs.map((actual) => {
      const reference = referenceArrays(actual.time_s, 50)
      return {
        near: maximumDifference(actual.near_voltage_v[1], reference.near[1]!),
        far: maximumDifference(actual.far_voltage_v[1], reference.far[1]!),
      }
    })
    for (const end of ["near", "far"] as const) {
      expect(errors[1]![end]).toBeLessThan(errors[0]![end])
      expect(errors[2]![end]).toBeLessThan(errors[1]![end])
      const reference = referenceArrays(runs[2]!.time_s, 50)
      const peak = Math.max(...reference[end][1]!.map(Math.abs))
      const tolerance = Math.max(1e-5, 0.02 * peak)
      expect(errors[2]![end]).toBeLessThan(tolerance)
      expect(maximumDifference(runs[1]![`${end}_voltage_v`][1], runs[2]![`${end}_voltage_v`][1])).toBeLessThan(tolerance)
    }
    measurements.spatial_refinement = {
      segments: [384, 768, 1536], reference_errors_v: errors,
      final_two_coupling_differences_v: {
        near: maximumDifference(runs[1]!.near_voltage_v[1], runs[2]!.near_voltage_v[1]),
        far: maximumDifference(runs[1]!.far_voltage_v[1], runs[2]!.far_voltage_v[1]),
      },
    }
  })

  test("finite cosine ramps meet the weak-coupling gate without a derivative discontinuity", () => {
    const actual = run(256, 50, true, cosineRamp)
    const reference = referenceArrays(actual.time_s, 50, true, cosineRamp)
    for (const end of ["near", "far"] as const) {
      const peak = Math.max(...reference[end][1]!.map(Math.abs))
      expect(maximumDifference(actual[`${end}_voltage_v`][1], reference[end][1]!)).toBeLessThan(Math.max(1e-5, 0.02 * peak))
    }
    // With currents positive INTO every PCB port, a resistive far load has a
    // negative port current. Net work into this zero-state passive line cannot
    // be negative; after this finite pulse it must return close to zero.
    let maximumCurrentError = 0
    const powers = actual.time_s.map((time, i) => {
      let power = 0
      for (let line = 0; line < 2; line++) {
        const near = actual.near_voltage_v[line]![i]!
        const far = actual.far_voltage_v[line]![i]!
        const nearCurrent = actual.near_current_a[line]![i]!
        const farCurrent = actual.far_current_a[line]![i]!
        const drive = line === 0 ? cosineRamp(time) : 0
        maximumCurrentError = Math.max(maximumCurrentError,
          Math.abs(nearCurrent - (drive - near) / 50),
          Math.abs(farCurrent + far / 50))
        power += near * nearCurrent + far * farCurrent
      }
      return power
    })
    expect(maximumCurrentError).toBeLessThan(1e-12)
    let netEnergy = 0, minimumEnergy = 0
    for (let i = 1; i < powers.length; i++) {
      netEnergy += (actual.time_s[i]! - actual.time_s[i - 1]!) * (powers[i]! + powers[i - 1]!) / 2
      minimumEnergy = Math.min(minimumEnergy, netEnergy)
    }
    expect(minimumEnergy).toBeGreaterThan(-1e-15)
    expect(Math.abs(netEnergy)).toBeLessThan(1e-14)
    measurements.cosine_ramp = {
      segments: actual.diagnostics.segments,
      near_coupling_error_v: maximumDifference(actual.near_voltage_v[1], reference.near[1]!),
      far_coupling_error_v: maximumDifference(actual.far_voltage_v[1], reference.far[1]!),
      maximum_current_sign_or_ohms_law_error_a: maximumCurrentError,
      minimum_cumulative_net_energy_j: minimumEnergy, final_net_energy_j: netEnergy,
    }
  })

  test("independent modal ABCD four-port remains reciprocal and passive at either extraction Z0", () => {
    const frequencies = [0, 1e6, 1e8, 5e8, 1e9, 2e9]
    for (const referenceZ of [50, 75]) {
      const matrices = frequencies.map((frequency) => modalScattering(frequency, referenceZ))
      const input = {
        ports: ["a_near", "a_far", "v_near", "v_far"].map((port_name) => ({
          port_name,
          reference_impedance_ohms: referenceZ,
        })),
        frequencies_hz: frequencies,
        phasor_convention: "exp_positive_j_omega_t" as const,
        current_sign_convention: "into_pcb" as const,
        dc: { kind: "included" as const },
        representation: "s" as const,
        matrix_units: "dimensionless" as const,
        matrices,
      }
      const qualified = importPassiveNetwork(input, { require_reciprocal: true })
      const provided = createCoupledLineNetwork(rlgc(), {
        length_m: fixture.length_m,
        ports: input.ports,
        frequencies_hz: frequencies,
      })
      let maximumReferenceError = 0
      for (let frequency = 0; frequency < frequencies.length; frequency++) {
        for (let row = 0; row < 4; row++) {
          for (let column = 0; column < 4; column++) {
            const expected = matrices[frequency]![row]![column]!
            const actual = provided.matrices[frequency]![row]![column]!
            maximumReferenceError = Math.max(maximumReferenceError,
              Math.hypot(actual.real - expected.real, actual.imag - expected.imag))
          }
        }
      }
      expect(maximumReferenceError).toBeLessThan(1e-10)
      measurements[`bare_network_z0_${referenceZ}_ohms`] = {
        frequencies_hz: frequencies, maximum_complex_s_reference_error: maximumReferenceError,
        maximum_singular_value: qualified.qualification.maximum_singular_value,
        maximum_reciprocity_error: qualified.qualification.maximum_reciprocity_error,
      }
      expect(qualified.qualification.maximum_singular_value).toBeCloseTo(1, 10)
      expect(qualified.qualification.maximum_reciprocity_error).toBeLessThan(1e-12)
      expect(matrices[0]![1]![0]!.real).toBe(1)
      expect(matrices[0]![2]![0]!.real).toBe(0)
      // Passivity qualification must reject a response with amplified power,
      // rather than silently fitting or correcting this independent reference.
      const amplified = matrices.map((matrix) => matrix.map((row) => row.map((entry) => ({
        real: entry.real * 1.02,
        imag: entry.imag * 1.02,
      }))))
      expect(() => importPassiveNetwork({ ...input, matrices: amplified })).toThrow()
      const nonreciprocal = structuredClone(matrices)
      nonreciprocal[1]![0]![1]!.real += 0.01
      expect(() => importPassiveNetwork({ ...input, matrices: nonreciprocal }, {
        require_reciprocal: true,
        passivity_tolerance: 0.1,
      })).toThrow()
    }
  })

  test("the exact network includes independently known resistive DC behavior", () => {
    const model = rlgc(false)
    model.R_ohm_per_m = [[7, 0], [0, 7]]
    const Z0 = 75
    const seriesR = 7 * fixture.length_m
    const network = createCoupledLineNetwork(model, {
      length_m: fixture.length_m,
      frequencies_hz: [0, 1e6],
      ports: ["a_near", "a_far", "v_near", "v_far"].map((port_name) => ({
        port_name,
        reference_impedance_ohms: Z0,
      })),
    })
    const dc = network.matrices[0]!
    expect(dc[0]![0]!.real).toBeCloseTo(seriesR / (2 * Z0 + seriesR), 12)
    expect(dc[1]![0]!.real).toBeCloseTo(2 * Z0 / (2 * Z0 + seriesR), 12)
    expect(dc[0]![0]!.imag).toBe(0)
    expect(dc[1]![0]!.imag).toBe(0)
    expect(Math.hypot(dc[2]![0]!.real, dc[2]![0]!.imag)).toBeLessThan(1e-12)
    expect(network.qualification.maximum_singular_value).toBeLessThanOrEqual(1 + 1e-10)
    measurements.resistive_dc = {
      series_resistance_ohms: seriesR, reference_impedance_ohms: Z0,
      s11_real: dc[0]![0]!.real, s21_real: dc[1]![0]!.real,
      expected_s11_real: seriesR / (2 * Z0 + seriesR),
      expected_s21_real: 2 * Z0 / (2 * Z0 + seriesR),
      maximum_singular_value: network.qualification.maximum_singular_value,
    }
  })

  for (const loadR of fixture.load_resistances_ohms) {
    test(`FFT closure reproduces independent finite-cosine reflections with equal ${loadR}-ohm loads`, () => {
      const solve = (sample_interval_s: number, mutual = true) => simulateCoupledChannel(
        rlgc(mutual), [testbench(cosineRamp, loadR), testbench(quiet, loadR)], {
          length_m: fixture.length_m, duration_s: 6e-9, sample_interval_s,
          initial_condition: "zero", padding_duration_s: 8e-9,
          maximum_wrap_error_v: 1e-5, maximum_wrap_error_a: 2e-7,
        },
      )
      const coarse = solve(4e-12), fine = solve(2e-12)
      const reference = referenceArrays(fine.time_s, loadR, true, cosineRamp)
      const errors: Record<string, number> = {}
      for (const end of ["near", "far"] as const) {
        for (let line = 0; line < 2; line++) {
          const expected = reference[end][line]!
          const error = maximumDifference(fine[`${end}_voltage_v`][line]!, expected)
          const peak = Math.max(...expected.map(Math.abs))
          const tolerance = line === 0 ? 0.01 : Math.max(1e-5, 0.02 * peak)
          expect(error).toBeLessThan(tolerance)
          const refinedSamples = coarse.time_s.map((_, i) => fine[`${end}_voltage_v`][line]![2 * i]!)
          const refinement = maximumDifference(coarse[`${end}_voltage_v`][line]!, refinedSamples)
          expect(refinement).toBeLessThan(tolerance)
          errors[`${end}_${line === 0 ? "signal" : "coupling"}_reference_error_v`] = error
          errors[`${end}_${line === 0 ? "signal" : "coupling"}_sample_refinement_v`] = refinement
        }
      }
      expect(fine.diagnostics.causal_pre_response_max_v).toBeLessThan(1e-5)
      measurements[`fft_closure_equal_load_${loadR}_ohms`] = {
        coarse_sample_interval_s: 4e-12, fine_sample_interval_s: 2e-12,
        ...errors, diagnostics: fine.diagnostics,
      }
      if (loadR === 50) {
        const matched = solve(2e-12, false)
        const matchedReference = referenceArrays(matched.time_s, 50, false, cosineRamp)
        const nearError = maximumDifference(matched.near_voltage_v[0], matchedReference.near[0]!)
        const farError = maximumDifference(matched.far_voltage_v[0], matchedReference.far[0]!)
        const crossingError = Math.abs(firstCrossing(matched.time_s, matched.far_voltage_v[0], 0.25) - 8e-10)
        const quietPeak = Math.max(...matched.near_voltage_v[1].map(Math.abs), ...matched.far_voltage_v[1].map(Math.abs))
        expect(nearError).toBeLessThan(0.01)
        expect(farError).toBeLessThan(0.01)
        expect(crossingError).toBeLessThan(0.01 * fixture.timing_tolerance_unit_interval_s)
        expect(quietPeak).toBeLessThan(1e-6)
        measurements.fft_closure_matched_line = {
          near_signal_error_v: nearError, far_signal_error_v: farError,
          crossing_difference_s: crossingError, quiet_victim_peak_v: quietPeak,
          diagnostics: matched.diagnostics,
        }
      }
    })
  }
})
