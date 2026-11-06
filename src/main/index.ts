import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, screen } from 'electron'
import { access, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import appIconPng from '../../build/icon.png?asset'
import appIconIco from '../../build/icon.ico?asset'

import {
  ACCOUNT_KEYS,
  isAccountKey,
  isWidgetTheme,
  THEME_MIN_SIZE,
  type AccountKey,
  type StatePayload,
  type TokenState,
  type UsageStatus
} from '../shared/types'
import { formatPercent, pickLang, t, type Lang } from '../shared/i18n'
import { createAccountManager, detectPresence, type AccountManager } from './core/accounts'
import { createCliRefresher } from './core/cli-refresh'
import { createCollector } from './core/collector'
import { readAccountIdentity, readOrganizationId } from './core/identity'
import { createKeychainTokenReader } from './core/keychain'
import { readRange } from './core/history-store'
import { writeTargets } from './core/hub-client'
import { createHubSync, type HubSync } from './core/hub-sync'
import { startTokenService, type HubSyncState, type TokenService } from './core/token-service'
import type { WorkerHub } from './token-worker'
import { createUsageReader } from './core/usage-reader'
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type AppConfig,
  type WidgetBounds
} from './core/config-store'
import { accountPaths, appConfigFile, appDataDir, nodePathFs, type AccountPaths } from './core/paths'
import { safeLog, setLogSink } from './core/log-safe'
import { createFileSink } from './core/diag-log'
import { scanClaudeSessions } from './platform/process-scan'
import {
  applyIndicator,
  buildTrayMenuTemplate,
  composeAccountTooltip,
  createTrayImage,
  detectCapabilities,
  probeTrayPresence,
  renderStatusIcon,
  toSupportedPlatform,
  trayImageStyleFor,
  type IconSpec,
  type TrayAssurance,
  type TrayLike,
  type TrayMenuItem
} from './platform/tray-adapter'

const isDev = !app.isPackaged

/** Tray referansi modul kapsaminda tutulur; yerel degiskende cop toplayici ikonu yok eder. */
let tray: Tray | null = null
let widget: BrowserWindow | null = null
/** Ayrintili panel penceresi; kapaninca null. */
let panel: BrowserWindow | null = null
/**
 * Varsayilanla dolu baslar. `second-instance` dinleyicisi `whenReady`den ONCE
 * kuruluyor; konfig dosyasi okunurken gelen ikinci calistirma burayi tanimsiz
 * bulup ana surecte cokuyordu. Dosyadan gelen deger birkac ms sonra ustune yazar.
 */
let config: AppConfig = defaultConfig()
let configFile: string
/**
 * Acilis tamamlandi mi. Tamamlanmadan pencere kurulmaz: hem konfig/`configFile`
 * henuz okunmamis olur hem de `whenReady` kendi `createWidget()`ini calistirinca
 * ikinci bir pencere acilip ilki sahipsiz kalirdi.
 */
let appReady = false
let lastSessions: StatePayload['sessions'] = null
/** Konfig okunduktan sonra kurulur: hesap klasorleri konfigten gelir. */
let accounts: AccountManager | null = null
let tokens: TokenService | null = null
let lastTokens: TokenState | null = null
let lastHubState: HubSyncState | null = null
/** Konfig okunduktan sonra kurulur: merkez adresleri konfigten gelir. */
let hubSync: HubSync | null = null
/**
 * Kullanici pencereyi elle boyutlandirdi mi. Boyutlandirmadiysa widget icerige
 * oturur; boyutlandirdiysa sectigi olcu korunur. Oturum icinde tutulur —
 * yeniden acilista widget tekrar icerige oturur.
 */
let userSized = false

/**
 * Ilk fit uygulanana kadar gelen `resized` olaylari kullanici mudahalesi
 * sayilmaz. Pencere olusturulurken ve kaydedilmis boyut geri yuklenirken de
 * olay yayiliyor; bunlar `userSized`i erken true yapip fit'i kilitliyordu.
 */
let firstFitDone = false

/**
 * Kendi yaptigimiz boyutlandirmanin hedefi. `setSize()` **ve** `setMinimumSize()`
 * ikisi de `resized` olayi tetikler; ayirmazsak ilk fit'ten sonra `userSized`
 * true olur ve widget bir daha gorunume gore toparlanmaz.
 *
 * Zaman bayragi yerine hedef karsilastirmasi kullaniliyor: olay hangi tikta
 * gelirse gelsin, ulasilan boyut bizim istedigimizse kullanici yapmamistir.
 */
let programmaticTarget: { width: number; height: number } | null = null

/** Olcum gelene kadarki mutlak taban; gercek alt siniri `widget:fit` koyar. */
const ABSOLUTE_MIN = { width: 120, height: 60 }

/** Alt siniri ve boyutu birlikte uygular; ikisi de olay tetikleyebilir. */
function applyFit(win: BrowserWindow, minW: number, minH: number, w: number, h: number): void {
  programmaticTarget = { width: w, height: h }
  win.setMinimumSize(minW, minH)
  const [curW, curH] = win.getSize()
  if (curW !== w || curH !== h) win.setSize(w, h)
}

// Desteklenmeyen bir platformda (aix vb.) en temkinli varsayim linux'tur.
const platform = toSupportedPlatform(process.platform) ?? 'linux'

/**
 * Tepsi yetenegi VARSAYILMAZ, olculur. `new Tray()` stock GNOME'da throw
 * etmiyor, ikon yalnizca gorunmuyor; "var" sanip widget'i gizlersek kullanici
 * onu geri getiremez. `caps` tray kurulduktan sonra yeniden hesaplanir.
 */
let caps: TrayAssurance = detectCapabilities(platform, { trayPresence: 'absent' })
const dataDir = appDataDir()

/**
 * Arayuz dili sistemden gelir; kullaniciya secim sunulmaz. `app.getLocale()`
 * `app.whenReady()` sonrasi guvenilir oldugu icin baslangicta varsayilan kalir,
 * hazir olunca ayarlanir.
 */
let lang: Lang = pickLang(null)

/**
 * Electron `Tray`'i adaptorun yapisal arayuzune baglar. Adaptor Electron'a
 * bagimli olmasin diye `NativeImageLike` kullaniyor; donusum tek yerde durur.
 */
function asTrayLike(t: Tray): TrayLike {
  return {
    setImage: (image) => t.setImage(image as Electron.NativeImage),
    setToolTip: (text) => t.setToolTip(text),
    setTitle: (title) => t.setTitle(title),
    setContextMenu: (menu) => t.setContextMenu(menu as Electron.Menu | null)
  }
}

/**
 * Renderer gercek fontla cizilmis ikon gonderdi mi. Gonderdiyse piksel font
 * ikonu ARTIK YAZILMAZ — yoksa iki uretici birbirinin ustune yazar ve ikon
 * titrer. Piksel font yalnizca renderer hazir olana kadarki ilk ikondur.
 */
let canvasIconActive = false

/** Ayni ikon her yayinda yeniden cizilmesin; anahtar durumun tamamini kapsar. */
const iconCache = new Map<string, Electron.NativeImage>()

/**
 * Tepsi ikonu YEREL 16 px'te uretilir, olcek carpani YOK.
 *
 * 32 px @2x denendi: isletim sistemi tepsi yuvasina indirirken rakamlar
 * bulaniklasip birbirine giriyor (olculdu, gorsel olarak daha kotu). Tam sayi
 * olmayan bir kucultme yerine hedef boyutta cizmek daha okunur. Rakamlarin
 * buyumesi olcek secimi ve dolum cubugunun kaldirilmasiyla saglanir.
 */
const TRAY_ICON_PX = 16

function iconFor(spec: IconSpec, size: number): Electron.NativeImage {
  const key = `${spec.percent ?? 'x'}|${spec.level}|${spec.badge ?? '-'}|${spec.stale}|${size}`
  const hit = iconCache.get(key)
  if (hit !== undefined) return hit
  const style = trayImageStyleFor(platform)
  const rendered = renderStatusIcon(spec, { size, monochrome: style.monochrome })
  const image = createTrayImage(rendered, nativeImage, {
    template: style.template,
    scaleFactor: style.scaleFactor
  }) as Electron.NativeImage
  iconCache.set(key, image)
  return image
}

function menuFrom(template: TrayMenuItem[]): Electron.Menu {
  return Menu.buildFromTemplate(
    template.map((item) => ({
      label: item.label,
      enabled: item.enabled !== false,
      click: () => onMenuAction(item.action)
    }))
  )
}

function onMenuAction(action: TrayMenuItem['action']): void {
  if (action === 'toggle-widget') toggleWidget()
  else if (action === 'open-panel') openPanel()
  else if (action === 'refresh') void accounts?.pollAll()
  else if (action === 'quit') app.quit()
}

/**
 * Planli olcumlere eklenen rastgele kayma. Ayni hesabi ikinci bir cihaz da
 * soruyorsa istekler ayni ana yigilmaz (kota ucu sik soruluca 429 veriyor).
 */
const POLL_JITTER_MS = 30 * 1000

function pathsFor(key: AccountKey): AccountPaths {
  return accountPaths(key, config.accountDirs[key])
}

/**
 * Pencere simgesi acikca verilir. Paketli uygulamada Windows simgeyi exe'den
 * alir, ama gelistirmede ve testte calisan `electron.exe` kendi simgesini
 * gosteriyordu (kullanici panel basliginda eski simgeyi gordu). macOS pencere
 * simgesi kullanmaz.
 */
function windowIcon(): { icon?: string } {
  if (process.platform === 'win32') return { icon: appIconIco }
  if (process.platform === 'linux') return { icon: appIconPng }
  return {}
}

/** Kota tarihcesi: kisisel hesabinki eski yerinde kalir; digerleri kendi alt klasorunde. */
function historyDirFor(key: AccountKey): string {
  return key === 'personal' ? dataDir : join(dataDir, 'accounts', key)
}

/**
 * Chromium ag yigini: sistem vekil sunucusunu ve sertifika deposunu kullanir.
 * Sirket aginda TLS'i acip yeniden imzalayan vekil varsa Node'un kendi
 * `fetch`i sertifikayi tanimaz; `net.fetch` isletim sisteminin tanidigini tanir.
 */
const hubFetch = (input: string, init?: RequestInit): Promise<Response> => net.fetch(input, init)

/** Toplayicinin merkeze gonderim ayari; kayit yoksa gonderim yok. */
function workerHub(): WorkerHub | null {
  const targets = writeTargets(config.hub)
  return targets.length === 0 ? null : { targets, sendProjectNames: config.shareProjectPaths }
}

/** Ilk taramanin yuzdesi; tarama bittiyse 100, toplayici yoksa null. */
function scanPct(): number | null {
  const p = lastTokens?.progress
  if (p === undefined || p === null) return null
  if (p.phase === 'idle') return 100
  return p.totalBytes > 0 ? Math.min(99, Math.floor((p.doneBytes / p.totalBytes) * 100)) : 0
}

function createHub(): HubSync {
  return createHubSync({
    fetch: hubFetch,
    now: Date.now,
    accounts: ACCOUNT_KEYS,
    getHub: () => config.hub,
    saveHub: async (hub) => {
      config = { ...config, hub }
      await saveConfig(configFile, config)
      tokens?.setHub(workerHub())
      safeLog('info', 'merkeze cihaz kaydi yapildi', { deviceId: hub.deviceId })
    },
    deviceName: () => config.hub.deviceName ?? hostname(),
    os: process.platform,
    version: app.getVersion(),
    readQuota: async (account, from, to) => {
      const { entries } = await readRange(historyDirFor(account), from, to - 1)
      return entries
        .filter((e) => e.windows.length > 0)
        .map((e) => ({
          account,
          fetchedAt: e.at,
          windows: e.windows.map((w) => ({ label: w.label, percent: w.percent, resetsAtMs: w.resetsAtMs }))
        }))
    },
    collectorInfo: () => ({ queue: lastHubState?.queue ?? null, scanPct: scanPct() }),
    localUsage: async (from, to, step, by, deviceId) => (await tokens?.usage(from, to, step, by, deviceId)) ?? null
  })
}

/**
 * Ayrintili panel: merkezin sayfasinin aynisi, uygulamanin icinden. Veri ana
 * surec uzerinden gelir (cihaz anahtari sayfaya hic inmez); merkez yoksa bu
 * cihazin kendi verisi gosterilir.
 */
function openPanel(): void {
  if (panel !== null && !panel.isDestroyed()) {
    if (panel.isMinimized()) panel.restore()
    panel.show()
    panel.focus()
    return
  }
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 380,
    minHeight: 480,
    show: false,
    backgroundColor: '#0e0e10',
    autoHideMenuBar: true,
    title: t(lang, 'panel.title'),
    ...windowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  panel = win
  // Panel baska pencere acmaz, baska sayfaya gitmez.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (panel === win) panel = null
  })
  void win.loadFile(join(__dirname, '../panel/index.html'))
}

/**
 * Kota verisi `claude` calistirilabilirinden GELMIYOR: once uc, olmazsa yapisal
 * onbellek. CLI yalniz suresi dolmus jetonu tazelemek icin, hesabin kendi
 * klasoruyle calistirilir.
 */
function createAccountCollector(key: AccountKey): ReturnType<typeof createCollector> {
  const paths = pathsFor(key)
  const readUsage = createUsageReader({
    fs: { readFile: (file) => readFile(file, 'utf8') },
    files: { accountFile: paths.accountFile, credentialsFile: paths.credentialsFile },
    refreshToken: createCliRefresher({ configDir: paths.cliConfigDir }),
    // macOS'ta jeton dosyada degil Anahtar Zinciri'nde.
    ...(process.platform === 'darwin' ? { readToken: createKeychainTokenReader(paths.cliConfigDir) } : {})
  })
  // Konfigdeki aralik (en az 2 dk, bkz. MIN_POLL_INTERVAL_MS). F1'de verilmeyi unutulmustu; ayar olu kalmis,
  // toplayici hep varsayilan 5 dk ile calismisti (olculdu: son 24 saatte 287 olcum).
  return createCollector(
    { readUsage },
    { dataDir: historyDirFor(key), pollIntervalMs: config.pollIntervalMs, jitterMs: POLL_JITTER_MS }
  )
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

function createAccounts(): AccountManager {
  return createAccountManager({
    presence: (key) =>
      detectPresence(pathsFor(key), (file) => readAccountIdentity(nodePathFs, file), fileExists),
    readAuth: (key) => readAccountIdentity(nodePathFs, pathsFor(key).accountFile),
    createCollector: createAccountCollector
  })
}

/**
 * Buyuk sayida ve tepside gosterilen hesabin durumu. Secili hesap bagli
 * degilse tepside "yukleniyor" degil "veri yok" gorunur; aksi halde gosterge
 * sonsuza dek bekliyor gibi durur.
 */
function focusStatus(): UsageStatus {
  const focused = accounts?.accounts().find((a) => a.key === config.focusAccount)
  return focused?.status ?? { kind: 'loading' }
}

function payload(): StatePayload {
  return {
    accounts: accounts?.accounts() ?? [],
    focus: config.focusAccount,
    tokens: lastTokens,
    sessions: lastSessions,
    // "Tepsi nesnesi var" degil, **gizlemek guvenli mi**. Gorunmeyen tepside
    // gizlemek widget-i geri getirilemez yapar; arayuz dugmeyi buna gore adlandirir.
    trayAvailable: caps.canHideWidget,
    lang
  }
}

/** Tepsi ipucunun ust ve alt satiri: secili hesabin adi, digerlerinin ozeti. */
function accountTooltipLines(): { header: string; others: string[] } {
  const all = accounts?.accounts() ?? []
  const label = (key: AccountKey): string => t(lang, key === 'personal' ? 'account.personal' : 'account.team')
  const others = all
    .filter((a) => a.key !== config.focusAccount)
    .map((a) => {
      if (a.presence === 'not-connected') return `${label(a.key)}: ${t(lang, 'account.notConnected')}`
      const s = a.status
      const snap = s.kind === 'ok' || s.kind === 'stale' ? s.snapshot : s.kind === 'error' ? s.lastSnapshot : null
      const session = snap?.windows.find((w) => /session/i.test(w.label)) ?? snap?.windows[0]
      return session === undefined ? `${label(a.key)}: —` : `${label(a.key)}: ${formatPercent(lang, session.percent)}`
    })
  return { header: label(config.focusAccount), others }
}

function updateTray(status: UsageStatus): void {
  if (tray === null) return
  const widgetVisible = widget?.isVisible() ?? false
  const plan = applyIndicator(
    asTrayLike(tray),
    status,
    caps,
    {
      // macOS'ta sayi menu cubugunda metin olarak duruyor; ikona da cizilirse
      // olcum yokken '-' isareti gorunuyor. Orada ikon sade kalir.
      // macOS'ta sayi menu cubugunda metin; Windows/Linux'ta ikona cizilir.
      // Renderer canvas ikonu gondermeye basladiysa piksel font devreden cikar.
      renderIcon:
        caps.textLabel || canvasIconActive ? undefined : (spec) => iconFor(spec, TRAY_ICON_PX),
      buildMenu: (template) => menuFrom(template)
      // Gorev cubugu ilerleme cubugu KULLANILMIYOR: widget `skipTaskbar: true`,
      // yani gorev cubugunda dugmesi yok. `setProgressBar()` dugme gerektirdigi
      // icin pencereyi gorev cubuguna geri sokuyor — istenen bu degil.
      // Gosterge tepsi ikonunda; ilerleme cubugu ayri bir yuzey isterse
      // ayri (gorunmez) bir pencere gerekir, o ayri bir karar.
    },
    { widgetVisible, lang }
  )
  // Ipucu hangi hesabin gosterildigini soyler; digeri tek satirda durur.
  const lines = accountTooltipLines()
  tray.setToolTip(composeAccountTooltip(plan.tooltip, lines.header, lines.others))
  // Menuyu applyIndicator da deps.buildMenu ile kuruyor; ikisi ayni dili
  // almazsa sonuncusu kazanir ve menu diger dilde kalir.
  tray.setContextMenu(menuFrom(buildTrayMenuTemplate(status, { widgetVisible, lang })))
}

function publish(): void {
  updateTray(focusStatus())
  if (widget !== null && !widget.isDestroyed()) {
    widget.webContents.send('usage:state', payload())
  }
}

const WIDGET_WIDTH = 248
/** Uc pencere (oturum + hafta + model) olcek gorunumunde bu yuksekligi ister. */
const WIDGET_HEIGHT = 200
// Baslangic alt siniri varsayilan gorunumundur; renderer acilista secili
// gorunumu bildirince `widget:theme` bunu gunceller.
const WIDGET_MIN_WIDTH = THEME_MIN_SIZE.focus.width
const WIDGET_MIN_HEIGHT = THEME_MIN_SIZE.focus.height

/**
 * Wayland'da pencere konumu uygulanamaz (`setPosition` desteklenmiyor).
 * Kaydedilmis konumu uygulamaya calismak sessizce bir sey yapmaz; onun yerine
 * bilinen bir yere — birincil ekranin sag ustune — acilir.
 */
const isWayland =
  process.platform === 'linux' &&
  (process.env['XDG_SESSION_TYPE'] === 'wayland' || process.env['WAYLAND_DISPLAY'] !== undefined)

function widgetStartBounds(): WidgetBounds {
  const saved = config.widgetBounds
  if (saved !== null && !isWayland) return saved
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - WIDGET_WIDTH - 24,
    y: area.y + 24,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT
  }
}

function createWidget(): void {
  const bounds = widgetStartBounds()
  widget = new BrowserWindow({
    // Kaydedilmis boyut geri yuklenir; sabit deger yalniz ilk acilista kullanilir.
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: WIDGET_MIN_WIDTH,
    minHeight: WIDGET_MIN_HEIGHT,
    frame: false,
    resizable: true,
    // Windows Aero Snap resizable + maximizable ikilisine bagli. Widget kenara
    // surukleninde ekranin yarisina yapismamali; maximize kapatilinca snap kalkar,
    // kenarlardan elle boyutlandirma calismaya devam eder.
    maximizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    ...windowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // 'screen-saver' seviyesi tam ekran uygulamalarin da ustunde kalir.
  widget.setAlwaysOnTop(true, 'screen-saver')
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const rememberBounds = (): void => {
    if (widget === null) return
    const b = widget.getBounds()
    config = { ...config, widgetBounds: { x: b.x, y: b.y, width: b.width, height: b.height } }
    void saveConfig(configFile, config).catch(() => undefined)
  }

  widget.on('moved', rememberBounds)
  widget.on('resized', () => {
    if (widget === null) return
    // Acilis yerlesimi kullanici mudahalesi degil.
    if (!firstFitDone) return
    const [w, h] = widget.getSize()
    if (programmaticTarget !== null && programmaticTarget.width === w && programmaticTarget.height === h) {
      // Ulasilan boyut bizim hedefimiz; kullanici mudahalesi degil.
      programmaticTarget = null
      return
    }
    userSized = true
    rememberBounds()
  })

  // maximizable:false snap'i kapatir; bu emniyet kemeri, isletim sistemi yine de
  // buyutmeyi denerse widget eski boyutuna doner.
  widget.on('maximize', () => widget?.unmaximize())

  widget.on('closed', () => {
    widget = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL'] !== undefined) {
    void widget.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void widget.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWidget(): void {
  // Acilis surerken gelen istek yok sayilir, ertelenmez: `whenReady` zaten
  // pencereyi kurup gosterecek. Erken donmek bir sey kaybettirmez.
  if (!appReady) {
    safeLog('debug', 'acilis surerken gosterim istegi geldi, atlandi')
    return
  }
  if (widget === null) createWidget()
  widget?.showInactive()
  updateTray(focusStatus())
}

function toggleWidget(): void {
  if (widget !== null && widget.isVisible()) {
    widget.hide()
    updateTray(focusStatus())
    return
  }
  showWidget()
}

/** Hesaplarin kurum kimlikleri; token kayitlarini hesaplara baglar. */
async function readOrgs(): Promise<{ personal: string | null; team: string | null }> {
  const [personal, team] = await Promise.all(
    (['personal', 'team'] as const).map((key) =>
      readOrganizationId(nodePathFs, pathsFor(key).accountFile).catch(() => null)
    )
  )
  return { personal: personal ?? null, team: team ?? null }
}

/** Token toplayici surecini baslatir; ozet geldikce widget'a yayinlanir. */
async function startTokens(): Promise<void> {
  tokens = startTokenService({
    dbFile: join(dataDir, 'usage.db'),
    sources: ACCOUNT_KEYS.map((key) => ({ account: key, projectsDir: pathsFor(key).projectsDir })),
    keys: [...ACCOUNT_KEYS],
    orgs: await readOrgs(),
    hub: workerHub(),
    onState: (state) => {
      lastTokens = state
      publish()
    },
    onHubState: (state) => {
      lastHubState = state
    }
  })
}

/** Merkez nabzi, kota gonderimi ve (ev agindaysa) ilk kayit bu aralikla. */
const HUB_TICK_MS = 5 * 60 * 1000

function startHub(): void {
  hubSync = createHub()
  const tick = (): void => {
    void hubSync?.tick().catch((error: unknown) => safeLog('warn', 'merkez turu basarisiz', { error }))
  }
  tick()
  setInterval(tick, HUB_TICK_MS)
  // Yeni kota olcumu gelince beklemeden gonderilir; kayitli degilse bir sey yapmaz.
  accounts?.onChange(() => {
    if (hubSync?.phase() === 'ok') void hubSync.flushQuota().catch(() => undefined)
  })
}

/** Kota disindaki bilgiler: hesap kimligi, kurumlar ve acik oturumlar. */
async function refreshSideChannels(): Promise<void> {
  // Kimlik dosyadan okunur; `claude auth status` cagrisina gerek yok.
  await accounts?.refreshIdentity()
  // Team'e sonradan giris yapilmissa kurumu simdi ogrenilir.
  if (tokens !== null) tokens.setOrgs(await readOrgs())
  try {
    lastSessions = await scanClaudeSessions()
  } catch (error: unknown) {
    safeLog('debug', 'surec taramasi basarisiz', { error })
  }
}

function createTray(): void {
  try {
    const idle = renderStatusIcon(
      { percent: null, level: 'normal', badge: null, stale: false },
      { size: 16 }
    )
    tray = new Tray(createTrayImage(idle, nativeImage) as Electron.NativeImage)
    tray.on('click', () => toggleWidget())

    // Tepsi olusturuldu; simdi gercekten gorunur mu diye olculur. Linux'ta
    // masaustu ortami SNI/AppIndicator sunmuyorsa ikon sessizce gorunmez.
    caps = detectCapabilities(platform, {
      trayPresence: probeTrayPresence(platform, true, {
        XDG_CURRENT_DESKTOP: process.env['XDG_CURRENT_DESKTOP'],
        DESKTOP_SESSION: process.env['DESKTOP_SESSION']
      })
    })
    safeLog('debug', 'tepsi yetenegi', {
      presence: caps.presence,
      gizlemeGuvenli: caps.canHideWidget
    })
  } catch (error: unknown) {
    // Bazi Linux masaustlerinde tray yok. Sahte bir cubuk uydurulmaz;
    // widget tek basina calisir ve durum loglanir.
    tray = null
    safeLog('warn', 'sistem cubugu olusturulamadi, widget tek basina calisiyor', { error })
  }
}

const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => showWidget())

  void app.whenReady().then(async () => {
    lang = pickLang(app.getLocale())
    // Tepsi bu satirdan once kurulmus olabilir; dil belli olunca yeniden cizilir.
    updateTray(focusStatus())
    safeLog('debug', 'arayuz dili', { locale: app.getLocale(), secilen: lang })

    if (process.platform === 'win32') app.setAppUserModelId('dev.fanthal.claude-usage-widget')
    // Arka plan araci: dock'ta yer kaplamaz (macOS LSUIElement karsiligi).
    if (process.platform === 'darwin') app.dock?.hide()

    // Konfigten ONCE kurulur: acilista cikan sorunlar da kayda gecsin.
    // Varsayilan `console` paketlenmis app'te hicbir yere gorunmuyor.
    setLogSink(createFileSink(join(appDataDir(), 'diagnostics.log')))

    configFile = appConfigFile()
    const loaded = await loadConfig(configFile)
    config = loaded.config
    if (loaded.issues.length > 0) safeLog('warn', 'konfig sorunlari', { issues: loaded.issues })
    accounts = createAccounts()

    createTray()
    if (widget === null) createWidget()
    widget?.once('ready-to-show', () => {
      widget?.showInactive()
      updateTray(focusStatus())
    })
    // Bu satira kadar `await` YOK: arada bir olay isleyicisi devreye girip
    // yarim kurulmus duruma dokunamaz. Yeni `await` eklenirse bu satir onun
    // ustunde kalmali.
    appReady = true

    accounts.onChange(publish)
    void accounts
      .start()
      .then(() => refreshSideChannels())
      .then(() => publish())
    startTokens()
      .catch((error: unknown) => {
        safeLog('warn', 'toplayici sureci baslatilamadi', { error })
        lastTokens = { accounts: [], progress: null, error: 'toplayici baslatilamadi' }
        publish()
      })
      // Merkez toplayicidan sonra: kayit olunca anahtar toplayiciya iletilir.
      .finally(() => startHub())
    // Kurum kimlikleri ve oturumlar seyrek degisir; on dakikada bir tazelenir.
    setInterval(() => void refreshSideChannels().then(() => publish()), 10 * 60 * 1000)

    ipcMain.handle('widget:theme', (_event, theme: unknown) => {
      if (!isWidgetTheme(theme) || widget === null) return
      // Alt sinir burada YUKSELTILMEZ: yukseltmek pencereyi buyutur, o da
      // `resized` tetikler ve fit kilitlenirdi. Sinir mutlak tabana indirilir
      // (kucultmek olay tetiklemez); gercek sinir hemen ardindan gelen
      // `widget:fit` olcumuyle konur. THEME_MIN_SIZE yalniz emniyet tabanidir.
      widget.setMinimumSize(ABSOLUTE_MIN.width, ABSOLUTE_MIN.height)
    })

    ipcMain.handle('widget:fit', (_event, width: unknown, height: unknown) => {
      if (widget === null) return
      if (typeof width !== 'number' || typeof height !== 'number') return
      if (!Number.isFinite(width) || !Number.isFinite(height)) return
      const w = Math.max(120, Math.ceil(width))
      const h = Math.max(60, Math.ceil(height))
      const [preW, preH] = widget.getSize()
      safeLog('debug', 'fit', { istenen: `${w}x${h}`, mevcut: `${preW}x${preH}`, userSized })

      const [curW, curH] = widget.getSize()
      if (!userSized) {
        // Kullanici boyuta karismadi: pencere icerige tam oturur — buyur de kuculur.
        // Gorunum degisince (kadran -> serit) widget kendiliginden toparlanir.
        applyFit(widget, w, h, w, h)
        firstFitDone = true
        return
      }
      // Kullanici kendi boyutunu sectiyse ona dokunulmaz; yalnizca icerik
      // sigmiyorsa buyutulur (kirpilma yasak), asla kucultulmez.
      const nextW = Math.max(curW ?? w, w)
      const nextH = Math.max(curH ?? h, h)
      applyFit(widget, w, h, nextW, nextH)
      firstFitDone = true
    })

    // Elle surukleme: OS tasima islemi baslamadigi icin Snap Layouts tetiklenmez.
    let dragOffset: { x: number; y: number } | null = null
    ipcMain.on('widget:drag-start', () => {
      if (widget === null) return
      const cursor = screen.getCursorScreenPoint()
      const [wx, wy] = widget.getPosition()
      dragOffset = { x: (wx ?? cursor.x) - cursor.x, y: (wy ?? cursor.y) - cursor.y }
    })
    ipcMain.on('widget:drag-move', () => {
      if (widget === null || dragOffset === null) return
      const cursor = screen.getCursorScreenPoint()
      widget.setPosition(cursor.x + dragOffset.x, cursor.y + dragOffset.y)
    })
    ipcMain.on('widget:drag-end', () => {
      dragOffset = null
      if (widget === null) return
      const b = widget.getBounds()
      config = { ...config, widgetBounds: { x: b.x, y: b.y, width: b.width, height: b.height } }
      void saveConfig(configFile, config).catch(() => undefined)
    })

    ipcMain.on('tray:icon', (_event, dataUrl: unknown) => {
      if (tray === null || typeof dataUrl !== 'string') return
      if (!dataUrl.startsWith('data:image/png;base64,')) return
      const image = nativeImage.createFromDataURL(dataUrl)
      if (image.isEmpty()) return
      // 64 px'te cizilip burada tam sayi carpanla kucultuluyor: Electron'un
      // 'best' filtresi rakami yumusatir, blokli kenar birakmaz.
      const small = image.resize({ width: 16, height: 16, quality: 'best' })
      tray.setImage(small)
      if (!canvasIconActive) {
        const s = image.getSize()
        safeLog('debug', 'tepsi ikonu canvas ile ciziliyor', { kaynak: `${s.width}x${s.height}` })
      }
      canvasIconActive = true
    })

    ipcMain.handle('widget:close', () => {
      // Tepsi var ama gorunmuyorsa gizlemek uygulamayi erisilemez yapar.
      if (tray === null || !caps.canHideWidget) {
        // Tepsi ikonu yok: gizlemek uygulamayi erisilemez birakirdi.
        app.quit()
        return
      }
      widget?.hide()
      updateTray(focusStatus())
    })

    ipcMain.handle('widget:account', (_event, key: unknown) => {
      if (!isAccountKey(key) || key === config.focusAccount) return
      config = { ...config, focusAccount: key }
      void saveConfig(configFile, config).catch(() => undefined)
      publish()
    })

    ipcMain.handle('widget:panel', () => openPanel())
    // Panel penceresinin tek veri yolu. Yol `panelGet` icinde dogrulanir:
    // bilinen okuma uclari disinda istek yapilmaz.
    ipcMain.handle('panel:get', async (_event, path: unknown) => {
      if (typeof path !== 'string' || hubSync === null) return { ok: false, local: true, body: null }
      return await hubSync.panelGet(path)
    })
    ipcMain.handle('panel:lang', () => lang)

    ipcMain.handle('usage:get', () => payload())
    ipcMain.handle('usage:refresh', async () => {
      // Elle yenileme bagli olmayan hesabi da yoklar: Team'e az once giris
      // yapildiysa bes dakikayi beklemeden gorunur.
      await refreshSideChannels()
      tokens?.rescan()
      await accounts?.pollAll()
      return payload()
    })
  })

  // Tray'de yasayan bir arac; son pencere kapaninca cikmaz.
  app.on('window-all-closed', () => {
    if (tray === null) app.quit()
  })

  app.on('before-quit', () => {
    accounts?.stop()
    tokens?.stop()
  })
}
