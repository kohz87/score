import { createContext, useContext } from 'react'

/**
 * True inside the Customizer's preview frame (PLAN 9.4): the real app, drawn for looking at. Things that belong to the
 * page a person is on (the command shortcut, desktop notifications, update banners) stay out of it.
 */
export const PreviewContext = createContext(false)
export function usePreview(): boolean {
  return useContext(PreviewContext)
}
