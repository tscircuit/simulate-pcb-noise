import { defineConfig, type Options } from "tsup"
import { rm } from "node:fs/promises"

export default defineConfig(async (): Promise<Options[]> => {
  await rm("dist", { recursive: true, force: true })
  return [
    {
      entry: { index: "lib/index.ts" },
      format: ["esm"],
      platform: "browser",
      target: "es2022",
      dts: true,
      sourcemap: true,
    },
    {
      entry: { cli: "cli/index.ts" },
      format: ["esm"],
      platform: "node",
      target: "node20",
      dts: { footer: "export {};" },
      sourcemap: true,
    },
  ]
})
