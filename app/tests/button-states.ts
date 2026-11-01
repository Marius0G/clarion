import { expect, type Page } from '@playwright/test'
const luminance = (rgb: string) => {
  const c = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722
}
export async function checkButtons(page: Page) {
  for (const button of await page.locator('button').all()) {
    if (!await button.isVisible()) continue
    if (!await button.evaluate(el => !!el.closest('.lm-zoom, .lm-sheet.s-peek .lm-sheet-body'))) await button.scrollIntoViewIfNeeded()
    const exposed = await button.evaluate(el => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    })
    if (!exposed) continue
    const style = () => button.evaluate(el => {
      const s = getComputedStyle(el)
      let background = s.backgroundColor, parent = el.parentElement
      while (background === 'rgba(0, 0, 0, 0)' && parent) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement }
      return { color: s.color, background, outline: s.outlineStyle }
    })
    const before = await style()
    await button.hover()
    if (await button.isDisabled()) { expect(await style()).toEqual(before); continue }
    const contrast = async () => {
      const s = await style(), a = luminance(s.color), b = luminance(s.background)
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), await button.textContent() ?? '').toBeGreaterThanOrEqual(4.5)
    }
    const hovered = await style()
    const kind = await button.evaluate(el => ({ handle: el.classList.contains('lm-handle'), primary: el.matches('.primary, .lv-buttons > button, .lv-chips button[aria-pressed=true]') }))
    if (!kind.handle) expect(hovered.background).toBe(kind.primary ? 'rgb(37, 75, 118)' : 'rgb(222, 222, 222)')
    await contrast()
    await button.focus()
    await button.press('Shift')
    expect((await style()).outline).toBe('solid')
    // The sheet handle starts a drag; moving off it would change the layout.
    if (await button.evaluate(el => el.classList.contains('lm-handle'))) continue
    await page.mouse.down()
    await contrast()
    await page.mouse.move(1, 1)
    await page.mouse.up()
  }
}
