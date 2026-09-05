/**
 * Sistem cubugu gostergesi adaptoru (REQ-3).
 *
 * Platform yetenekleri esit degildir ve eksik yetenek TAKLIT EDILMEZ
 * (design-notes.md > Platform Yetenek Matrisi). Modul dort parcaya ayrilir:
 *   1. yetenek tespiti (saf)
 *   2. durum metinleri + tooltip butcesi (saf)
 *   3. ikon piksel uretimi (saf, Electron'a bagimli degil)
 *   4. karar + uygulama (yan etki yalniz `applyIndicator` icinde)
 *
 * Gosterge `UsageStatus` konusur, ciplak `UsageSnapshot` degil: olcum
 * basarisiz oldugunda da bir karar uretilir, boylece ekranda eski yuzde
 * oldugu gibi kalmaz.
 *
 * Kullaniciya gorunen her metin `shared/i18n` sozlugunden gelir; modul kendi
 * dil sabitini tutmaz. Dil disaridan `lang` ile verilir, verilmezse
 * `FALLBACK_LANG` kullanilir — bilinmeyen dilde sessizce Turkce'ye dusulmez.
 */

import type {
  CliErrorKind,
  SupportedPlatform,
  TrayCapabilities,
  UsageSnapshot,
  UsageStatus,
  UsageWindow
} from '../../shared/types'
import { FALLBACK_LANG, formatAgo, formatDuration, t, type Lang } from '../../shared/i18n'

// ── Yetenek tespiti ──────────────────────────────────────────────────────────

/**
 * Tepsinin gercek durumu — ikili degil UC durumlu.
 *
 * En tehlikeli hal "var" ile "yok" arasindadir: stock GNOME'da `new Tray()`
 * THROW ETMEZ, nesne kurulur ve ikon hicbir yerde cizilmez. `try/catch` bunu
 * goremez. Ikili bir bayrakla bu durum "var" tarafina duser; widget gizlenir ve
 * kullanicinin geri getirecek yuzeyi kalmaz — geri donusu olmayan bir kilit.
 */
export type TrayPresence =
  /** Ikonun cizildigi platform/masaustu biliniyor. */
  | 'confirmed'
  /** Nesne kuruldu ama cizildigi DOGRULANAMADI (tipik: GNOME, eklenti yok). */
  | 'unverified'
  /** Tepsi hic kurulamadi. */
  | 'absent'

/** `process.env`in bu modulun okudugu alani; testte duz nesne verilir. */
export interface DesktopEnv {
  readonly XDG_CURRENT_DESKTOP?: string | undefined
  readonly DESKTOP_SESSION?: string | undefined
}

/**
 * Tepsi ikonunu kendi kabuguyla cizdigi bilinen masaustleri.
 *
 * Liste bilerek DAR: burada olmayan her masaustu `unverified` doner. Yanlis
 * "confirmed" kullaniciyi kilitler, yanlis "unverified" yalnizca bir onay
 * adimi ekler — maliyetler esit degil, supheli taraf ucuz olan taraftir.
 * GNOME kasten disaridadir: tepsi ancak ucuncu-parti eklentiyle cizilir ve
 * eklentinin varligi surec icinden okunamaz.
 */
const KNOWN_TRAY_HOSTS: ReadonlySet<string> = new Set([
  'kde',
  'plasma',
  'xfce',
  'lxqt',
  'lxde',
  'cinnamon',
  'mate',
  'budgie',
  'unity',
  'pantheon',
  'deepin',
  'trinity'
])

/** Masaustu kimligini token'lara ayirir: "ubuntu:GNOME" → ['ubuntu','gnome']. */
function desktopTokens(env: DesktopEnv): string[] {
  return `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`
    .toLowerCase()
    .split(/[:;,\s]+/)
    .filter((token) => token !== '')
}

/** Linux masaustunun tepsi cizip cizmedigini ortam degiskenlerinden siniflar. */
export function classifyLinuxTrayHost(env: DesktopEnv): TrayPresence {
  const tokens = desktopTokens(env)
  return tokens.some((token) => KNOWN_TRAY_HOSTS.has(token)) ? 'confirmed' : 'unverified'
}

/**
 * Tepsi durumunu olcer. `trayCreated` cagiranin GERCEKTEN denedigi sonuctur
 * (`new Tray()` bir nesne dondurdu mu); varsayilmaz.
 */
export function probeTrayPresence(
  platform: SupportedPlatform,
  trayCreated: boolean,
  env: DesktopEnv = {}
): TrayPresence {
  if (!trayCreated) return 'absent'
  if (platform === 'linux') return classifyLinuxTrayHost(env)
  return 'confirmed'
}

/**
 * Calisma anindan gelen gercek durum. Varsayilani YOKTUR: `trayPresence`
 * zorunludur, cunku "olculmedi" ile "var" ayni sey degildir.
 */
export interface CapabilityProbe {
  /** Olculmus tepsi durumu; `probeTrayPresence` ile uretilir. */
  trayPresence: TrayPresence
  /** Linux masaustu cubukta metin gosterebiliyor mu. */
  desktopSupportsLabel?: boolean
}

/**
 * `TrayCapabilities`in olcum guvenilirligiyle genisletilmis hali.
 *
 * `TrayCapabilities`i genisletir, degistirmez: yalnizca `trayIcon` bakan mevcut
 * kod aynen calisir, gizleme karari verecek olan taraf `canHideWidget` okur.
 */
export interface TrayAssurance extends TrayCapabilities {
  presence: TrayPresence
  /**
   * Widget guvenle gizlenebilir mi. Yalniz `confirmed`de true — gizlemenin geri
   * donusu tepsi menusudur; menu gorunmuyorsa geri donus de yoktur.
   */
  canHideWidget: boolean
}

/** Yetenek nesnesi olcum guvenilirligini tasiyor mu. */
export function isTrayAssurance(caps: TrayCapabilities): caps is TrayAssurance {
  return 'presence' in caps && 'canHideWidget' in caps
}

/** Platform basina tray yetenekleri. Bilinmeyen yetenek false doner, uydurulmaz. */
export function detectCapabilities(
  platform: SupportedPlatform,
  probe: CapabilityProbe
): TrayAssurance {
  const presence = probe.trayPresence
  // `unverified`de ikon YINE cizilir: gorunurse kullanici kazanir, gorunmezse
  // kaybedilen bir sey yok. Riskli olan cizim degil, widget'i gizlemektir.
  const trayIcon = presence !== 'absent'
  const canHideWidget = presence === 'confirmed'

  switch (platform) {
    case 'darwin':
      // Menu bar ogesi metin gosterir (tray.setTitle), dock ilerleme cubugu var.
      return { textLabel: trayIcon, trayIcon, progressBar: true, presence, canHideWidget }
    case 'win32':
      // Cubukta metin yok; yuzde ikonun uzerine cizilir. Gorev cubugunda ilerleme var.
      return { textLabel: false, trayIcon, progressBar: true, presence, canHideWidget }
    case 'linux':
      // Tray bazi masaustlerinde hic olusmaz; ilerleme cubugu yalniz bazi shell'lerde.
      return {
        textLabel: trayIcon && (probe.desktopSupportsLabel ?? false),
        trayIcon,
        progressBar: false,
        presence,
        canHideWidget
      }
  }
}

/** Gizleme karari: guvenli / onay iste / hic sunma. */
export type HideWidgetSafety = 'safe' | 'confirm' | 'blocked'

/**
 * Widget gizleme guvenligi.
 *
 * `confirm` bilerek "yasak" degil: eklentili bir GNOME'da tepsi calisiyor
 * olabilir ve kullaniciyi engellemek de bir kayiptir. Karar kullanicinin, ama
 * geri donusu olmayan adim sessizce atilmaz.
 */
export function hideWidgetSafetyFor(presence: TrayPresence): HideWidgetSafety {
  switch (presence) {
    case 'confirmed':
      return 'safe'
    case 'unverified':
      return 'confirm'
    case 'absent':
      return 'blocked'
  }
}

/** Tepsi belirsizliginin tek satirlik ozeti; `confirmed`de bos. */
export function trayPresenceNote(lang: Lang, presence: TrayPresence): string {
  switch (presence) {
    case 'confirmed':
      return ''
    case 'unverified':
      return t(lang, 'tray.iconUnverified')
    case 'absent':
      return t(lang, 'tray.iconMissing')
  }
}

/** `process.platform` gibi genis bir degeri desteklenen platforma daraltir. */
export function toSupportedPlatform(value: string): SupportedPlatform | null {
  return value === 'win32' || value === 'darwin' || value === 'linux' ? value : null
}

// ── Esikler ──────────────────────────────────────────────────────────────────

/** Kullanim esigi: normal / dikkat / kritik. */
export type UsageLevel = 'normal' | 'caution' | 'critical'

/** Bu yuzdeden itibaren "dikkat". */
export const CAUTION_PERCENT = 75
/** Bu yuzdeden itibaren "kritik" (REQ-2: %90 ustu uyari rengi). */
export const CRITICAL_PERCENT = 90

export function levelFor(percent: number): UsageLevel {
  if (percent >= CRITICAL_PERCENT) return 'critical'
  if (percent >= CAUTION_PERCENT) return 'caution'
  return 'normal'
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

// ── Durum metinleri ──────────────────────────────────────────────────────────

/**
 * Hata sinifina gore ayri metin. Tek genel "hata" yazilmaz: kullanicinin atacagi
 * adim siniftan sinifa degisir (REQ-10 AC2).
 */
export function errorText(lang: Lang, kind: CliErrorKind): string {
  switch (kind) {
    case 'not-found':
      return t(lang, 'error.notFound')
    case 'not-logged-in':
      return t(lang, 'error.notLoggedIn')
    case 'timeout':
      return t(lang, 'error.timeout')
    case 'bad-output':
      return t(lang, 'error.badOutput')
    case 'rate-limited':
      // Kullaniciya ne yapacagini soyler: bu kendiliginden gecer, mudahale gerekmez.
      return t(lang, 'error.rateLimited')
    case 'unknown':
      return t(lang, 'error.unknown')
  }
}

/** Ikonun uzerine cizilen durum isareti. */
export type IconBadge = 'stale' | 'error'

/** Durumun gosterge icin sadelestirilmis hali. */
interface StatusView {
  kind: UsageStatus['kind']
  /** Gosterilecek olcum; hic yoksa null. */
  snapshot: UsageSnapshot | null
  /** Gosterilen deger guncel degil. */
  stale: boolean
  badge: IconBadge | null
  /** Gosterilen olcumun yasi; bilinmiyorsa null. */
  ageMs: number | null
  /** Durumu anlatan tek satir; `ok` icin bos. */
  summary: string
}

function viewOf(status: UsageStatus, now: number, lang: Lang): StatusView {
  switch (status.kind) {
    case 'loading':
      return {
        kind: 'loading',
        snapshot: null,
        stale: false,
        badge: null,
        ageMs: null,
        summary: t(lang, 'state.measuring')
      }
    case 'no-data':
      return {
        kind: 'no-data',
        snapshot: null,
        stale: false,
        badge: null,
        ageMs: null,
        summary: t(lang, 'state.noMeasureYet')
      }
    case 'ok':
      return {
        kind: 'ok',
        snapshot: status.snapshot,
        stale: false,
        badge: null,
        ageMs: null,
        summary: ''
      }
    case 'stale':
      return {
        kind: 'stale',
        snapshot: status.snapshot,
        stale: true,
        badge: 'stale',
        ageMs: status.ageMs,
        // Bayatligi renk degil METIN soyler; renk tek basina bilgi tasimaz.
        // `state.stale` sablonu "önce/ago" edatini kendi tasir, bu yuzden yasa
        // `formatAgo` degil ciplak sure (`formatDuration`) girer.
        summary: t(lang, 'state.stale', {
          age: formatDuration(lang, status.ageMs, { short: true })
        })
      }
    case 'error': {
      const last = status.lastSnapshot
      const age = last === null ? null : Math.max(0, now - last.at)
      const base = errorText(lang, status.errorKind)
      return {
        kind: 'error',
        snapshot: last,
        stale: last !== null,
        badge: 'error',
        ageMs: age,
        // Gosterilen sayi hatadan ONCEKI olcumdur; yasi yaninda durmazsa guncel sanilir.
        summary: age === null ? base : `${base} · ${formatAgo(lang, age)}`
      }
    }
  }
}

/** Durumun tek satirlik ozeti. `ok` icin bos doner — anlatacak bir sey yok. */
export function statusSummary(
  status: UsageStatus,
  lang: Lang,
  now: number = Date.now()
): string {
  return viewOf(status, now, lang).summary
}

// ── Tooltip butcesi ──────────────────────────────────────────────────────────

/** Windows tray tooltip'i bu uzunlukta kirpilir. */
export const MAX_TOOLTIP_LENGTH = 127

/** Kirpilmis etiketin okunur kalmasi icin gereken en az karakter. */
const MIN_LABEL_CHARS = 4

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function blockLength(lines: readonly string[]): number {
  if (lines.length === 0) return 0
  return lines.reduce((n, line) => n + line.length, 0) + lines.length - 1
}

/**
 * Tooltip'i oncelik sirasina gore kurar: **yuzdeler > durum > anomali > ayrinti**.
 *
 * Windows tooltip'i 127 karakterde kesildigi icin blok tek parca halinde sondan
 * kirpilamaz — oyle yapildiginda son pencere bastan kaybolur ve uyari metni
 * cumle ortasindan kesilir. Bunun yerine ayrinti kademe kademe dusurulur: once
 * sifirlanma saatleri, sonra etiket uzunlugu, sonra anomali satiri, en son
 * etiketlerin tamami. Yuzdeler hicbir kademede dusmez — butun pencereler gorunur.
 *
 * Butce her dilde ayni: 127 karakter metnin dili degisince degismez, bu yuzden
 * kademeler TR ve EN metinlerle ayri ayri dogrulanir.
 */
function buildTooltip(view: StatusView, presence: TrayPresence, lang: Lang): string {
  const windows = view.snapshot?.windows ?? []
  const unparsedCount = view.snapshot?.unparsedLines.length ?? 0
  // Okunamayan satirlar sessizce dusurulmez (REQ-10); sayi parantezde durur.
  const anomaly = unparsedCount > 0 ? `${t(lang, 'error.badOutput')} (${unparsedCount})` : ''
  // Tepsi belirsizligi kurulum notudur; kota degerinden sonra gelir ve butce
  // daralinca anomali satiriyla birlikte ilk dusen kademede dusulur.
  const trayNote = trayPresenceNote(lang, presence)

  const tail = (withAnomaly: boolean): string[] => {
    const out: string[] = []
    if (view.summary !== '') out.push(view.summary)
    if (withAnomaly && anomaly !== '') out.push(anomaly)
    if (withAnomaly && trayNote !== '') out.push(trayNote)
    return out
  }

  if (windows.length === 0) {
    const lines = tail(true)
    if (lines.length === 0) return t(lang, 'tray.noData')
    return clip(lines.join('\n'), MAX_TOOLTIP_LENGTH)
  }

  const percents = windows.map((w) => clampPercent(w.percent))
  const valueOf = (w: UsageWindow): string => `${clampPercent(w.percent)}%`

  /** Etiketleri verilen genislige kirparak blok kurar. */
  const clipped = (labelBudget: number, withAnomaly: boolean): string =>
    [
      ...windows.map((w) => `${clip(w.label, labelBudget)}: ${valueOf(w)}`),
      ...tail(withAnomaly)
    ].join('\n')

  /** Etiketlerin sigmasi icin kalan butceyi pencerelere esit boler. */
  const labelBudgetFor = (withAnomaly: boolean): number => {
    const lines = tail(withAnomaly)
    const fixed = windows.reduce((n, w) => n + valueOf(w).length + 2, 0)
    const separators = windows.length + lines.length - 1
    const available = MAX_TOOLTIP_LENGTH - fixed - separators - blockLength(lines)
    return Math.floor(available / windows.length)
  }

  const candidates: string[] = [
    // Kademe 0 — tam ayrinti.
    [...windows.map((w) => `${w.label}: ${valueOf(w)} · ${w.resetsAtRaw}`), ...tail(true)].join(
      '\n'
    ),
    // Kademe 1 — sifirlanma saatleri dusuruldu.
    [...windows.map((w) => `${w.label}: ${valueOf(w)}`), ...tail(true)].join('\n'),
    // Kademe 2 — etiketler ortak butceye kirpildi.
    clipped(Math.max(MIN_LABEL_CHARS, labelBudgetFor(true)), true),
    // Kademe 3 — anomali satiri dusuruldu, etiket butcesi yeniden hesaplandi.
    clipped(Math.max(MIN_LABEL_CHARS, labelBudgetFor(false)), false),
    // Kademe 4 — etiketler tamamen dusuruldu; yuzdeler tek satirda kalir.
    [percents.map((p) => `${p}%`).join(' · '), ...tail(false)].join('\n')
  ]

  for (const candidate of candidates) {
    if (candidate.length <= MAX_TOOLTIP_LENGTH) return candidate
  }
  // Son care: yalniz yuzdeler, sert kirpma.
  return clip(percents.map((p) => `${p}%`).join(' · '), MAX_TOOLTIP_LENGTH)
}

// ── Baglam menusu (REQ-3 AC3) ────────────────────────────────────────────────

export type TrayMenuAction = 'toggle-widget' | 'refresh' | 'open-panel' | 'quit'

/**
 * Electron'a bagimli olmayan menu sablonu. `click` burada baglanmaz; ana surec
 * `action` alanina gore kendi isleyicisini takar. Boylece menu saf uretilir ve
 * test edilebilir.
 */
export interface TrayMenuItem {
  id: string
  label: string
  enabled: boolean
  type: 'normal' | 'separator'
  /** Tiklaninca yapilacak is; ayirac ve bilgi satirinda null. */
  action: TrayMenuAction | null
}

export interface TrayMenuOptions {
  /** Widget su an gorunur mu — menu ogesinin metnini belirler. */
  widgetVisible?: boolean
  /** Yas hesabi icin referans zaman. */
  now?: number
  /**
   * Olculmus tepsi durumu. Verilmezse yetenek nesnesinden okunur; o da
   * tasimiyorsa `confirmed` kabul edilir (eski davranis).
   */
  presence?: TrayPresence
  /**
   * Arayuz dili. Verilmezse `FALLBACK_LANG` (Ingilizce) kullanilir — dil
   * bilinmiyorken sessizce Turkce'ye DUSULMEZ; sistem dilini ana surec verir.
   */
  lang?: Lang
}

/**
 * Gostergeye cikan pencere: **her zaman oturum**.
 *
 * Onceden "en cok dolmus pencere" seciliyordu; oturum sifirlaninca haftalik one
 * geciyor ve tepsi baska bir seyi anlatmaya basliyordu (olculdu: widget oturum
 * %5 gosterirken tepsi haftalik %28 gosteriyordu). Widget ile tepsi ayni seyi
 * soylemeli; ikisi de oturuma sabit.
 *
 * Oturum penceresi gelmezse ilk pencereye dusulur — uydurma yapilmaz.
 */
function tightestWindow(snapshot: UsageSnapshot | null): UsageWindow | null {
  if (snapshot === null) return null
  const usable = snapshot.windows.filter((w) => Number.isFinite(w.percent))
  return usable.find((w) => /session/i.test(w.label)) ?? usable[0] ?? null
}

function menuStatusLabel(view: StatusView, lang: Lang): string {
  const tightest = tightestWindow(view.snapshot)
  if (view.summary === '') {
    return tightest === null
      ? t(lang, 'tray.noData')
      : `${tightest.label}: ${clampPercent(tightest.percent)}%`
  }
  // Deger varsa durumla birlikte gosterilir; sayi tek basina guncel sanilmasin.
  return tightest === null ? view.summary : `${clampPercent(tightest.percent)}% · ${view.summary}`
}

/** Gizleme ogesinin metni ve tiklanabilirligi — tepsi durumuna bagli. */
function toggleWidgetItem(
  widgetVisible: boolean,
  presence: TrayPresence,
  lang: Lang
): TrayMenuItem {
  if (!widgetVisible) {
    return {
      id: 'toggle-widget',
      label: t(lang, 'tray.showWidget'),
      enabled: true,
      type: 'normal',
      action: 'toggle-widget'
    }
  }
  const safety = hideWidgetSafetyFor(presence)
  // Gerekce basligin kendisinde durur: menu ogesi tiklanmadan once okunan tek yerdir.
  const note = trayPresenceNote(lang, presence)
  const hide = t(lang, 'tray.hideWidget')
  return {
    id: 'toggle-widget',
    label: note === '' ? hide : `${hide} · ${note}`,
    // `blocked`da oge duruyor ama tiklanmiyor: kaybolan bir menu ogesi
    // "neredeydi?" sorusu uretir, gerekcesi yazili duran oge uretmez.
    enabled: safety !== 'blocked',
    type: 'normal',
    action: safety === 'blocked' ? null : 'toggle-widget'
  }
}

/** Baglam menusu sablonunu durumdan uretir. Saf fonksiyon. */
export function buildTrayMenuTemplate(
  status: UsageStatus,
  options: TrayMenuOptions = {}
): TrayMenuItem[] {
  const lang = options.lang ?? FALLBACK_LANG
  const view = viewOf(status, options.now ?? Date.now(), lang)
  const widgetVisible = options.widgetVisible ?? true
  const presence = options.presence ?? 'confirmed'
  const warning: TrayMenuItem[] =
    presence === 'confirmed'
      ? []
      : [
          {
            id: 'tray-warning',
            label: trayPresenceNote(lang, presence),
            enabled: false,
            type: 'normal',
            action: null
          }
        ]

  return [
    {
      id: 'status',
      label: menuStatusLabel(view, lang),
      enabled: false,
      type: 'normal',
      action: null
    },
    ...warning,
    { id: 'sep-1', label: '', enabled: false, type: 'separator', action: null },
    toggleWidgetItem(widgetVisible, presence, lang),
    {
      id: 'refresh',
      label: t(lang, 'tray.refresh'),
      // Olcum surerken ikinci istek kuyruga girmez.
      enabled: view.kind !== 'loading',
      type: 'normal',
      action: 'refresh'
    },
    {
      id: 'open-panel',
      label: t(lang, 'tray.panel'),
      enabled: true,
      type: 'normal',
      action: 'open-panel'
    },
    { id: 'sep-2', label: '', enabled: false, type: 'separator', action: null },
    { id: 'quit', label: t(lang, 'tray.quit'), enabled: true, type: 'normal', action: 'quit' }
  ]
}

// ── Piksel tamponu ───────────────────────────────────────────────────────────

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Ham ikon verisi. Bayt sirasi BGRA, satir basi `width * 4` bayt. */
export interface PixelBuffer {
  width: number
  height: number
  data: Uint8Array
}

/** Esige gore dolum cubugu rengi. Renk TEK BASINA bilgi tasimaz; yuzde de cizilir. */
const LEVEL_COLORS: Record<UsageLevel, Rgba> = {
  normal: { r: 0x2e, g: 0xc4, b: 0x8c, a: 0xff },
  caution: { r: 0xe8, g: 0xa3, b: 0x21, a: 0xff },
  critical: { r: 0xe5, g: 0x48, b: 0x4a, a: 0xff }
}

/** Dolmamis kisim — sonuk ama gorunur, olcek hissi icin. */
const TRACK_COLOR: Rgba = { r: 0x8a, g: 0x92, b: 0x9e, a: 0x59 }
/** Rakam rengi. */
const TEXT_COLOR: Rgba = { r: 0xff, g: 0xff, b: 0xff, a: 0xff }
/** Rakamin cevresindeki koyu hale — acik zeminli cubukta da okunur kalir. */
const TEXT_OUTLINE_COLOR: Rgba = { r: 0x0b, g: 0x0f, b: 0x14, a: 0xe6 }

/** Durum isareti renkleri. Isaretin varligi zaten bir sekildir; renk ek ipucu. */
const BADGE_COLORS: Record<IconBadge, Rgba> = {
  stale: { r: 0x8a, g: 0x92, b: 0x9e, a: 0xff },
  error: { r: 0xe5, g: 0x48, b: 0x4a, a: 0xff }
}

/**
 * Template (macOS menu cubugu) muregi.
 *
 * macOS template ikonda RGB kanallarini ATAR, yalnizca ALFA'yi okur ve sekli
 * menu cubugu temasina gore siyah ya da beyaz cizer. Bu yuzden burada seviye
 * rengi YOKTUR — macOS'ta renk kodlamasi taklit edilemez; bilgiyi `setTitle`
 * metni (`83%`, `83%*`, `83%!`), rozet SEKLI ve tooltip tasir.
 */
const TEMPLATE_INK: Rgba = { r: 0, g: 0, b: 0, a: 0xff }
/** Dolmamis kisim: ayni murekkep, dusuk alfa — olcek hissi alfa ile kurulur. */
const TEMPLATE_TRACK: Rgba = { r: 0, g: 0, b: 0, a: 0x4d }

/** Bir cizimde kullanilan renkler; `monochrome` bayragina gore secilir. */
interface IconPalette {
  track: Rgba
  fill: Rgba
  text: Rgba
  /** Rakamin cevresindeki hale; template ikonda cizilmez (null). */
  outline: Rgba | null
  badge: Rgba
}

function paletteFor(level: UsageLevel, badge: IconBadge | null, monochrome: boolean): IconPalette {
  if (monochrome) {
    return {
      track: TEMPLATE_TRACK,
      fill: TEMPLATE_INK,
      text: TEMPLATE_INK,
      // Hale cizilmez: template ikonda hale ile rakam ayni murekkebe duser ve
      // rakam halenin icinde kaybolur. Kontrasti isletim sistemi saglar.
      outline: null,
      badge: TEMPLATE_INK
    }
  }
  return {
    track: TRACK_COLOR,
    fill: LEVEL_COLORS[level],
    text: TEXT_COLOR,
    outline: TEXT_OUTLINE_COLOR,
    badge: badge === null ? TEXT_COLOR : BADGE_COLORS[badge]
  }
}

/** Bayat ikon sonuklestirilir; isaret ve tooltip metni durumu ayrica soyler. */
const STALE_ALPHA_NUMERATOR = 110
const STALE_ALPHA_DENOMINATOR = 255

function createPixelBuffer(width: number, height: number): PixelBuffer {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

function setPixel(buf: PixelBuffer, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return
  const i = (y * buf.width + x) * 4
  buf.data[i] = color.b
  buf.data[i + 1] = color.g
  buf.data[i + 2] = color.r
  buf.data[i + 3] = color.a
}

/** Tek pikseli okur. Tampon disi koordinat tamamen saydam doner. */
export function getPixel(buf: PixelBuffer, x: number, y: number): Rgba {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return { r: 0, g: 0, b: 0, a: 0 }
  const i = (y * buf.width + x) * 4
  return {
    b: buf.data[i] ?? 0,
    g: buf.data[i + 1] ?? 0,
    r: buf.data[i + 2] ?? 0,
    a: buf.data[i + 3] ?? 0
  }
}

/** Saydam olmayan piksel sayisi. Ikonun bos cikmadigini dogrulamak icin. */
export function countOpaquePixels(buf: PixelBuffer): number {
  let n = 0
  for (let i = 3; i < buf.data.length; i += 4) {
    if ((buf.data[i] ?? 0) > 0) n += 1
  }
  return n
}

function fillRect(buf: PixelBuffer, x: number, y: number, w: number, h: number, color: Rgba): void {
  for (let dy = 0; dy < h; dy += 1) {
    for (let dx = 0; dx < w; dx += 1) setPixel(buf, x + dx, y + dy, color)
  }
}

function dimBuffer(buf: PixelBuffer): void {
  for (let i = 3; i < buf.data.length; i += 4) {
    const a = buf.data[i] ?? 0
    buf.data[i] = Math.round((a * STALE_ALPHA_NUMERATOR) / STALE_ALPHA_DENOMINATOR)
  }
}

// ── Gomulu bitmap font ───────────────────────────────────────────────────────

const GLYPH_W = 3
const GLYPH_H = 5
const GLYPH_GAP = 1

/** 3x5 matris; '1' = dolu piksel. 16 px ikonda okunacak en kucuk boy. */
const FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '%': ['101', '001', '010', '100', '101'],
  '!': ['010', '010', '010', '000', '010'],
  '?': ['111', '001', '011', '000', '010'],
  '-': ['000', '000', '111', '000', '000']
}

/** Bosluk olceklenmez; boylece buyuk ikonda rakamlar daha genis olur. */
function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0
  return text.length * GLYPH_W * scale + (text.length - 1) * GLYPH_GAP
}

/** Metnin dolu piksellerini olcekleyip koordinat listesi olarak verir. */
function glyphPixels(
  text: string,
  scale: number,
  originX: number,
  originY: number
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let cursorX = originX
  for (const ch of text) {
    const rows = FONT[ch]
    if (rows !== undefined) {
      for (let row = 0; row < GLYPH_H; row += 1) {
        const line = rows[row] ?? ''
        for (let col = 0; col < GLYPH_W; col += 1) {
          if (line[col] !== '1') continue
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              out.push([cursorX + col * scale + sx, originY + row * scale + sy])
            }
          }
        }
      }
    }
    cursorX += GLYPH_W * scale + GLYPH_GAP
  }
  return out
}

// ── Ikon uretimi (saf) ───────────────────────────────────────────────────────

export interface IconRenderOptions {
  /** Kenar uzunlugu, piksel (16 / 22 / 32). */
  size: number
  /** Dolum cubugunun rengini belirler. Verilmezse yuzdeden hesaplanir. */
  level?: UsageLevel
  /**
   * macOS template ikonu: renk kodlamasi ve hale birakilir, sekil yalnizca
   * alfa kanaliyla anlatilir. `trayImageStyleFor` bu degeri uretir.
   */
  monochrome?: boolean
}

/** Ikonun nasil yerlestigi — test ve tani icin. */
export interface IconLayout {
  /** Ikona cizilen metin; yer yetmezse '%' dusurulur, hic sigmazsa bos. */
  text: string
  /** Font olcegi (1 = 3x5 piksel). */
  scale: number
  /** Dolum cubugunun dolu piksel genisligi. */
  fillWidth: number
  /** Cizilen metnin piksel genisligi; her zaman `size - 2` icinde kalir. */
  textWidth: number
  /** Metin sigmadi, yalniz dolum cubugu cizildi. */
  barOnly: boolean
}

export interface RenderedIcon extends PixelBuffer {
  layout: IconLayout
}

/**
 * Metin cizilebilmesi icin gereken en kucuk ikon kenari.
 *
 * scale=1'de en genis metin "100" = 11 px; ic alan `size - 2` oldugundan
 * `size >= 13` sarttir. Altinda metin cizilmez — kirpilmis yarim rakam yerine
 * yalniz dolum cubugu gosterilir (olculdu: size=12 → 11 px metin, 10 px ic alan).
 */
export const MIN_TEXT_ICON_SIZE = 13


/** Ikona hangi durumun cizilecegi. */
export interface IconSpec {
  /** Cizilecek yuzde; olcum yoksa null — bu durumda sayi UYDURULMAZ. */
  percent: number | null
  level: UsageLevel
  badge: IconBadge | null
  /** Deger guncel degil; ikon sonuk cizilir. */
  stale: boolean
}

/** Deger yokken cizilen isaret. Bos ikon yerine durumu anlatan tek karakter. */
function markFor(badge: IconBadge | null): string {
  if (badge === 'error') return '!'
  if (badge === 'stale') return '?'
  return '-'
}

/**
 * Durumu ham BGRA tamponuna cizer. Saf fonksiyon: Electron'a dokunmaz, ayni
 * girdi ayni tamponu uretir.
 */
export function renderStatusIcon(spec: IconSpec, opts: IconRenderOptions): RenderedIcon {
  const size = Math.max(8, Math.round(opts.size))
  const pct = spec.percent === null ? null : clampPercent(spec.percent)
  const level = opts.level ?? spec.level
  const palette = paletteFor(level, spec.badge, opts.monochrome === true)
  const buf = createPixelBuffer(size, size)

  const pad = 1
  const innerW = size - pad * 2

  const barH = Math.max(2, Math.round(size / 8))
  const textAreaH = size - pad * 2 - barH - 1

  const digits = pct === null ? markFor(spec.badge) : String(pct)

  // Olcek CIZILECEK metne gore secilir, en genis olasiya ("100") gore degil.
  // Eskiden "100" referans alindigi icin iki haneli deger (yani neredeyse her
  // zaman) gereksiz kucuk ciziliyordu: 16 px ikonda 3x5 piksel rakam, tepside
  // okunmuyordu. Boyut yalnizca 99 -> 100 esiginde bir kez degisir; bu, surekli
  // okunaksiz kalmaya yeglenir.
  let scale = 1
  for (let s = 4; s >= 1; s -= 1) {
    if (textWidth(digits, s) <= innerW && GLYPH_H * s <= textAreaH) {
      scale = s
      break
    }
  }

  // Yuzde isareti ancak rakamlari kucultmeden siğiyorsa eklenir: rakam okunurlugu
  // '%' isaretinden onceliklidir.
  const wanted = pct === null ? digits : `${digits}%`
  const chosen = textWidth(wanted, scale) <= innerW ? wanted : digits

  // Alt sinirin altinda ya da dikey/yatay sigmayan durumda metin CIZILMEZ;
  // yarim rakam gostermek yerine dolum cubugu tek basina anlatir.
  const fits =
    size >= MIN_TEXT_ICON_SIZE &&
    textWidth(chosen, scale) <= innerW &&
    GLYPH_H * scale <= textAreaH
  const text = fits ? chosen : ''

  // Alt kenardaki olcek cubugu: dolum konumu yuzdeyi ikinci kez anlatir.
  const barY = size - pad - barH
  fillRect(buf, pad, barY, innerW, barH, palette.track)
  const fillWidth = pct === null || pct === 0 ? 0 : Math.max(1, Math.round((pct / 100) * innerW))
  if (fillWidth > 0) fillRect(buf, pad, barY, fillWidth, barH, palette.fill)

  const drawnW = textWidth(text, scale)
  const textX = pad + Math.max(0, Math.floor((innerW - drawnW) / 2))
  const textY = pad + Math.max(0, Math.floor((textAreaH - GLYPH_H * scale) / 2))
  const pixels = glyphPixels(text, scale, textX, textY)

  // Once hale (rakamin 8 komsusu), sonra rakam — bu sira sayesinde harmanlama gerekmez.
  const outline = palette.outline
  if (outline !== null) {
    for (const [x, y] of pixels) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) setPixel(buf, x + dx, y + dy, outline)
      }
    }
  }
  for (const [x, y] of pixels) setPixel(buf, x, y, palette.text)

  // Sonuklestirme once uygulanir, isaret sonra cizilir ki isaret sonuklesmesin.
  if (spec.stale) dimBuffer(buf)
  if (spec.badge !== null) {
    const badgeSize = Math.max(2, Math.round(size / 6))
    fillRect(buf, size - badgeSize, 0, badgeSize, badgeSize, palette.badge)
  }

  return { ...buf, layout: { text, scale, fillWidth, textWidth: drawnW, barOnly: text === '' } }
}

/** Yuzdeyi ikonun uzerine cizer. `renderStatusIcon`in durumsuz kisayolu. */
export function renderPercentIcon(percent: number, opts: IconRenderOptions): RenderedIcon {
  return renderStatusIcon(
    { percent, level: opts.level ?? levelFor(clampPercent(percent)), badge: null, stale: false },
    opts
  )
}

// ── Electron sarmalayicisi (tek bagimli nokta) ───────────────────────────────

/** `nativeImage`in kullandigimiz yuzeyi; gercek Electron nesnesi bu kaliba uyar. */
export interface NativeImageLike {
  isEmpty(): boolean
  setTemplateImage(option: boolean): void
}

export interface NativeImageFactory {
  createFromBitmap(
    buffer: Uint8Array,
    options: { width: number; height: number; scaleFactor?: number }
  ): NativeImageLike
}

/**
 * Piksel tamponunu `nativeImage`e cevirir. Electron nesnesi disaridan verilir;
 * boylece uretici saf kalir ve bu sarmalayici test edilebilir.
 */
export function createTrayImage(
  pixels: PixelBuffer,
  factory: NativeImageFactory,
  options: { scaleFactor?: number; template?: boolean } = {}
): NativeImageLike {
  const image = factory.createFromBitmap(pixels.data, {
    width: pixels.width,
    height: pixels.height,
    scaleFactor: options.scaleFactor ?? 1
  })
  // macOS'ta ikon sade kalir ve menu cubugu temasina gore renklenir.
  if (options.template === true) image.setTemplateImage(true)
  return image
}

// ── Platform basina ikon bicimi ──────────────────────────────────────────────

/** Tepsi ikonunun platforma gore nasil uretilecegi. */
export interface TrayImageStyle {
  /** `nativeImage.setTemplateImage(true)` cagrilsin mi. */
  template: boolean
  /** `renderStatusIcon`a gecilecek `monochrome` degeri. */
  monochrome: boolean
  /** Uretilecek tamponun kenari (piksel). */
  size: number
  /** `createFromBitmap` scaleFactor'u. */
  scaleFactor: number
}

/** Platform basina mantiksal tepsi ikonu kenari (nokta cinsinden). */
const TRAY_LOGICAL_PX: Record<SupportedPlatform, number> = {
  win32: 16,
  darwin: 16,
  linux: 22
}

/**
 * Tepsi ikonu bicimini platforma gore secer.
 *
 * macOS **template** ister: template olmayan ikon acik ve koyu menu cubugunda
 * ayni renkte cizilir ve birinde okunmaz kalir. Template acilinca RGB atilir,
 * bu yuzden ayni anda `monochrome` cizim gerekir — yoksa renkli piksel yalnizca
 * alfaya inip lekeye doner.
 *
 * Windows'ta olcek carpani BILEREK 1: 32 px @2x denendi, isletim sistemi 16 px
 * yuvaya indirirken rakamlar birbirine girdi (olculdu). Ikon hedef boyutta
 * cizilir.
 */
export function trayImageStyleFor(
  platform: SupportedPlatform,
  displayScaleFactor: number = 1
): TrayImageStyle {
  const scale = Number.isFinite(displayScaleFactor)
    ? Math.max(1, Math.round(displayScaleFactor))
    : 1
  switch (platform) {
    case 'darwin':
      return {
        template: true,
        monochrome: true,
        size: TRAY_LOGICAL_PX.darwin * scale,
        scaleFactor: scale
      }
    case 'win32':
      return { template: false, monochrome: false, size: TRAY_LOGICAL_PX.win32, scaleFactor: 1 }
    case 'linux':
      return { template: false, monochrome: false, size: TRAY_LOGICAL_PX.linux, scaleFactor: 1 }
  }
}

/**
 * Durumu platformun istedigi bicimde ikona cevirir — cizim ve `nativeImage`
 * donusumu tek cagrida. Onbellek anahtari `spec` + `style`den turetilir.
 */
export function renderTrayImage(
  spec: IconSpec,
  factory: NativeImageFactory,
  style: TrayImageStyle
): NativeImageLike {
  const rendered = renderStatusIcon(spec, { size: style.size, monochrome: style.monochrome })
  return createTrayImage(rendered, factory, {
    scaleFactor: style.scaleFactor,
    template: style.template
  })
}

// ── Gosterge karari ──────────────────────────────────────────────────────────

export interface IndicatorPlan {
  /** Gosterilecek yuzde; olcum yoksa null. */
  percent: number | null
  /** Cubuk metni; platform metni desteklemiyorsa null. */
  title: string | null
  /** Ikonun uzerine cizilecek yuzde; ikona cizilmeyecekse null. */
  iconPercent: number | null
  /** Her platformda dolu — metin gosterilemese bile bilgi kaybolmaz. */
  tooltip: string
  level: UsageLevel
  /** 0-1 arasi ilerleme; desteklenmiyorsa null. */
  progress: number | null
  /** Karari ureten durum sinifi. */
  statusKind: UsageStatus['kind']
  /** Gosterilen deger guncel degil. */
  stale: boolean
  /** Durumu anlatan tek satir; `ok` icinde bos. */
  statusText: string
  /** Ikon cizim girdisi — durum degisince ikon da degisir. */
  icon: IconSpec
  /** Baglam menusu sablonu (REQ-3 AC3). */
  menu: TrayMenuItem[]
  /** Karari ureten tepsi olcumu. */
  presence: TrayPresence
  /**
   * Widget gizleme karari. Ana surec bunu okur: `confirm`de once kullaniciya
   * sorar, `blocked`da gizlemez. Adaptor pencere yonetmez, yalnizca karari verir.
   */
  hideWidgetSafety: HideWidgetSafety
}

function tightestPercent(snapshot: UsageSnapshot | null): number | null {
  const w = tightestWindow(snapshot)
  return w === null ? null : clampPercent(w.percent)
}

function titleFor(view: StatusView, percent: number | null): string {
  // Isaret rengin yerine gecmez, ona eklenir; tam metin tooltip'te durur.
  switch (view.kind) {
    case 'loading':
      return '…'
    case 'no-data':
      return '—'
    case 'ok':
      return percent === null ? '—' : `${percent}%`
    case 'stale':
      return percent === null ? '—' : `${percent}%*`
    case 'error':
      return percent === null ? '!' : `${percent}%!`
  }
}

export type IndicatorOptions = TrayMenuOptions

/** Ciplak `UsageSnapshot` verilirse basarili olcum kabul edilir. */
function asStatus(source: UsageSnapshot | UsageStatus): UsageStatus {
  return 'kind' in source ? source : { kind: 'ok', snapshot: source }
}

/**
 * Yetenege ve DURUMA gore ne gosterilecegine karar verir. Saf fonksiyon.
 *
 * Girdi olarak ciplak `UsageSnapshot` da kabul edilir (basarili olcum kisayolu),
 * ama asil kullanilacak alan `UsageStatus`tur: hata ve bayatlik ancak onunla
 * ifade edilebilir.
 */
export function planIndicator(
  source: UsageSnapshot | UsageStatus,
  caps: TrayCapabilities,
  options: IndicatorOptions = {}
): IndicatorPlan {
  const status = asStatus(source)
  const now = options.now ?? Date.now()
  const lang = options.lang ?? FALLBACK_LANG
  const view = viewOf(status, now, lang)
  // Oncelik: acik secenek > yetenek olcumu > eski davranis (ikon varsa kesin).
  const presence: TrayPresence =
    options.presence ?? (isTrayAssurance(caps) ? caps.presence : caps.trayIcon ? 'confirmed' : 'absent')

  const percent = tightestPercent(view.snapshot)
  const level = levelFor(percent ?? 0)
  // macOS'ta sayi metin olarak gosterildigi icin ikonun uzerine ayrica cizilmez.
  const drawOnIcon = caps.trayIcon && !caps.textLabel
  const iconPercent = drawOnIcon && percent !== null ? percent : null

  return {
    percent,
    title: caps.textLabel ? titleFor(view, percent) : null,
    iconPercent,
    tooltip: buildTooltip(view, presence, lang),
    level,
    progress: caps.progressBar && percent !== null ? percent / 100 : null,
    statusKind: view.kind,
    stale: view.stale,
    statusText: view.summary,
    icon: { percent: iconPercent, level, badge: view.badge, stale: view.stale },
    menu: buildTrayMenuTemplate(status, {
      widgetVisible: options.widgetVisible,
      now,
      presence,
      lang
    }),
    presence,
    hideWidgetSafety: hideWidgetSafetyFor(presence)
  }
}

/** `Tray`in kullandigimiz yuzeyi; gercek Electron `Tray` nesnesi bu kaliba uyar. */
export interface TrayLike {
  setImage(image: NativeImageLike): void
  setToolTip(toolTip: string): void
  setTitle(title: string): void
  /** Electron `Menu` nesnesi alir; sablonu menuye ceviren taraf `deps.buildMenu`dur. */
  setContextMenu?(menu: unknown): void
}

export interface IndicatorDeps {
  /**
   * Durumu bilen ikon uretici. Verilirse HER karar sonrasi cagrilir — CLI
   * dustugunde ikon eski yuzdede kalmaz.
   */
  renderIcon?: (spec: IconSpec) => NativeImageLike
  /** Yalniz yuzdeyi bilen uretici; `renderIcon` yoksa kullanilir. */
  createImage?: (percent: number, level: UsageLevel) => NativeImageLike
  /** Menu sablonunu Electron `Menu` nesnesine cevirir. Verilmezse menu kurulmaz. */
  buildMenu?: (template: TrayMenuItem[]) => unknown
  /** Gorev cubugu / dock ilerleme cubugu. Verilmezse atlanir. */
  setProgress?: (value: number) => void
}

/**
 * Karari tray'e uygular. Tray yoksa (Linux'ta olusturulamadi) sahte bir cubuk
 * uydurulmaz; app calismaya devam eder ve plan yine dondurulur.
 */
export function applyIndicator(
  tray: TrayLike | null,
  source: UsageSnapshot | UsageStatus,
  caps: TrayCapabilities,
  deps: IndicatorDeps = {},
  options: IndicatorOptions = {}
): IndicatorPlan {
  const plan = planIndicator(source, caps, options)

  if (tray !== null && caps.trayIcon) {
    tray.setToolTip(plan.tooltip)
    if (plan.title !== null) tray.setTitle(plan.title)

    if (deps.renderIcon !== undefined) {
      tray.setImage(deps.renderIcon(plan.icon))
    } else if (plan.iconPercent !== null && deps.createImage !== undefined) {
      tray.setImage(deps.createImage(plan.iconPercent, plan.level))
    }

    if (deps.buildMenu !== undefined && tray.setContextMenu !== undefined) {
      tray.setContextMenu(deps.buildMenu(plan.menu))
    }
  }

  if (plan.progress !== null && deps.setProgress !== undefined) deps.setProgress(plan.progress)

  return plan
}
