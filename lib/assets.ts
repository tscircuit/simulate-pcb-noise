import { canonicalJson, HASH_PATTERN, sha256, validateNoiseManifest, verifyNoiseManifest, type ExpectedInputHashes, type ManifestArtifact } from "./manifest"
import { validateWaveform, type Waveform } from "./waveform"

export const NOISE_ASSET_FORMATS = ["manifest", "network", "waveform", "eye", "spectrum"].map((kind) => `simulation_pcb_noise_${kind}_json_v1`)
export type NoiseAssetFormat = `simulation_pcb_noise_${"manifest" | "network" | "waveform" | "eye" | "spectrum"}_json_v1`
export interface NoiseAssetDescriptor {
  asset: { project_relative_path: string; url: string; mimetype: "application/json" | "application/gzip" }
  /** Exact decoded JSON bytes; independent from encoded bytes and canonical JSON. */
  sha256: string
  encoded_sha256: string
  canonical_sha256: string
  byte_length: number
  decoded_byte_length: number
  data_format: NoiseAssetFormat
}
export interface AssetLimits {
  compressedBytes: number
  decodedBytes: number
  samples: number
  channels: number
  ports: number
  frequencies: number
  eyeTimeBins: number
  eyeVoltageBins: number
}
export const DEFAULT_ASSET_LIMITS: Readonly<AssetLimits> = Object.freeze({
  compressedBytes: 2 * 1024 * 1024, decodedBytes: 16 * 1024 * 1024,
  samples: 100_000, channels: 4, ports: 32, frequencies: 100_000,
  eyeTimeBins: 512, eyeVoltageBins: 256,
})
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

function limitsWith(overrides?: Partial<AssetLimits>): AssetLimits {
  const limits = { ...DEFAULT_ASSET_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid asset limit ${name}`)
  return limits
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error(`Invalid ${label}`)
}
function number(value: unknown, label: string, positive = false): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) throw new Error(`${label} must be a finite${positive ? " positive" : ""} number`)
}
function count(value: unknown, label: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${label} exceeds the allowed count or is invalid`)
}
function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`Invalid ${label} SHA256`)
}
function finiteArray(value: unknown, label: string, max: number): asserts value is number[] {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) throw new Error(`Invalid ${label} array or count limit exceeded`)
}
function allowed(value: Record<string, unknown>, keys: string[], label: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra) throw new Error(`Unknown ${label} field ${extra}`)
}
function intervals(value: unknown, label: string, max: number) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label} intervals`)
  let previous = -Infinity
  for (const entry of value) {
    const interval = record(entry, `${label} interval`)
    allowed(interval, ["start_s", "end_s"], `${label} interval`)
    number(interval.start_s, `${label} start`)
    number(interval.end_s, `${label} end`)
    if (interval.start_s < previous || interval.end_s <= interval.start_s) throw new Error(`Invalid ordered ${label} interval`)
    previous = interval.end_s
  }
}

export function validateNoiseAssetDescriptor(value: unknown, overrides?: Partial<AssetLimits>): NoiseAssetDescriptor {
  const limits = limitsWith(overrides)
  const descriptor = record(value, "Asset descriptor")
  const asset = record(descriptor.asset, "Asset")
  allowed(descriptor, ["asset", "sha256", "encoded_sha256", "canonical_sha256", "byte_length", "decoded_byte_length", "data_format"], "asset descriptor")
  allowed(asset, ["project_relative_path", "url", "mimetype"], "asset")
  string(asset.url, "asset URL")
  try { new URL(asset.url) } catch { throw new Error("Asset URL must be absolute; external loading requires an explicit resolver") }
  string(asset.project_relative_path, "project relative path")
  if (asset.project_relative_path.startsWith("/") || asset.project_relative_path.split(/[\\/]/).some((part) => part === "..")) throw new Error("Asset path must stay project relative")
  if (!["application/json", "application/gzip"].includes(String(asset.mimetype))) throw new Error("Unsupported asset MIME")
  if (!NOISE_ASSET_FORMATS.includes(String(descriptor.data_format))) throw new Error("Unsupported noise asset format/version")
  for (const key of ["sha256", "encoded_sha256", "canonical_sha256"]) hash(descriptor[key], key)
  count(descriptor.byte_length, "Encoded asset bytes", asset.mimetype === "application/gzip" ? limits.compressedBytes : limits.decodedBytes)
  count(descriptor.decoded_byte_length, "Decoded asset bytes", limits.decodedBytes)
  if (asset.mimetype === "application/json" && descriptor.byte_length !== descriptor.decoded_byte_length) throw new Error("Plain JSON asset lengths must match")
  if (asset.url.startsWith("data:") && !asset.url.startsWith(`data:${asset.mimetype};base64,`)) throw new Error("Data URL MIME/encoding must match asset MIME")
  return value as NoiseAssetDescriptor
}

/** Validate full resolution data before plotting or allocating expanded arrays. */
export function validateNoisePayload(value: unknown, expectedFormat: NoiseAssetFormat, overrides?: Partial<AssetLimits>): Record<string, unknown> {
  const limits = limitsWith(overrides)
  const data = record(value, "Noise payload")
  if (data.format !== expectedFormat || !NOISE_ASSET_FORMATS.includes(expectedFormat)) throw new Error("Noise asset format/version mismatch")
  string(data.run_id, "run ID")
  if (expectedFormat.endsWith("waveform_json_v1")) {
    allowed(data, ["format", "run_id", "observation_name", "unit", "variant", "time", "values", "valid_intervals_s", "bandwidth_hz", "input_sha256", "source_sha256", "full_resolution", "comparison_identity"], "waveform")
    const time = record(data.time, "Waveform time")
    allowed(time, time.kind === "uniform" ? ["kind", "start_s", "step_s", "count"] : ["kind", "times_s"], "waveform time")
    intervals(data.valid_intervals_s, "Waveform valid", limits.samples)
    if (data.comparison_identity !== undefined) string(data.comparison_identity, "Waveform comparison identity")
    string(data.observation_name, "Waveform observation")
    hash(data.input_sha256, "Waveform input")
    hash(data.source_sha256, "Waveform source")
    validateWaveform(data as unknown as Waveform, { max_samples: limits.samples })
  } else if (expectedFormat.endsWith("network_json_v1")) {
    validateNetwork(data, limits)
  } else if (expectedFormat.endsWith("eye_json_v1")) {
    validateEye(data, limits)
  } else if (expectedFormat.endsWith("spectrum_json_v1")) {
    validateSpectrum(data, limits)
  } else if (expectedFormat.endsWith("manifest_json_v1")) {
    validateNoiseManifest(data)
  }
  // Array counts/dimensions are checked first, before recursive canonical copies.
  canonicalJson(data) // rejects nonfinite numbers, non-JSON values, cycles, and excessive depth
  return data
}

function validateNetwork(data: Record<string, unknown>, limits: AssetLimits) {
  allowed(data, ["format", "run_id", "input_sha256", "model_sha256", "ports", "frequencies_hz", "representation", "matrix_units", "matrices", "phasor_convention", "current_sign_convention", "dc", "extraction"], "network")
  hash(data.input_sha256, "Network input")
  hash(data.model_sha256, "Network model")
  if (!["s", "y", "z"].includes(String(data.representation)) || data.matrix_units !== ({ s: "dimensionless", y: "S", z: "ohm" } as Record<string, string>)[String(data.representation)]) throw new Error("Network representation/units mismatch")
  if (data.phasor_convention !== "exp_positive_j_omega_t" || data.current_sign_convention !== "into_pcb") throw new Error("Unsupported network phasor/current convention")
  // Contract-specific matrix/port checks below also guard the n²*f memory product.
  if (!Array.isArray(data.ports) || !data.ports.length || data.ports.length > limits.ports) throw new Error("Network port count exceeds the limit or is invalid")
  finiteArray(data.frequencies_hz, "Network frequencies", limits.frequencies)
  if (data.frequencies_hz.some((frequency, i, values) => frequency < 0 || (i > 0 && frequency <= values[i - 1]!))) throw new Error("Network frequencies must be sorted and nonnegative")
  const names = new Set<string>()
  for (const entry of data.ports) {
    const port = record(entry, "Network port")
    allowed(port, ["port_name", "signal_contact", "reference_contact", "reference_impedance_ohms", "reference_plane", "polarity"], "network port")
    string(port.port_name, "Network port name")
    if (names.has(port.port_name)) throw new Error("Network port names must be unique")
    names.add(port.port_name)
    number(port.reference_impedance_ohms, "Network reference impedance", true)
    string(port.reference_plane, "Network reference plane")
    if (port.polarity !== "signal_minus_reference") throw new Error("Unsupported port polarity")
    for (const key of ["signal_contact", "reference_contact"]) {
      const contact = record(port[key], "Physical contact")
      const idKey = `${contact.contact_type}_id`
      if (!["pcb_port", "pcb_via", "pcb_copper_pour"].includes(String(contact.contact_type))) throw new Error("Invalid physical contact type")
      allowed(contact, ["contact_type", "x", "y", "layer", idKey], "physical contact")
      number(contact.x, "Contact x")
      number(contact.y, "Contact y")
      string(contact[idKey], "Contact ID")
      if (!["top", "bottom", "inner1", "inner2", "inner3", "inner4", "inner5", "inner6", "inner7", "inner8"].includes(String(contact.layer))) throw new Error("Invalid physical contact layer")
    }
  }
  const n = data.ports.length
  if (data.frequencies_hz.length * n * n > Math.floor(limits.decodedBytes / 16)) throw new Error("Complex network storage exceeds the decoded resource budget")
  if (!Array.isArray(data.matrices) || data.matrices.length !== data.frequencies_hz.length) throw new Error("Network matrix frequency dimensions mismatch")
  for (const slice of data.matrices) {
    if (!Array.isArray(slice) || slice.length !== n) throw new Error("Network matrix port dimensions mismatch")
    for (const row of slice) {
      if (!Array.isArray(row) || row.length !== n) throw new Error("Network matrix must be square with all ordered ports")
      for (const entry of row) {
        const complex = record(entry, "Complex matrix entry")
        allowed(complex, ["real", "imag"], "complex matrix entry")
        number(complex.real, "Matrix real component")
        number(complex.imag, "Matrix imaginary component")
      }
    }
  }
  const dc = record(data.dc, "Network DC")
  allowed(dc, dc.kind === "included" ? ["kind"] : ["kind", "reason"], "network DC")
  if (dc.kind === "included") {
    if (data.frequencies_hz[0] !== 0) throw new Error("Included DC requires a zero-frequency endpoint")
    if (data.matrices[0].some((row: { imag: number }[]) => row.some((entry) => entry.imag !== 0))) throw new Error("Network DC must be real")
  } else if (dc.kind === "unavailable") {
    string(dc.reason, "Unavailable DC reason")
    if (data.frequencies_hz[0] === 0) throw new Error("DC endpoint conflicts with unavailable DC")
  } else throw new Error("Network requires explicit DC status")
  const extraction = record(data.extraction, "Network extraction")
  allowed(extraction, ["provider", "version", "normalization"], "network extraction")
  for (const key of ["provider", "version", "normalization"]) string(extraction[key], `Network extraction ${key}`)
}

function validateEye(data: Record<string, unknown>, limits: AssetLimits) {
  allowed(data, ["format", "run_id", "observation_name", "waveform_sha256", "timing_sha256", "modulation", "unit_interval_s", "extent_ui", "time_bins", "voltage_bins", "min_voltage_v", "max_voltage_v", "counts", "complete_window_count", "transition_count", "excluded_intervals_s", "resolved_timing", "metrics", "metric_definitions"], "eye")
  string(data.observation_name, "Eye observation")
  hash(data.waveform_sha256, "Eye waveform")
  hash(data.timing_sha256, "Eye timing")
  if (data.modulation !== "nrz" || data.extent_ui !== 2) throw new Error("Unsupported eye modulation/extent")
  count(data.time_bins, "Eye time bins", limits.eyeTimeBins)
  count(data.voltage_bins, "Eye voltage bins", limits.eyeVoltageBins)
  if (!Array.isArray(data.counts) || data.counts.length !== data.time_bins * data.voltage_bins || data.counts.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) || !data.counts.some((entry) => entry > 0)) throw new Error("Eye weighted bin counts must be finite nonnegative values with exact dimensions and captured samples")
  number(data.unit_interval_s, "Eye UI", true)
  number(data.min_voltage_v, "Eye minimum voltage")
  number(data.max_voltage_v, "Eye maximum voltage")
  if (data.max_voltage_v <= data.min_voltage_v) throw new Error("Eye voltage range must be increasing")
  count(data.complete_window_count, "Eye complete windows", Number.MAX_SAFE_INTEGER)
  if (data.complete_window_count < 64) throw new Error("Eye requires at least 64 complete windows")
  if (!Number.isSafeInteger(data.transition_count) || (data.transition_count as number) < 0) throw new Error("Invalid eye transition count")
  intervals(data.excluded_intervals_s, "Eye excluded", limits.samples)
  const timing = record(data.resolved_timing, "Resolved eye timing")
  allowed(timing, timing.kind === "known_ui" ? ["kind", "unit_interval_s", "epoch_s", "sample_offset_s"] : ["kind", "unit_interval_s", "epoch_s", "sample_offset_s", "clock_edges_s", "edge_polarity", "symbol_mapping", "interpretation", "clock_source", "clock_waveform_sha256"], "resolved timing")
  if (!["known_ui", "explicit_clock"].includes(String(timing.kind))) throw new Error("Unsupported eye timing mode")
  number(timing.unit_interval_s, "Resolved UI", true)
  if (timing.kind === "known_ui" || timing.epoch_s !== undefined) number(timing.epoch_s, "Resolved epoch")
  number(timing.sample_offset_s, "Resolved sample offset")
  if (timing.unit_interval_s !== data.unit_interval_s) throw new Error("Resolved and eye UI mismatch")
  if (timing.sample_offset_s < 0 || timing.sample_offset_s >= data.unit_interval_s) throw new Error("Eye sample offset must lie in one UI")
  if (timing.kind === "explicit_clock") {
    finiteArray(timing.clock_edges_s, "Resolved clock edges", limits.samples)
    if (timing.clock_edges_s.some((edge, i, edges) => i > 0 && edge <= edges[i - 1]!)) throw new Error("Clock edges must be strictly increasing")
    if (!["rising", "falling", "both"].includes(String(timing.edge_polarity)) || timing.symbol_mapping !== "one_edge_per_symbol") throw new Error("Invalid resolved clock mapping")
    if (!["actual_receiver_clock", "nominal_reference"].includes(String(timing.interpretation))) throw new Error("Explicit clock requires declared timing interpretation")
    const source = record(timing.clock_source, "Clock source")
    if (source.kind === "authored_edges") {
      allowed(source, ["kind", "source_name"], "authored clock source")
      string(source.source_name, "Authored clock source name")
      if (timing.interpretation !== "nominal_reference") throw new Error("Authored edges require nominal-reference timing")
    } else if (source.kind === "observation") {
      allowed(source, ["kind", "observation_name"], "observed clock source")
      string(source.observation_name, "Clock observation name")
      if (source.observation_name === data.observation_name) throw new Error("Clock observation must be independent from data")
    } else throw new Error("Unsupported explicit clock source")
    if (timing.clock_waveform_sha256 !== undefined) {
      hash(timing.clock_waveform_sha256, "Clock waveform")
      if (timing.clock_waveform_sha256 === data.waveform_sha256) throw new Error("Clock waveform must be independent from data")
    }
  }
  const metrics = record(data.metrics, "Eye metrics")
  allowed(metrics, ["eye_height_v", "eye_width_s", "jitter_rms_s", "jitter_peak_to_peak_s", "offset_s", "tie_rms_s"], "eye metrics")
  for (const [key, value] of Object.entries(metrics)) { number(value, key); if (key !== "offset_s" && value < 0) throw new Error("Eye magnitudes must be nonnegative") }
  if (data.metric_definitions !== undefined) {
    const definitions = record(data.metric_definitions, "Metric definitions")
    for (const value of Object.values(definitions)) string(value, "Metric definition")
  }
}

function validateSpectrum(data: Record<string, unknown>, limits: AssetLimits) {
  allowed(data, ["format", "run_id", "observation_name", "waveform_sha256", "frequencies_hz", "values", "kind", "unit", "sidedness", "window", "coherent_gain", "enbw_hz", "dc_treatment", "fft_length", "sample_rate_hz", "integrated_power", "windowed_mean_square", "parseval_relative_error"], "spectrum")
  string(data.observation_name, "Spectrum observation")
  hash(data.waveform_sha256, "Spectrum waveform")
  finiteArray(data.frequencies_hz, "Spectrum frequencies", limits.samples)
  if (data.frequencies_hz.some((frequency, i, values) => (data.sidedness === "one_sided" && frequency < 0) || (i > 0 && frequency <= values[i - 1]!))) throw new Error("Spectrum frequencies must be increasing with the declared sidedness")
  const values = data.values
  finiteArray(values, "Spectrum values", limits.samples)
  if (values.length !== data.frequencies_hz.length || values.some((value) => value < 0)) throw new Error("Spectrum values must match frequency count and be nonnegative")
  if (!["psd", "amplitude_peak", "amplitude_rms"].includes(String(data.kind)) || !["one_sided", "two_sided"].includes(String(data.sidedness)) || !["rectangular", "hann"].includes(String(data.window)) || !["included", "mean_removed"].includes(String(data.dc_treatment))) throw new Error("Unsupported spectrum normalization metadata")
  if (!(data.kind === "psd" ? ["V^2/Hz", "A^2/Hz"] : ["V", "A"]).includes(String(data.unit))) throw new Error("Spectrum unit/quantity mismatch")
  count(data.fft_length, "Spectrum FFT length", 2 * limits.samples)
  if (data.fft_length < 2) throw new Error("Spectrum FFT length must be at least two")
  for (const key of ["coherent_gain", "enbw_hz", "sample_rate_hz"]) number(data[key], key, true)
  for (const key of ["integrated_power", "windowed_mean_square", "parseval_relative_error"]) { number(data[key], key); if ((data[key] as number) < 0) throw new Error(`Invalid negative ${key}`) }
  if (data.frequencies_hz.some((frequency) => Math.abs(frequency) > (data.sample_rate_hz as number) / 2)) throw new Error("Spectrum frequency exceeds Nyquist")
  const expectedCount = data.sidedness === "one_sided" ? Math.floor(data.fft_length / 2) + 1 : data.fft_length
  if (values.length !== expectedCount) throw new Error("Spectrum count must match FFT length and sidedness")
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(binary)
}
function embeddedBytes(descriptor: NoiseAssetDescriptor): Uint8Array {
  const encoded = descriptor.asset.url.slice(descriptor.asset.url.indexOf(",") + 1)
  // Check length before atob allocates the decoded byte buffer.
  const padding = (3 - descriptor.byte_length % 3) % 3
  const firstPadding = encoded.indexOf("=")
  if (encoded.length !== 4 * Math.ceil(descriptor.byte_length / 3) || /[^A-Za-z0-9+/=]/.test(encoded) ||
    (padding === 0 ? firstPadding !== -1 : firstPadding !== encoded.length - padding || !encoded.endsWith("=".repeat(padding)))) throw new Error("Invalid base64 asset length/encoding")
  const binary = atob(encoded)
  if (binary.length !== descriptor.byte_length) throw new Error("Encoded byte length mismatch")
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** Read streaming transforms with a hard cap, including gzip expansion bombs. */
async function readBounded(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > max) {
        await reader.cancel()
        throw new Error("Decoded asset exceeds byte limit")
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export interface LoadAssetOptions extends ExpectedInputHashes {
  /** External IO is always explicit. Return exact encoded bytes, never parsed data. */
  resolveAsset?: (asset: NoiseAssetDescriptor["asset"]) => Promise<Uint8Array | string>
  expectedObservationName?: string
  expectedInputHash?: string
  expectedSourceHash?: string
  expectedWaveformHash?: string
  limits?: Partial<AssetLimits>
  budget?: NoiseAssetBudget
}

/** Share a budget across selected concurrent loads; reservations are cumulative
 * for one render/analysis request because returned decoded data remains resident. */
export interface NoiseAssetBudget {
  reserve(descriptor: NoiseAssetDescriptor): void
  readonly compressedBytes: number
  readonly decodedBytes: number
  readonly channels: number
}
export function createNoiseAssetBudget(overrides?: Partial<AssetLimits>): NoiseAssetBudget {
  const limits = limitsWith(overrides)
  let compressedBytes = 0
  let decodedBytes = 0
  let channels = 0
  return {
    reserve(descriptor) {
      const compressed = descriptor.asset.mimetype === "application/gzip" ? descriptor.byte_length : 0
      const channel = descriptor.data_format === "simulation_pcb_noise_waveform_json_v1" ? 1 : 0
      if (compressedBytes + compressed > limits.compressedBytes || decodedBytes + descriptor.decoded_byte_length > limits.decodedBytes || channels + channel > limits.channels) throw new Error("Selected assets exceed the shared resource budget")
      compressedBytes += compressed
      decodedBytes += descriptor.decoded_byte_length
      channels += channel
    },
    get compressedBytes() { return compressedBytes },
    get decodedBytes() { return decodedBytes },
    get channels() { return channels },
  }
}

/** Loads only the requested asset; never fetches/filesystem-resolves implicitly. */
export async function loadNoiseAsset(value: unknown, options: LoadAssetOptions = {}): Promise<Record<string, unknown>> {
  const limits = limitsWith(options.limits)
  const descriptor = validateNoiseAssetDescriptor(value, limits)
  options.budget?.reserve(descriptor)
  let encoded: Uint8Array
  if (descriptor.asset.url.startsWith("data:")) encoded = embeddedBytes(descriptor)
  else {
    if (!options.resolveAsset) throw new Error("External asset requires an explicit resolver")
    const resolved = await options.resolveAsset(descriptor.asset)
    encoded = typeof resolved === "string" ? encoder.encode(resolved) : resolved
    if (!(encoded instanceof Uint8Array)) throw new Error("Asset resolver must return exact bytes or UTF8 text")
  }
  if (encoded.length !== descriptor.byte_length) throw new Error("Encoded byte length mismatch")
  if (await sha256(encoded) !== descriptor.encoded_sha256) throw new Error("Encoded asset SHA256 mismatch")
  let decoded: Uint8Array = encoded
  if (descriptor.asset.mimetype === "application/gzip") {
    const stream = new Blob([new Uint8Array(encoded).buffer]).stream().pipeThrough(new DecompressionStream("gzip"))
    decoded = await readBounded(stream, Math.min(limits.decodedBytes, descriptor.decoded_byte_length))
  }
  if (decoded.length !== descriptor.decoded_byte_length) throw new Error("Decoded byte length mismatch")
  if (await sha256(decoded) !== descriptor.sha256) throw new Error("Decoded asset SHA256 mismatch")
  const data = validateNoisePayload(JSON.parse(decoder.decode(decoded)), descriptor.data_format, limits)
  if (await sha256(canonicalJson(data)) !== descriptor.canonical_sha256) throw new Error("Canonical asset SHA256 mismatch")
  for (const [key, expected] of [["run_id", options.expectedRunId], ["observation_name", options.expectedObservationName], ["input_sha256", options.expectedInputHash], ["source_sha256", options.expectedSourceHash], ["waveform_sha256", options.expectedWaveformHash]] as const) {
    if (expected !== undefined && data[key] !== expected) throw new Error(`Stale asset: ${key} mismatch`)
  }
  if (descriptor.data_format === "simulation_pcb_noise_manifest_json_v1") await verifyNoiseManifest(data, options)
  return data
}

export async function createJsonAsset(payload: unknown, options: { projectRelativePath: string; mimetype?: "application/json" | "application/gzip"; limits?: Partial<AssetLimits> }): Promise<NoiseAssetDescriptor> {
  const data = record(payload, "Noise payload")
  const format = data.format as NoiseAssetFormat
  validateNoisePayload(payload, format, options.limits)
  if (format === "simulation_pcb_noise_manifest_json_v1") await verifyNoiseManifest(payload)
  const decoded = encoder.encode(JSON.stringify(payload))
  const limits = limitsWith(options.limits)
  if (decoded.length > limits.decodedBytes) throw new Error("Decoded asset exceeds byte limit")
  const mime = options.mimetype ?? "application/json"
  let encoded: Uint8Array = decoded
  if (mime === "application/gzip") {
    encoded = await readBounded(new Blob([decoded.buffer]).stream().pipeThrough(new CompressionStream("gzip")), limits.compressedBytes)
  }
  const descriptor: NoiseAssetDescriptor = {
    asset: { project_relative_path: options.projectRelativePath, url: `data:${mime};base64,${base64(encoded)}`, mimetype: mime },
    sha256: await sha256(decoded), encoded_sha256: await sha256(encoded), canonical_sha256: await sha256(canonicalJson(payload)),
    byte_length: encoded.length, decoded_byte_length: decoded.length, data_format: format,
  }
  return validateNoiseAssetDescriptor(descriptor, limits)
}

export type NoiseAssetLimits = AssetLimits
export type NoiseAssetLoadOptions = LoadAssetOptions
export const DEFAULT_NOISE_ASSET_LIMITS = DEFAULT_ASSET_LIMITS

export function manifestArtifact(name: string, descriptor: NoiseAssetDescriptor, limits?: Partial<AssetLimits>): ManifestArtifact {
  validateNoiseAssetDescriptor(descriptor, limits)
  return { name, data_format: descriptor.data_format, sha256: descriptor.sha256, encoded_sha256: descriptor.encoded_sha256, canonical_sha256: descriptor.canonical_sha256, byte_length: descriptor.byte_length, decoded_byte_length: descriptor.decoded_byte_length }
}

/** Run results are append-only; old runs and unrelated experiments retain identity. */
export function appendNoiseResult<T extends Record<string, unknown>>(circuitJson: T[], result: T): T[] {
  if (result.type !== "simulation_pcb_noise_result" || !["completed", "failed", "unsupported"].includes(String(result.status))) throw new Error("Only a noise result may be appended")
  string(result.run_id, "Run ID")
  string(result.simulation_pcb_noise_result_id, "Noise result ID")
  if (circuitJson.some((record) => record.type === "simulation_pcb_noise_result" && (record.run_id === result.run_id || record.simulation_pcb_noise_result_id === result.simulation_pcb_noise_result_id))) throw new Error("Immutable noise run/result already exists")
  if (!circuitJson.some((record) => record.type === "simulation_experiment" && record.simulation_experiment_id === result.simulation_experiment_id && record.experiment_type === "pcb_noise")) throw new Error("Noise result refers to a missing experiment")
  if (!circuitJson.some((record) => record.type === "simulation_pcb_noise_configuration" && record.simulation_pcb_noise_configuration_id === result.simulation_pcb_noise_configuration_id && record.simulation_experiment_id === result.simulation_experiment_id && record.pcb_board_id === result.pcb_board_id)) throw new Error("Noise result configuration ownership mismatch")
  return [...circuitJson, result]
}
