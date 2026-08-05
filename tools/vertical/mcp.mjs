// Reusable MCP stdio driver: spawn a fresh server, call tools, exit.
import { spawn } from 'node:child_process';
export function open(runSh) {
  const child = spawn('/bin/sh', [runSh], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', d => { const s = String(d).trim(); if (s && !/ready|Warning/i.test(s)) console.error('[e]', s); });
  let n = 1, buf = ''; const pend = new Map();
  child.stdout.on('data', c => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
      try { const m = JSON.parse(l); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } catch {}
    }
  });
  const rpc = (method, params, t = 300000) => {
    const id = n++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      pend.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
      setTimeout(() => rej(new Error('client timeout ' + method)), t);
    });
  };
  const call = async (name, args = {}, t) => {
    const r = await rpc('tools/call', { name, arguments: args }, t);
    const txt = r?.content?.[0]?.text ?? '';
    if (r?.isError) return { _error: txt };
    try { return JSON.parse(txt); } catch { return txt; }
  };
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'crm-build', version: '0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  })();
  return { ready, call, close: () => child.kill() };
}
