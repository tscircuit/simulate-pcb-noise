import { countTransientSamples, type CoupledLineGeometry, type CoupledLineMaterial } from "./coupled-line"

type RecordValue = Record<string, unknown>
export type CoupledGeometryIssueCode = "missing_physical_data" | "unsupported_geometry" | "missing_reference_plane" | "invalid_noise_configuration" | "unresolved_contact" | "unsupported_model"
export interface CoupledGeometryIssue { code: CoupledGeometryIssueCode; message: string; element_ids: string[] }
export interface ConfiguredLine {
  trace_id: string
  near_port_name: string
  far_port_name: string
  source: RecordValue
  termination: RecordValue
}
export interface CoupledPhysicalModel {
  geometry: CoupledLineGeometry
  material: CoupledLineMaterial
  lines: [ConfiguredLine, ConfiguredLine]
  duration_s: number
  sample_interval_s: number
  reference_pour_id: string
  stackup_source: "specified" | "assumed"
  reference_frequency_hz: number
}
export interface CoupledGeometryReport {
  status: "complete" | "unsupported" | "missing_data"
  issues: CoupledGeometryIssue[]
  assumptions: string[]
  model?: CoupledPhysicalModel
}
export const coupledLineAssumptions = [
  "Uniform two-conductor quasi-TEM cross-section with explicit constant relative permittivity and zero dielectric loss.",
  "Verified continuous bottom ground is idealized as an infinite equipotential nonmagnetic reference; finite-ground resistance, ground bounce and plane edges are outside this model.",
  "Top copper supplies DC series resistance; skin effect, surface roughness and internal inductance are omitted.",
  "Pad launches and solder, component bodies, soldermask, vias and dielectric dispersion are outside this model; no material properties are inferred from a part name or FR4 label.",
  "Mesh, domain and transient convergence measure numerical uncertainty separately from the omitted physical effects.",
]
class GeometryProblem extends Error {
  constructor(readonly status: "unsupported" | "missing_data", readonly code: CoupledGeometryIssueCode, message: string, readonly ids: string[] = []) { super(message) }
}
const fail = (code: CoupledGeometryIssueCode, message: string, ids: string[] = [], status: "unsupported" | "missing_data" = "unsupported"): never => { throw new GeometryProblem(status, code, message, ids) }
const object = (value: unknown, message: string): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("missing_physical_data", message, [], "missing_data")
  return value as RecordValue
}
const number = (value: unknown, name: string, positive = false): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive && value <= 0)) return fail("missing_physical_data", `Supply ${positive ? "positive " : ""}finite ${name}`, [], "missing_data")
  return value
}
const string = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) return fail("invalid_noise_configuration", `Missing ${name}`)
  return value
}
const array = (value: unknown, name: string): RecordValue[] => {
  if (!Array.isArray(value)) return fail("invalid_noise_configuration", `${name} must be an array`)
  return value.map((v) => object(v, `${name} entries must be records`))
}
const layerName = (value: unknown) => typeof value === "string" ? value : object(value, "Invalid layer reference").name
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-7
const pcbAnnotation = /(?:_error|_warning)$|^pcb_(?:silkscreen|note|fabrication_note|courtyard)(?:_|$)|^pcb_(?:trace_hint|breakout_point|debug_object)$/
const isPhysicalPcb = (type: unknown) => typeof type === "string" && type.startsWith("pcb_") && !pcbAnnotation.test(type)
const uniformPcbTypes = new Set(["pcb_board", "pcb_component", "pcb_port", "pcb_trace", "pcb_smtpad", "pcb_copper_pour", "pcb_solder_paste", "pcb_soldermask_opening", "pcb_net", "pcb_group", "pcb_keepout"])
// Coordinate comparisons tolerate only roundoff (in mm), not physical clearance.
const contains = (bounds: [number, number, number, number], x: number, y: number, margin = 0) => {
  const epsilon = 32 * Number.EPSILON * Math.max(1, ...bounds.map(Math.abs), Math.abs(x), Math.abs(y), margin)
  return x >= bounds[0] + margin - epsilon && x <= bounds[1] - margin + epsilon && y >= bounds[2] + margin - epsilon && y <= bounds[3] - margin + epsilon
}

/** Strict adapter from the physical noise contract to the uniform-line tier.
 * It reads records without mutating route order or silently inventing ground.
 */
export function buildCoupledLineModel(circuitJson: readonly unknown[], configuration: unknown): CoupledGeometryReport {
  try {
    const records = circuitJson.map((v) => object(v, "Circuit JSON must contain records"))
    const config = object(configuration, "Supply a noise configuration")
    if (config.type !== "simulation_pcb_noise_configuration") fail("invalid_noise_configuration", "Expected simulation_pcb_noise_configuration")
    const id = string(config.simulation_pcb_noise_configuration_id, "configuration ID")
    const boards = records.filter((e) => e.type === "pcb_board")
    if (boards.length !== 1 || boards[0].pcb_board_id !== config.pcb_board_id) fail("unsupported_geometry", "Select the single physical board owned by the configuration", [id])
    const board = boards[0], stackup = object(board.stackup, "Supply pcb_board.stackup; material names do not define physical parameters")
    if (stackup.source !== "specified" && stackup.source !== "assumed") fail("missing_physical_data", "stackup.source must be specified or assumed", [], "missing_data")
    const layers = array(stackup.layers, "stackup.layers")
    if (board.num_layers !== 2 || layers.length !== 3 || layers[0].type !== "copper" || layerName(layers[0].layer) !== "top" || layers[1].type !== "dielectric" || layers[2].type !== "copper" || layerName(layers[2].layer) !== "bottom") fail("unsupported_geometry", "Supported stackup is top copper / one dielectric / bottom copper")
    const thickness = number(layers[0].thickness_mm, "top copper thickness_mm", true), height = number(layers[1].thickness_mm, "dielectric thickness_mm", true), bottomThickness = number(layers[2].thickness_mm, "bottom copper thickness_mm", true)
    const conductivity = number(layers[0].conductivity_s_per_m, "top conductivity_s_per_m", true)
    number(layers[2].conductivity_s_per_m, "bottom conductivity_s_per_m", true)
    if (board.thickness !== undefined && !close(number(board.thickness, "board thickness", true), thickness + height + bottomThickness)) fail("unsupported_geometry", "Board thickness must include the supplied dielectric and both copper foils")
    const er = number(layers[1].dielectric_constant, "dielectric_constant", true)
    if (er < 1) fail("unsupported_model", "Relative permittivity below vacuum is unsupported")
    const referenceFrequency = number(layers[1].dielectric_constant_frequency_hz, "dielectric_constant_frequency_hz", true)
    const lossFrequency = number(layers[1].dielectric_loss_tangent_frequency_hz, "dielectric_loss_tangent_frequency_hz", true)
    const loss = number(layers[1].dielectric_loss_tangent, "dielectric_loss_tangent")
    if (loss !== 0 || !close(referenceFrequency / lossFrequency, 1)) fail("unsupported_model", "The bounded provider requires explicitly supplied zero dielectric loss at the same permittivity reference frequency")
    const unsupported = records.find((e) => isPhysicalPcb(e.type) && !uniformPcbTypes.has(String(e.type)))
    if (unsupported) fail("unsupported_geometry", `${unsupported.type} physical geometry is outside the uniform-line tier`)

    const pours = records.filter((e) => e.type === "pcb_copper_pour")
    if (pours.length !== 1) fail("missing_reference_plane", "Supply exactly one continuous bottom ground pour", [], "missing_data")
    const pour = pours[0], pourId = string(pour.pcb_copper_pour_id, "reference pour ID")
    const ground = records.filter((e) => e.type === "source_net" && e.source_net_id === pour.source_net_id)
    if (layerName(pour.layer) !== "bottom" || ground.length !== 1 || ground[0].is_ground !== true) fail("missing_reference_plane", "Reference pour must be bottom copper owned by one explicit ground source_net", [pourId], "missing_data")
    const planeBounds = rectangleBounds(pour)
    const boardBounds = rectangleBounds(board.outline !== undefined || board.shape === "polygon" ? { shape: "polygon", points: board.outline } : { ...board, shape: "rect" })
    if (!contains(boardBounds, planeBounds[0], planeBounds[2]) || !contains(boardBounds, planeBounds[1], planeBounds[3])) fail("unsupported_geometry", "Reference plane must lie within the actual rectangular board outline", [pourId])
    const inPlane = (x: number, y: number, margin = 0) => contains(planeBounds, x, y, margin)
    const sourceTraces = records.filter((e) => e.type === "source_trace")
    const groundTrace = (trace: RecordValue) => {
      const connection = sourceTraces.find((e) => e.source_trace_id === trace.source_trace_id)
      return Array.isArray(connection?.connected_source_net_ids) && connection!.connected_source_net_ids.includes(pour.source_net_id)
    }
    const traces = records.filter((e) => e.type === "pcb_trace").filter((trace) => {
      const route = array(trace.route, "trace route")
      // Core may emit duplicate routes wholly inside the already-modelled pour.
      const insideGround = groundTrace(trace) && route.every((p) => p.route_type === "wire" && layerName(p.layer) === "bottom" && p.start_width === undefined && p.end_width === undefined && p.width_interpolation_mode === undefined && p.copper_pour_id === pourId && p.is_inside_copper_pour === true && inPlane(number(p.x, "ground x"), number(p.y, "ground y"), number(p.width, "ground width", true) / 2))
      return !insideGround
    })
    if (traces.length !== 2) fail("unsupported_geometry", "Require exactly two signal traces; other copper must be explicitly inside the verified bottom ground pour")
    const configPorts = array(config.ports, "ports"), sources = array(config.sources, "sources"), terminations = array(config.terminations, "terminations")
    if (configPorts.length !== 4 || sources.length !== 2 || terminations.length !== 2) fail("invalid_noise_configuration", "Two-line tier requires four physical ports, two sources and two terminations")
    const names = configPorts.map((p) => string(p.name, "port name"))
    if (new Set(names).size !== names.length) fail("invalid_noise_configuration", "Physical port names must be unique")
    const ports = records.filter((e) => e.type === "pcb_port"), sourcePorts = records.filter((e) => e.type === "source_port")
    const pads = records.filter((e) => e.type === "pcb_smtpad"), usedPads = new Set<RecordValue>()
    function contact(port: RecordValue, signal: boolean): RecordValue {
      const c = object(port[signal ? "signal_contact" : "reference_contact"], "Missing physical contact")
      const x = number(c.x, "contact x"), y = number(c.y, "contact y"), layer = layerName(c.layer)
      if (signal && c.contact_type !== "pcb_port") fail("unresolved_contact", "Signal contact must be a physical pcb_port")
      if (c.contact_type === "pcb_port") {
        const found = ports.filter((p) => p.pcb_port_id === c.pcb_port_id)
        if (found.length !== 1 || !close(number(found[0].x, "pcb_port x"), x) || !close(number(found[0].y, "pcb_port y"), y) || !Array.isArray(found[0].layers) || !found[0].layers.some((l) => layerName(l) === layer)) fail("unresolved_contact", "Authored contact must match exactly one physical pcb_port coordinate and layer", [String(c.pcb_port_id)])
        const matchingPads = pads.filter((p) => p.pcb_port_id === c.pcb_port_id && layerName(p.layer) === layer)
        if (matchingPads.length !== 1) fail("unresolved_contact", "A pcb_port contact needs exactly one owned physical SMT pad on its selected layer", [String(c.pcb_port_id)])
        const pad = matchingPads[0], corners = padCorners(pad), pcbPort = found[0]
        const sourcePort = sourcePorts.filter((p) => p.source_port_id === pcbPort.source_port_id)
        if (sourcePort.length !== 1 || pad.pcb_component_id !== pcbPort.pcb_component_id) fail("unresolved_contact", "Contact pad and PCB port must share an owner and resolve exactly one source_port", [String(c.pcb_port_id)])
        if (pcbPort.pcb_component_id !== undefined) {
          const components = records.filter((e) => e.type === "pcb_component" && e.pcb_component_id === pcbPort.pcb_component_id)
          if (components.length !== 1 || components[0].source_component_id !== sourcePort[0].source_component_id) fail("unresolved_contact", "PCB contact owner must agree with its source_port component", [String(c.pcb_port_id)])
        }
        if (sourcePort[0].source_component_id !== undefined && records.filter((e) => e.type === "source_component" && e.source_component_id === sourcePort[0].source_component_id).length !== 1) fail("unresolved_contact", "Contact source component must resolve exactly once", [String(c.pcb_port_id)])
        if (!corners.every(([px, py]) => contains(boardBounds, px, py))) fail("unresolved_contact", "Contact pad copper must lie within the actual board outline", [String(c.pcb_port_id)])
        const angle = number(pad.ccw_rotation ?? pad.rotation ?? 0, "pad rotation") * Math.PI / 180, px = x - number(pad.x, "pad x"), py = y - number(pad.y, "pad y")
        if (Math.abs(px * Math.cos(angle) + py * Math.sin(angle)) > number(pad.width, "pad width", true) / 2 + 1e-7 || Math.abs(-px * Math.sin(angle) + py * Math.cos(angle)) > number(pad.height, "pad height", true) / 2 + 1e-7) fail("unresolved_contact", "Contact lies outside its actual pad copper aperture", [String(c.pcb_port_id)])
        if (!signal && !corners.every(([px, py]) => inPlane(px, py))) fail("unresolved_contact", "Reference pad copper must be fully inside the verified bottom ground pour", [String(c.pcb_port_id)])
        usedPads.add(pad)
        if (!signal && !sourceTraces.some((t) => Array.isArray(t.connected_source_port_ids) && t.connected_source_port_ids.includes(found[0].source_port_id) && Array.isArray(t.connected_source_net_ids) && t.connected_source_net_ids.includes(pour.source_net_id))) fail("unresolved_contact", "Reference pcb_port must be physically on the declared ground net", [String(c.pcb_port_id)])
      } else if (!signal && c.contact_type === "pcb_copper_pour" && c.pcb_copper_pour_id === pourId) {
        // Exact pour ownership and containment are checked below.
      } else fail("unresolved_contact", "Unsupported contact kind or unresolved ground pour")
      if (signal ? layer !== "top" : layer !== "bottom" || !inPlane(x, y)) fail("unresolved_contact", "Signal contact must be top; reference must lie within the continuous bottom ground")
      return c
    }
    for (const p of configPorts) { contact(p, true); contact(p, false) }
    if (pads.some((pad) => !usedPads.has(pad))) fail("unsupported_geometry", "Floating or foreign SMT-pad copper is outside the two-line model")
    const signalPads = pads.filter((p) => layerName(p.layer) === "top")
    for (let i = 0; i < signalPads.length; i++) for (let j = i + 1; j < signalPads.length; j++) {
      if (rectanglesOverlap(padCorners(signalPads[i]), padCorners(signalPads[j]))) fail("unsupported_geometry", "Signal endpoint pads overlap or touch", [String(signalPads[i].pcb_smtpad_id), String(signalPads[j].pcb_smtpad_id)])
    }
    const routes = traces.map((trace) => {
      const traceId = string(trace.pcb_trace_id, "trace ID"), route = array(trace.route, "signal route")
      if (route.length < 2 || route.some((p) => p.route_type !== "wire" || layerName(p.layer) !== "top" || p.start_width !== undefined || p.end_width !== undefined || p.width_interpolation_mode !== undefined)) fail("unsupported_geometry", "Each signal route must be untapered top-layer wire segments", [traceId])
      const first = route[0], last = route[route.length - 1], width = number(first.width, "trace width", true)
      const x0 = number(first.x, "route x"), y0 = number(first.y, "route y"), x1 = number(last.x, "route x"), y1 = number(last.y, "route y")
      const length = Math.hypot(x1 - x0, y1 - y0)
      if (length <= 0) fail("unsupported_geometry", "Signal route must have positive length", [traceId])
      const dx = (x1 - x0) / length, dy = (y1 - y0) / length
      let previous = -1e-7
      for (const p of route) {
        const x = number(p.x, "route x"), y = number(p.y, "route y"), along = (x - x0) * dx + (y - y0) * dy
        if (!close(number(p.width, "trace width", true), width) || !close((x - x0) * dy - (y - y0) * dx, 0) || along < previous - 1e-7 || !inPlane(x, y, width / 2 + 4 * height)) fail("unsupported_geometry", "Trace must be straight, monotone and uniform, with reference-plane margin of at least four dielectric heights", [traceId])
        previous = along
      }
      const endpoint = (x: number, y: number) => configPorts.filter((p) => { const c = object(p.signal_contact, "Missing signal contact"); return close(number(c.x, "signal x"), x) && close(number(c.y, "signal y"), y) })
      const endpoints = [endpoint(x0, y0), endpoint(x1, y1)]
      if (endpoints.some((p) => p.length !== 1)) fail("unresolved_contact", "Every signal endpoint must match one configured port", [traceId])
      const connections = sourceTraces.filter((e) => e.source_trace_id === trace.source_trace_id), connection = connections[0]
      const sourcePortIds = endpoints.map((e) => { const c = object(e[0].signal_contact, "Missing signal"); return ports.find((p) => p.pcb_port_id === c.pcb_port_id)!.source_port_id })
      const connectedPorts = connection?.connected_source_port_ids
      if (connections.length !== 1 || new Set(sourcePortIds).size !== 2 || !Array.isArray(connectedPorts) || connectedPorts.length !== 2 || !sourcePortIds.every((port) => connectedPorts.includes(port))) fail("unsupported_geometry", "Each signal must correspond to a complete unbranched two-port source connection", [traceId])
      if (sourceTraces.some((t) => Array.isArray(t.connected_source_port_ids) && t.connected_source_port_ids.some((p) => sourcePortIds.includes(p)) && Array.isArray(t.connected_source_net_ids) && t.connected_source_net_ids.includes(pour.source_net_id))) fail("unsupported_geometry", "Signal contacts cannot belong to the reference ground net", [traceId])
      const source = sources.filter((s) => endpoints.some((e) => e[0].name === s.port_name)), termination = terminations.filter((s) => endpoints.some((e) => e[0].name === s.port_name))
      if (source.length !== 1 || termination.length !== 1 || source[0].port_name === termination[0].port_name) fail("invalid_noise_configuration", "Each line requires one near source and one opposite far termination", [traceId])
      const model = object(source[0].source_model, "Supply source model"), load = object(termination[0].model, "Supply termination model")
      if (model.kind !== "thevenin" || (load.kind !== "resistor" && load.kind !== "parallel_rc")) fail("unsupported_model", "Bounded provider supports explicit Thevenin sources and resistor/parallel-RC loads")
      number(model.resistance_ohms, "source resistance", true); number(load.resistance_ohms, "load resistance", true); number(load.bias_voltage_v, "load bias")
      if (load.kind === "parallel_rc" && number(load.capacitance_f, "load capacitance") < 0) fail("invalid_noise_configuration", "Load capacitance must be nonnegative")
      const sourceFirst = source[0].port_name === endpoints[0][0].name
      return { line: { trace_id: traceId, near_port_name: String(source[0].port_name), far_port_name: String(termination[0].port_name), source: source[0], termination: termination[0] }, contact_ids: endpoints.map((p) => object(p[0].signal_contact, "Missing signal contact").pcb_port_id), x0: sourceFirst ? x0 : x1, y0: sourceFirst ? y0 : y1, dx: sourceFirst ? dx : -dx, dy: sourceFirst ? dy : -dy, width, length }
    })
    const [a, b] = routes
    if (!close(a.width, b.width) || !close(a.length, b.length) || !close(a.dx, b.dx) || !close(a.dy, b.dy) || !close((b.x0 - a.x0) * a.dx + (b.y0 - a.y0) * a.dy, 0)) fail("unsupported_geometry", "Signals must be equal-width parallel coextensive traces driven in the same direction")
    const gap = Math.abs((b.x0 - a.x0) * a.dy - (b.y0 - a.y0) * a.dx) - a.width
    if (gap <= 0) fail("unsupported_geometry", "Signal copper touches or overlaps")
    for (const route of routes) for (const pad of signalPads) if (!route.contact_ids.includes(pad.pcb_port_id)) {
      const x1 = route.x0 + route.dx * route.length, y1 = route.y0 + route.dy * route.length, nx = -route.dy * route.width / 2, ny = route.dx * route.width / 2
      const traceRectangle: [number, number][] = [[route.x0 + nx, route.y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [route.x0 - nx, route.y0 - ny]]
      if (rectanglesOverlap(padCorners(pad), traceRectangle)) fail("unsupported_geometry", "Signal pad touches foreign trace copper", [String(pad.pcb_smtpad_id), route.line.trace_id])
    }
    const duration = number(config.duration_s, "duration_s", true), sample = number(config.sample_interval_s, "sample_interval_s", true)
    if (countTransientSamples(duration, sample) > 100000) fail("unsupported_model", "Bounded transient permits at most 100000 output samples including time zero")
    const model: CoupledPhysicalModel = { geometry: { width_mm: a.width, thickness_mm: thickness, height_mm: height, length_mm: a.length, gap_mm: gap }, material: { relative_permittivity: er, conductivity_s_per_m: conductivity }, lines: routes.map((r) => r.line) as [ConfiguredLine, ConfiguredLine], duration_s: duration, sample_interval_s: sample, reference_pour_id: pourId, stackup_source: stackup.source as "specified" | "assumed", reference_frequency_hz: referenceFrequency }
    return { status: "complete", issues: [], assumptions: [...coupledLineAssumptions], model }
  } catch (error) {
    const problem = error instanceof GeometryProblem ? error : new GeometryProblem("unsupported", "unsupported_geometry", error instanceof Error ? error.message : String(error))
    return { status: problem.status, issues: [{ code: problem.code, message: problem.message, element_ids: problem.ids }], assumptions: [...coupledLineAssumptions] }
  }
}

function rectangleBounds(pour: RecordValue): [number, number, number, number] {
  if (pour.shape === "rect" && (pour.rotation === undefined || close(number(pour.rotation, "pour rotation") % 180, 0))) {
    const center = object(pour.center, "Missing pour center"), x = number(center.x, "pour x"), y = number(center.y, "pour y"), width = number(pour.width, "pour width", true), height = number(pour.height, "pour height", true)
    return [x - width / 2, x + width / 2, y - height / 2, y + height / 2]
  }
  const brep = pour.shape === "brep" ? object(pour.brep_shape, "Missing brep_shape") : undefined
  if (brep && (!Array.isArray(brep.inner_rings) || brep.inner_rings.length)) fail("unsupported_geometry", "Ground plane holes are unsupported")
  const points = pour.shape === "polygon" ? array(pour.points, "plane points") : brep ? array(object(brep.outer_ring, "Missing outer ring").vertices, "ground vertices") : []
  if (points.length !== 4 || points.some((p) => p.bulge !== undefined && p.bulge !== 0)) fail("unsupported_geometry", "Ground plane must be one rectangle with four straight edges")
  const xs = [...new Set(points.map((p) => number(p.x, "plane x")))], ys = [...new Set(points.map((p) => number(p.y, "plane y")))]
  if (xs.length !== 2 || ys.length !== 2 || points.some((p, i) => { const next = points[(i + 1) % 4]; return (p.x === next.x) === (p.y === next.y) })) fail("unsupported_geometry", "Ground rectangle edges must close without crossing")
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

function padCorners(pad: RecordValue): [number, number][] {
  if (pad.shape !== "rect" || (pad.corner_radius !== undefined && pad.corner_radius !== 0) || (pad.rect_border_radius !== undefined && pad.rect_border_radius !== 0)) fail("unsupported_geometry", "Uniform-line contacts require rectangular SMT pads without curved apertures", [String(pad.pcb_smtpad_id)])
  const x = number(pad.x, "pad x"), y = number(pad.y, "pad y"), w = number(pad.width, "pad width", true) / 2, h = number(pad.height, "pad height", true) / 2, a = number(pad.ccw_rotation ?? pad.rotation ?? 0, "pad rotation") * Math.PI / 180
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([px, py]) => [x + px * Math.cos(a) - py * Math.sin(a), y + px * Math.sin(a) + py * Math.cos(a)])
}
function rectanglesOverlap(a: [number, number][], b: [number, number][]): boolean {
  for (const p of [a, b]) for (let i = 0; i < 2; i++) {
    const next = p[i + 1], axis = [-(next[1] - p[i][1]), next[0] - p[i][0]]
    const aa = a.map(([x, y]) => x * axis[0] + y * axis[1]), bb = b.map(([x, y]) => x * axis[0] + y * axis[1])
    if (Math.max(...aa) < Math.min(...bb) - 1e-10 || Math.max(...bb) < Math.min(...aa) - 1e-10) return false
  }
  return true
}

/** Complete physical-input selection shared by producer and display provenance.
 * The provider inspects the whole single-board document, so added physical boards
 * and unsupported copper must invalidate prior results. Derived diagnostics and
 * views do not; materials, contacts, mask/paste and connectivity remain in it.
 */
export function collectNoiseGeometryInputs(circuitJson: readonly unknown[], boardId: string): unknown[] {
  const records = circuitJson.map((value) => object(value, "Circuit JSON must contain records"))
  const board = records.find((e) => e.type === "pcb_board" && e.pcb_board_id === boardId)
  if (!board) throw new Error(`Unknown physical board ${boardId}`)
  const sourceTypes = new Set(["source_net", "source_trace", "source_port", "source_component", "source_pcb_ground_plane"])
  const styleOnly = new Set(["highlight_color", "display_name", "label", "color", "port_hints"])
  const copy = (value: unknown): unknown => Array.isArray(value) ? value.map(copy) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !styleOnly.has(key)).map(([key, child]) => [key, copy(child)])) : value
  return records.filter((e) => isPhysicalPcb(e.type) || sourceTypes.has(String(e.type))).map(copy)
}
