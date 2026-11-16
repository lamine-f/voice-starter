/**
 * The tool registry: every tool is declared once, with a Zod schema.
 *
 * The same declaration gives the JSON Schema published to the provider, the
 * type of the arguments a handler receives, and the validation of what the
 * agent actually sent. Declarations carry no handler, so a browser bundle can
 * import their types without pulling server code.
 */
import type { JsonSchema, ToolDeclaration, ToolLocation } from "@lamine-f/voice-protocol";
import { z } from "zod";

export interface ToolSpec<P extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  readonly runsOn: ToolLocation;
}

/** A server tool: its declaration plus what runs it. `ctx` comes from the route's `authorize`. */
export interface ServerTool<P extends z.ZodObject = z.ZodObject, Ctx = void> extends ToolSpec<P> {
  readonly run: (args: z.output<P>, ctx: Ctx) => unknown;
}

/** The arguments a tool receives, typed from its declaration. */
export type ToolArgs<T extends ToolSpec> = z.output<T["parameters"]>;

/** Declare a tool. Typing helper: the spec is returned as is. */
export function tool<P extends z.ZodObject>(spec: ToolSpec<P>): ToolSpec<P> {
  return spec;
}

/** Attach the handler of a server tool to its declaration. */
export function implement<P extends z.ZodObject, Ctx = void>(
  spec: ToolSpec<P>,
  run: (args: z.output<P>, ctx: Ctx) => unknown,
): ServerTool<P, Ctx> {
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
  assertNoUnion(spec.name, parameters);
  return { name: spec.name, description: spec.description, parameters, runsOn: spec.runsOn };
}

/** Some providers' models (Gemini) reject union types: refuse them at declaration time. */
function assertNoUnion(tool: string, schema: JsonSchema, path = "parameters"): void {
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || (key === "type" && Array.isArray(value))) {
      throw new Error(`${tool} : type union refusé dans ${path} (non pris en charge par Gemini)`);
    }
    if (value && typeof value === "object") {
      assertNoUnion(tool, value as JsonSchema, `${path}.${key}`);
    }
  }
}
