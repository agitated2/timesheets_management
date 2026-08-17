// Shared by every Edge Function invoked directly from the browser (i.e.
// everything except daily-timesheet-reminders, which is called only by
// cron/curl and needs no CORS handling at all).
//
// supabase-js's functions.invoke() always sends a CORS preflight OPTIONS
// request first — Authorization isn't a CORS-safelisted header — and
// without an explicit OPTIONS handler + these headers on every response,
// the preflight fails and the browser never sends the real request at
// all. supabase-js reports that as the unhelpful "Failed to send a
// request to the Edge Function", with no server-side log to explain it
// since the request never arrived.
//
// Origin is locked to the deployed frontend once APP_URL is set (auth
// hardening Phase 4) — falls back to '*' only when APP_URL is unset,
// e.g. before a production domain exists. This is defence-in-depth, not
// the real guard: every function using this still verifies the caller's
// JWT and role independently of where the request came from.
const APP_ORIGIN = (Deno.env.get('APP_URL') || '*').replace(/\/$/, '')

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': APP_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export const jsonHeaders = { 'Content-Type': 'application/json', ...CORS_HEADERS }

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

// Call first, before any other request handling. Returns the preflight
// response to return immediately, or null if this isn't a preflight.
export function corsPreflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS_HEADERS }) : null
}
