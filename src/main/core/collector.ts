/**
 * Periyodik olcum dongusu: `readUsage -> durum -> tarihce`.
 *
 * Gostergeye ciplak `UsageSnapshot` degil `UsageStatus` gider: kaynak dustugunde
 * ekranda eski yuzdenin sessizce durmasi engellenir (REQ-10).
 *
 * Olcum CLI metni ayristirmaz; veri `readUsage` ile disaridan gelir ve tazeleme
 * basarisizligi SINIFIYLA bildirilir (`usage-source.ts`). Toplayici bu sinifi
 * saklamaz: hem duruma yazar hem de 429'da yoklama araligini geri ceker.
 */

import {
  BACKOFF_FACTOR,
  CliError,
  DEFAULT_POLL_INTERVAL_MS,
  ERROR_STREAK_FOR_ALERT,
  MAX_BACKOFF_MS,
  staleThresholdMs,
  type CliErrorKind,
  type CollectorConfig,
  type UsageSnapshot,
  type UsageStatus
} from '../../shared/types'
import { appendSnapshot } from './history-store'

// ── Zamanlayici ──────────────────────────────────────────────────────────────

/** Zamanlayici kimligi. Sayidir, boylece sahte saat gercek Timeout uretmez. */
export type TimerHandle = number

/**
 * Enjekte edilebilir zamanlayici. Testler sahte saatle kosar; dakikalarca gercek
 * bekleme yapilmaz.
 */
export interface CollectorTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/**
 * Node zamanlayicisi. Handle olarak sayi doner; gercek `Timeout` nesnesi iceride
 * tutulur, boylece arayuz platformdan bagimsiz kalir.
 */
export function createNodeTimers(): CollectorTimers {
  const handles = new Map<TimerHandle, ReturnType<typeof setTimeout>>()
  let nextId = 1

  return {
    setTimeout(callback, ms) {
      const id = nextId
      nextId += 1
      handles.set(
        id,
        setTimeout(() => {
          handles.delete(id)
          callback()
        }, ms)
      )
      return id
    },
    clearTimeout(handle) {
      const timer = handles.get(handle)
      if (timer === undefined) return
      handles.delete(handle)
      clearTimeout(timer)
    }
  }
}

// ── Kaynak sozlesmesi ────────────────────────────────────────────────────────

/**
 * Kaynagin bir turdeki cevabi.
 *
 * `cached` = "tazeleme olmadi ama elde deger var". Deger gosterilir; `snapshot.at`
 * verinin sunucudan alindigi an oldugu icin bayatlik kendiliginden ortaya cikar.
 * Eski deger guncel gibi gosterilmez.
 */
export type UsageReadResult =
  | { kind: 'fresh'; snapshot: UsageSnapshot }
  | { kind: 'cached'; snapshot: UsageSnapshot; failure: CliErrorKind }
  | { kind: 'none'; failure: CliErrorKind; message: string }

/** Kaynak baglanmadiysa deger uydurulmaz; durum acikca hata olur. */
const NO_SOURCE: UsageReadResult = {
  kind: 'none',
  failure: 'unknown',
  message: 'kota kaynagi baglanmadi'
}

// ── Toplayici ────────────────────────────────────────────────────────────────

export interface CollectorState {
  status: UsageStatus
  /** Ust uste basarisizlik sayisi; taze olcumde sifirlanir. */
  errorStreak: number
  /** `errorStreak >= ERROR_STREAK_FOR_ALERT` — kullaniciya gorunur uyari (REQ-10 AC2). */
  alert: boolean
  /**
   * Son tazelemenin basarisizlik sinifi; son olcum tazeyse null. Deger
   * gosterilirken bile dolu olabilir: onbellekten okunan sayi gercektir ama
   * guncel degildir.
   */
  lastFailure: CliErrorKind | null
  /** Yururlukteki olcum araligi. 429'da buyur, taze olcumde tabana doner. */
  intervalMs: number
  /** Bir sonraki olcumun planlandigi an (epoch ms); zamanlayici yoksa null. */
  nextAttemptAtMs: number | null
  /** Tarihceye yazma hatasi. Olcumu gecersiz kilmaz, sessizce de yutulmaz. */
  historyError: string | null
}

export type StateListener = (state: CollectorState) => void

export interface CollectorDeps {
  /** Kota verisinin kaynagi. Verilmezse olcum hata durumuna duser. */
  readUsage?: () => Promise<UsageReadResult>
  appendSnapshot?: (dir: string, snapshot: UsageSnapshot) => Promise<unknown>
  now?: () => number
  timers?: CollectorTimers
}

/** `CollectorConfig` ile uyumlu; `dataDir` disindaki alanlarin varsayilani var. */
export interface CollectorInit {
  dataDir: string
  pollIntervalMs?: number
}

export interface Collector {
  start(): void
  stop(): void
  getState(): CollectorState
  /** Aboneligi biten fonksiyon doner. */
  onChange(listener: StateListener): () => void
  /** Simdi olc. Devam eden olcum varsa onun sonucunu doner (cift calistirma yok). */
  pollNow(): Promise<CollectorState>
}

const MAX_MESSAGE_LENGTH = 200

/** Loga ve arayuze giden metin: yalniz mesaj, ham cikti ve yigin izi degil. */
function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return 'bilinmeyen hata'
  return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH)}...` : clean
}

function errorKindOf(error: unknown): CliErrorKind {
  return error instanceof CliError ? error.kind : 'unknown'
}

export function createCollector(deps: CollectorDeps, config: CollectorInit): Collector {
  const dataDir = config.dataDir
  const baseIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const now = deps.now ?? Date.now
  const timers = deps.timers ?? createNodeTimers()
  const read = deps.readUsage ?? (async (): Promise<UsageReadResult> => NO_SOURCE)
  const persist =
    deps.appendSnapshot ?? ((dir: string, snapshot: UsageSnapshot) => appendSnapshot(dir, snapshot))

  let baseStatus: UsageStatus = { kind: 'no-data' }
  let lastSnapshot: UsageSnapshot | null = null
  let lastPersistedAt: number | null = null
  let errorStreak = 0
  let lastFailure: CliErrorKind | null = null
  let intervalMs = baseIntervalMs
  let nextAttemptAtMs: number | null = null
  let historyError: string | null = null

  let running = false
  let timer: TimerHandle | null = null
  let inFlight: Promise<CollectorState> | null = null
  let lastEmittedKind: UsageStatus['kind'] | null = null

  const listeners = new Set<StateListener>()

  /**
   * Bayatlik saatin fonksiyonudur, olcumun degil: saklanan 'ok' durumu okunurken
   * yasa gore 'stale'e cevrilir. Boylece bir sonraki olcum gelmese de gosterge
   * dogruyu soyler.
   *
   * Esik TABAN araliktan hesaplanir, geri cekilmis araliktan degil. Aksi halde
   * 429 backoff'u esigi de buyutur ve saatlerce eski veri "taze" gorunur.
   */
  function deriveStatus(): UsageStatus {
    if (baseStatus.kind !== 'ok') return baseStatus
    const ageMs = now() - baseStatus.snapshot.at
    if (ageMs <= staleThresholdMs(baseIntervalMs)) return baseStatus
    const seconds = Math.round(ageMs / 1000)
    const reason =
      lastFailure === null
        ? `veri ${seconds} sn once alindi`
        : `veri ${seconds} sn once alindi; tazeleme basarisiz (${lastFailure})`
    return { kind: 'stale', snapshot: baseStatus.snapshot, ageMs, reason }
  }

  function getState(): CollectorState {
    return {
      status: deriveStatus(),
      errorStreak,
      alert: errorStreak >= ERROR_STREAK_FOR_ALERT,
      lastFailure,
      intervalMs,
      nextAttemptAtMs,
      historyError
    }
  }

  function notify(): void {
    const state = getState()
    lastEmittedKind = state.status.kind
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // Bir dinleyicinin hatasi olcum dongusunu durdurmaz.
      }
    }
  }

  /** Saat ilerledigi icin degisen bayatlik durumunu yayina cikarir. */
  function notifyIfDerivedChanged(): void {
    if (lastEmittedKind === null) return
    if (deriveStatus().kind !== lastEmittedKind) notify()
  }

  function clearTimer(): void {
    nextAttemptAtMs = null
    if (timer === null) return
    timers.clearTimeout(timer)
    timer = null
  }

  function schedule(): void {
    if (!running) return
    clearTimer()
    nextAttemptAtMs = now() + intervalMs
    timer = timers.setTimeout(() => {
      timer = null
      nextAttemptAtMs = null
      void pollNow()
    }, intervalMs)
  }

  /** 429 = "cok sik sordun". Sinir acilana kadar aralik ustel olarak buyur. */
  function applyBackoff(failure: CliErrorKind): void {
    if (failure !== 'rate-limited') return
    intervalMs = Math.min(intervalMs * BACKOFF_FACTOR, MAX_BACKOFF_MS)
  }

  /**
   * Ayni `at` ikinci kez yazilmaz: onbellek tazelenmedigi surece her tur ayni
   * kaydi uretir, tarihce tekrarla siserdi.
   */
  async function persistOnce(snapshot: UsageSnapshot): Promise<void> {
    if (snapshot.at === lastPersistedAt) return
    try {
      await persist(dataDir, snapshot)
      lastPersistedAt = snapshot.at
      historyError = null
    } catch (error) {
      // Yazma hatasi olcumu gecersiz kilmaz; durum 'ok' kalir, hata gorunur olur.
      historyError = shortMessage(error)
    }
  }

  function toError(kind: CliErrorKind, message: string): void {
    errorStreak += 1
    lastFailure = kind
    applyBackoff(kind)
    baseStatus = { kind: 'error', errorKind: kind, message, lastSnapshot }
  }

  async function apply(result: UsageReadResult): Promise<void> {
    if (result.kind === 'none') {
      toError(result.failure, shortMessage(result.message))
      return
    }

    const snapshot = result.snapshot
    // Kaynak pencere uretemediyse gosterilecek deger yok; sifir uydurulmaz.
    if (snapshot.windows.length === 0) {
      toError('bad-output', 'kota penceresi yok')
      return
    }

    lastSnapshot = snapshot

    if (result.kind === 'fresh') {
      baseStatus = { kind: 'ok', snapshot }
      errorStreak = 0
      lastFailure = null
      intervalMs = baseIntervalMs
    } else {
      // Deger var ama tazeleme basarisiz: sayac isler, uyari esigi calisir.
      errorStreak += 1
      lastFailure = result.failure
      applyBackoff(result.failure)

      // Onbellek hala tazeyse deger guvenilir; gecici bir tazeleme hatasi
      // kullaniciyi kirmiziya bogmamali. Ama deger bayatladiysa SEBEBI
      // gorunmeli: "13 sa once" tek basina ne yapmasi gerektigini soylemez.
      // Bu, jeton suresi dolunca yasandi: widget bayat dedi, "oturum kapali"
      // demedi ve kullanici sebebi bilemedi.
      const age = now() - snapshot.at
      baseStatus =
        age > staleThresholdMs(baseIntervalMs)
          ? {
              kind: 'error',
              errorKind: result.failure,
              // Kullaniciya gorunen metin arayuzde errorKind-dan cevrilir;
              // buradaki mesaj tani icindir.
              message: `tazeleme basarisiz (${result.failure})`,
              lastSnapshot: snapshot
            }
          : { kind: 'ok', snapshot }
    }

    await persistOnce(snapshot)
  }

  async function poll(): Promise<void> {
    notifyIfDerivedChanged()

    if (lastSnapshot === null && baseStatus.kind !== 'loading') {
      baseStatus = { kind: 'loading' }
      notify()
    }

    await apply(await read())
  }

  function pollNow(): Promise<CollectorState> {
    const existing = inFlight
    if (existing !== null) return existing

    // Yayin planlamadan SONRA yapilir; boylece dinleyici bir sonraki denemenin
    // zamanini da gorur.
    const started = poll()
      .catch((error: unknown) => {
        toError(errorKindOf(error), shortMessage(error))
      })
      .then(() => {
        inFlight = null
        schedule()
        notify()
        return getState()
      })
    inFlight = started
    return started
  }

  return {
    start(): void {
      if (running) return
      running = true
      void pollNow()
    },
    stop(): void {
      running = false
      clearTimer()
    },
    getState,
    onChange(listener: StateListener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pollNow
  }
}

/** `CollectorConfig`ten toplayici kurar. */
export function collectorFromConfig(deps: CollectorDeps, config: CollectorConfig): Collector {
  return createCollector(deps, {
    dataDir: config.dataDir,
    pollIntervalMs: config.pollIntervalMs
  })
}
