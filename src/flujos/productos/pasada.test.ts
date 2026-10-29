import { describe, expect, it } from 'vitest';
import type { CategoriaCoreinbox, ProductoCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { Coreinbox, ErrorCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import {
  EmiteDte,
  ErrorEmite,
  type CambiosProducto,
  type ProductoEmite,
  type ProductoNuevo,
} from '../../adaptadores/emite/cliente.js';
import { Estado } from '../../estado.js';
import { MARGEN_CURSOR_MS } from '../comun.js';
import { pasadaProductos } from './pasada.js';

const EMISOR = '11111111-1111-1111-1111-111111111111';
const TS = '2026-10-28T15:00:02.113Z';

function producto(id: string, extra: Partial<ProductoCoreinbox> = {}): ProductoCoreinbox {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Producto ${id}`,
    description: null,
    type: 'product',
    unit: 'unidad',
    unitPrice: '1000',
    currencyCode: 'CLP',
    isTaxable: true,
    taxRate: '0.19',
    categoryId: null,
    isActive: true,
    updatedAt: TS,
    ...extra,
  };
}

function enEmite(extra: Partial<ProductoEmite> = {}): ProductoEmite {
  return {
    id: 'emite-1',
    codigo: 'SKU-p1',
    nombre: 'Producto p1',
    descripcion: null,
    tipo: 'bien',
    unidad: 'UN',
    precioNeto: 1000,
    exento: false,
    categoria: null,
    activo: true,
    ...extra,
  };
}

interface Doble {
  productos: ProductoCoreinbox[];
  categorias?: CategoriaCoreinbox[];
  /** Lo que hay en Emite DTE por código (ya resueltos alias y fusiones). */
  existentes?: Record<string, ProductoEmite>;
  listar?: (desde: string, cursor?: string) => unknown;
  crear?: (datos: ProductoNuevo, intento: number) => ProductoEmite;
}

function armar(doble: Doble) {
  const consultas: Array<{ desde: string; cursor?: string }> = [];
  const buscados: string[] = [];
  const creados: ProductoNuevo[] = [];
  const actualizados: Array<{ id: string; cambios: CambiosProducto }> = [];
  let categoriasPedidas = 0;
  // Lo que Emite DTE «tiene»: lo que ya existía más lo que el conector cree en la prueba.
  const existentes: Record<string, ProductoEmite> = { ...doble.existentes };
  const coreinbox = {
    listarProductos: async (desde: string, cursor?: string) => {
      consultas.push({ desde, ...(cursor ? { cursor } : {}) });
      if (doble.listar) return doble.listar(desde, cursor);
      return { items: doble.productos, nextCursor: null, timestamp: TS };
    },
    categorias: async () => {
      categoriasPedidas++;
      return doble.categorias ?? [];
    },
  } as unknown as Coreinbox;
  const emite = {
    productoPorCodigo: async (_emisorId: string, codigo: string) => {
      buscados.push(codigo);
      return existentes[codigo] ?? null;
    },
    crearProducto: async (datos: ProductoNuevo) => {
      creados.push(datos);
      const creado = doble.crear
        ? doble.crear(datos, creados.length)
        : enEmite({ id: `emite-${datos.codigo}`, codigo: datos.codigo, nombre: datos.nombre });
      existentes[datos.codigo] = { ...creado, precioNeto: datos.precioNeto };
      return creado;
    },
    actualizarProducto: async (id: string, cambios: CambiosProducto) => {
      actualizados.push({ id, cambios });
      return enEmite({ id, ...cambios });
    },
  } as unknown as EmiteDte;
  const estado = new Estado(':memory:');
  const deps = { coreinbox, emite, estado, emisorId: EMISOR, desde: '2026-10-01T00:00:00.000Z' };
  return {
    deps,
    estado,
    consultas,
    buscados,
    creados,
    actualizados,
    categorias: () => categoriasPedidas,
  };
}

const sinNovedad = {
  revisados: 0,
  creados: 0,
  actualizados: 0,
  sinCambios: 0,
  omitidos: 0,
  conError: 0,
  pendientes: 0,
};

describe('pasadaProductos', () => {
  it('crea en Emite DTE los productos nuevos, con su categoría, y guarda el cursor con margen', async () => {
    const { deps, estado, consultas, creados, categorias } = armar({
      productos: [
        producto('p1', { categoryId: 'cat-1', type: 'service', unit: 'hora', taxRate: '0' }),
        producto('p2'),
      ],
      categorias: [{ id: 'cat-1', name: 'Servicios', parentId: null }],
    });
    expect(await pasadaProductos(deps)).toEqual({ ...sinNovedad, revisados: 2, creados: 2 });
    expect(consultas[0]).toEqual({ desde: '2026-10-01T00:00:00.000Z' });
    expect(creados).toHaveLength(2);
    expect(creados[0]).toEqual({
      emisorId: EMISOR,
      codigo: 'SKU-p1',
      nombre: 'Producto p1',
      tipo: 'servicio',
      unidad: 'HRS',
      precioNeto: 1000,
      exento: true,
      categoria: 'Servicios',
    });
    expect(creados[1]).toMatchObject({ codigo: 'SKU-p2', tipo: 'bien', unidad: 'UN' });
    expect(categorias()).toBe(1);
    expect(estado.producto('p1')).toMatchObject({
      estado: 'sincronizado',
      emiteId: 'emite-SKU-p1',
      sku: 'SKU-p1',
    });
    expect(estado.cursorProductos).toBe(new Date(Date.parse(TS) - MARGEN_CURSOR_MS).toISOString());
    expect(estado.cursor).toBeNull();
    expect(estado.resumen().productos).toEqual({ sincronizados: 2, omitidos: 0, conError: 0 });

    // La pasada siguiente parte del cursor de productos.
    expect(await pasadaProductos(deps)).toEqual({ ...sinNovedad, revisados: 2, sinCambios: 2 });
    expect(consultas[1]?.desde).toBe(estado.cursorProductos);
  });

  it('en uno que ya existe (también por alias o fusión) cambia sólo nombre y precio, y sólo si difieren', async () => {
    const { deps, buscados, creados, actualizados } = armar({
      productos: [
        producto('p1', { name: 'Producto p1 renombrado', unitPrice: '1500', unit: 'caja' }),
        producto('p2'),
      ],
      existentes: {
        // SKU-p1 es un alias: Emite DTE responde con el producto que lo absorbió.
        'SKU-p1': enEmite({ id: 'emite-destino', codigo: 'SKU-NUEVO', unidad: 'UN' }),
        'SKU-p2': enEmite({ id: 'emite-2', codigo: 'SKU-p2', nombre: 'Producto p2' }),
      },
    });
    expect(await pasadaProductos(deps)).toEqual({
      ...sinNovedad,
      revisados: 2,
      actualizados: 1,
      sinCambios: 1,
    });
    expect(buscados).toEqual(['SKU-p1', 'SKU-p2']);
    expect(creados).toHaveLength(0);
    expect(actualizados).toEqual([
      { id: 'emite-destino', cambios: { nombre: 'Producto p1 renombrado', precioNeto: 1500 } },
    ]);
    expect(deps.estado.producto('p1')).toMatchObject({
      estado: 'sincronizado',
      emiteId: 'emite-destino',
    });
  });

  it('omite los productos sin SKU, en otra moneda o inactivos que no existen acá, sin frenar el cursor', async () => {
    const { deps, estado, creados, actualizados } = armar({
      productos: [
        producto('p1', { sku: null }),
        producto('p2', { currencyCode: 'USD' }),
        producto('p3', { isActive: false }),
        producto('p4', { isActive: false, unitPrice: '2000' }),
        producto('p5'),
      ],
      existentes: { 'SKU-p4': enEmite({ id: 'emite-4', codigo: 'SKU-p4', nombre: 'Producto p4' }) },
    });
    expect(await pasadaProductos(deps)).toEqual({
      ...sinNovedad,
      revisados: 5,
      creados: 1,
      actualizados: 1,
      omitidos: 3,
    });
    expect(creados.map((c) => c.codigo)).toEqual(['SKU-p5']);
    // Inactivo en Coreinbox pero existente acá: recibe el precio nuevo y no se desactiva.
    expect(actualizados).toEqual([{ id: 'emite-4', cambios: { precioNeto: 2000 } }]);
    expect(estado.producto('p1')).toMatchObject({
      estado: 'omitido',
      sku: null,
      error: expect.stringContaining('SIN_SKU'),
    });
    expect(estado.producto('p2')?.error).toContain('MONEDA');
    expect(estado.producto('p3')?.error).toContain('INACTIVO');
    expect(estado.cursorProductos).not.toBeNull();
    expect(estado.resumen().productos).toEqual({ sincronizados: 2, omitidos: 3, conError: 0 });
  });

  it('un rechazo 4xx de Emite DTE queda como error y no bloquea a los demás', async () => {
    const { deps, estado } = armar({
      productos: [producto('p1'), producto('p2')],
      crear: (datos) => {
        if (datos.codigo === 'SKU-p1')
          throw new ErrorEmite(400, 'VALIDACION', 'unidad: demasiado larga');
        return enEmite({ id: 'emite-2', codigo: datos.codigo });
      },
    });
    expect(await pasadaProductos(deps)).toEqual({
      ...sinNovedad,
      revisados: 2,
      creados: 1,
      conError: 1,
    });
    expect(estado.producto('p1')).toMatchObject({
      estado: 'error',
      error: 'VALIDACION: unidad: demasiado larga',
    });
    expect(estado.cursorProductos).not.toBeNull();
  });

  it('una falla transitoria deja el producto pendiente y no mueve el cursor', async () => {
    const { deps, estado, creados } = armar({
      productos: [producto('p1')],
      crear: (datos, intento) => {
        if (intento === 1) throw new ErrorEmite(503, 'HTTP_503', 'caída');
        return enEmite({ id: 'emite-1', codigo: datos.codigo });
      },
    });
    expect(await pasadaProductos(deps)).toEqual({ ...sinNovedad, revisados: 1, pendientes: 1 });
    expect(estado.cursorProductos).toBeNull();
    expect(estado.producto('p1')).toBeNull();
    expect((await pasadaProductos(deps)).creados).toBe(1);
    expect(creados).toHaveLength(2);
    expect(estado.cursorProductos).not.toBeNull();
  });

  it('si Coreinbox no entrega las categorías, el producto queda pendiente', async () => {
    const { deps } = armar({ productos: [producto('p1', { categoryId: 'cat-1' })] });
    deps.coreinbox.categorias = async () => {
      throw new ErrorCoreinbox(429, 'API_KEY_RATE_LIMITED', 'espera');
    };
    expect(await pasadaProductos(deps)).toEqual({ ...sinNovedad, revisados: 1, pendientes: 1 });
    expect(deps.estado.cursorProductos).toBeNull();
  });

  it('si otro lo creó entre la consulta y el alta (409), lo trata como existente', async () => {
    let existe = false;
    const { deps, actualizados } = armar({
      productos: [producto('p1', { name: 'Nombre nuevo' })],
      crear: () => {
        existe = true;
        throw new ErrorEmite(409, 'PRODUCTO_DUPLICADO', 'Ya existe un producto con código SKU-p1');
      },
    });
    deps.emite.productoPorCodigo = async () =>
      existe ? enEmite({ id: 'emite-x', codigo: 'SKU-p1', nombre: 'Producto p1' }) : null;
    expect(await pasadaProductos(deps)).toEqual({ ...sinNovedad, revisados: 1, creados: 1 });
    expect(actualizados).toEqual([{ id: 'emite-x', cambios: { nombre: 'Nombre nuevo' } }]);
  });

  it('recorre todas las páginas y deduplica por id', async () => {
    const p1 = producto('p1');
    const { deps, creados } = armar({
      productos: [p1],
      listar: (_desde, cursor) =>
        cursor
          ? { items: [p1], nextCursor: null, timestamp: '2026-10-28T15:00:05.000Z' }
          : { items: [p1], nextCursor: 'c2', timestamp: TS },
    });
    expect((await pasadaProductos(deps)).creados).toBe(1);
    expect(creados).toHaveLength(1);
    expect(deps.estado.cursorProductos).toBe(
      new Date(Date.parse(TS) - MARGEN_CURSOR_MS).toISOString(),
    );
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

describe('pasadaProductos con la red de Coreinbox caída', () => {
  it('al pedir las categorías de un producto: queda pendiente, sin cursor y sin crear nada', async () => {
    const { peticiones, coreinbox, emite } = red({
      'GET crm.test/api/v1/products': {
        items: [producto('p1', { categoryId: 'cat-1' })],
        nextCursor: null,
      },
    });
    const estado = new Estado(':memory:');
    const resultado = await pasadaProductos({
      coreinbox,
      emite,
      estado,
      emisorId: EMISOR,
      desde: '2026-10-01T00:00:00.000Z',
    });
    expect(resultado).toEqual({ ...sinNovedad, revisados: 1, pendientes: 1 });
    expect(estado.producto('p1')).toBeNull();
    expect(estado.cursorProductos).toBeNull();
    expect(peticiones).toEqual([
      'GET crm.test/api/v1/products',
      'GET crm.test/api/v1/products/categories',
    ]);
  });
});
