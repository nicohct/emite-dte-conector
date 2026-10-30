import { describe, expect, it } from 'vitest';
import { EmiteDte, ErrorEmite } from './cliente.js';
import type { ProductoEmite } from './cliente.js';

const EMISOR = '11111111-1111-1111-1111-111111111111';
const BASE = 'http://app:3000';

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

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function producto(id: string, extra: Partial<ProductoEmite> = {}): ProductoEmite {
  return {
    id,
    codigo: 'SKU-001',
    nombre: 'Producto de Prueba',
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

describe('EmiteDte: listarProductos', () => {
  it('manda los filtros y la clave, y mapea la página', async () => {
    const { http, peticiones } = doble(
      json({ data: [producto('p-1'), producto('p-2')], next_cursor: 'sig' }),
    );
    const emite = new EmiteDte(BASE, 'edte_prueba', http);
    const pagina = await emite.listarProductos({
      emisorId: EMISOR,
      orden: 'reciente',
      activo: 'todos',
      origen: 'historial',
      cursor: 'abc',
      limite: 100,
    });

    expect(pagina.items.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(pagina.siguiente).toBe('sig');
    const [p] = peticiones;
    expect(p?.metodo).toBe('GET');
    expect(p?.url.pathname).toBe('/api/v1/productos');
    expect(p?.url.search).toBe(
      `?emisorId=${EMISOR}&limit=100&origen=historial&orden=reciente&activo=todos&cursor=abc`,
    );
    expect(p?.cabeceras.get('authorization')).toBe('Bearer edte_prueba');
  });

  it('sin next_cursor la siguiente página es null', async () => {
    const { http } = doble(json({ data: [producto('p-1')] }));
    const pagina = await new EmiteDte(BASE, 'edte_prueba', http).listarProductos({
      emisorId: EMISOR,
    });
    expect(pagina.siguiente).toBeNull();
  });

  it('sin filtros opcionales sólo manda emisor y límite por omisión', async () => {
    const { http, peticiones } = doble(json({ data: [] }));
    await new EmiteDte(BASE, 'edte_prueba', http).listarProductos({ emisorId: EMISOR });
    expect(peticiones[0]?.url.search).toBe(`?emisorId=${EMISOR}&limit=100`);
  });
});

describe('EmiteDte: fusionarProductos', () => {
  it('hace POST con el cuerpo tal cual', async () => {
    const resultado = { destino: producto('p-1'), fusionados: 2, lineasReapuntadas: 5 };
    const { http, peticiones } = doble(json(resultado));
    const fusion = { emisorId: EMISOR, destinoId: 'p-1', origenIds: ['p-2', 'p-3'] };

    const r = await new EmiteDte(BASE, 'edte_prueba', http).fusionarProductos(fusion);

    expect(r).toEqual(resultado);
    expect(peticiones[0]?.metodo).toBe('POST');
    expect(peticiones[0]?.url.pathname).toBe('/api/v1/productos/fusionar');
    expect(peticiones[0]?.cuerpo).toEqual(fusion);
  });
});

describe('EmiteDte: urlProducto', () => {
  it('codifica el id', () => {
    const emite = new EmiteDte(BASE, 'edte_prueba', doble(json({})).http);
    expect(emite.urlProducto('x y')).toBe('http://app:3000/api/v1/productos/x%20y');
  });
});

describe('EmiteDte: errores', () => {
  it('un 503 es un ErrorEmite transitorio', async () => {
    const { http } = doble(json({ error: { code: 'NO_DISPONIBLE', message: 'caído' } }, 503));
    const emite = new EmiteDte(BASE, 'edte_prueba', http);
    const error = await emite.listarProductos({ emisorId: EMISOR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ErrorEmite);
    expect((error as ErrorEmite).status).toBe(503);
    expect((error as ErrorEmite).code).toBe('NO_DISPONIBLE');
    expect((error as ErrorEmite).transitorio).toBe(true);
  });

  it('un 400 no es transitorio', async () => {
    const { http } = doble(json({ error: { code: 'VALIDACION' } }, 400));
    const error = await new EmiteDte(BASE, 'edte_prueba', http)
      .listarProductos({ emisorId: EMISOR })
      .catch((e: unknown) => e);
    expect((error as ErrorEmite).transitorio).toBe(false);
  });

  it('una falla de red es transitoria', async () => {
    const { http } = doble(new Error('ECONNRESET'));
    const error = await new EmiteDte(BASE, 'edte_prueba', http)
      .listarProductos({ emisorId: EMISOR })
      .catch((e: unknown) => e);
    expect((error as ErrorEmite).status).toBe(0);
    expect((error as ErrorEmite).transitorio).toBe(true);
  });
});

describe('EmiteDte: productoPorCodigo', () => {
  it('un 404 devuelve null', async () => {
    const { http, peticiones } = doble(json({ error: { code: 'NOT_FOUND' } }, 404));
    const r = await new EmiteDte(BASE, 'edte_prueba', http).productoPorCodigo(EMISOR, 'SKU-001');
    expect(r).toBeNull();
    expect(peticiones[0]?.url.pathname).toBe('/api/v1/productos/por-codigo/SKU-001');
    expect(peticiones[0]?.url.searchParams.get('emisorId')).toBe(EMISOR);
  });

  it('devuelve el producto si existe', async () => {
    const { http } = doble(json(producto('p-1')));
    const r = await new EmiteDte(BASE, 'edte_prueba', http).productoPorCodigo(EMISOR, 'SKU-001');
    expect(r?.id).toBe('p-1');
  });
});
