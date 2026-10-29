import { describe, expect, it } from 'vitest';
import { ErrorWoo, WooCommerce, configWooDesdeEnv } from './cliente.js';
import type { PedidoWoo, ProductoWoo } from './tipos.js';

const CONFIG = {
  url: 'https://tienda.example.com',
  consumerKey: 'ck_prueba',
  consumerSecret: 'cs_prueba',
};
const BASIC = `Basic ${Buffer.from('ck_prueba:cs_prueba').toString('base64')}`;

interface Peticion {
  url: URL;
  metodo: string;
  cabeceras: Headers;
  cuerpo: unknown;
}

type Respuesta = Response | Error;

/** `fetch` doble: registra las peticiones y responde en orden (la última se repite). */
function doble(...respuestas: Respuesta[]) {
  const peticiones: Peticion[] = [];
  const http = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const cuerpo = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    peticiones.push({
      url: new URL(String(entrada)),
      metodo: init?.method ?? 'GET',
      cabeceras: new Headers(init?.headers),
      cuerpo,
    });
    const r = respuestas[Math.min(peticiones.length - 1, respuestas.length - 1)];
    if (r === undefined) throw new Error('sin respuesta configurada');
    if (r instanceof Error) throw r;
    return r.clone();
  }) as typeof fetch;
  return { http, peticiones };
}

function json(cuerpo: unknown, status = 200, cabeceras: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json', ...cabeceras },
  });
}

function sinEspera() {
  const esperas: number[] = [];
  return {
    esperas,
    dormir: async (ms: number) => {
      esperas.push(ms);
    },
  };
}

function producto(id: number, extra: Partial<ProductoWoo> = {}): ProductoWoo {
  return {
    id,
    sku: `SKU-${id}`,
    name: `Producto ${id}`,
    status: 'publish',
    regular_price: '1000',
    price: '1000',
    date_modified: '2026-10-28T12:00:00',
    date_modified_gmt: '2026-10-28T15:00:00',
    ...extra,
  };
}

function pedidoDePrueba(id: number): PedidoWoo {
  return {
    id,
    number: String(id),
    status: 'processing',
    date_modified: '2026-10-28T12:00:00',
    date_modified_gmt: '2026-10-28T15:00:00',
    billing: {
      first_name: 'Ana',
      last_name: 'Prueba',
      company: 'Empresa de Prueba SpA',
      address_1: 'Calle Falsa 123',
      address_2: '',
      city: 'Santiago',
      state: 'RM',
      postcode: '',
      country: 'CL',
      email: 'ana@example.com',
      phone: '',
    },
    line_items: [
      {
        id: 1,
        name: 'Producto 1',
        product_id: 10,
        sku: 'SKU-1',
        quantity: 2,
        price: 1000,
        total: '2000',
      },
    ],
    shipping_total: '0',
    meta_data: [{ id: 5, key: '_billing_rut', value: '76000000-0' }],
  };
}

describe('WooCommerce: peticiones', () => {
  it('manda Basic con las claves y llama a /wp-json/wc/v3/products con página y tamaño', async () => {
    const { http, peticiones } = doble(json([producto(1)], 200, { 'x-wp-totalpages': '1' }));
    const woo = new WooCommerce({ ...CONFIG, url: 'https://tienda.example.com///' }, http);

    const pagina = await woo.paginaProductos({ porPagina: 5 });

    expect(pagina.items.map((p) => p.sku)).toEqual(['SKU-1']);
    const [p] = peticiones;
    expect(p?.metodo).toBe('GET');
    expect(p?.url.origin).toBe('https://tienda.example.com');
    expect(p?.url.pathname).toBe('/wp-json/wc/v3/products');
    expect(p?.url.searchParams.get('page')).toBe('1');
    expect(p?.url.searchParams.get('per_page')).toBe('5');
    expect(p?.url.searchParams.has('modified_after')).toBe(false);
    expect(p?.cabeceras.get('authorization')).toBe(BASIC);
    expect(p?.cabeceras.get('accept')).toBe('application/json');
    expect(p?.cabeceras.has('content-type')).toBe(false);
  });

  it('usa modified_after con dates_are_gmt=true para el cursor en UTC', async () => {
    const { http, peticiones } = doble(json([]));
    const woo = new WooCommerce(CONFIG, http);

    await woo.paginaProductos({ modificadosDesde: '2026-10-28T15:00:00.000Z' });

    const q = peticiones[0]?.url.searchParams;
    expect(q?.get('modified_after')).toBe('2026-10-28T15:00:00.000Z');
    expect(q?.get('dates_are_gmt')).toBe('true');
    expect(q?.get('per_page')).toBe('100');
  });

  it('totalPaginas vale 1 si falta X-WP-TotalPages o no es número', async () => {
    const sin = new WooCommerce(CONFIG, doble(json([producto(1)])).http);
    expect((await sin.paginaProductos()).totalPaginas).toBe(1);
    const malo = new WooCommerce(
      CONFIG,
      doble(json([producto(1)], 200, { 'x-wp-totalpages': 'abc' })).http,
    );
    expect((await malo.paginaProductos()).totalPaginas).toBe(1);
  });

  it('productos() recorre las 3 páginas según X-WP-TotalPages', async () => {
    const cab = { 'x-wp-totalpages': '3' };
    const { http, peticiones } = doble(
      json([producto(1), producto(2)], 200, cab),
      json([producto(3)], 200, cab),
      json([producto(4)], 200, cab),
    );
    const woo = new WooCommerce(CONFIG, http);

    const ids: number[] = [];
    for await (const p of woo.productos('2026-10-01T00:00:00.000Z')) ids.push(p.id);

    expect(ids).toEqual([1, 2, 3, 4]);
    expect(peticiones.map((p) => p.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(peticiones.every((p) => p.url.searchParams.get('dates_are_gmt') === 'true')).toBe(true);
  });

  it('productos() corta si una página viene vacía', async () => {
    const { http, peticiones } = doble(
      json([producto(1)], 200, { 'x-wp-totalpages': '5' }),
      json([], 200, { 'x-wp-totalpages': '5' }),
    );
    const woo = new WooCommerce(CONFIG, http);

    const ids: number[] = [];
    for await (const p of woo.productos()) ids.push(p.id);

    expect(ids).toEqual([1]);
    expect(peticiones).toHaveLength(2);
  });

  it('paginaPedidos junta los estados con comas y pedidos() recorre las páginas', async () => {
    const cab = { 'x-wp-totalpages': '2' };
    const { http, peticiones } = doble(
      json([pedidoDePrueba(1)], 200, cab),
      json([pedidoDePrueba(2)], 200, cab),
    );
    const woo = new WooCommerce(CONFIG, http);

    const ids: number[] = [];
    for await (const p of woo.pedidos({
      estados: ['processing', 'completed'],
      modificadosDesde: '2026-10-28T15:00:00.000Z',
    })) {
      ids.push(p.id);
    }

    expect(ids).toEqual([1, 2]);
    expect(peticiones[0]?.url.pathname).toBe('/wp-json/wc/v3/orders');
    expect(peticiones[0]?.url.searchParams.get('status')).toBe('processing,completed');
    expect(peticiones[1]?.url.searchParams.get('page')).toBe('2');
    expect(peticiones[1]?.url.searchParams.get('dates_are_gmt')).toBe('true');
  });

  it('paginaPedidos sin estados no manda status', async () => {
    const { http, peticiones } = doble(json([]));
    await new WooCommerce(CONFIG, http).paginaPedidos();
    expect(peticiones[0]?.url.searchParams.has('status')).toBe(false);
  });

  it('pedido(id) hace GET /orders/{id}', async () => {
    const { http, peticiones } = doble(json(pedidoDePrueba(77)));
    const woo = new WooCommerce(CONFIG, http);

    const pedido = await woo.pedido(77);

    expect(pedido.billing.company).toBe('Empresa de Prueba SpA');
    expect(pedido.line_items[0]?.price).toBe(1000);
    expect(peticiones[0]?.metodo).toBe('GET');
    expect(peticiones[0]?.url.pathname).toBe('/wp-json/wc/v3/orders/77');
  });

  it('agregarNota hace POST con note y customer_note', async () => {
    const nota = { id: 9, note: 'Facturado, folio 123', customer_note: false, date_created: 'x' };
    const { http, peticiones } = doble(json(nota, 201));
    const woo = new WooCommerce(CONFIG, http);

    const creada = await woo.agregarNota(77, 'Facturado, folio 123');
    await woo.agregarNota(77, 'Hola', true);

    expect(creada.id).toBe(9);
    expect(peticiones[0]?.metodo).toBe('POST');
    expect(peticiones[0]?.url.pathname).toBe('/wp-json/wc/v3/orders/77/notes');
    expect(peticiones[0]?.cabeceras.get('content-type')).toBe('application/json');
    expect(peticiones[0]?.cuerpo).toEqual({ note: 'Facturado, folio 123', customer_note: false });
    expect(peticiones[1]?.cuerpo).toEqual({ note: 'Hola', customer_note: true });
  });

  it('actualizarProducto hace PUT sólo con los cambios dados', async () => {
    const { http, peticiones } = doble(json(producto(10, { regular_price: '1500' })));
    const woo = new WooCommerce(CONFIG, http);

    const actualizado = await woo.actualizarProducto(10, { regular_price: '1500' });

    expect(actualizado.regular_price).toBe('1500');
    expect(peticiones[0]?.metodo).toBe('PUT');
    expect(peticiones[0]?.url.pathname).toBe('/wp-json/wc/v3/products/10');
    expect(peticiones[0]?.cuerpo).toEqual({ regular_price: '1500' });
  });

  it('rechaza ids que no son enteros positivos sin llamar a la red', async () => {
    const { http, peticiones } = doble(json({}));
    const woo = new WooCommerce(CONFIG, http);

    await expect(woo.pedido(0)).rejects.toThrow(RangeError);
    await expect(woo.pedido(1.5)).rejects.toThrow(RangeError);
    await expect(woo.agregarNota(-1, 'x')).rejects.toThrow(RangeError);
    await expect(woo.actualizarProducto(Number.NaN, {})).rejects.toThrow(RangeError);
    expect(peticiones).toHaveLength(0);
  });

  it('el constructor rechaza una URL sin https', () => {
    expect(() => new WooCommerce({ ...CONFIG, url: 'http://tienda.example.com' })).toThrow(/https/);
  });
});

describe('WooCommerce: errores y reintentos', () => {
  it('429 seguido de 200 reintenta y respeta Retry-After', async () => {
    const { http, peticiones } = doble(
      json({ code: 'too_many', message: 'Despacio' }, 429, { 'retry-after': '7' }),
      json([producto(1)]),
    );
    const { esperas, dormir } = sinEspera();
    const woo = new WooCommerce(CONFIG, http, { dormir });

    const pagina = await woo.paginaProductos();

    expect(pagina.items).toHaveLength(1);
    expect(peticiones).toHaveLength(2);
    expect(esperas).toEqual([7000]);
  });

  it('Retry-After también respeta el tope', async () => {
    const { http } = doble(json({}, 429, { 'retry-after': '600' }), json([]));
    const { esperas, dormir } = sinEspera();

    await new WooCommerce(CONFIG, http, { dormir, esperaMaxMs: 5000 }).paginaProductos();

    expect(esperas).toEqual([5000]);
  });

  it('503 repetido agota los reintentos con esperas crecientes y tope, y lanza ErrorWoo transitorio', async () => {
    const { http, peticiones } = doble(json({ code: 'unavailable', message: 'Caído' }, 503));
    const { esperas, dormir } = sinEspera();
    const woo = new WooCommerce(CONFIG, http, {
      reintentos: 4,
      esperaBaseMs: 1000,
      esperaMaxMs: 5000,
      dormir,
    });

    const error = await woo.paginaProductos().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWoo);
    const e = error as ErrorWoo;
    expect(e.status).toBe(503);
    expect(e.code).toBe('unavailable');
    expect(e.transitorio).toBe(true);
    expect(peticiones).toHaveLength(5);
    expect(esperas).toEqual([1000, 2000, 4000, 5000]);
  });

  it('por omisión reintenta 3 veces', async () => {
    const { http, peticiones } = doble(new Response('', { status: 500 }));
    const { dormir } = sinEspera();

    const error = await new WooCommerce(CONFIG, http, { dormir })
      .pedido(1)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWoo);
    expect((error as ErrorWoo).code).toBe('HTTP_500');
    expect(peticiones).toHaveLength(4);
  });

  it('una falla de red es transitoria (status 0) y se reintenta', async () => {
    const { http, peticiones } = doble(new TypeError('fetch failed'), json([producto(1)]));
    const { esperas, dormir } = sinEspera();
    const woo = new WooCommerce(CONFIG, http, { dormir });

    expect((await woo.paginaProductos()).items).toHaveLength(1);
    expect(peticiones).toHaveLength(2);
    expect(esperas).toEqual([1000]);

    const caida = doble(new TypeError('fetch failed'));
    const error = await new WooCommerce(CONFIG, caida.http, { dormir, reintentos: 0 })
      .paginaProductos()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorWoo);
    expect((error as ErrorWoo).status).toBe(0);
    expect((error as ErrorWoo).code).toBe('RED');
    expect((error as ErrorWoo).transitorio).toBe(true);
  });

  it('400 con cuerpo de WooCommerce lanza ErrorWoo no transitorio con su code y message, sin reintentar', async () => {
    const { http, peticiones } = doble(
      json(
        {
          code: 'woocommerce_rest_invalid_product_id',
          message: 'ID no válido.',
          data: { status: 400 },
        },
        400,
      ),
    );
    const { esperas, dormir } = sinEspera();
    const woo = new WooCommerce(CONFIG, http, { dormir });

    const error = await woo.actualizarProducto(10, { name: 'X' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorWoo);
    const e = error as ErrorWoo;
    expect(e.status).toBe(400);
    expect(e.code).toBe('woocommerce_rest_invalid_product_id');
    expect(e.message).toBe('ID no válido.');
    expect(e.transitorio).toBe(false);
    expect(peticiones).toHaveLength(1);
    expect(esperas).toEqual([]);
  });

  it('4xx sin cuerpo JSON usa HTTP_<status>', async () => {
    const { http } = doble(new Response('<html>no</html>', { status: 401 }));

    const error = await new WooCommerce(CONFIG, http).pedido(1).catch((e: unknown) => e);

    expect((error as ErrorWoo).code).toBe('HTTP_401');
    expect((error as ErrorWoo).transitorio).toBe(false);
  });

  it('un 200 que no es JSON lanza un error no transitorio', async () => {
    const { http, peticiones } = doble(new Response('<html>mantenimiento</html>', { status: 200 }));

    const error = await new WooCommerce(CONFIG, http).pedido(1).catch((e: unknown) => e);

    expect((error as ErrorWoo).code).toBe('RESPUESTA_INVALIDA');
    expect((error as ErrorWoo).transitorio).toBe(false);
    expect(peticiones).toHaveLength(1);
  });
});

describe('configWooDesdeEnv', () => {
  it('devuelve null si las tres variables están vacías o ausentes', () => {
    expect(configWooDesdeEnv({})).toBeNull();
    expect(
      configWooDesdeEnv({ WOO_URL: ' ', WOO_CONSUMER_KEY: '', WOO_CONSUMER_SECRET: '  ' }),
    ).toBeNull();
  });

  it('falla si falta alguna pero no todas, nombrando lo que falta', () => {
    expect(() => configWooDesdeEnv({ WOO_URL: 'https://tienda.example.com' })).toThrow(
      'WOO_URL, WOO_CONSUMER_KEY y WOO_CONSUMER_SECRET van juntas; falta WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET',
    );
    expect(() => configWooDesdeEnv({ WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs' })).toThrow(
      /falta WOO_URL$/,
    );
  });

  it('exige https://', () => {
    expect(() =>
      configWooDesdeEnv({
        WOO_URL: 'http://tienda.example.com',
        WOO_CONSUMER_KEY: 'ck',
        WOO_CONSUMER_SECRET: 'cs',
      }),
    ).toThrow(/https/);
  });

  it('recorta espacios y quita las barras finales', () => {
    expect(
      configWooDesdeEnv({
        WOO_URL: '  https://tienda.example.com//  ',
        WOO_CONSUMER_KEY: ' ck_prueba ',
        WOO_CONSUMER_SECRET: ' cs_prueba ',
      }),
    ).toEqual({
      url: 'https://tienda.example.com',
      consumerKey: 'ck_prueba',
      consumerSecret: 'cs_prueba',
    });
  });
});
