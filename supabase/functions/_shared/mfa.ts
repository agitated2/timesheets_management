// Shared by every IT-gated Edge Function: reads the `aal` (Authenticator
// Assurance Level) claim out of the caller's access token.
//
// This does NOT verify the token's signature — it doesn't need to. Every
// call site already ran `supabaseAdmin.auth.getUser(token)` successfully
// before reaching this, which proves the token is genuinely
// Supabase-signed and unexpired. Reading a claim out of a token already
// known to be valid is safe; this is just cheaper than asking the auth
// server to re-parse it for one field.
import { json } from './cors.ts'

// JWTs are base64URL (RFC 7519), not plain base64 — '-'/'_' instead of
// '+'/'/', no padding. Deno's atob() only understands plain base64, so
// decoding a JWT segment with it directly silently mangles or rejects any
// payload containing those characters, which is data-dependent (not every
// token would happen to hit it, making this the kind of bug that passes
// testing and then fails intermittently in production).
function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return atob(padded)
}

export function getAal(token: string): string {
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1]))
    return payload.aal || 'aal1'
  } catch {
    return 'aal1'
  }
}

// Auth hardening (AUTH_HARDENING_PLAN.md Phase 2, decision: "no grace for
// IT actions"): every function calling this can create/edit/delete a user
// or destroy timesheets, so aal2 is required unconditionally — unlike
// normal app use, an IT admin's own 7-day MFA grace period does NOT
// extend to these calls. Returns a ready-to-return 403 Response, or null
// if the caller is cleared to proceed.
export function requireAal2(token: string): Response | null {
  if (getAal(token) === 'aal2') return null
  return json(403, {
    error: 'Two-factor verification is required for this action. Sign in with your authenticator app, then try again.',
  })
}
