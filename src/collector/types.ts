/**
 * Token toplayicinin sozlesmeleri.
 *
 * Toplayici Electron'a bagimli DEGILDIR: widget onu ayri bir surecte calistirir,
 * merkez sunucusu ayni kodu kendi makinesinin kayitlari icin kullanir.
 */

import type { AccountKey } from '../shared/types'

/** Bir API cevabinin token dokumu. */
export interface UsageTokens {
  input: number
  output: number
  /** 5 dakikalik onbellege yazma. */
  cacheWrite5m: number
  /** 1 saatlik onbellege yazma. */
  cacheWrite1h: number
  cacheRead: number
}

/** Kayittaki bir asistan mesaji (tekillestirilmis birim). */
export interface MessageRecord {
  /** `message.id|requestId`; ikisi yoksa `uuid:<satir uuid>`. Tum dosyalarda tekil. */
  key: string
  atMs: number
  model: string
  sessionId: string | null
  /** Calisma klasorunun son parcasi; bilinmiyorsa null. */
  project: string | null
  /** Alt ajan (Task/Workflow) mesaji mi. */
  subagent: boolean
  tokens: UsageTokens
}

export type ParsedLine =
  | { kind: 'message'; record: MessageRecord }
  /** Oturumun hangi kurumla (hesapla) calistigi. */
  | { kind: 'org'; sessionId: string; orgId: string }
  /** Ilgisiz satir. */
  | { kind: 'skip' }
  /** Ilgili gorunen ama cozulemeyen satir; sayilir, sessizce atilmaz. */
  | { kind: 'bad' }

/** Taranacak bir hesap klasoru. */
export interface ScanSource {
  account: AccountKey
  projectsDir: string
}

export function totalTokens(t: UsageTokens): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}
