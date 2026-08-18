// IT-only: edits an employee's profile/auth fields, checks or removes
// their MFA status. Ported from netlify/functions/update-user.js — logic
// unchanged, only the request/response plumbing differs.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { json, corsPreflight } from '../_shared/cors.ts'
import { requireAal2 } from '../_shared/mfa.ts'

Deno.serve(async (req: Request) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'Server misconfigured: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from the function environment.' })
  }
  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !user) return json(401, { error: 'Invalid token' })

    const { data: caller } = await supabaseAdmin.from('profiles').select('roles, role').eq('id', user.id).single()
    if (!(caller?.roles?.includes('it') || caller?.role === 'it')) return json(403, { error: 'IT admin only' })

    const { userId, email, fullName, managerIds, roles, newPassword, checkMfaStatus, removeMfa } = await req.json()
    if (!userId) return json(400, { error: 'userId required' })

    // ── MFA status check — read-only, dedicated call from the edit-user
    // modal on open. Returned early rather than folded into the "Save
    // changes" flow below, since it isn't a change and has nothing to do
    // with the other profile/auth fields.
    if (checkMfaStatus) {
      const { data, error: mfaErr } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId })
      if (mfaErr) throw new Error(`MFA status check failed: ${mfaErr.message}`)
      const factors = data?.factors || []
      return json(200, { mfaEnrolled: factors.some((f) => f.status === 'verified'), factorCount: factors.length })
    }

    // Everything past this point mutates something (profile, auth user,
    // or another user's MFA factors) — aal2 required unconditionally, with
    // no grace-period exemption for IT (see AUTH_HARDENING_PLAN.md Phase
    // 2). checkMfaStatus above is deliberately exempt: it's read-only.
    const aal2Rejection = requireAal2(token)
    if (aal2Rejection) return aal2Rejection

    // ── Remove MFA (auth hardening: only IT can do this — see
    // AUTH_HARDENING_PLAN.md D2). Deletes every factor (there should only
    // ever be one, but don't leave a stray behind) and resets the grace
    // period rather than leaving it expired — someone who lost a device
    // and had IT clear it should get a fresh window to re-enrol, not be
    // dropped straight into "mandatory, right now".
    if (removeMfa) {
      const { data, error: listErr } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId })
      if (listErr) throw new Error(`MFA lookup failed: ${listErr.message}`)
      for (const factor of data?.factors || []) {
        const { error: delErr } = await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: factor.id, userId })
        if (delErr) throw new Error(`MFA factor removal failed: ${delErr.message}`)
      }
      const { error: resetErr } = await supabaseAdmin
        .from('profiles')
        .update({ mfa_grace_started_at: null })
        .eq('id', userId)
      if (resetErr) throw new Error(`Grace period reset failed: ${resetErr.message}`)
      return json(200, { success: true })
    }

    // ── Auth-level updates (email / password) ──────────────────
    const authUpdate: Record<string, string> = {}
    if (email) authUpdate.email = email.trim().toLowerCase()
    if (newPassword) authUpdate.password = newPassword

    if (Object.keys(authUpdate).length > 0) {
      const { error: auErr } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdate)
      if (auErr) throw new Error(`Auth update failed: ${auErr.message}`)
    }

    // ── Profile-level updates ──────────────────────────────────
    const profileUpdate: Record<string, unknown> = {}
    if (email !== undefined) profileUpdate.email = email.trim().toLowerCase()
    if (fullName !== undefined) profileUpdate.full_name = fullName.trim() || null
    if (managerIds !== undefined) profileUpdate.manager_ids = Array.isArray(managerIds) ? managerIds : []
    if (roles !== undefined) profileUpdate.roles = roles

    if (Object.keys(profileUpdate).length > 0) {
      const { error: prErr } = await supabaseAdmin
        .from('profiles')
        .update(profileUpdate)
        .eq('id', userId)
      if (prErr) throw new Error(`Profile update failed: ${prErr.message}`)
    }

    return json(200, { success: true })
  } catch (err) {
    console.error('update-user error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
