import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { pickLang, type Lang } from '@shared/i18n'

import { bridgeSource, sameOriginSource, type DataSource, type PanelBridge } from './data'
import { Panel } from './Panel'
import './index.css'

declare global {
  interface Window {
    /** Yalniz widget'in panel penceresinde vardir (preload/panel.ts). */
    panelBridge?: PanelBridge
  }
}

async function boot(): Promise<void> {
  const host = document.getElementById('root')
  if (host === null) throw new Error('#root bulunamadi')

  let source: DataSource
  let lang: Lang
  const bridge = window.panelBridge
  if (bridge === undefined) {
    // Merkezin kendi sayfasi (ev agi): ayni kokenden okur.
    source = sameOriginSource()
    lang = pickLang(navigator.language)
  } else {
    source = bridgeSource(bridge)
    lang = await bridge.lang()
  }
  document.title = lang === 'tr' ? 'Claude kullanımı' : 'Claude usage'

  createRoot(host).render(
    <StrictMode>
      <Panel source={source} lang={lang} />
    </StrictMode>
  )
}

void boot()
