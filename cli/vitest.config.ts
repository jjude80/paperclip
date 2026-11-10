import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every CLI test gets a user bus that does not exist. See the file's header
    // for why the runner guard alone is not enough (NEXA-714).
    setupFiles: ["./src/__tests__/helpers/isolate-user-bus.ts"],
  },
});
