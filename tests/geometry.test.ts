import { expect, test } from "bun:test"
import { buildCoupledLineModel, collectNoiseGeometryInputs } from "../lib/geometry"

function fixture() {
  const records: Record<string, any>[] = [
    { type: "pcb_board", pcb_board_id: "board", center: { x: 0, y: 0 }, width: 24, height: 5, num_layers: 2, thickness: 0.27, stackup: { source: "specified", layers: [{ type: "copper", layer: "top", thickness_mm: 0.035, conductivity_s_per_m: 5.8e7 }, { type: "dielectric", thickness_mm: 0.2, dielectric_constant: 4.2, dielectric_constant_frequency_hz: 1e9, dielectric_loss_tangent: 0, dielectric_loss_tangent_frequency_hz: 1e9 }, { type: "copper", layer: "bottom", thickness_mm: 0.035, conductivity_s_per_m: 5.8e7 }] } },
    { type: "source_net", source_net_id: "gnd", is_ground: true },
    { type: "pcb_copper_pour", pcb_copper_pour_id: "plane", source_net_id: "gnd", layer: "bottom", shape: "brep", brep_shape: { outer_ring: { vertices: [{ x: -12, y: -2.5 }, { x: 12, y: -2.5 }, { x: 12, y: 2.5 }, { x: -12, y: 2.5 }] }, inner_rings: [] } },
  ]
  const ports: any[] = [], sources: any[] = [], terminations: any[] = []
  for (let line = 0; line < 2; line++) {
    const y = line ? 0.3 : -0.3
    for (let side = 0; side < 2; side++) {
      const name = `p${line}${side}`, x = side ? 10 : -10, groundY = y + 1
      for (const [suffix, layer, py] of [["", "top", y], ["g", "bottom", groundY]] as const) {
        records.push({ type: "source_port", source_port_id: "s" + name + suffix, name: name + suffix })
        records.push({ type: "pcb_port", pcb_port_id: name + suffix, source_port_id: "s" + name + suffix, x, y: py, layers: [layer] })
        records.push({ type: "pcb_smtpad", pcb_smtpad_id: "pad" + name + suffix, pcb_port_id: name + suffix, layer, shape: "rect", x, y: py, width: 0.3, height: 0.3 })
      }
      records.push({ type: "source_trace", source_trace_id: "g" + name, connected_source_port_ids: ["s" + name + "g"], connected_source_net_ids: ["gnd"] })
      ports.push({ name, signal_contact: { contact_type: "pcb_port", pcb_port_id: name, x, y, layer: "top" }, reference_contact: { contact_type: "pcb_port", pcb_port_id: name + "g", x, y: groundY, layer: "bottom" } })
      if (!side) sources.push({ name: "source" + line, port_name: name, role: line ? "victim" : "aggressor", source_model: { kind: "thevenin", resistance_ohms: 50 }, waveform: { kind: "dc", voltage_v: 0 } })
      else terminations.push({ name: "load" + line, port_name: name, model: { kind: "resistor", resistance_ohms: 50, bias_voltage_v: 0 } })
    }
    records.push({ type: "source_trace", source_trace_id: "trace" + line, connected_source_port_ids: [`sp${line}0`, `sp${line}1`], connected_source_net_ids: [] })
    records.push({ type: "pcb_trace", pcb_trace_id: "pcbtrace" + line, source_trace_id: "trace" + line, route: [{ route_type: "wire", x: -10, y, width: 0.3, layer: "top" }, { route_type: "wire", x: -10, y, width: 0.3, layer: "top" }, { route_type: "wire", x: 10, y, width: 0.3, layer: "top" }] })
  }
  const config = { type: "simulation_pcb_noise_configuration", simulation_pcb_noise_configuration_id: "config", simulation_experiment_id: "experiment", pcb_board_id: "board", duration_s: 64e-9, sample_interval_s: 20e-12, ports, sources, terminations, observations: ports.map((p) => ({ name: p.name, port_name: p.name, quantity: "voltage" })) }
  return { records, config }
}
test("strict physical adapter preserves original route order and normalizes driver orientation", () => {
  const { records, config } = fixture(), before = JSON.stringify(records)
  const result = buildCoupledLineModel(records, config)
  expect(result.status).toBe("complete")
  expect(result.model!.geometry).toEqual({ width_mm: 0.3, thickness_mm: 0.035, height_mm: 0.2, length_mm: 20, gap_mm: 0.3 })
  expect(JSON.stringify(records)).toBe(before)
  for (const record of records.filter((e) => e.type === "pcb_trace")) record.route.reverse()
  expect(buildCoupledLineModel(records, config).status).toBe("complete")
})
test("missing or wrong-layer physical reference copper cannot become ground", () => {
  for (const change of ["missing", "wronglayer", "outside"] as const) {
    const { records, config } = fixture(), pad = records.find((e) => e.pcb_smtpad_id === "padp00g")!
    if (change === "missing") records.splice(records.indexOf(pad), 1)
    if (change === "wronglayer") pad.layer = "top"
    if (change === "outside") pad.x = 100
    expect(buildCoupledLineModel(records, config).issues[0].code).toBe("unresolved_contact")
  }
})
test("foreign copper, vias, bends, unknown loss and fabricated ground are diagnosed", () => {
  const probes: ((records: Record<string, any>[]) => void)[] = [
    (r) => r.push({ type: "pcb_smtpad", pcb_smtpad_id: "foreign", pcb_port_id: "foreign", shape: "rect", layer: "top", x: 0, y: 0, width: 0.1, height: 0.1 }),
    (r) => r.push({ type: "pcb_via", pcb_via_id: "via" }),
    (r) => { r.find((e) => e.type === "pcb_trace")!.route[1].y += 0.1 },
    (r) => { delete r[0].stackup.layers[1].dielectric_loss_tangent },
    (r) => { r.find((e) => e.type === "source_net")!.is_ground = false },
  ]
  for (const probe of probes) { const { records, config } = fixture(); probe(records); const report = buildCoupledLineModel(records, config); expect(report.status).not.toBe("complete"); expect(report.issues.length).toBe(1) }
})
test("physical provenance includes nested copper and stackup, excludes appended results and visual styles", () => {
  const { records } = fixture(), original = JSON.stringify(collectNoiseGeometryInputs(records, "board"))
  records.push({ type: "simulation_pcb_noise_result", simulation_pcb_noise_result_id: "run" })
  records.find((e) => e.type === "pcb_trace")!.highlight_color = "red"
  expect(JSON.stringify(collectNoiseGeometryInputs(records, "board"))).toBe(original)
  records.find((e) => e.type === "pcb_trace")!.route[0].width += 0.001
  expect(JSON.stringify(collectNoiseGeometryInputs(records, "board"))).not.toBe(original)
  expect(() => collectNoiseGeometryInputs(records, "missing")).toThrow("Unknown physical board")
})
test("pads cannot short an adjacent route; sample budgets count the initial sample", () => {
  const { records, config } = fixture()
  const pad = records.find((r) => r.pcb_smtpad_id === "padp00")!
  pad.height = 1.2
  // Opposite pads remain small; the oversized pad intersects the actual wire.
  expect(buildCoupledLineModel(records, config).status).toBe("unsupported")
  pad.height = 0.3
  config.duration_s = 1e-6; config.sample_interval_s = 1e-11
  expect(buildCoupledLineModel(records, config).issues[0].code).toBe("unsupported_model")
})

test("actual board bounds, alternate copper and ground-connected signals are refused", () => {
  const changes: ((r: Record<string, any>[]) => void)[] = [
    (r) => { r[0].width = 1 },
    (r) => { r[0].outline = [{ x: -12, y: -2.5 }, { x: 0, y: -2.5 }, { x: 12, y: 2.5 }, { x: -12, y: 2.5 }] },
    (r) => { r.find((e) => e.source_trace_id === "trace0")!.connected_source_net_ids = ["gnd"] },
    ...[
      { type: "pcb_ground_plane", pcb_ground_plane_id: "alternate", source_pcb_ground_plane_id: "source", source_net_id: "gnd" },
      { type: "pcb_ground_plane_region", pcb_ground_plane_region_id: "alternate", pcb_ground_plane_id: "plane", layer: "top", points: [{ x: -10, y: -0.4 }, { x: 10, y: -0.4 }, { x: 10, y: 0.4 }, { x: -10, y: 0.4 }] },
      { type: "pcb_copper_text", pcb_copper_text_id: "text", pcb_component_id: "component", text: "X", font: "tscircuit2024", font_size: 1, layer: "top", anchor_position: { x: 0, y: 0 }, anchor_alignment: "center" },
      { type: "pcb_thermal_spoke", pcb_thermal_spoke_id: "spoke", pcb_ground_plane_id: "plane", shape: "circle", spoke_count: 4, spoke_thickness: 0.1, spoke_inner_diameter: 0.2, spoke_outer_diameter: 0.3 },
      { type: "pcb_bend", pcb_bend_id: "bend", pcb_board_id: "board", start: { x: 0, y: -2 }, end: { x: 0, y: 2 }, bend_angle: 90, bend_radius: 1, bend_side: "left" },
      { type: "pcb_stiffener", pcb_stiffener_id: "stiffener", pcb_board_id: "board", layer: "top", material: "aluminum", thickness: 1, shape: "rect", center: { x: 0, y: 0 }, width: 5, height: 5 },
      { type: "pcb_text", pcb_text_id: "text", layer: "top", text: "X", center: { x: 0, y: 0 }, width: 1, height: 1, lines: 1, align: "bottom-left" },
      { type: "pcb_future_copper", points: [{ x: -1, y: -1 }, { x: 1, y: 1 }] },
    ].map((record) => (r: Record<string, any>[]) => { r.push(record) }),
  ]
  for (const change of changes) {
    const { records, config } = fixture(); change(records)
    expect(buildCoupledLineModel(records, config).issues[0].code).toBe("unsupported_geometry")
  }
})

test("detached or inconsistent physical contact ownership cannot qualify", () => {
  const changes: ((r: Record<string, any>[]) => void)[] = [
    (r) => { r.find((e) => e.pcb_port_id === "p00")!.source_port_id = "detached" },
    (r) => { r.find((e) => e.pcb_smtpad_id === "padp00")!.pcb_component_id = "foreign" },
    (r) => { r.find((e) => e.source_port_id === "sp00")!.source_component_id = "missing" },
    (r) => { r.push({ ...r.find((e) => e.type === "source_port")! }) },
    (r) => { r.find((e) => e.pcb_smtpad_id === "padp00")!.width = 5 },
  ]
  for (const change of changes) {
    const { records, config } = fixture(); change(records)
    expect(buildCoupledLineModel(records, config).issues[0].code).toBe("unresolved_contact")
  }
})

test("curved pad corners cannot be treated as filled rectangular contact apertures", () => {
  const { records, config } = fixture()
  records.find((e) => e.pcb_smtpad_id === "padp00")!.corner_radius = 0.15
  expect(buildCoupledLineModel(records, config).issues[0].code).toBe("unsupported_geometry")
})

test("only actual untapered bottom routes wholly inside the ground pour are redundant", () => {
  const { records, config } = fixture()
  const route = [{ route_type: "wire", layer: "bottom", x: -10, y: 0.7, width: 0.15, copper_pour_id: "plane", is_inside_copper_pour: true }, { route_type: "wire", layer: "bottom", x: -10, y: 1.3, width: 0.15, copper_pour_id: "plane", is_inside_copper_pour: true }]
  records.push({ type: "pcb_trace", pcb_trace_id: "ground_duplicate", source_trace_id: "gp00", route })
  expect(buildCoupledLineModel(records, config).status).toBe("complete")
  Object.assign(route[0], { end_width: 100 })
  expect(buildCoupledLineModel(records, config).status).toBe("unsupported")
})

test("four-height actual ground margin accepts equality and rejects physical deficits", () => {
  for (const deficit of [0, 1e-8, 0.001]) {
    const { records, config } = fixture()
    const pour = records.find((r) => r.type === "pcb_copper_pour")!
    pour.brep_shape.outer_ring.vertices.forEach((p: any) => { if (p.y < 0) p.y = -1.25 + deficit })
    expect(buildCoupledLineModel(records, config).status).toBe(deficit ? "unsupported" : "complete")
  }
})

test("foreign copper cannot reuse a contacted SMT pad identifier to evade refusal", () => {
  const { records, config } = fixture()
  records.push({ type: "pcb_smtpad", pcb_smtpad_id: "padp00", pcb_port_id: "foreign", shape: "rect", layer: "top", x: 0, y: 2, width: 0.1, height: 0.1 })
  expect(buildCoupledLineModel(records, config).status).toBe("unsupported")
})

test("physical identity covers extra boards, alternate copper, mask and paste", () => {
  const additions = [
    { type: "pcb_board", pcb_board_id: "extra", subcircuit_id: "other" },
    { type: "pcb_ground_plane", pcb_ground_plane_id: "extra", source_net_id: "gnd" },
    { type: "pcb_ground_plane_region", pcb_ground_plane_region_id: "extra", layer: "top", points: [{ x: 0, y: 0 }] },
    { type: "pcb_copper_text", pcb_copper_text_id: "extra", text: "X", layer: "top" },
    { type: "pcb_text", pcb_text_id: "extra", text: "X", layer: "top" },
    { type: "pcb_thermal_spoke", pcb_thermal_spoke_id: "extra", spoke_thickness: 0.1 },
    { type: "pcb_solder_paste", pcb_solder_paste_id: "extra", width: 0.1 },
    { type: "pcb_soldermask_opening", pcb_soldermask_opening_id: "extra", radius: 0.1 },
    { type: "pcb_bend", pcb_bend_id: "extra", bend_angle: 90 },
    { type: "pcb_stiffener", pcb_stiffener_id: "extra", material: "aluminum" },
    { type: "pcb_future_copper", copper_width: 0.1 },
  ]
  for (const addition of additions) {
    const { records } = fixture(), before = JSON.stringify(collectNoiseGeometryInputs(records, "board"))
    records.push(addition)
    expect(JSON.stringify(collectNoiseGeometryInputs(records, "board"))).not.toBe(before)
  }
  const { records } = fixture(), before = JSON.stringify(collectNoiseGeometryInputs(records, "board"))
  for (const type of ["pcb_note_text", "pcb_silkscreen_line", "pcb_fabrication_note_rect", "pcb_trace_error", "pcb_trace_warning", "pcb_debug_object", "pcb_trace_hint"]) records.push({ type })
  expect(JSON.stringify(collectNoiseGeometryInputs(records, "board"))).toBe(before)
})
