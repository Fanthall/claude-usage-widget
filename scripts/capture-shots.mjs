/**
 * README ekran goruntulerini uretir.
 *
 * Gelistirme onizleme koprusuyle (`dev-preview.ts`) sahte veri kullanilir:
 * gercek hesap bilgisi, e-posta veya gercek kota degeri goruntulere GIRMEZ.
 * Cizilen arayuz gercek widget'in ta kendisidir — yalnizca veri sahtedir.
 *
 * Kullanim: `npm run dev` acikken `node scripts/capture-shots.mjs`
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Playwright bu projenin bagimliligi DEGIL — yalnizca goruntu almak icin
 * gerekiyor ve tarayici indirmesi ~100 MB. Yerelde varsa kullanilir; yoksa
 * `PLAYWRIGHT_DIR` ile dis kurulum gosterilebilir.
 */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium
  } catch {
    const dir = process.env['PLAYWRIGHT_DIR']
    if (dir === undefined) {
      throw new Error(
        'playwright bulunamadi. `npm i -D playwright` veya PLAYWRIGHT_DIR=<playwright/index.js iceren dizin>'
      )
    }
    const mod = await import(pathToFileURL(join(dir, 'playwright', 'index.js')).href)
    return mod.chromium
  }
}

const chromium = await loadChromium()

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', 'docs', 'shots')
const BASE = 'http://localhost:5173'

/** Onizleme rozetini gizler; README'de gorunmesi kafa karistirir. */
const HIDE_BADGE = `
  const badge = [...document.querySelectorAll('div')].find(
    (d) => d.textContent?.startsWith('ÖNİZLEME')
  )
  if (badge) badge.style.display = 'none'
`

const SHOTS = [
  { file: 'odak.png', theme: 'focus', state: 'ok', w: 214, h: 232 },
  { file: 'liste.png', theme: 'list', state: 'ok', w: 214, h: 190 },
  { file: 'serit.png', theme: 'strip', state: 'ok', w: 214, h: 128 },
  { file: 'kritik.png', theme: 'focus', state: 'critical', w: 214, h: 232 },
  { file: 'bayat.png', theme: 'focus', state: 'stale', w: 214, h: 250 },
  { file: 'hata.png', theme: 'focus', state: 'error', w: 214, h: 250 }
]

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()

for (const shot of SHOTS) {
  const page = await browser.newPage({
    viewport: { width: shot.w, height: shot.h },
    deviceScaleFactor: 2 // README'de keskin gorunsun
  })
  await page.goto(BASE)
  await page.evaluate((t) => localStorage.setItem('widget-theme-v2', t), shot.theme)
  await page.goto(`${BASE}/?state=${shot.state}`)
  await page.waitForTimeout(700)
  await page.evaluate(HIDE_BADGE)
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(OUT, shot.file), omitBackground: true })
  console.log(`${shot.file}  ${shot.w}x${shot.h}  tema=${shot.theme} durum=${shot.state}`)
  await page.close()
}

await browser.close()
console.log(`\n${SHOTS.length} goruntu -> ${OUT}`)
