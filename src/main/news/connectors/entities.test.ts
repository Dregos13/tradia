import { describe, expect, it } from 'vitest';

import { decodeHtmlEntities } from './entities';

describe('decodeHtmlEntities', () => {
  it('decodifica entidades con nombre', () => {
    expect(decodeHtmlEntities('A&amp;P LIFESCIENCE FUND, FI')).toBe('A&P LIFESCIENCE FUND, FI');
    expect(decodeHtmlEntities('&quot;hawkish&quot; &lt;Fed&gt;')).toBe('"hawkish" <Fed>');
    expect(decodeHtmlEntities('Caída del 2&nbsp;% &ndash; IBEX')).toBe('Caída del 2 % – IBEX');
  });

  it('decodifica numéricas decimales y hexadecimales', () => {
    expect(decodeHtmlEntities('Powell&#39;s speech')).toBe("Powell's speech");
    expect(decodeHtmlEntities('Powell&#x2019;s speech')).toBe('Powell’s speech');
    expect(decodeHtmlEntities('&#X20AC;10')).toBe('€10');
  });

  it('no decodifica dos veces: «&amp;amp;» queda «&amp;»', () => {
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeHtmlEntities('&amp;#39;')).toBe('&#39;');
  });

  it('deja intacto lo que no reconoce o no es válido', () => {
    expect(decodeHtmlEntities('AT&T y P&G')).toBe('AT&T y P&G');
    expect(decodeHtmlEntities('&desconocida; &amp')).toBe('&desconocida; &amp');
    expect(decodeHtmlEntities('&#xD800; &#1114112; &#0;')).toBe('&#xD800; &#1114112; &#0;');
  });

  it('el resultado es texto: «&lt;script&gt;» no se convierte en otra cosa que caracteres', () => {
    expect(decodeHtmlEntities('&lt;script&gt;')).toBe('<script>');
  });
});
