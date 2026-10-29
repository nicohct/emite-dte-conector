import { describe, expect, it } from 'vitest';
import type { CotizacionCoreinbox, EmpresaCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { ErrorMapeo, armarCotizacion, normalizarRut } from './mapeo.js';

const EMISOR = '11111111-1111-1111-1111-111111111111';

/** Cotización sintética como la devuelve `GET /quotes/:id` (los Decimal llegan como texto). */
function cotizacion(extra: Partial<CotizacionCoreinbox> = {}): CotizacionCoreinbox {
  return {
    id: 'q-1',
    quoteNumber: 'COT-2026-012',
    status: 'accepted',
    title: 'Barredoras para bodega',
    companyId: 'e-1',
    contactId: 'c-1',
    dealId: 'd-1',
    currencyCode: 'CLP',
    validUntil: '2026-11-30T00:00:00.000Z',
    paymentTerms: { mode: 'credito', creditDays: 30, note: 'Pago a 30 días con OC' },
    termsAndConditions: 'Entrega en 10 días hábiles.',
    notes: 'nota interna del vendedor',
    discountMode: 'line',
    discountPercent: null,
    sections: [
      {
        items: [
          {
            id: 'l-1',
            productId: 'p-1',
            name: 'Barredora HT100',
            description: 'Con batería',
            quantity: '2.0000',
            unit: 'unidad',
            unitPrice: '450000.0000',
            discountPercent: '10.00',
            discountAmount: null,
            taxRate: '0.1900',
            isOptional: false,
            sortOrder: 0,
          },
          {
            id: 'l-2',
            productId: null,
            name: 'Capacitación en terreno',
            description: null,
            quantity: '1.0000',
            unit: null,
            unitPrice: '80000.0000',
            discountPercent: null,
            discountAmount: null,
            taxRate: '0',
            isOptional: true,
            isSelectedByContact: true,
            sortOrder: 1,
          },
          {
            id: 'l-3',
            productId: null,
            name: 'Repuestos extra (opcional no elegido)',
            description: null,
            quantity: '1.0000',
            unit: null,
            unitPrice: '50000.0000',
            discountPercent: null,
            discountAmount: null,
            taxRate: null,
            isOptional: true,
            isSelectedByContact: false,
            sortOrder: 2,
          },
        ],
      },
    ],
    acceptance: {
      acceptedAt: '2026-10-27T15:00:00.000Z',
      poNumber: 'OC-7788',
      note: 'Despachar a bodega 2',
      differsFromQuote: true,
      lines: [
        {
          quoteLineItemId: 'l-1',
          quantity: '3',
          unitPrice: '440000',
          discountPercent: null,
          discountAmount: '20000',
        },
        {
          quoteLineItemId: 'l-2',
          quantity: '1',
          unitPrice: '80000',
          discountPercent: null,
          discountAmount: null,
        },
      ],
    },
    ...extra,
  };
}

const empresa: EmpresaCoreinbox = {
  id: 'e-1',
  name: 'Empresa de Prueba',
  legalName: 'Empresa de Prueba SpA',
  taxId: '76.000.000-0',
  taxIdType: 'cl_rut',
  activityDescription:
    'Venta al por mayor de maquinaria, equipo y materiales para la limpieza industrial',
  addressLine1: 'Av. Siempre Viva 742',
  addressLine2: 'Bodega 3',
  admin1Name: 'Región Metropolitana de Santiago',
  admin2Name: 'Pudahuel',
  city: 'Santiago',
  countryCode: 'CL',
};

const contacto = { id: 'c-1', firstName: 'Ana', lastName: 'Pérez', email: 'Ana@Prueba.test' };

describe('normalizarRut', () => {
  it('acepta con y sin puntos y valida el dígito verificador', () => {
    expect(normalizarRut('76.000.000-0')).toBe('76000000-0');
    expect(normalizarRut('76000000k')).toBeNull();
    expect(normalizarRut('12.345.678-5')).toBe('12345678-5');
    expect(normalizarRut('76000000-K')).toBeNull();
    expect(normalizarRut('US-12-3456789')).toBeNull();
  });
});

describe('armarCotizacion', () => {
  it('traduce lo aceptado (cantidades, precios y descuentos de la aceptación) con la OC del cliente', () => {
    const r = armarCotizacion(
      { cotizacion: cotizacion(), empresa, contacto, skus: new Map([['p-1', 'HT100']]) },
      EMISOR,
    );
    expect(r.completo).toEqual({
      emisorId: EMISOR,
      receptor: {
        rut: '76000000-0',
        razonSocial: 'Empresa de Prueba SpA',
        giro: 'Venta al por mayor de maquinaria, equipo',
        direccion: 'Av. Siempre Viva 742, Bodega 3',
        comuna: 'Pudahuel',
        ciudad: 'Santiago',
        contacto: 'Ana Pérez',
        correo: 'ana@prueba.test',
      },
      items: [
        {
          codigo: 'HT100',
          nombre: 'Barredora HT100',
          descripcion: 'Con batería',
          cantidad: 3,
          unidad: 'unid',
          precioUnitario: 440000,
          descuentoMonto: 20000,
          exento: false,
        },
        { nombre: 'Capacitación en terreno', cantidad: 1, precioUnitario: 80000, exento: true },
      ],
      vigenteHasta: '2026-11-30',
      formaPago: 2,
      condiciones: 'Entrega en 10 días hábiles.\n\nPago a 30 días con OC',
      observaciones:
        'Cotización COT-2026-012 de Coreinbox · Barredoras para bodega\nNota del cliente al aceptar: Despachar a bodega 2',
      ordenCompra: { numero: 'OC-7788' },
      origen: { nombre: 'coreinbox', idExterno: 'q-1', numero: 'COT-2026-012' },
      estado: 'aceptada',
    });
    // Por RUT: sólo el RUT y el contacto, para no pisar el catálogo de Emite DTE.
    expect(r.porRut.receptor).toEqual({ rut: '76000000-0', contacto: 'Ana Pérez' });
    expect(r.avisos).toEqual(['El giro se acortó a 40 caracteres']);
  });

  it('sin aceptación detallada toma las líneas obligatorias y las opcionales elegidas', () => {
    const r = armarCotizacion(
      {
        cotizacion: cotizacion({
          acceptance: {
            acceptedAt: '',
            poNumber: null,
            note: null,
            differsFromQuote: false,
            lines: [],
          },
        }),
        empresa,
        contacto: null,
        skus: new Map(),
      },
      EMISOR,
    );
    expect(r.completo.items.map((i) => [i.nombre, i.cantidad, i.precioUnitario])).toEqual([
      ['Barredora HT100', 2, 450000],
      ['Capacitación en terreno', 1, 80000],
    ]);
    expect(r.completo.items[0]).toMatchObject({ descuentoPorcentaje: 10 });
    expect(r.completo.ordenCompra).toBeUndefined();
    expect(r.completo.receptor).not.toHaveProperty('correo');
  });

  it('una OC más larga que la referencia 801 queda en las notas, con aviso', () => {
    const r = armarCotizacion(
      {
        cotizacion: cotizacion({
          acceptance: { ...cotizacion().acceptance!, poNumber: 'OC-2026-000000123456789' },
        }),
        empresa,
        contacto,
        skus: new Map(),
      },
      EMISOR,
    );
    expect(r.completo.ordenCompra).toBeUndefined();
    expect(r.completo.observaciones).toContain('OC del cliente: OC-2026-000000123456789');
    expect(r.avisos.some((a) => a.includes('18 caracteres'))).toBe(true);
  });

  it('el descuento global de Coreinbox pasa como porcentaje global', () => {
    const r = armarCotizacion(
      {
        cotizacion: cotizacion({ discountMode: 'global', discountPercent: '5.00' }),
        empresa,
        contacto,
        skus: new Map(),
      },
      EMISOR,
    );
    expect(r.completo.descuentoGlobalPorcentaje).toBe(5);
  });

  it('rechaza otra moneda, una empresa sin RUT válido y una cotización sin líneas', () => {
    const base = { empresa, contacto, skus: new Map<string, string>() };
    expect(() =>
      armarCotizacion({ ...base, cotizacion: cotizacion({ currencyCode: 'USD' }) }, EMISOR),
    ).toThrow(ErrorMapeo);
    expect(() =>
      armarCotizacion(
        { ...base, cotizacion: cotizacion(), empresa: { ...empresa, taxId: 'US-12-3456789' } },
        EMISOR,
      ),
    ).toThrowError(/RUT válido/);
    expect(() =>
      armarCotizacion({ ...base, cotizacion: cotizacion(), empresa: null }, EMISOR),
    ).toThrowError(/no tiene empresa/);
    const sinLineas = cotizacion({
      acceptance: {
        acceptedAt: '',
        poNumber: null,
        note: null,
        differsFromQuote: false,
        lines: [],
      },
      sections: [{ items: [] }],
    });
    expect(() => armarCotizacion({ ...base, cotizacion: sinLineas }, EMISOR)).toThrowError(
      /sin líneas|líneas aceptadas/,
    );
  });
});
