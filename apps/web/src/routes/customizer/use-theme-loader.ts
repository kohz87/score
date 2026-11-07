import type { ThemeDetail, ThemeSummary } from '@score/contract'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { ApiError } from '../../data/api.ts'
import {
  emptyManifest,
  freshId,
  startHistory,
  type Draft,
  type History,
} from '../../themes/customizer/draft.ts'
import type { Probe } from '../../themes/customizer/frame-document.ts'
import {
  THEME_CHANGED_TEXT,
  ThemeChangedError,
  type Snapshot,
} from '../../themes/customizer/snapshot.ts'
import { hasSettings } from './customizer-helpers.ts'
import type { Target } from './customizer-types.ts'
import { loadWithSnapshot } from './theme-files.ts'

export type LoadedTheme = { detail: ThemeDetail; snapshot: Snapshot }
export type CopyOf = (id: string, loaded?: LoadedTheme) => Promise<{ draft: Draft; target: Target }>

type LoaderInput = { probe: Probe | null; themeId: string | undefined; themes: ThemeSummary[] }

type LoaderResult = {
  history: History | null
  setHistory: Dispatch<SetStateAction<History | null>>
  target: Target | null
  setTarget: Dispatch<SetStateAction<Target | null>>
  loadProblem: string
  skipReloadRef: MutableRefObject<string | null>
  copyOf: CopyOf
  takenIds: string[]
}

export function useThemeLoader({ probe, themeId, themes }: LoaderInput): LoaderResult {
  const [history, setHistory] = useState<History | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [loadProblem, setLoadProblem] = useState('')
  const skipReloadRef = useRef<string | null>(null)

  const takenIds = useMemo(() => themes.map((theme) => theme.id), [themes])

  const copyOf = useCallback(
    async (id: string, loaded?: LoadedTheme): Promise<{ draft: Draft; target: Target }> => {
      const { detail, snapshot } = loaded ?? (await loadWithSnapshot(id))
      const name = `${detail.manifest.name} copy`.slice(0, 60)
      const nextId = freshId(name, takenIds)
      const manifest = hasSettings(detail.manifest)
        ? { ...structuredClone(detail.manifest), id: nextId, name, version: '1.0.0' }
        : { ...emptyManifest(nextId, name) }
      return {
        draft: { manifest, css: detail.css, uploads: {} },
        target: {
          id: nextId,
          exists: false,
          source: 'new',
          etag: null,
          assetSource: id,
          assets: detail.assets,
          assetRev: detail.etag,
          licenseFiles: detail.licenseFiles,
          snapshot,
        },
      }
    },
    [takenIds],
  )

  // Open the theme named in the address: a custom or installed theme is edited in place, a built-in one is copied.
  useEffect(() => {
    if (!probe) return
    if (skipReloadRef.current === (themeId ?? '')) {
      skipReloadRef.current = null
      return
    }
    let alive = true
    void (async () => {
      try {
        setLoadProblem('')
        if (!themeId) {
          const id = freshId('My theme', takenIds)
          setHistory(
            startHistory({ manifest: emptyManifest(id, 'My theme'), css: '', uploads: {} }),
          )
          setTarget({
            id,
            exists: false,
            source: 'new',
            etag: null,
            assetSource: null,
            assets: [],
            assetRev: null,
            licenseFiles: [],
            snapshot: null,
          })
          return
        }
        const loaded = await loadWithSnapshot(themeId)
        if (!alive) return
        const { detail, snapshot } = loaded
        if (detail.summary.source === 'builtin') {
          const copy = await copyOf(themeId, loaded)
          if (!alive) return
          setHistory(startHistory(copy.draft))
          setTarget(copy.target)
          return
        }
        // `snapshot` holds this version's files, read now: a later conflict can't take them from "Save as new" or "Export".
        setHistory(startHistory({ manifest: detail.manifest, css: detail.css, uploads: {} }))
        setTarget({
          id: themeId,
          exists: true,
          source: detail.summary.source,
          etag: detail.etag,
          assetSource: themeId,
          assets: detail.assets,
          assetRev: detail.etag,
          licenseFiles: detail.licenseFiles,
          snapshot,
        })
      } catch (error) {
        if (!alive) return
        setLoadProblem(
          error instanceof ThemeChangedError
            ? THEME_CHANGED_TEXT
            : error instanceof ApiError && error.status === 404
              ? 'Couldn’t find that theme. It may have been deleted.'
              : 'Couldn’t open the theme. Check the connection and try again.',
        )
      }
    })()
    return () => {
      alive = false
    }
    // takenIds and copyOf follow the theme list: only the address and the probe decide when to open a theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId, probe])

  return {
    history,
    setHistory,
    target,
    setTarget,
    loadProblem,
    skipReloadRef,
    copyOf,
    takenIds,
  }
}
