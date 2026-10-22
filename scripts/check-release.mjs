import { spawnSync } from 'node:child_process';

const allowed = [
  /^(?:\.gitignore|README\.md|package\.json)$/,
  /^docs\/(?:GITHUB-PUBLISH-PLAN|VALIDATION|RELIABILITY-PLAN|RELIABILITY-VALIDATION)\.md$/,
  /^scripts\/check-release\.mjs$/,
  /^packaging\/windows\/(?:Build\.ps1|Installer\.ps1|Discovery\.ps1|Desktop\.ps1|Launcher\.cs|README\.md)$/,
  /^plugins\/dsh-session-editor\/(?:package\.json|README\.md|AGENT\.md|install\.mjs|host-adapter\.mjs)$/,
  /^plugins\/dsh-session-editor\/lib\/[a-z-]+\.(?:js|mjs)$/,
  /^tests\/(?:memory-workbench|workbench-client|memory-assistant|context-coverage|session-editor-regression|assistant-edit-wire|memory-ergonomics-client|native-chat-projection|storage-integrity|runtime-diagnostics|installer-transaction|desktop-installation|native-session-e2e)\.mjs$/,
  /^tests\/windows-(?:installation-e2e|desktop-e2e|discovery|health-rollback)\.ps1$/,
];
const patterns = [
  ['personal Windows path', /[A-Z]:[\\/](?:Users|MYCODE)[\\/]/i],
  ['personal Unix home', /\/(?:home|Users)\/[a-z0-9_.-]+\//i],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['API secret', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential in URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/i],
  ['literal bearer credential', /Bearer\s+[A-Za-z0-9_.-]{20,}/i],
  ['email address', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot read Git index: ' + result.stderr.trim());
  return result.stdout;
}
const files = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked release files to inspect');
const failures = [];
for (const file of files) {
  if (!allowed.some(pattern => pattern.test(file))) failures.push(`${file}: outside release allowlist`);
  const source = git('show', ':' + file);
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) failures.push(`${file}: ${label}`);
  }
}
if (failures.length) {
  // Report locations and categories, never matched secrets.
  process.stderr.write(failures.join('\n') + '\n');
  process.exitCode = 1;
} else {
  console.log(`Release index checked: ${files.length} files; allowlist and sensitive-content checks passed.`);
}
