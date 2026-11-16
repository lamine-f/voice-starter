/**
 * The JSON Schema subset tool parameters are written in, and its checker.
 *
 * The relay refuses, at declaration time, any keyword outside this subset
 * (unions first: some providers' models reject them). Whatever reaches the
 * core can therefore be checked here, with no library: the core validates a
 * client tool's arguments before handing the call to the host, as the relay
 * does for server tools.
 */
import type { JsonSchema } from "./index.ts";

/** Keywords the checker enforces. */
const CHECKED = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
] as const;

/** Annotations: they describe, they do not constrain (`format` included, as the standard says). */
const ANNOTATIONS = ["description", "title", "default", "examples", "format"] as const;

/** Every keyword a tool's parameters may use. */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([...CHECKED, ...ANNOTATIONS]);

const TYPE_NAMES: Record<string, string> = {
  object: "objet",
  array: "liste",
  string: "texte",
  number: "nombre",
  integer: "entier",
  boolean: "booléen",
  null: "null",
};

/**
 * The first way `value` breaks `schema`, as a sentence the agent can act on
 * ("kpis[0].value : texte attendu"), or null when it fits.
 */
export function checkArgs(schema: JsonSchema, value: unknown, path = ""): string | null {
  const at = (problem: string) => (path ? `${path} : ${problem}` : problem);
  const s = schema as Record<string, unknown>;

  if (typeof s.type === "string" && !hasType(value, s.type)) {
    return at(`${TYPE_NAMES[s.type] ?? s.type} attendu`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((option) => option === value)) {
    return at(`une valeur parmi ${s.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }
  if ("const" in s && s.const !== value) return at(`${JSON.stringify(s.const)} attendu`);

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return at(`au moins ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) return at(`au plus ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) {
      return at(`plus de ${s.exclusiveMinimum}`);
    }
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) {
      return at(`moins de ${s.exclusiveMaximum}`);
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) {
      return at(`au moins ${s.minLength} caractère(s)`);
    }
    if (typeof s.maxLength === "number" && length > s.maxLength) {
      return at(`au plus ${s.maxLength} caractère(s)`);
    }
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) {
      return at(`format attendu : ${s.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) {
      return at(`au moins ${s.minItems} élément(s)`);
    }
    if (typeof s.maxItems === "number" && value.length > s.maxItems) {
      return at(`au plus ${s.maxItems} élément(s)`);
    }
    if (isSchema(s.items)) {
      for (const [i, item] of value.entries()) {
        const problem = checkArgs(s.items, item, `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (isObject(value)) {
    const properties = isSchema(s.properties) ? (s.properties as Record<string, JsonSchema>) : {};
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (!(String(key) in value)) return at(`${String(key)} manquant`);
    }
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      const property = properties[key];
      if (property) {
        const problem = checkArgs(property, item, child);
        if (problem) return problem;
      } else if (s.additionalProperties === false) {
        return `${child} : champ inconnu`;
      }
    }
  }
  return null;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isObject(value);
}
