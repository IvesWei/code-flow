import { createContext, useContext } from 'react'

export const NavigationContext = createContext<(path: string) => void>(() => { throw new Error('SPA navigation provider is required') })

export function useNavigation() {
  return useContext(NavigationContext)
}