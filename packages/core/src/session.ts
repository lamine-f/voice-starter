/**
 * The voice session: one conversation, from `start` to `stop`.
 *
 * It owns everything that does not depend on the platform or the provider:
 * the state machine, reconnection with the conversation replayed, routing of
 * tool calls (client tools to the host, server tools to the relay) and the
 * queue of injected messages. A host drives it with commands and listens to
 * its events (see @voice-starter/protocol).
 */
import type {
  Command,
  ErrorCode,
  HistoryItem,
  SessionGrant,
  SessionState,
  ToolDeclaration,
  VoiceEvent,
} from "@voice-starter/protocol";
import type {
  AudioInput,
  AudioOutput,
  Pcm16,
  ProviderConnection,
  ProviderEvents,
  ProviderToolCall,
  SessionBroker,
  VoiceProvider,
} from "./ports.ts";

// After an unexpected drop: a few spaced retries, then give up. The counter
// resets once a reconnected link has carried a real exchange.
const RECONNECT_DELAYS_MS = [1000, 3000, 8000];
// Turns replayed on reconnect so the agent remembers what was said; older
// turns matter little in a voice chat and would only bloat the settings.
const HISTORY_LIMIT = 50;
// The agent refuses injections while it talks: try again shortly.
const INJECTION_RETRY_MS = 1500;

export interface VoiceSessionPorts {
  broker: SessionBroker;
  provider: VoiceProvider;
  audioIn: AudioInput;
  audioOut: AudioOutput;
}

export type VoiceListener = (event: VoiceEvent) => void;

export interface VoiceSession {
  readonly state: SessionState;
  dispatch(command: Command): void;
  /** Returns the function that unsubscribes. */
  subscribe(listener: VoiceListener): () => void;
}

export function createVoiceSession(ports: VoiceSessionPorts): VoiceSession {
  return new Session(ports);
}

/** Thrown inside `start` when the session is stopped while it awaits. */
class Stopped extends Error {}

class Failure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A provider connection plus the run it belongs to; events from older links are ignored. */
interface Link {
  conn: ProviderConnection | null;
}

/** One start → stop cycle; a stop makes every pending await of the run stale. */
interface Run {
  stopped: boolean;
}

class Session implements VoiceSession {
  readonly #ports: VoiceSessionPorts;
  readonly #listeners = new Set<VoiceListener>();
  #state: SessionState = "idle";

  #run: Run | null = null;
  #link: Link | null = null;
  #ready = false; // the current link accepted its settings
  #tools = new Map<string, ToolDeclaration>();
  #history: HistoryItem[] = [];
  #retries = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  #hostCalls = new Map<string, (result: unknown) => void>(); // client tool calls awaiting `toolResult`
  #cancelled = new Set<string>();
  #pendingInjections: string[] = [];
  #inFlight: string | null = null; // last injection sent, re-queued if refused

  constructor(ports: VoiceSessionPorts) {
    this.#ports = ports;
  }

  get state(): SessionState {
    return this.#state;
  }

  subscribe(listener: VoiceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispatch(command: Command): void {
    switch (command.type) {
      case "start":
        void this.#start(command.clientTools);
        break;
      case "stop":
        this.#stop();
        break;
      case "inject":
        this.#pendingInjections.push(command.text);
        this.#flushInjections();
        break;
      case "toolResult": {
        const resolve = this.#hostCalls.get(command.callId);
        this.#hostCalls.delete(command.callId);
        resolve?.(command.result);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async #start(clientTools: string[]): Promise<void> {
    if (this.#run) return; // already running
    const run: Run = { stopped: false };
    this.#run = run;
    this.#setState("connecting");
    const { audioIn, audioOut, broker } = this.#ports;
    const live = <T>(value: T): T => {
      if (run.stopped) throw new Stopped();
      return value;
    };
    try {
      // Microphone first: the permission prompt can take a while, the grant is short-lived.
      live(
        await audioIn.open().catch((err) => {
          throw new Failure("microphone", messageOf(err));
        }),
      );
      const grant = live(
        await broker.open().catch((err) => {
          throw new Failure("broker", messageOf(err));
        }),
      );
      const missing = grant.tools
        .filter((tool) => tool.runsOn === "client" && !clientTools.includes(tool.name))
        .map((tool) => tool.name);
      if (missing.length) {
        throw new Failure(
          "missing_tool_handlers",
          `outils client sans gestionnaire : ${missing.join(", ")}`,
        );
      }
      live(await audioOut.start(grant.audio.outputRate));
      live(await audioIn.start(grant.audio.inputRate, (pcm) => this.#onMicrophone(pcm)));
      this.#connect(grant);
    } catch (err) {
      if (err instanceof Stopped) return;
      const failure = err instanceof Failure ? err : new Failure("provider", messageOf(err));
      this.#fail(failure.code, failure.message);
    }
  }

  #connect(grant: SessionGrant): void {
    this.#tools = new Map(grant.tools.map((tool) => [tool.name, tool]));
    const link: Link = { conn: null };
    this.#link = link;
    this.#ready = false;
    link.conn = this.#ports.provider.connect(grant, [...this.#history], this.#eventsFor(link));
  }

  #stop(): void {
    if (this.#run) this.#run.stopped = true;
    this.#run = null;
    this.#release();
    this.#history = [];
    this.#retries = 0;
    this.#cancelled.clear();
    this.#pendingInjections = [];
    this.#inFlight = null;
    this.#setState("idle");
  }

  #release(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#link?.conn?.close();
    this.#link = null;
    this.#ready = false;
    this.#hostCalls.clear();
    this.#ports.audioIn.close();
    this.#ports.audioOut.close();
  }

  #fail(code: ErrorCode, message: string): void {
    this.#stop();
    this.#emit({ type: "error", code, message, fatal: true });
  }

  #dropped(cause: string): void {
    this.#link?.conn?.close();
    this.#link = null;
    this.#ready = false;
    this.#ports.audioOut.interrupt();
    const delay = RECONNECT_DELAYS_MS[this.#retries];
    if (delay === undefined) {
      this.#fail("disconnected", `déconnecté · ${cause}`);
      return;
    }
    this.#retries++;
    this.#setState("reconnecting", cause);
    this.#later(delay, () => void this.#reconnect());
  }

  async #reconnect(): Promise<void> {
    const run = this.#run;
    if (!run) return;
    try {
      const grant = await this.#ports.broker.open(); // a fresh short-lived token
      if (!run.stopped) this.#connect(grant);
    } catch (err) {
      if (!run.stopped) this.#dropped(messageOf(err));
    }
  }

  // ---------------------------------------------------------------- provider

  #eventsFor(link: Link): ProviderEvents {
    // Every handler ignores links that are no longer the current one.
    const current = () => link === this.#link;
    return {
      ready: () => {
        if (!current()) return;
        this.#ready = true;
        this.#setState("listening");
        this.#flushInjections();
      },
      transcript: (role, text) => {
        if (!current()) return;
        this.#retries = 0; // the link carries a real exchange again
        this.#emit({ type: "transcript", role, text });
      },
      history: (item) => {
        if (!current()) return;
        this.#history.push(item);
        if (this.#history.length > HISTORY_LIMIT) {
          this.#history.splice(0, this.#history.length - HISTORY_LIMIT);
        }
      },
      userSpeaking: () => {
        if (!current()) return;
        this.#ports.audioOut.interrupt(); // barge-in
        this.#setState("listening");
      },
      agentThinking: () => {
        if (current()) this.#setState("thinking");
      },
      agentAudio: (pcm) => {
        if (!current()) return;
        this.#emit({ type: "level", source: "output", value: rms(pcm) });
        this.#ports.audioOut.play(pcm);
        this.#setState("speaking");
      },
      agentDone: () => {
        if (!current()) return;
        this.#setState("listening");
        this.#flushInjections();
      },
      toolCall: (call) => {
        if (current()) void this.#runTool(link, call);
      },
      toolCancelled: (callId) => {
        if (!current()) return;
        this.#cancelled.add(callId);
        this.#hostCalls.delete(callId);
        this.#emit({ type: "toolCancelled", callId });
      },
      injectionRefused: () => {
        if (!current()) return;
        if (this.#inFlight !== null) this.#pendingInjections.unshift(this.#inFlight);
        this.#inFlight = null;
        this.#later(INJECTION_RETRY_MS, () => this.#flushInjections());
      },
      error: (message) => {
        if (current()) this.#emit({ type: "error", code: "provider", message, fatal: false });
      },
      closed: (cause) => {
        if (current()) this.#dropped(cause);
      },
    };
  }

  #onMicrophone(pcm: Pcm16): void {
    this.#emit({ type: "level", source: "input", value: rms(pcm) });
    if (this.#ready) this.#link?.conn?.sendAudio(pcm);
  }

  // ---------------------------------------------------------------- tools

  async #runTool(link: Link, call: ProviderToolCall): Promise<void> {
    const { id: callId, name } = call;
    this.#emit({ type: "toolActivity", callId, name, status: "started" });
    let result: unknown;
    let status: "done" | "error" = "done";
    try {
      const tool = this.#tools.get(name);
      if (!tool) throw new Error(`outil inconnu : ${name}`);
      const args: unknown = call.arguments ? JSON.parse(call.arguments) : {};
      result =
        tool.runsOn === "server"
          ? await this.#ports.broker.callTool(name, args)
          : await this.#askHost(callId, name, args);
    } catch (err) {
      status = "error";
      result = { ok: false, error: messageOf(err) };
    }
    // The agent drops answers to calls it cancelled.
    if (this.#cancelled.has(callId)) return;
    this.#emit({ type: "toolActivity", callId, name, status, result });
    // Answer on the link that asked: a newer link knows nothing of this call.
    if (link === this.#link) link.conn?.sendToolResult(call, result);
  }

  #askHost(callId: string, name: string, args: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      this.#hostCalls.set(callId, resolve);
      this.#emit({ type: "toolCall", callId, name, args });
    });
  }

  // ---------------------------------------------------------------- injections

  #flushInjections(): void {
    // One at a time, so a refusal tells exactly which message to re-queue.
    if (!this.#ready || !this.#pendingInjections.length) return;
    this.#inFlight = this.#pendingInjections.shift() ?? null;
    if (this.#inFlight !== null) this.#link?.conn?.inject(this.#inFlight);
  }

  // ---------------------------------------------------------------- plumbing

  /** A new cause is news even in the same state (another failed reconnection). */
  #setState(state: SessionState, cause?: string): void {
    if (state === this.#state && cause === undefined) return;
    this.#state = state;
    this.#emit(cause === undefined ? { type: "state", state } : { type: "state", state, cause });
  }

  #emit(event: VoiceEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }
}

/** Voice energy of a chunk, scaled so normal speech reaches the top of 0..1. */
export function rms(pcm16: Int16Array): number {
  if (!pcm16.length) return 0;
  let sum = 0;
  for (const v of pcm16) sum += (v / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / pcm16.length) * 3);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
