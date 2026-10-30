import { describe, expect, it } from 'vitest';
import { Html, esc, fecha, html } from './html.js';

describe('esc', () => {
  it('escapa los cinco caracteres peligrosos', () => {
    expect(esc(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('escapa el ampersand en cada pasada', () => {
    expect(esc('&')).toBe('&amp;');
    expect(esc(esc('&'))).toBe('&amp;amp;');
  });

  it('convierte null, undefined y números en texto', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
    expect(esc(0)).toBe('0');
  });
});

describe('html', () => {
  it('escapa los valores interpolados', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.valor).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('no escapa los fragmentos Html anidados', () => {
    const interno = html`<b>${'a&b'}</b>`;
    expect(html`<p>${interno}</p>`.valor).toBe('<p><b>a&amp;b</b></p>');
  });

  it('une listas, incluso anidadas, y omite null, undefined y false', () => {
    const lista = ['<x>', html`<i>1</i>`, [2, [null, undefined, false, 'y']]];
    expect(html`${lista}`.valor).toBe('&lt;x&gt;<i>1</i>2y');
  });

  it('imprime el número cero', () => {
    expect(html`${0}`.valor).toBe('0');
  });

  it('toString devuelve el valor', () => {
    expect(String(new Html('<b>x</b>'))).toBe('<b>x</b>');
  });
});

describe('fecha', () => {
  it('muestra una raya tenue si no hay fecha', () => {
    expect(fecha(null).valor).toContain('—');
    expect(fecha(null).valor).toContain('tenue');
  });

  it('muestra el texto escapado si la fecha no es válida', () => {
    const r = fecha('no es <fecha>').valor;
    expect(r).toContain('no es &lt;fecha&gt;');
    expect(r).not.toContain('<time');
  });

  it('formatea una fecha ISO en hora de Santiago y conserva el ISO', () => {
    const r = fecha('2026-10-29T12:00:00.000Z').valor;
    expect(r).toContain('<time');
    expect(r).toContain('datetime="2026-10-29T12:00:00.000Z"');
    expect(r).toContain('title="2026-10-29T12:00:00.000Z"');
    expect(r).toMatch(/9:00:00/);
  });
});
