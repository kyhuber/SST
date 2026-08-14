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
import { FALLBACK_ENDPOINTS, fetchDiscovery, type OAuthEndpoints } from "./endpoints";
import type {
  AccessTokenResult,
  Env,
  FundsSnapshot,
  IntuitTokenResponse,
} from "./types";

/** How long a fetched discovery document is trusted before re-reading it. */
const ENDPOINT_TTL_MS = 24 * 60 * 60_000;

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

/**
 * A record of what the token machinery last did.
 *
 * Without this, a connection that dies overnight leaves no trace: the next
 * person sees only "needs reconnecting" with no way to tell whether a refresh
 * failed, Intuit revoked the grant, or nobody loaded the page for 100 days.
 * For a tool maintained by volunteers, the difference matters.
 */
interface TokenEvent {
  at: number;
  kind: "seeded" | "refreshed" | "refresh_failed" | "revoked" | "discovery_fallback";
  detail?: string;
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

  /**
   * OAuth endpoints, read from Intuit's discovery document and cached.
   *
   * Precedence on a failed read: a stale cached document beats the compiled-in
   * fallback, because it came from Intuit at some point; the fallback is only
   * for a cold start during an outage.
   */
  async getEndpoints(): Promise<OAuthEndpoints> {
    const cached = await this.ctx.storage.get<{ endpoints: OAuthEndpoints; at: number }>(
      "endpoints",
    );
    if (cached && Date.now() - cached.at < ENDPOINT_TTL_MS) {
      return cached.endpoints;
    }

    const fresh = await fetchDiscovery(this.env);
    if (fresh) {
      await this.ctx.storage.put("endpoints", { endpoints: fresh, at: Date.now() });
      return fresh;
    }

    if (cached) return cached.endpoints;

    await this.record(
      "discovery_fallback",
      "Discovery document unavailable and nothing cached; using compiled-in endpoints.",
    );
    return FALLBACK_ENDPOINTS;
  }

  /** Append to the rolling event log. Keeps the most recent 20 entries. */
  private async record(kind: TokenEvent["kind"], detail?: string): Promise<void> {
    const log = (await this.ctx.storage.get<TokenEvent[]>("events")) ?? [];
    log.push({ at: Date.now(), kind, detail });
    await this.ctx.storage.put("events", log.slice(-20));
  }

  /** Store the token pair from an authorization-code exchange. */
  async seed(tokens: IntuitTokenResponse): Promise<void> {
    await this.persist(tokens);
    await this.ctx.storage.delete("needs_reauth");
    await this.ctx.storage.delete("snapshot");
    await this.record("seeded");
  }

  /**
   * Note that the hourly keep-alive ran.
   *
   * Deliberately kept out of the event log: an hourly entry would push the
   * seeds, refreshes, and failures worth reading off the end within a day.
   */
  async recordScheduledRun(connection: string): Promise<void> {
    await this.ctx.storage.put("last_scheduled", { at: Date.now(), connection });
  }

  /** The event log, for diagnosing a connection that died unattended. */
  async events(): Promise<Array<{ at: string; kind: string; detail?: string }>> {
    const log = (await this.ctx.storage.get<TokenEvent[]>("events")) ?? [];
    return log.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, detail: e.detail }));
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
      response = await fetch((await this.getEndpoints()).token, {
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
        await this.record(
          "refresh_failed",
          `invalid_grant (HTTP ${response.status}) — the refresh token was rejected. ` +
            `Either it expired, the grant was revoked in QuickBooks, or a stale value was used.`,
        );
        await this.ctx.storage.put("needs_reauth", true);
        await this.ctx.storage.delete("tokens");
        return { ok: false, reason: "needs_reauth", detail: "invalid_grant" };
      }
      await this.record("refresh_failed", `HTTP ${response.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        reason: "not_seeded",
        detail: `Token refresh failed (${response.status})`,
      };
    }

    const tokens = JSON.parse(body) as IntuitTokenResponse;
    await this.persist(tokens);
    await this.record(
      "refreshed",
      `new access token valid ${tokens.expires_in}s; refresh token ${
        tokens.refresh_token === refreshToken ? "unchanged" : "rotated"
      }`,
    );
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

  /**
   * Revoke the connection at Intuit and forget it locally.
   *
   * Local state is cleared whether or not Intuit confirms. The user asked to
   * disconnect; continuing to hold a token we may no longer be entitled to use
   * would be the wrong reading of that instruction. The return value reports
   * whether Intuit acknowledged, so a failure is visible rather than silent.
   */
  async revoke(): Promise<{ revokedAtIntuit: boolean; detail: string }> {
    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");

    const forgetLocally = async () => {
      await this.ctx.storage.delete("tokens");
      await this.ctx.storage.delete("snapshot");
      await this.ctx.storage.put("needs_reauth", true);
    };

    if (!tokens) {
      await forgetLocally();
      return { revokedAtIntuit: false, detail: "There was no active connection to revoke." };
    }

    const credentials = btoa(`${this.env.QBO_CLIENT_ID}:${this.env.QBO_CLIENT_SECRET}`);
    let detail: string;
    let revoked = false;

    try {
      const response = await fetch((await this.getEndpoints()).revocation, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${credentials}`,
        },
        // Revoking the refresh token invalidates the whole grant.
        body: JSON.stringify({ token: tokens.refreshToken }),
      });
      revoked = response.ok;
      detail = response.ok
        ? "QuickBooks confirmed the connection was revoked."
        : `Intuit returned ${response.status}. The connection was cleared locally regardless.`;
    } catch (error) {
      detail = `Could not reach Intuit (${String(error)}). The connection was cleared locally regardless.`;
    }

    await forgetLocally();
    await this.record("revoked", detail);
    return { revokedAtIntuit: revoked, detail };
  }

  /** Connection state, for the health endpoint and the reconnect message. */
  async status(): Promise<{
    seeded: boolean;
    needsReauth: boolean;
    lastRefreshAt: string | null;
    accessTokenExpiresAt: string | null;
    lastScheduledRun: { at: string; connection: string } | null;
  }> {
    const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
    const needsReauth = (await this.ctx.storage.get<boolean>("needs_reauth")) ?? false;
    const scheduled = await this.ctx.storage.get<{ at: number; connection: string }>(
      "last_scheduled",
    );
    return {
      seeded: Boolean(tokens),
      needsReauth,
      lastRefreshAt: tokens ? new Date(tokens.lastRefreshAt).toISOString() : null,
      accessTokenExpiresAt: tokens
        ? new Date(tokens.accessTokenExpiresAt).toISOString()
        : null,
      lastScheduledRun: scheduled
        ? { at: new Date(scheduled.at).toISOString(), connection: scheduled.connection }
        : null,
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
