import { describe, expect, it } from 'vitest'

import { CliError } from '../../shared/types'
import {
  AUTH_STATUS_ARGS,
  USAGE_ARGS,
  discoverClaudeBinary,
  isWindowsShim,
  isZeroTokenUsage,
  parseAuthStatusJson,
  parseUsageJson,
  runAuthStatus,
  runUsage,
  sortVersionDirsDesc,
  type CliFileSystem,
  type ExecFileError,
  type ExecFileFn,
  type ExecFileOptions,
  type UsageCliOutput
} from './claude-cli'

// ── Test yardimcilari ────────────────────────────────────────────────────────

/** Verilen yollari calistirilabilir, verilen dizinleri listelenebilir sayan sahte fs. */
function fakeFs(executables: readonly string[], dirs: Record<string, string[]> = {}): CliFileSystem {
  const normalized = new Set(executables.map(norm))
  return {
    isExecutable: (path) => normalized.has(norm(path)),
    listDir: (path) => dirs[norm(path)] ?? []
  }
}

function norm(path: string): string {
  return path.replace(/\\/g, '/')
}

interface ExecCall {
  file: string
  args: readonly string[]
  options: ExecFileOptions
}

interface FakeExecResult {
  stdout?: string
  stderr?: string
  error?: Partial<ExecFileError>
  /**
   * Node 22'de batch dosyasi hedefinde `spawn` geri cagriya hic dusmeden
   * SENKRON firlatir (olculdu). Bu bayrak o davranisi taklit eder.
   */
  throwSync?: Partial<ExecFileError>
}

/** execFile yerine gecen sahte; yapilan cagrilari kaydeder. */
function fakeExec(result: FakeExecResult): { fn: ExecFileFn; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const fn: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options })
    if (result.throwSync) {
      throw Object.assign(new Error(result.throwSync.message ?? 'spawn hatasi'), result.throwSync)
    }
    const error = result.error
      ? Object.assign(new Error(result.error.message ?? 'exec hatasi'), result.error)
      : null
    // execFile geri cagrisi asenkrondur; ayni davranisi taklit et.
    queueMicrotask(() => callback(error, result.stdout ?? '', result.stderr ?? ''))
  }
  return { fn, calls }
}

/** cmd.exe sarmalayicisinin urettigi tek parcali komut satiri. */
function commandLine(call: ExecCall | undefined): string {
  return call?.args[3] ?? ''
}

const USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 83% used \u00b7 resets Sep 5, 4:50pm (Europe/Istanbul)',
  'Current week (all models): 20% used \u00b7 resets Sep 6, 8am (Europe/Istanbul)'
].join('\n')

const USAGE_JSON = JSON.stringify({
  type: 'result',
  result: USAGE_TEXT,
  duration_ms: 312,
  duration_api_ms: 0,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 }
})

/** Beklenen CliError'i yakalar; hata atilmazsa testi dusurur. */
async function catchCliError(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(CliError)
    return error as CliError
  }
  throw new Error('CliError bekleniyordu, hata atilmadi')
}

// ── discoverClaudeBinary ─────────────────────────────────────────────────────

describe('discoverClaudeBinary', () => {
  it('konfige yazili yolu her seyden once kullanir', () => {
    const configured = 'D:/tools/claude.exe'
    const found = discoverClaudeBinary({
      configuredPath: configured,
      platform: 'win32',
      env: { PATH: 'C:/bin' },
      fs: fakeFs([configured, 'C:/bin/claude.exe'])
    })
    expect(found).toBe(configured)
  })

  it('konfig yolu artik calismiyorsa kesfi yeniden kosar (REQ-8)', () => {
    const found = discoverClaudeBinary({
      configuredPath: 'C:/eski/surum/claude.exe',
      platform: 'win32',
      env: { PATH: 'C:/bin' },
      fs: fakeFs(['C:/bin/claude.exe'])
    })
    expect(norm(found)).toBe('C:/bin/claude.exe')
  })

  it('PATH icindeki dizinleri sirayla tarar (posix)', () => {
    const found = discoverClaudeBinary({
      platform: 'linux',
      env: { PATH: '/opt/bin:/home/u/.local/bin' },
      home: '/home/u',
      fs: fakeFs(['/home/u/.local/bin/claude'])
    })
    expect(found).toBe('/home/u/.local/bin/claude')
  })

  it('PATH bosken bilinen posix kurulum yollarina duser', () => {
    const found = discoverClaudeBinary({
      platform: 'darwin',
      env: {},
      home: '/Users/u',
      fs: fakeFs(['/usr/local/bin/claude'])
    })
    expect(found).toBe('/usr/local/bin/claude')
  })

  it('npm global prefix altindaki bin yolunu dener', () => {
    const found = discoverClaudeBinary({
      platform: 'linux',
      env: { npm_config_prefix: '/opt/npm-global' },
      home: '/home/u',
      fs: fakeFs(['/opt/npm-global/bin/claude'])
    })
    expect(norm(found)).toBe('/opt/npm-global/bin/claude')
  })

  it('Windows surum klasorlerinden EN YENISINI secer (sozluksel degil sayisal)', () => {
    const root = 'C:/Users/u/AppData/Roaming/Claude/claude-code'
    const found = discoverClaudeBinary({
      platform: 'win32',
      env: { APPDATA: 'C:/Users/u/AppData/Roaming', PATH: '' },
      fs: fakeFs(
        [`${root}/2.1.9/claude.exe`, `${root}/2.1.10/claude.exe`, `${root}/2.1.258/claude.exe`],
        { [root]: ['2.1.9', '2.1.258', '2.1.10'] }
      )
    })
    expect(norm(found)).toBe(`${root}/2.1.258/claude.exe`)
  })

  it('LOCALAPPDATA varyantini da dener', () => {
    const root = 'C:/Users/u/AppData/Local/Claude/claude-code'
    const found = discoverClaudeBinary({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:/Users/u/AppData/Local', PATH: '' },
      fs: fakeFs([`${root}/2.0.1/claude.exe`], { [root]: ['2.0.1'] })
    })
    expect(norm(found)).toBe(`${root}/2.0.1/claude.exe`)
  })

  it('gercek exe varken PATH icindeki .cmd shim tercih EDILMEZ', () => {
    // Node shell:false ile .cmd calistiramaz (EINVAL), o yuzden exe oncelikli.
    const root = 'C:/Users/u/AppData/Roaming/Claude/claude-code'
    const found = discoverClaudeBinary({
      platform: 'win32',
      env: { APPDATA: 'C:/Users/u/AppData/Roaming', PATH: 'C:/Users/u/AppData/Roaming/npm' },
      fs: fakeFs(
        ['C:/Users/u/AppData/Roaming/npm/claude.cmd', `${root}/2.1.260/claude.exe`],
        { [root]: ['2.1.260'] }
      )
    })
    expect(norm(found)).toBe(`${root}/2.1.260/claude.exe`)
  })

  it('baska hicbir aday yoksa .cmd shim son care olarak doner', () => {
    const found = discoverClaudeBinary({
      platform: 'win32',
      env: { PATH: 'C:/npm' },
      fs: fakeFs(['C:/npm/claude.cmd'])
    })
    expect(norm(found)).toBe('C:/npm/claude.cmd')
  })

  it('hicbir aday bulunamazsa CliError(not-found) atar', () => {
    expect(() =>
      discoverClaudeBinary({
        platform: 'linux',
        env: { PATH: '/opt/bin' },
        home: '/home/u',
        fs: fakeFs([])
      })
    ).toThrowError(
      expect.objectContaining({ name: 'CliError', kind: 'not-found' }) as unknown as Error
    )
  })
})

describe('sortVersionDirsDesc', () => {
  it('surumleri sayisal olarak yeniden eskiye siralar', () => {
    expect(sortVersionDirsDesc(['2.1.9', '2.1.258', '10.0.0', '2.1.10'])).toEqual([
      '10.0.0',
      '2.1.258',
      '2.1.10',
      '2.1.9'
    ])
  })

  it('rakam icermeyen girdileri eler', () => {
    expect(sortVersionDirsDesc(['current', 'backup', '1.2.3'])).toEqual(['1.2.3'])
  })
})

// ── runUsage ─────────────────────────────────────────────────────────────────

describe('runUsage', () => {
  it('basarili yolda UsageCliResult dondurur', async () => {
    const { fn } = fakeExec({ stdout: USAGE_JSON })
    const result = await runUsage('C:/bin/claude.exe', { execFile: fn })

    expect(result.result).toContain('Current session: 83% used')
    expect(result.duration_ms).toBe(312)
    // CONSTRAINT-5: kota olcumu kota harcamaz.
    expect(result.total_cost_usd).toBe(0)
    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it('KABUK KULLANMAZ: shell false, argumanlar dizi olarak gecer (CONSTRAINT-1)', async () => {
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage('C:/bin/claude.exe', { execFile: fn })

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call).toBeDefined()
    if (!call) return
    expect(call.file).toBe('C:/bin/claude.exe')
    // "/usage" oldugu gibi gecmeli — kabuk yol donusumu yapamamali.
    expect(call.args).toEqual(['-p', '/usage', '--output-format', 'json'])
    expect(call.args).toEqual(USAGE_ARGS)
    expect(call.options.shell).toBe(false)
    expect(call.options.windowsHide).toBe(true)
  })

  it('varsayilan zaman asimi 30 sn, override edilebilir', async () => {
    const varsayilan = fakeExec({ stdout: USAGE_JSON })
    await runUsage('claude', { execFile: varsayilan.fn })
    expect(varsayilan.calls[0]?.options.timeout).toBe(30_000)

    const ozel = fakeExec({ stdout: USAGE_JSON })
    await runUsage('claude', { execFile: ozel.fn, timeoutMs: 1500 })
    expect(ozel.calls[0]?.options.timeout).toBe(1500)
  })

  it('zaman asiminda CliError(timeout) atar', async () => {
    const { fn } = fakeExec({ error: { killed: true, signal: 'SIGTERM' }, stdout: '' })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('timeout')
  })

  it('ENOENT durumunda CliError(not-found) atar', async () => {
    const { fn } = fakeExec({ error: { code: 'ENOENT', message: 'spawn ENOENT' } })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('not-found')
  })

  it('401 iceren ciktida CliError(not-logged-in) atar', async () => {
    const { fn } = fakeExec({
      stderr: 'API Error: 401 Unauthorized',
      error: { code: 1 }
    })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('not-logged-in')
    expect(error.rawOutput).toContain('401')
  })

  it('"expired" / "authenticate" iceren ciktida da not-logged-in atar', async () => {
    const expired = fakeExec({ stdout: 'OAuth token expired, please run /login' })
    expect((await catchCliError(runUsage('claude', { execFile: expired.fn }))).kind).toBe(
      'not-logged-in'
    )

    const authenticate = fakeExec({ stderr: 'You must authenticate before using Claude Code' })
    expect((await catchCliError(runUsage('claude', { execFile: authenticate.fn }))).kind).toBe(
      'not-logged-in'
    )
  })

  it('JSON cozulemezse CliError(bad-output) atar ve ham ciktiyi tasir', async () => {
    const { fn } = fakeExec({ stdout: 'bu JSON degil' })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('bad-output')
    expect(error.rawOutput).toContain('bu JSON degil')
  })

  it('JSON gecerli ama `result` alani yoksa bad-output atar (sessiz bozulma yok)', async () => {
    const { fn } = fakeExec({ stdout: JSON.stringify({ type: 'result', duration_ms: 10 }) })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('bad-output')
  })

  it('siniflandirilamayan hatada CliError(unknown) atar', async () => {
    const { fn } = fakeExec({ error: { code: 3, message: 'beklenmedik cokme' }, stderr: 'panic' })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('unknown')
    expect(error.rawOutput).toContain('panic')
  })

  it.each(['EACCES', 'EPERM'])(
    '%s durumunda da CliError(not-found) atar (erisilemeyen aday = bulunamadi)',
    async (code) => {
      const { fn } = fakeExec({ error: { code, message: `spawn ${code}` } })
      const error = await catchCliError(runUsage('claude', { execFile: fn }))
      expect(error.kind).toBe('not-found')
    }
  )

  it('cok uzun ham ciktiyi GORUNUR bicimde kirpar, sessizce yutmaz', async () => {
    const uzunMetin = 'x'.repeat(5000)
    const { fn } = fakeExec({ stdout: uzunMetin })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('bad-output')
    expect(error.rawOutput?.length).toBeLessThan(5000)
    expect(error.rawOutput).toContain('kirpildi')
    expect(error.rawOutput).toContain('toplam 5000 karakter')
  })
})

// ── runAuthStatus ────────────────────────────────────────────────────────────

describe('runAuthStatus', () => {
  it('auth status --json ciktisini AuthStatus olarak dondurur', async () => {
    const { fn, calls } = fakeExec({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: 'oauth',
        email: 'kullanici@ornek.com',
        orgId: 'org_1',
        orgName: 'Ornek Org',
        subscriptionType: 'max'
      })
    })
    const status = await runAuthStatus('claude', { execFile: fn })

    expect(status).toEqual({
      loggedIn: true,
      email: 'kullanici@ornek.com',
      orgName: 'Ornek Org',
      subscriptionType: 'max'
    })
    expect(calls[0]?.args).toEqual(AUTH_STATUS_ARGS)
    expect(calls[0]?.options.shell).toBe(false)
  })

  it('eksik alanlari null yapar, uydurmaz', async () => {
    const { fn } = fakeExec({ stdout: JSON.stringify({ loggedIn: false }) })
    const status = await runAuthStatus('claude', { execFile: fn })
    expect(status).toEqual({
      loggedIn: false,
      email: null,
      orgName: null,
      subscriptionType: null
    })
  })

  it('cikis kodu sifir olmasa bile gecerli JSON varsa onu kullanir', async () => {
    const { fn } = fakeExec({
      stdout: JSON.stringify({ loggedIn: false }),
      error: { code: 1, message: 'exit 1' }
    })
    const status = await runAuthStatus('claude', { execFile: fn })
    expect(status.loggedIn).toBe(false)
  })

  it('zaman asiminda CliError(timeout) atar', async () => {
    const { fn } = fakeExec({ error: { killed: true, signal: 'SIGTERM' } })
    expect((await catchCliError(runAuthStatus('claude', { execFile: fn }))).kind).toBe('timeout')
  })

  it('calistirilabilir yoksa CliError(not-found) atar', async () => {
    const { fn } = fakeExec({ error: { code: 'ENOENT', message: 'spawn ENOENT' } })
    expect((await catchCliError(runAuthStatus('claude', { execFile: fn }))).kind).toBe('not-found')
  })

  it('cozulemeyen ciktida CliError(bad-output) atar', async () => {
    const { fn } = fakeExec({ stdout: '<html>proxy hatasi</html>' })
    const error = await catchCliError(runAuthStatus('claude', { execFile: fn }))
    expect(error.kind).toBe('bad-output')
    expect(error.rawOutput).toContain('proxy hatasi')
  })
})

// ── Ayristiricilar ───────────────────────────────────────────────────────────

describe('parseUsageJson', () => {
  it('`result` yoksa veya sema tutmuyorsa null doner', () => {
    expect(parseUsageJson(JSON.stringify({ result: 42 }))).toBeNull()
    expect(parseUsageJson('[]')).toBeNull()
    expect(parseUsageJson('')).toBeNull()
  })

  // B8: eksik alan icin 0/{} doldurmak "olculdu" ile "yoktu"yu ayirt edilemez
  // yapiyordu; deger geriye donuk uyumlu kalir ama varlik ayrica bildirilir.
  it('eksik `usage`/`total_cost_usd` alanlarini UYDURMAZ, yoklugunu bildirir', () => {
    const parsed = parseUsageJson(JSON.stringify({ result: 'metin' }))
    expect(parsed).toEqual({
      result: 'metin',
      duration_ms: 0,
      total_cost_usd: 0,
      usage: {},
      usageFieldPresent: false,
      costFieldPresent: false
    })
  })

  it('alanlar gercekten geldiyse varlik bayraklari true olur', () => {
    const parsed = parseUsageJson(
      JSON.stringify({ result: 'm', total_cost_usd: 0, usage: { input_tokens: 0 } })
    )
    expect(parsed?.usageFieldPresent).toBe(true)
    expect(parsed?.costFieldPresent).toBe(true)
  })

  it('`usage` nesne degilse (dizi/null) alan yok sayilir', () => {
    expect(parseUsageJson(JSON.stringify({ result: 'm', usage: [1, 2] }))?.usageFieldPresent).toBe(
      false
    )
    expect(parseUsageJson(JSON.stringify({ result: 'm', usage: null }))?.usageFieldPresent).toBe(
      false
    )
  })
})

// ── CONSTRAINT-5: sifir-token kaniti ─────────────────────────────────────────

describe('isZeroTokenUsage', () => {
  function output(patch: Partial<UsageCliOutput>): UsageCliOutput {
    return {
      result: 'm',
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
      usageFieldPresent: false,
      costFieldPresent: false,
      ...patch
    }
  }

  it('tum token alanlari 0 ise kanit sayar', () => {
    expect(
      isZeroTokenUsage(
        output({ usage: { input_tokens: 0, output_tokens: 0 }, usageFieldPresent: true })
      )
    ).toBe(true)
  })

  it('herhangi bir token alani sifir degilse kanit vermez (regresyon yakalanir)', () => {
    expect(
      isZeroTokenUsage(
        output({ usage: { input_tokens: 0, output_tokens: 12 }, usageFieldPresent: true })
      )
    ).toBe(false)
  })

  // Asil kusur: `usage: {}` fallback'i ile "hepsi 0" kosulu BOS-DOGRU oluyordu.
  it('`usage` alani hic yoksa kanit YOKTUR — bos nesne "hepsi 0" sayilmaz', () => {
    expect(isZeroTokenUsage(output({ usage: {}, usageFieldPresent: false }))).toBe(false)
  })

  it('alan var ama icinde hic sayi yoksa yine kanit yoktur', () => {
    expect(
      isZeroTokenUsage(output({ usage: { service_tier: 'standard' }, usageFieldPresent: true }))
    ).toBe(false)
  })

  it('sayi olmayan alanlar kaniti bozmaz', () => {
    expect(
      isZeroTokenUsage(
        output({
          usage: { input_tokens: 0, output_tokens: 0, service_tier: 'standard' },
          usageFieldPresent: true
        })
      )
    ).toBe(true)
  })
})

// ── B7: Windows .cmd/.bat shim ───────────────────────────────────────────────

describe('isWindowsShim', () => {
  it('.cmd ve .bat uzantilarini tanir, .exe ve uzantisizi tanimaz', () => {
    expect(isWindowsShim('C:/npm/claude.cmd')).toBe(true)
    expect(isWindowsShim('C:/npm/claude.BAT')).toBe(true)
    expect(isWindowsShim('C:/npm/claude.exe')).toBe(false)
    expect(isWindowsShim('/usr/local/bin/claude')).toBe(false)
  })
})

describe('runUsage — .cmd shim (B7)', () => {
  const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'

  it('shim dogrudan spawn EDILMEZ, cmd.exe uzerinden calisir', async () => {
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage(SHIM, { execFile: fn, platform: 'win32' })

    const call = calls[0]
    expect(call?.file).toBe('cmd.exe')
    expect(call?.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    // Kabuk hala kapali: POSIX kabugu devrede degil, "/usage" yola cevrilmez.
    expect(call?.options.shell).toBe(false)
    expect(call?.options.windowsVerbatimArguments).toBe(true)
  })

  it('her jetonu tirnaklar; "/usage" argumani bozulmadan gecer (CONSTRAINT-1)', async () => {
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage(SHIM, { execFile: fn, platform: 'win32' })

    const line = commandLine(calls[0])
    expect(line).toBe(`""${SHIM}" "-p" "/usage" "--output-format" "json""`)
  })

  it('yolda & varsa jeton tirnak icinde kalir (cmd komutu bolmez)', async () => {
    const tricky = 'C:\\Tools&Utils\\claude.cmd'
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage(tricky, { execFile: fn, platform: 'win32' })

    expect(commandLine(calls[0])).toContain(`"${tricky}"`)
  })

  it('Windows disinda .cmd sarmalanmaz (posix yolunda cmd.exe yok)', async () => {
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage('/opt/bin/claude.cmd', { execFile: fn, platform: 'linux' })

    expect(calls[0]?.file).toBe('/opt/bin/claude.cmd')
    expect(calls[0]?.args).toEqual(USAGE_ARGS)
    expect(calls[0]?.options.windowsVerbatimArguments).toBeUndefined()
  })

  it('.exe hedefi eskisi gibi dogrudan calisir', async () => {
    const { fn, calls } = fakeExec({ stdout: USAGE_JSON })
    await runUsage('C:/bin/claude.exe', { execFile: fn, platform: 'win32' })

    expect(calls[0]?.file).toBe('C:/bin/claude.exe')
    expect(calls[0]?.args).toEqual(USAGE_ARGS)
  })

  it('runAuthStatus de ayni sarmalayiciyi kullanir', async () => {
    const { fn, calls } = fakeExec({ stdout: JSON.stringify({ loggedIn: true }) })
    await runAuthStatus(SHIM, { execFile: fn, platform: 'win32' })

    expect(calls[0]?.file).toBe('cmd.exe')
    expect(commandLine(calls[0])).toBe(`""${SHIM}" "auth" "status" "--json""`)
  })
})

describe('spawn hatalarinin siniflandirilmasi (B7)', () => {
  it('SENKRON firlayan spawn hatasi da CliError olur, ciplak Error sizmaz', async () => {
    const { fn } = fakeExec({ throwSync: { code: 'EINVAL', message: 'spawn EINVAL' } })
    const error = await catchCliError(runUsage('C:/npm/claude.cmd', { execFile: fn }))
    expect(error.name).toBe('CliError')
  })

  it('EINVAL artik not-found DEGIL — CLI var, calistirma bicimi yanlis', async () => {
    const { fn } = fakeExec({ error: { code: 'EINVAL', message: 'spawn EINVAL' } })
    const error = await catchCliError(runUsage('C:/npm/claude.cmd', { execFile: fn }))
    expect(error.kind).not.toBe('not-found')
    expect(error.kind).toBe('unknown')
    expect(error.message).toContain('EINVAL')
  })

  it('senkron ENOENT yine not-found kalir', async () => {
    const { fn } = fakeExec({ throwSync: { code: 'ENOENT', message: 'spawn ENOENT' } })
    const error = await catchCliError(runUsage('claude', { execFile: fn }))
    expect(error.kind).toBe('not-found')
  })
})

describe('parseAuthStatusJson', () => {
  it('loggedIn boolean degilse null doner', () => {
    expect(parseAuthStatusJson(JSON.stringify({ loggedIn: 'evet' }))).toBeNull()
    expect(parseAuthStatusJson('null')).toBeNull()
  })

  it('bos e-postayi null yapar', () => {
    expect(parseAuthStatusJson(JSON.stringify({ loggedIn: true, email: '' }))?.email).toBeNull()
  })
})
