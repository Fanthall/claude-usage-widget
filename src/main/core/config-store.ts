/**
 * Kucuk JSON konfig deposu.
 *
 * Iki davranis garantisi verir:
 *
 * 1. **Okuma cokmez.** Dosya yoksa, okunamiyorsa, JSON bozuksa veya bir alanin
 *    tipi yanlissa varsayilana dusulur ve neden `issues` icinde bildirilir.
 *    Konfig bozuk diye uygulama acilmamazlik etmez.
 * 2. **Yazma atomiktir.** Once yan dosyaya yazilir, sonra hedefin uzerine
 *    `rename` edilir. Yazma yarida kesilirse hedef dosya eski gecerli haliyle
 *    kalir; yarim JSON birakilmaz.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_POLL_INTERVAL_MS, type CollectorConfig } from '../../shared/types'

// ── Sema ─────────────────────────────────────────────────────────────────────

export interface WidgetBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AppConfig {
  /** Kesfedilen calistirilabilir yolu; bilinmiyorsa null (her aciliste kesfedilir). */
  claudeBinPath: string | null
  pollIntervalMs: number
  /** Widget'in son konumu; hic tasinmadiysa null. */
  widgetBounds: WidgetBounds | null
  /** Cihaz envanterinde proje yollari paylasilsin mi. Varsayilan kapali (security.md Q4). */
  shareProjectPaths: boolean
  autostart: boolean
}

/** Cok sik olcum CLI'yi bosuna yorar; cok seyrek olcum gostergeyi bayatlatir. */
export const MIN_POLL_INTERVAL_MS = 5 * 1000
export const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000

/**
 * Her cagride yeni nesne uretir. Paylasilan tek bir sabit dondurulseydi cagiran
 * taraf onu degistirdiginde "varsayilan" kalici olarak kayardi.
 */
export function defaultConfig(): AppConfig {
  return {
    claudeBinPath: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    widgetBounds: null,
    shareProjectPaths: false,
    autostart: false
  }
}

// ── Enjekte edilebilir dosya sistemi ─────────────────────────────────────────

export interface ConfigFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  ensureDir(dir: string): Promise<void>
  /** Yalnizca bu modulun kendi olusturdugu gecici dosya icin cagrilir. */
  removeFile(file: string): Promise<void>
}

export const nodeConfigFs: ConfigFs = {
  async readFile(file: string): Promise<string> {
    return await readFile(file, 'utf8')
  },
  async writeFile(file: string, data: string): Promise<void> {
    await writeFile(file, data, 'utf8')
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  },
  async ensureDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
  },
  async removeFile(file: string): Promise<void> {
    await unlink(file)
  }
}

export interface ConfigStoreOptions {
  fs?: ConfigFs
}

/** Gecici dosyanin sabit soneki. Sabit ad birakilirsa en fazla bir artik kalir. */
export const TEMP_SUFFIX = '.tmp'

export function tempFilePath(file: string): string {
  return file + TEMP_SUFFIX
}

// ── Dogrulama ────────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function parseBounds(value: unknown): WidgetBounds | null {
  if (!isPlainObject(value)) return null
  const x = value['x']
  const y = value['y']
  const width = value['width']
  const height = value['height']
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  // Sifir veya negatif olcu pencereyi gorunmez kilar; kayit bozuk sayilir.
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

interface FieldReader {
  object: Record<string, unknown>
  issues: string[]
}

function readBoolean(source: FieldReader, key: string, fallback: boolean): boolean {
  const value = source.object[key]
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  source.issues.push(key + ': mantiksal deger degil, varsayilan kullanildi')
  return fallback
}

function readBinPath(source: FieldReader): string | null {
  const value = source.object['claudeBinPath']
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    source.issues.push('claudeBinPath: metin degil, varsayilan kullanildi')
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readPollInterval(source: FieldReader): number {
  const value = source.object['pollIntervalMs']
  if (value === undefined) return DEFAULT_POLL_INTERVAL_MS
  if (!isFiniteNumber(value)) {
    source.issues.push('pollIntervalMs: sayi degil, varsayilan kullanildi')
    return DEFAULT_POLL_INTERVAL_MS
  }
  if (value < MIN_POLL_INTERVAL_MS) {
    source.issues.push('pollIntervalMs: alt sinira cekildi (' + MIN_POLL_INTERVAL_MS + ' ms)')
    return MIN_POLL_INTERVAL_MS
  }
  if (value > MAX_POLL_INTERVAL_MS) {
    source.issues.push('pollIntervalMs: ust sinira cekildi (' + MAX_POLL_INTERVAL_MS + ' ms)')
    return MAX_POLL_INTERVAL_MS
  }
  return value
}

function readBounds(source: FieldReader): WidgetBounds | null {
  const value = source.object['widgetBounds']
  if (value === undefined || value === null) return null
  const bounds = parseBounds(value)
  if (bounds === null) {
    source.issues.push('widgetBounds: gecersiz, pencere konumu sifirlandi')
    return null
  }
  return bounds
}

/**
 * Bilinmeyen sekilli veriyi konfige cevirir. Bozuk alanlar varsayilana duser,
 * saglam alanlar korunur — tek bir hatali alan tum dosyayi atmaz.
 */
export function normalizeConfig(value: unknown): { config: AppConfig; issues: string[] } {
  if (!isPlainObject(value)) {
    return { config: defaultConfig(), issues: ['kok deger nesne degil, varsayilanlar kullanildi'] }
  }
  const source: FieldReader = { object: value, issues: [] }
  const fallback = defaultConfig()
  return {
    config: {
      claudeBinPath: readBinPath(source),
      pollIntervalMs: readPollInterval(source),
      widgetBounds: readBounds(source),
      shareProjectPaths: readBoolean(source, 'shareProjectPaths', fallback.shareProjectPaths),
      autostart: readBoolean(source, 'autostart', fallback.autostart)
    },
    issues: source.issues
  }
}

// ── Okuma ────────────────────────────────────────────────────────────────────

export interface ConfigLoadResult {
  config: AppConfig
  /** Dosya hic yoktu. Ilk calistirma; hata degildir. */
  missing: boolean
  /** Varsayilana dusulen alanlarin nedenleri. Bos ise dosya bastan sona gecerliydi. */
  issues: string[]
}

/**
 * Konfigi okur. Hicbir kosulda istisna firlatmaz; en kotu durumda varsayilan
 * konfig ve dolu bir `issues` listesi doner.
 */
export async function loadConfig(
  file: string,
  options: ConfigStoreOptions = {}
): Promise<ConfigLoadResult> {
  const fs = options.fs ?? nodeConfigFs

  let text: string
  try {
    text = await fs.readFile(file)
  } catch (error) {
    if (isMissingFile(error)) {
      return { config: defaultConfig(), missing: true, issues: [] }
    }
    return { config: defaultConfig(), missing: false, issues: ['dosya okunamadi'] }
  }

  let parsed: unknown
  try {
    // BOM'lu dosya `JSON.parse`'i patlatir ve tum ayarlar sessizce varsayilana
    // duser. Not Defteri ve PowerShell'in `-Encoding utf8`'i BOM yaziyor;
    // dosyayi elle duzenleyen kullanici ayarlarini kaybetmemeli.
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return {
      config: defaultConfig(),
      missing: false,
      issues: ['gecerli JSON degil, varsayilanlar kullanildi']
    }
  }

  const { config, issues } = normalizeConfig(parsed)
  return { config, missing: false, issues }
}

// ── Yazma ────────────────────────────────────────────────────────────────────

/**
 * Ayni dosyaya yonelen yazimlar sirayla calisir. Gecici dosyanin adi sabit
 * oldugu icin es zamanli iki yazim birbirinin yarim ciktisini rename edebilirdi.
 */
const writeQueues = new Map<string, Promise<void>>()

async function serialize(file: string, task: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(file) ?? Promise.resolve()
  const run = previous.then(task)
  // Kuyrukta hata firlatmayan surum tutulur: bir yazim patlasa da sonraki
  // yazim sirasini alir. Asil hata cagirana `run` uzerinden gider.
  const tail = run.catch(() => undefined)
  writeQueues.set(file, tail)
  try {
    return await run
  } finally {
    // Bu yazim kuyrugun sonuysa girdi birakilmaz.
    if (writeQueues.get(file) === tail) writeQueues.delete(file)
  }
}

/**
 * Konfigi atomik yazar: gecici dosya → `rename`. Basarili yazimdan sonra
 * gecici dosya kalmaz (rename onu tuketir). Yazim yarida patlarsa gecici dosya
 * temizlenir; temizlik de basarisiz olursa yok sayilir, cunku bir sonraki yazim
 * ayni adi zaten uzerine yazar.
 */
export async function saveConfig(
  file: string,
  config: AppConfig,
  options: ConfigStoreOptions = {}
): Promise<void> {
  const fs = options.fs ?? nodeConfigFs
  const temp = tempFilePath(file)
  const text = JSON.stringify(config, null, 2) + '\n'

  await serialize(file, async () => {
    await fs.ensureDir(dirname(file))
    try {
      await fs.writeFile(temp, text)
      await fs.rename(temp, file)
    } catch (error) {
      try {
        await fs.removeFile(temp)
      } catch {
        // Gecici dosya yoksa veya silinemiyorsa asil hatayi golgeleme.
      }
      throw error
    }
  })
}

// ── Sozlesmeye kopru ─────────────────────────────────────────────────────────

/** Konfigi toplayicinin bekledigi `CollectorConfig` bicimine cevirir. */
export function toCollectorConfig(config: AppConfig, dataDir: string): CollectorConfig {
  return {
    pollIntervalMs: config.pollIntervalMs,
    dataDir,
    claudeBinPath: config.claudeBinPath
  }
}
