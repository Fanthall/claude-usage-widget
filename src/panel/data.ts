/**
 * Panelin veri katmani ve hesaplari. React'ten ayri: test ortaminda DOM yok,
 * kararlar (dilimleme, tepeler, isi haritasi, kota cizgisi, dolma tahmini)
 * burada sinanir.
 */

import type { Lang } from '@shared/i18n'
import type { AccountKey } from '@shared/types'

export interface UsageRow {
  atMs: number
  account?: AccountKey
  device?: string
  model?: string
  project?: string | null
  total: number
  output: number
  input: number
  cacheWrite: number
  cacheRead: number
  requests: number
}

export interface QuotaRow {
  account: AccountKey
  fetchedAt: number
  label: string
  percent: number
  resetsAtMs: number | null
}

export interface DeviceRow {
  id: string
  name: string
  os: string | null
  version: string | null
  lastSeen: number | null
  queue: number | null
  scanPct: number | null
}

/** Merkez (ayni koken) ya da widget'in ana sureci; panel kodu ikisini ayirt etmez. */
export interface DataSource {
  usage(from: number, to: number, step: number, by: string[]): Promise<UsageRow[]>
  /** `main`: yalniz ana pencereler (5 saatlik + tum modellerin haftasi). */
  quota(from: number, to: number, kind?: 'main'): Promise<QuotaRow[]>
  devices(): Promise<DeviceRow[]>
  /** Son yanit merkezden degil, yalniz bu cihazin toplayicisindan geldiyse true. */
  isLocal?(): boolean
}

/**
 * `fresh`: giris + cikti + onbellege yazma (varsayilan). `total` onbellekten okumayi da katar;
 * her istek tum baglami yeniden okudugu icin o sayi ~100 kat buyuk ve "harcanan" gibi okunmaz.
 */
export type Metric = 'fresh' | 'total' | 'output'

export function metricValue(r: UsageRow, metric: Metric): number {
  return metric === 'fresh' ? r.total - r.cacheRead : r[metric]
}
export type RangeKind = 'today' | 'yesterday' | '7d' | '30d'

export const HOUR = 3_600_000
export const DAY = 24 * HOUR

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Secilen aralik, yerel saate gore. "Bugun" gece yarisindan simdiye degil, gun sonuna kadar cizilir. */
export function rangeFor(kind: RangeKind, now: number): { from: number; to: number } {
  const today = startOfDay(now)
  switch (kind) {
    case 'today':
      return { from: today, to: today + DAY }
    case 'yesterday':
      return { from: today - DAY, to: today }
    case '7d':
      return { from: today - 6 * DAY, to: today + DAY }
    case '30d':
      return { from: today - 29 * DAY, to: today + DAY }
  }
}

export interface StackBucket {
  atMs: number
  personal: number
  team: number
}

/** Hesap basina satirlari esit dilimlere dizer; bos dilim 0. */
export function stackSeries(rows: readonly UsageRow[], from: number, to: number, step: number, metric: Metric): StackBucket[] {
  const n = Math.max(0, Math.ceil((to - from) / step))
  const out: StackBucket[] = Array.from({ length: n }, (_, i) => ({ atMs: from + i * step, personal: 0, team: 0 }))
  for (const r of rows) {
    const i = Math.floor((r.atMs - from) / step)
    const b = out[i]
    if (b === undefined || r.account === undefined) continue
    b[r.account] += metricValue(r, metric)
  }
  return out
}

/** En yogun dilimler; etiketler ust uste binmesin diye birbirinden en az `minGap` dilim uzak. */
export function peaks(buckets: readonly StackBucket[], count: number, minGap: number, show: Record<AccountKey, boolean>): number[] {
  const value = (b: StackBucket): number => (show.personal ? b.personal : 0) + (show.team ? b.team : 0)
  const order = buckets
    .map((b, i) => [i, value(b)] as const)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  const picked: number[] = []
  for (const [i] of order) {
    if (picked.length >= count) break
    if (picked.every((j) => Math.abs(i - j) >= minGap)) picked.push(i)
  }
  return picked
}

/** Saat x gun: son 7 gun, her hucre o saatin toplami. Satir gun, sutun saat (0-23). */
export function heatCells(rows: readonly UsageRow[], now: number, metric: Metric): Array<{ dayMs: number; hours: number[] }> {
  const first = startOfDay(now) - 6 * DAY
  const days = Array.from({ length: 7 }, (_, d) => ({ dayMs: first + d * DAY, hours: new Array<number>(24).fill(0) }))
  for (const r of rows) {
    const d = Math.floor((startOfDay(r.atMs) - first) / DAY)
    const h = new Date(r.atMs).getHours()
    const day = days[d]
    if (day !== undefined) day.hours[h] = (day.hours[h] ?? 0) + metricValue(r, metric)
  }
  return days
}

/** 0-5 kademe; 0 bos. Esikler en buyuk hucreye gore (gunden gune olcek degisir). */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio < 0.1) return 1
  if (ratio < 0.3) return 2
  if (ratio < 0.55) return 3
  if (ratio < 0.8) return 4
  return 5
}

/** Ana pencere turu: 5 saatlik oturum ya da (o yoksa) tum modellerin haftasi. */
export type MainWindowKind = 'session' | 'week'

export function windowKind(label: string): MainWindowKind | null {
  if (/session/i.test(label)) return 'session'
  if (/week/i.test(label) && /all/i.test(label)) return 'week'
  return null
}

/** Hesap basina bir pencerenin cizgisi: zaman sirali yuzde noktalari. */
export function windowLine(rows: readonly QuotaRow[], account: AccountKey, kind: MainWindowKind): Array<{ atMs: number; percent: number }> {
  return rows
    .filter((r) => r.account === account && windowKind(r.label) === kind)
    .sort((a, b) => a.fetchedAt - b.fetchedAt)
    .map((r) => ({ atMs: r.fetchedAt, percent: r.percent }))
}

/** Hesabin son kota ornegindeki pencereler. */
export function latestQuota(rows: readonly QuotaRow[], account: AccountKey): QuotaRow[] {
  const mine = rows.filter((r) => r.account === account)
  const last = Math.max(-Infinity, ...mine.map((r) => r.fetchedAt))
  return mine.filter((r) => r.fetchedAt === last)
}

/**
 * Hesabin ana penceresi SON ornege gore secilir: 5 saatlik pencere varsa o,
 * yoksa tum modellerin haftasi. Gecmiste oturum penceresi olmasi yetmez —
 * olculdu: kisisel hesapta 2026-10-31'den beri API 5 saatlik pencere dondurmuyor.
 */
export function mainWindow(latest: readonly QuotaRow[]): { kind: MainWindowKind; row: QuotaRow } | null {
  const session = latest.find((r) => windowKind(r.label) === 'session')
  if (session !== undefined) return { kind: 'session', row: session }
  const week = latest.find((r) => windowKind(r.label) === 'week')
  return week === undefined ? null : { kind: 'week', row: week }
}

/** Dolma tahmininde egimin bakildigi sure: oturumda son 2 saat, haftada son 24 saat. */
export const FILL_LOOKBACK: Record<MainWindowKind, number> = { session: 2 * HOUR, week: DAY }

/**
 * Bu hizla pencere ne zaman dolar. Son `lookbackMs` icindeki orneklerden egim;
 * pencere sifirlanmadan dolmuyorsa ya da veri yetmiyorsa null.
 */
export function fillTime(
  line: ReadonlyArray<{ atMs: number; percent: number }>,
  now: number,
  resetsAtMs: number | null,
  lookbackMs = FILL_LOOKBACK.session
): number | null {
  const recent = line.filter((p) => p.atMs >= now - lookbackMs)
  if (recent.length < 2) return null
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (first === undefined || last === undefined) return null
  // Aralikta sifirlanma olduysa egim anlamsiz.
  if (recent.some((p, i) => i > 0 && p.percent < (recent[i - 1]?.percent ?? 0))) return null
  const perMs = (last.percent - first.percent) / (last.atMs - first.atMs)
  if (!(perMs > 0)) return null
  const at = last.atMs + (100 - last.percent) / perMs
  if (resetsAtMs !== null && at >= resetsAtMs) return null
  return at
}

/** Bir alana gore toplamlar, buyukten kucuge. */
export function breakdown(rows: readonly UsageRow[], field: 'device' | 'model' | 'project', metric: Metric): Array<{ key: string | null; value: number }> {
  const sums = new Map<string | null, number>()
  for (const r of rows) {
    const key = (r[field] ?? null) as string | null
    sums.set(key, (sums.get(key) ?? 0) + metricValue(r, metric))
  }
  return [...sums.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value)
}

type QuotaPoint = { atMs: number; percent: number }

/** Kota cizgisini sifirlanmalardan boler; her parca artan (ya da sabit) bir dizi. */
function segments(line: readonly QuotaPoint[]): QuotaPoint[][] {
  const out: QuotaPoint[][] = []
  let cur: QuotaPoint[] = []
  for (const p of line) {
    const prev = cur[cur.length - 1]
    if (prev !== undefined && p.percent < prev.percent) {
      out.push(cur)
      cur = []
    }
    cur.push(p)
  }
  if (cur.length > 0) out.push(cur)
  return out
}

function tokensBetween(rows: readonly UsageRow[], from: number, to: number): number {
  let n = 0
  // Onbellek okumasi kotada dusuk agirlikli; katilirsa oran gurultuye boguluyor.
  for (const r of rows) if (r.atMs >= from && r.atMs < to) n += metricValue(r, 'fresh')
  return n
}

/** Kalibrasyon icin bir pencerede en az bu kadar artis gerekir; kucuk artista oran gurultulu. */
const CALIBRATION_MIN_RISE = 5

/**
 * Toplayicisi olmayan yerden (telefon, claude.ai, bulut) harcamanin kaba tahmini.
 *
 * Gecmis 5 saatlik pencerelerden "yuzde puan basina token" orani cikarilir;
 * aralikta kotanin artisi kayitli tokenlerle karsilastirilir. Oranin ust ceyregi
 * alinir: toplayicisiz kullanim bir pencerenin oranini yalniz DUSURUR (token
 * gelmeden kota artar), en temiz pencereler ustte kalir.
 *
 * Model agirliklari farkli oldugu icin kesin degildir; arayuzde "tahmin" yazar.
 * Yeterli olcum yoksa null.
 */
export function unattributedShare(
  line: readonly QuotaPoint[],
  rows: readonly UsageRow[],
  from: number,
  to: number
): { rise: number; explained: number } | null {
  const segs = segments(line)
  const ratios: number[] = []
  for (const s of segs) {
    const first = s[0]
    const last = s[s.length - 1]
    if (first === undefined || last === undefined) continue
    const rise = last.percent - first.percent
    if (rise < CALIBRATION_MIN_RISE) continue
    const tokens = tokensBetween(rows, first.atMs, last.atMs)
    if (tokens > 0) ratios.push(tokens / rise)
  }
  if (ratios.length < 2) return null
  ratios.sort((a, b) => a - b)
  const perPercent = ratios[Math.floor(ratios.length * 0.75)] ?? ratios[ratios.length - 1]
  if (perPercent === undefined || perPercent <= 0) return null

  let rise = 0
  let tokens = 0
  for (const s of segs) {
    const inside = s.filter((p) => p.atMs >= from && p.atMs < to)
    const first = inside[0]
    const last = inside[inside.length - 1]
    if (first === undefined || last === undefined || inside.length < 2) continue
    rise += last.percent - first.percent
    tokens += tokensBetween(rows, first.atMs, last.atMs)
  }
  if (rise < 2) return null
  return { rise, explained: Math.min(1, tokens / perPercent / rise) }
}

/** Merkez API yollari; ayni koken de Electron koprusu de bu goreli yollari ister. */
export function usagePath(from: number, to: number, step: number, by: readonly string[]): string {
  return `v1/usage?from=${from}&to=${to}&step=${step}&by=${by.join(',')}`
}

export function quotaPath(from: number, to: number, kind?: 'main'): string {
  return `v1/quota?from=${from}&to=${to}${kind === undefined ? '' : `&kind=${kind}`}`
}

export const DEVICES_PATH = 'v1/devices'

/** Bir `get(yol)` fonksiyonundan veri kaynagi. */
export function sourceFrom(get: (path: string) => Promise<unknown>, isLocal?: () => boolean): DataSource {
  return {
    usage: async (from, to, step, by) => ((await get(usagePath(from, to, step, by))) as { rows: UsageRow[] }).rows,
    quota: async (from, to, kind) => ((await get(quotaPath(from, to, kind))) as { samples: QuotaRow[] }).samples,
    devices: async () => ((await get(DEVICES_PATH)) as { devices: DeviceRow[] }).devices,
    ...(isLocal === undefined ? {} : { isLocal })
  }
}

/** Ayni koken (merkezin kendi sayfasi). Okuma evde anahtarsiz. */
export function sameOriginSource(): DataSource {
  return sourceFrom(async (path) => {
    const res = await fetch(path, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as unknown
  })
}

/** Widget penceresindeki panel: ana surec merkeze anahtarla gider, yoksa yerel toplayiciya duser. */
export interface PanelBridge {
  get(path: string): Promise<{ ok: boolean; local: boolean; body: unknown }>
  lang(): Promise<Lang>
}

export function bridgeSource(bridge: PanelBridge): DataSource {
  let local = false
  return sourceFrom(
    async (path) => {
      const res = await bridge.get(path)
      if (!res.ok) throw new Error('panel bridge failed')
      local = res.local
      return res.body
    },
    () => local
  )
}
