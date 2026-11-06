import { describe, expect, it } from 'vitest'

import type { TokenState } from '../../shared/types'
import type { FetchFn } from './hub-client'
import { fetchOtherDevices, mergeTokens, OTHERS_MAX_AGE_MS, type OtherDevicesTotals } from './token-totals'

const NOW = 1_800_000_000_000
const STEP = 5 * 60_000
const SPARK_START = NOW - 36 * STEP
const DAY_START = NOW - 10 * 3_600_000

function local(over: Partial<TokenState['accounts'][number]> = {}): TokenState {
  return {
    accounts: [
      { key: 'personal', last15m: 76, cacheRead15m: 1000, today: 25_000, spark: new Array<number>(36).fill(1), ...over },
      { key: 'team', last15m: 0, cacheRead15m: 0, today: 0, spark: new Array<number>(36).fill(0) }
    ],
    progress: null,
    error: null
  }
}

const others: OtherDevicesTotals = {
  fetchedAt: NOW,
  accounts: { personal: { last15m: 862, cacheRead15m: 50, today: 1_545, spark: new Array<number>(36).fill(2) } }
}

describe('mergeTokens', () => {
  it('merkez yoksa yerel sayi oldugu gibi, kapsam "device"', () => {
    const m = mergeTokens(local(), null, false, NOW)
    expect(m?.scope).toBe('device')
    expect(m?.accounts[0]?.last15m).toBe(76)
    expect(m?.accounts[0]?.own).toBeUndefined()
  })

  it('taze merkez okumasi: toplam + bu cihazin payi (kullanici olcumu: 76 bin + 862 bin)', () => {
    const m = mergeTokens(local(), others, true, NOW + 30_000)
    expect(m?.scope).toBe('all')
    const p = m?.accounts.find((a) => a.key === 'personal')
    expect(p).toMatchObject({ last15m: 938, cacheRead15m: 1050, today: 26_545, own: { last15m: 76, today: 25_000 } })
    expect(p?.spark.every((v) => v === 3)).toBe(true)
    // Merkezde diger cihazi olmayan hesap: toplam = bu cihaz, pay yine gosterilir.
    expect(m?.accounts.find((a) => a.key === 'team')).toMatchObject({ last15m: 0, own: { last15m: 0, today: 0 } })
  })

  it('merkez tanimli ama okuma yok ya da bayat: yerel sayi "device-offline" isaretiyle', () => {
    expect(mergeTokens(local(), null, true, NOW)?.scope).toBe('device-offline')
    const stale = mergeTokens(local(), others, true, NOW + OTHERS_MAX_AGE_MS + 1)
    expect(stale?.scope).toBe('device-offline')
    expect(stale?.accounts[0]?.last15m).toBe(76)
  })

  it('toplayici yoksa null kalir', () => {
    expect(mergeTokens(null, others, true, NOW)).toBeNull()
  })
})

describe('fetchOtherDevices', () => {
  const rows = (path: string): unknown[] => {
    if (path.includes(`from=${SPARK_START}`)) {
      return [
        // Diger cihaz (Mac): son dilim (son 15 dk) + daha eski bir dilim.
        { atMs: SPARK_START + 35 * STEP, account: 'personal', device: 'mac', total: 900, cacheRead: 100 },
        { atMs: SPARK_START + 10 * STEP, account: 'personal', device: 'mac', total: 50, cacheRead: 0 },
        // Bu cihaz: cikarilir (yerel sayi kullanilir).
        { atMs: SPARK_START + 35 * STEP, account: 'personal', device: 'self', total: 7_000, cacheRead: 0 }
      ]
    }
    return [
      { atMs: DAY_START, account: 'personal', device: 'mac', total: 2_000, cacheRead: 500 },
      { atMs: DAY_START, account: 'personal', device: 'self', total: 99_999, cacheRead: 0 }
    ]
  }

  it('bu cihazi cikarir; son uc dilim son 15 dakikadir, olcu onbelleksiz', async () => {
    const asked: string[] = []
    const fetch: FetchFn = async (url) => {
      asked.push(url)
      return new Response(JSON.stringify({ rows: rows(url) }), { status: 200 })
    }
    const hub = { url: 'https://out.example.test', lanUrl: null, key: 'k', deviceId: 'self' }
    const o = await fetchOtherDevices(fetch, hub, NOW, DAY_START)
    expect(asked.every((u) => u.startsWith('https://out.example.test/v1/usage?') && u.includes('by=account,device'))).toBe(true)
    expect(o?.accounts.personal).toMatchObject({ last15m: 800, cacheRead15m: 100, today: 1_500 })
    expect(o?.accounts.personal?.spark[35]).toBe(800)
    expect(o?.accounts.personal?.spark[10]).toBe(50)
  })

  it('merkeze ulasilamazsa null', async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await fetchOtherDevices(fetch, { url: 'https://x.test', lanUrl: null, key: 'k', deviceId: 'self' }, NOW, DAY_START)).toBeNull()
  })
})
