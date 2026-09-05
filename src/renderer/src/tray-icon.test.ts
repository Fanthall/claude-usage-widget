import { describe, expect, it } from 'vitest'

import type { CliErrorKind, UsageSnapshot, UsageStatus } from '@shared/types'
import { badgeColorFor, markFor } from './tray-icon'

/**
 * Yalnizca damga/isaret karari sinanir — cizim `document` ister, test ortami
 * `node`. Karar zaten cizimden bagimsiz tutuldugu icin dogrulanabiliyor.
 */

const STALE = '#e0a33a'
const ERROR = '#e5544f'

function snapshot(): UsageSnapshot {
  return {
    at: 1_700_000_000_000,
    windows: [{ label: 'Current session', percent: 22, resetsAtRaw: '', resetsAtMs: null }],
    unparsedLines: [],
    raw: ''
  }
}

function error(errorKind: CliErrorKind): UsageStatus {
  return { kind: 'error', errorKind, message: '', lastSnapshot: null }
}

describe('badgeColorFor', () => {
  it('saglikli durumda damga yok', () => {
    expect(badgeColorFor({ kind: 'ok', snapshot: snapshot() })).toBeNull()
    expect(badgeColorFor({ kind: 'loading' })).toBeNull()
    expect(badgeColorFor({ kind: 'no-data' })).toBeNull()
  })

  it('hiz siniri kirmizi DEGIL, bayat gibi amber damgalanir', () => {
    expect(badgeColorFor(error('rate-limited'))).toBe(STALE)
    expect(
      badgeColorFor({
        kind: 'stale',
        snapshot: snapshot(),
        ageMs: 13 * 60_000,
        reason: 'poll gecikti'
      })
    ).toBe(STALE)
  })

  it('gercek hata kirmizi kalir', () => {
    expect(badgeColorFor(error('not-found'))).toBe(ERROR)
    expect(badgeColorFor(error('timeout'))).toBe(ERROR)
  })
})

describe('markFor', () => {
  it('hiz sinirinda unlem degil soru isareti — kirilan bir sey yok', () => {
    expect(markFor(error('rate-limited'))).toBe('?')
    expect(markFor(error('not-found'))).toBe('!')
  })

  it('bayatta soru, saglikli durumda nokta', () => {
    expect(
      markFor({ kind: 'stale', snapshot: snapshot(), ageMs: 1, reason: 'poll gecikti' })
    ).toBe('?')
    expect(markFor({ kind: 'loading' })).toBe('·')
  })
})
