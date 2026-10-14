import { DataFreshness } from './DataFreshness';
export { sessionDateLabel } from './DataFreshness';
export function ProviderBanner({ offline = false }: { offline?: boolean }) {
  return (
    <div className="provider-banners" data-layout-block="avisos-datos">
      <DataFreshness variant="banner" offline={offline} />
    </div>
  );
}
