// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useScrollHint } from './useScrollHint';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function List() {
  const ref = useRef<HTMLElement>(null);
  const moreBelow = useScrollHint(ref);
  return (
    <aside data-testid="side" data-more-below={moreBelow || undefined}>
      <nav ref={ref} aria-label="Principal">
        <a href="#inicio">Inicio</a>
        <a href="#ajustes">Ajustes</a>
      </nav>
    </aside>
  );
}

/** jsdom no maqueta: se fija la geometría del contenedor a mano. */
function setGeometry(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
}

it('marca el indicio mientras queda contenido por debajo y lo retira al llegar al final', async () => {
  render(<List />);
  const side = screen.getByTestId('side');
  const nav = screen.getByRole('navigation', { name: 'Principal' });
  setGeometry(nav, 900, 600);
  fireEvent.scroll(nav);
  await waitFor(() => expect(side).toHaveAttribute('data-more-below'));

  nav.scrollTop = 300;
  fireEvent.scroll(nav);
  await waitFor(() => expect(side).not.toHaveAttribute('data-more-below'));

  nav.scrollTop = 100;
  fireEvent.scroll(nav);
  await waitFor(() => expect(side).toHaveAttribute('data-more-below'));
});

it('sin desbordamiento no muestra el indicio', async () => {
  render(<List />);
  const nav = screen.getByRole('navigation', { name: 'Principal' });
  setGeometry(nav, 600, 600);
  fireEvent.scroll(nav);
  await waitFor(() => expect(screen.getByTestId('side')).not.toHaveAttribute('data-more-below'));
});

it('desplaza a la vista la entrada que recibe el foco', () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  render(<List />);
  screen.getByRole('link', { name: 'Ajustes' }).focus();
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
