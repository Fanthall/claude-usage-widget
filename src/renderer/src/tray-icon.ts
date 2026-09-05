import type { UsageStatus } from '@shared/types'

/**
 * Tepsi ikonunu **gerçek fontla** çizer.
 *
 * Ana süreçte elle yazılmış 3×5 piksel font vardı; 16 px'lik tepsi yuvasında
 * rakamlar bloklu ve okunmaz çıkıyordu (kullanıcı gözlemi 2026-09-05). Renderer
 * tarafında canvas olduğu için burada sistem fontu, gerçek kerning ve
 * kenar yumuşatma kullanılabiliyor: 64 px'te çizilip ana süreçte 16 px'e
 * yüksek kaliteli küçültülüyor.
 *
 * Piksel font ana süreçte **yedek olarak duruyor**: widget penceresi henüz
 * açılmadan da tepside bir ikon olmalı.
 *
 * Renk yalnızca dolum çubuğundadır (yeşil / turuncu / kırmızı); rakam her
 * durumda beyaz — sayının okunurluğu eşikten bağımsızdır.
 *
 * macOS'ta bu çizim KULLANILMAZ: orada yüzde menü çubuğunda metin olarak durur,
 * ikona da çizilirse aynı sayı iki kez görünür. Çağrıyı Widget engeller.
 */

const CANVAS_PX = 64

const LEVEL_COLOR = { normal: '#35c68f', caution: '#e0a33a', critical: '#e5544f' } as const

function levelFor(percent: number): keyof typeof LEVEL_COLOR {
  if (percent >= 90) return 'critical'
  if (percent >= 75) return 'caution'
  return 'normal'
}

/** Gösterge oturum penceresini anlatır; widget ile aynı şeyi söylemeli. */
function primaryPercent(status: UsageStatus): number | null {
  const snap =
    status.kind === 'ok' || status.kind === 'stale'
      ? status.snapshot
      : status.kind === 'error'
        ? status.lastSnapshot
        : null
  if (snap === null) return null
  const usable = snap.windows.filter((w) => Number.isFinite(w.percent))
  const w = usable.find((x) => /session/i.test(x.label)) ?? usable[0]
  return w === undefined ? null : Math.min(100, Math.max(0, Math.round(w.percent)))
}

/**
 * Uç hız sınırına girdi mi (429 → geri çekilme).
 *
 * `rate-limited` bir hata sınıfıdır ama **kırılan bir şey yoktur**: uç bizi
 * bekletiyor, sınır açılınca ölçüm kendiliğinden döner. Bu yüzden gösterge onu
 * hata gibi değil **bayat** gibi işaretler: kırmızı "eline al" diye okunur;
 * kendiliğinden geçen bir durumu alarm rengiyle damgalamak kırmızıyı öğrenilmiş
 * gürültüye çevirir ve gerçek arıza fark edilmez. Söylediği şey de zaten
 * bayatlıktır — gösterilen değer tazelenemediği için eskiyor.
 */
function isBackoff(status: UsageStatus): boolean {
  return status.kind === 'error' && status.errorKind === 'rate-limited'
}

/** Değer yokken çizilen tek karakter. Boş ikon yerine durumu anlatır. */
export function markFor(status: UsageStatus): string {
  if (status.kind === 'error') return isBackoff(status) ? '?' : '!'
  if (status.kind === 'stale') return '?'
  return '·'
}

/** Sağ üstteki damganın rengi; damga gerekmiyorsa null. */
export function badgeColorFor(status: UsageStatus): string | null {
  if (status.kind === 'error') return isBackoff(status) ? '#e0a33a' : '#e5544f'
  if (status.kind === 'stale') return '#e0a33a'
  return null
}

/**
 * İkonu data URL olarak üretir. Değer yoksa sayı UYDURULMAZ — işaret çizilir.
 * Metin, ikonun içine sığana kadar küçültülür; kırpılmış rakam gösterilmez.
 */
export function drawTrayIcon(status: UsageStatus): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_PX
  canvas.height = CANVAS_PX
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null

  const pct = primaryPercent(status)
  const text = pct === null ? markFor(status) : String(pct)
  const color = pct === null ? '#a1a1aa' : LEVEL_COLOR[levelFor(pct)]

  ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX)

  // Alt kenarda dolum çubuğu: **seviyeyi çubuk anlatır**, rakam değil.
  // Rakam her durumda beyaz kalır — sayı okunurluğu renkten bağımsız olsun.
  const pad = 3
  const barH = 9
  const barY = CANVAS_PX - pad - barH
  const barW = CANVAS_PX - pad * 2
  const radius = barH / 2

  const roundedBar = (x: number, w: number): void => {
    if (w <= 0) return
    ctx.beginPath()
    ctx.roundRect(x, barY, Math.max(w, barH), barH, radius)
    ctx.fill()
  }

  ctx.fillStyle = 'rgba(255,255,255,0.24)'
  roundedBar(pad, barW)
  if (pct !== null && pct > 0) {
    ctx.fillStyle = color
    roundedBar(pad, (pct / 100) * barW)
  }

  // Metin çubuğun üstünde kalan alana ortalanır.
  const textAreaH = barY - pad
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const maxWidth = CANVAS_PX - 6
  let fontPx = Math.floor(textAreaH * 1.06)
  const font = (px: number): string => `700 ${px}px "Segoe UI", system-ui, sans-serif`
  ctx.font = font(fontPx)
  while (ctx.measureText(text).width > maxWidth && fontPx > 8) {
    fontPx -= 2
    ctx.font = font(fontPx)
  }

  const cx = CANVAS_PX / 2
  const cy = textAreaH / 2 + pad

  // Koyu kontur: görev çubuğu açık temaya geçse de beyaz rakam okunur kalır.
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(4, fontPx * 0.18)
  ctx.strokeStyle = 'rgba(8,10,14,0.92)'
  ctx.strokeText(text, cx, cy)

  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, cx, cy)

  // Bayat/hata damgası: sağ üstte küçük nokta. Metin zaten durumu söylüyor,
  // bu yalnızca hızlı ayırt etme içindir.
  const badge = badgeColorFor(status)
  if (badge !== null) {
    const r = CANVAS_PX * 0.13
    ctx.beginPath()
    ctx.arc(CANVAS_PX - r - 2, r + 2, r, 0, Math.PI * 2)
    ctx.fillStyle = badge
    ctx.fill()
  }

  return canvas.toDataURL('image/png')
}
