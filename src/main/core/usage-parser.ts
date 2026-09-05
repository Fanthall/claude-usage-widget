/**
 * `claude -p "/usage" --output-format json` ciktisindaki `result` duz metnini
 * `UsageSnapshot`'a cevirir. Saf fonksiyon: I/O yok, saat okumaz — olcum zamani
 * disaridan (`atMs`) gelir.
 *
 * Cikti bicimi dokumante degil (PRD context.md > Tuzaklar 3). Bu yuzden:
 * - etiket sabit listeye baglanmaz, gelen ne varsa alinir,
 * - kaliba uymayan satir sessizce atilmaz, `unparsedLines`e tasinir (REQ-10);
 *   tek istisna bastaki bilinen onsozdur, o `raw` icinde saklanir,
 * - fonksiyon hicbir kosulda throw etmez.
 */

import type { UsageSnapshot, UsageWindow } from '../../shared/types'

/**
 * "<etiket>: <N>% used · resets <kalan metin>" — resets kuyrugu OPSIYONEL.
 * Gercek ciktida "Current week (Fable): 0% used" gibi sifirlanma saati olmayan
 * pencereler geliyor; kuyrugu zorunlu tutmak gercek bir kota penceresini dusuruyordu.
 * Ayirici gercek ciktida U+00B7 (·); nokta/tire/madde-imi varyantlarina da izin
 * verilir, ayirici tamamen yoksa da eslesir.
 */
const WINDOW_LINE =
  /^\s*(\S.*?)\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*used\b(?:\s*(?:[·•*.\-–—|]\s*)?resets\s+(\S.*?))?\s*$/i

/**
 * "Sep 5, 4:50pm (Europe/Istanbul)" — yil YOK, saat 12'lik.
 * am/pm isareti zorunlu: onsuz "4:50" belirsizdir, tahmin uretmek yerine null donulur.
 */
const RESET_AT =
  /^\s*([A-Za-z]{3,9})\s+(\d{1,2})\s*,?\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?\s*(?:\(([^)]+)\))?\s*$/

/**
 * Ciktinin basindaki bilgilendirme satiri: "You are currently using your
 * subscription to power your Claude Code usage". Her olcumde gelir, kota verisi
 * tasimaz. Kalip dar tutulur — genis bir kalip gercek anomaliyi de yutar.
 */
const PREAMBLE_LINE = /^\s*you(?:'re|\s+are)\s+currently\s+using\b/i

/**
 * Satir bilinen onsoz mu. Onsoz yalnizca ILK pencere satirindan once beklenir;
 * `parseUsageResult` konum kosulunu ayrica uygular.
 */
export function isPreambleLine(line: string): boolean {
  return PREAMBLE_LINE.test(line)
}

/**
 * Pencerelerden SONRA gelen bilinen ayrinti bolumunun basligi. Bu satirdan
 * itibaren gelen her sey aciklayici dokumdur (istek sayilari, davranis yuzdeleri),
 * kota penceresi degildir. Anomali sayilirsa gosterge her saglikli olcumde
 * "N satir okunamadi" der ve REQ-10'un uyari sinyali anlamini yitirir.
 */
const DETAIL_SECTION_HEADER = /contributing to your limits usage/i

export function isDetailSectionHeader(line: string): boolean {
  return DETAIL_SECTION_HEADER.test(line)
}

/**
 * Ham ciktidaki onsoz satirlari. `UsageSnapshot` icinde ayri bir alan olmadigi
 * icin metin `raw` uzerinden buradan geri okunur — bilgi kaybolmaz.
 */
export function preambleLines(raw: string): string[] {
  const lines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (WINDOW_LINE.test(line)) break
    if (isPreambleLine(line)) lines.push(line)
  }
  return lines
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
}

/** Bir zaman diliminin verilen an icin UTC'ye gore ofseti (ms, dogu pozitif). */
function timeZoneOffsetMs(atMs: number, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(atMs))
  } catch {
    return null
  }

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    return part === undefined ? Number.NaN : Number(part.value)
  }

  const year = field('year')
  const month = field('month')
  const day = field('day')
  const hour = field('hour')
  const minute = field('minute')
  const second = field('second')
  if ([year, month, day, hour, minute, second].some((n) => !Number.isFinite(n))) return null

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  return asUtc - Math.floor(atMs / 1000) * 1000
}

/** Verilen ayin gun sayisi. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * Duvar saatini epoch ms'e cevirir. `timeZone` verilmisse o dilimde, verilmemis
 * veya taninmiyorsa yerel saatte yorumlanir (widget olcumu yapan makinede kosar,
 * CLI de o makinenin dilimini yazar).
 */
function wallTimeToMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | null
): number | null {
  if (day > daysInMonth(year, month)) return null

  if (timeZone !== null) {
    const utcGuess = Date.UTC(year, month, day, hour, minute)
    const firstOffset = timeZoneOffsetMs(utcGuess, timeZone)
    if (firstOffset !== null) {
      const firstPass = utcGuess - firstOffset
      // DST sinirinda ofset degisebilir; ikinci tur duzeltme yapar.
      const secondOffset = timeZoneOffsetMs(firstPass, timeZone)
      return secondOffset === null || secondOffset === firstOffset
        ? firstPass
        : utcGuess - secondOffset
    }
  }

  const local = new Date(year, month, day, hour, minute, 0, 0)
  const ms = local.getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * "Sep 5, 4:50pm (Europe/Istanbul)" gibi bir ifadeyi epoch ms'e cevirir.
 * Metinde yil yoktur; `atMs`'e en yakin yil secilir (yil sonu gecisi bu sayede
 * dogru tarafa duser). Kalip tutmuyorsa tahmin uretilmez, null donulur.
 */
export function parseResetsAt(text: string, atMs: number): number | null {
  const match = RESET_AT.exec(text)
  if (match === null) return null

  const [, monthText, dayText, hourText, minuteText, meridiemText, timeZoneText] = match
  if (
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    meridiemText === undefined
  ) {
    return null
  }

  const month = MONTHS[monthText.toLowerCase()]
  if (month === undefined) return null

  const day = Number(dayText)
  if (day < 1 || day > 31) return null

  const rawHour = Number(hourText)
  if (rawHour < 1 || rawHour > 12) return null
  const isPm = meridiemText.toLowerCase() === 'p'
  const hour = isPm ? (rawHour === 12 ? 12 : rawHour + 12) : rawHour === 12 ? 0 : rawHour

  const minute = minuteText === undefined ? 0 : Number(minuteText)
  if (minute > 59) return null

  const timeZone = timeZoneText === undefined ? null : timeZoneText.trim()
  const referenceYear = new Date(atMs).getUTCFullYear()
  if (!Number.isFinite(referenceYear)) return null

  let best: number | null = null
  for (const year of [referenceYear - 1, referenceYear, referenceYear + 1]) {
    const candidate = wallTimeToMs(year, month, day, hour, minute, timeZone)
    if (candidate === null) continue
    if (best === null || Math.abs(candidate - atMs) < Math.abs(best - atMs)) best = candidate
  }
  return best
}

/**
 * `result` metnini snapshot'a cevirir. Hicbir satir kaliba uymazsa `windows` bos
 * doner — cagiran taraf bunu 'bad-output' sayar; parser kendisi throw etmez.
 */
export function parseUsageResult(raw: string, atMs: number): UsageSnapshot {
  const windows: UsageWindow[] = []
  const unparsedLines: string[] = []
  let sawWindow = false
  let inDetailSection = false

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue

    const match = WINDOW_LINE.exec(line)
    const label = match?.[1]
    const percentText = match?.[2]
    // Sifirlanma saati olmayan pencere gecerlidir; yalniz label + yuzde zorunlu.
    const resetsAtRaw = match?.[3] ?? ''
    if (label === undefined || percentText === undefined) {
      // Bilinen onsoz anomali degildir; `unparsedLines` her olcumde dolu olursa
      // "beklenmedik satir var mi" sorusu anlamini yitirir. Metin `raw` icinde
      // durur, `preambleLines()` ile geri okunur. Ayni kalip pencerelerden
      // SONRA gelirse beklenmedik sayilir ve tasinir.
      if (!sawWindow && isPreambleLine(line)) continue
      // Ayrinti bolumu bir kez basladi mi sonuna kadar surer; icerigi degisken
      // oldugu icin satir satir kaliba baglanmaz, bolum olarak atlanir.
      if (inDetailSection) continue
      if (isDetailSectionHeader(line)) {
        inDetailSection = true
        continue
      }
      unparsedLines.push(line)
      continue
    }

    const percent = Number(percentText)
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      unparsedLines.push(line)
      continue
    }

    windows.push({
      label,
      percent,
      resetsAtRaw,
      resetsAtMs: resetsAtRaw === '' ? null : parseResetsAt(resetsAtRaw, atMs)
    })
    sawWindow = true
  }

  return { at: atMs, windows, unparsedLines, raw }
}
