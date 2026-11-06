/**
 * Kayit dosyasini kaldigi bayttan okur.
 *
 * Satirlar bayt duzeyinde bolunur: hangi baytta kalindigi kesin bilinmeli, yoksa
 * bir sonraki turda ayni satir iki kez okunur ya da yarim kalir. Son satir
 * henuz yaziliyorsa (sonunda `\n` yok) okunmaz; konum onun basinda kalir ve
 * bir sonraki turda tamami okunur.
 *
 * Ilgisiz satirlar metne bile cevrilmez: dosyalarin cogu buyuk istek govdeleri
 * tasiyan satirlardan olusur (tek dosya 623 MB olculdu).
 */

import { createReadStream } from 'node:fs'

const NEWLINE = 0x0a
const MARKERS = [Buffer.from('"type":"assistant"'), Buffer.from('"credential_org"')]

function relevant(buf: Buffer): boolean {
  return MARKERS.some((m) => buf.indexOf(m) !== -1)
}

export interface ReadResult {
  /** Bir sonraki okumanin baslayacagi bayt (son tam satirin sonu). */
  nextOffset: number
  /** Okunan bayt (ilerleme icin). */
  bytesRead: number
}

/**
 * `start` baytindan itibaren tam satirlari okur; yalniz ilgili satirlari
 * `onLine`a verir. Satir sonundaki `\r` atilir.
 */
export async function readNewLines(
  file: string,
  start: number,
  onLine: (line: string) => void,
  onBytes?: (bytes: number) => void
): Promise<ReadResult> {
  let consumed = start
  let pending: Buffer[] = []
  let pendingLength = 0
  const stream = createReadStream(file, { start, highWaterMark: 1 << 20 })

  for await (const raw of stream) {
    const chunk = raw as Buffer
    let from = 0
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, from)
      if (nl === -1) {
        pending.push(chunk.subarray(from))
        pendingLength += chunk.length - from
        break
      }
      const tail = chunk.subarray(from, nl)
      const line = pendingLength > 0 ? Buffer.concat([...pending, tail]) : tail
      consumed += pendingLength + (nl - from) + 1
      pending = []
      pendingLength = 0
      if (line.length > 0 && relevant(line)) {
        let end = line.length
        if (line[end - 1] === 0x0d) end -= 1
        onLine(line.toString('utf8', 0, end))
      }
      from = nl + 1
    }
    onBytes?.(chunk.length)
  }
  return { nextOffset: consumed, bytesRead: consumed - start }
}
