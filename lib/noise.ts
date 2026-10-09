import type { CompiledSource } from "./sources"

/** An authored synthetic source; this does not calculate resistor/device noise. */
export interface NoiseSource {
  kind: "stochastic_noise"
  distribution: "random_phase_multisine"
  mean_voltage_v: number
  peak_bound_v: number
  bandwidth_hz: number
  tone_count: number
  seed: number
  algorithm: "xorshift32"
  algorithm_version: "1"
  correlation: { kind: "independent" } | { kind: "shared"; group_id: string; polarity: 1 | -1 }
}

function validate(source: NoiseSource): void {
  const fields = ["kind", "distribution", "mean_voltage_v", "peak_bound_v", "bandwidth_hz", "tone_count", "seed", "algorithm", "algorithm_version", "correlation"]
  for (const key of Object.keys(source)) if (!fields.includes(key)) throw new Error(`Unsupported stochastic source field: ${key}`)
  if (source.kind !== "stochastic_noise" || source.distribution !== "random_phase_multisine" || source.algorithm !== "xorshift32" || source.algorithm_version !== "1") throw new Error("Unsupported stochastic distribution/algorithm/version")
  if (!Number.isFinite(source.mean_voltage_v) || !Number.isFinite(source.peak_bound_v) || source.peak_bound_v < 0 || !Number.isFinite(source.bandwidth_hz) || source.bandwidth_hz <= 0) throw new Error("Noise mean/bound/bandwidth must be finite, with nonnegative bound and positive bandwidth")
  if (!Number.isFinite(Math.abs(source.mean_voltage_v) + source.peak_bound_v)) throw new Error("Noise voltage bound must be finite")
  if (!Number.isInteger(source.tone_count) || source.tone_count < 1 || source.tone_count > 4096) throw new Error("Noise tone_count must be an integer from 1 to 4096")
  if (!Number.isFinite(source.tone_count / source.bandwidth_hz) || source.bandwidth_hz / source.tone_count <= 0) throw new Error("Noise period and frequency spacing must be representable")
  if (!Number.isInteger(source.seed) || source.seed < 1 || source.seed > 0xffffffff) throw new Error("xorshift32 seed must be a nonzero uint32")
  if (!source.correlation || !["independent", "shared"].includes(source.correlation.kind)) throw new Error("Noise correlation must be explicitly declared")
  const allowed = source.correlation.kind === "shared" ? ["kind", "group_id", "polarity"] : ["kind"]
  for (const key of Object.keys(source.correlation)) if (!allowed.includes(key)) throw new Error(`Unsupported noise correlation field: ${key}`)
  if (source.correlation.kind === "shared" && (typeof source.correlation.group_id !== "string" || !source.correlation.group_id.trim() || ![1, -1].includes(source.correlation.polarity))) throw new Error("Shared noise requires a group_id and signed polarity")
}

/** Uniform independent phase draws from the specified uint32 recurrence. */
export function seededNoisePhases(seed: number, count: number): number[] {
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff || !Number.isInteger(count) || count < 1 || count > 4096) throw new Error("Invalid xorshift32 seed/count")
  let state = seed >>> 0
  return Array.from({ length: count }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return 2 * Math.PI * state / 2 ** 32 })
}

export function compileNoiseSource(source: NoiseSource): CompiledSource {
  validate(source)
  const phases = seededNoisePhases(source.seed, source.tone_count)
  const frequencies = Array.from({ length: source.tone_count }, (_, index) => source.bandwidth_hz * ((index + 1) / source.tone_count))
  const amplitude = source.peak_bound_v / source.tone_count
  const powerPerTone = amplitude * 0.5 * amplitude
  if (!Number.isFinite(powerPerTone * source.tone_count) || (source.peak_bound_v > 0 && powerPerTone === 0)) throw new Error("Noise spectral power must be representable")
  const mean = source.mean_voltage_v
  const polarity = source.correlation.kind === "shared" ? source.correlation.polarity : 1
  const period = source.tone_count / source.bandwidth_hz
  return {
    valueAt(time_s) {
      if (!Number.isFinite(time_s)) throw new Error("Noise time_s must be finite")
      const time = time_s % period
      let value = 0
      for (let index = 0; index < phases.length; index++) value += amplitude * Math.cos(2 * Math.PI * (frequencies[index]! * time) + phases[index]!)
      return mean + polarity * value
    },
    metadata: {
      ...source, correlation: { ...source.correlation }, unit: "V", source_model: "authored_synthetic_voltage", phase_distribution: "uniform_0_2pi", phases_rad: [...phases],
      ac_rms_v: source.peak_bound_v / Math.sqrt(2 * source.tone_count), period_s: period,
      spectrum: { kind: "one_sided_discrete_line_power", frequencies_hz: [...frequencies], power_per_tone_v2: powerPerTone },
      filter: "finite_cosine_basis", support_band_hz: [frequencies[0], source.bandwidth_hz],
      assumptions: ["stationary random-phase ensemble", "periodic realization", "distinct pseudorandom phase streams assumed independent; finite-record correlation may remain", "discrete spectral lines, not continuous white PSD", "no inferred thermal or flicker noise calibration"],
    },
  }
}

/** Detect accidental identical seeds before an uncorrelated power assumption. */
export function compileNoiseSources(sources: NoiseSource[]): CompiledSource[] {
  sources.forEach(validate)
  const independentSeeds = new Set<number>(), shared = new Map<string, string>(), seedOwners = new Map<number, string>()
  for (const source of sources) {
    const owner = source.correlation.kind === "independent" ? "independent" : `shared:${source.correlation.group_id}`
    if (source.correlation.kind === "independent") {
      if (independentSeeds.has(source.seed) || seedOwners.has(source.seed)) throw new Error("Independent stochastic sources require distinct seeds")
      independentSeeds.add(source.seed)
    } else {
      const signature = JSON.stringify([source.seed, source.bandwidth_hz, source.tone_count, source.algorithm, source.algorithm_version, source.distribution])
      const previous = shared.get(source.correlation.group_id)
      if (previous && previous !== signature) throw new Error("Shared noise group must use identical seed, spectrum and algorithm")
      if (seedOwners.has(source.seed) && seedOwners.get(source.seed) !== owner) throw new Error("Separate noise groups require distinct seeds")
      shared.set(source.correlation.group_id, signature)
    }
    seedOwners.set(source.seed, owner)
  }
  return sources.map(compileNoiseSource)
}
