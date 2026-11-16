/**
 * The relay: the only place that holds the provider key.
 *
 * It grants sessions (a short-lived token plus complete settings, so a client
 * never chooses its prompt or its tools) and runs server tools with validated
 * arguments.
 */
import type { SessionGrant, ToolDeclaration } from "@lamine-f/voice-protocol";
import { z } from "zod";
import { declaration, isServerTool, type ServerTool, type ToolSpec } from "./tools.ts";

/** An error with the HTTP status the routes answer with. */
export class BrokerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The server side of a provider: grants tokens and builds its session settings. */
export interface ProviderBackend {
  readonly name: string;
  readonly url: string;
  readonly audio: { inputRate: number; outputRate: number };
  grantToken(): Promise<string>;
  buildSettings(prompt: string, tools: ToolDeclaration[]): unknown;
}

export interface BrokerOptions<Ctx> {
  provider: ProviderBackend;
  prompt: string;
  /** Client tools as declared; server tools with their handler (`implement`). */
  // biome-ignore lint/suspicious/noExplicitAny: each tool keeps its own parameter type
  tools: ReadonlyArray<ToolSpec<any> | ServerTool<any, Ctx>>;
}

export interface Broker<Ctx = void> {
  readonly tools: readonly ToolDeclaration[];
  openSession(): Promise<SessionGrant>;
  callTool(name: string, args: unknown, ctx: Ctx): Promise<unknown>;
}

export function createBroker<Ctx = void>(options: BrokerOptions<Ctx>): Broker<Ctx> {
  const { provider, prompt } = options;
  const byName = new Map<string, ToolSpec | ServerTool<z.ZodObject, Ctx>>();
  for (const t of options.tools) {
    if (byName.has(t.name)) throw new Error(`outil déclaré deux fois : ${t.name}`);
    if (t.runsOn === "server" && !isServerTool(t)) {
      throw new Error(`outil serveur sans gestionnaire : ${t.name} (utilise implement())`);
    }
    byName.set(t.name, t);
  }
  const tools = [...byName.values()].map(declaration);

  return {
    tools,

    async openSession() {
      return {
        provider: provider.name,
        url: provider.url,
        token: await provider.grantToken(),
        settings: provider.buildSettings(prompt, tools),
        audio: provider.audio,
        tools,
      };
    },

    async callTool(name, args, ctx) {
      const t = byName.get(name);
      if (!t) throw new BrokerError(404, `outil inconnu : ${name}`);
      if (!isServerTool(t)) throw new BrokerError(400, `${name} s'exécute côté client`);
      const parsed = t.parameters.safeParse(args);
      if (!parsed.success) {
        throw new BrokerError(
          400,
          `arguments invalides pour ${name} : ${z.prettifyError(parsed.error)}`,
        );
      }
      return t.run(parsed.data, ctx);
    },
  };
}
