export async function measure(page, parts, side) {
  return page.evaluate(
    ({ parts, side }) => {
      const result = {}
      for (const part of parts) {
        const element = globalThis.document.querySelector(part.selectors[side])
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
    const prototypeValue = left[part.name]
    const appValue = right[part.name]
    if (!prototypeValue && !appValue) continue
    if (!prototypeValue || !appValue) {
      rows.push({
        area: part.name,
        property: 'rendered',
        prototype: Boolean(prototypeValue),
        app: Boolean(appValue),
      })
      continue
    }
    for (const property of part.props) {
      if (prototypeValue[property] !== appValue[property])
        rows.push({
          area: part.name,
          property,
          prototype: prototypeValue[property],
          app: appValue[property],
        })
    }
  }
  return rows
}
