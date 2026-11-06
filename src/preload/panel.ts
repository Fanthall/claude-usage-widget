import { contextBridge, ipcRenderer } from 'electron'

/**
 * Panel penceresinin koprusu. Sayfa merkeze kendisi gitmez: istek ana surece
 * gider, ana surec cihaz anahtariyla merkeze sorar ya da yerel veriye duser.
 * Anahtar bu yuzden sayfaya hic inmez.
 */
const bridge = {
  get: (path: string): Promise<{ ok: boolean; local: boolean; body: unknown }> => ipcRenderer.invoke('panel:get', path),
  lang: (): Promise<'tr' | 'en'> => ipcRenderer.invoke('panel:lang')
}

contextBridge.exposeInMainWorld('panelBridge', bridge)
