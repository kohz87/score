import { useSyncExternalStore } from 'react'

// "Update available · Reload": a new build installs a new worker, which waits until the person reloads.
let waiting: ServiceWorker | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

function watch(registration: ServiceWorkerRegistration) {
  const found = (worker: ServiceWorker | null) => {
    if (!worker) return
    // A first install has no controller yet: only a worker that replaces a running one is an update.
    const done = () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        waiting = worker
        emit()
      }
    }
    worker.addEventListener('statechange', done)
    done()
  }
  found(registration.waiting)
  registration.addEventListener('updatefound', () => found(registration.installing))
  // Long-lived windows (installed phone apps) look for a new build whenever they come back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => {})
  })
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(watch)
      .catch(() => {
        // Without a worker Score still works; it is just not installable.
      })
  })
}

export function applyUpdate(): void {
  const worker = waiting
  if (!worker) return
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
  worker.postMessage({ type: 'SKIP_WAITING' })
}

export function useUpdateAvailable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => waiting !== undefined,
    () => false,
  )
}

/** Test hook: pretend a new worker is waiting. */
export function setWaitingWorker(worker: ServiceWorker | undefined): void {
  waiting = worker
  emit()
}
