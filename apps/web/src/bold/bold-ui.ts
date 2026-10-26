import type { Dispatch, SetStateAction } from 'react'

/** The phone side sheet is owned by the shell (so the header and tab bar can go inert) but opened by the room. */
export type BoldSheetState = {
  sheetOpen: boolean
  setSheetOpen: Dispatch<SetStateAction<boolean>>
}
