import { describe, expect, test } from "bun:test"
import {
  copperConductivityAtTemperature,
  copperSkinDepthM,
  finiteCopperSlabImpedance,
  finiteCopperTraceImpedance,
  legacyCopperSkinRegime,
  nativeCopperCapabilityDiagnostic,
  PALACE_V014_COPPER_AUDIT,
  type CopperSlabInput,
} from "../lib/copper"

const foil: CopperSlabInput = {
  frequencyHz: 0,
  conductivitySPerM: 5.8e7,
  thicknessM: 35e-6,
  relativePermeability: 1,
  currentDistribution: "one_sided",
}

/** Independent RK4 solution of E''=j*omega*mu*sigma*E and integrated conduction current. */
function diffusionReference(input: CopperSlabInput): { re: number; im: number } {
  const depth = input.thicknessM * (input.currentDistribution === "one_sided" ? 1 : 0.5)
  const w = 2 * Math.PI * input.frequencyHz * (4e-7 * Math.PI) * input.relativePermeability * input.conductivitySPerM * depth * depth
  const derivative = (s: number[]) => [s[2]!, s[3]!, -w * s[1]!, w * s[0]!, s[0]!, s[1]!]
  const add = (a: number[], b: number[], k: number) => a.map((v, i) => v + k * b[i]!)
  const steps = 8192
  const h = 1 / steps
  let s = [1, 0, 0, 0, 0, 0]
  for (let n = 0; n < steps; n++) {
    const k1 = derivative(s)
    const k2 = derivative(add(s, k1, h / 2))
    const k3 = derivative(add(s, k2, h / 2))
    const k4 = derivative(add(s, k3, h))
    s = s.map((v, i) => v + h * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!) / 6)
  }
  const currentRe = input.conductivitySPerM * input.thicknessM * s[4]!
  const currentIm = input.conductivitySPerM * input.thicknessM * s[5]!
  const norm = currentRe * currentRe + currentIm * currentIm
  return { re: (s[0]! * currentRe + s[1]! * currentIm) / norm, im: (s[1]! * currentRe - s[0]! * currentIm) / norm }
}

describe("finite copper diffusion", () => {
  test("known DC strip resistance, one or two current-carrying faces", () => {
    for (const currentDistribution of ["one_sided", "symmetric_two_sided"] as const) {
      const z = finiteCopperTraceImpedance({ ...foil, currentDistribution, lengthM: 0.1, widthM: 0.00025 })
      expect(z.re).toBeCloseTo(0.19704433497536947, 13)
      expect(z.im).toBe(0)
    }
    expect(copperSkinDepthM(foil)).toBe(Infinity)
  })

  test("independent 1 MHz skin-depth benchmark", () => {
    expect(copperSkinDepthM({ ...foil, frequencyHz: 1e6 })).toBeCloseTo(6.608549310080563e-5, 15)
  })

  test("finite-thickness impedance agrees with independent diffusion ODE across transition", () => {
    for (const currentDistribution of ["one_sided", "symmetric_two_sided"] as const) {
      for (const frequencyHz of [1e3, 1e6, 4e6, 32e6, 100e6]) {
        const input = { ...foil, frequencyHz, currentDistribution }
        const actual = finiteCopperSlabImpedance(input)
        const reference = diffusionReference(input)
        expect(Math.abs(actual.re - reference.re) / reference.re).toBeLessThan(1e-9)
        expect(Math.abs(actual.im - reference.im) / reference.im).toBeLessThan(1e-8)
      }
    }
  })

  test("low-frequency internal inductance is mu*t/3 or mu*t/12 per square", () => {
    for (const currentDistribution of ["one_sided", "symmetric_two_sided"] as const) {
      const input = { ...foil, frequencyHz: 1, currentDistribution }
      const divisor = currentDistribution === "one_sided" ? 3 : 12
      const expected = 2 * Math.PI * (4e-7 * Math.PI) * foil.thicknessM / divisor
      expect(Math.abs(finiteCopperSlabImpedance(input).im / expected - 1)).toBeLessThan(1e-10)
    }
  })

  test("half-space asymptote records the different one/two-face total current", () => {
    const frequencyHz = 1e12
    const halfSpace = Math.sqrt(Math.PI * frequencyHz * (4e-7 * Math.PI) / foil.conductivitySPerM)
    const one = finiteCopperSlabImpedance({ ...foil, frequencyHz })
    const two = finiteCopperSlabImpedance({ ...foil, frequencyHz, currentDistribution: "symmetric_two_sided" })
    expect(Math.abs(one.re / halfSpace - 1)).toBeLessThan(1e-12)
    expect(Math.abs(one.im / halfSpace - 1)).toBeLessThan(1e-12)
    expect(Math.abs(two.re / (halfSpace / 2) - 1)).toBeLessThan(1e-12)
  })

  test("positive real impedance and continuous transition across a wide sweep", () => {
    const dc = 1 / (foil.conductivitySPerM * foil.thicknessM)
    for (const currentDistribution of ["one_sided", "symmetric_two_sided"] as const) {
      let previous = dc
      for (let n = -12; n <= 12; n += 0.1) {
        const z = finiteCopperSlabImpedance({ ...foil, frequencyHz: 10 ** n, currentDistribution })
        expect(Number.isFinite(z.re) && Number.isFinite(z.im)).toBe(true)
        expect(z.re).toBeGreaterThanOrEqual(dc * (1 - 1e-12))
        expect(z.im).toBeGreaterThanOrEqual(0)
        expect(z.re).toBeGreaterThanOrEqual(previous * (1 - 1e-10))
        previous = z.re
      }
    }
  })

  test("numerical series and half-space branches join without discontinuity", () => {
    for (const a of [0.02, 20]) {
      const centerFrequency = a * a / (Math.PI * (4e-7 * Math.PI) * foil.conductivitySPerM * foil.thicknessM ** 2)
      const before = finiteCopperSlabImpedance({ ...foil, frequencyHz: centerFrequency * (1 - 1e-9) })
      const after = finiteCopperSlabImpedance({ ...foil, frequencyHz: centerFrequency * (1 + 1e-9) })
      expect(Math.abs(before.re - after.re) / before.re).toBeLessThan(2e-9)
      expect(Math.abs(before.im - after.im) / before.im).toBeLessThan(3e-9)
    }
  })

  test("temperature is explicit and stays within the authored calibrated interval", () => {
    const model = { conductivityAtReferenceTemperatureSPerM: 5.8e7, referenceTemperatureC: 20, temperatureC: 80, temperatureCoefficientPerC: 0.00393, validTemperatureRangeC: [-50, 100] as const }
    expect(copperConductivityAtTemperature(model)).toBeCloseTo(5.8e7 / 1.2358, 7)
    const hot = finiteCopperSlabImpedance({ ...foil, conductivitySPerM: copperConductivityAtTemperature(model) })
    expect(hot.re / finiteCopperSlabImpedance(foil).re).toBeCloseTo(1.2358, 13)
    expect(() => copperConductivityAtTemperature({ ...model, temperatureC: 101 })).toThrow("validity interval")
    expect(() => copperConductivityAtTemperature({ ...model, temperatureCoefficientPerC: -1 })).toThrow()
  })

  test("missing/invalid dimensions, material and frequency fail instead of producing NaN", () => {
    for (const key of ["thicknessM", "conductivitySPerM", "relativePermeability"] as const) {
      for (const value of [0, -1, NaN, Infinity]) {
        expect(() => finiteCopperSlabImpedance({ ...foil, [key]: value })).toThrow()
      }
    }
    for (const frequencyHz of [-1, NaN, Infinity]) expect(() => finiteCopperSlabImpedance({ ...foil, frequencyHz })).toThrow()
    expect(() => finiteCopperSlabImpedance({ ...foil, currentDistribution: undefined } as unknown as CopperSlabInput)).toThrow("explicitly")
    expect(() => finiteCopperTraceImpedance({ ...foil, lengthM: 0, widthM: 1 })).toThrow()
  })

  test("native guard gap is still visible and analytic utilities are not native convergence", () => {
    expect(legacyCopperSkinRegime({ ...foil, frequencyHz: 1e6 })).toBe("volume_guard")
    expect(legacyCopperSkinRegime({ ...foil, frequencyHz: 10e6 })).toBe("guard_gap")
    expect(legacyCopperSkinRegime({ ...foil, frequencyHz: 100e6 })).toBe("half_space_guard")
    expect(nativeCopperCapabilityDiagnostic("finite_ground").code).toBe("native_finite_ground_unavailable")
    expect(nativeCopperCapabilityDiagnostic("broadband_finite_thickness").status).toBe("unsupported")
    expect(PALACE_V014_COPPER_AUDIT.finiteThicknessDenominator).toBe("cosh(nu)-cos(nu)")
    expect(PALACE_V014_COPPER_AUDIT.externalEffectiveThickness).toBe("2 * authored thickness")
  })
})
