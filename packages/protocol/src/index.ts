/**
 * The contracts every part of a voice interface shares.
 *
 * - Commands and events: what a host and the voice core say to each other.
 *   They are plain JSON, so the same messages work in-page, across an iframe
 *   (postMessage), an IPC bridge or a WebSocket.
 * - Session grant and tool declarations: what the relay server hands the core.
 */

/** Bumped on any incompatible change to the messages below. */
export const PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------ session

export type SessionState =
  | "idle" // nothing open
  | "connecting" // microphone, grant and provider being set up
  | "listening" // the user may speak
  | "thinking" // the agent prepares its answer
  | "speaking" // the agent's voice is playing
  | "reconnecting"; // the link dropped, a new one is being opened

export type Role = "user" | "agent";

/** Where a tool runs: the host (screen, UI) or the relay server (data, secrets). */
export type ToolLocation = "client" | "server";

/** A JSON Schema object, as providers expect for tool parameters. */
export type JsonSchema = { readonly [key: string]: unknown };

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
  runsOn: ToolLocation;
}

/** Everything the core needs to open a provider session, built by the relay. */
export interface SessionGrant {
  provider: string;
  url: string;
  /** Short-lived: only valid for the provider handshake. */
  token: string;
  /** Provider-specific session settings, opaque to the core. */
  settings: unknown;
  audio: { inputRate: number; outputRate: number };
  tools: ToolDeclaration[];
}

/** A conversation turn, kept by the core and replayed after a reconnection. */
export type HistoryItem =
  | { kind: "message"; role: Role; content: string }
  | { kind: "toolCalls"; calls: HistoryToolCall[] };

export interface HistoryToolCall {
  callId: string;
  name: string;
  /** JSON text, as the provider sent it. */
  arguments: string;
  /** JSON text, as the core answered. */
  response: string;
}

// ------------------------------------------------------------------ messages

/** Host → core. */
export type Command =
  /** `clientTools`: the client tools this host can run; every one the grant declares must be listed. */
  | { type: "start"; clientTools: string[] }
  | { type: "stop" }
  /** A system message for the agent: a long task's result, page context. */
  | { type: "inject"; text: string }
  | { type: "toolResult"; callId: string; result: unknown };

export type ErrorCode =
  | "microphone" // no microphone, or permission refused
  | "broker" // the relay refused or could not be reached
  | "missing_tool_handlers" // the grant declares client tools the host cannot run
  | "provider" // the provider reported a problem
  | "disconnected"; // the link dropped and every reconnection failed

/** Core → host. */
export type VoiceEvent =
  | { type: "state"; state: SessionState; cause?: string }
  | { type: "transcript"; role: Role; text: string }
  /** Voice energy of one audio chunk, 0 to 1, to animate the interface. */
  | { type: "level"; source: "input" | "output"; value: number }
  /** Run this client tool, then answer with a `toolResult` command. */
  | { type: "toolCall"; callId: string; name: string; args: unknown }
  /** The agent abandoned the call: do not answer it, undo what it started (its `toolActivity` still comes). */
  | { type: "toolCancelled"; callId: string }
  /** Progress of any tool, client or server. `result` comes with `done` and `error`. */
  | {
      type: "toolActivity";
      callId: string;
      name: string;
      status: "started" | "done" | "error";
      result?: unknown;
    }
  /** `fatal`: the session is over and back to `idle`. */
  | { type: "error"; code: ErrorCode; message: string; fatal: boolean };

// ------------------------------------------------------------------ wire

/** A message as it crosses a boundary (iframe, IPC, socket): versioned. */
export type Wire<M> = M & { v: typeof PROTOCOL_VERSION };

export function toWire<M extends Command | VoiceEvent>(message: M): Wire<M> {
  return { ...message, v: PROTOCOL_VERSION };
}

export class ProtocolError extends Error {}

/** Unwrap a message from a boundary; refuses other versions instead of misreading them. */
export function fromWire<M extends Command | VoiceEvent>(data: unknown): M {
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new ProtocolError("message sans type");
  }
  const { v, ...message } = data as { v?: unknown };
  if (v !== PROTOCOL_VERSION) {
    throw new ProtocolError(`version de protocole ${String(v)} non prise en charge`);
  }
  return message as M;
}
