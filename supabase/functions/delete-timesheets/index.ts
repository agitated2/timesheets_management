// IT-only: bulk-deletes timesheets (and their storage file, when no
// sibling timesheet still references it) with an optional notification
// to the affected employee. Ported from
// netlify/functions/delete-timesheets.js — logic unchanged.

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

    const { data: caller } = await supabaseAdmin.from('profiles').select('roles').eq('id', user.id).single()
    if (!caller?.roles?.includes('it')) return json(403, { error: 'IT admin only' })

    const aal2Rejection = requireAal2(token)
    if (aal2Rejection) return aal2Rejection

    const { timesheetIds, userId, notify } = await req.json()
    if (!Array.isArray(timesheetIds) || timesheetIds.length === 0) {
      return json(400, { error: 'No timesheets specified' })
    }

    // Fetch the timesheets to get their file paths and dates
    const { data: timesheets, error: fetchErr } = await supabaseAdmin
      .from('timesheets')
      .select('id, file_path, date')
      .in('id', timesheetIds)

    if (fetchErr) throw new Error(fetchErr.message)
    if (!timesheets?.length) return json(404, { error: 'Timesheets not found' })

    // Only delete a storage file if no OTHER timesheets (outside this delete set) share it.
    // Weekly uploads store all days under one file, so deleting one day must not orphan siblings.
    const uniquePaths = [...new Set(timesheets.map((t) => t.file_path).filter(Boolean))]
    for (const filePath of uniquePaths) {
      const { count } = await supabaseAdmin
        .from('timesheets')
        .select('id', { count: 'exact', head: true })
        .eq('file_path', filePath)
        .not('id', 'in', `(${timesheetIds.join(',')})`)

      if (count === 0) {
        await supabaseAdmin.storage.from('timesheet-files').remove([filePath])
      }
    }

    // Delete from DB (cascades to timesheet_entries and notifications)
    const { error: deleteErr } = await supabaseAdmin
      .from('timesheets')
      .delete()
      .in('id', timesheetIds)

    if (deleteErr) throw new Error(deleteErr.message)

    // Optional: notify the employee that their timesheets were removed
    if (notify && userId) {
      const dates = timesheets
        .map((t) => new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
        .join(', ')

      const message = timesheets.length === 1
        ? `Your timesheet for ${dates} has been removed by IT.`
        : `${timesheets.length} timesheets (${dates}) have been removed by IT.`

      await supabaseAdmin.from('notifications').insert({
        user_id: userId,
        type: 'rejection',
        message,
      })
    }

    return json(200, { deleted: timesheets.length })
  } catch (err) {
    console.error('delete-timesheets error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return json(500, { error: message })
  }
})
