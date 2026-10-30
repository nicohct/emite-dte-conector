import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Estado } from './estado.js';

const en = (minuto: number) => `2026-10-30T12:${String(minuto).padStart(2, '0')}:00.000Z`;

describe('Estado: eventos', () => {
  let estado: Estado;
  const reloj = (minuto: number) => vi.setSystemTime(new Date(en(minuto)));

  beforeEach(() => {
    vi.useFakeTimers();
    estado = new Estado(':memory:');
    reloj(1);
    estado.guardarCotizacion({
      quoteId: 'q1',
      quoteNumber: 'C-1001',
      dealId: null,
      companyId: null,
      contactId: null,
      estado: 'creada',
      emiteId: 'cot-1',
      emiteNumero: 1,
      error: null,
    });
    reloj(2);
    estado.guardarCotizacion({
      quoteId: 'q2',
      quoteNumber: 'C-1002',
      dealId: null,
      companyId: null,
      contactId: null,
      estado: 'error',
      emiteId: null,
      emiteNumero: null,
      error: 'RECEPTOR: falta el RUT',
    });
    reloj(3);
    estado.guardarProducto({
      productId: 'p1',
      sku: 'SKU-001',
      estado: 'omitido',
      emiteId: null,
      error: 'SIN_SKU: no tiene SKU',
    });
    reloj(4);
    estado.marcarWebhook('wh-1');
    const catalogo = estado.catalogo;
    catalogo.abrirConflicto('SKU-001', 'precio', { coreinbox: { valor: 1, en: null } }, en(5));
    catalogo.guardarHistorico({
      emiteId: 'e1',
      codigo: 'X',
      nombre: 'Histórico',
      activo: true,
      fusionadoEnId: null,
      uso: null,
      modificadoEn: null,
      leidoEn: en(6),
    });
    catalogo.proponerEmpate(
      'e1',
      [{ sku: 'SKU-001', puntaje: 1, motivo: 'codigo', detalle: 'el código es el SKU' }],
      en(6),
    );
    catalogo.registrarAccion('visibilidad', 'admin@example.com', { skus: ['SKU-001'] }, en(7));
  });

  afterEach(() => {
    estado.cerrar();
    vi.useRealTimers();
  });

  it('une las tablas en una sola lista, lo más reciente primero', () => {
    expect(estado.eventos().map((e) => [e.tipo, e.estado, e.en])).toEqual([
      ['accion', 'visibilidad', en(7)],
      ['empate', 'propuesto', en(6)],
      ['conflicto', 'abierto', en(5)],
      ['webhook', 'visto', en(4)],
      ['producto', 'omitido', en(3)],
      ['cotizacion', 'error', en(2)],
      ['cotizacion', 'creada', en(1)],
    ]);
    expect(estado.contar()).toBe(7);
  });

  it('trae ids, SKU y mensaje de cada tipo', () => {
    const eventos = estado.eventos();
    expect(eventos.find((e) => e.idExterno === 'q1')).toEqual({
      flujo: 'cotizaciones',
      tipo: 'cotizacion',
      estado: 'creada',
      en: en(1),
      idExterno: 'q1',
      emiteId: 'cot-1',
      sku: null,
      mensaje: 'C-1001',
      referencia: 'C-1001',
      emiteNumero: 1,
      sistema: null,
      campo: null,
    });
    expect(eventos.find((e) => e.idExterno === 'q2')).toMatchObject({
      mensaje: 'RECEPTOR: falta el RUT',
      referencia: 'C-1002',
      emiteNumero: null,
    });
    expect(eventos.find((e) => e.tipo === 'producto')).toMatchObject({
      referencia: null,
      emiteNumero: null,
    });
    expect(eventos.find((e) => e.tipo === 'producto')).toMatchObject({
      flujo: 'productos',
      sku: 'SKU-001',
      mensaje: 'SIN_SKU: no tiene SKU',
    });
    expect(eventos.find((e) => e.tipo === 'webhook')).toMatchObject({
      flujo: 'cotizaciones',
      idExterno: 'wh-1',
    });
    expect(eventos.find((e) => e.tipo === 'conflicto')).toMatchObject({
      sku: 'SKU-001',
      mensaje: 'precio',
    });
    expect(eventos.find((e) => e.tipo === 'accion')?.mensaje).toBe('admin@example.com');
  });

  it('filtra por flujo y estado, y pagina', () => {
    expect(estado.eventos({ flujo: 'cotizaciones' }).map((e) => e.tipo)).toEqual([
      'webhook',
      'cotizacion',
      'cotizacion',
    ]);
    expect(estado.contar({ flujo: 'productos' })).toBe(4);
    expect(estado.eventos({ estado: 'error' }).map((e) => e.idExterno)).toEqual(['q2']);
    expect(estado.contar({ flujo: 'productos', estado: 'error' })).toBe(0);
    expect(estado.eventos({ pagina: 2, porPagina: 3 }).map((e) => e.en)).toEqual([
      en(4),
      en(3),
      en(2),
    ]);
    expect(estado.eventos({ pagina: 9, porPagina: 3 })).toEqual([]);
  });

  it('un empate decidido o un conflicto resuelto cambia de estado y de fecha', () => {
    estado.catalogo.decidirEmpate('e1', 'SKU-001', 'confirmado', 'admin@example.com', en(8));
    const [conflicto] = estado.catalogo.conflictos('SKU-001');
    if (!conflicto) throw new Error('falta el conflicto');
    estado.catalogo.resolverConflicto(conflicto.id, 'coreinbox', null, en(9));
    expect(estado.eventos({ porPagina: 2 }).map((e) => [e.tipo, e.estado, e.en])).toEqual([
      ['conflicto', 'resuelto', en(9)],
      ['empate', 'confirmado', en(8)],
    ]);
  });
});
