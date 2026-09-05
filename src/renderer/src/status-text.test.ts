import { describe, expect, it } from 'vitest'

import type { UsageSnapshot, UsageStatus } from '@shared/types'
import {
  FRESHNESS_NOTICE_MS,
  ageNotice,
  ageText,
  shownData,
  statusNotice
} from './status-text'

const NOW = 1_700_000_000_000

function snapshot(at: number): UsageSnapshot {
  return {
    at,
    windows: [
      { label: 'Current session', percent: 22, resetsAtRaw: '', resetsAtMs: null },
      { label: 'Current week (all models)', percent: 7, resetsAtRaw: '', resetsAtMs: null }
    ],
    unparsedLines: [],
    raw: ''
  }
}

describe('ageText', () => {
  it('asagi yuvarlar — gecen sure abartilmaz', () => {
    expect(ageText(59_999)).toBe('59 sn önce')
    expect(ageText(119_000)).toBe('1 dk önce')
    expect(ageText(59 * 60_000)).toBe('59 dk önce')
    expect(ageText(90 * 60_000)).toBe('1 sa önce')
    expect(ageText(50 * 3_600_000)).toBe('2 gün önce')
  })

  it('negatif yasi 0 sayar (saat kaymasi uydurma deger uretmesin)', () => {
    expect(ageText(-5_000)).toBe('0 sn önce')
  })
})

describe('shownData', () => {
  it("ok durumunda verinin ALINDIGI ani tasir", () => {
    const at = NOW - 20 * 60_000
    const state = shownData({ kind: 'ok', snapshot: snapshot(at) })
    expect(state).toMatchObject({ at, fresh: true })
    expect(state.windows).toHaveLength(2)
  })

  it('hata durumunda son degeri bayat olarak tasir', () => {
    const at = NOW - 60_000
    const state = shownData({
      kind: 'error',
      errorKind: 'rate-limited',
      message: 'kota ucu hiz sinirinda',
      lastSnapshot: snapshot(at)
    })
    expect(state).toMatchObject({ at, fresh: false })
  })

  it('deger yoksa pencere de yas da bos — 0 uydurulmaz', () => {
    expect(shownData({ kind: 'no-data' })).toEqual({ windows: [], at: null, fresh: false })
    expect(
      shownData({ kind: 'error', errorKind: 'not-found', message: 'yok', lastSnapshot: null })
    ).toEqual({ windows: [], at: null, fresh: false })
  })
})

describe('ageNotice', () => {
  it('taze olcumde satir cizilmez', () => {
    const status: UsageStatus = { kind: 'ok', snapshot: snapshot(NOW - 30_000) }
    expect(ageNotice(status, NOW)).toBeNull()
  })

  it("esik asilinca 'ok' iken de yas gorunur (bugunku hatanin oldugu delik)", () => {
    const status: UsageStatus = { kind: 'ok', snapshot: snapshot(NOW - 20 * 60_000) }
    expect(ageNotice(status, NOW)).toEqual({ text: '20 dk önce ölçüldü', stale: false })
  })

  it('esigin hemen altinda sessiz, hemen ustunde konusur', () => {
    const altinda: UsageStatus = { kind: 'ok', snapshot: snapshot(NOW - FRESHNESS_NOTICE_MS + 1) }
    const ustunde: UsageStatus = { kind: 'ok', snapshot: snapshot(NOW - FRESHNESS_NOTICE_MS) }
    expect(ageNotice(altinda, NOW)).toBeNull()
    expect(ageNotice(ustunde, NOW)?.stale).toBe(false)
  })

  it('bayat degeri METINLE isaretler — renk tek basina bilgi tasimaz', () => {
    const status: UsageStatus = {
      kind: 'stale',
      snapshot: snapshot(NOW - 13 * 60_000),
      ageMs: 13 * 60_000,
      reason: 'poll gecikti'
    }
    expect(ageNotice(status, NOW)).toEqual({ text: 'eski değer · 13 dk önce ölçüldü', stale: true })
  })

  it('hiz sinirinda gosterilen deger eski olarak yazilir', () => {
    const status: UsageStatus = {
      kind: 'error',
      errorKind: 'rate-limited',
      message: 'kota ucu hiz sinirinda',
      lastSnapshot: snapshot(NOW - 8 * 60_000)
    }
    expect(ageNotice(status, NOW)).toEqual({ text: 'eski değer · 8 dk önce ölçüldü', stale: true })
  })

  it('deger yokken satir yok', () => {
    expect(ageNotice({ kind: 'loading' }, NOW)).toBeNull()
    expect(ageNotice({ kind: 'no-data' }, NOW)).toBeNull()
  })
})

describe('statusNotice', () => {
  it('ok durumunda satir cizilmez', () => {
    expect(statusNotice({ kind: 'ok', snapshot: snapshot(NOW) })).toBeNull()
  })

  it("hiz siniri ayri metin: 'hata' demez, kendiliginden gececegini soyler", () => {
    const notice = statusNotice({
      kind: 'error',
      errorKind: 'rate-limited',
      message: 'kota ucu hiz sinirinda',
      lastSnapshot: snapshot(NOW - 60_000)
    })
    expect(notice?.tone).toBe('wait')
    expect(notice?.text).toContain('çok sık soruldu')
    expect(notice?.text).toContain('kendiliğinden geçer')
    expect(notice?.text).not.toContain('hata')
    // Geri cekilme sirasinda tekrar deneme beklenen davranis; sayac alarm gibi durmasin.
    expect(notice?.showStreak).toBe(false)
  })

  it('gercek hatalar kirmizi ve sayacli', () => {
    for (const kind of ['not-found', 'not-logged-in', 'timeout', 'bad-output'] as const) {
      const notice = statusNotice({ kind: 'error', errorKind: kind, message: '', lastSnapshot: null })
      expect(notice?.tone).toBe('error')
      expect(notice?.showStreak).toBe(true)
    }
  })

  it('her hata sinifinin ayri metni var (tek genel "hata" yok)', () => {
    const kinds = ['not-found', 'not-logged-in', 'timeout', 'bad-output', 'rate-limited'] as const
    const texts = kinds.map(
      (k) => statusNotice({ kind: 'error', errorKind: k, message: '', lastSnapshot: null })?.text
    )
    expect(new Set(texts).size).toBe(kinds.length)
  })

  it('bilinmeyen hatada toplayicinin mesaji gecer, bossa yerine metin konur', () => {
    expect(
      statusNotice({ kind: 'error', errorKind: 'unknown', message: 'soket kapandi', lastSnapshot: null })
        ?.text
    ).toBe('soket kapandi')
    expect(
      statusNotice({ kind: 'error', errorKind: 'unknown', message: '   ', lastSnapshot: null })?.text
    ).toBe('ölçüm alınamadı')
  })

  it('bayat durumda NEDEN yazilir, yas tekrar edilmez', () => {
    const notice = statusNotice({
      kind: 'stale',
      snapshot: snapshot(NOW - 13 * 60_000),
      ageMs: 13 * 60_000,
      reason: 'poll gecikti'
    })
    expect(notice).toEqual({ text: 'ölçüm gecikti', tone: 'wait', showStreak: false })
  })
})
