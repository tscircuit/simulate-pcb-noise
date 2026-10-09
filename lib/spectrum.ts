import { validateWaveform, waveformTimes, type Waveform } from "./waveform"
import { channelFft } from "./channel"

export type SpectrumOptions = {
  waveform_sha256: string
  window: "rectangular" | "hann"
  dc_treatment: "included" | "mean_removed"
  kind: "psd" | "amplitude_peak" | "amplitude_rms"
  fft_length?: number
}

export type SpectrumAsset = {
  format: "simulation_pcb_noise_spectrum_json_v1"
  run_id: string
  observation_name: string
  waveform_sha256: string
  frequencies_hz: number[]
  values: number[]
  kind: "psd" | "amplitude_peak" | "amplitude_rms"
  unit: "V" | "A" | "V^2/Hz" | "A^2/Hz"
  sidedness: "one_sided"
  window: "rectangular" | "hann"
  coherent_gain: number
  enbw_hz: number
  dc_treatment: "included" | "mean_removed"
  fft_length: number
  sample_rate_hz: number
  integrated_power: number
  windowed_mean_square: number
  parseval_relative_error: number
}

/**
 * A uniformly sampled waveform spectrum, never a channel transfer response.
 * PSD integrates to window-normalized mean square. Amplitude uses coherent gain;
 * DC/Nyquist bins have no factor of two or sine RMS conversion.
 */
export function computeSpectrum(waveform: Waveform, options: SpectrumOptions): SpectrumAsset {
  validateWaveform(waveform)
  if (!/^[0-9a-f]{64}$/.test(options.waveform_sha256) ||
    !["rectangular", "hann"].includes(options.window) ||
    !["included", "mean_removed"].includes(options.dc_treatment) ||
    !["psd", "amplitude_peak", "amplitude_rms"].includes(options.kind)) {
    throw new Error("Spectrum requires explicit window, DC treatment, units and waveform hash")
  }
  if (waveform.valid_intervals_s.length !== 1) throw new Error("A spectrum cannot interpolate or concatenate waveform gaps")
  const times = waveformTimes(waveform)
  const count = waveform.values.length
  const step = waveform.time.kind === "uniform" ? waveform.time.step_s : (times[count - 1]! - times[0]!) / (count - 1)
  for (let i = 1; i < count; i++) {
    if (Math.abs((times[i]! - times[i - 1]!) - step) > step * 1e-7) {
      throw new Error("Spectrum requires uniform samples; explicitly resample valid intervals before analysis")
    }
  }
  const sampleRate = 1 / step
  if (waveform.bandwidth_hz > sampleRate / 2 * (1 + 1e-9)) throw new Error("Declared waveform bandwidth exceeds the sample Nyquist limit")
  const fftLength = options.fft_length ?? 2 ** Math.ceil(Math.log2(count))
  if (!Number.isSafeInteger(fftLength) || fftLength < count || fftLength > 2 ** 22 ||
    (fftLength & (fftLength - 1)) !== 0) {
    throw new Error("FFT length must be a power of two covering every sample, at most 4194304")
  }
  if (options.window === "hann" && count < 3) throw new Error("Hann window requires at least three samples")
  const mean = options.dc_treatment === "mean_removed" ? waveform.values.reduce((a, b) => a + b, 0) / count : 0
  const real = new Float64Array(fftLength)
  const imaginary = new Float64Array(fftLength)
  let windowSum = 0
  let windowSquareSum = 0
  let weightedSquares = 0
  for (let i = 0; i < count; i++) {
    // Periodic Hann preserves bin-coherent sinusoid calibration.
    const window = options.window === "hann" ? 0.5 - 0.5 * Math.cos(2 * Math.PI * i / count) : 1
    const value = (waveform.values[i]! - mean) * window
    real[i] = value
    windowSum += window
    windowSquareSum += window * window
    weightedSquares += value * value
  }
  channelFft(real, imaginary)
  const frequencies: number[] = []
  const values: number[] = []
  let integratedPower = 0
  for (let bin = 0; bin <= fftLength / 2; bin++) {
    const singleton = bin === 0 || bin === fftLength / 2
    const magnitudeSquared = real[bin]! ** 2 + imaginary[bin]! ** 2
    const psd = magnitudeSquared * (singleton ? 1 : 2) / (sampleRate * windowSquareSum)
    integratedPower += psd * sampleRate / fftLength
    const peak = Math.sqrt(magnitudeSquared) * (singleton ? 1 : 2) / windowSum
    values.push(options.kind === "psd" ? psd : options.kind === "amplitude_peak" || singleton ? peak : peak / Math.SQRT2)
    frequencies.push(bin * sampleRate / fftLength)
  }
  const windowedMeanSquare = weightedSquares / windowSquareSum
  return {
    format: "simulation_pcb_noise_spectrum_json_v1", run_id: waveform.run_id,
    observation_name: waveform.observation_name, waveform_sha256: options.waveform_sha256,
    frequencies_hz: frequencies, values, kind: options.kind,
    unit: options.kind === "psd" ? waveform.unit === "V" ? "V^2/Hz" : "A^2/Hz" : waveform.unit,
    sidedness: "one_sided", window: options.window, coherent_gain: windowSum / count,
    enbw_hz: sampleRate * windowSquareSum / (windowSum * windowSum), dc_treatment: options.dc_treatment,
    fft_length: fftLength, sample_rate_hz: sampleRate, integrated_power: integratedPower,
    windowed_mean_square: windowedMeanSquare,
    parseval_relative_error: Math.abs(integratedPower - windowedMeanSquare) / Math.max(windowedMeanSquare, Number.MIN_VALUE),
  }
}

export const analyzeSpectrum = computeSpectrum
