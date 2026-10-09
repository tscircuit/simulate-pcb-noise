import { constants } from "node:fs"
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const consumer = await mkdtemp(join(tmpdir(), "simulate-pcb-noise-consumer-"))
async function run(command: string[], cwd: string) {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 })
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stdout.toString()}${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

try {
  let tarball = process.argv[2] && resolve(process.argv[2])
  if (!tarball) {
    await run([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", consumer], root)
    tarball = join(consumer, (await readdir(consumer)).find((name) => name.endsWith(".tgz"))!)
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "simulate-pcb-noise": `file:${tarball}` },
    ...(process.env.CIRCUIT_JSON_TARBALL ? {
      overrides: { "circuit-json": `file:${resolve(process.env.CIRCUIT_JSON_TARBALL)}` },
    } : {}),
  }))
  await run([process.execPath, "install", "--production"], consumer)
  const entrypoint = join(consumer, "consumer.ts")
  await writeFile(entrypoint, 'import * as noise from "simulate-pcb-noise"\nif (!Object.keys(noise).length) throw new Error("No public exports")\n')
  const bundle = await Bun.build({ entrypoints: [entrypoint], target: "browser" })
  if (!bundle.success || bundle.logs.length) throw new Error(`Browser bundle failed: ${bundle.logs.join("\n")}`)
  const javascript = await bundle.outputs[0]!.text()
  if (/(?:from|import)\s*["'](?:node:|bun:)/.test(javascript)) throw new Error("Node import leaked into browser bundle")
  await run([process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", entrypoint], consumer)
  const node = process.env.NODE_EXECUTABLE ?? "node"
  const nodeConsumer = join(consumer, "consumer.mjs")
  await writeFile(nodeConsumer, `import { createJsonAsset, loadNoiseAsset, sha256 } from "simulate-pcb-noise"
if (await sha256("abc") !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw Error("SHA256 mismatch")
const waveform = {
  format: "simulation_pcb_noise_waveform_json_v1", run_id: "node-smoke", observation_name: "victim_far",
  unit: "V", variant: "total", full_resolution: true,
  time: { kind: "uniform", start_s: 0, step_s: 1e-11, count: 4 }, values: [0, 0.25, 0.5, 0.1],
  valid_intervals_s: [{ start_s: 0, end_s: 3e-11 }], bandwidth_hz: 1e9,
  input_sha256: "0".repeat(64), source_sha256: "0".repeat(64),
}
const asset = await createJsonAsset(waveform, { projectRelativePath: "waveform.json.gz", mimetype: "application/gzip" })
const restored = await loadNoiseAsset(asset, { expectedRunId: "node-smoke", expectedObservationName: "victim_far" })
if (JSON.stringify(restored) !== JSON.stringify(waveform)) throw Error("Gzip waveform roundtrip mismatch")
`)
  await run([node, nodeConsumer], consumer)
  await access(join(consumer, "node_modules/.bin/simulate-pcb-noise"), constants.X_OK)
  const cliHelp = await run([node, join(consumer, "node_modules/simulate-pcb-noise/dist/cli.js"), "--help"], consumer)
  if (!/simulate-pcb-noise|usage/i.test(cliHelp)) throw new Error("CLI help did not describe usage")
  console.log("Clean package consumer: TypeScript, browser bundle, Node import and Node CLI passed")
} finally {
  await rm(consumer, { recursive: true, force: true })
}
