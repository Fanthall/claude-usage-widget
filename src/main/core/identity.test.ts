import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CREDENTIALS_FILE_NAME,
  claudeCredentialsFile,
  readAccessToken,
  readAccountIdentity
} from './identity'
import { resetLogSink, setLogSink, type LogRecord } from './log-safe'
import type { PathEnv, PathFs } from './paths'

// ── Sabitler ve sahte ortam ──────────────────────────────────────────────────

const CONFIG_FILE = '/home/ada/.claude.json'
const CREDS_FILE = '/home/ada/.claude/.credentials.json'

/**
 * Sahte jeton bilerek **log-safe'in maskeleyemeyecegi** bicimde secildi: kisa
 * harf gruplari, rakam yok. Boylece kod jetonu bir yere sizdirsa maskelenip
 * gizlenmez, testte ciplak gorunur — guvenlik testi gercekten sizintiyi olcer,
 * maskelemeyi degil.
 */
const FAKE_TOKEN = 'sahte-jeton-degeri-DENEME'

function windowsEnv(): PathEnv {
  return { platform: 'win32', homeDir: 'C:\\Users\\ada', env: {} }
}

function macEnv(): PathEnv {
  return { platform: 'darwin', homeDir: '/Users/ada', env: {} }
}

function linuxEnv(): PathEnv {
  return { platform: 'linux', homeDir: '/home/ada', env: {} }
}

function missingFileError(): Error {
  const error = new Error('ENOENT: no such file') as Error & { code: string }
  error.code = 'ENOENT'
  return error
}

function fakeFs(files: Record<string, string>): PathFs {
  return {
    async readFile(file: string): Promise<string> {
      const content = files[file]
      if (content === undefined) throw missingFileError()
      return content
    }
  }
}

function failingFs(error: Error): PathFs {
  return {
    async readFile(_file: string): Promise<string> {
      throw error
    }
  }
}

function configWith(account: unknown): string {
  return JSON.stringify({ machineID: 'ada-makine', oauthAccount: account })
}

function credentialsWith(oauth: unknown): string {
  return JSON.stringify({ claudeAiOauth: oauth })
}

// Loglar testte yakalanir: hem gurultu cikmaz hem de icerigi olcebiliriz.
let records: LogRecord[] = []

beforeEach(() => {
  records = []
  setLogSink((record) => {
    records.push(record)
  })
})

afterEach(() => {
  resetLogSink()
})

function loggedText(): string {
  return JSON.stringify(records)
}

// ── claudeCredentialsFile ────────────────────────────────────────────────────

describe('claudeCredentialsFile', () => {
  it('Windows ayracini kullanir', () => {
    expect(claudeCredentialsFile(windowsEnv())).toBe('C:\\Users\\ada\\.claude\\.credentials.json')
  })

  it('macOS yolunu uretir', () => {
    expect(claudeCredentialsFile(macEnv())).toBe('/Users/ada/.claude/.credentials.json')
  })

  it('Linux yolunu uretir', () => {
    expect(claudeCredentialsFile(linuxEnv())).toBe(CREDS_FILE)
  })

  it('~/.claude ALTINDA durur, ~/.claude.json degildir', () => {
    const file = claudeCredentialsFile(linuxEnv())
    expect(file.endsWith('/.claude/' + CREDENTIALS_FILE_NAME)).toBe(true)
    expect(file).not.toBe('/home/ada/.claude.json')
  })
})

// ── readAccountIdentity ──────────────────────────────────────────────────────

describe('readAccountIdentity', () => {
  it('gecerli dosyadan tum alanlari okur', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: configWith({
        emailAddress: 'ada@ornek.com',
        organizationName: 'Ornek A.S.',
        subscriptionType: 'max'
      })
    })

    await expect(readAccountIdentity(fs, CONFIG_FILE)).resolves.toEqual({
      loggedIn: true,
      email: 'ada@ornek.com',
      orgName: 'Ornek A.S.',
      subscriptionType: 'max'
    })
  })

  it('subscriptionType yoksa seatTier okunur', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: configWith({ emailAddress: 'ada@ornek.com', seatTier: 'enterprise' })
    })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.subscriptionType).toBe('enterprise')
  })

  it('subscriptionType varsa seatTier yok sayilir', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: configWith({ subscriptionType: 'pro', seatTier: 'enterprise' })
    })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.subscriptionType).toBe('pro')
  })

  it('eksik alanlar null kalir, uydurulmaz', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: configWith({ emailAddress: 'ada@ornek.com' }) })

    await expect(readAccountIdentity(fs, CONFIG_FILE)).resolves.toEqual({
      loggedIn: true,
      email: 'ada@ornek.com',
      orgName: null,
      subscriptionType: null
    })
  })

  it('yalniz-bosluk degerler alan sayilmaz', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: configWith({
        emailAddress: '   ',
        organizationName: '',
        subscriptionType: 'pro'
      })
    })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.email).toBeNull()
    expect(auth.orgName).toBeNull()
    expect(auth.subscriptionType).toBe('pro')
  })

  it('yalniz accountUuid varsa oturum sayilir ama uuid dondurulmez', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    const fs = fakeFs({ [CONFIG_FILE]: configWith({ accountUuid: uuid }) })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth).toEqual({ loggedIn: true, email: null, orgName: null, subscriptionType: null })
    expect(JSON.stringify(auth)).not.toContain(uuid)
  })

  it('bos oauthAccount oturum sayilmaz', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: configWith({}) })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
  })

  it('oauthAccount yoksa oturum yok doner', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: JSON.stringify({ machineID: 'ada-makine' }) })

    await expect(readAccountIdentity(fs, CONFIG_FILE)).resolves.toEqual({
      loggedIn: false,
      email: null,
      orgName: null,
      subscriptionType: null
    })
  })

  it('oauthAccount nesne degilse oturum yok doner', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: configWith(['ada@ornek.com']) })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
  })

  it('bozuk JSON cokmez, oturum yok doner', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: '{ "oauthAccount": { ' })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('warn')
  })

  it('ust duzey deger nesne degilse oturum yok doner', async () => {
    const fs = fakeFs({ [CONFIG_FILE]: '[1, 2, 3]' })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
  })

  it('BOM ile baslayan dosyayi okur', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: '\uFEFF' + configWith({ emailAddress: 'ada@ornek.com' })
    })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.email).toBe('ada@ornek.com')
    expect(records).toHaveLength(0)
  })

  it('dosya yoksa sessizce oturum yok doner (giris yapilmamis olmak hata degil)', async () => {
    const fs = fakeFs({})

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
    expect(records).toHaveLength(0)
  })

  it('okuma hatasinda cokmez, uyari birakir', async () => {
    const fs = failingFs(new Error('EACCES: izin yok'))

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(auth.loggedIn).toBe(false)
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe('warn')
  })
})

// ── readAccessToken ──────────────────────────────────────────────────────────

describe('readAccessToken', () => {
  const now = (): number => 1_000_000

  it('suresi dolmamis jetonu dondurur', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 2_000_000 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBe(FAKE_TOKEN)
  })

  it('suresi dolmus jetonu vermez', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 999_999 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('tam sinirda (expiresAt === simdi) jeton verilmez', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 1_000_000 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('expiresAt yoksa yas bilinmiyor sayilir, jeton dondurulur', async () => {
    const fs = fakeFs({ [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN }) })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBe(FAKE_TOKEN)
  })

  it('expiresAt sayi degilse jeton dondurulur', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: '2026-01-01' })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBe(FAKE_TOKEN)
  })

  it('accessToken yoksa null doner', async () => {
    const fs = fakeFs({ [CREDS_FILE]: credentialsWith({ expiresAt: 2_000_000 }) })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('accessToken bos dizge ise null doner', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: '   ', expiresAt: 2_000_000 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('claudeAiOauth yoksa null doner', async () => {
    const fs = fakeFs({ [CREDS_FILE]: JSON.stringify({ other: { accessToken: FAKE_TOKEN } }) })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('bozuk JSON cokmez, null doner', async () => {
    const fs = fakeFs({ [CREDS_FILE]: '{ "claudeAiOauth": ' })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('BOM ile baslayan dosyayi okur', async () => {
    const fs = fakeFs({
      [CREDS_FILE]:
        '\uFEFF' + credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 2_000_000 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBe(FAKE_TOKEN)
  })

  it('dosya yoksa sessizce null doner', async () => {
    const fs = fakeFs({})

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
    expect(records).toHaveLength(0)
  })

  it('okuma hatasinda cokmez', async () => {
    const fs = failingFs(new Error('EACCES: izin yok'))

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
  })

  it('varsayilan saat gercek zamani kullanir', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: Date.now() + 60_000 })
    })

    await expect(readAccessToken(fs, CREDS_FILE)).resolves.toBe(FAKE_TOKEN)
  })
})

// ── Guvenlik ─────────────────────────────────────────────────────────────────

describe('guvenlik: jeton sizmaz', () => {
  const now = (): number => 1_000_000

  it('bozuk oturum dosyasinin icerigi loglanmaz', async () => {
    // Bozuk ama icinde jeton olan bir dosya: ayristirma hatasi mesaji icerik
    // tasiyabilir, o yuzden hicbir icerik loga gitmemeli.
    const fs = fakeFs({ [CREDS_FILE]: '{ "claudeAiOauth": { "accessToken": "' + FAKE_TOKEN })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
    expect(records.length).toBeGreaterThan(0)
    expect(loggedText()).not.toContain(FAKE_TOKEN)
  })

  it('suresi dolmus jeton uyarisinda deger gecmez', async () => {
    const fs = fakeFs({
      [CREDS_FILE]: credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 1 })
    })

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
    expect(records).toHaveLength(1)
    expect(loggedText()).not.toContain(FAKE_TOKEN)
  })

  it('okuma hatasinin mesaji jeton tasisa bile loga girmez', async () => {
    const fs = failingFs(new Error('EACCES ' + FAKE_TOKEN))

    await expect(readAccessToken(fs, CREDS_FILE, now)).resolves.toBeNull()
    expect(loggedText()).not.toContain(FAKE_TOKEN)
  })

  it('hesap kimligi donusu jeton tasimaz', async () => {
    const fs = fakeFs({
      [CONFIG_FILE]: JSON.stringify({
        oauthAccount: { emailAddress: 'ada@ornek.com', accessToken: FAKE_TOKEN },
        claudeAiOauth: { accessToken: FAKE_TOKEN }
      })
    })

    const auth = await readAccountIdentity(fs, CONFIG_FILE)
    expect(JSON.stringify(auth)).not.toContain(FAKE_TOKEN)
    expect(loggedText()).not.toContain(FAKE_TOKEN)
  })

  it('CONSTRAINT-7: hicbir yol dosyaya YAZMAZ', async () => {
    const writeFile = vi.fn()
    const spyFs = {
      readFile: async (): Promise<string> =>
        credentialsWith({ accessToken: FAKE_TOKEN, expiresAt: 2_000_000 }),
      writeFile
    }

    await readAccessToken(spyFs, CREDS_FILE, now)
    await readAccountIdentity(spyFs, CONFIG_FILE)
    expect(writeFile).not.toHaveBeenCalled()
  })
})
