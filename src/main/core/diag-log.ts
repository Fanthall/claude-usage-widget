/**
 * Tani kaydi dosyasi.
 *
 * Varsayilan log yolu `console`dur; paketlenmis Electron ana surecinde bu
 * hicbir yere gorunmez. Olcum hatalarinin sinifi ve ham ayrintisi boylece
 * kaybolur ve geriye donuk teshis imkansizlasir — bir ag kesintisinin hangi
 * hata oldugunu anlamak icin ayri bir prob kurmak gerekmisti.
 *
 * Burasi o bosluğu doldurur: satir satir JSON, en yenisi sonda.
 * Jeton ve benzeri degerler `safeLog` tarafindan zaten maskelenir; bu katman
 * yalnizca yazar.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import type { LogLevel, LogRecord, LogSink } from './log-safe'

/** Dosya bu boyutu asinca en eski yari atilir. */
export const MAX_LOG_BYTES = 512 * 1024

/**
 * Dosyaya yazilacak en dusuk seviye.
 *
 * `debug` DISARIDA: pencere boyutu ("fit") gibi olaylar saniyede birkac kez
 * dusuyor ve dosyayi doldurup asil aranan hata kaydini gomuyor. Tani kaydinin
 * amaci hatayi bulunur kilmak.
 */
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
export const DEFAULT_MIN_LEVEL: LogLevel = 'info'

export interface DiagFs {
  appendFileSync(file: string, data: string): void
  readFileSync(file: string): string
  writeFileSync(file: string, data: string): void
  sizeOf(file: string): number
  ensureDir(dir: string): void
}

export const nodeDiagFs: DiagFs = {
  appendFileSync: (file, data) => appendFileSync(file, data, 'utf8'),
  readFileSync: (file) => readFileSync(file, 'utf8'),
  writeFileSync: (file, data) => writeFileSync(file, data, 'utf8'),
  sizeOf: (file) => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  },
  ensureDir: (dir) => {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Dosya buyudugunde en eski yariyi atar.
 *
 * Satir sinirinda kesilir; yarim JSON satiri birakmak dosyayi okunamaz yapar.
 */
export function halveFromStart(text: string): string {
  const cut = Math.floor(text.length / 2)
  const nl = text.indexOf('\n', cut)
  return nl === -1 ? '' : text.slice(nl + 1)
}

/**
 * `safeLog` ciktisini dosyaya yazan bir sink uretir.
 *
 * Yazma hatasi YUTULUR: tani kaydi tutulamiyorsa bu, olcumun durmasi icin
 * sebep degildir.
 */
export function createFileSink(
  file: string,
  deps: { fs?: DiagFs; now?: () => number; maxBytes?: number; minLevel?: LogLevel } = {}
): LogSink {
  const fs = deps.fs ?? nodeDiagFs
  const now = deps.now ?? Date.now
  const maxBytes = deps.maxBytes ?? MAX_LOG_BYTES
  const minLevel = deps.minLevel ?? DEFAULT_MIN_LEVEL

  return (record: LogRecord): void => {
    if (LEVEL_ORDER[record.level] < LEVEL_ORDER[minLevel]) return
    try {
      fs.ensureDir(dirname(file))
      if (fs.sizeOf(file) > maxBytes) {
        fs.writeFileSync(file, halveFromStart(fs.readFileSync(file)))
      }
      const line = JSON.stringify({
        at: new Date(now()).toISOString(),
        level: record.level,
        message: record.message,
        ...(record.meta === undefined ? {} : { meta: record.meta })
      })
      fs.appendFileSync(file, line + '\n')
    } catch {
      // Sessiz: tani kaydi en son dusen sey olmali.
    }
  }
}
