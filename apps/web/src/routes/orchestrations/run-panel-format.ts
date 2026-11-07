export const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : null
