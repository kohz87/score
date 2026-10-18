import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DataRouter } from 'react-router'
import { applyTheme } from '../data/theme.ts'
import { applyBuiltin, applyCustom, clearLook, isBuiltinTheme, type ColorMode } from './engine.ts'
import { watchProtectedSurfaces } from './guard.ts'
import {
  clearDeviceLook,
  lookStore,
  readCachedLayout,
  writeDeviceOverride,
  writeLookCache,
} from './look-store.ts'
import { DEFAULT_LAYOUT, layoutFromCache, setLayout, viewOfPath, type LookView } from './layout.ts'
import { themeDetailQuery } from './queries.ts'
import { useLook } from './use-look.ts'
import { packs } from '../styles/packs.ts'
import './look.css'

// The layout of the last applied theme, before the first render: the menu and the Now cards start where they were.
try {
  setLayout(layoutFromCache(readCachedLayout(viewOfPath(window.location.pathname))))
} catch {
  // No window (tests of other modules): the Score default.
}

/** Which front end this page is (the user view lives at /u), following the router. */
function useView(router?: DataRouter): LookView {
  const path = useSyncExternalStore(
    (notify) => router?.subscribe(notify) ?? (() => undefined),
    () => router?.state.location.pathname ?? window.location.pathname,
    () => '/',
  )
  return viewOfPath(path)
}

function systemMode(): ColorMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function useResolvedMode(choice: 'light' | 'dark' | 'system'): ColorMode {
  const [system, setSystem] = useState<ColorMode>(systemMode)
  useEffect(() => {
    if (choice !== 'system') return
    let query: MediaQueryList
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      return
    }
    const update = () => setSystem(query.matches ? 'dark' : 'light')
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [choice])
  return choice === 'system' ? system : choice
}

/** Keyboard escape hatch: Ctrl+Shift+0 resets the look on this device, from any page. */
function useResetShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        (event.code === 'Digit0' || event.code === 'Numpad0')
      ) {
        event.preventDefault()
        clearDeviceLook()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * Applies the look: the shared theme, or this device's own, never in safe mode. A theme that fails to load, throws
 * while it is applied or damages a protected surface is skipped and the banner says so. Renders the banners.
 */
export function LookRuntime({ router }: { router?: DataRouter }) {
  const look = useLook()
  useResetShortcut()
  const id = look.effectiveId
  const custom = id !== null && !isBuiltinTheme(id)
  const detail = useQuery({ ...themeDetailQuery(id ?? 'score'), enabled: custom })
  const mode = useResolvedMode(look.mode)
  const view = useView(router)

  // Colour mode: this device's choice, else the shared one.
  useEffect(() => {
    applyTheme(look.mode)
  }, [look.mode])

  useEffect(() => {
    // The shared theme isn't known yet: the boot cache's look (attributes, token sheet, layout) stays until it is.
    if (look.loading && !look.safe) return
    if (look.safe || id === null) {
      applyBuiltin('score')
      setLayout(DEFAULT_LAYOUT)
      return
    }
    if (!custom) {
      applyBuiltin(id)
      setLayout(DEFAULT_LAYOUT)
      const pack = packs.find((item) => item.id === id) ?? packs[0]
      writeLookCache({
        id,
        attributes: {
          'data-pack': pack.id,
          'data-layout': pack.layout,
          'data-density': pack.density,
        },
        css: '',
      })
      return
    }
    if (detail.isPending) return // the boot cache keeps the last look until the theme arrives
    if (detail.isError || !detail.data) {
      applyBuiltin('score')
      setLayout(DEFAULT_LAYOUT)
      writeLookCache(null)
      lookStore.setFailure('Your theme couldn’t be loaded, so Score is showing its own look.')
      return
    }
    let stopWatching: (() => void) | undefined
    try {
      const applied = applyCustom(
        { id, manifest: detail.data.manifest, css: detail.data.css },
        mode,
        view,
      )
      writeLookCache({ id, ...applied.cache, user: applied.userCache })
      setLayout(applied.layout)
      lookStore.setFailure(null)
      stopWatching = watchProtectedSurfaces(() => {
        // Sticky on this device: reloading must not bring the same theme straight back.
        clearLook()
        applyBuiltin('score')
        setLayout(DEFAULT_LAYOUT)
        writeLookCache(null)
        writeDeviceOverride('score')
        lookStore.setFailure(
          'Score switched your theme off because it hid part of an approval or a security screen.',
        )
      })
    } catch {
      applyBuiltin('score')
      setLayout(DEFAULT_LAYOUT)
      writeLookCache(null)
      lookStore.setFailure('Your theme couldn’t be applied, so Score is showing its own look.')
    }
    return () => stopWatching?.()
  }, [look.safe, look.loading, id, custom, detail.isPending, detail.isError, detail.data, mode, view])

  return <LookBanner router={router} safe={look.safe} failure={look.failure} />
}

function LookBanner({
  router,
  safe,
  failure,
}: {
  router?: DataRouter
  safe: boolean
  failure: string | null
}): ReactNode {
  if (!safe && !failure) return null
  return (
    <div className="look-banner" role="status" data-protected="flex">
      <span>{safe ? 'Safe look: your theme is off for this visit' : failure}</span>
      <a
        href="/settings#look"
        onClick={(event) => {
          if (!router) return
          event.preventDefault()
          void router.navigate('/settings#look')
        }}
      >
        Settings › Look
      </a>
    </div>
  )
}
