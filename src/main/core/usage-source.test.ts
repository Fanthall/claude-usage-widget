import { describe, expect, it } from 'vitest'

import type { UsageWindow } from '../../shared/types'
import {
  USAGE_ENDPOINT,
  fetchUtilization,
  parseCachedUtilization,
  toSnapshot,
  windowsFromLimits,
  type FetchErr,
  type FetchFn,
  type FetchOk,
  type FetchResult
} from './usage-source'

// ── Yardimcilar ──────────────────────────────────────────────────────────────

/** `noUncheckedIndexedAccess` altinda dizinden guvenli okuma. */
function nth(windows: UsageWindow[], index: number): UsageWindow {
  const found = windows[index]
  if (found === undefined) throw new Error(`beklenen pencere yok: ${index}`)
  return found
}

function okOf(result: FetchResult): FetchOk {
  if (!result.ok) throw new Error(`basari bekleniyordu, gelen hata: ${result.kind}`)
  return result
}

function errOf(result: FetchResult): FetchErr {
  if (result.ok) throw new Error('hata bekleniyordu, basari geldi')
  return result
}

interface Recorded {
  url: string
  headers: Record<string, string>
}

type FetchResponse = Awaited<ReturnType<FetchFn>>
type Responder = () => Promise<FetchResponse>

interface FetchSpy {
  fetchFn: FetchFn
  calls: Recorded[]
}

/** Cagrilari kaydeden sahte fetch. Gercek ag hicbir testte kullanilmaz. */
function spyFetch(responder: Responder): FetchSpy {
  const calls: Recorded[] = []
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } })
    return responder()
  }
  return { fetchFn, calls }
}

function reply(status: number, body: string, headerMap: Record<string, string> = {}): Responder {
  return async () => ({
    status,
    headers: { get: (name: string) => headerMap[name.toLowerCase()] ?? null },
    text: async () => body
  })
}

function throwing(error: unknown): Responder {
  return async () => {
    throw error
  }
}

function onlyCall(calls: Recorded[]): Recorded {
  const first = calls[0]
  if (first === undefined) throw new Error('hic fetch cagrisi yapilmadi')
  if (calls.length !== 1) throw new Error(`tek cagri bekleniyordu, ${calls.length} var`)
  return first
}

// ── Sabit veriler ────────────────────────────────────────────────────────────

const RESET_SESSION = '2026-09-05T13:50:00.000Z'
const RESET_WEEK = '2026-09-06T05:00:00.000Z'

const SESSION_LIMIT = { kind: 'session', percent: 22, resets_at: RESET_SESSION }
const WEEKLY_ALL_LIMIT = { kind: 'weekly_all', percent: 20, resets_at: RESET_WEEK }
const WEEKLY_SCOPED_LIMIT = {
  kind: 'weekly_scoped',
  percent: 5,
  resets_at: RESET_WEEK,
  scope: { model: { display_name: 'Fable' } }
}

/** Ucun gonderdigi govde: kok nesnenin `limits` alani. */
function bodyOf(...limits: unknown[]): string {
  return JSON.stringify({ limits })
}

/** `~/.claude.json` iskeleti — gercek dosyada bunun yaninda baska alanlar da var. */
function claudeJson(cached: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, cachedUsageUtilization: cached })
}

const TOKEN = 'sk-ant-oat01-COK-GIZLI-JETON-DEGERI'
const NOW = Date.UTC(2026, 8, 5, 13, 0)

function readsToken(): () => Promise<string | null> {
  return async () => TOKEN
}

// ── windowsFromLimits: etiketler ─────────────────────────────────────────────

describe('windowsFromLimits: etiketler', () => {
  it('session / weekly_all / weekly_scoped icin `/usage` metniyle ayni etiketleri uretir', () => {
    const windows = windowsFromLimits({
      limits: [SESSION_LIMIT, WEEKLY_ALL_LIMIT, WEEKLY_SCOPED_LIMIT]
    })

    expect(windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)'
    ])
  })

  it('weekly_scoped model adini etikete gomer', () => {
    const windows = windowsFromLimits({ limits: [WEEKLY_SCOPED_LIMIT] })

    expect(nth(windows, 0)).toEqual({
      label: 'Current week (Fable)',
      percent: 5,
      resetsAtRaw: RESET_WEEK,
      resetsAtMs: Date.parse(RESET_WEEK)
    })
  })

  it('weekly_scoped model adi yoksa sade `Current week` olur', () => {
    const cases: unknown[] = [
      { kind: 'weekly_scoped', percent: 5 },
      { kind: 'weekly_scoped', percent: 5, scope: null },
      { kind: 'weekly_scoped', percent: 5, scope: { model: null } },
      { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: '' } } },
      { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: 42 } } }
    ]

    for (const limit of cases) {
      const windows = windowsFromLimits({ limits: [limit] })
      expect(nth(windows, 0).label).toBe('Current week')
    }
  })

  it('taninmayan kind ATLANIR, patlamaz', () => {
    const windows = windowsFromLimits({
      limits: [{ kind: 'monthly_experimental', percent: 40 }, SESSION_LIMIT]
    })

    expect(windows.map((w) => w.label)).toEqual(['Current session'])
  })

  it('kind string degilse veya yoksa atlanir', () => {
    expect(windowsFromLimits({ limits: [{ kind: 7, percent: 40 }] })).toEqual([])
    expect(windowsFromLimits({ limits: [{ percent: 40 }] })).toEqual([])
  })

  it('siralamayi korur', () => {
    const windows = windowsFromLimits({
      limits: [WEEKLY_SCOPED_LIMIT, SESSION_LIMIT, WEEKLY_ALL_LIMIT]
    })

    expect(windows.map((w) => w.label)).toEqual([
      'Current week (Fable)',
      'Current session',
      'Current week (all models)'
    ])
  })
})

// ── windowsFromLimits: percent ───────────────────────────────────────────────

describe('windowsFromLimits: percent', () => {
  it('sayisal olmayan veya eksik percent atlanir', () => {
    const windows = windowsFromLimits({
      limits: [
        { kind: 'session', percent: '22' },
        { kind: 'weekly_all' },
        { kind: 'weekly_all', percent: null },
        { kind: 'weekly_all', percent: true },
        WEEKLY_SCOPED_LIMIT
      ]
    })

    expect(windows.map((w) => w.label)).toEqual(['Current week (Fable)'])
  })

  it('sonlu olmayan percent atlanir (NaN / Infinity)', () => {
    expect(windowsFromLimits({ limits: [{ kind: 'session', percent: Number.NaN }] })).toEqual([])
    expect(
      windowsFromLimits({ limits: [{ kind: 'session', percent: Number.POSITIVE_INFINITY }] })
    ).toEqual([])
  })

  it('0-100 disi degerler kirpilir', () => {
    const windows = windowsFromLimits({
      limits: [
        { kind: 'session', percent: -5 },
        { kind: 'weekly_all', percent: 140 }
      ]
    })

    expect(nth(windows, 0).percent).toBe(0)
    expect(nth(windows, 1).percent).toBe(100)
  })

  it('kesirli percent yuvarlanir', () => {
    const windows = windowsFromLimits({
      limits: [
        { kind: 'session', percent: 83.6 },
        { kind: 'weekly_all', percent: 22.4 }
      ]
    })

    expect(nth(windows, 0).percent).toBe(84)
    expect(nth(windows, 1).percent).toBe(22)
  })

  it('sinir degerleri oldugu gibi gecer', () => {
    const windows = windowsFromLimits({
      limits: [
        { kind: 'session', percent: 0 },
        { kind: 'weekly_all', percent: 100 }
      ]
    })

    expect(nth(windows, 0).percent).toBe(0)
    expect(nth(windows, 1).percent).toBe(100)
  })
})

// ── windowsFromLimits: resets_at ─────────────────────────────────────────────

describe('windowsFromLimits: resets_at', () => {
  it('ISO-8601 degeri epoch ms olarak cozer', () => {
    const windows = windowsFromLimits({ limits: [SESSION_LIMIT] })

    expect(nth(windows, 0).resetsAtMs).toBe(Date.UTC(2026, 8, 5, 13, 50))
    expect(nth(windows, 0).resetsAtRaw).toBe(RESET_SESSION)
  })

  it('cozulemeyen metinde resetsAtMs null olur ama ham deger KORUNUR (tahmin yok)', () => {
    const windows = windowsFromLimits({
      limits: [{ kind: 'session', percent: 22, resets_at: 'yakinda' }]
    })

    expect(nth(windows, 0).resetsAtMs).toBeNull()
    expect(nth(windows, 0).resetsAtRaw).toBe('yakinda')
  })

  it('resets_at yoksa veya string degilse ham deger bos, ms null', () => {
    const windows = windowsFromLimits({
      limits: [
        { kind: 'session', percent: 22 },
        { kind: 'weekly_all', percent: 20, resets_at: 1757079000000 }
      ]
    })

    expect(nth(windows, 0)).toMatchObject({ resetsAtRaw: '', resetsAtMs: null })
    expect(nth(windows, 1)).toMatchObject({ resetsAtRaw: '', resetsAtMs: null })
  })

  it('bos metin resets_at icin ms null kalir', () => {
    const windows = windowsFromLimits({
      limits: [{ kind: 'session', percent: 22, resets_at: '' }]
    })

    expect(nth(windows, 0).resetsAtMs).toBeNull()
    expect(nth(windows, 0).resetsAtRaw).toBe('')
  })
})

// ── windowsFromLimits: bozuk girdi ───────────────────────────────────────────

describe('windowsFromLimits: bozuk girdi', () => {
  it('nesne olmayan girdide bos dizi doner', () => {
    expect(windowsFromLimits(null)).toEqual([])
    expect(windowsFromLimits(undefined)).toEqual([])
    expect(windowsFromLimits('limits')).toEqual([])
    expect(windowsFromLimits(42)).toEqual([])
  })

  it('limits dizi degilse bos dizi doner', () => {
    expect(windowsFromLimits({})).toEqual([])
    expect(windowsFromLimits({ limits: null })).toEqual([])
    expect(windowsFromLimits({ limits: { session: 22 } })).toEqual([])
  })

  it('dizi icindeki nesne olmayan ogeler atlanir', () => {
    const windows = windowsFromLimits({
      limits: [null, 'session', 7, [], SESSION_LIMIT]
    })

    expect(windows.map((w) => w.label)).toEqual(['Current session'])
  })
})

// ── parseCachedUtilization ───────────────────────────────────────────────────

describe('parseCachedUtilization', () => {
  const FETCHED = Date.UTC(2026, 8, 5, 12, 40)

  const VALID = claudeJson(
    { fetchedAtMs: FETCHED, utilization: { limits: [SESSION_LIMIT, WEEKLY_ALL_LIMIT] } },
    { numStartups: 12 }
  )

  it('gecerli dosyadan yasi ve pencereleri okur', () => {
    const cached = parseCachedUtilization(VALID)

    expect(cached).not.toBeNull()
    expect(cached?.fetchedAtMs).toBe(FETCHED)
    expect(cached?.windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)'
    ])
    expect(cached?.windows.map((w) => w.percent)).toEqual([22, 20])
  })

  it('BOM ile baslayan dosyayi cozer', () => {
    const cached = parseCachedUtilization('﻿' + VALID)

    expect(cached?.fetchedAtMs).toBe(FETCHED)
    expect(cached?.windows).toHaveLength(2)
  })

  it('bozuk JSON icin null doner, throw ETMEZ', () => {
    expect(() => parseCachedUtilization('{ bu json degil')).not.toThrow()
    expect(parseCachedUtilization('{ bu json degil')).toBeNull()
    expect(parseCachedUtilization('')).toBeNull()
  })

  it('kok deger nesne degilse null doner', () => {
    expect(parseCachedUtilization('null')).toBeNull()
    expect(parseCachedUtilization('"metin"')).toBeNull()
    expect(parseCachedUtilization('42')).toBeNull()
    expect(parseCachedUtilization('[1,2,3]')).toBeNull()
  })

  it('cachedUsageUtilization yoksa veya nesne degilse null doner', () => {
    expect(parseCachedUtilization('{"numStartups":12}')).toBeNull()
    expect(parseCachedUtilization(claudeJson(null))).toBeNull()
    expect(parseCachedUtilization(claudeJson('bos'))).toBeNull()
  })

  it('fetchedAtMs yoksa veya sayi degilse null doner', () => {
    expect(
      parseCachedUtilization(claudeJson({ utilization: { limits: [SESSION_LIMIT] } }))
    ).toBeNull()
    expect(
      parseCachedUtilization(
        claudeJson({ fetchedAtMs: '1757079000000', utilization: { limits: [SESSION_LIMIT] } })
      )
    ).toBeNull()
    expect(
      parseCachedUtilization(
        claudeJson({ fetchedAtMs: null, utilization: { limits: [SESSION_LIMIT] } })
      )
    ).toBeNull()
  })

  it('sonlu olmayan fetchedAtMs kabul edilmez', () => {
    // JSON.parse("1e999") -> Infinity: yas hesabi bunun uzerine kurulamaz.
    const text =
      '{"cachedUsageUtilization":{"fetchedAtMs":1e999,' +
      '"utilization":{"limits":[{"kind":"session","percent":22}]}}}'

    expect(parseCachedUtilization(text)).toBeNull()
  })

  it('limits bos veya hepsi taninmiyorsa null doner (bos pencere gosterilmez)', () => {
    expect(
      parseCachedUtilization(claudeJson({ fetchedAtMs: FETCHED, utilization: { limits: [] } }))
    ).toBeNull()
    expect(parseCachedUtilization(claudeJson({ fetchedAtMs: FETCHED, utilization: {} }))).toBeNull()
    expect(
      parseCachedUtilization(
        claudeJson({
          fetchedAtMs: FETCHED,
          utilization: { limits: [{ kind: 'aylik', percent: 3 }] }
        })
      )
    ).toBeNull()
  })

  it('utilization alani hic yoksa null doner', () => {
    expect(parseCachedUtilization(claudeJson({ fetchedAtMs: FETCHED }))).toBeNull()
  })

  it('fetchedAtMs 0 gecerli sayilir (dusme degeri degil)', () => {
    const cached = parseCachedUtilization(
      claudeJson({ fetchedAtMs: 0, utilization: { limits: [SESSION_LIMIT] } })
    )

    expect(cached?.fetchedAtMs).toBe(0)
  })

  it('dosyadaki kimlik bilgileri donus degerine SIZMAZ', () => {
    const withSecrets = claudeJson(
      { fetchedAtMs: FETCHED, utilization: { limits: [SESSION_LIMIT] } },
      { oauthAccount: { accessToken: TOKEN }, userID: 'kullanici-kimligi' }
    )

    const cached = parseCachedUtilization(withSecrets)

    expect(cached).not.toBeNull()
    expect(JSON.stringify(cached)).not.toContain(TOKEN)
    expect(JSON.stringify(cached)).not.toContain('kullanici-kimligi')
  })
})

// ── fetchUtilization: basari ─────────────────────────────────────────────────

describe('fetchUtilization: basari', () => {
  it('200 + gecerli govde pencereleri doner', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf(SESSION_LIMIT, WEEKLY_ALL_LIMIT)))

    const result = okOf(await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW }))

    expect(result.windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)'
    ])
    expect(nth(result.windows, 0).percent).toBe(22)
  })

  it('fetchedAtMs enjekte edilen now() degeridir', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    const result = okOf(await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW }))

    expect(result.fetchedAtMs).toBe(NOW)
  })

  it('now verilmezse gercek zaman kullanilir', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    const before = Date.now()
    const result = okOf(await fetchUtilization({ readToken: readsToken(), fetchFn }))
    const after = Date.now()

    expect(result.fetchedAtMs).toBeGreaterThanOrEqual(before)
    expect(result.fetchedAtMs).toBeLessThanOrEqual(after)
  })

  it('bilinen kota ucuna https uzerinden gider', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    expect(onlyCall(calls).url).toBe(USAGE_ENDPOINT)
    expect(USAGE_ENDPOINT.startsWith('https://')).toBe(true)
  })

  it('oauth beta basligi ve accept gonderilir', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    const headers = onlyCall(calls).headers
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(headers['accept']).toBe('application/json')
  })
})

// ── fetchUtilization: 429 (bu yolun varlik sebebi) ───────────────────────────

describe('fetchUtilization: 429', () => {
  it('429 sessizce yutulmaz, rate-limited olarak siniflandirilir', async () => {
    const { fetchFn } = spyFetch(reply(429, ''))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('rate-limited')
  })

  it('retry-after basligi sayiya cevrilir', async () => {
    const { fetchFn } = spyFetch(reply(429, '', { 'retry-after': '120' }))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.retryAfterSec).toBe(120)
  })

  it('retry-after yoksa null olur (tahmin uretilmez)', async () => {
    const { fetchFn } = spyFetch(reply(429, ''))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.retryAfterSec).toBeNull()
  })

  it('cozulemeyen veya pozitif olmayan retry-after null olur', async () => {
    for (const raw of ['yakinda', '', '0', '-5', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      const { fetchFn } = spyFetch(reply(429, '', { 'retry-after': raw }))
      const result = errOf(
        await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
      )

      expect(result.retryAfterSec, `retry-after: ${JSON.stringify(raw)}`).toBeNull()
    }
  })

  it('429 govdesinde veri olsa bile basari sayilmaz', async () => {
    const { fetchFn } = spyFetch(reply(429, bodyOf(SESSION_LIMIT)))

    const result = await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    expect(result.ok).toBe(false)
  })
})

// ── fetchUtilization: diger durum kodlari ────────────────────────────────────

describe('fetchUtilization: durum kodlari', () => {
  it('401 ve 403 unauthorized olur', async () => {
    for (const status of [401, 403]) {
      const { fetchFn } = spyFetch(reply(status, ''))
      const result = errOf(
        await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
      )

      expect(result.kind, `HTTP ${status}`).toBe('unauthorized')
      expect(result.retryAfterSec).toBeNull()
    }
  })

  it('500 network olur ve durum kodunu mesajda tasir', async () => {
    const { fetchFn } = spyFetch(reply(500, 'sunucu hatasi'))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('network')
    expect(result.message).toBe('HTTP 500')
  })

  it('2xx disi diger kodlar da network olur', async () => {
    for (const status of [302, 404, 503]) {
      const { fetchFn } = spyFetch(reply(status, ''))
      const result = errOf(
        await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
      )

      expect(result.kind, `HTTP ${status}`).toBe('network')
    }
  })
})

// ── fetchUtilization: govde ──────────────────────────────────────────────────

describe('fetchUtilization: govde', () => {
  it('200 ama JSON degilse bad-body olur', async () => {
    const { fetchFn } = spyFetch(reply(200, '<html>giris yapin</html>'))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('bad-body')
  })

  it('200 ama bos govde bad-body olur — CLI bunu yutuyordu', async () => {
    const { fetchFn } = spyFetch(reply(200, ''))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('bad-body')
  })

  it('200 ama limits bos ise bad-body olur', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf()))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('bad-body')
  })

  it('200 ama kota alani hic yoksa bad-body olur', async () => {
    const bodies = ['{}', '{"limits":null}', '[]', '{"limits":[{"kind":"aylik","percent":3}]}']

    for (const body of bodies) {
      const { fetchFn } = spyFetch(reply(200, body))
      const result = errOf(
        await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
      )

      expect(result.kind, body).toBe('bad-body')
    }
  })

  it('bad-body sonucunda retryAfterSec null kalir', async () => {
    const { fetchFn } = spyFetch(reply(200, '{}', { 'retry-after': '30' }))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.retryAfterSec).toBeNull()
  })
})

// ── fetchUtilization: oturum ve ag ───────────────────────────────────────────

describe('fetchUtilization: oturum ve ag', () => {
  it('jeton yoksa unauthorized doner ve AG CAGRISI HIC yapilmaz', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    const result = errOf(
      await fetchUtilization({ readToken: async () => null, fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('unauthorized')
    expect(calls).toHaveLength(0)
  })

  it('bos jeton da unauthorized sayilir, ag cagrisi yapilmaz', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    const result = errOf(
      await fetchUtilization({ readToken: async () => '', fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('unauthorized')
    expect(calls).toHaveLength(0)
  })

  it('jeton yokken fetchFn verilmese bile gercek aga cikilmaz', async () => {
    const result = errOf(await fetchUtilization({ readToken: async () => null }))

    expect(result.kind).toBe('unauthorized')
  })

  it('fetch throw ederse network olur ve hata mesaji tasinir', async () => {
    const { fetchFn } = spyFetch(throwing(new Error('ECONNREFUSED 127.0.0.1:443')))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('network')
    expect(result.message).toBe('ECONNREFUSED 127.0.0.1:443')
  })

  it('Error olmayan firlatma icin genel mesaj kullanilir', async () => {
    const { fetchFn } = spyFetch(throwing('kopuk'))

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('network')
    expect(result.message).toBe('aga erisilemedi')
  })

  it('govde okunurken kopan baglanti network olur', async () => {
    const fetchFn: FetchFn = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => {
        throw new Error('akis yarida kesildi')
      }
    })

    const result = errOf(
      await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })
    )

    expect(result.kind).toBe('network')
    expect(result.message).toBe('akis yarida kesildi')
  })

  it('readToken reddederse hata yutulmaz', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    await expect(
      fetchUtilization({
        readToken: async () => {
          throw new Error('anahtarlik kilitli')
        },
        fetchFn,
        now: () => NOW
      })
    ).rejects.toThrow('anahtarlik kilitli')
    expect(calls).toHaveLength(0)
  })
})

// ── fetchUtilization: jeton sizintisi ────────────────────────────────────────

describe('fetchUtilization: jeton sizintisi', () => {
  it('jeton YALNIZCA authorization basliginda gecer', async () => {
    const { fetchFn, calls } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    const call = onlyCall(calls)
    expect(call.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(call.url).not.toContain(TOKEN)
    for (const [name, value] of Object.entries(call.headers)) {
      if (name === 'authorization') continue
      expect(value, `baslik: ${name}`).not.toContain(TOKEN)
    }
  })

  it('basari donusunun hicbir alaninda jeton gorunmez', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))

    const result = await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain('Bearer')
  })

  it('govde jetonu yankilasa bile hata donusu jeton tasimaz', async () => {
    for (const status of [401, 429, 500, 200]) {
      const { fetchFn } = spyFetch(reply(status, `jeton yankisi: ${TOKEN}`))
      const result = await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

      expect(result.ok, `HTTP ${status}`).toBe(false)
      expect(JSON.stringify(result), `HTTP ${status}`).not.toContain(TOKEN)
    }
  })

  it('ag hatasinda da donus jeton tasimaz', async () => {
    const { fetchFn } = spyFetch(throwing(new Error('istek basarisiz')))

    const result = await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW })

    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })
})

// ── toSnapshot: sozlesmenin kalbi ────────────────────────────────────────────

describe('toSnapshot', () => {
  const WINDOWS: UsageWindow[] = [
    {
      label: 'Current session',
      percent: 22,
      resetsAtRaw: RESET_SESSION,
      resetsAtMs: Date.parse(RESET_SESSION)
    }
  ]

  it('at alani fetchedAtMs degeridir', () => {
    const snapshot = toSnapshot(NOW, WINDOWS)

    expect(snapshot.at).toBe(NOW)
  })

  it('at, okuma ani DEGIL verinin alinma anidir — 20 dk eski veri eski gorunur', () => {
    const fetchedAtMs = NOW - 20 * 60 * 1000

    const snapshot = toSnapshot(fetchedAtMs, WINDOWS)

    expect(snapshot.at).toBe(fetchedAtMs)
    expect(NOW - snapshot.at).toBe(20 * 60 * 1000)
  })

  it('onbellekten okunan yas anlik goruntuye aynen tasinir', () => {
    const fetchedAtMs = NOW - 35 * 60 * 1000
    const cached = parseCachedUtilization(
      claudeJson({ fetchedAtMs, utilization: { limits: [SESSION_LIMIT] } })
    )
    if (cached === null) throw new Error('onbellek cozulemedi')

    const snapshot = toSnapshot(cached.fetchedAtMs, cached.windows)

    expect(snapshot.at).toBe(fetchedAtMs)
    expect(snapshot.at).toBeLessThan(NOW)
  })

  it('tazelemeden gelen fetchedAtMs anlik goruntuye aynen tasinir', async () => {
    const { fetchFn } = spyFetch(reply(200, bodyOf(SESSION_LIMIT)))
    const result = okOf(await fetchUtilization({ readToken: readsToken(), fetchFn, now: () => NOW }))

    const snapshot = toSnapshot(result.fetchedAtMs, result.windows)

    expect(snapshot.at).toBe(NOW)
    expect(snapshot.windows).toEqual(result.windows)
  })

  it('pencereleri oldugu gibi tasir, metin alanlarini bos birakir', () => {
    const snapshot = toSnapshot(NOW, WINDOWS)

    expect(snapshot.windows).toEqual(WINDOWS)
    expect(snapshot.unparsedLines).toEqual([])
    expect(snapshot.raw).toBe('')
  })

  it('bos pencere listesiyle de calisir, uydurma deger uretmez', () => {
    const snapshot = toSnapshot(NOW, [])

    expect(snapshot.windows).toEqual([])
    expect(snapshot.at).toBe(NOW)
  })
})
