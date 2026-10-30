/**
 * Dobles sintéticos de Coreinbox, la web y Emite DTE a nivel de HTTP, con un mundo inicial de
 * productos inventados. Leen y escriben sobre ese mundo; son la única fuente de dobles de las
 * pruebas del catálogo, de la escritura y del panel. Sólo para pruebas: `tsconfig.json` deja `src/prueba/` fuera
 * del build.
 */
import { expect } from 'vitest';
import type { ProductoCoreinbox } from '../adaptadores/coreinbox/cliente.js';
import { Coreinbox } from '../adaptadores/coreinbox/cliente.js';
import type { ProductoEmite } from '../adaptadores/emite/cliente.js';
import { EmiteDte } from '../adaptadores/emite/cliente.js';
import { WooCommerce } from '../adaptadores/woocommerce/cliente.js';
import type { ProductoWoo } from '../adaptadores/woocommerce/tipos.js';
import type { SistemaCatalogo } from '../estado-catalogo.js';
import { Estado } from '../estado.js';
import { pasadaCatalogo } from '../flujos/productos/catalogo.js';

export const EMISOR = '11111111-1111-1111-1111-111111111111';
export const CI = 'https://ci.example.com';
export const TIENDA = 'https://tienda.example.com';
export const EMITE = 'http://emite.test';
export const AHORA = new Date('2026-10-30T12:00:00.000Z');
export const T1 = '2026-10-29T10:00:00.000Z';
export const T2 = '2026-10-30T11:00:00.000Z';
export const T0 = '2026-09-15T08:00:00.000Z';

// --- Dobles de los tres sistemas, a nivel de HTTP ---

export function coreinbox(id: string, extra: Partial<ProductoCoreinbox> = {}): ProductoCoreinbox {
  return {
    id,
    sku: null,
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
    imageStorageKey: null,
    updatedAt: T1,
    ...extra,
  };
}

export function woo(id: number, extra: Partial<ProductoWoo> = {}): ProductoWoo {
  return {
    id,
    sku: '',
    name: `Producto ${id}`,
    status: 'publish',
    catalog_visibility: 'visible',
    regular_price: '1000',
    price: '1000',
    date_modified: T1.slice(0, 19),
    date_modified_gmt: T1.slice(0, 19),
    permalink: `${TIENDA}/producto/p-${id}/`,
    type: 'simple',
    description: '',
    short_description: '',
    categories: [],
    images: [],
    attributes: [],
    meta_data: [],
    ...extra,
  };
}

export function emite(id: string, extra: Partial<ProductoEmite> = {}): ProductoEmite {
  return {
    id,
    codigo: id,
    nombre: `Producto ${id}`,
    descripcion: null,
    tipo: 'bien',
    unidad: 'UN',
    precioNeto: 1000,
    exento: false,
    categoria: null,
    activo: true,
    origen: 'historial',
    fusionadoEnId: null,
    updatedAt: T1,
    uso: { documentos: 0, cantidad: 0, ultimaVez: null, clientes: 0 },
    ...extra,
  };
}

export interface Mundo {
  coreinbox: ProductoCoreinbox[];
  woo: ProductoWoo[];
  emite: ProductoEmite[];
  /** Lo que `por-codigo` resuelve por alias (código → id de Emite DTE). */
  alias: Record<string, string>;
  /** Respuesta forzada de la tienda (para simular caídas). */
  wooStatus?: number;
  /** Ids de Emite DTE con inventario: `fusionar` los rechaza como origen. */
  inventario?: string[];
  /** Hora de la próxima escritura en los dobles; cada una avanza un segundo. */
  reloj?: number;
}

/** La hora de una escritura en el mundo: después de todo lo inicial, un segundo más cada vez. */
export function tic(mundo: Mundo): string {
  mundo.reloj = (mundo.reloj ?? Date.parse(T2) + 60_000) + 1000;
  return new Date(mundo.reloj).toISOString();
}

/** Lo que cada doble recibió en sus escrituras, en orden. */
export interface Escritura {
  sistema: 'coreinbox' | 'woocommerce' | 'emite';
  metodo: string;
  ruta: string;
  cuerpo: Record<string, unknown>;
}

export function mundoInicial(): Mundo {
  return {
    coreinbox: [
      coreinbox('c1', {
        sku: 'SKU-001',
        name: 'Válvula esfera 1/2',
        unitPrice: '4201.68',
        categoryId: 'cat-1',
        imageStorageKey: 'productos/c1.png',
      }),
      coreinbox('c2', {
        sku: 'SKU-002',
        name: 'Servicio de mantención',
        type: 'service',
        unit: 'hora',
        unitPrice: '50000',
      }),
      coreinbox('c3', { sku: 'SKU-003', name: 'Repuesto sello', unitPrice: '840.34' }),
      coreinbox('c4', { sku: null, name: 'Producto sin código', unitPrice: '100' }),
      coreinbox('c5', { sku: 'SKU-005', name: 'Bomba centrífuga', unitPrice: '84033.61' }),
    ],
    woo: [
      woo(11, {
        sku: 'SKU-001',
        name: 'Válvula esfera 1/2',
        regular_price: '5000',
        categories: [{ id: 3, name: 'Válvulas', slug: 'valvulas' }],
        images: [{ id: 91, src: `${TIENDA}/wp-content/uploads/valvula.jpg` }],
        attributes: [{ id: 1, name: 'Material', options: ['Bronce'] }],
        meta_data: [
          { id: 1, key: '_edit_lock', value: '123' },
          { id: 2, key: 'ficha_tecnica', value: `${TIENDA}/wp-content/uploads/ficha-001.pdf` },
        ],
      }),
      woo(15, { sku: 'SKU-005', name: 'Bomba centrífuga &amp; motor', regular_price: '99990' }),
      woo(16, { sku: 'SKU-006', name: 'Llave de paso', status: 'draft', regular_price: '3000' }),
      woo(17, { sku: '', name: 'Oferta sin SKU', regular_price: '2000' }),
    ],
    emite: [
      emite('e1', {
        codigo: 'VALV ESF 1/2',
        nombre: 'VALVULA ESFERA 1/2',
        uso: { documentos: 12, cantidad: 40, ultimaVez: '2026-09-01T00:00:00.000Z', clientes: 3 },
      }),
      emite('e2', { codigo: 'SKU-002', nombre: 'Mantencion' }),
      emite('e3', { codigo: 'XX-9', nombre: 'Bomba centrifuga c/motor' }),
      emite('e4', { codigo: 'ANT-003', nombre: 'Sello viejo', updatedAt: T0 }),
      emite('e5', {
        codigo: 'SKU-001',
        nombre: 'Válvula esfera 1/2',
        precioNeto: 4201.68,
        origen: 'manual',
        updatedAt: T0,
      }),
      emite('e6', { codigo: 'ZZZ', nombre: 'Cosa rara sin parecido', updatedAt: T0 }),
    ],
    alias: { 'SKU-003': 'e4' },
  };
}

export interface Peticion {
  metodo: string;
  url: URL;
}

export function respuesta(cuerpo: unknown, status = 200, cabeceras: Record<string, string> = {}) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json', ...cabeceras },
  });
}

/** Responde rutas propias de una prueba (las fotos, por ejemplo) antes que los tres sistemas. */
export type RutasExtra = (url: URL, init?: RequestInit) => Response | null;

/**
 * Las escrituras de los tres dobles sobre `mundo`: cambian el producto y su hora de modificación,
 * como el sistema real, para que la lectura siguiente las vea (y reconozca el eco).
 */
function escribir(mundo: Mundo, url: URL, metodo: string, cuerpo: Record<string, unknown>) {
  const ruta = url.pathname;
  if (url.origin === CI) {
    const sobre = (data: unknown) => ({ success: true, data, meta: { timestamp: T2 } });
    if (metodo === 'POST' && ruta === '/api/v1/products') {
      // Como el API real (`forbidNonWhitelisted`): `isActive` no está en `CreateProductDto`.
      if ('isActive' in cuerpo) {
        return respuesta({ success: false, error: { code: 'VALIDATION_ERROR' } }, 400);
      }
      if (mundo.coreinbox.some((c) => c.sku === cuerpo.sku)) {
        return respuesta({ success: false, error: { code: 'SKU_DUPLICATED' } }, 409);
      }
      const p = coreinbox(`ci-${String(cuerpo.sku)}`, {
        sku: String(cuerpo.sku),
        name: String(cuerpo.name),
        type: String(cuerpo.type),
        unitPrice: String(cuerpo.unitPrice),
        isTaxable: cuerpo.isTaxable !== false,
        taxRate: cuerpo.isTaxable === false ? '0' : '0.19',
        categoryId: typeof cuerpo.categoryId === 'string' ? cuerpo.categoryId : null,
        unit: null,
        updatedAt: tic(mundo),
      });
      mundo.coreinbox.push(p);
      return respuesta(sobre(p), 201);
    }
    const id = ruta.match(/^\/api\/v1\/products\/([^/]+)$/)?.[1];
    if (metodo === 'PATCH' && id) {
      const p = mundo.coreinbox.find((c) => c.id === decodeURIComponent(id));
      if (!p) return respuesta({ success: false, error: { code: 'NOT_FOUND' } }, 404);
      if (typeof cuerpo.name === 'string') p.name = cuerpo.name;
      if (typeof cuerpo.unitPrice === 'number') p.unitPrice = String(cuerpo.unitPrice);
      if (typeof cuerpo.isActive === 'boolean') p.isActive = cuerpo.isActive;
      if (cuerpo.categoryId !== undefined) p.categoryId = cuerpo.categoryId as string | null;
      if (cuerpo.type === 'product' || cuerpo.type === 'service') p.type = cuerpo.type;
      p.updatedAt = tic(mundo);
      return respuesta(sobre(p));
    }
  }
  if (url.origin === TIENDA) {
    const sello = () => tic(mundo).slice(0, 19);
    if (metodo === 'POST' && ruta === '/wp-json/wc/v3/products') {
      if (mundo.woo.some((w) => w.sku === cuerpo.sku)) {
        return respuesta({ code: 'product_invalid_sku', message: 'SKU repetido' }, 400);
      }
      const id = Math.max(100, ...mundo.woo.map((w) => w.id)) + 1;
      const hora = sello();
      const p = woo(id, {
        sku: String(cuerpo.sku),
        name: String(cuerpo.name),
        regular_price: String(cuerpo.regular_price ?? ''),
        price: String(cuerpo.regular_price ?? ''),
        status: String(cuerpo.status ?? 'draft'),
        date_modified: hora,
        date_modified_gmt: hora,
      });
      mundo.woo.push(p);
      return respuesta(p, 201);
    }
    const id = ruta.match(/^\/wp-json\/wc\/v3\/products\/(\d+)$/)?.[1];
    if (metodo === 'PUT' && id) {
      const p = mundo.woo.find((w) => w.id === Number(id));
      if (!p) return respuesta({ code: 'woocommerce_rest_product_invalid_id' }, 404);
      if (typeof cuerpo.name === 'string') p.name = cuerpo.name;
      if (typeof cuerpo.regular_price === 'string') p.regular_price = cuerpo.regular_price;
      if (typeof cuerpo.status === 'string') p.status = cuerpo.status;
      p.date_modified_gmt = p.date_modified = sello();
      return respuesta(p);
    }
  }
  if (url.origin === EMITE) {
    if (metodo === 'POST' && ruta === '/api/v1/productos') {
      const codigo = String(cuerpo.codigo);
      if (mundo.emite.some((e) => e.codigo === codigo && e.origen !== 'historial')) {
        return respuesta({ error: { code: 'PRODUCTO_DUPLICADO', message: 'ya existe' } }, 409);
      }
      const p = emite(`nuevo-${codigo}`, {
        codigo,
        nombre: String(cuerpo.nombre),
        precioNeto: Number(cuerpo.precioNeto),
        tipo: cuerpo.tipo === 'servicio' ? 'servicio' : 'bien',
        exento: cuerpo.exento === true,
        activo: cuerpo.activo !== false,
        categoria: typeof cuerpo.categoria === 'string' ? cuerpo.categoria : null,
        unidad: typeof cuerpo.unidad === 'string' ? cuerpo.unidad : 'UN',
        origen: 'manual',
        updatedAt: tic(mundo),
      });
      mundo.emite.push(p);
      return respuesta(p, 201);
    }
    if (metodo === 'POST' && ruta === '/api/v1/productos/fusionar') {
      const destino = mundo.emite.find((e) => e.id === cuerpo.destinoId);
      const origenes = (cuerpo.origenIds as string[]).map((id) =>
        mundo.emite.find((e) => e.id === id),
      );
      if (!destino || origenes.some((o) => !o)) {
        return respuesta({ error: { code: 'PRODUCTO_NO_EXISTE', message: 'no existe' } }, 404);
      }
      if (origenes.some((o) => o && mundo.inventario?.includes(o.id))) {
        return respuesta(
          { error: { code: 'PRODUCTO_CON_INVENTARIO', message: 'tiene inventario' } },
          409,
        );
      }
      for (const o of origenes) {
        if (!o) continue;
        o.fusionadoEnId = destino.id;
        o.activo = false;
        o.updatedAt = tic(mundo);
      }
      return respuesta({ destino, fusionados: origenes.length, lineasReapuntadas: 0 });
    }
    const id = ruta.match(/^\/api\/v1\/productos\/([^/]+)$/)?.[1];
    if (metodo === 'PATCH' && id) {
      const p = mundo.emite.find((e) => e.id === decodeURIComponent(id));
      if (!p) return respuesta({ error: { code: 'PRODUCTO_NO_EXISTE' } }, 404);
      expect(cuerpo.codigo).toBeUndefined();
      if (typeof cuerpo.nombre === 'string') p.nombre = cuerpo.nombre;
      if (typeof cuerpo.precioNeto === 'number') p.precioNeto = cuerpo.precioNeto;
      if (typeof cuerpo.activo === 'boolean') p.activo = cuerpo.activo;
      if (cuerpo.tipo === 'bien' || cuerpo.tipo === 'servicio') p.tipo = cuerpo.tipo;
      if (typeof cuerpo.categoria === 'string') p.categoria = cuerpo.categoria;
      if (typeof cuerpo.exento === 'boolean') p.exento = cuerpo.exento;
      p.updatedAt = tic(mundo);
      return respuesta(p);
    }
  }
  return respuesta({ error: 'escritura desconocida en el doble' }, 405);
}

/**
 * Un `fetch` que hace de los tres sistemas sobre `mundo` y registra cada petición. Las escrituras
 * (POST, PATCH, PUT) cambian `mundo` y quedan además en `escrituras`. Nunca hay DELETE.
 */
export function dobles(mundo: Mundo, extra: RutasExtra = () => null) {
  const peticiones: Peticion[] = [];
  const escrituras: Escritura[] = [];
  const http = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const metodo = init?.method ?? 'GET';
    peticiones.push({ metodo, url });
    const propia = extra(url, init);
    if (propia) return propia;
    expect(metodo).not.toBe('DELETE');
    if (metodo !== 'GET') {
      const cuerpo = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
      const sistema =
        url.origin === CI ? 'coreinbox' : url.origin === TIENDA ? 'woocommerce' : 'emite';
      escrituras.push({ sistema, metodo, ruta: url.pathname, cuerpo });
      return escribir(mundo, url, metodo, cuerpo);
    }
    const q = url.searchParams;

    if (url.origin === CI) {
      const sobre = (data: unknown) => ({ success: true, data, meta: { timestamp: T2 } });
      if (url.pathname === '/api/v1/products/categories') {
        return respuesta(sobre([{ id: 'cat-1', name: 'Válvulas', parentId: null }]));
      }
      if (url.pathname === '/api/v1/products') {
        const desde = Date.parse(q.get('updatedSince') ?? '');
        const items = mundo.coreinbox.filter((p) => Date.parse(p.updatedAt) >= desde);
        return respuesta(sobre({ items, nextCursor: null }));
      }
    }

    if (url.origin === TIENDA && url.pathname === '/wp-json/wc/v3/products') {
      if (mundo.wooStatus) return respuesta({ code: 'caida' }, mundo.wooStatus);
      const desde = q.get('modified_after');
      const todos = mundo.woo.filter(
        (p) => !desde || Date.parse(`${p.date_modified_gmt}Z`) > Date.parse(desde),
      );
      // Páginas de 2 para ejercitar la paginación.
      const pagina = Number(q.get('page'));
      const porPagina = 2;
      return respuesta(todos.slice((pagina - 1) * porPagina, pagina * porPagina), 200, {
        'x-wp-totalpages': String(Math.max(1, Math.ceil(todos.length / porPagina))),
      });
    }

    if (url.origin === EMITE) {
      if (url.pathname === '/api/v1/productos') {
        expect(q.get('orden')).toBe('reciente');
        expect(q.get('activo')).toBe('todos');
        const orden = [...mundo.emite].sort(
          (a, b) =>
            Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '') ||
            a.id.localeCompare(b.id),
        );
        const desde = q.get('cursor') ? orden.findIndex((p) => p.id === q.get('cursor')) + 1 : 0;
        const limite = 4;
        const data = orden.slice(desde, desde + limite);
        const hayMas = desde + limite < orden.length;
        return respuesta({ data, next_cursor: hayMas ? (data.at(-1)?.id ?? null) : null });
      }
      const porCodigo = url.pathname.match(/^\/api\/v1\/productos\/por-codigo\/(.+)$/);
      if (porCodigo?.[1]) {
        const codigo = decodeURIComponent(porCodigo[1]);
        const id = mundo.alias[codigo];
        const p = mundo.emite.find((e) => (id ? e.id === id : e.codigo === codigo));
        return p ? respuesta(p) : respuesta({ error: { code: 'NO_EXISTE' } }, 404);
      }
    }
    return respuesta({ error: 'ruta desconocida en el doble' }, 404);
  }) as typeof fetch;
  return { http, peticiones, escrituras };
}

export function armar(
  mundo = mundoInicial(),
  estado = new Estado(':memory:'),
  extra: RutasExtra = () => null,
) {
  const { http, peticiones, escrituras } = dobles(mundo, extra);
  const d = {
    coreinbox: new Coreinbox(CI, 'cik_prueba', http),
    emite: new EmiteDte(EMITE, 'edte_prueba', http),
    woocommerce: new WooCommerce(
      { url: TIENDA, consumerKey: 'ck_prueba', consumerSecret: 'cs_prueba' },
      http,
      { reintentos: 0 },
    ),
    estado,
    emisorId: EMISOR,
    escribir: false,
    sistemas: ['coreinbox', 'woocommerce', 'emite'] as SistemaCatalogo[],
    ahora: () => AHORA,
  };
  return { d, http, mundo, estado, peticiones, escrituras, pasada: () => pasadaCatalogo(d) };
}
