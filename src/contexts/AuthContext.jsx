import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = useCallback(async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    setProfile(data ?? null)
  }, [])

  // Lazy, self-scoped leave-cycle refresh: fires once per sign-in so an
  // employee's rollover/reset happens on login even without pg_cron.
  // Idempotent server-side (skipped if this cycle was already granted) and
  // fire-and-forget — a failure here must never block auth.
  const triggerLeaveCycle = useCallback((userId) => {
    supabase.rpc('run_leave_cycle', { p_employee: userId }).catch(() => {})
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        fetchProfile(session.user.id).finally(() => setLoading(false))
        triggerLeaveCycle(session.user.id)
      } else {
        setLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) {
        fetchProfile(session.user.id)
        if (_event === 'SIGNED_IN') triggerLeaveCycle(session.user.id)
      } else {
        setProfile(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [fetchProfile, triggerLeaveCycle])

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const refreshProfile = useCallback(() => {
    if (user) return fetchProfile(user.id)
  }, [user, fetchProfile])

  // Returns true if the current user has the given role.
  // Checks the roles[] array first; falls back to the single role column
  // for profiles that pre-date the multi-role migration.
  const hasRole = useCallback((r) => {
    if (!profile) return false
    if (Array.isArray(profile.roles) && profile.roles.length > 0) {
      return profile.roles.includes(r)
    }
    return profile.role === r
  }, [profile])

  return (
    <AuthContext.Provider value={{ user, profile, loading, signOut, refreshProfile, hasRole }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
