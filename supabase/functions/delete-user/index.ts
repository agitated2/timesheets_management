// IT-only: permanently deletes a user (cascades to profiles → timesheets
// → entries → notifications via FK ON DELETE CASCADE). Ported from
// netlify/functions/delete-user.js — logic unchanged.

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
      .from('profiles').select('roles').eq('id', caller.id).single()
    if (!callerProfile?.roles?.includes('it')) return json(403, { error: 'IT role required' })

    const aal2Rejection = requireAal2(token)
    if (aal2Rejection) return aal2Rejection

    const { userId } = await req.json()
    if (!userId) return json(400, { error: 'userId is required' })
    if (userId === caller.id) return json(400, { error: 'You cannot delete your own account' })

    // Deleting from auth.users cascades to profiles → timesheets → entries → notifications via FK ON DELETE CASCADE
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (delErr) return json(400, { error: delErr.message })

    return json(200, { success: true })
  } catch (err) {
    console.error('delete-user error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
