import {
  simulation_pcb_noise_configuration, simulation_pcb_noise_result,
  simulation_pcb_noise_network_json, simulation_pcb_noise_waveform_json,
  simulation_pcb_noise_eye_json, simulation_pcb_noise_spectrum_json,
  simulation_pcb_noise_manifest_json, validatePcbNoiseCircuitJson,
  validatePcbNoiseDecodedAssets, type SimulationPcbNoiseConfiguration,
  type SimulationPcbNoiseResult,
} from "circuit-json"
import { createJsonAsset, manifestArtifact, type NoiseAssetDescriptor } from "./assets"
import { buildRunManifest, canonicalJson, computeInputDigest, sha256, type JsonValue } from "./manifest"
import { buildCoupledLineModel, collectNoiseGeometryInputs } from "./geometry"
import { compareRlgcCoupling, extractCoupledRlgc, validateCoupledRlgc, type ExtractionResult, type LineTestbench } from "./coupled-line"
import { createCoupledLineNetwork } from "./coupled-network"
import { simulateCoupledChannel } from "./channel"
import { compileSource, generateSymbolClock, type SourceWaveform } from "./sources"
import { analyzeEye, type EyeTiming } from "./eye"
import { computeSpectrum } from "./spectrum"
import { subtractBaseline, thresholdCrossings, type Waveform } from "./waveform"

export interface PcbNoiseRunSettings {
  copper: { kind: "finite_slab"; relative_permeability: number; current_distribution: "one_sided" | "symmetric_two_sided" }
  extraction: { grid_mm: number; margin_mm: number; top_mm: number; relative_tolerance: number; maximum_iterations: number }
  transient: { initial_condition: "zero" | "dc_equilibrium"; padding_duration_s: number; maximum_wrap_error_v: number; maximum_wrap_error_a: number; maximum_fft_size: number }
  frequency: { frequencies_hz: number[]; reference_impedance_ohms: number }
  convergence: { coupling_relative_tolerance: number; capacitance_absolute_f_per_m: number; inductance_absolute_h_per_m: number; domain_scale: number; maximum_reciprocity_error: number; sampling_relative_tolerance: number; sampling_absolute_v: number; sampling_absolute_a: number }
  spectrum: { window: "rectangular" | "hann"; dc_treatment: "included" | "mean_removed" }
  eyes: Record<string, { threshold_v: number; rise_time_s: number }>
}
export interface PcbNoiseRunOptions {
  experiment_id: string
  result_id: string
  run_id: string
  settings: PcbNoiseRunSettings
  extraction_cache?: PcbNoiseExtractionCache
}
export interface PcbNoiseExtractionCache {
  format: "pcb_noise_extraction_cache_v1"
  key_sha256: string
  data_sha256: string
  runs: ExtractionResult[]
}
export interface PcbNoiseRunAsset { path: string; bytes: Uint8Array; descriptor: NoiseAssetDescriptor; payload: unknown }
export interface PcbNoiseRunOutput { result: SimulationPcbNoiseResult; circuit_json: unknown[]; assets: PcbNoiseRunAsset[]; extraction_cache?: PcbNoiseExtractionCache }
type Residual = { name: string; value: number; unit: string; limit: number }
class RunProblem extends Error {
  constructor(readonly status: "failed" | "unsupported", readonly code: string, message: string) { super(message) }
}
function keys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!expected.includes(key)) throw new Error(`Unknown ${label} field ${key}`)
  for (const key of expected) if (!(key in value)) throw new Error(`Supply explicit ${label}.${key}`)
}
/** Numerical and electrical settings are authored; malformed settings are never repaired. */
export function validatePcbNoiseRunSettings(value: unknown): PcbNoiseRunSettings {
  keys(value, ["copper", "extraction", "transient", "frequency", "convergence", "spectrum", "eyes"], "settings")
  keys(value.copper, ["kind", "relative_permeability", "current_distribution"], "copper")
  keys(value.extraction, ["grid_mm", "margin_mm", "top_mm", "relative_tolerance", "maximum_iterations"], "extraction")
  keys(value.transient, ["initial_condition", "padding_duration_s", "maximum_wrap_error_v", "maximum_wrap_error_a", "maximum_fft_size"], "transient")
  keys(value.frequency, ["frequencies_hz", "reference_impedance_ohms"], "frequency")
  keys(value.convergence, ["coupling_relative_tolerance", "capacitance_absolute_f_per_m", "inductance_absolute_h_per_m", "domain_scale", "maximum_reciprocity_error", "sampling_relative_tolerance", "sampling_absolute_v", "sampling_absolute_a"], "convergence")
  keys(value.spectrum, ["window", "dc_treatment"], "spectrum")
  for (const group of [value.extraction, value.transient, value.frequency, value.convergence]) for (const [name, number] of Object.entries(group)) {
    if (name === "initial_condition" || name === "frequencies_hz") continue
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive and finite`)
  }
  const settings = value as unknown as PcbNoiseRunSettings
  if (settings.copper.kind !== "finite_slab" || !Number.isFinite(settings.copper.relative_permeability) || settings.copper.relative_permeability < 1 || !["one_sided", "symmetric_two_sided"].includes(settings.copper.current_distribution)) throw new Error("Supply finite-slab copper with explicit permeability and current distribution")
  if (!Number.isSafeInteger(settings.extraction.maximum_iterations) || !Number.isSafeInteger(settings.transient.maximum_fft_size)) throw new Error("Iteration and FFT limits must be integers")
  if (!["zero", "dc_equilibrium"].includes(settings.transient.initial_condition) || settings.convergence.domain_scale <= 1) throw new Error("Supply supported initial condition and domain scale greater than one")
  const f = settings.frequency.frequencies_hz
  if (!Array.isArray(f) || f.length < 2 || f.length > 100000 || f[0] !== 0 || f.some((v, i) => !Number.isFinite(v) || v < 0 || i > 0 && v <= f[i - 1]!)) throw new Error("Supply an increasing frequency grid including DC")
  if (!["hann", "rectangular"].includes(settings.spectrum.window) || !["included", "mean_removed"].includes(settings.spectrum.dc_treatment)) throw new Error("Unsupported spectrum policy")
  if (!settings.eyes || typeof settings.eyes !== "object" || Array.isArray(settings.eyes)) throw new Error("eyes must be an observation settings map")
  for (const [name, eye] of Object.entries(settings.eyes)) {
    keys(eye, ["threshold_v", "rise_time_s"], `eyes.${name}`)
    if (!Number.isFinite(eye.threshold_v) || !Number.isFinite(eye.rise_time_s) || eye.rise_time_s <= 0) throw new Error("Supply finite eye threshold and positive rise time")
  }
  canonicalJson(settings)
  return settings
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
const max = (values: readonly number[]) => values.reduce((a, b) => Math.max(a, Math.abs(b)), 0)
const channels = (run: ReturnType<typeof simulateCoupledChannel>) => [...run.near_voltage_v, ...run.far_voltage_v, ...run.near_current_a, ...run.far_current_a]
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function qualifyCachedExtraction(runs: ExtractionResult[], settings: PcbNoiseRunSettings, copper: { conductivity_s_per_m: number; width_m: number; thickness_m: number }, relativePermittivity: number) {
  const dc = 1 / (copper.conductivity_s_per_m * copper.width_m * copper.thickness_m)
  const close = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(b), Number.MIN_VALUE)
  for (const [index, run] of runs.entries()) {
    validateCoupledRlgc(run); canonicalJson(run)
    const expected = { grid_mm: settings.extraction.grid_mm / [1, 2, 4, 4][index]!, margin_mm: settings.extraction.margin_mm * (index === 3 ? settings.convergence.domain_scale : 1), top_mm: settings.extraction.top_mm * (index === 3 ? settings.convergence.domain_scale : 1) }
    if (!run.diagnostics || Object.entries(expected).some(([key, value]) => !close(run.diagnostics[key as keyof typeof expected], value))) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached mesh/domain coordinates differ from authored refinement settings")
    for (const key of ["nodes", "unknowns", "iterations"] as const) if (!Number.isSafeInteger(run.diagnostics[key]) || run.diagnostics[key] < 1) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached numerical diagnostics require positive finite integer counts")
    for (const value of Object.values(run.diagnostics)) if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached numerical diagnostics must be finite and nonnegative")
    const vacuum = run.C_vacuum_f_per_m
    if (!Array.isArray(vacuum) || vacuum.length !== 2 || vacuum.some((row) => !Array.isArray(row) || row.length !== 2 || row.some((v) => !Number.isFinite(v)))) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached extraction requires a complete finite vacuum capacitance matrix")
    const determinant = vacuum[0][0] * vacuum[1][1] - vacuum[0][1] * vacuum[1][0]
    if (vacuum[0][0] <= 0 || vacuum[1][1] <= 0 || determinant <= 0 || !close(vacuum[0][1], vacuum[1][0])) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached vacuum capacitance must be symmetric positive definite")
    // Every edge permittivity lies in [1, er], so minimized electric energy gives Cvac <= C <= er*Cvac.
    // Check matrix order, allowing 1e-7 relative numerical noise at the semidefinite bounds.
    const capacitance = run.C_f_per_m, capacitanceScale = Math.max(...capacitance.flat().map(Math.abs), ...vacuum.flat().map((v) => relativePermittivity * Math.abs(v)))
    for (const [direction, permittivity] of [[1, 1], [-1, relativePermittivity]] as const) {
      const a = direction * (capacitance[0][0] - permittivity * vacuum[0][0]) / capacitanceScale
      const d = direction * (capacitance[1][1] - permittivity * vacuum[1][1]) / capacitanceScale
      const b = direction * (capacitance[0][1] + capacitance[1][0] - permittivity * (vacuum[0][1] + vacuum[1][0])) / (2 * capacitanceScale)
      const minimumEigenvalue = (a + d - Math.hypot(a - d, 2 * b)) / 2
      if (!Number.isFinite(minimumEigenvalue) || minimumEigenvalue < -1e-7) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached capacitance violates vacuum and authored dielectric energy bounds")
    }
    const scale = 1 / (299792458 ** 2 * determinant)
    const inductance = [[vacuum[1][1] * scale, -vacuum[0][1] * scale], [-vacuum[1][0] * scale, vacuum[0][0] * scale]]
    for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
      if (!close(run.R_ohm_per_m[row]![column]!, row === column ? dc : 0) || run.G_s_per_m[row]![column] !== 0 || !close(run.L_h_per_m[row]![column]!, inductance[row]![column]!)) throw new RunProblem("failed", "inconsistent_extraction_cache", "Cached RLGC differs from actual copper DC resistance, explicit zero dielectric loss or inverse vacuum-capacitance inductance")
    }
  }
}

/** Pure browser-safe orchestration. IO and asset URL resolution belong to the caller. */
export async function runPcbNoise(circuitJson: readonly unknown[], options: PcbNoiseRunOptions): Promise<PcbNoiseRunOutput> {
  for (const [name, id] of Object.entries({ experiment_id: options.experiment_id, result_id: options.result_id, run_id: options.run_id })) if (typeof id !== "string" || !id.trim()) throw new Error(`Supply ${name}`)
  const document = validatePcbNoiseCircuitJson(circuitJson)
  const config = document.configurations.find((c) => c.simulation_experiment_id === options.experiment_id)
  if (!config) throw new Error("Selected pcb_noise experiment has no configuration")
  if (document.results.some((r) => r.run_id === options.run_id || r.simulation_pcb_noise_result_id === options.result_id)) throw new Error("Immutable noise run/result already exists")
  const identity = { type: "simulation_pcb_noise_result" as const, simulation_pcb_noise_result_id: options.result_id, simulation_experiment_id: config.simulation_experiment_id, simulation_pcb_noise_configuration_id: config.simulation_pcb_noise_configuration_id, pcb_board_id: config.pcb_board_id, run_id: options.run_id }
  let verifiedExtractionCache: PcbNoiseExtractionCache | undefined
  try {
    const settings = validatePcbNoiseRunSettings(options.settings)
    simulation_pcb_noise_configuration.parse(config)
    const report = buildCoupledLineModel(circuitJson, config)
    if (report.status !== "complete" || !report.model) throw new RunProblem("unsupported", report.issues[0]?.code ?? "unsupported_geometry", report.issues.map((i) => i.message).join("; "))
    const model = report.model, residuals: Residual[] = []
    const copper = { width_m: model.geometry.width_mm / 1000, thickness_m: model.geometry.thickness_mm / 1000, conductivity_s_per_m: model.material.conductivity_s_per_m, relative_permeability: settings.copper.relative_permeability, current_distribution: settings.copper.current_distribution }
    if (settings.frequency.frequencies_hz.at(-1)! < 1 / (2 * model.sample_interval_s)) throw new RunProblem("unsupported", "insufficient_network_band", "Authored network frequency band must cover every frequency applied by the sampled channel, including Nyquist")
    for (const line of model.lines) {
      const waveform = line.source.waveform as SourceWaveform
      const rate = waveform.kind === "sine" ? waveform.frequency_hz : waveform.kind === "prbs" ? waveform.baud_rate_hz : waveform.kind === "pulse" ? 1 / waveform.period_s : 0
      if (rate * model.sample_interval_s > 1 / 32) throw new RunProblem("unsupported", "undersampled_source", "Authored periodic sources require at least 32 samples per period or symbol; two aliased runs cannot certify a source")
    }
    for (const eye of config.eyes ?? []) {
      const observation = config.observations.find((o) => o.name === eye.observation_name)!
      const mappedLine = model.lines.find((line) => line.near_port_name === observation.port_name || line.far_port_name === observation.port_name)!
      const mapped = mappedLine.source.waveform as SourceWaveform
      if (mapped.kind !== "prbs") continue
      const expectedUi = 1 / mapped.baud_rate_hz
      // Decimal SI parsing and reciprocal arithmetic need only a small ULP margin.
      // Independent receiver/reference clocks may carry intentional frequency error.
      const authoredUi = eye.timing.kind === "known_ui" ? eye.timing.unit_interval_s
        : eye.timing.clock.kind === "authored_edges" && eye.timing.clock.source_name === mappedLine.source.name ? expectedUi : undefined
      if (authoredUi !== undefined && Math.abs(authoredUi - expectedUi) > 64 * Number.EPSILON * Math.max(authoredUi, expectedUi)) throw new RunProblem("unsupported", "conflicting_authored_symbol_rate", `Eye ${eye.observation_name} has authored UI ${authoredUi}s inconsistent with its mapped PRBS UI ${expectedUi}s`)
    }
    if (config.baseline?.source_names.some((name) => config.sources.find((s) => s.name === name)?.role !== "aggressor")) throw new RunProblem("unsupported", "invalid_baseline", "Paired baseline may quiet only declared aggressor sources")
    const geometry = json({ records: collectNoiseGeometryInputs(circuitJson, config.pcb_board_id) })
    const extractionKey = await sha256(canonicalJson({ version: "uniform_cross_section_1", geometry, extraction: settings.extraction, domain_scale: settings.convergence.domain_scale }))
    const gate = (name: string, value: number, limit: number, unit = "relative") => {
      residuals.push({ name, value, limit, unit })
      if (!Number.isFinite(value) || value > limit) throw new RunProblem("failed", "numerical_validation_failed", `${name}: measured ${value} ${unit}, limit ${limit}`)
    }
    let extractionRuns: ExtractionResult[], expanded: ExtractionResult
    if (options.extraction_cache) {
      const cache = options.extraction_cache
      keys(cache, ["format", "key_sha256", "data_sha256", "runs"], "extraction cache")
      if (cache.format !== "pcb_noise_extraction_cache_v1" || cache.key_sha256 !== extractionKey || !Array.isArray(cache.runs) || cache.runs.length !== 4 || await sha256(canonicalJson(cache.runs)) !== cache.data_sha256) throw new RunProblem("failed", "stale_extraction_cache", "Extraction cache fingerprint or data digest differs from complete geometry and numerical settings")
      const runs = JSON.parse(JSON.stringify(cache.runs)) as ExtractionResult[]
      qualifyCachedExtraction(runs, settings, copper, model.material.relative_permittivity)
      extractionRuns = runs.slice(0, 3); expanded = runs[3]!
    } else {
      extractionRuns = [1, 2, 4].map((refinement) => extractCoupledRlgc(model.geometry, model.material, { ...settings.extraction, grid_mm: settings.extraction.grid_mm / refinement }))
      expanded = extractCoupledRlgc(model.geometry, model.material, { ...settings.extraction, grid_mm: settings.extraction.grid_mm / 4, margin_mm: settings.extraction.margin_mm * settings.convergence.domain_scale, top_mm: settings.extraction.top_mm * settings.convergence.domain_scale })
    }
    const finest = extractionRuns[2]!
    const compare = (a: typeof finest, b: typeof finest, name: string) => {
      const c = compareRlgcCoupling(a, b, { relative: settings.convergence.coupling_relative_tolerance, capacitance_absolute_f_per_m: settings.convergence.capacitance_absolute_f_per_m, inductance_absolute_h_per_m: settings.convergence.inductance_absolute_h_per_m })
      for (const [quantity, comparison, values, floor, unit] of [
        ["mutual_capacitance", c.capacitance, [a.C_f_per_m[0][1], b.C_f_per_m[0][1]], settings.convergence.capacitance_absolute_f_per_m, "F/m"],
        ["mutual_inductance", c.inductance, [a.L_h_per_m[0][1], b.L_h_per_m[0][1]], settings.convergence.inductance_absolute_h_per_m, "H/m"],
      ] as const) gate(`${name}_${quantity}`, comparison.absolute, Math.max(floor, settings.convergence.coupling_relative_tolerance * max(values)), unit)
      for (const [quantity, am, bm, floor, unit] of [["capacitance", a.C_f_per_m, b.C_f_per_m, settings.convergence.capacitance_absolute_f_per_m, "F/m"], ["inductance", a.L_h_per_m, b.L_h_per_m, settings.convergence.inductance_absolute_h_per_m, "H/m"]] as const) {
        for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) gate(`${name}_${quantity}_${row}_${column}`, Math.abs(am[row]![column]! - bm[row]![column]!), Math.max(floor, settings.convergence.coupling_relative_tolerance * Math.max(Math.abs(am[row]![column]!), Math.abs(bm[row]![column]!))), unit)
      }
    }
    compare(extractionRuns[1]!, finest, "mesh_medium_fine")
    compare(finest, expanded, "domain_fine_expanded")
    for (const [i, run] of [...extractionRuns, expanded].entries()) {
      gate(`extraction_${i}_residual`, run.diagnostics.relative_residual, settings.extraction.relative_tolerance)
      gate(`extraction_${i}_reciprocity`, run.diagnostics.relative_reciprocity_error, settings.convergence.maximum_reciprocity_error)
    }
    const extractionCache = freeze({ format: "pcb_noise_extraction_cache_v1" as const, key_sha256: extractionKey, data_sha256: await sha256(canonicalJson([...extractionRuns, expanded])), runs: [...extractionRuns, expanded] })
    verifiedExtractionCache = extractionCache
    const sources = model.lines.map((line) => compileSource(line.source.waveform as SourceWaveform))
    const makeLines = (baseline: boolean): [LineTestbench, LineTestbench] => model.lines.map((line, i) => {
      const load = line.termination.model as Record<string, unknown>, sourceModel = line.source.source_model as Record<string, unknown>
      const quiet = baseline && config.baseline?.source_names.includes(String(line.source.name))
      return { source_resistance_ohms: sourceModel.resistance_ohms as number, load_resistance_ohms: load.resistance_ohms as number, load_capacitance_f: load.kind === "parallel_rc" ? load.capacitance_f as number : 0, load_bias_voltage_v: load.bias_voltage_v as number, source_voltage: quiet ? () => config.baseline!.voltage_v : sources[i]!.valueAt, ...(sources[i]!.minimum_transition_s !== undefined ? { minimum_transition_s: sources[i]!.minimum_transition_s } : {}) }
    }) as [LineTestbench, LineTestbench]
    const transientOptions = { ...settings.transient, copper, length_m: model.geometry.length_mm / 1000, duration_s: model.duration_s, sample_interval_s: model.sample_interval_s }
    const total = simulateCoupledChannel(expanded, makeLines(false), transientOptions)
    const refined = simulateCoupledChannel(expanded, makeLines(false), { ...transientOptions, sample_interval_s: model.sample_interval_s / 2 })
    const baseline = config.baseline ? simulateCoupledChannel(expanded, makeLines(true), transientOptions) : undefined
    const baselineRefined = config.baseline ? simulateCoupledChannel(expanded, makeLines(true), { ...transientOptions, sample_interval_s: model.sample_interval_s / 2 }) : undefined
    const gateSampling = (label: string, coarse: number[][], fine: number[][]) => {
      for (let channel = 0; channel < coarse.length; channel++) {
        const unit = channel < 4 ? "V" : "A", absolute = unit === "V" ? settings.convergence.sampling_absolute_v : settings.convergence.sampling_absolute_a
        const delta = max(coarse[channel]!.map((value, i) => value - fine[channel]![2 * i]!))
        gate(`${label}_sampling_channel_${channel}`, delta, Math.max(absolute, settings.convergence.sampling_relative_tolerance * max(fine[channel]!)), unit)
      }
    }
    const totalChannels = channels(total), refinedChannels = channels(refined)
    gateSampling("total", totalChannels, refinedChannels)
    if (baseline && baselineRefined) {
      const base = channels(baseline), baseRefined = channels(baselineRefined)
      gateSampling("baseline", base, baseRefined)
      gateSampling("difference", totalChannels.map((waveform, channel) => waveform.map((value, i) => value - base[channel]![i]!)), refinedChannels.map((waveform, channel) => waveform.map((value, i) => value - baseRefined[channel]![i]!)))
    }
    const transientRuns: [string, typeof total][] = [["total", total], ["sampling_refined", refined]]
    if (baseline) transientRuns.push(["baseline", baseline])
    if (baselineRefined) transientRuns.push(["baseline_sampling_refined", baselineRefined])
    for (const [label, run] of transientRuns) {
      gate(`${label}_circular_wrap`, run.diagnostics.circular_wrap_refinement_max_v, settings.transient.maximum_wrap_error_v, "V")
      gate(`${label}_circular_wrap_current`, run.diagnostics.circular_wrap_refinement_max_a, settings.transient.maximum_wrap_error_a, "A")
      gate(`${label}_causal_pre_response`, run.diagnostics.causal_pre_response_max_v, settings.transient.maximum_wrap_error_v, "V")
      gate(`${label}_nyquist_projection`, run.diagnostics.nyquist_projection_bound_v, settings.transient.maximum_wrap_error_v, "V")
      gate(`${label}_nyquist_projection_current`, run.diagnostics.nyquist_projection_bound_a, settings.transient.maximum_wrap_error_a, "A")
    }
    const inputs = { geometry: { value: geometry }, configuration: { value: json(config) }, sources: { value: json({ sources: config.sources }) }, loads: { value: json({ terminations: config.terminations }) } }
    const digests = { geometry: await computeInputDigest(inputs.geometry), sources: await computeInputDigest(inputs.sources), loads: await computeInputDigest(inputs.loads) }
    const orderedNames = model.lines.flatMap((line) => [line.near_port_name, line.far_port_name])
    const ports = orderedNames.map((name) => {
      const port = config.ports.find((p) => p.name === name)!
      return { port_name: name, signal_contact: port.signal_contact, reference_contact: port.reference_contact, reference_impedance_ohms: settings.frequency.reference_impedance_ohms, reference_plane: "authored_signal_contact", polarity: "signal_minus_reference" as const }
    })
    const qualified = createCoupledLineNetwork(expanded, { length_m: transientOptions.length_m, copper, ports, frequencies_hz: settings.frequency.frequencies_hz }, { passivity_tolerance: 1e-8, reciprocity_tolerance: settings.convergence.maximum_reciprocity_error, require_reciprocal: true, maximum_condition_number: 1e12 })
    gate("network_passivity_excess", Math.max(0, qualified.qualification.maximum_singular_value - 1), qualified.qualification.passivity_tolerance)
    gate("network_reciprocity", qualified.qualification.maximum_reciprocity_error, qualified.qualification.reciprocity_tolerance)
    const permutation = config.ports.map((p) => orderedNames.indexOf(p.name))
    const provider = "uniform_coupled_quasi_tem_finite_slab_copper"
    const network = simulation_pcb_noise_network_json.parse({
      format: "simulation_pcb_noise_network_json_v1", run_id: options.run_id,
      input_sha256: digests.geometry.sha256,
      model_sha256: await sha256(canonicalJson({ geometry: model.geometry, material: model.material, copper, R: expanded.R_ohm_per_m, L: expanded.L_h_per_m, C: expanded.C_f_per_m, G: expanded.G_s_per_m })),
      ports: permutation.map((i) => ports[i]), frequencies_hz: qualified.frequencies_hz,
      representation: "s", matrix_units: "dimensionless",
      matrices: qualified.matrices.map((slice) => permutation.map((p) => permutation.map((q) => slice[p]![q]))),
      phasor_convention: qualified.phasor_convention, current_sign_convention: qualified.current_sign_convention,
      dc: qualified.dc, extraction: { provider, version: "1", normalization: qualified.normalization },
    })
    const assets: PcbNoiseRunAsset[] = []
    const asset = async (payload: unknown, path: string) => {
      const embedded = await createJsonAsset(payload, { projectRelativePath: path })
      const descriptor = { ...embedded, asset: { ...embedded.asset, url: `project://${path}` } }
      assets.push({ path, bytes: new TextEncoder().encode(JSON.stringify(payload)), descriptor, payload })
      return descriptor
    }
    const networkAsset = await asset(network, "network.json")
    const waveforms: Waveform[] = [], waveformAssets: { observation_name: string; variant: Waveform["variant"]; asset: NoiseAssetDescriptor }[] = []
    const observationValues = (run: typeof total, observation: SimulationPcbNoiseConfiguration["observations"][number]) => {
      const index = model.lines.findIndex((line) => line.near_port_name === observation.port_name || line.far_port_name === observation.port_name)
      if (index < 0) throw new RunProblem("unsupported", "unresolved_observation", "Observation has no supported line terminal")
      const near = model.lines[index]!.near_port_name === observation.port_name
      return (observation.quantity === "voltage" ? near ? run.near_voltage_v : run.far_voltage_v : near ? run.near_current_a : run.far_current_a)[index]!
    }
    const timingHash = await sha256(canonicalJson(config.eyes ?? []))
    const victimHash = await sha256(canonicalJson(config.sources.filter((s) => s.role === "victim")))
    const baselineIdentity = { victim_source_sha256: victimHash, loads_sha256: digests.loads.sha256, timing_sha256: timingHash, seed: canonicalJson(config.sources.filter((s) => s.role === "victim").map((s) => s.waveform.kind === "prbs" ? s.waveform.seed : null)) }
    const comparison = await sha256(canonicalJson(baselineIdentity))
    for (const [i, observation] of config.observations.entries()) {
      const waveform: Waveform = { format: "simulation_pcb_noise_waveform_json_v1", run_id: options.run_id, observation_name: observation.name, unit: observation.quantity === "voltage" ? "V" : "A", variant: "total", time: { kind: "uniform", start_s: 0, step_s: model.sample_interval_s, count: total.time_s.length }, values: observationValues(total, observation), valid_intervals_s: [{ start_s: total.time_s[0]!, end_s: total.time_s.at(-1)! }], bandwidth_hz: total.diagnostics.bandwidth_hz, input_sha256: digests.geometry.sha256, source_sha256: digests.sources.sha256, full_resolution: true, ...(baseline ? { comparison_identity: comparison } : {}) }
      const variants = [waveform]
      if (baseline) {
        const quietSources = config.sources.map((s) => config.baseline!.source_names.includes(s.name) ? { ...s, waveform: { kind: "dc", voltage_v: config.baseline!.voltage_v } } : s)
        const baselineWaveform: Waveform = { ...waveform, variant: "baseline", values: observationValues(baseline, observation), source_sha256: (await computeInputDigest({ value: json({ sources: quietSources }) })).sha256 }
        variants.push(baselineWaveform, subtractBaseline(waveform, baselineWaveform, { total: baselineIdentity, baseline: baselineIdentity }))
      }
      for (const variant of variants) {
        simulation_pcb_noise_waveform_json.parse(variant)
        waveforms.push(variant)
        waveformAssets.push({ observation_name: observation.name, variant: variant.variant, asset: await asset(variant, `waveform-${i}-${variant.variant}.json`) })
      }
    }
    const eyes: unknown[] = [], eyeAssets: { observation_name: string; asset: NoiseAssetDescriptor }[] = [], spectra: unknown[] = [], spectrumAssets: { observation_name: string; asset: NoiseAssetDescriptor }[] = []
    const eyeDiagnostics: { observation_name: string; code: string; message: string }[] = []
    for (const [i, observation] of config.observations.entries()) {
      const waveform = waveforms.find((w) => w.observation_name === observation.name && w.variant === "total")!
      const waveformHash = waveformAssets.find((w) => w.observation_name === observation.name && w.variant === "total")!.asset.sha256
      const spectrum = simulation_pcb_noise_spectrum_json.parse(computeSpectrum(waveform, { ...settings.spectrum, waveform_sha256: waveformHash, kind: "psd" }))
      gate(`spectrum_${i}_parseval`, spectrum.parseval_relative_error, 1e-10)
      spectra.push(spectrum); spectrumAssets.push({ observation_name: observation.name, asset: await asset(spectrum, `spectrum-${i}.json`) })
      const authored = config.eyes?.find((eye) => eye.observation_name === observation.name)
      if (!authored) continue
      const eyeSettings = settings.eyes[observation.name]
      if (!eyeSettings) throw new RunProblem("unsupported", "missing_eye_settings", `Supply threshold and rise time for ${observation.name}`)
      const line = model.lines.find((l) => l.near_port_name === observation.port_name || l.far_port_name === observation.port_name)!
      const source = line.source.waveform as SourceWaveform
      const timing = await resolveTiming(authored.timing, config, waveforms, model.duration_s, model.sample_interval_s)
      const analysis = analyzeEye(waveform, { ...eyeSettings, signal_kind: source.kind === "prbs" || source.kind === "pulse" ? "active_nrz" : source.kind === "dc" ? "quiet" : "analog", timing, waveform_sha256: waveformHash, timing_sha256: await sha256(canonicalJson(authored.timing)), time_bins: 256, voltage_bins: 128 })
      if (analysis.status === "eye_available") { const eye = simulation_pcb_noise_eye_json.parse(analysis.eye); eyes.push(eye); eyeAssets.push({ observation_name: observation.name, asset: await asset(eye, `eye-${i}.json`) }) }
      else eyeDiagnostics.push({ observation_name: observation.name, code: analysis.code, message: analysis.reason })
    }
    const assumptions = report.assumptions.filter((a) => !a.startsWith("Top copper supplies DC series resistance"))
    assumptions.push("Copper uses an authored finite conducting slab skin-effect and internal-inductance approximation; lateral edge crowding, proximity effect, surface roughness and finite ground impedance remain outside this model.")
    const manifest = simulation_pcb_noise_manifest_json.parse(await buildRunManifest({
      run_id: options.run_id, experiment_id: config.simulation_experiment_id,
      configuration_id: config.simulation_pcb_noise_configuration_id, board_id: config.pcb_board_id, inputs,
      solver: { backend: `${provider}_exact_modal_fft`, version: "1", unit_adapter_version: "si_1",
        settings: json({ authored: settings, resolved_physical_model: model, copper, assumptions,
          extraction_runs: [...extractionRuns, expanded], extraction_cache_reused: Boolean(options.extraction_cache),
          extraction_cache_key_sha256: extractionCache.key_sha256, extraction_cache_data_sha256: extractionCache.data_sha256,
          transient_total: total.diagnostics, transient_sampling_refined: refined.diagnostics,
          ...(baseline ? { transient_baseline: baseline.diagnostics } : {}),
          ...(baselineRefined ? { transient_baseline_sampling_refined: baselineRefined.diagnostics } : {}), baseline_identity: baselineIdentity,
          eye_diagnostics: eyeDiagnostics, numerical_analysis: { extraction_grid_refinements: [1, 2, 4], eye_time_bins: 256,
            eye_voltage_bins: 128, network_passivity_tolerance: 1e-8, maximum_condition_number: 1e12,
            spectrum_parseval_relative_limit: 1e-10, source_minimum_samples_per_period_or_symbol: 32,
            sampling_refinement_band_hz: refined.diagnostics.bandwidth_hz }, residuals }),
      }, artifacts: assets.map((a) => manifestArtifact(a.path, a.descriptor)),
    }))
    const result = simulation_pcb_noise_result.parse({ ...identity, status: "completed",
      observation_names: config.observations.map((o) => o.name), model_tier: `${provider}_v1`,
      validity_band_hz: { min_hz: 0, max_hz: total.diagnostics.bandwidth_hz }, validation: { state: "validated", residuals },
      manifest_asset: await asset(manifest, "manifest.json"), network_asset: networkAsset, waveform_assets: waveformAssets,
      ...(eyeAssets.length ? { eye_assets: eyeAssets } : {}), spectrum_assets: spectrumAssets,
    })
    await validatePcbNoiseDecodedAssets(config, result, { manifest, network, waveforms, eyes, spectra })
    const output = [...circuitJson, result]
    validatePcbNoiseCircuitJson(output)
    return { result, circuit_json: output, assets, extraction_cache: extractionCache }
  } catch (error) {
    const problem = error instanceof RunProblem ? error : new RunProblem("failed", "simulation_failed", error instanceof Error ? error.message : String(error))
    const result = simulation_pcb_noise_result.parse({ ...identity, status: problem.status, diagnostics: [{ code: problem.code, message: problem.message }] })
    const output = [...circuitJson, result]
    validatePcbNoiseCircuitJson(output)
    return { result, circuit_json: output, assets: [], ...(verifiedExtractionCache ? { extraction_cache: verifiedExtractionCache } : {}) }
  }
}

async function resolveTiming(timing: NonNullable<SimulationPcbNoiseConfiguration["eyes"]>[number]["timing"], config: SimulationPcbNoiseConfiguration, waveforms: Waveform[], duration: number, step: number): Promise<EyeTiming> {
  if (timing.kind === "known_ui") return { kind: "known_ui", unit_interval_s: timing.unit_interval_s, sample_offset_s: timing.sample_offset_s, ...(timing.origin.kind === "authored_epoch" ? { epoch_s: timing.origin.epoch_s } : { training_interval_s: timing.origin.training_interval }) }
  if (timing.ui_per_selected_edge !== 1) throw new RunProblem("unsupported", "unsupported_clock_mapping", "The bounded provider requires one selected physical or authored clock event per symbol")
  let edges: number[], ui: number, clockHash: string | undefined
  if (timing.clock.kind === "authored_edges") {
    const sourceName = timing.clock.source_name
    const source = config.sources.find((s: { name: string; waveform: SourceWaveform }) => s.name === sourceName)!.waveform as SourceWaveform
    if (source.kind !== "prbs" || timing.edge !== "rising" || timing.interpretation !== "nominal_reference") throw new RunProblem("unsupported", "unsupported_authored_clock", "Authored symbol clock requires PRBS rising epoch events and nominal_reference interpretation")
    const clock = generateSymbolClock(source, 0, duration)
    edges = clock.times_s; ui = 1 / source.baud_rate_hz
  } else {
    const observationName = timing.clock.observation_name
    const clock = waveforms.find((w) => w.observation_name === observationName && w.variant === "total")!
    clockHash = await sha256(JSON.stringify(clock))
    const crossings = thresholdCrossings(clock, timing.threshold_v)
    edges = crossings.filter((e) => timing.edge === "both" || e.polarity === timing.edge).map((e) => e.time_s)
    if (edges.length < 3) throw new RunProblem("unsupported", "insufficient_clock_events", "Sampled explicit clock requires at least three selected clock crossings")
    const periods = edges.slice(1).map((edge, i) => edge - edges[i]!).sort((a, b) => a - b)
    ui = periods[Math.floor(periods.length / 2)]!
    if (ui < 32 * step) throw new RunProblem("unsupported", "undersampled_clock", "Explicit clock requires at least 32 samples per symbol")
  }
  return { kind: "explicit_clock", unit_interval_s: ui, clock_edges_s: edges, sample_offset_s: timing.sample_offset_s, edge_polarity: timing.edge, symbol_mapping: "one_edge_per_symbol", interpretation: timing.interpretation, clock_source: timing.clock, ...(clockHash ? { clock_waveform_sha256: clockHash } : {}) }
}
