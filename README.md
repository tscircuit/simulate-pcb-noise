# simulate-pcb-noise

PCB crosstalk and victim-noise simulation from tscircuit Circuit JSON, with a browser-safe library and a separate Node CLI. The implemented provider models two uniform, straight, parallel conductors over a continuous ideal ground reference. It extracts a quasi-TEM cross-section and evaluates the coupled four-port network with finite conducting-slab copper impedance and an exact modal FFT channel.

The solver appends an immutable `simulation_pcb_noise_result` and exports full-resolution assets. A completed run records numerical validation, its frequency band, physical assumptions, resolved settings and input hashes. Unsupported geometry and failed numerical gates produce typed diagnostics without completed assets.

## TSX authoring and a separate solver run

`@tscircuit/core` authors the physical board and a pending experiment with `simulation.pcbnoisesimulation`, `pcbnoisechannel` and `pcbnoiseeye`. Each channel owns its source, load and physical reference contacts; an eye selects the receiver channel and either known-UI timing or an explicit clock. [The props PR](https://github.com/tscircuit/props/pull/927) includes complete TSX for both timing choices. Rendering resolves contacts and emits pending intent; the solver runs afterward.

The [two-line TSX example](https://github.com/tscircuit/return-current-trace-demo/tree/codex/pcb-noise-demo/examples/circuit-json/two-line-pcb-noise) supplies an actual board, four physical ports, explicit fabrication stackup, seeded aggressor/victim sources, loads, baseline and eye timing. Its [authoring code](https://github.com/tscircuit/return-current-trace-demo/blob/codex/pcb-noise-demo/examples/circuit-json/two-line-pcb-noise/generate-input.tsx) writes `input.circuit.json` before executing a separate Node process. Core does not infer dielectric properties or conductivity from a part name or a material label; those inputs must be supplied with the physical geometry.

This work uses package previews. Install the exact simulator commit preview published by this repository's **PR package preview** workflow; the package currently pins the matching Circuit JSON preview in `package.json`. The CLI requires Node ≥20.11. Bun is used for development and verification.

```sh
simulate-pcb-noise input.circuit.json \
  --experiment-id simulation_experiment_0 \
  --settings settings.json \
  --output runs/quiet/assets \
  --result-json runs/quiet/result.circuit.json \
  --result-id simulation_pcb_noise_result_quiet \
  --run-id quiet \
  --cache extraction-cache.json
```

The required arguments select a pending experiment, explicit numerical settings, new result/run identities, asset directory and output document. `--cache` is optional: a missing file receives the completed extraction cache; an existing file is checked and reused. New runs use new output paths and identities. Writes are exclusive, preserving earlier files. The command prints a JSON summary and exits with a nonzero status for failed or unsupported runs.

## Explicit settings

[The example settings file](https://github.com/tscircuit/return-current-trace-demo/blob/codex/pcb-noise-demo/examples/circuit-json/two-line-pcb-noise/settings.json) supplies every field below. `validatePcbNoiseRunSettings` rejects missing or unknown fields and nonphysical values. These values belong to the authored experiment; there are no implicit mesh, source, material or receiver defaults.

| Settings group | Required fields |
| --- | --- |
| `copper` | `kind: "finite_slab"`, `relative_permeability`, `current_distribution: "one_sided"` or `"symmetric_two_sided"` |
| `extraction` | `grid_mm`, `margin_mm`, `top_mm`, `relative_tolerance`, `maximum_iterations` |
| `transient` | `initial_condition: "zero"` or `"dc_equilibrium"`, `padding_duration_s`, `maximum_wrap_error_v`, `maximum_wrap_error_a`, `maximum_fft_size` |
| `frequency` | Increasing `frequencies_hz` including DC and covering the channel's sampled band, plus `reference_impedance_ohms` |
| `convergence` | `coupling_relative_tolerance`, `capacitance_absolute_f_per_m`, `inductance_absolute_h_per_m`, `domain_scale`, `maximum_reciprocity_error`, `sampling_relative_tolerance`, `sampling_absolute_v`, `sampling_absolute_a` |
| `spectrum` | `window: "hann"` or `"rectangular"`, `dc_treatment: "included"` or `"mean_removed"` |
| `eyes` | Map from observation name to explicit `threshold_v` and `rise_time_s`; use `{}` when no eyes are requested |

Physical dimensions use the stated millimetre/metre units. Time, frequency, voltage and current assets use SI seconds, hertz, volts and amperes. Mesh refinement, domain expansion, weak mutual coupling, reciprocity, passivity, sampling refinement, FFT wrap/pre-response and spectrum Parseval checks are separate gates.

## Library API

The package root has no Node or Bun imports. The caller supplies Circuit JSON and performs its own filesystem or browser asset IO.

```ts
import { runPcbNoise, validatePcbNoiseRunSettings } from "simulate-pcb-noise"

const output = await runPcbNoise(pendingCircuitJson, {
  experiment_id: "simulation_experiment_0",
  result_id: "simulation_pcb_noise_result_quiet",
  run_id: "quiet",
  settings: validatePcbNoiseRunSettings(authoredSettings),
  // Optional previously returned, fingerprinted physical extraction cache:
  ...(previousExtractionCache ? { extraction_cache: previousExtractionCache } : {}),
})

if (output.result.status === "completed") {
  // Persist each { path, bytes } from output.assets and output.circuit_json.
  // Retain output.extraction_cache for a later compatible experiment.
} else {
  console.log(output.result.diagnostics)
}
```

`pendingCircuitJson`, `authoredSettings` and `previousExtractionCache` are caller-provided values. `output.circuit_json` preserves authored records and appends the selected result. Cache identity covers complete physical geometry and extraction/domain settings; its data digest is checked independently. Changing only compatible source/load settings can reuse extraction, while stale geometry or extraction data is rejected.

Reuse a cache previously returned by this solver. Its hashes and physical consistency checks detect stale or inconsistent data; recomputing hashes for external matrices does not establish that an electrostatic solve produced them.

The root also exports source generators, finite-slab copper utilities, passive complex-network import/qualification, coupled network/channel evaluation, waveform analysis and bounded asset transport. `simulate-pcb-noise/cli` resolves to the Node executable module.

## Waveforms, eyes and spectra

A paired baseline quiets only named aggressor sources while preserving the victim drive, loads, seed, timing and physical inputs. Assets retain `total`, `baseline` and `difference` variants with comparison identity and exact timestamps. Their relationship is `difference = total − baseline`. Full-resolution waveform data is retained independently of display density.

Digital eyes require an active NRZ observation, sufficient edge resolution and at least 64 complete windows. Known-UI timing uses an authored epoch or one frozen training origin. Explicit clock timing records its selected edges, source, polarity, mapping, sample offset and `interpretation`. An authored PRBS symbol clock is a `nominal_reference`; a sampled physical clock remains a separately identified observation. Explicit clock analysis uses a fixed nominal-UI association and can refuse larger timing excursions even when data and clock remain physically correlated. Requested eyes for quiet and analog observations carry diagnostics. Folded eye density and timing metrics describe the captured record, with no BER extrapolation.

Spectra record quantity/unit, one- or two-sided normalization, window, coherent gain, equivalent noise bandwidth, DC treatment and Parseval residuals. The runner exports voltage/current PSD assets; the analysis API also supports peak and RMS amplitudes. Waveform/eye/spectrum hashes identify the exact source data and timing used.

`createJsonAsset` and `loadNoiseAsset` support bounded JSON/gzip transport, with independent encoded, decoded and canonical SHA256 checks. External resolution is explicit and occurs only for the selected asset. CLI assets use `project://` URLs plus `project_relative_path`; the caller supplies a resolver for those paths. Size, sample and shared-load budgets bound decoding.

## Physical scope

The implemented provider assumes a uniform two-conductor quasi-TEM section, explicit constant permittivity, zero dielectric loss and a continuous equipotential reference plane. Authored finite-slab copper includes DC resistance, skin loss and internal inductance with the stated one- or two-sided current distribution. Recorded limitations include lateral proximity/edge crowding, roughness, dielectric dispersion, finite-ground impedance, arbitrary bends/vias, pad launches and component/package models. Numerical convergence establishes the reported model's discretization checks; the assumptions bound its physical application. `validity_band_hz` describes the evaluated numerical model band, without claiming calibrated PCB hardware accuracy. The manifest separately records the wider band used by half-step sampling refinement.

`simulateAuthoredPowerNetwork` is a standalone, authored single-load lumped circuit utility: an ideal voltage source, regulator/board/package R–L paths and an optional series ESR/ESL/C decap. Parameters are supplied explicitly; the regulator is an impedance equivalent without control-loop dynamics. `compileNoiseSource` and `compileNoiseSources` generate bounded, periodic random-phase multisines with explicit seeds, discrete line power and shared/independent correlation declarations. Distinct seeds do not guarantee zero cross power in a finite realization. These exported utilities are not wired to the current `runPcbNoise` Circuit JSON provider. They do not extract a PCB power-distribution network or calculate thermal, flicker or device noise. This package does not run a native electromagnetic field solver.

## Verification and related projects

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
RUN_CROSS_SECTION_CONVERGENCE=1 bun test tests/electrostatic-reference.test.ts
bun run build
bun run smoke:package
```

The explicit convergence command performs three production meshes and an independently expanded domain against the pinned SciPy reference. It is also a required CI step. Independent tests cover modal reflections, coupling, DC behavior, copper diffusion, source sequences, timing and PSD normalization. `smoke:package` installs the packed library in a clean production consumer, checks strict TypeScript declarations and browser bundling, then exercises actual Node SHA256/gzip transport and CLI help. Set `NODE_EXECUTABLE` when Node is outside `PATH`.

Related work: [Circuit JSON noise contract](https://github.com/tscircuit/circuit-json/pull/895), [TSX props](https://github.com/tscircuit/props), [core authoring](https://github.com/tscircuit/core), [SVG rendering](https://github.com/tscircuit/circuit-to-svg), and [circuit-json-crosstalk-simulation](https://github.com/tscircuit/circuit-json-crosstalk-simulation).
