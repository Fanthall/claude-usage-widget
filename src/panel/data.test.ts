import { describe, expect, it } from 'vitest'

import {
  breakdown,
  bridgeSource,
  DAY,
  fillTime,
  heatCells,
  heatLevel,
  HOUR,
  latestQuota,
  metricValue,
  peaks,
  rangeFor,
  mainWindow,
  stackSeries,
  windowLine,
  unattributedShare,
  usagePath,
  type QuotaRow,
  type UsageRow
} from './data'

const MIN = 60_000

function row(atMs: number, account: UsageRow['account'], total: number, extra: Partial<UsageRow> = {}): UsageRow {
  return { atMs, account, total, output: Math.round(total / 10), input: 0, cacheWrite: 0, cacheRead: 0, requests: 1, ...extra }
}

function quota(account: QuotaRow['account'], fetchedAt: number, percent: number, label = 'Current session'): QuotaRow {
  return { account, fetchedAt, label, percent, resetsAtMs: null }
}

// Yerel saatle 2026-11-06 14:30; testler saat dilimine bagli olmasin diye Date ile kurulur.
const NOW = new Date(2026, 10, 6, 14, 30).getTime()
const TODAY = new Date(2026, 10, 6).getTime()

describe('rangeFor', () => {
  it('bugun gece yarisindan gun sonuna kadar', () => {
    expect(rangeFor('today', NOW)).toEqual({ from: TODAY, to: TODAY + DAY })
  })
  it('dun bir onceki tam gun', () => {
    expect(rangeFor('yesterday', NOW)).toEqual({ from: TODAY - DAY, to: TODAY })
  })
  it('7 gun bugunu de kapsar', () => {
    const r = rangeFor('7d', NOW)
    expect(r.to - r.from).toBe(7 * DAY)
  })
})

describe('stackSeries', () => {
  it('satirlari dilimlere ve hesaplara dizer, bos dilim 0', () => {
    const rows = [row(TODAY + 5 * MIN, 'personal', 100), row(TODAY + 20 * MIN, 'team', 40), row(TODAY + 25 * MIN, 'personal', 7)]
    const b = stackSeries(rows, TODAY, TODAY + HOUR, 15 * MIN, 'total')
    expect(b).toHaveLength(4)
    expect(b[0]).toEqual({ atMs: TODAY, personal: 100, team: 0 })
    expect(b[1]).toEqual({ atMs: TODAY + 15 * MIN, personal: 7, team: 40 })
    expect(b[3]).toEqual({ atMs: TODAY + 45 * MIN, personal: 0, team: 0 })
  })
  it('aralik disini ve hesapsiz satiri atar', () => {
    const rows = [row(TODAY - MIN, 'personal', 100), row(TODAY + MIN, undefined, 5)]
    expect(stackSeries(rows, TODAY, TODAY + HOUR, HOUR, 'total')[0]).toEqual({ atMs: TODAY, personal: 0, team: 0 })
  })
  it('cikti olcusu output alanini toplar', () => {
    const b = stackSeries([row(TODAY, 'personal', 100)], TODAY, TODAY + HOUR, HOUR, 'output')
    expect(b[0]?.personal).toBe(10)
  })
  it('onbelleksiz olcu onbellekten okumayi dusurur, toplam katar', () => {
    const r = row(TODAY, 'personal', 1_000, { cacheRead: 990 })
    expect(metricValue(r, 'fresh')).toBe(10)
    expect(metricValue(r, 'total')).toBe(1_000)
    expect(stackSeries([r], TODAY, TODAY + HOUR, HOUR, 'fresh')[0]?.personal).toBe(10)
  })
})

describe('peaks', () => {
  const b = [5, 90, 80, 10, 70, 0].map((v, i) => ({ atMs: i, personal: v, team: 0 }))
  const all = { personal: true, team: true }
  it('en yogunlari secer, komsulari atlar', () => {
    expect(peaks(b, 3, 2, all)).toEqual([1, 4])
  })
  it('gizli hesap sayilmaz', () => {
    expect(peaks(b, 3, 1, { personal: false, team: true })).toEqual([])
  })
})

describe('heatCells / heatLevel', () => {
  it('son 7 gun x 24 saat, bugun son satir', () => {
    const cells = heatCells([row(TODAY + 9 * HOUR + 10 * MIN, 'personal', 50), row(TODAY - 8 * DAY, 'personal', 999)], NOW, 'total')
    expect(cells).toHaveLength(7)
    expect(cells[6]?.dayMs).toBe(TODAY)
    expect(cells[6]?.hours[9]).toBe(50)
    expect(cells.flatMap((d) => d.hours).reduce((a, v) => a + v, 0)).toBe(50)
  })
  it('kademe en buyuk hucreye gore', () => {
    expect(heatLevel(0, 100)).toBe(0)
    expect(heatLevel(5, 100)).toBe(1)
    expect(heatLevel(100, 100)).toBe(5)
    expect(heatLevel(5, 0)).toBe(0)
  })
})

describe('kota yardimcilari', () => {
  it('windowLine istenen pencereyi zaman sirasiyla verir', () => {
    const rows = [quota('personal', 3, 30), quota('personal', 1, 10), quota('personal', 2, 99, 'Current week (all models)'), quota('team', 1, 5)]
    expect(windowLine(rows, 'personal', 'week')).toEqual([{ atMs: 2, percent: 99 }])
    expect(windowLine(rows, 'personal', 'session')).toEqual([
      { atMs: 1, percent: 10 },
      { atMs: 3, percent: 30 }
    ])
  })
  it('latestQuota son ornegin tum pencereleri', () => {
    const rows = [quota('personal', 1, 10), quota('personal', 2, 20), quota('personal', 2, 40, 'Current week (all models)')]
    expect(latestQuota(rows, 'personal').map((r) => r.percent)).toEqual([20, 40])
    expect(latestQuota(rows, 'team')).toEqual([])
  })
  it('ana pencere: 5 saatlik varsa o, yoksa tum modellerin haftasi (model haftasi degil)', () => {
    const withSession = [quota('personal', 2, 20), quota('personal', 2, 40, 'Current week (all models)')]
    expect(mainWindow(withSession)).toMatchObject({ kind: 'session', row: { percent: 20 } })
    // Olculen durum (2026-11-06): API 5 saatlik pencere dondurmuyor.
    const weekly = [quota('personal', 2, 0, 'Current week (Fable)'), quota('personal', 2, 42, 'Current week (all models)')]
    expect(mainWindow(weekly)).toMatchObject({ kind: 'week', row: { percent: 42 } })
    expect(mainWindow([quota('personal', 2, 0, 'Current week (Fable)')])).toBeNull()
  })
})

describe('fillTime', () => {
  it('egimden dolma anini hesaplar', () => {
    const line = [
      { atMs: NOW - HOUR, percent: 40 },
      { atMs: NOW, percent: 60 }
    ]
    // Saatte 20 puan: kalan 40 puan iki saatte dolar.
    expect(fillTime(line, NOW, null)).toBeCloseTo(NOW + 2 * HOUR, -1)
  })
  it('sifirlanmadan once dolmuyorsa null', () => {
    const line = [
      { atMs: NOW - HOUR, percent: 40 },
      { atMs: NOW, percent: 60 }
    ]
    expect(fillTime(line, NOW, NOW + HOUR)).toBeNull()
  })
  it('aralikta sifirlanma ya da duz cizgi varsa null', () => {
    expect(fillTime([{ atMs: NOW - HOUR, percent: 80 }, { atMs: NOW, percent: 5 }], NOW, null)).toBeNull()
    expect(fillTime([{ atMs: NOW - HOUR, percent: 30 }, { atMs: NOW, percent: 30 }], NOW, null)).toBeNull()
    expect(fillTime([{ atMs: NOW, percent: 30 }], NOW, null)).toBeNull()
  })
})

describe('breakdown', () => {
  it('alana gore toplar, buyukten kucuge; bos ad null', () => {
    const rows = [row(0, 'personal', 5, { project: 'a' }), row(0, 'team', 9, { project: null }), row(0, 'personal', 7, { project: 'a' })]
    expect(breakdown(rows, 'project', 'total')).toEqual([
      { key: 'a', value: 12 },
      { key: null, value: 9 }
    ])
  })
})

describe('unattributedShare', () => {
  // Iki temiz kalibrasyon penceresi: puan basina 1000 token.
  const calibration = [
    { atMs: NOW - 10 * HOUR, percent: 0 },
    { atMs: NOW - 8 * HOUR, percent: 20 },
    { atMs: NOW - 7 * HOUR, percent: 2 },
    { atMs: NOW - 6 * HOUR, percent: 32 }
  ]
  const calibRows = [row(NOW - 9 * HOUR, 'personal', 20_000), row(NOW - 7 * HOUR + MIN, 'personal', 30_000)]

  it('kayitli tokenlerin kota artisinin ne kadarini acikladigini tahmin eder', () => {
    // Aralikta 30 puan artis, yalniz 15 puanlik token kaydi: yari aciklaniyor.
    const line = [...calibration, { atMs: NOW - 2 * HOUR, percent: 0 }, { atMs: NOW, percent: 30 }]
    const rows = [...calibRows, row(NOW - HOUR, 'personal', 15_000)]
    const share = unattributedShare(line, rows, NOW - 3 * HOUR, NOW + MIN)
    expect(share?.rise).toBe(30)
    expect(share?.explained).toBeCloseTo(0.5)
  })
  it('kalibrasyon yetmezse null', () => {
    expect(unattributedShare(calibration.slice(0, 2), calibRows, NOW - 3 * HOUR, NOW)).toBeNull()
  })
  it('aralikta artis yoksa null', () => {
    expect(unattributedShare(calibration, calibRows, NOW - HOUR, NOW)).toBeNull()
  })
})

describe('bridgeSource', () => {
  it('goreli yolu kopruye verir, yerel bayragini tasir', async () => {
    const asked: string[] = []
    const source = bridgeSource({
      get: async (path) => {
        asked.push(path)
        return { ok: true, local: true, body: { rows: [row(1, 'personal', 3)] } }
      },
      lang: async () => 'tr'
    })
    const rows = await source.usage(0, 10, 5, ['account', 'model'])
    expect(rows).toHaveLength(1)
    expect(asked).toEqual([usagePath(0, 10, 5, ['account', 'model'])])
    expect(source.isLocal?.()).toBe(true)
  })
  it('kopru hatasini firlatir', async () => {
    const source = bridgeSource({ get: async () => ({ ok: false, local: false, body: null }), lang: async () => 'en' })
    await expect(source.devices()).rejects.toThrow()
  })
})
