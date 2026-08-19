/**
 * Recorded Little Green Light response shapes, used when LGL_MODE=fixture.
 *
 * These are raw API payloads rather than pre-assembled snapshots, and fixture
 * mode intercepts at the HTTP boundary in `lgl.ts`. Everything above that —
 * pagination, gift-type resolution, custom-field reading, funnel assembly —
 * runs identically against fixtures and against LGL. A fixture that skipped
 * the parsing would test nothing that matters.
 *
 * Shapes are copied from the published API documentation at
 * https://api.littlegreenlight.com/api-docs/static.html (read 2026-08-14).
 *
 * The three awards deliberately cover all three reimbursable states —
 * populated yes, populated no, and field absent — because the field is not
 * populated in HPIC's LGL yet and the "unknown" path is the one most likely to
 * regress unnoticed.
 */

/**
 * A stable, obviously-fake retrieval time, in the format of an HTTP `Date`
 * header — which is where the real value comes from, LGL having no timestamp
 * in its response bodies.
 */
export const LGL_FIXTURE_RETRIEVED_AT = "Wed, 12 Aug 2026 16:14:03 GMT";

/** Gift type IDs are resolved by name at runtime; these mirror a real account. */
const GIFT_TYPES = [
  { id: 1, name: "Gift", ordinal: 1 },
  { id: 5, name: "Other Income", ordinal: 3 },
  { id: 7, name: "Pledge", ordinal: 4 },
  { id: 8, name: "In Kind", ordinal: 2 },
  { id: 9, name: "Soft Credit", ordinal: 6 },
  { id: 13, name: "Installment", ordinal: 7 },
];

const CAMPAIGNS = [
  { id: 901, name: "Clubhouse Rebuild", description: "Post-fire reconstruction", is_active: true },
  { id: 902, name: "Annual Giving", description: null, is_active: true },
];

/**
 * Awards. In LGL these are gifts whose gift_type is "Pledge"; the stock gift
 * category "Grant" (under that type) is what distinguishes a grant award from
 * an individual's multi-year pledge.
 */
const PLEDGE_GIFTS = [
  {
    id: 991001,
    constituent_id: 1200401,
    external_id: null,
    is_anon: false,
    gift_type_id: 7,
    gift_type_name: "Pledge",
    gift_category_id: 6101,
    gift_category_name: "Grant",
    campaign_id: 901,
    campaign_name: "Clubhouse Rebuild",
    fund_id: 3201,
    fund_name: "Rebuild — Restricted",
    appeal_id: 3301,
    appeal_name: "Rebuild Grants 2026",
    event_id: null,
    event_name: null,
    received_amount: 750000.0,
    received_date: "2026-05-02",
    deductible_amount: 0.0,
    note: "Cost-reimbursement; contract not yet signed.",
    parent_gift_id: null,
    custom_fields: [
      {
        id: 7701,
        item_type: "Gift",
        name: "Reimbursable",
        key: "reimbursable",
        facet_type: "single_select",
        ordinal: 1,
        removable: true,
        editable: true,
        values: [{ category_id: 7701, name: "Yes", short_code: "yes", ordinal: 1 }],
      },
    ],
    created_at: "2026-05-02T15:44:09Z",
    updated_at: "2026-05-02T15:44:09Z",
  },
  {
    id: 991002,
    constituent_id: 1200402,
    external_id: null,
    is_anon: false,
    gift_type_id: 7,
    gift_type_name: "Pledge",
    gift_category_id: 6101,
    gift_category_name: "Grant",
    campaign_id: 901,
    campaign_name: "Clubhouse Rebuild",
    fund_id: 3201,
    fund_name: "Rebuild — Restricted",
    appeal_id: 3301,
    appeal_name: "Rebuild Grants 2026",
    event_id: null,
    event_name: null,
    received_amount: 150000.0,
    received_date: "2026-04-18",
    deductible_amount: 0.0,
    note: null,
    parent_gift_id: null,
    custom_fields: [
      {
        id: 7701,
        item_type: "Gift",
        name: "Reimbursable",
        key: "reimbursable",
        facet_type: "single_select",
        ordinal: 1,
        removable: true,
        editable: true,
        values: [{ category_id: 7702, name: "No", short_code: "no", ordinal: 2 }],
      },
    ],
    created_at: "2026-04-18T22:03:31Z",
    updated_at: "2026-04-18T22:03:31Z",
  },
  {
    // No reimbursable custom field at all — the state HPIC's records are
    // actually in today. This must render as "unknown", never as spendable.
    id: 991003,
    constituent_id: 1200404,
    external_id: null,
    is_anon: false,
    gift_type_id: 7,
    gift_type_name: "Pledge",
    gift_category_id: 6101,
    gift_category_name: "Grant",
    campaign_id: 901,
    campaign_name: "Clubhouse Rebuild",
    fund_id: 3201,
    fund_name: "Rebuild — Restricted",
    appeal_id: 3301,
    appeal_name: "Rebuild Grants 2026",
    event_id: null,
    event_name: null,
    received_amount: 60000.0,
    received_date: "2026-06-09",
    deductible_amount: 0.0,
    note: null,
    parent_gift_id: null,
    custom_fields: [],
    created_at: "2026-06-09T18:20:44Z",
    updated_at: "2026-06-09T18:20:44Z",
  },
  {
    // An individual's multi-year pledge under a different campaign. Excluded
    // once a grant scope is configured.
    id: 991050,
    constituent_id: 1200501,
    external_id: null,
    is_anon: false,
    gift_type_id: 7,
    gift_type_name: "Pledge",
    gift_category_id: 6100,
    gift_category_name: "Standard Pledge",
    campaign_id: 902,
    campaign_name: "Annual Giving",
    fund_id: 3202,
    fund_name: "Unrestricted",
    appeal_id: 3302,
    appeal_name: "Spring Member Appeal",
    event_id: null,
    event_name: null,
    received_amount: 5000.0,
    received_date: "2026-03-22",
    deductible_amount: 5000.0,
    note: null,
    parent_gift_id: null,
    custom_fields: [],
    created_at: "2026-03-22T10:00:00Z",
    updated_at: "2026-03-22T10:00:00Z",
  },
];

/** Everything fixture mode can answer, keyed by API path. */
const RESPONSES: Record<string, unknown[]> = {
  gift_types: GIFT_TYPES,
  campaigns: CAMPAIGNS,
  "gifts/search": PLEDGE_GIFTS,
};

/**
 * Answer a request from recorded data, or null if this path has no fixture —
 * which surfaces as an ordinary read failure rather than an empty success, so
 * a path added without a fixture cannot silently report zero grants.
 */
export function lglFixture(path: string, params: URLSearchParams): unknown[] | null {
  const items = RESPONSES[path];
  if (!items) return null;

  // Apply the gift search filters the real endpoint would apply server-side,
  // so scoping is exercised here rather than only in production.
  if (path === "gifts/search") {
    return (items as Array<Record<string, unknown>>).filter((gift) =>
      matchesGiftQuery(gift, params.getAll("q[]")),
    );
  }

  return items;
}

/** Minimal stand-in for LGL's `q[]` filters — only the ones this client sends. */
function matchesGiftQuery(gift: Record<string, unknown>, terms: string[]): boolean {
  for (const combined of terms) {
    for (const term of combined.split(";")) {
      const [field, expression] = term.split("=");
      if (!field || !expression) continue;
      const [operator, values] = expression.split("|");
      if (operator !== "in" || !values) continue;

      const wanted = values.split(",");
      const actual =
        field === "gift_types"
          ? gift.gift_type_id
          : field === "campaigns"
            ? gift.campaign_id
            : field === "categories"
              ? gift.gift_category_id
              : undefined;

      if (actual === undefined) continue;
      if (!wanted.includes(String(actual))) return false;
    }
  }
  return true;
}
