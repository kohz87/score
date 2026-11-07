export async function measure(page, parts, side) {
  return page.evaluate(
    ({ parts, side }) => {
      const result = {}
      for (const part of parts) {
        const selector = part.selectors[side]
        const element = globalThis.document.querySelector(selector)
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = globalThis.getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...new Set([...part.props, 'display'])].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { parts, side },
  )
}

export function differences(left, right, parts) {
  const rows = []
  for (const part of parts) {
    const a = left[part.name]
    const b = right[part.name]
    if (!a || !b) {
      rows.push({ area: part.name, property: 'rendered', prototype: Boolean(a), app: Boolean(b) })
      continue
    }
    for (const property of part.props) {
      if (a[property] !== b[property])
        rows.push({ area: part.name, property, prototype: a[property], app: b[property] })
    }
  }
  return rows
}
