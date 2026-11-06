/**
 * Token deposu (SQLite, `node:sqlite`).
 *
 * Mesaj basina bir satir tutulur; dakika ve aralik toplamlari sorguda
 * hesaplanir. Boylece tekillestirme dogal olur (anahtar birincil anahtar) ve
 * gec gelen kopya satir yalnizca kendi mesajini gunceller.
 *
 * Hesap sorguda cozulur: oturumun kurumu (`sessions`) biliniyor ve o kurum bir
 * hesaba eslenmisse (`orgs`) o hesap; degilse kaydin bulundugu klasorun hesabi
 * (`source`). Kurum bilgisi oturumun ortasinda gelse de sonuc dogru kalir.
 */

import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

import type { AccountKey, AccountTokens } from '../shared/types'
import type { MessageRecord } from './types'

export interface FileState {
  path: string
  account: AccountKey
  size: number
  mtimeMs: number
  offset: number
  badLines: number
}

/** Merkeze giden dakika sepeti; degerler o dakikanin MUTLAK toplamidir. */
export interface MinuteBucket {
  minute: number
  account: AccountKey
  model: string
  project: string | null
  subagent: boolean
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  requests: number
  /** Dakikanin surumu: o dakikadaki satirlarin en buyuk `seq`i. Merkez daha eskisini yok sayar. */
  version: number
}

export type UsageGroup = 'account' | 'device' | 'model' | 'project' | 'subagent'

/** Merkezin `/v1/usage` satiri; panel ikisini ayirt etmez. */
export interface UsageRow {
  atMs: number
  account?: AccountKey
  device?: string
  model?: string
  project?: string | null
  subagent?: boolean
  total: number
  output: number
  input: number
  cacheWrite: number
  cacheRead: number
  requests: number
}

const GROUP_EXPR: Record<Exclude<UsageGroup, 'device'>, string> = {
  account: 'COALESCE(o.account, m.source)',
  model: 'm.model',
  project: 'm.project',
  subagent: 'm.subagent'
}

const MINUTE_MS = 60_000
const SPARK_STEP_MS = 5 * MINUTE_MS
const SPARK_POINTS = 36

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, account TEXT NOT NULL, size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL, offset INTEGER NOT NULL, bad_lines INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  key TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, minute INTEGER NOT NULL, source TEXT NOT NULL,
  session_id TEXT, model TEXT NOT NULL, project TEXT, subagent INTEGER NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cw5m INTEGER NOT NULL, cw1h INTEGER NOT NULL,
  cache_read INTEGER NOT NULL, seq INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_at ON messages(at_ms);
CREATE INDEX IF NOT EXISTS messages_unsynced ON messages(synced, minute);
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, org_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orgs (org_id TEXT PRIMARY KEY, account TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/**
 * Hesap cozumu: once oturumun kurumu, yoksa kaydin klasoru.
 * GROUP BY'da TAKMA ADLA (`account`) DEGIL bu ifadeyle gruplanir: SQLite takma adi
 * ayni adli SUTUNA (`orgs.account`) cozer. Kurumu bilinen ve bilinmeyen oturumlar
 * iki ayri "personal" grubu olur; merkez ikisini ayni anahtarda ezerdi (olculdu: 21,5 M).
 */
const ACCOUNT_EXPR = 'COALESCE(o.account, m.source)'
const JOINS = 'LEFT JOIN sessions s ON s.session_id = m.session_id LEFT JOIN orgs o ON o.org_id = s.org_id'
const TOTAL_EXPR = '(m.input + m.output + m.cw5m + m.cw1h + m.cache_read)'
/**
 * Widget'in ana sayisi: onbellekten okuma HARIC. Her istek oturumun tum
 * baglamini onbellekten yeniden okur (olculdu: istek basina ~320 bin token,
 * 15 dakikanin %99'u); dahil edilince sayi "harcanan" gibi okunmuyor.
 */
const FRESH_EXPR = '(m.input + m.output + m.cw5m + m.cw1h)'

export class UsageStore {
  private readonly db: DatabaseSync
  private seq: number
  private readonly upsertStmt: StatementSync
  private readonly sessionStmt: StatementSync
  private readonly sessionOrgStmt: StatementSync
  /** Bu veritabaninin kimligi; merkez dakika surumlerini donem icinde karsilastirir. */
  readonly epoch: string

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA)
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages').get() as { s: number }
    this.seq = row.s
    // Ayni mesajin sonraki satiri degerleri gunceller; cikti yalniz buyur (F0: son
    // satir hep en buyuk). Kaynak klasor ilk gorulen kalir.
    this.upsertStmt = this.db.prepare(`
      INSERT INTO messages (key, at_ms, minute, source, session_id, model, project, subagent,
        input, output, cw5m, cw1h, cache_read, seq, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(key) DO UPDATE SET
        input = excluded.input, output = MAX(messages.output, excluded.output),
        cw5m = excluded.cw5m, cw1h = excluded.cw1h, cache_read = excluded.cache_read,
        seq = excluded.seq, synced = 0
      WHERE messages.output <> MAX(messages.output, excluded.output)
         OR messages.input <> excluded.input OR messages.cw5m <> excluded.cw5m
         OR messages.cw1h <> excluded.cw1h OR messages.cache_read <> excluded.cache_read`)
    this.sessionStmt = this.db.prepare(
      'INSERT INTO sessions (session_id, org_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET org_id = excluded.org_id'
    )
    this.sessionOrgStmt = this.db.prepare('SELECT org_id FROM sessions WHERE session_id = ?')
    // Donem: bu veritabaninin kimligi. Dosya silinip yeniden kurulursa seq sifirdan
    // baslar; merkez donemi farkli gorunce eski surumlerle karsilastirmaz.
    const epoch = this.db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | undefined
    if (epoch === undefined) {
      this.epoch = randomUUID()
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(this.epoch)
    } else {
      this.epoch = epoch.value
    }
    this.resyncOnce()
  }

  /**
   * Eski surumun gonderdigi dakikalar bir kez yeniden gonderilir. 0.3.0 oncesi
   * gruplama hatasi (bkz. ACCOUNT_EXPR) merkezde dakikalarin bir kismini ezmisti;
   * tum satirlar bekleyene doner ve surumleri yukseltilir, merkez kabul eder.
   * Yeni veritabaninda satir yok, maliyeti yok.
   */
  private resyncOnce(): void {
    const RESYNC_GENERATION = '1'
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'resync'").get() as { value: string } | undefined
    if (row?.value === RESYNC_GENERATION) return
    this.seq += 1
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE messages SET synced = 0, seq = ?').run(this.seq)
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('resync', ?)").run(RESYNC_GENERATION)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  getFile(path: string): FileState | null {
    const row = this.db
      .prepare('SELECT path, account, size, mtime_ms, offset, bad_lines FROM files WHERE path = ?')
      .get(path) as
      | { path: string; account: AccountKey; size: number; mtime_ms: number; offset: number; bad_lines: number }
      | undefined
    if (row === undefined) return null
    return {
      path: row.path,
      account: row.account,
      size: row.size,
      mtimeMs: row.mtime_ms,
      offset: row.offset,
      badLines: row.bad_lines
    }
  }

  saveFile(state: FileState): void {
    this.db
      .prepare(
        `INSERT INTO files (path, account, size, mtime_ms, offset, bad_lines) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET account = excluded.account, size = excluded.size,
           mtime_ms = excluded.mtime_ms, offset = excluded.offset, bad_lines = excluded.bad_lines`
      )
      .run(state.path, state.account, state.size, state.mtimeMs, state.offset, state.badLines)
  }

  totalBadLines(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(bad_lines), 0) AS n FROM files').get() as { n: number }
    return row.n
  }

  /** Mesajlari ve oturum kurumlarini tek islemde yazar. */
  write(source: AccountKey, records: readonly MessageRecord[], orgs: ReadonlyArray<[string, string]>): void {
    if (records.length === 0 && orgs.length === 0) return
    this.db.exec('BEGIN')
    try {
      for (const r of records) {
        this.seq += 1
        const t = r.tokens
        this.upsertStmt.run(
          r.key,
          r.atMs,
          Math.floor(r.atMs / MINUTE_MS),
          source,
          r.sessionId,
          r.model,
          r.project,
          r.subagent ? 1 : 0,
          t.input,
          t.output,
          t.cacheWrite5m,
          t.cacheWrite1h,
          t.cacheRead,
          this.seq
        )
      }
      // Oturumun kurumu sonradan ogrenilirse (kurum satiri dosyada gec gelir) daha
      // once gonderilmis satirlarin hesabi degisebilir: yeniden gonderilir.
      const changed = orgs.filter(([sessionId, orgId]) => this.sessionOrgStmt.get(sessionId)?.['org_id'] !== orgId)
      for (const [sessionId, orgId] of orgs) this.sessionStmt.run(sessionId, orgId)
      this.resyncSessions(changed.map(([sessionId]) => sessionId))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Oturum basina kurumdan gelen hesap (eslesmemisse null). */
  private sessionAccounts(): Map<string, string | null> {
    const rows = this.db
      .prepare('SELECT s.session_id AS s, o.account AS a FROM sessions s LEFT JOIN orgs o ON o.org_id = s.org_id')
      .all() as Array<{ s: string; a: string | null }>
    return new Map(rows.map((r) => [r.s, r.a ?? null]))
  }

  /**
   * Hesap atamasi degisen oturumlarin satirlari yeniden gonderilir. Merkez
   * dakikayi hesap ayrimiyla saklar; eski atamayla gitmis satir orada yanlis
   * hesapta kalirdi. Yeni `seq` dakikanin surumunu yukseltir, merkez kabul eder.
   */
  private resyncSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return
    this.seq += 1
    const stmt = this.db.prepare('UPDATE messages SET synced = 0, seq = ? WHERE session_id = ?')
    for (const id of sessionIds) stmt.run(this.seq, id)
  }

  private resyncChangedAccounts(change: () => void): void {
    const before = this.sessionAccounts()
    change()
    const changed: string[] = []
    for (const [session, account] of this.sessionAccounts()) {
      if ((before.get(session) ?? null) !== account) changed.push(session)
    }
    this.resyncSessions(changed)
  }

  /** Kurum → hesap eslemesi; hesaplarin `.claude.json` dosyalarindan gelir. */
  setOrgAccounts(pairs: ReadonlyArray<{ orgId: string; account: AccountKey }>): void {
    this.db.exec('BEGIN')
    try {
      this.resyncChangedAccounts(() => {
        this.db.exec('DELETE FROM orgs')
        const stmt = this.db.prepare('INSERT OR REPLACE INTO orgs (org_id, account) VALUES (?, ?)')
        for (const p of pairs) stmt.run(p.orgId, p.account)
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Eslenmemis kurumlari `other` hesabina baglar (`known` disindakiler).
   *
   * Team yalniz Desktop uygulamasinda kullaniliyorsa Team'in kurum kimligini
   * okuyacak bir `.claude.json` olmaz; kayitlarda ise kurum kimligi gorunur.
   * Iki hesap izlendigi icin kisisel kurum disindaki her kurum Team'dir.
   */
  mapOtherOrgs(known: string, other: AccountKey): void {
    this.resyncChangedAccounts(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO orgs (org_id, account)
           SELECT DISTINCT org_id, ? FROM sessions WHERE org_id <> ? AND org_id NOT IN (SELECT org_id FROM orgs)`
        )
        .run(other, known)
    })
  }

  /** Widget ozeti: son 15 dk, bugun ve son 3 saatin 5 dakikalik dilimleri. */
  summary(keys: readonly AccountKey[], nowMs: number, dayStartMs: number): AccountTokens[] {
    const since15 = nowMs - 15 * MINUTE_MS
    const sparkStart = nowMs - SPARK_POINTS * SPARK_STEP_MS
    const from = Math.min(since15, dayStartMs, sparkStart)
    const totals = this.db
      .prepare(
        `SELECT ${ACCOUNT_EXPR} AS account,
           SUM(CASE WHEN m.at_ms >= ? THEN ${FRESH_EXPR} ELSE 0 END) AS last15,
           SUM(CASE WHEN m.at_ms >= ? THEN ${FRESH_EXPR} ELSE 0 END) AS today,
           SUM(CASE WHEN m.at_ms >= ? THEN m.cache_read ELSE 0 END) AS cacheRead15
         FROM messages m ${JOINS} WHERE m.at_ms >= ? AND m.at_ms <= ? GROUP BY ${ACCOUNT_EXPR}`
      )
      .all(since15, dayStartMs, since15, from, nowMs) as Array<{ account: string; last15: number; today: number; cacheRead15: number }>
    const spark = this.db
      .prepare(
        `SELECT ${ACCOUNT_EXPR} AS account, CAST((m.at_ms - ?) / ? AS INTEGER) AS bucket, SUM(${FRESH_EXPR}) AS total
         FROM messages m ${JOINS} WHERE m.at_ms >= ? AND m.at_ms <= ? GROUP BY ${ACCOUNT_EXPR}, bucket`
      )
      .all(sparkStart, SPARK_STEP_MS, sparkStart, nowMs) as Array<{ account: string; bucket: number; total: number }>

    return keys.map((key) => {
      const row = totals.find((r) => r.account === key)
      const points = new Array<number>(SPARK_POINTS).fill(0)
      for (const s of spark) {
        const i = Math.floor(s.bucket)
        if (s.account === key && i >= 0 && i < SPARK_POINTS) points[i] = s.total
      }
      return { key, last15m: row?.last15 ?? 0, cacheRead15m: row?.cacheRead15 ?? 0, today: row?.today ?? 0, spark: points }
    })
  }

  /**
   * Panel satirlari, merkezin `/v1/usage` cevabiyla ayni bicimde. Merkez yokken
   * panel bu cihazin verisini buradan okur; `device` alani hep bu cihazdir.
   */
  usageRows(fromMs: number, toMs: number, stepMs: number, by: readonly UsageGroup[], deviceId: string): UsageRow[] {
    const cols = by.filter((f) => f !== 'device').map((f) => ({ field: f, expr: GROUP_EXPR[f] }))
    const select = cols.map((c) => `${c.expr} AS ${c.field}, `).join('')
    const group = cols.map((c) => `, ${c.expr}`).join('')
    const rows = this.db
      .prepare(
        `SELECT CAST((m.at_ms - ?) / ? AS INTEGER) AS bucket, ${select}
           SUM(${TOTAL_EXPR}) AS total, SUM(m.output) AS output, SUM(m.input) AS input,
           SUM(m.cw5m + m.cw1h) AS cacheWrite, SUM(m.cache_read) AS cacheRead, COUNT(*) AS requests
         FROM messages m ${JOINS} WHERE m.at_ms >= ? AND m.at_ms < ? GROUP BY bucket${group} ORDER BY bucket`
      )
      .all(fromMs, stepMs, fromMs, toMs) as Array<Record<string, unknown>>
    return rows.map((r) => {
      const { bucket, ...rest } = r
      const out: UsageRow = { atMs: fromMs + Math.floor(Number(bucket)) * stepMs, ...(rest as Omit<UsageRow, 'atMs'>) }
      if (by.includes('device')) out.device = deviceId
      if ('subagent' in out) out.subagent = (out.subagent as unknown) === 1
      return out
    })
  }

  /**
   * Merkeze gonderilmemis degisiklik iceren dakikalarin TAM toplamlari.
   * `maxSeq` donulur: gonderim basarili olunca yalniz o ana kadarki satirlar
   * isaretlenir; arada gelen yeni satir bir sonraki turda gider.
   */
  pendingBuckets(limitMinutes = 500): { buckets: MinuteBucket[]; minutes: number[]; maxSeq: number; epoch: string } {
    const minuteRows = this.db
      .prepare('SELECT DISTINCT minute FROM messages WHERE synced = 0 ORDER BY minute LIMIT ?')
      .all(limitMinutes) as Array<{ minute: number }>
    const minutes = minuteRows.map((r) => r.minute)
    if (minutes.length === 0) return { buckets: [], minutes: [], maxSeq: this.seq, epoch: this.epoch }
    const maxSeq = this.seq
    const placeholders = minutes.map(() => '?').join(',')
    const versions = new Map(
      (
        this.db
          .prepare(`SELECT minute, MAX(seq) AS v FROM messages WHERE minute IN (${placeholders}) GROUP BY minute`)
          .all(...minutes) as Array<{ minute: number; v: number }>
      ).map((r) => [r.minute, r.v])
    )
    const rows = this.db
      .prepare(
        `SELECT m.minute AS minute, ${ACCOUNT_EXPR} AS account, m.model AS model, m.project AS project,
           m.subagent AS subagent, SUM(m.input) AS input, SUM(m.output) AS output, SUM(m.cw5m) AS cw5m,
           SUM(m.cw1h) AS cw1h, SUM(m.cache_read) AS cache_read, COUNT(*) AS requests
         FROM messages m ${JOINS} WHERE m.minute IN (${placeholders})
         GROUP BY m.minute, ${ACCOUNT_EXPR}, m.model, m.project, m.subagent`
      )
      .all(...minutes) as Array<{
      minute: number
      account: AccountKey
      model: string
      project: string | null
      subagent: number
      input: number
      output: number
      cw5m: number
      cw1h: number
      cache_read: number
      requests: number
    }>
    return {
      minutes,
      maxSeq,
      epoch: this.epoch,
      buckets: rows.map((r) => ({
        minute: r.minute,
        account: r.account,
        model: r.model,
        project: r.project,
        subagent: r.subagent === 1,
        input: r.input,
        output: r.output,
        cacheWrite5m: r.cw5m,
        cacheWrite1h: r.cw1h,
        cacheRead: r.cache_read,
        requests: r.requests,
        version: versions.get(r.minute) ?? 0
      }))
    }
  }

  /** Merkeze gitmeyi bekleyen dakika sayisi (cihaz listesinde "kuyrukta N"). */
  pendingMinutes(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT minute) AS n FROM messages WHERE synced = 0').get() as { n: number }).n
  }

  markSynced(minutes: readonly number[], maxSeq: number): void {
    if (minutes.length === 0) return
    const placeholders = minutes.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE messages SET synced = 1 WHERE minute IN (${placeholders}) AND seq <= ?`)
      .run(...minutes, maxSeq)
  }
}
