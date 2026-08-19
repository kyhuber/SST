/**
 * The Little Green Light grant funnel.
 *
 * What is worth testing here is not arithmetic — it is the set of places where
 * this code is supposed to refuse to produce a number. LGL is a partial
 * picture during the prototype and its API does not expose everything the
 * funnel is defined in terms of, so the failure mode that matters is a total
 * that looks clean while quietly omitting records or filling in a gap with a
 * guess. Each test below pins one of those refusals.
 *
 * Every outbound request is intercepted. Nothing in this file reaches LGL.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMOUNT_DUE_NOTE, getGrants, readReimbursable } from "../src/lgl";
import type { Env } from "../src/types";

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

let calls: RecordedCall[] = [];

/**
 * What each API path returns. A path with no entry gets a network failure, so
 * a request this file did not anticipate can never quietly succeed.
 */
let routes: Record<string, (url: URL) => Response> = {};

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push({
      method: init?.method ?? "GET",
      url: href,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    const path = url.pathname.replace("/api/v1/", "");
    const route = routes[path];
    if (!route) throw new TypeError("Network connection lost.");
    return route(url);
  });
});

afterEach(() => vi.unstubAllGlobals());

/** An LGL list response. `date` is the header the retrieval time comes from. */
function page(items: unknown[], totalItems = items.length): Response {
  return new Response(
    JSON.stringify({
      api_version: "1.0",
      items_count: items.length,
      total_items: totalItems,
      limit: 100,
      offset: 0,
      items,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        date: "Fri, 14 Aug 2026 17:05:00 GMT",
      },
    },
  );
}

const GIFT_TYPES = [
  { id: 1, name: "Gift" },
  { id: 7, name: "Pledge" },
  { id: 13, name: "Installment" },
];

/** Live mode with a key. Individual tests narrow this further. */
function liveEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, LGL_MODE: "live", LGL_API_KEY: "test-lgl-key", ...overrides } as Env;
}

function fixtureEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, LGL_MODE: "fixture", ...overrides } as Env;
}

function stage(snapshot: Awaited<ReturnType<typeof getGrants>>, key: string) {
  const found = snapshot.stages.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key} stage`);
  return found;
}

describe("the amount-due gap", () => {
  it("reports Received and Outstanding as unavailable, with the reason", async () => {
    // LGL's REST API exposes no amount-due or balance field on any object, and
    // both of these figures are defined in terms of it. The spec forbids
    // recomputing it by summing payment gifts. So the only honest output is no
    // number plus a stated reason — and that must survive a healthy read, not
    // just an error path.
    const snapshot = await getGrants(fixtureEnv());

    for (const key of ["received", "outstanding"]) {
      const figure = stage(snapshot, key);
      expect(figure.status).toBe("unavailable");
      expect(figure.amount).toBeNull();
      expect(figure.recordCount).toBeNull();
      expect(figure.note).toBe(AMOUNT_DUE_NOTE);
    }
  });
});

describe("reimbursable status", () => {
  it("reads an absent custom field as unknown rather than assuming", async () => {
    // The state every HPIC record is in today. Defaulting a silent record to
    // "not reimbursable" would move roughly $900,000 of cost-reimbursement
    // awards into the spendable column, which is the specific failure this
    // dashboard exists to prevent.
    expect(readReimbursable({})).toBe("unknown");
    expect(readReimbursable({ custom_fields: [] })).toBe("unknown");
    expect(readReimbursable({ custom_fields: [{ key: "contract_signed", values: [{ name: "Yes" }] }] })).toBe(
      "unknown",
    );
    // Present but unparseable is still unknown, not a guess.
    expect(readReimbursable({ custom_fields: [{ key: "reimbursable", values: [{ name: "TBD" }] }] })).toBe(
      "unknown",
    );
    // A field with no value at all.
    expect(readReimbursable({ custom_fields: [{ key: "reimbursable", values: [] }] })).toBe("unknown");
  });

  it("reads a populated value from either custom_fields or custom_attrs", async () => {
    expect(readReimbursable({ custom_fields: [{ key: "reimbursable", values: [{ name: "Yes" }] }] })).toBe(
      "reimbursable",
    );
    expect(readReimbursable({ custom_fields: [{ name: "Reimbursable", values: [{ name: "No" }] }] })).toBe(
      "not_reimbursable",
    );
    // Appeal requests carry custom_attrs as well as custom_fields.
    expect(readReimbursable({ custom_attrs: [{ key: "reimbursable", value: "true" }] })).toBe(
      "reimbursable",
    );
  });

  it("never merges reimbursable and non-reimbursable awards into one figure", async () => {
    const snapshot = await getGrants(fixtureEnv({ LGL_GRANT_CAMPAIGN_IDS: "901" }));

    // Three separate buckets, each with its own count. Nothing in the payload
    // adds them together, because a cost-reimbursement award is not cash
    // available to start work.
    const byStatus = Object.fromEntries(
      snapshot.awardsByReimbursable.map((bucket) => [bucket.status, bucket]),
    );
    expect(byStatus.reimbursable).toMatchObject({ amount: 750000, recordCount: 1 });
    expect(byStatus.not_reimbursable).toMatchObject({ amount: 150000, recordCount: 1 });
    expect(byStatus.unknown).toMatchObject({ amount: 60000, recordCount: 1 });

    // The buckets partition the awards: every award lands in exactly one.
    const bucketed = snapshot.awardsByReimbursable.reduce((n, b) => n + b.recordCount, 0);
    expect(bucketed).toBe(stage(snapshot, "pledged").recordCount);
  });
});

describe("record counts and scoping", () => {
  it("reports a count beside every figure it shows", async () => {
    // A grant that was never entered into LGL shows up as a count
    // discrepancy long before anyone would notice a total being low.
    const snapshot = await getGrants(fixtureEnv({ LGL_GRANT_CAMPAIGN_IDS: "901" }));

    expect(stage(snapshot, "applied")).toMatchObject({
      status: "ok",
      amount: 1175000,
      recordCount: 3,
    });
    expect(stage(snapshot, "pledged")).toMatchObject({
      status: "ok",
      amount: 960000,
      recordCount: 3,
    });
  });

  it("flags an unscoped read instead of passing donor activity off as grants", async () => {
    // With no grant campaign configured, the figures cover every appeal ask and
    // pledge in LGL — including individual donors. That is a defensible
    // prototype state, but only if it is stated.
    const snapshot = await getGrants(fixtureEnv());

    expect(snapshot.unscoped).toBe(true);
    expect(stage(snapshot, "applied").recordCount).toBe(5);
    expect(stage(snapshot, "applied").note).toMatch(/not scoped to grants/i);
    expect(stage(snapshot, "pledged").note).toMatch(/not scoped to grants/i);

    const scoped = await getGrants(fixtureEnv({ LGL_GRANT_CAMPAIGN_IDS: "901" }));
    expect(scoped.unscoped).toBe(false);
    expect(stage(scoped, "applied").note).toBeUndefined();
  });
});

describe("reads against LGL", () => {
  function standardRoutes() {
    routes["gift_types"] = () => page(GIFT_TYPES);
    routes["appeals"] = () => page([{ id: 3301, name: "Rebuild Grants", campaign_id: 901 }]);
    routes["appeals/3301/appeal_requests"] = () =>
      page([{ id: 1, ask_amount: 500000, status: "submitted" }]);
    routes["gifts/search"] = () =>
      page([{ id: 9, gift_type_id: 7, received_amount: 400000, custom_fields: [] }]);
  }

  it("resolves the Pledge gift type by name and sends the configured scope", async () => {
    standardRoutes();
    await getGrants(
      liveEnv({ LGL_GRANT_CAMPAIGN_IDS: "901", LGL_GRANT_GIFT_CATEGORY_IDS: "6101" }),
    );

    // The gift type ID is looked up rather than hardcoded: a wrong ID would
    // return zero awards, which is indistinguishable from HPIC having none.
    const search = calls.find((call) => call.url.includes("gifts/search"));
    const query = new URL(search!.url).searchParams.get("q[]");
    expect(query).toBe("gift_types=in|7;campaigns=in|901;categories=in|6101");
  });

  it("only ever issues GETs, with the key in an Authorization header", async () => {
    standardRoutes();
    await getGrants(liveEnv());

    // The dashboard is read-only by construction. A write to LGL would corrupt
    // the system of record for HPIC's fundraising.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.headers.Authorization).toBe("Bearer test-lgl-key");
    }
  });

  it("takes the retrieval time from LGL's own response, not the local clock", async () => {
    standardRoutes();
    const snapshot = await getGrants(liveEnv());

    // A dashboard that always shows the current time regardless of data
    // freshness is worse than one showing no time at all.
    expect(snapshot.retrievedAt).toBe("Fri, 14 Aug 2026 17:05:00 GMT");
  });

  it("does not report the connection as ok when LGL rejects the key", async () => {
    routes["gift_types"] = () => new Response("Unauthorized", { status: 401 });
    routes["appeals"] = () => new Response("Unauthorized", { status: 401 });

    const snapshot = await getGrants(liveEnv());

    expect(snapshot.connection).toBe("unavailable");
    expect(stage(snapshot, "applied").status).toBe("unavailable");
    expect(stage(snapshot, "pledged").status).toBe("unavailable");
    expect(stage(snapshot, "applied").note).toMatch(/rejected the API key/i);
  });

  it("still shows the awards when the applications read fails", async () => {
    // Graceful degradation: one failing source must not blank the panel.
    standardRoutes();
    routes["appeals"] = () => new Response("Server error", { status: 500 });

    const snapshot = await getGrants(liveEnv());

    expect(stage(snapshot, "applied").status).toBe("unavailable");
    expect(stage(snapshot, "pledged")).toMatchObject({
      status: "ok",
      amount: 400000,
      recordCount: 1,
    });
    expect(snapshot.connection).toBe("ok");
  });

  it("suppresses a total it could not read to the end", async () => {
    // The Phase 1 rule applied to Phase 2: a sum missing its last pages
    // understates the funnel exactly the way a dropped account understates
    // cash. Every page comes back full, so paging never reaches the end.
    standardRoutes();
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      gift_type_id: 7,
      received_amount: 1000,
      custom_fields: [],
    }));
    routes["gifts/search"] = () => page(full, 999999);

    const snapshot = await getGrants(liveEnv());

    const pledged = stage(snapshot, "pledged");
    expect(pledged.status).toBe("unavailable");
    expect(pledged.amount).toBeNull();
    expect(pledged.note).toMatch(/partial total would understate/i);
  });

  it("says the key is missing rather than reporting an empty funnel", async () => {
    const snapshot = await getGrants(liveEnv({ LGL_API_KEY: undefined }));

    expect(snapshot.connection).toBe("not_configured");
    expect(stage(snapshot, "pledged").amount).toBeNull();
    expect(stage(snapshot, "pledged").note).toMatch(/no little green light api key/i);
    // Nothing was called; a missing key is caught before any request.
    expect(calls).toHaveLength(0);
  });
});
