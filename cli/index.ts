#!/usr/bin/env node
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { runPcbNoise, type PcbNoiseExtractionCache, type PcbNoiseRunSettings } from "../lib/run"

const usage = "Usage: simulate-pcb-noise input.circuit.json --experiment-id ID --settings settings.json --output directory --result-json result.circuit.json --result-id ID --run-id ID [--cache extraction-cache.json]\nAsset project_relative_path values resolve under --output. The --result-json destination is independent; pass an explicit asset resolver rooted at --output."
async function requireAbsent(path: string) {
  try { await lstat(path) }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error }
  throw new Error(`Output already exists: ${path}`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) { console.log(usage); return }
  const inputPath = args.shift()
  if (!inputPath || inputPath.startsWith("--")) throw new Error(usage)
  const required = ["--experiment-id", "--settings", "--output", "--result-json", "--result-id", "--run-id"]
  const allowed = new Set([...required, "--cache"])
  const flags = new Map<string, string>()
  while (args.length) {
    const key = args.shift()!, value = args.shift()
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error(`Invalid or duplicate argument ${key}\n${usage}`)
    flags.set(key, value)
  }
  for (const key of required) if (!flags.has(key)) throw new Error(`Required argument ${key}\n${usage}`)
  const input = JSON.parse(await readFile(resolve(inputPath), "utf8"))
  if (!Array.isArray(input)) throw new Error("Input Circuit JSON must be an array")
  const resultPath = resolve(flags.get("--result-json")!)
  await requireAbsent(resultPath)
  const settings = JSON.parse(await readFile(resolve(flags.get("--settings")!), "utf8")) as PcbNoiseRunSettings
  const cachePath = flags.has("--cache") ? resolve(flags.get("--cache")!) : undefined
  let cache: PcbNoiseExtractionCache | undefined
  if (cachePath) {
    try { cache = JSON.parse(await readFile(cachePath, "utf8")) }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error }
  }
  const output = await runPcbNoise(input, { experiment_id: flags.get("--experiment-id")!, result_id: flags.get("--result-id")!, run_id: flags.get("--run-id")!, settings, ...(cache ? { extraction_cache: cache } : {}) })
  const directory = resolve(flags.get("--output")!)
  const writes: { path: string; data: string | Uint8Array }[] = output.assets.map((asset) => ({ path: resolve(directory, asset.path), data: asset.bytes }))
  if (cachePath && !cache && output.extraction_cache) writes.push({ path: cachePath, data: JSON.stringify(output.extraction_cache) })
  writes.push({ path: resultPath, data: JSON.stringify(output.circuit_json, null, 2) + "\n" })
  if (new Set(writes.map((entry) => entry.path)).size !== writes.length) throw new Error("Output asset, cache and result paths must be distinct")
  for (const entry of writes) await requireAbsent(entry.path)
  const created: string[] = []
  try {
    for (const entry of writes) {
      await mkdir(dirname(entry.path), { recursive: true })
      const file = await open(entry.path, "wx")
      created.push(entry.path)
      try { await file.writeFile(entry.data) } finally { await file.close() }
    }
  } catch (error) {
    await Promise.allSettled(created.map((path) => unlink(path)))
    throw error
  }
  console.log(JSON.stringify({ result_id: output.result.simulation_pcb_noise_result_id, run_id: output.result.run_id, status: output.result.status, assets: output.assets.length, ...(output.result.status === "completed" ? { validation: output.result.validation } : { diagnostics: output.result.diagnostics }) }))
  if (output.result.status !== "completed") process.exitCode = 1
}

main().catch((error: unknown) => {
  const issues = error && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues as { path?: unknown[]; message?: string }[] : undefined
  console.error(issues ? `Circuit JSON runtime validation failed: ${issues.slice(0, 6).map((issue) => `${issue.path?.join(".") || "root"}: ${issue.message}`).join("; ")}` : error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
