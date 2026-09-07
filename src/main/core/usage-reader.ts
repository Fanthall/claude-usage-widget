/**
 * Kaynak koprusu: `usage-source` parcalarini toplayicinin bekledigi
 * `UsageReadResult`a cevirir.
 *
 * Sira onemli: **once uc denenir**, basarisiz olursa onbellege dusulur.
 * Onbellek asla "taze" sayilmaz — `snapshot.at` onun `fetchedAtMs`'i oldugu icin
 * bayatlik kendiliginden dogru cikar. Bugunku hata (20 dk'lik veriyi guncel
 * gostermek) bu iki kuralin ihlaliydi.
 */

import type { CliErrorKind } from '../../shared/types'
import type { UsageReadResult } from './collector'
import { claudeConfigFile, nodePathEnv, type PathEnv } from './paths'
import { createCliRefresher, type RefreshOutcome } from './cli-refresh'
import { claudeCredentialsFile, readAccessToken } from './identity'
import {
  fetchUtilization,
  parseCachedUtilization,
  toSnapshot,
  type CachedUtilization,
  type FetchDeps,
  type FetchFailure
} from './usage-source'

/** Uc hatalarini kullaniciya gosterilen sinifa cevirir. */
export function toErrorKind(failure: FetchFailure): CliErrorKind {
  switch (failure) {
    case 'rate-limited':
      return 'rate-limited'
    case 'unauthorized':
      return 'not-logged-in'
    case 'bad-body':
      return 'bad-output'
    case 'network':
      return 'unknown'
  }
}

export interface UsageReaderFs {
  readFile(file: string): Promise<string>
}

export interface UsageReaderDeps {
  fs: UsageReaderFs
  env?: PathEnv
  /** Testte enjekte edilir; uretimde `fetchUtilization`. */
  fetchFn?: FetchDeps['fetchFn']
  /**
   * Jeton suresi dolunca CLI'i durterek tazeletir. Testte enjekte edilir.
   * Verilmezse gercek CLI aranir.
   */
  refreshToken?: () => Promise<RefreshOutcome>
  readToken?: FetchDeps['readToken']
  now?: () => number
}

/** `~/.claude.json` okunamazsa onbellek yok sayilir; bu bir hata degil. */
async function readCache(
  deps: UsageReaderDeps,
  env: PathEnv
): Promise<CachedUtilization | null> {
  try {
    return parseCachedUtilization(await deps.fs.readFile(claudeConfigFile(env)))
  } catch {
    return null
  }
}

/**
 * Bir olcum turu. Kota verisi icin `claude` calistirilabiliri **hic gerekmez** —
 * yalniz dosya okuma ve HTTPS. Bu, capraz platform denetiminde bulunan en buyuk
 * kirilma sinifini (macOS'ta GUI app'in minimal PATH'i) ortadan kaldirir.
 */
export function createUsageReader(deps: UsageReaderDeps): () => Promise<UsageReadResult> {
  const env = deps.env ?? nodePathEnv()
  const readToken =
    deps.readToken ??
    (() => readAccessToken({ readFile: (f) => deps.fs.readFile(f) }, claudeCredentialsFile(env)))

  const nudgeCli = deps.refreshToken ?? createCliRefresher()

  const fetchOnce = (): Promise<Awaited<ReturnType<typeof fetchUtilization>>> =>
    fetchUtilization({
      readToken,
      ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
      ...(deps.now === undefined ? {} : { now: deps.now })
    })

  return async function readUsage(): Promise<UsageReadResult> {
    let fresh = await fetchOnce()

    // Jeton 8 saatte bir doluyor ve onu yalnizca CLI yenileyebilir (refresh
    // token tek kullanimlik olabilir; biz tuketirsek kullanicinin CLI oturumu
    // duser). Bir kez durtup yeniden deniyoruz; jeton dosyadan taze okunur.
    if (!fresh.ok && fresh.kind === 'unauthorized') {
      const outcome = await nudgeCli()
      if (outcome === 'refreshed') fresh = await fetchOnce()
    }

    if (fresh.ok) {
      return { kind: 'fresh', snapshot: toSnapshot(fresh.fetchedAtMs, fresh.windows) }
    }

    const failure = toErrorKind(fresh.kind)
    const cached = await readCache(deps, env)
    if (cached === null) {
      return { kind: 'none', failure, message: fresh.message }
    }
    // Onbellekten gelen deger gosterilir ama `at` onun kendi yasidir; toplayici
    // bunu bayat sayar ve gosterge guncel gibi davranmaz.
    return {
      kind: 'cached',
      snapshot: toSnapshot(cached.fetchedAtMs, cached.windows),
      failure
    }
  }
}
