/**
 * `claude` calistirilabilirini bulur ve kabuk KULLANMADAN calistirir.
 *
 * Kabuk yasagi (constraints.md CONSTRAINT-1): Git Bash / MSYS `"/usage"`
 * argumanini `C:/Program Files/Git/usage` haline getirir; slash komutu calismaz,
 * duz prompt olarak modele gider ve token yakar. Bu yuzden her cagri `execFile` +
 * arguman dizisi ile yapilir, `shell` acikca `false` gecilir.
 *
 * Tek istisna Windows `.cmd`/`.bat` shim'idir: Node onu `shell:false` ile
 * acamaz, `cmd.exe` uzerinden gecer. Bu bir POSIX kabugu degildir, yol
 * donusumu yapmaz ve argumanlar tirnaklanarak aynen gecirilir.
 *
 * Butun dis bagimliliklar (execFile, dosya sistemi, ortam degiskenleri)
 * parametre olarak enjekte edilebilir; testler gercek I/O yapmaz.
 */

import { execFile as nodeExecFile } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

import { CliError, type AuthStatus, type UsageCliResult } from '../../shared/types'

// ── Enjekte edilebilir bagimliliklar ─────────────────────────────────────────

/** `execFile` hatasinin bu modulun okudugu alanlari. */
export interface ExecFileError extends Error {
  code?: string | number | null
  killed?: boolean
  signal?: string | null
}

export interface ExecFileOptions {
  timeout: number
  maxBuffer: number
  windowsHide: boolean
  encoding: 'utf8'
  /** Daima false — CONSTRAINT-1. */
  shell: false
  /**
   * Yalnizca Windows `.cmd`/`.bat` shim yolunda true. Komut satirini bu modul
   * kurar; Node yeniden tirnaklamaz. Diger yollarda tanimsiz kalir.
   */
  windowsVerbatimArguments?: boolean
}

export type ExecFileCallback = (
  error: ExecFileError | null,
  stdout: string,
  stderr: string
) => void

/** `child_process.execFile`in bu modulun kullandigi imzasi. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback
) => void

/**
 * `parseUsageJson` ciktisi. `UsageCliResult`i genisletir: eksik alanlar geriye
 * donuk uyum icin 0/{} ile doldurulur ama VARLIKLARI ayrica bildirilir, boylece
 * "olculdu ve sifirdi" ile "alan hic gelmedi" birbirine karismaz.
 */
export interface UsageCliOutput extends UsageCliResult {
  /** `usage` nesnesi ciktida gercekten var miydi. */
  usageFieldPresent: boolean
  /** `total_cost_usd` sayisi ciktida gercekten var miydi. */
  costFieldPresent: boolean
}

/** Kesif sirasinda kullanilan dosya sistemi erisimi. */
export interface CliFileSystem {
  /** Yol bir dosya ve calistirilabilir mi. */
  isExecutable(path: string): boolean
  /** Dizin girdileri; dizin yoksa veya okunamazsa bos dizi. */
  listDir(path: string): string[]
}

/** Hedef platformun yol lehcesi (`path.win32` veya `path.posix`). */
interface PathFlavor {
  join(...parts: string[]): string
  readonly delimiter: string
}

export interface DiscoverOptions {
  /** Konfige yazili yol; varsa once bu denenir. */
  configuredPath?: string | null
  /** `process.platform` degeri. */
  platform?: string
  env?: Record<string, string | undefined>
  home?: string
  fs?: CliFileSystem
}

export interface CliRuntime {
  execFile?: ExecFileFn
  timeoutMs?: number
  /** `process.platform` degeri; shim sarmalamasi buna gore acilir. */
  platform?: string
}

// ── Sabitler ─────────────────────────────────────────────────────────────────

/** Kota sorgusunun argumanlari. 0 token harcar (context.md > Dogrulanmis Bulgular). */
export const USAGE_ARGS: readonly string[] = ['-p', '/usage', '--output-format', 'json']

export const AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status', '--json']

export const DEFAULT_TIMEOUT_MS = 30_000

const MAX_BUFFER_BYTES = 4 * 1024 * 1024

/** `CliError.rawOutput` icin ust sinir; asilirsa gorunur bicimde kirpilir. */
const MAX_RAW_OUTPUT_CHARS = 4000

/** Oturum kapali / token olu gostergeleri. */
const AUTH_FAILURE_PATTERN =
  /\b401\b|unauthorized|not logged in|please log ?in|expired|authenticat/i

/**
 * Calistirilabilir bulunamadi anlamina gelen spawn hata kodlari.
 *
 * EINVAL burada YOKTUR: Windows'ta batch dosyasi hedefinde gelir ve "CLI kurulu
 * degil" demek degildir — dosya oradadir, yalnizca `cmd.exe` olmadan
 * acilamaz. 'not-found' sinifi kullaniciya yanlis teshis gosterir.
 */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'])

/** Windows'ta kabuk yorumlayicisi isteyen shim uzantilari. */
const WINDOWS_SHIM_PATTERN = /\.(?:cmd|bat)$/i

// ── Varsayilan bagimliliklar ─────────────────────────────────────────────────

const defaultExecFile: ExecFileFn = (file, args, options, callback) => {
  nodeExecFile(file, args, options, callback)
}

const defaultFileSystem: CliFileSystem = {
  isExecutable(path) {
    try {
      if (!statSync(path).isFile()) return false
      // Windows'ta X_OK anlamsizdir; dosyanin varligi yeter.
      if (process.platform === 'win32') return true
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  }
}

// ── Kesif ────────────────────────────────────────────────────────────────────

/**
 * Surum klasorlerini yeniden eskiye siralar. Sozluksel siralama yanlis sonuc
 * verir (`2.1.9` > `2.1.10`), o yuzden segmentler sayisal karsilastirilir.
 */
export function sortVersionDirsDesc(entries: readonly string[]): string[] {
  return entries.filter((entry) => /\d/.test(entry)).sort(compareVersionsDesc)
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const na = toSegmentNumber(left[i])
    const nb = toSegmentNumber(right[i])
    if (na !== nb) return nb - na
  }
  return b.localeCompare(a)
}

function toSegmentNumber(segment: string | undefined): number {
  if (segment === undefined) return -1
  const parsed = Number.parseInt(segment, 10)
  return Number.isNaN(parsed) ? -1 : parsed
}

/**
 * `claude` calistirilabilirini bulur. Sira: konfig → PATH → bilinen kurulum
 * yollari → (Windows) PATH'teki `.cmd`/`.bat` shim'leri.
 *
 * Son adim ayri tutulur: shim `cmd.exe` sarmalayicisiyla calisir (bkz.
 * `windowsShimLaunch`) ama fazladan bir surec ve tirnaklama riski getirir,
 * o yuzden gercek exe varken tercih edilmez.
 *
 * @throws CliError('not-found') hicbir aday calistirilabilir degilse.
 */
export function discoverClaudeBinary(options: DiscoverOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const fs = options.fs ?? defaultFileSystem
  const isWindows = platform === 'win32'

  const tried: string[] = []

  const configured = options.configuredPath?.trim()
  if (configured) {
    if (fs.isExecutable(configured)) return configured
    tried.push(configured)
  }

  // Yol birlestirme hedef platformun lehcesiyle yapilir, host'un `path`
  // varsayilaniyla degil; yoksa Windows'ta posix aday `\` ile uretilir.
  const p: PathFlavor = isWindows ? pathWin32 : pathPosix

  const groups: string[][] = [
    pathCandidates(env, isWindows, false, p),
    knownInstallCandidates(env, home, isWindows, fs, p),
    isWindows ? pathCandidates(env, isWindows, true, p) : []
  ]

  for (const group of groups) {
    for (const candidate of group) {
      if (fs.isExecutable(candidate)) return candidate
      tried.push(candidate)
    }
  }

  throw new CliError(
    'not-found',
    `claude calistirilabiliri bulunamadi (${tried.length} aday denendi)`
  )
}

/** PATH'teki her dizin icin aday yollar. `shims` true ise yalnizca .cmd/.bat. */
function pathCandidates(
  env: Record<string, string | undefined>,
  isWindows: boolean,
  shims: boolean,
  p: PathFlavor
): string[] {
  if (shims && !isWindows) return []
  const rawPath = env.PATH ?? env.Path ?? env.path ?? ''
  const dirs = rawPath.split(p.delimiter).filter((dir) => dir.trim().length > 0)
  const names = isWindows ? (shims ? ['claude.cmd', 'claude.bat'] : ['claude.exe']) : ['claude']

  const candidates: string[] = []
  for (const dir of dirs) {
    for (const name of names) candidates.push(p.join(dir, name))
  }
  return candidates
}

/** Platform bazli bilinen kurulum yollari. */
function knownInstallCandidates(
  env: Record<string, string | undefined>,
  home: string,
  isWindows: boolean,
  fs: CliFileSystem,
  p: PathFlavor
): string[] {
  return isWindows ? windowsInstallCandidates(env, fs, p) : posixInstallCandidates(env, home, p)
}

/**
 * Windows: `%APPDATA%/Claude/claude-code/<surum>/claude.exe` ve `%LOCALAPPDATA%`
 * varyanti. Surum klasoru degiskendir; en yeni surum basa alinir.
 */
function windowsInstallCandidates(
  env: Record<string, string | undefined>,
  fs: CliFileSystem,
  p: PathFlavor
): string[] {
  const candidates: string[] = []

  for (const base of [env.APPDATA, env.LOCALAPPDATA]) {
    if (!base) continue
    const root = p.join(base, 'Claude', 'claude-code')
    for (const version of sortVersionDirsDesc(fs.listDir(root))) {
      candidates.push(p.join(root, version, 'claude.exe'))
    }
    candidates.push(p.join(root, 'claude.exe'))
  }

  const npmPrefix = env.npm_config_prefix ?? (env.APPDATA ? p.join(env.APPDATA, 'npm') : undefined)
  if (npmPrefix) candidates.push(p.join(npmPrefix, 'claude.exe'))

  return candidates
}

function posixInstallCandidates(
  env: Record<string, string | undefined>,
  home: string,
  p: PathFlavor
): string[] {
  const candidates = [
    p.join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    p.join(home, '.npm-global', 'bin', 'claude')
  ]
  const npmPrefix = env.npm_config_prefix
  if (npmPrefix) candidates.push(p.join(npmPrefix, 'bin', 'claude'))
  return candidates
}

// ── Calistirma ───────────────────────────────────────────────────────────────

interface CliOutcome {
  stdout: string
  stderr: string
  error: ExecFileError | null
}

/** Hedef bir Windows kabuk shim'i mi (`.cmd` / `.bat`). */
export function isWindowsShim(bin: string): boolean {
  return WINDOWS_SHIM_PATTERN.test(bin.trim())
}

interface Launch {
  file: string
  args: string[]
  verbatim: boolean
}

/**
 * `.cmd`/`.bat` hedefini `cmd.exe` uzerinden calistirilabilir bicime cevirir.
 *
 * Node 22'de `execFile(shell:false)` ile batch dosyasi acmak `spawn`i SENKRON
 * `EINVAL` ile dusurur (node v22.22.3 + `%APPDATA%/npm/claude.cmd` uzerinde
 * olculdu). Bu makinede PATH'te yalnizca shim vardir, yani sarmalayici olmadan
 * CLI hic calismaz.
 *
 * Komut satiri burada elle kurulur ve `windowsVerbatimArguments` ile aynen
 * gecirilir. Node'un varsayilan tirnaklamasi yalnizca bosluk gorunce tirnak
 * ekler; yolda `&` varsa jeton tirnaksiz gecer ve cmd komutu `&`'de boler
 * (olculdu: `...\shim' is not recognized`). Her jeton tirnaklanip tumu tek dis
 * tirnak ciftiyle sarilinca `/s` dis cifti soyar, jetonlar aynen gecer.
 *
 * CONSTRAINT-1 korunur: `shell:false` kalir, POSIX kabugu devreye girmez ve
 * cmd.exe yol donusumu yapmaz — `/usage` argumani oldugu gibi ulasir.
 */
function windowsShimLaunch(bin: string, args: readonly string[]): Launch {
  const tokens = [bin, ...args]
  // Windows yollarinda `"` gecersizdir; yine de tirnaklama sessizce bozulmasin.
  const bad = tokens.find((token) => token.includes('"'))
  if (bad !== undefined) {
    throw new CliError('unknown', `shim komutunda tirnak karakteri var: ${bad}`)
  }
  const line = tokens.map((token) => `"${token}"`).join(' ')
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

function planLaunch(bin: string, args: readonly string[], platform: string): Launch {
  if (platform === 'win32' && isWindowsShim(bin)) return windowsShimLaunch(bin, args)
  return { file: bin, args: [...args], verbatim: false }
}

/** Bilinmeyen bir firlatilan degeri bu modulun okudugu hata bicimine cevirir. */
function toExecFileError(thrown: unknown): ExecFileError {
  if (thrown instanceof Error) return thrown as ExecFileError
  return new Error(String(thrown)) as ExecFileError
}

function execCli(
  bin: string,
  args: readonly string[],
  runtime: CliRuntime | undefined
): Promise<CliOutcome> {
  const execFileFn = runtime?.execFile ?? defaultExecFile
  const timeout = runtime?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const platform = runtime?.platform ?? process.platform
  const launch = planLaunch(bin, args, platform)

  const options: ExecFileOptions = {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    encoding: 'utf8',
    shell: false,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {})
  }

  return new Promise((resolve) => {
    try {
      execFileFn(launch.file, launch.args, options, (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', error: error ?? null })
      })
    } catch (thrown) {
      // spawn bazi hatalarda (Windows batch hedefi: EINVAL) geri cagriya hic
      // dusmeden SENKRON firlatir; yakalanmazsa disari ciplak Error sizar.
      resolve({ stdout: '', stderr: '', error: toExecFileError(thrown) })
    }
  })
}

/**
 * `claude -p /usage --output-format json` calistirir ve JSON'u cozer.
 *
 * @throws CliError — 'timeout' | 'not-found' | 'not-logged-in' | 'bad-output' | 'unknown'
 */
export async function runUsage(bin: string, runtime?: CliRuntime): Promise<UsageCliOutput> {
  const outcome = await execCli(bin, USAGE_ARGS, runtime)
  const raw = combineOutput(outcome)

  if (AUTH_FAILURE_PATTERN.test(raw)) {
    throw new CliError('not-logged-in', 'claude oturumu gecerli degil', clip(raw))
  }

  if (outcome.error) throw classifyExecError(outcome.error, raw)

  const parsed = parseUsageJson(outcome.stdout)
  if (!parsed) {
    throw new CliError('bad-output', '/usage ciktisi JSON olarak cozulemedi', clip(raw))
  }
  return parsed
}

/**
 * `claude auth status --json` calistirir.
 *
 * Oturum kapaliyken komut `loggedIn:false` donebilir — bu bir hata degildir,
 * o yuzden burada 'not-logged-in' firlatilmaz. DIKKAT: cikti yerelden okunur,
 * token olu olsa bile `loggedIn:true` gelebilir; saglik kaniti degildir.
 */
export async function runAuthStatus(bin: string, runtime?: CliRuntime): Promise<AuthStatus> {
  const outcome = await execCli(bin, AUTH_STATUS_ARGS, runtime)
  const raw = combineOutput(outcome)

  const parsed = parseAuthStatusJson(outcome.stdout)
  if (parsed) return parsed

  if (outcome.error) throw classifyExecError(outcome.error, raw)
  throw new CliError('bad-output', 'auth status ciktisi JSON olarak cozulemedi', clip(raw))
}

function classifyExecError(error: ExecFileError, raw: string): CliError {
  if (isTimeout(error)) {
    return new CliError('timeout', 'claude komutu zaman asimina ugradi', clip(raw))
  }
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'EINVAL') {
    // Dosya yerinde; yalnizca bu bicimde acilamiyor. 'not-found' demek
    // kullaniciya "CLI kurulu degil" yanlis teshisini gosterir.
    return new CliError(
      'unknown',
      'claude calistirilamadi (EINVAL) — hedef bir .cmd/.bat shim ise cmd.exe uzerinden acilmali',
      clip(raw)
    )
  }
  if (NOT_FOUND_CODES.has(code)) {
    return new CliError('not-found', `claude calistirilamadi (${code})`, clip(raw))
  }
  if (AUTH_FAILURE_PATTERN.test(raw)) {
    return new CliError('not-logged-in', 'claude oturumu gecerli degil', clip(raw))
  }
  return new CliError('unknown', `claude komutu basarisiz: ${error.message}`, clip(raw))
}

function isTimeout(error: ExecFileError): boolean {
  return error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT'
}

function combineOutput(outcome: CliOutcome): string {
  return [outcome.stdout, outcome.stderr].filter((part) => part.trim().length > 0).join('\n')
}

/**
 * Cok uzun ciktiyi gorunur bicimde kirpar; sessizce yutmaz.
 *
 * DIKKAT — kirpma MASKELEME DEGILDIR. Donen metin ham CLI ciktisidir ve
 * e-posta / dosya yolu / oturum bilgisi tasiyabilir (types.ts:46). Bu modul
 * bilerek hicbir log cagrisi yapmaz: `CliError.rawOutput` bir yere yazilacaksa
 * maskeleme cagiranin sorumlulugudur.
 */
function clip(raw: string): string {
  if (raw.length <= MAX_RAW_OUTPUT_CHARS) return raw
  return `${raw.slice(0, MAX_RAW_OUTPUT_CHARS)}… (kirpildi, toplam ${raw.length} karakter)`
}

// ── JSON ayristirma ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown
  } catch {
    return undefined
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `/usage` ciktisini cozer; sema tutmuyorsa null. */
export function parseUsageJson(stdout: string): UsageCliOutput | null {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed)) return null
  const result = parsed.result
  if (typeof result !== 'string') return null

  const usageValue = parsed.usage
  const costValue = parsed.total_cost_usd
  const usageFieldPresent = isRecord(usageValue)
  const costFieldPresent = typeof costValue === 'number' && Number.isFinite(costValue)

  return {
    result,
    duration_ms: numberOr(parsed.duration_ms, 0),
    total_cost_usd: numberOr(costValue, 0),
    usage: usageFieldPresent ? usageValue : {},
    usageFieldPresent,
    costFieldPresent
  }
}

/**
 * CONSTRAINT-5 kaniti: olcum gercekten sifir token harcadi mi.
 *
 * `usage` alani hic gelmediyse veya icinde hic sayi yoksa **kanit yoktur**;
 * bos nesnede "tum alanlar 0" kosulu bos-dogru (vacuously true) olur ve
 * regresyonu gizler. O yuzden bu iki durumda false donulur.
 */
export function isZeroTokenUsage(output: UsageCliOutput): boolean {
  if (!output.usageFieldPresent) return false
  const numbers = Object.values(output.usage).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  if (numbers.length === 0) return false
  return numbers.every((value) => value === 0)
}

/** `auth status --json` ciktisini cozer; sema tutmuyorsa null. */
export function parseAuthStatusJson(stdout: string): AuthStatus | null {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed)) return null
  if (typeof parsed.loggedIn !== 'boolean') return null
  return {
    loggedIn: parsed.loggedIn,
    email: stringOrNull(parsed.email),
    orgName: stringOrNull(parsed.orgName),
    subscriptionType: stringOrNull(parsed.subscriptionType)
  }
}
