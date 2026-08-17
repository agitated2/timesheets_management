// IT-only: creates a new employee account. Ported from
// netlify/functions/create-user.js — logic unchanged, only the
// request/response plumbing differs (Deno.serve/Response instead of the
// Lambda-style {statusCode, headers, body} object Netlify Functions use).
//
// Called from the browser via supabase-js's functions.invoke(), which
// attaches the caller's own session Authorization header automatically.

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
    // Verify caller is an IT admin
    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '')
    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !caller) return json(401, { error: 'Unauthorized' })

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('roles, role').eq('id', caller.id).single()
    const callerIsIT = callerProfile?.roles?.includes('it') || callerProfile?.role === 'it'
    if (!callerIsIT) return json(403, { error: 'IT role required' })

    const aal2Rejection = requireAal2(token)
    if (aal2Rejection) return aal2Rejection

    const { email, password, fullName, roles, officeId } = await req.json()

    if (!email?.trim()) return json(400, { error: 'Email is required' })
    if (!password || password.length < 6) return json(400, { error: 'Password must be at least 6 characters' })
    if (!officeId) return json(400, { error: 'Office is required' })

    // Create auth user — email_confirm: true skips verification email.
    // office_id rides in on user_metadata: the profiles.office_id column is
    // NOT NULL, and the handle_new_user() trigger reads it from here so the
    // profile row is created with an office atomically — there is no safe
    // window to backfill it afterwards.
    const { data, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
      user_metadata: { office_id: officeId },
    })
    if (createErr) return json(400, { error: createErr.message })

    // The DB trigger creates the profile row automatically (incl. office_id).
    // Update name and/or role if provided.
    const profileUpdates: Record<string, unknown> = {}
    if (fullName?.trim()) profileUpdates.full_name = fullName.trim()
    if (Array.isArray(roles) && roles.length > 0) profileUpdates.roles = roles

    if (Object.keys(profileUpdates).length > 0) {
      await supabaseAdmin.from('profiles').update(profileUpdates).eq('id', data.user.id)
    }

    return json(200, { user: data.user })
  } catch (err) {
    console.error('create-user error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
