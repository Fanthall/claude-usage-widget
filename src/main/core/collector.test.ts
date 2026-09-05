import { describe, expect, it } from 'vitest'

import {
  BACKOFF_FACTOR,
  CliError,
  DEFAULT_POLL_INTERVAL_MS,
  ERROR_STREAK_FOR_ALERT,
  MAX_BACKOFF_MS,
  staleThresholdMs,
  type CliErrorKind,
  type UsageSnapshot,
  type UsageStatus
} from '../../shared/types'
import {
  createCollector,
  type Collector,
  type CollectorState,
  type CollectorTimers,
  type TimerHandle,
  type UsageReadResult
} from './collector'

const DATA_DIR = 'C:/data/claude-usage-widget'

/** Olcum ani: 5 Eyl 2026 16:00 (Europe/Istanbul). */
const START_MS = Date.UTC(2026, 8, 5, 13, 0)

const MINUTE = 60 * 1000

/** Varsayilan aralikta bayatlik esigi: 12,5 dk (5 dk x 2,5). */
const DEFAULT_STALE_MS = staleThresholdMs(DEFAULT_POLL_INTERVAL_MS)

function snap(atMs: number, percent: number): UsageSnapshot {
  return {
    at: atMs,
    windows: [
      {
        label: 'Current session',
        percent,
        resetsAtRaw: '2026-09-05T13:50:00Z',
        resetsAtMs: Date.parse('2026-09-05T13:50:00Z')
      },
      {
        label: 'Current week (all models)',
        percent: 20,
        resetsAtRaw: '2026-09-06T05:00:00Z',
        resetsAtMs: Date.parse('2026-09-06T05:00:00Z')
      }
    ],
    unparsedLines: [],
    raw: ''
  }
}

function fresh(atMs: number, percent: number): UsageReadResult {
  return { kind: 'fresh', snapshot: snap(atMs, percent) }
}

function cached(atMs: number, percent: number, failure: CliErrorKind): UsageReadResult {
  return { kind: 'cached', snapshot: snap(atMs, percent), failure }
}

function none(failure: CliErrorKind, message: string): UsageReadResult {
  return { kind: 'none', failure, message }
}

// ── Sahte saat ───────────────────────────────────────────────────────────────

/**
 * Zamanlayici enjekte edildigi icin testler gercek 5 dk'yi beklemez.
 * `pendingCount` sizinti kontrolu icin acilir.
 */
class FakeClock {
  private current = START_MS
  private nextId = 1
  private readonly pending = new Map<TimerHandle, { at: number; run: () => void }>()

  readonly now = (): number => this.current

  readonly timers: CollectorTimers = {
    setTimeout: (callback: () => void, ms: number): TimerHandle => {
      const id = this.nextId
      this.nextId += 1
      this.pending.set(id, { at: this.current + ms, run: callback })
      return id
    },
    clearTimeout: (handle: TimerHandle): void => {
      this.pending.delete(handle)
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }

  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      let dueId: TimerHandle | null = null
      let dueAt = Number.POSITIVE_INFINITY
      for (const [id, task] of this.pending) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at
          dueId = id
        }
      }
      if (dueId === null) break

      const task = this.pending.get(dueId)
      this.pending.delete(dueId)
      if (task === undefined) break
      this.current = task.at
      task.run()
    }
    this.current = target
  }
}

/** Mikro gorevleri bosaltir (setImmediate makro gorev oldugu icin hepsi kosar). */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

interface Deferred {
  promise: Promise<UsageReadResult>
  resolve: (value: UsageReadResult) => void
}

function deferred(): Deferred {
  let resolve: (value: UsageReadResult) => void = () => undefined
  const promise = new Promise<UsageReadResult>((inner) => {
    resolve = inner
  })
  return { promise, resolve }
}

// ── Kosum duzenegi ───────────────────────────────────────────────────────────

interface HarnessOptions {
  respond: (callIndex: number, nowMs: number) => Promise<UsageReadResult>
  pollIntervalMs?: number
  appendFails?: boolean
}

interface Harness {
  clock: FakeClock
  collector: Collector
  states: CollectorState[]
  appended: Array<{ dir: string; snapshot: UsageSnapshot }>
  calls: () => number
}

function makeHarness(options: HarnessOptions): Harness {
  const clock = new FakeClock()
  const states: CollectorState[] = []
  const appended: Array<{ dir: string; snapshot: UsageSnapshot }> = []
  let calls = 0

  const collector = createCollector(
    {
      now: clock.now,
      timers: clock.timers,
      readUsage: async (): Promise<UsageReadResult> => {
        const index = calls
        calls += 1
        return await options.respond(index, clock.now())
      },
      appendSnapshot: async (dir: string, snapshot: UsageSnapshot): Promise<void> => {
        if (options.appendFails === true) throw new Error('disk yazilamadi')
        appended.push({ dir, snapshot })
      }
    },
    {
      dataDir: DATA_DIR,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    }
  )

  collector.onChange((state) => {
    states.push(state)
  })

  return { clock, collector, states, appended, calls: () => calls }
}

function kinds(states: CollectorState[]): string[] {
  return states.map((state) => state.status.kind)
}

function snapshotOf(status: UsageStatus): UsageSnapshot {
  if (status.kind === 'ok' || status.kind === 'stale') return status.snapshot
  throw new Error(`beklenen 'ok'/'stale', gelen '${status.kind}'`)
}

function firstPercent(snapshot: UsageSnapshot): number {
  const window = snapshot.windows[0]
  if (window === undefined) throw new Error('pencere yok')
  return window.percent
}

// ── Testler ──────────────────────────────────────────────────────────────────

describe('createCollector — taze olcum', () => {
  it('ilk olcumde loading -> ok gecisi yapar ve tarihceye yazar', async () => {
    const harness = makeHarness({ respond: async () => fresh(START_MS, 83) })

    harness.collector.start()
    const state = await harness.collector.pollNow()

    expect(kinds(harness.states)).toEqual(['loading', 'ok'])
    expect(state.status.kind).toBe('ok')
    expect(firstPercent(snapshotOf(state.status))).toBe(83)
    expect(state.errorStreak).toBe(0)
    expect(state.alert).toBe(false)
    expect(state.lastFailure).toBeNull()
    expect(state.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)

    expect(harness.appended).toHaveLength(1)
    const written = harness.appended[0]
    expect(written?.dir).toBe(DATA_DIR)
    expect(written?.snapshot.windows).toHaveLength(2)
    expect(written?.snapshot.at).toBe(START_MS)

    harness.collector.stop()
  })

  it('olcum araligi dolunca kendiliginden tekrar olcer', async () => {
    let percent = 50
    const harness = makeHarness({
      respond: async (_index, nowMs) => {
        percent += 1
        return fresh(nowMs, percent)
      }
    })

    harness.collector.start()
    await harness.collector.pollNow()
    expect(harness.calls()).toBe(1)

    harness.clock.advance(DEFAULT_POLL_INTERVAL_MS)
    const second = await harness.collector.pollNow()

    expect(harness.calls()).toBe(2)
    expect(firstPercent(snapshotOf(second.status))).toBe(52)

    harness.clock.advance(DEFAULT_POLL_INTERVAL_MS)
    await harness.collector.pollNow()
    expect(harness.calls()).toBe(3)

    harness.collector.stop()
  })

  it('devam eden olcum varken pollNow ikinci kez calistirmaz', async () => {
    const gate = deferred()
    const harness = makeHarness({ respond: async () => await gate.promise })

    const first = harness.collector.pollNow()
    const second = harness.collector.pollNow()
    expect(harness.calls()).toBe(1)

    gate.resolve(fresh(START_MS, 12))
    const [stateA, stateB] = await Promise.all([first, second])

    expect(stateA.status.kind).toBe('ok')
    expect(stateB.status.kind).toBe('ok')
    expect(harness.calls()).toBe(1)
  })
})

describe('createCollector — onbellekten okuma', () => {
  it('cached deger gosterilir ama bayat isaretlenir ve basarisizlik sinifi gorunur', async () => {
    // Bu, 2026-09-05'te olculen hatanin ta kendisi: 20 dk once alinmis veri
    // "guncel" diye gosteriliyordu. Artik `at` sunucu ani oldugu icin bayatlar.
    const harness = makeHarness({
      respond: async () => cached(START_MS - 20 * MINUTE, 22, 'rate-limited')
    })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('stale')
    expect(firstPercent(snapshotOf(state.status))).toBe(22)
    if (state.status.kind === 'stale') {
      expect(state.status.ageMs).toBe(20 * MINUTE)
      expect(state.status.reason).toContain('rate-limited')
    }
    expect(state.lastFailure).toBe('rate-limited')
    expect(state.errorStreak).toBe(1)
  })

  it('onbellek gercekten tazeyse ok kalir ama basarisizlik sinifi gizlenmez', async () => {
    const harness = makeHarness({
      respond: async () => cached(START_MS - 30 * 1000, 22, 'unknown')
    })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('ok')
    expect(firstPercent(snapshotOf(state.status))).toBe(22)
    expect(state.lastFailure).toBe('unknown')
    expect(state.errorStreak).toBe(1)
  })

  it('ayni `at` ikinci kez tarihceye yazilmaz', async () => {
    const harness = makeHarness({
      respond: async (index) => {
        if (index === 0) return fresh(START_MS, 40)
        if (index === 1) return cached(START_MS, 40, 'rate-limited')
        return cached(START_MS + 1000, 41, 'rate-limited')
      }
    })

    await harness.collector.pollNow()
    expect(harness.appended).toHaveLength(1)

    await harness.collector.pollNow()
    expect(harness.appended).toHaveLength(1)

    await harness.collector.pollNow()
    expect(harness.appended).toHaveLength(2)
    expect(harness.appended[1]?.snapshot.at).toBe(START_MS + 1000)
  })
})

describe('createCollector — hata durumlari', () => {
  it('none gelince error durumuna duser ve tarihceye YAZMAZ', async () => {
    const harness = makeHarness({
      respond: async () => none('not-logged-in', 'oturum bulunamadi')
    })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('error')
    if (state.status.kind === 'error') {
      expect(state.status.errorKind).toBe('not-logged-in')
      expect(state.status.message).toBe('oturum bulunamadi')
      expect(state.status.lastSnapshot).toBeNull()
    }
    expect(state.errorStreak).toBe(1)
    expect(state.lastFailure).toBe('not-logged-in')
    expect(harness.appended).toHaveLength(0)
  })

  it('hata sonrasi taze olcumde ok durumuna doner ve errorStreak sifirlanir', async () => {
    const harness = makeHarness({
      respond: async (index) => {
        if (index === 0) return none('unknown', 'gecici hata')
        return fresh(START_MS, 64)
      }
    })

    const failed = await harness.collector.pollNow()
    expect(failed.status.kind).toBe('error')
    expect(failed.errorStreak).toBe(1)

    const recovered = await harness.collector.pollNow()
    expect(recovered.status.kind).toBe('ok')
    expect(recovered.errorStreak).toBe(0)
    expect(recovered.lastFailure).toBeNull()
    expect(firstPercent(snapshotOf(recovered.status))).toBe(64)
  })

  it('hata durumunda son bilinen olcumu tasir (deger kaybolmaz)', async () => {
    const harness = makeHarness({
      respond: async (index) => {
        if (index === 0) return fresh(START_MS, 77)
        return none('not-logged-in', 'oturum gecerli degil')
      }
    })

    await harness.collector.pollNow()
    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('error')
    if (state.status.kind === 'error') {
      const carried = state.status.lastSnapshot
      expect(carried === null ? -1 : firstPercent(carried)).toBe(77)
    }
  })

  it(`ust uste ${ERROR_STREAK_FOR_ALERT} hatada uyari isareti kalkar`, async () => {
    const harness = makeHarness({ respond: async () => none('unknown', 'olmadi') })

    for (let i = 1; i < ERROR_STREAK_FOR_ALERT; i += 1) {
      const state = await harness.collector.pollNow()
      expect(state.errorStreak).toBe(i)
      expect(state.alert).toBe(false)
    }

    const alerting = await harness.collector.pollNow()
    expect(alerting.errorStreak).toBe(ERROR_STREAK_FOR_ALERT)
    expect(alerting.alert).toBe(true)
  })

  it('kaynak firlatirsa CliError sinifi korunur', async () => {
    const harness = makeHarness({
      respond: async () => {
        throw new CliError('timeout', 'istek zaman asimina ugradi')
      }
    })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('error')
    if (state.status.kind === 'error') {
      expect(state.status.errorKind).toBe('timeout')
      expect(state.status.message).toBe('istek zaman asimina ugradi')
    }
  })

  it('kaynak baglanmadiysa deger uydurmaz, acikca hata der', async () => {
    const clock = new FakeClock()
    const collector = createCollector(
      { now: clock.now, timers: clock.timers, appendSnapshot: async () => undefined },
      { dataDir: DATA_DIR }
    )

    const state = await collector.pollNow()

    expect(state.status.kind).toBe('error')
    if (state.status.kind === 'error') {
      expect(state.status.errorKind).toBe('unknown')
      expect(state.status.message).toBe('kota kaynagi baglanmadi')
    }
  })

  it('pencere listesi bossa bad-output sayar ve tarihceye yazmaz', async () => {
    const harness = makeHarness({
      respond: async () => ({
        kind: 'fresh',
        snapshot: { at: START_MS, windows: [], unparsedLines: [], raw: '' }
      })
    })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('error')
    if (state.status.kind === 'error') expect(state.status.errorKind).toBe('bad-output')
    expect(harness.appended).toHaveLength(0)
  })

  it('tarihce yazma hatasi olcumu gecersiz kilmaz ama gorunur kalir', async () => {
    const harness = makeHarness({ respond: async () => fresh(START_MS, 31), appendFails: true })

    const state = await harness.collector.pollNow()

    expect(state.status.kind).toBe('ok')
    expect(state.historyError).toBe('disk yazilamadi')
  })
})

describe('createCollector — 429 geri cekilmesi', () => {
  const BACKED_OFF = DEFAULT_POLL_INTERVAL_MS * BACKOFF_FACTOR

  it('429 alinca aralik carpilir ve zamanlayici geri cekilmis aralikta kurulur', async () => {
    const harness = makeHarness({ respond: async () => none('rate-limited', 'hiz sinirinda') })

    harness.collector.start()
    const state = await harness.collector.pollNow()

    expect(state.intervalMs).toBe(BACKED_OFF)
    expect(state.nextAttemptAtMs).toBe(START_MS + BACKED_OFF)

    // Varsayilan aralik dolsa bile yeni olcum YOK: geri cekilme gecerli.
    harness.clock.advance(DEFAULT_POLL_INTERVAL_MS)
    await flush()
    expect(harness.calls()).toBe(1)

    harness.clock.advance(DEFAULT_POLL_INTERVAL_MS)
    await harness.collector.pollNow()
    expect(harness.calls()).toBe(2)

    harness.collector.stop()
  })

  it('cached + rate-limited de araligi geri ceker', async () => {
    const harness = makeHarness({
      respond: async () => cached(START_MS - MINUTE, 22, 'rate-limited')
    })

    const state = await harness.collector.pollNow()

    expect(state.intervalMs).toBe(BACKED_OFF)
  })

  it('ust uste 429 tavani asmaz', async () => {
    const harness = makeHarness({ respond: async () => none('rate-limited', 'hiz sinirinda') })

    let last = 0
    for (let i = 0; i < 10; i += 1) {
      const state = await harness.collector.pollNow()
      last = state.intervalMs
      expect(last).toBeLessThanOrEqual(MAX_BACKOFF_MS)
    }

    expect(last).toBe(MAX_BACKOFF_MS)
  })

  it('taze olcumde aralik varsayilana doner', async () => {
    const harness = makeHarness({
      respond: async (index) => {
        if (index < 2) return none('rate-limited', 'hiz sinirinda')
        return fresh(START_MS, 55)
      }
    })

    await harness.collector.pollNow()
    const backed = await harness.collector.pollNow()
    expect(backed.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS * BACKOFF_FACTOR * BACKOFF_FACTOR)

    const recovered = await harness.collector.pollNow()
    expect(recovered.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
  })

  it('429 disi hata araligi buyutmez', async () => {
    const harness = makeHarness({ respond: async () => none('unknown', 'aga erisilemedi') })

    const state = await harness.collector.pollNow()

    expect(state.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
  })

  it('geri cekilme bayatlik esigini BUYUTMEZ', async () => {
    // Esik geri cekilmis araliktan hesaplansaydi 429 sirasinda 25 dk'lik veri
    // hala "taze" gorunurdu — duzeltmeye calistigimiz hatanin aynisi.
    const harness = makeHarness({
      respond: async (index) => {
        if (index === 0) return fresh(START_MS, 45)
        return cached(START_MS, 45, 'rate-limited')
      }
    })

    await harness.collector.pollNow()
    const backed = await harness.collector.pollNow()
    expect(backed.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS * BACKOFF_FACTOR)
    expect(backed.status.kind).toBe('ok')

    harness.clock.advance(DEFAULT_STALE_MS + 1000)
    const aged = harness.collector.getState()

    expect(aged.status.kind).toBe('stale')
    if (aged.status.kind === 'stale') {
      expect(aged.status.ageMs).toBe(DEFAULT_STALE_MS + 1000)
      expect(aged.status.reason).toContain('rate-limited')
    }
  })
})

describe('createCollector — bayatlik (REQ-10)', () => {
  /** Testlerde kullanilan aralik; esik bundan turetilir (sabit degil). */
  const POLL = 10 * MINUTE
  const ESIK = staleThresholdMs(POLL)

  it(`son olcumun uzerinden ${ESIK} ms gecince stale doner`, async () => {
    const harness = makeHarness({
      respond: async (_index, nowMs) => fresh(nowMs, 45),
      pollIntervalMs: POLL
    })

    const state = await harness.collector.pollNow()
    expect(state.status.kind).toBe('ok')

    harness.clock.advance(ESIK - 1000)
    expect(harness.collector.getState().status.kind).toBe('ok')

    harness.clock.advance(2000)
    const stale = harness.collector.getState()
    expect(stale.status.kind).toBe('stale')
    if (stale.status.kind === 'stale') {
      expect(stale.status.ageMs).toBe(ESIK + 1000)
      expect(stale.status.reason).toContain('sn')
      expect(firstPercent(stale.status.snapshot)).toBe(45)
    }
  })

  it('bayatlik degisimini yeni olcum sonucundan once yayinlar', async () => {
    const gate = deferred()
    const harness = makeHarness({
      respond: async (index, nowMs) => {
        if (index === 0) return fresh(nowMs, 45)
        return await gate.promise
      },
      pollIntervalMs: POLL
    })

    await harness.collector.pollNow()
    harness.clock.advance(ESIK + 1000)

    const pending = harness.collector.pollNow()
    await flush()
    expect(kinds(harness.states)).toEqual(['loading', 'ok', 'stale'])

    gate.resolve(fresh(harness.clock.now(), 46))
    const resolved = await pending
    expect(resolved.status.kind).toBe('ok')
  })

  it('yeni taze olcum bayatligi kaldirir', async () => {
    const harness = makeHarness({
      respond: async (_index, nowMs) => fresh(nowMs, 45),
      pollIntervalMs: POLL
    })

    await harness.collector.pollNow()
    harness.clock.advance(ESIK + 1000)
    expect(harness.collector.getState().status.kind).toBe('stale')

    const state = await harness.collector.pollNow()
    expect(state.status.kind).toBe('ok')
  })
})

describe('createCollector — durdurma', () => {
  it('stop() zamanlayici birakmaz ve yeni olcum tetiklemez', async () => {
    const harness = makeHarness({ respond: async () => fresh(START_MS, 20) })

    harness.collector.start()
    await harness.collector.pollNow()
    expect(harness.clock.pendingCount).toBe(1)
    expect(harness.collector.getState().nextAttemptAtMs).toBe(
      START_MS + DEFAULT_POLL_INTERVAL_MS
    )

    harness.collector.stop()
    expect(harness.clock.pendingCount).toBe(0)
    expect(harness.collector.getState().nextAttemptAtMs).toBeNull()

    harness.clock.advance(DEFAULT_POLL_INTERVAL_MS * 5)
    await flush()
    expect(harness.calls()).toBe(1)
  })

  it('ucusta olan olcum bittiginde durdurulmus toplayici yeniden planlamaz', async () => {
    const gate = deferred()
    const harness = makeHarness({ respond: async () => await gate.promise })

    harness.collector.start()
    harness.collector.stop()
    gate.resolve(fresh(START_MS, 20))
    await flush()

    expect(harness.clock.pendingCount).toBe(0)
    expect(harness.collector.getState().nextAttemptAtMs).toBeNull()
  })

  it('onChange aboneligi birakilabilir', async () => {
    const harness = makeHarness({ respond: async () => fresh(START_MS, 20) })
    const seen: string[] = []
    const unsubscribe = harness.collector.onChange((state) => {
      seen.push(state.status.kind)
    })

    await harness.collector.pollNow()
    const before = seen.length
    unsubscribe()
    await harness.collector.pollNow()

    expect(seen).toHaveLength(before)
    expect(before).toBeGreaterThan(0)
  })
})
