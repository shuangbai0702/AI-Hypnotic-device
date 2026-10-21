import { zstdDecompressSync } from 'node:zlib';

const MAGIC = 0xfd2fb528;
const MAX_OUTPUT = 512 * 1024 * 1024;
const fail = (offset, message) => new Error(`会话日志损坏（byte ${offset}）：${message}；未允许写回`);

// RFC 8878: determine exact frame boundaries from headers and block sizes.
// Do not search for magic inside compressed data, or depend on whether a given
// Node release decodes one frame or every concatenated frame.
export function decodeLogBuf(input) {
  const buf = Buffer.from(input);
  if (!buf.length) throw fail(0, '空日志');
  const need = (offset, length) => {
    if (offset + length > buf.length) throw fail(offset, '截断的帧');
  };
  const first = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  const isSkip = magic => (magic & 0xfffffff0) === 0x184d2a50;
  if (first !== MAGIC && !isSkip(first)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { throw fail(0, '既非有效 Zstd，也非 UTF-8 文本'); }
  }
  const chunks = [];
  let offset = 0, total = 0;
  while (offset < buf.length) {
    need(offset, 4);
    const start = offset, magic = buf.readUInt32LE(offset);
    offset += 4;
    if (isSkip(magic)) {
      need(offset, 4);
      const size = buf.readUInt32LE(offset);
      offset += 4;
      need(offset, size);
      offset += size;
      continue;
    }
    if (magic !== MAGIC) throw fail(start, '帧边界不合法或有尾部垃圾');
    need(offset, 1);
    const descriptor = buf[offset++];
    if (descriptor & 0x18) throw fail(start, '帧头保留位非零');
    const single = Boolean(descriptor & 0x20), sizeFlag = descriptor >> 6;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    const contentBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag];
    const headerBytes = (single ? 0 : 1) + dictionaryBytes + contentBytes;
    need(offset, headerBytes);
    offset += headerBytes;
    let last;
    do {
      need(offset, 3);
      const block = buf.readUIntLE(offset, 3);
      offset += 3;
      last = Boolean(block & 1);
      const kind = (block >> 1) & 3, size = block >> 3;
      if (kind === 3 || size > 128 * 1024) throw fail(offset - 3, '非法 Zstd block');
      const bytes = kind === 1 ? 1 : size;
      need(offset, bytes);
      offset += bytes;
    } while (!last);
    if (descriptor & 4) { need(offset, 4); offset += 4; }
    let decoded;
    try { decoded = zstdDecompressSync(buf.subarray(start, offset), { maxOutputLength: MAX_OUTPUT - total }); }
    catch (cause) { throw new Error(fail(start, 'Zstd 解压失败').message, { cause }); }
    total += decoded.length;
    if (total > MAX_OUTPUT) throw fail(start, '日志超过解码大小上限');
    chunks.push(decoded);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch { throw fail(0, '无效 UTF-8'); }
}

export function parseRows(text) {
  const events = [];
  for (const [index, line] of text.replace(/^\uFEFF/, '').split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (cause) { throw new Error(`会话日志第 ${index + 1} 行 JSON 无效；未允许写回`, { cause }); }
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string') {
      throw new Error(`会话日志第 ${index + 1} 行不是合法事件；未允许写回`);
    }
    events.push(row);
  }
  if (!events.length) throw new Error('会话日志不包含事件；未允许写回');
  return events;
}

export function assertSequence(events) {
  const start = events[0]?.type === 'session' ? 1 : 0;
  for (let i = start; i < events.length; i++) {
    if (events[i]?.type === 'session' || events[i]?.seq !== i - start) {
      throw new Error(`seq 断裂或重复 at 位置 ${i}；未允许写回`);
    }
  }
}
