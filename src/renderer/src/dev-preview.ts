import type {
  AccountKey,
  AccountPayload,
  AccountPresenceState,
  StatePayload,
  TokenState,
  UsageSnapshot,
  UsageStatus
} from '@shared/types'

/**
 * Onizleme token durumu (`?tokens=`): `ok` (varsayilan; tum cihazlar, bu cihazin payi), `device`
 * (merkez yok), `offline` (merkeze ulasilamadi), `scan` (ilk tarama
 * suruyor), `error`, `off` (toplayici henuz cevap vermedi). Sayilar sahte.
 */
function tokenState(wanted: string): TokenState | null {
  if (wanted === 'off') return null
  if (wanted === 'error') return { accounts: [], progress: null, error: 'onizleme hatasi' }
  const spark = (seed: number): number[] =>
    Array.from({ length: 36 }, (_, i) => Math.round((Math.sin(i / 4 + seed) + 1.3) * 60_000 + i * 2_000))
  return {
    accounts: [
      // Olculen (2026-11-06): son 15 dk PC 76 bin + Mac 862 bin = 938 bin; onbellekten okuma ~50 mn.
      { key: 'personal', last15m: 938_000, cacheRead15m: 49_600_000, today: 26_900_000, spark: spark(0), own: { last15m: 76_000, today: 25_400_000 } },
      { key: 'team', last15m: 180_000, cacheRead15m: 14_000_000, today: 3_100_000, spark: spark(2), own: { last15m: 0, today: 0 } }
    ],
    progress:
      wanted === 'scan'
        ? { phase: 'initial', doneBytes: 3.1e9, totalBytes: 8.7e9, badLines: 0 }
        : { phase: 'idle', doneBytes: 0, totalBytes: 0, badLines: 0 },
    error: null,
    scope: wanted === 'device' ? 'device' : wanted === 'offline' ? 'device-offline' : 'all'
  }
}

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

/**
 * Team hesabinin onizleme durumu (`?team=`): `off` bagli degil (bugunku durum),
 * `checking` yoklaniyor, digerleri `STATES` anahtarlari.
 */
function teamAccount(wanted: string): AccountPayload {
  if (wanted === 'off' || wanted === 'checking') {
    const presence: AccountPresenceState = wanted === 'off' ? 'not-connected' : 'checking'
    return {
      key: 'team',
      presence,
      status: wanted === 'off' ? { kind: 'no-data' } : { kind: 'loading' },
      auth: null,
      errorStreak: 0
    }
  }
  const status: UsageStatus =
    wanted === 'ok' ? { kind: 'ok', snapshot: snapshot(46, 40, 3) } : (STATES[wanted] ?? { kind: 'no-data' })
  return { key: 'team', presence: 'connected', status, auth: null, errorStreak: 0 }
}

export function installDevPreview(): void {
  if (!import.meta.env.DEV) return
  if (window.usageApi !== undefined) return

  const params = new URLSearchParams(window.location.search)
  const wanted = params.get('state') ?? 'ok'
  const status = STATES[wanted] ?? STATES['ok']
  if (status === undefined) return
  const teamWanted = params.get('team') ?? 'off'
  const focus: AccountKey = params.get('focus') === 'team' ? 'team' : 'personal'
  let payload: StatePayload = {
    accounts: [
      { key: 'personal', presence: 'connected', status, auth: null, errorStreak: 0 },
      teamAccount(teamWanted)
    ],
    focus,
    tokens: tokenState(params.get('tokens') ?? 'ok'),
    sessions: null,
    trayAvailable: true,
    // Onizlemede dil sorgudan secilebilir: ?lang=tr | ?lang=en
    lang: params.get('lang') === 'tr' ? 'tr' : 'en'
  }
  let listener: ((next: StatePayload) => void) | null = null

  window.usageApi = {
    // Gercek koprüde bu `process.platform`; onizlemede tarayici calisiyor.
    platform: 'linux',
    dragMode: 'manual',
    setTheme: () => Promise.resolve(),
    // Gercek ana surec secimi saklayip yeni durumu yayinlar; onizleme de oyle yapar.
    setAccount: (key) => {
      payload = { ...payload, focus: key }
      listener?.(payload)
      return Promise.resolve()
    },
    // Tarayicida pencere yok. Olcum yine de loglanir: gorunum basina istenen
    // boyutu Electron'u acmadan dogrulayabilmek icin.
    fitToContent: (width, height) => {
      // eslint-disable-next-line no-console
      console.info(`[dev-preview] fit -> ${Math.round(width)} x ${Math.round(height)}`)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
    openPanel: () => Promise.resolve(),
    setTrayIcon: () => undefined,
    dragStart: () => undefined,
    dragMove: () => undefined,
    dragEnd: () => undefined,
    get: () => Promise.resolve(payload),
    refresh: () => Promise.resolve(payload),
    onState: (handler) => {
      listener = handler
      return () => {
        listener = null
      }
    }
  }

  // Sahte veri sessizce gercek gibi gorunmemeli: kopru kuruldugunda ekranda
  // kalici bir isaret birakilir. Electron'da preload beklenmedik sekilde
  // dusseydi bu rozet hemen fark edilir.
  const rozet = document.createElement('div')
  rozet.textContent = `ÖNİZLEME · ${wanted} · team=${teamWanted}`
  rozet.setAttribute(
    'style',
    'position:fixed;left:0;bottom:0;z-index:9999;background:#e8a321;color:#18181b;' +
      'font:600 9px/1.4 system-ui,sans-serif;padding:1px 4px;letter-spacing:.04em;pointer-events:none'
  )
  document.body.appendChild(rozet)

  // eslint-disable-next-line no-console
  console.info(`[dev-preview] sahte koprü kuruldu (state=${wanted}) — veri GERÇEK DEĞİL`)
}
