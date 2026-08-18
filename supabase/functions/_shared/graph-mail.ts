// Shared Microsoft Graph mail sender for any Edge Function that needs to
// send email from the company M365 tenant (no SMTP vendor, no extra cost —
// client-credentials auth against Entra + Graph's sendMail).
//
// Deno port of netlify/lib/graph-mail.js (now retired) — logic is
// unchanged, only the module/env-var syntax differs. `fetch` is native in
// both Node and Deno, so the actual HTTP calls didn't need to change.

const GRAPH_TENANT_ID     = Deno.env.get('GRAPH_TENANT_ID')
const GRAPH_CLIENT_ID     = Deno.env.get('GRAPH_CLIENT_ID')
const GRAPH_CLIENT_SECRET = Deno.env.get('GRAPH_CLIENT_SECRET')
const GRAPH_SENDER_UPN    = Deno.env.get('GRAPH_SENDER_UPN')

// Module-scope cache — a cold start pays for one token fetch, every warm
// invocation after that reuses it until ~60s before expiry. Without this,
// every single email would cost two round-trips instead of one.
let cachedToken: { accessToken: string; expiresAt: number } | null = null

function assertConfigured() {
  const missing = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_SENDER_UPN']
    .filter(name => !Deno.env.get(name))
  if (missing.length) {
    throw new Error(`Graph mail is not configured — missing env var(s): ${missing.join(', ')}`)
  }
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.accessToken
  }

  assertConfigured()
  const url = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id:     GRAPH_CLIENT_ID!,
    client_secret: GRAPH_CLIENT_SECRET!,
    scope:         'https://graph.microsoft.com/.default',
    grant_type:    'client_credentials',
  })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Graph token request failed (${res.status}): ${detail}`)
  }
  const data = await res.json()
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  }
  return cachedToken.accessToken
}

export interface SendMailArgs {
  to: string | string[]
  subject: string
  html?: string
  text?: string
}

const MAX_SEND_ATTEMPTS = 4

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// sendMail({ to, subject, html, text }) — `to` is a single address or an
// array of addresses. Throws on failure; callers decide how to record that
// (e.g. the reminder job marks its own log row 'failed' rather than
// letting one bad address blow up the whole run).
//
// Retries 429 (throttled) and 503 (transient service unavailability) —
// Exchange Online enforces a per-mailbox concurrency ceiling that's easy to
// bump into even at CONCURRENCY=4 under a cold start, and without a retry
// here that single 429 used to permanently suppress that recipient's
// reminder for the rest of the business day (see reminder_log's
// idempotency guarantee in migration_v13). Honors Retry-After when Graph
// sends one; otherwise backs off exponentially.
export async function sendMail({ to, subject, html, text }: SendMailArgs): Promise<void> {
  assertConfigured()
  const recipients = (Array.isArray(to) ? to : [to]).map(address => ({
    emailAddress: { address },
  }))

  const message = {
    subject,
    body: { contentType: html ? 'HTML' : 'Text', content: html || text || '' },
    toRecipients: recipients,
  }

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const token = await getAccessToken()
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(GRAPH_SENDER_UPN!)}/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      // true (was false) so the shared mailbox's Sent Items gives a real,
      // independently-checkable trail of what actually went out — the
      // fastest way to confirm delivery while this feature is still new.
      body: JSON.stringify({ message, saveToSentItems: true }),
    })

    if (res.ok) return

    const retryable = res.status === 429 || res.status === 503
    if (!retryable || attempt === MAX_SEND_ATTEMPTS) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Graph sendMail failed (${res.status}): ${detail}`)
    }

    const retryAfterHeader = Number(res.headers.get('Retry-After'))
    const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : 500 * 2 ** (attempt - 1)
    await sleep(delayMs)
  }
}
