/**
 * Hesap klasorlerini tarar: yeni ya da buyumus kayit dosyalarinin yalniz yeni
 * satirlarini okuyup depoya yazar.
 *
 * Ilk turda tum gecmis okunur (bu PC'de 9,12 GB, ~82 sn olculdu); sonraki
 * turlarda boyutu degismeyen dosyaya dokunulmaz. Dosya kuculmusse (yeniden
 * yazilmis) bastan okunur.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { TokenScanProgress } from '../shared/types'
import { parseLine } from './parse'
import { readNewLines } from './read-lines'
import type { UsageStore } from './store'
import type { MessageRecord, ScanSource } from './types'

/** Bu kadar kayit birikince depoya yazilir; dev dosyada bellek sismez. */
const FLUSH_EVERY = 2000

export interface ScanResult {
  filesRead: number
  messages: number
  badLines: number
}

async function listJsonl(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = (await readdir(dir, { recursive: true })) as string[]
  } catch {
    // Klasor yoksa (hesap bu cihazda kullanilmamis) taranacak bir sey yok.
    return []
  }
  return entries.filter((e) => e.endsWith('.jsonl')).map((e) => join(dir, e))
}

function isSubagentFile(path: string): boolean {
  return /[\\/]subagents[\\/]/.test(path)
}

interface Pending {
  file: string
  source: ScanSource
  size: number
  mtimeMs: number
  offset: number
  badLines: number
}

/**
 * Bir tarama turu.
 *
 * @param initial ilk tur mu; ilerleme `initial` evresinde raporlanir
 */
export async function scanOnce(
  store: UsageStore,
  sources: readonly ScanSource[],
  onProgress?: (progress: TokenScanProgress) => void,
  initial = false
): Promise<ScanResult> {
  const pending: Pending[] = []
  for (const source of sources) {
    for (const file of await listJsonl(source.projectsDir)) {
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      const known = store.getFile(file)
      if (known !== null && known.size === info.size && known.offset === info.size) continue
      const shrunk = known !== null && info.size < known.offset
      pending.push({
        file,
        source,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: known === null || shrunk ? 0 : known.offset,
        badLines: known === null || shrunk ? 0 : known.badLines
      })
    }
  }

  const totalBytes = pending.reduce((n, p) => n + (p.size - p.offset), 0)
  let doneBytes = 0
  let lastReport = 0
  const report = (force = false): void => {
    if (onProgress === undefined) return
    const now = Date.now()
    if (!force && now - lastReport < 500) return
    lastReport = now
    onProgress({
      phase: initial ? 'initial' : 'idle',
      doneBytes,
      totalBytes,
      badLines: store.totalBadLines()
    })
  }

  let messages = 0
  let badLines = 0
  for (const p of pending) {
    const subagent = isSubagentFile(p.file)
    let batch: MessageRecord[] = []
    let orgs: Array<[string, string]> = []
    let bad = 0
    const flush = (): void => {
      store.write(p.source.account, batch, orgs)
      messages += batch.length
      batch = []
      orgs = []
    }
    let result
    try {
      result = await readNewLines(
        p.file,
        p.offset,
        (line) => {
          const parsed = parseLine(line, subagent)
          if (parsed.kind === 'message') batch.push(parsed.record)
          else if (parsed.kind === 'org') orgs.push([parsed.sessionId, parsed.orgId])
          else if (parsed.kind === 'bad') bad += 1
          if (batch.length >= FLUSH_EVERY) flush()
        },
        (bytes) => {
          doneBytes += bytes
          report()
        }
      )
    } catch {
      // Dosya okuma sirasinda silindi/kilitlendi: bir sonraki turda yeniden denenir.
      continue
    }
    flush()
    badLines += bad
    store.saveFile({
      path: p.file,
      account: p.source.account,
      size: p.size,
      mtimeMs: p.mtimeMs,
      offset: result.nextOffset,
      badLines: p.badLines + bad
    })
  }
  report(true)
  return { filesRead: pending.length, messages, badLines }
}
