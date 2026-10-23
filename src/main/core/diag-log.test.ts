import { describe, expect, it } from 'vitest'

import { createFileSink, halveFromStart, type DiagFs } from './diag-log'
import type { LogRecord } from './log-safe'

const NOW = Date.parse('2026-10-23T12:00:00.000Z')

function fakeFs(initial = ''): DiagFs & { content: () => string; dirs: string[] } {
  let content = initial
  const dirs: string[] = []
  return {
    dirs,
    content: () => content,
    appendFileSync: (_file, data) => {
      content += data
    },
    readFileSync: () => content,
    writeFileSync: (_file, data) => {
      content = data
    },
    sizeOf: () => content.length,
    ensureDir: (dir) => {
      dirs.push(dir)
    }
  }
}

const record = (message: string, meta?: Record<string, unknown>): LogRecord =>
  meta === undefined ? { level: 'warn', message } : { level: 'warn', message, meta }

describe('halveFromStart', () => {
  it('en eski yariyi atar ve SATIR sinirinda keser', () => {
    // Yarim JSON satiri birakmak dosyayi okunamaz yapar.
    const text = ['bir', 'iki', 'uc', 'dort'].join('\n') + '\n'
    const out = halveFromStart(text)
    expect(out.startsWith('{')).toBe(false)
    for (const line of out.split('\n').filter(Boolean)) {
      expect(['bir', 'iki', 'uc', 'dort']).toContain(line)
    }
    expect(out.length).toBeLessThan(text.length)
  })

  it('satir sonu yoksa bos doner — yarim satir tasinmaz', () => {
    expect(halveFromStart('satirsonuyok')).toBe('')
  })
})

describe('createFileSink', () => {
  it('kaydi JSON satiri olarak yazar, zaman damgasi ekler', () => {
    const fs = fakeFs()
    const sink = createFileSink('/tmp/d/diagnostics.log', { fs, now: () => NOW })

    sink(record('olcum basarisiz', { kind: 'unknown', detail: 'fetch failed' }))

    const line = JSON.parse(fs.content().trim())
    expect(line.at).toBe('2026-10-23T12:00:00.000Z')
    expect(line.level).toBe('warn')
    expect(line.message).toBe('olcum basarisiz')
    expect(line.meta).toEqual({ kind: 'unknown', detail: 'fetch failed' })
  })

  it('meta yoksa alan hic yazilmaz', () => {
    const fs = fakeFs()
    createFileSink('/tmp/d/x.log', { fs, now: () => NOW })(record('sade'))
    expect(Object.keys(JSON.parse(fs.content().trim()))).toEqual(['at', 'level', 'message'])
  })

  it('her kayit ayri satirdir', () => {
    const fs = fakeFs()
    const sink = createFileSink('/tmp/d/x.log', { fs, now: () => NOW })
    sink(record('bir'))
    sink(record('iki'))
    expect(fs.content().trim().split('\n')).toHaveLength(2)
  })

  it('klasorun varligini saglar', () => {
    const fs = fakeFs()
    createFileSink('/tmp/d/x.log', { fs, now: () => NOW })(record('bir'))
    expect(fs.dirs).toContain('/tmp/d')
  })

  it('tavan asilinca dosya kuculur ama son kayit korunur', () => {
    const fs = fakeFs('eski\n'.repeat(50))
    const sink = createFileSink('/tmp/d/x.log', { fs, now: () => NOW, maxBytes: 40 })

    sink(record('yeni kayit'))

    expect(fs.content().length).toBeLessThan(50 * 5)
    expect(fs.content()).toContain('yeni kayit')
  })

  it('debug kayitlari YAZILMAZ — asil hatayi gomerler', () => {
    // "fit" gibi olaylar saniyede birkac kez dusuyor; dosyaya girerse
    // 512 KB'lik tavan gurultuyle dolar ve aranan hata kaydi kaybolur.
    const fs = fakeFs()
    const sink = createFileSink('/tmp/d/x.log', { fs, now: () => NOW })

    sink({ level: 'debug', message: 'fit', meta: { istenen: '214x230' } })
    expect(fs.content()).toBe('')

    sink(record('olcum basarisiz'))
    expect(fs.content()).toContain('olcum basarisiz')
  })

  it('minLevel yukseltilebilir', () => {
    const fs = fakeFs()
    const sink = createFileSink('/tmp/d/x.log', { fs, now: () => NOW, minLevel: 'error' })

    sink(record('uyari'))
    expect(fs.content()).toBe('')

    sink({ level: 'error', message: 'kritik' })
    expect(fs.content()).toContain('kritik')
  })

  it('yazma patlarsa YUTULUR — tani kaydi olcumu durdurmaz', () => {
    const broken: DiagFs = {
      appendFileSync: () => {
        throw new Error('EACCES')
      },
      readFileSync: () => '',
      writeFileSync: () => undefined,
      sizeOf: () => 0,
      ensureDir: () => undefined
    }
    const sink = createFileSink('/tmp/d/x.log', { fs: broken, now: () => NOW })
    expect(() => sink(record('bir'))).not.toThrow()
  })
})
