/**
 * Merkez (hub) istemcisi: kayit, gonderim ve panel okumalari icin ortak
 * yardimcilar. Electron'a bagli degil; hem ana surec hem toplayici sureci
 * (utilityProcess) kullanir, testte `fetch` enjekte edilir.
 *
 * Ag duzeni: `url` disaridan ulasilan adres (hangi tunel ya da vekil oldugu fark etmez), her istek
 * cihaz anahtari ister. `lanUrl` ev agi adresi: kayit yalniz oradan yapilir,
 * okuma anahtarsizdir. Gonderim once `url`, olmazsa `lanUrl` dener.
 */

import type { MinuteBucket } from '../../collector/store'

export interface HubTarget {
  url: string
  /** null: ev agi okumasi (anahtarsiz). */
  key: string | null
}

export interface HubSettings {
  url: string | null
  lanUrl: string | null
  key: string | null
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface HubResponse {
  /** 0: ag hatasi ya da zaman asimi. */
  status: number
  body: unknown
}

/** Disari giden istek bu kadar bekler; ev agi adresi disarida hic cevap vermeyebilir. */
export const HUB_TIMEOUT_MS = 10_000
export const HUB_LAN_TIMEOUT_MS = 3_000

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Yazma hedefleri: anahtar yoksa bos (kayit olmadan gonderim yok). */
export function writeTargets(hub: HubSettings): HubTarget[] {
  if (hub.key === null) return []
  const out: HubTarget[] = []
  if (hub.url !== null) out.push({ url: trimSlash(hub.url), key: hub.key })
  if (hub.lanUrl !== null) out.push({ url: trimSlash(hub.lanUrl), key: hub.key })
  return out
}

/** Okuma hedefleri: anahtarla disari, sonra ev agi (anahtarsiz da olur). */
export function readTargets(hub: HubSettings): HubTarget[] {
  const out: HubTarget[] = []
  if (hub.url !== null && hub.key !== null) out.push({ url: trimSlash(hub.url), key: hub.key })
  if (hub.lanUrl !== null) out.push({ url: trimSlash(hub.lanUrl), key: hub.key })
  return out
}

async function request(fetchFn: FetchFn, target: HubTarget, path: string, init: RequestInit, timeoutMs: number): Promise<HubResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (target.key !== null) headers['authorization'] = `Bearer ${target.key}`
    const res = await fetchFn(`${target.url}/${path.replace(/^\/+/, '')}`, { ...init, headers, signal: controller.signal })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  } catch {
    return { status: 0, body: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Hedefleri sirayla dener; ilk HTTP cevabi doner (401 dahil — anahtar yanlissa
 * ikinci adres de reddeder, denemek bosuna). Yalniz ag hatasi sonrakine gecer.
 */
export async function sendToHub(
  fetchFn: FetchFn,
  targets: readonly HubTarget[],
  path: string,
  body: unknown | undefined
): Promise<HubResponse> {
  let last: HubResponse = { status: 0, body: null }
  for (const [i, target] of targets.entries()) {
    const init: RequestInit = body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body) }
    last = await request(fetchFn, target, path, init, i === 0 ? HUB_TIMEOUT_MS : HUB_LAN_TIMEOUT_MS)
    if (last.status !== 0) return last
  }
  return last
}

/** Ev agindan kayit: cihaz kimligi ve anahtari doner. Basarisizsa null. */
export async function enrollDevice(
  fetchFn: FetchFn,
  lanUrl: string,
  name: string,
  os: string
): Promise<{ deviceId: string; key: string } | null> {
  const res = await request(
    fetchFn,
    { url: trimSlash(lanUrl), key: null },
    'v1/enroll',
    { method: 'POST', body: JSON.stringify({ name, os }) },
    HUB_LAN_TIMEOUT_MS
  )
  const b = res.body as { deviceId?: unknown; key?: unknown } | null
  if (res.status !== 200 || typeof b?.deviceId !== 'string' || typeof b.key !== 'string') return null
  return { deviceId: b.deviceId, key: b.key }
}

/**
 * Proje adi gonderilmiyorsa ayni dakika + hesap + model + alt ajan sepetleri
 * birlestirilir. Birlestirilmezse merkezde ayni anahtara dusen satirlar
 * birbirinin uzerine yazilir ve token kaybolur.
 */
export function prepareBuckets(buckets: readonly MinuteBucket[], sendProjectNames: boolean): MinuteBucket[] {
  if (sendProjectNames) return [...buckets]
  const merged = new Map<string, MinuteBucket>()
  for (const b of buckets) {
    const key = `${b.minute}|${b.account}|${b.model}|${b.subagent ? 1 : 0}`
    const prev = merged.get(key)
    if (prev === undefined) {
      merged.set(key, { ...b, project: null })
      continue
    }
    prev.input += b.input
    prev.output += b.output
    prev.cacheWrite5m += b.cacheWrite5m
    prev.cacheWrite1h += b.cacheWrite1h
    prev.cacheRead += b.cacheRead
    prev.requests += b.requests
  }
  return [...merged.values()]
}

/** Panelin istedigi goreli yol; yerel cevap icin ayristirilir. Taninmayan yol null. */
export type HubQuery =
  | { kind: 'usage'; from: number; to: number; step: number; by: string[] }
  | { kind: 'quota'; from: number; to: number; mainOnly: boolean }
  | { kind: 'devices' }

const USAGE_GROUPS = new Set(['account', 'device', 'model', 'project', 'subagent'])
/** Yerel cevapta da merkezdeki sinir: 20 000 dilimden fazlasi reddedilir. */
const MAX_SLICES = 20_000

export function parseHubQuery(path: string): HubQuery | null {
  // Yalniz goreli `v1/...`; tam adres verilirse merkezin adresine eklenip garip bir istek olusurdu.
  if (!/^\/?v1\//.test(path)) return null
  let url: URL
  try {
    url = new URL(path, 'http://panel/')
  } catch {
    return null
  }
  const num = (name: string): number | null => {
    const v = url.searchParams.get(name)
    if (v === null || !/^\d+$/.test(v)) return null
    return Number(v)
  }
  if (url.pathname === '/v1/devices') return { kind: 'devices' }
  const from = num('from')
  const to = num('to')
  if (from === null || to === null || to <= from) return null
  if (url.pathname === '/v1/quota') return { kind: 'quota', from, to, mainOnly: url.searchParams.get('kind') === 'main' }
  if (url.pathname === '/v1/usage') {
    const step = num('step')
    const by = (url.searchParams.get('by') ?? 'account').split(',').filter((f) => f !== '')
    if (step === null || step < 60_000 || (to - from) / step > MAX_SLICES) return null
    if (!by.every((f) => USAGE_GROUPS.has(f))) return null
    return { kind: 'usage', from, to, step, by }
  }
  return null
}

/**
 * Ana kota penceresi: 5 saatlik oturum ya da tum modellerin haftasi. Hesapta
 * 5 saatlik pencere olmayabilir (olculdu: kisisel hesapta 2026-10-31'den beri
 * yok); o zaman haftalik pencere ana penceredir.
 */
export function isMainWindow(label: string): boolean {
  return /session/i.test(label) || (/week/i.test(label) && /all/i.test(label))
}
