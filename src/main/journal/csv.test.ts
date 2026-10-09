import { describe, expect, it } from 'vitest';

import type { JournalEntry } from '../../shared/ipc';
import { CSV_BOM, JOURNAL_CSV_COLUMNS, journalEntriesToCsv } from './csv';

const entry = (patch: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 1,
  type: 'senal',
  createdAt: '2026-10-09T15:42:08.123Z',
  ticker: 'AAPL',
  strategies: [{ strategyId: 7, name: 'Tendencia SMA', version: 3 }],
  reason: 'Cierre sobre SMA 50',
  dataUsed: { barDate: '2026-10-08' },
  result: 'aprobada',
  errors: [],
  ruleChecks: [],
  signalId: 5,
  ...patch,
});

/** Parser mínimo RFC 4180 para comprobar el CSV celda a celda. */
const parseCsv = (csv: string): string[][] => {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const text = csv.startsWith(CSV_BOM) ? csv.slice(CSV_BOM.length) : csv;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      field = '';
      row = [];
      i += 1;
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

describe('journal CSV (RFC 4180, UTF-8 con BOM)', () => {
  it('el diario vacío exporta un CSV válido con solo la cabecera', () => {
    const csv = journalEntriesToCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([...JOURNAL_CSV_COLUMNS]);
  });

  it('escapa comas, comillas y saltos de línea duplicando las comillas', () => {
    const csv = journalEntriesToCsv([
      entry({
        reason: 'Ruptura con "gap", volumen\npor encima de 1,4×',
        errors: ['error, con coma', 'error "citado"'],
      }),
    ]);
    // Comprobación en crudo: comillas dobladas y campo con salto entre comillas.
    expect(csv).toContain('"Ruptura con ""gap"", volumen\npor encima de 1,4×"');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    const header = rows[0]!;
    const record = rows[1]!;
    expect(record[header.indexOf('motivo')]).toBe('Ruptura con "gap", volumen\npor encima de 1,4×');
    expect(record[header.indexOf('errores')]).toBe(
      JSON.stringify(['error, con coma', 'error "citado"']),
    );
  });

  it('usa CRLF como separador de registros y fecha ISO en la columna fecha', () => {
    const csv = journalEntriesToCsv([entry(), entry({ id: 2 })]);
    const body = csv.slice(CSV_BOM.length);
    expect(body).toContain('\r\n');
    expect(body.split('\r\n').filter((line) => line !== '')).toHaveLength(3);
    const rows = parseCsv(csv);
    const fechaIdx = rows[0]!.indexOf('fecha');
    expect(rows[1]![fechaIdx]).toBe('2026-10-09T15:42:08.123Z');
  });

  it('serializa estrategias legibles, datos y reglas en JSON y deja huecos los nulos', () => {
    const csv = journalEntriesToCsv([
      entry({
        strategies: [
          { strategyId: 7, name: 'Tendencia SMA', version: 3 },
          { strategyId: 9, name: 'Momentum', version: 1 },
        ],
        ruleChecks: [
          { code: 'MAX_DRAWDOWN', label: 'Drawdown', cumplida: false, observed: '11', limit: '10' },
        ],
        signalId: null,
        result: null,
        dataUsed: null,
      }),
    ]);
    const rows = parseCsv(csv);
    const header = rows[0]!;
    const record = rows[1]!;
    expect(record[header.indexOf('estrategias')]).toBe('Tendencia SMA v3; Momentum v1');
    expect(JSON.parse(record[header.indexOf('reglas')]!)).toEqual([
      { code: 'MAX_DRAWDOWN', label: 'Drawdown', cumplida: false, observed: '11', limit: '10' },
    ]);
    expect(record[header.indexOf('senal_id')]).toBe('');
    expect(record[header.indexOf('resultado')]).toBe('');
    expect(record[header.indexOf('datos_usados')]).toBe('');
  });
});
