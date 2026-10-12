import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import tokens from '../../design/onboarding.tokens.json';
import { TOUR_STEPS } from './tourSteps';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
const margin = parseInt(tokens.size.viewportMargin);
const offset = parseInt(tokens.size.popoverOffset);
const padding = parseInt(tokens.spacing['2']);

export function useTourAnchor(step: number, dialog: RefObject<HTMLDivElement | null>) {
  const current = TOUR_STEPS[step - 1]!;
  const [anchor, setAnchor] = useState<{ step: number; rect: Rect | null; loading: boolean }>({
    step,
    rect: null,
    loading: Boolean(current.anchor),
  });
  const [position, setPosition] = useState<CSSProperties>({});
  const rect = anchor.step === step ? anchor.rect : null;
  const loading = anchor.step === step ? anchor.loading : Boolean(current.anchor);
  useEffect(() => {
    if (current.route) window.location.hash = current.route;
    if (!current.anchor) {
      setAnchor({ step, rect: null, loading: false });
      return;
    }
    setAnchor({ step, rect: null, loading: true });
    let target: HTMLElement | null = null;
    let resize: ResizeObserver | undefined;
    const measure = () => {
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      const left = Math.max(0, bounds.left - padding);
      const top = Math.max(0, bounds.top - padding);
      const right = Math.min(window.innerWidth, bounds.right + padding);
      const bottom = Math.min(window.innerHeight, bounds.bottom + padding);
      setAnchor({
        step,
        loading: false,
        rect:
          right > left && bottom > top
            ? { left, top, width: right - left, height: bottom - top }
            : null,
      });
    };
    const find = () => {
      if (current.route && window.location.hash !== `#${current.route}`) return;
      const selected = document.querySelector('.nav a[aria-current="page"]');
      if (current.route && selected && selected.getAttribute('href') !== `#${current.route}`)
        return;
      const candidates = [
        document.querySelector<HTMLElement>(`[data-tour="${current.anchor}"]`),
        current.fallback ? document.querySelector<HTMLElement>(current.fallback) : null,
      ];
      target =
        candidates.find((element) => {
          if (!element || element.closest('[hidden]')) return false;
          const bounds = element.getBoundingClientRect();
          return (
            bounds.width > 0 &&
            bounds.height > 0 &&
            getComputedStyle(element).visibility !== 'hidden'
          );
        }) ?? null;
      if (!target) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(measure);
        resize.observe(target);
      }
    };
    const observer = new MutationObserver(find);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-tour', 'hidden', 'class', 'aria-current'],
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      setAnchor({ step, rect: null, loading: false });
    }, 1500);
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    find();
    return () => {
      observer.disconnect();
      resize?.disconnect();
      window.clearTimeout(timeout);
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [step, current]);
  useLayoutEffect(() => {
    if (!rect || !dialog.current) {
      setPosition({});
      return;
    }
    const width = dialog.current.offsetWidth || parseInt(tokens.size.popoverWidth);
    const height = dialog.current.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - height - margin));
    const candidates = [
      { left: rect.left + rect.width + offset, top },
      { left, top: rect.top + rect.height + offset },
      { left: rect.left - width - offset, top },
      { left, top: rect.top - height - offset },
    ];
    const fits = candidates.find(
      ({ left, top }) =>
        left >= margin &&
        top >= margin &&
        left + width <= window.innerWidth - margin &&
        top + height <= window.innerHeight - margin,
    );
    setPosition(fits ? { left: fits.left, top: fits.top, transform: 'none' } : {});
  }, [rect, step, dialog]);
  return { rect, loading, position };
}
