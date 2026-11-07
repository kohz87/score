#!/usr/bin/env node
// How busy the whole machine is, for the lead's load rule (CLAUDE.md "Ground rules" 3, owner 2026-11-07): 80% is a
// safety ceiling so the VM never crashes; under 50% the lead starts more tasks. Linux only (/proc).
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
// The whole machine counts (other projects share it): 80% is a safety ceiling, and memory is the crash risk.
const advice =
  mem > 90
    ? 'memory over 90%: stop the newest task Score started'
    : cpu > 85 || mem > 80
      ? 'over the ceiling: start nothing, let running work finish'
      : Math.max(cpu, mem) >= 70
        ? 'near the ceiling (70–85%): start nothing new'
        : Math.max(cpu, mem) >= 50
          ? 'room for one more task (50–70%)'
          : 'start more parallel tasks (under 50%), one at a time'
console.log(`cpu ${cpu}%  mem ${mem}%  → ${advice}`)
