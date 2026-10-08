#!/usr/bin/env node
/**
 * Claude Code oturumunu tazeler.
 *
 * Erisim jetonu 8 saatte bir doluyor. Dolmus jeton "oturum kapali" gibi
 * gorunur ama genelde degildir: `refreshToken` yerinde duruyorsa CLI'i bir kez
 * calistirmak jetonu yeniler. Tam `auth login` yalnizca refresh token da
 * gecersizse gerekir.
 *
 * `claude -p "/usage"` secildi: slash komutu oldugu icin model cagrisi yapmaz
 * (sifir token), ama kimlik dogrulamasi gereken bir istek attigi icin CLI'i
 * jetonu tazelemeye zorlar. Olculdu: dolmus jeton 4,7 sn'de yenilenir.
 *
 * `claude auth status` BU ISE YARAMAZ — aga hic gitmez, yalnizca dosyadaki
 * kaydi okuyup `loggedIn: true` basar; jeton dolmus olsa bile tazelemez.
 *
 * Jetonu BIZ uretmiyoruz: refresh token tek kullanimlik olabilir, tuketip
 * yenisini geri yazmazsak kullanicinin CLI oturumu duser. Yazma isi CLI'da.
 * Bu script `~/.claude/` altina yazmaz, yalnizca okur.
 *
 * Cikis kodlari: 0 = jeton gecerli · 1 = elle `claude auth login` gerekiyor
 *                2 = CLI bulunamadi
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const REFRESH_TIMEOUT_MS = 90_000

/** Surum klasorlerini yeniden eskiye siralar ("2.1.286" > "2.1.9"). */
function sortVersionsDesc(names) {
  const parse = (n) => n.split('.').map((p) => Number.parseInt(p, 10) || 0)
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

function listDir(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * `claude` calistirilabilirini arar.
 *
 * PATH genelde Windows'ta `claude.cmd` / `claude.ps1` shim'ini gosterir ve
 * `execFile(shell:false)` bir `.cmd`'yi calistiramaz (EINVAL). Bu yuzden hep
 * gercek `.exe` aranir. Iki kurulum bicimi var ve ikisi de goz onunde
 * tutulmali:
 *
 *   npm global : %APPDATA%/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *   native     : %APPDATA%/Claude/claude-code/<surum>/<hash>/claude.exe
 *
 * Native yolda surumun ALTINDA bir hash klasoru daha vardir; o seviye
 * atlanirsa hicbir sey bulunamaz.
 */
export function findClaudeBinary(
  platform = process.platform,
  env = process.env,
  fs = { exists: existsSync, listDir }
) {
  // Yol ayraci hedef platformdan gelir, calisilan makineden degil.
  const { join } = platform === 'win32' ? win32 : posix
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir()

  if (platform === 'win32') {
    const roaming = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')

    const npmExe = join(
      roaming,
      'npm',
      'node_modules',
      '@anthropic-ai',
      'claude-code',
      'bin',
      'claude.exe'
    )
    if (fs.exists(npmExe)) return npmExe

    const base = join(roaming, 'Claude', 'claude-code')
    for (const version of sortVersionsDesc(fs.listDir(base))) {
      const versionDir = join(base, version)
      // Once dogrudan, sonra hash alt klasorleri: kurulum bicimi surumle degisti.
      const direct = join(versionDir, 'claude.exe')
      if (fs.exists(direct)) return direct
      for (const hash of fs.listDir(versionDir)) {
        const nested = join(versionDir, hash, 'claude.exe')
        if (fs.exists(nested)) return nested
      }
    }
    return null
  }

  const candidates = [
    join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude')
  ]
  return candidates.find((p) => fs.exists(p)) ?? null
}

/** Jetonun bitis anini okur. Jetonun KENDISI hic okunmaz. */
function readExpiry() {
  const file = win32.join(homedir(), '.claude', '.credentials.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const oauth = parsed?.claudeAiOauth
    if (typeof oauth?.expiresAt !== 'number') return null
    return {
      expiresAt: oauth.expiresAt,
      hasRefresh: typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0
    }
  } catch {
    return null
  }
}

function runRefresh(bin) {
  return new Promise((resolve) => {
    // Kabuk YOK: arguman dizisi dogrudan gecer, yol cevrimi olmaz.
    execFile(
      bin,
      ['-p', '/usage', '--output-format', 'json'],
      { timeout: REFRESH_TIMEOUT_MS, windowsHide: true, shell: false },
      (error) => resolve(error === null)
    )
  })
}

const dk = (ms) => Math.round(ms / 60_000)

async function main() {
  const before = readExpiry()
  if (before === null) {
    console.log('credentials okunamadi — hic giris yapilmamis olabilir.')
    console.log('Yap: claude auth login')
    return 1
  }

  const remaining = before.expiresAt - Date.now()
  if (remaining > 0) {
    console.log(`jeton gecerli — ${dk(remaining)} dk kaldi, yapilacak bir sey yok.`)
    return 0
  }
  console.log(`jeton DOLMUS — ${dk(-remaining)} dk once.`)

  if (!before.hasRefresh) {
    console.log('refresh token yok, kendiliginden tazelenemez.')
    console.log('Yap: claude auth login')
    return 1
  }

  const bin = findClaudeBinary()
  if (bin === null) {
    console.log('claude calistirilabiliri bulunamadi (PATH shim\'i sayilmaz, gercek .exe gerekir).')
    console.log('Yap: claude auth login')
    return 2
  }
  console.log(`CLI: ${bin}`)
  console.log('tazeleme deneniyor (claude -p /usage — model cagrisi yok)...')

  const ok = await runRefresh(bin)
  const after = readExpiry()
  const left = after === null ? -1 : after.expiresAt - Date.now()

  if (left > 0) {
    console.log(`TAZELENDI — jeton ${dk(left)} dk gecerli.`)
    return 0
  }

  console.log(`tazeleme yetmedi (CLI ${ok ? 'kostu' : 'hata verdi'}).`)
  console.log('Yap: claude auth login')
  return 1
}

// Yalniz dogrudan calistirildiginda kosar: `findClaudeBinary` baska yerden
// import edilebilsin diye, iceri alinmak yan etki uretmemeli.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = await main()
