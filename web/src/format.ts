/**
 * Shared formatting. Both panels show money and a retrieval time, and those
 * two things have to look and behave the same on a screen the board reads
 * together.
 */

export const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Formats the timestamp the source system reported for the data itself.
 *
 * This is never the current clock. A dashboard that always shows today's date
 * regardless of data freshness is worse than showing no date at all.
 *
 * QuickBooks supplies an ISO timestamp in its response body; Little Green
 * Light has none, so its HTTP `Date` header stands in. Both parse here.
 */
export function formatRetrievedAt(value: string | null): string {
  if (!value) return "No data retrieved";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Retrieval time unavailable";
  // Explicit component options rather than dateStyle/timeStyle: Intl rejects
  // combining those shorthands with timeZoneName, and the zone matters here.
  return date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

/** "3 records" / "1 record" — always shown beside a total, never on its own. */
export function recordCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "record" : "records"} in LGL`;
}
