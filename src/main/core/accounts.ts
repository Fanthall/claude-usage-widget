/**
 * Hesap basina olcum.
 *
 * Her hesabin kendi toplayicisi vardir; biri 429 alip geri cekilince digerinin
 * ritmi bozulmaz. Bu cihazda girisi olmayan hesap (Team henuz acilmamis) icin
 * toplayici KURULMAZ: olcum yapilmaz, sayi uydurulmaz, hata da sayilmaz. Hesap
 * belirli araliklarla yeniden yoklanir; giris yapildigi an olcum kendiliginden
 * baslar.
 */

import { ACCOUNT_KEYS, type AccountKey, type AccountPayload, type AuthStatus } from '../../shared/types'
import { createNodeTimers, type Collector, type CollectorState, type CollectorTimers, type TimerHandle } from './collector'
import { safeLog } from './log-safe'
import type { AccountPaths } from './paths'

/** Bagli olmayan hesap bu aralikla yeniden yoklanir. */
export const PRESENCE_RECHECK_MS = 5 * 60 * 1000

export type AccountPresence = 'connected' | 'not-connected'

/**
 * Hesap bu cihazda bagli mi.
 *
 * Hesap kaydinda `oauthAccount` varsa ya da jeton dosyasi duruyorsa baglidir.
 * Ikisine birden bakilir: macOS'ta jeton dosyasi yoktur (Anahtar Zinciri'nde
 * durur), Windows'ta ise hesap kaydi bir surum hatasiyla eksik kalabilir.
 * Jeton dosyasinin yalniz VARLIGINA bakilir, icerigi okunmaz.
 */
export async function detectPresence(
  paths: AccountPaths,
  readAuth: (accountFile: string) => Promise<AuthStatus>,
  exists: (file: string) => Promise<boolean>
): Promise<AccountPresence> {
  const auth = await readAuth(paths.accountFile)
  if (auth.loggedIn) return 'connected'
  return (await exists(paths.credentialsFile)) ? 'connected' : 'not-connected'
}

export interface AccountManagerDeps {
  /** Izlenecek hesaplar, gosterim sirasiyla. Varsayilan `ACCOUNT_KEYS`. */
  keys?: readonly AccountKey[]
  presence: (key: AccountKey) => Promise<AccountPresence>
  readAuth: (key: AccountKey) => Promise<AuthStatus | null>
  createCollector: (key: AccountKey) => Collector
  timers?: CollectorTimers
}

export interface AccountManager {
  /** Hesaplari yoklar, baglilarin olcumunu baslatir. */
  start(): Promise<void>
  stop(): void
  /** Gostergeye giden durum, `keys` sirasiyla. */
  accounts(): AccountPayload[]
  /** Hesabin toplayici durumu; bagli degilse null. */
  state(key: AccountKey): CollectorState | null
  /** Herhangi bir hesapta degisiklik oldugunda cagrilir. */
  onChange(listener: () => void): () => void
  /** Bagli olmayanlari yeniden yoklar, baglilari simdi olcer. */
  pollAll(): Promise<void>
  /** Bagli hesaplarin kimlik bilgisini yeniden okur. */
  refreshIdentity(): Promise<void>
}

interface Entry {
  collector: Collector | null
  auth: AuthStatus | null
  /** En az bir kez yoklandi mi; yoklanmadan "bagli degil" denmez. */
  checked: boolean
}

export function createAccountManager(deps: AccountManagerDeps): AccountManager {
  const keys = deps.keys ?? ACCOUNT_KEYS
  const timers = deps.timers ?? createNodeTimers()
  const entries = new Map<AccountKey, Entry>(
    keys.map((key) => [key, { collector: null, auth: null, checked: false }])
  )
  const listeners = new Set<() => void>()
  let running = false
  let recheckTimer: TimerHandle | null = null

  function entry(key: AccountKey): Entry {
    const found = entries.get(key)
    if (found === undefined) throw new Error(`bilinmeyen hesap: ${key}`)
    return found
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Bir dinleyicinin hatasi digerlerini durdurmaz.
      }
    }
  }

  async function readAuth(key: AccountKey): Promise<AuthStatus | null> {
    try {
      return await deps.readAuth(key)
    } catch (error: unknown) {
      safeLog('debug', 'hesap bilgisi okunamadi', { account: key, error })
      return null
    }
  }

  /** Bagli degilse yoklar; baglandiysa toplayiciyi kurup baslatir. */
  async function check(key: AccountKey): Promise<void> {
    const e = entry(key)
    if (e.collector !== null) return
    let presence: AccountPresence
    try {
      presence = await deps.presence(key)
    } catch {
      presence = 'not-connected'
    }
    e.checked = true
    if (!running || presence !== 'connected' || e.collector !== null) return

    e.auth = await readAuth(key)
    const collector = deps.createCollector(key)
    e.collector = collector
    collector.onChange(() => notify())
    collector.start()
    safeLog('debug', 'hesap bagli, olcum basladi', { account: key })
  }

  function scheduleRecheck(): void {
    if (recheckTimer !== null) {
      timers.clearTimeout(recheckTimer)
      recheckTimer = null
    }
    if (!running) return
    const pending = keys.filter((key) => entry(key).collector === null)
    if (pending.length === 0) return
    recheckTimer = timers.setTimeout(() => {
      recheckTimer = null
      void Promise.all(pending.map(check)).then(() => {
        notify()
        scheduleRecheck()
      })
    }, PRESENCE_RECHECK_MS)
  }

  return {
    async start(): Promise<void> {
      if (running) return
      running = true
      await Promise.all(keys.map(check))
      notify()
      scheduleRecheck()
    },

    stop(): void {
      running = false
      scheduleRecheck()
      for (const e of entries.values()) e.collector?.stop()
    },

    accounts(): AccountPayload[] {
      return keys.map((key) => {
        const e = entry(key)
        const state = e.collector?.getState() ?? null
        return {
          key,
          presence: e.collector !== null ? 'connected' : e.checked ? 'not-connected' : 'checking',
          status: state?.status ?? (e.checked ? { kind: 'no-data' } : { kind: 'loading' }),
          auth: e.auth,
          errorStreak: state?.errorStreak ?? 0
        }
      })
    },

    state(key: AccountKey): CollectorState | null {
      return entry(key).collector?.getState() ?? null
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async pollAll(): Promise<void> {
      await Promise.all(keys.map(check))
      await Promise.all(keys.map((key) => entry(key).collector?.pollNow()))
      notify()
      scheduleRecheck()
    },

    async refreshIdentity(): Promise<void> {
      await Promise.all(
        keys.map(async (key) => {
          const e = entry(key)
          if (e.collector !== null) e.auth = await readAuth(key)
        })
      )
    }
  }
}
