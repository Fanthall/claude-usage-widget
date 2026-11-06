/**
 * Merkezin HTTP uclari. Iki dinleyici ayni isleyiciyi farkli rolle kullanir:
 *
 * - `public` (disariya acilan dinleyici; tunel ya da ters vekil arkasinda): yalniz `/v1/*`,
 *   HER istek cihaz anahtari ister;
 *   kayit ucu ve panel yok.
 * - `home` (yalniz ev agi / ozel ag): panel sayfasi, anahtarsiz okuma, cihaz kaydi.
 *   Yazma burada da anahtar ister.
 *
 * Kimlik dogrulama Bearer anahtariyla (cerez yok); bu yuzden CORS `*` acik:
 * widget'in panel penceresi uygulama dosyasindan (origin `null`) okur.
 */

import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

import { GROUP_FIELDS, type BucketIn, type Device, type GroupField, type HubDb, type QuotaSampleIn } from './db'

export type ListenerRole = 'public' | 'home'

export interface HandlerOptions {
  role: ListenerRole
  db: HubDb
  panelDir: string | null
  now?: () => number
}

const MAX_BODY = 8 * 1024 * 1024
const ACCOUNTS = new Set(['personal', 'team'])
const MAX_RANGE_MS = 400 * 24 * 3600 * 1000

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, 'govde cok buyuk')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'JSON degil')
  }
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

function parseBuckets(body: unknown): BucketIn[] {
  const list = (body as { buckets?: unknown })?.buckets
  if (!Array.isArray(list) || list.length > 20_000) throw new HttpError(400, 'buckets dizi degil')
  return list.map((raw: unknown) => {
    const b = raw as Record<string, unknown>
    const account = text(b['account'], 20)
    const model = text(b['model'], 120)
    const minute = int(b['minute'])
    const nums = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'requests'].map((k) => int(b[k]))
    if (account === null || !ACCOUNTS.has(account) || model === null || minute === null || nums.some((n) => n === null)) {
      throw new HttpError(400, 'gecersiz sepet')
    }
    const [input, output, cacheWrite5m, cacheWrite1h, cacheRead, requests] = nums as number[]
    return {
      minute,
      account,
      model,
      project: b['project'] === null ? null : text(b['project'], 200),
      subagent: b['subagent'] === true,
      input: input ?? 0,
      output: output ?? 0,
      cacheWrite5m: cacheWrite5m ?? 0,
      cacheWrite1h: cacheWrite1h ?? 0,
      cacheRead: cacheRead ?? 0,
      requests: requests ?? 0,
      ...(int(b['version']) === null ? {} : { version: int(b['version']) as number })
    }
  })
}

function parseQuota(body: unknown): QuotaSampleIn[] {
  const list = (body as { samples?: unknown })?.samples
  if (!Array.isArray(list) || list.length > 1000) throw new HttpError(400, 'samples dizi degil')
  return list.map((raw: unknown) => {
    const s = raw as Record<string, unknown>
    const account = text(s['account'], 20)
    const fetchedAt = int(s['fetchedAt'])
    const windows = s['windows']
    if (account === null || !ACCOUNTS.has(account) || fetchedAt === null || !Array.isArray(windows)) {
      throw new HttpError(400, 'gecersiz kota ornegi')
    }
    return {
      account,
      fetchedAt,
      windows: windows.slice(0, 10).map((w: unknown) => {
        const x = w as Record<string, unknown>
        const label = text(x['label'], 80)
        const percent = typeof x['percent'] === 'number' ? Math.max(0, Math.min(100, x['percent'])) : null
        if (label === null || percent === null) throw new HttpError(400, 'gecersiz pencere')
        return { label, percent, resetsAtMs: int(x['resetsAtMs']) }
      })
    }
  })
}

function rangeOf(url: URL, now: number): { from: number; to: number } {
  const to = Number(url.searchParams.get('to') ?? now)
  const from = Number(url.searchParams.get('from') ?? to - 24 * 3600 * 1000)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_MS) {
    throw new HttpError(400, 'gecersiz aralik')
  }
  return { from, to }
}

async function servePanel(res: ServerResponse, panelDir: string | null, pathname: string): Promise<boolean> {
  if (panelDir === null) return false
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
  const file = normalize(join(panelDir, rel))
  if (!file.startsWith(normalize(panelDir) + sep) && file !== normalize(join(panelDir, 'index.html'))) return false
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': rel === 'index.html' ? 'no-store' : 'max-age=86400'
    })
    res.end(await readFile(file))
    return true
  } catch {
    return false
  }
}

export function createHandler(options: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { db, role } = options
  const now = options.now ?? Date.now

  function authenticate(req: IncomingMessage): Device {
    const header = req.headers['authorization']
    const key = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const device = key === '' ? null : db.deviceByKey(key)
    if (device === null) throw new HttpError(401, 'cihaz anahtari gecersiz')
    db.touch(device.id, now())
    return device
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '86400'
      })
      res.end()
      return
    }
    if (path === '/health') return send(res, 200, { ok: true, role })

    if (path.startsWith('/v1/')) {
      // Okuma: evde anahtarsiz, disarida anahtarla. Yazma: her yerde anahtarla.
      if (method === 'GET') {
        if (role === 'public') authenticate(req)
        if (path === '/v1/usage') {
          const { from, to } = rangeOf(url, now())
          const step = Number(url.searchParams.get('step') ?? 15 * 60 * 1000)
          if (!Number.isInteger(step) || step < 60_000) throw new HttpError(400, 'gecersiz adim')
          if ((to - from) / step > 20_000) throw new HttpError(400, 'cok fazla dilim')
          const by = (url.searchParams.get('by') ?? 'account').split(',').filter((f) => f !== '')
          if (!by.every((f) => (GROUP_FIELDS as readonly string[]).includes(f))) throw new HttpError(400, 'gecersiz gruplama')
          return send(res, 200, { rows: db.usage(from, to, step, by as GroupField[]) })
        }
        if (path === '/v1/quota') {
          const { from, to } = rangeOf(url, now())
          return send(res, 200, { samples: db.quota(from, to, url.searchParams.get('kind') === 'main') })
        }
        if (path === '/v1/devices') return send(res, 200, { devices: db.devices() })
        throw new HttpError(404, 'bulunamadi')
      }
      if (method === 'POST') {
        if (path === '/v1/enroll') {
          if (role !== 'home') throw new HttpError(404, 'bulunamadi')
          const body = (await readJson(req)) as Record<string, unknown>
          const name = text(body['name'], 80)
          if (name === null) throw new HttpError(400, 'ad gerekli')
          return send(res, 200, db.enroll(name, text(body['os'], 20), now()))
        }
        const device = authenticate(req)
        const body = await readJson(req)
        if (path === '/v1/usage') {
          const epoch = text((body as { epoch?: unknown })?.epoch, 64)
          return send(res, 200, { accepted: db.writeBuckets(device.id, parseBuckets(body), epoch) })
        }
        if (path === '/v1/quota') return send(res, 200, { accepted: db.writeQuota(device.id, parseQuota(body)) })
        if (path === '/v1/heartbeat') {
          const b = body as Record<string, unknown>
          db.touch(device.id, now(), {
            ...(text(b['version'], 40) === null ? {} : { version: text(b['version'], 40) as string }),
            ...(int(b['queue']) === null ? {} : { queue: int(b['queue']) as number }),
            ...(int(b['scanPct']) === null ? {} : { scanPct: int(b['scanPct']) as number })
          })
          return send(res, 200, { ok: true, deviceId: device.id })
        }
      }
      throw new HttpError(404, 'bulunamadi')
    }

    if (role === 'home' && method === 'GET' && (await servePanel(res, options.panelDir, path))) return
    throw new HttpError(404, 'bulunamadi')
  }

  return (req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500
      if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : 'hata' })
      else res.end()
    })
  }
}
