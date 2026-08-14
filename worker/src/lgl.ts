/**
 * Little Green Light reads — the Phase 2 grant funnel.
 *
 * Everything in this file is a GET. The dashboard never writes to LGL.
 *
 * ## What the API actually exposes
 *
 * Verified 2026-08-14 against https://api.littlegreenlight.com/api-docs/static.html
 * rather than assumed, and the result differs from the build spec in a way
 * that changes what this dashboard can honestly show:
 *
 * - **There is no `/goals` endpoint and no `/pledges` endpoint.** The
 *   documented resources are appeals, appeal_requests, gifts, gift_types,
 *   gift_categories, campaigns, funds, and constituents.
 * - The spec's **Goal** — an application carrying an ask amount and a request
 *   status — is an **appeal_request**: `ask_amount`, `status`, `raised`, plus
 *   both `custom_fields` and `custom_attrs`.
 * - The spec's **Pledge** — an award — is a **gift whose gift_type is
 *   "Pledge"**. LGL's stock gift categories include "Grant" under exactly that
 *   type, so this is the intended modelling, not a workaround.
 * - Payments against an award are separate gifts linked by `parent_gift_id`.
 * - **No amount-due or balance field exists on any documented object.** The
 *   strings `amount_due` and `balance` do not appear in the API docs at all.
 *
 * That last point decides the shape of this file. Received and Outstanding are
 * both defined in terms of amount due, and the spec is explicit that it must be
 * read from LGL rather than recomputed by summing payment gifts, because LGL
 * maintains the real figure and recomputing invites drift. With no field to
 * read, the honest output is no number and a stated reason — the same rule
 * that suppresses total cash when one account fails to read.
 *
 * ## Scoping
 *
 * LGL holds every appeal ask and every pledge, the overwhelming majority of
 * which are individual donor activity. `LGL_GRANT_CAMPAIGN_IDS` and
 * `LGL_GRANT_GIFT_CATEGORY_IDS` narrow the reads to grant activity. Both unset
 * is a valid prototype state, but it makes the figures an "everything funnel"
 * rather than a grant funnel, so the snapshot flags itself as unscoped and the
 * UI says so.
 */

import { LGL_FIXTURE_RETRIEVED_AT, lglFixture } from "./lgl-fixtures";
import type {
  Env,
  FunnelStage,
  GrantSnapshot,
  ReimbursableBucket,
  ReimbursableStatus,
} from "./types";

const BASE_URL = "https://api.littlegreenlight.com/api/v1";

/** LGL defaults to 25 per page. Larger pages mean fewer round trips. */
const PAGE_SIZE = 100;

/**
 * Refuse to page forever. Hitting this cap makes a figure *incomplete*, which
 * is treated as unavailable rather than reported as a total — a sum missing
 * its last pages understates the funnel exactly the way a dropped account
 * would understate cash.
 */
const MAX_PAGES = 20;

export const SOURCE_LABEL = "Little Green Light";

/**
 * The prototype caveat. LGL is a partial picture: some grants are still
 * tracked manually and have not been entered, and reimbursable status is not
 * populated. Removed at go-live once the development committee confirms
 * reconciliation.
 */
export const COMPLETENESS_NOTE =
  "These figures reflect what is currently recorded in Little Green Light, not HPIC's " +
  "complete grant history. Some grants are still tracked on the manual spreadsheet and " +
  "have not been entered yet. Record counts appear beside every total so a missing grant " +
  "shows up as a count discrepancy rather than a quietly low number.";

/** Custom field name/key that carries cost-reimbursement status. */
const REIMBURSABLE_KEYS = ["reimbursable", "is_reimbursable", "cost_reimbursement"];

// --- LGL response shapes (only the fields this dashboard reads) ---

interface LglCustomFieldValue {
  name?: string | null;
  short_code?: string | null;
}

interface LglCustomField {
  name?: string | null;
  key?: string | null;
  values?: LglCustomFieldValue[] | null;
}

interface LglCustomAttr {
  name?: string | null;
  key?: string | null;
  value?: string | null;
}

export interface LglGift {
  id: number;
  gift_type_id?: number | null;
  gift_type_name?: string | null;
  gift_category_id?: number | null;
  gift_category_name?: string | null;
  campaign_id?: number | null;
  campaign_name?: string | null;
  fund_id?: number | null;
  fund_name?: string | null;
  /**
   * The documented amount field. Some list endpoints echo it as `amount`
   * instead, so both are read and the documented one wins.
   */
  received_amount?: number | null;
  amount?: number | null;
  received_date?: string | null;
  parent_gift_id?: number | null;
  custom_fields?: LglCustomField[] | null;
}

export interface LglAppeal {
  id: number;
  name?: string | null;
  campaign_id?: number | null;
  campaign_name?: string | null;
}

export interface LglAppealRequest {
  id: number;
  appeal_id?: number | null;
  name?: string | null;
  ask_amount?: number | null;
  raised?: number | null;
  status?: string | null;
  custom_fields?: LglCustomField[] | null;
  custom_attrs?: LglCustomAttr[] | null;
}

interface LglGiftType {
  id: number;
  name?: string | null;
}

interface LglPage<T> {
  items?: T[] | null;
  items_count?: number;
  total_items?: number;
}

/**
 * A completed read. `complete` is false when paging stopped at MAX_PAGES,
 * which makes any sum over `items` an undercount.
 */
type ReadResult<T> =
  | { ok: true; items: T[]; complete: boolean; date: string | null }
  | { ok: false; detail: string };

// --- HTTP ---

/**
 * The single network call in this file. Fixture mode intercepts here, so every
 * layer above runs identically against recorded data and against LGL.
 */
async function getPage<T>(
  env: Env,
  path: string,
  params: URLSearchParams,
): Promise<{ ok: true; page: LglPage<T>; date: string | null } | { ok: false; detail: string }> {
  if (isFixtureMode(env)) {
    const items = lglFixture(path, params);
    if (!items) {
      return { ok: false, detail: `No fixture recorded for ${path}.` };
    }
    // Fixtures are small enough to return whole; paging is exercised live.
    return {
      ok: true,
      page: { items: items as T[], items_count: items.length, total_items: items.length },
      date: LGL_FIXTURE_RETRIEVED_AT,
    };
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/${path}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${env.LGL_API_KEY}`,
      },
    });
  } catch (error) {
    return { ok: false, detail: `Could not reach Little Green Light: ${String(error)}` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      detail:
        "Little Green Light rejected the API key. Check LGL_API_KEY and that the key is " +
        "still active in LGL's integration settings.",
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `Little Green Light returned ${response.status}.` };
  }

  try {
    return {
      ok: true,
      page: (await response.json()) as LglPage<T>,
      // LGL puts no timestamp in the response body, so its `Date` header is
      // the closest thing to the source's own clock. Never our clock.
      date: response.headers.get("date"),
    };
  } catch (error) {
    return { ok: false, detail: `Unreadable response from Little Green Light: ${String(error)}` };
  }
}

/** Page through a list endpoint until it runs out or MAX_PAGES is reached. */
async function getAll<T>(
  env: Env,
  path: string,
  extraParams: Array<[string, string]> = [],
): Promise<ReadResult<T>> {
  const items: T[] = [];
  let date: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    for (const [key, value] of extraParams) params.append(key, value);

    const result = await getPage<T>(env, path, params);
    if (!result.ok) return result;

    date ??= result.date;
    const batch = result.page.items ?? [];
    items.push(...batch);

    const total = result.page.total_items;
    const done =
      batch.length < PAGE_SIZE || (typeof total === "number" && items.length >= total);
    if (done) return { ok: true, items, complete: true, date };
  }

  return { ok: true, items, complete: false, date };
}

function isFixtureMode(env: Env): boolean {
  // Defaults to fixture: an unset mode must never start calling a live API.
  return (env.LGL_MODE ?? "fixture") !== "live";
}

// --- Configuration ---

function parseIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
}

// --- Reading the reimbursable custom field ---

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Map a stored value onto a reimbursable status.
 *
 * Anything unrecognized is "unknown" rather than a guess. Treating an
 * unparseable value as not-reimbursable would quietly move an award into the
 * spendable column, which is the failure this dashboard exists to prevent.
 */
function toReimbursableStatus(raw: string | null | undefined): ReimbursableStatus {
  const value = normalizeKey(raw);
  if (["yes", "y", "true", "1", "reimbursable", "cost_reimbursement"].includes(value)) {
    return "reimbursable";
  }
  if (["no", "n", "false", "0", "not_reimbursable"].includes(value)) {
    return "not_reimbursable";
  }
  return "unknown";
}

/**
 * Read reimbursable status off an LGL record.
 *
 * Returns "unknown" when the field is absent, which is the state every record
 * is in today — HPIC has not defined or populated the custom field yet. The
 * path is built now so that populating the field later lights the feature up
 * with no code change.
 */
export function readReimbursable(record: {
  custom_fields?: LglCustomField[] | null;
  custom_attrs?: LglCustomAttr[] | null;
}): ReimbursableStatus {
  for (const field of record.custom_fields ?? []) {
    const matches =
      REIMBURSABLE_KEYS.includes(normalizeKey(field.key)) ||
      REIMBURSABLE_KEYS.includes(normalizeKey(field.name));
    if (!matches) continue;
    const first = field.values?.[0];
    if (!first) return "unknown";
    return toReimbursableStatus(first.name ?? first.short_code);
  }

  for (const attr of record.custom_attrs ?? []) {
    const matches =
      REIMBURSABLE_KEYS.includes(normalizeKey(attr.key)) ||
      REIMBURSABLE_KEYS.includes(normalizeKey(attr.name));
    if (matches) return toReimbursableStatus(attr.value);
  }

  return "unknown";
}

/** The amount LGL recorded for a gift, preferring the documented field name. */
function giftAmount(gift: LglGift): number {
  const amount = gift.received_amount ?? gift.amount;
  return typeof amount === "number" ? amount : 0;
}

// --- Reads ---

/**
 * Resolve the numeric ID of the "Pledge" gift type.
 *
 * Resolved by name at runtime rather than hardcoded: the IDs look stable
 * across accounts, but a wrong ID here would silently return zero awards,
 * which is indistinguishable from HPIC having no grants.
 */
async function pledgeGiftTypeId(env: Env): Promise<{ ok: true; id: number } | { ok: false; detail: string }> {
  const result = await getAll<LglGiftType>(env, "gift_types");
  if (!result.ok) return result;

  const pledge = result.items.find((type) => normalizeKey(type.name) === "pledge");
  if (!pledge) {
    return {
      ok: false,
      detail:
        "Little Green Light did not report a 'Pledge' gift type, so awards cannot be " +
        "identified. Check the gift types configured in LGL.",
    };
  }
  return { ok: true, id: pledge.id };
}

/** Grant applications: every appeal_request under the in-scope appeals. */
async function readApplications(env: Env): Promise<ReadResult<LglAppealRequest>> {
  const campaignIds = parseIds(env.LGL_GRANT_CAMPAIGN_IDS);

  const appeals = await getAll<LglAppeal>(env, "appeals");
  if (!appeals.ok) return appeals;

  // The appeals endpoint documents no campaign filter, so scope is applied here.
  const inScope =
    campaignIds.length === 0
      ? appeals.items
      : appeals.items.filter(
          (appeal) => appeal.campaign_id != null && campaignIds.includes(appeal.campaign_id),
        );

  const requests: LglAppealRequest[] = [];
  let complete = appeals.complete;
  let date = appeals.date;

  for (const appeal of inScope) {
    const result = await getAll<LglAppealRequest>(env, `appeals/${appeal.id}/appeal_requests`);
    if (!result.ok) return result;
    requests.push(...result.items);
    complete &&= result.complete;
    date ??= result.date;
  }

  return { ok: true, items: requests, complete, date };
}

/** Awards: gifts whose gift type is "Pledge", narrowed to grant activity. */
async function readAwards(env: Env): Promise<ReadResult<LglGift>> {
  const giftType = await pledgeGiftTypeId(env);
  if (!giftType.ok) return giftType;

  const terms = [`gift_types=in|${giftType.id}`];

  const campaignIds = parseIds(env.LGL_GRANT_CAMPAIGN_IDS);
  if (campaignIds.length > 0) terms.push(`campaigns=in|${campaignIds.join(",")}`);

  const categoryIds = parseIds(env.LGL_GRANT_GIFT_CATEGORY_IDS);
  if (categoryIds.length > 0) terms.push(`categories=in|${categoryIds.join(",")}`);

  // LGL combines multiple search terms with a semicolon.
  return getAll<LglGift>(env, "gifts/search", [["q[]", terms.join(";")]]);
}

// --- Funnel assembly ---

function unavailableStage(
  key: FunnelStage["key"],
  label: string,
  note: string,
): FunnelStage {
  return { key, label, status: "unavailable", amount: null, recordCount: null, note };
}

/**
 * The note carried by Received and Outstanding.
 *
 * Kept as one string in one place because it is the single most important
 * caveat in Phase 2: these are not slow or missing numbers, they are numbers
 * the system of record does not expose.
 */
export const AMOUNT_DUE_NOTE =
  "Not shown. This figure is defined as the pledge amount due, and Little Green Light's " +
  "REST API exposes no amount-due or balance field on any object. Deriving it by summing " +
  "payment gifts is possible but rejected by the spec: LGL maintains the real figure " +
  "internally, and recomputing it here would drift from the system of record.";

const UNSCOPED_NOTE =
  "Not scoped to grants — no grant campaign or gift category is configured, so this counts " +
  "all Little Green Light activity, including individual donor asks and pledges.";

/**
 * Split awards by reimbursable status.
 *
 * Deliberately returns three separate buckets and no combined figure. A
 * cost-reimbursement award requires HPIC to spend first and invoice afterwards,
 * so it does not reduce the working capital needed to begin a construction
 * phase. Summing it with unrestricted awards into one "available" number would
 * materially overstate readiness to the board.
 */
function splitByReimbursable(awards: LglGift[]): ReimbursableBucket[] {
  const labels: Record<ReimbursableStatus, string> = {
    reimbursable: "Reimbursable",
    not_reimbursable: "Not reimbursable",
    unknown: "Reimbursable status unknown",
  };
  const order: ReimbursableStatus[] = ["reimbursable", "not_reimbursable", "unknown"];

  return order.map((status) => {
    const matching = awards.filter((award) => readReimbursable(award) === status);
    return {
      status,
      label: labels[status],
      amount: matching.reduce((sum, award) => sum + giftAmount(award), 0),
      recordCount: matching.length,
    };
  });
}

/** Assemble the Phase 2 grant funnel snapshot. */
export async function getGrants(env: Env): Promise<GrantSnapshot> {
  const fixture = isFixtureMode(env);
  const unscoped =
    parseIds(env.LGL_GRANT_CAMPAIGN_IDS).length === 0 &&
    parseIds(env.LGL_GRANT_GIFT_CATEGORY_IDS).length === 0;

  if (!fixture && !env.LGL_API_KEY) {
    return {
      stages: [
        unavailableStage("applied", "Applied", "No Little Green Light API key configured."),
        unavailableStage("pledged", "Pledged", "No Little Green Light API key configured."),
        unavailableStage("received", "Received", AMOUNT_DUE_NOTE),
        unavailableStage("outstanding", "Outstanding", AMOUNT_DUE_NOTE),
      ],
      awardsByReimbursable: [],
      unscoped,
      retrievedAt: null,
      cached: false,
      source: SOURCE_LABEL,
      connection: "not_configured",
      completenessNote: COMPLETENESS_NOTE,
    };
  }

  // Read both halves independently so one failing source still renders the
  // other, rather than blanking the whole panel.
  const [applications, awards] = await Promise.all([readApplications(env), readAwards(env)]);

  const stages: FunnelStage[] = [
    toStage("applied", "Applied", applications, (request) =>
      typeof request.ask_amount === "number" ? request.ask_amount : 0,
    ),
    toStage("pledged", "Pledged", awards, giftAmount),
    // Both of these depend on a field LGL does not expose. See AMOUNT_DUE_NOTE.
    unavailableStage("received", "Received", AMOUNT_DUE_NOTE),
    unavailableStage("outstanding", "Outstanding", AMOUNT_DUE_NOTE),
  ];

  if (unscoped) {
    for (const stage of stages) {
      if (stage.status !== "ok") continue;
      stage.note = stage.note ? `${stage.note} ${UNSCOPED_NOTE}` : UNSCOPED_NOTE;
    }
  }

  const anyOk = stages.some((stage) => stage.status === "ok");
  const retrievedAt =
    (applications.ok ? applications.date : null) ?? (awards.ok ? awards.date : null);

  return {
    stages,
    awardsByReimbursable: awards.ok ? splitByReimbursable(awards.items) : [],
    unscoped,
    retrievedAt,
    cached: false,
    source: fixture ? `${SOURCE_LABEL} (fixture data)` : SOURCE_LABEL,
    // Never report "ok" when nothing could be read.
    connection: fixture ? "fixture" : anyOk ? "ok" : "unavailable",
    completenessNote: COMPLETENESS_NOTE,
  };
}

/**
 * Turn one read into a funnel stage.
 *
 * An incomplete read produces "unavailable", not a partial sum. The same rule
 * governs total cash in Phase 1: a total quietly missing records is worse than
 * no total, because nothing on screen says it is wrong.
 */
function toStage<T>(
  key: FunnelStage["key"],
  label: string,
  result: ReadResult<T>,
  amountOf: (item: T) => number,
): FunnelStage {
  if (!result.ok) {
    return unavailableStage(key, label, result.detail);
  }
  if (!result.complete) {
    return unavailableStage(
      key,
      label,
      `More Little Green Light records than this dashboard reads in one pass ` +
        `(${MAX_PAGES * PAGE_SIZE}). A partial total would understate the figure, so it is not shown.`,
    );
  }

  return {
    key,
    label,
    status: "ok",
    amount: result.items.reduce((sum, item) => sum + amountOf(item), 0),
    recordCount: result.items.length,
  };
}
