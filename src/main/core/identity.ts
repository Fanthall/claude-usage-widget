/**
 * Hesap kimligi ve erisim jetonu — dosyadan.
 *
 * `claude` calistirilabilirine olan bagimlilik burada biter. Kesif yolu (PATH
 * taramasi) capraz platformda en kirilgan parcadir: macOS'ta Finder'dan acilan
 * uygulama minimal bir PATH devralir, `claude` bulunamaz ve widget yalnizca kota
 * degerini degil kimligi de kaybederdi. Hesap bilgisi zaten diskte duruyor.
 *
 * Iki dosya okunur, ikisi de YALNIZCA okunur (CONSTRAINT-7 — `~/.claude/` altina
 * yazilmaz):
 *   - `~/.claude.json > oauthAccount`      → kim giris yapmis
 *   - `~/.claude/.credentials.json > claudeAiOauth` → erisim jetonu
 *
 * Jeton kurali: `readAccessToken` jetonu **dogrudan** dondurur. Bir nesne alanina
 * konsaydi o nesne bir gun loglanabilir veya durum yayinina karisabilirdi; dizge
 * olarak dondurulen deger yalnizca cagiranin istek basligina gider. Bu modulun
 * urettigi hicbir log kaydi, hata mesaji veya donus alani jeton icermez — dosya
 * icerigi bozuk oldugunda bile icerik loglanmaz, yalnizca hangi dosyanin
 * cozulemedigi bildirilir.
 */

import { posix, win32 } from 'node:path'

import type { AuthStatus } from '../../shared/types'
import { safeLog } from './log-safe'
import {
  claudeConfigFile,
  claudeHomeDir,
  nodePathEnv,
  nodePathFs,
  type PathEnv,
  type PathFs
} from './paths'

/** CLI'in OAuth jetonunu tuttugu dosyanin adi (`~/.claude/` altinda). */
export const CREDENTIALS_FILE_NAME = '.credentials.json'

/** `~/.claude/.credentials.json` — jeton dosyasinin tam yolu. */
export function claudeCredentialsFile(env: PathEnv = nodePathEnv()): string {
  const join = env.platform === 'win32' ? win32.join : posix.join
  return join(claudeHomeDir(env), CREDENTIALS_FILE_NAME)
}

// ── Yardimcilar ──────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bos ve yalniz-bosluk dizgeler "alan yok" sayilir; uydurma deger uretilmez. */
function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** BOM ile baslayan dosya `JSON.parse`i patlatir; elle duzenlenmis dosyalarda gorulur. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Dosyanin hic olmamasi normal bir durumdur (giris yapilmamis), hata degildir. */
function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Oturum yokken dondurulen deger. Her cagride yeni nesne — paylasilan durum olmaz. */
function loggedOut(): AuthStatus {
  return { loggedIn: false, email: null, orgName: null, subscriptionType: null }
}

/**
 * Dosyayi okuyup ust duzey JSON nesnesini dondurur; her basarisizlikta `null`.
 *
 * Bozuk icerik LOGLANMAZ: bu dosyalarin ikisi de jeton tasiyabilir. Loga yalnizca
 * hangi dosyanin cozulemedigi gider — `safeLog` yolun icindeki ev dizinini de
 * maskeler.
 */
async function readJsonObject(fs: PathFs, file: string, what: string): Promise<JsonObject | null> {
  let text: string
  try {
    text = await fs.readFile(file)
  } catch (error: unknown) {
    if (!isMissingFile(error)) safeLog('warn', what + ' okunamadi', { file })
    return null
  }

  try {
    const parsed: unknown = JSON.parse(stripBom(text))
    if (isPlainObject(parsed)) return parsed
  } catch {
    // Ayristirma hatasinin mesaji dosya icerigi tasiyabilir; yutulur.
  }
  safeLog('warn', what + ' cozulemedi', { file })
  return null
}

// ── Hesap kimligi ────────────────────────────────────────────────────────────

/**
 * `~/.claude.json > oauthAccount` icindeki hesap bilgisini okur.
 *
 * `loggedIn` "diskte bir hesap kaydi var" demektir; jetonun hala gecerli oldugunu
 * SOYLEMEZ — onu `readAccessToken` ayrica denetler. Bulunamayan her alan `null`
 * kalir, tahmin edilmez.
 */
export async function readAccountIdentity(
  fs: PathFs = nodePathFs,
  file: string = claudeConfigFile()
): Promise<AuthStatus> {
  const root = await readJsonObject(fs, file, 'hesap dosyasi')
  if (root === null) return loggedOut()

  const account = root['oauthAccount']
  if (!isPlainObject(account)) return loggedOut()

  const email = stringOrNull(account['emailAddress'])
  const orgName = stringOrNull(account['organizationName'])
  // Alan adi CLI surumune gore degisir; ikisi de ayni seyi anlatir.
  const subscriptionType =
    stringOrNull(account['subscriptionType']) ?? stringOrNull(account['seatTier'])

  // Hesap kimligi gosterilecek bir alan tasimasa da oturumun varligini kanitlar.
  // Yalnizca varlik kaniti olarak kullanilir, dondurulmez: log-safe UUID'leri
  // gizli sayar ve gostergede isi yoktur.
  const hasAccountId = stringOrNull(account['accountUuid']) !== null

  if (email === null && orgName === null && subscriptionType === null && !hasAccountId) {
    return loggedOut()
  }
  return { loggedIn: true, email, orgName, subscriptionType }
}

// ── Erisim jetonu ────────────────────────────────────────────────────────────

/**
 * `~/.claude/.credentials.json > claudeAiOauth > accessToken` degerini dondurur.
 *
 * Suresi dolmus jeton `null` doner: uc onu 401 ile reddederdi, cagiran taraf bunu
 * zaten 'unauthorized' sayar; bos yere istek atmanin anlami yok. `expiresAt`
 * epoch ms'dir — sayi degilse yas bilinmiyor demektir ve jeton dondurulur, son
 * sozu uc soyler.
 *
 * Tum parametreleri opsiyoneldir; bu haliyle `usage-source`daki `TokenReader`
 * olarak dogrudan gecirilebilir.
 */
export async function readAccessToken(
  fs: PathFs = nodePathFs,
  file: string = claudeCredentialsFile(),
  now: () => number = Date.now
): Promise<string | null> {
  const root = await readJsonObject(fs, file, 'oturum dosyasi')
  if (root === null) return null

  const oauth = root['claudeAiOauth']
  if (!isPlainObject(oauth)) return null

  const token = stringOrNull(oauth['accessToken'])
  if (token === null) return null

  const expiresAt = oauth['expiresAt']
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now()) {
    safeLog('warn', 'oturum jetonunun suresi dolmus')
    return null
  }
  return token
}
