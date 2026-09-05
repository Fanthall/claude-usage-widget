import type { Lang } from './i18n'

/**
 * Modul sozlesmeleri. Tum main-process modulleri bu tiplere gore yazilir.
 * PRD: workspace/prds/claude-usage-widget/usage-widget-mvp/
 */

// ── /usage ciktisi ───────────────────────────────────────────────────────────

/** Tek bir kota penceresi. Cikti metnindeki her "... : N% used · resets ..." satiri. */
export interface UsageWindow {
  /** Satirin etiketi, oldugu gibi: "Current session", "Current week (all models)". */
  label: string
  /** 0-100. */
  percent: number
  /** Sifirlanma zamani, ham metin: "Sep 5, 4:50pm (Europe/Istanbul)". */
  resetsAtRaw: string
  /** Ayristirilabildiyse epoch ms; belirsizse null (asla tahmin uydurma). */
  resetsAtMs: number | null
}

export interface UsageSnapshot {
  /** Olcum zamani, epoch ms. */
  at: number
  windows: UsageWindow[]
  /** Ayristirilamayan satirlar — sessizce atilmaz, tasinir (REQ-10). */
  unparsedLines: string[]
  /** Ham `result` metni; tani icin saklanir. */
  raw: string
}

/** Sema surumu — history satirlarinda `v` alani (constraints.md > Migration). */
export const SNAPSHOT_SCHEMA_VERSION = 1

// ── CLI calistirma ───────────────────────────────────────────────────────────

export type CliErrorKind =
  | 'not-found'      // calistirilabilir bulunamadi
  | 'not-logged-in'  // 401 / oturum kapali
  | 'timeout'
  | 'bad-output'     // govde cozulemedi veya kota alani yok
  | 'rate-limited'   // kota ucu 429: cok sik soruldu
  | 'unknown'

export class CliError extends Error {
  constructor(
    readonly kind: CliErrorKind,
    message: string,
    /** Ham cikti — loglanirken maskelenir (security.md). */
    readonly rawOutput?: string
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/** `claude -p "/usage" --output-format json` ciktisinin ilgilendigimiz alanlari. */
export interface UsageCliResult {
  result: string
  duration_ms: number
  total_cost_usd: number
  usage: Record<string, unknown>
}

export interface AuthStatus {
  loggedIn: boolean
  email: string | null
  orgName: string | null
  subscriptionType: string | null
}

// ── Tarihce ──────────────────────────────────────────────────────────────────

export interface HistoryEntry extends UsageSnapshot {
  v: number
}

/** Grafik icin: ardisik iki kayit arasinda bu esikten uzun bosluk varsa seri kesilir. */
export const HISTORY_GAP_MS = 5 * 60 * 1000

// ── Oturum tespiti ───────────────────────────────────────────────────────────

export interface ClaudeSession {
  pid: number
  /** Epoch ms; platform veremezse null. */
  startedAtMs: number | null
  /** Transkriptten eslestirilen calisma dizini; bulunamazsa null. */
  cwd: string | null
}

/**
 * Tespit sonucu. `supported: false` ise sayim YAPILAMADI demektir —
 * cagiran taraf bunu "0 oturum" diye gostermez (REQ-7).
 */
export type ProcessScanResult =
  | { supported: true; sessions: ClaudeSession[] }
  | { supported: false; reason: string }

// ── Sistem cubugu ────────────────────────────────────────────────────────────

export interface TrayCapabilities {
  /** Cubukta metin gosterilebiliyor mu (macOS: evet; Windows: hayir). */
  textLabel: boolean
  /** Tray ikonu olusturulabildi mi (bazi Linux masaustlerinde hayir). */
  trayIcon: boolean
  /** Gorev cubugu / dock ilerleme cubugu. */
  progressBar: boolean
}

/** Desteklenen platformlar. NodeJS namespace'i renderer tarafinda yok, o yuzden literal. */
export type SupportedPlatform = 'win32' | 'darwin' | 'linux'

// ── Cihaz envanteri ──────────────────────────────────────────────────────────

export interface DeviceHeartbeat {
  /** ~/.claude.json icindeki machineID — cihaz anahtari (makine adi benzersiz degil). */
  machineId: string
  hostname: string
  platform: SupportedPlatform
  email: string | null
  /** Tespit edilemediyse null — 0 YAZILMAZ. */
  openSessions: number | null
  /** Ayar kapaliysa yalnizca sayi paylasilir (security.md, Q4 varsayilani). */
  projects: string[] | null
  updatedAt: number
}

// ── Olcum durumu (REQ-10) ────────────────────────────────────────────────────

/**
 * Gostergeye giden durum. Tray/widget bunu alir, ciplak UsageSnapshot'i DEGIL.
 *
 * Gerekce: yalnizca snapshot gecirilirse CLI dustugunde gosterge guncellenmez ve
 * ekranda **eski yuzde oldugu gibi kalir** — kullanici bayat sayiyi guncel sanir.
 * Durum tipi bayatligi ve hatayi ifade edilebilir kilar; "sessiz bozulma yasak".
 */
export type UsageStatus =
  | { kind: 'loading' }
  /** Hic olcum yapilmadi (ilk kurulum). */
  | { kind: 'no-data' }
  | { kind: 'ok'; snapshot: UsageSnapshot }
  /** Son olcum basarili ama eski; deger gosterilir, bayat isaretlenir. */
  | { kind: 'stale'; snapshot: UsageSnapshot; ageMs: number; reason: string }
  /** Olcum basarisiz. lastSnapshot varsa bayat olarak gosterilir, yoksa deger yok. */
  | { kind: 'error'; errorKind: CliErrorKind; message: string; lastSnapshot: UsageSnapshot | null }

/** Bayatlik alt siniri. Gercek esik icin `staleThresholdMs()` kullanilir. */
export const STALE_AFTER_MS = 3 * 60 * 1000

/**
 * Bayatlik esigi. Sabit STALE_AFTER_MS ile olcum araligi 3 dk'dan buyuk secilirse
 * toplayici kusursuz calisirken gosterge surekli "bayat" der — bir sonraki olcum
 * esikten sonra gelir. Bu yuzden esik aralikla olceklenir (gapThresholdMs ile ayni mantik).
 */
export function staleThresholdMs(pollIntervalMs: number): number {
  return Math.max(STALE_AFTER_MS, pollIntervalMs * 2.5)
}

/** Ust uste bu kadar basarisizlikta kullaniciya gorunur uyari verilir (REQ-10 AC2). */
export const ERROR_STREAK_FOR_ALERT = 3

// ── Toplayici ────────────────────────────────────────────────────────────────

export interface CollectorConfig {
  /** Olcum araligi. Varsayilan 60 sn (Q5). */
  pollIntervalMs: number
  /** Tarihcenin yazilacagi dizin. */
  dataDir: string
  /** Kesfedilen calistirilabilir yolu; bilinmiyorsa null. */
  claudeBinPath: string | null
}

/**
 * Varsayilan olcum araligi.
 *
 * 60 sn ile baslamistik; kota ucu /api/oauth/usage bu siklikta **429**
 * dondurdu ve CLI bunu gizleyip 20 dakikalik bayat veriyi guncelmis gibi
 * gosterdi (olculdu 2026-09-05). Kota yuzdesi saatler icinde degisen bir sey;
 * dakikalik yoklama bilgi katmiyor, yalnizca sinira carpiyor.
 */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000

/** 429 sonrasi bekleme carpani ve tavani — sinir acilana kadar geri cekilinir. */
export const BACKOFF_FACTOR = 2
export const MAX_BACKOFF_MS = 60 * 60 * 1000

/**
 * Grafikte seriyi kesecek bosluk esigi. Sabit degil — olcum araligina bagli.
 * Sabit HISTORY_GAP_MS ile 5 dk'lik aralik secilirse ardisik HER cift bosluk
 * sayilir ve grafikte tek bir cizgi kalmaz; bu yuzden aralikla olceklenir.
 */
export function gapThresholdMs(pollIntervalMs: number): number {
  return Math.max(HISTORY_GAP_MS, pollIntervalMs * 2.5)
}

// ── Pencere / IPC ────────────────────────────────────────────────────────────

export type WindowRole = 'widget' | 'panel'

/** Renderer'a giden yayin. Tek kanal, tek tip. */
export interface StatePayload {
  status: UsageStatus
  auth: AuthStatus | null
  sessions: ProcessScanResult | null
  /** Ust uste basarisizlik sayisi; ERROR_STREAK_FOR_ALERT'i asinca uyari. */
  errorStreak: number
  /**
   * Sistem cubugu ikonu kurulabildi mi. Bazi Linux masaustlerinde tray yok;
   * o zaman widget'i gizlemek onu erisilemez yapar — kapatma dugmesi bunu
   * bilerek davranir (gizlemek yerine cikar).
   */
  trayAvailable: boolean
  /**
   * Arayuz dili. Sistemden secilir (TR sistemde TR, aksi halde EN); kullaniciya
   * secim sunulmaz. Ana surec `app.getLocale()` ile belirler.
   */
  lang: Lang
}

// ── Widget gorunumleri ───────────────────────────────────────────────────────

/** Uc ayri gorsel dil; kullanici widget'tan gecis yapar. */
export type WidgetTheme = 'focus' | 'list' | 'strip'

export const WIDGET_THEMES: readonly WidgetTheme[] = ['focus', 'list', 'strip']

/**
 * Her gorunumun kendi alt siniri var: serit tek satira sigar, kadran yaya yer
 * ister, olcek cubuk + etiket + geri sayim tasir. Tek bir ortak alt sinir ya
 * seridi bosuna buyutur ya kadrani kirpar.
 */
export const THEME_MIN_SIZE: Record<WidgetTheme, { width: number; height: number }> = {
  focus: { width: 210, height: 150 },
  list: { width: 216, height: 130 },
  strip: { width: 196, height: 74 }
}

export function isWidgetTheme(value: unknown): value is WidgetTheme {
  return typeof value === 'string' && (WIDGET_THEMES as readonly string[]).includes(value)
}
