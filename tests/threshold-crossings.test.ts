import { describe, expect, test } from "bun:test"
import { thresholdCrossings, type Waveform } from "../lib/waveform"

function capture(values: number[]): Waveform {
  const times = values.map((_, index) => index * 1e-12)
  return {
    format: "simulation_pcb_noise_waveform_json_v1",
    run_id: "run", observation_name: "observation",
    unit: "V", variant: "total",
    time: { kind: "explicit", times_s: times },
    values,
    valid_intervals_s: [{ start_s: times[0]!, end_s: times[times.length - 1]! }],
    bandwidth_hz: 1e12,
    input_sha256: "a".repeat(64),
    source_sha256: "b".repeat(64),
    full_resolution: true,
  }
}

describe("threshold crossings at exact-threshold samples", () => {
  test("a tangent touch reversing below the threshold is not a crossing", () => {
    expect(thresholdCrossings(capture([0, 0.5, 0.25, 0]), 0.5)).toEqual([])
  })
  test("a tangent touch reversing above the threshold is not a crossing", () => {
    expect(thresholdCrossings(capture([1, 0.5, 0.75, 1]), 0.5)).toEqual([])
  })
  test("dwelling exactly on the threshold then reversing is not a crossing", () => {
    expect(thresholdCrossings(capture([0, 0.5, 0.5, 0]), 0.5)).toEqual([])
  })
  test("a waveform ending exactly on the threshold is not a crossing", () => {
    expect(thresholdCrossings(capture([0, 0.25, 0.5]), 0.5)).toEqual([])
  })
  test("an exact-threshold sample on a genuine rising edge still crosses at first contact", () => {
    expect(thresholdCrossings(capture([0, 0.5, 1]), 0.5)).toEqual([{ time_s: 1e-12, polarity: "rising" }])
  })
  test("dwelling exactly on the threshold mid-edge crosses once at first contact", () => {
    expect(thresholdCrossings(capture([0, 0.5, 0.5, 1]), 0.5)).toEqual([{ time_s: 1e-12, polarity: "rising" }])
    expect(thresholdCrossings(capture([1, 0.5, 0.5, 0]), 0.5)).toEqual([{ time_s: 1e-12, polarity: "falling" }])
  })
  test("strict crossings are unchanged", () => {
    expect(thresholdCrossings(capture([0, 1, 0]), 0.5)).toEqual([
      { time_s: 0.5e-12, polarity: "rising" },
      { time_s: 1.5e-12, polarity: "falling" },
    ])
  })
})
