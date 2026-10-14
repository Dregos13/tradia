import { DataFreshness } from './DataFreshness';
export { sessionDateLabel } from './DataFreshness';
export function ProviderBanner({ offline = false }: { offline?: boolean }) {
  return (
    <aside className="provider-banners" aria-label="Avisos del mercado">
      <DataFreshness variant="banner" offline={offline} />
    </aside>
  );
}
