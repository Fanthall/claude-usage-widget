import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { drawTrayIcon } from './tray-icon'
import { shownData, FRESHNESS_NOTICE_MS, type NoticeTone } from './status-text'
import { LuAlignLeft, LuCircleDot, LuMinus, LuRefreshCw, LuX } from 'react-icons/lu'
import type { IconType } from 'react-icons'

import { FALLBACK_LANG, formatDuration, t, type Lang, type MessageKey } from '@shared/i18n'
import {
  isWidgetTheme,
  WIDGET_THEMES,
  type CliErrorKind,
  type StatePayload,
  type UsageStatus,
  type UsageWindow,
  type WidgetTheme
} from '@shared/types'

/**
 * Tasarim yonu "A · Tek odak" (kullanici karari 2026-09-05, prototip:
 * workspace/plan/claude-usage-widget/prototype/widget-konseptleri.html).
 *
 * Ortak dil: tek vurgu rengi yalnizca esik anlatir, tabular rakam, uc kademeli
 * tipografi. Renk TEK BASINA bilgi tasimaz — yuzde metni her zaman okunur.
 *
 * Kullaniciya gorunen her metin `@shared/i18n` sozlugunden gelir; dil
 * `payload.lang` ile sistemden secilir, kullaniciya secim sunulmaz.
 */

const THEME_META: Record<WidgetTheme, { key: MessageKey; icon: IconType }> = {
  focus: { key: 'view.focus', icon: LuCircleDot },
  list: { key: 'view.list', icon: LuAlignLeft },
  strip: { key: 'view.strip', icon: LuMinus }
}
/**
 * Anahtar surumu: gorunum adlari ve tasarim dili bastan degisti
 * (meter/dial -> focus/list/strip). Eski kayitli tercih yeni semada baska bir
 * seye isaret ediyordu; bir kez sifirlanip herkes varsayilan 'focus' ile baslar.
 */
const STORAGE_KEY = 'widget-theme-v2'

const TOOLBAR_GAP = 8
const STATUS_GAP = 6
/** Fit genişliğinin üst sınırı; ötesinde içerik sarmalanır. */
const MAX_FIT_WIDTH = 420

const LEVEL_COLOR = { normal: '#35c68f', caution: '#e0a33a', critical: '#e5544f' } as const
type Level = keyof typeof LEVEL_COLOR

function levelFor(percent: number): Level {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'caution'
  return 'normal'
}

/**
 * Kalan süre. `short` bir günden uzun süreyi yalnız **toplam saat** olarak yazar
 * (kullanıcı kararı): gün/tarih yerine "156 sa" hem kısa hem doğrudan okunur.
 *
 * Süre dolduysa `null` — geçmiş bir an "kaldı" diye yazılmaz.
 */
function timeLeft(lang: Lang, resetsAtMs: number | null, now: number, short = false): string | null {
  if (resetsAtMs === null) return null
  const left = resetsAtMs - now
  if (left <= 0) return null
  return formatDuration(lang, left, { short })
}

/**
 * BAŞLANGIÇ SAATİ GÖSTERİLMEZ. `/usage` yalnızca bitiş saatini veriyor;
 * başlangıcı pencere uzunluğu varsayarak üretmek yanlış veri doğurdu
 * (kullanıcı gözlemi 2026-09-05). Gerçek başlangıç ancak kendi tarihçemizde
 * yüzdenin düştüğü andan ölçülebilir — kanıta dayanır, varsayıma değil.
 *
 * Saat biçimi dile bağlıdır: Türkçe 24 saat okur, İngilizce 12 saat + AM/PM.
 * Bu bir yerel ayar farkı, çeviri değil; o yüzden sözlükte değil burada durur.
 */
const CLOCK_FORMAT: Record<Lang, { locale: string; options: Intl.DateTimeFormatOptions }> = {
  tr: { locale: 'tr-TR', options: { hour: '2-digit', minute: '2-digit' } },
  en: { locale: 'en-US', options: { hour: 'numeric', minute: '2-digit' } }
}

function clock(lang: Lang, ms: number): string {
  // Yalnizca saat. Tarih yazilmiyor (kullanici karari): yaninda kalan sure zaten
  // duruyor, "6 Eyl 08:00" gereksiz yer kapliyordu.
  const { locale, options } = CLOCK_FORMAT[lang]
  return new Date(ms).toLocaleTimeString(locale, options)
}

/**
 * "Current week (all models)" widget'a sığmaz; anlamı koruyarak kısaltılır.
 *
 * Parantez içindeki model adı (örn. "Fable") **çevrilmez** — ürün adıdır, dile
 * göre değişmez.
 */
function shortLabel(lang: Lang, label: string): string {
  const l = label.toLowerCase()
  if (l.includes('session')) return t(lang, 'window.session')
  if (l.includes('week')) {
    const inner = /\(([^)]+)\)/.exec(label)?.[1]
    if (inner !== undefined && !inner.toLowerCase().includes('all')) return inner
    return t(lang, 'window.week')
  }
  return label
}

/**
 * Odaktaki pencere: **her zaman oturum**.
 *
 * Önce "yüzdesi en yüksek olan" seçiliyordu; oturum sıfırlanıp haftalık öne
 * geçince büyük sayının kimliği kendiliğinden değişiyor ve widget başka bir şey
 * anlatmaya başlıyordu. Odak sabit olmalı: dakikalık işi kesen pencere oturum
 * penceresidir, haftalık arka plandaki sınırdır.
 *
 * Oturum penceresi gelmezse ilk pencereye düşülür — uydurma yapılmaz.
 */
function primaryWindow(windows: UsageWindow[]): UsageWindow | null {
  const session = windows.find((w) => /session/i.test(w.label))
  return session ?? windows[0] ?? null
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

// ── Ortak parçalar ───────────────────────────────────────────────────────────

function Bar({
  percent,
  motion,
  muted = false
}: {
  percent: number
  motion: boolean
  muted?: boolean
}): React.ReactElement {
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-sm bg-[#2a2a31]">
      <span
        className={`block h-full rounded-sm ${motion ? 'transition-[width] duration-300' : ''}`}
        style={{
          width: `${Math.max(2, Math.min(100, percent))}%`,
          background: muted ? '#3a3a44' : LEVEL_COLOR[levelFor(percent)]
        }}
      />
    </span>
  )
}

/** Sıfırlanma zamanı + kalan süre — çıktının gerçekten verdiği tek zaman bilgisi. */
function resetText(lang: Lang, w: UsageWindow, now: number): string {
  if (w.resetsAtMs === null) return '—'
  return timeLeft(lang, w.resetsAtMs, now, true) ?? clock(lang, w.resetsAtMs)
}

// ── A · Tek odak (varsayılan) ────────────────────────────────────────────────

function FocusView({
  lang,
  windows,
  now,
  motion
}: {
  lang: Lang
  windows: UsageWindow[]
  now: number
  motion: boolean
}): React.ReactElement {
  const main = primaryWindow(windows)
  if (main === null) {
    return <div className="text-[11px] text-[#6b6b74]">{t(lang, 'state.noData')}</div>
  }
  const rest = windows.filter((w) => w.label !== main.label)
  const left = timeLeft(lang, main.resetsAtMs, now)

  return (
    <div className="w-max min-w-[184px]">
      <div className="text-[10px] tracking-[0.09em] text-[#6b6b74] uppercase">
        {shortLabel(lang, main.label)}
      </div>

      <div className="mt-[7px] mb-[9px] text-[40px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
        {main.percent}
        <span className="ml-px text-[17px] font-medium text-[#a1a1aa]">%</span>
      </div>

      <Bar percent={main.percent} motion={motion} />

      <div className="mt-2 text-[10.5px] tabular-nums text-[#6b6b74]">
        {main.resetsAtMs === null
          ? t(lang, 'reset.unknown')
          : `${t(lang, 'reset.at', { time: clock(lang, main.resetsAtMs) })}${
              left === null ? '' : ` · ${t(lang, 'reset.left', { left })}`
            }`}
      </div>

      {rest.length === 0 ? null : (
        <div className="mt-3 flex gap-[14px] border-t border-[#1e1e23] pt-[10px]">
          {rest.map((w) => (
            <div key={w.label} className="flex flex-col gap-[3px]">
              <span className="text-[9.5px] tracking-[0.07em] text-[#6b6b74] uppercase">
                {shortLabel(lang, w.label)}
              </span>
              <span
                className="text-[13px] font-semibold tabular-nums"
                style={{ color: w.percent === 0 ? '#a1a1aa' : undefined }}
              >
                {w.percent}
                <span className="text-[10px] font-normal text-[#6b6b74]">%</span>
              </span>
              <span className="text-[9.5px] whitespace-nowrap tabular-nums text-[#6b6b74]">
                {timeLeft(lang, w.resetsAtMs, now, true) ?? '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── B · Satır listesi ────────────────────────────────────────────────────────

function ListView({
  lang,
  windows,
  now,
  motion
}: {
  lang: Lang
  windows: UsageWindow[]
  now: number
  motion: boolean
}): React.ReactElement {
  return (
    <div className="w-max min-w-[190px]">
      {windows.map((w, i) => (
        <div
          key={w.label}
          className={`grid grid-cols-[1fr_auto] gap-x-2 gap-y-[3px] py-[7px] ${
            i === 0 ? '' : 'border-t border-[#1e1e23]'
          }`}
        >
          <div className="text-[11.5px] whitespace-nowrap text-[#f4f4f5]">
            {shortLabel(lang, w.label)}
          </div>
          <div
            className="text-right text-[13.5px] font-semibold tabular-nums"
            style={{ color: w.percent === 0 ? '#a1a1aa' : undefined }}
          >
            {w.percent}%
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <span className="min-w-[70px] flex-1">
              <Bar percent={w.percent} motion={motion} muted={w.percent === 0} />
            </span>
            <span className="text-[9.5px] whitespace-nowrap tabular-nums text-[#6b6b74]">
              {resetText(lang, w, now)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── D · Şerit ────────────────────────────────────────────────────────────────

function StripView({
  lang,
  windows,
  now
}: {
  lang: Lang
  windows: UsageWindow[]
  now: number
}): React.ReactElement {
  return (
    <div className="w-max space-y-[7px]">
      {windows.map((w) => (
        <div key={w.label} className="flex items-baseline gap-[7px]">
          <span
            className="h-1.5 w-1.5 shrink-0 -translate-y-px rounded-full"
            style={{ background: w.percent === 0 ? '#3a3a44' : LEVEL_COLOR[levelFor(w.percent)] }}
            aria-hidden
          />
          <span
            className="min-w-[34px] text-[15px] font-semibold tabular-nums"
            style={{ color: w.percent === 0 ? '#a1a1aa' : undefined }}
          >
            {w.percent}%
          </span>
          <span className="flex-1 text-[10px] whitespace-nowrap text-[#a1a1aa]">
            {shortLabel(lang, w.label)}
          </span>
          <span className="text-[9.5px] whitespace-nowrap tabular-nums text-[#6b6b74]">
            {resetText(lang, w, now)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Araç çubuğu ──────────────────────────────────────────────────────────────

function IconButton({
  icon: Icon,
  label,
  active = false,
  spinning = false,
  danger = false,
  onClick
}: {
  icon: IconType
  label: string
  active?: boolean
  spinning?: boolean
  /** Kapatma gibi geri dönüşü olan ama sonuç doğuran eylem: üzerine gelince uyarır. */
  danger?: boolean
  onClick: () => void
}): React.ReactElement {
  const tone = active
    ? 'bg-[#26262e] text-[#f4f4f5]'
    : danger
      ? 'text-[#6b6b74] hover:bg-[#3a1f21] hover:text-[#e5544f]'
      : 'text-[#6b6b74] hover:bg-[#1f1f25] hover:text-[#a1a1aa]'
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-5 w-5 place-items-center rounded-[5px] transition-colors ${tone}`}
    >
      <Icon size={12} className={spinning ? 'animate-spin' : undefined} />
    </button>
  )
}

function Toolbar({
  ref,
  lang,
  theme,
  onTheme,
  onRefresh,
  refreshing,
  trayAvailable
}: {
  ref: React.Ref<HTMLDivElement>
  lang: Lang
  theme: WidgetTheme
  onTheme: (next: WidgetTheme) => void
  onRefresh: () => void
  refreshing: boolean
  trayAvailable: boolean
}): React.ReactElement {
  return (
    // `w-max ml-auto`: sağa yaslanır ama genişliği içeriği kadardır. `justify-end`
    // ile blok seviyesinde tam genişlik kaplıyordu ve fit ölçümü onu okuyup
    // pencereyi hiç daraltamıyordu.
    <div
      ref={ref}
      className="ml-auto flex w-max shrink-0 items-center gap-[2px]"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {WIDGET_THEMES.map((view) => (
        <IconButton
          key={view}
          icon={THEME_META[view].icon}
          label={t(lang, 'view.suffix', { view: t(lang, THEME_META[view].key) })}
          active={view === theme}
          onClick={() => onTheme(view)}
        />
      ))}
      <span className="mx-[3px] h-3 w-px bg-[#26262c]" aria-hidden />
      <IconButton
        icon={LuRefreshCw}
        label={t(lang, refreshing ? 'action.measuring' : 'action.measureNow')}
        spinning={refreshing}
        onClick={onRefresh}
      />
      <IconButton
        icon={LuX}
        label={t(lang, trayAvailable ? 'action.hideToTray' : 'action.close')}
        danger
        onClick={() => void window.usageApi.close()}
      />
    </div>
  )
}

// ── Verinin yaşı ─────────────────────────────────────────────────────────────

/** Türkçe birimi boşlukla ayırır, İngilizce bitişik yazar — `formatDuration` ile aynı. */
const UNIT_SEP: Record<Lang, string> = { tr: ' ', en: '' }

/**
 * Yaşın çıplak süresi — "önce" / "ago" eki **eklenmez**.
 *
 * `measured.ago` ve `state.stale` şablonları o eki kendileri taşıyor; `formatAgo`
 * da taşıyor. İkisini birleştirmek Türkçede "5 dk önce önce ölçüldü" üretirdi.
 * Bir dakikanın altında `formatDuration` "0 dk" derdi; saniyelik bir değeri
 * "0 dk" diye göstermek onu olduğundan eski gösterir, o yüzden saniye yazılır.
 */
function ageAmount(lang: Lang, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}${UNIT_SEP[lang]}${t(lang, 'unit.second')}`
  return formatDuration(lang, ms)
}

/**
 * Sayının hemen üstünde duran tazelik satırı.
 *
 * Gövdenin içinde, **değerlerden önce** çizilir: kullanıcı yüzdeye bakarken
 * yaşı da görür, ayrıca aramaz. Üç görünümün de üstünde olduğu için odak/liste/
 * şerit aynı şeyi söyler.
 *
 * Durum `ok` olsa bile yaş eşiği aşılınca satır çıkar: bayat bir değer güncel
 * gibi görünmemeli. Değerin kendisi soluklaştırılır ama bu satır **tam opak**
 * kalır — uyarı, uyardığı şeyle birlikte solmamalı.
 */
function DataAge({
  lang,
  status,
  now
}: {
  lang: Lang
  status: UsageStatus
  now: number
}): React.ReactElement | null {
  const { at, fresh } = shownData(status)
  if (at === null) return null
  const age = Math.max(0, now - at)
  // Güncel ve yeni ölçümde satır çizilmez: her zaman görünen bir "0 sn önce"
  // gürültü olur, dikkat çekmesi gereken durumda da fark edilmez.
  if (fresh && age < FRESHNESS_NOTICE_MS) return null

  const amount = ageAmount(lang, age)
  // Bayatlığı renk değil METİN söyler; renk tek başına bilgi taşımaz.
  const text = fresh
    ? t(lang, 'measured.ago', { age: amount })
    : t(lang, 'state.stale', { age: amount })

  // Renk: ikincil metin tonu (#6b6b74) bu satır için fazla sessiz — 9,5 px'te
  // zemine karşı ~3,4:1 kontrast veriyor ve tam da fark edilmesi gereken bilgi
  // gözden kaçıyor. #a1a1aa ~7:1 ile okunur, sayının önüne de geçmez.
  return (
    <div
      className={`mb-[7px] flex items-center gap-[5px] text-[9.5px] tabular-nums ${
        fresh ? 'text-[#a1a1aa]' : 'text-[#e0a33a]'
      }`}
    >
      {fresh ? null : <span className="h-1 w-1 shrink-0 rounded-full bg-[#e0a33a]" aria-hidden />}
      <span className="whitespace-nowrap">{text}</span>
    </div>
  )
}

// ── Durum satırı: her durum kendi metnini söyler (REQ-10) ────────────────────

const TONE_COLOR: Record<NoticeTone, string> = {
  info: 'text-[#a1a1aa]',
  wait: 'text-[#e0a33a]',
  error: 'text-[#e5544f]'
}

interface StatusMessage {
  text: string
  tone: NoticeTone
  /** Üst üste deneme sayısı gösterilsin mi. */
  showStreak: boolean
}

const ERROR_KEY: Record<CliErrorKind, MessageKey> = {
  'not-found': 'error.notFound',
  'not-logged-in': 'error.notLoggedIn',
  timeout: 'error.timeout',
  'bad-output': 'error.badOutput',
  'rate-limited': 'error.rateLimited',
  unknown: 'error.unknown'
}

/**
 * Hata sınıfına göre ayrı metin; tek genel "hata" yazılmaz (REQ-10 AC2).
 * Kullanıcının atacağı adım sınıftan sınıfa değişir.
 */
function errorMessage(lang: Lang, kind: CliErrorKind, message: string): StatusMessage {
  if (kind === 'rate-limited') {
    // Kırılan bir şey yok: uç bizi bekletiyor, sınır açılınca ölçüm kendiliğinden
    // döner. "Hata" demek kullanıcıyı gereksiz müdahaleye iter. Aynı nedenle
    // streak sayacı da gizlenir — geri çekilme sırasında tekrar denemek beklenen
    // davranıştır, "(5x)" büyüyen bir arıza gibi okunur.
    return { text: t(lang, 'error.rateLimited'), tone: 'wait', showStreak: false }
  }
  // Sınıflandırılamayan hatada uçtan gelen metin taşınır: bu çeviri değil, tanı
  // verisidir. Boşsa sözlükteki genel karşılığa düşülür.
  const detail = message.trim()
  const text = kind === 'unknown' && detail !== '' ? detail : t(lang, ERROR_KEY[kind])
  return { text, tone: 'error', showStreak: true }
}

/** Alt satırda duran durum metni. Söylenecek bir şey yoksa satır hiç çizilmez. */
function statusMessage(lang: Lang, status: UsageStatus): StatusMessage | null {
  switch (status.kind) {
    case 'ok':
      return null
    case 'stale':
      // Bayatlığı ve yaşı üstteki tazelik satırı zaten söylüyor; burada tekrar
      // edilmez — aynı bilgiyi iki kez yazmak ikisini de zayıflatır.
      return null
    case 'loading':
      return { text: t(lang, 'state.measuring'), tone: 'info', showStreak: false }
    case 'no-data':
      return { text: t(lang, 'state.noMeasureYet'), tone: 'info', showStreak: false }
    case 'error':
      return errorMessage(lang, status.errorKind, status.message)
  }
}

function StatusLine({
  lang,
  status,
  streak
}: {
  lang: Lang
  status: UsageStatus
  streak: number
}): React.ReactElement | null {
  const notice = statusMessage(lang, status)
  if (notice === null) return null
  const text = notice.showStreak && streak > 1 ? `${notice.text} (${streak}x)` : notice.text
  return (
    // İki satıra kadar sarmalanır, sonra kırpılır: uzun metnin ikinci yarısı tek
    // satırlık kırpmada kayboluyordu. Tamamı `title` içinde durur.
    <div
      role="status"
      className={`mt-1.5 line-clamp-2 text-[10px] ${TONE_COLOR[notice.tone]}`}
      title={text}
    >
      {text}
    </div>
  )
}

function readTheme(): WidgetTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isWidgetTheme(saved)) return saved
  } catch {
    // Depolama kapalı olabilir; varsayılana düşeriz.
  }
  return 'focus'
}

export function Widget(): React.ReactElement {
  const [payload, setPayload] = useState<StatePayload | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [theme, setThemeState] = useState<WidgetTheme>(readTheme)
  const [refreshing, setRefreshing] = useState(false)
  const motion = !useReducedMotion()

  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)

  /**
   * Pencerenin alt sınırı sabit sayı değil, **çizilen içeriğin ölçülmüş boyutu**.
   * Ölçüm kutusu `w-max`: genişliği içeriğine eşit, konteynere değil — yoksa
   * ölçüm kendi kendini besler ve pencere hiç daralmaz.
   */
  const reportFit = useCallback(() => {
    const root = rootRef.current
    const body = bodyRef.current
    if (root === null || body === null) return
    const cs = getComputedStyle(root)
    const padX =
      parseFloat(cs.paddingLeft) +
      parseFloat(cs.paddingRight) +
      parseFloat(cs.borderLeftWidth) +
      parseFloat(cs.borderRightWidth)
    const padY =
      parseFloat(cs.paddingTop) +
      parseFloat(cs.paddingBottom) +
      parseFloat(cs.borderTopWidth) +
      parseFloat(cs.borderBottomWidth)

    const toolbar = toolbarRef.current
    const status = statusRef.current
    const toolbarH = toolbar === null ? 0 : toolbar.offsetHeight + TOOLBAR_GAP
    // Durum satırı çizilmediğinde boşluk da eklenmez.
    const statusH =
      status === null || status.offsetHeight === 0 ? 0 : status.offsetHeight + STATUS_GAP

    const contentWidth = Math.min(body.offsetWidth, MAX_FIT_WIDTH)
    const width = Math.max(contentWidth, toolbar?.offsetWidth ?? 0) + padX
    const height = body.scrollHeight + toolbarH + statusH + padY
    void window.usageApi.fitToContent(width, height)
  }, [])

  useLayoutEffect(() => {
    reportFit()
    const body = bodyRef.current
    if (body === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => reportFit())
    ro.observe(body)
    return () => ro.disconnect()
  })

  useEffect(() => {
    void window.usageApi.get().then(setPayload)
    const off = window.usageApi.onState(setPayload)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(tick)
    }
  }, [])

  // Tepsi ikonu gercek fontla renderer'da cizilir; durum degistikce yenilenir.
  //
  // macOS haric: orada tepsi metin etiketini destekliyor ve ana surec yuzdeyi
  // zaten `setTitle` ile yaziyor. Ikona da cizersek ayni sayi menu cubugunda
  // yan yana IKI KEZ gorunur. Ikonu gondermeyince ana surec de canvas moduna
  // gecmez, sade ikon + metin kalir.
  useEffect(() => {
    if (payload === null) return
    if (window.usageApi.platform === 'darwin') return
    const dataUrl = drawTrayIcon(payload.status)
    if (dataUrl !== null) window.usageApi.setTrayIcon(dataUrl)
  }, [payload])

  // Alt sınır görünüme göre değişir; ana süreç bunu bilmeli.
  useEffect(() => {
    void window.usageApi.setTheme(theme)
  }, [theme])

  function selectTheme(next: WidgetTheme): void {
    setThemeState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Kalıcı yazılamazsa seçim yalnız bu oturumda geçerli olur.
    }
  }

  function refresh(): void {
    if (refreshing) return
    setRefreshing(true)
    void window.usageApi
      .refresh()
      .then(setPayload)
      .finally(() => setRefreshing(false))
  }

  /** Elle sürükleme — OS taşıma işlemi başlamaz, Windows snap tetiklenmez. */
  // Wayland'da elle surukleme calismaz (setPosition desteklenmiyor); orada
  // tasimayi compositor yapar. Diger platformlarda elle surukleme kalir —
  // CSS surukleme Windows Snap Layouts'u tetikliyor.
  const cssDrag = window.usageApi.dragMode === 'css'

  function startDrag(event: React.MouseEvent<HTMLDivElement>): void {
    if (cssDrag) return
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button') !== null) return
    event.preventDefault()
    window.usageApi.dragStart()
    const onMove = (): void => window.usageApi.dragMove()
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.usageApi.dragEnd()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Payload gelmeden once de bir dile ihtiyac var; sozlugun varsayilanina duselir.
  const lang: Lang = payload?.lang ?? FALLBACK_LANG

  /**
   * Belgenin dili secilen dile ayarlanir.
   *
   * CSS `text-transform: uppercase` yerel-duyarlidir: belge Turkce isaretliyken
   * Ingilizce "Session" metni "SESSİON" olarak buyur (noktali İ). Etiket
   * buyuk harfe cevrildigi icin bu ekranda dogrudan gorunur.
   */
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const status: UsageStatus = payload?.status ?? { kind: 'loading' }
  const { windows, fresh } = shownData(status)

  return (
    <div
      ref={rootRef}
      onMouseDown={startDrag}
      className="flex h-screen w-screen flex-col overflow-hidden rounded-[10px] border border-[#26262c] bg-[#16161a] px-[14px] pt-3 pb-[13px] text-[#f4f4f5] select-none"
      style={cssDrag ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <Toolbar
        ref={toolbarRef}
        lang={lang}
        theme={theme}
        onTheme={selectTheme}
        onRefresh={refresh}
        refreshing={refreshing}
        trayAvailable={payload?.trayAvailable ?? true}
      />

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ marginTop: TOOLBAR_GAP }}>
        {/* Ölçüm bu kutudan alınır; `w-max` şart. */}
        <div ref={bodyRef} className="w-max">
          <DataAge lang={lang} status={status} now={now} />
          {/* Soluklaştırma yalnızca DEĞERLERE uygulanır — tazelik satırı tam
              opak kalsın diye. Renk zaten tek başına yeterli değil; eski değeri
              asıl anlatan, üstteki bayatlık satırıdır. */}
          <div className={fresh ? '' : 'opacity-60'}>
            {windows.length === 0 ? (
              <div className="text-[11px] text-[#a1a1aa]">
                {t(lang, status.kind === 'loading' ? 'state.firstMeasure' : 'state.noData')}
              </div>
            ) : theme === 'focus' ? (
              <FocusView lang={lang} windows={windows} now={now} motion={motion} />
            ) : theme === 'list' ? (
              <ListView lang={lang} windows={windows} now={now} motion={motion} />
            ) : (
              <StripView lang={lang} windows={windows} now={now} />
            )}
          </div>
        </div>
      </div>

      {/* Boşluk StatusLine'ın kendi içinde; metin gerekmiyorsa hiç çizilmez ve
          hayalet boşluk oluşmaz. */}
      <div ref={statusRef} className="shrink-0">
        <StatusLine lang={lang} status={status} streak={payload?.errorStreak ?? 0} />
      </div>
    </div>
  )
}
