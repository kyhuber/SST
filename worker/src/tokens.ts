/**
 * TokenStore — sole custodian of the QuickBooks OAuth tokens.
 *
 * Why a Durable Object rather than environment variables or KV:
 *
 * Intuit rotates the refresh_token value roughly every 24 hours, and the
 * previous value expires the moment a new one is issued. Worker environment
 * variables are immutable at runtime, so they cannot hold a value that must be
 * rewritten daily. Intuit also documents that two concurrent refreshes with the
 * same token succeed once and return invalid_grant the second time, which can
 * revoke the connection outright.
 *
 * A Durable Object gives us exactly one writer. Every request for an access
 * token funnels through this single instance, so a refresh happens once and
 * everyone else waits for it. Recovering from a revoked connection means a
 * human re-doing OAuth consent, which is precisely what a volunteer-run
 * organization should never have to do on a schedule.
 *
 * See:
 * https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AccessTokenResult,
  Env,
  FundsSnapshot,
  IntuitTokenResponse,
} from "./types";

const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

/** Refresh this far before actual expiry so a call never races the deadline. */
const EXPIRY_SKEW_MS = 120_000;

/** How long a pending OAuth `state` value stays valid. */
const AUTH_STATE_TTL_MS = 10 * 60_000;

interface StoredTokens {
  accessToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  refreshToken: string;
  /** Epoch milliseconds of the last successful refresh. */
  lastRefreshAt: number;
}

interface PendingAuth {
  state: string;
  createdAt: number;
}

interface CachedSnapshot {
  snapshot: FundsSnapshot;
  cachedAt: number;
}

export class TokenStore extends DurableObject<Env> {
  /**
   * Set while a refresh is in progress. The Durable Object serializes
   * incoming calls, but they can still interleave at `await` points, so
   * callers that arrive mid-refresh join this promise instead of starting
   * a second one.
   */
  private refreshInFlight: Promise<AccessTokenResult> | null = null;

  /** Store the token pair from an authorization-code exchange. */
  async seed(tokens: IntuitTokenResponse): Promise<void> {
    await this.persist(tokens);
    await this.ctx.storage.delete("needs_reauth");
    await this.ctx.storage.delete("snapshot");
  }

  /**
   * Returns a usable access token, refreshing first if the current one is
   * expired or close to it.
   *
   * @param force Refresh even if the cached token still looks valid. Used
   *   when QuickBooks rejects a token we believed was good.
   */
  async getAccessToken(force = false): Promise<AccessTokenResult> {
    if (await this.ctx.storage.get<boolean>("needs_reauth")) {
      return { ok: false, reason: "needs_reauth" };
    }

    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
    if (!tokens) {
      return { ok: false, reason: "not_seeded" };
    }

    const stillGood = tokens.accessTokenExpiresAt - Date.now() > EXPIRY_SKEW_MS;
    if (stillGood && !force) {
      return { ok: true, accessToken: tokens.accessToken };
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refresh(tokens.refreshToken).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** Exchange the refresh token for a new token pair and persist both. */
  private async refresh(refreshToken: string): Promise<AccessTokenResult> {
    const credentials = btoa(`${this.env.QBO_CLIENT_ID}:${this.env.QBO_CLIENT_SECRET}`);

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
    } catch (error) {
      // Network failure is transient. Do not touch stored tokens.
      return {
        ok: false,
        reason: "not_seeded",
        detail: `Could not reach Intuit: ${String(error)}`,
      };
    }

    const body = await response.text();

    if (!response.ok) {
      // invalid_grant means the refresh token is dead. Nothing we do here can
      // recover it — someone has to re-authorize — so record that plainly
      // instead of retrying into a wall.
      if (body.includes("invalid_grant")) {
        await this.ctx.storage.put("needs_reauth", true);
        await this.ctx.storage.delete("tokens");
        return { ok: false, reason: "needs_reauth", detail: "invalid_grant" };
      }
      return {
        ok: false,
        reason: "not_seeded",
        detail: `Token refresh failed (${response.status})`,
      };
    }

    const tokens = JSON.parse(body) as IntuitTokenResponse;
    await this.persist(tokens);
    return { ok: true, accessToken: tokens.access_token };
  }

  /**
   * Persist both values from the response. Intuit's documentation is explicit
   * that the refresh_token in the response supersedes the one we sent, so
   * storing only the access token would break the connection within a day.
   */
  private async persist(tokens: IntuitTokenResponse): Promise<void> {
    const stored: StoredTokens = {
      accessToken: tokens.access_token,
      accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token,
      lastRefreshAt: Date.now(),
    };
    await this.ctx.storage.put("tokens", stored);
  }

  /** Connection state, for the health endpoint and the reconnect message. */
  async status(): Promise<{
    seeded: boolean;
    needsReauth: boolean;
    lastRefreshAt: string | null;
  }> {
    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
    const needsReauth = (await this.ctx.storage.get<boolean>("needs_reauth")) ?? false;
    return {
      seeded: Boolean(tokens),
      needsReauth,
      lastRefreshAt: tokens ? new Date(tokens.lastRefreshAt).toISOString() : null,
    };
  }

  // --- OAuth state (CSRF protection for the one-time seeding flow) ---

  /** Generate and remember a `state` value for an authorization request. */
  async beginAuth(): Promise<string> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const pending: PendingAuth = { state, createdAt: Date.now() };
    await this.ctx.storage.put("pending_auth", pending);
    return state;
  }

  /** Validate and consume a `state` value returned by Intuit. Single use. */
  async consumeAuthState(state: string): Promise<boolean> {
    const pending = await this.ctx.storage.get<PendingAuth>("pending_auth");
    await this.ctx.storage.delete("pending_auth");
    if (!pending) return false;
    if (Date.now() - pending.createdAt > AUTH_STATE_TTL_MS) return false;
    return pending.state === state;
  }

  // --- Snapshot cache ---
  //
  // The spec calls for no manual refresh step: data loads on page load or a
  // defined cache interval. Caching here rather than in KV keeps the whole
  // stateful surface in one place.

  async getCachedSnapshot(maxAgeMs: number): Promise<CachedSnapshot | null> {
    const cached = await this.ctx.storage.get<CachedSnapshot>("snapshot");
    if (!cached) return null;
    if (Date.now() - cached.cachedAt > maxAgeMs) return null;
    return cached;
  }

  async putCachedSnapshot(snapshot: FundsSnapshot): Promise<void> {
    const entry: CachedSnapshot = { snapshot, cachedAt: Date.now() };
    await this.ctx.storage.put("snapshot", entry);
  }
}
