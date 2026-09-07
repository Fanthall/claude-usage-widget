import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  createCliRefresher,
  findClaudeBinary,
  REFRESH_COOLDOWN_MS,
  sortVersionsDesc,
  type DiscoverFs
} from './cli-refresh'

function fakeFs(paths: readonly string[], dirs: Record<string, string[]> = {}): DiscoverFs {
  return {
    exists: (p) => paths.includes(p),
    listDir: (p) => dirs[p] ?? []
  }
}

describe('sortVersionsDesc', () => {
  it('sayisal siralar — dizgi siralamasi 2.1.9 > 2.1.260 derdi', () => {
    expect(sortVersionsDesc(['2.1.9', '2.1.260', '2.1.58'])).toEqual([
      '2.1.260',
      '2.1.58',
      '2.1.9'
    ])
  })

  it('bos liste ve bozuk ad cokmez', () => {
    expect(sortVersionsDesc([])).toEqual([])
    expect(sortVersionsDesc(['abc', '1.0'])).toEqual(['1.0', 'abc'])
  })
})

describe('findClaudeBinary — Windows', () => {
  // Yollar `win32.join` ile kurulur: fixture'i elle ters egik cizgiyle yazmak
  // hem okunmaz hem de kacis hatasina acik.
  const roaming = win32.join('C:', 'Roaming')
  const env = { APPDATA: roaming, USERPROFILE: win32.join('C:', 'Users', 'x') }
  const base = win32.join(roaming, 'Claude', 'claude-code')
  const exe = (v: string): string => win32.join(base, v, 'claude.exe')

  it('en yeni surum klasorundeki exe secilir', () => {
    const fs = fakeFs([exe('2.1.260'), exe('2.1.9')], { [base]: ['2.1.9', '2.1.260'] })
    expect(findClaudeBinary('win32', env, fs)).toBe(exe('2.1.260'))
  })

  it('en yeni klasorde exe yoksa bir alttakine duser', () => {
    const fs = fakeFs([exe('2.1.9')], { [base]: ['2.1.9', '2.1.260'] })
    expect(findClaudeBinary('win32', env, fs)).toBe(exe('2.1.9'))
  })

  it('PATH shim (.cmd/.ps1) DONDURULMEZ — Node 22 onu execFile ile calistiramaz', () => {
    // Projede iki kez yasanan tuzak: shim calistirilinca EINVAL geliyor ve
    // "CLI kurulu degil" diye yanlis teshis ediliyordu.
    const npm = win32.join(roaming, 'npm')
    const fs = fakeFs([win32.join(npm, 'claude.cmd'), win32.join(npm, 'claude.ps1')])
    expect(findClaudeBinary('win32', env, fs)).toBeNull()
  })

  it('hicbir sey yoksa null', () => {
    expect(findClaudeBinary('win32', env, fakeFs([]))).toBeNull()
  })
})

describe('findClaudeBinary — POSIX', () => {
  const home = posix.join('/home', 'x')
  const env = { HOME: home }

  it('Apple Silicon Homebrew yolu taniniyor', () => {
    // Capraz platform denetiminde eksik oldugu tespit edilmisti.
    const fs = fakeFs(['/opt/homebrew/bin/claude'])
    expect(findClaudeBinary('darwin', env, fs)).toBe('/opt/homebrew/bin/claude')
  })

  it('kullanici yolu sistem yolundan once gelir', () => {
    const local = posix.join(home, '.local', 'bin', 'claude')
    const fs = fakeFs([local, '/usr/local/bin/claude'])
    expect(findClaudeBinary('linux', env, fs)).toBe(local)
  })

  it('Windows disinda yol ayraci egik cizgidir', () => {
    // Hedef platform parametreye baglidir; calisilan makineye DEGIL. Bu test
    // Windows'ta kosarken bile POSIX yolu bekler.
    const local = posix.join(home, '.local', 'bin', 'claude')
    expect(local).toContain('/')
    expect(findClaudeBinary('darwin', env, fakeFs([local]))).toBe(local)
  })
})

describe('createCliRefresher', () => {
  it('CLI bulunamazsa calistirma denenmez', async () => {
    const run = vi.fn()
    const refresh = createCliRefresher({ findBinary: () => null, run })
    expect(await refresh()).toBe('no-cli')
    expect(run).not.toHaveBeenCalled()
  })

  it('kabuk KULLANMAZ ve /usage argumanini dizi olarak gecer', async () => {
    // Parametreler acikca yazilir; yoksa mock.calls bos tuple olarak tiplenir.
    const run = vi.fn(async (_file: string, _args: readonly string[]) => undefined)
    const refresh = createCliRefresher({ findBinary: () => '/bin/claude', run })

    expect(await refresh()).toBe('refreshed')
    const [file, args] = run.mock.calls[0] ?? []
    expect(file).toBe('/bin/claude')
    // Kabuk olsaydi "/usage" dosya yoluna cevrilir, duz prompt olarak modele
    // gider ve token yakardi.
    expect(args).toEqual(['-p', '/usage', '--output-format', 'json'])
  })

  it('calistirma hatasi yutulur, failed doner', async () => {
    const refresh = createCliRefresher({
      findBinary: () => '/bin/claude',
      run: async () => {
        throw new Error('ENOENT')
      }
    })
    expect(await refresh()).toBe('failed')
  })

  it('bekleme suresi dolmadan ikinci kez calistirmaz', async () => {
    const run = vi.fn(async () => undefined)
    let simdi = 1_000_000
    const refresh = createCliRefresher({
      findBinary: () => '/bin/claude',
      run,
      now: () => simdi
    })

    expect(await refresh()).toBe('refreshed')
    simdi += REFRESH_COOLDOWN_MS - 1
    expect(await refresh()).toBe('cooling-down')
    expect(run).toHaveBeenCalledTimes(1)

    simdi += 2
    expect(await refresh()).toBe('refreshed')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('CLI yoksa bekleme suresi baslamaz — kurulunca hemen denenir', async () => {
    let bin: string | null = null
    const run = vi.fn(async () => undefined)
    let simdi = 0
    const refresh = createCliRefresher({ findBinary: () => bin, run, now: () => simdi })

    expect(await refresh()).toBe('no-cli')
    bin = '/bin/claude'
    simdi += 1000
    expect(await refresh()).toBe('refreshed')
  })
})
