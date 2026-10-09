/**
 * Persistencia del motor de riesgo (fase 3) — `risk_limits`, `risk_vetoes`,
 * `risk_portfolio_positions` y `risk_equity_history` (migración 007).
 *
 * Es el ÚNICO escritor de las tablas de riesgo: la IA, las estrategias y
 * el backtest no pueden importarlo (ver `eslint.config.mjs`,
 * `no-restricted-imports`); reciben instantáneas de solo lectura a través
 * de la pasarela. Los límites solo cambian por `risk:set-limits` y los
 * vetos solo se escriben desde el motor (`engine.ts`).
 *
 * También construye la `PortfolioSnapshot` que consumen las reglas de
 * cartera: posiciones abiertas y curva de capital propias, más metadatos
 * de mercado leídos de las tablas de fase 1 (`bars` para precio de marca,
 * volumen medio de 20 días y rendimientos diarios; `macro_observations`
 * para el último VIX). La cartera es simulada («paper»): sin siembra el
 * capital por defecto es `RISK_PAPER_EQUITY_DEFAULT`.
 */

import type Database from 'better-sqlite3';

import {
  LIQUIDITY_AVG_VOLUME_DAYS,
  RISK_DEFAULTS,
  RISK_VETOES_MAX_LIMIT,
  type LoggedRiskDecision,
  type RiskDecisionReason,
  type RiskLimits,
  type RiskVeto,
  type RiskVetoesQuery,
  type SeedPortfolioRequest,
  type SeedPortfolioResult,
  type SignalDirection,
  type SignalIntent,
} from '../../shared/ipc';
import type {
  EquityHistoryPoint,
  InstrumentInfo,
  NewPaperPosition,
  PaperCloseRequest,
  PaperCloseResult,
  PaperExitReason,
  PaperPositionRecord,
  PortfolioPosition,
  PortfolioSnapshot,
} from './portfolio';

/** Capital de arranque de la cartera simulada cuando aún no hay curva. */
export const RISK_PAPER_EQUITY_DEFAULT = 100_000;

/** Días de cierres que se piden para cubrir la ventana de correlación (60 rendimientos). */
const RETURN_CLOSES_FETCHED = 61;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Lo que el motor pide persistir por cada motivo de veto o reducción. */
export interface RiskVetoRecord {
  signal: SignalIntent;
  decision: LoggedRiskDecision;
  reason: RiskDecisionReason;
  /** Tamaño calculado antes del veto (0 cuando no procede). */
  size: number;
}

interface RiskLimitsRow {
  risk_per_trade_pct: number;
  min_reward_risk_ratio: number;
  max_daily_loss_pct: number;
  max_weekly_loss_pct: number;
  max_monthly_loss_pct: number;
  max_drawdown_pct: number;
  max_open_positions: number;
  max_asset_exposure_pct: number;
  max_sector_exposure_pct: number;
  max_currency_exposure_pct: number;
  max_correlation: number;
  max_leverage: number;
  max_liquidity_pct: number;
}

interface RiskVetoRow {
  id: number;
  senal: string;
  ticker: string;
  decision: LoggedRiskDecision;
  codigo: string;
  motivo: string;
  detalles: string;
  tamano: number;
  creado_en: string;
}

interface PositionRow {
  id: number;
  ticker: string;
  direccion: string;
  entrada: number;
  stop: number | null;
  objetivo: number | null;
  tamano: number;
  sector: string | null;
  divisa: string;
  senal_id: number | null;
  vela_apertura: string | null;
  salida: number | null;
  motivo_salida: string | null;
  abierta_en: string;
  cerrada_en: string | null;
}

interface EquityRow {
  fecha: string;
  capital: number;
}

interface BarRow {
  close: number;
  adj_close: number | null;
  volume: number;
  adj_volume: number | null;
}

export interface RiskRepository {
  /**
   * Límites vigentes como instantánea congelada. Si la fila singleton no
   * existe todavía, escribe `RISK_DEFAULTS` (primera lectura) y los
   * devuelve; es lo único que escribe fuera de `setLimits`/`appendVeto`/la
   * cartera simulada.
   */
  getLimits(): RiskLimits;
  /**
   * Sustituye los límites. La validación de márgenes duros vive en el
   * servicio (`risk:set-limits`); aquí llegan ya comprobados y aun así los
   * CHECK de la tabla los vuelven a exigir.
   */
  setLimits(limits: RiskLimits): RiskLimits;
  /** Registra un motivo de veto/reducción y devuelve la fila creada. */
  appendVeto(record: RiskVetoRecord): RiskVeto;
  /** Registro de vetos, más reciente primero, con filtros del contrato. */
  listVetoes(query?: RiskVetoesQuery): RiskVeto[];
  /**
   * Instantánea de la cartera simulada en `nowIso`: posiciones abiertas
   * con precio de marca, curva de capital completa, metadatos (volumen
   * medio 20 días) y rendimientos diarios de los tickers en cartera más
   * `extraTickers` (p. ej. el de la señal evaluada).
   */
  buildSnapshot(nowIso: string, extraTickers?: readonly string[]): PortfolioSnapshot;
  /** Tickers con posición abierta (contexto de cautela 'resultados'). */
  openTickers(): readonly string[];
  /** Último valor conocido del VIX (serie VIXCLS); null sin dato. */
  lastVix(): number | null;
  /**
   * Gancho E2E `risk:seed-portfolio`: sustituye la cartera simulada por
   * las posiciones y la curva de capital pedidas, en una transacción.
   */
  seedPortfolio(request: SeedPortfolioRequest, nowIso: string): SeedPortfolioResult;
  /**
   * Abre una posición simulada (fase 4): la señal aprobada fija entrada,
   * stop, objetivo y tamaño; `signalId`/`openedOnBar` la enlazan con ella
   * para la trazabilidad. Devuelve la fila creada.
   */
  openPaperPosition(input: NewPaperPosition): PaperPositionRecord;
  /** Posiciones abiertas (`cerrada_en IS NULL`), opcionalmente de un activo. */
  listPaperPositions(ticker?: string): PaperPositionRecord[];
  /**
   * Liquida una posición abierta en una transacción: anota el P&L
   * realizado en la curva de capital (`risk_equity_history`) y marca la
   * fila con `cerrada_en`/`salida`/`motivo_salida`. Devuelve null si la
   * posición no existe o ya estaba cerrada (idempotente).
   */
  settlePaperPosition(request: PaperCloseRequest): PaperCloseResult | null;
}

// ---------------------------------------------------------------------------
// Implementación
// ---------------------------------------------------------------------------

const normalizeTicker = (ticker: string): string => ticker.trim().toUpperCase();

function rowToLimits(row: RiskLimitsRow): RiskLimits {
  return {
    riskPerTradePct: row.risk_per_trade_pct,
    minRewardRiskRatio: row.min_reward_risk_ratio,
    maxDailyLossPct: row.max_daily_loss_pct,
    maxWeeklyLossPct: row.max_weekly_loss_pct,
    maxMonthlyLossPct: row.max_monthly_loss_pct,
    maxDrawdownPct: row.max_drawdown_pct,
    maxOpenPositions: row.max_open_positions,
    maxAssetExposurePct: row.max_asset_exposure_pct,
    maxSectorExposurePct: row.max_sector_exposure_pct,
    maxCurrencyExposurePct: row.max_currency_exposure_pct,
    maxCorrelation: row.max_correlation,
    maxLeverage: row.max_leverage,
    maxLiquidityPct: row.max_liquidity_pct,
  };
}

function rowToPaperPosition(row: PositionRow): PaperPositionRecord {
  return {
    id: row.id,
    ticker: row.ticker,
    direction: row.direccion as SignalDirection,
    entry: row.entrada,
    stop: row.stop,
    target: row.objetivo,
    size: row.tamano,
    sector: row.sector,
    currency: row.divisa,
    signalId: row.senal_id,
    openedOnBar: row.vela_apertura,
    openedAt: row.abierta_en,
    closedAt: row.cerrada_en,
    exit: row.salida,
    exitReason: row.motivo_salida as PaperExitReason | null,
  };
}

function rowToVeto(row: RiskVetoRow): RiskVeto {
  return {
    id: row.id,
    signal: JSON.parse(row.senal) as SignalIntent,
    ticker: row.ticker,
    decision: row.decision,
    code: row.codigo as RiskVeto['code'],
    message: row.motivo,
    details: JSON.parse(row.detalles) as Record<string, number | string>,
    size: row.tamano,
    createdAt: row.creado_en,
  };
}

export function createRiskRepository(db: Database.Database): RiskRepository {
  // -- Límites --------------------------------------------------------------

  const selectLimits = db.prepare('SELECT * FROM risk_limits WHERE id = 1');
  const upsertLimits = db.prepare(
    `INSERT INTO risk_limits (
       id, risk_per_trade_pct, min_reward_risk_ratio,
       max_daily_loss_pct, max_weekly_loss_pct, max_monthly_loss_pct,
       max_drawdown_pct, max_open_positions,
       max_asset_exposure_pct, max_sector_exposure_pct, max_currency_exposure_pct,
       max_correlation, max_leverage, max_liquidity_pct, updated_at
     ) VALUES (
       1, @riskPerTradePct, @minRewardRiskRatio,
       @maxDailyLossPct, @maxWeeklyLossPct, @maxMonthlyLossPct,
       @maxDrawdownPct, @maxOpenPositions,
       @maxAssetExposurePct, @maxSectorExposurePct, @maxCurrencyExposurePct,
       @maxCorrelation, @maxLeverage, @maxLiquidityPct, @updatedAt
     )
     ON CONFLICT (id) DO UPDATE SET
       risk_per_trade_pct = excluded.risk_per_trade_pct,
       min_reward_risk_ratio = excluded.min_reward_risk_ratio,
       max_daily_loss_pct = excluded.max_daily_loss_pct,
       max_weekly_loss_pct = excluded.max_weekly_loss_pct,
       max_monthly_loss_pct = excluded.max_monthly_loss_pct,
       max_drawdown_pct = excluded.max_drawdown_pct,
       max_open_positions = excluded.max_open_positions,
       max_asset_exposure_pct = excluded.max_asset_exposure_pct,
       max_sector_exposure_pct = excluded.max_sector_exposure_pct,
       max_currency_exposure_pct = excluded.max_currency_exposure_pct,
       max_correlation = excluded.max_correlation,
       max_leverage = excluded.max_leverage,
       max_liquidity_pct = excluded.max_liquidity_pct,
       updated_at = excluded.updated_at`,
  );

  const writeLimits = (limits: RiskLimits): void => {
    upsertLimits.run({ ...limits, updatedAt: new Date().toISOString() });
  };

  // -- Vetos ----------------------------------------------------------------

  const insertVeto = db.prepare(
    `INSERT INTO risk_vetoes (senal, ticker, decision, codigo, motivo, detalles, tamano)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const vetoById = db.prepare('SELECT * FROM risk_vetoes WHERE id = ?');

  // -- Cartera simulada -----------------------------------------------------

  const listOpenPositions = db.prepare(
    `SELECT * FROM risk_portfolio_positions WHERE cerrada_en IS NULL ORDER BY id`,
  );
  const insertPosition = db.prepare(
    `INSERT INTO risk_portfolio_positions
       (ticker, direccion, entrada, stop, objetivo, tamano, sector, divisa, abierta_en, cerrada_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deletePositions = db.prepare('DELETE FROM risk_portfolio_positions');
  const insertPaperPosition = db.prepare(
    `INSERT INTO risk_portfolio_positions
       (ticker, direccion, entrada, stop, objetivo, tamano, sector, divisa,
        senal_id, vela_apertura, abierta_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listOpenPaperRows = db.prepare(
    'SELECT * FROM risk_portfolio_positions WHERE cerrada_en IS NULL ORDER BY id',
  );
  const listOpenPaperRowsByTicker = db.prepare(
    'SELECT * FROM risk_portfolio_positions WHERE cerrada_en IS NULL AND ticker = ? ORDER BY id',
  );
  const paperRowById = db.prepare('SELECT * FROM risk_portfolio_positions WHERE id = ?');
  const closePaperRow = db.prepare(
    `UPDATE risk_portfolio_positions
     SET cerrada_en = ?, salida = ?, motivo_salida = ? WHERE id = ?`,
  );
  const listEquity = db.prepare('SELECT fecha, capital FROM risk_equity_history ORDER BY fecha');
  const insertEquity = db.prepare(
    `INSERT INTO risk_equity_history (fecha, capital) VALUES (?, ?)
     ON CONFLICT (fecha) DO UPDATE SET capital = excluded.capital`,
  );
  const deleteEquity = db.prepare('DELETE FROM risk_equity_history');
  const latestEquityStmt = db.prepare(
    'SELECT capital FROM risk_equity_history ORDER BY fecha DESC LIMIT 1',
  );

  // -- Metadatos de mercado (tablas de fase 1, solo lectura) ----------------

  const lastBars = db.prepare(
    'SELECT close, adj_close, volume, adj_volume FROM bars WHERE ticker = ? ORDER BY fecha DESC LIMIT ?',
  );
  const lastVixStmt = db.prepare(
    `SELECT valor FROM macro_observations WHERE serie_id = 'VIXCLS' ORDER BY fecha DESC LIMIT 1`,
  );

  /** Último cierre conocido del ticker (precio de marca de las posiciones). */
  const lastClose = (ticker: string): number | null => {
    const row = lastBars.get(ticker, 1) as BarRow | undefined;
    return row?.close ?? null;
  };

  /** Volumen medio de los últimos `LIQUIDITY_AVG_VOLUME_DAYS` días; null si no hay barras. */
  const avgVolume20d = (ticker: string): number | null => {
    const rows = lastBars.all(ticker, LIQUIDITY_AVG_VOLUME_DAYS) as BarRow[];
    if (rows.length === 0) return null;
    const sum = rows.reduce((total, row) => total + (row.adj_volume ?? row.volume), 0);
    return sum / rows.length;
  };

  /**
   * Rendimientos diarios (fracciones, p. ej. 0,023 = 2,3 %) sobre el
   * cierre ajustado cuando existe: la ventana cubre los
   * `CORRELATION_WINDOW_DAYS` del contrato y alimenta el detector de
   * saltos de precio anómalos de la parada.
   */
  const dailyReturns = (ticker: string): number[] => {
    const rows = lastBars.all(ticker, RETURN_CLOSES_FETCHED) as BarRow[];
    // DESC → ASC para calcular rendimientos en orden temporal.
    const closes = rows.map((row) => row.adj_close ?? row.close).reverse();
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const prev = closes[i - 1]!;
      const curr = closes[i]!;
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
        returns.push(curr / prev - 1);
      }
    }
    return returns;
  };

  return {
    getLimits: () => {
      const row = selectLimits.get() as RiskLimitsRow | undefined;
      if (row === undefined) {
        writeLimits(RISK_DEFAULTS);
        return Object.freeze({ ...RISK_DEFAULTS });
      }
      return Object.freeze(rowToLimits(row));
    },

    setLimits: (limits) => {
      writeLimits(limits);
      return Object.freeze({ ...limits });
    },

    appendVeto: (record) => {
      const result = insertVeto.run(
        JSON.stringify(record.signal),
        normalizeTicker(record.signal.ticker),
        record.decision,
        record.reason.code,
        record.reason.message,
        JSON.stringify(record.reason.details),
        record.size,
      );
      const row = vetoById.get(Number(result.lastInsertRowid)) as RiskVetoRow;
      return rowToVeto(row);
    },

    listVetoes: (query = {}) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (query.rule !== undefined) {
        clauses.push('codigo = ?');
        params.push(query.rule);
      }
      if (query.decision !== undefined) {
        clauses.push('decision = ?');
        params.push(query.decision);
      }
      if (query.ticker !== undefined) {
        clauses.push('ticker = ?');
        params.push(normalizeTicker(query.ticker));
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(query.limit ?? RISK_VETOES_MAX_LIMIT, RISK_VETOES_MAX_LIMIT);
      const offset = query.offset ?? 0;
      const rows = db
        .prepare(`SELECT * FROM risk_vetoes ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as RiskVetoRow[];
      return rows.map(rowToVeto);
    },

    buildSnapshot: (nowIso, extraTickers = []) => {
      const positions = (listOpenPositions.all() as PositionRow[]).map((row): PortfolioPosition => {
        const mark = lastClose(row.ticker);
        return {
          ticker: row.ticker,
          direction: row.direccion as PortfolioPosition['direction'],
          entry: row.entrada,
          size: row.tamano,
          ...(mark !== null ? { markPrice: mark } : {}),
          ...(row.sector !== null ? { sector: row.sector } : {}),
          currency: row.divisa,
        };
      });

      const tickers = [
        ...new Set([...positions.map((p) => p.ticker), ...extraTickers.map(normalizeTicker)]),
      ];
      const instruments: Record<string, InstrumentInfo> = {};
      const returns: Record<string, readonly number[]> = {};
      for (const ticker of tickers) {
        // El sector y la divisa los resuelve el evaluador (universo local o
        // la propia posición); aquí solo aporta el dato de mercado.
        instruments[ticker] = {
          sector: null,
          currency: 'USD',
          avgDailyVolume20d: avgVolume20d(ticker),
        };
        returns[ticker] = dailyReturns(ticker);
      }

      const latestEquity = (latestEquityStmt.get() as { capital: number } | undefined)?.capital;
      const equityRows = listEquity.all() as EquityRow[];

      return {
        now: nowIso,
        equity: latestEquity ?? RISK_PAPER_EQUITY_DEFAULT,
        positions,
        equityHistory: equityRows.map((row): EquityHistoryPoint => ({
          at: row.fecha,
          equity: row.capital,
        })),
        instruments,
        dailyReturns: returns,
      };
    },

    openTickers: () => (listOpenPositions.all() as PositionRow[]).map((row) => row.ticker),

    lastVix: () => (lastVixStmt.get() as { valor: number } | undefined)?.valor ?? null,

    seedPortfolio: (request, nowIso) => {
      const positions = request.positions ?? [];
      const history = [...(request.equityHistory ?? [])];
      if (request.equity !== undefined) history.push({ at: nowIso, equity: request.equity });

      db.transaction(() => {
        deletePositions.run();
        deleteEquity.run();
        for (const position of positions) {
          insertPosition.run(
            normalizeTicker(position.ticker),
            position.direction,
            position.entry,
            position.stop ?? null,
            position.target ?? null,
            position.size,
            position.sector ?? null,
            position.currency ?? 'USD',
            position.openedAt ?? nowIso,
            position.closedAt ?? null,
          );
        }
        for (const point of history) {
          insertEquity.run(point.at, point.equity);
        }
      })();

      return {
        openPositions: positions.filter((p) => p.closedAt === undefined).length,
        equityPoints: history.length,
      };
    },

    openPaperPosition: (input) => {
      const result = insertPaperPosition.run(
        normalizeTicker(input.ticker),
        input.direction,
        input.entry,
        input.stop,
        input.target,
        input.size,
        input.sector,
        input.currency,
        input.signalId,
        input.openedOnBar,
        input.openedAt,
      );
      const row = paperRowById.get(Number(result.lastInsertRowid)) as PositionRow;
      return rowToPaperPosition(row);
    },

    listPaperPositions: (ticker) => {
      const rows =
        ticker === undefined
          ? (listOpenPaperRows.all() as PositionRow[])
          : (listOpenPaperRowsByTicker.all(normalizeTicker(ticker)) as PositionRow[]);
      return rows.map(rowToPaperPosition);
    },

    settlePaperPosition: (request) =>
      db.transaction((): PaperCloseResult | null => {
        const row = paperRowById.get(request.positionId) as PositionRow | undefined;
        if (row === undefined || row.cerrada_en !== null) return null;
        const sign = row.direccion === 'largo' ? 1 : -1;
        const pnl = (request.exit - row.entrada) * row.tamano * sign;
        const previous =
          (latestEquityStmt.get() as { capital: number } | undefined)?.capital ??
          RISK_PAPER_EQUITY_DEFAULT;
        const equity = previous + pnl;
        insertEquity.run(request.closedAt, equity);
        closePaperRow.run(request.closedAt, request.exit, request.exitReason, request.positionId);
        const updated = paperRowById.get(request.positionId) as PositionRow;
        return {
          position: rowToPaperPosition(updated),
          exit: request.exit,
          exitReason: request.exitReason,
          pnl,
          equity,
        };
      })(),
  };
}
