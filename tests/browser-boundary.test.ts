import { expect, test } from "bun:test"

test("public library bundles for browsers without Node builtins", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../lib/index.ts", import.meta.url).pathname],
    target: "browser",
  })
  expect(result.success).toBe(true)
  expect(result.logs).toHaveLength(0)
  const bundle = await result.outputs[0]!.text()
  expect(bundle).not.toMatch(/(?:from|import)\s*["'](?:node:|bun:)/)
})
