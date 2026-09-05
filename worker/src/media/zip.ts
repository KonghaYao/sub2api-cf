import type { MediaTaskOutputRow } from './types'

const UTF8_AND_DESCRIPTOR = 0x0808
export const MAX_MEDIA_ZIP_BYTES = 512 * 1024 * 1024

interface CentralEntry {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  dosTime: number
  dosDate: number
}

/** Streams uncompressed ZIP entries directly from R2; image bytes are never accumulated. */
export function streamMediaZip(
  bucket: R2Bucket,
  outputs: MediaTaskOutputRow[],
  modifiedAt = new Date(),
): ReadableStream<Uint8Array> {
  const totalBytes = outputs.reduce((total, output) => total + output.byte_length, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_MEDIA_ZIP_BYTES) {
    throw new Error('media_zip_too_large')
  }
  const channel = new TransformStream<Uint8Array, Uint8Array>()
  void writeArchive(channel.writable.getWriter(), bucket, outputs, modifiedAt)
  return channel.readable
}

async function writeArchive(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  bucket: R2Bucket,
  outputs: MediaTaskOutputRow[],
  modifiedAt: Date,
): Promise<void> {
  try {
    const central: CentralEntry[] = []
    const { time, date } = dosDateTime(modifiedAt)
    let offset = 0
    for (const output of outputs) {
      const name = new TextEncoder().encode(zipFilename(output))
      const localOffset = offset
      const local = header(30)
      local.setUint32(0, 0x04034b50, true)
      local.setUint16(4, 20, true)
      local.setUint16(6, UTF8_AND_DESCRIPTOR, true)
      local.setUint16(8, 0, true)
      local.setUint16(10, time, true)
      local.setUint16(12, date, true)
      local.setUint16(26, name.byteLength, true)
      await writer.write(bytes(local))
      await writer.write(name)
      offset += local.byteLength + name.byteLength

      const object = await bucket.get(output.object_key)
      if (object === null) throw new Error(`Missing media object: ${output.object_key}`)
      const reader = object.body.getReader()
      let crc = 0xffffffff
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > OUTPUT_MAX_BYTES || size > output.byte_length) throw new Error('Media object size changed')
          crc = updateCrc32(crc, part.value)
          await writer.write(part.value)
        }
      } finally {
        reader.releaseLock()
      }
      if (size !== output.byte_length) throw new Error('Media object size changed')
      crc = (crc ^ 0xffffffff) >>> 0
      const descriptor = header(16)
      descriptor.setUint32(0, 0x08074b50, true)
      descriptor.setUint32(4, crc, true)
      descriptor.setUint32(8, size, true)
      descriptor.setUint32(12, size, true)
      await writer.write(bytes(descriptor))
      offset += size + descriptor.byteLength
      central.push({ name, crc, size, offset: localOffset, dosTime: time, dosDate: date })
    }

    const centralOffset = offset
    for (const entry of central) {
      const directory = header(46)
      directory.setUint32(0, 0x02014b50, true)
      directory.setUint16(4, 20, true)
      directory.setUint16(6, 20, true)
      directory.setUint16(8, UTF8_AND_DESCRIPTOR, true)
      directory.setUint16(10, 0, true)
      directory.setUint16(12, entry.dosTime, true)
      directory.setUint16(14, entry.dosDate, true)
      directory.setUint32(16, entry.crc, true)
      directory.setUint32(20, entry.size, true)
      directory.setUint32(24, entry.size, true)
      directory.setUint16(28, entry.name.byteLength, true)
      directory.setUint32(42, entry.offset, true)
      await writer.write(bytes(directory))
      await writer.write(entry.name)
      offset += directory.byteLength + entry.name.byteLength
    }
    const end = header(22)
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, central.length, true)
    end.setUint16(10, central.length, true)
    end.setUint32(12, offset - centralOffset, true)
    end.setUint32(16, centralOffset, true)
    await writer.write(bytes(end))
    await writer.close()
  } catch (error) {
    await writer.abort(error)
  }
}

const OUTPUT_MAX_BYTES = 32 * 1024 * 1024

function zipFilename(output: MediaTaskOutputRow): string {
  const base = output.custom_id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'image'
  const suffix = output.image_index === 0 ? '' : `_${String(output.image_index + 1).padStart(2, '0')}`
  return `${base}${suffix}.${output.file_extension}`
}

function header(length: number): DataView {
  return new DataView(new ArrayBuffer(length))
}

function bytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer)
}

function dosDateTime(input: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, input.getUTCFullYear()))
  return {
    time: (input.getUTCHours() << 11) | (input.getUTCMinutes() << 5) | Math.floor(input.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((input.getUTCMonth() + 1) << 5) | input.getUTCDate(),
  }
}

function updateCrc32(crc: number, value: Uint8Array): number {
  let next = crc
  for (const byte of value) next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8)
  return next >>> 0
}

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}
