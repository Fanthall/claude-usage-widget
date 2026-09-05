import { describe, expect, it } from 'vitest'

import type { UsageWindow } from '../../shared/types'
import { isPreambleLine, parseResetsAt, parseUsageResult, preambleLines } from './usage-parser'

const DOT = '\u00b7'

/** Olcum ani: 5 Eyl 2026 16:00 (Europe/Istanbul) = 13:00 UTC. */
const AT = Date.UTC(2026, 8, 5, 13, 0)

const PREAMBLE = 'You are currently using your subscription to power your Claude Code usage'

const TWO_LINE = [
  PREAMBLE,
  '',
  `Current session: 83% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`,
  `Current week (all models): 20% used ${DOT} resets Sep 6, 8am (Europe/Istanbul)`
].join('\n')

const THREE_LINE = [
  PREAMBLE,
  '',
  `Current session: 83% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`,
  `Current week (all models): 20% used ${DOT} resets Sep 6, 8am (Europe/Istanbul)`,
  `Current week (Opus): 5% used ${DOT} resets Sep 6, 8am (Europe/Istanbul)`
].join('\n')

function nth(windows: UsageWindow[], index: number): UsageWindow {
  const found = windows[index]
  if (found === undefined) throw new Error(`beklenen pencere yok: ${index}`)
  return found
}

describe('parseUsageResult', () => {
  it('gercek iki satirlik ciktiyi ayristirir', () => {
    const snapshot = parseUsageResult(TWO_LINE, AT)

    expect(snapshot.at).toBe(AT)
    expect(snapshot.raw).toBe(TWO_LINE)
    expect(snapshot.windows).toEqual([
      {
        label: 'Current session',
        percent: 83,
        resetsAtRaw: 'Sep 5, 4:50pm (Europe/Istanbul)',
        resetsAtMs: Date.UTC(2026, 8, 5, 13, 50)
      },
      {
        label: 'Current week (all models)',
        percent: 20,
        resetsAtRaw: 'Sep 6, 8am (Europe/Istanbul)',
        resetsAtMs: Date.UTC(2026, 8, 6, 5, 0)
      }
    ])
  })

  it('uc satirli (Opus) varyantta ucunu de alir, etiketi sabit listeye baglamaz', () => {
    const snapshot = parseUsageResult(THREE_LINE, AT)

    expect(snapshot.windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Opus)'
    ])
    expect(nth(snapshot.windows, 2).percent).toBe(5)
  })

  it('bos stringde bos snapshot doner, throw etmez', () => {
    const snapshot = parseUsageResult('', AT)

    expect(snapshot).toEqual({ at: AT, windows: [], unparsedLines: [], raw: '' })
  })

  it('tamamen alakasiz metinde windows bos kalir, satirlar unparsedLines\'a tasinir', () => {
    const raw = 'Error: something went wrong\nTry again later'
    const snapshot = parseUsageResult(raw, AT)

    expect(snapshot.windows).toEqual([])
    expect(snapshot.unparsedLines).toEqual(['Error: something went wrong', 'Try again later'])
  })

  // B1: onsoz HER olcumde gelir; anomali degil. `unparsedLines` yalnizca
  // gercekten beklenmedik satiri ifade etmeli, yoksa alan her zaman doludur
  // ve "anomali var mi" sorusu anlamsizlasir. Metin `raw` icinde durur.
  it('bilinen onsoz satirini unparsedLines\'a KOYMAZ', () => {
    const snapshot = parseUsageResult(TWO_LINE, AT)

    expect(snapshot.unparsedLines).toEqual([])
    expect(snapshot.raw).toContain(PREAMBLE)
  })

  it('onsoz yaninda gercek anomali varsa yalnizca anomaliyi tasir', () => {
    const raw = [PREAMBLE, '', 'Warning: beklenmedik satir', TWO_LINE.split('\n')[2] ?? ''].join(
      '\n'
    )
    const snapshot = parseUsageResult(raw, AT)

    expect(snapshot.unparsedLines).toEqual(['Warning: beklenmedik satir'])
    expect(snapshot.windows).toHaveLength(1)
  })

  it('onsoz kalibina uyan satir pencerelerden SONRA gelirse anomali sayilir', () => {
    const raw = [
      `Current session: 83% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`,
      PREAMBLE
    ].join('\n')
    const snapshot = parseUsageResult(raw, AT)

    expect(snapshot.unparsedLines).toEqual([PREAMBLE])
  })

  it('kaliba uymayan gercek satiri sessizce atmaz', () => {
    const snapshot = parseUsageResult(`${PREAMBLE}\nBeklenmedik bir sey`, AT)

    expect(snapshot.unparsedLines).toEqual(['Beklenmedik bir sey'])
  })

  it('%0 ve %100 degerlerini kabul eder', () => {
    const raw = [
      `Current session: 0% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`,
      `Current week (all models): 100% used ${DOT} resets Sep 6, 8am (Europe/Istanbul)`
    ].join('\n')
    const snapshot = parseUsageResult(raw, AT)

    expect(snapshot.windows.map((w) => w.percent)).toEqual([0, 100])
    expect(snapshot.unparsedLines).toEqual([])
  })

  it('%100 ustu degeri kabul etmez, unparsedLines\'a koyar', () => {
    const line = `Current session: 140% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`
    const snapshot = parseUsageResult(line, AT)

    expect(snapshot.windows).toEqual([])
    expect(snapshot.unparsedLines).toEqual([line])
  })

  it('"·" yerine nokta veya tire gelirse de ayristirir', () => {
    const raw = [
      'Current session: 83% used . resets Sep 5, 4:50pm (Europe/Istanbul)',
      'Current week (all models): 20% used - resets Sep 6, 8am (Europe/Istanbul)',
      'Current week (Opus): 5% used resets Sep 6, 8am (Europe/Istanbul)'
    ].join('\n')
    const snapshot = parseUsageResult(raw, AT)

    expect(snapshot.windows.map((w) => w.percent)).toEqual([83, 20, 5])
    expect(snapshot.unparsedLines).toEqual([])
  })

  it('sifirlanma saati ayristirilamayinca pencere kalir ama resetsAtMs null olur', () => {
    const raw = `Current session: 83% used ${DOT} resets in about 4 hours`
    const snapshot = parseUsageResult(raw, AT)

    expect(nth(snapshot.windows, 0)).toEqual({
      label: 'Current session',
      percent: 83,
      resetsAtRaw: 'in about 4 hours',
      resetsAtMs: null
    })
  })

  it('CRLF satir sonlarini da isler', () => {
    const snapshot = parseUsageResult(TWO_LINE.replace(/\n/g, '\r\n'), AT)

    expect(snapshot.windows).toHaveLength(2)
    expect(nth(snapshot.windows, 0).resetsAtRaw).toBe('Sep 5, 4:50pm (Europe/Istanbul)')
  })
})

describe('parseResetsAt', () => {
  it('"4:50pm" bicimini cozer', () => {
    expect(parseResetsAt('Sep 5, 4:50pm (Europe/Istanbul)', AT)).toBe(
      Date.UTC(2026, 8, 5, 13, 50)
    )
  })

  it('"8am" bicimini (dakikasiz) cozer', () => {
    expect(parseResetsAt('Sep 6, 8am (Europe/Istanbul)', AT)).toBe(Date.UTC(2026, 8, 6, 5, 0))
  })

  it('12am gece yarisi, 12pm ogledir', () => {
    expect(parseResetsAt('Sep 6, 12am (Europe/Istanbul)', AT)).toBe(Date.UTC(2026, 8, 5, 21, 0))
    expect(parseResetsAt('Sep 6, 12pm (Europe/Istanbul)', AT)).toBe(Date.UTC(2026, 8, 6, 9, 0))
  })

  it('yil verilmediginde olcum anina en yakin yili secer (yil sonu gecisi)', () => {
    const newYearEve = Date.UTC(2026, 11, 31, 19, 0) // 31 Ara 2026 22:00 Istanbul
    expect(parseResetsAt('Jan 1, 8am (Europe/Istanbul)', newYearEve)).toBe(
      Date.UTC(2027, 0, 1, 5, 0)
    )
  })

  it('zaman dilimi verilmezse yerel saat olarak yorumlar', () => {
    expect(parseResetsAt('Sep 5, 4:50pm', AT)).toBe(new Date(2026, 8, 5, 16, 50).getTime())
  })

  it('am/pm isareti yoksa tahmin uretmez', () => {
    expect(parseResetsAt('Sep 5, 16:50 (Europe/Istanbul)', AT)).toBeNull()
  })

  it('taninmayan bicimlerde null doner', () => {
    expect(parseResetsAt('tomorrow morning', AT)).toBeNull()
    expect(parseResetsAt('Foo 5, 4:50pm', AT)).toBeNull()
    expect(parseResetsAt('', AT)).toBeNull()
  })

  it('olmayan takvim gununu kabul etmez', () => {
    expect(parseResetsAt('Feb 30, 8am (Europe/Istanbul)', AT)).toBeNull()
  })

  it('13 gibi 12-saat disi degeri kabul etmez', () => {
    expect(parseResetsAt('Sep 5, 13:00pm (Europe/Istanbul)', AT)).toBeNull()
  })

  it('metinde yil varsa taninmaz, null doner (uydurma yok)', () => {
    expect(parseResetsAt('Sep 5, 2026, 4:50pm (Europe/Istanbul)', AT)).toBeNull()
  })

  it('taninmayan zaman dilimi adinda yerel saate duser, cokmez', () => {
    expect(parseResetsAt('Sep 5, 4:50pm (Not/AZone)', AT)).toBe(
      new Date(2026, 8, 5, 16, 50).getTime()
    )
  })
})

describe('onsoz siniflandirmasi (B1)', () => {
  it('olculmus onsoz satirini tanir', () => {
    expect(isPreambleLine(PREAMBLE)).toBe(true)
    expect(isPreambleLine("  You're currently using your subscription  ")).toBe(true)
  })

  it('pencere satirini ve rastgele metni onsoz saymaz', () => {
    expect(isPreambleLine(`Current session: 83% used ${DOT} resets Sep 5, 4:50pm`)).toBe(false)
    expect(isPreambleLine('Error: something went wrong')).toBe(false)
    expect(isPreambleLine('')).toBe(false)
  })

  it('onsoz metni kaybolmaz, ham ciktidan geri okunabilir', () => {
    expect(preambleLines(TWO_LINE)).toEqual([PREAMBLE])
    expect(preambleLines('Error: yok')).toEqual([])
  })
})

describe('parseUsageResult ondalikli yuzde', () => {
  it('ondalikli yuzdeyi kabul eder', () => {
    const line = `Current session: 83.5% used ${DOT} resets Sep 5, 4:50pm (Europe/Istanbul)`
    const snapshot = parseUsageResult(line, AT)

    expect(snapshot.windows).toEqual([
      {
        label: 'Current session',
        percent: 83.5,
        resetsAtRaw: 'Sep 5, 4:50pm (Europe/Istanbul)',
        resetsAtMs: Date.UTC(2026, 8, 5, 13, 50)
      }
    ])
  })
})

describe('sifirlanma saati olmayan pencere (K1 regresyonu)', () => {
  it('resets kuyrugu olmayan satiri pencere olarak alir, unparsed birakmaz', () => {
    const raw = [
      'You are currently using your subscription to power your Claude Code usage',
      '',
      'Current session: 62% used · resets Sep 5, 9:50pm (Europe/Istanbul)',
      'Current week (all models): 27% used · resets Sep 6, 8am (Europe/Istanbul)',
      'Current week (Fable): 0% used'
    ].join('\n')

    const snap = parseUsageResult(raw, Date.parse('2026-09-05T15:00:00Z'))

    expect(snap.windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)'
    ])
    expect(snap.unparsedLines).toEqual([])
  })

  it('sifirlanma saati yoksa resetsAtMs null, resetsAtRaw bos', () => {
    const snap = parseUsageResult('Current week (Fable): 0% used', 1788600000000)
    expect(snap.windows).toHaveLength(1)
    expect(snap.windows[0]?.resetsAtMs).toBeNull()
    expect(snap.windows[0]?.resetsAtRaw).toBe('')
    expect(snap.windows[0]?.percent).toBe(0)
  })
})

describe('ayrinti bolumu anomali degildir (canli cikti regresyonu)', () => {
  /** 2026-09-05'te gercek `/usage` ciktisindan alindi. */
  const CANLI = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    `Current session: 64% used ${DOT} resets Sep 5, 9:50pm (Europe/Istanbul)`,
    `Current week (all models): 28% used ${DOT} resets Sep 6, 8am (Europe/Istanbul)`,
    'Current week (Fable): 0% used',
    '',
    "What's contributing to your limits usage?",
    'Approximate, based on local sessions on this machine — does not include other devices.',
    '',
    `Last 24h ${DOT} 4134 requests ${DOT} 9 sessions`,
    '  88% of your usage came from subagent-heavy sessions',
    '  75% of your usage was at >150k context',
    '  Top subagents: workflow-subagent 40%, general-purpose 2%'
  ].join('\n')

  it('uc pencereyi alir, ayrinti bolumunu anomali saymaz', () => {
    const snap = parseUsageResult(CANLI, AT)
    expect(snap.windows.map((w) => w.label)).toEqual([
      'Current session',
      'Current week (all models)',
      'Current week (Fable)'
    ])
    // Onceki davranis: 13 satir "okunamadi" sayiliyordu ve gosterge her saglikli
    // olcumde uyari veriyordu.
    expect(snap.unparsedLines).toEqual([])
  })

  it('ayrinti bolumu icindeki yuzdeli satirlar pencere sanilmaz', () => {
    const snap = parseUsageResult(CANLI, AT)
    expect(snap.windows.some((w) => w.label.includes('subagent'))).toBe(false)
    expect(snap.windows).toHaveLength(3)
  })
})
