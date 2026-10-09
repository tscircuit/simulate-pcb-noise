/** Planar diffusion model; excludes edge/proximity effects, roughness and PCB ground geometry. */
export const COPPER_PHASOR_CONVENTION = "exp(+j*omega*t)" as const
export const VACUUM_PERMEABILITY_H_PER_M = 4e-7 * Math.PI

export interface CopperSlabInput {
  frequencyHz: number
  thicknessM: number
  /** Conductivity at the actual operating temperature; no copper-grade default. */
  conductivitySPerM: number
  relativePermeability: number
  /** one_sided: H=0 at the back face; symmetric_two_sided: equal face currents. */
  currentDistribution: "one_sided" | "symmetric_two_sided"
}

export interface CopperImpedance {
  re: number
  im: number
}

export interface CopperTemperatureInput {
  conductivityAtReferenceTemperatureSPerM: number
  referenceTemperatureC: number
  temperatureC: number
  temperatureCoefficientPerC: number
  /** Author's calibrated validity interval for the linear resistivity law. */
  validTemperatureRangeC: readonly [number, number]
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
}

function positive(value: number, name: string): void {
  finite(value, name)
  if (value <= 0) throw new RangeError(`${name} must be positive`)
}

function validateSlab(input: CopperSlabInput): void {
  finite(input.frequencyHz, "frequencyHz")
  if (input.frequencyHz < 0) throw new RangeError("frequencyHz must be nonnegative")
  positive(input.thicknessM, "thicknessM")
  positive(input.conductivitySPerM, "conductivitySPerM")
  positive(input.relativePermeability, "relativePermeability")
  if (input.currentDistribution !== "one_sided" && input.currentDistribution !== "symmetric_two_sided") {
    throw new RangeError("currentDistribution must be explicitly one_sided or symmetric_two_sided")
  }
}

/** sigma(T) = sigma(Tref)/(1+alpha*(T-Tref)); does not infer copper purity or temperature. */
export function copperConductivityAtTemperature(input: CopperTemperatureInput): number {
  positive(input.conductivityAtReferenceTemperatureSPerM, "conductivityAtReferenceTemperatureSPerM")
  finite(input.referenceTemperatureC, "referenceTemperatureC")
  finite(input.temperatureC, "temperatureC")
  finite(input.temperatureCoefficientPerC, "temperatureCoefficientPerC")
  const [min, max] = input.validTemperatureRangeC
  finite(min, "validTemperatureRangeC minimum")
  finite(max, "validTemperatureRangeC maximum")
  if (min <= -273.15 || min > max || input.temperatureCoefficientPerC < 0) {
    throw new RangeError("temperature range must be ordered, above absolute zero, and alpha nonnegative")
  }
  if (input.temperatureC < min || input.temperatureC > max || input.referenceTemperatureC < min || input.referenceTemperatureC > max) {
    throw new RangeError("temperature is outside the authored linear-law validity interval")
  }
  const resistivityScale = 1 + input.temperatureCoefficientPerC * (input.temperatureC - input.referenceTemperatureC)
  positive(resistivityScale, "temperature resistivity scale")
  const conductivity = input.conductivityAtReferenceTemperatureSPerM / resistivityScale
  positive(conductivity, "temperature-corrected conductivity")
  return conductivity
}

/** Infinity denotes the exact zero-frequency limit, not an AC sample or a native DC solve. */
export function copperSkinDepthM(input: Pick<CopperSlabInput, "frequencyHz" | "conductivitySPerM" | "relativePermeability">): number {
  finite(input.frequencyHz, "frequencyHz")
  if (input.frequencyHz < 0) throw new RangeError("frequencyHz must be nonnegative")
  positive(input.conductivitySPerM, "conductivitySPerM")
  positive(input.relativePermeability, "relativePermeability")
  if (input.frequencyHz === 0) return Infinity
  // Log evaluation avoids overflow of the f*mu*sigma intermediate.
  const depth = Math.exp(-0.5 * (Math.log(Math.PI) + Math.log(input.frequencyHz) + Math.log(VACUUM_PERMEABILITY_H_PER_M) + Math.log(input.relativePermeability) + Math.log(input.conductivitySPerM)))
  positive(depth, "skin depth")
  return depth
}

/** Ohms/square for total sheet current, including the DC and finite-thickness skin transition. */
export function finiteCopperSlabImpedance(input: CopperSlabInput): CopperImpedance {
  validateSlab(input)
  const dc = (1 / input.conductivitySPerM) / input.thicknessM
  positive(dc, "DC sheet resistance")
  if (input.frequencyHz === 0) return { re: dc, im: 0 }
  const penetrationDistance = input.thicknessM * (input.currentDistribution === "one_sided" ? 1 : 0.5)
  const a = penetrationDistance / copperSkinDepthM(input)
  finite(a, "thickness/skin-depth ratio")
  let normalized: CopperImpedance
  if (a < 0.02) {
    // x*coth(x), x=(1+j)*a; avoids cancellation in cosh(2a)-cos(2a).
    const a2 = a * a
    const a4 = a2 * a2
    normalized = { re: 1 + 4 * a4 / 45 - 16 * a4 * a4 / 4725, im: 2 * a2 / 3 - 16 * a4 * a2 / 945 }
  } else if (a > 20) {
    normalized = { re: a, im: a }
  } else {
    const den = Math.cosh(2 * a) - Math.cos(2 * a)
    normalized = {
      re: a * (Math.sinh(2 * a) + Math.sin(2 * a)) / den,
      im: a * (Math.sinh(2 * a) - Math.sin(2 * a)) / den,
    }
  }
  const impedance = { re: dc * normalized.re, im: dc * normalized.im }
  positive(impedance.re, "sheet impedance resistance")
  finite(impedance.im, "sheet impedance reactance")
  return impedance
}

/** Rectangular strip internal impedance only; external/geometric inductance is separate. */
export function finiteCopperTraceImpedance(input: CopperSlabInput & { lengthM: number; widthM: number }): CopperImpedance {
  positive(input.lengthM, "lengthM")
  positive(input.widthM, "widthM")
  const sheet = finiteCopperSlabImpedance(input)
  const squares = input.lengthM / input.widthM
  const result = { re: sheet.re * squares, im: sheet.im * squares }
  positive(result.re, "trace impedance resistance")
  finite(result.im, "trace impedance reactance")
  return result
}

/** Reports existing adapter guards; these are eligibility conditions, not accuracy certificates. */
export function legacyCopperSkinRegime(input: CopperSlabInput): "volume_guard" | "half_space_guard" | "guard_gap" {
  validateSlab(input)
  const depth = copperSkinDepthM(input)
  if (input.thicknessM <= depth) return "volume_guard"
  if (input.thicknessM >= 3 * depth) return "half_space_guard"
  return "guard_gap"
}

/** Pinned implementation audit: the source's minus sign differs from its reference-page plus sign. */
export const PALACE_V014_COPPER_AUDIT = {
  version: "v0.14.0",
  source: "https://github.com/awslabs/palace/blob/v0.14.0/palace/models/surfaceconductivityoperator.cpp#L138-L160",
  reference: "https://github.com/awslabs/palace/blob/v0.14.0/docs/src/reference.md#L227-L244",
  phasorConvention: COPPER_PHASOR_CONVENTION,
  finiteThicknessDenominator: "cosh(nu)-cos(nu)",
  externalEffectiveThickness: "2 * authored thickness",
  domainConductivityLaw: "J = sigma E",
  support: "frequency-domain driven; DC/broadband finite-ground extraction remains unvalidated",
} as const

export type UnsupportedCopperCapability = {
  status: "unsupported"
  code: "native_finite_ground_unavailable" | "native_broadband_copper_unvalidated"
  message: string
}

export function nativeCopperCapabilityDiagnostic(capability: "finite_ground" | "broadband_finite_thickness"): UnsupportedCopperCapability {
  if (capability === "finite_ground") {
    return { status: "unsupported", code: "native_finite_ground_unavailable", message: "The analytic copper slab does not extract PCB ground geometry or contact-pair voltage. Supply and ground noise require an explicitly authored finite-return network or a validated native provider." }
  }
  if (capability !== "broadband_finite_thickness") throw new RangeError("Unknown native copper capability")
  return { status: "unsupported", code: "native_broadband_copper_unvalidated", message: "Finite-slab AC/DC utilities do not establish native mesh, material or bandwidth convergence. Palace copper eligibility guards remain required." }
}
