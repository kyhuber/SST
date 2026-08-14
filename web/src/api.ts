/**
 * The only place this app talks to the network.
 *
 * The frontend never holds credentials or account identifiers. It sends the
 * shared passphrase and receives labels and amounts — nothing that identifies
 * a QuickBooks company or account.
 */

import type { FundsSnapshot, GrantSnapshot } from "./types";

const WORKER_URL: string = import.meta.env.VITE_WORKER_URL ?? "http://127.0.0.1:8787";

/** Thrown when the passphrase is wrong or missing, so the gate can reappear. */
export class NotAuthorizedError extends Error {}

async function get<T>(path: string, passphrase: string): Promise<T> {
  const response = await fetch(`${WORKER_URL}${path}`, {
    headers: { "X-HPIC-Auth": passphrase },
  });

  if (response.status === 401) {
    throw new NotAuthorizedError("Passphrase not accepted.");
  }
  if (!response.ok) {
    throw new Error(`The server returned ${response.status}.`);
  }

  return (await response.json()) as T;
}

export function fetchFunds(passphrase: string): Promise<FundsSnapshot> {
  return get<FundsSnapshot>("/api/funds", passphrase);
}

export function fetchGrants(passphrase: string): Promise<GrantSnapshot> {
  return get<GrantSnapshot>("/api/grants", passphrase);
}
