import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { HubDb, type BucketIn } from './db'
import { createHandler, type ListenerRole } from './handlers'

const T0 = Date.UTC(2026, 10, 6, 9, 0)
const MIN = Math.floor(T0 / 60000)

function bucket(over: Partial<BucketIn> = {}): BucketIn {
  return {
    minute: MIN,
    account: 'personal',
    model: 'claude-opus-5-5',
    project: 'wisp',
    subagent: false,
    input: 1,
    output: 10,
    cacheWrite5m: 0,
    cacheWrite1h: 100,
    cacheRead: 1000,
    requests: 1,
    ...over
  }
}

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function serve(db: HubDb, role: ListenerRole): Promise<string> {
  const server = createServer(createHandler({ role, db, panelDir: null, now: () => T0 }))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('HubDb', () => {
  it('ayni dakika yeniden gelirse eski satirlar silinir (hesap degisse de cift sayim yok)', () => {
    const db = new HubDb(':memory:')
    const { deviceId } = db.enroll('PC', 'win32', T0)
    db.writeBuckets(deviceId, [bucket()])
    db.writeBuckets(deviceId, [bucket({ account: 'team', output: 12 })])
    const rows = db.usage(T0, T0 + 60_000, 60_000, ['account'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.['account']).toBe('team')
    expect(rows[0]?.['output']).toBe(12)
    db.close()
  })

  it('ayni donemden eski surum yeniyi ezmez (gec islenen istek)', () => {
    const db = new HubDb(':memory:')
    const { deviceId } = db.enroll('PC', 'win32', T0)
    db.writeBuckets(deviceId, [bucket({ output: 20, requests: 2, version: 9 })], 'e1')
    // Istemcinin vazgectigi eski istek sonradan islenir: yok sayilir.
    expect(db.writeBuckets(deviceId, [bucket({ output: 10, version: 5 })], 'e1')).toBe(0)
    expect(db.usage(T0, T0 + 60_000, 60_000, [])[0]?.['output']).toBe(20)
    // Daha yeni surum yazilir.
    db.writeBuckets(deviceId, [bucket({ output: 30, requests: 3, version: 12 })], 'e1')
    expect(db.usage(T0, T0 + 60_000, 60_000, [])[0]?.['output']).toBe(30)
    db.close()
  })

  it('yeni donem (yeniden kurulan veritabani) dusuk surumle de yazilir; surumsuz istek her zaman', () => {
    const db = new HubDb(':memory:')
    const { deviceId } = db.enroll('PC', 'win32', T0)
    db.writeBuckets(deviceId, [bucket({ output: 20, version: 900 })], 'e1')
    db.writeBuckets(deviceId, [bucket({ output: 7, version: 3 })], 'e2')
    expect(db.usage(T0, T0 + 60_000, 60_000, [])[0]?.['output']).toBe(7)
    db.writeBuckets(deviceId, [bucket({ output: 4 })])
    expect(db.usage(T0, T0 + 60_000, 60_000, [])[0]?.['output']).toBe(4)
    db.close()
  })

  it('iki cihazin ayni dakikasi toplanir; cihaza gore ayrilabilir', () => {
    const db = new HubDb(':memory:')
    const a = db.enroll('PC', 'win32', T0).deviceId
    const b = db.enroll('Mac', 'darwin', T0).deviceId
    db.writeBuckets(a, [bucket({ output: 10 })])
    db.writeBuckets(b, [bucket({ output: 5, project: null })])
    expect(db.usage(T0, T0 + 60_000, 60_000, [])[0]?.['output']).toBe(15)
    expect(db.usage(T0, T0 + 60_000, 60_000, ['device'])).toHaveLength(2)
    const byProject = db.usage(T0, T0 + 60_000, 60_000, ['project'])
    expect(byProject.map((r) => r['project']).sort()).toEqual([null, 'wisp'].sort())
    db.close()
  })

  it('ayni kota ornegi iki kez saklanmaz', () => {
    const db = new HubDb(':memory:')
    const d = db.enroll('PC', 'win32', T0).deviceId
    const sample = { account: 'personal', fetchedAt: T0, windows: [{ label: 'Current session', percent: 65, resetsAtMs: T0 + 1 }] }
    expect(db.writeQuota(d, [sample])).toBe(1)
    expect(db.writeQuota(d, [sample])).toBe(0)
    db.close()
  })
})

describe('HTTP uclari', () => {
  it('disari acik dinleyicide anahtarsiz okuma ve kayit yok', async () => {
    const db = new HubDb(':memory:')
    const base = await serve(db, 'public')
    expect((await fetch(`${base}/v1/devices`)).status).toBe(401)
    expect((await fetch(`${base}/v1/enroll`, { method: 'POST', body: '{"name":"x"}' })).status).toBe(404)
    expect((await fetch(`${base}/health`)).status).toBe(200)
    db.close()
  })

  it('evde kayit olunur; anahtarla yazilir, disaridan anahtarla okunur', async () => {
    const db = new HubDb(':memory:')
    const home = await serve(db, 'home')
    const pub = await serve(db, 'public')
    const enroll = (await (await fetch(`${home}/v1/enroll`, { method: 'POST', body: '{"name":"PC","os":"win32"}' })).json()) as {
      key: string
    }
    expect(enroll.key.startsWith('cuw_')).toBe(true)
    const auth = { authorization: `Bearer ${enroll.key}` }

    const post = await fetch(`${pub}/v1/usage`, { method: 'POST', headers: auth, body: JSON.stringify({ buckets: [bucket()] }) })
    expect(post.status).toBe(200)
    expect((await fetch(`${pub}/v1/usage`, { method: 'POST', body: JSON.stringify({ buckets: [bucket()] }) })).status).toBe(401)

    const read = (await (
      await fetch(`${pub}/v1/usage?from=${T0}&to=${T0 + 3_600_000}&step=900000&by=account`, { headers: auth })
    ).json()) as { rows: Array<Record<string, unknown>> }
    expect(read.rows[0]?.['total']).toBe(1 + 10 + 100 + 1000)

    // Evde okuma anahtarsiz.
    expect((await fetch(`${home}/v1/devices`)).status).toBe(200)
    db.close()
  })

  it('bozuk girdi reddedilir, bilinmeyen hesap kabul edilmez', async () => {
    const db = new HubDb(':memory:')
    const home = await serve(db, 'home')
    const { key } = db.enroll('PC', 'win32', T0)
    const auth = { authorization: `Bearer ${key}` }
    expect((await fetch(`${home}/v1/usage`, { method: 'POST', headers: auth, body: '{bozuk' })).status).toBe(400)
    const bad = JSON.stringify({ buckets: [bucket({ account: 'baskasi' })] })
    expect((await fetch(`${home}/v1/usage`, { method: 'POST', headers: auth, body: bad })).status).toBe(400)
    expect((await fetch(`${home}/v1/usage?from=10&to=5`)).status).toBe(400)
    db.close()
  })

  it('tarayicidan on-ucus istegi CORS ile cevaplanir', async () => {
    const db = new HubDb(':memory:')
    const pub = await serve(db, 'public')
    const res = await fetch(`${pub}/v1/usage`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
    db.close()
  })
})
