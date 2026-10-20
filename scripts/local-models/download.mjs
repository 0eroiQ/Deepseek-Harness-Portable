import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function hashFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function availableBytes(path) {
  const s = await statfs(path)
  return s.bavail * s.bsize
}
// Partial bytes are retained on abort/network failure and published only after SHA-256 verification.
export async function downloadFile({ url, destination, sha256, size, signal, progress = () => {}, fetcher = fetch }) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Missing download checksum.')
  await mkdir(dirname(destination), { recursive: true })
  const part = `${destination}.part`
  let offset = (await stat(part).catch(() => ({size: 0}))).size
  if (size && offset > size) { await rm(part); offset = 0 }
  if (size && await availableBytes(dirname(destination)) < size - offset + 64 * 1024 * 1024) throw new Error('Not enough free space on this drive.')
  if (!size || offset !== size) {
    const response = await fetcher(url, { headers: offset ? {Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity'} : {'Accept-Encoding': 'identity'}, signal })
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). Retry to resume.`)
    if (offset && response.status === 206) {
      if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Server returned an invalid resume range.')
    } else offset = 0 // A server ignoring Range starts over; never append a full response.
    const total = size || (Number(response.headers.get('content-length')) + offset) || 0
    let received = offset
    progress({received, total, phase: 'downloading'})
    const meter = new Transform({ transform(chunk, _encoding, done) {
      received += chunk.length
      if (size && received > size) return done(new Error('Download exceeded its advertised size.'))
      progress({received, total, phase: 'downloading'}); done(null, chunk)
    }})
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: offset ? 'a' : 'w' }), {signal})
  }
  signal?.throwIfAborted()
  progress({received: size || (await stat(part)).size, total: size || 0, phase: 'verifying'})
  if ((size && (await stat(part)).size !== size) || await hashFile(part) !== sha256) {
    await rm(part, {force:true})
    throw new Error('Checksum verification failed. The incomplete file was removed; please retry.')
  }
  signal?.throwIfAborted()
  await rename(part, destination)
}
