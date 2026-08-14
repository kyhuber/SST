/**
 * Test configuration for the Worker.
 *
 * Tests run inside workerd — the same runtime that serves the deployed Worker —
 * rather than against a hand-rolled mock of the Durable Object storage API.
 * TokenStore's correctness depends on storage semantics and on how the runtime
 * interleaves concurrent calls at `await` points, and neither survives being
 * approximated.
 *
 * The bindings below are the secrets, which by design are not in wrangler.toml.
 * They are obvious fakes: nothing here reaches Intuit, because every outbound
 * request is intercepted (see test/tokens.test.ts).
 */

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // Required by the test pool itself. Deliberately set here rather than
        // in wrangler.toml: the deployed Worker does not need it, and adding a
        // compatibility flag to production to satisfy a test runner would be
        // the wrong trade.
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          QBO_CLIENT_ID: "test-client-id",
          QBO_CLIENT_SECRET: "test-client-secret",
          ACCESS_PASSPHRASE: "test-passphrase",
          QBO_REALM_ID: "test-realm",
          QBO_OPERATING_ACCOUNT_ID: "35",
          QBO_REBUILD_FUND_ACCOUNT_ID: "36",
          // The refresh path is what these tests exercise, and it is only
          // reachable in live mode.
          QBO_MODE: "live",
        },
      },
    }),
  ],
});
