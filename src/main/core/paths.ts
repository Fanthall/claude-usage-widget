/**
 * Platform bazli yol cozumleme.
 *
 * Modul saftir: `electron`in `app` modulune bagimli degildir, ev dizini ve ortam
 * degiskenleri disaridan verilebilir. Boylece uc platformun yollari da tek bir
 * makinede test edilebilir.
 *
 * Yollar `path.win32` / `path.posix` ile ayri ayri birlestirilir; calisan
 * makinenin ayraci sonuca karismaz.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { AccountKey, SupportedPlatform } from '../../shared/types'

/** Uygulamanin kendi verisi bu ad altinda toplanir. */
export const APP_DIR_NAME = 'claude-usage-widget'

/** Konfig dosyasinin adi. */
export const CONFIG_FILE_NAME = 'config.json'

/** Claude CLI'nin ev dizini adi. */
export const CLAUDE_DIR_NAME = '.claude'

/** machineID ve hesap bilgisini tutan dosyanin adi. */
export const CLAUDE_CONFIG_FILE_NAME = '.claude.json'

/** CLI'in OAuth jetonunu tuttugu dosyanin adi (ayar klasorunun altinda). */
export const CREDENTIALS_FILE_NAME = '.credentials.json'

/** Team hesabinin varsayilan ayar klasoru; `CLAUDE_CONFIG_DIR` ile kullanilir. */
export const TEAM_CLAUDE_DIR_NAME = '.claude-team'

// ── Enjekte edilebilir ortam ─────────────────────────────────────────────────

export interface PathEnv {
  platform: SupportedPlatform
  /** Kullanicinin ev dizini, platformun kendi ayraciyla. */
  homeDir: string
  env: Readonly<Record<string, string | undefined>>
}

/**
 * Bilinmeyen platformlar (freebsd, openbsd, ...) XDG duzenini izler, bu yuzden
 * 'linux' tarafina toplanir.
 */
function normalizePlatform(value: string): SupportedPlatform {
  if (value === 'win32') return 'win32'
  if (value === 'darwin') return 'darwin'
  return 'linux'
}

/** Calisan surecin gercek ortami. */
export function nodePathEnv(): PathEnv {
  return {
    platform: normalizePlatform(process.platform),
    homeDir: homedir(),
    env: process.env
  }
}

function joinerFor(platform: SupportedPlatform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join
}

/** Bos dizge "tanimsiz" sayilir; ortam degiskenleri bos atanmis olabilir. */
function readEnv(env: PathEnv, name: string): string | null {
  const value = env.env[name]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

// ── Claude CLI yollari ───────────────────────────────────────────────────────

/** `~/.claude` — CLI'nin veri dizini (transkriptler, ayarlar). */
export function claudeHomeDir(env: PathEnv = nodePathEnv()): string {
  return joinerFor(env.platform)(env.homeDir, CLAUDE_DIR_NAME)
}

/** `~/.claude.json` — `machineID` ve `oauthAccount` burada durur. */
export function claudeConfigFile(env: PathEnv = nodePathEnv()): string {
  return joinerFor(env.platform)(env.homeDir, CLAUDE_CONFIG_FILE_NAME)
}

// ── Hesap basina yollar ──────────────────────────────────────────────────────

/** Bir hesabin Claude Code dosyalari. */
export interface AccountPaths {
  /** Claude Code ayar klasoru. */
  configDir: string
  /** Hesap kaydi: `oauthAccount`, `cachedUsageUtilization`. */
  accountFile: string
  /** Jeton dosyasi (Windows/Linux). macOS'ta jeton Anahtar Zinciri'nde durur. */
  credentialsFile: string
  /** Oturum kayitlari. */
  projectsDir: string
  /**
   * CLI bu hesap icin calistirilirken verilecek `CLAUDE_CONFIG_DIR`.
   * Varsayilan klasorde null: degisken hic verilmez.
   */
  cliConfigDir: string | null
}

/** Ayni klasor mu. Windows'ta buyuk/kucuk harf ve sondaki ayrac fark etmez. */
function samePath(a: string, b: string, platform: SupportedPlatform): boolean {
  const norm = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, '')
    return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed
  }
  return norm(a) === norm(b)
}

/**
 * Hesabin dosya yollari.
 *
 * Kisisel hesap ortamdaki `CLAUDE_CONFIG_DIR`'i **okumaz**: widget bir Team
 * oturumundan baslatilmissa o degisken Team klasorunu gosterir ve kisisel
 * satir Team'in kotasini yazardi. Klasor yalniz ayardan (`override`) degisir.
 *
 * Hesap kaydinin yeri klasore baglidir: varsayilan klasorde `~/.claude.json`
 * (ev dizininde), `CLAUDE_CONFIG_DIR` verildiginde klasorun icinde
 * `.claude.json` (olculdu 2026-11-06, Claude Code 2.1.177).
 */
export function accountPaths(
  key: AccountKey,
  override: string | null = null,
  env: PathEnv = nodePathEnv()
): AccountPaths {
  const join = joinerFor(env.platform)
  const defaultDir = claudeHomeDir(env)
  const dir = override ?? (key === 'personal' ? defaultDir : join(env.homeDir, TEAM_CLAUDE_DIR_NAME))
  const isDefault = samePath(dir, defaultDir, env.platform)
  return {
    configDir: dir,
    accountFile: isDefault ? claudeConfigFile(env) : join(dir, CLAUDE_CONFIG_FILE_NAME),
    credentialsFile: join(dir, CREDENTIALS_FILE_NAME),
    projectsDir: join(dir, 'projects'),
    cliConfigDir: isDefault ? null : dir
  }
}

// ── Uygulamanin kendi veri dizini ────────────────────────────────────────────

/**
 * Tarihce ve konfigin yazildigi dizin.
 *
 * - Windows: `%APPDATA%\<base>`, degisken yoksa `<ev>\AppData\Roaming\<base>`
 * - macOS: `<ev>/Library/Application Support/<base>`
 * - Linux: `$XDG_CONFIG_HOME/<base>`, yoksa `<ev>/.config/<base>`
 */
export function appDataDir(base: string = APP_DIR_NAME, env: PathEnv = nodePathEnv()): string {
  const join = joinerFor(env.platform)

  if (env.platform === 'win32') {
    const appData = readEnv(env, 'APPDATA')
    const root = appData ?? join(env.homeDir, 'AppData', 'Roaming')
    return join(root, base)
  }

  if (env.platform === 'darwin') {
    return join(env.homeDir, 'Library', 'Application Support', base)
  }

  // XDG sartnamesi: goreli bir deger gecersizdir ve yok sayilir.
  const xdg = readEnv(env, 'XDG_CONFIG_HOME')
  const root = xdg !== null && posix.isAbsolute(xdg) ? xdg : join(env.homeDir, '.config')
  return join(root, base)
}

/** Konfig dosyasinin tam yolu. */
export function appConfigFile(base: string = APP_DIR_NAME, env: PathEnv = nodePathEnv()): string {
  return joinerFor(env.platform)(appDataDir(base, env), CONFIG_FILE_NAME)
}

// ── ~/.claude.json okuma ─────────────────────────────────────────────────────

/**
 * Dosya okuma. Testte sahte uygulama verilir; uretimde `nodePathFs`.
 */
export interface PathFs {
  readFile(file: string): Promise<string>
}

export const nodePathFs: PathFs = {
  async readFile(file: string): Promise<string> {
    return await readFile(file, 'utf8')
  }
}

/**
 * `~/.claude.json` icinden alinan tek sey.
 *
 * Dosya oturum belirteci de tasir; bu modul belirtec alanlarini ne okur, ne
 * dondurur, ne de bellekte tutar (security.md).
 */
export interface ClaudeIdentity {
  machineId: string | null
  email: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Kimlik alanlarini okur. Dosya yoksa, okunamiyorsa veya bozuksa istisna
 * firlatmaz — alanlar `null` doner. Cagiran taraf "cihaz bilinmiyor" durumunu
 * zaten desteklemek zorunda (`DeviceHeartbeat.machineId`).
 */
export async function readClaudeIdentity(
  fs: PathFs = nodePathFs,
  file: string = claudeConfigFile()
): Promise<ClaudeIdentity> {
  let text: string
  try {
    text = await fs.readFile(file)
  } catch {
    return { machineId: null, email: null }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { machineId: null, email: null }
  }
  if (!isPlainObject(parsed)) return { machineId: null, email: null }

  // Yalnizca bu iki alan alinir; `parsed` bundan sonra kullanilmaz.
  const account = parsed['oauthAccount']
  return {
    machineId: stringOrNull(parsed['machineID']),
    email: isPlainObject(account) ? stringOrNull(account['emailAddress']) : null
  }
}

/** `~/.claude.json` icindeki `machineID`; yoksa null. */
export async function readMachineId(
  fs: PathFs = nodePathFs,
  file: string = claudeConfigFile()
): Promise<string | null> {
  return (await readClaudeIdentity(fs, file)).machineId
}
