import { describe, expect, it, vi } from 'vitest'

import {
  createKeychainTokenReader,
  DEFAULT_KEYCHAIN_SERVICE,
  derivedServiceName,
  parseServiceNames,
  tokenFromSecret
} from './keychain'

const NOW = Date.UTC(2026, 10, 6, 12, 0)
const secret = (token: string, expiresAt = NOW + 3_600_000): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt } })

describe('tokenFromSecret', () => {
  it('gecerli jetonu dondurur, suresi dolmusu dondurmez', () => {
    expect(tokenFromSecret(secret('abc'), NOW)).toBe('abc')
    expect(tokenFromSecret(secret('abc', NOW - 1), NOW)).toBeNull()
    expect(tokenFromSecret('bozuk', NOW)).toBeNull()
  })
})

describe('parseServiceNames', () => {
  it('yalniz Claude Code kayit adlarini, tekrarsiz alir', () => {
    const dump = [
      '    "svce"<blob>="Claude Code-credentials"',
      '    "svce"<blob>="Claude Code-credentials-1a2b3c4d"',
      '    "svce"<blob>="Claude Code-credentials"',
      '    "svce"<blob>="Baska Uygulama"'
    ].join('\n')
    expect(parseServiceNames(dump)).toEqual(['Claude Code-credentials', 'Claude Code-credentials-1a2b3c4d'])
  })
})

describe('createKeychainTokenReader', () => {
  it('varsayilan klasorde dogrudan varsayilan kaydi, kabuksuz okur', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      expect(args).toEqual(['find-generic-password', '-s', DEFAULT_KEYCHAIN_SERVICE, '-w'])
      return secret('kisisel') + '\n'
    })
    expect(await createKeychainTokenReader(null, { run, now: () => NOW })()).toBe('kisisel')
  })

  it('Team: turetilmis ad varsa onu kullanir', async () => {
    const dir = '/Users/ada/.claude-team'
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[2] === derivedServiceName(dir)) return secret('team')
      throw new Error('bulunamadi')
    })
    expect(await createKeychainTokenReader(dir, { run, now: () => NOW })()).toBe('team')
  })

  it('Team: ad tutmazsa varsayilan disindaki tek kayda duser', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'dump-keychain') {
        return '"svce"<blob>="Claude Code-credentials"\n"svce"<blob>="Claude Code-credentials-ffff0000"'
      }
      if (args[2] === 'Claude Code-credentials-ffff0000') return secret('team2')
      throw new Error('bulunamadi')
    })
    expect(await createKeychainTokenReader('/Users/ada/.claude-team', { run, now: () => NOW })()).toBe('team2')
  })

  it('Team: birden cok aday varsa secmez (yanlis hesabin kotasi gosterilmez)', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      if (args[0] === 'dump-keychain') {
        return '"svce"<blob>="Claude Code-credentials-aaaa"\n"svce"<blob>="Claude Code-credentials-bbbb"'
      }
      throw new Error('bulunamadi')
    })
    expect(await createKeychainTokenReader('/Users/ada/.claude-team', { run, now: () => NOW })()).toBeNull()
  })
})
