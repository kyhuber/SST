/**
 * TokenStore — the QuickBooks OAuth refresh path.
 *
 * This is the least-exercised code in the project and the only code that can
 * take the dashboard offline in a way that requires a human to re-authorize.
 * The hourly keep-alive cron exercises the happy path against Intuit, but three
 * of the four failure modes here cannot be reached that way at all: forcing
 * `invalid_grant` means deliberately revoking the live grant, Intuit cannot be
 * made unreachable on demand, and the cron issues one request at a time so it
 * never puts two refreshes in flight together.
 *
 * Every outbound request is intercepted. Nothing in this file reaches Intuit.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthEndpoints } from "../src/endpoints";
import type { TokenStore } from "../src/tokens";

/**
 * Endpoints as published by Intuit's discovery document. Seeded into storage
 * directly so these tests exercise the refresh logic rather than re-testing
 * discovery, and so an unexpected discovery fetch shows up as an unexpected
 * request instead of passing silently.
 */
const INTUIT_ENDPOINTS: OAuthEndpoints = {
  authorization: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};

/** Mirrors the StoredTokens shape held in Durable Object storage. */
interface StoredTokens {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  lastRefreshAt: number;
}

interface RecordedCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** Every outbound request the code under test made, in order. */
let calls: RecordedCall[] = [];

/**
 * What the next request should return. Left null to simulate an unreachable
 * Intuit — which is also what an unexpected request gets, so a call this file
 * did not anticipate can never quietly succeed.
 */
let respond: ((call: RecordedCall) => Response) | null = null;

beforeEach(() => {
  calls = [];
  respond = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      body: init?.body === undefined ? "" : String(init.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    if (!respond) throw new TypeError("Network connection lost.");
    return respond(call);
  });
});

afterEach(() => vi.unstubAllGlobals());

function tokenResponse(accessToken: string, refreshToken: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      x_refresh_token_expires_in: 8726400,
      token_type: "bearer",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * A TokenStore with empty storage and known endpoints.
 *
 * Each test uses its own Durable Object name. The single-flight guard lives in
 * instance memory rather than storage, so sharing an instance between tests
 * would let one test's in-flight state affect the next.
 */
async function freshStore(name: string) {
  const stub = env.TOKEN_STORE.get(env.TOKEN_STORE.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.put("endpoints", { endpoints: INTUIT_ENDPOINTS, at: Date.now() });
  });
  return stub;
}

/** Seed a token pair. `expiresIn: 0` produces a token that is already stale. */
function seed(
  stub: DurableObjectStub<TokenStore>,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
) {
  return stub.seed({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    token_type: "bearer",
  });
}

function readStorage(stub: DurableObjectStub<TokenStore>) {
  return runInDurableObject(stub, async (_instance, state) => ({
    tokens: await state.storage.get<StoredTokens>("tokens"),
    needsReauth: await state.storage.get<boolean>("needs_reauth"),
  }));
}

describe("TokenStore.getAccessToken", () => {
  it("persists the rotated refresh token, not just the access token", async () => {
    const stub = await freshStore("rotation");
    await seed(stub, "access-1", "refresh-1", 0);
    respond = () => tokenResponse("access-2", "refresh-2");

    const result = await stub.getAccessToken();
    expect(result).toEqual({ ok: true, accessToken: "access-2" });

    // Intuit rotates the refresh token and expires the previous value the
    // moment a new one is issued. Storing only the access token would leave the
    // connection working until the next refresh and then break it permanently.
    const { tokens } = await readStorage(stub);
    expect(tokens?.refreshToken).toBe("refresh-2");
    expect(tokens?.accessToken).toBe("access-2");
    expect(tokens?.accessTokenExpiresAt).toBeGreaterThan(Date.now());

    // The request itself: the old refresh token, form-encoded, with the client
    // credentials in a Basic header.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(INTUIT_ENDPOINTS.token);
    expect(calls[0].body).toContain("grant_type=refresh_token");
    expect(calls[0].body).toContain("refresh_token=refresh-1");
    expect(calls[0].headers.Authorization).toBe(
      `Basic ${btoa("test-client-id:test-client-secret")}`,
    );
  });

  it("treats invalid_grant as needing re-authorization and stops trying", async () => {
    const stub = await freshStore("invalid-grant");
    await seed(stub, "access-1", "refresh-1", 0);
    respond = () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    const result = await stub.getAccessToken();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the refresh to fail");
    expect(result.reason).toBe("needs_reauth");

    // A dead refresh token cannot be recovered by retrying. The stored pair is
    // cleared so nothing keeps presenting a token Intuit has already rejected.
    const { tokens, needsReauth } = await readStorage(stub);
    expect(tokens).toBeUndefined();
    expect(needsReauth).toBe(true);

    // And the store stops asking. Hammering Intuit with a token it has already
    // rejected is how an app gets rate-limited on top of being disconnected.
    const second = await stub.getAccessToken();
    expect(second).toEqual({ ok: false, reason: "needs_reauth" });
    expect(calls).toHaveLength(1);
  });

  it("keeps the stored tokens when Intuit is unreachable", async () => {
    const stub = await freshStore("network-failure");
    await seed(stub, "access-1", "refresh-1", 0);
    // `respond` stays null: the request fails the way an outage would.

    const result = await stub.getAccessToken();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the refresh to fail");

    // The property that matters: a transient outage must not cost the board a
    // trip through QuickBooks consent. The refresh token survives untouched and
    // the connection is not marked as needing re-authorization.
    expect(result.reason).not.toBe("needs_reauth");
    const { tokens, needsReauth } = await readStorage(stub);
    expect(tokens?.refreshToken).toBe("refresh-1");
    expect(needsReauth).toBeUndefined();
  });

  it("refreshes once when two callers arrive together", async () => {
    const stub = await freshStore("single-flight");
    await seed(stub, "access-1", "refresh-1", 0);
    respond = () => tokenResponse("access-2", "refresh-2");

    // Two concurrent refreshes with the same refresh token succeed once and
    // return invalid_grant the second time, which revokes the connection
    // outright. This is the reason TokenStore is a Durable Object at all.
    const [first, second] = await runInDurableObject(stub, (instance) =>
      Promise.all([instance.getAccessToken(), instance.getAccessToken()]),
    );

    expect(calls).toHaveLength(1);
    expect(first).toEqual({ ok: true, accessToken: "access-2" });
    expect(second).toEqual({ ok: true, accessToken: "access-2" });
  });

  it("serves a still-valid token without contacting Intuit", async () => {
    const stub = await freshStore("cached-token");
    await seed(stub, "access-1", "refresh-1", 3600);

    const result = await stub.getAccessToken();
    expect(result).toEqual({ ok: true, accessToken: "access-1" });
    expect(calls).toHaveLength(0);
  });

  it("refreshes on demand when QuickBooks rejects a token we believed was good", async () => {
    const stub = await freshStore("forced-refresh");
    await seed(stub, "access-1", "refresh-1", 3600);
    respond = () => tokenResponse("access-2", "refresh-2");

    // The retry path in qbo.ts: a token can be rejected before our own expiry
    // check says it should be, and the read must recover within one request.
    const result = await stub.getAccessToken(true);
    expect(result).toEqual({ ok: true, accessToken: "access-2" });
    expect(calls).toHaveLength(1);
  });
});
