import { describe, expect, it } from 'vitest';
import { Coreinbox, ErrorCoreinbox } from './cliente.js';
import type { ProductoCoreinbox } from './cliente.js';

const BASE = 'https://ci.example.com';

interface Peticion {
  url: URL;
  metodo: string;
  cabeceras: Headers;
  cuerpo: unknown;
}

/** `fetch` doble: registra las peticiones y responde en orden (la última se repite). */
function doble(...respuestas: Array<Response | Error>) {
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

function sobre(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ success: true, data, meta: { timestamp: '2026-10-28T15:00:00.000Z' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function producto(id: string, extra: Partial<ProductoCoreinbox> = {}): ProductoCoreinbox {
  return {
    id,
    sku: 'SKU-001',
    name: 'Producto de Prueba',
    description: null,
    type: 'product',
    unit: 'UN',
    unitPrice: '1000',
    currencyCode: 'CLP',
    isTaxable: true,
    taxRate: '0.19',
    categoryId: null,
    isActive: true,
    updatedAt: '2026-10-28T15:00:00.000Z',
    ...extra,
  };
}

describe('Coreinbox: producto', () => {
  it('pide el producto y devuelve data', async () => {
    const { http, peticiones } = doble(sobre(producto('id-1')));
    const r = await new Coreinbox(BASE, 'cik_prueba', http).producto('id-1');

    expect(r.id).toBe('id-1');
    expect(peticiones[0]?.metodo).toBe('GET');
    expect(peticiones[0]?.url.pathname).toBe('/api/v1/products/id-1');
    expect(peticiones[0]?.cabeceras.get('authorization')).toBe('Bearer cik_prueba');
  });
});

describe('Coreinbox: actualizarProducto', () => {
  it('manda un PATCH con los cambios', async () => {
    const { http, peticiones } = doble(sobre(producto('id-1', { name: 'X', unitPrice: 10 })));
    const r = await new Coreinbox(BASE, 'cik_prueba', http).actualizarProducto('id-1', {
      name: 'X',
      unitPrice: 10,
    });

    expect(r.name).toBe('X');
    expect(peticiones[0]?.metodo).toBe('PATCH');
    expect(peticiones[0]?.url.pathname).toBe('/api/v1/products/id-1');
    expect(peticiones[0]?.cuerpo).toEqual({ name: 'X', unitPrice: 10 });
  });
});

describe('Coreinbox: URLs', () => {
  it('urlImagen apunta a la imagen del producto', () => {
    const ci = new Coreinbox(BASE, 'cik_prueba', doble(sobre({})).http);
    expect(ci.urlImagen('id-1')).toBe(`${BASE}/api/v1/products/id-1/image`);
  });

  it('urlProducto codifica el id', () => {
    const ci = new Coreinbox(BASE, 'cik_prueba', doble(sobre({})).http);
    expect(ci.urlProducto('a b')).toBe(`${BASE}/api/v1/products/a%20b`);
  });
});

describe('Coreinbox: errores', () => {
  it('el sobre de error con 404 es un ErrorCoreinbox NOT_FOUND no transitorio', async () => {
    const { http } = doble(
      new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const error = await new Coreinbox(BASE, 'cik_prueba', http)
      .producto('id-1')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ErrorCoreinbox);
    expect((error as ErrorCoreinbox).status).toBe(404);
    expect((error as ErrorCoreinbox).code).toBe('NOT_FOUND');
    expect((error as ErrorCoreinbox).transitorio).toBe(false);
  });

  it('un 503 es transitorio', async () => {
    const { http } = doble(new Response('', { status: 503 }));
    const error = await new Coreinbox(BASE, 'cik_prueba', http)
      .producto('id-1')
      .catch((e: unknown) => e);
    expect((error as ErrorCoreinbox).code).toBe('HTTP_503');
    expect((error as ErrorCoreinbox).transitorio).toBe(true);
  });
});
