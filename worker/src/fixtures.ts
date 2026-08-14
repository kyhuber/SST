/**
 * Recorded QuickBooks response shapes, used when QBO_MODE=fixture.
 *
 * These exist so the whole dashboard — Worker, frontend, degradation paths —
 * can be built and reviewed before an Intuit developer app and sandbox company
 * exist, and so the UI stays testable afterwards without burning API calls.
 *
 * Shapes are copied from Intuit's published Account samples. The rebuild fund
 * deliberately carries a CurrentBalanceWithSubAccounts that differs from
 * CurrentBalance, so the sub-account notice renders in development.
 */

import type { AccountReadResult } from "./qbo";
import type { AccountSnapshot } from "./types";

/** A stable, obviously-fake retrieval timestamp. */
const FIXTURE_TIME = "2026-08-12T09:14:03.412-07:00";

export function fixtureAccount(key: AccountSnapshot["key"]): AccountReadResult {
  if (key === "operating") {
    return {
      ok: true,
      time: FIXTURE_TIME,
      account: {
        Id: "35",
        Name: "Operating Checking",
        FullyQualifiedName: "Operating Checking",
        Classification: "Asset",
        AccountType: "Bank",
        AccountSubType: "Checking",
        CurrentBalance: 84213.55,
        CurrentBalanceWithSubAccounts: 84213.55,
        MetaData: { LastUpdatedTime: "2026-08-11T16:02:44-07:00" },
      },
    };
  }

  return {
    ok: true,
    time: FIXTURE_TIME,
    account: {
      Id: "36",
      Name: "Rebuild Fund",
      FullyQualifiedName: "Rebuild Fund",
      Classification: "Asset",
      AccountType: "Bank",
      AccountSubType: "Savings",
      CurrentBalance: 512000.0,
      CurrentBalanceWithSubAccounts: 512480.19,
      MetaData: { LastUpdatedTime: "2026-08-11T16:02:44-07:00" },
    },
  };
}

export const FIXTURE_RETRIEVED_AT = FIXTURE_TIME;
