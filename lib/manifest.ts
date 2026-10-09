import { canonicalPcbNoiseJson as canonicalJson, pcbNoiseSha256 as sha256 } from "circuit-json"
export { canonicalJson, sha256 }

/** Browser-safe provenance. Numeric canonicalization uses 12 significant digits
 * recursively; exact input-byte SHA256 is retained so rounding never hides edits. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export const CANONICALIZATION_VERSION = "sorted-json-significant-12-v1"
export const HASH_PATTERN = /^[a-f0-9]{64}$/

export interface InputDigest {
  sha256: string
  canonical_sha256: string
}

export interface ManifestArtifact {
  name: string
  data_format: string
  sha256: string
  encoded_sha256: string
  canonical_sha256: string
  byte_length: number
  decoded_byte_length: number
}

export interface NoiseRunManifest {
  format: "simulation_pcb_noise_manifest_json_v1"
  run_id: string
  experiment_id: string
  configuration_id: string
  board_id: string
  canonicalization: typeof CANONICALIZATION_VERSION
  inputs: Record<"geometry" | "configuration" | "sources" | "loads", InputDigest>
  resolved_inputs: Record<"geometry" | "configuration" | "sources" | "loads", JsonValue>
  solver: { backend: string; version: string; unit_adapter_version: string; settings: JsonValue }
  artifacts: ManifestArtifact[]
}

export interface ManifestInput {
  value: JsonValue
  /** Original bytes of the authored input, before parsing or normalization. */
  originalBytes?: Uint8Array | string
}

export async function computeInputDigest(input: ManifestInput): Promise<InputDigest> {
  const canonical = canonicalJson(input.value)
  const original = input.originalBytes ?? JSON.stringify(input.value)
  const originalText = typeof original === "string" ? original : new TextDecoder("utf-8", { fatal: true }).decode(original)
  if (canonicalJson(JSON.parse(originalText)) !== canonical) throw new Error("Original bytes do not match resolved input")
  return { sha256: await sha256(original), canonical_sha256: await sha256(canonical) }
}

export interface BuildManifestOptions {
  run_id: string
  experiment_id: string
  configuration_id: string
  board_id: string
  inputs: Record<"geometry" | "configuration" | "sources" | "loads", ManifestInput>
  solver: NoiseRunManifest["solver"]
  artifacts?: ManifestArtifact[]
}

const inputNames = ["geometry", "configuration", "sources", "loads"] as const

export async function buildRunManifest(options: BuildManifestOptions): Promise<NoiseRunManifest> {
  canonicalJson(options.solver)
  canonicalJson(options.artifacts ?? [])
  const digests = await Promise.all(inputNames.map(async (name) => {
    const input = options.inputs[name]
    return [name, await computeInputDigest(input)] as const
  }))
  const manifest: NoiseRunManifest = {
    format: "simulation_pcb_noise_manifest_json_v1",
    run_id: options.run_id,
    experiment_id: options.experiment_id,
    configuration_id: options.configuration_id,
    board_id: options.board_id,
    canonicalization: CANONICALIZATION_VERSION,
    inputs: Object.fromEntries(digests) as NoiseRunManifest["inputs"],
    // Copy the complete inputs without rounding the persisted original values.
    resolved_inputs: JSON.parse(JSON.stringify(Object.fromEntries(inputNames.map((name) => [name, options.inputs[name].value])))),
    solver: JSON.parse(JSON.stringify(options.solver)),
    artifacts: JSON.parse(JSON.stringify(options.artifacts ?? [])),
  }
  validateNoiseManifest(manifest)
  return manifest
}

export interface ExpectedInputHashes {
  expectedRunId?: string
  expectedExperimentId?: string
  expectedConfigurationId?: string
  expectedBoardId?: string
  expectedGeometryHash?: string
  expectedConfigHash?: string
  expectedSourcesHash?: string
  expectedLoadsHash?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new Error(`${label} must be a nonempty string`)
}
function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA256`)
}
function allowed(value: Record<string, unknown>, keys: string[], label: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra) throw new Error(`Unknown ${label} field ${extra}`)
}

export function validateNoiseManifest(value: unknown, expected: ExpectedInputHashes = {}): NoiseRunManifest {
  const manifest = object(value, "Manifest")
  allowed(manifest, ["format", "run_id", "experiment_id", "configuration_id", "board_id", "canonicalization", "inputs", "resolved_inputs", "solver", "artifacts"], "manifest")
  if (manifest.format !== "simulation_pcb_noise_manifest_json_v1") throw new Error("Unsupported noise manifest format")
  if (manifest.canonicalization !== CANONICALIZATION_VERSION) throw new Error("Unsupported canonicalization version")
  for (const key of ["run_id", "experiment_id", "configuration_id", "board_id"]) nonempty(manifest[key], key)
  for (const [key, wanted] of [["run_id", expected.expectedRunId], ["experiment_id", expected.expectedExperimentId], ["configuration_id", expected.expectedConfigurationId], ["board_id", expected.expectedBoardId]] as const) {
    if (wanted !== undefined && manifest[key] !== wanted) throw new Error(`Stale manifest: ${key} mismatch`)
  }
  const inputs = object(manifest.inputs, "Manifest inputs")
  const resolved = object(manifest.resolved_inputs, "Resolved inputs")
  allowed(inputs, [...inputNames], "manifest inputs")
  allowed(resolved, [...inputNames], "resolved inputs")
  const expectedHashes = [expected.expectedGeometryHash, expected.expectedConfigHash, expected.expectedSourcesHash, expected.expectedLoadsHash]
  inputNames.forEach((name, index) => {
    const digest = object(inputs[name], `${name} digest`)
    allowed(digest, ["sha256", "canonical_sha256"], `${name} digest`)
    hash(digest.sha256, `${name}.sha256`)
    hash(digest.canonical_sha256, `${name}.canonical_sha256`)
    if (!(name in resolved)) throw new Error(`Missing resolved ${name} input`)
    canonicalJson(resolved[name])
    if (expectedHashes[index] !== undefined && digest.sha256 !== expectedHashes[index]) throw new Error(`Stale manifest: ${name} hash mismatch`)
  })
  const solver = object(manifest.solver, "Solver")
  allowed(solver, ["backend", "version", "unit_adapter_version", "settings"], "solver")
  for (const key of ["backend", "version", "unit_adapter_version"]) nonempty(solver[key], `solver.${key}`)
  canonicalJson(solver.settings)
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 1024) throw new Error("Manifest artifacts must be a bounded array")
  const names = new Set<string>()
  for (const entry of manifest.artifacts) {
    const artifact = object(entry, "Artifact")
    allowed(artifact, ["name", "data_format", "sha256", "encoded_sha256", "canonical_sha256", "byte_length", "decoded_byte_length"], "artifact")
    nonempty(artifact.name, "Artifact name")
    if (names.has(artifact.name)) throw new Error("Duplicate manifest artifact name")
    names.add(artifact.name)
    nonempty(artifact.data_format, "Artifact format")
    for (const key of ["sha256", "encoded_sha256", "canonical_sha256"]) hash(artifact[key], `Artifact ${key}`)
    for (const key of ["byte_length", "decoded_byte_length"]) if (!Number.isSafeInteger(artifact[key]) || (artifact[key] as number) < 1) throw new Error(`Invalid artifact ${key}`)
  }
  return value as NoiseRunManifest
}

/** Recompute nested digests instead of trusting a self-reported manifest. */
export async function verifyNoiseManifest(value: unknown, expected: ExpectedInputHashes = {}): Promise<NoiseRunManifest> {
  const manifest = validateNoiseManifest(value, expected)
  for (const name of inputNames) {
    if (await sha256(canonicalJson(manifest.resolved_inputs[name])) !== manifest.inputs[name].canonical_sha256) throw new Error(`Manifest ${name} canonical hash mismatch`)
  }
  return manifest
}
