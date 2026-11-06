/**
 * Merkez: cihazlarin token sepetlerini ve kota orneklerini birlestirir, paneli sunar.
 *
 * Ortam degiskenleri (hepsinin varsayilani var):
 *   HUB_DATA            veri klasoru (SQLite)                       /data
 *   HUB_PUBLIC_PORT     disariya acilan dinleyici (tunel/vekil)      8080
 *   HUB_HOME_PORT       ev agi dinleyicisi (panel, kayit)            8081
 *   HUB_PANEL_DIR       derlenmis panel sayfasi                      /app/panel
 *   HUB_LOCAL_CLAUDE    bu makinenin Claude klasoru (salt okunur)    /claude
 *   HUB_LOCAL_ACCOUNT   bu makinenin .claude.json dosyasi            /claude.json
 *   HUB_LOCAL_NAME      panelde gorunecek ad                         Ev sunucusu
 */

import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { HubDb } from './db'
import { createHandler } from './handlers'
import { startLocalCollector } from './local-collector'

const env = (name: string, fallback: string): string => process.env[name] ?? fallback

const dataDir = env('HUB_DATA', '/data')
const panelDir = env('HUB_PANEL_DIR', '/app/panel')
const db = new HubDb(join(dataDir, 'hub.db'))

const listeners = [
  { role: 'public' as const, port: Number(env('HUB_PUBLIC_PORT', '8080')) },
  { role: 'home' as const, port: Number(env('HUB_HOME_PORT', '8081')) }
]
for (const l of listeners) {
  createServer(createHandler({ role: l.role, db, panelDir: existsSync(panelDir) ? panelDir : null })).listen(l.port, () => {
    console.log(`[hub] ${l.role} dinleyici :${l.port}`)
  })
}

const localClaude = env('HUB_LOCAL_CLAUDE', '/claude')
if (existsSync(join(localClaude, 'projects'))) {
  startLocalCollector({
    hub: db,
    projectsDir: join(localClaude, 'projects'),
    accountFile: env('HUB_LOCAL_ACCOUNT', '/claude.json'),
    storeFile: join(dataDir, 'local.db'),
    deviceName: env('HUB_LOCAL_NAME', 'Ev sunucusu')
  })
} else {
  console.log('[hub] yerel Claude klasoru yok, sunucu toplayicisi calismiyor')
}

const shutdown = (): void => {
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
