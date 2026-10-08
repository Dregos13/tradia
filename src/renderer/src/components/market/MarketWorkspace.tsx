import { useEffect, useState } from 'react';
import { dataStatusKey } from '../../../../shared/ipc';
import { useMarketData } from '../../hooks/useMarketData';
import { PriceChart } from './PriceChart';
import { Watchlist } from './Watchlist';
import './market.css';

export function MarketWorkspace() {
  const [selected, setSelected] = useState<string | null>(null);
  const data = useMarketData(selected ? { ticker: selected } : undefined);
  useEffect(() => {
    if (!selected || !data.watchlist.some((item) => item.ticker === selected)) {
      setSelected(data.watchlist[0]?.ticker ?? null);
    }
  }, [data.watchlist, selected]);
  const result = data.bars?.ticker === selected ? data.bars : null;
  const status = selected
    ? data.statuses.find((entry) => entry.key === dataStatusKey.ticker(selected))
    : undefined;
  return (
    <div className="market-workspace">
      {data.statusError && (
        <p className="market-error" role="alert">
          {data.statusError}
        </p>
      )}
      {data.error && (
        <div className="market-error" role="alert">
          <p>{data.error}</p>
          <button className="button" onClick={() => void data.reload()}>
            Reintentar
          </button>
        </div>
      )}
      <Watchlist
        items={data.watchlist}
        statuses={data.statuses}
        simulated={data.statuses.some((entry) => entry.key === 'provider:simulated')}
        selected={selected}
        onSelect={setSelected}
        onChanged={data.reload}
      />
      {selected ? (
        result ? (
          <PriceChart result={result} status={status} loading={data.loading} />
        ) : (
          <p role="status">Consultando histórico de {selected}…</p>
        )
      ) : data.loading ? (
        <p role="status">Consultando lista…</p>
      ) : (
        <div className="data-empty">
          <h3>Elige un activo para empezar.</h3>
          <p>Añade un ticker para ver sus precios diarios, medias móviles, RSI y ATR.</p>
        </div>
      )}
    </div>
  );
}
