import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Estado } from '../estado.js';
import { leerEventos, type FiltroEventos } from './eventos.js';
import { filtroDe } from './index.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

let dir: string;
let ruta: string;
let estado: Estado;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'panel-eventos-'));
  ruta = join(dir, 'estado.sqlite');
  estado = new Estado(ruta);
});

afterEach(() => {
  estado.cerrar();
  rmSync(dir, { recursive: true, force: true });
});

const FILTRO: FiltroEventos = { flujo: null, estado: null, pagina: 1, porPagina: 50 };

/** Fija la fecha de una fila para que el orden no dependa del reloj. */
function fijarFecha(tabla: string, columna: string, clave: string, id: string, iso: string) {
  const db = new DatabaseSync(ruta);
  try {
    db.prepare(`UPDATE ${tabla} SET ${columna} = ? WHERE ${clave} = ?`).run(iso, id);
  } finally {
    db.close();
  }
}

function cotizacion(n: number, estadoCot: 'creada' | 'error', error: string | null = null) {
  estado.guardarCotizacion({
    quoteId: `q-${n}`,
    quoteNumber: `COT-${n}`,
    dealId: null,
    companyId: null,
    contactId: null,
    estado: estadoCot,
    emiteId: estadoCot === 'creada' ? `em-${n}` : null,
    emiteNumero: estadoCot === 'creada' ? n : null,
    error,
  });
}

function poblar() {
  cotizacion(1, 'creada');
  cotizacion(2, 'error', 'Empresa de Prueba SpA sin RUT');
  estado.marcarWebhook('wh-1');
  estado.guardarProducto({
    productId: 'p-1',
    sku: 'SKU-PRUEBA-1',
    estado: 'sincronizado',
    emiteId: 'ep-1',
    error: null,
  });
  estado.guardarProducto({
    productId: 'p-2',
    sku: null,
    estado: 'omitido',
    emiteId: null,
    error: 'SIN_SKU: sin SKU',
  });
  estado.guardarProducto({
    productId: 'p-3',
    sku: 'SKU-PRUEBA-3',
    estado: 'error',
    emiteId: null,
    error: 'rechazado',
  });
  fijarFecha('cotizaciones', 'actualizado_en', 'quote_id', 'q-1', '2026-10-29T10:00:00.000Z');
  fijarFecha('cotizaciones', 'actualizado_en', 'quote_id', 'q-2', '2026-10-29T11:00:00.000Z');
  fijarFecha('webhooks_vistos', 'visto_en', 'id', 'wh-1', '2026-10-29T12:00:00.000Z');
  fijarFecha('productos', 'actualizado_en', 'product_id', 'p-1', '2026-10-29T13:00:00.000Z');
  fijarFecha('productos', 'actualizado_en', 'product_id', 'p-2', '2026-10-29T14:00:00.000Z');
  fijarFecha('productos', 'actualizado_en', 'product_id', 'p-3', '2026-10-29T15:00:00.000Z');
}

describe('leerEventos', () => {
  it('devuelve vacío sobre un estado vacío', () => {
    expect(leerEventos(ruta, FILTRO)).toEqual({ total: 0, eventos: [] });
  });

  it('une cotizaciones, webhooks y productos, el más nuevo primero', () => {
    poblar();
    const { total, eventos } = leerEventos(ruta, FILTRO);
    expect(total).toBe(6);
    expect(eventos.map((e) => e.id)).toEqual(['p-3', 'p-2', 'p-1', 'wh-1', 'q-2', 'q-1']);
  });

  it('mapea los campos de cada tipo', () => {
    poblar();
    const { eventos } = leerEventos(ruta, FILTRO);
    const por = (id: string) => eventos.find((e) => e.id === id)!;
    expect(por('q-1')).toEqual({
      tipo: 'cotizacion',
      id: 'q-1',
      estado: 'creada',
      en: '2026-10-29T10:00:00.000Z',
      referencia: 'COT-1',
      emiteId: 'em-1',
      emiteNumero: 1,
      detalle: null,
    });
    expect(por('q-2').detalle).toBe('Empresa de Prueba SpA sin RUT');
    expect(por('wh-1')).toEqual({
      tipo: 'webhook',
      id: 'wh-1',
      estado: 'visto',
      en: '2026-10-29T12:00:00.000Z',
      referencia: null,
      emiteId: null,
      emiteNumero: null,
      detalle: null,
    });
    expect(por('p-1')).toMatchObject({
      tipo: 'producto',
      estado: 'sincronizado',
      referencia: 'SKU-PRUEBA-1',
      emiteId: 'ep-1',
    });
    expect(por('p-2')).toMatchObject({ referencia: null, detalle: 'SIN_SKU: sin SKU' });
  });

  it('el flujo cotizaciones incluye cotizaciones y webhooks; productos, sólo productos', () => {
    poblar();
    const c = leerEventos(ruta, { ...FILTRO, flujo: 'cotizaciones' });
    expect(c.total).toBe(3);
    expect(c.eventos.map((e) => e.tipo).sort()).toEqual(['cotizacion', 'cotizacion', 'webhook']);
    const p = leerEventos(ruta, { ...FILTRO, flujo: 'productos' });
    expect(p.total).toBe(3);
    expect(p.eventos.every((e) => e.tipo === 'producto')).toBe(true);
  });

  it('filtra por estado y combina con el flujo', () => {
    poblar();
    const ids = (f: Partial<FiltroEventos>) =>
      leerEventos(ruta, { ...FILTRO, ...f }).eventos.map((e) => e.id);
    expect(ids({ estado: 'error' })).toEqual(['p-3', 'q-2']);
    expect(ids({ estado: 'omitido' })).toEqual(['p-2']);
    expect(ids({ estado: 'visto' })).toEqual(['wh-1']);
    expect(ids({ flujo: 'cotizaciones', estado: 'error' })).toEqual(['q-2']);
    expect(leerEventos(ruta, { ...FILTRO, flujo: 'productos', estado: 'creada' }).total).toBe(0);
  });

  it('desempata por id descendente cuando la fecha es igual', () => {
    for (const n of [1, 2, 3]) {
      cotizacion(n, 'creada');
      fijarFecha(
        'cotizaciones',
        'actualizado_en',
        'quote_id',
        `q-${n}`,
        '2026-10-29T10:00:00.000Z',
      );
    }
    expect(leerEventos(ruta, FILTRO).eventos.map((e) => e.id)).toEqual(['q-3', 'q-2', 'q-1']);
  });

  it('pagina con el offset correcto y el total completo', () => {
    for (let n = 1; n <= 7; n++) {
      cotizacion(n, 'creada');
      fijarFecha(
        'cotizaciones',
        'actualizado_en',
        'quote_id',
        `q-${n}`,
        `2026-10-29T10:00:0${n}.000Z`,
      );
    }
    const p = (pagina: number) => leerEventos(ruta, { ...FILTRO, pagina, porPagina: 3 });
    expect(p(1).eventos.map((e) => e.id)).toEqual(['q-7', 'q-6', 'q-5']);
    expect(p(2).eventos.map((e) => e.id)).toEqual(['q-4', 'q-3', 'q-2']);
    expect(p(3).eventos.map((e) => e.id)).toEqual(['q-1']);
    expect(p(4).eventos).toEqual([]);
    expect(p(4).total).toBe(7);
  });

  it('falla si el archivo no existe en vez de crearlo', () => {
    expect(() => leerEventos(join(dir, 'no-existe.sqlite'), FILTRO)).toThrow();
  });
});

describe('filtroDe', () => {
  const q = (s: string) => filtroDe(new URLSearchParams(s));

  it('sin parámetros: sin filtros, página 1, 50 por página', () => {
    expect(q('')).toEqual({ flujo: null, estado: null, pagina: 1, porPagina: 50 });
  });

  it('acepta los valores conocidos', () => {
    expect(q('flujo=cotizaciones&estado=error&pagina=3')).toEqual({
      flujo: 'cotizaciones',
      estado: 'error',
      pagina: 3,
      porPagina: 50,
    });
    expect(q('flujo=productos&estado=omitido').flujo).toBe('productos');
  });

  it('ignora valores desconocidos', () => {
    const f = q('flujo=pedidos&estado=roto');
    expect(f.flujo).toBeNull();
    expect(f.estado).toBeNull();
  });

  it('una página inválida vuelve a la 1', () => {
    for (const v of ['0', '-2', '1.5', 'abc', '', 'NaN', 'Infinity']) {
      expect(q(`pagina=${v}`).pagina).toBe(1);
    }
  });
});
