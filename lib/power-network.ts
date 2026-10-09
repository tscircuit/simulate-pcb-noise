/**
 * Authored single-load lumped circuit; these values are never extracted from PCB
 * geometry. An ideal voltage source drives regulator, board and package RL paths;
 * the load and optional series ESR/ESL/C decap span the two local contacts.
 * All quantities use V, A, ohms, H, F and seconds. Positive load current flows
 * from local supply to local ground. The remote ground is only a voltage gauge.
 */
export interface LumpedRlPath {
  resistanceOhm: number
  inductanceH: number
}

export interface PhysicalPowerContact {
  contactId: string
  /** Labels may match; contact IDs must remain physically distinct. */
  logicalNetId?: string
}

export interface AuthoredPowerNetwork {
  kind: "authored_lumped_power_network_v1"
  sourceVoltageV: number
  contacts: {
    sourceSupply: PhysicalPowerContact
    remoteGround: PhysicalPowerContact
    localSupply: PhysicalPowerContact
    localGround: PhysicalPowerContact
  }
  regulator: LumpedRlPath
  boardSupply: LumpedRlPath
  packageSupply: LumpedRlPath
  boardReturn: LumpedRlPath
  packageGround: LumpedRlPath
  /** One explicitly authored equivalent, attached across the local contacts. */
  decap?: { capacitanceF: number; esrOhm: number; eslH: number }
}

export class PowerNetworkError extends Error {
  constructor(
    public readonly code:
      | "invalid_authored_power_network"
      | "invalid_load_waveform"
      | "singular_power_network_response",
    message: string,
  ) {
    super(message)
    this.name = "PowerNetworkError"
  }
}

export interface PowerComplex { re: number; im: number }

const invalid = (message: string): never => {
  throw new PowerNetworkError("invalid_authored_power_network", message)
}
const nonnegative = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) invalid(`${label} must be finite and nonnegative`)
}

function paths(model: AuthoredPowerNetwork) {
  if (!model || model.kind !== "authored_lumped_power_network_v1") invalid("Expected an explicitly authored lumped model")
  if (!Number.isFinite(model.sourceVoltageV) || model.sourceVoltageV <= 0) invalid("sourceVoltageV must be finite and positive")
  const contacts = ["sourceSupply", "remoteGround", "localSupply", "localGround"].map((key) => model.contacts?.[key as keyof AuthoredPowerNetwork["contacts"]])
  if (contacts.some((c) => !c || typeof c.contactId !== "string" || !c.contactId.trim()) || new Set(contacts.map((c) => c?.contactId)).size !== 4) {
    invalid("Four distinct physical contact IDs are required, including local and remote grounds")
  }
  for (const key of ["regulator", "boardSupply", "packageSupply", "boardReturn", "packageGround"] as const) {
    if (!model[key]) invalid(`${key} must be explicitly declared`)
    nonnegative(model[key].resistanceOhm, `${key}.resistanceOhm`)
    nonnegative(model[key].inductanceH, `${key}.inductanceH`)
  }
  if (model.decap) {
    if (!Number.isFinite(model.decap.capacitanceF) || model.decap.capacitanceF <= 0) invalid("decap.capacitanceF must be finite and positive")
    nonnegative(model.decap.esrOhm, "decap.esrOhm")
    nonnegative(model.decap.eslH, "decap.eslH")
  }
  const supply = {
    resistanceOhm: model.regulator.resistanceOhm + model.boardSupply.resistanceOhm + model.packageSupply.resistanceOhm,
    inductanceH: model.regulator.inductanceH + model.boardSupply.inductanceH + model.packageSupply.inductanceH,
  }
  const ground = {
    resistanceOhm: model.boardReturn.resistanceOhm + model.packageGround.resistanceOhm,
    inductanceH: model.boardReturn.inductanceH + model.packageGround.inductanceH,
  }
  const resistanceOhm = supply.resistanceOhm + ground.resistanceOhm
  const inductanceH = supply.inductanceH + ground.inductanceH
  if (!Number.isFinite(resistanceOhm) || !Number.isFinite(inductanceH)) invalid("Total path parameters overflow")
  if (ground.resistanceOhm === 0 && ground.inductanceH === 0) invalid("A finite authored ground return impedance is required")
  return { supply, ground, resistanceOhm, inductanceH }
}

export function getPowerNetworkOperatingPoint(model: AuthoredPowerNetwork, loadCurrentA: number) {
  const path = paths(model)
  if (!Number.isFinite(loadCurrentA)) invalid("DC load current must be finite")
  const result = {
    loadCurrentA,
    sourceCurrentA: loadCurrentA,
    decapCurrentA: 0,
    localSupplyVoltageV: model.sourceVoltageV - path.resistanceOhm * loadCurrentA,
    sourceReferencedSupplyVoltageV: model.sourceVoltageV - path.supply.resistanceOhm * loadCurrentA,
    groundBounceVoltageV: path.ground.resistanceOhm * loadCurrentA,
  }
  if (!Object.values(result).every(Number.isFinite)) invalid("DC operating point exceeds finite numeric range")
  return result
}

const add = (a: PowerComplex, b: PowerComplex): PowerComplex => ({ re: a.re + b.re, im: a.im + b.im })
const multiply = (a: PowerComplex, b: PowerComplex): PowerComplex => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re })
function divide(a: PowerComplex, b: PowerComplex): PowerComplex {
  const scale = Math.max(Math.abs(b.re), Math.abs(b.im))
  if (scale === 0 || !Number.isFinite(scale)) throw new PowerNetworkError("singular_power_network_response", "The authored circuit has a singular response at this frequency")
  const br = b.re / scale, bi = b.im / scale, d = br * br + bi * bi
  return { re: (a.re / scale * br + a.im / scale * bi) / d, im: (a.im / scale * br - a.re / scale * bi) / d }
}

/** exp(+j omega t), incremental V/A around the declared DC operating point. */
export function getPowerNetworkFrequencyResponse(model: AuthoredPowerNetwork, frequencyHz: number) {
  const path = paths(model)
  nonnegative(frequencyHz, "frequencyHz")
  const omega = 2 * Math.PI * frequencyHz
  const loop = { re: path.resistanceOhm, im: omega * path.inductanceH }
  const ground = { re: path.ground.resistanceOhm, im: omega * path.ground.inductanceH }
  const decap = model.decap && frequencyHz > 0
    ? { re: model.decap.esrOhm, im: omega * model.decap.eslH - 1 / (omega * model.decap.capacitanceF) }
    : null // The capacitor is open at DC.
  if (![loop.re, loop.im, ground.re, ground.im, ...(decap ? [decap.re, decap.im] : [])].every(Number.isFinite)) invalid("Frequency-domain circuit parameters overflow")
  const sourceCurrentPerLoadCurrent = decap ? divide(decap, add(loop, decap)) : { re: 1, im: 0 }
  const response = {
    frequencyHz,
    decapImpedanceOhm: decap,
    sourceCurrentPerLoadCurrent,
    supplyDroopVPerA: multiply(loop, sourceCurrentPerLoadCurrent),
    groundBounceVPerA: multiply(ground, sourceCurrentPerLoadCurrent),
  }
  if (![response.sourceCurrentPerLoadCurrent, response.supplyDroopVPerA, response.groundBounceVPerA].every((v) => Number.isFinite(v.re) && Number.isFinite(v.im))) invalid("Frequency response exceeds finite numeric range")
  return response
}

export interface PowerNetworkLoadWaveform {
  /** Continuous piecewise-linear samples; gaps must be split into separate runs. */
  timesS: readonly number[]
  currentsA: readonly number[]
  /** Initial steady-state load; the first current sample must equal this value. */
  dcCurrentA: number
}

/**
 * Exact propagation for a constant slope of load current. State x=Is-Iload,
 * y=Vcap-(Vsource-Rloop*Iload) keeps the declared DC solution explicit.
 * exp(A dt) is evaluated with real stable poles or a damped sin/cos pair.
 */
function advance(
  x: number, y: number, slope: number, dt: number,
  resistance: number, inductance: number,
  decap: NonNullable<AuthoredPowerNetwork["decap"]>,
) {
  const c = decap.capacitanceF, r = resistance + decap.esrOhm, l = inductance + decap.eslH
  const equilibriumX = -c * resistance * slope
  if (l === 0) {
    const nextX = equilibriumX + Math.exp(-dt / (c * r)) * (x - equilibriumX)
    return [nextX, -r * nextX] as const
  }
  const equilibriumY = r * c * resistance * slope - inductance * slope
  const dx = x - equilibriumX, dy = y - equilibriumY
  const p = -r / (2 * l), omegaSquared = 1 / (l * c), discriminant = p * p - omegaSquared
  let diagonal: number, factor: number
  if (Math.abs(discriminant) <= Number.EPSILON * Math.max(p * p, omegaSquared) * 8) {
    diagonal = Math.exp(p * dt)
    factor = dt * diagonal
  } else if (discriminant < 0) {
    const q = Math.sqrt(-discriminant), decay = Math.exp(p * dt)
    diagonal = decay * Math.cos(q * dt)
    factor = decay * Math.sin(q * dt) / q
  } else {
    const q = Math.sqrt(discriminant)
    // Avoid cancellation in p+q and overflow in exp(p dt)*cosh(q dt).
    const slow = Math.exp(-omegaSquared / (q - p) * dt), fast = Math.exp((p - q) * dt)
    diagonal = (slow + fast) / 2
    factor = 2 * q * dt < 1e-4 ? fast * Math.expm1(2 * q * dt) / (2 * q) : (slow - fast) / (2 * q)
  }
  return [
    equilibriumX + diagonal * dx + factor * (p * dx - dy / l),
    equilibriumY + diagonal * dy + factor * (dx / c - p * dy),
  ] as const
}

export function simulateAuthoredPowerNetwork(model: AuthoredPowerNetwork, load: PowerNetworkLoadWaveform) {
  const path = paths(model)
  const { timesS, currentsA, dcCurrentA } = load
  if (timesS.length < 2 || timesS.length !== currentsA.length || !Number.isFinite(dcCurrentA) || currentsA[0] !== dcCurrentA ||
      timesS.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= timesS[i - 1])) || currentsA.some((i) => !Number.isFinite(i))) {
    throw new PowerNetworkError("invalid_load_waveform", "Require finite, strictly increasing PWL times, equal lengths and a first sample at the declared DC current")
  }
  const dcOperatingPoint = getPowerNetworkOperatingPoint(model, dcCurrentA)
  const slopes = currentsA.slice(1).map((v, i) => (v - currentsA[i]) / (timesS[i + 1] - timesS[i]))
  if (!slopes.every(Number.isFinite)) throw new PowerNetworkError("invalid_load_waveform", "Load slopes overflow; use finite-rise current edges")
  const localSupplyVoltageV: number[] = [], sourceReferencedSupplyVoltageV: number[] = [], groundBounceVoltageV: number[] = []
  const sourceCurrentA: number[] = [], decapCurrentA: number[] = []
  let x = 0, y = 0
  for (let index = 0; index < timesS.length; index++) {
    if (index > 0 && model.decap) [x, y] = advance(x, y, slopes[index - 1], timesS[index] - timesS[index - 1], path.resistanceOhm, path.inductanceH, model.decap)
    // At a PWL corner, report the right-hand voltage; the last sample uses the left slope.
    const slope = slopes[Math.min(index, slopes.length - 1)]
    const current = currentsA[index] + x
    const totalL = path.inductanceH + (model.decap?.eslH ?? 0)
    const derivative = !model.decap ? slope : totalL === 0 ? 0 :
      (-(path.resistanceOhm + model.decap.esrOhm) * x - y + model.decap.eslH * slope) / totalL
    sourceCurrentA.push(current)
    decapCurrentA.push(x)
    localSupplyVoltageV.push(model.sourceVoltageV - path.resistanceOhm * current - path.inductanceH * derivative)
    sourceReferencedSupplyVoltageV.push(model.sourceVoltageV - path.supply.resistanceOhm * current - path.supply.inductanceH * derivative)
    groundBounceVoltageV.push(path.ground.resistanceOhm * current + path.ground.inductanceH * derivative)
  }
  const supplyDeviationV = localSupplyVoltageV.map((v) => v - dcOperatingPoint.localSupplyVoltageV)
  if (![...localSupplyVoltageV, ...sourceReferencedSupplyVoltageV, ...groundBounceVoltageV, ...sourceCurrentA, ...decapCurrentA, ...supplyDeviationV].every(Number.isFinite)) {
    throw new PowerNetworkError("singular_power_network_response", "Circuit parameters or load waveform exceed finite numeric range")
  }
  return {
    modelKind: model.kind,
    modelProvenance: { origin: "authored_lumped_circuit" as const, pcbGeometryExtracted: false as const },
    reference: {
      localGroundContactId: model.contacts.localGround.contactId,
      remoteGroundContactId: model.contacts.remoteGround.contactId,
      voltageGauge: "remote_ground" as const,
      logicalNetContactsCollapsed: false as const,
    },
    initialCondition: "declared_dc_operating_point" as const,
    sampleConvention: "pwl_right_hand_except_final_left_hand" as const,
    dcOperatingPoint,
    timesS: [...timesS], loadCurrentA: [...currentsA], sourceCurrentA, decapCurrentA,
    localSupplyVoltageV, sourceReferencedSupplyVoltageV, groundBounceVoltageV,
    supplyDeviationV,
    supplyDroopV: supplyDeviationV.map((v) => v === 0 ? 0 : -v),
    groundDeviationV: groundBounceVoltageV.map((v) => v - dcOperatingPoint.groundBounceVoltageV),
  }
}
