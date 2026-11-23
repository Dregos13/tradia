import { useCallback, useEffect, useState } from 'react';

import type { ForwardSummary } from '../../../../shared/lab';
import { ForwardBoard } from './ForwardBoard';
import { ForwardDetailView } from './ForwardDetailView';
import { LabStudio } from './LabStudio';
import './lab.css';

/**
 * Laboratorio: idea → reglas con IA → backtest → prueba en vivo.
 * Rutas: `#laboratorio` y `#laboratorio/prueba/<id>`.
 */
export function LabPage() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => {
      setRoute(window.location.hash);
      const main = document.getElementById('contenido');
      if (main) main.scrollTop = 0;
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const detail = /^#laboratorio\/prueba\/(\d+)$/.exec(route);
  return (
    <div className="lab-page" data-layout-page="laboratorio">
      {detail ? <ForwardDetailView key={detail[1]} id={Number(detail[1])} /> : <LabHome />}
    </div>
  );
}

function LabHome() {
  const [rows, setRows] = useState<ForwardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await window.tradia.forward.list());
    } catch (cause) {
      setError((cause as Error)?.message ?? 'No se pudieron cargar las pruebas.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <header className="lab-intro">
        <h2>De una idea a una estrategia probada en el mercado</h2>
        <p>
          Escríbela como se la contarías a alguien. La IA la convierte en reglas exactas, la pruebas
          con uno o dos años de historia y, si te convence, la dejas operando con dinero ficticio
          sobre las velas reales de cada hora.
        </p>
      </header>
      <LabStudio
        onLaunched={(id) => {
          window.location.hash = `laboratorio/prueba/${id}`;
        }}
      />
      <ForwardBoard rows={rows} loading={loading} error={error} onRetry={() => void load()} />
    </>
  );
}
