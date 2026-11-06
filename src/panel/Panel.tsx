import { useCallback, useEffect, useMemo, useState } from 'react'
import { LuMoon, LuSun } from 'react-icons/lu'

import { formatAgo, formatDuration, formatPercent, formatTokens, t, type Lang, type MessageKey } from '@shared/i18n'
import type { AccountKey } from '@shared/types'
import {
  breakdown,
  DAY,
  FILL_LOOKBACK,
  fillTime,
  heatCells,
  heatLevel,
  HOUR,
  latestQuota,
  peaks,
  rangeFor,
  mainWindow,
  windowKind,
  windowLine,
  metricValue,
  stackSeries,
  unattributedShare,
  type DataSource,
  type DeviceRow,
  type MainWindowKind,
  type Metric,
  type QuotaRow,
  type RangeKind,
  type UsageRow
} from './data'

/**
 * Panel: iki hesabin token ve kota tarihcesi. Tasarim tuvaldeki "Panel —
 * masaustu" panosu. Kota ve token AYRI grafikte, ortak zaman ekseninde (iki
 * eksenli tek grafik yaniltir). Hesap rengi kimlik, esik renkleri yalniz kota
 * cubugunda ve etiketle.
 */

type Theme = 'dark' | 'light'

const PALETTE: Record<Theme, Record<string, string>> = {
  dark: {
    '--bg': '#0e0e10', '--surface': '#16161a', '--surface2': '#1e1e23', '--border': '#26262c', '--sel': '#26262e',
    '--text': '#f4f4f5', '--text2': '#a1a1aa', '--muted': '#8b8b94', '--grid': '#26262c', '--grid2': '#3a3a44',
    '--track': '#26262c', '--p': '#3987e5', '--t': '#d95926', '--green': '#35c68f', '--amber': '#e0a33a',
    '--red': '#e5544f', '--hover': 'rgba(244,244,245,0.06)', '--bar': '#5a5a63', '--scroll-thumb': '#3a3a44', '--scroll-thumb-hover': '#5a5a63', '--scroll-thumb-active': '#71717a', '--warnBg': '#2a2112',
    '--warnFg': '#f2c879', '--okBg': '#13241d', '--okFg': '#8fe0bd',
    '--h1': '#1c2a40', '--h2': '#1f4a80', '--h3': '#2f6fc0', '--h4': '#3987e5', '--h5': '#a9cbf5', '--h0': '#1e1e23'
  },
  light: {
    '--bg': '#f4f4f5', '--surface': '#ffffff', '--surface2': '#fafafa', '--border': '#e4e4e7', '--sel': '#e4e4e7',
    '--text': '#18181b', '--text2': '#52525b', '--muted': '#71717a', '--grid': '#e4e4e7', '--grid2': '#d4d4d8',
    '--track': '#e4e4e7', '--p': '#2a78d6', '--t': '#eb6834', '--green': '#1f8a5f', '--amber': '#b7791f',
    '--red': '#c43c37', '--hover': 'rgba(24,24,27,0.06)', '--bar': '#a1a1aa', '--scroll-thumb': '#c4c4cc', '--scroll-thumb-hover': '#a1a1aa', '--scroll-thumb-active': '#8b8b94', '--warnBg': '#fdf3e1',
    '--warnFg': '#6b4507', '--okBg': '#eef6f1', '--okFg': '#14532d',
    '--h1': '#dbe8f9', '--h2': '#a9cbf5', '--h3': '#5b9ae6', '--h4': '#2a78d6', '--h5': '#174f94', '--h0': '#f4f4f5'
  }
}

const ACCOUNTS: AccountKey[] = ['personal', 'team']
const ACCOUNT_LABEL: Record<AccountKey, MessageKey> = { personal: 'account.personal', team: 'account.team' }
const ACCOUNT_VAR: Record<AccountKey, string> = { personal: 'var(--p)', team: 'var(--t)' }
const RANGES: RangeKind[] = ['today', 'yesterday', '7d', '30d']
const RANGE_KEY: Record<RangeKind, MessageKey> = {
  today: 'panel.range.today',
  yesterday: 'panel.range.yesterday',
  '7d': 'panel.range.7d',
  '30d': 'panel.range.30d'
}
/** Araliga gore secilebilir dilimler; 30 gunu 5 dakikalik dilimle cizmek binlerce cubuk demek. */
const METRIC_KEY: Record<Metric, MessageKey> = {
  fresh: 'panel.metric.fresh',
  total: 'panel.metric.total',
  output: 'panel.metric.output'
}

const STEPS: Record<RangeKind, number[]> = {
  today: [5 * 60_000, 15 * 60_000, HOUR],
  yesterday: [5 * 60_000, 15 * 60_000, HOUR],
  '7d': [HOUR, 6 * HOUR],
  '30d': [6 * HOUR, DAY]
}
const DEFAULT_STEP: Record<RangeKind, number> = { today: 15 * 60_000, yesterday: 15 * 60_000, '7d': HOUR, '30d': 6 * HOUR }

/** Dilim genisligi etiketi: "15 dk", "1 sa" (formatDuration "1 sa 0 dk" yazardi). */
function stepLabel(lang: Lang, step: number): string {
  const sep = lang === 'tr' ? ' ' : ''
  if (step < HOUR) return `${Math.round(step / 60_000)}${sep}${t(lang, 'unit.minute')}`
  if (step < DAY) return `${Math.round(step / HOUR)}${sep}${t(lang, 'unit.hour')}`
  return `${Math.round(step / DAY)}${sep}${t(lang, 'unit.day')}`
}

function clock(lang: Lang, ms: number, withDay = false): string {
  const d = new Date(ms)
  const locale = lang === 'tr' ? 'tr-TR' : 'en-US'
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (!withDay) return time
  return `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} ${time}`
}

function level(percent: number): { color: string; key: MessageKey | null } {
  if (percent >= 90) return { color: 'var(--red)', key: 'panel.quota.critical' }
  if (percent >= 75) return { color: 'var(--amber)', key: 'panel.quota.caution' }
  return { color: 'var(--green)', key: null }
}

interface Loaded {
  series: UsageRow[]
  /** Yalniz 5 saatlik pencere; cizgi, dolma tahmini ve kalibrasyon icin. */
  quota: QuotaRow[]
  /** Son 6 saatin tum pencereleri; kartlardaki guncel degerler icin. */
  quotaNow: QuotaRow[]
  calib: UsageRow[]
  heat: UsageRow[]
  byDevice: UsageRow[]
  byModel: UsageRow[]
  byProject: UsageRow[]
  last15: UsageRow[]
  today: UsageRow[]
  devices: DeviceRow[]
  at: number
  /** Merkez yok: veri yalniz bu cihazin toplayicisindan. */
  local: boolean
}

const card = 'rounded-[14px] border border-(--border) bg-(--surface) p-[18px]'

function Segmented<T extends string | number>(props: {
  label: string
  options: T[]
  value: T
  text: (v: T) => string
  onChange: (v: T) => void
}): React.ReactElement {
  return (
    <div role="group" aria-label={props.label} className="flex gap-[2px] rounded-[10px] border border-(--border) bg-(--surface) p-[3px]">
      {props.options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={o === props.value}
          onClick={() => props.onChange(o)}
          className={`h-[30px] rounded-[7px] px-3 text-[13px] ${o === props.value ? 'bg-(--sel) text-(--text)' : 'text-(--text2)'}`}
        >
          {props.text(o)}
        </button>
      ))}
    </div>
  )
}

export function Panel({ source, lang }: { source: DataSource; lang: Lang }): React.ReactElement {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('panel-theme') === 'light' ? 'light' : 'dark'))
  const [range, setRange] = useState<RangeKind>('today')
  const [step, setStep] = useState(15 * 60_000)
  const [metric, setMetric] = useState<Metric>('fresh')
  const [show, setShow] = useState<Record<AccountKey, boolean>>({ personal: true, team: true })
  const [hover, setHover] = useState(-1)
  const [heatHover, setHeatHover] = useState<[number, number] | null>(null)
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState(false)
  const [now, setNow] = useState(Date.now())

  const { from, to } = useMemo(() => rangeFor(range, now), [range, now])

  const load = useCallback(async () => {
    const at = Date.now()
    const r = rangeFor(range, at)
    const dayStart = rangeFor('today', at).from
    try {
      const whole = Math.max(60_000, r.to - r.from)
      // Tahmin kalibrasyonu son 14 gunu ister; secili aralik daha uzunsa onu da kapsar.
      const calibFrom = Math.min(r.from, at - 14 * DAY)
      const [series, quota, quotaNow, calib, heat, byDevice, byModel, byProject, last15, today, devices] = await Promise.all([
        source.usage(r.from, r.to, step, ['account']),
        source.quota(calibFrom, Math.max(r.to, at), 'main'),
        source.quota(at - 6 * HOUR, at + 60_000),
        source.usage(calibFrom, at, 15 * 60_000, ['account']),
        source.usage(dayStart - 6 * DAY, dayStart + DAY, HOUR, ['account']),
        source.usage(r.from, r.from + whole, whole, ['device']),
        source.usage(r.from, r.from + whole, whole, ['model']),
        source.usage(r.from, r.from + whole, whole, ['project']),
        source.usage(at - 15 * 60_000, at, 15 * 60_000, ['account']),
        source.usage(dayStart, dayStart + DAY, DAY, ['account']),
        source.devices()
      ])
      setData({ series, quota, quotaNow, calib, heat, byDevice, byModel, byProject, last15, today, devices, at, local: source.isLocal?.() ?? false })
      setError(false)
    } catch {
      setError(true)
    }
    setNow(at)
  }, [source, range, step])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), 60_000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    localStorage.setItem('panel-theme', theme)
    document.documentElement.lang = lang
    document.body.style.background = PALETTE[theme]['--bg'] ?? ''
    // Sayfanin kaydirma cubugu kok ogede cizilir; renk degiskenleri oraya da konur.
    const root = document.documentElement
    for (const [name, value] of Object.entries(PALETTE[theme])) root.style.setProperty(name, value)
    root.style.colorScheme = theme
  }, [theme, lang])

  const buckets = useMemo(() => stackSeries(data?.series ?? [], from, to, step, metric), [data, from, to, step, metric])
  const visible = (b: { personal: number; team: number }): number => (show.personal ? b.personal : 0) + (show.team ? b.team : 0)
  // %15 bas bosluk: en yuksek cubugun tepe etiketi grafigin icinde kalsin, basliga binmesin.
  const maxV = Math.max(1, ...buckets.map(visible)) * 1.15
  const peakIdx = useMemo(() => peaks(buckets, 3, Math.max(2, Math.round(buckets.length / 16)), show), [buckets, show])
  const nowLeft = now >= from && now < to ? ((now - from) / (to - from)) * 100 : null
  const name = (k: AccountKey): string => t(lang, ACCOUNT_LABEL[k])

  const readout =
    hover < 0 || buckets[hover] === undefined
      ? t(lang, 'panel.tokens.hint')
      : `${clock(lang, buckets[hover]!.atMs, range !== 'today' && range !== 'yesterday')}–${clock(lang, buckets[hover]!.atMs + step)} · ${ACCOUNTS.filter(
          (a) => show[a]
        )
          .map((a) => `${name(a)} ${formatTokens(lang, buckets[hover]![a])}`)
          .join(' · ')}`

  const sum = (rows: UsageRow[] | undefined, account: AccountKey): number =>
    (rows ?? []).filter((r) => r.account === account).reduce((n, r) => n + metricValue(r, metric), 0)

  // Hesap basina ana pencere (son ornekten): 5 saatlik yoksa haftalik.
  const mainKinds = useMemo(
    () =>
      Object.fromEntries(ACCOUNTS.map((a) => [a, mainWindow(latestQuota(data?.quotaNow ?? [], a))?.kind ?? null])) as Record<
        AccountKey,
        MainWindowKind | null
      >,
    [data]
  )
  const shownKinds = new Set(ACCOUNTS.filter((a) => show[a] && mainKinds[a] !== null).map((a) => mainKinds[a]))
  const quotaTitle: MessageKey =
    shownKinds.size === 1 && shownKinds.has('week') ? 'panel.quota.weekly' : shownKinds.size > 1 ? 'panel.quota.mixed' : 'panel.quota.title'

  const heat = useMemo(
    () => heatCells((data?.heat ?? []).filter((r) => r.account !== undefined && show[r.account]), now, metric),
    [data, now, metric, show]
  )
  const heatMax = Math.max(0, ...heat.flatMap((d) => d.hours))

  const topSlices = [...buckets.keys()]
    .filter((i) => visible(buckets[i]!) > 0)
    .sort((a, b) => visible(buckets[b]!) - visible(buckets[a]!))
    .slice(0, 5)

  const seen = (data?.devices ?? []).map((d) => d.lastSeen).filter((v): v is number => v !== null)
  const lastSeen = seen.length === 0 ? null : Math.max(...seen)

  const style = PALETTE[theme] as React.CSSProperties

  return (
    <div style={style} className="min-h-screen bg-(--bg) font-sans text-(--text) tabular-nums">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-5 px-4 pt-6 pb-10 sm:px-8">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="mr-auto flex flex-col gap-[2px]">
            <h1 className="m-0 text-[22px] leading-7 font-semibold">{t(lang, 'panel.title')}</h1>
            <div className="text-[13px] text-(--text2)">
              {data === null
                ? t(lang, 'panel.loading')
                : lastSeen === null
                  ? t(lang, 'panel.devices.never')
                  : t(lang, 'panel.lastData', { age: formatAgo(lang, Math.max(0, now - lastSeen)) })}
              {data?.local === true ? ` · ${t(lang, 'panel.localOnly')}` : ''}
            </div>
          </div>
          <Segmented
            label={t(lang, 'panel.range.group')}
            options={RANGES}
            value={range}
            text={(r) => t(lang, RANGE_KEY[r])}
            onChange={(r) => {
              setRange(r)
              if (!STEPS[r].includes(step)) setStep(DEFAULT_STEP[r])
            }}
          />
          <Segmented label={t(lang, 'panel.step.group')} options={STEPS[range]} value={step} text={(s) => stepLabel(lang, s)} onChange={setStep} />
          <Segmented
            label={t(lang, 'panel.metric.group')}
            options={['fresh', 'total', 'output'] as Metric[]}
            value={metric}
            text={(m) => t(lang, METRIC_KEY[m])}
            onChange={setMetric}
          />
          <div className="flex gap-[6px]">
            {ACCOUNTS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={show[a]}
                onClick={() => setShow({ ...show, [a]: !show[a] })}
                className={`flex h-9 items-center gap-2 rounded-[10px] border border-(--border) px-3 text-[13px] ${show[a] ? 'bg-(--sel) text-(--text)' : 'text-(--muted)'}`}
              >
                <span aria-hidden className="h-[10px] w-[10px] rounded-[2px]" style={{ background: ACCOUNT_VAR[a], opacity: show[a] ? 1 : 0.35 }} />
                {name(a)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={t(lang, 'panel.theme.toggle')}
            title={t(lang, 'panel.theme.toggle')}
            className="h-9 rounded-[10px] border border-(--border) px-3 text-[13px] text-(--text2)"
          >
            {theme === 'dark' ? <LuSun aria-hidden size={16} /> : <LuMoon aria-hidden size={16} />}
          </button>
        </header>

        {error ? <div className={`${card} text-[13px] text-(--red)`}>{t(lang, 'panel.error')}</div> : null}

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]">
          {ACCOUNTS.map((a) => {
            const latest = latestQuota(data?.quotaNow ?? [], a)
            const main = mainWindow(latest)
            const session = main?.row
            // Ikinci sutun: ana pencere oturumsa tum modellerin haftasi, haftaysa model haftasi (orn. "Fable").
            const second =
              main?.kind === 'session'
                ? { label: t(lang, 'window.week'), row: latest.find((r) => windowKind(r.label) === 'week') }
                : (() => {
                    const row = latest.find((r) => /week/i.test(r.label) && windowKind(r.label) === null)
                    return { label: /\(([^)]+)\)/.exec(row?.label ?? '')?.[1] ?? t(lang, 'window.week'), row }
                  })()
            const line = main === null ? [] : windowLine(data?.quota ?? [], a, main.kind)
            const fill = main === null ? null : fillTime(line, now, main.row.resetsAtMs, FILL_LOOKBACK[main.kind])
            const lv = level(session?.percent ?? 0)
            return (
              <section key={a} className={`${card} flex flex-col gap-3`}>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="h-[10px] w-[10px] rounded-[2px]" style={{ background: ACCOUNT_VAR[a] }} />
                  <h2 className="m-0 text-[15px] font-semibold">{name(a)}</h2>
                </div>
                {main === null || session === undefined ? (
                  <div className="text-[13px] text-(--text2)">{t(lang, 'account.notConnected')}</div>
                ) : (
                  <div className="grid grid-cols-2 items-end gap-5 sm:grid-cols-[1.3fr_1fr_1fr]">
                    <div className="col-span-2 flex flex-col gap-[6px] sm:col-span-1">
                      <div className="text-[11px] tracking-[0.08em] text-(--muted) uppercase">
                        {t(lang, main.kind === 'session' ? 'window.session' : 'window.week')}
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[34px] leading-none font-semibold">{formatPercent(lang, session.percent)}</span>
                        {lv.key === null ? null : <span className="text-[12px]" style={{ color: lv.color }}>{t(lang, lv.key, { pct: '' }).trim()}</span>}
                      </div>
                      <div className="h-[6px] rounded-[3px] bg-(--track)">
                        <div className="h-[6px] rounded-[3px]" style={{ width: `${session.percent}%`, background: lv.color }} />
                      </div>
                      <div className="text-[12px] text-(--muted)">
                        {session.resetsAtMs === null
                          ? t(lang, 'reset.unknown')
                          : `${t(lang, 'reset.at', { time: clock(lang, session.resetsAtMs, session.resetsAtMs - now > 20 * HOUR) })} · ${t(lang, 'reset.left', { left: formatDuration(lang, Math.max(0, session.resetsAtMs - now), { short: true }) })}`}
                      </div>
                    </div>
                    <div className="flex flex-col gap-[6px]">
                      <div className="text-[11px] tracking-[0.08em] text-(--muted) uppercase">{second.label}</div>
                      <div className="text-[20px] font-semibold">{second.row === undefined ? '—' : formatPercent(lang, second.row.percent)}</div>
                    </div>
                    <div className="flex flex-col gap-[6px]">
                      <div className="text-[11px] tracking-[0.08em] text-(--muted) uppercase">{t(lang, 'tokens.last15')}</div>
                      <div className="text-[20px] font-semibold">{formatTokens(lang, sum(data?.last15, a))}</div>
                      <div className="text-[12px] text-(--muted)">{t(lang, 'tokens.today', { value: formatTokens(lang, sum(data?.today, a)) })}</div>
                    </div>
                  </div>
                )}
                {/* Pencere bostayken (sifirlanma saati yok) tahmin kutusu anlamsiz: gizli. */}
                {session === undefined || session.percent === 0 || (fill === null && session.resetsAtMs === null) ? null : (
                  <div
                    className="rounded-[10px] px-3 py-[10px] text-[13px]"
                    style={{ background: fill === null ? 'var(--okBg)' : 'var(--warnBg)', color: fill === null ? 'var(--okFg)' : 'var(--warnFg)' }}
                  >
                    {fill === null ? t(lang, 'panel.card.noFill') : t(lang, 'panel.card.fill', { time: clock(lang, fill) })}
                  </div>
                )}
              </section>
            )
          })}
        </div>

        <section className={`${card} flex flex-col gap-3`} onMouseLeave={() => setHover(-1)}>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="m-0 text-[15px] font-semibold">{t(lang, 'panel.tokens.title', { step: stepLabel(lang, step) })}</h2>
            <div className="flex gap-3 text-[12px] text-(--text2)">
              {ACCOUNTS.map((a) => (
                <span key={a} className="flex items-center gap-[6px]">
                  <span aria-hidden className="h-[10px] w-[10px] rounded-[2px]" style={{ background: ACCOUNT_VAR[a] }} />
                  {name(a)}
                </span>
              ))}
            </div>
            <div className="ml-auto text-[13px] text-(--text2)">{readout}</div>
          </div>
          <div className="flex gap-[10px]">
            <div aria-hidden className="relative h-[220px] w-[56px] text-[11px] text-(--muted)">
              {[0, 1, 2, 3].map((k) => (
                <div key={k} className="absolute right-0 -translate-y-1/2" style={{ top: `${(k / 3) * 100}%` }}>
                  {k === 3 ? '0' : formatTokens(lang, (maxV * (3 - k)) / 3)}
                </div>
              ))}
            </div>
            <div role="img" aria-label={t(lang, 'panel.tokens.title', { step: stepLabel(lang, step) })} className="relative h-[220px] min-w-0 flex-1">
              {[0, 1, 2, 3].map((k) => (
                <div key={k} className="absolute right-0 left-0 h-px bg-(--grid)" style={{ top: `${(k / 3) * 100}%` }} />
              ))}
              {nowLeft === null ? null : (
                <div className="absolute top-0 bottom-0 w-px bg-(--text2) opacity-60" style={{ left: `${nowLeft}%` }}>
                  <span className="absolute -top-[18px] left-1 text-[11px] text-(--muted)">{t(lang, 'panel.now')}</span>
                </div>
              )}
              <div className="absolute inset-0 flex items-stretch gap-[2px]">
                {buckets.map((b, i) => {
                  const hp = show.personal ? (b.personal / maxV) * 100 : 0
                  const ht = show.team ? (b.team / maxV) * 100 : 0
                  return (
                    <div
                      key={b.atMs}
                      onMouseEnter={() => setHover(i)}
                      className="relative flex min-w-0 flex-1 flex-col justify-end rounded-[3px]"
                      style={{ gap: hp > 0 && ht > 0 ? 2 : 0, background: i === hover ? 'var(--hover)' : 'transparent' }}
                    >
                      {peakIdx.includes(i) ? (
                        <div
                          className="absolute left-1/2 -translate-x-1/2 rounded-[6px] border border-(--border) bg-(--surface2) px-[6px] py-px text-[11px] whitespace-nowrap"
                          style={{ bottom: `calc(${hp + ht}% + 6px)` }}
                        >
                          {clock(lang, b.atMs)} · {formatTokens(lang, visible(b))}
                        </div>
                      ) : null}
                      <div style={{ height: `${ht}%`, background: 'var(--t)', borderRadius: '3px 3px 0 0' }} />
                      <div style={{ height: `${hp}%`, background: 'var(--p)', borderRadius: ht > 0 ? 0 : '3px 3px 0 0' }} />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="flex gap-[10px]">
            <div className="w-[56px] text-[11px] text-(--muted)">{t(lang, quotaTitle)}</div>
            <div role="img" aria-label={t(lang, quotaTitle)} className="relative h-[120px] min-w-0 flex-1 border-b border-(--grid)">
              {[75, 90].map((p) => (
                <div key={p} className="absolute right-0 left-0 border-t border-dashed border-(--grid2)" style={{ top: `${100 - p}%` }}>
                  <span className="absolute right-0 -translate-y-full text-[11px] text-(--muted)">
                    {t(lang, p === 75 ? 'panel.quota.caution' : 'panel.quota.critical', { pct: formatPercent(lang, p) })}
                  </span>
                </div>
              ))}
              {nowLeft === null ? null : <div className="absolute top-0 bottom-0 w-px bg-(--text2) opacity-60" style={{ left: `${nowLeft}%` }} />}
              <svg aria-hidden width="100%" height="100%" viewBox="0 0 1000 120" preserveAspectRatio="none" className="absolute inset-0 overflow-visible">
                {ACCOUNTS.filter((a) => show[a] && mainKinds[a] !== null).map((a) => {
                  const pts = windowLine(data?.quota ?? [], a, mainKinds[a] ?? 'session').filter((p) => p.atMs >= from && p.atMs < to)
                  const points = pts.map((p) => `${(((p.atMs - from) / (to - from)) * 1000).toFixed(1)},${(120 - p.percent * 1.2).toFixed(1)}`).join(' ')
                  return <polyline key={a} points={points} fill="none" stroke={ACCOUNT_VAR[a]} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                })}
              </svg>
              {hover >= 0 ? <div className="absolute top-0 bottom-0 w-px bg-(--text)" style={{ left: `${((hover + 0.5) / buckets.length) * 100}%` }} /> : null}
            </div>
          </div>
          {buckets.every((b) => visible(b) === 0) && data !== null ? <div className="text-[13px] text-(--text2)">{t(lang, 'panel.empty')}</div> : null}
        </section>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">
          <section className={`${card} flex flex-col gap-3`} onMouseLeave={() => setHeatHover(null)}>
            <div className="flex items-baseline gap-3">
              <h2 className="m-0 text-[15px] font-semibold">{t(lang, 'panel.heat.title')}</h2>
              <span className="ml-auto text-[13px] text-(--text2)">
                {heatHover === null
                  ? ''
                  : `${new Date(heat[heatHover[0]]!.dayMs).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { weekday: 'short', day: 'numeric', month: 'short' })} ${String(heatHover[1]).padStart(2, '0')}:00 · ${formatTokens(lang, heat[heatHover[0]]!.hours[heatHover[1]] ?? 0)}`}
              </span>
            </div>
            <div className="flex flex-col gap-[3px]">
              {heat.map((d, di) => (
                <div key={d.dayMs} className="flex items-center gap-2">
                  <div className="w-[72px] text-[12px] text-(--text2)">
                    {new Date(d.dayMs).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { weekday: 'short', day: 'numeric' })}
                  </div>
                  <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
                    {d.hours.map((v, h) => (
                      <div
                        key={h}
                        onMouseEnter={() => setHeatHover([di, h])}
                        className="h-[22px] rounded-[3px]"
                        style={{
                          background: `var(--h${heatLevel(v, heatMax)})`,
                          outline: heatHover !== null && heatHover[0] === di && heatHover[1] === h ? '2px solid var(--text)' : 'none'
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div aria-hidden className="flex items-center gap-2">
                <div className="w-[72px]" />
                <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px] text-[11px] text-(--muted)">
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h}>{h % 6 === 0 ? String(h).padStart(2, '0') : ''}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-[6px] text-[11px] text-(--muted)">
              {t(lang, 'panel.heat.less')}
              {[1, 2, 3, 4, 5].map((l) => (
                <span key={l} aria-hidden className="h-[10px] w-[18px] rounded-[2px]" style={{ background: `var(--h${l})` }} />
              ))}
              {t(lang, 'panel.heat.more')}
            </div>
          </section>

          <section className={`${card} flex flex-col gap-2`}>
            <h2 className="m-0 text-[15px] font-semibold">{t(lang, 'panel.peaks.title')}</h2>
            <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-2 border-b border-(--border) py-[6px] text-[13px] text-(--muted)">
              <span>{t(lang, 'panel.col.slice')}</span>
              <span className="text-right">{t(lang, 'panel.col.total')}</span>
              <span className="text-right">{name('personal')}</span>
              <span className="text-right">{name('team')}</span>
            </div>
            {topSlices.map((i) => (
              <div key={i} className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-2 border-b border-(--border) py-[7px] text-[13px]">
                <span>{`${clock(lang, buckets[i]!.atMs, range === '7d' || range === '30d')}–${clock(lang, buckets[i]!.atMs + step)}`}</span>
                <span className="text-right font-semibold">{formatTokens(lang, visible(buckets[i]!))}</span>
                <span className="text-right text-(--text2)">{formatTokens(lang, buckets[i]!.personal)}</span>
                <span className="text-right text-(--text2)">{formatTokens(lang, buckets[i]!.team)}</span>
              </div>
            ))}
            {topSlices.length === 0 ? <div className="text-[13px] text-(--text2)">{t(lang, 'panel.empty')}</div> : null}
          </section>
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
          {(
            [
              ['panel.breakdown.device', breakdown(data?.byDevice ?? [], 'device', metric), (k: string | null) => data?.devices.find((d) => d.id === k)?.name ?? k ?? '—'],
              ['panel.breakdown.model', breakdown(data?.byModel ?? [], 'model', metric), (k: string | null) => k ?? '—'],
              ['panel.breakdown.project', breakdown(data?.byProject ?? [], 'project', metric), (k: string | null) => k ?? t(lang, 'panel.project.none')]
            ] as const
          ).map(([title, rows, label]) => {
            const top = rows[0]?.value ?? 1
            return (
              <section key={title} className={`${card} flex flex-col gap-[10px]`}>
                <h2 className="m-0 text-[15px] font-semibold">{t(lang, title)}</h2>
                {rows.slice(0, 6).map((r) => (
                  <div key={String(r.key)} className="flex flex-col gap-1">
                    <div className="flex justify-between gap-3 text-[13px]">
                      <span className={r.key === null ? 'text-(--muted)' : ''}>{label(r.key)}</span>
                      <span className="font-semibold">{formatTokens(lang, r.value)}</span>
                    </div>
                    <div className="h-1 rounded-[2px] bg-(--track)">
                      <div className="h-1 rounded-[2px] bg-(--bar)" style={{ width: `${(r.value / top) * 100}%` }} />
                    </div>
                  </div>
                ))}
                {rows.length === 0 ? <div className="text-[13px] text-(--text2)">{t(lang, 'panel.empty')}</div> : null}
              </section>
            )
          })}
        </div>

        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">
          <section className={`${card} flex flex-col gap-[6px]`}>
            <h2 className="m-0 text-[15px] font-semibold">{t(lang, 'panel.devices.title')}</h2>
            {(data?.devices ?? []).map((d) => {
              const age = d.lastSeen === null ? null : now - d.lastSeen
              const live = age !== null && age < 10 * 60_000
              return (
                <div key={d.id} className="flex items-center gap-[10px] border-b border-(--border) py-[6px] text-[13px]">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: live ? 'var(--green)' : 'var(--bar)' }} />
                  <span className="min-w-[120px]">{d.name}</span>
                  <span className="text-(--text2)">
                    {age === null ? t(lang, 'panel.devices.never') : formatAgo(lang, age)}
                  </span>
                  <span className="ml-auto text-(--muted)">
                    {d.queue !== null && d.queue > 0 ? t(lang, 'panel.devices.queue', { count: d.queue }) : (d.version ?? '')}
                  </span>
                </div>
              )
            })}
          </section>
          <section className={`${card} flex flex-col gap-2`}>
            <h2 className="m-0 text-[15px] font-semibold">{t(lang, 'panel.unattributed.title')}</h2>
            {ACCOUNTS.map((a) => {
              const kind = mainKinds[a]
              const share = kind === null ? null : unattributedShare(windowLine(data?.quota ?? [], a, kind), (data?.calib ?? []).filter((r) => r.account === a), from, Math.min(to, now))
              return (
                <div key={a} className="text-[13px] leading-5 text-(--text2)">
                  {share === null
                    ? `${name(a)}: ${t(lang, 'panel.unattributed.none')}`
                    : t(lang, 'panel.unattributed.body', {
                        account: name(a),
                        rise: Math.round(share.rise),
                        window: t(lang, kind === 'week' ? 'panel.window.week' : 'panel.window.session'),
                        explained: formatPercent(lang, Math.round(share.explained * 100))
                      })}
                </div>
              )
            })}
          </section>
        </div>
      </div>
    </div>
  )
}
