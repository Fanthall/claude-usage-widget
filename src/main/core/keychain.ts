/**
 * macOS: Claude Code oturum jetonu Anahtar Zinciri'ndedir; `.credentials.json`
 * yoktur (F0 Mac denetimi, 2026-11-06). Kaydin icerigi Windows dosyasiyla ayni
 * JSON'dur (`claudeAiOauth.accessToken`, `expiresAt`, ...).
 *
 * Okuma uygulamanin kendisiyle degil Apple imzali `/usr/bin/security` ile
 * yapilir: imzasiz uygulamanin kimligi her surumde degisir, Anahtar Zinciri
 * izni uygulamaya verilseydi her guncellemede yeniden sorulurdu. Izin
 * `security` aracina bir kez "Her zaman izin ver" ile verilir.
 *
 * Jeton hicbir yere yazilmaz, loglanmaz; yalniz cagiranin istek basligina gider.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

import { safeLog } from './log-safe'

export const SECURITY_BIN = '/usr/bin/security'
/** Varsayilan ayar klasorunun kayit adi (olculdu, Mac denetimi). */
export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials'

export type SecurityRun = (args: readonly string[]) => Promise<string>

const nodeSecurityRun: SecurityRun = (args) =>
  new Promise((resolve, reject) => {
    execFile(SECURITY_BIN, [...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })

/**
 * `CLAUDE_CONFIG_DIR` ile acilan klasorun kayit adi icin aday: klasor yolunun
 * SHA-256 ozetinin ilk 8 karakteri ekli. Claude Code'un kullandigi ad Mac'te
 * dogrulanacak; tutmazsa `discoverOtherServices` devreye girer.
 */
export function derivedServiceName(configDir: string): string {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${DEFAULT_KEYCHAIN_SERVICE}-${hash}`
}

/** `security dump-keychain` ciktisindan Claude Code kayit adlari (yalniz adlar). */
export function parseServiceNames(dump: string): string[] {
  const names = new Set<string>()
  for (const match of dump.matchAll(/"svce"<blob>="(Claude Code[^"]*-credentials[^"]*)"/g)) {
    if (match[1] !== undefined) names.add(match[1])
  }
  return [...names]
}

/** Kayit icerigindeki jeton; suresi dolmussa null (dosya okuyucusuyla ayni kural). */
export function tokenFromSecret(secret: string, now: number): string | null {
  let root: unknown
  try {
    root = JSON.parse(secret.trim())
  } catch {
    return null
  }
  if (typeof root !== 'object' || root === null) return null
  const oauth = (root as Record<string, unknown>)['claudeAiOauth']
  if (typeof oauth !== 'object' || oauth === null) return null
  const token = (oauth as Record<string, unknown>)['accessToken']
  if (typeof token !== 'string' || token.length === 0) return null
  const expiresAt = (oauth as Record<string, unknown>)['expiresAt']
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now) return null
  return token
}

export interface KeychainDeps {
  run?: SecurityRun
  now?: () => number
}

async function readSecret(run: SecurityRun, service: string): Promise<string | null> {
  try {
    return await run(['find-generic-password', '-s', service, '-w'])
  } catch {
    return null
  }
}

/**
 * Hesabin jetonunu okur.
 *
 * @param cliConfigDir hesabin `CLAUDE_CONFIG_DIR` degeri; varsayilan klasorde null
 */
export function createKeychainTokenReader(
  cliConfigDir: string | null,
  deps: KeychainDeps = {}
): () => Promise<string | null> {
  const run = deps.run ?? nodeSecurityRun
  const now = deps.now ?? Date.now
  let resolvedService: string | null = cliConfigDir === null ? DEFAULT_KEYCHAIN_SERVICE : null

  async function findService(): Promise<string | null> {
    if (cliConfigDir === null) return DEFAULT_KEYCHAIN_SERVICE
    const derived = derivedServiceName(cliConfigDir)
    if ((await readSecret(run, derived)) !== null) return derived
    // Ad tutmadiysa: varsayilan disindaki TEK Claude kaydi bu hesabindir.
    let dump: string
    try {
      dump = await run(['dump-keychain'])
    } catch {
      return null
    }
    const others = parseServiceNames(dump).filter((n) => n !== DEFAULT_KEYCHAIN_SERVICE)
    if (others.length === 1) return others[0] ?? null
    if (others.length > 1) safeLog('warn', 'anahtar zincirinde birden cok Claude kaydi, hesap secilemedi', { count: others.length })
    return null
  }

  return async function readToken(): Promise<string | null> {
    if (resolvedService === null) resolvedService = await findService()
    if (resolvedService === null) return null
    const secret = await readSecret(run, resolvedService)
    if (secret === null) {
      // Kayit silinmis/yeniden adlandirilmis olabilir; bir sonraki turda yeniden aranir.
      if (cliConfigDir !== null) resolvedService = null
      return null
    }
    return tokenFromSecret(secret, now())
  }
}
