import { applyUpdate, useUpdateAvailable } from './service-worker.ts'

export function UpdateBanner() {
  if (!useUpdateAvailable()) return null
  return (
    <div className="update-banner" role="status">
      <span>Update available</span>
      <button type="button" onClick={applyUpdate}>
        Reload
      </button>
    </div>
  )
}
