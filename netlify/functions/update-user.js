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

    const { data: caller } = await supabaseAdmin.from('profiles').select('roles').eq('id', user.id).single()
    if (!caller?.roles?.includes('it')) return { statusCode: 403, headers, body: JSON.stringify({ error: 'IT admin only' }) }

    const { userId, email, fullName, managerId, roles, newPassword } = JSON.parse(event.body)
    if (!userId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'userId required' }) }

    // ── Auth-level updates (email / password) ──────────────────
    const authUpdate = {}
    if (email)       authUpdate.email    = email.trim().toLowerCase()
    if (newPassword) authUpdate.password = newPassword

    if (Object.keys(authUpdate).length > 0) {
      const { error: auErr } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdate)
      if (auErr) throw new Error(`Auth update failed: ${auErr.message}`)
    }

    // ── Profile-level updates ──────────────────────────────────
    const profileUpdate = {}
    if (email !== undefined)     profileUpdate.email      = email.trim().toLowerCase()
    if (fullName !== undefined)  profileUpdate.full_name  = fullName.trim() || null
    if (managerId !== undefined) profileUpdate.manager_id = managerId || null
    if (roles !== undefined)     profileUpdate.roles      = roles

    if (Object.keys(profileUpdate).length > 0) {
      const { error: prErr } = await supabaseAdmin
        .from('profiles')
        .update(profileUpdate)
        .eq('id', userId)
      if (prErr) throw new Error(`Profile update failed: ${prErr.message}`)
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    }
  } catch (err) {
    console.error('update-user error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
