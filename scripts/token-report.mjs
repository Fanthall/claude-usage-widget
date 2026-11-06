#!/usr/bin/env node
// Token dokumu: widget'in gosterdigi sayinin karsiligini Claude Code kayitlarindan
// BAGIMSIZ olarak hesaplar (widget'in veritabanini okumaz). Salt okunur.
//
//   npm run tokens                  son 15 dk, 1 sa, 5 sa, bugun
//   npm run tokens -- --minutes 30  ek pencere
//   npm run tokens -- --dir ~/.claude-team
//   npm run tokens -- --lang tr
//
// Kurallar widget'in toplayicisiyla ayni (src/collector/parse.ts): ayni mesajin
// kopya satirlari `message.id|requestId` ile bir kez sayilir, `<synthetic>` sayilmaz.
// Hesap ayrimi burada KLASORE goredir (widget ayrica oturumun kurumuna da bakar).
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const argValue = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

// Dil: --lang tr|en; verilmezse sistemin yerel ayari (Windows'ta Node cogu zaman en-US der).
const langArg = argValue('--lang')
const tr = langArg !== undefined ? langArg === 'tr' : (Intl.DateTimeFormat().resolvedOptions().locale ?? '').toLowerCase().startsWith('tr')
const L = tr
  ? {
      window: 'Pencere', requests: 'İstek', input: 'Giriş', output: 'Çıktı', write: 'Önbelleğe yazma',
      read: 'Önbellekten okuma', fresh: 'Önbelleksiz (widget)', all: 'Hepsi', today: 'bugün', min: 'dk', hour: 'sa',
      none: 'kayıt klasörü yok', note: 'Widget\'ın ana sayısı "Önbelleksiz" sütunudur. "Önbellekten okuma", her istekte\noturumun bütün bağlamının yeniden okunmasıdır; API fiyatında girişin onda biri sayılır.'
    }
  : {
      window: 'Window', requests: 'Requests', input: 'Input', output: 'Output', write: 'Cache write',
      read: 'Cache read', fresh: 'Excl. cache read (widget)', all: 'All', today: 'today', min: 'min', hour: 'h',
      none: 'no transcript folder', note: 'The widget\'s main number is the "Excl. cache read" column. "Cache read" is the whole\nsession context being re-read on every request; the API bills it at a tenth of input.'
    }

const MIN = 60_000
const now = Date.now()
const dayStart = new Date(now).setHours(0, 0, 0, 0)
const windows = [
  { label: `15 ${L.min}`, from: now - 15 * MIN },
  { label: `1 ${L.hour}`, from: now - 60 * MIN },
  { label: `5 ${L.hour}`, from: now - 300 * MIN },
  { label: L.today, from: dayStart }
]
const extra = Number(argValue('--minutes'))
if (Number.isFinite(extra) && extra > 0) windows.unshift({ label: `${extra} ${L.min}`, from: now - extra * MIN })
const oldest = Math.min(...windows.map((w) => w.from))

const dirs = argValue('--dir') !== undefined
  ? [expandHome(argValue('--dir'))]
  : [join(homedir(), '.claude'), join(homedir(), '.claude-team')].filter(existsSync)

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    // Pencere disinda degismemis dosyanin satirlari da pencere disindadir: acilmaz.
    else if (entry.name.endsWith('.jsonl') && statSync(full).mtimeMs >= oldest) out.push(full)
  }
  return out
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

async function scan(projectsDir) {
  const messages = new Map()
  for (const file of walk(projectsDir, [])) {
    const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.includes('"type":"assistant"')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const m = rec?.message
      if (rec?.type !== 'assistant' || m?.usage === undefined || m.model === '<synthetic>') continue
      const at = Date.parse(rec.timestamp ?? '')
      if (!Number.isFinite(at) || at < oldest) continue
      const key = m.id && rec.requestId ? `${m.id}|${rec.requestId}` : rec.uuid ? `uuid:${rec.uuid}` : null
      if (key === null) continue
      const u = m.usage
      const c = u.cache_creation
      const tokens = {
        input: n(u.input_tokens),
        output: n(u.output_tokens),
        write: c ? n(c.ephemeral_5m_input_tokens) + n(c.ephemeral_1h_input_tokens) : n(u.cache_creation_input_tokens),
        read: n(u.cache_read_input_tokens)
      }
      const prev = messages.get(key)
      // Kopyalar arasinda yalniz cikti buyur; en buyugu (son satir) kalir.
      if (prev === undefined || tokens.output >= prev.tokens.output) messages.set(key, { at, tokens })
    }
  }
  return [...messages.values()]
}

const fmt = (v) => v.toLocaleString(tr ? 'tr-TR' : 'en-US')
const pad = (s, w, right = true) => (right ? String(s).padStart(w) : String(s).padEnd(w))

for (const dir of dirs) {
  const projects = join(dir, 'projects')
  console.log(`\n${dir}`)
  if (!existsSync(projects)) {
    console.log(`  ${L.none}`)
    continue
  }
  const all = await scan(projects)
  const head = [L.window, L.requests, L.input, L.output, L.write, L.read, L.fresh, L.all]
  const rows = windows.map((w) => {
    const s = { req: 0, input: 0, output: 0, write: 0, read: 0 }
    for (const m of all) {
      if (m.at < w.from || m.at > now) continue
      s.req += 1
      s.input += m.tokens.input
      s.output += m.tokens.output
      s.write += m.tokens.write
      s.read += m.tokens.read
    }
    const fresh = s.input + s.output + s.write
    return [w.label, fmt(s.req), fmt(s.input), fmt(s.output), fmt(s.write), fmt(s.read), fmt(fresh), fmt(fresh + s.read)]
  })
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  console.log('  ' + head.map((h, i) => pad(h, widths[i], i > 0)).join('  '))
  for (const r of rows) console.log('  ' + r.map((c, i) => pad(c, widths[i], i > 0)).join('  '))
}
console.log(`\n${L.note}`)
