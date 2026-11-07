import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createSseParser, type SseFrame } from '../../../src/hermes/live/index.ts'
import { comment, encoder, event, installSseHooks } from './sse-client-helpers.ts'

function parse(text: string): SseFrame[] {
  const parser = createSseParser()
  return [...parser.push(encoder.encode(text)), ...parser.finish()]
}

installSseHooks()

describe('SSE parser', () => {
  test.each(['\n', '\r', '\r\n'])('dispatches with %j line endings', (eol) => {
    expect(parse(`id: 0${eol}data: first${eol}data: second${eol}${eol}`)).toEqual([
      event('first\nsecond', '0'),
    ])
  })

  test('dispatches CR immediately and skips a following LF in the next chunk', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('data: hello\r\r'))).toEqual([event('hello')])
    expect(parser.push(encoder.encode('\ndata: again\r\n\r\n'))).toEqual([event('again')])
    expect(parser.finish()).toEqual([])
  })

  test('strips only the leading BOM and streams split UTF-8 characters', () => {
    const bytes = encoder.encode('\uFEFFdata: café 🐈\uFEFF\n\n')
    const parser = createSseParser()
    const output = [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte)))
    expect([...output, ...parser.finish()]).toEqual([event('café 🐈\uFEFF')])
  })

  test('removes exactly one optional space and preserves tabs and colons', () => {
    expect(parse('data:value\ndata: value\ndata:  value:more\ndata:\tvalue\n\n')).toEqual([
      event('value\nvalue\n value:more\n\tvalue'),
    ])
  })

  test('surfaces comments without disturbing a pending event', () => {
    expect(parse(': open\ndata: a\n:keepalive\n:  spaces\n:\ndata: b\n\n: stream closed')).toEqual([
      comment('open'),
      comment('keepalive'),
      comment(' spaces'),
      comment(''),
      event('a\nb'),
      comment('stream closed'),
    ])
  })

  test('ignores unknown fields and compares field names literally', () => {
    expect(parse('unknown: x\nData: ignored\ndata: yes\n\n')).toEqual([event('yes')])
  })

  test('persists IDs, ignores NUL IDs, and clears IDs without a colon', () => {
    expect(
      parse('id: first\ndata: a\n\nid: bad\0id\ndata: b\n\ndata: c\n\nid\ndata: d\n\n'),
    ).toEqual([event('a', 'first'), event('b', 'first'), event('c', 'first'), event('d')])
  })

  test('ID-only blocks affect following events without dispatching data', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('id: cursor\n\n'))).toEqual([])
    expect(parser.lastEventId).toBe('cursor')
    expect(parser.push(encoder.encode('data: next\n\n'))).toEqual([event('next', 'cursor')])
  })

  test('uses the last event type and resets it even after an empty block', () => {
    expect(
      parse(
        'event: ignored\n\nevent: first\nevent: custom\ndata: a\n\ndata: b\n\nevent:\ndata: c\n\n',
      ),
    ).toEqual([event('a', '', 'custom'), event('b'), event('c')])
  })

  test('empty data fields dispatch; blocks with no data do not', () => {
    expect(parse('\nunknown\n\ndata\n\ndata:\ndata\n\n')).toEqual([event(''), event('\n')])
  })

  test.each(['', '-1', '+1', '1.5', '1x', ' 12', '12 ', '\t12', '１２'])(
    'ignores invalid retry %j',
    (value) => {
      const parser = createSseParser()
      parser.push(encoder.encode(`retry: 123\nretry: ${value}\n\n`))
      expect(parser.retry).toBe(123)
    },
  )

  test('accepts zero and leading zeros in retry without dispatching a frame', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode('retry: 00025\n'))).toEqual([])
    expect(parser.retry).toBe(25)
    parser.push(encoder.encode('retry: 0\n'))
    expect(parser.retry).toBe(0)
    parser.push(encoder.encode(`retry: ${'9'.repeat(400)}\n`))
    expect(parser.retry).toBe(Number.MAX_SAFE_INTEGER)
  })

  test.each(['data: lost', 'data: lost\n', 'data: lost\r\n'])(
    'discards incomplete data at EOF: %j',
    (text) => {
      expect(parse(text)).toEqual([])
    },
  )

  test('flushes malformed trailing UTF-8 without dispatching pending data', () => {
    const parser = createSseParser()
    expect(parser.push(encoder.encode(': comment '))).toEqual([])
    expect(parser.push(Uint8Array.of(0xc3))).toEqual([])
    expect(parser.finish()).toEqual([comment('comment �')])
    expect(parser.finish()).toEqual([])
    expect(() => parser.push(new Uint8Array())).toThrow('finished')
  })

  test('every byte split and one-byte chunks produce identical frames and parser state', () => {
    const bytes = encoder.encode(
      '\uFEFF: open\r\nid: 0\rdata: café 🐈\r\ndata: two\n\nretry: 00012\r\nevent: custom\rdata\r\rid: bad\0id\ndata: last\n\n: stream closed\r\n',
    )
    const expected = [
      comment('open'),
      event('café 🐈\ntwo', '0'),
      event('', '0', 'custom'),
      event('last', '0'),
      comment('stream closed'),
    ]
    for (let offset = 0; offset <= bytes.length; offset++) {
      const parser = createSseParser()
      const frames = [
        ...parser.push(bytes.subarray(0, offset)),
        ...parser.push(bytes.subarray(offset)),
        ...parser.finish(),
      ]
      expect(frames, `byte split ${offset}`).toEqual(expected)
      expect(parser.lastEventId).toBe('0')
      expect(parser.retry).toBe(12)
    }
    const parser = createSseParser()
    expect(
      [...bytes].flatMap((byte) => parser.push(Uint8Array.of(byte))).concat(parser.finish()),
    ).toEqual(expected)
  })

  test('replays every recorded run sequence and JSON event name', () => {
    const fixture = z
      .array(
        z.object({ id: z.string(), seq: z.int().nonnegative(), event: z.string() }).passthrough(),
      )
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../fixtures/hermes/l2-run-events.json', import.meta.url),
            'utf8',
          ),
        ),
      )
    const wire =
      ': open\n' +
      fixture.map((item) => `id: ${item.id}\ndata: ${JSON.stringify(item)}\n\n`).join('') +
      ': stream closed\n'
    const parser = createSseParser()
    const frames = [...encoder.encode(wire)]
      .flatMap((byte) => parser.push(Uint8Array.of(byte)))
      .concat(parser.finish())
    const decoded = frames
      .filter((frame) => frame.type === 'event')
      .map((frame) => {
        const data = z.object({ seq: z.int(), event: z.string() }).parse(JSON.parse(frame.data))
        return { id: frame.id, ...data }
      })
    expect(decoded).toEqual(fixture.map(({ id, seq, event }) => ({ id, seq, event })))
    expect(decoded).toHaveLength(68)
  })
})
