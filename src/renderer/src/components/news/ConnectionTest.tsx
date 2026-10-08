import { connectionError, type ConnectionState } from './sourceModel';
export function ConnectionTest({
  state,
  disabled,
  onTest,
}: {
  state: ConnectionState;
  disabled?: boolean;
  onTest: () => void;
}) {
  return (
    <div className="source-test">
      <button
        type="button"
        className="button"
        disabled={disabled || state.testing}
        aria-busy={state.testing}
        onClick={onTest}
      >
        {state.testing ? 'Probando conexión…' : 'Probar conexión'}
      </button>
      {state.result && (
        <p
          className={`settings-message ${state.result.ok ? 'success' : 'error'}`}
          role={state.result.ok ? 'status' : 'alert'}
        >
          {state.result.ok
            ? `Conexión correcta · ${state.result.itemsFound} titulares encontrados en el feed`
            : connectionError(state.result.error)}
        </p>
      )}
    </div>
  );
}
