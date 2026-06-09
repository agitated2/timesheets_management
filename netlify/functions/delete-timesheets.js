const { createClient } = require('@supabase/supabase-js')

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  }

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    const token = (event.headers.authorization || event.headers.Authorization || '').slice(7)
    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) }

    const { data: caller } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (caller?.role !== 'it') return { statusCode: 403, headers, body: JSON.stringify({ error: 'IT admin only' }) }

    const { timesheetIds, userId, notify } = JSON.parse(event.body)
    if (!Array.isArray(timesheetIds) || timesheetIds.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No timesheets specified' }) }
    }

    // Fetch the timesheets to get their file paths and dates
    const { data: timesheets, error: fetchErr } = await supabaseAdmin
      .from('timesheets')
      .select('id, file_path, date')
      .in('id', timesheetIds)

    if (fetchErr) throw new Error(fetchErr.message)
    if (!timesheets?.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Timesheets not found' }) }

    // Only delete a storage file if no OTHER timesheets (outside this delete set) share it.
    // Weekly uploads store all days under one file, so deleting one day must not orphan siblings.
    const uniquePaths = [...new Set(timesheets.map(t => t.file_path).filter(Boolean))]
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
        .map(t => new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
        .join(', ')

      const message = timesheets.length === 1
        ? `Your timesheet for ${dates} has been removed by IT.`
        : `${timesheets.length} timesheets (${dates}) have been removed by IT.`

      await supabaseAdmin.from('notifications').insert({
        user_id:  userId,
        type:     'rejection',
        message,
      })
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ deleted: timesheets.length }),
    }
  } catch (err) {
    console.error('delete-timesheets error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
