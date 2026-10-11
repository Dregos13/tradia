import { DataFreshness } from './DataFreshness';
export { sessionDateLabel } from './DataFreshness';
export function ProviderBanner({ offline = false }: { offline?: boolean }) {
  return (
    <div className="provider-banners">
      <DataFreshness variant="banner" offline={offline} />
    </div>
  );
}
