import { writeFileSync, appendFileSync } from 'node:fs';
export function makeLog(name: string) {
  const file = `/tmp/qa-cont/${name}.log`;
  writeFileSync(file, '');
  const note = (label: string, value?: unknown) => {
    const line = `[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    appendFileSync(file, line + '\n');
    console.log(line);
  };
  const step = async (label: string, fn: () => Promise<void>) => {
    note('STEP', label);
    try { await fn(); note('OK', label); } catch (e) { note('FAIL', `${label}: ${(e as Error).message.split('\n').slice(0, 6).join(' | ')}`); }
  };
  return { note, step };
}
