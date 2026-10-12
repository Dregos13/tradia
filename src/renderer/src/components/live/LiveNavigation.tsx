export function LiveNavigation({
  label,
  href,
  onOpen,
}: {
  label: string;
  href: string;
  onOpen?: () => void;
}) {
  return onOpen ? (
    <button type="button" className="button" onClick={onOpen}>
      {label}
    </button>
  ) : (
    <a className="live-link" href={href}>
      {label}
    </a>
  );
}
