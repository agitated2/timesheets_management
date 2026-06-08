import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { KeyRound } from 'lucide-react'

export default function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    let subscription

    async function handle() {
      // First try: session may already be ready (implicit flow tokens in hash)
      const { data: { session }, error: sessionErr } = await supabase.auth.getSession()

      if (sessionErr) { setError(sessionErr.message); return }

      if (session) {
        navigate('/', { replace: true })
        return
      }

      // Second try: wait for onAuthStateChange (PKCE code exchange is still in flight)
      const { data } = supabase.auth.onAuthStateChange((event, sess) => {
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && sess) {
          navigate('/', { replace: true })
        }
        if (event === 'SIGNED_IN' && !sess) {
          setError('Sign-in failed. Please try again.')
        }
      })
      subscription = data.subscription

      // Fallback: if nothing resolves in 10 s, show error
      setTimeout(() => {
        setError(e => e || 'Sign-in timed out. Please try again.')
      }, 10000)
    }

    handle()

    return () => subscription?.unsubscribe()
  }, [navigate])

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-950 dark:to-gray-900 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-5 shadow-lg">
          <KeyRound size={26} className="text-white" />
        </div>

        {error ? (
          <div className="space-y-4">
            <p className="text-red-600 dark:text-red-400 text-sm max-w-xs">{error}</p>
            <button
              onClick={() => navigate('/auth', { replace: true })}
              className="btn-secondary"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-sm text-gray-500 dark:text-gray-400">Signing you in…</p>
          </div>
        )}
      </div>
    </div>
  )
}
