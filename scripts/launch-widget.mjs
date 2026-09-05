#!/usr/bin/env node
/**
 * Widget'i baslatir. Claude Code'un `SessionStart` hook'undan cagrilir.
 *
 * Iki sert kural:
 *  1. **Bloklamaz.** Hook donene kadar Claude Code bekler; bu yuzden surec
 *     ayrik (detached) baslatilir ve script hemen cikar.
 *  2. **Sessizce basarisiz olur.** Widget kurulu degilse veya baslatilamazsa
 *     Claude Code oturumu bundan etkilenmemeli — cikis kodu her zaman 0.
 *
 * Ikinci kez calistirmak zararsiz: uygulamada tek-ornek kilidi var, ikinci
 * baslatma yalnizca mevcut widget'i one getirir. Yani her yeni Claude Code
 * oturumu widget'i gorunur kilar.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')

/** Paketlenmis uygulamanin platform basina bilinen yerleri. */
function packagedCandidates() {
  const p = platform()
  if (p === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    // Kurulu surum once denenir; `dist/` yalnizca gelistirme yedegi.
    // Klasor adi electron-builder'in `productName` degeri (bosluklu).
    return [
      join(local, 'Programs', 'Claude Usage Widget', 'Claude Usage Widget.exe'),
      join(PROJECT, 'dist', 'win-unpacked', 'Claude Usage Widget.exe')
    ]
  }
  if (p === 'darwin') {
    return [
      join(PROJECT, 'dist', 'mac', 'Claude Usage Widget.app'),
      '/Applications/Claude Usage Widget.app',
      join(homedir(), 'Applications', 'Claude Usage Widget.app')
    ]
  }
  return [
    join(PROJECT, 'dist', 'Claude Usage Widget.AppImage'),
    join(homedir(), '.local', 'bin', 'claude-usage-widget.AppImage'),
    '/usr/local/bin/claude-usage-widget'
  ]
}

function firstExisting(paths) {
  for (const p of paths) if (existsSync(p)) return p
  return null
}

function launch(target) {
  const p = platform()
  // macOS'ta .app bir dizindir; `open` ile acilir.
  const [cmd, args] =
    p === 'darwin' && target.endsWith('.app') ? ['open', ['-g', '-a', target]] : [target, []]

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    // Yutulur: hook Claude Code oturumunu bozmamali.
  })
  child.unref()
}

const target = firstExisting(packagedCandidates())
if (target !== null) {
  try {
    launch(target)
  } catch {
    // Sessiz: bkz. kural 2.
  }
}

// Kurulu degilse hicbir sey yapilmaz ve hata da verilmez; hook no-op olur.
process.exit(0)
