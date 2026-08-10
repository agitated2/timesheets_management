const { createClient } = require('@supabase/supabase-js')

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL
    const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set on this deploy. Add them in Netlify → Site settings → Environment variables and redeploy.' }) }
    }
    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Verify caller is an IT admin
    const token = (event.headers.authorization || '').replace('Bearer ', '')
    const { data: { user: caller }, error: authErr } = await supabaseAdmin.auth.getUser(token)
    if (authErr || !caller) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) }

    const { data: callerProfile } = await supabaseAdmin
      .from('profiles').select('roles, role').eq('id', caller.id).single()
    const callerIsIT = callerProfile?.roles?.includes('it') || callerProfile?.role === 'it'
    if (!callerIsIT) return { statusCode: 403, headers, body: JSON.stringify({ error: 'IT role required' }) }

    const { email, password, fullName, roles, officeId } = JSON.parse(event.body || '{}')

    if (!email?.trim()) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) }
    if (!password || password.length < 6) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 6 characters' }) }
    if (!officeId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Office is required' }) }

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
    if (createErr) return { statusCode: 400, headers, body: JSON.stringify({ error: createErr.message }) }

    // The DB trigger creates the profile row automatically (incl. office_id).
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
