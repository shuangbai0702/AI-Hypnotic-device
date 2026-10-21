import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Run the shipped DSH footer projection, rather than duplicating its contract.
const source = readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('function isSessionEvent(event)');
const end = source.indexOf('/** Completed-turn footer Definition', start);
if (start < 0 || end < start) throw new Error('Native chat projection entry changed');
const tailData = runInNewContext(`(() => { ${source.slice(start, end)}; return tailData; })()`);

export function projectTurnFooters(events) {
  return events.filter(e => e.type === 'turn/end').map(end => {
    const location = { kind: 'turn', turn: { steps: [] } };
    const matches = events.filter(e => e.data?.turn === end.data.turn).map(event => ({ event, location }));
    // Use the native projection's replay path (no active start/state).
    return tailData({ matches });
  });
}
