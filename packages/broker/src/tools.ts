/**
 * The tool registry: every tool is declared once, with a Zod schema.
 *
 * The same declaration gives the JSON Schema published to the provider, the
 * type of the arguments a handler receives, and the validation of what the
 * agent actually sent (parseArgs, on the relay for server tools, in the host
 * for client tools). This module needs only Zod: browsers import it through
 * "@lamine-f/voice-broker/tools", without the relay or its routes.
 */
import {
  type JsonSchema,
  SCHEMA_KEYWORDS,
  type ToolDeclaration,
  type ToolLocation,
} from "@lamine-f/voice-protocol";
import { z } from "zod";

export interface ToolSpec<P extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  readonly runsOn: ToolLocation;
}

/**
 * A server tool: its declaration plus what runs it. `ctx` comes from the
 * route's `authorize`; `R` is what it returns, kept for the host's page.
 */
export interface ServerTool<P extends z.ZodObject = z.ZodObject, Ctx = void, R = unknown>
  extends ToolSpec<P> {
  readonly run: (args: z.output<P>, ctx: Ctx) => R;
}

/** The arguments a tool receives, typed from its declaration. */
export type ToolArgs<T extends ToolSpec> = z.output<T["parameters"]>;

/** What a server tool's handler resolves to: the result the page receives in toolActivity. */
// biome-ignore lint/suspicious/noExplicitAny: matches any parameters and context
export type ToolResult<T extends ServerTool<any, any, unknown>> = Awaited<ReturnType<T["run"]>>;

export type ParsedArgs<P extends z.ZodObject> =
  | { success: true; data: z.output<P> }
  | { success: false; error: string };

/**
 * Checks what the agent sent against the tool's schema: the relay before a
 * server tool runs, the host before a client tool does. The error reads as a
 * sentence the agent can act on.
 */
export function parseArgs<P extends z.ZodObject>(spec: ToolSpec<P>, args: unknown): ParsedArgs<P> {
  const parsed = spec.parameters.safeParse(args);
  return parsed.success
    ? { success: true, data: parsed.data }
    : {
        success: false,
        error: `arguments invalides pour ${spec.name} : ${z.prettifyError(parsed.error)}`,
      };
}

/** Declare a tool. Typing helper: the spec is returned as is. */
export function tool<P extends z.ZodObject>(spec: ToolSpec<P>): ToolSpec<P> {
  return spec;
}

/** Attach the handler of a server tool to its declaration. */
export function implement<P extends z.ZodObject, Ctx = void, R = unknown>(
  spec: ToolSpec<P>,
  run: (args: z.output<P>, ctx: Ctx) => R,
): ServerTool<P, Ctx, R> {
  if (spec.runsOn !== "server") {
    throw new Error(`${spec.name} est un outil client : il s'exécute dans l'hôte, pas ici`);
  }
  return { ...spec, run };
}

export function isServerTool<Ctx>(
  t: ToolSpec | ServerTool<z.ZodObject, Ctx>,
): t is ServerTool<z.ZodObject, Ctx> {
  return "run" in t;
}

/** The declaration published to the provider and to the core. */
export function declaration(spec: ToolSpec): ToolDeclaration {
  // io "input": the shape the agent must send, without additionalProperties.
  const { $schema: _, ...parameters } = z.toJSONSchema(spec.parameters, { io: "input" });
  assertPortable(spec.name, parameters);
  return { name: spec.name, description: spec.description, parameters, runsOn: spec.runsOn };
}

/**
 * Refuses, at declaration time, what the core could not check (see
 * SCHEMA_KEYWORDS in the protocol), unions first: some providers' models
 * (Gemini) reject them.
 */
function assertPortable(tool: string, schema: JsonSchema, path = "parameters"): void {
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || (key === "type" && Array.isArray(value))) {
      throw new Error(`${tool} : type union refusé dans ${path} (non pris en charge par Gemini)`);
    }
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`${tool} : mot-clé JSON Schema non pris en charge dans ${path} : ${key}`);
    }
    if (key === "properties" && value && typeof value === "object") {
      for (const [name, property] of Object.entries(value)) {
        assertPortable(tool, property as JsonSchema, `${path}.${name}`);
      }
    } else if (key === "items" && value && typeof value === "object") {
      assertPortable(tool, value as JsonSchema, `${path}[]`);
    }
  }
}
