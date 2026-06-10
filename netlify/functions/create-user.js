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

    const { email, password, fullName, roles } = JSON.parse(event.body || '{}')

    if (!email?.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) }
    if (!password || password.length < 6) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) }

    // Create auth user — email_confirm: true skips verification email
    const { data, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true,
    })
    if (createErr) return { statusCode: 400, headers, body: JSON.stringify({ error: createErr.message }) }

    // The DB trigger creates the profile row automatically.
    // Update name and/or role if provided.
    const profileUpdates = {}
    if (fullName?.trim()) profileUpdates.full_name = fullName.trim()
    if (Array.isArray(roles) && roles.length > 0) profileUpdates.roles = roles

    if (Object.keys(profileUpdates).length > 0) {
      await supabaseAdmin.from('profiles').update(profileUpdates).eq('id', data.user.id)
    }

    return { statusCode: 200, headers, body: JSON.stringify({ user: data.user }) }
  } catch (err) {
    console.error('create-user error:', err)
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
  }
}
