import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseLine, projectName } from './parse'
import { readNewLines } from './read-lines'
import { scanOnce } from './scan'
import { UsageStore } from './store'

const T0 = Date.UTC(2026, 10, 6, 9, 0)

function assistant(opts: {
  id?: string
  req?: string
  uuid?: string
  at?: number
  output?: number
  input?: number
  read?: number
  w1h?: number
  model?: string
  session?: string
  cwd?: string
  sidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid ?? 'u-1',
    sessionId: opts.session ?? 's-1',
    cwd: opts.cwd ?? 'F:\\dev-apps\\claude-usage-widget',
    isSidechain: opts.sidechain ?? false,
    requestId: opts.req,
    timestamp: new Date(opts.at ?? T0).toISOString(),
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-opus-5-5',
      usage: {
        input_tokens: opts.input ?? 2,
        output_tokens: opts.output ?? 100,
        cache_creation_input_tokens: opts.w1h ?? 0,
        cache_read_input_tokens: opts.read ?? 1000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: opts.w1h ?? 0 }
      }
    }
  })
}

function orgLine(session: string, org: string): string {
  return JSON.stringify({
    type: 'attachment',
    sessionId: session,
    attachment: { type: 'credential_org', organizationUuid: org }
  })
}

describe('parseLine', () => {
  it('asistan satirindan tekil anahtar ve token dokumu cikar', () => {
    const p = parseLine(assistant({ id: 'msg_1', req: 'req_1', output: 50, w1h: 300 }))
    expect(p.kind).toBe('message')
    if (p.kind !== 'message') return
    expect(p.record.key).toBe('msg_1|req_1')
    expect(p.record.tokens).toEqual({ input: 2, output: 50, cacheWrite5m: 0, cacheWrite1h: 300, cacheRead: 1000 })
    expect(p.record.project).toBe('claude-usage-widget')
    expect(p.record.subagent).toBe(false)
  })

  it('id ya da requestId yoksa satirin uuid-i anahtar olur', () => {
    const p = parseLine(assistant({ uuid: 'abc' }))
    expect(p.kind === 'message' && p.record.key).toBe('uuid:abc')
  })

  it('<synthetic> model sayilmaz', () => {
    expect(parseLine(assistant({ id: 'm', req: 'r', model: '<synthetic>' })).kind).toBe('skip')
  })

  it('kurum satiri oturum ve kurumu verir', () => {
    expect(parseLine(orgLine('s-9', 'org-x'))).toEqual({ kind: 'org', sessionId: 's-9', orgId: 'org-x' })
  })

  it('ilgisiz satir JSON acilmadan atlanir; bozuk ilgili satir sayilir', () => {
    expect(parseLine('{"type":"user","message":"x"}').kind).toBe('skip')
    expect(parseLine('{"type":"assistant", bozuk').kind).toBe('bad')
  })

  it('alt ajan dosyasi ya da isSidechain alt ajan sayilir', () => {
    const a = parseLine(assistant({ id: 'm', req: 'r' }), true)
    const b = parseLine(assistant({ id: 'm', req: 'r', sidechain: true }))
    expect(a.kind === 'message' && a.record.subagent).toBe(true)
    expect(b.kind === 'message' && b.record.subagent).toBe(true)
  })

  it('proje adi iki ayracla da cozulur', () => {
    expect(projectName('/Users/ada/dev/wisp/')).toBe('wisp')
    expect(projectName('C:\\dev\\mimi')).toBe('mimi')
    expect(projectName('')).toBeNull()
  })
})

describe('readNewLines', () => {
  it('yarim son satiri okumaz; konum tam satirin sonunda kalir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuw-read-'))
    const file = join(dir, 'a.jsonl')
    const first = assistant({ id: 'm1', req: 'r1' })
    await writeFile(file, `${first}\n{"type":"user"}\n{"type":"assistant","yarim`)
    const lines: string[] = []
    const r1 = await readNewLines(file, 0, (l) => lines.push(l))
    expect(lines).toEqual([first])
    expect(r1.nextOffset).toBe(Buffer.byteLength(`${first}\n{"type":"user"}\n`))

    // Satir tamamlaninca kaldigi yerden okunur, eski satir tekrar gelmez.
    await appendFile(file, '"}\r\n')
    const more: string[] = []
    const r2 = await readNewLines(file, r1.nextOffset, (l) => more.push(l))
    expect(more).toEqual(['{"type":"assistant","yarim"}'])
    expect(r2.nextOffset).toBe(Buffer.byteLength(`${first}\n{"type":"user"}\n{"type":"assistant","yarim"}\r\n`))
  })

  it('cok baytli karakterler ve buyuk satirlarda konum bayt olarak dogru', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuw-read-'))
    const file = join(dir, 'b.jsonl')
    const big = `{"type":"api-request-blob","x":"${'ş'.repeat(300_000)}"}`
    const line = assistant({ id: 'm', req: 'r', cwd: 'C:\\Şirket\\proje' })
    await writeFile(file, `${big}\n${line}\n`)
    const got: string[] = []
    const r = await readNewLines(file, 0, (l) => got.push(l))
    expect(got).toEqual([line])
    expect(r.nextOffset).toBe(Buffer.byteLength(`${big}\n${line}\n`))
  })
})

describe('UsageStore', () => {
  it('ayni mesajin kopyalari tek sayilir; cikti en buyuk deger olur', () => {
    const store = new UsageStore(':memory:')
    const rec = (output: number): ReturnType<typeof parseLine> =>
      parseLine(assistant({ id: 'm1', req: 'r1', output, read: 0, input: 0 }))
    const records = [rec(10), rec(40), rec(25)].flatMap((p) => (p.kind === 'message' ? [p.record] : []))
    store.write('personal', records, [])
    const [personal] = store.summary(['personal'], T0 + 60_000, T0 - 3_600_000)
    expect(personal?.today).toBe(40)
    store.close()
  })

  it('hesap: oturumun kurumu klasorun hesabini ezer; bilinmeyen kurum klasore duser', () => {
    const store = new UsageStore(':memory:')
    const p = (id: string, session: string) => {
      const r = parseLine(assistant({ id, req: id, session, output: 100, read: 0, input: 0 }))
      return r.kind === 'message' ? [r.record] : []
    }
    store.setOrgAccounts([{ orgId: 'org-team', account: 'team' }])
    // Desktop uygulamasi Team kurumuna gecmis ama kayit kisisel klasorde.
    store.write('personal', [...p('a', 's-team'), ...p('b', 's-personal'), ...p('c', 's-unknown')], [
      ['s-team', 'org-team'],
      ['s-unknown', 'org-baska']
    ])
    const sums = store.summary(['personal', 'team'], T0 + 60_000, T0 - 3_600_000)
    expect(sums.find((s) => s.key === 'team')?.today).toBe(100)
    expect(sums.find((s) => s.key === 'personal')?.today).toBe(200)
    store.close()
  })

  it('son 15 dk, bugun ve 3 saatlik dilimler ayri hesaplanir', () => {
    const store = new UsageStore(':memory:')
    const now = T0 + 3 * 3_600_000
    const at = (min: number, id: string) => {
      const r = parseLine(assistant({ id, req: id, at: now - min * 60_000, output: 10, read: 0, input: 0 }))
      return r.kind === 'message' ? [r.record] : []
    }
    store.write('personal', [...at(5, 'a'), ...at(20, 'b'), ...at(200, 'c')], [])
    const [s] = store.summary(['personal'], now, now - 10 * 3_600_000)
    expect(s?.last15m).toBe(10)
    expect(s?.today).toBe(30)
    expect(s?.spark).toHaveLength(36)
    expect(s?.spark.reduce((a, b) => a + b, 0)).toBe(20)
    store.close()
  })

  it('merkeze bekleyen dakikalar mutlak toplamla doner; gonderilince isaretlenir', () => {
    const store = new UsageStore(':memory:')
    const r = (id: string, output: number) => {
      const p = parseLine(assistant({ id, req: id, output, read: 0, input: 0 }))
      return p.kind === 'message' ? [p.record] : []
    }
    store.write('personal', [...r('a', 10), ...r('b', 5)], [])
    const first = store.pendingBuckets()
    expect(first.buckets).toHaveLength(1)
    expect(first.buckets[0]?.output).toBe(15)
    expect(first.buckets[0]?.requests).toBe(2)
    store.markSynced(first.minutes, first.maxSeq)
    expect(store.pendingBuckets().buckets).toHaveLength(0)

    // Ayni dakikaya yeni mesaj: dakikanin TAM toplami yeniden gider.
    store.write('personal', r('c', 7), [])
    const again = store.pendingBuckets()
    expect(again.buckets[0]?.output).toBe(22)
    expect(store.pendingMinutes()).toBe(1)
    store.close()
  })

  it('kurumu bilinen ve bilinmeyen oturum ayni dakikada TEK sepet olur (takma ad tuzagi)', () => {
    const store = new UsageStore(':memory:')
    const rec = (id: string, session: string) => {
      const p = parseLine(assistant({ id, req: id, output: 10, read: 0, input: 0, session }))
      return p.kind === 'message' ? [p.record] : []
    }
    store.setOrgAccounts([{ orgId: 'org-p', account: 'personal' }])
    store.write('personal', [...rec('a', 's-known'), ...rec('b', 's-unknown')], [['s-known', 'org-p']])
    const { buckets } = store.pendingBuckets()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.requests).toBe(2)
    expect(buckets[0]?.output).toBe(20)
    const [s] = store.summary(['personal'], T0 + 60_000, T0 - 3_600_000)
    expect(s?.last15m).toBe(20)
    store.close()
  })

  it('eski veritabani acilista bir kez yeniden gonderilir, ikinci acilista degil', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cuw-resync-'))
    const file = join(dir, 'usage.db')
    const p = parseLine(assistant({ id: 'a', req: 'a', output: 10, read: 0, input: 0 }))
    const first = new UsageStore(file)
    first.write('personal', p.kind === 'message' ? [p.record] : [], [])
    const sent = first.pendingBuckets()
    first.markSynced(sent.minutes, sent.maxSeq)
    first.close()
    // Ayni dosya yeniden acilir: bu surumde isaret zaten var, yeniden gonderim yok.
    const second = new UsageStore(file)
    expect(second.pendingMinutes()).toBe(0)
    second.close()

    // Isaretsiz (eski surumun) veritabani: bir kez her sey yeniden gider, surum buyur.
    const raw = new DatabaseSync(file)
    raw.exec("DELETE FROM meta WHERE key = 'resync'")
    raw.close()
    const third = new UsageStore(file)
    const resent = third.pendingBuckets()
    expect(resent.buckets).toHaveLength(1)
    expect(resent.buckets[0]?.version).toBeGreaterThan(sent.buckets[0]?.version ?? Infinity)
    third.close()
  })

  it('dakika surumu degisiklikle buyur; donem kalicidir', () => {
    const store = new UsageStore(':memory:')
    const r = (id: string, output: number) => {
      const p = parseLine(assistant({ id, req: id, output, read: 0, input: 0 }))
      return p.kind === 'message' ? [p.record] : []
    }
    store.write('personal', r('a', 10), [])
    const first = store.pendingBuckets()
    expect(first.epoch).toMatch(/^[0-9a-f-]{36}$/)
    store.markSynced(first.minutes, first.maxSeq)
    store.write('personal', r('b', 5), [])
    const second = store.pendingBuckets()
    expect(second.epoch).toBe(first.epoch)
    expect(second.buckets[0]?.version).toBeGreaterThan(first.buckets[0]?.version ?? Infinity)
    store.close()
  })

  it('oturumun hesabi sonradan degisirse gonderilmis satirlari yeniden gonderilir', () => {
    const store = new UsageStore(':memory:')
    const p = parseLine(assistant({ id: 'a', req: 'a', output: 10, read: 0, input: 0, session: 's-late' }))
    store.write('personal', p.kind === 'message' ? [p.record] : [], [])
    const first = store.pendingBuckets()
    store.markSynced(first.minutes, first.maxSeq)
    expect(store.pendingMinutes()).toBe(0)
    // Kurum satiri gec geldi; kurum Team'e esli.
    store.setOrgAccounts([{ orgId: 'org-team', account: 'team' }])
    store.write('personal', [], [['s-late', 'org-team']])
    const again = store.pendingBuckets()
    expect(again.buckets.map((b) => b.account)).toEqual(['team'])
    expect(again.buckets[0]?.version).toBeGreaterThan(first.buckets[0]?.version ?? Infinity)
    store.close()
  })

  it('ana sayi onbellekten okumayi icermez; okuma ayri doner', () => {
    const store = new UsageStore(':memory:')
    const now = T0 + 3_600_000
    const r = parseLine(assistant({ id: 'a', req: 'a', at: now - 60_000, output: 10, read: 300_000, input: 2 }))
    store.write('personal', r.kind === 'message' ? [r.record] : [], [])
    const [s] = store.summary(['personal'], now, now - 3_600_000)
    expect(s?.last15m).toBe(12)
    expect(s?.today).toBe(12)
    expect(s?.cacheRead15m).toBe(300_000)
    expect(s?.spark.reduce((a, b) => a + b, 0)).toBe(12)
    store.close()
  })

  it('ayni 5 dakikalik dilimdeki mesajlar kivilcimda toplanir (dilim tam sayi)', () => {
    // node:sqlite sayilari REAL baglar; bolme tam sayiya cevrilmezse her mesaj
    // kendi dilimine duser ve kivilcim degeri birbirinin uzerine yazilirdi.
    const store = new UsageStore(':memory:')
    const now = T0 + 3_600_000
    const at = (sec: number, id: string) => {
      const r = parseLine(assistant({ id, req: id, at: now - sec * 1000, output: 10, read: 0, input: 0 }))
      return r.kind === 'message' ? [r.record] : []
    }
    store.write('personal', [...at(400, 'a'), ...at(390, 'b')], [])
    const [s] = store.summary(['personal'], now, now - 3_600_000)
    expect(s?.spark.reduce((a, b) => a + b, 0)).toBe(20)
    expect(Math.max(...(s?.spark ?? []))).toBe(20)
    store.close()
  })

  it('panel satirlari merkezin bicimiyle doner; cihaz alani bu cihaz', () => {
    const store = new UsageStore(':memory:')
    const now = T0 + 3_600_000
    const at = (min: number, id: string) => {
      const r = parseLine(assistant({ id, req: id, at: now - min * 60_000, output: 10, read: 5, input: 1 }))
      return r.kind === 'message' ? [r.record] : []
    }
    store.write('personal', [...at(50, 'a'), ...at(10, 'b'), ...at(5, 'c')], [])
    const from = now - 3_600_000
    const rows = store.usageRows(from, now, 30 * 60_000, ['account', 'device'], 'pc-1')
    expect(rows).toEqual([
      { atMs: from, account: 'personal', device: 'pc-1', total: 16, output: 10, input: 1, cacheWrite: 0, cacheRead: 5, requests: 1 },
      { atMs: from + 30 * 60_000, account: 'personal', device: 'pc-1', total: 32, output: 20, input: 2, cacheWrite: 0, cacheRead: 10, requests: 2 }
    ])
    store.close()
  })
})

describe('scanOnce', () => {
  it('gecmisi okur, ikinci turda yalniz yeni satirlari okur', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cuw-scan-'))
    const projects = join(root, 'projects', 'F--dev')
    await mkdir(join(projects, 's-1', 'subagents'), { recursive: true })
    const main = join(projects, 's-1.jsonl')
    await writeFile(
      main,
      [orgLine('s-1', 'org-p'), assistant({ id: 'm1', req: 'r1', output: 10 }), assistant({ id: 'm1', req: 'r1', output: 30 })].join(
        '\n'
      ) + '\n'
    )
    await writeFile(join(projects, 's-1', 'subagents', 'a.jsonl'), assistant({ id: 'm2', req: 'r2', output: 5 }) + '\n')

    const store = new UsageStore(':memory:')
    const sources = [{ account: 'personal' as const, projectsDir: join(root, 'projects') }]
    const progress: number[] = []
    const r1 = await scanOnce(store, sources, (p) => progress.push(p.doneBytes), true)
    expect(r1.filesRead).toBe(2)
    expect(progress.at(-1)).toBeGreaterThan(0)

    const r2 = await scanOnce(store, sources)
    expect(r2.filesRead).toBe(0)

    await appendFile(main, assistant({ id: 'm3', req: 'r3', output: 1, at: T0 + 1000 }) + '\n')
    const r3 = await scanOnce(store, sources)
    expect(r3.filesRead).toBe(1)
    expect(r3.messages).toBe(1)

    const [s] = store.summary(['personal'], T0 + 60_000, T0 - 3_600_000)
    // m1 (30, son satir) + m2 (5) + m3 (1) cikti + her mesajda 2 giris; okuma (3 x 1000) ana sayiya girmez
    expect(s?.today).toBe(30 + 5 + 1 + 3 * 2)
    store.close()
  })

  it('olmayan klasor hata vermez', async () => {
    const store = new UsageStore(':memory:')
    const r = await scanOnce(store, [{ account: 'team', projectsDir: join(tmpdir(), 'yok-boyle-bir-klasor') }])
    expect(r.filesRead).toBe(0)
    store.close()
  })
})

describe('mapOtherOrgs', () => {
  it('kisisel disindaki bilinmeyen kurum Team sayilir; bilinen esleme ezilmez', () => {
    const store = new UsageStore(':memory:')
    const r = (id: string, session: string) => {
      const p = parseLine(assistant({ id, req: id, session, output: 10, read: 0, input: 0 }))
      return p.kind === 'message' ? [p.record] : []
    }
    store.setOrgAccounts([{ orgId: 'org-p', account: 'personal' }])
    store.write('personal', [...r('a', 's-p'), ...r('b', 's-x')], [
      ['s-p', 'org-p'],
      ['s-x', 'org-desktop-team']
    ])
    store.mapOtherOrgs('org-p', 'team')
    const sums = store.summary(['personal', 'team'], T0 + 60_000, T0 - 3_600_000)
    expect(sums.find((s) => s.key === 'personal')?.today).toBe(10)
    expect(sums.find((s) => s.key === 'team')?.today).toBe(10)
    store.close()
  })
})
