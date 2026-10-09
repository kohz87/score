import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { QrCode, qrPath } from './QrCode.tsx'

test('renders a labelled SVG with a quiet zone and does not repeat the URL', () => {
  const url = 'https://example.test:8741/pair#abcdef'
  const { container } = render(<QrCode text={url} label="QR code for the pairing link" />)
  const svg = screen.getByRole('img', { name: 'QR code for the pairing link' })
  const { size } = qrPath(url)
  expect(svg.getAttribute('viewBox')).toBe(`0 0 ${size + 8} ${size + 8}`)
  expect(container.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(50)
  expect(container.innerHTML).not.toContain('example.test')
})

test('different text gives a different code, the same text the same code', () => {
  expect(qrPath('a').path).toBe(qrPath('a').path)
  expect(qrPath('a').path).not.toBe(qrPath('b').path)
})
