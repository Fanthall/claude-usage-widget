/**
 * Append-only JSONL tarihce deposu.
 *
 * Her satir bir `HistoryEntry`dir. Dosya yalnizca sona eklenerek buyur; hicbir
 * satir yerinde degistirilmez veya silinmez. Okuma sirasinda bozuk satirlar
 * atlanir ve SAYILIR (sessiz kayip yok), ileri surum satirlari ham haliyle
 * korunur.
 */

import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  DEFAULT_POLL_INTERVAL_MS,
  HISTORY_GAP_MS,
  SNAPSHOT_SCHEMA_VERSION,
  gapThresholdMs,
  type HistoryEntry,
  type UsageSnapshot,
  type UsageWindow
} from '../../shared/types'

export const HISTORY_FILE_NAME = 'usage-history.jsonl'

/** Verilen dizindeki tarihce dosyasinin tam yolu. */
export function historyFilePath(dir: string, fileName: string = HISTORY_FILE_NAME): string {
  return join(dir, fileName)
}

// ── Enjekte edilebilir dosya sistemi ─────────────────────────────────────────

/**
 * Deponun ihtiyac duydugu dosya islemleri. Testte sahte uygulama verilir,
 * uretimde `nodeHistoryFs` kullanilir.
 */
export interface HistoryFs {
  ensureDir(dir: string): Promise<void>
  appendLine(file: string, line: string): Promise<void>
  /** Dosya yoksa hic satir uretmez. */
  readLines(file: string): AsyncIterable<string>
  /**
   * Dosya boyutu (bayt); dosya yoksa 0. Rotasyon tavani bununla olculur.
   * Opsiyonel: enjekte edilen sahte fs vermek zorunda degil.
   */
  size?(file: string): Promise<number>
  /** Dosyayi yeni ada tasir. SILME degil — hard-rule A2 geregi tek yol budur. */
  rename?(from: string, to: string): Promise<void>
  /** Dizindeki dosya adlari (yol yok). Dondurulmus kusaklari bulmak icin. */
  listFiles?(dir: string): Promise<string[]>
}

export interface HistoryStoreOptions {
  fs?: HistoryFs
  fileName?: string
  /**
   * Tek dosyanin bayt tavani. Asilinca dosya dondurulur (bkz. `rotateHistory`).
   * 0 veya negatif verilirse rotasyon kapanir.
   */
  maxBytes?: number
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Dosyayi satir satir okur. Tum icerigi bellege almaz: tarihce dakikada bir
 * satir buyudugu icin dosya zamanla yuz binlerce satira ulasir.
 */
async function* streamLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      yield line
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  } finally {
    reader.close()
    stream.destroy()
  }
}

export const nodeHistoryFs: HistoryFs = {
  async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
  },
  async appendLine(file: string, line: string): Promise<void> {
    await appendFile(file, line, 'utf8')
  },
  readLines(file: string): AsyncIterable<string> {
    return streamLines(file)
  },
  async size(file: string): Promise<number> {
    try {
      return (await stat(file)).size
    } catch (error) {
      if (isMissingFile(error)) return 0
      throw error
    }
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  },
  async listFiles(dir: string): Promise<string[]> {
    try {
      return await readdir(dir)
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }
  }
}

// ── Rotasyon ─────────────────────────────────────────────────────────────────

/**
 * Tek tarihce dosyasinin bayt tavani.
 *
 * Kayit basina ~2 KB olculdu. 5 dk'lik olcum araliginda gunde ~24 KB, yani
 * 5 MB kesintisiz ~7 aylik olcum eder. Tavan asilinca dosya **SILINMEZ**:
 * `usage-history.1.jsonl` gibi bir kusaga tasinir ve yeni dosya bastan baslar
 * (hard-rule A2 — geri alinamaz silme yok).
 */
export const HISTORY_MAX_BYTES = 5 * 1024 * 1024

/** Rotasyon icin gereken fs yetenekleri var mi. */
type RotatingFs = HistoryFs & Required<Pick<HistoryFs, 'size' | 'rename' | 'listFiles'>>

export function canRotate(fs: HistoryFs): fs is RotatingFs {
  // `listFiles` de sart: kusak numarasi mevcut dosyalardan turetiliyor, onsuz
  // ayni ada ikinci kez tasinir ve dondurulmus veri EZILIRDI.
  return (
    typeof fs.size === 'function' &&
    typeof fs.rename === 'function' &&
    typeof fs.listFiles === 'function'
  )
}

/** `usage-history.jsonl` + 2 → `usage-history.2.jsonl`. */
export function rotatedFileName(fileName: string, index: number): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return `${fileName}.${index}`
  return `${fileName.slice(0, dot)}.${index}${fileName.slice(dot)}`
}

/** Ad bir kusak dosyasiysa numarasi, degilse null. Aktif dosya null doner. */
function rotationIndexOf(name: string, fileName: string): number | null {
  const dot = fileName.lastIndexOf('.')
  const stem = dot <= 0 ? fileName : fileName.slice(0, dot)
  const ext = dot <= 0 ? '' : fileName.slice(dot)
  if (!name.startsWith(`${stem}.`) || !name.endsWith(ext)) return null
  const middle = name.slice(stem.length + 1, name.length - ext.length)
  if (!/^\d+$/.test(middle)) return null
  const index = Number(middle)
  return Number.isSafeInteger(index) && index >= 1 ? index : null
}

/** Bir kusak dosyasi: numarasi ve tam yolu. */
interface RotatedFile {
  index: number
  path: string
}

/**
 * Dondurulmus kusaklar, **numara artan** sirada.
 *
 * Numara arttikca dosya YENIDIR: kusaklar yeniden adlandirilmaz (logrotate'in
 * `.1 → .2` kaydirmasi her donuste tum dosyalara dokunur ve her dokunus bir
 * kayip firsatidir). Artan numarayla eski dosyalara bir daha hic dokunulmaz.
 */
async function listRotated(dir: string, options: HistoryStoreOptions): Promise<RotatedFile[]> {
  const fs = options.fs ?? nodeHistoryFs
  const fileName = options.fileName ?? HISTORY_FILE_NAME
  if (fs.listFiles === undefined) return []
  const names = await fs.listFiles(dir)
  const found: RotatedFile[] = []
  for (const name of names) {
    const index = rotationIndexOf(name, fileName)
    if (index !== null) found.push({ index, path: join(dir, name) })
  }
  return found.sort((a, b) => a.index - b.index)
}

/** Dondurulmus kusak dosyalarinin tam yollari, eskiden yeniye. */
export async function listRotatedFiles(
  dir: string,
  options: HistoryStoreOptions = {}
): Promise<string[]> {
  return (await listRotated(dir, options)).map((item) => item.path)
}

export interface RotationResult {
  /** Dondurulen dosyanin eski (aktif) yolu. */
  from: string
  /** Dondurulmus kusagin yolu. */
  to: string
  /** Dondurulen bayt sayisi. */
  bytes: number
  /** Kusak numarasi. */
  index: number
}

/**
 * Aktif dosyayi bir sonraki kusaga tasir. Veri silinmez, yalnizca ad degisir.
 * Dosya yoksa veya bossa hicbir sey yapmaz ve null doner.
 */
export async function rotateHistory(
  dir: string,
  options: HistoryStoreOptions = {}
): Promise<RotationResult | null> {
  const fs = options.fs ?? nodeHistoryFs
  if (!canRotate(fs)) return null
  const fileName = options.fileName ?? HISTORY_FILE_NAME
  const from = historyFilePath(dir, fileName)
  const bytes = await fs.size(from)
  if (bytes <= 0) return null

  const existing = await listRotated(dir, options)
  const index = existing.reduce((max, item) => Math.max(max, item.index), 0) + 1
  const to = join(dir, rotatedFileName(fileName, index))
  await fs.rename(from, to)
  return { from, to, bytes, index }
}

// ── Okuma sonucu ─────────────────────────────────────────────────────────────

export interface HistoryRecord {
  entry: HistoryEntry
  /** Dosyadaki ham satir. Ileri surum alanlari burada eksiksiz durur. */
  raw: string
  /**
   * Satir bu surumden yeni (`v > SNAPSHOT_SCHEMA_VERSION`). `entry` alanlari
   * eksik olabilir; satir yeniden yazilacaksa `raw` kullanilir.
   */
  future: boolean
  /**
   * Kayittan cizilecek pencere yok: olcum yapildi ama hicbir satir
   * ayristirilamadi ya da satir bu surumun okuyamadigi bir ileri surum.
   * Grafik bunu veri noktasi saymaz — saymazsa iki gercek olcumu birlestirip
   * olmayan bir DUZ CIZGI cizer.
   */
  emptyWindows: boolean
}

export interface HistoryReadResult {
  /** Araliktaki kayitlar, `at` artan sirada. Ileri surum satirlari da dahildir. */
  records: HistoryRecord[]
  /** Kayitlarin ayristirilmis hali — grafik/hesaplama tarafi icin kisayol. */
  entries: HistoryEntry[]
  /**
   * Ayristirilamayan satir sayisi. Bozuk satirin zaman damgasi bilinemedigi
   * icin sayac dosyanin tamamini kapsar, yalnizca istenen araligi degil.
   */
  skipped: number
  /** Araliktaki pencere tasimayan kayit sayisi (`emptyWindows`). */
  emptyCount: number
  /**
   * Gercekten okunan dosyalar, eskiden yeniye. Dondurulmus kusaklar taranmadiysa
   * burada gorunmez — kapsam sessiz kalmaz, sayilabilir.
   */
  filesRead: string[]
}

export interface HistoryReadOptions extends HistoryStoreOptions {
  /**
   * Dondurulmus kusaklar da taransin mi (varsayilan: evet).
   *
   * Varsayilan "evet", cunku donus bir uygulama ayrintisidir: istenen zaman
   * araligi donusun oncesine uzaniyorsa ve kusak okunmazsa grafik orada
   * **olmayan bir bosluk** cizer — "olcum yapilmadi" der, oysa yapilmisti.
   */
  includeRotated?: boolean
}

/**
 * Kayit hic pencere tasimiyor mu. Toplayici bunu yazmadan once de sorabilir;
 * okuyan taraf `HistoryRecord.emptyWindows` ile ayni bilgiyi alir.
 */
export function isEmptyMeasurement(entry: { readonly windows: readonly UsageWindow[] }): boolean {
  return entry.windows.length === 0
}

// ── Yazma ────────────────────────────────────────────────────────────────────

export interface AppendOptions extends HistoryStoreOptions {
  /** Yazmadan once donus yapildiysa cagrilir; ana surec bunu loglar. */
  onRotate?: (result: RotationResult) => void
}

/**
 * Anlik olcumu tarihceye tek satir olarak ekler. Dizin yoksa olusturur.
 * Yazilan kaydi dondurur.
 *
 * Satir dosyayi tavanin ustune cikaracaksa once **donus** yapilir: aktif dosya
 * bir kusaga tasinir, yeni satir bos dosyaya yazilir. Hicbir kayit silinmez.
 * Donus icin `size`+`rename`+`listFiles` gerekir; enjekte edilen sahte fs
 * bunlari vermezse donus yapilmaz ve dosya buyumeye devam eder (`canRotate`).
 */
export async function appendSnapshot(
  dir: string,
  snapshot: UsageSnapshot,
  options: AppendOptions = {}
): Promise<HistoryEntry> {
  const fs = options.fs ?? nodeHistoryFs
  const file = historyFilePath(dir, options.fileName ?? HISTORY_FILE_NAME)
  const entry: HistoryEntry = {
    v: SNAPSHOT_SCHEMA_VERSION,
    at: snapshot.at,
    windows: snapshot.windows,
    unparsedLines: snapshot.unparsedLines,
    raw: snapshot.raw
  }
  await fs.ensureDir(dir)
  // JSON.stringify satir sonlarini kacisla yazar, kayit tek satirda kalir.
  const line = `${JSON.stringify(entry)}\n`

  const maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES
  if (maxBytes > 0 && canRotate(fs)) {
    const current = await fs.size(file)
    // Karsilastirma yazmadan ONCE: tavani asan satir hic yazilmaz, once donulur.
    // Bos dosyada donus yapilmaz, yoksa tek satir tavandan buyukse sonsuz doner.
    if (current > 0 && current + Buffer.byteLength(line, 'utf8') > maxBytes) {
      const rotated = await rotateHistory(dir, options)
      if (rotated !== null) options.onRotate?.(rotated)
    }
  }

  await fs.appendLine(file, line)
  return entry
}

// ── Okuma ────────────────────────────────────────────────────────────────────

/**
 * `fromMs`-`toMs` (iki uc dahil) araligindaki kayitlari dondurur. Bozuk ve
 * yarim satirlar atlanir, sayisi `skipped` alaninda bildirilir.
 */
export async function readRange(
  dir: string,
  fromMs: number,
  toMs: number,
  options: HistoryReadOptions = {}
): Promise<HistoryReadResult> {
  const fs = options.fs ?? nodeHistoryFs
  const active = historyFilePath(dir, options.fileName ?? HISTORY_FILE_NAME)
  // Kusaklar once, aktif dosya sonra: dosya sirasi zaman sirasiyla ortusur,
  // boylece kararli sort ayni ms'teki kayitlarin yazilma sirasini korur.
  const rotated = options.includeRotated === false ? [] : await listRotatedFiles(dir, options)
  const files = [...rotated, active]

  const records: HistoryRecord[] = []
  let skipped = 0
  let emptyCount = 0

  for (const file of files) {
    for await (const line of fs.readLines(file)) {
      if (line.trim() === '') continue
      const record = parseLine(line)
      if (record === null) {
        skipped += 1
        continue
      }
      const at = record.entry.at
      if (at < fromMs || at > toMs) continue
      if (record.emptyWindows) emptyCount += 1
      records.push(record)
    }
  }

  // Append sirasi normalde zaten artan; sort saat geri alindiginda da grafigin
  // dogru sirada cizilmesini saglar. Sort kararli oldugu icin ayni ms'teki
  // kayitlar yazilma sirasini korur.
  records.sort((a, b) => a.entry.at - b.entry.at)

  return {
    records,
    entries: records.map((record) => record.entry),
    skipped,
    emptyCount,
    filesRead: files
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseWindows(value: unknown): UsageWindow[] | null {
  if (!Array.isArray(value)) return null
  const windows: UsageWindow[] = []
  for (const item of value) {
    if (!isPlainObject(item)) return null
    const label = item['label']
    const percent = item['percent']
    const resetsAtRaw = item['resetsAtRaw']
    const resetsAtMs = item['resetsAtMs']
    if (typeof label !== 'string') return null
    if (!isFiniteNumber(percent)) return null
    if (typeof resetsAtRaw !== 'string') return null
    if (resetsAtMs !== null && !isFiniteNumber(resetsAtMs)) return null
    windows.push({ label, percent, resetsAtRaw, resetsAtMs })
  }
  return windows
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    items.push(item)
  }
  return items
}

/** Bu surumun bildigi sema: eksik veya yanlis tipte alan varsa satir bozuktur. */
function parseCurrentEntry(
  object: Record<string, unknown>,
  v: number,
  at: number
): HistoryEntry | null {
  const windows = parseWindows(object['windows'])
  if (windows === null) return null
  const unparsedLines = parseStringArray(object['unparsedLines'])
  if (unparsedLines === null) return null
  const raw = object['raw']
  if (typeof raw !== 'string') return null
  return { v, at, windows, unparsedLines, raw }
}

/**
 * Ileri surum satiri: tanimadigimiz alanlar `HistoryRecord.raw` icinde korunur,
 * bu yuzden satir atlanmaz. Okunabilen alanlar alinir, okunamayanlar bos kalir.
 */
function parseFutureEntry(
  object: Record<string, unknown>,
  v: number,
  at: number
): HistoryEntry {
  const rawText = object['raw']
  return {
    v,
    at,
    windows: parseWindows(object['windows']) ?? [],
    unparsedLines: parseStringArray(object['unparsedLines']) ?? [],
    raw: typeof rawText === 'string' ? rawText : ''
  }
}

function parseLine(line: string): HistoryRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null

  const v = parsed['v']
  const at = parsed['at']
  // `v` ve `at` olmadan satir ne siralanabilir ne de yorumlanabilir.
  if (!isFiniteNumber(v) || !isFiniteNumber(at)) return null

  const future = v > SNAPSHOT_SCHEMA_VERSION
  const entry = future ? parseFutureEntry(parsed, v, at) : parseCurrentEntry(parsed, v, at)
  if (entry === null) return null
  return { entry, raw: line, future, emptyWindows: isEmptyMeasurement(entry) }
}

// ── Bosluk tespiti ───────────────────────────────────────────────────────────

export interface HistoryGap {
  /** Bosluktan onceki kaydin verilen dizideki indeksi. */
  beforeIndex: number
  /** Bosluk oncesi son kaydin zamani. */
  fromMs: number
  /** Bosluk sonrasi ilk kaydin zamani. */
  toMs: number
  durationMs: number
}

/**
 * Bosluk esigi. Sabit `HISTORY_GAP_MS` yalnizca varsayilan 60 sn'lik olcum
 * araligi icin dogrudur: 5 dk aralik secilirse ardisik HER cift esigi asar,
 * her nokta kendi parcasinda kalir ve grafikte hic cizgi gorunmez. Bu yuzden
 * esik `pollIntervalMs` ile bildirilir ve `gapThresholdMs()` ile olceklenir.
 */
export interface GapOptions {
  /** Dogrudan esik (ms). Verilirse `pollIntervalMs` yok sayilir. */
  gapMs?: number
  /** Olcum araligi; esik bundan turetilir. Verilmezse varsayilan aralik. */
  pollIntervalMs?: number
  /**
   * Pencere tasimayan kayitlar seride kalsin mi. Varsayilan hayir: bos kayit
   * cizilebilir veri degildir, seriyi keser (bkz. `isEmptyMeasurement`).
   */
  keepEmpty?: boolean
}

/** Sayi da secenek nesnesi de kabul eder; ikisi de yoksa sabit esige duser. */
export function resolveGapMs(threshold: number | GapOptions = HISTORY_GAP_MS): number {
  if (typeof threshold === 'number') return threshold
  if (threshold.gapMs !== undefined) return threshold.gapMs
  return gapThresholdMs(threshold.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
}

/**
 * Ardisik iki kayit arasindaki fark esigi asiyorsa bosluk isaretler. Grafik
 * seriyi burada keser; olcum yapilmamis araliga duz cizgi cizilmez (REQ-1).
 * Kayitlar `at` artan sirada beklenir (`readRange` boyle dondurur).
 */
export function detectGaps(
  entries: readonly HistoryEntry[],
  threshold: number | GapOptions = HISTORY_GAP_MS
): HistoryGap[] {
  const gapMs = resolveGapMs(threshold)
  const gaps: HistoryGap[] = []
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (previous === undefined || current === undefined) continue
    const durationMs = current.at - previous.at
    if (durationMs > gapMs) {
      gaps.push({
        beforeIndex: index - 1,
        fromMs: previous.at,
        toMs: current.at,
        durationMs
      })
    }
  }
  return gaps
}

/**
 * Kayitlari cizilebilir parcalara ayirir. Grafik her parcayi ayri bir cizgi
 * olarak cizer. Parca su iki durumda kesilir:
 * 1. iki kayit arasi fark esigi asiyor (olcum yapilmamis),
 * 2. kayit hic pencere tasimiyor (olcum yapildi ama deger yok) — bu kayit
 *    hicbir parcaya girmez, yoksa iki gercek olcum arasina olmayan bir duz
 *    cizgi cizilir. `keepEmpty` ile eski davranis istenebilir.
 */
export function splitSegments(
  entries: readonly HistoryEntry[],
  threshold: number | GapOptions = HISTORY_GAP_MS
): HistoryEntry[][] {
  const gapMs = resolveGapMs(threshold)
  const keepEmpty = typeof threshold === 'object' && threshold.keepEmpty === true
  const segments: HistoryEntry[][] = []
  let current: HistoryEntry[] = []
  let previous: HistoryEntry | null = null

  const close = (): void => {
    if (current.length > 0) segments.push(current)
    current = []
    previous = null
  }

  for (const entry of entries) {
    if (!keepEmpty && isEmptyMeasurement(entry)) {
      close()
      continue
    }
    if (previous !== null && entry.at - previous.at > gapMs) close()
    current.push(entry)
    previous = entry
  }
  close()
  return segments
}
