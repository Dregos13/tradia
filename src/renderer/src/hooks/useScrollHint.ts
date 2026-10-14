import { useEffect, useState, type RefObject } from 'react';

/**
 * Indica si un contenedor con desplazamiento vertical aún tiene contenido
 * oculto por debajo, para pintar un indicio (degradado) mientras quede algo
 * por ver. Además, el elemento que recibe el foco con teclado se desplaza a
 * la vista respetando el `scroll-padding` del contenedor, de modo que no
 * quede bajo el propio indicio.
 */
export function useScrollHint(ref: RefObject<HTMLElement | null>): boolean {
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      // Medio píxel de margen para el redondeo de la escala de pantalla.
      setMoreBelow(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target !== element) {
        target.scrollIntoView?.({ block: 'nearest' });
      }
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    element.addEventListener('focusin', reveal);
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      element.removeEventListener('focusin', reveal);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [ref]);
  return moreBelow;
}
