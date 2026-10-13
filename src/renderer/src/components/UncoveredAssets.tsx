import { useRef, useState } from 'react';
import type { UncoveredAsset } from '../../../shared/ipc';
import { DataStateIcon } from './DataStateIcon';
import { notifyWatchlistChanged } from '../hooks/watchlistEvents';
import { fxPairForCurrency } from '../../../shared/fx';
import { assetSymbol } from './assetPresentation';

export function UncoveredAssets({
  assets,
  current,
  offline,
  reload,
  onActionCompleted,
}: {
  assets: UncoveredAsset[];
  current: boolean;
  offline: boolean;
  reload: () => Promise<void>;
  onActionCompleted: (message: string) => void;
}) {
  const locked = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (asset: UncoveredAsset, replace: boolean) => {
    if (locked.current) return;
    locked.current = true;
    setPending(asset.ticker);
    setError(null);
    let added = false;
    let removed = false;
    try {
      if (replace && asset.suggestion) {
        const list = await window.tradia.watchlist.list();
        if (!list.some((row) => row.ticker === asset.suggestion)) {
          const saved = await window.tradia.watchlist.add(asset.suggestion);
          if (!saved.added) throw new Error('La alternativa no se añadió.');
          added = true;
        }
      }
      await window.tradia.watchlist.remove(asset.ticker);
      removed = true;
      onActionCompleted(
        replace
          ? `${asset.ticker} se cambió por ${asset.suggestion}.`
          : `${asset.ticker} se ha quitado de tu lista.`,
      );
    } catch {
      setError(
        added
          ? `${asset.suggestion} se añadió, pero no pudimos quitar ${asset.ticker}. Vuelve a pulsar «Quitar de la lista».`
          : `No pudimos ${replace ? 'cambiar' : 'quitar'} ${asset.ticker}. Tu lista se conserva. Inténtalo de nuevo.`,
      );
    } finally {
      if (added || removed) notifyWatchlistChanged();
      // A push during the mutation must not replace its result. Re-read once it finishes.
      await reload();
      locked.current = false;
      setPending(null);
    }
  };
  return (
    <section className="data-uncovered" aria-label="Activos sin datos">
      <h2>Activos sin datos</h2>
      <p className="data-uncovered-count">
        {assets.length === 1
          ? '1 activo necesita atención'
          : `${assets.length} activos necesitan atención`}
      </p>
      <ul className="data-uncovered-list">
        {assets.map((asset) => (
          <li className="data-uncovered-asset" key={asset.ticker}>
            <div className="data-uncovered-description" role="status">
              <h3>
                <DataStateIcon kind="uncovered" />
                {asset.ticker} no está disponible en Tiingo
              </h3>
              <p>
                {current
                  ? assets.length === 1
                    ? `Solo ${asset.ticker} queda en pausa. Los demás activos, predicciones y señales siguen al día.`
                    : `${asset.ticker} queda en pausa. Los activos con datos, predicciones y señales siguen al día.`
                  : `No se calculan nuevas predicciones ni señales para ${asset.ticker} porque Tiingo no cubre este símbolo.`}
              </p>
              {offline && (
                <p>
                  Sin conexión a internet. Puedes quitar el activo; comprueba la alternativa cuando
                  vuelva la red.
                </p>
              )}
            </div>
            <div className="data-freshness-actions">
              {asset.suggestion && (
                <button
                  className="button primary"
                  disabled={pending !== null || offline}
                  aria-label={`Cambiar por ${asset.suggestion} para ${asset.ticker}`}
                  onClick={() => void change(asset, true)}
                >
                  Cambiar por {asset.suggestion}
                </button>
              )}
              <button
                className={`button${asset.suggestion ? '' : ' primary'}`}
                disabled={pending !== null}
                aria-label={`Quitar ${asset.ticker} de la lista`}
                onClick={() => void change(asset, false)}
              >
                Quitar de la lista
              </button>
            </div>
            <details>
              <summary>
                Por qué ocurre<span className="sr-only"> con {asset.ticker}</span>
              </summary>
              <p>
                Tiingo ofrece precios diarios de acciones y de fondos cotizados (ETF) de EE. UU.;{' '}
                {asset.ticker} no es un símbolo disponible en este conector. Puedes quitarlo de la
                lista{asset.suggestion ? ` o cambiarlo por ${asset.suggestion}` : ''}.
              </p>
              {fxPairForCurrency(asset.ticker) && (
                <p>
                  Para seguir el tipo de cambio, añade{' '}
                  {assetSymbol(fxPairForCurrency(asset.ticker) ?? '')} desde la lista de
                  seguimiento: es el par que Tiingo sí cubre. Solo tiene datos de lunes a viernes.
                </p>
              )}
            </details>
          </li>
        ))}
      </ul>
      {pending && <p role="status">Actualizando la lista para {pending}…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
