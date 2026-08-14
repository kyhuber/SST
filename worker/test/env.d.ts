/**
 * Tells TypeScript that the `env` handed to tests is this Worker's `Env`.
 *
 * Without this, `env` from "cloudflare:test" is the empty ambient
 * `Cloudflare.Env`, and every binding on it types as an error. The bindings
 * themselves are supplied by vitest.config.ts.
 */

import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
