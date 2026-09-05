/**
 * Bu makinede acik Claude Code oturumlarini tespit eden platform adaptoru (REQ-7).
 *
 * Tespit basarisiz olursa sonuc `{ supported: false, reason }` olur; bos oturum
 * listesi ile "0 oturum" iddia edilmez — cagiran taraf ikisini ayirt eder.
 *
 * Surec listesi kabuk uzerinden alinmaz: `execFile` + arguman dizisi kullanilir
 * (constraints.md CONSTRAINT-1).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ClaudeSession, ProcessScanResult } from '../../shared/types'

// ── Calistirilacak komutlar ──────────────────────────────────────────────────

export interface ProcessCommand {
  file: string
  args: string[]
}

/** Ham stdout dondurur; calistirilamazsa firlatir. */
export type CommandRunner = (command: ProcessCommand, timeoutMs: number) => Promise<string>

export interface ScanOptions {
  /** Varsayilan `process.platform`; testler icin gecilir. */
  platform?: NodeJS.Platform
  /** Varsayilan `execFile`; testler gercek surec baslatmadan calisir. */
  run?: CommandRunner
  timeoutMs?: number
}

export const SCAN_TIMEOUT_MS = 8000

/**
 * Surecleri isim filtresiyle daraltir, komut satirinda "claude" gecmeyenleri
 * atar ve her satiri {pid, start, cmd} olarak yazar. Tarih bicimi burada
 * sabitlenir: PowerShell surumleri DateTime'i farkli serilestirir
 * (5.1 `/Date(ms)/`, 7 ISO-8601), `ToString('o')` ikisinde de ayni cikar.
 * Komut satiri 1024 karaktere kirpilir — sinifiandirma icin gereken yol ve
 * bayraklar basta durur, geri kalani yalnizca yuku buyutur.
 */
const WINDOWS_SCAN_SCRIPT =
  "$ErrorActionPreference='Stop';" +
  '$r=Get-CimInstance Win32_Process -Filter "Name=\'claude.exe\' OR Name=\'node.exe\' OR Name=\'bun.exe\' OR Name=\'deno.exe\'"' +
  " | Where-Object { $_.CommandLine -and $_.CommandLine -like '*claude*' }" +
  ' | ForEach-Object { [pscustomobject]@{' +
  ' pid=$_.ProcessId;' +
  " start=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null});" +
  ' cmd=$_.CommandLine.Substring(0,[Math]::Min(1024,$_.CommandLine.Length)) } };' +
  'ConvertTo-Json -InputObject @($r) -Compress -Depth 3'

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']

/** Sirayla denenir: Windows PowerShell her kurulumda vardir, `pwsh` yedektir. */
export const WINDOWS_SCAN_COMMANDS: ProcessCommand[] = [
  { file: 'powershell.exe', args: [...POWERSHELL_ARGS, WINDOWS_SCAN_SCRIPT] },
  { file: 'pwsh', args: [...POWERSHELL_ARGS, WINDOWS_SCAN_SCRIPT] }
]

/**
 * `-w -w` komut satirinin terminal genisligine kirpilmasini engeller; bayragi
 * tanimayan `ps` surumleri icin bayraksiz surum yedekte durur.
 */
export const UNIX_SCAN_COMMANDS: ProcessCommand[] = [
  { file: 'ps', args: ['-w', '-w', '-eo', 'pid,lstart,command'] },
  { file: 'ps', args: ['-eo', 'pid,lstart,command'] }
]

// ── Surec sinifiandirma ──────────────────────────────────────────────────────

const CLAUDE_EXECUTABLES = new Set(['claude', 'claude.exe'])
const JS_HOSTS = new Set(['node', 'node.exe', 'bun', 'bun.exe', 'deno', 'deno.exe'])

/** Electron alt surecleri (Claude Desktop'un gpu/renderer/utility surecleri). */
const ELECTRON_CHILD_FLAG =
  /--type=(?:renderer|gpu-process|utility|crashpad-handler|zygote|broker|ppapi|plugin)/

/**
 * Claude Desktop yol imzalari. Desktop'un calistirilabiliri de `claude.exe`
 * adini tasir ve ana sureci `--type=` bayragi tasimaz; bu yuzden yalniz isim
 * veya yalniz bayrak elemesi yetmez.
 */
const DESKTOP_MARKERS = [
  '\\windowsapps\\claude_',
  '\\app\\claude.exe',
  '\\appdata\\local\\anthropicclaude',
  '\\applications\\claude.app',
  '\\claude.app\\contents',
  '\\claude helper',
  '\\claude-desktop',
  'app.asar'
]

/** CLI npm/bun ile kurulduysa calistirilabilir bir JS calisma ortamidir. */
const CLI_PACKAGE_MARKERS = ['claude-code', '@anthropic-ai']

/** Karsilastirmayi buyuk/kucuk harften ve yol ayiracindan bagimsiz kilar. */
function normalizeCommandLine(commandLine: string): string {
  return commandLine.toLowerCase().replace(/\//g, '\\').replace(/"/g, '')
}

/** Ilk bayraga kadar olan kisim: calistirilabilir yolu ve varsa betik yolu. */
function commandHead(normalized: string): string {
  const flag = /\s-{1,2}[a-z]/.exec(normalized)
  return flag === null ? normalized : normalized.slice(0, flag.index)
}

function baseName(path: string): string {
  const parts = path.split('\\')
  return parts[parts.length - 1] ?? ''
}

/**
 * Komut satirinin bir Claude Code CLI oturumuna ait olup olmadigini soyler.
 * Claude Desktop surecleri ve yolunda tesadufen "claude" gecen alakasiz
 * surecler (orn. `node C:\...\Temp\claude\betik.mjs`) elenir.
 */
export function isClaudeCodeSession(commandLine: string): boolean {
  const trimmed = commandLine.trim()
  if (trimmed.length === 0) return false

  const normalized = normalizeCommandLine(trimmed)
  if (ELECTRON_CHILD_FLAG.test(normalized)) return false
  if (DESKTOP_MARKERS.some((marker) => normalized.includes(marker))) return false

  const head = commandHead(normalized)
  const tokens = head.split(/\s+/).filter((token) => token.length > 0)

  // Tirnaksiz bir yol bosluk iceriyorsa ilk token kirilir; her parcanin son
  // bileseni denenerek `C:\Program Files\...\claude.exe` bicimi de yakalanir.
  for (const token of tokens) {
    if (CLAUDE_EXECUTABLES.has(baseName(token))) return true
  }

  const host = tokens[0]
  if (host !== undefined && JS_HOSTS.has(baseName(host))) {
    return CLI_PACKAGE_MARKERS.some((marker) => head.includes(marker))
  }

  return false
}

// ── Zaman ayristirma ─────────────────────────────────────────────────────────

const DOTNET_JSON_DATE = /^\/Date\((-?\d+)\)\/$/
const CIM_DATETIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3,4})$/

const MONTHS = new Map<string, number>([
  ['jan', 0],
  ['feb', 1],
  ['mar', 2],
  ['apr', 3],
  ['may', 4],
  ['jun', 5],
  ['jul', 6],
  ['aug', 7],
  ['sep', 8],
  ['oct', 9],
  ['nov', 10],
  ['dec', 11]
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * PowerShell'in uc tarih bicimini de kabul eder: ISO-8601, `/Date(ms)/` ve ham
 * CIM_DATETIME. Cozulemezse null doner — tahmin uretilmez.
 */
export function parseWindowsStartTime(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  // `Get-Date` ciktisi DateTime'i { value, DisplayHint, DateTime } olarak sarar.
  if (isRecord(value)) {
    return 'value' in value ? parseWindowsStartTime(value.value) : null
  }
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (text.length === 0) return null

  const dotnet = DOTNET_JSON_DATE.exec(text)
  if (dotnet !== null) {
    const ms = Number(dotnet[1])
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }

  const cim = CIM_DATETIME.exec(text)
  if (cim !== null) {
    const [, year, month, day, hour, minute, second, micro, offset] = cim
    if (
      year === undefined ||
      month === undefined ||
      day === undefined ||
      hour === undefined ||
      minute === undefined ||
      second === undefined ||
      micro === undefined ||
      offset === undefined
    ) {
      return null
    }
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(micro.slice(0, 3))
    )
    return utc - Number(offset) * 60_000
  }

  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

const UNIX_LSTART = /^(?:[A-Za-z]{3,}\s+)?([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/

/**
 * `ps -o lstart` ciktisini cozer: "Fri Sep  5 14:47:59 2026". Deger yerel saat
 * diliminde uretilir, yerel takvimle epoch ms'e cevrilir.
 */
export function parseUnixStartTime(lstart: string): number | null {
  const match = UNIX_LSTART.exec(lstart.trim())
  if (match === null) return null

  const [, monthName, day, hour, minute, second, year] = match
  if (
    monthName === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    year === undefined
  ) {
    return null
  }

  const month = MONTHS.get(monthName.toLowerCase())
  if (month === undefined) return null

  return new Date(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime()
}

// ── Ham cikti ayristiricilari (saf; testler bunlari dogrudan cagirir) ────────

function toPid(value: unknown): number | null {
  const pid = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  return pid
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * `cwd` transkript eslestirmesiyle doldurulur (ayri modul): `~/.claude/projects`
 * altindaki oturum `.jsonl` dosyalarinin `cwd` alani, oturumun baslangic
 * zamanina en yakin kayit uzerinden pid ile eslestirilir. Surec listesi cwd
 * bilgisini vermedigi icin burada null kalir.
 */
function toSession(pid: number, startedAtMs: number | null): ClaudeSession {
  return { pid, startedAtMs, cwd: null }
}

/** Once en eski oturum; zamani bilinmeyenler sona, esitlikte pid'e gore. */
function sortSessions(sessions: ClaudeSession[]): ClaudeSession[] {
  return [...sessions].sort((a, b) => {
    if (a.startedAtMs === null && b.startedAtMs === null) return a.pid - b.pid
    if (a.startedAtMs === null) return 1
    if (b.startedAtMs === null) return -1
    if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs
    return a.pid - b.pid
  })
}

/**
 * `Get-CimInstance Win32_Process` ciktisini (JSON) oturum listesine cevirir.
 * Bos veya cozulemeyen cikti "0 oturum" degil, tespit edilemedi demektir.
 */
export function parseWindowsProcessList(raw: string): ProcessScanResult {
  const text = raw.trim()
  if (text.length === 0) {
    return { supported: false, reason: 'PowerShell surec sorgusu bos cikti dondurdu' }
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch {
    return { supported: false, reason: 'PowerShell ciktisi JSON olarak cozulemedi' }
  }

  // Tek satirlik sonucta PowerShell dizi yerine tek nesne yazabilir.
  const rows = Array.isArray(decoded) ? decoded : [decoded]

  const sessions: ClaudeSession[] = []
  let readableRows = 0

  for (const row of rows) {
    if (!isRecord(row)) continue
    const pid = toPid(row.pid ?? row.ProcessId)
    if (pid === null) continue
    readableRows += 1

    if (!isClaudeCodeSession(toText(row.cmd ?? row.CommandLine))) continue
    sessions.push(toSession(pid, parseWindowsStartTime(row.start ?? row.CreationDate)))
  }

  if (rows.length > 0 && readableRows === 0) {
    return {
      supported: false,
      reason: 'PowerShell ciktisindaki hicbir satir okunamadi (pid alani yok)'
    }
  }

  return { supported: true, sessions: sortSessions(sessions) }
}

const UNIX_LINE = /^\s*(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*)$/

function isUnixHeaderLine(line: string): boolean {
  return /^\s*pid\b/i.test(line)
}

/**
 * `ps -eo pid,lstart,command` ciktisini oturum listesine cevirir. Hicbir satir
 * beklenen bicime uymuyorsa cikti anlasilmamistir; bos liste dondurulmez.
 */
export function parseUnixProcessList(raw: string): ProcessScanResult {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return { supported: false, reason: '`ps` bos cikti dondurdu' }
  }

  const sessions: ClaudeSession[] = []
  let readableLines = 0

  for (const line of lines) {
    if (isUnixHeaderLine(line)) continue

    const match = UNIX_LINE.exec(line)
    if (match === null) continue

    const [, pidText, startText, command] = match
    if (pidText === undefined || startText === undefined || command === undefined) continue

    const pid = toPid(pidText)
    if (pid === null) continue
    readableLines += 1

    if (!isClaudeCodeSession(command)) continue
    sessions.push(toSession(pid, parseUnixStartTime(startText)))
  }

  if (readableLines === 0) {
    return {
      supported: false,
      reason: '`ps` ciktisi beklenen "pid lstart command" bicimine uymuyor'
    }
  }

  return { supported: true, sessions: sortSessions(sessions) }
}

// ── Calistirma ───────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

const defaultRunner: CommandRunner = async (command, timeoutMs) => {
  const { stdout } = await execFileAsync(command.file, command.args, {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
    shell: false
  })
  return stdout
}

/** Hata metnini arayuze tasimadan once yol ve e-posta alanlarini maskeler. */
export function maskSensitive(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-posta>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"']*/g, '<yol>')
}

/** Cok satirli ciktinin ilk anlamli satiri; arayuze tek satir gider. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

function describeRunError(error: unknown): string {
  if (!(error instanceof Error)) return 'bilinmeyen hata'

  const details = error as { code?: unknown; killed?: unknown; stderr?: unknown }
  if (details.killed === true) return 'zaman asimi'
  if (typeof details.code === 'string' && details.code.length > 0) return details.code

  // stderr komutun kendi hata metnini verir; `error.message` tum komut satirini
  // (Windows'ta yuzlerce karakterlik PowerShell betigini) basa ekler.
  const stderr = typeof details.stderr === 'string' ? firstLine(details.stderr) : ''
  const detail = stderr.length > 0 ? stderr : firstLine(error.message)

  return maskSensitive(detail).slice(0, 160)
}

async function runFirstWorking(
  commands: ProcessCommand[],
  parse: (raw: string) => ProcessScanResult,
  run: CommandRunner,
  timeoutMs: number
): Promise<ProcessScanResult> {
  let last: ProcessScanResult = {
    supported: false,
    reason: 'Surec listeleme komutu tanimlanmadi'
  }

  for (const command of commands) {
    try {
      last = parse(await run(command, timeoutMs))
    } catch (error) {
      last = {
        supported: false,
        reason: `\`${command.file}\` calistirilamadi: ${describeRunError(error)}`
      }
      continue
    }
    if (last.supported) return last
  }

  return last
}

/**
 * Bu makinede acik Claude Code oturumlarini dondurur. Tespit yapilamazsa
 * `{ supported: false, reason }` doner; bos liste ile karistirilmaz (REQ-7).
 */
export async function scanClaudeSessions(options: ScanOptions = {}): Promise<ProcessScanResult> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? SCAN_TIMEOUT_MS

  if (platform === 'win32') {
    return runFirstWorking(WINDOWS_SCAN_COMMANDS, parseWindowsProcessList, run, timeoutMs)
  }
  if (platform === 'darwin' || platform === 'linux') {
    return runFirstWorking(UNIX_SCAN_COMMANDS, parseUnixProcessList, run, timeoutMs)
  }

  return { supported: false, reason: `Surec tespiti bu platformda desteklenmiyor: ${platform}` }
}
