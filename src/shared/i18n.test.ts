import { describe, expect, it } from 'vitest'
import {
  FALLBACK_LANG,
  MESSAGES,
  formatAgo,
  formatDuration,
  pickLang,
  t,
  type Lang,
  type MessageKey
} from './i18n'

/** Sozlukteki tum anahtarlar — kapsama testleri bunun uzerinden doner. */
const ALL_KEYS = Object.keys(MESSAGES.en) as MessageKey[]

/** Bir metindeki `{ad}` yer tutucularini toplar. */
function placeholders(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names.sort()
}

/** Yer tutuculari cikarir; icerideki adlar Ingilizce oldugu icin taramayi bozar. */
function withoutPlaceholders(text: string): string {
  return text.replace(/\{\w+\}/g, ' ')
}

/**
 * TR ve EN metni ayni olmasi **kabul edilen** anahtarlar.
 *
 * Ozel ad, marka ve kisaltmalar iki dilde de ayni yazilir; boyle bir anahtar
 * cikarsa buraya gerekcesiyle eklenir. Su an bos: sozlukteki her anahtar iki
 * dilde farkli metin tasiyor, yani kopyala-yapistir unutmasi yok.
 */
const IDENTICAL_ALLOWED: ReadonlySet<MessageKey> = new Set<MessageKey>()

const MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000
} as const

describe('pickLang', () => {
  it('Turkce yerel ayar dizgilerini tr olarak taniyor', () => {
    expect(pickLang('tr')).toBe('tr')
    expect(pickLang('tr-TR')).toBe('tr')
    expect(pickLang('tr_TR')).toBe('tr')
    expect(pickLang('tr-CY')).toBe('tr')
  })

  it('buyuk harf ve bosluklara takilmiyor', () => {
    expect(pickLang('TR')).toBe('tr')
    expect(pickLang('TR-tr')).toBe('tr')
    expect(pickLang(' tr ')).toBe('tr')
    expect(pickLang('\ttr-TR\n')).toBe('tr')
  })

  it('diger dilleri varsayilana dusuruyor', () => {
    expect(pickLang('en-US')).toBe('en')
    expect(pickLang('en')).toBe('en')
    expect(pickLang('de')).toBe('en')
    expect(pickLang('de-TR')).toBe('en')
    expect(pickLang('az-Latn-AZ')).toBe('en')
  })

  it('bos ve tanimsiz girdide varsayilani veriyor', () => {
    expect(pickLang('')).toBe('en')
    expect(pickLang('   ')).toBe('en')
    expect(pickLang(null)).toBe('en')
    expect(pickLang(undefined)).toBe('en')
  })

  it('onek sinirini dogru cekiyor: "tur..." Turkce degil', () => {
    // 'turkmen' t-u-r ile baslar, 'tr' ile DEGIL — Turkce sayilmamali.
    expect(pickLang('turkmen')).toBe('en')
    expect(pickLang('tur')).toBe('en')
    expect(pickLang('tk')).toBe('en')
    // Onek eslesmesi bastan yapilir; icinde 'tr' gecmesi yetmez.
    expect(pickLang('ktr')).toBe('en')
    expect(pickLang('en-tr')).toBe('en')
  })

  it('varsayilan dil EN', () => {
    expect(FALLBACK_LANG).toBe('en')
  })
})

describe('t', () => {
  it('yer tutucuyu dolduruyor', () => {
    expect(t('en', 'reset.at', { time: '14:00' })).toBe('resets at 14:00')
    expect(t('tr', 'reset.at', { time: '14:00' })).toBe('14:00’de sıfırlanır')
  })

  it('sayi degerini metne ceviriyor', () => {
    expect(t('en', 'reset.left', { left: 5 })).toBe('5 left')
    expect(t('tr', 'reset.left', { left: 0 })).toBe('0 kaldı')
  })

  it('karsiligi olmayan yer tutucuyu oldugu gibi birakiyor', () => {
    // Sessizce bos birakmak, ekranda "resets at " gibi yarim cumle uretirdi.
    expect(t('en', 'reset.at', {})).toBe('resets at {time}')
    expect(t('en', 'reset.at', { wrong: '14:00' })).toBe('resets at {time}')
    expect(t('tr', 'state.stale', { yanlis: '5 dk' })).toBe('bayat · {age} önce')
  })

  it('fazladan parametreyi yok sayiyor', () => {
    expect(t('en', 'reset.left', { left: '3h', extra: 'yoksay' })).toBe('3h left')
  })

  it('parametresiz cagirilinca sablonu aynen donduruyor', () => {
    expect(t('en', 'reset.at')).toBe('resets at {time}')
    expect(t('en', 'window.session')).toBe('Session')
    expect(t('tr', 'window.session')).toBe('Oturum')
  })

  it('ayni anahtar icin iki dilde farkli metin donduruyor', () => {
    expect(t('tr', 'view.focus')).toBe('Odak')
    expect(t('en', 'view.focus')).toBe('Focus')
    expect(t('tr', 'tray.quit')).toBe('Çıkış')
    expect(t('en', 'tray.quit')).toBe('Quit')
  })

  it('yer tutucu sirasi dile gore degisebiliyor', () => {
    // TR'de {time} basta, EN'de sonda — motamot aktarim degil.
    expect(t('tr', 'reset.at', { time: '09:30' }).startsWith('09:30')).toBe(true)
    expect(t('en', 'reset.at', { time: '09:30' }).endsWith('09:30')).toBe(true)
  })
})

describe('formatDuration', () => {
  it('sifir sureyi dakika olarak yaziyor', () => {
    expect(formatDuration('tr', 0)).toBe('0 dk')
    expect(formatDuration('en', 0)).toBe('0m')
  })

  it('bir dakikanin altini sifir dakika sayiyor', () => {
    expect(formatDuration('tr', 59 * MS.second)).toBe('0 dk')
    expect(formatDuration('en', 59 * MS.second)).toBe('0m')
  })

  it('tam bir saati saat + dakika olarak yaziyor', () => {
    expect(formatDuration('tr', MS.hour)).toBe('1 sa 0 dk')
    expect(formatDuration('en', MS.hour)).toBe('1h 0m')
  })

  it('saat ve dakikayi birlikte veriyor', () => {
    const value = 3 * MS.hour + 17 * MS.minute
    expect(formatDuration('tr', value)).toBe('3 sa 17 dk')
    expect(formatDuration('en', value)).toBe('3h 17m')
  })

  it('saniyeleri yok sayiyor', () => {
    const value = 3 * MS.hour + 17 * MS.minute + 59 * MS.second
    expect(formatDuration('tr', value)).toBe('3 sa 17 dk')
    expect(formatDuration('en', value)).toBe('3h 17m')
  })

  it('short=true ve 24 saatin ustunde yalniz saat yaziyor', () => {
    const value = 25 * MS.hour + 40 * MS.minute
    expect(formatDuration('tr', value, { short: true })).toBe('25 sa')
    expect(formatDuration('en', value, { short: true })).toBe('25h')
  })

  it('short=true olsa da 24 saatin altinda dakikayi koruyor', () => {
    const value = 23 * MS.hour + 59 * MS.minute
    expect(formatDuration('tr', value, { short: true })).toBe('23 sa 59 dk')
    expect(formatDuration('en', value, { short: true })).toBe('23h 59m')
  })

  it('short verilmezse 24 saatin ustunde de dakika yaziyor', () => {
    const value = 25 * MS.hour
    expect(formatDuration('tr', value)).toBe('25 sa 0 dk')
    expect(formatDuration('en', value)).toBe('25h 0m')
    expect(formatDuration('en', value, { short: false })).toBe('25h 0m')
  })

  it('negatif sureyi sifira sabitliyor', () => {
    expect(formatDuration('tr', -5 * MS.hour)).toBe('0 dk')
    expect(formatDuration('en', -1)).toBe('0m')
  })

  it('TR bosluklu, EN bosluksuz ayrac kullaniyor', () => {
    const value = 2 * MS.hour + 5 * MS.minute
    expect(formatDuration('tr', value)).toContain(' sa ')
    expect(formatDuration('en', value)).not.toContain(' h')
    expect(formatDuration('en', value)).toBe('2h 5m')
  })
})

describe('formatAgo', () => {
  it('bir dakikanin altini saniye olarak veriyor', () => {
    expect(formatAgo('tr', 0)).toBe('0 sn önce')
    expect(formatAgo('en', 0)).toBe('0s ago')
    expect(formatAgo('tr', 5 * MS.second)).toBe('5 sn önce')
    expect(formatAgo('en', 59 * MS.second)).toBe('59s ago')
  })

  it('milisaniye artigini asagi yuvarliyor', () => {
    expect(formatAgo('en', 999)).toBe('0s ago')
    expect(formatAgo('tr', 5 * MS.second + 999)).toBe('5 sn önce')
  })

  it('dakika esigini tam 60 saniyede geciyor', () => {
    expect(formatAgo('tr', 59 * MS.second)).toBe('59 sn önce')
    expect(formatAgo('tr', MS.minute)).toBe('1 dk önce')
    expect(formatAgo('en', MS.minute)).toBe('1m ago')
  })

  it('dakikayi asagi yuvarliyor', () => {
    expect(formatAgo('tr', MS.minute + 59 * MS.second)).toBe('1 dk önce')
    expect(formatAgo('en', 59 * MS.minute + 59 * MS.second)).toBe('59m ago')
  })

  it('saat esigini tam 60 dakikada geciyor', () => {
    expect(formatAgo('tr', MS.hour)).toBe('1 sa önce')
    expect(formatAgo('en', MS.hour)).toBe('1h ago')
    expect(formatAgo('tr', MS.hour + 59 * MS.minute)).toBe('1 sa önce')
    expect(formatAgo('en', 23 * MS.hour + 59 * MS.minute)).toBe('23h ago')
  })

  it('gun esigini tam 24 saatte geciyor', () => {
    expect(formatAgo('tr', MS.day)).toBe('1 gün önce')
    expect(formatAgo('en', MS.day)).toBe('1d ago')
    expect(formatAgo('tr', 3 * MS.day + 20 * MS.hour)).toBe('3 gün önce')
    expect(formatAgo('en', 3 * MS.day + 20 * MS.hour)).toBe('3d ago')
  })

  it('negatif sureyi sifira sabitliyor', () => {
    expect(formatAgo('tr', -1)).toBe('0 sn önce')
    expect(formatAgo('en', -MS.day)).toBe('0s ago')
  })

  it('iki dilde farkli metin uretiyor', () => {
    const value = 5 * MS.minute
    expect(formatAgo('tr', value)).toBe('5 dk önce')
    expect(formatAgo('en', value)).toBe('5m ago')
    expect(formatAgo('tr', value)).not.toBe(formatAgo('en', value))
  })
})

describe('MESSAGES kapsamasi', () => {
  const langs: Lang[] = ['tr', 'en']

  it('sozluk bos degil', () => {
    expect(ALL_KEYS.length).toBeGreaterThan(0)
  })

  it('TR ve EN anahtar kumeleri birebir ayni', () => {
    const tr = Object.keys(MESSAGES.tr).sort()
    const en = Object.keys(MESSAGES.en).sort()
    expect(tr).toEqual(en)
  })

  it('hicbir deger bos veya yalniz bosluk degil', () => {
    for (const lang of langs) {
      for (const key of ALL_KEYS) {
        expect(MESSAGES[lang][key].trim(), `${lang}/${key} bos`).not.toBe('')
      }
    }
  })

  it('hicbir EN degeri TR degerinin kopyasi degil', () => {
    const copied = ALL_KEYS.filter(
      (key) => MESSAGES.en[key] === MESSAGES.tr[key] && !IDENTICAL_ALLOWED.has(key)
    )
    expect(copied).toEqual([])
  })

  it('yer tutucu kumeleri iki dilde ayni', () => {
    for (const key of ALL_KEYS) {
      expect(placeholders(MESSAGES.tr[key]), `${key} yer tutuculari`).toEqual(
        placeholders(MESSAGES.en[key])
      )
    }
  })

  it('kapali kalmis yer tutucu suslu parantezi yok', () => {
    // '{left kaldı' gibi bir yazim hatasi ekranda ham suslu parantez birakir.
    for (const lang of langs) {
      for (const key of ALL_KEYS) {
        const text = MESSAGES[lang][key]
        const opens = (text.match(/\{/g) ?? []).length
        const closes = (text.match(/\}/g) ?? []).length
        expect(opens, `${lang}/${key} suslu parantez dengesi`).toBe(closes)
        expect(placeholders(text).length, `${lang}/${key} yer tutucu sayisi`).toBe(opens)
      }
    }
  })

  it('her anahtar iki dilde de t() ile okunabiliyor', () => {
    for (const lang of langs) {
      for (const key of ALL_KEYS) {
        expect(t(lang, key)).toBe(MESSAGES[lang][key])
      }
    }
  })

  it('TR metinlerinde Ingilizce kacagi yok', () => {
    // Ceviri unutulunca TR tarafta EN kelimeler kalir; en sik gorulenleri tarar.
    const leaks = /\b(reset|left|measured|measuring|stale|view|show|hide|quit|refresh)\b/i
    const suspects = ALL_KEYS.filter((key) => leaks.test(withoutPlaceholders(MESSAGES.tr[key])))
    expect(suspects).toEqual([])
  })
})
