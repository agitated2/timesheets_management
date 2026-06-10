const { createClient } = require('@supabase/supabase-js')

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    // Verify caller is an IT admin
    const token = (event.headers.authorization || '').replace('Bearer ', '')
    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !caller) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('roles').eq('id', caller.id).single()
    if (!callerProfile?.roles?.includes('it')) return { statusCode: 403, headers, body: JSON.stringify({ error: 'IT role required' }) }

    const { userId } = JSON.parse(event.body || '{}')
    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId is required' }) }
    if (userId === caller.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'You cannot delete your own account' }) }

    // Deleting from auth.users cascades to profiles → timesheets → entries → notifications via FK ON DELETE CASCADE
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userId)
    if (delErr) return { statusCode: 400, headers, body: JSON.stringify({ error: delErr.message }) }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) }
  } catch (err) {
    console.error('delete-user error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
