import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isWidgetTheme,
  THEME_MIN_SIZE,
  type StatePayload,
  type UsageStatus
} from '../shared/types'
import { pickLang, type Lang } from '../shared/i18n'
import { createCollector, type CollectorState } from './core/collector'
import { readAccountIdentity } from './core/identity'
import { createUsageReader } from './core/usage-reader'
import { loadConfig, saveConfig, type AppConfig, type WidgetBounds } from './core/config-store'
import { appConfigFile, appDataDir } from './core/paths'
import { safeLog } from './core/log-safe'
import { scanClaudeSessions } from './platform/process-scan'
import {
  applyIndicator,
  buildTrayMenuTemplate,
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
let config: AppConfig
let configFile: string
let lastSessions: StatePayload['sessions'] = null
let lastAuth: StatePayload['auth'] = null
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
  if (action === 'toggle-widget' || action === 'open-panel') toggleWidget()
  else if (action === 'refresh') void collector.pollNow()
  else if (action === 'quit') app.quit()
}

/**
 * Kota verisi artik `claude` calistirilabilirinden GELMIYOR: once uc, olmazsa
 * yapisal onbellek. Boylece 429 gizlenmiyor ve GUI app'in minimal PATH'i
 * (macOS'ta kesfin en buyuk kirilma sebebi) veri yolunu etkilemiyor.
 */
const readUsage = createUsageReader({ fs: { readFile: (file) => readFile(file, 'utf8') } })

const collector = createCollector({ readUsage }, { dataDir })

function payloadFrom(state: CollectorState): StatePayload {
  return {
    status: state.status,
    auth: lastAuth,
    sessions: lastSessions,
    errorStreak: state.errorStreak,
    // "Tepsi nesnesi var" degil, **gizlemek guvenli mi**. Gorunmeyen tepside
    // gizlemek widget-i geri getirilemez yapar; arayuz dugmeyi buna gore adlandirir.
    trayAvailable: caps.canHideWidget,
    lang
  }
}

function updateTray(status: UsageStatus): void {
  if (tray === null) return
  const widgetVisible = widget?.isVisible() ?? false
  applyIndicator(
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
  // Menuyu applyIndicator da deps.buildMenu ile kuruyor; ikisi ayni dili
  // almazsa sonuncusu kazanir ve menu diger dilde kalir.
  tray.setContextMenu(menuFrom(buildTrayMenuTemplate(status, { widgetVisible, lang })))
}

function publish(state: CollectorState): void {
  updateTray(state.status)
  if (widget !== null && !widget.isDestroyed()) {
    widget.webContents.send('usage:state', payloadFrom(state))
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
  if (widget === null) createWidget()
  widget?.showInactive()
  updateTray(collector.getState().status)
}

function toggleWidget(): void {
  if (widget !== null && widget.isVisible()) {
    widget.hide()
    updateTray(collector.getState().status)
    return
  }
  showWidget()
}

/** Kota disindaki bilgiler: hesap kimligi ve acik oturumlar. */
async function refreshSideChannels(): Promise<void> {
  try {
    // Kimlik de dosyadan okunur; `claude auth status` cagrisina gerek yok.
    lastAuth = await readAccountIdentity()
  } catch (error: unknown) {
    safeLog('debug', 'hesap bilgisi okunamadi', { error })
  }
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
    updateTray(collector.getState().status)
    safeLog('debug', 'arayuz dili', { locale: app.getLocale(), secilen: lang })

    if (process.platform === 'win32') app.setAppUserModelId('dev.fanthal.claude-usage-widget')
    // Arka plan araci: dock'ta yer kaplamaz (macOS LSUIElement karsiligi).
    if (process.platform === 'darwin') app.dock?.hide()

    configFile = appConfigFile()
    const loaded = await loadConfig(configFile)
    config = loaded.config
    if (loaded.issues.length > 0) safeLog('warn', 'konfig sorunlari', { issues: loaded.issues })

    createTray()
    createWidget()
    widget?.once('ready-to-show', () => {
      widget?.showInactive()
      updateTray(collector.getState().status)
    })

    collector.onChange(publish)
    collector.start()
    void collector.pollNow()
    void refreshSideChannels().then(() => publish(collector.getState()))

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
      updateTray(collector.getState().status)
    })

    ipcMain.handle('usage:get', () => payloadFrom(collector.getState()))
    ipcMain.handle('usage:refresh', async () => {
      await refreshSideChannels()
      const state = await collector.pollNow()
      return payloadFrom(state)
    })
  })

  // Tray'de yasayan bir arac; son pencere kapaninca cikmaz.
  app.on('window-all-closed', () => {
    if (tray === null) app.quit()
  })

  app.on('before-quit', () => collector.stop())
}
