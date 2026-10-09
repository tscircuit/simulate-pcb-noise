import { expect, test } from "bun:test"
import {
  getPowerNetworkFrequencyResponse,
  getPowerNetworkOperatingPoint,
  PowerNetworkError,
  simulateAuthoredPowerNetwork,
  type AuthoredPowerNetwork,
} from "../lib/power-network"

const zero = { resistanceOhm: 0, inductanceH: 0 }
function circuit(): AuthoredPowerNetwork {
  return {
    kind: "authored_lumped_power_network_v1",
    sourceVoltageV: 3.3,
    contacts: {
      sourceSupply: { contactId: "REG.VDD", logicalNetId: "VDD" },
      localSupply: { contactId: "U1.VDD", logicalNetId: "VDD" },
      remoteGround: { contactId: "REG.GND", logicalNetId: "GND" },
      localGround: { contactId: "U1.GND", logicalNetId: "GND" },
    },
    regulator: { resistanceOhm: 0.05, inductanceH: 0 },
    boardSupply: { resistanceOhm: 0.1, inductanceH: 5e-9 },
    packageSupply: { resistanceOhm: 0.02, inductanceH: 2e-9 },
    boardReturn: { resistanceOhm: 0.08, inductanceH: 8e-9 },
    packageGround: { resistanceOhm: 0.03, inductanceH: 3e-9 },
  }
}

test("DC operating point keeps the two GND contacts and the load-current sign", () => {
  const model = circuit()
  model.decap = { capacitanceF: 1e-6, esrOhm: 0.02, eslH: 0.7e-9 }
  const point = getPowerNetworkOperatingPoint(model, 2)
  expect(point.sourceCurrentA).toBe(2)
  expect(point.decapCurrentA).toBe(0)
  expect(point.localSupplyVoltageV).toBeCloseTo(3.3 - 0.28 * 2, 12)
  expect(point.groundBounceVoltageV).toBeCloseTo(0.11 * 2, 12)
  expect(point.sourceReferencedSupplyVoltageV - point.groundBounceVoltageV).toBeCloseTo(point.localSupplyVoltageV, 12)
  expect(getPowerNetworkOperatingPoint(model, -2).groundBounceVoltageV).toBeCloseTo(-0.22, 12)
  const dc = getPowerNetworkFrequencyResponse(model, 0)
  expect(dc.decapImpedanceOhm).toBeNull()
  expect(dc.supplyDroopVPerA).toEqual({ re: 0.28, im: 0 })
})

test("a ramp independently reproduces R*i + L*di/dt on supply and return", () => {
  const result = simulateAuthoredPowerNetwork(circuit(), {
    dcCurrentA: 1,
    timesS: [0, 0.5e-6, 1e-6],
    currentsA: [1, 1.5, 2],
  })
  result.timesS.forEach((_, i) => {
    expect(result.localSupplyVoltageV[i]).toBeCloseTo(3.3 - 0.28 * result.loadCurrentA[i] - 18e-9 * 1e6, 12)
    expect(result.groundBounceVoltageV[i]).toBeCloseTo(0.11 * result.loadCurrentA[i] + 11e-9 * 1e6, 12)
    expect(result.sourceReferencedSupplyVoltageV[i] - result.groundBounceVoltageV[i]).toBeCloseTo(result.localSupplyVoltageV[i], 12)
  })
  expect(result.supplyDroopV[2]).toBeCloseTo(0.28 + 0.018, 12)
  expect(result.groundDeviationV[2]).toBeCloseTo(0.11 + 0.011, 12)
  expect(result.reference).toEqual({
    localGroundContactId: "U1.GND", remoteGroundContactId: "REG.GND",
    voltageGauge: "remote_ground", logicalNetContactsCollapsed: false,
  })
  expect(result.modelProvenance).toEqual({ origin: "authored_lumped_circuit", pcbGeometryExtracted: false })
})

test("ESR/ESL decap has its independently calculated self-resonance", () => {
  const model = circuit()
  model.decap = { capacitanceF: 100e-9, esrOhm: 0.025, eslH: 0.8e-9 }
  const resonance = 1 / (2 * Math.PI * Math.sqrt(100e-9 * 0.8e-9))
  const response = getPowerNetworkFrequencyResponse(model, resonance)
  expect(response.decapImpedanceOhm!.re).toBe(0.025)
  expect(Math.abs(response.decapImpedanceOhm!.im)).toBeLessThan(1e-15)
  expect(getPowerNetworkFrequencyResponse(model, resonance / 2).decapImpedanceOhm!.im).toBeLessThan(0)
  expect(getPowerNetworkFrequencyResponse(model, resonance * 2).decapImpedanceOhm!.im).toBeGreaterThan(0)
})

test("loaded small-signal supply and ground transfer obey independent parallel impedance arithmetic", () => {
  const model = circuit()
  model.decap = { capacitanceF: 100e-9, esrOhm: 0.025, eslH: 0.8e-9 }
  const w = 2 * Math.PI * 20e6
  const a = 0.28, b = w * 18e-9, c = 0.025, d = w * 0.8e-9 - 1 / (w * 100e-9)
  const denominator = (a + c) ** 2 + (b + d) ** 2
  const ratioReal = (c * (a + c) + d * (b + d)) / denominator
  const ratioImag = (d * (a + c) - c * (b + d)) / denominator
  const response = getPowerNetworkFrequencyResponse(model, 20e6)
  expect(response.supplyDroopVPerA.re).toBeCloseTo(a * ratioReal - b * ratioImag, 12)
  expect(response.supplyDroopVPerA.im).toBeCloseTo(a * ratioImag + b * ratioReal, 12)
  expect(response.groundBounceVPerA.re).toBeCloseTo(0.11 * ratioReal - w * 11e-9 * ratioImag, 12)
  expect(response.groundBounceVPerA.im).toBeCloseTo(0.11 * ratioImag + w * 11e-9 * ratioReal, 12)
})

test("pure RC current ramp agrees with the closed-form exponential solution", () => {
  const model = circuit()
  model.regulator = { resistanceOhm: 0.05, inductanceH: 0 }
  model.boardSupply = { resistanceOhm: 0.1, inductanceH: 0 }
  model.packageSupply = zero
  model.boardReturn = { resistanceOhm: 0.05, inductanceH: 0 }
  model.packageGround = zero
  model.decap = { capacitanceF: 10e-6, esrOhm: 0.03, eslH: 0 }
  const result = simulateAuthoredPowerNetwork(model, { dcCurrentA: 1, timesS: [0, 1e-6, 2e-6], currentsA: [1, 2, 3] })
  const r = 0.2, cap = 10e-6, slope = 1e6, tau = (r + 0.03) * cap
  for (let i = 0; i < result.timesS.length; i++) {
    const independentDecapCurrent = -cap * r * slope * (1 - Math.exp(-result.timesS[i] / tau))
    expect(result.decapCurrentA[i]).toBeCloseTo(independentDecapCurrent, 11)
    expect(result.sourceCurrentA[i]).toBeCloseTo(result.loadCurrentA[i] + independentDecapCurrent, 11)
    expect(result.localSupplyVoltageV[i]).toBeCloseTo(3.3 - r * result.sourceCurrentA[i], 11)
  }
})

test("RLC current ramp matches a separate direct KVL/KCL RK4 integration", () => {
  const model = circuit()
  model.decap = { capacitanceF: 200e-9, esrOhm: 0.03, eslH: 1e-9 }
  const tEnd = 2e-6, slope = 5e5
  const result = simulateAuthoredPowerNetwork(model, { dcCurrentA: 1, timesS: [0, tEnd], currentsA: [1, 2] })
  // Independent states are actual source current and capacitor voltage; no
  // production state evolution or frequency-response helper is used here.
  let source = 1, capacitor = 3.3 - 0.28
  const derivative = (t: number, s: number, v: number) => [
    (3.3 - 0.28 * s - 0.03 * (s - (1 + slope * t)) - v + 1e-9 * slope) / 19e-9,
    (s - (1 + slope * t)) / 200e-9,
  ]
  const steps = 20_000, h = tEnd / steps
  for (let i = 0; i < steps; i++) {
    const t = i * h
    const k1 = derivative(t, source, capacitor)
    const k2 = derivative(t + h / 2, source + h * k1[0] / 2, capacitor + h * k1[1] / 2)
    const k3 = derivative(t + h / 2, source + h * k2[0] / 2, capacitor + h * k2[1] / 2)
    const k4 = derivative(t + h, source + h * k3[0], capacitor + h * k3[1])
    source += h * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) / 6
    capacitor += h * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) / 6
  }
  const finalDerivative = derivative(tEnd, source, capacitor)[0]
  expect(result.sourceCurrentA[1]).toBeCloseTo(source, 9)
  expect(result.localSupplyVoltageV[1]).toBeCloseTo(3.3 - 0.28 * source - 18e-9 * finalDerivative, 9)
  expect(result.groundBounceVoltageV[1]).toBeCloseTo(0.11 * source + 11e-9 * finalDerivative, 9)
})

test("decap steady load starts at DC and stays there without invented noise", () => {
  const model = circuit()
  model.decap = { capacitanceF: 1e-6, esrOhm: 0.03, eslH: 1e-9 }
  const result = simulateAuthoredPowerNetwork(model, { dcCurrentA: 1.5, timesS: [0, 1e-9, 1, 100], currentsA: [1.5, 1.5, 1.5, 1.5] })
  expect(result.supplyDroopV).toEqual([0, 0, 0, 0])
  expect(result.groundDeviationV).toEqual([0, 0, 0, 0])
  expect(result.sourceCurrentA).toEqual([1.5, 1.5, 1.5, 1.5])
})

test("stiff overdamped decap circuit settles finitely without cosh overflow", () => {
  const model = circuit()
  model.regulator.resistanceOhm = 1000
  model.decap = { capacitanceF: 1e-9, esrOhm: 0.01, eslH: 1e-12 }
  const result = simulateAuthoredPowerNetwork(model, { dcCurrentA: 0, timesS: [0, 1e-6, 1], currentsA: [0, 0.001, 0.001] })
  expect(result.sourceCurrentA[2]).toBeCloseTo(0.001, 12)
  expect(result.decapCurrentA[2]).toBeCloseTo(0, 12)
  expect(result.localSupplyVoltageV[2]).toBeCloseTo(3.3 - 1000.23 * 0.001, 12)
})

test("distinct physical grounds are required even when the logical net name matches", () => {
  const model = circuit()
  model.contacts.localGround.contactId = model.contacts.remoteGround.contactId
  expect(() => getPowerNetworkOperatingPoint(model, 1)).toThrow(PowerNetworkError)
  expect(() => getPowerNetworkOperatingPoint({ ...circuit(), boardReturn: zero, packageGround: zero }, 1)).toThrow("finite authored ground return")
})

test("nonphysical circuit parameters and malformed PWL loads fail explicitly", () => {
  expect(() => getPowerNetworkOperatingPoint({ ...circuit(), boardSupply: { resistanceOhm: -1, inductanceH: 0 } }, 1)).toThrow("nonnegative")
  expect(() => getPowerNetworkFrequencyResponse(circuit(), Number.NaN)).toThrow("finite")
  expect(() => getPowerNetworkOperatingPoint({ ...circuit(), decap: { capacitanceF: 0, esrOhm: 0, eslH: 0 } }, 1)).toThrow("positive")
  for (const load of [
    { dcCurrentA: 0, timesS: [0, 0], currentsA: [0, 1] },
    { dcCurrentA: 0, timesS: [0, 1], currentsA: [0] },
    { dcCurrentA: 0, timesS: [0, 1], currentsA: [1, 2] },
    { dcCurrentA: 0, timesS: [0, 1], currentsA: [0, Infinity] },
  ]) expect(() => simulateAuthoredPowerNetwork(circuit(), load)).toThrow(PowerNetworkError)
})
