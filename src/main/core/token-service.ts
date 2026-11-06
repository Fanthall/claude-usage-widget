/**
 * Token toplayici surecini baslatir, izler ve ozetini ana surece tasir.
 *
 * Surec beklenmedik kapanirsa bir dakika sonra yeniden baslatilir (en cok 5
 * kez ust uste); o surede arayuz "token sayilamiyor" der, eski sayiyi guncel
 * gibi gostermez.
 */

import { utilityProcess, type UtilityProcess } from 'electron'

import type { AccountKey, TokenState } from '../../shared/types'
import type { UsageGroup, UsageRow } from '../../collector/store'
import type { ScanSource } from '../../collector/types'
import { safeLog } from './log-safe'
import workerPath from '../token-worker?modulePath'
import type { AccountOrgs, HubSyncStatus, WorkerHub, WorkerMessage, WorkerRequest } from '../token-worker'

const RESTART_DELAY_MS = 60_000
const MAX_RESTARTS = 5
/** Yerel sorgu bu surede cevap vermezse panel hata gosterir; ilk tarama surerken SQLite mesgul olabilir. */
const QUERY_TIMEOUT_MS = 15_000

export interface HubSyncState {
  status: HubSyncStatus
  /** Merkeze gitmeyi bekleyen dakika sayisi. */
  queue: number
}

export interface TokenServiceOptions {
  dbFile: string
  sources: ScanSource[]
  keys: AccountKey[]
  orgs: AccountOrgs
  hub: WorkerHub | null
  onState: (state: TokenState) => void
  onHubState?: (state: HubSyncState) => void
}

export interface TokenService {
  setOrgs(orgs: AccountOrgs): void
  setHub(hub: WorkerHub | null): void
  rescan(): void
  /** Panel icin yerel satirlar (merkez yokken). Surec yoksa ya da sorgu patlarsa null. */
  usage(from: number, to: number, step: number, by: UsageGroup[], deviceId: string): Promise<UsageRow[] | null>
  stop(): void
}

export function startTokenService(options: TokenServiceOptions): TokenService {
  let child: UtilityProcess | null = null
  let stopped = false
  let restarts = 0
  let orgs = options.orgs
  let hub = options.hub
  let nextQueryId = 1
  const pending = new Map<number, (rows: UsageRow[] | null) => void>()

  function send(msg: WorkerRequest): void {
    child?.postMessage(msg)
  }

  function spawn(): void {
    const proc = utilityProcess.fork(workerPath, [], { serviceName: 'token-collector', stdio: 'pipe' })
    child = proc
    // Surecin kendi hata ciktisi tani kaydina gider; yoksa cokmenin nedeni gorunmez.
    proc.stderr?.on('data', (chunk: Buffer) => {
      safeLog('warn', 'toplayici sureci hata ciktisi', { detail: chunk.toString('utf8').slice(0, 500) })
    })
    let lastError: string | null = null
    let lastHubStatus: HubSyncStatus | null = null
    proc.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'usage') {
        pending.get(msg.id)?.(msg.rows)
        pending.delete(msg.id)
        return
      }
      if (msg.type === 'hub-state') {
        // Durum degisimi kayda gecer; her turda ayni satir yazilmaz.
        if (msg.status !== lastHubStatus) safeLog('debug', 'merkez gonderimi', { durum: msg.status, kuyruk: msg.queue })
        lastHubStatus = msg.status
        options.onHubState?.({ status: msg.status, queue: msg.queue })
        return
      }
      // Saglikli bir tur, ust uste cokme sayacini sifirlar.
      if (msg.state.error === null) restarts = 0
      // Ayni hata her turda tekrar yazilmaz; yenisi ya da ilki yazilir.
      if (msg.state.error !== null && msg.state.error !== lastError) {
        safeLog('warn', 'toplayici sureci hata bildirdi', { detail: msg.state.error })
      }
      lastError = msg.state.error
      options.onState(msg.state)
    })
    proc.on('exit', (code) => {
      child = null
      for (const resolve of pending.values()) resolve(null)
      pending.clear()
      if (stopped) return
      restarts += 1
      safeLog('warn', 'toplayici sureci kapandi', { code, restarts })
      options.onState({ accounts: [], progress: null, error: `toplayici kapandi (${code})` })
      if (restarts <= MAX_RESTARTS) setTimeout(() => !stopped && spawn(), RESTART_DELAY_MS)
    })
    // Baslatma istegi surec ayaga kalktiktan sonra gider; erken gonderilen
    // mesajin kuyruga alindigi belgelenmemis.
    proc.once('spawn', () => {
      safeLog('debug', 'toplayici sureci basladi', { pid: proc.pid })
      proc.postMessage({
        type: 'init',
        dbFile: options.dbFile,
        sources: options.sources,
        keys: options.keys,
        orgs
      } satisfies WorkerRequest)
      proc.postMessage({ type: 'hub', hub } satisfies WorkerRequest)
    })
  }

  spawn()

  return {
    setOrgs(next: AccountOrgs): void {
      orgs = next
      send({ type: 'orgs', orgs })
    },
    setHub(next: WorkerHub | null): void {
      hub = next
      send({ type: 'hub', hub })
    },
    rescan(): void {
      send({ type: 'rescan' })
    },
    usage(from, to, step, by, deviceId): Promise<UsageRow[] | null> {
      if (child === null) return Promise.resolve(null)
      const id = nextQueryId++
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve(null)
        }, QUERY_TIMEOUT_MS)
        pending.set(id, (rows) => {
          clearTimeout(timer)
          resolve(rows)
        })
        send({ type: 'usage', id, from, to, step, by, deviceId })
      })
    },
    stop(): void {
      stopped = true
      child?.kill()
      child = null
    }
  }
}
