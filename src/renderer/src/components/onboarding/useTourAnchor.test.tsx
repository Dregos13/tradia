// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTourAnchor } from './useTourAnchor';

// Paso 3 (Mercado): ancla «mercado-lista», respaldo «Datos de mercado».
const STEP = 3;
const ANCHOR_TOP = 300;
const FALLBACK_TOP = 100;

function mount(html: string) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper.firstElementChild!);
}

describe('useTourAnchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.dataset.tour ? ANCHOR_TOP : this.matches('section') ? FALLBACK_TOP : 0;
      const height = top ? 100 : 0;
      return {
        left: 100,
        top,
        width: top ? 200 : 0,
        height,
        right: 300,
        bottom: top + height,
        x: 100,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    mount('<section aria-label="Datos de mercado"><p>Cargando…</p></section>');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  const dialog = { current: null };

  it('ilumina el ancla data-tour presente desde el inicio', () => {
    document
      .querySelector('section')!
      .insertAdjacentHTML('beforeend', '<ul data-tour="mercado-lista"></ul>');
    const { result } = renderHook(() => useTourAnchor(STEP, dialog));
    expect(result.current.loading).toBe(false);
    expect(result.current.rect?.top).toBe(ANCHOR_TOP - 8);
  });

  it('pasa del respaldo al ancla cuando se monta tarde', async () => {
    const { result } = renderHook(() => useTourAnchor(STEP, dialog));
    expect(result.current.rect?.top).toBe(FALLBACK_TOP - 8);
    await act(async () => {
      vi.advanceTimersByTime(300);
      document
        .querySelector('section')!
        .insertAdjacentHTML('beforeend', '<ul data-tour="mercado-lista"></ul>');
    });
    expect(result.current.rect?.top).toBe(ANCHOR_TOP - 8);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.rect?.top).toBe(ANCHOR_TOP - 8);
  });

  it('se queda en el respaldo sin parpadeos si el ancla no llega', async () => {
    const { result } = renderHook(() => useTourAnchor(STEP, dialog));
    const seen: Array<number | undefined> = [];
    expect(result.current.rect?.top).toBe(FALLBACK_TOP - 8);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    seen.push(result.current.rect?.top);
    await act(async () => {
      document.querySelector('section')!.insertAdjacentHTML('beforeend', '<p>Más</p>');
      vi.advanceTimersByTime(1000);
    });
    seen.push(result.current.rect?.top);
    expect(seen).toEqual([FALLBACK_TOP - 8, FALLBACK_TOP - 8]);
    expect(result.current.loading).toBe(false);
  });

  describe('desplazamiento hacia el ancla', () => {
    const globe = document.createElement('div');
    Object.defineProperty(globe, 'offsetWidth', { value: 360 });
    Object.defineProperty(globe, 'offsetHeight', { value: 320 });
    const sized = { current: globe };
    let scroll: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      scroll = vi.fn();
      HTMLElement.prototype.scrollIntoView = scroll as unknown as HTMLElement['scrollIntoView'];
    });
    afterEach(() => {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    it('centra el ancla cuando el globo cabe a un lado', () => {
      document
        .querySelector('section')!
        .insertAdjacentHTML('beforeend', '<ul data-tour="mercado-lista"></ul>');
      renderHook(() => useTourAnchor(STEP, sized));
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    });

    it('sube el ancla al borde si, centrada, el globo no cabe a ningún lado', () => {
      // Ancla a todo el ancho y de 200 px: centrada no deja 320 px ni arriba ni abajo.
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        const own = Boolean(this.dataset.tour);
        return {
          left: 0,
          top: own ? ANCHOR_TOP : 0,
          width: own ? window.innerWidth : 0,
          height: own ? 200 : 0,
          right: own ? window.innerWidth : 0,
          bottom: own ? ANCHOR_TOP + 200 : 0,
          x: 0,
          y: own ? ANCHOR_TOP : 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
      document
        .querySelector('section')!
        .insertAdjacentHTML('beforeend', '<ul data-tour="mercado-lista"></ul>');
      renderHook(() => useTourAnchor(STEP, sized));
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    });

    it('vuelve a alinear el ancla si una carga encima la saca de la vista (paso 10)', () => {
      const observers: Array<{ callback: () => void; targets: Element[] }> = [];
      vi.stubGlobal(
        'ResizeObserver',
        class {
          private entry: { callback: () => void; targets: Element[] };
          constructor(callback: () => void) {
            this.entry = { callback, targets: [] };
            observers.push(this.entry);
          }
          observe(target: Element) {
            this.entry.targets.push(target);
          }
          disconnect() {}
        },
      );
      let anchorTop = ANCHOR_TOP;
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
        this: HTMLElement,
      ) {
        const own = Boolean(this.dataset.tour);
        const scroller = this.id === 'scroller';
        const top = own ? anchorTop : 0;
        const height = own ? 100 : scroller ? 800 : 0;
        return {
          left: 100,
          top,
          width: own || scroller ? 200 : 0,
          height,
          right: 300,
          bottom: top + height,
          x: 100,
          y: top,
          toJSON: () => ({}),
        } as DOMRect;
      });
      const section = document.querySelector('section')!;
      const scroller = document.createElement('div');
      scroller.id = 'scroller';
      scroller.style.overflowY = 'auto';
      section.replaceWith(scroller);
      scroller.appendChild(section);
      section.insertAdjacentHTML('beforeend', '<ul data-tour="mercado-lista"></ul>');
      renderHook(() => useTourAnchor(STEP, sized));
      expect(scroll).toHaveBeenCalledTimes(1);
      const layout = observers.find(({ targets }) => targets.includes(section))!;
      // La primera notificación es la inicial del observador: no desplaza.
      layout.callback();
      expect(scroll).toHaveBeenCalledTimes(1);
      // Con el ancla a la vista, un cambio de alto no mueve la página.
      layout.callback();
      expect(scroll).toHaveBeenCalledTimes(1);
      // La carga de encima termina y el ancla queda por encima de la vista.
      anchorTop = -200;
      layout.callback();
      expect(scroll).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    });
  });
});
