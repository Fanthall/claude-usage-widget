/**
 * Merkezin kendi makinesindeki Claude kayitlari: widget'taki toplayicinin aynisi,
 * ama sepetler HTTP yerine dogrudan merkezin deposuna yazilir. Sunucuda Claude
 * az kullaniliyor (13 dosya, 17 MB olculdu); ayri bir gorev gerekmez.
 */

import { readFile } from 'node:fs/promises'

import { scanOnce } from '../../src/collector/scan'
import { UsageStore } from '../../src/collector/store'
import type { HubDb } from './db'

export const LOCAL_DEVICE_ID = 'local-server'
const INTERVAL_MS = 60_000

export interface LocalCollectorOptions {
  hub: HubDb
  projectsDir: string
  accountFile: string
  storeFile: string
  deviceName: string
}

async function readOrg(file: string): Promise<string | null> {
  try {
    const root = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')) as Record<string, unknown>
    const account = root['oauthAccount'] as Record<string, unknown> | undefined
    const org = account?.['organizationUuid']
    return typeof org === 'string' && org.length > 0 ? org : null
  } catch {
    return null
  }
}

export function startLocalCollector(options: LocalCollectorOptions): void {
  const store = new UsageStore(options.storeFile)
  options.hub.ensureLocalDevice(LOCAL_DEVICE_ID, options.deviceName, Date.now())
  let first = true

  const tick = async (): Promise<void> => {
    try {
      const org = await readOrg(options.accountFile)
      if (org !== null) {
        store.setOrgAccounts([{ orgId: org, account: 'personal' }])
        store.mapOtherOrgs(org, 'team')
      }
      await scanOnce(store, [{ account: 'personal', projectsDir: options.projectsDir }], undefined, first)
      first = false
      for (;;) {
        const pending = store.pendingBuckets()
        if (pending.buckets.length === 0) break
        options.hub.writeBuckets(LOCAL_DEVICE_ID, pending.buckets, pending.epoch)
        store.markSynced(pending.minutes, pending.maxSeq)
      }
      options.hub.touch(LOCAL_DEVICE_ID, Date.now(), { queue: 0, scanPct: 100 })
    } catch (error: unknown) {
      console.error('[hub] sunucu toplayicisi hatasi:', error instanceof Error ? error.message : error)
    } finally {
      setTimeout(() => void tick(), INTERVAL_MS)
    }
  }
  void tick()
}
