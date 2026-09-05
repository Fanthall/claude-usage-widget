/**
 * Kota verisinin kaynagi.
 *
 * ESKI YOL (birakildi): `claude -p "/usage"` cagirip **metin** ciktisini
 * ayristirmak. Olculdu (2026-09-05): bu yol basarisizligi GIZLIYOR — uc 429
 * dondugunde CLI `200` alip bos govdeyi yutuyor, sonra sessizce eski onbellegi
 * guncelmis gibi yazdiriyor. Widget 20 dakikalik veriyi canli sandi.
 *
 * YENI YOL, iki parca:
 *   1. `~/.claude.json > cachedUsageUtilization` — **yapisal** veri (`limits[]`)
 *      ve en onemlisi `fetchedAtMs`: verinin gercek yasi. Metin ayristirmasi yok.
 *   2. `GET /api/oauth/usage` — tazeleme. Durum kodunu BIZ goruruz; 429 sessizce
 *      yutulmaz, geri cekilmeye doner.
 *
 * Onbellek dosyasina YAZILMAZ (CONSTRAINT-7): `~/.claude/` yalnizca okunur.
 */

import type { UsageSnapshot, UsageWindow } from '../../shared/types'

/** Uc, dokumante degil. Kesif: `claude --debug-file` ciktisinda `fetchUtilization`. */
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

export type FetchFailure = 'rate-limited' | 'unauthorized' | 'bad-body' | 'network'

export interface FetchOk {
  ok: true
  /** Verinin sunucudan alindigi an. */
  fetchedAtMs: number
  windows: UsageWindow[]
}

export interface FetchErr {
  ok: false
  kind: FetchFailure
  /** Sunucunun onerdigi bekleme (sn); yoksa null. */
  retryAfterSec: number | null
  message: string
}

export type FetchResult = FetchOk | FetchErr

// ── limits[] -> UsageWindow[] ────────────────────────────────────────────────

interface RawLimit {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

/**
 * Etiketler `/usage` metnindeki adlarla AYNI tutulur. Boylece kisaltma, odak
 * secimi ve tepsi mantigi degismeden calisir; degisen yalnizca veri yoludur.
 */
function labelFor(limit: RawLimit): string | null {
  const kind = typeof limit.kind === 'string' ? limit.kind : null
  if (kind === 'session') return 'Current session'
  if (kind === 'weekly_all') return 'Current week (all models)'
  if (kind === 'weekly_scoped') {
    const name = limit.scope?.model?.display_name
    return typeof name === 'string' && name !== '' ? `Current week (${name})` : 'Current week'
  }
  return null
}

function toWindow(limit: RawLimit): UsageWindow | null {
  const label = labelFor(limit)
  if (label === null) return null
  const percent = typeof limit.percent === 'number' ? limit.percent : null
  if (percent === null || !Number.isFinite(percent)) return null

  // `resets_at` ISO-8601; cozulemezse null — tahmin uretilmez.
  const raw = typeof limit.resets_at === 'string' ? limit.resets_at : ''
  const parsed = raw === '' ? NaN : Date.parse(raw)
  return {
    label,
    percent: Math.min(100, Math.max(0, Math.round(percent))),
    resetsAtRaw: raw,
    resetsAtMs: Number.isFinite(parsed) ? parsed : null
  }
}

/** `utilization.limits` dizisini pencerelere cevirir. Taninmayan kind atlanir. */
export function windowsFromLimits(value: unknown): UsageWindow[] {
  if (typeof value !== 'object' || value === null) return []
  const limits = (value as { limits?: unknown }).limits
  if (!Array.isArray(limits)) return []
  const out: UsageWindow[] = []
  for (const item of limits) {
    if (typeof item !== 'object' || item === null) continue
    const w = toWindow(item as RawLimit)
    if (w !== null) out.push(w)
  }
  return out
}

// ── Onbellek okuma ───────────────────────────────────────────────────────────

export interface CachedUtilization {
  fetchedAtMs: number
  windows: UsageWindow[]
}

/**
 * `~/.claude.json` icindeki son bilinen kota verisi. Bizim yazdigimiz bir sey
 * degil; CLI'in birakti§i iz. Tazeleme calismadiginda gosterilecek tek gercek
 * veri budur — ama **yasiyla birlikte** gosterilir.
 */
export function parseCachedUtilization(text: string): CachedUtilization | null {
  let root: unknown
  try {
    // BOM'lu dosya JSON.parse'i patlatir; elle duzenlenmis olabilir.
    root = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (typeof root !== 'object' || root === null) return null
  const cached = (root as { cachedUsageUtilization?: unknown }).cachedUsageUtilization
  if (typeof cached !== 'object' || cached === null) return null

  const fetchedAtMs = (cached as { fetchedAtMs?: unknown }).fetchedAtMs
  if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return null

  const windows = windowsFromLimits((cached as { utilization?: unknown }).utilization)
  if (windows.length === 0) return null
  return { fetchedAtMs, windows }
}

// ── Canli tazeleme ───────────────────────────────────────────────────────────

export type TokenReader = () => Promise<string | null>
export type FetchFn = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export interface FetchDeps {
  /** Erisim jetonunu dondurur. Deger LOGLANMAZ, saklanmaz, geri dondurulmez. */
  readToken: TokenReader
  fetchFn?: FetchFn
  now?: () => number
}

function retryAfterOf(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get('retry-after')
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Kota verisini ucdan tazeler.
 *
 * Basarisizlik SINIFLANDIRILIR ve cagirana aynen bildirilir — CLI'in yaptigi
 * gibi "200 ama bos govde" durumu basari sayilmaz.
 */
export async function fetchUtilization(deps: FetchDeps): Promise<FetchResult> {
  const now = deps.now ?? Date.now
  const doFetch = deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn)

  const token = await deps.readToken()
  if (token === null || token === '') {
    return { ok: false, kind: 'unauthorized', retryAfterSec: null, message: 'oturum bulunamadi' }
  }

  let status: number
  let headers: { get(name: string): string | null }
  let body: string
  try {
    const res = await doFetch(USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json'
      }
    })
    status = res.status
    headers = res.headers
    body = await res.text()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'aga erisilemedi'
    return { ok: false, kind: 'network', retryAfterSec: null, message }
  }

  if (status === 429) {
    return {
      ok: false,
      kind: 'rate-limited',
      retryAfterSec: retryAfterOf(headers),
      message: 'kota ucu hiz sinirinda'
    }
  }
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'unauthorized', retryAfterSec: null, message: 'yetki reddedildi' }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, kind: 'network', retryAfterSec: null, message: `HTTP ${status}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, kind: 'bad-body', retryAfterSec: null, message: 'govde JSON degil' }
  }

  // 200 + govde var ama alan yok: CLI bunu sessizce yutuyordu, biz yutmuyoruz.
  const windows = windowsFromLimits(parsed)
  if (windows.length === 0) {
    return { ok: false, kind: 'bad-body', retryAfterSec: null, message: 'govdede kota alani yok' }
  }
  return { ok: true, fetchedAtMs: now(), windows }
}

// ── Anlik goruntuye cevirme ──────────────────────────────────────────────────

/**
 * `at` alani **verinin sunucudan alindigi an**dir, bizim okudugumuz an degil.
 * Bayatlik hesabi buna dayandigi icin, tazeleme calismadiginda gosterge
 * kendiliginden "bayat" der — eski deger guncel gibi gosterilemez.
 */
export function toSnapshot(fetchedAtMs: number, windows: UsageWindow[]): UsageSnapshot {
  return { at: fetchedAtMs, windows, unparsedLines: [], raw: '' }
}
