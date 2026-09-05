import { describe, expect, it } from 'vitest'
import {
  APP_DIR_NAME,
  CONFIG_FILE_NAME,
  appConfigFile,
  appDataDir,
  claudeConfigFile,
  claudeHomeDir,
  nodePathEnv,
  readClaudeIdentity,
  readMachineId,
  type PathEnv,
  type PathFs
} from './paths'

// ── Sahte ortamlar ───────────────────────────────────────────────────────────

function windowsEnv(env: Record<string, string | undefined> = {}): PathEnv {
  return { platform: 'win32', homeDir: 'C:\\Users\\ada', env }
}

function macEnv(env: Record<string, string | undefined> = {}): PathEnv {
  return { platform: 'darwin', homeDir: '/Users/ada', env }
}

function linuxEnv(env: Record<string, string | undefined> = {}): PathEnv {
  return { platform: 'linux', homeDir: '/home/ada', env }
}

function fakeFs(files: Record<string, string>): PathFs {
  return {
    async readFile(file: string): Promise<string> {
      const content = files[file]
      if (content === undefined) {
        const error = new Error('ENOENT') as Error & { code: string }
        error.code = 'ENOENT'
        throw error
      }
      return content
    }
  }
}

// ── claudeHomeDir / claudeConfigFile ─────────────────────────────────────────

describe('claudeHomeDir', () => {
  it('Windows ayracini kullanir', () => {
    expect(claudeHomeDir(windowsEnv())).toBe('C:\\Users\\ada\\.claude')
  })

  it('macOS yolunu uretir', () => {
    expect(claudeHomeDir(macEnv())).toBe('/Users/ada/.claude')
  })

  it('Linux yolunu uretir', () => {
    expect(claudeHomeDir(linuxEnv())).toBe('/home/ada/.claude')
  })
})

describe('claudeConfigFile', () => {
  it('Windows ~/.claude.json', () => {
    expect(claudeConfigFile(windowsEnv())).toBe('C:\\Users\\ada\\.claude.json')
  })

  it('macOS ~/.claude.json', () => {
    expect(claudeConfigFile(macEnv())).toBe('/Users/ada/.claude.json')
  })

  it('Linux ~/.claude.json', () => {
    expect(claudeConfigFile(linuxEnv())).toBe('/home/ada/.claude.json')
  })

  it('dizinin degil dosyanin yolunu verir', () => {
    expect(claudeConfigFile(linuxEnv())).not.toBe(claudeHomeDir(linuxEnv()))
  })
})

// ── appDataDir ───────────────────────────────────────────────────────────────

describe('appDataDir', () => {
  it('Windows: %APPDATA% varsa onu kullanir', () => {
    const dir = appDataDir(APP_DIR_NAME, windowsEnv({ APPDATA: 'D:\\Roaming' }))
    expect(dir).toBe('D:\\Roaming\\claude-usage-widget')
  })

  it('Windows: %APPDATA% yoksa AppData\\Roaming altina duser', () => {
    expect(appDataDir(APP_DIR_NAME, windowsEnv())).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\claude-usage-widget'
    )
  })

  it('Windows: bos %APPDATA% tanimsiz sayilir', () => {
    expect(appDataDir(APP_DIR_NAME, windowsEnv({ APPDATA: '   ' }))).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\claude-usage-widget'
    )
  })

  it('macOS: Application Support altinda', () => {
    expect(appDataDir(APP_DIR_NAME, macEnv())).toBe(
      '/Users/ada/Library/Application Support/claude-usage-widget'
    )
  })

  it('Linux: XDG_CONFIG_HOME varsa onu kullanir', () => {
    const dir = appDataDir(APP_DIR_NAME, linuxEnv({ XDG_CONFIG_HOME: '/var/tmp/cfg' }))
    expect(dir).toBe('/var/tmp/cfg/claude-usage-widget')
  })

  it('Linux: XDG_CONFIG_HOME yoksa ~/.config', () => {
    expect(appDataDir(APP_DIR_NAME, linuxEnv())).toBe('/home/ada/.config/claude-usage-widget')
  })

  it('Linux: goreli XDG_CONFIG_HOME yok sayilir (XDG sartnamesi)', () => {
    const dir = appDataDir(APP_DIR_NAME, linuxEnv({ XDG_CONFIG_HOME: 'gomulu/yol' }))
    expect(dir).toBe('/home/ada/.config/claude-usage-widget')
  })

  it('varsayilan taban ad uygulamanin kendi adidir', () => {
    expect(appDataDir(undefined, macEnv())).toContain(APP_DIR_NAME)
  })

  it('taban ad degistirilebilir', () => {
    expect(appDataDir('deneme', linuxEnv())).toBe('/home/ada/.config/deneme')
  })

  it('platformlar ayni yola cikmaz', () => {
    const dirs = new Set([
      appDataDir(APP_DIR_NAME, windowsEnv()),
      appDataDir(APP_DIR_NAME, macEnv()),
      appDataDir(APP_DIR_NAME, linuxEnv())
    ])
    expect(dirs.size).toBe(3)
  })
})

describe('appConfigFile', () => {
  it('veri dizininin altindadir', () => {
    expect(appConfigFile(APP_DIR_NAME, linuxEnv())).toBe(
      '/home/ada/.config/claude-usage-widget/' + CONFIG_FILE_NAME
    )
  })

  it('Windows ayracini korur', () => {
    expect(appConfigFile(APP_DIR_NAME, windowsEnv({ APPDATA: 'D:\\Roaming' }))).toBe(
      'D:\\Roaming\\claude-usage-widget\\config.json'
    )
  })
})

describe('nodePathEnv', () => {
  it('desteklenen bir platform ve dolu bir ev dizini verir', () => {
    const env = nodePathEnv()
    expect(['win32', 'darwin', 'linux']).toContain(env.platform)
    expect(env.homeDir.length).toBeGreaterThan(0)
  })
})

// ── readMachineId / readClaudeIdentity ───────────────────────────────────────

const CONFIG_PATH = '/home/ada/.claude.json'

describe('readMachineId', () => {
  it('machineID alanini okur', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ machineID: 'abc123' }) })
    expect(await readMachineId(fs, CONFIG_PATH)).toBe('abc123')
  })

  it('alan yoksa null', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ baska: 1 }) })
    expect(await readMachineId(fs, CONFIG_PATH)).toBeNull()
  })

  it('dosya yoksa null doner, istisna firlatmaz', async () => {
    const fs = fakeFs({})
    await expect(readMachineId(fs, CONFIG_PATH)).resolves.toBeNull()
  })

  it('bozuk JSON cokmez', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: '{ machineID: ' })
    await expect(readMachineId(fs, CONFIG_PATH)).resolves.toBeNull()
  })

  it('JSON nesne degilse null', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: '"duz dizge"' })
    expect(await readMachineId(fs, CONFIG_PATH)).toBeNull()
  })

  it('dizi de nesne sayilmaz', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: '[{"machineID":"x"}]' })
    expect(await readMachineId(fs, CONFIG_PATH)).toBeNull()
  })

  it('sayi tipindeki machineID kabul edilmez', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ machineID: 42 }) })
    expect(await readMachineId(fs, CONFIG_PATH)).toBeNull()
  })

  it('bos/bosluk machineID null sayilir', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ machineID: '   ' }) })
    expect(await readMachineId(fs, CONFIG_PATH)).toBeNull()
  })
})

describe('readClaudeIdentity', () => {
  it('machineID ve e-postayi birlikte verir', async () => {
    const fs = fakeFs({
      [CONFIG_PATH]: JSON.stringify({
        machineID: 'm-1',
        oauthAccount: { emailAddress: 'ada@ornek.com' }
      })
    })
    expect(await readClaudeIdentity(fs, CONFIG_PATH)).toEqual({
      machineId: 'm-1',
      email: 'ada@ornek.com'
    })
  })

  it('oauthAccount yoksa e-posta null', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ machineID: 'm-1' }) })
    expect(await readClaudeIdentity(fs, CONFIG_PATH)).toEqual({ machineId: 'm-1', email: null })
  })

  it('oauthAccount nesne degilse e-posta null', async () => {
    const fs = fakeFs({ [CONFIG_PATH]: JSON.stringify({ oauthAccount: 'ada@ornek.com' }) })
    expect(await readClaudeIdentity(fs, CONFIG_PATH)).toEqual({ machineId: null, email: null })
  })

  it('belirtec alanlarini ne okur ne dondurur', async () => {
    const fs = fakeFs({
      [CONFIG_PATH]: JSON.stringify({
        machineID: 'm-1',
        oauthAccount: {
          emailAddress: 'ada@ornek.com',
          accessToken: 'gizli-deger-1',
          refreshToken: 'gizli-deger-2'
        },
        primaryApiKey: 'gizli-deger-3'
      })
    })
    const identity = await readClaudeIdentity(fs, CONFIG_PATH)
    expect(Object.keys(identity).sort()).toEqual(['email', 'machineId'])
    expect(JSON.stringify(identity)).not.toContain('gizli-deger')
  })

  it('okuma hatasinda her iki alan da null', async () => {
    const fs: PathFs = {
      async readFile(): Promise<string> {
        throw new Error('EACCES')
      }
    }
    expect(await readClaudeIdentity(fs, CONFIG_PATH)).toEqual({ machineId: null, email: null })
  })
})
