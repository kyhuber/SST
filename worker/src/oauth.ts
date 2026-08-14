/**
 * One-time OAuth seeding.
 *
 * A board member never touches this. It runs once, when the Worker is first
 * deployed, to hand the TokenStore its initial token pair. After that the
 * dashboard refreshes tokens on its own and this flow is only needed if the
 * connection sits unused for 100 days or someone disconnects the app in
 * QuickBooks.
 *
 * https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 */

import { checkPassphrase } from "./auth";
import type { Env, IntuitTokenResponse } from "./types";
import type { TokenStore } from "./tokens";

const AUTHORIZE_ENDPOINT = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}` +
      `code{background:#f1f1f1;padding:.1em .35em;border-radius:3px}</style>` +
      `<h1>${title}</h1>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * GET /oauth/start?k=<passphrase>
 *
 * The passphrase rides in the query string here rather than a header because
 * this endpoint is opened directly in a browser. It is the same shared secret
 * the dashboard uses.
 */
export async function handleStart(
  request: Request,
  env: Env,
  store: DurableObjectStub<TokenStore>,
): Promise<Response> {
  const url = new URL(request.url);

  if (!checkPassphrase(url.searchParams.get("k"), env)) {
    return page("Not authorized", "<p>Wrong or missing passphrase.</p>", 401);
  }

  const state = await store.beginAuth();
  const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
  authorizeUrl.searchParams.set("client_id", env.QBO_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", ACCOUNTING_SCOPE);
  authorizeUrl.searchParams.set("redirect_uri", env.QBO_REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);

  return Response.redirect(authorizeUrl.toString(), 302);
}

/**
 * GET /oauth/callback?code=&state=&realmId=
 *
 * Intuit redirects here after consent. The `state` value proves the flow
 * started at /oauth/start rather than somewhere else.
 */
export async function handleCallback(
  request: Request,
  env: Env,
  store: DurableObjectStub<TokenStore>,
): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return page("Authorization cancelled", `<p>QuickBooks returned <code>${error}</code>.</p>`, 400);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const realmId = url.searchParams.get("realmId");

  if (!code || !state) {
    return page("Incomplete response", "<p>QuickBooks did not send a code and state.</p>", 400);
  }
  if (!(await store.consumeAuthState(state))) {
    return page(
      "State mismatch",
      "<p>This authorization did not start at <code>/oauth/start</code>, or it expired. Start again.</p>",
      400,
    );
  }

  const credentials = btoa(`${env.QBO_CLIENT_ID}:${env.QBO_CLIENT_SECRET}`);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.QBO_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    // invalid_grant here almost always means the redirect URI registered with
    // Intuit does not exactly match QBO_REDIRECT_URI.
    return page(
      "Token exchange failed",
      `<p>QuickBooks returned ${response.status}.</p><pre>${detail.slice(0, 500)}</pre>` +
        `<p>Check that the redirect URI registered on the Intuit app exactly matches ` +
        `<code>${env.QBO_REDIRECT_URI}</code>, including scheme, casing, and trailing slash.</p>`,
      502,
    );
  }

  const tokens = (await response.json()) as IntuitTokenResponse;
  await store.seed(tokens);

  const realmNote =
    realmId && realmId !== env.QBO_REALM_ID
      ? `<p><strong>Set <code>QBO_REALM_ID</code> to <code>${realmId}</code></strong> ` +
        `and redeploy — it does not match the currently configured value.</p>`
      : `<p>Company ID (realm): <code>${realmId ?? "not returned"}</code></p>`;

  return page(
    "QuickBooks connected",
    `<p>Tokens stored. The dashboard will keep them refreshed on its own.</p>${realmNote}` +
      `<p>You can close this window.</p>`,
  );
}
