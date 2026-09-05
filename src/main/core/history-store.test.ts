import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POLL_INTERVAL_MS,
  HISTORY_GAP_MS,
  SNAPSHOT_SCHEMA_VERSION,
  gapThresholdMs,
  type HistoryEntry,
  type UsageSnapshot
} from '../../shared/types'
import {
  HISTORY_FILE_NAME,
  appendSnapshot,
  canRotate,
  detectGaps,
  historyFilePath,
  isEmptyMeasurement,
  listRotatedFiles,
  nodeHistoryFs,
  readRange,
  resolveGapMs,
  rotateHistory,
  rotatedFileName,
  splitSegments,
  type HistoryFs,
  type RotationResult
} from './history-store'

/**
 * Testler os.tmpdir() altinda benzersiz dizinlerde calisir. Dizinler silinmez
 * (hard-rule A2); temizlik isletim sistemine birakilir.
 */
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'cuw-history-'))
}

function snapshot(at: number, percent: number, raw = 'ham cikti'): UsageSnapshot {
  return {
    at,
    windows: [
      {
        label: 'Current session',
        percent,
        resetsAtRaw: 'Sep 5, 4:50pm (Europe/Istanbul)',
        resetsAtMs: at + 3_600_000
      }
    ],
    unparsedLines: [],
    raw
  }
}

function entry(at: number): HistoryEntry {
  return { v: SNAPSHOT_SCHEMA_VERSION, ...snapshot(at, 10) }
}

/** Olcum yapildi ama hicbir pencere ayristirilamadi (CLI bozuk cikti verdi). */
function emptySnapshot(at: number): UsageSnapshot {
  return { at, windows: [], unparsedLines: ['Error: bir sey ters gitti'], raw: 'bozuk' }
}

function emptyEntry(at: number): HistoryEntry {
  return { v: SNAPSHOT_SCHEMA_VERSION, ...emptySnapshot(at) }
}

/** `noUncheckedIndexedAccess` acikken indekslemeyi okunur kilar. */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`beklenen oge yok: ${index}`)
  return item
}

describe('appendSnapshot + readRange', () => {
  it('yazilan kaydi ayni haliyle geri okur ve dizini olusturur', async () => {
    const dir = join(await tempDir(), 'yok', 'daha-da-yok')
    const snap = snapshot(1_000, 42)

    const written = await appendSnapshot(dir, snap)
    expect(written).toEqual({ v: SNAPSHOT_SCHEMA_VERSION, ...snap })

    const result = await readRange(dir, 0, 10_000)
    expect(result.skipped).toBe(0)
    expect(result.entries).toEqual([{ v: SNAPSHOT_SCHEMA_VERSION, ...snap }])
    expect(nth(result.records, 0).future).toBe(false)
  })

  it('her kaydi tek satir olarak append eder', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(1_000, 10))
    await appendSnapshot(dir, snapshot(2_000, 20, 'iki\nsatirli\nham metin'))

    const text = await readFile(historyFilePath(dir), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.trimEnd().split('\n')).toHaveLength(2)
  })

  it('yalnizca aralik icindeki kayitlari dondurur (iki uc dahil)', async () => {
    const dir = await tempDir()
    for (const at of [1_000, 2_000, 3_000, 4_000]) {
      await appendSnapshot(dir, snapshot(at, 5))
    }

    const result = await readRange(dir, 2_000, 3_000)
    expect(result.entries.map((item) => item.at)).toEqual([2_000, 3_000])
  })

  it('kayitlari at artan sirada dondurur', async () => {
    const dir = await tempDir()
    for (const at of [3_000, 1_000, 2_000]) {
      await appendSnapshot(dir, snapshot(at, 5))
    }

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries.map((item) => item.at)).toEqual([1_000, 2_000, 3_000])
  })

  it('ayni ms icindeki iki kaydi da yazma sirasiyla korur', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(5_000, 10, 'once'))
    await appendSnapshot(dir, snapshot(5_000, 20, 'sonra'))

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries).toHaveLength(2)
    expect(result.entries.map((item) => item.raw)).toEqual(['once', 'sonra'])
    expect(result.skipped).toBe(0)
  })

  it('enjekte edilen dosya sistemiyle calisir', async () => {
    const lines: string[] = []
    const created: string[] = []
    const fakeFs: HistoryFs = {
      async ensureDir(dir) {
        created.push(dir)
      },
      async appendLine(_file, line) {
        lines.push(line)
      },
      async *readLines() {
        for (const line of lines) yield line.replace(/\n$/, '')
      }
    }

    await appendSnapshot('/sanal/dizin', snapshot(7_000, 33), { fs: fakeFs })
    expect(created).toEqual(['/sanal/dizin'])
    expect(lines).toHaveLength(1)

    const result = await readRange('/sanal/dizin', 0, 10_000, { fs: fakeFs })
    expect(nth(result.entries, 0).at).toBe(7_000)
  })
})

describe('readRange — bozuk ve eksik veri', () => {
  it('bozuk satirlari atlar ve sayisini dondurur', async () => {
    const dir = await tempDir()
    const good = JSON.stringify({ v: SNAPSHOT_SCHEMA_VERSION, ...snapshot(1_000, 40) })
    await writeFile(
      historyFilePath(dir),
      [
        good,
        '{"v":1,"at":2000,"windows":[', // yarim yazilmis satir
        'bu JSON degil',
        '[1,2,3]', // dizi, kayit degil
        '{"v":1,"windows":[],"unparsedLines":[],"raw":""}', // at yok
        '{"v":1,"at":3000,"windows":[{"label":"x","percent":"yuzde"}],"unparsedLines":[],"raw":""}',
        '', // bos satir bozuk sayilmaz
        '   '
      ].join('\n') + '\n',
      'utf8'
    )

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries).toHaveLength(1)
    expect(nth(result.entries, 0).at).toBe(1_000)
    expect(result.skipped).toBe(5)
  })

  it('bos dosyada bos sonuc dondurur', async () => {
    const dir = await tempDir()
    await writeFile(historyFilePath(dir), '', 'utf8')

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries).toEqual([])
    expect(result.records).toEqual([])
    expect(result.skipped).toBe(0)
  })

  it('dosya hic yoksa hata atmaz', async () => {
    const dir = join(await tempDir(), 'henuz-yok')

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries).toEqual([])
    expect(result.skipped).toBe(0)
  })

  it('ENOENT disindaki dosya hatasi yutulmaz, disari firlar', async () => {
    const boom = Object.assign(new Error('izin yok'), { code: 'EACCES' })
    const fakeFs: HistoryFs = {
      async ensureDir() {},
      async appendLine() {},
      async *readLines(): AsyncIterable<string> {
        throw boom
      }
    }

    await expect(readRange('/sanal', 0, 10_000, { fs: fakeFs })).rejects.toBe(boom)
  })

  it('sondaki satir yeni satirla bitmese de okunur', async () => {
    const dir = await tempDir()
    const line = JSON.stringify({ v: SNAPSHOT_SCHEMA_VERSION, ...snapshot(1_000, 40) })
    await writeFile(historyFilePath(dir), line, 'utf8')

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries).toHaveLength(1)
  })
})

describe('readRange — ileri surum satirlari', () => {
  it('ileri surum satirini atlamaz, ham haliyle tasir', async () => {
    const dir = await tempDir()
    const futureLine = JSON.stringify({
      v: SNAPSHOT_SCHEMA_VERSION + 1,
      at: 2_000,
      windows: [
        {
          label: 'Current week (all models)',
          percent: 20,
          resetsAtRaw: 'Sep 6, 8am (Europe/Istanbul)',
          resetsAtMs: null,
          trend: 'rising' // bu surumun bilmedigi alan
        }
      ],
      unparsedLines: [],
      raw: 'ham',
      opusWindow: { percent: 3 } // bu surumun bilmedigi alan
    })
    await writeFile(historyFilePath(dir), `${futureLine}\n`, 'utf8')

    const result = await readRange(dir, 0, 10_000)
    expect(result.skipped).toBe(0)
    expect(result.records).toHaveLength(1)

    const record = nth(result.records, 0)
    expect(record.future).toBe(true)
    expect(record.entry.at).toBe(2_000)
    expect(nth(record.entry.windows, 0).percent).toBe(20)
    // Ham satir korunur: eski surum dosyayi yeniden yazsa bile yeni alan durur.
    expect(record.raw).toBe(futureLine)
    expect(JSON.parse(record.raw)).toMatchObject({ opusWindow: { percent: 3 } })
  })

  it('ileri surum satiri tanimadigimiz sekilde olsa da atlanmaz', async () => {
    const dir = await tempDir()
    const alien = JSON.stringify({
      v: SNAPSHOT_SCHEMA_VERSION + 5,
      at: 4_000,
      windows: 'artik dizi degil',
      series: [1, 2, 3]
    })
    await writeFile(historyFilePath(dir), `${alien}\n`, 'utf8')

    const result = await readRange(dir, 0, 10_000)
    expect(result.skipped).toBe(0)

    const record = nth(result.records, 0)
    expect(record.future).toBe(true)
    expect(record.entry.windows).toEqual([])
    expect(record.entry.raw).toBe('')
    expect(record.raw).toBe(alien)
  })

  it('ileri surum satirlari da zaman sirasina girer', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(1_000, 10))
    await writeFile(
      historyFilePath(dir),
      `${JSON.stringify({ v: SNAPSHOT_SCHEMA_VERSION + 1, at: 500, windows: [], unparsedLines: [], raw: '' })}\n`,
      { encoding: 'utf8', flag: 'a' }
    )

    const result = await readRange(dir, 0, 10_000)
    expect(result.entries.map((item) => item.at)).toEqual([500, 1_000])
    expect(result.records.map((item) => item.future)).toEqual([true, false])
  })
})

describe('detectGaps', () => {
  it('esigi asan araligi bosluk isaretler', async () => {
    const base = 1_000_000
    const entries = [
      entry(base),
      entry(base + 60_000),
      entry(base + 60_000 + HISTORY_GAP_MS + 1),
      entry(base + 120_000 + HISTORY_GAP_MS)
    ]

    const gaps = detectGaps(entries)
    expect(gaps).toHaveLength(1)
    expect(nth(gaps, 0)).toEqual({
      beforeIndex: 1,
      fromMs: base + 60_000,
      toMs: base + 60_000 + HISTORY_GAP_MS + 1,
      durationMs: HISTORY_GAP_MS + 1
    })
  })

  it('tam esik degerinde bosluk saymaz', () => {
    const entries = [entry(0), entry(HISTORY_GAP_MS)]
    expect(detectGaps(entries)).toEqual([])
  })

  it('bos ve tek elemanli dizide bosluk yok', () => {
    expect(detectGaps([])).toEqual([])
    expect(detectGaps([entry(0)])).toEqual([])
  })

  it('ayni ms icindeki kayitlar bosluk uretmez', () => {
    expect(detectGaps([entry(5_000), entry(5_000)])).toEqual([])
  })

  it('birden fazla boslugu sirayla bulur', () => {
    const step = HISTORY_GAP_MS * 2
    const entries = [entry(0), entry(step), entry(step * 2)]
    expect(detectGaps(entries).map((gap) => gap.beforeIndex)).toEqual([0, 1])
  })

  it('esik parametreyle degistirilebilir', () => {
    const entries = [entry(0), entry(10_000)]
    expect(detectGaps(entries, 5_000)).toHaveLength(1)
    expect(detectGaps(entries, 20_000)).toHaveLength(0)
  })

  it('app 3 saat kapali kalirsa seri kesilir (REQ-1)', async () => {
    const dir = await tempDir()
    const base = 1_700_000_000_000
    await appendSnapshot(dir, snapshot(base, 10))
    await appendSnapshot(dir, snapshot(base + 60_000, 12))
    await appendSnapshot(dir, snapshot(base + 3 * 60 * 60_000, 30))

    const result = await readRange(dir, 0, Number.MAX_SAFE_INTEGER)
    const segments = splitSegments(result.entries)
    expect(segments.map((segment) => segment.length)).toEqual([2, 1])
  })
})

describe('splitSegments', () => {
  it('boslugu olmayan seriyi tek parca dondurur', () => {
    const entries = [entry(0), entry(60_000), entry(120_000)]
    expect(splitSegments(entries)).toHaveLength(1)
  })

  it('bos dizide parca uretmez', () => {
    expect(splitSegments([])).toEqual([])
  })
})

describe('historyFilePath', () => {
  it('varsayilan dosya adini kullanir', () => {
    expect(historyFilePath('/veri')).toBe(join('/veri', HISTORY_FILE_NAME))
  })
})

// ── B4: esik sabit degil, olcum araligina bagli ──────────────────────────────

describe('resolveGapMs', () => {
  it('parametresiz cagride sabit HISTORY_GAP_MS kalir (geriye donuk uyum)', () => {
    expect(resolveGapMs()).toBe(HISTORY_GAP_MS)
  })

  it('dogrudan sayi verilirse onu kullanir', () => {
    expect(resolveGapMs(7_000)).toBe(7_000)
  })

  it('olcum araligindan gapThresholdMs ile turetir', () => {
    expect(resolveGapMs({ pollIntervalMs: 5 * 60_000 })).toBe(gapThresholdMs(5 * 60_000))
    expect(resolveGapMs({ pollIntervalMs: 5 * 60_000 })).toBe(750_000)
  })

  it('varsayilan aralik esigi olcekler — sabit esik artik taban', () => {
    // Varsayilan aralik 60 sn'den 5 dk'ya cikti (kota ucu 60 sn'de 429 verdi).
    // Bu aralikta sabit HISTORY_GAP_MS ardisik HER cifti bosluk sayardi;
    // esik aralikla olceklendigi icin seri butun kalir.
    expect(resolveGapMs({ pollIntervalMs: DEFAULT_POLL_INTERVAL_MS })).toBe(
      DEFAULT_POLL_INTERVAL_MS * 2.5
    )
    expect(resolveGapMs({ pollIntervalMs: DEFAULT_POLL_INTERVAL_MS })).toBeGreaterThan(
      HISTORY_GAP_MS
    )
  })

  it('cok kisa aralikta sabit taban korunur', () => {
    expect(resolveGapMs({ pollIntervalMs: 10_000 })).toBe(HISTORY_GAP_MS)
  })

  it('acik gapMs, pollIntervalMs\'i ezer', () => {
    expect(resolveGapMs({ gapMs: 1_000, pollIntervalMs: 5 * 60_000 })).toBe(1_000)
  })
})

describe('detectGaps — aralik duyarli esik (B4)', () => {
  // Kusur: 5 dk aralik + sabit 5 dk esik → gercek olcumler tam saniyesinde
  // gelmedigi icin ardisik HER cift boslugu asar; grafikte tek cizgi kalmaz.
  const POLL = 5 * 60_000
  /** Olcumler timer gecikmesiyle esigin bir tik ustunde duser. */
  const step = POLL + 1_500

  it('5 dk araliktaki DUZENLI olcumler bosluk saymaz', () => {
    const entries = [entry(0), entry(step), entry(step * 2), entry(step * 3)]

    // Sabit esikle her adim bosluk olur:
    expect(detectGaps(entries, HISTORY_GAP_MS)).toHaveLength(3)
    // Aralik bildirilince seri butun kalir:
    expect(detectGaps(entries, { pollIntervalMs: POLL })).toEqual([])
  })

  it('aralik bilinse de gercek kesinti yine yakalanir', () => {
    const entries = [entry(0), entry(step), entry(step + 3 * 60 * 60_000)]

    expect(detectGaps(entries, { pollIntervalMs: POLL })).toHaveLength(1)
  })
})

describe('splitSegments — aralik duyarli esik (B4)', () => {
  it('5 dk araliktaki seri tek parca kalir', () => {
    const step = 5 * 60_000 + 1_500
    const entries = [entry(0), entry(step), entry(step * 2)]

    expect(splitSegments(entries, HISTORY_GAP_MS)).toHaveLength(3)
    expect(splitSegments(entries, { pollIntervalMs: 5 * 60_000 })).toHaveLength(1)
  })
})

// ── B5: pencere tasimayan kayit ──────────────────────────────────────────────

describe('bos olcum kayitlari (B5)', () => {
  it('isEmptyMeasurement pencere tasimayan kaydi ayirt eder', () => {
    expect(isEmptyMeasurement(emptyEntry(0))).toBe(true)
    expect(isEmptyMeasurement(entry(0))).toBe(false)
  })

  it('okurken isaretlenir ve sayilir — sessizce normal kayit gibi durmaz', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(1_000, 10))
    await appendSnapshot(dir, emptySnapshot(2_000))

    const result = await readRange(dir, 0, 10_000)
    expect(result.emptyCount).toBe(1)
    expect(result.records.map((record) => record.emptyWindows)).toEqual([false, true])
    // Kayit atilmaz: ham satir ve unparsedLines tanida durur.
    expect(result.entries).toHaveLength(2)
  })

  it('okunamayan ileri surum satiri da bos isaretlenir', async () => {
    const dir = await tempDir()
    await writeFile(
      historyFilePath(dir),
      `${JSON.stringify({ v: SNAPSHOT_SCHEMA_VERSION + 1, at: 500, series: [1, 2] })}\n`,
      'utf8'
    )

    const result = await readRange(dir, 0, 10_000)
    expect(nth(result.records, 0).emptyWindows).toBe(true)
    expect(result.emptyCount).toBe(1)
  })

  it('bos kayit grafikte DUZ CIZGI uretmez: seriyi keser ve parcaya girmez', () => {
    const step = 60_000
    const entries = [entry(0), entry(step), emptyEntry(step * 2), entry(step * 3), entry(step * 4)]

    const segments = splitSegments(entries)
    expect(segments.map((segment) => segment.length)).toEqual([2, 2])
    expect(segments.flat().some(isEmptyMeasurement)).toBe(false)
  })

  it('bastaki ve sondaki bos kayitlar bos parca uretmez', () => {
    const entries = [emptyEntry(0), entry(60_000), emptyEntry(120_000)]

    expect(splitSegments(entries).map((segment) => segment.length)).toEqual([1])
  })

  it('sadece bos kayit varsa hic parca cikmaz', () => {
    expect(splitSegments([emptyEntry(0), emptyEntry(60_000)])).toEqual([])
  })

  it('keepEmpty ile eski davranis istenirse bos kayit seride kalir', () => {
    const entries = [entry(0), emptyEntry(60_000), entry(120_000)]

    expect(splitSegments(entries, { keepEmpty: true }).map((s) => s.length)).toEqual([3])
  })
})

// ── Rotasyon: tavan asilinca DONDUR, silme ───────────────────────────────────

describe('rotatedFileName', () => {
  it('kusak numarasini uzantinin onune koyar', () => {
    expect(rotatedFileName(HISTORY_FILE_NAME, 1)).toBe('usage-history.1.jsonl')
    expect(rotatedFileName(HISTORY_FILE_NAME, 12)).toBe('usage-history.12.jsonl')
  })

  it('uzantisiz ada sona ekler', () => {
    expect(rotatedFileName('tarihce', 3)).toBe('tarihce.3')
  })
})

describe('listRotatedFiles', () => {
  it('yalnizca kusaklari, numara artan sirada dondurur', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, HISTORY_FILE_NAME), '', 'utf8')
    for (const name of [
      'usage-history.2.jsonl',
      'usage-history.10.jsonl',
      'usage-history.1.jsonl',
      'usage-history.jsonl.bak',
      'baska-dosya.jsonl'
    ]) {
      await writeFile(join(dir, name), '', 'utf8')
    }

    expect(await listRotatedFiles(dir)).toEqual([
      join(dir, 'usage-history.1.jsonl'),
      join(dir, 'usage-history.2.jsonl'),
      join(dir, 'usage-history.10.jsonl')
    ])
  })

  it('dizin yoksa bos liste doner', async () => {
    expect(await listRotatedFiles(join(await tempDir(), 'yok'))).toEqual([])
  })
})

describe('appendSnapshot — rotasyon', () => {
  /** Tek kaydin bayt uzunlugu; tavani kayit sayisiyla ifade etmek icin. */
  function lineBytes(at: number): number {
    return Buffer.byteLength(
      `${JSON.stringify({ v: SNAPSHOT_SCHEMA_VERSION, ...snapshot(at, 10) })}\n`,
      'utf8'
    )
  }

  it('tavan altinda kalirken donmez', async () => {
    const dir = await tempDir()
    const maxBytes = lineBytes(1_000) * 5

    await appendSnapshot(dir, snapshot(1_000, 10), { maxBytes })
    await appendSnapshot(dir, snapshot(2_000, 20), { maxBytes })

    expect(await listRotatedFiles(dir)).toEqual([])
    expect((await readRange(dir, 0, 10_000)).entries).toHaveLength(2)
  })

  it('tavan asilinca dosya SILINMEZ, kusaga tasinir', async () => {
    const dir = await tempDir()
    const rotations: RotationResult[] = []
    const maxBytes = lineBytes(1_000) + 1

    await appendSnapshot(dir, snapshot(1_000, 10), { maxBytes })
    await appendSnapshot(dir, snapshot(2_000, 20), {
      maxBytes,
      onRotate: (result) => void rotations.push(result)
    })

    expect(rotations).toHaveLength(1)
    expect(nth(rotations, 0).index).toBe(1)
    expect(nth(rotations, 0).to).toBe(join(dir, 'usage-history.1.jsonl'))

    // Eski kayit kusakta duruyor, yeni kayit aktif dosyada.
    const old = await readFile(join(dir, 'usage-history.1.jsonl'), 'utf8')
    const current = await readFile(historyFilePath(dir), 'utf8')
    expect(JSON.parse(old.trim())).toMatchObject({ at: 1_000 })
    expect(JSON.parse(current.trim())).toMatchObject({ at: 2_000 })
  })

  it('ikinci donus kusak 1i EZMEZ, 2ye yazar', async () => {
    const dir = await tempDir()
    const maxBytes = lineBytes(1_000) + 1

    for (const at of [1_000, 2_000, 3_000]) {
      await appendSnapshot(dir, snapshot(at, 10), { maxBytes })
    }

    expect(await listRotatedFiles(dir)).toEqual([
      join(dir, 'usage-history.1.jsonl'),
      join(dir, 'usage-history.2.jsonl')
    ])
  })

  it('bos dosyada donmez — tek satir tavandan buyukse sonsuz donus olurdu', async () => {
    const dir = await tempDir()

    await appendSnapshot(dir, snapshot(1_000, 10), { maxBytes: 1 })
    await appendSnapshot(dir, snapshot(2_000, 20), { maxBytes: 1 })

    expect(await listRotatedFiles(dir)).toEqual([join(dir, 'usage-history.1.jsonl')])
    expect((await readRange(dir, 0, 10_000)).entries.map((item) => item.at)).toEqual([1_000, 2_000])
  })

  it('maxBytes 0 rotasyonu kapatir', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(1_000, 10), { maxBytes: 0 })
    await appendSnapshot(dir, snapshot(2_000, 20), { maxBytes: 0 })

    expect(await listRotatedFiles(dir)).toEqual([])
  })

  it('rotasyon yetenegi olmayan sahte fs ile yazma yine calisir', async () => {
    const lines: string[] = []
    const fakeFs: HistoryFs = {
      async ensureDir() {},
      async appendLine(_file, line) {
        lines.push(line)
      },
      async *readLines() {
        for (const line of lines) yield line.replace(/\n$/, '')
      }
    }

    expect(canRotate(fakeFs)).toBe(false)
    expect(canRotate(nodeHistoryFs)).toBe(true)

    await appendSnapshot('/sanal', snapshot(1_000, 10), { fs: fakeFs, maxBytes: 1 })
    await appendSnapshot('/sanal', snapshot(2_000, 20), { fs: fakeFs, maxBytes: 1 })
    expect(lines).toHaveLength(2)
  })
})

describe('rotateHistory', () => {
  it('dosya yoksa veya bossa null doner ve hicbir sey tasimaz', async () => {
    const dir = await tempDir()
    expect(await rotateHistory(dir)).toBeNull()

    await writeFile(historyFilePath(dir), '', 'utf8')
    expect(await rotateHistory(dir)).toBeNull()
    expect(await listRotatedFiles(dir)).toEqual([])
  })

  it('dondurulen bayt sayisini bildirir', async () => {
    const dir = await tempDir()
    await appendSnapshot(dir, snapshot(1_000, 10), { maxBytes: 0 })

    const result = await rotateHistory(dir)
    expect(result?.bytes).toBeGreaterThan(0)
    expect(result?.from).toBe(historyFilePath(dir))
  })
})

describe('readRange — dondurulmus kusaklar', () => {
  const maxBytes = 1

  async function threeGenerations(): Promise<string> {
    const dir = await tempDir()
    for (const at of [1_000, 61_000, 121_000]) {
      await appendSnapshot(dir, snapshot(at, 10), { maxBytes })
    }
    return dir
  }

  it('varsayilan olarak kusaklari da okur — donus grafikte bosluk uretmez', async () => {
    const dir = await threeGenerations()

    const result = await readRange(dir, 0, 10_000_000)
    expect(result.entries.map((item) => item.at)).toEqual([1_000, 61_000, 121_000])
    expect(result.filesRead).toHaveLength(3)
    // Donus bir uygulama ayrintisi: seri tek parca kalmali.
    expect(splitSegments(result.entries)).toHaveLength(1)
  })

  it('kusaklar atlanirsa yalnizca aktif dosya gorunur', async () => {
    const dir = await threeGenerations()

    const result = await readRange(dir, 0, 10_000_000, { includeRotated: false })
    expect(result.entries.map((item) => item.at)).toEqual([121_000])
    expect(result.filesRead).toEqual([historyFilePath(dir)])
  })

  it('aralik filtresi kusaklarda da uygulanir', async () => {
    const dir = await threeGenerations()

    const result = await readRange(dir, 60_000, 100_000)
    expect(result.entries.map((item) => item.at)).toEqual([61_000])
  })

  it('bozuk satir sayaci butun kusaklari kapsar', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'usage-history.1.jsonl'), 'bu JSON degil\n', 'utf8')
    await writeFile(historyFilePath(dir), 'bu da degil\n', 'utf8')

    expect((await readRange(dir, 0, 10_000)).skipped).toBe(2)
  })
})
