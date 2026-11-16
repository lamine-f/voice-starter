/**
 * Deepgram Voice Agent, client side: the core's VoiceProvider port.
 *
 * Translates the agent's WebSocket messages into the core's provider events,
 * and keeps everything Deepgram-specific here: the bearer subprotocol, the
 * Settings sent on Welcome, `thought_signature` echoed back with tool results,
 * and the Error message that explains a close without a code (1005).
 */
import type {
  Pcm16,
  ProviderConnection,
  ProviderEvents,
  ProviderToolCall,
  VoiceProvider,
} from "@lamine-f/voice-core";
import type { HistoryItem } from "@lamine-f/voice-protocol";

type DeepgramEvent = { type: string; [key: string]: unknown };

interface DeepgramFunctionCall {
  id: string;
  name: string;
  arguments: string;
  client_side?: boolean;
  thought_signature?: string;
}

interface DeepgramHistoryCall {
  id: string;
  name: string;
  client_side?: boolean;
  arguments: string;
  response: string;
}

export interface DeepgramProviderOptions {
  /** For tests or non-browser runtimes. */
  WebSocket?: typeof WebSocket;
}

export function deepgramProvider(options: DeepgramProviderOptions = {}): VoiceProvider {
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  return {
    connect(grant, history, events) {
      return new DeepgramConnection(
        new Socket(grant.url, ["bearer", grant.token]),
        grant.settings,
        history,
        events,
      );
    },
  };
}

class DeepgramConnection implements ProviderConnection {
  readonly #socket: WebSocket;
  #closing = false;
  #lastError: string | null = null; // Deepgram explains itself in an Error, then closes
  #applied = false; // Settings accepted: an Error before that is a refusal of them

  constructor(
    socket: WebSocket,
    settings: unknown,
    history: readonly HistoryItem[],
    events: ProviderEvents,
  ) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data !== "string") {
        if (e.data.byteLength) events.agentAudio(new Int16Array(e.data));
        return;
      }
      this.#onEvent(JSON.parse(e.data) as DeepgramEvent, settings, history, events);
    };
    socket.onclose = (e: CloseEvent) => {
      if (this.#closing) return;
      events.closed(this.#lastError ?? `code ${e.code}${e.reason ? ` : ${e.reason}` : ""}`);
    };
  }

  #onEvent(
    ev: DeepgramEvent,
    settings: unknown,
    history: readonly HistoryItem[],
    events: ProviderEvents,
  ): void {
    switch (ev.type) {
      case "Welcome":
        this.#send(withHistory(settings, history));
        break;
      case "SettingsApplied":
        this.#lastError = null;
        this.#applied = true;
        events.ready();
        break;
      case "ConversationText":
        events.transcript(ev.role === "assistant" ? "agent" : "user", String(ev.content ?? ""));
        break;
      case "History":
        events.history(fromHistoryEvent(ev));
        break;
      case "UserStartedSpeaking":
        events.userSpeaking();
        break;
      case "AgentThinking":
        events.agentThinking();
        break;
      case "AgentAudioDone":
        events.agentDone();
        break;
      case "FunctionCallRequest":
        for (const fn of ev.functions as DeepgramFunctionCall[]) {
          if (!fn.client_side) continue; // Deepgram runs its own server-side functions
          events.toolCall({
            id: fn.id,
            name: fn.name,
            arguments: fn.arguments,
            meta: fn.thought_signature,
          });
        }
        break;
      case "FunctionCallCancelled":
        for (const fn of ev.functions as Array<{ id: string }>) events.toolCancelled(fn.id);
        break;
      case "InjectionRefused":
        events.injectionRefused();
        break;
      case "Warning":
        console.warn("Deepgram :", ev.description);
        break;
      case "Error": {
        const message = [ev.code, ev.description].filter(Boolean).join(" : ") || "erreur Deepgram";
        if (!this.#applied) {
          // Refused settings: Deepgram keeps the socket open, the session
          // would hang, and a reconnection would send the same settings.
          events.rejected(message);
          this.close();
          break;
        }
        this.#lastError = message;
        events.error(message);
        break;
      }
    }
  }

  sendAudio(pcm16: Pcm16): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(pcm16);
  }

  sendToolResult(call: ProviderToolCall, result: unknown): void {
    this.#send({
      type: "FunctionCallResponse",
      id: call.id,
      name: call.name,
      content: JSON.stringify(result),
      // Thinking models (Gemini) need their signature back with the result.
      ...(typeof call.meta === "string" ? { thought_signature: call.meta } : {}),
    });
  }

  inject(text: string): void {
    this.#send({ type: "InjectUserMessage", content: text });
  }

  close(): void {
    this.#closing = true;
    this.#socket.close();
  }

  #send(message: unknown): void {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}

/** Settings plus the conversation so far, so a reconnected agent picks up the thread. */
function withHistory(settings: unknown, history: readonly HistoryItem[]): unknown {
  if (!history.length) return settings;
  const s = settings as { agent: Record<string, unknown> };
  return { ...s, agent: { ...s.agent, context: { messages: history.map(toHistoryEvent) } } };
}

function fromHistoryEvent(ev: DeepgramEvent): HistoryItem {
  if (Array.isArray(ev.function_calls)) {
    return {
      kind: "toolCalls",
      calls: (ev.function_calls as DeepgramHistoryCall[]).map((c) => ({
        callId: c.id,
        name: c.name,
        arguments: c.arguments,
        response: c.response,
      })),
    };
  }
  return {
    kind: "message",
    role: ev.role === "assistant" ? "agent" : "user",
    content: String(ev.content ?? ""),
  };
}

/**
 * Only the fields the context schema defines: with extras such as
 * conversational_behavior, the agent ignores the turn's content.
 */
function toHistoryEvent(item: HistoryItem) {
  if (item.kind === "message") {
    return {
      type: "History",
      role: item.role === "agent" ? "assistant" : "user",
      content: item.content,
    };
  }
  return {
    type: "History",
    function_calls: item.calls.map((c) => ({
      id: c.callId,
      name: c.name,
      client_side: true,
      arguments: c.arguments,
      response: c.response,
    })),
  };
}
