/**
 * Web Audio implementations of the core's audio ports: microphone → 16-bit
 * PCM chunks, and 16-bit PCM chunks → speakers.
 *
 * Browsers only run audio after a user gesture: call the session's `start`
 * from a click handler.
 */
import type { AudioInput, AudioOutput, Pcm16 } from "@lamine-f/voice-core";

const CAPTURE_PROCESSOR = "pcm16-capture";

/**
 * Runs on the audio rendering thread, not here: it is shipped as its own
 * source text (see `captureModuleUrl`), so it may only use worklet globals.
 * Kept a real function rather than a string so it is type-checked and linted.
 */
function pcm16CaptureWorklet(): void {
  const CHUNK_SAMPLES = 1024; // ~64 ms at 16 kHz: few messages, low latency

  class Pcm16Capture extends AudioWorkletProcessor {
    buf = new Int16Array(CHUNK_SAMPLES);
    n = 0;

    process(inputs: Float32Array[][]): boolean {
      const ch = inputs[0]?.[0];
      if (!ch) return true;
      for (const sample of ch) {
        const s = Math.max(-1, Math.min(1, sample));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === CHUNK_SAMPLES) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(CHUNK_SAMPLES);
          this.n = 0;
        }
      }
      return true;
    }
  }

  registerProcessor("pcm16-capture", Pcm16Capture);
}

// Worklet globals, for the type checker only.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

let moduleUrl: string | null = null;

/** The worklet as a Blob URL: the package ships no extra file to serve, whatever the bundler. */
function captureModuleUrl(): string {
  moduleUrl ??= URL.createObjectURL(
    new Blob([`(${pcm16CaptureWorklet.toString()})();`], { type: "text/javascript" }),
  );
  return moduleUrl;
}

export class WebAudioInput implements AudioInput {
  #stream: MediaStream | null = null;
  #ctx: AudioContext | null = null;

  async open(): Promise<void> {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  async start(sampleRate: number, onChunk: (pcm16: Pcm16) => void): Promise<void> {
    if (!this.#stream) throw new Error("micro non ouvert");
    const ctx = new AudioContext({ sampleRate });
    this.#ctx = ctx;
    // Created after awaits, so outside the click: some browsers start it suspended.
    await ctx.resume();
    await ctx.audioWorklet.addModule(captureModuleUrl());
    if (ctx.state === "closed") return; // closed while loading
    const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, { numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onChunk(new Int16Array(e.data));
    ctx.createMediaStreamSource(this.#stream).connect(node);
  }

  close(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    if (this.#ctx && this.#ctx.state !== "closed") void this.#ctx.close();
    this.#stream = null;
    this.#ctx = null;
  }
}

export class WebAudioOutput implements AudioOutput {
  #ctx: AudioContext | null = null;
  #sources = new Set<AudioBufferSourceNode>();
  #playhead = 0;

  async start(sampleRate: number): Promise<void> {
    this.#ctx = new AudioContext({ sampleRate });
    await this.#ctx.resume();
  }

  /** Chunks are scheduled back to back, so the voice plays without gaps. */
  play(pcm16: Pcm16): void {
    const ctx = this.#ctx;
    if (!ctx || !pcm16.length) return;
    const audio = ctx.createBuffer(1, pcm16.length, ctx.sampleRate);
    audio.getChannelData(0).set(Float32Array.from(pcm16, (v) => v / 32768));
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime, this.#playhead);
    src.start(at);
    this.#playhead = at + audio.duration;
    this.#sources.add(src);
    src.onended = () => this.#sources.delete(src);
  }

  interrupt(): void {
    for (const src of this.#sources) src.stop();
    this.#sources.clear();
    this.#playhead = 0;
  }

  close(): void {
    this.interrupt();
    if (this.#ctx && this.#ctx.state !== "closed") void this.#ctx.close();
    this.#ctx = null;
  }
}
