import type { HistoryItem, SessionGrant, VoiceEvent } from "@voice-starter/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AudioInput,
  type AudioOutput,
  createVoiceSession,
  type Pcm16,
  type ProviderConnection,
  type ProviderEvents,
  type ProviderToolCall,
  type SessionBroker,
  type VoiceProvider,
} from "../src/index.ts";

// ---------------------------------------------------------------- fakes

const GRANT: SessionGrant = {
  provider: "fake",
  url: "wss://agent.test",
  token: "tok",
  settings: { any: "thing" },
  audio: { inputRate: 16000, outputRate: 24000 },
  tools: [
    { name: "show", description: "", parameters: {}, runsOn: "client" },
    { name: "lookup", description: "", parameters: {}, runsOn: "server" },
  ],
};

class FakeConnection implements ProviderConnection {
  audio: Int16Array[] = [];
  results: Array<{ call: ProviderToolCall; result: unknown }> = [];
  injected: string[] = [];
  closed = false;
  sendAudio(pcm16: Int16Array) {
    this.audio.push(pcm16);
  }
  sendToolResult(call: ProviderToolCall, result: unknown) {
    this.results.push({ call, result });
  }
  inject(text: string) {
    this.injected.push(text);
  }
  close() {
    this.closed = true;
  }
}

interface FakeLink {
  grant: SessionGrant;
  history: readonly HistoryItem[];
  events: ProviderEvents;
  conn: FakeConnection;
}

function setup(options: { micError?: Error } = {}) {
  const order: string[] = [];
  let onChunk: ((pcm: Pcm16) => void) | null = null;
  const audioIn = {
    closed: 0,
    async open() {
      order.push("mic");
      if (options.micError) throw options.micError;
    },
    async start(_rate: number, cb: (pcm: Pcm16) => void) {
      onChunk = cb;
    },
    close() {
      this.closed++;
    },
  } satisfies AudioInput & { closed: number };
  const audioOut = {
    rate: 0,
    played: [] as Int16Array[],
    interrupts: 0,
    async start(rate: number) {
      this.rate = rate;
    },
    play(pcm16: Int16Array) {
      this.played.push(pcm16);
    },
    interrupt() {
      this.interrupts++;
    },
    close() {},
  } satisfies AudioOutput & { rate: number; played: Int16Array[]; interrupts: number };
  const grants: Array<SessionGrant | Error> = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];
  const broker = {
    grants,
    toolCalls,
    async open(): Promise<SessionGrant> {
      order.push("grant");
      const next = grants.shift() ?? GRANT;
      if (next instanceof Error) throw next;
      return next;
    },
    async callTool(name: string, args: unknown) {
      toolCalls.push({ name, args });
      return { ok: true, from: "server" };
    },
  } satisfies SessionBroker & { grants: typeof grants; toolCalls: typeof toolCalls };
  const links: FakeLink[] = [];
  const provider: VoiceProvider = {
    connect(grant, history, events) {
      const conn = new FakeConnection();
      links.push({ grant, history, events, conn });
      return conn;
    },
  };
  const session = createVoiceSession({ broker, provider, audioIn, audioOut });
  const events: VoiceEvent[] = [];
  session.subscribe((e) => events.push(e));
  const link = (i = -1) => {
    const found = links.at(i);
    if (!found) throw new Error("no provider link");
    return found;
  };
  const mic = (pcm: Pcm16) => onChunk?.(pcm);
  const of = <T extends VoiceEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<VoiceEvent, { type: T }> => e.type === type);
  return { session, audioIn, audioOut, broker, links, link, events, of, mic, order };
}

/** Let the awaits inside `start` and tool calls settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function started(options?: { micError?: Error }) {
  const t = setup(options);
  t.session.dispatch({ type: "start", clientTools: ["show"] });
  await settle();
  return t;
}

async function online() {
  const t = await started();
  t.link().events.ready();
  return t;
}

const call = (id: string, name: string, args: unknown = {}): ProviderToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
  meta: { signature: id },
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- lifecycle

describe("start", () => {
  it("opens the microphone before asking for the short-lived grant", async () => {
    const t = await started();
    expect(t.order).toEqual(["mic", "grant"]);
    expect(t.audioOut.rate).toBe(24000);
    expect(t.link().grant).toBe(GRANT);
    expect(t.session.state).toBe("connecting");
  });

  it("listens once the provider accepted the settings, and only then sends audio", async () => {
    const t = await started();
    t.mic(new Int16Array([1000, -1000]));
    expect(t.link().conn.audio).toHaveLength(0);
    t.link().events.ready();
    t.mic(new Int16Array([1000, -1000]));
    expect(t.link().conn.audio).toHaveLength(1);
    expect(t.session.state).toBe("listening");
    expect(t.of("level").map((e) => e.source)).toEqual(["input", "input"]);
    expect(t.of("state").map((e) => e.state)).toEqual(["connecting", "listening"]);
  });

  it("refuses to start when the host cannot run a declared client tool", async () => {
    const t = setup();
    t.session.dispatch({ type: "start", clientTools: [] });
    await settle();
    expect(t.links).toHaveLength(0);
    expect(t.session.state).toBe("idle");
    expect(t.of("error")).toEqual([
      {
        type: "error",
        code: "missing_tool_handlers",
        message: "outils client sans gestionnaire : show",
        fatal: true,
      },
    ]);
  });

  it("reports a refused microphone", async () => {
    const t = await started({ micError: new Error("Permission denied") });
    expect(t.of("error")[0]).toMatchObject({ code: "microphone", fatal: true });
    expect(t.order).toEqual(["mic"]);
  });

  it("reports a relay failure", async () => {
    const t = setup();
    t.broker.grants.push(new Error("401 jeton invalide"));
    t.session.dispatch({ type: "start", clientTools: ["show"] });
    await settle();
    expect(t.of("error")[0]).toMatchObject({ code: "broker", message: "401 jeton invalide" });
  });

  it("opens nothing when stopped while starting", async () => {
    const t = setup();
    t.session.dispatch({ type: "start", clientTools: ["show"] });
    t.session.dispatch({ type: "stop" });
    await settle();
    expect(t.links).toHaveLength(0);
    expect(t.session.state).toBe("idle");
  });

  it("stop closes everything and ignores the old link afterwards", async () => {
    const t = await online();
    const old = t.link();
    t.session.dispatch({ type: "stop" });
    expect(old.conn.closed).toBe(true);
    expect(t.audioIn.closed).toBeGreaterThan(0);
    expect(t.session.state).toBe("idle");
    old.events.transcript("agent", "trop tard");
    expect(t.of("transcript")).toHaveLength(0);
  });
});

describe("conversation states", () => {
  it("follows the agent: thinking, speaking, interrupted, done", async () => {
    const t = await online();
    const { events } = t.link();
    events.agentThinking();
    expect(t.session.state).toBe("thinking");
    events.agentAudio(new Int16Array([2000]));
    expect(t.session.state).toBe("speaking");
    expect(t.audioOut.played).toHaveLength(1);
    expect(t.of("level").at(-1)).toMatchObject({ source: "output" });
    events.userSpeaking();
    expect(t.audioOut.interrupts).toBe(1);
    expect(t.session.state).toBe("listening");
    events.agentAudio(new Int16Array([2000]));
    events.agentDone();
    expect(t.session.state).toBe("listening");
  });

  it("relays transcripts and non-fatal provider errors", async () => {
    const t = await online();
    t.link().events.transcript("agent", "Bonjour, monsieur.");
    t.link().events.error("quota bientôt atteint");
    expect(t.of("transcript")).toEqual([
      { type: "transcript", role: "agent", text: "Bonjour, monsieur." },
    ]);
    expect(t.of("error")[0]).toMatchObject({ code: "provider", fatal: false });
    expect(t.session.state).toBe("listening");
  });
});

// ---------------------------------------------------------------- tools

describe("tools", () => {
  it("asks the host for client tools and answers with its result", async () => {
    const t = await online();
    t.link().events.toolCall(call("c1", "show", { title: "Hi" }));
    await settle();
    expect(t.of("toolCall")).toEqual([
      { type: "toolCall", callId: "c1", name: "show", args: { title: "Hi" } },
    ]);
    t.session.dispatch({ type: "toolResult", callId: "c1", result: { status: "displayed" } });
    await settle();
    expect(t.link().conn.results).toEqual([
      { call: call("c1", "show", { title: "Hi" }), result: { status: "displayed" } },
    ]);
    expect(t.of("toolActivity").map((e) => e.status)).toEqual(["started", "done"]);
  });

  it("runs server tools through the relay", async () => {
    const t = await online();
    t.link().events.toolCall(call("c2", "lookup", { q: "x" }));
    await settle();
    expect(t.broker.toolCalls).toEqual([{ name: "lookup", args: { q: "x" } }]);
    expect(t.link().conn.results[0]?.result).toEqual({ ok: true, from: "server" });
    expect(t.of("toolCall")).toHaveLength(0);
    expect(t.of("toolActivity").at(-1)).toMatchObject({ status: "done", result: { ok: true } });
  });

  it("answers unknown tools and unreadable arguments with an error", async () => {
    const t = await online();
    t.link().events.toolCall(call("c3", "nope"));
    t.link().events.toolCall({ id: "c4", name: "lookup", arguments: "{oops" });
    await settle();
    const results = t.link().conn.results.map((r) => r.result);
    expect(results[0]).toEqual({ ok: false, error: "outil inconnu : nope" });
    expect(results[1]).toMatchObject({ ok: false });
    expect(t.of("toolActivity").filter((e) => e.status === "error")).toHaveLength(2);
  });

  it("never answers a call the agent cancelled", async () => {
    const t = await online();
    t.link().events.toolCall(call("c5", "show"));
    await settle();
    t.link().events.toolCancelled("c5");
    t.session.dispatch({ type: "toolResult", callId: "c5", result: "late" });
    await settle();
    expect(t.link().conn.results).toHaveLength(0);
    expect(t.of("toolCancelled")).toEqual([{ type: "toolCancelled", callId: "c5" }]);
  });

  it("still reports a cancelled server call, so the host can undo what it started", async () => {
    const t = await online();
    t.link().events.toolCall(call("c7", "lookup"));
    t.link().events.toolCancelled("c7");
    await settle();
    expect(t.of("toolActivity").at(-1)).toMatchObject({ callId: "c7", status: "done" });
    expect(t.link().conn.results).toHaveLength(0);
  });

  it("drops a result whose link was replaced in the meantime", async () => {
    const t = await online();
    t.link().events.toolCall(call("c6", "lookup"));
    const first = t.link();
    first.events.closed("code 1006");
    await settle(); // the relay answers after the drop
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.links).toHaveLength(2);
    expect(first.conn.results).toHaveLength(0);
    expect(t.link().conn.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- reconnection

describe("reconnection", () => {
  it("reconnects with the conversation so far", async () => {
    const t = await online();
    const turn: HistoryItem = { kind: "message", role: "user", content: "bonjour" };
    t.link().events.history(turn);
    t.link().events.closed("Deepgram : délai dépassé");
    expect(t.session.state).toBe("reconnecting");
    expect(t.of("state").at(-1)).toEqual({
      type: "state",
      state: "reconnecting",
      cause: "Deepgram : délai dépassé",
    });
    expect(t.links[0]?.conn.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.links).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.links).toHaveLength(2);
    expect(t.link().history).toEqual([turn]);
    t.link().events.ready();
    expect(t.session.state).toBe("listening");
  });

  it("gives up after 1 s, 3 s and 8 s without a real exchange", async () => {
    const t = await online();
    for (const delay of [1000, 3000, 8000]) {
      t.link().events.closed("coupure");
      await vi.advanceTimersByTimeAsync(delay);
    }
    t.link().events.closed("coupure");
    expect(t.links).toHaveLength(4);
    expect(t.session.state).toBe("idle");
    expect(t.of("error").at(-1)).toMatchObject({ code: "disconnected", fatal: true });
  });

  it("starts counting again once a reconnected link carried a transcript", async () => {
    const t = await online();
    for (let i = 0; i < 5; i++) {
      t.link().events.closed("coupure");
      await vi.advanceTimersByTimeAsync(1000);
      t.link().events.ready();
      t.link().events.transcript("user", "toujours là");
    }
    expect(t.links).toHaveLength(6);
    expect(t.session.state).toBe("listening");
  });

  it("treats a relay failure during reconnection as another drop", async () => {
    const t = await online();
    t.broker.grants.push(new Error("relais injoignable"));
    t.link().events.closed("coupure");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.of("state").at(-1)).toMatchObject({
      state: "reconnecting",
      cause: "relais injoignable",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.links).toHaveLength(2);
  });

  it("keeps only the 50 latest turns", async () => {
    const t = await online();
    for (let i = 0; i < 60; i++) {
      t.link().events.history({ kind: "message", role: "user", content: String(i) });
    }
    t.link().events.closed("coupure");
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.link().history).toHaveLength(50);
    expect(t.link().history[0]).toEqual({ kind: "message", role: "user", content: "10" });
  });
});

// ---------------------------------------------------------------- injections

describe("injections", () => {
  it("waits for the link to be ready, then sends one message at a time", async () => {
    const t = await started();
    t.session.dispatch({ type: "inject", text: "un" });
    t.session.dispatch({ type: "inject", text: "deux" });
    expect(t.link().conn.injected).toEqual([]);
    t.link().events.ready();
    expect(t.link().conn.injected).toEqual(["un"]);
    t.link().events.agentDone();
    expect(t.link().conn.injected).toEqual(["un", "deux"]);
  });

  it("re-queues a refused message and tries again 1.5 s later", async () => {
    const t = await online();
    t.session.dispatch({ type: "inject", text: "résultat" });
    t.link().events.injectionRefused();
    await vi.advanceTimersByTimeAsync(1499);
    expect(t.link().conn.injected).toEqual(["résultat"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.link().conn.injected).toEqual(["résultat", "résultat"]);
  });

  it("keeps undelivered messages across a reconnection", async () => {
    const t = await started();
    t.session.dispatch({ type: "inject", text: "en attente" });
    t.link().events.closed("coupure");
    await vi.advanceTimersByTimeAsync(1000);
    t.link().events.ready();
    expect(t.link().conn.injected).toEqual(["en attente"]);
  });
});
