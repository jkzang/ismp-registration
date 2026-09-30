import { createContext, useContext } from 'react'
import type { AppConfig, CurrentUser, Sheet } from './types'

export type AppState = {
  config: AppConfig
  user: CurrentUser
  sheets: Sheet[] | null
  refreshSheets: () => Promise<void>
}

export const AppContext = createContext<AppState | null>(null)

export function useApp() {
  const state = useContext(AppContext)
  if (!state) throw new Error('useApp needs AppContext')
  return state
}
