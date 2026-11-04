import { createContext, useContext } from 'react'

export interface AuthStatus { configured: boolean; authenticated: boolean; login?: string }
export const AuthContext = createContext<{ auth: AuthStatus; login: () => void; logout: () => Promise<void> } | null>(null)

export function invalidateAuth() {
  window.dispatchEvent(new Event('codeflow:unauthorized'))
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is required')
  return value
}