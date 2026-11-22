/**
 * The QR path the Host emits must decode back to the exact ticket URL, or every
 * scan fails silently. jsQR is dev-only and optional: without it this asserts
 * geometry only.
 */
import assert from 'node:assert/strict'
import { qrSvgPath } from '../lib/qr.js'

const ticket = 'https://cnb.cool/login/wx/jump?ticket=9QjNq5Ub5lTL1QlWyJzb6V1aopXcUBFVIR0T38VO6hWO0MzbENXT2lEW1MjLwADMlNGZwQjNlNDOidDZxA'
const qr = qrSvgPath(ticket, { scale: 6, margin: 4 })

assert.ok(qr.modules >= 21, 'a QR must have at least 21 modules per side')
assert.equal(qr.size, (qr.modules + 8) * 6)
const rects = qr.path.match(/M-?\d+ -?\d+h-?\d+v-?\d+h-?\d+z/g) ?? []
assert.ok(rects.length > 100, 'a real ticket fills a lot of modules')

let decoder = null
try {
  decoder = (await import('jsqr')).default
} catch {
  decoder = null
}
if (decoder === null) {
  console.log('qr geometry OK (install jsqr to also assert decoding)')
} else {
  const pixels = new Uint8ClampedArray(qr.size * qr.size * 4).fill(255)
  const pattern = /M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h-(-?[\d.]+)z/g
  let match
  while ((match = pattern.exec(qr.path)) !== null) {
    const [x, y, w, h] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const at = (row * qr.size + column) * 4
        pixels[at] = 0
        pixels[at + 1] = 0
        pixels[at + 2] = 0
      }
    }
  }
  const decoded = decoder(pixels, qr.size, qr.size)
  assert.ok(decoded !== null, 'the rendered path must decode')
  assert.equal(decoded.data, ticket)
  console.log('qr decodes back to the ticket URL')
}
