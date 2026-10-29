import { describe, expect, it } from 'vitest';
import type {
  ActividadNueva,
  CotizacionCoreinbox,
  CotizacionResumen,
  EmpresaCoreinbox,
} from '../../adaptadores/coreinbox/cliente.js';
import { Coreinbox, ErrorCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { EmiteDte, ErrorEmite, type CotizacionEmite } from '../../adaptadores/emite/cliente.js';
import { Estado } from '../../estado.js';
import { MARGEN_CURSOR_MS } from '../comun.js';
import { pasada } from './pasada.js';

const EMISOR = '11111111-1111-1111-1111-111111111111';
const TS = '2026-10-28T15:00:02.113Z';
const EMPRESA: EmpresaCoreinbox = {
  id: 'e-1',
  name: 'Empresa de Prueba',
  legalName: 'Empresa de Prueba SpA',
  taxId: '76000000-0',
  taxIdType: 'cl_rut',
  activityDescription: 'Servicios',
  addressLine1: 'Calle 1',
  addressLine2: null,
  admin1Name: null,
  admin2Name: 'Santiago',
  city: null,
  countryCode: 'CL',
};

function cotizacion(id: string, extra: Partial<CotizacionCoreinbox> = {}): CotizacionCoreinbox {
  return {
    id,
    quoteNumber: `COT-${id}`,
    status: 'accepted',
    companyId: 'e-1',
    contactId: null,
    dealId: 'd-1',
    currencyCode: 'CLP',
    validUntil: null,
    paymentTerms: null,
    termsAndConditions: null,
    notes: null,
    sections: [
      {
        items: [
          {
            id: `${id}-l1`,
            productId: 'p-1',
            name: 'Servicio',
            description: null,
            quantity: '1',
            unit: null,
            unitPrice: '1000',
            discountPercent: null,
            discountAmount: null,
            taxRate: null,
            isOptional: false,
            sortOrder: 0,
          },
        ],
      },
    ],
    acceptance: null,
    ...extra,
  };
}

interface Doble {
  cotizaciones: CotizacionCoreinbox[];
  emite?: (cuerpo: CotizacionEmite, intento: number) => unknown;
  listar?: (desde: string, cursor?: string) => unknown;
}

function armar(doble: Doble) {
  const actividades: ActividadNueva[] = [];
  const llamadasEmite: CotizacionEmite[] = [];
  const consultas: Array<{ desde: string; cursor?: string }> = [];
  const coreinbox = {
    listarAceptadas: async (desde: string, cursor?: string) => {
      consultas.push({ desde, ...(cursor ? { cursor } : {}) });
      if (doble.listar) return doble.listar(desde, cursor);
      const items: CotizacionResumen[] = doble.cotizaciones.map((c) => ({
        id: c.id,
        quoteNumber: c.quoteNumber,
        status: c.status,
        updatedAt: TS,
      }));
      return { items, nextCursor: null, timestamp: TS };
    },
    cotizacion: async (id: string) => {
      const c = doble.cotizaciones.find((x) => x.id === id);
      if (!c) throw new ErrorCoreinbox(404, 'NOT_FOUND', 'no existe');
      return c;
    },
    empresa: async () => EMPRESA,
    contacto: async () => ({ id: 'c-1', email: null }),
    skuDe: async () => 'SKU-1',
    crearActividad: async (a: ActividadNueva) => {
      actividades.push(a);
      return 'act';
    },
  } as unknown as Coreinbox;
  const emite = {
    crearCotizacion: async (cuerpo: CotizacionEmite) => {
      llamadasEmite.push(cuerpo);
      if (doble.emite) return doble.emite(cuerpo, llamadasEmite.length);
      return {
        id: `emite-${cuerpo.origen.idExterno}`,
        numero: 40,
        estado: 'aceptada',
        montoTotal: 1190,
        receptorSnapshot: { rut: '76000000-0', razonSocial: 'Empresa de Prueba SpA' },
      };
    },
  } as unknown as EmiteDte;
  const estado = new Estado(':memory:');
  const deps = {
    coreinbox,
    emite,
    estado,
    emisorId: EMISOR,
    urlPublica: 'https://f.test',
    tipoActividad: 'nota',
    desde: '2026-10-01T00:00:00.000Z',
  };
  return { deps, estado, actividades, llamadasEmite, consultas };
}

describe('pasada', () => {
  it('crea en Emite DTE lo aceptado, anota en el negocio y guarda el cursor con margen', async () => {
    const { deps, estado, actividades, llamadasEmite, consultas } = armar({
      cotizaciones: [cotizacion('q1'), cotizacion('q2', { status: 'sent' })],
    });
    expect(await pasada(deps)).toEqual({ revisadas: 1, creadas: 1, conError: 0, pendientes: 0 });
    expect(consultas[0]).toEqual({ desde: '2026-10-01T00:00:00.000Z' });
    expect(llamadasEmite).toHaveLength(1);
    expect(llamadasEmite[0]).toMatchObject({
      origen: { nombre: 'coreinbox', idExterno: 'q1' },
      receptor: { rut: '76000000-0' },
      items: [{ codigo: 'SKU-1', nombre: 'Servicio', cantidad: 1, precioUnitario: 1000 }],
    });
    expect(estado.cotizacion('q1')).toMatchObject({
      estado: 'creada',
      emiteId: 'emite-q1',
      emiteNumero: 40,
      dealId: 'd-1',
    });
    expect(actividades).toHaveLength(1);
    expect(actividades[0]).toMatchObject({
      dealId: 'd-1',
      title: 'Cotización COT-q1 lista para facturar en Emite DTE (N° 40)',
    });
    expect(estado.cursor).toBe(new Date(Date.parse(TS) - MARGEN_CURSOR_MS).toISOString());

    // La pasada siguiente parte del cursor y no vuelve a crear la misma.
    expect(await pasada(deps)).toEqual({ revisadas: 0, creadas: 0, conError: 0, pendientes: 0 });
    expect(consultas[1]?.desde).toBe(estado.cursor);
    expect(llamadasEmite).toHaveLength(1);
  });

  it('con un cliente que no existe en Emite DTE reenvía el receptor completo', async () => {
    const { deps, llamadasEmite } = armar({
      cotizaciones: [cotizacion('q1')],
      emite: (cuerpo, intento) => {
        if (intento === 1)
          throw new ErrorEmite(400, 'RECEPTOR_NO_EXISTE', 'no está en el catálogo');
        return {
          id: 'emite-q1',
          numero: 41,
          estado: 'aceptada',
          montoTotal: 1190,
          receptorSnapshot: { rut: cuerpo.receptor.rut, razonSocial: 'Empresa de Prueba SpA' },
        };
      },
    });
    expect((await pasada(deps)).creadas).toBe(1);
    expect(llamadasEmite).toHaveLength(2);
    expect(llamadasEmite[0]!.receptor).toEqual({ rut: '76000000-0' });
    expect(llamadasEmite[1]!.receptor).toMatchObject({
      razonSocial: 'Empresa de Prueba SpA',
      giro: 'Servicios',
      comuna: 'Santiago',
    });
  });

  it('un dato que Emite DTE no acepta queda como error, se anota una vez y no bloquea el cursor', async () => {
    const { deps, estado, actividades } = armar({
      cotizaciones: [cotizacion('q1', { currencyCode: 'USD' }), cotizacion('q2')],
    });
    expect(await pasada(deps)).toEqual({ revisadas: 2, creadas: 1, conError: 1, pendientes: 0 });
    expect(estado.cotizacion('q1')).toMatchObject({
      estado: 'error',
      error: expect.stringContaining('MONEDA'),
    });
    expect(actividades.filter((a) => a.title.includes('no se pudo'))).toHaveLength(1);
    expect(estado.cursor).not.toBeNull();
    // Mientras el dato no cambie, se vuelve a intentar sin repetir el aviso.
    await pasada(deps);
    expect(actividades.filter((a) => a.title.includes('no se pudo'))).toHaveLength(1);
  });

  it('una falla transitoria deja la cotización pendiente y no mueve el cursor', async () => {
    const { deps, estado, llamadasEmite } = armar({
      cotizaciones: [cotizacion('q1')],
      emite: (_c, intento) => {
        if (intento === 1) throw new ErrorEmite(503, 'HTTP_503', 'caída');
        return {
          id: 'emite-q1',
          numero: 42,
          estado: 'aceptada',
          montoTotal: 1190,
          receptorSnapshot: { rut: '76000000-0', razonSocial: 'Empresa de Prueba SpA' },
        };
      },
    });
    expect(await pasada(deps)).toEqual({ revisadas: 1, creadas: 0, conError: 0, pendientes: 1 });
    expect(estado.cursor).toBeNull();
    expect(estado.cotizacion('q1')).toBeNull();
    expect((await pasada(deps)).creadas).toBe(1);
    expect(llamadasEmite).toHaveLength(2);
    expect(estado.cursor).not.toBeNull();
  });

  it('recorre todas las páginas y deduplica por id', async () => {
    const q1 = cotizacion('q1');
    const resumen = { id: 'q1', quoteNumber: 'COT-q1', status: 'accepted', updatedAt: TS };
    const { deps, llamadasEmite } = armar({
      cotizaciones: [q1],
      listar: (_desde, cursor) =>
        cursor
          ? { items: [resumen], nextCursor: null, timestamp: '2026-10-28T15:00:05.000Z' }
          : { items: [resumen], nextCursor: 'c2', timestamp: TS },
    });
    expect((await pasada(deps)).creadas).toBe(1);
    expect(llamadasEmite).toHaveLength(1);
    expect(deps.estado.cursor).toBe(new Date(Date.parse(TS) - MARGEN_CURSOR_MS).toISOString());
  });
});

/**
 * `fetch` doble por ruta («GET host/ruta», sin query) para los clientes reales: registra cada
 * petición, responde con el sobre de Coreinbox lo que está en `rutas` y lo demás es la red caída.
 */
function red(rutas: Record<string, unknown>) {
  const peticiones: string[] = [];
  const http = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const peticion = `${init?.method ?? 'GET'} ${url.host}${url.pathname}`;
    peticiones.push(peticion);
    if (!(peticion in rutas)) throw new TypeError('fetch failed');
    return new Response(
      JSON.stringify({ success: true, data: rutas[peticion], meta: { timestamp: TS } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return {
    peticiones,
    coreinbox: new Coreinbox('https://crm.test', 'cik_prueba', http),
    emite: new EmiteDte('https://emite.test', 'edte_prueba', http),
  };
}

describe('pasada con la red de Coreinbox caída', () => {
  const listado = {
    'GET crm.test/api/v1/quotes': {
      items: [{ id: 'q1', quoteNumber: 'COT-q1', status: 'accepted', updatedAt: TS }],
      nextCursor: null,
    },
  };

  async function pasadaSinRed(rutas: Record<string, unknown>) {
    const { peticiones, coreinbox, emite } = red(rutas);
    const estado = new Estado(':memory:');
    const resultado = await pasada({
      coreinbox,
      emite,
      estado,
      emisorId: EMISOR,
      urlPublica: 'https://f.test',
      tipoActividad: 'nota',
      desde: '2026-10-01T00:00:00.000Z',
    });
    return { resultado, estado, peticiones };
  }

  it('al pedir el detalle de la cotización: queda pendiente, sin cursor, sin anotar ni crear', async () => {
    const { resultado, estado, peticiones } = await pasadaSinRed(listado);
    expect(resultado).toEqual({ revisadas: 1, creadas: 0, conError: 0, pendientes: 1 });
    expect(estado.cotizacion('q1')).toBeNull();
    expect(estado.cursor).toBeNull();
    expect(peticiones).toEqual(['GET crm.test/api/v1/quotes', 'GET crm.test/api/v1/quotes/q1']);
  });

  it('al pedir el SKU de un producto de la cotización: queda pendiente en vez de ir sin código', async () => {
    const { resultado, estado, peticiones } = await pasadaSinRed({
      ...listado,
      'GET crm.test/api/v1/quotes/q1': cotizacion('q1'),
      'GET crm.test/api/v1/crm/companies/e-1': EMPRESA,
    });
    expect(resultado).toEqual({ revisadas: 1, creadas: 0, conError: 0, pendientes: 1 });
    expect(estado.cotizacion('q1')).toBeNull();
    expect(estado.cursor).toBeNull();
    expect(peticiones).toEqual([
      'GET crm.test/api/v1/quotes',
      'GET crm.test/api/v1/quotes/q1',
      'GET crm.test/api/v1/crm/companies/e-1',
      'GET crm.test/api/v1/products/p-1',
    ]);
  });
});
