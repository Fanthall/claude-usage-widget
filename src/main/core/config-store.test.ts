import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLL_INTERVAL_MS } from '../../shared/types'
import {
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  TEMP_SUFFIX,
  defaultConfig,
  loadConfig,
  normalizeConfig,
  saveConfig,
  tempFilePath,
  toCollectorConfig,
  type AppConfig,
  type ConfigFs
} from './config-store'

/**
 * Testler os.tmpdir() altinda benzersiz dizinlerde calisir. Dizinler silinmez
 * (hard-rule A2); temizlik isletim sistemine birakilir.
 */
async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'cuw-config-'))
}

/** Bellekte calisan sahte dosya sistemi; cagrilari da kaydeder. */
function memoryFs(seed: Record<string, string> = {}): ConfigFs & {
  files: Map<string, string>
  calls: string[]
} {
  const files = new Map<string, string>(Object.entries(seed))
  const calls: string[] = []
  return {
    files,
    calls,
    async readFile(file: string): Promise<string> {
      calls.push('read ' + file)
      const content = files.get(file)
      if (content === undefined) {
        const error = new Error('ENOENT') as Error & { code: string }
        error.code = 'ENOENT'
        throw error
      }
      return content
    },
    async writeFile(file: string, data: string): Promise<void> {
      calls.push('write ' + file)
      files.set(file, data)
    },
    async rename(from: string, to: string): Promise<void> {
      calls.push('rename ' + from + ' -> ' + to)
      const content = files.get(from)
      if (content === undefined) throw new Error('ENOENT')
      files.delete(from)
      files.set(to, content)
    },
    async ensureDir(dir: string): Promise<void> {
      calls.push('mkdir ' + dir)
    },
    async removeFile(file: string): Promise<void> {
      calls.push('remove ' + file)
      files.delete(file)
    }
  }
}

const FILE = '/cfg/config.json'

// ── Varsayilanlar ────────────────────────────────────────────────────────────

describe('defaultConfig', () => {
  it('proje yollarini paylasmaz (security.md Q4)', () => {
    expect(defaultConfig().shareProjectPaths).toBe(false)
  })

  it('sozlesmedeki olcum araligini kullanir', () => {
    expect(defaultConfig().pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
  })

  it('her cagride yeni nesne verir', () => {
    const first = defaultConfig()
    first.autostart = true
    expect(defaultConfig().autostart).toBe(false)
  })
})

// ── normalizeConfig ──────────────────────────────────────────────────────────

describe('normalizeConfig', () => {
  it('gecerli konfigi oldugu gibi birakir', () => {
    const input: AppConfig = {
      claudeBinPath: 'C:\\bin\\claude.cmd',
      pollIntervalMs: 30_000,
      widgetBounds: { x: 10, y: 20, width: 300, height: 140 },
      shareProjectPaths: true,
      autostart: true
    }
    const { config, issues } = normalizeConfig(input)
    expect(config).toEqual(input)
    expect(issues).toEqual([])
  })

  it('eksik alanlar varsayilana duser ve sorun bildirmez', () => {
    const { config, issues } = normalizeConfig({})
    expect(config).toEqual(defaultConfig())
    expect(issues).toEqual([])
  })

  it('kok deger nesne degilse varsayilana duser', () => {
    const { config, issues } = normalizeConfig('bozuk')
    expect(config).toEqual(defaultConfig())
    expect(issues).toHaveLength(1)
  })

  it('dizi kok deger de kabul edilmez', () => {
    expect(normalizeConfig([1, 2]).issues).toHaveLength(1)
  })

  it('bozuk alan digerlerini goturmez', () => {
    const { config, issues } = normalizeConfig({
      claudeBinPath: 42,
      shareProjectPaths: true
    })
    expect(config.claudeBinPath).toBeNull()
    expect(config.shareProjectPaths).toBe(true)
    expect(issues).toHaveLength(1)
  })

  it('bos claudeBinPath null sayilir', () => {
    expect(normalizeConfig({ claudeBinPath: '   ' }).config.claudeBinPath).toBeNull()
  })

  it('pollIntervalMs sayi degilse varsayilan', () => {
    const { config, issues } = normalizeConfig({ pollIntervalMs: 'hizli' })
    expect(config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
    expect(issues).toHaveLength(1)
  })

  it('pollIntervalMs alt sinira cekilir', () => {
    const { config, issues } = normalizeConfig({ pollIntervalMs: 10 })
    expect(config.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS)
    expect(issues).toHaveLength(1)
  })

  it('pollIntervalMs ust sinira cekilir', () => {
    const { config } = normalizeConfig({ pollIntervalMs: 99 * 60 * 60 * 1000 })
    expect(config.pollIntervalMs).toBe(MAX_POLL_INTERVAL_MS)
  })

  it('NaN aralik varsayilana duser', () => {
    expect(normalizeConfig({ pollIntervalMs: Number.NaN }).config.pollIntervalMs).toBe(
      DEFAULT_POLL_INTERVAL_MS
    )
  })

  it('gecerli widgetBounds korunur', () => {
    const bounds = { x: -5, y: 0, width: 320, height: 200 }
    expect(normalizeConfig({ widgetBounds: bounds }).config.widgetBounds).toEqual(bounds)
  })

  it('eksik alanli widgetBounds sifirlanir', () => {
    const { config, issues } = normalizeConfig({ widgetBounds: { x: 1, y: 2, width: 10 } })
    expect(config.widgetBounds).toBeNull()
    expect(issues).toHaveLength(1)
  })

  it('sifir genislikli widgetBounds gecersizdir', () => {
    expect(normalizeConfig({ widgetBounds: { x: 1, y: 2, width: 0, height: 5 } }).config
      .widgetBounds).toBeNull()
  })

  it('null widgetBounds sorun sayilmaz', () => {
    expect(normalizeConfig({ widgetBounds: null }).issues).toEqual([])
  })

  it('mantiksal olmayan autostart varsayilana duser', () => {
    const { config, issues } = normalizeConfig({ autostart: 'evet' })
    expect(config.autostart).toBe(false)
    expect(issues).toHaveLength(1)
  })

  it('shareProjectPaths acikca acilabilir', () => {
    expect(normalizeConfig({ shareProjectPaths: true }).config.shareProjectPaths).toBe(true)
  })
})

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('dosya yoksa varsayilan doner ve missing isaretlenir', async () => {
    const result = await loadConfig(FILE, { fs: memoryFs() })
    expect(result.missing).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.config).toEqual(defaultConfig())
  })

  it('bozuk JSON cokmez, varsayilana duser', async () => {
    const fs = memoryFs({ [FILE]: '{ "pollIntervalMs": ' })
    const result = await loadConfig(FILE, { fs })
    expect(result.config).toEqual(defaultConfig())
    expect(result.missing).toBe(false)
    expect(result.issues).toHaveLength(1)
  })

  it('bos dosya bozuk JSON sayilir', async () => {
    const result = await loadConfig(FILE, { fs: memoryFs({ [FILE]: '' }) })
    expect(result.config).toEqual(defaultConfig())
    expect(result.issues).toHaveLength(1)
  })

  it('okuma hatasi (ENOENT disi) missing degildir', async () => {
    const fs = memoryFs()
    fs.readFile = async (): Promise<string> => {
      throw new Error('EACCES')
    }
    const result = await loadConfig(FILE, { fs })
    expect(result.missing).toBe(false)
    expect(result.issues).toEqual(['dosya okunamadi'])
  })

  it('gecerli dosyayi okur', async () => {
    const stored: AppConfig = {
      claudeBinPath: '/usr/local/bin/claude',
      pollIntervalMs: 15_000,
      widgetBounds: { x: 1, y: 2, width: 300, height: 100 },
      shareProjectPaths: true,
      autostart: true
    }
    const fs = memoryFs({ [FILE]: JSON.stringify(stored) })
    const result = await loadConfig(FILE, { fs })
    expect(result.config).toEqual(stored)
    expect(result.issues).toEqual([])
  })

  it('kismen bozuk dosyada saglam alanlar korunur', async () => {
    const fs = memoryFs({
      [FILE]: JSON.stringify({ pollIntervalMs: 'cok', shareProjectPaths: true })
    })
    const result = await loadConfig(FILE, { fs })
    expect(result.config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS)
    expect(result.config.shareProjectPaths).toBe(true)
    expect(result.issues).toHaveLength(1)
  })
})

// ── saveConfig: atomik yazim ─────────────────────────────────────────────────

describe('saveConfig', () => {
  it('once gecici dosyaya yazar, sonra rename eder', async () => {
    const fs = memoryFs()
    await saveConfig(FILE, defaultConfig(), { fs })
    expect(fs.calls).toEqual([
      'mkdir ' + dirname(FILE),
      'write ' + FILE + TEMP_SUFFIX,
      'rename ' + FILE + TEMP_SUFFIX + ' -> ' + FILE
    ])
  })

  it('basarili yazimdan sonra gecici dosya kalmaz', async () => {
    const fs = memoryFs()
    await saveConfig(FILE, defaultConfig(), { fs })
    expect(fs.files.has(tempFilePath(FILE))).toBe(false)
    expect(fs.files.has(FILE)).toBe(true)
  })

  it('rename patlarsa gecici dosya temizlenir', async () => {
    const fs = memoryFs()
    fs.rename = async (): Promise<void> => {
      throw new Error('EPERM')
    }
    await expect(saveConfig(FILE, defaultConfig(), { fs })).rejects.toThrow('EPERM')
    expect(fs.files.has(tempFilePath(FILE))).toBe(false)
  })

  it('rename patlarsa hedef dosya eski haliyle kalir', async () => {
    const onceki = JSON.stringify({ pollIntervalMs: 15_000 })
    const fs = memoryFs({ [FILE]: onceki })
    fs.rename = async (): Promise<void> => {
      throw new Error('EPERM')
    }
    await expect(saveConfig(FILE, defaultConfig(), { fs })).rejects.toThrow('EPERM')
    expect(fs.files.get(FILE)).toBe(onceki)
  })

  it('temizlik de patlarsa asil hata golgelenmez', async () => {
    const fs = memoryFs()
    fs.rename = async (): Promise<void> => {
      throw new Error('EPERM')
    }
    fs.removeFile = async (): Promise<void> => {
      throw new Error('temizlik hatasi')
    }
    await expect(saveConfig(FILE, defaultConfig(), { fs })).rejects.toThrow('EPERM')
  })

  it('es zamanli yazimlar birbirinin gecici dosyasini ezmez', async () => {
    const fs = memoryFs()
    const first: AppConfig = { ...defaultConfig(), pollIntervalMs: 10_000 }
    const second: AppConfig = { ...defaultConfig(), pollIntervalMs: 20_000 }
    await Promise.all([
      saveConfig(FILE, first, { fs }),
      saveConfig(FILE, second, { fs })
    ])
    const written = fs.files.get(FILE) ?? ''
    // Iki yazim sirayla tamamlanir; sonuc iki tam JSON'dan biridir, karisim degil.
    expect([JSON.stringify(first, null, 2) + '\n', JSON.stringify(second, null, 2) + '\n'])
      .toContain(written)
    expect(fs.files.has(tempFilePath(FILE))).toBe(false)
  })

  it('bir yazim patlasa da sonraki yazim calisir', async () => {
    const fs = memoryFs()
    let patla = true
    const gercekRename = fs.rename.bind(fs)
    fs.rename = async (from: string, to: string): Promise<void> => {
      if (patla) {
        patla = false
        throw new Error('EPERM')
      }
      await gercekRename(from, to)
    }
    const ilk = saveConfig(FILE, defaultConfig(), { fs })
    const ikinci = saveConfig(FILE, { ...defaultConfig(), autostart: true }, { fs })
    await expect(ilk).rejects.toThrow('EPERM')
    await expect(ikinci).resolves.toBeUndefined()
    expect(JSON.parse(fs.files.get(FILE) ?? '{}').autostart).toBe(true)
  })
})

// ── Gercek dosya sistemiyle gidis-donus ──────────────────────────────────────

describe('gercek dosya sistemi', () => {
  it('yazilan konfig geri okunur ve gecici dosya birakmaz', async () => {
    const dir = await tempDir()
    const file = join(dir, 'config.json')
    const config: AppConfig = {
      claudeBinPath: null,
      pollIntervalMs: 45_000,
      widgetBounds: { x: 3, y: 4, width: 280, height: 120 },
      shareProjectPaths: false,
      autostart: true
    }

    await saveConfig(file, config)
    const result = await loadConfig(file)

    expect(result.config).toEqual(config)
    expect(result.issues).toEqual([])
    expect(result.missing).toBe(false)
    expect(await readdir(dir)).toEqual(['config.json'])
  })

  it('olmayan dizini olusturur', async () => {
    const dir = await tempDir()
    const file = join(dir, 'ic', 'derin', 'config.json')
    await saveConfig(file, defaultConfig())
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(defaultConfig())
  })

  it('diskteki bozuk dosya uygulamayi durdurmaz', async () => {
    const dir = await tempDir()
    const file = join(dir, 'config.json')
    await writeFile(file, '{ yarim', 'utf8')
    const result = await loadConfig(file)
    expect(result.config).toEqual(defaultConfig())
    expect(result.issues).toHaveLength(1)
  })

  it('yazilan dosya satir sonuyla biter (elle duzenlenebilir)', async () => {
    const dir = await tempDir()
    const file = join(dir, 'config.json')
    await saveConfig(file, defaultConfig())
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true)
  })
})

// ── Sozlesmeye kopru ─────────────────────────────────────────────────────────

describe('toCollectorConfig', () => {
  it('CollectorConfig alanlarini doldurur', () => {
    const config: AppConfig = { ...defaultConfig(), claudeBinPath: '/bin/claude' }
    expect(toCollectorConfig(config, '/veri')).toEqual({
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      dataDir: '/veri',
      claudeBinPath: '/bin/claude'
    })
  })

  it('bilinmeyen calistirilabilir null tasinir', () => {
    expect(toCollectorConfig(defaultConfig(), '/veri').claudeBinPath).toBeNull()
  })
})

describe('BOM iceren konfig (regresyon)', () => {
  it('BOM ile baslayan gecerli JSON okunur, varsayilana dusmez', async () => {
    const gecerli = JSON.stringify({ ...defaultConfig(), pollIntervalMs: 120_000 })
    const fs: ConfigFs = {
      readFile: async () => `\uFEFF${gecerli}`,
      writeFile: async () => undefined,
      rename: async () => undefined,
      ensureDir: async () => undefined,
      removeFile: async () => undefined
    }
    const sonuc = await loadConfig('/tmp/config.json', { fs })
    expect(sonuc.issues).toEqual([])
    expect(sonuc.config.pollIntervalMs).toBe(120_000)
  })
})
