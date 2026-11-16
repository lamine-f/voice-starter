import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests run against the sources of sibling packages, not their build.
  resolve: { conditions: ["source"] },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
