/**
 * Claude Code kayit satirini ayristirir.
 *
 * Olculen kurallar (F0, 2026-11-06, 9,12 GB / 433 bin kullanim satiri):
 * - Ayni mesaj birden cok satira yazilir (mesaj basina ortalama 2,1). Kopyalar
 *   arasinda yalniz `output_tokens` degisir ve SON satir her zaman en buyugudur.
 *   Tekillestirme anahtari `message.id|requestId`; birini tasimayan satir (29
 *   tane) icin satirin `uuid`'si.
 * - `<synthetic>` modelli satirlar gercek API cagrisi degildir, sayilmaz.
 * - Oturumun hesabi `attachment.type = credential_org` satirindan gelir
 *   (Claude Code 2.1.284'ten beri her oturumda).
 */

import type { MessageRecord, ParsedLine, UsageTokens } from './types'

/** Satir bu iki isaretten birini tasimiyorsa JSON'u hic acilmaz (hiz). */
export function isRelevant(line: string): boolean {
  return line.includes('"type":"assistant"') || line.includes('"credential_org"')
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Calisma klasorunun son parcasi; Windows ve POSIX ayraclari ikisi de. */
export function projectName(cwd: unknown): string | null {
  const text = str(cwd)
  if (text === null) return null
  const parts = text.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.at(-1) ?? null
}

function tokensOf(usage: Json): UsageTokens {
  const creation = isObject(usage['cache_creation']) ? usage['cache_creation'] : null
  // Eski surumlerde ayrim yok: toplam yazma 5 dakikalik sayilir.
  const write5m =
    creation === null ? num(usage['cache_creation_input_tokens']) : num(creation['ephemeral_5m_input_tokens'])
  const write1h = creation === null ? 0 : num(creation['ephemeral_1h_input_tokens'])
  return {
    input: num(usage['input_tokens']),
    output: num(usage['output_tokens']),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: num(usage['cache_read_input_tokens'])
  }
}

/**
 * Bir satiri ayristirir.
 *
 * @param fileIsSubagent satir bir alt ajan dosyasindan (`.../subagents/...`) mi
 */
export function parseLine(line: string, fileIsSubagent = false): ParsedLine {
  if (!isRelevant(line)) return { kind: 'skip' }
  let rec: unknown
  try {
    rec = JSON.parse(line)
  } catch {
    return { kind: 'bad' }
  }
  if (!isObject(rec)) return { kind: 'bad' }

  if (rec['type'] === 'attachment') {
    const att = rec['attachment']
    if (!isObject(att) || att['type'] !== 'credential_org') return { kind: 'skip' }
    const sessionId = str(rec['sessionId'])
    const orgId = str(att['organizationUuid'])
    if (sessionId === null || orgId === null) return { kind: 'skip' }
    return { kind: 'org', sessionId, orgId }
  }

  if (rec['type'] !== 'assistant') return { kind: 'skip' }
  const message = rec['message']
  if (!isObject(message) || !isObject(message['usage'])) return { kind: 'skip' }
  const model = str(message['model']) ?? 'unknown'
  if (model === '<synthetic>') return { kind: 'skip' }

  const id = str(message['id'])
  const requestId = str(rec['requestId'])
  const uuid = str(rec['uuid'])
  const key = id !== null && requestId !== null ? `${id}|${requestId}` : uuid !== null ? `uuid:${uuid}` : null
  if (key === null) return { kind: 'skip' }

  const atMs = Date.parse(str(rec['timestamp']) ?? '')
  if (!Number.isFinite(atMs)) return { kind: 'bad' }

  const record: MessageRecord = {
    key,
    atMs,
    model,
    sessionId: str(rec['sessionId']),
    project: projectName(rec['cwd']),
    subagent: fileIsSubagent || rec['isSidechain'] === true,
    tokens: tokensOf(message['usage'])
  }
  return { kind: 'message', record }
}
