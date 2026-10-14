// Renderer-only notification for mutations initiated outside the watchlist form.
const WATCHLIST_CHANGED = 'tradia:watchlist-changed';

export function notifyWatchlistChanged() {
  window.dispatchEvent(new Event(WATCHLIST_CHANGED));
}

export function subscribeWatchlistChanged(listener: () => void) {
  window.addEventListener(WATCHLIST_CHANGED, listener);
  return () => window.removeEventListener(WATCHLIST_CHANGED, listener);
}
