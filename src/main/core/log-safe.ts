/**
 * Maskeleme katmani ve guvenli log.
 *
 * Loglar tani icin kullanicidan istenebilir; icinde e-posta, kullanici adi
 * tasiyan mutlak yol veya belirtec kalmamalidir (security.md).
 *
 * Tasarim ilkesi: **masum metin bozulmaz.** Her kural dar tanimlidir; "uzun ve
 * suphelidir" diye genis tarama yapilmaz. `/usage`, `usage-history.jsonl`,
 * surum numarasi, zaman damgasi gibi tani degeri tasiyan metinler oldugu gibi
 * kalir — asiri maskeleme, logu okunmaz kilarak maskelemenin amacini bozar.
 */

export const EMAIL_MASK = '<e-posta>'
export const HOME_MASK = '<ev>'
export const SECRET_MASK = '<gizli>'

/** Kesintisiz harf/rakam dizisi bu uzunlugu asarsa belirtec adayi sayilir. */
export const MIN_SECRET_RUN = 20

// ── Yardimcilar ──────────────────────────────────────────────────────────────

function isAlnum(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch)
}

/** Adayin `-` ve `_` ile bolunmemis en uzun harf/rakam parcasi. */
function longestAlnumRun(value: string): string {
  let best = ''
  let current = ''
  for (const ch of value) {
    if (isAlnum(ch)) {
      current += ch
      if (current.length > best.length) best = current
    } else {
      current = ''
    }
  }
  return best
}

/**
 * Belirtecler yuksek entropilidir: uzun, kesintisiz ve harf-rakam karisik.
 * Yalnizca uzunluga bakilsaydi `usage-history-2026-09-05` gibi masum adlar da
 * maskelenirdi; yalnizca karisima bakilsaydi `v2.1.258` gibi kisa metinler.
 */
function looksLikeSecret(candidate: string): boolean {
  const run = longestAlnumRun(candidate)
  if (run.length < MIN_SECRET_RUN) return false
  return /[0-9]/.test(run) && /[A-Za-z]/.test(run)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Ev dizini logda hem `\` hem `/` ayraciyla gecebilir; ikisi de yakalanir. */
function homeDirPattern(dir: string): RegExp {
  const parts = dir.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.length === 0) return /(?!)/
  return new RegExp(parts.map(escapeRegExp).join('[\\\\/]+'), 'gi')
}

// ── Kurallar ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Ev dizini kokleri. Yalnizca **kok** maskelenir, kuyruk korunur:
 * `C:\Users\ada\.claude\projects` → `<ev>\.claude\projects`. Yolun tamami
 * silinseydi "hangi dosya" bilgisi de giderdi.
 */
const HOME_RULES: readonly RegExp[] = [
  // WSL: /mnt/c/Users/<ad>
  /\/mnt\/[a-z]\/Users\/[^\\/\s"']+/gi,
  // Windows: C:\Users\<ad>, \\?\C:\Users\<ad>, C:/Users/<ad>
  /(?:\\\\\?\\)?[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi,
  // macOS /Users/<ad> ve Linux /home/<ad>. Onunde harf/rakam varsa (URL yolu
  // gibi) eslesmez.
  /(?<![A-Za-z0-9])\/(?:Users|home)\/[^\\/\s"']+/g
]

const SECRET_RULES: readonly RegExp[] = [
  // JWT: uc base64url parca.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+)?/g,
  // Anthropic anahtar/oturum belirteci.
  /\bsk-ant-[A-Za-z0-9_-]+/gi,
  // UUID (machineID, oturum kimligi): sekil kesin, yanlis pozitif vermez.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
]

const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/** Kalan yuksek entropili diziler. Karar `looksLikeSecret`e birakilir. */
const ENTROPY_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g

export interface MaskOptions {
  /**
   * Standart disi ev dizinleri (`PathEnv.homeDir`). Kalip tabanli kurallar
   * yalnizca alisildik koklari bilir; gercek ev dizini verilirse kesin yakalanir.
   */
  homeDirs?: readonly string[]
}

/**
 * Metindeki e-posta, ev dizini koku ve belirtec benzeri dizileri maskeler.
 * Kurallar sirayla uygulanir: once e-posta, sonra yollar, en sonda belirtecler —
 * boylece yol parcalari belirtec sanilip topluca silinmez.
 */
export function maskSensitive(text: string, options: MaskOptions = {}): string {
  let output = text

  for (const dir of options.homeDirs ?? []) {
    if (dir.trim().length === 0) continue
    output = output.replace(homeDirPattern(dir), HOME_MASK)
  }

  output = output.replace(EMAIL_RE, EMAIL_MASK)

  for (const rule of HOME_RULES) {
    output = output.replace(rule, HOME_MASK)
  }

  for (const rule of SECRET_RULES) {
    output = output.replace(rule, SECRET_MASK)
  }

  output = output.replace(BEARER_RE, (_match, scheme: string) => scheme + ' ' + SECRET_MASK)

  return output.replace(ENTROPY_RE, (match) => (looksLikeSecret(match) ? SECRET_MASK : match))
}

// ── Meta maskeleme ───────────────────────────────────────────────────────────

/**
 * Adi geciyorsa deger hic incelenmez, dogrudan maskelenir. `auth` gibi genis
 * parcalar bilerek yok: `authStatus` bu uygulamada gizli olmayan bir alan.
 */
const SECRET_KEY_PARTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'privatekey'
]

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}

/** Ic ice gecmis meta bu derinlikten sonra ozetlenir. */
export const MAX_META_DEPTH = 4

function maskValue(
  value: unknown,
  options: MaskOptions,
  depth: number,
  seen: Set<object>
): unknown {
  if (typeof value === 'string') return maskSensitive(value, options)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value === undefined) return undefined
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function') return '<fonksiyon>'
  if (typeof value === 'symbol') return value.toString()

  if (value instanceof Error) {
    return { name: value.name, message: maskSensitive(value.message, options) }
  }

  if (depth >= MAX_META_DEPTH) return '<derin>'
  if (seen.has(value as object)) return '<dongu>'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, options, depth + 1, seen))
  }

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? SECRET_MASK : maskValue(item, options, depth + 1, seen)
  }
  return output
}

/** Meta nesnesini maskeler. Anahtarlar korunur, degerler temizlenir. */
export function maskMeta(
  meta: Record<string, unknown>,
  options: MaskOptions = {}
): Record<string, unknown> {
  const result = maskValue(meta, options, 0, new Set<object>())
  return result as Record<string, unknown>
}

// ── Log ──────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  level: LogLevel
  /** Maskelenmis mesaj. */
  message: string
  /** Maskelenmis meta; verilmediyse yok. */
  meta?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

const consoleMethods: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error'
}

export const consoleSink: LogSink = (record: LogRecord): void => {
  const method = consoleMethods[record.level]
  const prefix = '[' + record.level + ']'
  if (record.meta === undefined) {
    console[method](prefix, record.message)
  } else {
    console[method](prefix, record.message, record.meta)
  }
}

let sink: LogSink = consoleSink
let maskOptions: MaskOptions = {}

/** Ciktinin nereye gidecegini degistirir (test, dosya logu, uzak toplama). */
export function setLogSink(next: LogSink): void {
  sink = next
}

export function resetLogSink(): void {
  sink = consoleSink
}

/**
 * Tum loglara uygulanacak maskeleme ayari. Uygulama acilisinda gercek ev dizini
 * verilir; boylece standart disi konumlar da yakalanir.
 */
export function configureMasking(options: MaskOptions): void {
  maskOptions = options
}

/**
 * Mesaji ve metayi maskeleyip sink'e verir. Hicbir cagri sitesinde "bu metin
 * temiz mi" diye dusunulmesi gerekmez — maskeleme burada, tek yerde olur.
 */
export function safeLog(
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>
): void {
  const record: LogRecord =
    meta === undefined
      ? { level, message: maskSensitive(message, maskOptions) }
      : {
          level,
          message: maskSensitive(message, maskOptions),
          meta: maskMeta(meta, maskOptions)
        }
  sink(record)
}
