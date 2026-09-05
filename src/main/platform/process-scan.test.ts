import { describe, expect, it } from 'vitest'

import type { ProcessScanResult } from '../../shared/types'
import type { ProcessCommand } from './process-scan'
import {
  UNIX_SCAN_COMMANDS,
  WINDOWS_SCAN_COMMANDS,
  isClaudeCodeSession,
  maskSensitive,
  parseUnixProcessList,
  parseUnixStartTime,
  parseWindowsProcessList,
  parseWindowsStartTime,
  scanClaudeSessions
} from './process-scan'

/** Sonucu daraltir; `supported:false` gelirse test nedeniyle birlikte patlar. */
function expectSupported(result: ProcessScanResult): { supported: true; sessions: unknown[] } {
  if (!result.supported) {
    throw new Error(`beklenmedik supported:false — ${result.reason}`)
  }
  return result
}

// Asagidaki iki fixture bu makinede olculen gercek ciktidan alinmistir
// (2026-09-05): Claude Desktop surecleri de `claude.exe` adini tasir ve ana
// sureci `--type=` bayragi tasimaz.

const DESKTOP_EXE =
  'C:\\Program Files\\WindowsApps\\Claude_1.46388.4.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'
const CLI_EXE = 'C:\\Users\\sezer\\AppData\\Roaming\\Claude\\claude-code\\2.1.260\\claude.exe'
const CLI_FLAGS = '--output-format stream-json --verbose --input-format stream-json --model claude-opus-5'

const WINDOWS_OUTPUT = JSON.stringify([
  { pid: 53748, start: '2026-09-05T08:27:59.9323330Z', cmd: `"${DESKTOP_EXE}" ` },
  {
    pid: 35132,
    start: '2026-09-05T08:28:00.2250870Z',
    cmd: `"${DESKTOP_EXE}" --type=crashpad-handler --user-data-dir=C:\\Users\\sezer\\AppData\\Roaming\\Claude`
  },
  {
    pid: 23492,
    start: '2026-09-05T08:28:00.5864050Z',
    cmd: `"${DESKTOP_EXE}" --type=renderer --user-data-dir=C:\\Users\\sezer\\AppData\\Roaming\\Claude`
  },
  { pid: 30564, start: '2026-09-05T08:53:20.0437580Z', cmd: `${CLI_EXE} ${CLI_FLAGS}` },
  { pid: 43260, start: '2026-09-05T10:19:01.5702840Z', cmd: `${CLI_EXE} ${CLI_FLAGS}` },
  {
    pid: 37652,
    start: '2026-09-05T09:58:53.4178900Z',
    cmd: 'C:\\nvm4w\\nodejs\\node.exe C:/Users/sezer/AppData/Local/Temp/claude/F--dev-apps/57df5a20/probe.mjs'
  },
  {
    pid: 18264,
    start: '2026-09-05T14:20:35.4538630Z',
    cmd: 'C:\\nvm4w\\nodejs\\node.exe C:\\Users\\sezer\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --output-format stream-json'
  }
])

const UNIX_OUTPUT = [
  '    PID                          STARTED COMMAND',
  '      1 Thu Sep  4 09:12:01 2026 /sbin/launchd',
  '  40211 Fri Sep  5 11:02:33 2026 /Users/sezer/.local/bin/claude',
  '  40777 Fri Sep  5 12:41:09 2026 node /Users/sezer/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js --output-format stream-json',
  '   2044 Fri Sep  5 08:15:00 2026 /Applications/Claude.app/Contents/MacOS/Claude',
  '   2051 Fri Sep  5 08:15:02 2026 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
  '   9931 Fri Sep  5 10:00:00 2026 /usr/bin/vim /home/sezer/claude-notes.md',
  ''
].join('\n')

describe('isClaudeCodeSession', () => {
  it('CLI oturumlarini tanir', () => {
    expect(isClaudeCodeSession(`${CLI_EXE} ${CLI_FLAGS}`)).toBe(true)
    expect(isClaudeCodeSession('/Users/sezer/.local/bin/claude')).toBe(true)
    expect(isClaudeCodeSession('/usr/local/bin/claude --resume')).toBe(true)
    expect(isClaudeCodeSession('"C:\\Program Files\\Claude Code\\claude.exe" --print')).toBe(true)
    expect(
      isClaudeCodeSession('node /opt/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js')
    ).toBe(true)
  })

  it('Claude Desktop sureclerini eler', () => {
    // Ana surec `--type=` tasimaz; yalniz bayrak elemesi yetmez.
    expect(isClaudeCodeSession(`"${DESKTOP_EXE}" `)).toBe(false)
    expect(isClaudeCodeSession(`"${DESKTOP_EXE}" --type=renderer --user-data-dir=X`)).toBe(false)
    expect(isClaudeCodeSession(`"${DESKTOP_EXE}" --type=crashpad-handler`)).toBe(false)
    expect(isClaudeCodeSession('/Applications/Claude.app/Contents/MacOS/Claude')).toBe(false)
    expect(
      isClaudeCodeSession(
        '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer'
      )
    ).toBe(false)
    expect(
      isClaudeCodeSession('C:\\Users\\sezer\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\claude.exe')
    ).toBe(false)
  })

  it('yolunda tesadufen "claude" gecen alakasiz surecleri eler', () => {
    expect(
      isClaudeCodeSession(
        'C:\\nvm4w\\nodejs\\node.exe C:/Users/sezer/AppData/Local/Temp/claude/F--dev-apps/57df5a20/probe.mjs'
      )
    ).toBe(false)
    expect(isClaudeCodeSession('/usr/bin/vim /home/sezer/claude-notes.md')).toBe(false)
    expect(isClaudeCodeSession('')).toBe(false)
    expect(isClaudeCodeSession('   ')).toBe(false)
  })
})

describe('parseWindowsProcessList', () => {
  it('gercek cikti uzerinde yalniz CLI oturumlarini dondurur', () => {
    const result = parseWindowsProcessList(WINDOWS_OUTPUT)
    expect(result).toEqual({
      supported: true,
      sessions: [
        { pid: 30564, startedAtMs: Date.UTC(2026, 8, 5, 8, 53, 20, 43), cwd: null },
        { pid: 43260, startedAtMs: Date.UTC(2026, 8, 5, 10, 19, 1, 570), cwd: null },
        { pid: 18264, startedAtMs: Date.UTC(2026, 8, 5, 14, 20, 35, 453), cwd: null }
      ]
    })
  })

  it('bos sonucu "0 oturum" olarak dondurur (tarama calisti)', () => {
    expect(parseWindowsProcessList('[]')).toEqual({ supported: true, sessions: [] })
  })

  it('tek satirlik sonucta dizi yerine nesne gelmesini kaldirir', () => {
    const result = expectSupported(
      parseWindowsProcessList(
        JSON.stringify({ pid: 30564, start: '2026-09-05T08:53:20.043Z', cmd: `${CLI_EXE} ${CLI_FLAGS}` })
      )
    )
    expect(result.sessions).toHaveLength(1)
  })

  it('PascalCase alan adlarini ve /Date(ms)/ bicimini kabul eder', () => {
    const result = expectSupported(
      parseWindowsProcessList(
        JSON.stringify([
          {
            ProcessId: '30564',
            CreationDate: '/Date(1788598400043)/',
            CommandLine: `${CLI_EXE} ${CLI_FLAGS}`
          }
        ])
      )
    )
    expect(result.sessions).toEqual([{ pid: 30564, startedAtMs: 1788598400043, cwd: null }])
  })

  it('bos ciktida supported:false doner', () => {
    expect(parseWindowsProcessList('')).toEqual({
      supported: false,
      reason: 'PowerShell surec sorgusu bos cikti dondurdu'
    })
    expect(parseWindowsProcessList('   \n  ').supported).toBe(false)
  })

  it('bozuk ciktida supported:false doner', () => {
    expect(parseWindowsProcessList('Get-CimInstance : Erisim reddedildi.').supported).toBe(false)
    expect(parseWindowsProcessList('null').supported).toBe(false)
    expect(parseWindowsProcessList('[{"foo":1},{"bar":2}]').supported).toBe(false)
  })

  it('zamani cozulemeyen oturumu yine listeler, zaman uydurmaz', () => {
    const result = expectSupported(
      parseWindowsProcessList(
        JSON.stringify([{ pid: 30564, start: null, cmd: `${CLI_EXE} ${CLI_FLAGS}` }])
      )
    )
    expect(result.sessions).toEqual([{ pid: 30564, startedAtMs: null, cwd: null }])
  })
})

describe('parseWindowsStartTime', () => {
  it('ISO, /Date(ms)/ ve CIM_DATETIME bicimlerini cozer', () => {
    expect(parseWindowsStartTime('2026-09-05T08:27:59.932Z')).toBe(Date.UTC(2026, 8, 5, 8, 27, 59, 932))
    expect(parseWindowsStartTime('/Date(1788596879932)/')).toBe(1788596879932)
    expect(parseWindowsStartTime('20260905112759.932000+180')).toBe(
      Date.UTC(2026, 8, 5, 8, 27, 59, 932)
    )
  })

  it('Get-Date sarmalayicisini ve gecersiz degerleri kaldirir', () => {
    expect(parseWindowsStartTime({ value: '/Date(1788596879932)/', DisplayHint: 2 })).toBe(
      1788596879932
    )
    expect(parseWindowsStartTime(null)).toBeNull()
    expect(parseWindowsStartTime('')).toBeNull()
    expect(parseWindowsStartTime('dun aksam')).toBeNull()
  })
})

describe('parseUnixProcessList', () => {
  it('gercek cikti uzerinde yalniz CLI oturumlarini dondurur', () => {
    const result = parseUnixProcessList(UNIX_OUTPUT)
    expect(result).toEqual({
      supported: true,
      sessions: [
        { pid: 40211, startedAtMs: new Date(2026, 8, 5, 11, 2, 33).getTime(), cwd: null },
        { pid: 40777, startedAtMs: new Date(2026, 8, 5, 12, 41, 9).getTime(), cwd: null }
      ]
    })
  })

  it('Claude Desktop ve alakasiz surecler listeye girmez', () => {
    const result = expectSupported(parseUnixProcessList(UNIX_OUTPUT))
    const pids = result.sessions.map((session) => (session as { pid: number }).pid)
    expect(pids).not.toContain(2044)
    expect(pids).not.toContain(2051)
    expect(pids).not.toContain(9931)
  })

  it('claude sureci yokken 0 oturum dondurur (tarama calisti)', () => {
    const raw = ['    PID                          STARTED COMMAND', '      1 Thu Sep  4 09:12:01 2026 /sbin/launchd'].join(
      '\n'
    )
    expect(parseUnixProcessList(raw)).toEqual({ supported: true, sessions: [] })
  })

  it('bos ciktida supported:false doner', () => {
    expect(parseUnixProcessList('')).toEqual({ supported: false, reason: '`ps` bos cikti dondurdu' })
    expect(parseUnixProcessList('\n\n  \n').supported).toBe(false)
  })

  it('beklenen bicime uymayan ciktida supported:false doner', () => {
    // lstart sutunu olmayan `ps` (orn. busybox) — bos liste degil, tespit edilemedi.
    const noLstart = ['  PID COMMAND', '40211 /Users/sezer/.local/bin/claude'].join('\n')
    expect(parseUnixProcessList(noLstart).supported).toBe(false)
    expect(parseUnixProcessList('ps: illegal option -- w').supported).toBe(false)
    expect(parseUnixProcessList('    PID                          STARTED COMMAND').supported).toBe(
      false
    )
  })
})

describe('parseUnixStartTime', () => {
  it('lstart bicimini yerel saatle epoch ms yapar', () => {
    expect(parseUnixStartTime('Fri Sep  5 14:47:59 2026')).toBe(
      new Date(2026, 8, 5, 14, 47, 59).getTime()
    )
    expect(parseUnixStartTime('Thu Dec 31 23:59:01 2026')).toBe(
      new Date(2026, 11, 31, 23, 59, 1).getTime()
    )
  })

  it('cozulemeyen degerde null doner', () => {
    expect(parseUnixStartTime('Fri Xyz  5 14:47:59 2026')).toBeNull()
    expect(parseUnixStartTime('14:47')).toBeNull()
    expect(parseUnixStartTime('')).toBeNull()
  })
})

describe('scanClaudeSessions', () => {
  it('Windows: PowerShell komutunu kabuksuz, arguman dizisiyle calistirir', async () => {
    const calls: ProcessCommand[] = []
    const result = await scanClaudeSessions({
      platform: 'win32',
      run: async (command) => {
        calls.push(command)
        return WINDOWS_OUTPUT
      }
    })

    expect(expectSupported(result).sessions).toHaveLength(3)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.file).toBe('powershell.exe')
    expect(calls[0]?.args).toBeInstanceOf(Array)
    expect(calls[0]?.args).toContain('-NoProfile')
    expect(calls[0]?.args.at(-1)).toContain('Win32_Process')
  })

  it('Windows sorgusu deno.exe surecini de sorgu filtresine dahil eder', () => {
    // JS_HOSTS deno'yu Claude Code host'u sayiyor; PowerShell filtresi
    // deno.exe'yi disarida birakirsa gercek bir deno-tabanli oturum hic
    // sorguya girmez ve sessizce kaybolur.
    const script = WINDOWS_SCAN_COMMANDS[0]?.args.at(-1) ?? ''
    expect(script).toContain("Name='deno.exe'")
  })

  it('Unix: ps ciktisini ayristirir', async () => {
    const result = await scanClaudeSessions({
      platform: 'darwin',
      run: async () => UNIX_OUTPUT
    })
    expect(expectSupported(result).sessions).toHaveLength(2)
  })

  it('ilk komut bicimi tutmazsa yedek komuta duser', async () => {
    const tried: string[] = []
    const result = await scanClaudeSessions({
      platform: 'linux',
      run: async (command) => {
        tried.push(command.args.join(' '))
        if (command.args.includes('-w')) throw new Error('ps: illegal option -- w')
        return UNIX_OUTPUT
      }
    })

    expect(tried).toHaveLength(2)
    expect(expectSupported(result).sessions).toHaveLength(2)
    expect(UNIX_SCAN_COMMANDS).toHaveLength(2)
  })

  it('komut calistirilamazsa supported:false doner, sifir demez', async () => {
    const result = await scanClaudeSessions({
      platform: 'linux',
      run: async () => {
        const error: Error & { code?: string } = new Error('spawn ps ENOENT')
        error.code = 'ENOENT'
        throw error
      }
    })

    expect(result.supported).toBe(false)
    if (!result.supported) {
      expect(result.reason).toContain('ps')
      expect(result.reason).toContain('ENOENT')
    }
  })

  it('hata nedeni komutun stderr satiridir, komut satirinin tamami degil', async () => {
    const result = await scanClaudeSessions({
      platform: 'linux',
      run: async () => {
        const error: Error & { stderr?: string } = new Error(
          'Command failed: ps -eo pid,lstart,command\nps: unknown option -- o\n'
        )
        error.stderr = 'ps: unknown option -- o\nTry `ps --help\' for more information.\n'
        throw error
      }
    })

    expect(result.supported).toBe(false)
    if (!result.supported) {
      expect(result.reason).toBe('`ps` calistirilamadi: ps: unknown option -- o')
      expect(result.reason).not.toContain('\n')
    }
  })

  it('zaman asiminda neden acikca yazilir', async () => {
    const result = await scanClaudeSessions({
      platform: 'win32',
      run: async () => {
        const error: Error & { killed?: boolean } = new Error('Command failed')
        error.killed = true
        throw error
      }
    })

    expect(result.supported).toBe(false)
    if (!result.supported) expect(result.reason).toContain('zaman asimi')
  })

  it('hata metnindeki dosya yolu maskelenir', async () => {
    const result = await scanClaudeSessions({
      platform: 'win32',
      run: async () => {
        throw new Error('Command failed: C:\\Users\\sezer\\AppData\\Roaming\\claude.ps1')
      }
    })

    expect(result.supported).toBe(false)
    if (!result.supported) {
      expect(result.reason).not.toContain('sezer')
      expect(result.reason).toContain('<yol>')
    }
  })

  it('desteklenmeyen platformda supported:false doner', async () => {
    const result = await scanClaudeSessions({
      platform: 'aix',
      run: async () => {
        throw new Error('calistirilmamaliydi')
      }
    })

    expect(result.supported).toBe(false)
    if (!result.supported) expect(result.reason).toContain('aix')
  })
})

describe('maskSensitive', () => {
  it('yol ve e-posta alanlarini maskeler', () => {
    expect(maskSensitive('hata: C:\\Users\\sezer\\.claude\\x.json okunamadi')).toBe(
      'hata: <yol> okunamadi'
    )
    expect(maskSensitive('/home/sezer/.claude bulunamadi')).toBe('<yol> bulunamadi')
    expect(maskSensitive('hesap sezerddedek@gmail.com')).toBe('hesap <e-posta>')
  })
})
