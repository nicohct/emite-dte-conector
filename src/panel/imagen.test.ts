import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Coreinbox } from '../adaptadores/coreinbox/cliente.js';
import { Estado } from '../estado.js';
import { armar, CI, coreinbox, mundoInicial, T2, TIENDA, woo } from '../prueba/catalogo.js';
import { Salud } from '../salud.js';
import { crearServidor } from '../servidor.js';
import { crearDescargaImagen, fotoPrincipal, leerImagen, TOPE_IMAGEN } from './imagen.js';
import { crearPanel } from './index.js';

const WEB_001 = `${TIENDA}/wp-content/uploads/valvula.jpg`;
const CI_001 = `${CI}/api/v1/products/c1/image`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

type Ruta = (init?: RequestInit) => Response;

let servidor: Server | null = null;
let estado: Estado | null = null;

afterEach(async () => {
  if (servidor) await new Promise((r) => servidor!.close(r));
  servidor = null;
  estado?.cerrar();
  estado = null;
});

function imagen(bytes: Uint8Array, tipo = 'image/jpeg', extra: Record<string, string> = {}) {
  return new Response(bytes, { status: 200, headers: { 'content-type': tipo, ...extra } });
}

/** Un mundo con las rutas de fotos de `rutas`, ya leído por una pasada, y el panel levantado. */
async function montar(
  rutas: Record<string, Ruta>,
  mundo = mundoInicial(),
  tienda: string | null = TIENDA,
) {
  estado = new Estado(':memory:');
  const m = armar(mundo, estado, (url, init) => rutas[url.href]?.(init) ?? null);
  await m.pasada();
  const salud = new Salud(estado, { cotizaciones: false, productos: true, pedidos: false });
  const panel = crearPanel({
    salud: () => salud.respuesta(),
    estado,
    enlaces: { emite: null },
    descargarImagen: crearDescargaImagen({ coreinbox: m.d.coreinbox, tienda, http: m.http }),
  });
  servidor = crearServidor(
    {
      coreinbox: {} as Coreinbox,
      estado: new Estado(':memory:'),
      secreto: 'whsec_prueba',
      urlPublica: 'https://facturacion.example.com',
      tipoActividad: 't-1',
    },
    () => salud.respuesta(),
    [panel],
  );
  await new Promise<void>((r) => servidor!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  const descargas = (prefijo?: string) =>
    m.peticiones.filter((p) =>
      prefijo ? p.url.href.startsWith(prefijo) : /\/image$|\.(jpg|png)$/.test(p.url.pathname),
    );
  return { ...m, base, descargas, estado: estado! };
}

async function pedir(base: string, sku: string) {
  const r = await fetch(`${base}/panel/imagen/${sku}`);
  return { r, bytes: new Uint8Array(await r.arrayBuffer()) };
}

describe('GET /panel/imagen/{sku}', () => {
  it('descarga la foto de la web (no la de Coreinbox) una vez y la sirve desde la caché', async () => {
    const m = await montar({
      [WEB_001]: () => imagen(JPEG),
      [CI_001]: () => imagen(PNG, 'image/png'),
    });

    const a = await pedir(m.base, 'SKU-001');
    expect(a.r.status).toBe(200);
    expect(a.r.headers.get('content-type')).toBe('image/jpeg');
    expect(a.r.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(a.bytes).toEqual(JPEG);
    expect(m.descargas().map((p) => p.url.href)).toEqual([WEB_001]);

    const b = await pedir(m.base, 'SKU-001');
    expect(b.bytes).toEqual(JPEG);
    expect(m.descargas()).toHaveLength(1);

    const entrada = m.estado.catalogo.fotos('SKU-001').find((f) => f.sistema === 'woocommerce')!;
    const guardada = m.estado.miniaturas.miniatura('SKU-001');
    expect(guardada?.hash).toBe(entrada.hash);
    expect(guardada?.contentType).toBe('image/jpeg');
    expect(Array.from(guardada!.bytes)).toEqual(Array.from(JPEG));
  });

  it('descarga de nuevo cuando cambia el hash del índice', async () => {
    const nueva = `${TIENDA}/wp-content/uploads/valvula-nueva.png`;
    const m = await montar({
      [WEB_001]: () => imagen(JPEG),
      [nueva]: () => imagen(PNG, 'image/png'),
    });
    await pedir(m.base, 'SKU-001');
    const hashAntes = m.estado.miniaturas.miniatura('SKU-001')!.hash;

    const p = m.mundo.woo.find((w) => w.id === 11)!;
    p.images = [{ id: 92, src: nueva }];
    p.date_modified_gmt = T2.slice(0, 19);
    p.date_modified = T2.slice(0, 19);
    await m.pasada();

    const r = await pedir(m.base, 'SKU-001');
    expect(r.r.headers.get('content-type')).toBe('image/png');
    expect(r.bytes).toEqual(PNG);
    expect(m.descargas()).toHaveLength(2);
    expect(m.estado.miniaturas.miniatura('SKU-001')!.hash).not.toBe(hashAntes);
  });

  it('un producto sólo en Coreinbox se descarga con la clave de la API', async () => {
    const mundo = mundoInicial();
    mundo.coreinbox.push(coreinbox('c9', { sku: 'SKU-009', imageStorageKey: 'productos/c9.jpg' }));
    const url = `${CI}/api/v1/products/c9/image`;
    let cabecera: string | null = null;
    const m = await montar(
      {
        [url]: (init) => {
          cabecera = new Headers(init?.headers).get('authorization');
          return imagen(JPEG);
        },
      },
      mundo,
    );

    const r = await pedir(m.base, 'SKU-009');

    expect(r.r.status).toBe(200);
    expect(r.bytes).toEqual(JPEG);
    expect(cabecera).toBe('Bearer cik_prueba');
    expect(m.descargas(url)).toHaveLength(1);
  });

  it('si en la web el producto no tiene foto, usa la de Coreinbox', async () => {
    const mundo = mundoInicial();
    mundo.woo.find((w) => w.id === 11)!.images = [];
    const m = await montar({ [CI_001]: () => imagen(PNG, 'image/png') }, mundo);
    const r = await pedir(m.base, 'SKU-001');
    expect(r.bytes).toEqual(PNG);
    expect(m.descargas().map((p) => p.url.href)).toEqual([CI_001]);
  });

  it('un producto sólo en la web con foto se sirve desde la web', async () => {
    const mundo = mundoInicial();
    const solo = `${TIENDA}/uploads/solo.png`;
    mundo.woo.push(woo(30, { sku: 'SKU-030', images: [{ id: 1, src: solo }] }));
    const m = await montar({ [solo]: () => imagen(PNG, 'image/png') }, mundo);
    expect((await pedir(m.base, 'SKU-030')).bytes).toEqual(PNG);
  });

  describe('404 y nada en la caché', () => {
    it('SKU sin foto', async () => {
      const m = await montar({});
      expect((await pedir(m.base, 'SKU-005')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-005')).toBeNull();
      expect(m.descargas()).toHaveLength(0);
    });

    it('SKU inexistente', async () => {
      const m = await montar({});
      expect((await pedir(m.base, 'SKU-NO')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-NO')).toBeNull();
    });

    it('el doble responde 500', async () => {
      const m = await montar({ [WEB_001]: () => new Response('boom', { status: 500 }) });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.descargas()).toHaveLength(1);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('la descarga falla por red', async () => {
      const m = await montar({
        [WEB_001]: () => {
          throw new Error('sin red');
        },
      });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it.each(['text/html', 'image/svg+xml', ''])('content-type %j', async (tipo) => {
      const m = await montar({
        [WEB_001]: () => new Response(JPEG, { headers: tipo ? { 'content-type': tipo } : {} }),
      });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('el cuerpo supera 1 MB, con content-length', async () => {
      const grande = new Uint8Array(TOPE_IMAGEN + 1);
      const m = await montar({
        [WEB_001]: () => imagen(grande, 'image/jpeg', { 'content-length': String(grande.length) }),
      });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('el cuerpo supera 1 MB, sin content-length', async () => {
      const m = await montar({
        [WEB_001]: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new Uint8Array(TOPE_IMAGEN / 2));
                c.enqueue(new Uint8Array(TOPE_IMAGEN / 2 + 1));
                c.close();
              },
            }),
            { headers: { 'content-type': 'image/jpeg' } },
          ),
      });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('un cuerpo de exactamente 1 MB se acepta', async () => {
      const m = await montar({ [WEB_001]: () => imagen(new Uint8Array(TOPE_IMAGEN)) });
      const r = await pedir(m.base, 'SKU-001');
      expect(r.r.status).toBe(200);
      expect(r.bytes.length).toBe(TOPE_IMAGEN);
    });

    it('la imagen de la web está en otro host: no se pide', async () => {
      const mundo = mundoInicial();
      mundo.woo.find((w) => w.id === 11)!.images = [
        { id: 91, src: 'https://cdn.evil.example.com/x.jpg' },
      ];
      const m = await montar({}, mundo);
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.peticiones.some((p) => p.url.hostname === 'cdn.evil.example.com')).toBe(false);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('la web responde con una redirección: no se sigue', async () => {
      const m = await montar({
        [WEB_001]: () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.example.com/x.jpg' },
          }),
      });
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.descargas()).toHaveLength(1);
      expect(m.peticiones.some((p) => p.url.hostname === 'evil.example.com')).toBe(false);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });

    it('sin tienda configurada no se descargan las de la web', async () => {
      const m = await montar({ [WEB_001]: () => imagen(JPEG) }, mundoInicial(), null);
      expect((await pedir(m.base, 'SKU-001')).r.status).toBe(404);
      expect(m.descargas()).toHaveLength(0);
      expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();
    });
  });

  it('sin tienda configurada sí se descargan las de Coreinbox', async () => {
    const mundo = mundoInicial();
    mundo.woo.find((w) => w.id === 11)!.images = [];
    const m = await montar({ [CI_001]: () => imagen(PNG, 'image/png') }, mundo, null);
    const r = await pedir(m.base, 'SKU-001');
    expect(r.r.status).toBe(200);
    expect(r.bytes).toEqual(PNG);
  });

  it('nunca descarga una URL que venga en la petición', async () => {
    const m = await montar({});
    const r = await fetch(
      `${m.base}/panel/imagen/${encodeURIComponent('https://evil.example.com/x.png')}`,
    );
    expect(r.status).toBe(404);
    expect(m.peticiones.some((p) => p.url.hostname === 'evil.example.com')).toBe(false);
    expect(m.descargas()).toHaveLength(0);
  });

  it('dos GET simultáneos del mismo SKU hacen una sola descarga', async () => {
    let soltar!: () => void;
    const puerta = new Promise<void>((r) => (soltar = r));
    const m = await montar({
      [WEB_001]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(c) {
              await puerta;
              c.enqueue(JPEG);
              c.close();
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    });

    const ambos = Promise.all([pedir(m.base, 'SKU-001'), pedir(m.base, 'SKU-001')]);
    await new Promise((r) => setTimeout(r, 150));
    soltar();
    const [a, b] = await ambos;

    expect(a.r.status).toBe(200);
    expect(a.bytes).toEqual(JPEG);
    expect(b.bytes).toEqual(JPEG);
    expect(m.descargas()).toHaveLength(1);
  });

  it('si se borra la caché, el siguiente pedido la reconstruye', async () => {
    const m = await montar({ [WEB_001]: () => imagen(JPEG) });
    await pedir(m.base, 'SKU-001');
    m.estado.miniaturas.quitar('SKU-001');
    expect(m.estado.miniaturas.miniatura('SKU-001')).toBeNull();

    const r = await pedir(m.base, 'SKU-001');

    expect(r.bytes).toEqual(JPEG);
    expect(m.estado.miniaturas.miniatura('SKU-001')).not.toBeNull();
    expect(m.descargas()).toHaveLength(2);
  });
});

describe('leerImagen', () => {
  it('devuelve tipo y bytes, ignorando parámetros del content-type', async () => {
    const r = await leerImagen(imagen(JPEG, 'image/jpeg; charset=binary'), TOPE_IMAGEN);
    expect(r?.contentType).toBe('image/jpeg');
    expect(Array.from(r!.bytes)).toEqual(Array.from(JPEG));
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])(
    'acepta %s',
    async (t) => {
      expect(await leerImagen(imagen(PNG, t), TOPE_IMAGEN)).not.toBeNull();
    },
  );

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream', 'image/bmp'])(
    'rechaza %s',
    async (t) => {
      expect(await leerImagen(imagen(PNG, t), TOPE_IMAGEN)).toBeNull();
    },
  );

  it('rechaza una respuesta no ok', async () => {
    const r = new Response(PNG, { status: 404, headers: { 'content-type': 'image/png' } });
    expect(await leerImagen(r, TOPE_IMAGEN)).toBeNull();
  });

  it('rechaza una respuesta sin cuerpo', async () => {
    const r = new Response(null, { status: 200, headers: { 'content-type': 'image/png' } });
    expect(await leerImagen(r, TOPE_IMAGEN)).toBeNull();
  });

  it('respeta el tope: el justo pasa y uno más no', async () => {
    expect(await leerImagen(imagen(new Uint8Array(10)), 10)).not.toBeNull();
    expect(await leerImagen(imagen(new Uint8Array(11)), 10)).toBeNull();
  });

  it('rechaza por content-length declarado sobre el tope', async () => {
    const r = imagen(new Uint8Array(5), 'image/png', { 'content-length': '11' });
    expect(await leerImagen(r, 10)).toBeNull();
  });
});

describe('fotoPrincipal', () => {
  async function leido(mundo = mundoInicial()) {
    estado = new Estado(':memory:');
    await armar(mundo, estado).pasada();
    return estado;
  }

  it('prefiere la de la web si el producto está en la web', async () => {
    expect(fotoPrincipal(await leido(), 'SKU-001')).toMatchObject({
      sistema: 'woocommerce',
      url: WEB_001,
    });
  });

  it('cae a Coreinbox si la web no tiene foto', async () => {
    const mundo = mundoInicial();
    mundo.woo.find((w) => w.id === 11)!.images = [];
    expect(fotoPrincipal(await leido(mundo), 'SKU-001')).toMatchObject({
      sistema: 'coreinbox',
      url: CI_001,
    });
  });

  it('sólo Coreinbox: usa la de Coreinbox', async () => {
    const mundo = mundoInicial();
    mundo.coreinbox.push(coreinbox('c9', { sku: 'SKU-009', imageStorageKey: 'p/c9.png' }));
    expect(fotoPrincipal(await leido(mundo), 'SKU-009')).toMatchObject({ sistema: 'coreinbox' });
  });

  it('null sin foto o para un SKU inexistente', async () => {
    const e = await leido();
    expect(fotoPrincipal(e, 'SKU-005')).toBeNull();
    expect(fotoPrincipal(e, 'SKU-NO')).toBeNull();
  });
});
