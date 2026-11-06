import { describe, expect, it } from 'vitest'

import type { MinuteBucket } from '../../collector/store'
import type { HubConfig } from './config-store'
import { parseHubQuery, prepareBuckets, readTargets, sendToHub, writeTargets, type FetchFn } from './hub-client'
import { createHubSync, QUOTA_BACKFILL_MS, type HubSyncDeps, type QuotaSampleOut } from './hub-sync'

const NOW = 1_800_000_000_000

interface Call {
  url: string
  method: string
  auth: string | null
  body: unknown
}

/** Adrese gore cevap veren sahte fetch; `null` ag hatasi demek. */
function fakeFetch(route: (url: string, method: string) => { status: number; body?: unknown } | null): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchFn = async (input, init) => {
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: input, method, auth: headers['authorization'] ?? null, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    const res = route(input, method)
    if (res === null) throw new TypeError('fetch failed')
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status })
  }
  return { fetch, calls }
}

function hubConfig(over: Partial<HubConfig> = {}): HubConfig {
  return { url: 'https://out.example.test', lanUrl: 'http://192.168.1.5:3310', key: 'k1', deviceId: 'd1', deviceName: null, ...over }
}

function bucket(over: Partial<MinuteBucket>): MinuteBucket {
  return {
    minute: 1,
    account: 'personal',
    model: 'm',
    project: 'p',
    subagent: false,
    input: 1,
    output: 2,
    cacheWrite5m: 3,
    cacheWrite1h: 0,
    cacheRead: 4,
    requests: 1,
    version: 1,
    ...over
  }
}

describe('hub-client', () => {
  it('yazma hedefi anahtar ister; once dis adres, sonra ev agi', () => {
    expect(writeTargets(hubConfig({ key: null }))).toEqual([])
    expect(writeTargets(hubConfig()).map((t) => t.url)).toEqual(['https://out.example.test', 'http://192.168.1.5:3310'])
  })

  it('anahtarsiz okuma yalniz ev agindan', () => {
    expect(readTargets(hubConfig({ key: null }))).toEqual([{ url: 'http://192.168.1.5:3310', key: null }])
  })

  it('ag hatasinda sonraki adrese gecer, HTTP cevabinda gecmez', async () => {
    const offline = fakeFetch((url) => (url.startsWith('https://out') ? null : { status: 200, body: { ok: true } }))
    const res = await sendToHub(offline.fetch, writeTargets(hubConfig()), 'v1/heartbeat', {})
    expect(res.status).toBe(200)
    expect(offline.calls.map((c) => c.url)).toEqual(['https://out.example.test/v1/heartbeat', 'http://192.168.1.5:3310/v1/heartbeat'])

    const denied = fakeFetch(() => ({ status: 401 }))
    expect((await sendToHub(denied.fetch, writeTargets(hubConfig()), 'v1/heartbeat', {})).status).toBe(401)
    expect(denied.calls).toHaveLength(1)
    expect(denied.calls[0]?.auth).toBe('Bearer k1')
  })

  it('proje adi gonderilmiyorsa ayni anahtarli sepetler toplanir (merkezde ezilmesin)', () => {
    const merged = prepareBuckets([bucket({ project: 'a' }), bucket({ project: 'b', output: 10 }), bucket({ model: 'x' })], false)
    expect(merged).toHaveLength(2)
    const m = merged.find((b) => b.model === 'm')
    expect(m?.project).toBeNull()
    expect(m?.output).toBe(12)
    expect(m?.requests).toBe(2)
    expect(prepareBuckets([bucket({ project: 'a' })], true)[0]?.project).toBe('a')
  })

  it('panel yollari dogrulanir', () => {
    expect(parseHubQuery('v1/devices')).toEqual({ kind: 'devices' })
    expect(parseHubQuery('v1/quota?from=1&to=2&kind=main')).toEqual({ kind: 'quota', from: 1, to: 2, mainOnly: true })
    expect(parseHubQuery('v1/usage?from=0&to=3600000&step=900000&by=account,model')).toEqual({
      kind: 'usage',
      from: 0,
      to: 3_600_000,
      step: 900_000,
      by: ['account', 'model']
    })
    expect(parseHubQuery('v1/enroll')).toBeNull()
    expect(parseHubQuery('v1/usage?from=0&to=10&step=60000&by=password')).toBeNull()
    expect(parseHubQuery('v1/usage?from=0&to=99999999999&step=60000')).toBeNull()
    expect(parseHubQuery('https://elsewhere.test/v1/devices')).toBeNull()
  })
})

function deps(fetch: FetchFn, hub: { current: HubConfig }, quota: QuotaSampleOut[] = []): HubSyncDeps {
  return {
    fetch,
    now: () => NOW,
    accounts: ['personal'],
    getHub: () => hub.current,
    saveHub: async (next) => {
      hub.current = next
    },
    deviceName: () => 'PC',
    os: 'win32',
    version: '0.3.0',
    readQuota: async (_account, from, to) => quota.filter((s) => s.fetchedAt >= from && s.fetchedAt < to),
    collectorInfo: () => ({ queue: 3, scanPct: 100 }),
    localUsage: async () => [{ atMs: 0, account: 'personal', total: 5, output: 1, input: 0, cacheWrite: 0, cacheRead: 4, requests: 1 }]
  }
}

describe('hub-sync', () => {
  it('anahtar yoksa ev agindan kayit olur ve anahtari saklar', async () => {
    const hub = { current: hubConfig({ key: null, deviceId: null }) }
    const { fetch, calls } = fakeFetch((url) => (url.endsWith('/v1/enroll') ? { status: 200, body: { deviceId: 'new', key: 'k2' } } : { status: 200 }))
    expect(await createHubSync(deps(fetch, hub)).tick()).toBe('ok')
    expect(hub.current.key).toBe('k2')
    expect(hub.current.deviceId).toBe('new')
    expect(calls[0]).toMatchObject({ url: 'http://192.168.1.5:3310/v1/enroll', auth: null, body: { name: 'PC', os: 'win32' } })
    expect(calls.at(-1)).toMatchObject({ url: 'https://out.example.test/v1/heartbeat', auth: 'Bearer k2', body: { version: '0.3.0', queue: 3 } })
  })

  it('ev aginda degilse kayit bekler, hata vermez', async () => {
    const hub = { current: hubConfig({ key: null }) }
    const { fetch } = fakeFetch(() => null)
    expect(await createHubSync(deps(fetch, hub)).tick()).toBe('waiting-enroll')
  })

  it('kota tarihcesini parca parca gonderir, sonra yalniz yeni olcumu', async () => {
    const hub = { current: hubConfig() }
    const quota: QuotaSampleOut[] = Array.from({ length: 700 }, (_, i) => ({
      account: 'personal',
      fetchedAt: NOW - QUOTA_BACKFILL_MS + i * 60_000,
      windows: [{ label: 'Current session', percent: i % 100, resetsAtMs: null }]
    }))
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }))
    const sync = createHubSync(deps(fetch, hub, quota))
    await sync.tick()
    const quotaCalls = calls.filter((c) => c.url.endsWith('/v1/quota'))
    expect(quotaCalls.map((c) => (c.body as { samples: unknown[] }).samples.length)).toEqual([500, 200])
    calls.length = 0
    await sync.flushQuota()
    expect(calls.filter((c) => c.url.endsWith('/v1/quota'))).toHaveLength(0)
  })

  it('anahtar reddedilirse durum unauthorized', async () => {
    const hub = { current: hubConfig() }
    const { fetch } = fakeFetch(() => ({ status: 401 }))
    expect(await createHubSync(deps(fetch, hub)).tick()).toBe('unauthorized')
  })

  it('panel once merkezden okur, ulasamazsa bu cihazin verisine duser', async () => {
    const hub = { current: hubConfig() }
    const up = fakeFetch(() => ({ status: 200, body: { devices: [] } }))
    expect(await createHubSync(deps(up.fetch, hub)).panelGet('v1/devices')).toEqual({ ok: true, local: false, body: { devices: [] } })

    const down = fakeFetch(() => null)
    const local = await createHubSync(deps(down.fetch, hub)).panelGet('v1/usage?from=0&to=3600000&step=900000&by=account')
    expect(local.local).toBe(true)
    expect((local.body as { rows: unknown[] }).rows).toHaveLength(1)
  })

  it('panel bilinmeyen yola istek attiramaz', async () => {
    const hub = { current: hubConfig() }
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }))
    expect((await createHubSync(deps(fetch, hub)).panelGet('v1/enroll')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
