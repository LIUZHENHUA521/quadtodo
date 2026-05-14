import { create } from 'zustand'
import { getConfig } from '../api'

interface AppConfigState {
  defaultPermissionMode: string | null
  loaded: boolean
  load: () => Promise<void>
  setDefaultPermissionMode: (mode: string | null) => void
}

export const useAppConfigStore = create<AppConfigState>((set) => ({
  defaultPermissionMode: null,
  loaded: false,
  load: async () => {
    try {
      const { config } = await getConfig()
      set({ defaultPermissionMode: config.defaultPermissionMode || null, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
  setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
}))
