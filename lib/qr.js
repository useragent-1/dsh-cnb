/**
 * QR rendering for the CNB scan-to-login ticket.
 *
 * The panel needs a scannable code for `<web>/login/wx/jump?ticket=...`. Rather
 * than shipping a QR encoder to the browser, the Host compiles the ticket into
 * an SVG path string and the Client renders one `<path>`; the whole code is then
 * three DOM nodes and inherits the panel's colors.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** MIT-licensed QR encoder (Kazuhiko Arase), vendored so the profile needs no install step. */
const qrcode = require('../vendor/qrcode.cjs')

/**
 * @param {string} text
 * @param {{ scale?: number, margin?: number, errorCorrection?: 'L'|'M'|'Q'|'H' }} [options]
 * @returns {{ path: string, modules: number, size: number, margin: number }}
 */
export function qrSvgPath(text, options = {}) {
  const { scale = 6, margin = 4, errorCorrection = 'M' } = options
  const code = qrcode(0, errorCorrection)
  code.addData(text)
  code.make()
  const modules = code.getModuleCount()
  const size = (modules + margin * 2) * scale
  const segments = []
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!code.isDark(row, column)) continue
      const x = (column + margin) * scale
      const y = (row + margin) * scale
      segments.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`)
    }
  }
  return { path: segments.join(''), modules, size, margin: margin * scale }
}
