/**
 * Arayüz metinleri — Türkçe ve İngilizce.
 *
 * Dil **sistemden** seçilir, kullanıcıya seçim sunulmaz: sistem Türkçeyse TR,
 * değilse EN. Varsayılan EN'dir.
 *
 * Kapsama garantisi tip düzeyindedir: `MESSAGES` bir
 * `Record<Lang, Record<MessageKey, string>>` olduğu için bir dile anahtar
 * eklemeyi unutmak **derleme hatası** verir. Bu, "her anahtar tüm dillerde"
 * kuralını grep'e bırakmaktan güçlüdür.
 *
 * Çeviri ilkesi: motamot aktarım değil, hedef dilde doğal karşılık. İngilizce
 * metinler Türkçe söz dizimi taşımaz.
 */

export type Lang = 'tr' | 'en'

/** Sistem dili tanınmazsa buraya düşülür. */
export const FALLBACK_LANG: Lang = 'en'

/**
 * `app.getLocale()` gibi bir yerel ayar dizgisinden dil seçer.
 * `tr`, `tr-TR`, `TR` — hepsi Türkçe sayılır.
 */
export function pickLang(locale: string | null | undefined): Lang {
  if (typeof locale !== 'string') return FALLBACK_LANG
  return locale.trim().toLowerCase().startsWith('tr') ? 'tr' : FALLBACK_LANG
}

export type MessageKey =
  // ── Pencere etiketleri ──
  | 'window.session'
  | 'window.week'
  // ── Odak / zaman satırı ──
  | 'reset.at'
  | 'reset.left'
  | 'reset.unknown'
  | 'measured.ago'
  // ── Durumlar ──
  | 'state.firstMeasure'
  | 'state.noData'
  | 'state.measuring'
  | 'state.noMeasureYet'
  | 'state.stale'
  | 'state.retryIn'
  // ── Hata sınıfları ──
  | 'error.notFound'
  | 'error.notLoggedIn'
  | 'error.timeout'
  | 'error.badOutput'
  | 'error.rateLimited'
  | 'error.unknown'
  // ── Araç çubuğu ──
  | 'view.focus'
  | 'view.list'
  | 'view.strip'
  | 'action.measureNow'
  | 'action.measuring'
  | 'action.hideToTray'
  | 'action.close'
  | 'view.suffix'
  // ── Tepsi menüsü ──
  | 'tray.showWidget'
  | 'tray.hideWidget'
  | 'tray.refresh'
  | 'tray.panel'
  | 'tray.quit'
  | 'tray.noData'
  | 'tray.iconMissing'
  | 'tray.iconUnverified'
  // ── Süre birimleri ──
  | 'unit.hour'
  | 'unit.minute'
  | 'unit.second'
  | 'unit.day'
  | 'time.ago'

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = {
  tr: {
    'window.session': 'Oturum',
    'window.week': 'Hafta',

    'reset.at': '{time}’de sıfırlanır',
    'reset.left': '{left} kaldı',
    'reset.unknown': 'sıfırlanma saati bildirilmedi',
    'measured.ago': '{age} önce ölçüldü',

    'state.firstMeasure': 'ilk ölçüm alınıyor…',
    'state.noData': 'gösterilecek ölçüm yok',
    'state.measuring': 'ölçülüyor…',
    'state.noMeasureYet': 'henüz ölçüm yok',
    'state.stale': 'bayat · {age} önce',
    'state.retryIn': '~{left} sonra tekrar denenecek',

    'error.notFound': 'claude komutu bulunamadı',
    'error.notLoggedIn': 'Oturum kapalı (claude auth login)',
    'error.timeout': 'Yanıt zamanında gelmedi',
    'error.badOutput': 'Kota yanıtı okunamadı',
    'error.rateLimited': 'Çok sık soruldu, bekleniyor',
    'error.unknown': 'Ölçüm alınamadı',

    'view.focus': 'Odak',
    'view.list': 'Liste',
    'view.strip': 'Şerit',
    'view.suffix': '{view} görünümü',
    'action.measureNow': 'Şimdi ölç',
    'action.measuring': 'Ölçülüyor',
    'action.hideToTray': 'Gizle (tepsi ikonundan geri aç)',
    'action.close': 'Kapat',

    'tray.showWidget': 'Widget’ı göster',
    'tray.hideWidget': 'Widget’ı gizle',
    'tray.refresh': 'Şimdi yenile',
    'tray.panel': 'Ayrıntılı panel',
    'tray.quit': 'Çıkış',
    'tray.noData': 'Kota verisi yok',
    'tray.iconMissing': 'Tepsi ikonu yok',
    'tray.iconUnverified': 'Tepsi ikonu doğrulanamadı',

    'unit.hour': 'sa',
    'unit.minute': 'dk',
    'unit.second': 'sn',
    'unit.day': 'gün',
    'time.ago': '{value} önce'
  },
  en: {
    'window.session': 'Session',
    'window.week': 'Week',

    'reset.at': 'resets at {time}',
    'reset.left': '{left} left',
    'reset.unknown': 'no reset time reported',
    'measured.ago': 'measured {age} ago',

    'state.firstMeasure': 'taking first measurement…',
    'state.noData': 'nothing to show',
    'state.measuring': 'measuring…',
    'state.noMeasureYet': 'no measurement yet',
    'state.stale': 'stale · {age} ago',
    'state.retryIn': 'retrying in ~{left}',

    'error.notFound': 'claude command not found',
    'error.notLoggedIn': 'Signed out (claude auth login)',
    'error.timeout': 'No response in time',
    'error.badOutput': 'Could not read usage response',
    'error.rateLimited': 'Asked too often, backing off',
    'error.unknown': 'Measurement failed',

    'view.focus': 'Focus',
    'view.list': 'List',
    'view.strip': 'Strip',
    'view.suffix': '{view} view',
    'action.measureNow': 'Measure now',
    'action.measuring': 'Measuring',
    'action.hideToTray': 'Hide (reopen from the tray icon)',
    'action.close': 'Close',

    'tray.showWidget': 'Show widget',
    'tray.hideWidget': 'Hide widget',
    'tray.refresh': 'Refresh now',
    'tray.panel': 'Details panel',
    'tray.quit': 'Quit',
    'tray.noData': 'No usage data',
    'tray.iconMissing': 'No tray icon',
    'tray.iconUnverified': 'Tray icon unverified',

    'unit.hour': 'h',
    'unit.minute': 'm',
    'unit.second': 's',
    'unit.day': 'd',
    'time.ago': '{value} ago'
  }
}

/**
 * Metni getirir ve `{ad}` yer tutucularını doldurur.
 * Bilinmeyen yer tutucu olduğu gibi kalır — sessizce boş bırakılmaz.
 */
export function t(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  const template = MESSAGES[lang][key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Süreyi dile göre biçimler: TR "3 sa 17 dk", EN "3h 17m".
 * Bir günden uzunsa yalnız toplam saat yazılır — gün/tarih yerine doğrudan
 * okunabilir bir sayı.
 */
export function formatDuration(lang: Lang, ms: number, opts: { short?: boolean } = {}): string {
  const total = Math.max(0, ms)
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor(total / 60_000) % 60
  const h = t(lang, 'unit.hour')
  const m = t(lang, 'unit.minute')
  const sep = lang === 'tr' ? ' ' : ''

  if (opts.short === true && hours >= 24) return `${hours}${sep}${h}`
  if (hours > 0) return `${hours}${sep}${h} ${minutes}${sep}${m}`
  return `${minutes}${sep}${m}`
}

/** Geçmiş bir anı anlatır: TR "5 dk önce", EN "5m ago". Aşağı yuvarlar. */
export function formatAgo(lang: Lang, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const s = t(lang, 'unit.second')
  const sep = lang === 'tr' ? ' ' : ''
  if (seconds < 60) return t(lang, 'time.ago', { value: `${seconds}${sep}${s}` })

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t(lang, 'time.ago', { value: `${minutes}${sep}${t(lang, 'unit.minute')}` })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t(lang, 'time.ago', { value: `${hours}${sep}${t(lang, 'unit.hour')}` })
  return t(lang, 'time.ago', { value: `${Math.floor(hours / 24)}${sep}${t(lang, 'unit.day')}` })
}
