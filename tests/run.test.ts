import { expect, test } from "bun:test"
import { validatePcbNoiseCircuitJson } from "circuit-json"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runPcbNoise, validatePcbNoiseRunSettings, type PcbNoiseRunSettings } from "../lib/run"
import { canonicalJson, sha256 } from "../lib/manifest"

const settings: PcbNoiseRunSettings = {
  copper: { kind: "finite_slab", relative_permeability: 1, current_distribution: "one_sided" },
  extraction: { grid_mm: 0.1, margin_mm: 0.8, top_mm: 0.8, relative_tolerance: 1e-9, maximum_iterations: 20000 },
  transient: { initial_condition: "dc_equilibrium", padding_duration_s: 4e-9, maximum_wrap_error_v: 1e-4, maximum_wrap_error_a: 2e-6, maximum_fft_size: 8192 },
  frequency: { frequencies_hz: [0, 1e9, 25e9], reference_impedance_ohms: 50 },
  convergence: { coupling_relative_tolerance: 0.02, capacitance_absolute_f_per_m: 1e-13, inductance_absolute_h_per_m: 1e-10, domain_scale: 2, maximum_reciprocity_error: 1e-6, sampling_relative_tolerance: 0.01, sampling_absolute_v: 1e-4, sampling_absolute_a: 2e-6 },
  spectrum: { window: "hann", dc_treatment: "mean_removed" }, eyes: {},
}

function fixture() {
  const records: Record<string, any>[] = [
    { type: "pcb_board", pcb_board_id: "board", center: { x: 0, y: 0 }, width: 24, height: 5, num_layers: 2, thickness: 0.27,
      stackup: { source: "specified", layers: [
        { type: "copper", layer: "top", thickness_mm: 0.035, conductivity_s_per_m: 5.8e7 },
        { type: "dielectric", thickness_mm: 0.2, dielectric_constant: 4.2, dielectric_constant_frequency_hz: 1e9, dielectric_loss_tangent: 0, dielectric_loss_tangent_frequency_hz: 1e9 },
        { type: "copper", layer: "bottom", thickness_mm: 0.035, conductivity_s_per_m: 5.8e7 },
      ] } },
    { type: "simulation_experiment", simulation_experiment_id: "experiment", experiment_type: "pcb_noise", name: "Bounded fixture" },
    { type: "source_net", source_net_id: "ground", name: "GND", is_ground: true, member_source_group_ids: [] },
    { type: "pcb_copper_pour", pcb_copper_pour_id: "plane", source_net_id: "ground", layer: "bottom", shape: "rect", center: { x: 0, y: 0 }, width: 24, height: 5 },
  ]
  const ports: any[] = [], sources: any[] = [], terminations: any[] = []
  for (let line = 0; line < 2; line++) {
    const y = line ? 0.3 : -0.3
    for (let side = 0; side < 2; side++) {
      const name = `p${line}${side}`, x = side ? 10 : -10
      records.push({ type: "pcb_port", pcb_port_id: name, source_port_id: "s" + name, x, y, layers: ["top"] })
      records.push({ type: "source_port", source_port_id: "s" + name, name })
      records.push({ type: "pcb_smtpad", pcb_smtpad_id: "pad" + name, pcb_port_id: name, shape: "rect", x, y, layer: "top", width: 0.3, height: 0.3 })
      ports.push({ name, signal_contact: { contact_type: "pcb_port", pcb_port_id: name, x, y, layer: "top" }, reference_contact: { contact_type: "pcb_copper_pour", pcb_copper_pour_id: "plane", x, y, layer: "bottom" } })
      if (!side) sources.push({ name: "source" + line, role: line ? "victim" : "aggressor", port_name: name, source_model: { kind: "thevenin", resistance_ohms: 50 }, waveform: { kind: "dc", voltage_v: 0 } })
      else terminations.push({ name: "load" + line, port_name: name, model: { kind: "resistor", resistance_ohms: 50, bias_voltage_v: 0 } })
    }
    records.push({ type: "source_trace", source_trace_id: "trace" + line, connected_source_port_ids: [`sp${line}0`, `sp${line}1`], connected_source_net_ids: [] })
    records.push({ type: "pcb_trace", pcb_trace_id: "wire" + line, source_trace_id: "trace" + line, route: [{ route_type: "wire", x: -10, y, width: 0.3, layer: "top" }, { route_type: "wire", x: 10, y, width: 0.3, layer: "top" }] })
  }
  records.push({ type: "simulation_pcb_noise_configuration", simulation_pcb_noise_configuration_id: "config", simulation_experiment_id: "experiment", pcb_board_id: "board", duration_s: 2e-9, sample_interval_s: 20e-12, ports, sources, terminations, observations: ports.map((p) => ({ name: p.name, port_name: p.name, quantity: "voltage" })) })
  validatePcbNoiseCircuitJson(records)
  return records
}
const options = () => ({ experiment_id: "experiment", result_id: "result", run_id: "run", settings: structuredClone(settings) })

test("unsupported missing fabrication inputs append a typed result and preserve authored records", async () => {
  const input = fixture(); delete input[0]!.stackup
  const before = JSON.stringify(input), output = await runPcbNoise(input, options())
  expect(output.result.status).toBe("unsupported")
  expect(output.assets).toHaveLength(0)
  expect(JSON.stringify(input)).toBe(before)
  expect(output.circuit_json.slice(0, input.length)).toEqual(input)
  expect(output.circuit_json.at(-1)).toEqual(output.result)
  expect("network_asset" in output.result).toBe(false)
  validatePcbNoiseCircuitJson(output.circuit_json)
})

test("invalid numerical settings fail without completed assets and unknown defaults are rejected", async () => {
  const input = fixture(), run = options(); run.settings.extraction.relative_tolerance = 0
  const output = await runPcbNoise(input, run)
  expect(output.result.status).toBe("failed")
  expect(output.assets).toHaveLength(0)
  expect("validation" in output.result).toBe(false)
  expect(() => validatePcbNoiseRunSettings({ ...settings, invented_default: 1 })).toThrow("Unknown settings field")
  const incomplete = structuredClone(settings) as unknown as Record<string, any>
  delete incomplete.transient.maximum_wrap_error_a
  expect(() => validatePcbNoiseRunSettings(incomplete)).toThrow("explicit transient.maximum_wrap_error_a")
})

test("a numerically unconverged physical model cannot report completed or validated", async () => {
  const input = fixture(), run = options()
  run.settings.convergence.coupling_relative_tolerance = 1e-8
  run.settings.convergence.capacitance_absolute_f_per_m = 1e-20
  run.settings.convergence.inductance_absolute_h_per_m = 1e-18
  const output = await runPcbNoise(input, run)
  expect(output.result.status).toBe("failed")
  if (output.result.status !== "completed") expect(output.result.diagnostics[0]!.code).toBe("numerical_validation_failed")
  expect(output.assets).toHaveLength(0)
  expect(output.extraction_cache).toBeUndefined()
}, 60000)

test("immutable failed run identifiers cannot be replaced or reused", async () => {
  const input = fixture(); delete input[0]!.stackup
  const output = await runPcbNoise(input, options())
  await expect(runPcbNoise(output.circuit_json, options())).rejects.toThrow("Immutable noise run/result")
  await expect(runPcbNoise(input, { ...options(), experiment_id: "absent" })).rejects.toThrow("no configuration")
})

test("network band cannot silently cover less than the applied transient band", async () => {
  const run = options(); run.settings.frequency.frequencies_hz = [0, 1.75e9]
  const output = await runPcbNoise(fixture(), run)
  expect(output.result.status).toBe("unsupported")
  if (output.result.status !== "completed") expect(output.result.diagnostics[0]!.code).toBe("insufficient_network_band")
  expect(output.assets).toHaveLength(0)
})

test("a stale externally supplied extraction cache cannot produce assets", async () => {
  const output = await runPcbNoise(fixture(), { ...options(), extraction_cache: { format: "pcb_noise_extraction_cache_v1", key_sha256: "a".repeat(64), data_sha256: "b".repeat(64), runs: [] } })
  expect(output.result.status).toBe("failed")
  if (output.result.status !== "completed") expect(output.result.diagnostics[0]!.code).toBe("stale_extraction_cache")
  expect(output.assets).toHaveLength(0)
})

test("an authored high-frequency sine cannot pass because both sampled runs alias", async () => {
  const input = fixture(), config = input.find((record) => record.type === "simulation_pcb_noise_configuration")!
  config.sources[0].waveform = { kind: "sine", offset_voltage_v: 0, amplitude_v: 1, amplitude_convention: "peak", frequency_hz: 50e9, phase_rad: 0 }
  const output = await runPcbNoise(input, options())
  expect(output.result.status).toBe("unsupported")
  if (output.result.status !== "completed") expect(output.result.diagnostics[0]!.code).toBe("undersampled_source")
  expect(output.assets).toHaveLength(0)
})

test("a later transient resource failure retains the independently checked immutable extraction cache", async () => {
  const run = options()
  run.settings.convergence.coupling_relative_tolerance = 1
  run.settings.transient.maximum_fft_size = 2
  const output = await runPcbNoise(fixture(), run)
  expect(output.result.status).toBe("failed")
  expect(output.assets).toHaveLength(0)
  expect(output.extraction_cache?.runs).toHaveLength(4)
  expect(Object.isFrozen(output.extraction_cache)).toBe(true)
  expect(Object.isFrozen(output.extraction_cache!.runs[0])).toBe(true)
  const retried = await runPcbNoise(fixture(), { ...run, result_id: "retry", run_id: "retry", extraction_cache: output.extraction_cache })
  expect(retried.result.status).toBe("failed")
  expect(retried.extraction_cache?.data_sha256).toBe(output.extraction_cache?.data_sha256)
  const changedLoad = fixture()
  changedLoad.find((record) => record.type === "simulation_pcb_noise_configuration")!.terminations[1].model.resistance_ohms = 100
  const terminationRun = await runPcbNoise(changedLoad, { ...run, extraction_cache: output.extraction_cache })
  expect(terminationRun.extraction_cache?.key_sha256).toBe(output.extraction_cache?.key_sha256)
  const changedGeometry = fixture(); changedGeometry[0]!.width += 0.01
  const stale = await runPcbNoise(changedGeometry, { ...run, extraction_cache: output.extraction_cache })
  if (stale.result.status !== "completed") expect(stale.result.diagnostics[0]!.code).toBe("stale_extraction_cache")
  expect(stale.assets).toHaveLength(0)
  for (const alter of [
    (cache: NonNullable<typeof output.extraction_cache>) => { cache.runs[1]!.diagnostics.grid_mm *= 2 },
    (cache: NonNullable<typeof output.extraction_cache>) => { cache.runs[2]!.R_ohm_per_m[0][0] *= 2 },
    (cache: NonNullable<typeof output.extraction_cache>) => { cache.runs[3]!.L_h_per_m[0][0] *= 1.1 },
    ...[10, 0.1].map((factor) => (cache: NonNullable<typeof output.extraction_cache>) => {
      for (const extracted of cache.runs) for (const row of extracted.C_f_per_m) for (let column = 0; column < 2; column++) row[column] *= factor
    }),
    (cache: NonNullable<typeof output.extraction_cache>) => {
      for (const extracted of cache.runs) {
        const vacuum = extracted.C_vacuum_f_per_m, delta = 0.01 * Math.max(...vacuum.flat().map(Math.abs))
        // Both diagonals remain within their scalar bounds; an offdiagonal error violates matrix order.
        extracted.C_f_per_m = [[4.2 * vacuum[0][0] - delta, 4.2 * vacuum[0][1] + 2 * delta], [4.2 * vacuum[1][0] + 2 * delta, 4.2 * vacuum[1][1] - delta]]
      }
    },
  ]) {
    const inconsistent = structuredClone(output.extraction_cache!)
    alter(inconsistent); inconsistent.data_sha256 = await sha256(canonicalJson(inconsistent.runs))
    const rejected = await runPcbNoise(fixture(), { ...run, extraction_cache: inconsistent })
    expect(rejected.result.status).toBe("failed")
    if (rejected.result.status !== "completed") expect(rejected.result.diagnostics[0]!.code).toBe("inconsistent_extraction_cache")
    expect(rejected.assets).toHaveLength(0)
    expect(rejected.extraction_cache).toBeUndefined()
  }
}, 60000)

test("an exact authored 2ns capture uses its emitted floating-point endpoint", async () => {
  const run = options(); run.settings.convergence.coupling_relative_tolerance = 1
  const output = await runPcbNoise(fixture(), run)
  expect(output.result.status).toBe("completed")
  const waveform = output.assets.find((asset) => asset.path === "waveform-0-total.json")!.payload as any
  expect(waveform.valid_intervals_s[0].end_s).toBe((waveform.time.count - 1) * waveform.time.step_s)
  expect(waveform.valid_intervals_s[0].end_s).toBeLessThan(2e-9)
  expect((output.circuit_json.find((record: any) => record.type === "simulation_pcb_noise_configuration") as any).duration_s).toBe(2e-9)
}, 60000)

test("known UI cannot contradict a mapped authored PRBS rate", async () => {
  const input = fixture(), config = input.find((record) => record.type === "simulation_pcb_noise_configuration")!
  config.sources[1].waveform = { kind: "prbs", order: 7, baud_rate_hz: 500e6, low_voltage_v: 0, high_voltage_v: 1, rise_time_s: 200e-12, fall_time_s: 200e-12, edge_time_convention: "10_90", seed: 1, algorithm: "lfsr_fibonacci", algorithm_version: "1" }
  config.eyes = [{ observation_name: "p11", modulation: "nrz", timing: { kind: "known_ui", unit_interval_s: 1e-9, sample_offset_s: 0.5e-9, origin: { kind: "authored_epoch", epoch_s: 0 } } }]
  const output = await runPcbNoise(input, options())
  expect(output.result.status).toBe("unsupported")
  if (output.result.status !== "completed") expect(output.result.diagnostics[0]!.code).toBe("conflicting_authored_symbol_rate")
  expect(output.assets).toHaveLength(0)
})

test("the separate CLI saves an invalid-settings failed receipt with preserved input and no assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pcb-noise-cli-failed-"))
  try {
    const input = fixture(), invalid = structuredClone(settings)
    invalid.extraction.relative_tolerance = 0
    await writeFile(join(directory, "input.json"), JSON.stringify(input))
    await writeFile(join(directory, "settings.json"), JSON.stringify(invalid))
    const child = Bun.spawn([process.execPath, new URL("../cli/index.ts", import.meta.url).pathname,
      join(directory, "input.json"), "--experiment-id", "experiment", "--settings", join(directory, "settings.json"),
      "--output", join(directory, "assets"), "--result-json", join(directory, "result.json"), "--result-id", "result", "--run-id", "run"],
      { stdout: "pipe", stderr: "pipe" })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(exit).toBe(1); expect(stderr).toBe("")
    expect(JSON.parse(stdout).assets).toBe(0)
    const output = JSON.parse(await readFile(join(directory, "result.json"), "utf8"))
    expect(output.slice(0, input.length)).toEqual(input)
    expect(output.at(-1).status).toBe("failed")
    expect("network_asset" in output.at(-1)).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("the CLI preflights late asset collisions and preserves existing output bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pcb-noise-cli-collision-"))
  try {
    const accepted = structuredClone(settings); accepted.convergence.coupling_relative_tolerance = 1
    await writeFile(join(directory, "input.json"), JSON.stringify(fixture()))
    await writeFile(join(directory, "settings.json"), JSON.stringify(accepted))
    await mkdir(join(directory, "assets"))
    await writeFile(join(directory, "assets", "spectrum-3.json"), "existing sentinel")
    const command = [process.execPath, new URL("../cli/index.ts", import.meta.url).pathname,
      join(directory, "input.json"), "--experiment-id", "experiment", "--settings", join(directory, "settings.json"),
      "--output", join(directory, "assets"), "--result-json", join(directory, "result.json"), "--result-id", "result", "--run-id", "run"]
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit).toBe(1); expect(stderr).toContain("Output already exists")
    expect(await readdir(join(directory, "assets"))).toEqual(["spectrum-3.json"])
    expect(await readFile(join(directory, "assets", "spectrum-3.json"), "utf8")).toBe("existing sentinel")
    await writeFile(join(directory, "result.json"), "existing result")
    const resultCollision = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    expect(await resultCollision.exited).toBe(1)
    expect(await readFile(join(directory, "result.json"), "utf8")).toBe("existing result")
    expect(await readdir(join(directory, "assets"))).toEqual(["spectrum-3.json"])
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
