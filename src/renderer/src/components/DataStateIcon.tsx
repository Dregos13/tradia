export function DataStateIcon({ kind }: { kind: 'ok' | 'pending' | 'warning' | 'uncovered' }) {
  return (
    <svg
      className="data-state-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      {kind === 'ok' ? (
        <path d="m7 12 3 3 7-7" />
      ) : kind === 'uncovered' ? (
        <path d="m6 18 12-12" />
      ) : kind === 'pending' ? (
        <path d="M12 6v6l4 2" />
      ) : (
        <>
          <path d="M12 7v6" />
          <path d="M12 17h.01" />
        </>
      )}
    </svg>
  );
}
