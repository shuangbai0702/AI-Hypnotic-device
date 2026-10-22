import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runtimePaths } from './runtime-paths.js';

const requestScope = new AsyncLocalStorage(), services = new WeakMap();
const MAX_BYTES = 2 * 1024 * 1024, ARCHIVES = 4;
const ref = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
export const sessionReference = ref;
const code = error => /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : undefined;
const fields = new Set(['id', 'time', 'event', 'level', 'plugin', 'homeSource', 'operation', 'parentRequestId',
  'requestId', 'method', 'route', 'sessionRef', 'status', 'durationMs', 'error', 'changeCount', 'diagnosticId']);
function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !/^[a-f0-9-]{36}$/.test(record.id ?? '') ||
      typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time)) || typeof record.event !== 'string') return false;
  if (Object.keys(record).some(key => !fields.has(key))) return false;
  if (record.error && (typeof record.error !== 'object' || Object.keys(record.error).some(key => !['type', 'code', 'category', 'frames'].includes(key)))) return false;
  if (record.plugin && (typeof record.plugin !== 'object' || Object.keys(record.plugin).some(key => !['name', 'version'].includes(key)))) return false;
  return true;
}
function errorDetails(error) {
  const message = String(error?.message ?? error);
  const category = /DSH_HOME|path.*undefined|ERR_INVALID_ARG_TYPE/i.test(message + ' ' + error?.code) ? 'data-path'
    : /版本冲突|revision/i.test(message) ? 'revision-conflict'
    : /corrupt|SessionFormat|compaction checkpoint/i.test(message) ? 'session-format'
    : /ENOSPC|disk.*full/i.test(message + ' ' + error?.code) ? 'disk-full'
    : /EACCES|EPERM|permission/i.test(message + ' ' + error?.code) ? 'permission'
    : /正在生成|running|owned|占用/i.test(message) ? 'session-busy' : 'operation-failed';
  // Error messages can contain JSON input, credentials and chat text. Keep the
  // technical type/code and every call frame, never the arbitrary message line.
  const frames = String(error?.stack ?? '').split('\n').slice(1, 41).flatMap(line => {
    const match = line.match(/^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!match) return [];
    const file = match[2].split(/[?#]|%(?:3f|23)/i)[0].replace(/\\/g, '/').split('/').at(-1).replace(/[^a-zA-Z0-9_.-]/g, '').slice(-100);
    const fn = (match[1] ?? '<anonymous>').replace(/[^a-zA-Z0-9_$ .<>]/g, '').slice(0, 100);
    return [`at ${fn} (<path>/${file}:${match[3]}:${match[4]})`];
  });
  return { type: /^[A-Za-z0-9_]{1,64}$/.test(error?.name ?? '') ? error.name : 'Error', code: code(error), category, frames };
}

export function captureError(error) { const scope = requestScope.getStore(); if (scope) scope.error = errorDetails(error); }
export function operationError(ctx, operation, error, targetId) {
  const scope = requestScope.getStore();
  return getDiagnostics(ctx).record({ event: 'assistant.tool.error', level: 'error', operation,
    parentRequestId: scope?.requestId, sessionRef: ref(targetId), error: errorDetails(error) });
}

export function getDiagnostics(ctx, metadata = {}, hostVersion) {
  if (services.has(ctx)) return services.get(ctx);
  const paths = runtimePaths(ctx), directory = join(paths.home, 'logs', 'session-editor');
  const file = join(directory, 'runtime.jsonl'), memory = [];
  const startedAt = new Date().toISOString();
  let writeFailure = null;
  const service = {
    warning(operation, error, sessionId) {
      return service.record({ event: 'operation.warning', level: 'warn', operation,
        parentRequestId: requestScope.getStore()?.requestId, sessionRef: ref(sessionId), error: errorDetails(error) });
    },
    clientError(operation, error, sessionId) {
      return service.record({event: 'client.error', level: 'error', operation, sessionRef: ref(sessionId), error: errorDetails(error)});
    },
    record(fields) {
      const entry = { id: randomUUID(), time: new Date().toISOString(), ...fields };
      memory.push(entry); if (memory.length > 200) memory.shift();
      try {
        mkdirSync(directory, { recursive: true });
        const line = JSON.stringify(entry) + '\n';
        if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > MAX_BYTES) {
          rmSync(file + '.' + ARCHIVES, { force: true });
          for (let n = ARCHIVES - 1; n >= 1; n--) if (existsSync(file + '.' + n)) renameSync(file + '.' + n, file + '.' + (n + 1));
          renameSync(file, file + '.1');
        }
        appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
        writeFailure = null;
      } catch (error) {
        const failure = code(error) ?? 'LOG_WRITE_FAILED';
        if (writeFailure !== failure) process.stderr.write('[session-editor] diagnostic log unavailable: ' + failure + '\n');
        writeFailure = failure;
      }
      return entry.id;
    },
    status() {
      return { enabled: true, directory: '<DSH_HOME>/logs/session-editor', homeSource: paths.source,
        maxFileBytes: MAX_BYTES, archives: ARCHIVES, memoryEntries: memory.length, writeFailure,
        redaction: 'metadata-and-call-frames-only', startedAt };
    },
    export() {
      const records = new Map(), warnings = [];
      for (let n = ARCHIVES; n >= 0; n--) {
        const path = file + (n ? '.' + n : '');
        try {
          if (!existsSync(path)) continue;
          if (statSync(path).size > MAX_BYTES) { warnings.push('oversized-log-skipped'); continue; }
          for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
            try { const record = JSON.parse(line); if (!validRecord(record)) throw new Error('invalid diagnostic record'); records.set(record.id, record); }
            catch { warnings.push('invalid-log-record-skipped'); }
          }
        } catch (error) { warnings.push(code(error) ?? 'LOG_READ_FAILED'); }
      }
      for (const record of memory) records.set(record.id, record);
      return { schemaVersion: 1, plugin: metadata, runtime: { dsh: hostVersion ?? 'unknown', node: process.version, platform: process.platform, arch: process.arch },
        logging: service.status(), warnings: [...new Set(warnings)], records: [...records.values()],
        excluded: ['message bodies', 'thinking', 'tool arguments/results', 'configuration', 'credentials', 'environment', 'absolute paths'] };
    },
    wrap(route, handler) {
      return async request => {
        const parentRequestId = requestScope.getStore()?.requestId;
        const scope = { requestId: randomUUID() }, start = performance.now();
        return requestScope.run(scope, async () => {
          let response, sessionRef;
          try {
            if (request.method === 'POST') {
              try { sessionRef = ref((await request.clone().json())?.id); } catch { /* Handler validates input. */ }
            } else sessionRef = ref(new URL(request.url).searchParams.get('id'));
            response = await handler(request);
          } catch (error) {
            captureError(error);
            response = Response.json({ error: '插件内部错误，请导出脱敏诊断。' }, { status: 500 });
          }
          const headers = new Headers(response.headers);
          headers.set('x-session-editor-request-id', scope.requestId);
          let body = response.body;
          if (response.status >= 400 && headers.get('content-type')?.includes('application/json')) {
            try { body = JSON.stringify({ ...await response.clone().json(), requestId: scope.requestId }); headers.delete('content-length'); } catch { /* Preserve non-JSON error bodies. */ }
          }
          service.record({ event: 'http.request', level: response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
            requestId: scope.requestId, parentRequestId, method: request.method, route, sessionRef,
            status: response.status, durationMs: Math.round(performance.now() - start), error: scope.error });
          return new Response(body, { status: response.status, statusText: response.statusText, headers });
        });
      };
    }
  };
  services.set(ctx, service);
  service.record({ event: 'plugin.started', level: 'info', plugin: metadata, homeSource: paths.source });
  return service;
}
