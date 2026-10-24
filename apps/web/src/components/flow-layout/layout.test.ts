import { describe, expect, it } from 'vitest'
import { layoutFlow, type FlowLayoutEdge, type FlowLayoutInput } from './layout'

const node = (id: string, width = 200, height = 80) => ({ id, width, height })
const edge = (from: string, to: string, kind = 'handoff'): FlowLayoutEdge => ({
  id: `${from}>${to}:${kind}`,
  from,
  to,
  kind,
})

function overlaps(input: FlowLayoutInput, out: ReturnType<typeof layoutFlow>): boolean {
  const size = new Map(input.nodes.map((n) => [n.id, n]))
  for (let i = 0; i < out.nodes.length; i++) {
    for (let j = i + 1; j < out.nodes.length; j++) {
      const a = out.nodes[i]!
      const b = out.nodes[j]!
      const sa = size.get(a.id)!
      const sb = size.get(b.id)!
      if (
        a.x < b.x + sb.width &&
        b.x < a.x + sa.width &&
        a.y < b.y + sb.height &&
        b.y < a.y + sa.height
      ) {
        return true
      }
    }
  }
  return false
}

describe('layoutFlow', () => {
  it('lays a chain out left to right', () => {
    const input = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c')],
    }
    const out = layoutFlow(input)
    const x = Object.fromEntries(out.nodes.map((n) => [n.id, n.x]))
    expect(x.a!).toBeLessThan(x.b!)
    expect(x.b!).toBeLessThan(x.c!)
    expect(out.edges.every((e) => !e.back && e.points.length >= 2)).toBe(true)
  })

  it('puts a diamond fan-out in one column and the join after it', () => {
    const input = {
      nodes: [node('brief'), node('x'), node('y'), node('join')],
      edges: [edge('brief', 'x'), edge('brief', 'y'), edge('x', 'join'), edge('y', 'join')],
    }
    const out = layoutFlow(input)
    const by = Object.fromEntries(out.nodes.map((n) => [n.id, n]))
    expect(by.x!.x).toBe(by.y!.x)
    expect(by.x!.y).not.toBe(by.y!.y)
    expect(by.join!.x).toBeGreaterThan(by.x!.x)
    expect(overlaps(input, out)).toBe(false)
  })

  it('routes sent_back edges below the nodes', () => {
    const input = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a', 'sent_back')],
    }
    const out = layoutFlow(input)
    const back = out.edges.find((e) => e.back)!
    const maxNodeBottom = Math.max(...out.nodes.map((n) => n.y + 80))
    expect(back.id).toBe('c>a:sent_back')
    expect(back.points.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...back.points.map((p) => p.y))).toBeGreaterThan(maxNodeBottom)
    expect(out.height).toBeGreaterThan(maxNodeBottom)
  })

  it('breaks plain cycles by marking the closing edge as a back-edge', () => {
    const out = layoutFlow({
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    })
    expect(out.edges.filter((e) => e.back)).toHaveLength(1)
    expect(out.edges.find((e) => e.id === 'a>b:handoff')!.back).toBe(false)
  })

  it('handles self-loops, unknown endpoints, empty input and disconnected nodes', () => {
    expect(layoutFlow({ nodes: [], edges: [] }).nodes).toEqual([])
    const input = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'a'), edge('a', 'zz')],
    }
    const out = layoutFlow(input)
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]!.back).toBe(true)
    expect(overlaps(input, out)).toBe(false)
    expect(out.nodes).toHaveLength(3)
  })

  it('is deterministic', () => {
    const input = {
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
      edges: [
        edge('a', 'c'),
        edge('b', 'c'),
        edge('c', 'd'),
        edge('c', 'e'),
        edge('e', 'a', 'sent_back'),
      ],
    }
    expect(layoutFlow(input)).toEqual(layoutFlow(structuredClone(input)))
  })
})

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('layoutFlow properties', () => {
  it('has no overlaps, >= 2 points per edge and left-to-right forward edges on 300 random graphs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const count = 1 + Math.floor(r() * 50)
      const nodes = Array.from({ length: count }, (_, i) =>
        node(`n${i}`, 120 + Math.floor(r() * 120), 40 + Math.floor(r() * 80)),
      )
      const edges: FlowLayoutEdge[] = []
      const edgeCount = Math.floor(r() * count * 2)
      for (let k = 0; k < edgeCount; k++) {
        const a = Math.floor(r() * count)
        const b = Math.floor(r() * count)
        const kind = r() < 0.15 ? 'sent_back' : 'handoff'
        edges.push({ id: `e${k}`, from: `n${a}`, to: `n${b}`, kind })
      }
      const input = { nodes, edges }
      const out = layoutFlow(input)
      expect(overlaps(input, out), `overlap seed ${seed}`).toBe(false)
      expect(out.edges).toHaveLength(edges.length)
      for (const e of out.edges) {
        expect(e.points.length).toBeGreaterThanOrEqual(2)
        if (!e.back) {
          for (let i = 1; i < e.points.length; i++) {
            expect(e.points[i]!.x).toBeGreaterThanOrEqual(e.points[i - 1]!.x)
          }
          const src = edges.find((x) => x.id === e.id)!
          const a = out.nodes.find((nn) => nn.id === src.from)!
          const b = out.nodes.find((nn) => nn.id === src.to)!
          expect(a.x, `forward seed ${seed}`).toBeLessThan(b.x)
        }
      }
      expect(layoutFlow(input)).toEqual(out)
    }
  })
})

it('keeps adjacent sent-back arrows in the gap and separate from the review arrow', () => {
  const out = layoutFlow({
    nodes: [node('build'), node('review')],
    edges: [edge('build', 'review', 'review'), edge('review', 'build', 'sent_back')],
  })
  const back = out.edges.find((item) => item.back)!
  const forward = out.edges.find((item) => !item.back)!
  expect(back.points[0]!.x).toBe(out.nodes[1]!.x)
  expect(back.points.at(-1)!.x).toBe(out.nodes[0]!.x + 200)
  expect(back.points[0]!.y).toBeGreaterThan(forward.points[0]!.y)
  expect(Math.max(...back.points.map((point) => point.y))).toBeLessThan(out.nodes[0]!.y + 80)
})
