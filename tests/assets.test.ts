import { describe, expect, test } from "bun:test"
import { appendNoiseResult, createJsonAsset, createNoiseAssetBudget, loadNoiseAsset, manifestArtifact, validateNoiseAssetDescriptor, validateNoisePayload, type NoiseAssetDescriptor } from "../lib/assets"
import { buildRunManifest, canonicalJson, computeInputDigest, sha256, verifyNoiseManifest } from "../lib/manifest"
import type { Waveform } from "../lib/waveform"

const zeroHash = "0".repeat(64)
function waveform(): Waveform {
  return {
    format: "simulation_pcb_noise_waveform_json_v1", run_id: "run-one", observation_name: "victim_far",
    unit: "V", variant: "total", full_resolution: true,
    time: { kind: "uniform", start_s: 0, step_s: 1e-11, count: 4 },
    values: [0, 0.25, 0.5, 0.1], valid_intervals_s: [{ start_s: 0, end_s: 3e-11 }],
    bandwidth_hz: 1e9, input_sha256: zeroHash, source_sha256: zeroHash,
  }
}
const contact = (id: string) => ({ contact_type: "pcb_port", pcb_port_id: id, x: 0, y: 0, layer: "top" })
function network() {
  return {
    format: "simulation_pcb_noise_network_json_v1" as const, run_id: "run-one", input_sha256: zeroHash, model_sha256: zeroHash,
    ports: ["near", "far"].map((name) => ({ port_name: name, signal_contact: contact(`${name}-signal`), reference_contact: contact(`${name}-ground`), reference_impedance_ohms: 50, reference_plane: "pad", polarity: "signal_minus_reference" })),
    frequencies_hz: [0, 1e9], representation: "s", matrix_units: "dimensionless",
    matrices: [[[{ real: 0, imag: 0 }, { real: 1, imag: 0 }], [{ real: 1, imag: 0 }, { real: 0, imag: 0 }]], [[{ real: 0, imag: 0 }, { real: 0, imag: -1 }], [{ real: 0, imag: -1 }, { real: 0, imag: 0 }]]],
    phasor_convention: "exp_positive_j_omega_t", current_sign_convention: "into_pcb", dc: { kind: "included" },
    extraction: { provider: "analytic", version: "1", normalization: "power_waves_real_positive_z0" },
  }
}
async function manifest() {
  return buildRunManifest({
    run_id: "run-one", experiment_id: "experiment-one", configuration_id: "configuration-one", board_id: "board-one",
    inputs: {
      geometry: { value: { pads: [{ x_mm: 1, y_mm: 2, rotation: 0 }], copper: { thickness_m: 35e-6, conductivity_s_m: 5.8e7 } } },
      configuration: { value: { name: "coupled", sample_interval_s: 1e-11 } },
      sources: { value: [{ name: "aggressor", seed: 9, high_voltage_v: 1 }] },
      loads: { value: [{ resistance_ohms: 50 }] },
    },
    solver: { backend: "coupled_line", version: "1", unit_adapter_version: "SI-v1", settings: { modes: ["even", "odd"], reference: "ideal_ground" } },
  })
}

describe("canonical input provenance", () => {
  test("recursively normalizes portable floats without losing original input bytes", async () => {
    const first = { z: [-0, 1e12], a: { y: 1.23456789012345, x: Math.sin(Math.PI / 3) } }
    const second = { a: { x: 0.8660254037844387, y: 1.23456789012344 }, z: [0, 1e12] }
    const expected = '{"a":{"x":0.866025403784,"y":1.23456789012},"z":[0,1000000000000]}'
    expect(canonicalJson(first)).toBe(expected)
    expect(canonicalJson(second)).toBe(expected)
    const [a, b] = await Promise.all([computeInputDigest({ value: first }), computeInputDigest({ value: second })])
    expect(a.canonical_sha256).toBe(b.canonical_sha256)
    expect(a.sha256).not.toBe(b.sha256)
    expect(await sha256(expected)).toBe(new Bun.CryptoHasher("sha256").update(expected).digest("hex"))
    expect(canonicalJson({ x: Number.MAX_VALUE })).toBe('{"x":1.79769313486e+308}')
  })
  test("uses real SHA256 and rejects non-JSON and mismatched original bytes", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(() => canonicalJson({ hidden: undefined })).toThrow("JSON values")
    expect(() => canonicalJson({ material: { loss: Infinity } })).toThrow("finite")
    expect(() => canonicalJson(new Date())).toThrow("plain objects")
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => canonicalJson(cycle)).toThrow("cycles")
    await expect(computeInputDigest({ value: { width: 1 }, originalBytes: '{"width":2}' })).rejects.toThrow("do not match")
  })
  test("recomputes complete nested hashes and rejects stale geometry, seeds and configs", async () => {
    const original = await manifest()
    await expect(verifyNoiseManifest(original, { expectedRunId: "run-one", expectedGeometryHash: original.inputs.geometry.sha256 })).resolves.toBe(original)
    for (const key of ["expectedGeometryHash", "expectedConfigHash", "expectedSourcesHash", "expectedLoadsHash"] as const) {
      await expect(verifyNoiseManifest(original, { [key]: "f".repeat(64) })).rejects.toThrow("Stale manifest")
    }
    const altered = structuredClone(original)
    ;(altered.resolved_inputs.geometry as { pads: { x_mm: number }[] }).pads[0]!.x_mm = 1.1
    await expect(verifyNoiseManifest(altered)).rejects.toThrow("geometry canonical hash mismatch")
    const sourceAltered = structuredClone(original)
    ;(sourceAltered.resolved_inputs.sources as { seed: number }[])[0]!.seed = 10
    await expect(verifyNoiseManifest(sourceAltered)).rejects.toThrow("sources canonical hash mismatch")
  })
})

describe("bounded browser asset transport", () => {
  test("embedded JSON and streamed gzip yield identical full-resolution data", async () => {
    const full = waveform()
    const [plain, compressed] = await Promise.all([
      createJsonAsset(full, { projectRelativePath: "runs/run-one/victim.json" }),
      createJsonAsset(full, { projectRelativePath: "runs/run-one/victim.json.gz", mimetype: "application/gzip" }),
    ])
    expect(plain.sha256).toBe(compressed.sha256)
    expect(plain.canonical_sha256).toBe(compressed.canonical_sha256)
    expect(compressed.encoded_sha256).not.toBe(compressed.sha256)
    expect(await loadNoiseAsset(plain)).toEqual(full)
    expect(await loadNoiseAsset(compressed)).toEqual(full)
    expect(full.time).toEqual({ kind: "uniform", start_s: 0, step_s: 1e-11, count: 4 })
  })
  test("loads only the selected external asset through explicit resolution", async () => {
    const full = waveform()
    const embedded = await createJsonAsset(full, { projectRelativePath: "runs/one.json" })
    const selected = { ...embedded, asset: { ...embedded.asset, url: "https://example.com/selected.json" } }
    const unselected = { ...embedded, asset: { ...embedded.asset, url: "https://example.com/never-read.json" } }
    const calls: string[] = []
    const resolveAsset = async (asset: NoiseAssetDescriptor["asset"]) => {
      calls.push(asset.url)
      if (asset.url !== selected.asset.url) throw new Error("Unselected asset was requested")
      return JSON.stringify(full)
    }
    await expect(loadNoiseAsset(selected)).rejects.toThrow("explicit resolver")
    expect(await loadNoiseAsset([selected, unselected][0], { resolveAsset })).toEqual(full)
    expect(calls).toEqual([selected.asset.url])
  })
  test("exact encoded, decoded and canonical hashes all independently reject tampering", async () => {
    const original = await createJsonAsset(waveform(), { projectRelativePath: "one.json" })
    for (const key of ["sha256", "encoded_sha256", "canonical_sha256"] as const) {
      await expect(loadNoiseAsset({ ...original, [key]: "f".repeat(64) })).rejects.toThrow("SHA256 mismatch")
    }
    const changed = waveform(); changed.values[1] = 0.35
    const freshBytes = await createJsonAsset(changed, { projectRelativePath: "one.json" })
    await expect(loadNoiseAsset({ ...original, asset: freshBytes.asset })).rejects.toThrow("Encoded asset SHA256 mismatch")
    await expect(loadNoiseAsset(original, { expectedRunId: "another-run" })).rejects.toThrow("run_id mismatch")
    await expect(loadNoiseAsset(original, { expectedObservationName: "victim_near" })).rejects.toThrow("observation_name mismatch")
    await expect(loadNoiseAsset(original, { expectedSourceHash: "a".repeat(64) })).rejects.toThrow("source_sha256 mismatch")
  })
  test("rejects format, MIME, byte-count and sample-count errors before display", async () => {
    const original = await createJsonAsset(waveform(), { projectRelativePath: "one.json" })
    expect(() => validateNoiseAssetDescriptor({ ...original, data_format: "simulation_pcb_noise_waveform_json_v2" })).toThrow("version")
    expect(() => validateNoiseAssetDescriptor({ ...original, asset: { ...original.asset, url: "relative.json" } })).toThrow("absolute")
    expect(() => validateNoiseAssetDescriptor({ ...original, asset: { ...original.asset, mimetype: "application/gzip" } })).toThrow("MIME")
    expect(() => validateNoiseAssetDescriptor({ ...original, asset: { ...original.asset, project_relative_path: "../escape.json" } })).toThrow("project relative")
    await expect(loadNoiseAsset({ ...original, byte_length: original.byte_length + 1, decoded_byte_length: original.decoded_byte_length + 1 })).rejects.toThrow("length")
    let calls = 0
    await expect(loadNoiseAsset({ ...original, asset: { ...original.asset, url: "https://example.com/large" } }, { limits: { decodedBytes: 4 }, resolveAsset: async () => { calls++; return "" } })).rejects.toThrow("count")
    expect(calls).toBe(0)
    await expect(loadNoiseAsset(original, { limits: { samples: 3 } })).rejects.toThrow("sample limit")
    const malformed = waveform(); malformed.time = { kind: "uniform", start_s: 0, step_s: 1, count: 1_000_000_000 }
    expect(() => validateNoisePayload(malformed, malformed.format)).toThrow("uniform time axis")
    const missingValues = waveform(); missingValues.values.pop()
    expect(() => validateNoisePayload(missingValues, missingValues.format)).toThrow("uniform time axis")
  })
  test("streaming gzip expansion is capped even when descriptor lies about decoded length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ padding: "x".repeat(50_000) }))
    const gzip = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())
    const descriptor: NoiseAssetDescriptor = {
      asset: { project_relative_path: "bomb.json.gz", mimetype: "application/gzip", url: "https://example.com/bomb" },
      byte_length: gzip.length, decoded_byte_length: 1000, data_format: "simulation_pcb_noise_waveform_json_v1",
      encoded_sha256: await sha256(gzip), sha256: await sha256(bytes), canonical_sha256: zeroHash,
    }
    await expect(loadNoiseAsset(descriptor, { resolveAsset: async () => gzip, limits: { decodedBytes: 1000 } })).rejects.toThrow("byte limit")
  })
  test("shared budget bounds concurrent selected loads and channels before resolution", async () => {
    const full = waveform()
    const asset = await createJsonAsset(full, { projectRelativePath: "one.json" })
    const budget = createNoiseAssetBudget({ decodedBytes: asset.decoded_byte_length * 2, channels: 2 })
    const loaded = await Promise.all([loadNoiseAsset(asset, { budget }), loadNoiseAsset(asset, { budget })])
    expect(loaded).toEqual([full, full])
    expect(budget.channels).toBe(2)
    await expect(loadNoiseAsset(asset, { budget })).rejects.toThrow("shared resource budget")
  })
})

describe("decoded network and immutable export", () => {
  test("validates weighted eyes with declared timing and refuses fabricated clock identity", async () => {
    const eye = {
      format: "simulation_pcb_noise_eye_json_v1" as const, run_id: "run-one", observation_name: "victim_far", waveform_sha256: zeroHash, timing_sha256: zeroHash,
      modulation: "nrz", unit_interval_s: 1e-9, extent_ui: 2, time_bins: 32, voltage_bins: 2,
      min_voltage_v: 0, max_voltage_v: 1, counts: Array.from({ length: 64 }, () => 0.5), complete_window_count: 64, transition_count: 40, excluded_intervals_s: [],
      resolved_timing: { kind: "explicit_clock", unit_interval_s: 1e-9, sample_offset_s: 0.5e-9, clock_edges_s: Array.from({ length: 65 }, (_, i) => i * 1e-9), edge_polarity: "rising", symbol_mapping: "one_edge_per_symbol", interpretation: "nominal_reference", clock_source: { kind: "authored_edges", source_name: "victim-source" } },
      metrics: { jitter_rms_s: 0, offset_s: -1e-12, tie_rms_s: 1e-12 }, metric_definitions: { offset_s: "Signed constant threshold-crossing offset from declared timing" },
    }
    const asset = await createJsonAsset(eye, { projectRelativePath: "eye.json" })
    expect(await loadNoiseAsset(asset, { expectedWaveformHash: zeroHash })).toEqual(eye)
    const wrongIntent = structuredClone(eye); wrongIntent.resolved_timing.interpretation = "actual_receiver_clock"
    expect(() => validateNoisePayload(wrongIntent, eye.format)).toThrow("nominal-reference")
    const empty = structuredClone(eye); empty.counts.fill(0)
    expect(() => validateNoisePayload(empty, eye.format)).toThrow("captured samples")
    const dimensions = structuredClone(eye); dimensions.time_bins = 513
    expect(() => validateNoisePayload(dimensions, eye.format)).toThrow("allowed count")
    const tooShort = structuredClone(eye); tooShort.complete_window_count = 63
    expect(() => validateNoisePayload(tooShort, eye.format)).toThrow("64 complete")
  })
  test("requires spectrum units, FFT count and frequencies inside the sampled band", async () => {
    const spectrum = {
      format: "simulation_pcb_noise_spectrum_json_v1" as const, run_id: "run-one", observation_name: "victim_far", waveform_sha256: zeroHash,
      frequencies_hz: [0, 250e6, 500e6], values: [0, 1e-10, 0], kind: "psd", unit: "V^2/Hz", sidedness: "one_sided", window: "rectangular",
      coherent_gain: 1, enbw_hz: 250e6, dc_treatment: "mean_removed", fft_length: 4, sample_rate_hz: 1e9,
      integrated_power: 0.025, windowed_mean_square: 0.025, parseval_relative_error: 0,
    }
    expect(await loadNoiseAsset(await createJsonAsset(spectrum, { projectRelativePath: "spectrum.json" }))).toEqual(spectrum)
    const units = structuredClone(spectrum); units.unit = "V"
    expect(() => validateNoisePayload(units, spectrum.format)).toThrow("unit/quantity")
    const bins = structuredClone(spectrum); bins.fft_length = 8
    expect(() => validateNoisePayload(bins, spectrum.format)).toThrow("FFT length")
    const band = structuredClone(spectrum); band.frequencies_hz[2] = 1e9
    expect(() => validateNoisePayload(band, spectrum.format)).toThrow("Nyquist")
  })
  test("validates all ordered matrix dimensions, reference values and DC without truncation", async () => {
    const reference = network()
    const asset = await createJsonAsset(reference, { projectRelativePath: "network.json" })
    expect(await loadNoiseAsset(asset)).toEqual(reference)
    const dimensions = structuredClone(reference); dimensions.matrices[1]![0]!.pop()
    expect(() => validateNoisePayload(dimensions, reference.format)).toThrow("square")
    const nonfinite = structuredClone(reference); nonfinite.matrices[1]![0]![1]!.imag = NaN
    expect(() => validateNoisePayload(nonfinite, reference.format)).toThrow("finite")
    const z0 = structuredClone(reference); z0.ports[1]!.reference_impedance_ohms = 0
    expect(() => validateNoisePayload(z0, reference.format)).toThrow("reference impedance")
    const imaginaryDc = structuredClone(reference); imaginaryDc.matrices[0]![0]![0]!.imag = 1e-3
    expect(() => validateNoisePayload(imaginaryDc, reference.format)).toThrow("DC must be real")
    const order = structuredClone(reference); order.frequencies_hz.reverse()
    expect(() => validateNoisePayload(order, reference.format)).toThrow("sorted")
  })
  test("exports a complete manifest and preserves other experiments and earlier runs", async () => {
    const waveformAsset = await createJsonAsset(waveform(), { projectRelativePath: "runs/run-one/victim.json" })
    const run = await manifest(); run.artifacts.push(manifestArtifact("victim_far_total", waveformAsset))
    const manifestAsset = await createJsonAsset(run, { projectRelativePath: "runs/run-one/manifest.json" })
    expect(await loadNoiseAsset(manifestAsset, { expectedGeometryHash: run.inputs.geometry.sha256 })).toEqual(run as unknown as Record<string, unknown>)
    const circuit: Record<string, unknown>[] = [
      { type: "simulation_experiment", simulation_experiment_id: "other-experiment", experiment_type: "pcb_return_current" },
      { type: "simulation_experiment", simulation_experiment_id: "experiment-one", experiment_type: "pcb_noise" },
      { type: "simulation_pcb_noise_configuration", simulation_experiment_id: "experiment-one", simulation_pcb_noise_configuration_id: "configuration-one", pcb_board_id: "board-one" },
    ]
    const result = { type: "simulation_pcb_noise_result", status: "completed", simulation_experiment_id: "experiment-one", simulation_pcb_noise_configuration_id: "configuration-one", pcb_board_id: "board-one", run_id: "run-one", simulation_pcb_noise_result_id: "result-one", manifest_asset: manifestAsset }
    const appended = appendNoiseResult(circuit, result)
    expect(circuit.length).toBe(3)
    expect(appended[0]).toBe(circuit[0])
    expect(() => appendNoiseResult(appended, result)).toThrow("Immutable")
    const second = appendNoiseResult(appended, { ...result, run_id: "run-two", simulation_pcb_noise_result_id: "result-two" })
    expect(second[3]).toBe(result)
    expect(second.length).toBe(5)
  })
})
