import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Widget } from './Widget'
import { installDevPreview } from './dev-preview'
import './index.css'

// Electron disinda (tarayici onizlemesi) sahte kopru kurar; Electron'da hicbir sey yapmaz.
installDevPreview()

const host = document.getElementById('root')
if (host === null) throw new Error('#root bulunamadi')

createRoot(host).render(
  <StrictMode>
    <Widget />
  </StrictMode>
)
