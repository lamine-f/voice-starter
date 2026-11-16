import type { ProviderEvents } from "@voice-starter/core";
import type { HistoryItem, SessionGrant } from "@voice-starter/protocol";
import { describe, expect, it, vi } from "vitest";
import { deepgramProvider } from "../src/client.ts";

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.OPEN;
  binaryType = "blob";
  sent: unknown[] = [];
  closed = false;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.closed = true;
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const GRANT: SessionGrant = {
  provider: "deepgram",
  url: "wss://agent.deepgram.com/v1/agent/converse",
  token: "tok",
  settings: { type: "Settings", agent: { think: { prompt: "p" } } },
  audio: { inputRate: 16000, outputRate: 24000 },
  tools: [],
};

function connect(history: HistoryItem[] = []) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const events = {
    ready: vi.fn(),
    transcript: vi.fn(),
    history: vi.fn(),
    userSpeaking: vi.fn(),
    agentThinking: vi.fn(),
    agentAudio: vi.fn(),
    agentDone: vi.fn(),
    toolCall: vi.fn(),
    toolCancelled: vi.fn(),
    injectionRefused: vi.fn(),
    error: vi.fn(),
    closed: vi.fn(),
  } satisfies ProviderEvents;
  const provider = deepgramProvider({ WebSocket: FakeSocket as unknown as typeof WebSocket });
  const conn = provider.connect(GRANT, history, events);
  return { conn, events, socket: FakeSocket.last };
}

describe("deepgram connection", () => {
  it("authenticates with the bearer subprotocol and sends Settings on Welcome", () => {
    const { socket } = connect();
    expect(socket.url).toBe(GRANT.url);
    expect(socket.protocols).toEqual(["bearer", "tok"]);
    expect(socket.binaryType).toBe("arraybuffer");
    socket.receive({ type: "Welcome" });
    expect(socket.sent).toEqual([GRANT.settings]);
  });

  it("replays the history in the agent context, with schema fields only", () => {
    const { socket } = connect([
      { kind: "message", role: "agent", content: "Bonjour" },
      {
        kind: "toolCalls",
        calls: [{ callId: "f1", name: "show", arguments: "{}", response: '{"ok":true}' }],
      },
    ]);
    socket.receive({ type: "Welcome" });
    expect(socket.sent[0]).toEqual({
      type: "Settings",
      agent: {
        think: { prompt: "p" },
        context: {
          messages: [
            { type: "History", role: "assistant", content: "Bonjour" },
            {
              type: "History",
              function_calls: [
                {
                  id: "f1",
                  name: "show",
                  client_side: true,
                  arguments: "{}",
                  response: '{"ok":true}',
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("translates the agent's messages into provider events", () => {
    const { socket, events } = connect();
    socket.receive({ type: "SettingsApplied" });
    socket.receive({ type: "ConversationText", role: "assistant", content: "Très bien." });
    socket.receive({ type: "ConversationText", role: "user", content: "Merci" });
    socket.receive({ type: "UserStartedSpeaking" });
    socket.receive({ type: "AgentThinking", content: "" });
    socket.receive({ type: "AgentAudioDone" });
    socket.receive({ type: "InjectionRefused" });
    socket.receive({
      type: "History",
      role: "user",
      content: "salut",
      conversational_behavior: "x",
    });
    socket.onmessage?.({ data: new Int16Array([1, 2]).buffer });
    socket.onmessage?.({ data: new ArrayBuffer(0) });
    expect(events.ready).toHaveBeenCalledOnce();
    expect(events.transcript.mock.calls).toEqual([
      ["agent", "Très bien."],
      ["user", "Merci"],
    ]);
    expect(events.userSpeaking).toHaveBeenCalledOnce();
    expect(events.agentThinking).toHaveBeenCalledOnce();
    expect(events.agentDone).toHaveBeenCalledOnce();
    expect(events.injectionRefused).toHaveBeenCalledOnce();
    expect(events.history).toHaveBeenCalledWith({
      kind: "message",
      role: "user",
      content: "salut",
    });
    expect(events.agentAudio).toHaveBeenCalledOnce(); // the empty chunk is skipped
  });

  it("passes on client-side calls and echoes their thought signature", () => {
    const { socket, events, conn } = connect();
    socket.receive({
      type: "FunctionCallRequest",
      functions: [
        {
          id: "f1",
          name: "show",
          arguments: '{"a":1}',
          client_side: true,
          thought_signature: "sig",
        },
        { id: "f2", name: "builtin", arguments: "{}", client_side: false },
      ],
    });
    expect(events.toolCall).toHaveBeenCalledExactlyOnceWith({
      id: "f1",
      name: "show",
      arguments: '{"a":1}',
      meta: "sig",
    });
    conn.sendToolResult(events.toolCall.mock.calls[0]?.[0], { ok: true });
    expect(socket.sent.at(-1)).toEqual({
      type: "FunctionCallResponse",
      id: "f1",
      name: "show",
      content: '{"ok":true}',
      thought_signature: "sig",
    });
    socket.receive({ type: "FunctionCallCancelled", functions: [{ id: "f1" }] });
    expect(events.toolCancelled).toHaveBeenCalledWith("f1");
  });

  it("explains a close with the Error that preceded it", () => {
    const { socket, events } = connect();
    socket.receive({ type: "Error", code: "CLIENT_MESSAGE_TIMEOUT", description: "trop long" });
    socket.onclose?.({ code: 1005, reason: "" });
    expect(events.error).toHaveBeenCalledWith("CLIENT_MESSAGE_TIMEOUT : trop long");
    expect(events.closed).toHaveBeenCalledWith("CLIENT_MESSAGE_TIMEOUT : trop long");
  });

  it("falls back to the close code, and stays quiet when closed on purpose", () => {
    const first = connect();
    first.socket.onclose?.({ code: 1006, reason: "abnormal" });
    expect(first.events.closed).toHaveBeenCalledWith("code 1006 : abnormal");
    const second = connect();
    second.conn.close();
    second.socket.onclose?.({ code: 1000, reason: "" });
    expect(second.socket.closed).toBe(true);
    expect(second.events.closed).not.toHaveBeenCalled();
  });

  it("sends audio and injections only on an open socket", () => {
    const { socket, conn } = connect();
    const pcm = new Int16Array([5]);
    conn.sendAudio(pcm);
    conn.inject("[SYSTEM] résultat");
    expect(socket.sent).toEqual([pcm, { type: "InjectUserMessage", content: "[SYSTEM] résultat" }]);
    socket.readyState = 3;
    conn.sendAudio(pcm);
    expect(socket.sent).toHaveLength(2);
  });
});
