/**
 * Token toplayici sureci (Electron `utilityProcess`).
 *
 * Ilk tarama dakikalar surer ve SQLite yazimi zaman uyumludur; ana surecte
 * calissaydi widget ve tepsi o surede donardi. Bu surec kendi basina tarar,
 * her tur sonunda ozeti ana surece yollar.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { AccountKey, TokenScanProgress, TokenState } from '../shared/types'
import { scanOnce } from '../collector/scan'
import { UsageStore, type UsageGroup, type UsageRow } from '../collector/store'
import type { ScanSource } from '../collector/types'
import { prepareBuckets, sendToHub, type HubTarget } from './core/hub-client'

/** Iki tur arasi bekleme. Tur basina maliyet: degisen dosya yoksa ~1 sn stat. */
const RESCAN_MS = 30_000

export interface AccountOrgs {
  personal: string | null
  team: string | null
}

/** Merkeze gonderim ayari; null = merkez yok ya da cihaz kayitli degil. */
export interface WorkerHub {
  targets: HubTarget[]
  sendProjectNames: boolean
}

export type HubSyncStatus = 'off' | 'ok' | 'offline' | 'unauthorized'

export type WorkerRequest =
  | { type: 'init'; dbFile: string; sources: ScanSource[]; keys: AccountKey[]; orgs: AccountOrgs }
  | { type: 'orgs'; orgs: AccountOrgs }
  | { type: 'rescan' }
  | { type: 'hub'; hub: WorkerHub | null }
  | { type: 'usage'; id: number; from: number; to: number; step: number; by: UsageGroup[]; deviceId: string }

export type WorkerMessage =
  | { type: 'state'; state: TokenState }
  | { type: 'hub-state'; status: HubSyncStatus; queue: number }
  | { type: 'usage'; id: number; rows: UsageRow[] | null }

/** Tek istekte en cok bu kadar dakika; ilk gonderimde gecmisin tamami parca parca gider. */
const SYNC_MINUTES_PER_REQUEST = 500
/** Bir turda en cok bu kadar istek; kalan bir sonraki tura kalir, tur 30 sn surmez. */
const SYNC_REQUESTS_PER_TICK = 40

const port = process.parentPort

let hub: WorkerHub | null = null
let hubStatus: HubSyncStatus = 'off'
let syncing = false

let store: UsageStore | null = null
let sources: ScanSource[] = []
let keys: AccountKey[] = []
let orgs: AccountOrgs = { personal: null, team: null }
let progress: TokenScanProgress | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function send(state: TokenState): void {
  port.postMessage({ type: 'state', state } satisfies WorkerMessage)
}

function dayStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function applyOrgs(): void {
  if (store === null) return
  const pairs: Array<{ orgId: string; account: AccountKey }> = []
  if (orgs.personal !== null) pairs.push({ orgId: orgs.personal, account: 'personal' })
  if (orgs.team !== null) pairs.push({ orgId: orgs.team, account: 'team' })
  store.setOrgAccounts(pairs)
  if (orgs.personal !== null) store.mapOtherOrgs(orgs.personal, 'team')
}

function publish(): void {
  if (store === null) return
  const now = Date.now()
  send({ accounts: store.summary(keys, now, dayStart(now)), progress, error: null })
}

function sendHubState(): void {
  port.postMessage({ type: 'hub-state', status: hubStatus, queue: store?.pendingMinutes() ?? 0 } satisfies WorkerMessage)
}

/**
 * Gonderilmemis dakikalari merkeze yollar. Basarili istekten sonra yalniz o
 * istegin dakikalari isaretlenir; ag yoksa kayit yerelde bekler, kaybolmaz.
 */
async function syncHub(): Promise<void> {
  if (store === null || hub === null || hub.targets.length === 0 || syncing) return
  syncing = true
  try {
    for (let i = 0; i < SYNC_REQUESTS_PER_TICK; i++) {
      const batch = store.pendingBuckets(SYNC_MINUTES_PER_REQUEST)
      if (batch.minutes.length === 0) break
      const res = await sendToHub(fetch, hub.targets, 'v1/usage', {
        epoch: batch.epoch,
        buckets: prepareBuckets(batch.buckets, hub.sendProjectNames)
      })
      if (res.status === 200) {
        store.markSynced(batch.minutes, batch.maxSeq)
        hubStatus = 'ok'
        continue
      }
      hubStatus = res.status === 401 ? 'unauthorized' : 'offline'
      break
    }
  } finally {
    syncing = false
    sendHubState()
  }
}

async function tick(initial: boolean): Promise<void> {
  if (store === null || running) return
  running = true
  if (timer !== null) clearTimeout(timer)
  try {
    await scanOnce(
      store,
      sources,
      (p) => {
        progress = p
        publish()
      },
      initial
    )
    // Yeni oturumlarin kurumlari ancak tarandiktan sonra bilinir.
    if (orgs.personal !== null) store.mapOtherOrgs(orgs.personal, 'team')
    progress = { phase: 'idle', doneBytes: 0, totalBytes: 0, badLines: store.totalBadLines() }
    publish()
  } catch (error: unknown) {
    send({ accounts: [], progress: null, error: error instanceof Error ? error.message : String(error) })
  } finally {
    running = false
  }
  try {
    await syncHub()
  } finally {
    timer = setTimeout(() => void tick(false), RESCAN_MS)
  }
}

port.on('message', (event) => {
  const msg = event.data as WorkerRequest
  if (msg.type === 'init') {
    try {
      // Temiz kurulumda veri klasoru ilk kota olcumu yazilana kadar yok; SQLite
      // olmayan klasorde dosya acamaz ("unable to open database file", olculdu).
      mkdirSync(dirname(msg.dbFile), { recursive: true })
      store = new UsageStore(msg.dbFile)
    } catch (error: unknown) {
      send({ accounts: [], progress: null, error: error instanceof Error ? error.message : String(error) })
      return
    }
    sources = msg.sources
    keys = msg.keys
    orgs = msg.orgs
    applyOrgs()
    publish()
    void tick(true)
  } else if (msg.type === 'orgs') {
    orgs = msg.orgs
    applyOrgs()
    publish()
  } else if (msg.type === 'rescan') {
    void tick(false)
  } else if (msg.type === 'hub') {
    hub = msg.hub
    hubStatus = hub === null ? 'off' : hubStatus
    // Kayit yeni yapildiysa beklemeden gonder; tarama surerken store hazir olmayabilir.
    void syncHub()
  } else if (msg.type === 'usage') {
    let rows: UsageRow[] | null = null
    try {
      rows = store?.usageRows(msg.from, msg.to, msg.step, msg.by, msg.deviceId) ?? null
    } catch {
      rows = null
    }
    port.postMessage({ type: 'usage', id: msg.id, rows } satisfies WorkerMessage)
  }
})
