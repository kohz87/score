import type { ThemeSummary } from '@score/contract'
import { LookSettingsSchema } from '@score/contract'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { readStoredTheme, THEME_CHANGED, type ThemeChoice } from '../data/theme.ts'
import { useOptionalStream } from '../data/query-client.ts'
import { builtinSummaries, saveSharedLook, themeListQuery, themesKey } from './queries.ts'
import { clearDeviceLook, lookStore, useLookState, writeDeviceOverride } from './look-store.ts'
import { useLayout, type LayoutConfig } from './layout.ts'

export type Look = {
  themes: ThemeSummary[]
  /** The theme every device uses unless it chose its own. */
  sharedId: string
  sharedMode: ThemeChoice
  /** This device's own theme, or null while it follows the shared one. */
  deviceId: string | null
  /** What is applied now: null in safe mode. */
  effectiveId: string | null
  /** The colour mode this device uses: its own choice, or the shared one. */
  mode: ThemeChoice
  safe: boolean
  failure: string | null
  /** What the applied theme asks of the components (menu, Now cards, chat); Score's default when none is applied. */
  layout: LayoutConfig
  /** True until the shared theme is known (the list is still loading and this device has no choice of its own). */
  loading: boolean
  /** False while the theme list could not be read (older server): only the built-in themes are offered. */
  fromServer: boolean
  chooseForDevice: (id: string | null) => void
  saveShared: (settings: { activeTheme: string; mode: ThemeChoice }) => Promise<void>
  resetDevice: () => void
}

/**
 * Shared theme and mode from the server (contract §16), this device's override from localStorage, and the escape
 * hatches' state. Re-reads on window focus and when another device announces `look.changed`.
 */
export function useLook(): Look {
  const queryClient = useQueryClient()
  const stream = useOptionalStream()
  const list = useQuery(themeListQuery)
  const state = useLookState()
  const [, rerender] = useState(0)
  useEffect(() => {
    const onMode = () => rerender((n) => n + 1)
    window.addEventListener(THEME_CHANGED, onMode)
    return () => window.removeEventListener(THEME_CHANGED, onMode)
  }, [])

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: themesKey })
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [queryClient])

  useEffect(() => {
    if (!stream) return
    const apply = (data: unknown) => {
      const parsed = LookSettingsSchema.safeParse(data)
      if (!parsed.success) return
      queryClient.setQueryData(themesKey, (old: unknown) =>
        old && typeof old === 'object'
          ? { ...old, active: parsed.data.activeTheme, mode: parsed.data.mode }
          : old,
      )
      void queryClient.invalidateQueries({ queryKey: themesKey })
    }
    const offLook = stream.onLookChanged?.(apply)
    const offEvents = stream.subscribe((event) => {
      if ((event as { type: string }).type === 'look.changed') apply(event.data)
    })
    return () => {
      offLook?.()
      offEvents()
    }
  }, [stream, queryClient])

  const themes = list.data?.items.length ? list.data.items : builtinSummaries
  const sharedId = list.data?.active ?? 'score'
  const sharedMode = list.data?.mode ?? 'system'
  // A device override naming a theme the server no longer has is ignored (once the list is known).
  const deviceId =
    state.device && (!list.data || themes.some((item) => item.id === state.device))
      ? state.device
      : null
  const stored = readStoredTheme()
  const layout = useLayout()

  const saveShared = useCallback(
    async (settings: { activeTheme: string; mode: ThemeChoice }) => {
      await saveSharedLook(settings)
      queryClient.setQueryData(themesKey, (old: unknown) =>
        old && typeof old === 'object'
          ? { ...old, active: settings.activeTheme, mode: settings.mode }
          : old,
      )
      await queryClient.invalidateQueries({ queryKey: themesKey })
    },
    [queryClient],
  )

  return {
    themes,
    sharedId,
    sharedMode,
    deviceId,
    effectiveId: state.safe ? null : (deviceId ?? sharedId),
    mode: stored ?? sharedMode,
    safe: state.safe,
    failure: state.failure,
    layout,
    loading: list.isPending && deviceId === null,
    fromServer: !!list.data,
    chooseForDevice: (id) => {
      writeDeviceOverride(id)
      lookStore.setFailure(null)
    },
    saveShared,
    resetDevice: () => {
      clearDeviceLook()
      lookStore.setFailure(null)
    },
  }
}
