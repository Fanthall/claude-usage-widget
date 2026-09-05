import type { StatePayload, UsageSnapshot, UsageStatus } from '@shared/types'

/**
 * Tarayicida (Electron olmadan) widget'i acabilmek icin sahte koprü.
 *
 * Yalniz `import.meta.env.DEV` altinda ve **yalniz gercek koprü YOKSA** kurulur:
 * Electron dev calistirmasinda preload `usageApi`yi zaten verir, bu kod hic
 * devreye girmez. Uretim paketinde ise `DEV` false oldugu icin tamamen elenir.
 * Boylece "preload dustu, kullanici sahte veriyi gercek sandi" durumu olusamaz.
 *
 * Ne ise yarar: durum matrisini (yukleniyor / veri yok / bayat / hata) tarayicida
 * gozle gezmek. Durum `?state=` sorgu parametresiyle secilir.
 */

function snapshot(
  session: number,
  week: number,
  fable: number,
  ageMs = 0
): UsageSnapshot {
  // `at` verinin sunucudan alindigi andir. Bayat durumlarda geriye alinir ki
  // onizleme gercek davranisi gostersin.
  const at = Date.now() - ageMs
  return {
    at,
    windows: [
      {
        label: 'Current session',
        percent: session,
        resetsAtRaw: 'Sep 5, 9:50pm (Europe/Istanbul)',
        resetsAtMs: at + 3 * 60 * 60 * 1000 + 18 * 60 * 1000
      },
      {
        label: 'Current week (all models)',
        percent: week,
        resetsAtRaw: 'Sep 6, 8am (Europe/Istanbul)',
        resetsAtMs: at + 13 * 60 * 60 * 1000
      },
      { label: 'Current week (Fable)', percent: fable, resetsAtRaw: '', resetsAtMs: null }
    ],
    unparsedLines: [],
    raw: ''
  }
}

const STATES: Record<string, UsageStatus> = {
  ok: { kind: 'ok', snapshot: snapshot(65, 28, 0) },
  caution: { kind: 'ok', snapshot: snapshot(82, 44, 12) },
  critical: { kind: 'ok', snapshot: snapshot(96, 71, 33) },
  loading: { kind: 'loading' },
  'no-data': { kind: 'no-data' },
  stale: {
    kind: 'stale',
    snapshot: snapshot(65, 28, 0, 7 * 60 * 1000),
    ageMs: 7 * 60 * 1000,
    reason: 'son basarili olcumun uzerinden 7 dk gecti'
  },
  error: {
    kind: 'error',
    errorKind: 'not-logged-in',
    message: 'oturum kapali — claude auth login',
    lastSnapshot: snapshot(65, 28, 0, 23 * 60 * 1000)
  },
  'error-bos': {
    kind: 'error',
    errorKind: 'not-found',
    message: 'claude calistirilabiliri bulunamadi',
    lastSnapshot: null
  }
}

export function installDevPreview(): void {
  if (!import.meta.env.DEV) return
  if (window.usageApi !== undefined) return

  const wanted = new URLSearchParams(window.location.search).get('state') ?? 'ok'
  const status = STATES[wanted] ?? STATES['ok']
  if (status === undefined) return
  const payload: StatePayload = {
    status,
    auth: null,
    sessions: null,
    errorStreak: 0,
    trayAvailable: true,
    // Onizlemede dil sorgudan secilebilir: ?lang=tr | ?lang=en
    lang: new URLSearchParams(window.location.search).get('lang') === 'tr' ? 'tr' : 'en'
  }

  window.usageApi = {
    // Gercek koprüde bu `process.platform`; onizlemede tarayici calisiyor.
    platform: 'linux',
    dragMode: 'manual',
    setTheme: () => Promise.resolve(),
    // Tarayicida pencere yok. Olcum yine de loglanir: gorunum basina istenen
    // boyutu Electron'u acmadan dogrulayabilmek icin.
    fitToContent: (width, height) => {
      // eslint-disable-next-line no-console
      console.info(`[dev-preview] fit -> ${Math.round(width)} x ${Math.round(height)}`)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
    setTrayIcon: () => undefined,
    dragStart: () => undefined,
    dragMove: () => undefined,
    dragEnd: () => undefined,
    get: () => Promise.resolve(payload),
    refresh: () => Promise.resolve(payload),
    onState: () => () => undefined
  }

  // Sahte veri sessizce gercek gibi gorunmemeli: kopru kuruldugunda ekranda
  // kalici bir isaret birakilir. Electron'da preload beklenmedik sekilde
  // dusseydi bu rozet hemen fark edilir.
  const rozet = document.createElement('div')
  rozet.textContent = `ÖNİZLEME · ${wanted}`
  rozet.setAttribute(
    'style',
    'position:fixed;left:0;bottom:0;z-index:9999;background:#e8a321;color:#18181b;' +
      'font:600 9px/1.4 system-ui,sans-serif;padding:1px 4px;letter-spacing:.04em;pointer-events:none'
  )
  document.body.appendChild(rozet)

  // eslint-disable-next-line no-console
  console.info(`[dev-preview] sahte koprü kuruldu (state=${wanted}) — veri GERÇEK DEĞİL`)
}
