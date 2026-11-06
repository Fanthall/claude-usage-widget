/**
 * Ana surecin merkez isleri: cihaz kaydi, kota ornegi gonderimi, nabiz ve
 * panelin okuma koprusu. Token sepetlerini toplayici sureci gonderir
 * (token-worker); burasi yalniz ana surecte duran veriyi tasir.
 *
 * Kota gonderiminde ayri kuyruk yok: tarihce dosyasi kuyruktur. Her turda
 * "en son gonderilen andan simdiye" okunur; merkez ayni ornegi bir kez saklar,
 * yeniden gonderim zararsizdir.
 */

import type { AccountKey } from '../../shared/types'
import type { UsageGroup, UsageRow } from '../../collector/store'
import type { HubConfig } from './config-store'
import { enrollDevice, isMainWindow, parseHubQuery, readTargets, sendToHub, writeTargets, type FetchFn } from './hub-client'

export interface QuotaSampleOut {
  account: AccountKey
  fetchedAt: number
  windows: Array<{ label: string; percent: number; resetsAtMs: number | null }>
}

export interface PanelResponse {
  ok: boolean
  /** Cevap merkezden degil, yalniz bu cihazin verisinden. */
  local: boolean
  body: unknown
}

export interface HubSyncDeps {
  fetch: FetchFn
  now: () => number
  accounts: readonly AccountKey[]
  getHub: () => HubConfig
  /** Kayit sonrasi anahtar konfige yazilir; toplayiciya da haber verilir. */
  saveHub: (hub: HubConfig) => Promise<void>
  deviceName: () => string
  os: string
  version: string
  /** Hesabin tarihcesindeki olcumler, `from` dahil `to` haric. */
  readQuota: (account: AccountKey, from: number, to: number) => Promise<QuotaSampleOut[]>
  /** Toplayicinin durumu (nabiz ve yerel cihaz satiri icin). */
  collectorInfo: () => { queue: number | null; scanPct: number | null }
  /** Merkez yokken panelin token satirlari. */
  localUsage: (from: number, to: number, step: number, by: UsageGroup[], deviceId: string) => Promise<UsageRow[] | null>
}

/** Ilk turda geriye bu kadar gidilir: panelin tahmin kalibrasyonu 14 gun ister. */
export const QUOTA_BACKFILL_MS = 14 * 24 * 60 * 60 * 1000
/** Merkezin tek istekte kabul ettigi en cok ornek 1000; pay birakilir. */
const QUOTA_SAMPLES_PER_REQUEST = 500

export type HubPhase = 'off' | 'waiting-enroll' | 'ok' | 'offline' | 'unauthorized'

export interface HubSync {
  /** Kayit (gerekirse) + kota + nabiz. Ayni anda iki tur calismaz. */
  tick(): Promise<HubPhase>
  /** Yalniz kota; yeni olcum gelince cagrilir. */
  flushQuota(): Promise<void>
  panelGet(path: string): Promise<PanelResponse>
  phase(): HubPhase
}

export function createHubSync(deps: HubSyncDeps): HubSync {
  const syncedUntil = new Map<AccountKey, number>()
  let phase: HubPhase = 'off'
  let running: Promise<HubPhase> | null = null
  let flushing: Promise<void> | null = null

  async function ensureEnrolled(): Promise<boolean> {
    const hub = deps.getHub()
    if (hub.key !== null) return true
    if (hub.lanUrl === null) return false
    const result = await enrollDevice(deps.fetch, hub.lanUrl, deps.deviceName(), deps.os)
    if (result === null) return false
    await deps.saveHub({ ...hub, key: result.key, deviceId: result.deviceId })
    return true
  }

  async function flushOnce(): Promise<void> {
    const targets = writeTargets(deps.getHub())
    if (targets.length === 0) return
    const now = deps.now()
    for (const account of deps.accounts) {
      const from = syncedUntil.get(account) ?? now - QUOTA_BACKFILL_MS
      const samples = await deps.readQuota(account, from, now + 1)
      for (let i = 0; i < samples.length; i += QUOTA_SAMPLES_PER_REQUEST) {
        const chunk = samples.slice(i, i + QUOTA_SAMPLES_PER_REQUEST)
        const res = await sendToHub(deps.fetch, targets, 'v1/quota', { samples: chunk })
        if (res.status !== 200) {
          phase = res.status === 401 ? 'unauthorized' : 'offline'
          return
        }
        const last = chunk[chunk.length - 1]
        if (last !== undefined) syncedUntil.set(account, last.fetchedAt + 1)
      }
      if (samples.length === 0 && !syncedUntil.has(account)) syncedUntil.set(account, from)
    }
  }

  function flushQuota(): Promise<void> {
    if (flushing !== null) return flushing
    flushing = flushOnce().finally(() => {
      flushing = null
    })
    return flushing
  }

  async function runTick(): Promise<HubPhase> {
    const hub = deps.getHub()
    if (hub.url === null && hub.lanUrl === null) return (phase = 'off')
    if (!(await ensureEnrolled())) return (phase = 'waiting-enroll')
    phase = 'ok'
    await flushQuota()
    if (phase !== 'ok') return phase
    const info = deps.collectorInfo()
    const res = await sendToHub(deps.fetch, writeTargets(deps.getHub()), 'v1/heartbeat', {
      version: deps.version,
      ...(info.queue === null ? {} : { queue: info.queue }),
      ...(info.scanPct === null ? {} : { scanPct: info.scanPct })
    })
    if (res.status !== 200) phase = res.status === 401 ? 'unauthorized' : 'offline'
    return phase
  }

  async function localAnswer(path: string): Promise<PanelResponse> {
    const query = parseHubQuery(path)
    if (query === null) return { ok: false, local: true, body: null }
    const now = deps.now()
    const hub = deps.getHub()
    const deviceId = hub.deviceId ?? 'local'
    if (query.kind === 'devices') {
      const info = deps.collectorInfo()
      return {
        ok: true,
        local: true,
        body: {
          devices: [
            { id: deviceId, name: deps.deviceName(), os: deps.os, version: deps.version, lastSeen: now, queue: info.queue, scanPct: info.scanPct }
          ]
        }
      }
    }
    if (query.kind === 'quota') {
      const samples: Array<Record<string, unknown>> = []
      for (const account of deps.accounts) {
        for (const s of await deps.readQuota(account, query.from, query.to)) {
          for (const w of s.windows) {
            if (query.mainOnly && !isMainWindow(w.label)) continue
            samples.push({ account, fetchedAt: s.fetchedAt, label: w.label, percent: Math.round(w.percent), resetsAtMs: w.resetsAtMs })
          }
        }
      }
      samples.sort((a, b) => (a['fetchedAt'] as number) - (b['fetchedAt'] as number))
      return { ok: true, local: true, body: { samples } }
    }
    const rows = await deps.localUsage(query.from, query.to, query.step, query.by as UsageGroup[], deviceId)
    return rows === null ? { ok: false, local: true, body: null } : { ok: true, local: true, body: { rows } }
  }

  return {
    tick(): Promise<HubPhase> {
      if (running !== null) return running
      running = runTick().finally(() => {
        running = null
      })
      return running
    },
    flushQuota,
    async panelGet(path: string): Promise<PanelResponse> {
      // Yalniz bilinen okuma yollari; panel baska bir uca istek attiramaz.
      if (parseHubQuery(path) === null) return { ok: false, local: false, body: null }
      const targets = readTargets(deps.getHub())
      if (targets.length > 0) {
        const res = await sendToHub(deps.fetch, targets, path, undefined)
        if (res.status === 200) return { ok: true, local: false, body: res.body }
      }
      return await localAnswer(path)
    },
    phase: () => phase
  }
}
