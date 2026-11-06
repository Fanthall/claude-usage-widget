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
  // ── Hesaplar ──
  | 'account.personal'
  | 'account.team'
  | 'account.group'
  | 'account.show'
  | 'account.notConnected'
  | 'account.connectHint'
  // ── Token ──
  | 'tokens.last15'
  | 'tokens.today'
  | 'tokens.per15'
  | 'tokens.scanning'
  | 'tokens.unavailable'
  | 'tokens.badLines'
  | 'tokens.cacheRead'
  | 'tokens.thisDevice'
  | 'tokens.deviceOnly'
  | 'tokens.hubUnreachable'
  | 'unit.thousand'
  | 'unit.million'
  | 'unit.billion'
  // ── Panel ──
  | 'panel.title'
  | 'panel.lastData'
  | 'panel.range.today'
  | 'panel.range.yesterday'
  | 'panel.range.7d'
  | 'panel.range.30d'
  | 'panel.range.group'
  | 'panel.step.group'
  | 'panel.metric.total'
  | 'panel.metric.output'
  | 'panel.metric.group'
  | 'panel.metric.fresh'
  | 'panel.theme.toggle'
  | 'panel.tokens.title'
  | 'panel.tokens.hint'
  | 'panel.quota.title'
  | 'panel.quota.weekly'
  | 'panel.quota.mixed'
  | 'panel.window.session'
  | 'panel.window.week'
  | 'panel.quota.caution'
  | 'panel.quota.critical'
  | 'panel.now'
  | 'panel.heat.title'
  | 'panel.heat.less'
  | 'panel.heat.more'
  | 'panel.peaks.title'
  | 'panel.col.slice'
  | 'panel.col.total'
  | 'panel.breakdown.device'
  | 'panel.breakdown.model'
  | 'panel.breakdown.project'
  | 'panel.project.none'
  | 'panel.devices.title'
  | 'panel.devices.queue'
  | 'panel.devices.never'
  | 'panel.card.fill'
  | 'panel.card.noFill'
  | 'panel.empty'
  | 'panel.error'
  | 'panel.localOnly'
  | 'panel.loading'
  | 'panel.unattributed.title'
  | 'panel.unattributed.body'
  | 'panel.unattributed.none'
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

    'account.personal': 'Kişisel',
    'account.team': 'Team',
    'account.group': 'Hesap',
    'account.show': '{account} hesabını göster',
    'account.notConnected': 'bağlı değil',
    'account.connectHint': 'Bağlamak için bir kez claude-team ile /login',

    'tokens.last15': 'Token · son 15 dk',
    'tokens.today': 'bugün {value}',
    'tokens.per15': '{value}/15 dk',
    'tokens.scanning': 'Geçmiş taranıyor · {pct}',
    'tokens.unavailable': 'Token sayılamıyor',
    'tokens.badLines': '{count} satır okunamadı',
    'tokens.cacheRead': '+{value} önbellekten okuma',
    'tokens.thisDevice': 'bu cihaz: {last15} · bugün {today}',
    'tokens.deviceOnly': 'yalnız bu cihaz',
    'tokens.hubUnreachable': 'merkeze ulaşılamadı',
    'unit.thousand': 'bin',
    'unit.million': 'mn',
    'unit.billion': 'mr',

    'panel.title': 'Claude kullanımı',
    'panel.lastData': 'son veri {age}',
    'panel.range.today': 'Bugün',
    'panel.range.yesterday': 'Dün',
    'panel.range.7d': '7 gün',
    'panel.range.30d': '30 gün',
    'panel.range.group': 'Zaman aralığı',
    'panel.step.group': 'Dilim genişliği',
    'panel.metric.total': 'Önbellek dahil',
    'panel.metric.output': 'Yalnız çıktı',
    'panel.metric.group': 'Ölçü',
    'panel.metric.fresh': 'Önbelleksiz',
    'panel.theme.toggle': 'Açık/koyu tema',
    'panel.tokens.title': 'Token · {step} dilimler',
    'panel.tokens.hint': 'Bir dilimin üzerine gel: o dilimin tokenleri',
    'panel.quota.title': '5 saatlik kota',
    'panel.quota.weekly': 'Haftalık kota',
    'panel.quota.mixed': 'Kota',
    'panel.window.session': '5 saatlik',
    'panel.window.week': 'haftalık',
    'panel.quota.caution': 'dikkat {pct}',
    'panel.quota.critical': 'kritik {pct}',
    'panel.now': 'şimdi',
    'panel.heat.title': 'Saat × gün · son 7 gün',
    'panel.heat.less': 'az',
    'panel.heat.more': 'çok',
    'panel.peaks.title': 'En yoğun dilimler',
    'panel.col.slice': 'Dilim',
    'panel.col.total': 'Toplam',
    'panel.breakdown.device': 'Cihaz',
    'panel.breakdown.model': 'Model',
    'panel.breakdown.project': 'Proje',
    'panel.project.none': 'adı gönderilmeyen',
    'panel.devices.title': 'Cihazlar',
    'panel.devices.queue': 'kuyrukta {count}',
    'panel.devices.never': 'hiç görülmedi',
    'panel.card.fill': 'Bu hızla pencere {time}’de dolar',
    'panel.card.noFill': 'Bu hızla dolmadan sıfırlanır',
    'panel.empty': 'Bu aralıkta veri yok',
    'panel.error': 'Veriler alınamadı',
    'panel.localOnly': 'Merkez bağlı değil: yalnız bu cihazın tokenleri görünüyor',
    'panel.loading': 'Yükleniyor…',
    'panel.unattributed.title': 'Toplayıcısız harcama · tahmin',
    'panel.unattributed.body':
      '{account}: bu aralıkta {window} pencerelerde toplam {rise} puan kota harcandı; kayıtlı tokenler bunun yaklaşık {explained} kadarını açıklıyor. Kalanı toplayıcısı olmayan yerden geliyor: telefon, claude.ai ya da bulut oturumu.',
    'panel.unattributed.none': 'Tahmin için yeterli kota ölçümü yok',

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

    'account.personal': 'Personal',
    'account.team': 'Team',
    'account.group': 'Account',
    'account.show': 'Show {account} account',
    'account.notConnected': 'not connected',
    'account.connectHint': 'To connect, run /login once with claude-team',

    'tokens.last15': 'Tokens · last 15 min',
    'tokens.today': 'today {value}',
    'tokens.per15': '{value}/15m',
    'tokens.scanning': 'Reading history · {pct}',
    'tokens.unavailable': 'Token count unavailable',
    'tokens.badLines': '{count} lines unreadable',
    'tokens.cacheRead': '+{value} read from cache',
    'tokens.thisDevice': 'this device: {last15} · today {today}',
    'tokens.deviceOnly': 'this device only',
    'tokens.hubUnreachable': 'hub unreachable',
    'unit.thousand': 'K',
    'unit.million': 'M',
    'unit.billion': 'B',

    'panel.title': 'Claude usage',
    'panel.lastData': 'last data {age}',
    'panel.range.today': 'Today',
    'panel.range.yesterday': 'Yesterday',
    'panel.range.7d': '7 days',
    'panel.range.30d': '30 days',
    'panel.range.group': 'Time range',
    'panel.step.group': 'Slice width',
    'panel.metric.total': 'Incl. cache reads',
    'panel.metric.output': 'Output only',
    'panel.metric.group': 'Metric',
    'panel.metric.fresh': 'Excl. cache reads',
    'panel.theme.toggle': 'Light/dark theme',
    'panel.tokens.title': 'Tokens · {step} slices',
    'panel.tokens.hint': 'Hover a slice to see its tokens',
    'panel.quota.title': '5-hour quota',
    'panel.quota.weekly': 'Weekly quota',
    'panel.quota.mixed': 'Quota',
    'panel.window.session': '5-hour',
    'panel.window.week': 'weekly',
    'panel.quota.caution': 'caution {pct}',
    'panel.quota.critical': 'critical {pct}',
    'panel.now': 'now',
    'panel.heat.title': 'Hour × day · last 7 days',
    'panel.heat.less': 'less',
    'panel.heat.more': 'more',
    'panel.peaks.title': 'Busiest slices',
    'panel.col.slice': 'Slice',
    'panel.col.total': 'Total',
    'panel.breakdown.device': 'Device',
    'panel.breakdown.model': 'Model',
    'panel.breakdown.project': 'Project',
    'panel.project.none': 'name not shared',
    'panel.devices.title': 'Devices',
    'panel.devices.queue': '{count} queued',
    'panel.devices.never': 'never seen',
    'panel.card.fill': 'At this rate the window fills at {time}',
    'panel.card.noFill': 'At this rate it resets before filling',
    'panel.empty': 'No data in this range',
    'panel.error': 'Could not load data',
    'panel.localOnly': 'No hub connected: showing this device’s tokens only',
    'panel.loading': 'Loading…',
    'panel.unattributed.title': 'Unattributed usage · estimate',
    'panel.unattributed.body':
      '{account}: {rise} points of {window} quota were used in this range; recorded tokens explain about {explained} of that. The rest came from places without a collector: phone, claude.ai or a cloud session.',
    'panel.unattributed.none': 'Not enough quota samples for an estimate',

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
 * Yüzde işaretinin yeri bir yerel ayar farkıdır, çeviri değil: Türkçede işaret
 * sayıdan ÖNCE yazılır (TDK: %65), İngilizcede sonra (65%). Arayüz işareti
 * sayıdan farklı boyutta çizdiği için sıra ayrı bir bilgi olarak verilir.
 */
export const PERCENT_SIGN_FIRST: Record<Lang, boolean> = { tr: true, en: false }

/** Düz metin yüzde: TR "%65", EN "65%". */
export function formatPercent(lang: Lang, value: number): string {
  return PERCENT_SIGN_FIRST[lang] ? `%${value}` : `${value}%`
}

/**
 * Token sayısını kısaltır: TR "1,8 mn", "58,7 mr", "12 bin"; EN "1.8M", "58.7B", "12K".
 * Ondalık ayracı dile göre; 10'dan büyükse ondalık yazılmaz (gürültü).
 */
export function formatTokens(lang: Lang, value: number): string {
  const n = Math.max(0, value)
  const tiers: Array<[number, MessageKey]> = [
    [1e9, 'unit.billion'],
    [1e6, 'unit.million'],
    [1e3, 'unit.thousand']
  ]
  for (const [size, key] of tiers) {
    if (n >= size) {
      const scaled = n / size
      const digits = scaled >= 10 ? 0 : 1
      const text = scaled.toFixed(digits).replace('.', lang === 'tr' ? ',' : '.')
      return lang === 'tr' ? `${text} ${t(lang, key)}` : `${text}${t(lang, key)}`
    }
  }
  return String(Math.round(n))
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
