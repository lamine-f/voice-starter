/**
 * "@lamine-f/voice-broker/tools": the registry alone, for browsers. Declaring
 * tools, typing their arguments and results, and validating what the agent
 * sent need nothing from the relay (Hono, routes, provider backends).
 */
// Declare tools with this instance: the one that turns schemas into JSON Schema.
export { z } from "zod";
export type { ParsedArgs, ServerTool, ToolArgs, ToolResult, ToolSpec } from "./tools.ts";
export { declaration, implement, parseArgs, tool } from "./tools.ts";
