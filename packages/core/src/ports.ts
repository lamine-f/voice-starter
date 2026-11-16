/**
 * The four ports a platform plugs into the voice core. The core never touches
 * the DOM, the system or the provider key: whatever differs between a browser,
 * a desktop app or a phone lives behind these interfaces.
 */
import type { HistoryItem, Role, SessionGrant } from "@lamine-f/voice-protocol";

/** 16-bit mono PCM, on a plain (transferable) buffer. */
export type Pcm16 = Int16Array<ArrayBuffer>;

/** Microphone → 16-bit PCM chunks. */
export interface AudioInput {
  /** Acquire the microphone (asks for permission): done before the short-lived grant. */
  open(): Promise<void>;
  start(sampleRate: number, onChunk: (pcm16: Pcm16) => void): Promise<void>;
  close(): void;
}

/** 16-bit PCM chunks → speakers, queued back to back. */
export interface AudioOutput {
  start(sampleRate: number): Promise<void>;
  play(pcm16: Pcm16): void;
  /** Drop everything queued: the user talks over the agent. */
  interrupt(): void;
  close(): void;
}

/** The relay server: grants sessions and runs server tools. */
export interface SessionBroker {
  open(): Promise<SessionGrant>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

/** A tool call as the provider asked it. */
export interface ProviderToolCall {
  id: string;
  name: string;
  /** JSON text; the core parses it. */
  arguments: string;
  /** Provider-specific data the answer must carry back. */
  meta?: unknown;
}

/** What a provider connection reports, already translated from its own messages. */
export interface ProviderEvents {
  /** Settings accepted: audio and injections may flow. */
  ready(): void;
  transcript(role: Role, text: string): void;
  history(item: HistoryItem): void;
  /** The user started talking (over the agent, possibly). */
  userSpeaking(): void;
  agentThinking(): void;
  agentAudio(pcm16: Pcm16): void;
  /** The agent finished speaking. */
  agentDone(): void;
  toolCall(call: ProviderToolCall): void;
  toolCancelled(callId: string): void;
  /** The agent was busy: the last injection was not taken. */
  injectionRefused(): void;
  error(message: string): void;
  /**
   * The provider refused the session settings (unknown model, bad field):
   * reconnecting with the same settings cannot help.
   */
  rejected(message: string): void;
  /** The link ended without `close()` being called; `cause` says why. */
  closed(cause: string): void;
}

/** One live link to the provider. A reconnection opens a new one. */
export interface ProviderConnection {
  sendAudio(pcm16: Pcm16): void;
  sendToolResult(call: ProviderToolCall, result: unknown): void;
  inject(text: string): void;
  close(): void;
}

export interface VoiceProvider {
  /** `history`: the conversation so far, so a reconnected agent picks up the thread. */
  connect(
    grant: SessionGrant,
    history: readonly HistoryItem[],
    events: ProviderEvents,
  ): ProviderConnection;
}
