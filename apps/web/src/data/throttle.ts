// Leading and trailing throttle: the first call runs at once, calls inside the window collapse into
// one more run when it ends. `cancel` drops the pending trailing run (unmount).
export function throttle(run: () => void, windowMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let trailing = false
  function open() {
    timer = setTimeout(() => {
      timer = undefined
      if (!trailing) return
      trailing = false
      run()
      open()
    }, windowMs)
  }
  const throttled = () => {
    if (timer !== undefined) {
      trailing = true
      return
    }
    run()
    open()
  }
  throttled.cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    trailing = false
  }
  return throttled
}
