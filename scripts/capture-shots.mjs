/**
 * README ekran goruntulerini uretir: `npm run shots`
 *
 * - Widget gorunumleri: arayuz Vite ile Electron'suz acilir, veri gelistirme
 *   onizleme koprusunden (`dev-preview.ts`) gelir. Electron acilmadigi icin
 *   calisan widget'in tek kopya kilidine takilmaz.
 * - Panel: merkezin GERCEK kodu (HubDb + createHandler) bellekte, SENTETIK veriyle
 *   calisir; derlenmis panel (`npm run build:panel`) ondan sunulur.
 *
 * Gercek hesap, e-posta, cihaz, proje adi ya da kota degeri goruntulere GIRMEZ.
 * Cizilen arayuz gercek uygulamanin kendisidir — yalnizca veri sahtedir.
 *
 * Playwright bu projenin bagimliligi DEGIL (tarayici indirmesi ~100 MB). Yerelde
 * yoksa `PLAYWRIGHT_DIR=<playwright klasorunu iceren node_modules>` verilir.
 */

import { mkdir } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { build, createServer } from 'vite'

async function loadChromium() {
  try {
    return (await import('playwright')).chromium
  } catch {
    const dir = process.env['PLAYWRIGHT_DIR']
    if (dir === undefined) {
      throw new Error('playwright bulunamadi. `npm i -D playwright` veya PLAYWRIGHT_DIR=<playwright klasorunu iceren dizin>')
    }
    const mod = await import(pathToFileURL(join(dir, 'playwright', 'index.js')).href)
    return mod.chromium ?? mod.default.chromium
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'docs', 'shots')
const WIDGET_PORT = 5199
const PANEL_PORT = 5310

/** Onizleme rozetini gizler; README'de gorunmesi kafa karistirir. */
const HIDE_BADGE = `
  const badge = [...document.querySelectorAll('div')].find((d) => /^(ÖNİZLEME|PREVIEW)/.test(d.textContent ?? ''))
  if (badge) badge.style.display = 'none'
`

const WIDGET_SHOTS = [
  { file: 'focus.png', theme: 'focus', q: 'state=ok&team=ok&lang=en' },
  { file: 'list.png', theme: 'list', q: 'state=ok&team=ok&lang=en' },
  { file: 'strip.png', theme: 'strip', q: 'state=ok&team=ok&lang=en' },
  { file: 'critical.png', theme: 'focus', q: 'state=critical&team=off&lang=en' },
  { file: 'stale.png', theme: 'focus', q: 'state=stale&team=off&lang=en' },
  { file: 'error.png', theme: 'focus', q: 'state=error&team=off&lang=en' }
]

async function gotoWithRetry(page, url) {
  for (let i = 0; i < 40; i += 1) {
    try {
      await page.goto(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('sunucuya ulasilamadi: ' + url)
}

async function widgetShots(chromium, errors) {
  const server = await createServer({
    configFile: false,
    root: join(ROOT, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@renderer': join(ROOT, 'src/renderer/src'), '@shared': join(ROOT, 'src/shared') } },
    server: { port: WIDGET_PORT, strictPort: true },
    logLevel: 'warn'
  })
  await server.listen()
  const base = `http://localhost:${WIDGET_PORT}`
  const browser = await chromium.launch()
  try {
    for (const shot of WIDGET_SHOTS) {
      // Once genis pencere; widget'in kendi olctugu sigma boyutu konsoldan okunur.
      const page = await browser.newPage({ viewport: { width: 520, height: 600 }, deviceScaleFactor: 2 })
      let fit = null
      page.on('console', (m) => {
        const hit = /fit -> (\d+) x (\d+)/.exec(m.text())
        if (hit) fit = { width: Number(hit[1]), height: Number(hit[2]) }
      })
      page.on('pageerror', (e) => errors.push(`${shot.file}: ${e.message}`))
      await gotoWithRetry(page, base)
      await page.evaluate((t) => localStorage.setItem('widget-theme-v2', t), shot.theme)
      await page.goto(`${base}/?${shot.q}`)
      await page.waitForTimeout(700)
      if (fit !== null) await page.setViewportSize(fit)
      await page.evaluate(HIDE_BADGE)
      await page.waitForTimeout(200)
      await page.screenshot({ path: join(OUT, shot.file), omitBackground: true })
      console.log(`${shot.file}  ${fit === null ? 'fit yok' : `${fit.width}x${fit.height}`}`)
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

// ── Panel: gercek merkez kodu, sentetik veri ─────────────────────────────────

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Kisisel: aksam ve hafta sonu (iki cihaz); Team: hafta ici mesai (is laptopu). */
function sessionsFor(now, rand) {
  const out = []
  const today = new Date(now).setHours(0, 0, 0, 0)
  for (let d = -29; d <= 0; d++) {
    const day = today + d * DAY
    const dow = new Date(day).getDay()
    const weekend = dow === 0 || dow === 6
    if (!weekend) {
      for (const h of [9.5, 13.5, 16]) {
        if (rand() < 0.25) continue
        const start = day + (h + rand() * 0.8) * HOUR
        out.push({ account: 'team', device: 'mac', start, end: start + (40 + rand() * 110) * MIN, intensity: 0.5 + rand() * 1.2 })
      }
    }
    for (const h of weekend ? [12, 15.5, 20.5] : [19.5, 22]) {
      if (rand() < 0.3) continue
      const start = day + (h + rand()) * HOUR
      out.push({ account: 'personal', device: rand() < 0.75 ? 'pc' : 'mac', start, end: start + (30 + rand() * 120) * MIN, intensity: 0.4 + rand() * 1.6 })
    }
  }
  // Bugun: kisisel hesapta son iki saatte calisma; kart, cizgi ve 'bu cihaz' bos kalmasin.
  out.push({ account: 'personal', device: 'pc', start: now - 110 * MIN, end: now, intensity: 1.1 })
  return out.filter((s) => s.start < now).map((s) => ({ ...s, end: Math.min(s.end, now) }))
}

const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
const PROJECTS = ['web-app', 'api', 'docs', 'mobile-app']

async function seededHub(loader, now) {
  const { HubDb } = await loader.ssrLoadModule('/server/src/db.ts')
  const { createHandler } = await loader.ssrLoadModule('/server/src/handlers.ts')
  const rand = rng(7)
  const db = new HubDb(':memory:')
  const pc = db.enroll('Windows PC', 'win32', now - 20 * DAY)
  const mac = db.enroll('Work Mac', 'darwin', now - 20 * DAY)
  db.ensureLocalDevice('local-server', 'Home server', now - 20 * DAY)
  const ids = { pc: pc.deviceId, mac: mac.deviceId }

  const perDevice = new Map()
  const perMinute = { personal: new Map(), team: new Map() }
  for (const s of sessionsFor(now, rand)) {
    const list = perDevice.get(s.device) ?? []
    for (let t = s.start; t < s.end; t += MIN) {
      if (rand() < 0.35) continue
      const minute = Math.floor(t / MIN)
      const burst = s.intensity * (0.4 + rand() * 1.6)
      const b = {
        minute,
        account: s.account,
        model: MODELS[Math.floor(rand() * MODELS.length)],
        project: s.account === 'team' ? null : PROJECTS[Math.floor(rand() * PROJECTS.length)],
        subagent: rand() < 0.15,
        input: Math.round(40 * burst),
        output: Math.round(2_500 * burst),
        cacheWrite5m: Math.round(9_000 * burst),
        cacheWrite1h: 0,
        cacheRead: Math.round(420_000 * burst),
        requests: 1 + Math.floor(burst * 3)
      }
      list.push(b)
      const fresh = b.input + b.output + b.cacheWrite5m
      perMinute[s.account].set(minute, (perMinute[s.account].get(minute) ?? 0) + fresh)
    }
    perDevice.set(s.device, list)
  }
  for (const [device, list] of perDevice) db.writeBuckets(ids[device], list)

  // Kota: 5 dakikada bir; oturum penceresi ilk kullanimla baslar, 5 saat surer.
  // Pencere kapasitesi: yogun bir Team gunu dikkat bandina (%75-90) ulasir, kritik olmaz.
  const CAP = { personal: 2_600_000, team: 3_300_000 }
  const samples = []
  for (const account of ['personal', 'team']) {
    let windowStart = null
    let used = 0
    let weekUsed = 0
    const weekStart = (() => {
      const d = new Date(now)
      d.setHours(9, 0, 0, 0)
      while (d.getDay() !== 4) d.setTime(d.getTime() - DAY)
      return d.getTime()
    })()
    for (let t = now - 15 * DAY; t <= now; t += 5 * MIN) {
      let added = 0
      for (let m = Math.floor((t - 5 * MIN) / MIN); m < Math.floor(t / MIN); m++) added += perMinute[account].get(m) ?? 0
      if (windowStart !== null && t >= windowStart + 5 * HOUR) {
        windowStart = null
        used = 0
      }
      if (added > 0 && windowStart === null) windowStart = t - 5 * MIN
      used += added
      if (t >= weekStart) weekUsed += added
      samples.push({
        account,
        fetchedAt: t,
        windows: [
          { label: 'Current session', percent: Math.min(100, (used / CAP[account]) * 100), resetsAtMs: windowStart === null ? null : windowStart + 5 * HOUR },
          { label: 'Current week (all models)', percent: Math.min(100, (weekUsed / (CAP[account] * 12)) * 100), resetsAtMs: weekStart + 7 * DAY }
        ]
      })
    }
  }
  db.writeQuota(pc.deviceId, samples)
  db.touch(pc.deviceId, now - 20_000, { version: '0.3.2', queue: 0, scanPct: 100 })
  db.touch(mac.deviceId, now - 2 * MIN, { version: '0.3.2', queue: 0, scanPct: 100 })
  db.touch('local-server', now - 40 * MIN, {})

  const server = createHttpServer(createHandler({ role: 'home', db, panelDir: join(ROOT, 'out/panel') }))
  await new Promise((r) => server.listen(PANEL_PORT, '127.0.0.1', r))
  return server
}

async function panelShots(chromium, errors) {
  await build({ configFile: join(ROOT, 'panel.vite.config.ts'), logLevel: 'warn' })
  // Merkez kodu TypeScript; Vite onu calisma aninda donusturur (paketleme gerekmez).
  const loader = await createServer({
    configFile: false,
    root: ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    // Yalniz sunucu modulleri yuklenir; tarayici bagimlilik taramasi gereksiz (panel HTML'ini tarayip @shared'i arardi).
    optimizeDeps: { noDiscovery: true, entries: [] },
    logLevel: 'warn'
  })
  const hub = await seededHub(loader, Date.now())
  const browser = await chromium.launch()
  try {
    for (const shot of [
      { file: 'panel.png', theme: 'dark', fullPage: true },
      { file: 'panel-light.png', theme: 'light', fullPage: false }
    ]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'en-US', deviceScaleFactor: 1 })
      await context.addInitScript((t) => localStorage.setItem('panel-theme', t), shot.theme)
      const page = await context.newPage()
      page.on('pageerror', (e) => errors.push(`${shot.file}: ${e.message}`))
      await page.goto(`http://127.0.0.1:${PANEL_PORT}/`)
      await page.waitForFunction(() => document.querySelector('h1') !== null && !/Loading/.test(document.body.innerText))
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(OUT, shot.file), fullPage: shot.fullPage })
      console.log(`${shot.file}  1280 genislik, ${shot.theme}`)
      await context.close()
    }
  } finally {
    await browser.close()
    hub.close()
    await loader.close()
  }
}

await mkdir(OUT, { recursive: true })
const chromium = await loadChromium()
const errors = []
await widgetShots(chromium, errors)
await panelShots(chromium, errors)
console.log(errors.length === 0 ? `\ngoruntuler -> ${OUT}, sayfa hatasi yok` : `\nHATALAR:\n${errors.join('\n')}`)
if (errors.length > 0) process.exitCode = 1
