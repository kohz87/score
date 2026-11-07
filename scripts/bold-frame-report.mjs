import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cell, difference } from './bold-frame-measure.mjs'
import { emptyParts, parts, roomParts } from './bold-frame-parts-frame.mjs'
import { recipeParts, searchPrototypeParts } from './bold-frame-parts-dialogs.mjs'
import { rulesParts, systemParts, usageParts } from './bold-frame-parts-settings.mjs'

export function writeReports(results, output) {
  writeFileSync(join(output, 'bold-frame-metrics.json'), `${JSON.stringify(results, null, 2)}\n`)

  const lines = ['# Bold frame: prototype vs app', '']
  for (const size of Object.keys(results)) {
    lines.push(`## ${size}px`, '', '| Part | Prototype | App | Difference |', '|---|---|---|---|')
    for (const part of parts)
      lines.push(
        `| ${part.name} | ${cell(results[size].prototype, part)} | ${cell(results[size].app, part)} | ${difference(results[size].prototype, results[size].app, part)} |`,
      )
    lines.push('')
  }
  writeFileSync(join(output, 'bold-frame-metrics.md'), `${lines.join('\n')}\n`)

  const roomLines = ['# Bold team room: prototype / board 09 vs app', '']
  for (const size of Object.keys(results)) {
    roomLines.push(
      `## Team room — ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of roomParts)
      roomLines.push(
        `| ${part.name} | ${cell(results[size].room.prototype, part)} | ${cell(results[size].room.app, part)} | ${difference(results[size].room.prototype, results[size].room.app, part)} |`,
      )
    roomLines.push(
      '',
      `## Empty room — ${size}px`,
      '',
      '| Part | Board 09 | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of emptyParts)
      roomLines.push(
        `| ${part.name} | ${cell(results[size].empty.prototype, part)} | ${cell(results[size].empty.app, part)} | ${difference(results[size].empty.prototype, results[size].empty.app, part)} |`,
      )
    roomLines.push('')
  }
  writeFileSync(join(output, 'bold-room-metrics.md'), `${roomLines.join('\n')}\n`)

  const usageLines = ['# Bold usage: prototype vs app', '']
  for (const size of Object.keys(results)) {
    usageLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of usageParts)
      usageLines.push(
        `| ${part.name} | ${cell(results[size].usage.prototype, part)} | ${cell(results[size].usage.app, part)} | ${difference(results[size].usage.prototype, results[size].usage.app, part)} |`,
      )
    usageLines.push('')
  }
  writeFileSync(join(output, 'bold-usage-metrics.md'), `${usageLines.join('\n')}\n`)

  for (const [name, title, sectionParts] of [
    ['rules', 'Bold rules', rulesParts],
    ['system', 'Bold system', systemParts],
  ]) {
    const sectionLines = [`# ${title}: prototype vs app`, '']
    for (const size of Object.keys(results)) {
      sectionLines.push(
        `## ${size}px`,
        '',
        '| Part | Prototype | App | Difference |',
        '|---|---|---|---|',
      )
      for (const part of sectionParts)
        sectionLines.push(
          `| ${part.name} | ${cell(results[size][name].prototype, part)} | ${cell(results[size][name].app, part)} | ${difference(results[size][name].prototype, results[size][name].app, part)} |`,
        )
      sectionLines.push('')
    }
    writeFileSync(join(output, `bold-${name}-metrics.md`), `${sectionLines.join('\n')}\n`)
  }
  const searchLines = ['# Bold search: prototype vs app', '']
  for (const size of Object.keys(results)) {
    searchLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of searchPrototypeParts)
      searchLines.push(
        `| ${part.name} | ${cell(results[size].search.prototype, part)} | ${cell(results[size].search.app, part)} | ${difference(results[size].search.prototype, results[size].search.app, part)} |`,
      )
    searchLines.push('')
  }
  writeFileSync(join(output, 'bold-search-metrics.md'), `${searchLines.join('\n')}\n`)
  const recipeLines = ['# Bold recipes: prototype vs app', '']
  for (const size of Object.keys(results)) {
    recipeLines.push(
      `## ${size}px`,
      '',
      '| Part | Prototype | App | Difference |',
      '|---|---|---|---|',
    )
    for (const part of recipeParts)
      recipeLines.push(
        `| ${part.name} | ${cell(results[size].recipes.prototype, part)} | ${cell(results[size].recipes.app, part)} | ${difference(results[size].recipes.prototype, results[size].recipes.app, part)} |`,
      )
    recipeLines.push('')
  }
  writeFileSync(join(output, 'bold-recipes-metrics.md'), `${recipeLines.join('\n')}\n`)
}
