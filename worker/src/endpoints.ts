/**
 * OAuth endpoint resolution via Intuit's discovery documents.
 *
 * Intuit publishes the authorization, token, and revocation endpoints as JSON
 * at a well-known location, and their platform requirements ask apps to read
 * them from there rather than hardcoding. Doing so means an endpoint move on
 * Intuit's side doesn't require a code change here — which matters for a tool
 * that has to keep running unattended between board meetings.
 *
 * The fallback below exists so that a discovery outage cannot take the
 * dashboard down. Reading discovery is the recommended practice; depending on
 * it as a single point of failure is not.
 */

import type { Env } from "./types";

export interface OAuthEndpoints {
  authorization: string;
  token: string;
  revocation: string;
}

const DISCOVERY_URLS = {
  sandbox: "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
  production: "https://developer.api.intuit.com/.well-known/openid_configuration",
} as const;

/**
 * Last-resort values, used only when the discovery document cannot be read and
 * nothing is cached. Verified against both discovery documents on 2026-08-14;
 * sandbox and production agree on all three.
 */
export const FALLBACK_ENDPOINTS: OAuthEndpoints = {
  authorization: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revocation: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
};

/** Read the discovery document for the configured environment. Null on any failure. */
export async function fetchDiscovery(env: Env): Promise<OAuthEndpoints | null> {
  const url = DISCOVERY_URLS[env.QBO_ENV === "production" ? "production" : "sandbox"];

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;

    const doc = (await response.json()) as Record<string, unknown>;
    const authorization = doc.authorization_endpoint;
    const token = doc.token_endpoint;
    const revocation = doc.revocation_endpoint;

    // A partial document is worse than none: silently falling back for one
    // endpoint while trusting the document for others would be hard to debug.
    if (
      typeof authorization !== "string" ||
      typeof token !== "string" ||
      typeof revocation !== "string"
    ) {
      return null;
    }

    return { authorization, token, revocation };
  } catch {
    return null;
  }
}
