import type { CliErrorKind, UsageStatus, UsageWindow } from '@shared/types'

/**
 * Ölçümün yaşı ve durum metinleri — React'ten ayrı, saf fonksiyonlar.
 *
 * Ayrı durmasının nedeni doğrulanabilirlik: test ortamı `node`, yani DOM yok.
 * Bu dosyadaki kararlar (yaş eşiği, hangi durumda ne yazıldığı) widget'ı
 * çizmeden sınanabilir.
 */

/**
 * Bu yaşın üstündeki değer, durum `ok` olsa bile yaşıyla birlikte gösterilir.
 *
 * Bayatlık eşiği ölçüm aralığıyla ölçekleniyor (`staleThresholdMs`): 5 dakikalık
 * aralıkta 12,5 dakika. Yani `ok` durumu on dakikalık veriyi de kapsar ve sayı
 * hiçbir şey söylemeden taze görünür — 2026-09-05'te yirmi dakikalık değer
 * güncel sanıldı. Eşik aşılınca sayının yanında ne zaman ölçüldüğü yazar.
 */
export const FRESHNESS_NOTICE_MS = 2 * 60 * 1000

/** Ekranda gösterilen ölçüm. */
export interface ShownData {
  windows: UsageWindow[]
  /**
   * `UsageSnapshot.at` — verinin **sunucudan alındığı** an, bizim okuduğumuz an
   * değil. Yaş hesabı buna dayanır; tazeleme çalışmadığında değer kendiliğinden
   * eski görünür.
   */
  at: number | null
  /** Değer güncel kabul ediliyor mu (bayat ya da hata artığı değil). */
  fresh: boolean
}

export function shownData(status: UsageStatus): ShownData {
  if (status.kind === 'ok') {
    return { windows: status.snapshot.windows, at: status.snapshot.at, fresh: true }
  }
  if (status.kind === 'stale') {
    return { windows: status.snapshot.windows, at: status.snapshot.at, fresh: false }
  }
  if (status.kind === 'error' && status.lastSnapshot !== null) {
    return { windows: status.lastSnapshot.windows, at: status.lastSnapshot.at, fresh: false }
  }
  return { windows: [], at: null, fresh: false }
}

/** Yaşı insan ölçüsüne çevirir. Aşağı yuvarlar — geçen süre abartılmaz. */
export function ageText(ms: number): string {
  const sn = Math.max(0, Math.floor(ms / 1000))
  if (sn < 60) return `${sn} sn önce`
  const dk = Math.floor(sn / 60)
  if (dk < 60) return `${dk} dk önce`
  const sa = Math.floor(dk / 60)
  if (sa < 24) return `${sa} sa önce`
  return `${Math.floor(sa / 24)} gün önce`
}

export interface AgeNotice {
  text: string
  /** Gösterilen değer güncel değil; hem renk hem metin bunu söyler. */
  stale: boolean
}

/**
 * Sayının yanında duracak tazelik satırı. Güncel ve yeni ölçüm için `null` —
 * her zaman görünen bir "0 sn önce" satırı gürültü olur, dikkat çekmesi gereken
 * durumda da fark edilmez.
 */
export function ageNotice(status: UsageStatus, now: number): AgeNotice | null {
  const { at, fresh } = shownData(status)
  if (at === null) return null
  const age = Math.max(0, now - at)
  if (fresh && age < FRESHNESS_NOTICE_MS) return null
  const olcum = `${ageText(age)} ölçüldü`
  // Bayatlığı renk değil METİN söyler; renk tek başına bilgi taşımaz.
  return { text: fresh ? olcum : `eski değer · ${olcum}`, stale: !fresh }
}

/**
 * Durum satırının tonu.
 * - `info`: nötr bilgi (ilk ölçüm, veri yok).
 * - `wait`: kendiliğinden geçer, kullanıcı bir şey yapmaz.
 * - `error`: müdahale ister.
 */
export type NoticeTone = 'info' | 'wait' | 'error'

export interface StatusNotice {
  text: string
  tone: NoticeTone
  /** Üst üste deneme sayısı gösterilsin mi. */
  showStreak: boolean
}

/**
 * Hata sınıfına göre ayrı metin; tek genel "hata" yazılmaz (REQ-10 AC2).
 * Kullanıcının atacağı adım sınıftan sınıfa değişir.
 */
function errorNotice(kind: CliErrorKind, message: string): StatusNotice {
  switch (kind) {
    case 'rate-limited':
      // Kırılan bir şey yok: uç bizi bekletiyor, sınır açılınca ölçüm kendiliğinden
      // döner. "Hata" demek kullanıcıyı gereksiz müdahaleye iter. Aynı nedenle
      // streak sayacı da gizlenir — geri çekilme sırasında tekrar denemek beklenen
      // davranıştır, "(5x)" büyüyen bir arıza gibi okunur.
      return {
        text: 'çok sık soruldu · bekleniyor, kendiliğinden geçer',
        tone: 'wait',
        showStreak: false
      }
    case 'not-found':
      return { text: 'claude komutu bulunamadı', tone: 'error', showStreak: true }
    case 'not-logged-in':
      return { text: 'oturum kapalı · claude /login', tone: 'error', showStreak: true }
    case 'timeout':
      return { text: 'ölçüm zamanında yanıt vermedi', tone: 'error', showStreak: true }
    case 'bad-output':
      return { text: 'kota yanıtı okunamadı', tone: 'error', showStreak: true }
    case 'unknown':
      return {
        text: message.trim() === '' ? 'ölçüm alınamadı' : message,
        tone: 'error',
        showStreak: true
      }
  }
}

/** Alt satırda duran durum metni. `ok` iken satır hiç çizilmez. */
export function statusNotice(status: UsageStatus): StatusNotice | null {
  switch (status.kind) {
    case 'ok':
      return null
    case 'loading':
      return { text: 'ölçülüyor...', tone: 'info', showStreak: false }
    case 'no-data':
      return { text: 'henüz ölçüm yok', tone: 'info', showStreak: false }
    case 'stale':
      // Yaş zaten sayının yanında yazıyor; burada NEDEN yazılır, yaş tekrar edilmez.
      return { text: 'ölçüm gecikti', tone: 'wait', showStreak: false }
    case 'error':
      return errorNotice(status.errorKind, status.message)
  }
}
