/**
 * Merkezin deposu (SQLite, `node:sqlite`).
 *
 * Cihazlar dakika sepetlerinin MUTLAK toplamini gonderir. Bir cihazin bir
 * dakikasi geldiginde o dakikanin eski satirlari silinip yenileri yazilir:
 * cihaz tarafinda bir oturum sonradan baska hesaba atanirsa (Team'in kurumu
 * gec ogrenildi) eski hesapta cift sayim kalmaz.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export interface BucketIn {
  minute: number
  account: string
  model: string
  project: string | null
  subagent: boolean
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  requests: number
  /** Dakikanin surumu (istemcide en buyuk seq). Yoksa eski istemci: surum korumasi yok. */
  version?: number
}

export interface QuotaSampleIn {
  account: string
  fetchedAt: number
  windows: Array<{ label: string; percent: number; resetsAtMs: number | null }>
}

export interface Device {
  id: string
  name: string
  os: string | null
  version: string | null
  lastSeen: number | null
  queue: number | null
  scanPct: number | null
}

export type GroupField = 'account' | 'device' | 'model' | 'project' | 'subagent'
export const GROUP_FIELDS: readonly GroupField[] = ['account', 'device', 'model', 'project', 'subagent']

const COLUMN: Record<GroupField, string> = {
  account: 'u.account',
  device: 'u.device_id',
  model: 'u.model',
  project: 'u.project',
  subagent: 'u.subagent'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, os TEXT, key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen INTEGER, version TEXT, queue INTEGER, scan_pct INTEGER
);
CREATE TABLE IF NOT EXISTS usage_minute (
  device_id TEXT NOT NULL, minute INTEGER NOT NULL, account TEXT NOT NULL, model TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '', subagent INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
  cw5m INTEGER NOT NULL, cw1h INTEGER NOT NULL, cache_read INTEGER NOT NULL, requests INTEGER NOT NULL,
  PRIMARY KEY (device_id, minute, account, model, project, subagent)
);
CREATE INDEX IF NOT EXISTS usage_minute_minute ON usage_minute(minute);
CREATE TABLE IF NOT EXISTS minute_version (
  device_id TEXT NOT NULL, minute INTEGER NOT NULL, epoch TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY (device_id, minute)
);
CREATE TABLE IF NOT EXISTS quota_sample (
  account TEXT NOT NULL, fetched_at INTEGER NOT NULL, label TEXT NOT NULL, percent INTEGER NOT NULL,
  resets_at INTEGER, device_id TEXT, PRIMARY KEY (account, fetched_at, label)
);
CREATE INDEX IF NOT EXISTS quota_sample_at ON quota_sample(fetched_at);
`

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export class HubDb {
  private readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** Yeni cihaz; anahtar yalniz bir kez dondurulur, depoda ozeti durur. */
  enroll(name: string, os: string | null, now: number): { deviceId: string; key: string } {
    const deviceId = randomUUID()
    const key = `cuw_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare('INSERT INTO devices (id, name, os, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(deviceId, name, os, hashKey(key), now)
    return { deviceId, key }
  }

  /** Merkezin kendi toplayicisi icin sabit kimlikli cihaz (anahtari kullanilamaz). */
  ensureLocalDevice(id: string, name: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, os, key_hash, created_at) VALUES (?, ?, 'server', ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      )
      .run(id, name, hashKey(randomBytes(32).toString('hex')), now)
  }

  deviceByKey(key: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE key_hash = ?').get(hashKey(key)) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? null : toDevice(row)
  }

  touch(deviceId: string, now: number, info: { version?: string; queue?: number; scanPct?: number } = {}): void {
    this.db
      .prepare(
        `UPDATE devices SET last_seen = ?, version = COALESCE(?, version), queue = COALESCE(?, queue),
           scan_pct = COALESCE(?, scan_pct) WHERE id = ?`
      )
      .run(now, info.version ?? null, info.queue ?? null, info.scanPct ?? null, deviceId)
  }

  devices(): Device[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Array<Record<string, unknown>>).map(toDevice)
  }

  /**
   * Cihazin dakikalarini yazar: gelen her dakikanin eski satirlari once silinir.
   *
   * Surum korumasi: ayni donemden (`epoch`) gelen bir dakika, merkezdeki
   * surumden yeni degilse yazilmaz. Istemcinin vazgectigi bir istek sunucuda
   * gec islenirse dakikanin YENI halini eskisiyle ezerdi (olculdu: e2e'de iki
   * oturumdan gelen 28 dakikada 21,5 M token kayboldu). Surumsuz (eski
   * istemci) sepetler her zaman yazilir. Donusu: yazilan sepet sayisi.
   */
  writeBuckets(deviceId: string, buckets: readonly BucketIn[], epoch: string | null = null): number {
    const byMinute = new Map<number, BucketIn[]>()
    for (const b of buckets) byMinute.set(b.minute, [...(byMinute.get(b.minute) ?? []), b])
    const del = this.db.prepare('DELETE FROM usage_minute WHERE device_id = ? AND minute = ?')
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO usage_minute (device_id, minute, account, model, project, subagent, input, output,
         cw5m, cw1h, cache_read, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const getVersion = this.db.prepare('SELECT epoch, version FROM minute_version WHERE device_id = ? AND minute = ?')
    const setVersion = this.db.prepare(
      `INSERT INTO minute_version (device_id, minute, epoch, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, minute) DO UPDATE SET epoch = excluded.epoch, version = excluded.version`
    )
    let written = 0
    this.db.exec('BEGIN')
    try {
      for (const [minute, list] of byMinute) {
        const version = Math.max(...list.map((b) => b.version ?? 0))
        if (epoch !== null && version > 0) {
          const cur = getVersion.get(deviceId, minute) as { epoch: string; version: number } | undefined
          if (cur !== undefined && cur.epoch === epoch && cur.version >= version) continue
          setVersion.run(deviceId, minute, epoch, version)
        }
        del.run(deviceId, minute)
        written += list.length
        for (const b of list) insertBucket(b)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return written

    function insertBucket(b: BucketIn): void {
      ins.run(
        deviceId,
        b.minute,
        b.account,
        b.model,
        b.project ?? '',
        b.subagent ? 1 : 0,
        b.input,
        b.output,
        b.cacheWrite5m,
        b.cacheWrite1h,
        b.cacheRead,
        b.requests
      )
    }
  }

  /** Kota ornekleri; ayni hesap + an + pencere bir kez saklanir (iki cihaz ayni ornegi gonderebilir). */
  writeQuota(deviceId: string, samples: readonly QuotaSampleIn[]): number {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO quota_sample (account, fetched_at, label, percent, resets_at, device_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    let n = 0
    this.db.exec('BEGIN')
    try {
      for (const s of samples) {
        for (const w of s.windows) {
          n += Number(ins.run(s.account, s.fetchedAt, w.label, Math.round(w.percent), w.resetsAtMs, deviceId).changes)
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return n
  }

  /** Dilimlenmis seri. `by` alanlarina gore gruplanir; dilim `stepMs` genisliginde. */
  usage(fromMs: number, toMs: number, stepMs: number, by: readonly GroupField[]): Array<Record<string, unknown>> {
    const groupCols = by.map((f) => `${COLUMN[f]} AS ${f}`)
    const sql = `SELECT CAST(((u.minute * 60000) - ?) / ? AS INTEGER) AS bucket, ${groupCols.length > 0 ? `${groupCols.join(', ')},` : ''}
        SUM(u.input + u.output + u.cw5m + u.cw1h + u.cache_read) AS total, SUM(u.output) AS output,
        SUM(u.input) AS input, SUM(u.cw5m + u.cw1h) AS cacheWrite, SUM(u.cache_read) AS cacheRead,
        SUM(u.requests) AS requests
      FROM usage_minute u WHERE u.minute >= ? AND u.minute < ?
      GROUP BY bucket${by.length > 0 ? `, ${by.map((f) => COLUMN[f]).join(', ')}` : ''} ORDER BY bucket`
    const rows = this.db
      .prepare(sql)
      .all(fromMs, stepMs, Math.floor(fromMs / 60000), Math.ceil(toMs / 60000)) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const { bucket, ...rest } = r
      const out: Record<string, unknown> = { atMs: fromMs + Number(bucket) * stepMs, ...rest }
      if ('project' in out && out['project'] === '') out['project'] = null
      if ('subagent' in out) out['subagent'] = out['subagent'] === 1
      return out
    })
  }

  /**
   * `mainOnly`: yalniz ana pencereler (5 saatlik + tum modellerin haftasi). Uzun aralikta cizgi icin;
   * model haftalari gereksiz yuk. Hesapta 5 saatlik pencere olmayabilir (olculdu: 2026-10-31'den beri yok).
   */
  quota(fromMs: number, toMs: number, mainOnly = false): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT account, fetched_at AS fetchedAt, label, percent, resets_at AS resetsAtMs
         FROM quota_sample WHERE fetched_at >= ? AND fetched_at < ?${mainOnly ? " AND (label LIKE '%session%' OR (label LIKE '%week%' AND label LIKE '%all%'))" : ''}
         ORDER BY fetched_at`
      )
      .all(fromMs, toMs) as Array<Record<string, unknown>>
  }
}

function toDevice(row: Record<string, unknown>): Device {
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    id: String(row['id']),
    name: String(row['name']),
    os: str(row['os']),
    version: str(row['version']),
    lastSeen: num(row['last_seen']),
    queue: num(row['queue']),
    scanPct: num(row['scan_pct'])
  }
}
