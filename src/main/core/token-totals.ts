/**
 * Widget'in token sayilari hesabin TUM cihazlarini kapsar: bu cihazin payi
 * yerel toplayicidan (gecikmesiz), digerleri merkezden gelir.
 *
 * Neden ayri: kota yuzdesi hesabin tamamina aittir; token sayisi yalniz o
 * cihazinki olunca iki makinede farkli "bugun" goruluyordu (kullanici
 * bildirdi, 2026-11-06: PC 25,4 mn, Mac 1,5 mn, hesap 26,9 mn).
 *
 * Merkezden bu cihazin satirlari CIKARILIR, yerine yerel sayi konur: merkez
 * bu cihazin son dakikalarini henuz almamis olabilir, yerel her zaman gunceldir.
 */

import { SPARK_POINTS, SPARK_STEP_MS } from '../../collector/store'
import type { AccountKey, AccountTokens, TokenState } from '../../shared/types'
import { readTargets, sendToHub, type FetchFn, type HubSettings } from './hub-client'

const MIN = 60_000

export interface OtherDevicesTotals {
  /** Merkezden okunma ani. */
  fetchedAt: number
  accounts: Partial<Record<AccountKey, { last15m: number; cacheRead15m: number; today: number; spark: number[] }>>
}

/** Bu kadar eski merkez okumasi "ulasilamadi" sayilir; eksik toplam gercek gibi gosterilmez. */
export const OTHERS_MAX_AGE_MS = 3 * MIN

interface HubRow {
  atMs: number
  account?: string
  device?: string
  total: number
  cacheRead: number
}

function isAccount(value: unknown): value is AccountKey {
  return value === 'personal' || value === 'team'
}

/**
 * Bu cihaz DISINDAKI cihazlarin son 15 dk, bugun ve kivilcim toplamlari.
 * Merkez tanimli degilse ya da ulasilamazsa null.
 *
 * Dilimler yerel ozetle ayni: `now - 36 x 5 dk`'dan baslar, son uc dilim son
 * 15 dakikadir. Sayilar onbellekten okumayi icermez (yerel ana sayiyla ayni olcu).
 */
export async function fetchOtherDevices(
  fetchFn: FetchFn,
  hub: HubSettings & { deviceId: string | null },
  now: number,
  dayStart: number
): Promise<OtherDevicesTotals | null> {
  const targets = readTargets(hub)
  if (targets.length === 0) return null
  const sparkStart = now - SPARK_POINTS * SPARK_STEP_MS
  const to = now + MIN
  const [spark, today] = await Promise.all([
    sendToHub(fetchFn, targets, `v1/usage?from=${sparkStart}&to=${to}&step=${SPARK_STEP_MS}&by=account,device`, undefined),
    sendToHub(fetchFn, targets, `v1/usage?from=${dayStart}&to=${to}&step=${to - dayStart}&by=account,device`, undefined)
  ])
  if (spark.status !== 200 || today.status !== 200) return null
  const others = (body: unknown): HubRow[] =>
    ((body as { rows?: HubRow[] } | null)?.rows ?? []).filter((r) => r.device !== hub.deviceId && isAccount(r.account))

  const accounts: OtherDevicesTotals['accounts'] = {}
  const entry = (key: AccountKey): NonNullable<OtherDevicesTotals['accounts'][AccountKey]> => {
    const cur = accounts[key] ?? { last15m: 0, cacheRead15m: 0, today: 0, spark: new Array<number>(SPARK_POINTS).fill(0) }
    accounts[key] = cur
    return cur
  }
  for (const r of others(spark.body)) {
    const e = entry(r.account as AccountKey)
    const fresh = r.total - r.cacheRead
    const i = Math.round((r.atMs - sparkStart) / SPARK_STEP_MS)
    if (i < 0 || i >= SPARK_POINTS) continue
    e.spark[i] = (e.spark[i] ?? 0) + fresh
    if (i >= SPARK_POINTS - 3) {
      e.last15m += fresh
      e.cacheRead15m += r.cacheRead
    }
  }
  for (const r of others(today.body)) entry(r.account as AccountKey).today += r.total - r.cacheRead
  return { fetchedAt: now, accounts }
}

/**
 * Yerel ozet + diger cihazlar. Merkez tanimli degilse yerel sayi oldugu gibi
 * (`device`); tanimli ama okuma yok ya da bayatsa yerel sayi `device-offline`
 * isaretiyle; okuma tazeyse toplam (`all`) ve her hesapta bu cihazin payi.
 */
export function mergeTokens(
  local: TokenState | null,
  others: OtherDevicesTotals | null,
  hubConfigured: boolean,
  now: number
): TokenState | null {
  if (local === null) return null
  if (!hubConfigured) return { ...local, scope: 'device' }
  if (others === null || now - others.fetchedAt > OTHERS_MAX_AGE_MS || local.error !== null) {
    return { ...local, scope: 'device-offline' }
  }
  const accounts: AccountTokens[] = local.accounts.map((a) => {
    const o = others.accounts[a.key]
    if (o === undefined) return { ...a, own: { last15m: a.last15m, today: a.today } }
    return {
      key: a.key,
      last15m: a.last15m + o.last15m,
      cacheRead15m: a.cacheRead15m + o.cacheRead15m,
      today: a.today + o.today,
      spark: a.spark.map((v, i) => v + (o.spark[i] ?? 0)),
      own: { last15m: a.last15m, today: a.today }
    }
  })
  return { ...local, accounts, scope: 'all' }
}
