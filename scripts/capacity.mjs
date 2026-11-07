#!/usr/bin/env node
// How busy this machine is, for the lead's parallel-task rule (CLAUDE.md "Ground rules" 3, owner 2026-11-07): keep it
// at about 80% while building, start more tasks under 50%, start nothing over 90%. Linux only (/proc).
import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

function cpuTimes() {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]
  const values = line.trim().split(/\s+/).slice(1).map(Number)
  // user nice system idle iowait irq softirq steal: idle + iowait are not busy.
  const idle = values[3] + (values[4] ?? 0)
  const total = values.slice(0, 8).reduce((sum, value) => sum + value, 0)
  return { idle, total }
}

function memoryPercent() {
  const info = Object.fromEntries(
    readFileSync('/proc/meminfo', 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [key, rest] = line.split(':')
        return [key, Number.parseInt(rest, 10)]
      }),
  )
  return Math.round(100 * (1 - info.MemAvailable / info.MemTotal))
}

const sampleMs = Number(process.argv[2] ?? 3000)
const before = cpuTimes()
await sleep(sampleMs)
const after = cpuTimes()
const total = after.total - before.total
const cpu = total > 0 ? Math.round(100 * (1 - (after.idle - before.idle) / total)) : 0
const mem = memoryPercent()
const busiest = Math.max(cpu, mem)
const advice =
  busiest < 50
    ? 'start more parallel tasks (under 50%)'
    : busiest > 90
      ? 'start nothing new (over 90%)'
      : busiest >= 70
        ? 'hold (in the 70–90% band)'
        : 'room for one more task (50–70%)'
console.log(`cpu ${cpu}%  mem ${mem}%  → ${advice}`)
