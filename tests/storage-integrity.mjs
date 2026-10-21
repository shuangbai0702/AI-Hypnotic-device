import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync as compress, constants } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { decodeLogBuf, parseRows, loadSession, writeValidatedEvents } from '../plugins/dsh-session-editor/lib/shadowing.js';
const rows = count => Array.from({ length: count }, (_, seq) => ({ seq, type: 'user/message', data: { text: `合成消息 ${seq} 😀` } }));
const text = events => events.map(JSON.stringify).join('\n') + '\n';
const encode = events => Buffer.concat(events.map(row => compress(Buffer.from(JSON.stringify(row) + '\n'))));

for (const count of [1, 3, 100, 1000]) test(`${count} independent Zstd frames decode exactly once and survive rewrite`, () => {
  const events = rows(count), dir = mkdtempSync(join(tmpdir(), 'dsh-codec-'));
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = dir;
  try {
    const file = join(dir, 'session.v4.jsonl.zstd'), bytes = encode(events);
    assert.equal(decodeLogBuf(bytes), text(events));
    assert.deepEqual(parseRows(decodeLogBuf(compress(Buffer.from(text(events))))), events);
    writeFileSync(file, bytes);
    const edited = structuredClone(events); edited.at(-1).data.text = 'new synthetic value';
    writeValidatedEvents(dir, edited);
    assert.deepEqual(loadSession(dir).events, edited);
    const backups = readdirSync(join(dir, 'backups/physical-sync'));
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(join(dir, 'backups/physical-sync', backups[0])), bytes);
    writeValidatedEvents(dir, events);
    assert.deepEqual(loadSession(dir).events, events);
    assert.equal(readdirSync(join(dir, 'backups/physical-sync')).length, 2);
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; rmSync(dir, { recursive: true }); }
});

test('skippable frames may contain magic; UTF-8 split across frames remains exact', () => {
  const data = Buffer.from(text(rows(2))), split = data.indexOf(Buffer.from('合')) + 1;
  const skip = Buffer.from([0x50,0x2a,0x4d,0x18,4,0,0,0,0x28,0xb5,0x2f,0xfd]);
  assert.equal(decodeLogBuf(Buffer.concat([skip, compress(data.subarray(0, split)), skip, compress(data.subarray(split))])), data.toString());
});

test('truncated frames, corrupt checksums, tail garbage and invalid JSON/UTF-8 fail closed', () => {
  const valid = encode(rows(3));
  for (const length of [1, 4, 5, valid.length - 1]) assert.throws(() => parseRows(decodeLogBuf(valid.subarray(0, length))));
  assert.throws(() => decodeLogBuf(Buffer.concat([valid, Buffer.from('garbage')])));
  const checked = compress(Buffer.from(text(rows(1))), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  checked[checked.length - 1] ^= 1;
  assert.throws(() => decodeLogBuf(checked), /解压失败/);
  assert.throws(() => parseRows(text(rows(1)) + '{broken\n'), /第 2 行/);
  assert.throws(() => parseRows('null\n'), /合法事件/);
  assert.throws(() => decodeLogBuf(compress(Buffer.from([0xff, 0xff]))), /UTF-8/);
});

test('corrupt source cannot be replaced by a partially recovered event list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-corrupt-')), file = join(dir, 'session.v4.jsonl.zstd');
  try {
    for (const bytes of [Buffer.concat([encode(rows(2)), Buffer.from([1])]), compress(Buffer.from(text(rows(1)) + '{bad')),
      encode([...rows(2), rows(1)[0]])]) {
      writeFileSync(file, bytes);
      assert.throws(() => loadSession(dir));
      assert.throws(() => writeValidatedEvents(dir, rows(1)));
      assert.deepEqual(readFileSync(file), bytes);
      assert.deepEqual(readdirSync(dir), ['session.v4.jsonl.zstd']);
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('legacy diagnostic CLI refuses every mutation without touching log bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cli-')), file = join(dir, 'session.v4.jsonl.zstd');
  const bytes = encode(rows(3)); writeFileSync(file, bytes);
  try {
    const cli = new URL('../plugins/dsh-session-editor/lib/log-rewrite.mjs', import.meta.url);
    for (const command of ['delete', 'edit', 'repair', 'insert', 'restore']) {
      const result = spawnSync(process.execPath, [fileURLToPath(cli), command, dir], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /仅支持 inspect/);
      assert.deepEqual(readFileSync(file), bytes);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
