/* global document, getComputedStyle */
export async function measure(page, list, side) {
  return page.evaluate(
    ({ list, side }) => {
      const result = {}
      for (const part of list) {
        const element = document.querySelector(part.selectors[side])
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...new Set([...part.props, 'display'])].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { list, side },
  )
}

export function differences(boardValues, appValues, list) {
  const rows = []
  for (const part of list) {
    const left = boardValues[part.name]
    const right = appValues[part.name]
    if (!left && !right) continue
    if (!left || !right) {
      rows.push({
        area: part.name,
        property: 'rendered',
        board: Boolean(left),
        app: Boolean(right),
      })
      continue
    }
    for (const property of part.props) {
      if (left[property] !== right[property])
        rows.push({ area: part.name, property, board: left[property], app: right[property] })
    }
  }
  return rows
}
