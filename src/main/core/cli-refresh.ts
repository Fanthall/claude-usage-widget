/**
 * Jeton tazeleme kurtarma yolu.
 *
 * Erisim jetonu 8 saatte bir doluyor (olculdu 2026-09-06). Onu yenileyebilecek
 * tek taraf, `refreshToken`'i sahiplenen CLI'dir. Refresh token muhtemelen
 * tek kullanimliktir: biz kullanip yenisini geri yazmazsak kullanicinin CLI
 * oturumu duser. Bu yuzden jetonu BIZ uretmiyoruz — CLI'i bir kez calistirip
 * kendi kurallariyla tazelemesini sagliyoruz, sonra dosyayi yeniden okuyoruz.
 *
 * `claude -p "/usage"` secildi: sifir token harcar (model cagrisi yapmaz) ama
 * kimlik dogrulamasi gerektiren bir istek attigi icin CLI'i jetonu tazelemeye
 * zorlar.
 *
 * Bu **kurtarma** yoludur, veri yolu degildir: kota verisi hala dogrudan uctan
 * gelir. CLI bulunamazsa kurtarma calismaz ve durum "oturum kapali" olarak
 * gosterilir — sessizce eski deger gosterilmez.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** CLI'i bir kez dururken bekleyecegimiz en uzun sure. */
export const REFRESH_TIMEOUT_MS = 45_000

/**
 * Iki durtme arasindaki en kisa sure. Her yoklamada surec baslatmak hem pahali
 * hem de sorunu cozmez: jeton tazelenmiyorsa tekrar denemek de tazelemez.
 */
export const REFRESH_COOLDOWN_MS = 10 * 60 * 1000

/** Surum klasorlerini yeniden eskiye siralar ("2.1.260" > "2.1.9"). */
export function sortVersionsDesc(names: readonly string[]): string[] {
  const parse = (n: string): number[] => n.split('.').map((p) => Number.parseInt(p, 10) || 0)
  return [...names].sort((a, b) => {
    const pa = parse(a)
    const pb = parse(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  })
}

export interface DiscoverFs {
  exists(path: string): boolean
  listDir(path: string): string[]
}

export const nodeDiscoverFs: DiscoverFs = {
  exists: (p) => existsSync(p),
  listDir: (p) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
}

/**
 * `claude` calistirilabilirini arar.
 *
 * Windows'ta PATH genelde `claude.cmd` / `claude.ps1` shim'i gosterir; Node 22'de
 * `execFile(shell:false)` ile `.cmd` calistirmak EINVAL verir. Bu yuzden once
 * gercek `.exe` aranir — kurulum surum klasorleri altindadir ve surum her
 * guncellemede degisir, en yenisi secilir.
 */
export function findClaudeBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  fs: DiscoverFs = nodeDiscoverFs
): string | null {
  // Yol ayraci **hedef platformdan** gelir, calisilan makineden degil. Aksi
  // halde Windows'ta macOS yolu ters egik cizgiyle kurulur ve hicbir zaman
  // eslesmez — uretimde gorulmez, testte yakalanmasi gereken bir tuzak.
  const { join } = platform === 'win32' ? win32 : posix
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir()

  if (platform === 'win32') {
    const roaming = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    const base = join(roaming, 'Claude', 'claude-code')
    for (const version of sortVersionsDesc(fs.listDir(base))) {
      const exe = join(base, version, 'claude.exe')
      if (fs.exists(exe)) return exe
    }
    return null
  }

  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude')
  ]
  return candidates.find((p) => fs.exists(p)) ?? null
}

export type RunFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean }
) => Promise<void>

const nodeRun: RunFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    // Kabuk YOK: "/usage" argumani kabukta dosya yoluna cevriliyor ve slash
    // komutu duz prompt olarak modele gidip token yakiyor.
    execFile(file, [...args], { ...options, shell: false }, (error) => {
      if (error !== null) reject(error)
      else resolve()
    })
  })

export interface RefreshDeps {
  findBinary?: () => string | null
  run?: RunFn
  now?: () => number
}

export type RefreshOutcome = 'refreshed' | 'no-cli' | 'failed' | 'cooling-down'

/**
 * CLI'i bir kez calistirarak jetonu tazelemesini saglar.
 *
 * Donus degeri "jeton kesin tazelendi" demez — yalnizca CLI'in kosup kosmadigini
 * soyler. Gercek karar cagiran tarafta: jetonu yeniden okuyup denemek.
 */
export function createCliRefresher(deps: RefreshDeps = {}): () => Promise<RefreshOutcome> {
  const find = deps.findBinary ?? (() => findClaudeBinary())
  const run = deps.run ?? nodeRun
  const now = deps.now ?? Date.now

  let lastAttemptMs: number | null = null

  return async function refresh(): Promise<RefreshOutcome> {
    if (lastAttemptMs !== null && now() - lastAttemptMs < REFRESH_COOLDOWN_MS) {
      return 'cooling-down'
    }
    const bin = find()
    if (bin === null) return 'no-cli'

    lastAttemptMs = now()
    try {
      await run(bin, ['-p', '/usage', '--output-format', 'json'], {
        timeout: REFRESH_TIMEOUT_MS,
        windowsHide: true
      })
      return 'refreshed'
    } catch {
      // Ayrinti onemli degil: tazelenmediyse cagiran taraf zaten 401 alacak.
      return 'failed'
    }
  }
}
