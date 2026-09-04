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
import { getGrants, readReimbursable, RECONCILIATION_NOTE } from "../src/lgl";
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

/**
 * Both helpers clear every LGL var before applying overrides.
 *
 * `env` carries whatever wrangler.toml sets, and it sets a real scope
 * (campaign 871, categories 6031/6076) plus a tenant URL. Without this, a test
 * asserting what happens with a var *unset* silently becomes a test of the
 * deployed configuration — which is exactly what happened twice: once when the
 * live cutover landed and turned the "unscoped" tests into scoped ones, and
 * again when LGL_UI_BASE_URL was added and gave records a link the test had
 * asserted they would not have.
 *
 * A test has to construct the state it is testing rather than inherit it, so
 * every var this file exercises is listed here even when it is currently unset
 * in wrangler.toml.
 */
const NO_LGL_CONFIG = {
  LGL_GRANT_CAMPAIGN_IDS: undefined,
  LGL_GRANT_GIFT_CATEGORY_IDS: undefined,
  LGL_GRANT_PAYMENT_CATEGORY_IDS: undefined,
  LGL_UI_BASE_URL: undefined,
} as const;

/** Live mode with a key. Individual tests narrow this further. */
function liveEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...NO_LGL_CONFIG, LGL_MODE: "live", LGL_API_KEY: "test-lgl-key", ...overrides } as Env;
}

function fixtureEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...NO_LGL_CONFIG, LGL_MODE: "fixture", ...overrides } as Env;
}

function stage(snapshot: Awaited<ReturnType<typeof getGrants>>, key: string) {
  const found = snapshot.stages.find((s) => s.key === key);
  if (!found) throw new Error(`no ${key} stage`);
  return found;
}

/** Scoped exactly as the deployed Worker is: awards, and payments separately. */
function grantEnv(overrides: Partial<Env> = {}): Env {
  return fixtureEnv({
    LGL_GRANT_CAMPAIGN_IDS: "901",
    LGL_GRANT_GIFT_CATEGORY_IDS: "6101",
    LGL_GRANT_PAYMENT_CATEGORY_IDS: "6102",
    ...overrides,
  });
}

function exception(snapshot: Awaited<ReturnType<typeof getGrants>>, key: string) {
  return snapshot.exceptions.find((e) => e.key === key);
}

describe("Received, computed provisionally from payment records", () => {
  it("sums payments linked to in-scope awards, and marks the figure provisional", async () => {
    const snapshot = await getGrants(grantEnv());

    // 400,000 + 200,000 against award 991001, and 150,000 against 991002.
    const received = stage(snapshot, "received");
    expect(received.status).toBe("provisional");
    expect(received.amount).toBe(750_000);
    expect(received.recordCount).toBe(3);

    expect(stage(snapshot, "pledged").amount).toBe(960_000);
    const outstanding = stage(snapshot, "outstanding");
    expect(outstanding.status).toBe("provisional");
    expect(outstanding.amount).toBe(210_000);
  });

  it("counts a payment whose campaign is missing", async () => {
    // THE regression test for this file. Payments frequently carry no campaign
    // even when their award has one — two of the three real payments against
    // the $485,000 Commerce award do. Filtering payments by campaign the way
    // awards are filtered drops them silently, which looks exactly like a
    // smaller grant rather than like a bug.
    //
    // Payment 992002 is $200,000 with campaign_id 0 against an award in
    // campaign 901. If this figure reads 550,000, someone has added a campaign
    // filter to readPayments.
    const snapshot = await getGrants(grantEnv());

    expect(stage(snapshot, "received").amount).toBe(750_000);
  });

  it("excludes payments belonging to an award outside the scope", async () => {
    // Payment 992950 hangs off award 991050, which is in campaign 902. Scope
    // has to fall out of the award link rather than needing its own rule.
    const snapshot = await getGrants(grantEnv());

    const ids = snapshot.exceptions.flatMap((e) => e.records.map((r) => r.id));
    expect(ids).not.toContain(992950);
    expect(stage(snapshot, "received").amount).toBe(750_000);
  });

  it("never states a figure QuickBooks has not confirmed as plain fact", async () => {
    // "provisional" is load-bearing. The board must not read an LGL-derived
    // number as reconciled cash, so the status itself carries the caveat
    // rather than a footnote someone can skip.
    const snapshot = await getGrants(grantEnv());

    for (const key of ["received", "outstanding"]) {
      const figure = stage(snapshot, key);
      expect(figure.status).not.toBe("ok");
      expect(figure.note).toMatch(/provisional/i);
    }
    expect(stage(snapshot, "received").note).toMatch(/not reconciled/i);
  });

  it("reports unavailable, not zero, when no payment category is configured", async () => {
    // Unset must never look like "no money has been received".
    const snapshot = await getGrants(grantEnv({ LGL_GRANT_PAYMENT_CATEGORY_IDS: undefined }));

    for (const key of ["received", "outstanding"]) {
      const figure = stage(snapshot, key);
      expect(figure.status).toBe("unavailable");
      expect(figure.amount).toBeNull();
    }
    expect(stage(snapshot, "received").note).toBe(RECONCILIATION_NOTE);
  });
});

describe("the data-quality panel", () => {
  it("names the payments that are linked to no award, and excludes them from Received", async () => {
    // The panel is the point of shipping against imperfect data: the gap has
    // to be nameable and countable in dollars, or it cannot be argued from.
    const snapshot = await getGrants(grantEnv());

    const unlinked = exception(snapshot, "unlinked_payments");
    expect(unlinked).toBeDefined();
    expect(unlinked?.severity).toBe("blocking");
    expect(unlinked?.recordCount).toBe(1);
    expect(unlinked?.amount).toBe(12_500);
    expect(unlinked?.records[0].id).toBe(992900);

    // Excluded from the figure, never quietly absorbed into it.
    expect(stage(snapshot, "received").amount).toBe(750_000);
  });

  it("says the figure may be understated rather than implying it is complete", async () => {
    const snapshot = await getGrants(grantEnv());

    expect(stage(snapshot, "received").note).toMatch(/may be higher|understated/i);
  });

  it("labels a record so a human can act on it", async () => {
    const snapshot = await getGrants(
      grantEnv({ LGL_UI_BASE_URL: "https://example.littlegreenlight.com" }),
    );

    const record = exception(snapshot, "unlinked_payments")?.records[0];
    expect(record?.who).toBe("City Arts Office");
    expect(record?.note).toBe("Addition to the 2025 award.");
    expect(record?.url).toBe("https://example.littlegreenlight.com/gifts/992900");
  });

  it("still reports the exception when the funder name cannot be resolved", async () => {
    // Labelling is best-effort. A failed lookup must not suppress a finding.
    const snapshot = await getGrants(grantEnv());
    const unlinked = exception(snapshot, "unlinked_payments");

    expect(unlinked?.recordCount).toBe(1);
    // No UI base configured here, so there is nothing to link to.
    expect(unlinked?.records[0].url).toBeNull();
  });

  it("flags awards with no reimbursable status as blocking", async () => {
    // This is what keeps Phase 3 unbuildable, so it is not advisory.
    const snapshot = await getGrants(grantEnv());

    const missing = exception(snapshot, "awards_missing_reimbursable");
    expect(missing?.severity).toBe("blocking");
    expect(missing?.records.some((r) => r.id === 991003)).toBe(true);
  });

  it("separates what breaks this dashboard from what breaks LGL's own reports", async () => {
    // A payment with no campaign costs nothing here — the campaign is reached
    // through the award — but LGL's campaign reports understate. Calling that
    // blocking would cry wolf and make the blocking items easier to ignore.
    const snapshot = await getGrants(grantEnv());

    const advisory = exception(snapshot, "payments_missing_campaign");
    expect(advisory?.severity).toBe("advisory");
    expect(advisory?.records.some((r) => r.id === 992002)).toBe(true);
  });

  it("reports no exceptions when a read failed, rather than a clean account", async () => {
    // Zero findings must mean "nothing is wrong", never "nothing was read".
    // `routes` is empty, so every request fails at the network layer.
    const snapshot = await getGrants(
      liveEnv({
        LGL_GRANT_CAMPAIGN_IDS: "901",
        LGL_GRANT_GIFT_CATEGORY_IDS: "6101",
        LGL_GRANT_PAYMENT_CATEGORY_IDS: "6102",
      }),
    );

    expect(snapshot.exceptions).toEqual([]);
    expect(stage(snapshot, "received").status).toBe("unavailable");
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
    // LGL exposes custom_attrs alongside custom_fields, so both are read. The
    // field is unpopulated in HPIC's LGL today; reading both is what lets
    // populating it later light the feature up with no code change.
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

    expect(stage(snapshot, "pledged")).toMatchObject({
      status: "ok",
      amount: 960000,
      recordCount: 3,
    });
  });

  it("flags an unscoped read instead of passing donor activity off as grants", async () => {
    // With no grant campaign configured, the figures cover every pledge in LGL
    // — including individual donors' multi-year pledges. That is a defensible
    // prototype state, but only if it is stated.
    const snapshot = await getGrants(fixtureEnv());

    expect(snapshot.unscoped).toBe(true);
    expect(stage(snapshot, "pledged").recordCount).toBe(4);
    expect(stage(snapshot, "pledged").note).toMatch(/not scoped to grants/i);

    const scoped = await getGrants(fixtureEnv({ LGL_GRANT_CAMPAIGN_IDS: "901" }));
    expect(scoped.unscoped).toBe(false);
    expect(stage(scoped, "pledged").recordCount).toBe(3);
    expect(stage(scoped, "pledged").note).toBeUndefined();
  });
});

describe("reads against LGL", () => {
  function standardRoutes() {
    routes["gift_types"] = () => page(GIFT_TYPES);
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

    const snapshot = await getGrants(liveEnv());

    expect(snapshot.connection).toBe("unavailable");
    expect(stage(snapshot, "pledged").status).toBe("unavailable");
    expect(stage(snapshot, "pledged").note).toMatch(/rejected the API key/i);
  });

  it("never asks LGL for applications", async () => {
    // The funnel starts at money awarded or promised, not money requested
    // (Alex, 2026-08-14). Applications still live in LGL as appeal_requests;
    // reading them is simply not this tool's job. Pinned as a test because the
    // /appeals enumeration is easy to reintroduce while adding a later stage,
    // and it was also the most expensive part of the page walk.
    standardRoutes();
    await getGrants(liveEnv({ LGL_GRANT_CAMPAIGN_IDS: "901" }));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toMatch(/appeal/i);
    }
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
