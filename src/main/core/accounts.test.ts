import { describe, expect, it, vi } from 'vitest'

import type { AccountKey, AuthStatus } from '../../shared/types'
import { createAccountManager, detectPresence, PRESENCE_RECHECK_MS, type AccountPresence } from './accounts'
import type { Collector, CollectorState, CollectorTimers, TimerHandle } from './collector'
import type { AccountPaths } from './paths'

const PATHS: AccountPaths = {
  configDir: '/home/ada/.claude-team',
  accountFile: '/home/ada/.claude-team/.claude.json',
  credentialsFile: '/home/ada/.claude-team/.credentials.json',
  projectsDir: '/home/ada/.claude-team/projects',
  cliConfigDir: '/home/ada/.claude-team'
}

const SIGNED_IN: AuthStatus = { loggedIn: true, email: null, orgName: null, subscriptionType: 'team' }
const SIGNED_OUT: AuthStatus = { loggedIn: false, email: null, orgName: null, subscriptionType: null }

/** Elle ilerletilen zamanlayici. */
function manualTimers(): CollectorTimers & { fire(): void; pending(): number } {
  const tasks = new Map<TimerHandle, () => void>()
  let next = 1
  return {
    setTimeout(callback) {
      const id = next
      next += 1
      tasks.set(id, callback)
      return id
    },
    clearTimeout(handle) {
      tasks.delete(handle)
    },
    fire() {
      const all = [...tasks.values()]
      tasks.clear()
      for (const task of all) task()
    },
    pending() {
      return tasks.size
    }
  }
}

function fakeCollector(): Collector & { started: boolean; stopped: boolean; polls: number } {
  const state: CollectorState = {
    status: { kind: 'loading' },
    errorStreak: 0,
    alert: false,
    lastFailure: null,
    intervalMs: 300_000,
    nextAttemptAtMs: null,
    historyError: null
  }
  const c = {
    started: false,
    stopped: false,
    polls: 0,
    start() {
      c.started = true
    },
    stop() {
      c.stopped = true
    },
    getState: () => state,
    onChange: () => () => undefined,
    pollNow() {
      c.polls += 1
      return Promise.resolve(state)
    }
  }
  return c
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

describe('detectPresence', () => {
  it('hesap kaydinda giris varsa bagli', async () => {
    const exists = vi.fn(async () => false)
    expect(await detectPresence(PATHS, async () => SIGNED_IN, exists)).toBe('connected')
    expect(exists).not.toHaveBeenCalled()
  })

  it('kayit yok ama jeton dosyasi duruyorsa bagli', async () => {
    expect(await detectPresence(PATHS, async () => SIGNED_OUT, async () => true)).toBe('connected')
  })

  it('ikisi de yoksa bagli degil', async () => {
    expect(await detectPresence(PATHS, async () => SIGNED_OUT, async () => false)).toBe('not-connected')
  })
})

describe('createAccountManager', () => {
  function setup(initial: Record<AccountKey, AccountPresence>) {
    const presence = { ...initial }
    const collectors = new Map<AccountKey, ReturnType<typeof fakeCollector>>()
    const timers = manualTimers()
    const manager = createAccountManager({
      presence: async (key) => presence[key],
      readAuth: async () => SIGNED_IN,
      createCollector: (key) => {
        const c = fakeCollector()
        collectors.set(key, c)
        return c
      },
      timers
    })
    return { manager, presence, collectors, timers }
  }

  it('yoklanmadan once hesaplar "yoklaniyor" gorunur, bagli degil denmez', () => {
    const { manager } = setup({ personal: 'connected', team: 'not-connected' })
    expect(manager.accounts().map((a) => a.presence)).toEqual(['checking', 'checking'])
  })

  it('yalniz bagli hesap icin olcum baslar', async () => {
    const { manager, collectors } = setup({ personal: 'connected', team: 'not-connected' })
    await manager.start()
    expect(collectors.get('personal')?.started).toBe(true)
    expect(collectors.has('team')).toBe(false)
    const team = manager.accounts().find((a) => a.key === 'team')
    expect(team?.presence).toBe('not-connected')
    expect(team?.status).toEqual({ kind: 'no-data' })
  })

  it('bagli olmayan hesap araliklarla yeniden yoklanir; giris yapilinca olcum baslar', async () => {
    const { manager, presence, collectors, timers } = setup({ personal: 'connected', team: 'not-connected' })
    await manager.start()
    expect(timers.pending()).toBe(1)

    presence.team = 'connected'
    timers.fire()
    await flush()
    expect(collectors.get('team')?.started).toBe(true)
    expect(manager.accounts().find((a) => a.key === 'team')?.presence).toBe('connected')
    // Hepsi bagli: yeni yoklama planlanmaz.
    expect(timers.pending()).toBe(0)
    expect(PRESENCE_RECHECK_MS).toBe(5 * 60 * 1000)
  })

  it('elle yenileme bagli olmayan hesabi da hemen yoklar', async () => {
    const { manager, presence, collectors } = setup({ personal: 'connected', team: 'not-connected' })
    await manager.start()
    presence.team = 'connected'
    await manager.pollAll()
    expect(collectors.get('team')?.started).toBe(true)
    expect(collectors.get('personal')?.polls).toBeGreaterThan(0)
  })

  it('durdurulunca toplayicilar durur ve yoklama planlanmaz', async () => {
    const { manager, collectors, timers } = setup({ personal: 'connected', team: 'not-connected' })
    await manager.start()
    manager.stop()
    expect(collectors.get('personal')?.stopped).toBe(true)
    expect(timers.pending()).toBe(0)
  })

  it('yoklama hata verirse hesap bagli degil sayilir, uygulama cokmez', async () => {
    const manager = createAccountManager({
      presence: async () => {
        throw new Error('disk okunamadi')
      },
      readAuth: async () => SIGNED_IN,
      createCollector: () => fakeCollector(),
      timers: manualTimers()
    })
    await manager.start()
    expect(manager.accounts().every((a) => a.presence === 'not-connected')).toBe(true)
  })
})
