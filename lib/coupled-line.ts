/** Browser-compatible, passive, two-conductor quasi-TEM transmission-line model.
 * Matrices are Maxwell C and loop L in SI per metre. No return-current heatmap is
 * interpreted as voltage. The cross-section extractor follows PR13's conservative
 * electrostatic flux formulation, with its vacuum solve supplying external L.
 */
export type Matrix2 = [[number, number], [number, number]]
export interface CoupledRlgc {
  R_ohm_per_m: Matrix2
  L_h_per_m: Matrix2
  C_f_per_m: Matrix2
  G_s_per_m: Matrix2
}
export interface CoupledLineGeometry {
  width_mm: number
  thickness_mm: number
  height_mm: number
  length_mm: number
  gap_mm: number
}
export interface CoupledLineMaterial {
  relative_permittivity: number
  conductivity_s_per_m: number
}
export interface ExtractionOptions {
  grid_mm?: number
  margin_mm?: number
  top_mm?: number
  relative_tolerance?: number
  maximum_iterations?: number
}
export interface ExtractionResult extends CoupledRlgc {
  C_vacuum_f_per_m: Matrix2
  diagnostics: {
    nodes: number
    unknowns: number
    grid_mm: number
    margin_mm: number
    top_mm: number
    iterations: number
    relative_residual: number
    relative_reciprocity_error: number
    electric_coupling_coefficient: number
    magnetic_coupling_coefficient: number
  }
}
const EPS0 = 8.8541878128e-12
const C0 = 299792458
const positive = (v: number, name: string) => {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be positive and finite`)
  return v
}
const nonnegative = (v: number, name: string) => {
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be nonnegative and finite`)
  return v
}
function inverse(a: Matrix2): Matrix2 {
  const determinant = a[0][0] * a[1][1] - a[0][1] * a[1][0]
  if (!(determinant > 0)) throw new Error("Matrix must be positive definite")
  return [[a[1][1] / determinant, -a[0][1] / determinant], [-a[1][0] / determinant, a[0][0] / determinant]]
}
function checkMatrix(a: Matrix2, name: string, definite: boolean) {
  if (a.length !== 2 || a.some((row) => row.length !== 2 || row.some((x) => !Number.isFinite(x)))) throw new Error(`${name} must be a finite 2x2 matrix`)
  const scale = Math.max(...a.flat().map(Math.abs), Number.MIN_VALUE)
  if (Math.abs(a[0][1] - a[1][0]) > scale * 1e-10) throw new Error(`${name} must be reciprocal`)
  const determinant = a[0][0] * a[1][1] - a[0][1] * a[1][0]
  if (a[0][0] < 0 || a[1][1] < 0 || determinant < -scale * scale * 1e-12 || (definite && (a[0][0] <= 0 || determinant <= 0))) throw new Error(`${name} must be ${definite ? "positive definite" : "positive semidefinite"}`)
}
export function validateCoupledRlgc(a: CoupledRlgc): void {
  checkMatrix(a.L_h_per_m, "L", true)
  checkMatrix(a.C_f_per_m, "C", true)
  checkMatrix(a.R_ohm_per_m, "R", false)
  checkMatrix(a.G_s_per_m, "G", false)
  if (a.C_f_per_m[0][1] > 0 || a.C_f_per_m.some((row) => row[0] + row[1] <= 0)) throw new Error("C must use Maxwell signs and have positive ground capacitance")
}

function meshAxis(breaks: number[], fine: number, fineRegion: [number, number]): number[] {
  const result: number[] = []
  const sorted = [...new Set(breaks)].sort((a, b) => a - b)
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1], middle = (a + b) / 2
    const distance = Math.max(fineRegion[0] - middle, middle - fineRegion[1], 0)
    const step = Math.min(fine * Math.max(1, distance / 0.0004), 0.00025)
    const count = Math.max(1, Math.ceil((b - a) / step))
    for (let j = 0; j < count; j++) result.push(a + (b - a) * j / count)
  }
  result.push(sorted[sorted.length - 1])
  return result
}

/** Finite-volume electrostatic extraction. Ground is the actual verified bottom
 * plane, idealized as infinite; outer top/side boundaries have zero normal flux.
 * Domain and mesh convergence are separate checks, not inferred from residuals.
 */
export function extractCoupledRlgc(geometry: CoupledLineGeometry, material: CoupledLineMaterial, options: ExtractionOptions = {}): ExtractionResult {
  const w = positive(geometry.width_mm, "width_mm") * 1e-3
  const t = positive(geometry.thickness_mm, "thickness_mm") * 1e-3
  const h = positive(geometry.height_mm, "height_mm") * 1e-3
  const s = positive(geometry.gap_mm, "gap_mm") * 1e-3
  positive(geometry.length_mm, "length_mm")
  const er = positive(material.relative_permittivity, "relative_permittivity")
  if (er < 1) throw new Error("Relative permittivity below vacuum is unsupported")
  const sigma = positive(material.conductivity_s_per_m, "conductivity_s_per_m")
  const grid = positive(options.grid_mm ?? Math.min(geometry.width_mm, geometry.height_mm, geometry.gap_mm) / 8, "grid_mm")
  const margin = positive(options.margin_mm ?? Math.max(2, geometry.height_mm * 8), "margin_mm")
  const top = positive(options.top_mm ?? Math.max(2, (geometry.height_mm + geometry.thickness_mm) * 8), "top_mm")
  if (top * 1e-3 <= h + t || margin * 1e-3 < w) throw new Error("Extraction domain must extend above and beside the conductors")
  const fine = grid * 1e-3, edge = s / 2 + w
  const outer = [0.0004, 0.001, 0.002, 0.004, 0.008].filter((d) => d < margin * 1e-3)
  const x = meshAxis([-edge - margin * 1e-3, ...outer.map((d) => -edge - d), -edge, -s / 2, s / 2, edge, ...outer.map((d) => edge + d), edge + margin * 1e-3], fine, [-edge - 0.0004, edge + 0.0004])
  const y = meshAxis([0, h, h + t, ...[h + t + 0.0004, 0.001, 0.002, 0.004, 0.008].filter((v) => v > h + t && v < top * 1e-3), top * 1e-3], fine, [0, h + t + 0.0004])
  const nx = x.length, ny = y.length, nodes = nx * ny
  if (nodes > 400000) throw new Error("Electrostatic extraction exceeds the 400000-node resource budget")
  const labels = new Int8Array(nodes).fill(-1), unknownIds = new Int32Array(nodes).fill(-1)
  let unknowns = 0
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const id = iy * nx + ix
    if (iy === 0) labels[id] = 0
    else if (y[iy] >= h - 1e-15 && y[iy] <= h + t + 1e-15) {
      if (x[ix] >= -edge - 1e-15 && x[ix] <= -s / 2 + 1e-15) labels[id] = 1
      if (x[ix] >= s / 2 - 1e-15 && x[ix] <= edge + 1e-15) labels[id] = 2
    }
    if (labels[id] < 0) unknownIds[id] = unknowns++
  }
  const realSolve = electrostaticCapacitance(x, y, labels, h, er, options)
  const vacuumSolve = electrostaticCapacitance(x, y, labels, h, 1, options)
  const capacitance = realSolve.capacitance, vacuum = vacuumSolve.capacitance
  const totalIterations = realSolve.iterations + vacuumSolve.iterations
  const maximumResidual = Math.max(realSolve.relative_residual, vacuumSolve.relative_residual)
  const maximumReciprocity = Math.max(realSolve.relative_reciprocity_error, vacuumSolve.relative_reciprocity_error)
  const inductance = inverse(vacuum).map((row) => row.map((v) => v / C0 ** 2)) as Matrix2
  const resistance = 1 / (sigma * w * t)
  const model: CoupledRlgc = { C_f_per_m: capacitance, L_h_per_m: inductance, R_ohm_per_m: [[resistance, 0], [0, resistance]], G_s_per_m: [[0, 0], [0, 0]] }
  validateCoupledRlgc(model)
  return { ...model, C_vacuum_f_per_m: vacuum, diagnostics: { nodes, unknowns, grid_mm: grid, margin_mm: margin, top_mm: top, iterations: totalIterations, relative_residual: maximumResidual, relative_reciprocity_error: maximumReciprocity, electric_coupling_coefficient: -capacitance[0][1] / Math.sqrt(capacitance[0][0] * capacitance[1][1]), magnetic_coupling_coefficient: inductance[0][1] / Math.sqrt(inductance[0][0] * inductance[1][1]) } }
}

/** Conservative finite-volume Maxwell capacitance, exposed for independent
 * exact parallel-plate and layered-interface benchmarks. Labels are -1 for
 * unknown potential, 0 for ground and 1/2 for the signal electrodes.
 */
export function electrostaticCapacitance(x: readonly number[], y: readonly number[], labels: Int8Array, h: number, er: number, options: ExtractionOptions = {}): {
  capacitance: Matrix2; iterations: number; relative_residual: number; relative_reciprocity_error: number
} {
  const nx = x.length, ny = y.length
  if (nx < 2 || ny < 2 || labels.length !== nx * ny || labels.some((v) => v < -1 || v > 2) || !labels.includes(0) || !labels.includes(1) || !labels.includes(2)) throw new Error("Electrostatic grid requires ground and two electrodes")
  for (const axis of [x, y]) for (let i = 0; i < axis.length; i++) if (!Number.isFinite(axis[i]) || (i && axis[i] <= axis[i - 1])) throw new Error("Electrostatic axes must be finite and strictly increasing")
  positive(er, "relative permittivity")
  const unknownIds = new Int32Array(labels.length).fill(-1)
  let unknowns = 0
  for (let i = 0; i < labels.length; i++) if (labels[i] < 0) unknownIds[i] = unknowns++
  const edgesA: number[] = [], edgesB: number[] = [], airConductance: number[] = [], realConductance: number[] = []
  const dual = (axis: readonly number[], i: number) => (i === 0 ? axis[1] - axis[0] : i === axis.length - 1 ? axis[i] - axis[i - 1] : axis[i + 1] - axis[i - 1]) / 2
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const id = iy * nx + ix
    if (ix + 1 < nx) {
      const face = dual(y, iy), low = iy === 0 ? y[0] : (y[iy - 1] + y[iy]) / 2
      const high = iy === ny - 1 ? y[iy] : (y[iy] + y[iy + 1]) / 2
      const below = Math.max(0, Math.min(high, h) - low)
      edgesA.push(id); edgesB.push(id + 1)
      airConductance.push(EPS0 * face / (x[ix + 1] - x[ix]))
      realConductance.push(EPS0 * (face + (er - 1) * below) / (x[ix + 1] - x[ix]))
    }
    if (iy + 1 < ny) {
      const g = EPS0 * dual(x, ix) / (y[iy + 1] - y[iy])
      edgesA.push(id); edgesB.push(id + nx); airConductance.push(g)
      realConductance.push(g * ((y[iy] + y[iy + 1]) / 2 < h ? er : 1))
    }
  }
  const tolerance = positive(options.relative_tolerance ?? 1e-10, "relative_tolerance")
  const maxIterations = options.maximum_iterations ?? 10000
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100000) throw new Error("maximum_iterations is outside resource limits")
  let totalIterations = 0, maximumResidual = 0, maximumReciprocity = 0
  function solveCapacitance(conductance: number[]): Matrix2 {
    const diagonal = new Float64Array(unknowns)
    const rhs = [new Float64Array(unknowns), new Float64Array(unknowns)]
    for (let e = 0; e < edgesA.length; e++) {
      const a = edgesA[e], b = edgesB[e], ua = unknownIds[a], ub = unknownIds[b], g = conductance[e]
      if (ua >= 0) { diagonal[ua] += g; if (labels[b] > 0) rhs[labels[b] - 1][ua] += g }
      if (ub >= 0) { diagonal[ub] += g; if (labels[a] > 0) rhs[labels[a] - 1][ub] += g }
    }
    const apply = (v: Float64Array, out: Float64Array) => {
      for (let i = 0; i < unknowns; i++) out[i] = diagonal[i] * v[i]
      for (let e = 0; e < edgesA.length; e++) {
        const a = unknownIds[edgesA[e]], b = unknownIds[edgesB[e]]
        if (a >= 0 && b >= 0) { out[a] -= conductance[e] * v[b]; out[b] -= conductance[e] * v[a] }
      }
    }
    const cap: Matrix2 = [[0, 0], [0, 0]]
    for (let basis = 0; basis < 2; basis++) {
      const phi = new Float64Array(unknowns), residual = rhs[basis].slice()
      const z = new Float64Array(unknowns), p = new Float64Array(unknowns), ap = new Float64Array(unknowns)
      let rz = 0, normB = 0
      for (let i = 0; i < unknowns; i++) { z[i] = residual[i] / diagonal[i]; p[i] = z[i]; rz += residual[i] * z[i]; normB += rhs[basis][i] ** 2 }
      let relativeResidual = Infinity, iteration = 0
      for (; iteration < maxIterations; iteration++) {
        apply(p, ap)
        let pap = 0
        for (let i = 0; i < unknowns; i++) pap += p[i] * ap[i]
        if (!(pap > 0)) throw new Error("Electrostatic operator lost positive definiteness")
        const alpha = rz / pap
        let normR = 0, nextRz = 0
        for (let i = 0; i < unknowns; i++) { phi[i] += alpha * p[i]; residual[i] -= alpha * ap[i]; normR += residual[i] ** 2; z[i] = residual[i] / diagonal[i]; nextRz += residual[i] * z[i] }
        relativeResidual = Math.sqrt(normR / normB)
        if (relativeResidual <= tolerance) { iteration++; break }
        const beta = nextRz / rz
        for (let i = 0; i < unknowns; i++) p[i] = z[i] + beta * p[i]
        rz = nextRz
      }
      if (relativeResidual > tolerance) throw new Error(`Electrostatic solve did not converge: residual ${relativeResidual}`)
      totalIterations += iteration; maximumResidual = Math.max(maximumResidual, relativeResidual)
      const voltage = (id: number) => unknownIds[id] >= 0 ? phi[unknownIds[id]] : labels[id] === basis + 1 ? 1 : 0
      for (let e = 0; e < edgesA.length; e++) {
        const a = edgesA[e], b = edgesB[e], flux = conductance[e] * (voltage(a) - voltage(b))
        if (labels[a] > 0) cap[labels[a] - 1][basis] += flux
        if (labels[b] > 0) cap[labels[b] - 1][basis] -= flux
      }
    }
    const reciprocity = Math.abs(cap[0][1] - cap[1][0]) / Math.max(...cap.flat().map(Math.abs))
    maximumReciprocity = Math.max(maximumReciprocity, reciprocity)
    if (reciprocity > 1e-7) throw new Error("Electrostatic reciprocity check failed")
    cap[0][1] = cap[1][0] = (cap[0][1] + cap[1][0]) / 2
    return cap
  }
  const capacitance = solveCapacitance(realConductance)
  return {capacitance, iterations: totalIterations, relative_residual: maximumResidual, relative_reciprocity_error: maximumReciprocity}
}

export interface LineTestbench {
  source_resistance_ohms: number
  load_resistance_ohms: number
  load_capacitance_f?: number
  load_bias_voltage_v?: number
  waveform?: [number, number][]
  source_voltage?: (time_s: number) => number
  minimum_transition_s?: number
}
export interface TransientOptions {
  length_m: number
  duration_s: number
  sample_interval_s: number
  segments?: number
  initial_condition?: "zero" | "dc_equilibrium"
  maximum_internal_steps?: number
}
export interface CoupledTransient {
  time_s: number[]
  near_voltage_v: [number[], number[]]
  far_voltage_v: [number[], number[]]
  near_current_a: [number[], number[]]
  far_current_a: [number[], number[]]
  diagnostics: { segments: number; internal_step_s: number; internal_steps: number; initial_condition: "zero" | "dc_equilibrium" }
}
export function countTransientSamples(duration_s: number, sample_interval_s: number): number {
  const ratio = positive(duration_s, "duration_s") / positive(sample_interval_s, "sample_interval_s"), nearest = Math.round(ratio)
  return (nearest >= 1 && Math.abs(ratio - nearest) < 1e-9 ? nearest : Math.ceil(ratio)) + 1
}
function sourceEvaluator(line: LineTestbench): (t: number) => number {
  if ((line.waveform === undefined) === (line.source_voltage === undefined)) throw new Error("Supply exactly one PWL waveform or source_voltage evaluator")
  if (line.source_voltage) return line.source_voltage
  const points = line.waveform!
  if (points.length < 1 || points.length > 10000 || points[0][0] !== 0) throw new Error("PWL needs time zero and at most 10000 knots")
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i][0]) || !Number.isFinite(points[i][1]) || points[i][0] < 0 || (i && points[i][0] <= points[i - 1][0])) throw new Error("PWL points must be finite and strictly increasing in seconds")
  }
  return (t: number) => {
    let low = 0, high = points.length - 1
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (points[mid][0] <= t) low = mid; else high = mid - 1 }
    if (low === points.length - 1) return points[low][1]
    const a = points[low], b = points[low + 1]
    return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0])
  }
}

/** Staggered finite-volume transmission-line ladder. C is split into half cells
 * at the ends; R,L sit on current edges; loads and drivers remain outside RLGC.
 * RK4 integrates actual coupled states, including the true zero-mutual control.
 */
export function simulateCoupledLines(rlgc: CoupledRlgc, lines: [LineTestbench, LineTestbench], options: TransientOptions): CoupledTransient {
  validateCoupledRlgc(rlgc)
  const length = positive(options.length_m, "length_m"), duration = positive(options.duration_s, "duration_s"), sample = positive(options.sample_interval_s, "sample_interval_s")
  const segments = options.segments ?? 64
  if (!Number.isInteger(segments) || segments < 4 || segments > 2048) throw new Error("segments must be an integer from 4 through 2048")
  if (countTransientSamples(duration, sample) > 100000) throw new Error("Transient exceeds the 100000-sample resource budget")
  const source = lines.map(sourceEvaluator)
  for (const line of lines) { positive(line.source_resistance_ohms, "source resistance"); positive(line.load_resistance_ohms, "load resistance"); nonnegative(line.load_capacitance_f ?? 0, "load capacitance"); if (!Number.isFinite(line.load_bias_voltage_v ?? 0)) throw new Error("Load bias must be finite") }
  const dx = length / segments, ci = inverse(rlgc.C_f_per_m), li = inverse(rlgc.L_h_per_m)
  const product00 = rlgc.L_h_per_m[0][0] * rlgc.C_f_per_m[0][0] + rlgc.L_h_per_m[0][1] * rlgc.C_f_per_m[1][0]
  const product11 = rlgc.L_h_per_m[1][0] * rlgc.C_f_per_m[0][1] + rlgc.L_h_per_m[1][1] * rlgc.C_f_per_m[1][1]
  const product01 = rlgc.L_h_per_m[0][0] * rlgc.C_f_per_m[0][1] + rlgc.L_h_per_m[0][1] * rlgc.C_f_per_m[1][1]
  const product10 = rlgc.L_h_per_m[1][0] * rlgc.C_f_per_m[0][0] + rlgc.L_h_per_m[1][1] * rlgc.C_f_per_m[1][0]
  const smallestLc = (product00 + product11 - Math.sqrt(Math.max(0, (product00 - product11) ** 2 + 4 * product01 * product10))) / 2
  if (!(smallestLc > 0)) throw new Error("Invalid line propagation modes")
  const nodeInverse = Array.from({ length: segments + 1 }, (_, n) => {
    const scale = dx * ((n === 0 || n === segments) ? 0.5 : 1)
    const c: Matrix2 = [[rlgc.C_f_per_m[0][0] * scale, rlgc.C_f_per_m[0][1] * scale], [rlgc.C_f_per_m[1][0] * scale, rlgc.C_f_per_m[1][1] * scale]]
    if (n === segments) for (let k = 0; k < 2; k++) c[k][k] += lines[k].load_capacitance_f ?? 0
    return inverse(c)
  })
  let maximumStep = dx * Math.sqrt(smallestLc) * 0.3
  for (let k = 0; k < 2; k++) {
    maximumStep = Math.min(maximumStep, 0.3 * lines[k].source_resistance_ohms / nodeInverse[0][k][k], 0.3 * lines[k].load_resistance_ohms / nodeInverse[segments][k][k])
    if (lines[k].minimum_transition_s !== undefined) maximumStep = Math.min(maximumStep, positive(lines[k].minimum_transition_s!, "minimum_transition_s") / 10)
  }
  const rRate = Math.max(...li.flat().map(Math.abs)) * Math.max(...rlgc.R_ohm_per_m.flat().map(Math.abs)) * 4
  const gRate = Math.max(...ci.flat().map(Math.abs)) * Math.max(...rlgc.G_s_per_m.flat().map(Math.abs)) * 4
  if (rRate) maximumStep = Math.min(maximumStep, 0.3 / rRate)
  if (gRate) maximumStep = Math.min(maximumStep, 0.3 / gRate)
  const stepsPerSample = Math.max(1, Math.ceil(sample / maximumStep)), dt = sample / stepsPerSample
  const estimatedSteps = Math.ceil(duration / dt)
  const maxSteps = options.maximum_internal_steps ?? 2000000
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || estimatedSteps > maxSteps) throw new Error(`Transient exceeds the ${maxSteps}-internal-step resource budget`)
  const voltageLength = 2 * (segments + 1), stateLength = voltageLength + 2 * segments
  const state = new Float64Array(stateLength), k1 = new Float64Array(stateLength), k2 = new Float64Array(stateLength), k3 = new Float64Array(stateLength), k4 = new Float64Array(stateLength), temp = new Float64Array(stateLength)
  const initial = options.initial_condition ?? "zero"
  if (initial === "zero") {
    if (lines.some((line, k) => Math.abs(source[k](0)) > 1e-12 || Math.abs(line.load_bias_voltage_v ?? 0) > 1e-12)) throw new Error("Nonzero initial sources or load bias require dc_equilibrium initial condition")
  } else if (initial === "dc_equilibrium") {
    if (rlgc.G_s_per_m.flat().some((v) => v !== 0)) throw new Error("DC equilibrium with distributed shunt conductance is unsupported")
    const totalR: Matrix2 = [[rlgc.R_ohm_per_m[0][0] * length + lines[0].source_resistance_ohms + lines[0].load_resistance_ohms, rlgc.R_ohm_per_m[0][1] * length], [rlgc.R_ohm_per_m[1][0] * length, rlgc.R_ohm_per_m[1][1] * length + lines[1].source_resistance_ohms + lines[1].load_resistance_ohms]]
    const ri = inverse(totalR), b0 = source[0](0) - (lines[0].load_bias_voltage_v ?? 0), b1 = source[1](0) - (lines[1].load_bias_voltage_v ?? 0)
    const currents = [ri[0][0] * b0 + ri[0][1] * b1, ri[1][0] * b0 + ri[1][1] * b1]
    for (let n = 0; n <= segments; n++) for (let k = 0; k < 2; k++) state[n * 2 + k] = source[k](0) - currents[k] * lines[k].source_resistance_ohms - n * dx * (rlgc.R_ohm_per_m[k][0] * currents[0] + rlgc.R_ohm_per_m[k][1] * currents[1])
    for (let n = 0; n < segments; n++) for (let k = 0; k < 2; k++) state[voltageLength + n * 2 + k] = currents[k]
  } else throw new Error("Unknown initial condition")
  function derivative(t: number, x: Float64Array, out: Float64Array) {
    const supplied = [source[0](t), source[1](t)]
    if (supplied.some((v) => !Number.isFinite(v))) throw new Error("Source evaluator returned a nonfinite voltage")
    for (let n = 0; n <= segments; n++) {
      const v0 = x[n * 2], v1 = x[n * 2 + 1], scale = dx * ((n === 0 || n === segments) ? 0.5 : 1)
      let i0 = n ? x[voltageLength + (n - 1) * 2] : (supplied[0] - v0) / lines[0].source_resistance_ohms
      let i1 = n ? x[voltageLength + (n - 1) * 2 + 1] : (supplied[1] - v1) / lines[1].source_resistance_ohms
      i0 -= n < segments ? x[voltageLength + n * 2] : (v0 - (lines[0].load_bias_voltage_v ?? 0)) / lines[0].load_resistance_ohms
      i1 -= n < segments ? x[voltageLength + n * 2 + 1] : (v1 - (lines[1].load_bias_voltage_v ?? 0)) / lines[1].load_resistance_ohms
      i0 -= scale * (rlgc.G_s_per_m[0][0] * v0 + rlgc.G_s_per_m[0][1] * v1)
      i1 -= scale * (rlgc.G_s_per_m[1][0] * v0 + rlgc.G_s_per_m[1][1] * v1)
      const inv = nodeInverse[n]
      out[n * 2] = inv[0][0] * i0 + inv[0][1] * i1
      out[n * 2 + 1] = inv[1][0] * i0 + inv[1][1] * i1
    }
    for (let n = 0; n < segments; n++) {
      const id = voltageLength + n * 2, i0 = x[id], i1 = x[id + 1]
      const v0 = (x[n * 2] - x[n * 2 + 2]) / dx - rlgc.R_ohm_per_m[0][0] * i0 - rlgc.R_ohm_per_m[0][1] * i1
      const v1 = (x[n * 2 + 1] - x[n * 2 + 3]) / dx - rlgc.R_ohm_per_m[1][0] * i0 - rlgc.R_ohm_per_m[1][1] * i1
      out[id] = li[0][0] * v0 + li[0][1] * v1
      out[id + 1] = li[1][0] * v0 + li[1][1] * v1
    }
  }
  const result: CoupledTransient = { time_s: [], near_voltage_v: [[], []], far_voltage_v: [[], []], near_current_a: [[], []], far_current_a: [[], []], diagnostics: { segments, internal_step_s: dt, internal_steps: 0, initial_condition: initial } }
  function record(t: number) {
    result.time_s.push(t)
    const hasLoadCapacitance = lines.some((line) => (line.load_capacitance_f ?? 0) > 0)
    if (hasLoadCapacitance) derivative(t, state, k1)
    for (let k = 0; k < 2; k++) {
      const near = state[k], far = state[segments * 2 + k]
      if (!Number.isFinite(near) || !Number.isFinite(far)) throw new Error("Transient integration produced a nonfinite state")
      result.near_voltage_v[k].push(near); result.far_voltage_v[k].push(far)
      result.near_current_a[k].push((source[k](t) - near) / lines[k].source_resistance_ohms)
      // Both terminal currents use the network-inward convention.
      const resistorCurrent = (far - (lines[k].load_bias_voltage_v ?? 0)) / lines[k].load_resistance_ohms
      const capacitorCurrent = hasLoadCapacitance ? (lines[k].load_capacitance_f ?? 0) * k1[segments * 2 + k] : 0
      result.far_current_a[k].push(-(resistorCurrent + capacitorCurrent))
    }
  }
  record(0)
  const outputs = countTransientSamples(duration, sample) - 1
  let t = 0
  for (let output = 1; output <= outputs; output++) {
    const end = output === outputs ? duration : output * sample, hstep = (end - t) / Math.ceil((end - t) / dt)
    while (t < end - hstep * 1e-6) {
      derivative(t, state, k1)
      for (let i = 0; i < stateLength; i++) temp[i] = state[i] + hstep * k1[i] / 2
      derivative(t + hstep / 2, temp, k2)
      for (let i = 0; i < stateLength; i++) temp[i] = state[i] + hstep * k2[i] / 2
      derivative(t + hstep / 2, temp, k3)
      for (let i = 0; i < stateLength; i++) temp[i] = state[i] + hstep * k3[i]
      derivative(t + hstep, temp, k4)
      for (let i = 0; i < stateLength; i++) state[i] += hstep * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6
      t += hstep; result.diagnostics.internal_steps++
    }
    t = end; record(t)
  }
  return result
}

/** Coupling checks deliberately inspect off-diagonal terms separately: a small
 * total-matrix error can conceal a large error on a quiet victim.
 */
export function compareRlgcCoupling(a: CoupledRlgc, b: CoupledRlgc, tolerances = { relative: 0.02, capacitance_absolute_f_per_m: 1e-13, inductance_absolute_h_per_m: 1e-10 }) {
  validateCoupledRlgc(a); validateCoupledRlgc(b)
  const difference = (x: number, y: number, floor: number) => ({ absolute: Math.abs(x - y), relative: Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), floor), passes: Math.abs(x - y) <= Math.max(floor, tolerances.relative * Math.max(Math.abs(x), Math.abs(y))) })
  const capacitance = difference(a.C_f_per_m[0][1], b.C_f_per_m[0][1], tolerances.capacitance_absolute_f_per_m)
  const inductance = difference(a.L_h_per_m[0][1], b.L_h_per_m[0][1], tolerances.inductance_absolute_h_per_m)
  return { capacitance, inductance, passes: capacitance.passes && inductance.passes }
}
