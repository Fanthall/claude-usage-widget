import { contextBridge, ipcRenderer } from 'electron'

import type { StatePayload, WidgetTheme } from '../shared/types'

/**
 * Wayland pencerelerin kendi konumunu belirlemesine izin vermez:
 * `setPosition` / `getCursorScreenPoint` orada calismaz, yani elle surukleme
 * olur. Cozum CSS surukleme — tasimayi compositor yapar.
 *
 * Windows/macOS/X11'de elle surukleme KALIR: orada CSS surukleme isletim
 * sisteminin tasima islemini baslatir ve Windows Snap Layouts devreye girer.
 */
const dragMode: 'manual' | 'css' =
  process.platform === 'linux' &&
  (process.env['XDG_SESSION_TYPE'] === 'wayland' || process.env['WAYLAND_DISPLAY'] !== undefined)
    ? 'css'
    : 'manual'

const api = {
  platform: process.platform,
  /** Surukleme nasil yapilacak. Wayland'da 'css', digerlerinde 'manual'. */
  dragMode,
  /** Secilen gorunumu bildirir; ana surec alt siniri ona gore ayarlar. */
  setTheme: (theme: WidgetTheme): Promise<void> => ipcRenderer.invoke('widget:theme', theme),
  /**
   * Icerigin olculmus dogal boyutu. Alt sinir buradan gelir — sabit sayi degil,
   * gercekten cizilen icerik. Pencere bunun altina inemez, icerik kirpilmaz.
   */
  fitToContent: (width: number, height: number): Promise<void> =>
    ipcRenderer.invoke('widget:fit', width, height),
  /**
   * Elle surukleme. `-webkit-app-region: drag` isletim sisteminin pencere tasima
   * islemini baslatiyor ve Windows Snap Layouts oraya bagli — kenara gelince
   * yapisiyor. Konumu kendimiz verince OS bir tasima gormuyor, snap tetiklenmiyor.
   * Imlec konumunu ana surec okur (DPI olceklemesinden etkilenmez).
   */
  /**
   * Kapat. Tepsi ikonu varsa widget gizlenir (ikondan geri acilir); tepsi yoksa
   * gizlemek uygulamayi erisilemez yapardi, o yuzden uygulama kapanir.
   * Karari ana surec verir — renderer tepsinin durumunu takip etmek zorunda degil.
   */
  close: (): Promise<void> => ipcRenderer.invoke('widget:close'),
  /**
   * Renderer'da gercek fontla cizilmis tepsi ikonu (PNG data URL). Ana surecin
   * elle yazilmis piksel fontu 16 px'de okunmuyordu; canvas gercek rasterizasyon
   * ve kenar yumusatma veriyor.
   */
  setTrayIcon: (dataUrl: string): void => ipcRenderer.send('tray:icon', dataUrl),
  dragStart: (): void => ipcRenderer.send('widget:drag-start'),
  dragMove: (): void => ipcRenderer.send('widget:drag-move'),
  dragEnd: (): void => ipcRenderer.send('widget:drag-end'),
  /** Acilista mevcut durumu ister. */
  get: (): Promise<StatePayload> => ipcRenderer.invoke('usage:get'),
  /** Kullanici "simdi yenile" dediginde. */
  refresh: (): Promise<StatePayload> => ipcRenderer.invoke('usage:refresh'),
  /** Ana surecten gelen yayina abone olur; aboneligi biten fonksiyon doner. */
  onState: (handler: (payload: StatePayload) => void): (() => void) => {
    const listener = (_event: unknown, payload: StatePayload): void => handler(payload)
    ipcRenderer.on('usage:state', listener)
    return () => {
      ipcRenderer.removeListener('usage:state', listener)
    }
  }
}

contextBridge.exposeInMainWorld('usageApi', api)

export type UsageApi = typeof api
