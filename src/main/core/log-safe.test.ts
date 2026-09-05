import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMAIL_MASK,
  HOME_MASK,
  MAX_META_DEPTH,
  SECRET_MASK,
  configureMasking,
  consoleSink,
  isSecretKey,
  maskMeta,
  maskSensitive,
  resetLogSink,
  safeLog,
  setLogSink,
  type LogRecord
} from './log-safe'

afterEach(() => {
  resetLogSink()
  configureMasking({})
  vi.restoreAllMocks()
})

function collect(): { records: LogRecord[] } {
  const records: LogRecord[] = []
  setLogSink((record) => records.push(record))
  return { records }
}

// ── E-posta ──────────────────────────────────────────────────────────────────

describe('maskSensitive: e-posta', () => {
  it('e-postayi maskeler', () => {
    expect(maskSensitive('hesap: ada@ornek.com')).toBe('hesap: ' + EMAIL_MASK)
  })

  it('birden fazla e-postayi maskeler', () => {
    const masked = maskSensitive('ada@ornek.com ve zeynep.demir+etiket@alt.ornek.co.uk')
    expect(masked).toBe(EMAIL_MASK + ' ve ' + EMAIL_MASK)
  })

  it('e-posta olmayan @ isaretini bozmaz', () => {
    expect(maskSensitive('@kullanici bir sey dedi')).toBe('@kullanici bir sey dedi')
  })

  it('paket adini bozmaz', () => {
    expect(maskSensitive('@anthropic-ai/claude-code kuruldu')).toBe(
      '@anthropic-ai/claude-code kuruldu'
    )
  })
})

// ── Yollar ───────────────────────────────────────────────────────────────────

describe('maskSensitive: kullanici adi iceren yollar', () => {
  it('Windows ev dizinini maskeler, kuyrugu korur', () => {
    expect(maskSensitive('C:\\Users\\sezer\\.claude\\projects okundu')).toBe(
      HOME_MASK + '\\.claude\\projects okundu'
    )
  })

  it('uzun Windows yol onekini de yakalar', () => {
    expect(maskSensitive('\\\\?\\C:\\Users\\sezer\\AppData')).toBe(HOME_MASK + '\\AppData')
  })

  it('ileri egik cizgili Windows yolunu yakalar', () => {
    expect(maskSensitive('C:/Users/sezer/AppData/Roaming')).toBe(HOME_MASK + '/AppData/Roaming')
  })

  it('macOS ev dizinini maskeler', () => {
    expect(maskSensitive('/Users/ada/Library/Application Support')).toBe(
      HOME_MASK + '/Library/Application Support'
    )
  })

  it('Linux ev dizinini maskeler', () => {
    expect(maskSensitive('/home/ada/.config/claude-usage-widget')).toBe(
      HOME_MASK + '/.config/claude-usage-widget'
    )
  })

  it('WSL yolunu maskeler', () => {
    expect(maskSensitive('/mnt/c/Users/sezer/dev')).toBe(HOME_MASK + '/dev')
  })

  it('kullanici adi tasimayan sistem yolunu bozmaz', () => {
    expect(maskSensitive('/usr/local/bin/claude')).toBe('/usr/local/bin/claude')
  })

  it('kullanici parcasi olmayan /Users/ bozulmaz', () => {
    expect(maskSensitive('dizin /Users/ altinda')).toBe('dizin /Users/ altinda')
  })

  it('URL yolunu bozmaz', () => {
    expect(maskSensitive('https://ornek.com/home/sayfa')).toBe('https://ornek.com/home/sayfa')
  })

  it('verilen ev dizinini maskeler (standart disi konum)', () => {
    const masked = maskSensitive('D:\\calisma\\ada\\notlar.txt', {
      homeDirs: ['D:\\calisma\\ada']
    })
    expect(masked).toBe(HOME_MASK + '\\notlar.txt')
  })

  it('verilen ev dizinini ayractan bagimsiz yakalar', () => {
    const masked = maskSensitive('D:/calisma/ada/notlar.txt', { homeDirs: ['D:\\calisma\\ada'] })
    expect(masked).toBe(HOME_MASK + '/notlar.txt')
  })

  it('bos ev dizini ayari metni bozmaz', () => {
    expect(maskSensitive('duz metin', { homeDirs: ['', '   '] })).toBe('duz metin')
  })
})

// ── Belirtecler ──────────────────────────────────────────────────────────────

describe('maskSensitive: belirtecler', () => {
  it('sk-ant anahtarini maskeler', () => {
    expect(maskSensitive('anahtar sk-ant-oat01-AbCd_1234-EfGh yuklendi')).toBe(
      'anahtar ' + SECRET_MASK + ' yuklendi'
    )
  })

  it('JWT maskeler', () => {
    // JWT **literal olarak yazilmaz**: credential bicimli dizgiler test dosyasinda
    // bile repoya girmemeli (hard-rule 28) ve secret tarayicisi bunlari bulgu
    // sayar. Deger burada parcalardan kurulur; testin olctugu sey degismez.
    const b64 = (o: unknown): string =>
      Buffer.from(JSON.stringify(o)).toString('base64url')
    const jwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'test' }), 'c2lnbmF0dXJl'].join('.')

    expect(maskSensitive('Authorization ' + jwt)).toBe('Authorization ' + SECRET_MASK)
  })

  it('Bearer semasini korur, degeri maskeler', () => {
    expect(maskSensitive('Bearer abc123def456ghi789jkl')).toBe('Bearer ' + SECRET_MASK)
  })

  it('UUID maskeler', () => {
    expect(maskSensitive('oturum 529e4a49-88f8-41e3-b563-76080dfabbb9 acildi')).toBe(
      'oturum ' + SECRET_MASK + ' acildi'
    )
  })

  it('uzun harf-rakam karisik diziyi maskeler', () => {
    const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    expect(maskSensitive('machineID=' + hex)).toBe('machineID=' + SECRET_MASK)
  })

  it('yalnizca rakamdan olusan uzun diziyi maskelemez', () => {
    expect(maskSensitive('at=1757083200000123456789012')).toBe('at=1757083200000123456789012')
  })

  it('yalnizca harften olusan uzun kelimeyi maskelemez', () => {
    expect(maskSensitive('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz')
  })
})

// ── Masum metin bozulmaz ─────────────────────────────────────────────────────

describe('maskSensitive: masum metni bozmaz', () => {
  const masum = [
    '/usage',
    'claude -p "/usage" --output-format json',
    'usage-history.jsonl',
    'usage-history-2026-09-05.jsonl',
    'surum 2.1.258 ve 2.1.260',
    'Current week (all models): 42% used · resets Sep 5, 4:50pm (Europe/Istanbul)',
    'SNAPSHOT_SCHEMA_VERSION degeri 1',
    'EINVAL: execFile shell:false ile .cmd calistirilamiyor',
    '%APPDATA%\\claude-usage-widget\\config.json',
    'toplam 570 ms, 0 token, total_cost_usd 0'
  ]

  for (const text of masum) {
    it('degistirmez: ' + text.slice(0, 40), () => {
      expect(maskSensitive(text)).toBe(text)
    })
  }

  it('bos metni bos birakir', () => {
    expect(maskSensitive('')).toBe('')
  })

  it('maskelenmis cikti tekrar maskelenince degismez', () => {
    const once = maskSensitive('ada@ornek.com C:\\Users\\ada\\x')
    expect(maskSensitive(once)).toBe(once)
  })
})

// ── Karisik icerik ───────────────────────────────────────────────────────────

describe('maskSensitive: karisik satir', () => {
  it('yol, e-posta ve UUID ayni satirda temizlenir', () => {
    const line =
      'kullanici ada@ornek.com, dizin C:\\Users\\ada\\AppData\\Local\\Temp\\529e4a49-88f8-41e3-b563-76080dfabbb9'
    expect(maskSensitive(line)).toBe(
      'kullanici ' +
        EMAIL_MASK +
        ', dizin ' +
        HOME_MASK +
        '\\AppData\\Local\\Temp\\' +
        SECRET_MASK
    )
  })
})

// ── isSecretKey ──────────────────────────────────────────────────────────────

describe('isSecretKey', () => {
  it('gizli anahtar adlarini tanir', () => {
    for (const key of ['accessToken', 'API_KEY', 'password', 'Authorization', 'refresh_token']) {
      expect(isSecretKey(key)).toBe(true)
    }
  })

  it('masum alan adlarini gizli saymaz', () => {
    for (const key of ['authStatus', 'label', 'percent', 'pollIntervalMs', 'machineId']) {
      expect(isSecretKey(key)).toBe(false)
    }
  })
})

// ── maskMeta ─────────────────────────────────────────────────────────────────

describe('maskMeta', () => {
  it('metin degerleri maskeler', () => {
    expect(maskMeta({ dosya: '/home/ada/x.json' })).toEqual({ dosya: HOME_MASK + '/x.json' })
  })

  it('gizli anahtarin degerini hic incelemeden maskeler', () => {
    expect(maskMeta({ accessToken: 'kisa' })).toEqual({ accessToken: SECRET_MASK })
  })

  it('sayi ve mantiksal degerleri korur', () => {
    expect(maskMeta({ percent: 42, ok: true, yok: null })).toEqual({
      percent: 42,
      ok: true,
      yok: null
    })
  })

  it('ic ice nesneleri gezer', () => {
    expect(maskMeta({ dis: { ic: 'ada@ornek.com' } })).toEqual({ dis: { ic: EMAIL_MASK } })
  })

  it('dizileri gezer', () => {
    expect(maskMeta({ yollar: ['/home/ada/a', '/usr/bin/b'] })).toEqual({
      yollar: [HOME_MASK + '/a', '/usr/bin/b']
    })
  })

  it('Error nesnesini ad ve maskeli mesaja indirger', () => {
    expect(maskMeta({ hata: new TypeError('ada@ornek.com bulunamadi') })).toEqual({
      hata: { name: 'TypeError', message: EMAIL_MASK + ' bulunamadi' }
    })
  })

  it('donguyu isaretler, sonsuza gitmez', () => {
    const dugum: Record<string, unknown> = { ad: 'a' }
    dugum['kendi'] = dugum
    expect(maskMeta({ dugum })).toEqual({ dugum: { ad: 'a', kendi: '<dongu>' } })
  })

  it('cok derin yapiyi ozetler', () => {
    let derin: Record<string, unknown> = { son: 'deger' }
    for (let i = 0; i < MAX_META_DEPTH + 2; i += 1) derin = { katman: derin }
    expect(JSON.stringify(maskMeta(derin))).toContain('<derin>')
  })

  it('fonksiyon ve bigint degerlerini duz metne cevirir', () => {
    const masked = maskMeta({ fn: () => undefined, buyuk: 10n })
    expect(masked['fn']).toBe('<fonksiyon>')
    expect(masked['buyuk']).toBe('10')
  })

  it('anahtar adlarini korur', () => {
    expect(Object.keys(maskMeta({ a: 1, b: 'x' }))).toEqual(['a', 'b'])
  })
})

// ── safeLog ──────────────────────────────────────────────────────────────────

describe('safeLog', () => {
  it('mesaji maskeleyip sink e verir', () => {
    const { records } = collect()
    safeLog('info', 'giris: ada@ornek.com')
    expect(records).toEqual([{ level: 'info', message: 'giris: ' + EMAIL_MASK }])
  })

  it('meta verilmediyse alani hic eklemez', () => {
    const { records } = collect()
    safeLog('debug', 'merhaba')
    expect(records[0] && 'meta' in records[0]).toBe(false)
  })

  it('metayi maskeler', () => {
    const { records } = collect()
    safeLog('warn', 'okuma basarisiz', { dosya: '/home/ada/.claude.json', token: 'gizli-deger' })
    expect(records[0]?.meta).toEqual({
      dosya: HOME_MASK + '/.claude.json',
      token: SECRET_MASK
    })
  })

  it('seviyeyi oldugu gibi tasir', () => {
    const { records } = collect()
    safeLog('error', 'patladi')
    expect(records[0]?.level).toBe('error')
  })

  it('configureMasking ile verilen ev dizini tum loglara uygulanir', () => {
    const { records } = collect()
    configureMasking({ homeDirs: ['D:\\calisma\\ada'] })
    safeLog('info', 'dosya D:\\calisma\\ada\\not.txt')
    expect(records[0]?.message).toBe('dosya ' + HOME_MASK + '\\not.txt')
  })

  it('resetLogSink varsayilan cikti yolunu geri verir', () => {
    const { records } = collect()
    resetLogSink()
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    safeLog('info', 'merhaba')
    expect(records).toHaveLength(0)
    expect(spy).toHaveBeenCalledWith('[info]', 'merhaba')
  })
})

describe('consoleSink', () => {
  it('meta varsa uc argumanla yazar', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    consoleSink({ level: 'warn', message: 'dikkat', meta: { a: 1 } })
    expect(spy).toHaveBeenCalledWith('[warn]', 'dikkat', { a: 1 })
  })
})
