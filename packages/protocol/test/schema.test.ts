import { describe, expect, it } from "vitest";
import { checkArgs } from "../src/index.ts";

// What z.toJSONSchema gives for a report tool: nested objects, lists, enums, optional fields.
const report = {
  type: "object",
  properties: {
    title: { type: "string", description: "Report title" },
    kpis: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { label: { type: "string" }, value: { type: "string" } },
        required: ["label", "value"],
      },
    },
    chart: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["line", "bar"] },
        series: { type: "array", items: { type: "array", items: { type: "number" } } },
      },
    },
    page: { type: "integer", minimum: 1 },
    code: { type: "string", pattern: "^[A-Z]{3}$", format: "currency" },
  },
  required: ["title"],
} as const;

describe("checkArgs", () => {
  it("accepts what fits, optional fields left out", () => {
    expect(checkArgs(report, { title: "Ventes" })).toBeNull();
    expect(
      checkArgs(report, {
        title: "Ventes",
        kpis: [{ label: "CA", value: "1,2 M" }],
        chart: { type: "bar", series: [[1, 2.5]] },
        page: 2,
        code: "XOF",
      }),
    ).toBeNull();
  });

  it("says where and how the arguments break the schema", () => {
    expect(checkArgs(report, {})).toBe("title manquant");
    expect(checkArgs(report, { title: 3 })).toBe("title : texte attendu");
    expect(checkArgs(report, { title: "x", kpis: [{ label: "CA" }] })).toBe(
      "kpis[0] : value manquant",
    );
    expect(checkArgs(report, { title: "x", chart: { type: "pie" } })).toBe(
      'chart.type : une valeur parmi "line", "bar"',
    );
    expect(checkArgs(report, { title: "x", chart: { series: [[1, "2"]] } })).toBe(
      "chart.series[0][1] : nombre attendu",
    );
    expect(checkArgs(report, { title: "x", page: 1.5 })).toBe("page : entier attendu");
    expect(checkArgs(report, { title: "x", page: 0 })).toBe("page : au moins 1");
    expect(checkArgs(report, { title: "x", code: "xof" })).toBe(
      "code : format attendu : ^[A-Z]{3}$",
    );
    expect(checkArgs(report, { title: "x", kpis: Array(5).fill({ label: "a", value: "b" }) })).toBe(
      "kpis : au plus 4 élément(s)",
    );
    expect(checkArgs(report, [])).toBe("objet attendu");
  });

  it("refuses unknown fields only when the schema closes the object", () => {
    expect(checkArgs(report, { title: "x", extra: true })).toBeNull();
    expect(checkArgs({ ...report, additionalProperties: false }, { title: "x", extra: true })).toBe(
      "extra : champ inconnu",
    );
  });
});
