import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import type { DataRouter } from 'react-router'
import { applyTheme } from '../data/theme.ts'
import { applyBuiltin, applyCustom, clearLook, isBuiltinTheme, type ColorMode } from './engine.ts'
import { watchProtectedSurfaces } from './guard.ts'
import { clearDeviceLook, lookStore, writeDeviceOverride, writeLookCache } from './look-store.ts'
import { themeDetailQuery } from './queries.ts'
import { useLook } from './use-look.ts'
import { packs } from '../styles/packs.ts'
import './look.css'

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

  // Colour mode: this device's choice, else the shared one.
  useEffect(() => {
    applyTheme(look.mode)
  }, [look.mode])

  useEffect(() => {
    if (look.safe || id === null) {
      applyBuiltin('score')
      return
    }
    if (!custom) {
      applyBuiltin(id)
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
      writeLookCache(null)
      lookStore.setFailure('Your theme couldn’t be loaded, so Score is showing its own look.')
      return
    }
    let stopWatching: (() => void) | undefined
    try {
      const applied = applyCustom(
        { id, manifest: detail.data.manifest, css: detail.data.css },
        mode,
      )
      writeLookCache({ id, attributes: applied.cache.attributes, css: applied.cache.css })
      lookStore.setFailure(null)
      stopWatching = watchProtectedSurfaces(() => {
        // Sticky on this device: reloading must not bring the same theme straight back.
        clearLook()
        applyBuiltin('score')
        writeLookCache(null)
        writeDeviceOverride('score')
        lookStore.setFailure(
          'Score switched your theme off because it hid part of an approval or a security screen.',
        )
      })
    } catch {
      applyBuiltin('score')
      writeLookCache(null)
      lookStore.setFailure('Your theme couldn’t be applied, so Score is showing its own look.')
    }
    return () => stopWatching?.()
  }, [look.safe, id, custom, detail.isPending, detail.isError, detail.data, mode])

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
