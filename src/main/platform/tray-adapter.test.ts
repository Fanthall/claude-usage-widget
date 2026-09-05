import { describe, expect, it, vi } from 'vitest'
import type { CliErrorKind, TrayCapabilities, UsageSnapshot, UsageStatus } from '../../shared/types'
import { FALLBACK_LANG, type Lang } from '../../shared/i18n'
import {
  CAUTION_PERCENT,
  CRITICAL_PERCENT,
  MAX_TOOLTIP_LENGTH,
  MIN_TEXT_ICON_SIZE,
  applyIndicator,
  buildTrayMenuTemplate,
  classifyLinuxTrayHost,
  countOpaquePixels,
  createTrayImage,
  detectCapabilities,
  errorText,
  getPixel,
  hideWidgetSafetyFor,
  isTrayAssurance,
  levelFor,
  planIndicator,
  probeTrayPresence,
  renderPercentIcon,
  renderStatusIcon,
  renderTrayImage,
  statusSummary,
  toSupportedPlatform,
  trayImageStyleFor,
  trayPresenceNote,
  type CapabilityProbe,
  type IconSpec,
  type NativeImageFactory,
  type NativeImageLike,
  type TrayAssurance,
  type TrayLike,
  type TrayMenuItem
} from './tray-adapter'

/** Tepsi olculdu ve cizildigi biliniyor — cogu testin varsaydigi hal. */
const CONFIRMED: CapabilityProbe = { trayPresence: 'confirmed' }

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    at: 1_757_000_000_000,
    windows: [
      {
        label: 'Current session',
        percent: 83,
        resetsAtRaw: 'Sep 5, 4:50pm',
        resetsAtMs: null
      },
      {
        label: 'Current week',
        percent: 20,
        resetsAtRaw: 'Sep 6, 8am',
        resetsAtMs: null
      }
    ],
    unparsedLines: [],
    raw: '',
    ...overrides
  }
}

function fakeTray(): TrayLike & {
  images: NativeImageLike[]
  tooltips: string[]
  titles: string[]
  menus: unknown[]
} {
  const images: NativeImageLike[] = []
  const tooltips: string[] = []
  const titles: string[] = []
  const menus: unknown[] = []
  return {
    images,
    tooltips,
    titles,
    menus,
    setImage: (image) => void images.push(image),
    setToolTip: (text) => void tooltips.push(text),
    setTitle: (text) => void titles.push(text),
    setContextMenu: (menu) => void menus.push(menu)
  }
}

const NOW = 1_757_000_300_000

// Beklentiler sozlukten TUREMEZ, birebir yazilir: `t()` ile uretilen bir beklenti
// ceviriyi kendi kendine dogrular ve yanlis metni de gecirir.
const TR: Lang = 'tr'
const EN: Lang = 'en'
const HIDE_WIDGET_TR = 'Widget’ı gizle'
const SHOW_WIDGET_TR = 'Widget’ı göster'
const HIDE_WIDGET_EN = 'Hide widget'
const SHOW_WIDGET_EN = 'Show widget'

function stale(ageMs = 4 * 60 * 1000): UsageStatus {
  return { kind: 'stale', snapshot: snapshot(), ageMs, reason: 'poll gecikti' }
}

function failed(errorKind: CliErrorKind, withLast = false): UsageStatus {
  return {
    kind: 'error',
    errorKind,
    message: 'ham mesaj',
    lastSnapshot: withLast ? snapshot({ at: NOW - 5 * 60 * 1000 }) : null
  }
}

function labelOf(menu: TrayMenuItem[], id: string): string {
  const item = menu.find((entry) => entry.id === id)
  if (item === undefined) throw new Error(`menu ogesi yok: ${id}`)
  return item.label
}

describe('detectCapabilities', () => {
  it('macOS metni cubukta gosterir', () => {
    expect(detectCapabilities('darwin', CONFIRMED)).toEqual<TrayAssurance>({
      textLabel: true,
      trayIcon: true,
      progressBar: true,
      presence: 'confirmed',
      canHideWidget: true
    })
  })

  it("Windows'ta metin yok, ilerleme cubugu var", () => {
    expect(detectCapabilities('win32', CONFIRMED)).toEqual<TrayAssurance>({
      textLabel: false,
      trayIcon: true,
      progressBar: true,
      presence: 'confirmed',
      canHideWidget: true
    })
  })

  it('Linux varsayilani en tutucu yetenek kumesidir', () => {
    expect(detectCapabilities('linux', CONFIRMED)).toEqual<TrayAssurance>({
      textLabel: false,
      trayIcon: true,
      progressBar: false,
      presence: 'confirmed',
      canHideWidget: true
    })
  })

  it("Linux'ta tray olusturulamadiysa trayIcon false doner", () => {
    expect(detectCapabilities('linux', { trayPresence: 'absent' })).toEqual<TrayAssurance>({
      textLabel: false,
      trayIcon: false,
      progressBar: false,
      presence: 'absent',
      canHideWidget: false
    })
  })

  it('Linux masaustu metin destekliyorsa textLabel acilir', () => {
    expect(
      detectCapabilities('linux', { trayPresence: 'confirmed', desktopSupportsLabel: true })
        .textLabel
    ).toBe(true)
  })

  it('tray yoksa metin destegi de dusurulur', () => {
    const caps = detectCapabilities('linux', { trayPresence: 'absent', desktopSupportsLabel: true })
    expect(caps).toEqual<TrayAssurance>({
      textLabel: false,
      trayIcon: false,
      progressBar: false,
      presence: 'absent',
      canHideWidget: false
    })
  })

  // ── Kilitlenme tuzagi: "belirsiz" != "var" ────────────────────────────────
  // Stock GNOME'da `new Tray()` throw etmez, ikon gorunmez. Ikili bayrakla bu
  // hal "var" tarafina duser, widget gizlenir ve geri getirilemez.

  it('dogrulanmamis tepside ikon YINE cizilir ama widget gizlenemez', () => {
    const caps = detectCapabilities('linux', { trayPresence: 'unverified' })
    expect(caps.trayIcon).toBe(true)
    expect(caps.canHideWidget).toBe(false)
    expect(caps.presence).toBe('unverified')
  })

  it('yalnizca dogrulanmis tepside gizleme guvenlidir', () => {
    expect(detectCapabilities('win32', CONFIRMED).canHideWidget).toBe(true)
    expect(detectCapabilities('darwin', CONFIRMED).canHideWidget).toBe(true)
    expect(detectCapabilities('linux', { trayPresence: 'unverified' }).canHideWidget).toBe(false)
    expect(detectCapabilities('linux', { trayPresence: 'absent' }).canHideWidget).toBe(false)
  })

  it('sonuc TrayCapabilities yerine gecer — mevcut kod bozulmaz', () => {
    const caps: TrayCapabilities = detectCapabilities('win32', CONFIRMED)
    expect(caps.trayIcon).toBe(true)
    expect(isTrayAssurance(caps)).toBe(true)
    expect(isTrayAssurance({ textLabel: false, trayIcon: true, progressBar: false })).toBe(false)
  })
})

describe('probeTrayPresence', () => {
  it('tray kurulamadiysa platform fark etmez: absent', () => {
    expect(probeTrayPresence('win32', false)).toBe('absent')
    expect(probeTrayPresence('darwin', false)).toBe('absent')
    expect(probeTrayPresence('linux', false, { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('absent')
  })

  it('Windows ve macOS kurulduysa dogrulanmis sayilir', () => {
    expect(probeTrayPresence('win32', true)).toBe('confirmed')
    expect(probeTrayPresence('darwin', true)).toBe('confirmed')
  })

  it("Linux'ta karar masaustune bakar, kurulmus olmasina degil", () => {
    expect(probeTrayPresence('linux', true, { XDG_CURRENT_DESKTOP: 'KDE' })).toBe('confirmed')
    expect(probeTrayPresence('linux', true, { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('unverified')
  })
})

describe('classifyLinuxTrayHost', () => {
  it('tepsi cizdigi bilinen masaustlerini dogrular', () => {
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('confirmed')
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'XFCE' })).toBe('confirmed')
    expect(classifyLinuxTrayHost({ DESKTOP_SESSION: 'cinnamon' })).toBe('confirmed')
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'X-Cinnamon:Cinnamon' })).toBe('confirmed')
  })

  it('GNOME dogrulanmaz — tepsi ucuncu-parti eklentiye bagli', () => {
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('unverified')
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' })).toBe('unverified')
  })

  it('bos veya taninmayan ortam dogrulanmaz', () => {
    expect(classifyLinuxTrayHost({})).toBe('unverified')
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: '' })).toBe('unverified')
    expect(classifyLinuxTrayHost({ XDG_CURRENT_DESKTOP: 'sway' })).toBe('unverified')
  })
})

describe('hideWidgetSafetyFor', () => {
  it('gizleme karari tepsi olcumune baglidir', () => {
    expect(hideWidgetSafetyFor('confirmed')).toBe('safe')
    expect(hideWidgetSafetyFor('unverified')).toBe('confirm')
    expect(hideWidgetSafetyFor('absent')).toBe('blocked')
  })

  it('dogrulanmis disinda not uretilir, dogrulanmista bos kalir', () => {
    for (const lang of [TR, EN]) {
      expect(trayPresenceNote(lang, 'confirmed')).toBe('')
      expect(trayPresenceNote(lang, 'unverified')).not.toBe('')
      expect(trayPresenceNote(lang, 'absent')).not.toBe('')
    }
  })

  it('not iki dilde de sozlukten gelir', () => {
    expect(trayPresenceNote(TR, 'unverified')).toBe('Tepsi ikonu doğrulanamadı')
    expect(trayPresenceNote(TR, 'absent')).toBe('Tepsi ikonu yok')
    expect(trayPresenceNote(EN, 'unverified')).toBe('Tray icon unverified')
    expect(trayPresenceNote(EN, 'absent')).toBe('No tray icon')
  })
})

describe('toSupportedPlatform', () => {
  it('desteklenmeyen platform null doner', () => {
    expect(toSupportedPlatform('freebsd')).toBeNull()
    expect(toSupportedPlatform('win32')).toBe('win32')
  })
})

describe('levelFor', () => {
  it('esikleri sinirlarda dogru siniflandirir', () => {
    expect(levelFor(0)).toBe('normal')
    expect(levelFor(CAUTION_PERCENT - 1)).toBe('normal')
    expect(levelFor(CAUTION_PERCENT)).toBe('caution')
    expect(levelFor(CRITICAL_PERCENT - 1)).toBe('caution')
    expect(levelFor(CRITICAL_PERCENT)).toBe('critical')
    expect(levelFor(100)).toBe('critical')
  })
})

describe('renderPercentIcon', () => {
  it('istenen boyutta BGRA tamponu uretir', () => {
    const icon = renderPercentIcon(83, { size: 16 })
    expect(icon.width).toBe(16)
    expect(icon.height).toBe(16)
    expect(icon.data.length).toBe(16 * 16 * 4)
  })

  it('rakamlar cizilir — tampon bos degildir', () => {
    expect(countOpaquePixels(renderPercentIcon(83, { size: 16 }))).toBeGreaterThan(0)
  })

  it('farkli yuzdeler farkli tampon uretir', () => {
    const a = renderPercentIcon(0, { size: 16 })
    const b = renderPercentIcon(83, { size: 16 })
    expect(a.data).not.toEqual(b.data)
    expect(countOpaquePixels(a)).toBeGreaterThan(0)
    expect(countOpaquePixels(b)).toBeGreaterThan(0)
  })

  it('ayni girdi ayni tamponu uretir (saf)', () => {
    expect(renderPercentIcon(42, { size: 22 }).data).toEqual(
      renderPercentIcon(42, { size: 22 }).data
    )
  })

  it.each([16, 22, 32])('%s px ikonda rakamlar cizilir', (size) => {
    const icon = renderPercentIcon(83, { size })
    // Rakam okunurlugu '%' isaretinden onceliklidir: isaret ancak rakamlari
    // kucultmeden siğiyorsa eklenir. Tepside asil bilgi sayidir.
    expect(icon.layout.text.startsWith('83')).toBe(true)
    expect(icon.layout.scale).toBeGreaterThanOrEqual(1)
    // Rakam pikselleri + hale + cubuk: ikonun anlamli bir kismi doludur.
    expect(countOpaquePixels(icon)).toBeGreaterThan(size)
  })

  it('uc haneli yuzdede isaret dusurulur, sayi korunur', () => {
    expect(renderPercentIcon(100, { size: 16 }).layout.text).toBe('100')
    expect(renderPercentIcon(100, { size: 32 }).layout.text).toBe('100')
    // Iki hane her zaman cizilir; isaret yalnizca yer artarsa eklenir.
    expect(renderPercentIcon(99, { size: 32 }).layout.text.startsWith('99')).toBe(true)
  })

  it('rakam boyu 1-2 hane arasinda sabittir; yalniz 100 esiginde degisir', () => {
    // Olcek artik cizilecek metne gore secilir (eskiden hep "100" referansti ve
    // iki haneli deger gereksiz kucuk ciziliyordu — tepside okunmuyordu).
    // Gunluk aralikta (0-99) boy sabit kalmali ki ikon her olcumde zipmasin.
    for (const size of [16, 22, 32]) {
      const gunluk = [0, 5, 42, 99].map((p) => renderPercentIcon(p, { size }).layout.scale)
      expect(new Set(gunluk).size).toBe(1)
    }
    // Uc hane daha dar cizilir; bu tek seferlik ve kacinilmaz.
    expect(renderPercentIcon(100, { size: 16 }).layout.scale).toBeLessThanOrEqual(
      renderPercentIcon(99, { size: 16 }).layout.scale
    )
  })

  it('iki haneli deger 16 px ikonda scale 1 degil, daha buyuk cizilir', () => {
    // Kullanici sikayeti (2026-09-05): tepside yazi cok kucuktu.
    expect(renderPercentIcon(28, { size: 16 }).layout.scale).toBeGreaterThan(1)
  })

  it('rakam boyu ikon buyudukce artar', () => {
    expect(renderPercentIcon(83, { size: 32 }).layout.scale).toBeGreaterThan(
      renderPercentIcon(83, { size: 16 }).layout.scale
    )
  })

  it('yuzde araligi disina tasan degerleri kirpar', () => {
    expect(renderPercentIcon(-5, { size: 16 }).layout.text).toBe('0%')
    expect(renderPercentIcon(140, { size: 32 }).layout.text).toBe('100')
    expect(renderPercentIcon(Number.NaN, { size: 16 }).layout.text).toBe('0%')
  })

  it('dolum cubugu yuzdeyle orantilidir', () => {
    const empty = renderPercentIcon(0, { size: 32 })
    const half = renderPercentIcon(50, { size: 32 })
    const full = renderPercentIcon(100, { size: 32 })
    expect(empty.layout.fillWidth).toBe(0)
    expect(half.layout.fillWidth).toBeGreaterThan(0)
    expect(full.layout.fillWidth).toBeGreaterThan(half.layout.fillWidth)
    expect(full.layout.fillWidth).toBe(32 - 2 * 1)
  })

  it('esik rengi cubuga uygulanir ve bayt sirasi BGRA olur', () => {
    const icon = renderPercentIcon(95, { size: 16 })
    const barY = 16 - 1 - Math.max(2, Math.round(16 / 8))
    expect(getPixel(icon, 1, barY)).toEqual({ r: 0xe5, g: 0x48, b: 0x4a, a: 0xff })
    const offset = (barY * 16 + 1) * 4
    expect(icon.data[offset]).toBe(0x4a) // B
    expect(icon.data[offset + 1]).toBe(0x48) // G
    expect(icon.data[offset + 2]).toBe(0xe5) // R
    expect(icon.data[offset + 3]).toBe(0xff) // A
  })

  it('esik disaridan verilebilir', () => {
    const forced = renderPercentIcon(10, { size: 16, level: 'critical' })
    const auto = renderPercentIcon(10, { size: 16 })
    expect(forced.data).not.toEqual(auto.data)
  })
})

describe('createTrayImage', () => {
  it('tamponu nativeImage fabrikasina boyutlariyla verir', () => {
    const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }
    const factory: NativeImageFactory = { createFromBitmap: vi.fn(() => image) }
    const pixels = renderPercentIcon(83, { size: 22 })

    const result = createTrayImage(pixels, factory, { scaleFactor: 2 })

    expect(result).toBe(image)
    expect(factory.createFromBitmap).toHaveBeenCalledWith(pixels.data, {
      width: 22,
      height: 22,
      scaleFactor: 2
    })
    expect(image.setTemplateImage).not.toHaveBeenCalled()
  })

  it('template istenirse macOS icin isaretlenir', () => {
    const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }
    const factory: NativeImageFactory = { createFromBitmap: () => image }

    createTrayImage(renderPercentIcon(50, { size: 16 }), factory, { template: true })

    expect(image.setTemplateImage).toHaveBeenCalledWith(true)
  })
})

describe('planIndicator', () => {
  it('macOS metni gosterir, ikona sayi cizmez', () => {
    const plan = planIndicator(snapshot(), detectCapabilities('darwin', CONFIRMED))
    expect(plan.title).toBe('83%')
    expect(plan.iconPercent).toBeNull()
    expect(plan.progress).toBeCloseTo(0.83)
  })

  it('Windows sayiyi ikona cizer, metin gostermez', () => {
    const plan = planIndicator(snapshot(), detectCapabilities('win32', CONFIRMED))
    expect(plan.title).toBeNull()
    expect(plan.iconPercent).toBe(83)
    expect(plan.progress).toBeCloseTo(0.83)
  })

  it('tray olmayan Linux ta bile tooltip ve yuzde hesaplanir', () => {
    const plan = planIndicator(snapshot(), detectCapabilities('linux', { trayPresence: 'absent' }))
    expect(plan.percent).toBe(83)
    expect(plan.iconPercent).toBeNull()
    expect(plan.title).toBeNull()
    expect(plan.progress).toBeNull()
    expect(plan.tooltip).toContain('83%')
  })

  it('oturum penceresini gosterir — haftalik daha dolu olsa bile', () => {
    const plan = planIndicator(
      snapshot({
        windows: [
          { label: 'Current session', percent: 12, resetsAtRaw: 'x', resetsAtMs: null },
          { label: 'Current week', percent: 91, resetsAtRaw: 'y', resetsAtMs: null }
        ]
      }),
      detectCapabilities('win32', CONFIRMED)
    )
    // Widget de oturuma odakli; tepsi baska bir seyi anlatmamali. Oturum
    // sifirlaninca haftalik one gecip gostergenin kimligini degistiriyordu.
    expect(plan.percent).toBe(12)
    expect(plan.level).toBe('normal')
  })

  it('tooltip her pencereyi etiketi ve sifirlanmasiyla yazar', () => {
    const plan = planIndicator(snapshot(), detectCapabilities('win32', CONFIRMED))
    expect(plan.tooltip).toBe(
      'Current session: 83% · Sep 5, 4:50pm\nCurrent week: 20% · Sep 6, 8am'
    )
  })

  it('okunamayan satirlar tooltipte sayilir', () => {
    const unparsed = snapshot({ unparsedLines: ['Opus limit: ???', 'ikinci satir'] })
    const win = detectCapabilities('win32', CONFIRMED)

    expect(planIndicator(unparsed, win, { lang: TR }).tooltip).toContain(
      'Kota yanıtı okunamadı (2)'
    )
    expect(planIndicator(unparsed, win, { lang: EN }).tooltip).toContain(
      'Could not read usage response (2)'
    )
  })

  // Eski sozlesme "tam 127 karakter + sonu …" idi; blok tek parca sondan
  // kesildigi icin son pencereler bastan kayboluyordu (olculdu: 6 pencerenin
  // yalnizca 2,5'i gorunuyordu). Yeni sozlesme: siniri asma + BUTUN pencereler
  // gorunur. Uzunlugun tam 127 olmasi bir gereklilik degil, kirpmanin yan
  // etkisiydi — bu yuzden esitlik yerine ust sinir dogrulanir.
  it('tooltip siniri asmaz ve butun pencereler gorunur kalir', () => {
    const plan = planIndicator(
      snapshot({
        windows: Array.from({ length: 6 }, (_, i) => ({
          label: `Cok uzun pencere etiketi ${i}`,
          percent: 40 + i,
          resetsAtRaw: 'Sep 6, 8am (Europe/Istanbul)',
          resetsAtMs: null
        }))
      }),
      detectCapabilities('win32', CONFIRMED)
    )

    expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
    expect(plan.tooltip.split('\n')).toHaveLength(6)
    for (const percent of [40, 41, 42, 43, 44, 45]) {
      expect(plan.tooltip).toContain(`${percent}%`)
    }
    // Kirpma etiketin sonundan yapilir, satirin ortasindan degil.
    expect(plan.tooltip).toContain('…')
    for (const line of plan.tooltip.split('\n')) expect(line).toMatch(/: \d+%$/)
  })

  it('olcum yoksa sayi uydurulmaz', () => {
    const plan = planIndicator(snapshot({ windows: [] }), detectCapabilities('darwin', CONFIRMED), {
      lang: TR
    })
    expect(plan.percent).toBeNull()
    expect(plan.iconPercent).toBeNull()
    expect(plan.progress).toBeNull()
    expect(plan.title).toBe('—')
    expect(plan.tooltip).toBe('Kota verisi yok')
  })

  it('veri yok metni Ingilizce de sozlukten gelir', () => {
    const plan = planIndicator(snapshot({ windows: [] }), detectCapabilities('darwin', CONFIRMED), {
      lang: EN
    })
    expect(plan.tooltip).toBe('No usage data')
    // Sayisal semboller dil disidir; cevrilmez.
    expect(plan.title).toBe('—')
  })

  it('dil verilmezse Ingilizce kullanilir — sessizce Turkce ye dusulmez', () => {
    const caps = detectCapabilities('win32', CONFIRMED)
    const noLang = planIndicator({ kind: 'no-data' }, caps, { now: NOW })

    expect(noLang.tooltip).toBe(planIndicator({ kind: 'no-data' }, caps, { now: NOW, lang: EN }).tooltip)
    expect(FALLBACK_LANG).toBe('en')
  })
})

describe('applyIndicator', () => {
  it('Windows ta ikonu ve tooltip i gunceller', () => {
    const tray = fakeTray()
    const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }
    const createImage = vi.fn(() => image)
    const setProgress = vi.fn()

    const plan = applyIndicator(tray, snapshot(), detectCapabilities('win32', CONFIRMED), {
      createImage,
      setProgress
    })

    expect(createImage).toHaveBeenCalledWith(83, 'caution')
    expect(tray.images).toEqual([image])
    expect(tray.titles).toEqual([])
    expect(tray.tooltips[0]).toBe(plan.tooltip)
    expect(setProgress).toHaveBeenCalledWith(plan.progress)
  })

  it('macOS ta metin yazar, ikonu yeniden cizmez', () => {
    const tray = fakeTray()
    const createImage = vi.fn<(percent: number) => NativeImageLike>()

    applyIndicator(tray, snapshot(), detectCapabilities('darwin', CONFIRMED), { createImage })

    expect(tray.titles).toEqual(['83%'])
    expect(createImage).not.toHaveBeenCalled()
    expect(tray.tooltips).toHaveLength(1)
  })

  it('tray yoksa cokmez, ilerleme cubugu yine de calisir', () => {
    const setProgress = vi.fn()
    const caps: TrayCapabilities = { textLabel: false, trayIcon: false, progressBar: true }

    const plan = applyIndicator(null, snapshot(), caps, { setProgress })

    expect(plan.percent).toBe(83)
    expect(setProgress).toHaveBeenCalledWith(0.83)
  })

  it('ikon uretici verilmezse ikon guncellenmez ama tooltip yazilir', () => {
    const tray = fakeTray()

    applyIndicator(tray, snapshot(), detectCapabilities('win32', CONFIRMED))

    expect(tray.images).toEqual([])
    expect(tray.tooltips).toHaveLength(1)
  })

  it('tray var ama trayIcon false ise tooltip/title yazilmaz', () => {
    const tray = fakeTray()
    const caps: TrayCapabilities = { textLabel: true, trayIcon: false, progressBar: false }

    applyIndicator(tray, snapshot(), caps)

    expect(tray.tooltips).toEqual([])
    expect(tray.titles).toEqual([])
  })
})

describe('planIndicator — UsageStatus varyantlari (B2)', () => {
  const win = detectCapabilities('win32', CONFIRMED)
  const mac = detectCapabilities('darwin', CONFIRMED)
  const ok: UsageStatus = { kind: 'ok', snapshot: snapshot() }

  it('loading: sayi uydurulmaz, durum metni yazilir', () => {
    const plan = planIndicator({ kind: 'loading' }, win, { now: NOW, lang: TR })
    expect(plan.statusKind).toBe('loading')
    expect(plan.percent).toBeNull()
    expect(plan.iconPercent).toBeNull()
    expect(plan.progress).toBeNull()
    expect(plan.stale).toBe(false)
    expect(plan.tooltip).toBe('ölçülüyor…')
    expect(planIndicator({ kind: 'loading' }, win, { now: NOW, lang: EN }).tooltip).toBe(
      'measuring…'
    )
    expect(plan.icon).toEqual<IconSpec>({
      percent: null,
      level: 'normal',
      badge: null,
      stale: false
    })
  })

  it('no-data: loading ile ayni metni paylasmaz', () => {
    for (const lang of [TR, EN]) {
      const empty = planIndicator({ kind: 'no-data' }, win, { now: NOW, lang })
      expect(empty.tooltip).not.toBe(
        planIndicator({ kind: 'loading' }, win, { now: NOW, lang }).tooltip
      )
    }
    expect(planIndicator({ kind: 'no-data' }, win, { now: NOW, lang: TR }).tooltip).toBe(
      'henüz ölçüm yok'
    )
    expect(planIndicator({ kind: 'no-data' }, win, { now: NOW, lang: EN }).tooltip).toBe(
      'no measurement yet'
    )
  })

  it('ok: deger gosterilir, bayatlik/hata isareti yok', () => {
    const plan = planIndicator(ok, win, { now: NOW })
    expect(plan.percent).toBe(83)
    expect(plan.stale).toBe(false)
    expect(plan.statusText).toBe('')
    expect(plan.icon.badge).toBeNull()
  })

  it('stale: deger gosterilir ama bayatligi METIN soyler', () => {
    const plan = planIndicator(stale(4 * 60 * 1000), win, { now: NOW, lang: TR })
    expect(plan.statusKind).toBe('stale')
    expect(plan.percent).toBe(83)
    expect(plan.stale).toBe(true)
    expect(plan.icon).toEqual<IconSpec>({
      percent: 83,
      level: 'caution',
      badge: 'stale',
      stale: true
    })
    expect(plan.statusText).toBe('bayat · 4 dk önce')
    // Renk tek basina anlatmaz: sure tooltip'te yaziyla da gecer.
    expect(plan.tooltip).toContain('4 dk önce')
  })

  it('stale: Ingilizce metin Turkce soz dizimi tasimaz', () => {
    const plan = planIndicator(stale(4 * 60 * 1000), win, { now: NOW, lang: EN })
    expect(plan.statusText).toBe('stale · 4m ago')
    expect(plan.tooltip).toContain('4m ago')
  })

  it('macOS cubuk metni bayatligi ve hatayi isaretler', () => {
    expect(planIndicator(ok, mac, { now: NOW }).title).toBe('83%')
    expect(planIndicator(stale(), mac, { now: NOW }).title).toBe('83%*')
    expect(planIndicator(failed('timeout', true), mac, { now: NOW }).title).toBe('83%!')
    expect(planIndicator(failed('timeout'), mac, { now: NOW }).title).toBe('!')
    expect(planIndicator({ kind: 'loading' }, mac, { now: NOW }).title).toBe('…')
    expect(planIndicator({ kind: 'no-data' }, mac, { now: NOW }).title).toBe('—')
  })

  it('error + son deger: bayat deger gosterilir, hata isaretlenir', () => {
    const plan = planIndicator(failed('timeout', true), win, { now: NOW, lang: TR })
    expect(plan.percent).toBe(83)
    expect(plan.stale).toBe(true)
    expect(plan.icon.badge).toBe('error')
    expect(plan.statusText).toBe('Yanıt zamanında gelmedi · 5 dk önce')

    const en = planIndicator(failed('timeout', true), win, { now: NOW, lang: EN })
    expect(en.statusText).toBe('No response in time · 5m ago')
  })

  it('error + son deger yok: sayi gosterilmez', () => {
    const plan = planIndicator(failed('not-found'), win, { now: NOW, lang: TR })
    expect(plan.percent).toBeNull()
    expect(plan.iconPercent).toBeNull()
    expect(plan.progress).toBeNull()
    expect(plan.stale).toBe(false)
    expect(plan.icon.badge).toBe('error')
    expect(plan.tooltip).toBe('claude komutu bulunamadı')
    expect(planIndicator(failed('not-found'), win, { now: NOW, lang: EN }).tooltip).toBe(
      'claude command not found'
    )
  })

  it('tooltip hata sinifina gore degisir — tek genel "hata" yok', () => {
    const kinds: CliErrorKind[] = ['not-found', 'not-logged-in', 'timeout', 'bad-output', 'unknown']
    for (const lang of [TR, EN]) {
      const tooltips = kinds.map((k) => planIndicator(failed(k), win, { now: NOW, lang }).tooltip)
      expect(new Set(tooltips).size).toBe(kinds.length)
    }
  })

  it('ciplak snapshot hala basarili olcum sayilir (eski cagri sekli)', () => {
    expect(planIndicator(snapshot(), win)).toEqual(planIndicator(ok, win))
  })
})

describe('errorText / statusSummary — iki dil', () => {
  const kinds: CliErrorKind[] = ['not-found', 'not-logged-in', 'timeout', 'bad-output', 'unknown']

  it('her hata sinifi her dilde ayri ve bos olmayan metin uretir', () => {
    for (const lang of [TR, EN]) {
      const texts = kinds.map((kind) => errorText(lang, kind))
      expect(new Set(texts).size).toBe(kinds.length)
      for (const text of texts) expect(text.length).toBeGreaterThan(0)
    }
  })

  it('metin atilacak adimi soyler, ham hata mesajini degil', () => {
    expect(errorText(TR, 'not-logged-in')).toContain('claude auth login')
    expect(errorText(EN, 'not-logged-in')).toContain('claude auth login')
    expect(errorText(TR, 'not-found')).toContain('claude')
    expect(errorText(EN, 'not-found')).toContain('claude')
  })

  it('hata metinleri sozlukten gelir — iki dilde de tam kapsam', () => {
    expect(errorText(TR, 'rate-limited')).toBe('Çok sık soruldu, bekleniyor')
    expect(errorText(EN, 'rate-limited')).toBe('Asked too often, backing off')
    expect(errorText(TR, 'unknown')).toBe('Ölçüm alınamadı')
    expect(errorText(EN, 'unknown')).toBe('Measurement failed')
    // Ayni sinif iki dilde ayni metne dusmez: ceviri gercekten yapilmis.
    for (const kind of kinds) expect(errorText(TR, kind)).not.toBe(errorText(EN, kind))
  })

  it('bayat ve hata ozetleri birbirinden ayri', () => {
    for (const lang of [TR, EN]) {
      expect(statusSummary(stale(), lang, NOW)).not.toBe(
        statusSummary(failed('unknown', true), lang, NOW)
      )
    }
  })

  it('ok durumunda anlatacak bir sey yok', () => {
    expect(statusSummary({ kind: 'ok', snapshot: snapshot() }, TR, NOW)).toBe('')
    expect(statusSummary({ kind: 'ok', snapshot: snapshot() }, EN, NOW)).toBe('')
  })

  it('yas asagi yuvarlanir — gecen sure abartilmaz', () => {
    // Yas artik sozlugun `formatDuration`/`formatAgo` fonksiyonlarindan gelir;
    // burada dogrulanan, adaptorun onlari dogru birime baglamasidir.
    expect(statusSummary(stale(59_000), TR, NOW)).toBe('bayat · 0 dk önce')
    expect(statusSummary(stale(4 * 60 * 1000), TR, NOW)).toBe('bayat · 4 dk önce')
    expect(statusSummary(stale(119_000), TR, NOW)).toBe('bayat · 1 dk önce')
    expect(statusSummary(stale(4 * 60 * 1000), EN, NOW)).toBe('stale · 4m ago')
    expect(statusSummary(stale(119_000), EN, NOW)).toBe('stale · 1m ago')
  })

  it('hata yasi saat ve gun olceginde de dogru birimi kullanir', () => {
    const hoursAgo = (h: number): UsageStatus => ({
      kind: 'error',
      errorKind: 'unknown',
      message: 'ham mesaj',
      lastSnapshot: snapshot({ at: NOW - h * 3_600_000 })
    })

    expect(statusSummary(hoursAgo(3), TR, NOW)).toBe('Ölçüm alınamadı · 3 sa önce')
    expect(statusSummary(hoursAgo(3), EN, NOW)).toBe('Measurement failed · 3h ago')
    expect(statusSummary(hoursAgo(50), TR, NOW)).toBe('Ölçüm alınamadı · 2 gün önce')
    expect(statusSummary(hoursAgo(50), EN, NOW)).toBe('Measurement failed · 2d ago')
  })
})

describe('tooltip butcesi (B1)', () => {
  const win = detectCapabilities('win32', CONFIRMED)
  const TZ = ' (Europe/Istanbul)'
  const threeWindows = snapshot({
    windows: [
      {
        label: 'Current session',
        percent: 83,
        resetsAtRaw: `Sep 5, 4:50pm${TZ}`,
        resetsAtMs: null
      },
      {
        label: 'Current week (all models)',
        percent: 20,
        resetsAtRaw: `Sep 6, 8am${TZ}`,
        resetsAtMs: null
      },
      {
        label: 'Current week (Opus)',
        percent: 5,
        resetsAtRaw: `Sep 6, 8am${TZ}`,
        resetsAtMs: null
      }
    ]
  })

  it('ucuncu pencere kaybolmaz — Opus tooltip te gecer', () => {
    const plan = planIndicator(threeWindows, win)
    expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
    expect(plan.tooltip.split('\n')).toHaveLength(3)
    expect(plan.tooltip).toContain('Opus')
    for (const value of ['83%', '20%', '5%']) expect(plan.tooltip).toContain(value)
  })

  it('yer daralinca once sifirlanma saatleri dusurulur, pencere degil', () => {
    expect(planIndicator(threeWindows, win).tooltip).not.toContain('Europe/Istanbul')
  })

  it('anomali satiri cumle ortasindan kesilmez', () => {
    const noisy = snapshot({
      windows: threeWindows.windows,
      unparsedLines: ['You are currently using your subscription...']
    })

    for (const [lang, expected] of [
      [TR, 'Kota yanıtı okunamadı (1)'],
      [EN, 'Could not read usage response (1)']
    ] as const) {
      const plan = planIndicator(noisy, win, { lang })
      expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
      expect(plan.tooltip).toContain(expected)
    }
  })

  it('durum satiri yuzdelerle birlikte sigar', () => {
    const staleThree: UsageStatus = {
      kind: 'stale',
      snapshot: threeWindows,
      ageMs: 4 * 60 * 1000,
      reason: 'poll gecikti'
    }

    for (const [lang, expected] of [
      [TR, 'bayat · 4 dk önce'],
      [EN, 'stale · 4m ago']
    ] as const) {
      const plan = planIndicator(staleThree, win, { now: NOW, lang })
      expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
      expect(plan.tooltip).toContain('Opus')
      expect(plan.tooltip).toContain(expected)
    }
  })

  // EN metinler TR metinlerden kisa: ayni kirpma kademesine dusmeleri sart degil,
  // ama iki dilde de BUTUN yuzdeler gorunur kalmali — dusen ayrintidir, veri degil.
  it('kirpma iki dilde de yuzdeleri korur', () => {
    const many = snapshot({
      windows: Array.from({ length: 6 }, (_, i) => ({
        label: `Cok uzun pencere etiketi ${i}`,
        percent: 40 + i,
        resetsAtRaw: `Sep 6, 8am${TZ}`,
        resetsAtMs: null
      })),
      unparsedLines: ['okunamayan satir']
    })

    for (const lang of [TR, EN]) {
      const plan = planIndicator(
        { kind: 'stale', snapshot: many, ageMs: 4 * 60 * 1000, reason: 'poll gecikti' },
        win,
        { now: NOW, lang }
      )
      expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
      for (const percent of [40, 41, 42, 43, 44, 45]) {
        expect(plan.tooltip).toContain(`${percent}%`)
      }
    }
  })

  it('en dar kademede bile durum satiri okunur kalir, ortasindan kesilmez', () => {
    const twelve = snapshot({
      windows: Array.from({ length: 12 }, (_, i) => ({
        label: `Pencere etiketi ${i}`,
        percent: i * 8,
        resetsAtRaw: `Sep 6, 8am${TZ}`,
        resetsAtMs: null
      }))
    })

    for (const [lang, expected] of [
      [TR, 'bayat · 4 dk önce'],
      [EN, 'stale · 4m ago']
    ] as const) {
      const plan = planIndicator(
        { kind: 'stale', snapshot: twelve, ageMs: 4 * 60 * 1000, reason: 'poll gecikti' },
        win,
        { now: NOW, lang }
      )
      expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
      // Kirpilan etiketlerdir; durum satiri bir butun olarak ya vardir ya yoktur.
      const lines = plan.tooltip.split('\n')
      const last = lines[lines.length - 1]
      if (last?.includes(expected.slice(0, 5)) === true) expect(last).toBe(expected)
    }
  })

  it('12 pencerede bile her yuzde gorunur', () => {
    const plan = planIndicator(
      snapshot({
        windows: Array.from({ length: 12 }, (_, i) => ({
          label: `Pencere etiketi ${i}`,
          percent: i * 8,
          resetsAtRaw: `Sep 6, 8am${TZ}`,
          resetsAtMs: null
        }))
      }),
      win
    )
    expect(plan.tooltip.length).toBeLessThanOrEqual(MAX_TOOLTIP_LENGTH)
    expect(plan.tooltip.split('\n')).toHaveLength(12)
    for (let i = 0; i < 12; i += 1) expect(plan.tooltip).toContain(`: ${i * 8}%`)
  })
})

describe('renderStatusIcon — kucuk boyutta tasma yok', () => {
  it.each([8, 9, 10, 11, 12, 13, 14, 15, 16, 22, 32])(
    '%s px ikonda metin ic alani asmaz',
    (size) => {
      for (const percent of [0, 5, 83, 100]) {
        expect(renderPercentIcon(percent, { size }).layout.textWidth).toBeLessThanOrEqual(size - 2)
      }
    }
  )

  it('13 pikselin altinda metin dusurulur, dolum cubugu kalir', () => {
    for (let size = 8; size < MIN_TEXT_ICON_SIZE; size += 1) {
      const icon = renderPercentIcon(100, { size })
      expect(icon.layout.barOnly).toBe(true)
      expect(icon.layout.text).toBe('')
      expect(icon.layout.fillWidth).toBe(size - 2)
      expect(countOpaquePixels(icon)).toBeGreaterThan(0)
    }
  })

  it('13 piksel ve ustunde metin cizilir', () => {
    for (const size of [MIN_TEXT_ICON_SIZE, 14, 16, 22, 32]) {
      expect(renderPercentIcon(100, { size }).layout.barOnly).toBe(false)
    }
  })

  it('metinsiz ikonda bilgi kaybolmaz — dolum yuzdeyle orantili kalir', () => {
    expect(renderPercentIcon(90, { size: 10 }).layout.fillWidth).toBeGreaterThan(
      renderPercentIcon(10, { size: 10 }).layout.fillWidth
    )
  })
})

describe('renderStatusIcon — durum isaretleri', () => {
  const base: IconSpec = { percent: 83, level: 'caution', badge: null, stale: false }

  it('bayat ikon taze ikondan farkli cizilir', () => {
    expect(
      renderStatusIcon({ ...base, stale: true, badge: 'stale' }, { size: 16 }).data
    ).not.toEqual(renderStatusIcon(base, { size: 16 }).data)
  })

  it('hata isareti bayat isaretinden farkli', () => {
    expect(
      renderStatusIcon({ ...base, stale: true, badge: 'error' }, { size: 16 }).data
    ).not.toEqual(renderStatusIcon({ ...base, stale: true, badge: 'stale' }, { size: 16 }).data)
  })

  it('deger yokken sayi uydurulmaz, isaret cizilir', () => {
    const icon = renderStatusIcon(
      { percent: null, level: 'normal', badge: 'error', stale: false },
      { size: 16 }
    )
    expect(icon.layout.text).toBe('!')
    expect(icon.layout.fillWidth).toBe(0)
    expect(countOpaquePixels(icon)).toBeGreaterThan(0)
  })

  it('renderPercentIcon durumsuz kisayoldur — cikti birebir ayni', () => {
    expect(renderPercentIcon(83, { size: 22 }).data).toEqual(
      renderStatusIcon(base, { size: 22 }).data
    )
  })
})

describe('buildTrayMenuTemplate (REQ-3 AC3)', () => {
  const ok: UsageStatus = { kind: 'ok', snapshot: snapshot() }

  it('menu ogeleri ve eylemleri tam', () => {
    const menu = buildTrayMenuTemplate(ok, { now: NOW })
    expect(menu.filter((i) => i.type === 'normal').map((i) => i.action)).toEqual([
      null,
      'toggle-widget',
      'refresh',
      'open-panel',
      'quit'
    ])
  })

  it('widget gorunurlugune gore metin degisir', () => {
    const visible = buildTrayMenuTemplate(ok, { widgetVisible: true, now: NOW, lang: TR })
    const hidden = buildTrayMenuTemplate(ok, { widgetVisible: false, now: NOW, lang: TR })
    expect(labelOf(visible, 'toggle-widget')).toBe(HIDE_WIDGET_TR)
    expect(labelOf(hidden, 'toggle-widget')).toBe(SHOW_WIDGET_TR)
  })

  it('menu etiketleri iki dilde de sozlukten gelir', () => {
    const tr = buildTrayMenuTemplate(ok, { widgetVisible: true, now: NOW, lang: TR })
    expect(labelOf(tr, 'toggle-widget')).toBe(HIDE_WIDGET_TR)
    expect(labelOf(tr, 'refresh')).toBe('Şimdi yenile')
    expect(labelOf(tr, 'open-panel')).toBe('Ayrıntılı panel')
    expect(labelOf(tr, 'quit')).toBe('Çıkış')

    const en = buildTrayMenuTemplate(ok, { widgetVisible: true, now: NOW, lang: EN })
    expect(labelOf(en, 'toggle-widget')).toBe(HIDE_WIDGET_EN)
    expect(labelOf(en, 'refresh')).toBe('Refresh now')
    expect(labelOf(en, 'open-panel')).toBe('Details panel')
    expect(labelOf(en, 'quit')).toBe('Quit')

    expect(labelOf(buildTrayMenuTemplate(ok, { widgetVisible: false, lang: EN }), 'toggle-widget'))
      .toBe(SHOW_WIDGET_EN)
  })

  it('dil verilmezse menu Ingilizce kurulur', () => {
    expect(buildTrayMenuTemplate(ok, { widgetVisible: true, now: NOW })).toEqual(
      buildTrayMenuTemplate(ok, { widgetVisible: true, now: NOW, lang: EN })
    )
  })

  it('olcum surerken yenile kapali', () => {
    const loading = buildTrayMenuTemplate({ kind: 'loading' }, { now: NOW })
    expect(loading.find((i) => i.id === 'refresh')?.enabled).toBe(false)
    expect(buildTrayMenuTemplate(ok, { now: NOW }).find((i) => i.id === 'refresh')?.enabled).toBe(
      true
    )
  })

  it('durum satiri her durumda farkli konusur', () => {
    const statuses: UsageStatus[] = [
      { kind: 'loading' },
      { kind: 'no-data' },
      ok,
      stale(),
      failed('not-logged-in', true),
      failed('not-found')
    ]
    const labels = statuses.map((s) =>
      labelOf(buildTrayMenuTemplate(s, { now: NOW, lang: TR }), 'status')
    )
    expect(new Set(labels).size).toBe(statuses.length)
    expect(labels[2]).toBe('Current session: 83%')
    expect(labels[4]).toContain('Oturum kapalı')
    // Deger tek basina guncel sanilmasin: durumla birlikte gosterilir.
    expect(labels[3]).toContain('83%')
    expect(labels[3]).toContain('bayat')

    const enLabels = statuses.map((s) =>
      labelOf(buildTrayMenuTemplate(s, { now: NOW, lang: EN }), 'status')
    )
    expect(new Set(enLabels).size).toBe(statuses.length)
    expect(enLabels[4]).toContain('Signed out')
    expect(enLabels[3]).toContain('stale')
  })

  it('bilgi satiri ve ayiraclar tiklanamaz', () => {
    for (const item of buildTrayMenuTemplate({ kind: 'no-data' }, { now: NOW })) {
      if (item.action === null) expect(item.enabled).toBe(false)
    }
  })

  it('plan menuyu tasir', () => {
    const plan = planIndicator({ kind: 'loading' }, detectCapabilities('win32', CONFIRMED), { now: NOW })
    expect(plan.menu).toEqual(buildTrayMenuTemplate({ kind: 'loading' }, { now: NOW }))
  })
})

describe('applyIndicator — durum degisince ikon bayat kalmaz (B2)', () => {
  const win = detectCapabilities('win32', CONFIRMED)
  const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }

  it('CLI dustugunde ikon yeniden cizilir, eski yuzde ekranda kalmaz', () => {
    const tray = fakeTray()
    const renderIcon = vi.fn<(spec: IconSpec) => NativeImageLike>(() => image)

    applyIndicator(tray, { kind: 'ok', snapshot: snapshot() }, win, { renderIcon }, { now: NOW })
    applyIndicator(tray, failed('not-logged-in'), win, { renderIcon }, { now: NOW })

    expect(renderIcon).toHaveBeenCalledTimes(2)
    expect(renderIcon.mock.calls[0]?.[0]).toEqual<IconSpec>({
      percent: 83,
      level: 'caution',
      badge: null,
      stale: false
    })
    expect(renderIcon.mock.calls[1]?.[0]).toEqual<IconSpec>({
      percent: null,
      level: 'normal',
      badge: 'error',
      stale: false
    })
    expect(tray.images).toHaveLength(2)
    expect(tray.tooltips[1]).toBe('Signed out (claude auth login)')
  })

  it('tooltip ana surecten gelen dile uyar', () => {
    const tray = fakeTray()
    applyIndicator(tray, failed('not-logged-in'), win, {}, { now: NOW, lang: TR })
    applyIndicator(tray, failed('not-logged-in'), win, {}, { now: NOW, lang: EN })

    expect(tray.tooltips).toEqual([
      'Oturum kapalı (claude auth login)',
      'Signed out (claude auth login)'
    ])
  })

  it('bayat durumda ikon bayat spec ile cizilir', () => {
    const tray = fakeTray()
    const plan = applyIndicator(tray, stale(), win, { renderIcon: () => image }, { now: NOW })
    expect(plan.icon).toEqual<IconSpec>({
      percent: 83,
      level: 'caution',
      badge: 'stale',
      stale: true
    })
    expect(tray.images).toHaveLength(1)
  })

  it('renderIcon varken eski createImage yolu kullanilmaz', () => {
    const createImage = vi.fn<(percent: number) => NativeImageLike>(() => image)
    applyIndicator(fakeTray(), snapshot(), win, { renderIcon: () => image, createImage })
    expect(createImage).not.toHaveBeenCalled()
  })

  it('menu Electron nesnesine cevrilip tray e verilir', () => {
    const tray = fakeTray()
    const menuObject = { native: true }
    const buildMenu = vi.fn<(template: TrayMenuItem[]) => unknown>(() => menuObject)

    const plan = applyIndicator(tray, snapshot(), win, { buildMenu }, { now: NOW })

    expect(buildMenu).toHaveBeenCalledWith(plan.menu)
    expect(tray.menus).toEqual([menuObject])
  })

  it('setContextMenu desteklemeyen tray de cokmez', () => {
    const bare: TrayLike = { setImage: vi.fn(), setToolTip: vi.fn(), setTitle: vi.fn() }
    expect(() => applyIndicator(bare, snapshot(), win, { buildMenu: () => ({}) })).not.toThrow()
  })
})

// ── Tepsi belirsizligi: menu, tooltip ve gizleme karari ─────────────────────

describe('buildTrayMenuTemplate — tepsi olcumu', () => {
  const ok: UsageStatus = { kind: 'ok', snapshot: snapshot() }

  function itemOf(menu: TrayMenuItem[], id: string): TrayMenuItem | undefined {
    return menu.find((entry) => entry.id === id)
  }

  it('dogrulanmis tepside uyari satiri yok, gizleme sade', () => {
    const menu = buildTrayMenuTemplate(ok, {
      widgetVisible: true,
      presence: 'confirmed',
      lang: TR
    })
    expect(itemOf(menu, 'tray-warning')).toBeUndefined()
    expect(labelOf(menu, 'toggle-widget')).toBe(HIDE_WIDGET_TR)
  })

  it('presence verilmezse eski davranis korunur', () => {
    expect(buildTrayMenuTemplate(ok, { widgetVisible: true })).toEqual(
      buildTrayMenuTemplate(ok, { widgetVisible: true, presence: 'confirmed' })
    )
  })

  it('dogrulanmamis tepside gizleme sonucunu basliginda soyler', () => {
    const menu = buildTrayMenuTemplate(ok, {
      widgetVisible: true,
      presence: 'unverified',
      lang: TR
    })
    const toggle = itemOf(menu, 'toggle-widget')

    expect(labelOf(menu, 'tray-warning')).toBe('Tepsi ikonu doğrulanamadı')
    expect(toggle?.label).toBe('Widget’ı gizle · Tepsi ikonu doğrulanamadı')
    // Engellenmez: eklentili GNOME'da tepsi calisiyor olabilir, karar kullanicinin.
    expect(toggle?.enabled).toBe(true)
    expect(toggle?.action).toBe('toggle-widget')
  })

  it('gerekce Ingilizce de basligin icinde durur', () => {
    const menu = buildTrayMenuTemplate(ok, {
      widgetVisible: true,
      presence: 'unverified',
      lang: EN
    })
    expect(labelOf(menu, 'tray-warning')).toBe('Tray icon unverified')
    expect(labelOf(menu, 'toggle-widget')).toBe('Hide widget · Tray icon unverified')
  })

  it('tepsi yokken gizleme tiklanamaz — geri getirecek yuzey yok', () => {
    const menu = buildTrayMenuTemplate(ok, { widgetVisible: true, presence: 'absent', lang: TR })
    const toggle = itemOf(menu, 'toggle-widget')

    expect(toggle?.enabled).toBe(false)
    expect(toggle?.action).toBeNull()
    expect(toggle?.label).not.toBe(HIDE_WIDGET_TR)
    expect(labelOf(menu, 'tray-warning')).toBe('Tepsi ikonu yok')

    const en = buildTrayMenuTemplate(ok, { widgetVisible: true, presence: 'absent', lang: EN })
    expect(itemOf(en, 'toggle-widget')?.enabled).toBe(false)
    expect(labelOf(en, 'toggle-widget')).toBe('Hide widget · No tray icon')
    expect(labelOf(en, 'tray-warning')).toBe('No tray icon')
  })

  it('widget zaten gizliyse gosterme ogesi her durumda calisir', () => {
    for (const presence of ['confirmed', 'unverified', 'absent'] as const) {
      const tr = buildTrayMenuTemplate(ok, { widgetVisible: false, presence, lang: TR })
      expect(labelOf(tr, 'toggle-widget')).toBe(SHOW_WIDGET_TR)
      expect(itemOf(tr, 'toggle-widget')?.enabled).toBe(true)

      const en = buildTrayMenuTemplate(ok, { widgetVisible: false, presence, lang: EN })
      expect(labelOf(en, 'toggle-widget')).toBe(SHOW_WIDGET_EN)
      expect(itemOf(en, 'toggle-widget')?.enabled).toBe(true)
    }
  })
})

describe('planIndicator — tepsi olcumu', () => {
  it('yetenek nesnesindeki olcumu plana tasir', () => {
    const caps = detectCapabilities('linux', { trayPresence: 'unverified' })
    const plan = planIndicator(snapshot(), caps, { now: NOW, lang: TR })

    expect(plan.presence).toBe('unverified')
    expect(plan.hideWidgetSafety).toBe('confirm')
    expect(plan.tooltip).toContain('Tepsi ikonu doğrulanamadı')
    // Kota degeri notun ustunde kalir — not ayrinti, yuzde asil bilgidir.
    expect(plan.tooltip).toContain('83%')

    const en = planIndicator(snapshot(), caps, { now: NOW, lang: EN })
    expect(en.tooltip).toContain('Tray icon unverified')
    expect(en.tooltip).toContain('83%')
  })

  it('tepsi yoksa gizleme engellenir', () => {
    const caps = detectCapabilities('linux', { trayPresence: 'absent' })
    expect(planIndicator(snapshot(), caps, { now: NOW }).hideWidgetSafety).toBe('blocked')
  })

  it('olcum tasimayan eski yetenek nesnesinde trayIcon esas alinir', () => {
    const withTray: TrayCapabilities = { textLabel: false, trayIcon: true, progressBar: false }
    const noTray: TrayCapabilities = { textLabel: false, trayIcon: false, progressBar: false }

    expect(planIndicator(snapshot(), withTray, { now: NOW }).presence).toBe('confirmed')
    expect(planIndicator(snapshot(), noTray, { now: NOW }).presence).toBe('absent')
  })

  it('acik presence secenegi yetenek nesnesini ezer', () => {
    const caps = detectCapabilities('win32', CONFIRMED)
    const plan = planIndicator(snapshot(), caps, { now: NOW, presence: 'unverified' })
    expect(plan.hideWidgetSafety).toBe('confirm')
  })

  it('dogrulanmis tepside tooltip eskisi gibi kalir', () => {
    const caps = detectCapabilities('win32', CONFIRMED)
    expect(planIndicator(snapshot(), caps, { now: NOW, lang: TR }).tooltip).not.toContain('Tepsi')
    expect(planIndicator(snapshot(), caps, { now: NOW, lang: EN }).tooltip).not.toContain('Tray')
  })
})

// ── macOS template ikonu ────────────────────────────────────────────────────

describe('trayImageStyleFor', () => {
  it('macOS template ister ve monokrom cizim gerektirir', () => {
    expect(trayImageStyleFor('darwin', 2)).toEqual({
      template: true,
      monochrome: true,
      size: 32,
      scaleFactor: 2
    })
    expect(trayImageStyleFor('darwin')).toEqual({
      template: true,
      monochrome: true,
      size: 16,
      scaleFactor: 1
    })
  })

  it('Windows olcek carpanini yok sayar (32@2x olculdu, bulaniklasiyordu)', () => {
    expect(trayImageStyleFor('win32', 2)).toEqual({
      template: false,
      monochrome: false,
      size: 16,
      scaleFactor: 1
    })
  })

  it('Linux 22 px GTK yuvasina cizer, template istemez', () => {
    expect(trayImageStyleFor('linux', 3)).toEqual({
      template: false,
      monochrome: false,
      size: 22,
      scaleFactor: 1
    })
  })

  it('gecersiz olcek carpani 1e duser', () => {
    expect(trayImageStyleFor('darwin', Number.NaN).scaleFactor).toBe(1)
    expect(trayImageStyleFor('darwin', 0).scaleFactor).toBe(1)
  })
})

describe('renderStatusIcon — monokrom (template) cizim', () => {
  const monoSpec: IconSpec = { percent: 42, level: 'caution', badge: null, stale: false }

  /** Saydam olmayan piksellerin RGB uclulerini toplar. */
  function distinctRgb(buf: { data: Uint8Array }): Set<string> {
    const out = new Set<string>()
    for (let i = 0; i < buf.data.length; i += 4) {
      if ((buf.data[i + 3] ?? 0) === 0) continue
      out.add([buf.data[i + 2], buf.data[i + 1], buf.data[i]].join(','))
    }
    return out
  }

  function distinctAlpha(buf: { data: Uint8Array }): number[] {
    const out = new Set<number>()
    for (let i = 3; i < buf.data.length; i += 4) out.add(buf.data[i] ?? 0)
    return [...out].sort((a, b) => a - b)
  }

  it('template ikonda her piksel siyah — macOS RGB kanalini atar', () => {
    const mono = renderStatusIcon(monoSpec, { size: 32, monochrome: true })
    expect(distinctRgb(mono)).toEqual(new Set(['0,0,0']))
  })

  it('renkli cizimde seviye rengi durur', () => {
    const colored = renderStatusIcon(monoSpec, { size: 32 })
    expect(distinctRgb(colored).size).toBeGreaterThan(1)
  })

  it('template ikonda hale cizilmez — rakam murekkebin icinde kaybolmaz', () => {
    const mono = renderStatusIcon(monoSpec, { size: 32, monochrome: true })
    // Yalniz iki murekkep seviyesi: dolu (255) ve olcek yolu (77). Hale alfasi (230) yok.
    expect(distinctAlpha(mono)).toEqual([0, 0x4d, 0xff])
  })

  it('monokrom cizim yerlesimi degistirmez, yalniz rengi degistirir', () => {
    const mono = renderStatusIcon(monoSpec, { size: 32, monochrome: true })
    const colored = renderStatusIcon(monoSpec, { size: 32 })

    expect(mono.layout).toEqual(colored.layout)
    // 32 px'te '%' sigmaz, rakam okunurlugu once gelir — iki cizimde de ayni.
    expect(mono.layout.text).toBe('42')
    expect(mono.data).not.toEqual(colored.data)
    expect(countOpaquePixels(mono)).toBeGreaterThan(0)
  })

  it('bayat template ikon sonuklesir ama siyah kalir', () => {
    const mono = renderStatusIcon(
      { ...monoSpec, stale: true, badge: 'stale' },
      { size: 32, monochrome: true }
    )
    expect(distinctRgb(mono)).toEqual(new Set(['0,0,0']))
    expect(countOpaquePixels(mono)).toBeGreaterThan(0)
  })
})

describe('renderTrayImage', () => {
  it('macOS bicimini uygular: template isaretlenir, olcek carpani gecer', () => {
    const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }
    const factory: NativeImageFactory = { createFromBitmap: vi.fn(() => image) }
    const spec: IconSpec = { percent: null, level: 'normal', badge: null, stale: false }

    const result = renderTrayImage(spec, factory, trayImageStyleFor('darwin', 2))

    expect(result).toBe(image)
    expect(factory.createFromBitmap).toHaveBeenCalledWith(expect.any(Uint8Array), {
      width: 32,
      height: 32,
      scaleFactor: 2
    })
    expect(image.setTemplateImage).toHaveBeenCalledWith(true)
  })

  it('Windows bicimi template istemez', () => {
    const image: NativeImageLike = { isEmpty: () => false, setTemplateImage: vi.fn() }
    const factory: NativeImageFactory = { createFromBitmap: () => image }
    const spec: IconSpec = { percent: 7, level: 'normal', badge: null, stale: false }

    renderTrayImage(spec, factory, trayImageStyleFor('win32'))

    expect(image.setTemplateImage).not.toHaveBeenCalled()
  })
})
