import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coreinbox } from '../adaptadores/coreinbox/cliente.js';
import { ErrorCoreinbox } from '../adaptadores/coreinbox/cliente.js';
import { Estado } from '../estado.js';
import { Salud } from '../salud.js';
import { crearServidor } from '../servidor.js';
import { crearPanel } from './index.js';

const EMITE = 'https://facturacion.example.com';
const ACTIVOS = { cotizaciones: true, productos: false, pedidos: false };

let estado: Estado;
let estadoCerrado: boolean;
let salud: Salud;
let servidor: Server | null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  estado = new Estado(':memory:');
  estadoCerrado = false;
  salud = new Salud(estado, ACTIVOS);
  servidor = null;
});

afterEach(async () => {
  if (servidor) await new Promise((r) => servidor!.close(r));
  if (!estadoCerrado) estado.cerrar();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function levantar(opciones: { emite?: string | null } = {}): Promise<string> {
  const panel = crearPanel({
    salud: () => salud.respuesta(),
    estado,
    enlaces: { emite: opciones.emite === undefined ? EMITE : opciones.emite },
  });
  servidor = crearServidor(
    {
      coreinbox: {} as Coreinbox,
      estado: new Estado(':memory:'),
      secreto: 'whsec_prueba',
      urlPublica: EMITE,
      tipoActividad: 't-1',
    },
    () => salud.respuesta(),
    [panel],
  );
  await new Promise<void>((r) => servidor!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
}

/** Fija el «ahora» de `Estado` (sólo se falsea Date) antes de la próxima escritura. */
function en(iso: string) {
  vi.setSystemTime(new Date(iso));
}

function cotizacion(
  n: number,
  estadoCot: 'creada' | 'error' = 'creada',
  error: string | null = null,
) {
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

function poblarBasico() {
  estado.cursor = '2026-10-28T14:55:02.113Z';
  estado.cursorProductos = '2026-10-27T09:00:00.000Z';
  en('2026-10-29T10:00:00.000Z');
  cotizacion(1);
  en('2026-10-29T11:00:00.000Z');
  cotizacion(2, 'error', 'Empresa de Prueba SpA (76000000-0) sin dirección');
  en('2026-10-29T12:00:00.000Z');
  estado.marcarWebhook('wh-prueba-1');
  en('2026-10-29T13:00:00.000Z');
  estado.guardarProducto({
    productId: 'p-1',
    sku: 'SKU-PRUEBA-1',
    estado: 'sincronizado',
    emiteId: 'ep-1',
    error: null,
  });
  en('2026-10-29T14:00:00.000Z');
  estado.guardarProducto({
    productId: 'p-2',
    sku: null,
    estado: 'omitido',
    emiteId: null,
    error: 'SIN_SKU: sin SKU',
  });
}

/** 60 cotizaciones: COT-60 la más nueva. Con 50 por página, la página 2 trae COT-10 a COT-1. */
function poblarSesenta() {
  for (let n = 1; n <= 60; n++) {
    en(new Date(Date.UTC(2026, 9, 29, 10, 0, n)).toISOString());
    cotizacion(n);
  }
}

async function pedir(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  return { res, texto: await res.text() };
}

const hrefs = (texto: string) => [...texto.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
const filas = (texto: string) => [...texto.matchAll(/<tr>\s*<td>/g)].length;
const posicion = (texto: string, aguja: string) => {
  const i = texto.indexOf(aguja);
  expect(i, `no aparece ${aguja}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe('panel: flujos', () => {
  it.each(['/panel', '/panel/', '/panel/flujos'])(
    'GET %s muestra los tres flujos',
    async (ruta_) => {
      poblarBasico();
      salud.registrarPasada('cotizaciones', { revisadas: 2, creadas: 1 });
      const base = await levantar();
      const { res, texto } = await pedir(base + ruta_);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      for (const nombre of ['Cotizaciones', 'Productos', 'Pedidos']) {
        expect(texto).toContain(`<h2>${nombre}</h2>`);
      }
      expect(texto).toContain('activo');
      expect(texto).toContain('apagado');
      expect(texto).toContain('2026-10-28T14:55:02.113Z');
      expect(texto).toContain('2026-10-27T09:00:00.000Z');
      expect(texto).toContain('todavía no implementado');
      expect(texto).toContain('revisadas');
    },
  );

  it('muestra los contadores del estado', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toMatch(/Creadas<\/dt>\s*<dd><span class="cifra">1<\/span>/);
    expect(texto).toMatch(/Con error<\/dt>\s*<dd><span class="cifra">1<\/span>/);
    expect(texto).toMatch(/Sincronizados<\/dt>\s*<dd><span class="cifra">1<\/span>/);
    expect(texto).toMatch(/Omitidos<\/dt>\s*<dd><span class="cifra">1<\/span>/);
  });

  it('muestra la tarjeta del catálogo con enlaces al resto del panel', async () => {
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toContain('<h2>Catálogo</h2>');
    expect(hrefs(texto)).toEqual(
      expect.arrayContaining(['./productos', './historicos', './conflictos']),
    );
  });

  it('sin pasadas ni fallas lo dice', async () => {
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toContain('sin pasadas desde el último arranque');
    expect(texto).toContain('ninguna desde el último arranque');
  });

  it('muestra código, status y "transitoria" de la última falla, nunca el mensaje', async () => {
    const err = new ErrorCoreinbox(503, 'HTTP_503', 'Coreinbox caído en http://interno.example');
    salud.registrarFalla('cotizaciones', err, true);
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toContain('HTTP_503');
    expect(texto).toMatch(/status <span class="cifra">503<\/span>/);
    expect(texto).toContain('transitoria');
    expect(texto).not.toContain('interno.example');
  });

  it('una falla no transitoria se marca como tal', async () => {
    salud.registrarFalla('productos', new TypeError('dato raro'), false);
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toContain('TypeError');
    expect(texto).toContain('no transitoria');
    expect(texto).not.toContain('dato raro');
  });

  it('lista los errores recientes con su mensaje y enlaza a todos', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).toContain('Errores recientes');
    expect(texto).toContain('Empresa de Prueba SpA (76000000-0) sin dirección');
    expect(hrefs(texto)).toContain('./eventos?flujo=cotizaciones&amp;estado=error');
  });

  it('sin errores no hay tabla de errores recientes', async () => {
    cotizacion(1);
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).not.toContain('Errores recientes');
  });

  it('muestra como mucho 5 errores recientes por flujo', async () => {
    for (let n = 1; n <= 8; n++) cotizacion(n, 'error', `fallo-${n}-x`);
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(filas(texto)).toBe(5);
  });

  it('escapa el HTML de un mensaje de error', async () => {
    cotizacion(1, 'error', 'rompe <b>negrita</b> & "comillas"');
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).not.toContain('<b>negrita</b>');
    expect(texto).toContain('&lt;b&gt;negrita&lt;/b&gt; &amp; &quot;comillas&quot;');
  });
});

describe('panel: enlaces', () => {
  it('en /panel los enlaces de navegación llevan el prefijo panel/', async () => {
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel`);
    expect(hrefs(texto)).toEqual(
      expect.arrayContaining([
        'panel/flujos',
        'panel/eventos',
        'panel/productos',
        'panel/historicos',
        'panel/conflictos',
        'panel/visibilidad',
        'panel/reglas',
      ]),
    );
    for (const nombre of [
      'Flujos',
      'Eventos',
      'Productos',
      'Históricos',
      'Conflictos',
      'Visibilidad web',
      'Quién manda',
    ]) {
      expect(texto).toContain(nombre);
    }
  });

  it.each(['/panel/', '/panel/flujos', '/panel/eventos'])(
    'en %s los enlaces de navegación son ./',
    async (ruta_) => {
      const base = await levantar();
      const { texto } = await pedir(base + ruta_);
      expect(hrefs(texto)).toEqual(expect.arrayContaining(['./flujos', './eventos']));
    },
  );

  it('marca la sección activa', async () => {
    const base = await levantar();
    const flujos = await pedir(`${base}/panel/flujos`);
    expect(flujos.texto).toMatch(/href="\.\/flujos"\s+aria-current="page"/);
    const eventos = await pedir(`${base}/panel/eventos`);
    expect(eventos.texto).toMatch(/href="\.\/eventos"\s+aria-current="page"/);
  });

  it.each(['/panel', '/panel/', '/panel/flujos', '/panel/eventos', '/panel/nada'])(
    'todos los href de %s son relativos salvo los de Emite DTE',
    async (ruta_) => {
      poblarBasico();
      const base = await levantar();
      const { texto } = await pedir(base + ruta_);
      for (const h of hrefs(texto)) {
        if (h.startsWith('/') || h.startsWith('http')) {
          expect(h.startsWith(`${EMITE}/cotizaciones/`), `href absoluto: ${h}`).toBe(true);
        }
      }
    },
  );

  it('con la URL de Emite DTE enlaza la cotización creada', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos`);
    expect(hrefs(texto)).toContain(`${EMITE}/cotizaciones/em-1`);
    expect(texto).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });

  it('sin URL de Emite DTE no hay enlaces externos pero sí el id', async () => {
    poblarBasico();
    const base = await levantar({ emite: null });
    for (const ruta_ of ['/panel/flujos', '/panel/eventos']) {
      const { texto } = await pedir(base + ruta_);
      expect(hrefs(texto).filter((h) => h.startsWith('http') || h.startsWith('/'))).toEqual([]);
      expect(texto).not.toContain('target="_blank"');
    }
    const { texto } = await pedir(`${base}/panel/eventos`);
    expect(texto).toContain('em-1');
    expect(texto).toContain('SKU-PRUEBA-1');
  });
});

describe('panel: eventos', () => {
  it('muestra cotizaciones, webhooks y productos con su estado y detalle', async () => {
    poblarBasico();
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/eventos`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(texto).toContain('COT-1');
    expect(texto).toContain('>q-2<');
    expect(texto).toContain('creada');
    expect(texto).toContain('Empresa de Prueba SpA (76000000-0) sin dirección');
    expect(texto).toContain('wh-prueba-1');
    expect(texto).toContain('Webhook de Emite DTE');
    expect(texto).toContain('visto');
    expect(texto).toContain('sincronizado');
    expect(texto).toContain('omitido');
    expect(texto).toContain('SIN_SKU: sin SKU');
    expect(hrefs(texto)).toContain('./productos/SKU-PRUEBA-1');
    expect(texto).toContain('5</span> en total');
    expect(texto).toContain('<th>SKU</th>');
  });

  it('ordena del más nuevo al más antiguo', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos`);
    const orden = ['p-2', 'p-1', 'wh-prueba-1', 'q-2', 'q-1'].map((id) =>
      posicion(texto, `>${id}<`),
    );
    expect(orden).toEqual([...orden].sort((a, b) => a - b));
  });

  it('?flujo=cotizaciones&estado=error deja sólo la cotización con error', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos?flujo=cotizaciones&estado=error`);
    expect(filas(texto)).toBe(1);
    expect(texto).toContain('>q-2<');
    expect(texto).not.toContain('>q-1<');
    expect(texto).toMatch(/<option value="cotizaciones"\s+selected>/);
    expect(texto).toContain('Quitar filtros');
  });

  it('?flujo=productos deja sólo productos', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos?flujo=productos`);
    expect(filas(texto)).toBe(2);
    expect(texto).toContain('SKU-PRUEBA-1');
    expect(texto).not.toContain('COT-');
    expect(texto).not.toContain('wh-prueba-1');
  });

  it('?estado=omitido deja sólo lo omitido', async () => {
    poblarBasico();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos?estado=omitido`);
    expect(filas(texto)).toBe(1);
    expect(texto).toContain('SIN_SKU: sin SKU');
  });

  describe('del registro del catálogo', () => {
    function poblarCatalogo() {
      en('2026-10-29T09:00:00.000Z');
      estado.catalogo.abrirConflicto(
        'SKU-001',
        'precio',
        { coreinbox: { valor: 100, en: null }, woocommerce: { valor: 120, en: null } },
        '2026-10-29T09:00:00.000Z',
      );
      estado.catalogo.guardarHistorico({
        emiteId: 'eh-1',
        codigo: 'VIEJO-1',
        nombre: 'Producto histórico de prueba',
        activo: true,
        fusionadoEnId: null,
        uso: null,
        modificadoEn: null,
        leidoEn: '2026-10-29T09:30:00.000Z',
      });
      estado.catalogo.proponerEmpate(
        'eh-1',
        { sku: 'SKU-002', puntaje: 0.9, motivo: 'mismo nombre', detalle: '{}' },
        '2026-10-29T10:00:00.000Z',
      );
      estado.catalogo.registrarAccion(
        'visibilidad',
        'admin@example.com',
        {},
        '2026-10-29T11:00:00.000Z',
      );
    }

    it('muestra conflictos, empates y acciones con su nombre y enlace al SKU', async () => {
      poblarCatalogo();
      const base = await levantar();
      const { res, texto } = await pedir(`${base}/panel/eventos`);
      expect(res.status).toBe(200);
      expect(filas(texto)).toBe(3);
      expect(texto).toContain('<td>Conflicto</td>');
      expect(texto).toContain('<td>Empate de histórico</td>');
      expect(texto).toContain('<td>Acción del panel</td>');
      expect(hrefs(texto)).toEqual(
        expect.arrayContaining(['./productos/SKU-001', './productos/SKU-002']),
      );
      expect(texto).toContain('campo <strong>precio</strong>');
      expect(texto).toContain('por admin@example.com');
      expect(texto).toContain('3</span> en total');
      const orden = ['Acción del panel', 'Empate de histórico', 'Conflicto'].map((n) =>
        posicion(texto, `<td>${n}</td>`),
      );
      expect(orden).toEqual([...orden].sort((a, b) => a - b));
    });

    it('?estado=abierto deja sólo el conflicto', async () => {
      poblarCatalogo();
      const base = await levantar();
      const { texto } = await pedir(`${base}/panel/eventos?estado=abierto`);
      expect(filas(texto)).toBe(1);
      expect(texto).toContain('<td>Conflicto</td>');
      expect(texto).not.toContain('<td>Empate de histórico</td>');
      expect(texto).toMatch(/<option value="abierto"\s+selected>/);
    });

    it('?estado=visibilidad deja sólo la acción', async () => {
      poblarCatalogo();
      const base = await levantar();
      const { texto } = await pedir(`${base}/panel/eventos?estado=visibilidad`);
      expect(filas(texto)).toBe(1);
      expect(texto).toContain('<td>Acción del panel</td>');
      expect(texto).not.toContain('<td>Conflicto</td>');
    });

    it('?estado=propuesto deja sólo el empate', async () => {
      poblarCatalogo();
      const base = await levantar();
      const { texto } = await pedir(`${base}/panel/eventos?estado=propuesto`);
      expect(filas(texto)).toBe(1);
      expect(texto).toContain('<td>Empate de histórico</td>');
    });
  });

  it('sin resultados lo dice con los filtros', async () => {
    poblarBasico();
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/eventos?flujo=productos&estado=visto`);
    expect(res.status).toBe(200);
    expect(texto).toContain('No hay eventos con estos filtros');
  });

  it('ignora los valores de filtro desconocidos', async () => {
    poblarBasico();
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/eventos?flujo=pedidos&estado=roto&x=1`);
    expect(res.status).toBe(200);
    expect(filas(texto)).toBe(5);
    expect(texto).not.toContain('Quitar filtros');
  });

  it('escapa el HTML del mensaje de error', async () => {
    cotizacion(1, 'error', 'mal <b>dato</b>');
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos`);
    expect(texto).not.toContain('<b>dato</b>');
    expect(texto).toContain('mal &lt;b&gt;dato&lt;/b&gt;');
  });
});

describe('panel: paginación', () => {
  it('la página 1 trae 50 filas y enlaza a la 2', async () => {
    poblarSesenta();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos`);
    expect(filas(texto)).toBe(50);
    expect(texto).toContain('>COT-60 ');
    expect(texto).toContain('>COT-11 ');
    expect(texto).not.toContain('>COT-10 ');
    expect(hrefs(texto)).toContain('?pagina=2');
    expect(hrefs(texto).some((h) => h.includes('pagina=0'))).toBe(false);
    expect(texto).toMatch(/de <span class="cifra">2<\/span>/);
    expect(texto).toContain('60</span> en total');
  });

  it('la página 2 trae el resto y enlaza a la anterior', async () => {
    poblarSesenta();
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/eventos?pagina=2`);
    expect(filas(texto)).toBe(10);
    expect(texto).toContain('>COT-10 ');
    expect(texto).toContain('>COT-1 ');
    expect(texto).not.toContain('>COT-11 ');
    expect(hrefs(texto)).toContain('?');
    expect(hrefs(texto).some((h) => h.includes('pagina=3'))).toBe(false);
  });

  it('los enlaces de página conservan los filtros', async () => {
    poblarSesenta();
    en('2026-10-29T11:00:00.000Z');
    estado.guardarProducto({
      productId: 'p-1',
      sku: 'SKU-PRUEBA-1',
      estado: 'omitido',
      emiteId: null,
      error: 'x',
    });
    const base = await levantar();
    const p1 = await pedir(`${base}/panel/eventos?flujo=cotizaciones&estado=creada`);
    expect(filas(p1.texto)).toBe(50);
    expect(hrefs(p1.texto)).toContain('?flujo=cotizaciones&amp;estado=creada&amp;pagina=2');
    const p2 = await pedir(`${base}/panel/eventos?flujo=cotizaciones&estado=creada&pagina=2`);
    expect(filas(p2.texto)).toBe(10);
    expect(hrefs(p2.texto)).toContain('?flujo=cotizaciones&amp;estado=creada');
  });

  it.each(['0', '-1', 'abc', '1.5', ''])('pagina=%s se trata como la página 1', async (valor) => {
    poblarSesenta();
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/eventos?pagina=${valor}`);
    expect(res.status).toBe(200);
    expect(filas(texto)).toBe(50);
    expect(texto).toContain('>COT-60 ');
  });

  it('una página más allá del final responde vacía sin romperse', async () => {
    poblarSesenta();
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/eventos?pagina=9`);
    expect(res.status).toBe(200);
    expect(filas(texto)).toBe(0);
  });
});

describe('panel: usuario', () => {
  it('muestra quién mira, escapado', async () => {
    const base = await levantar();
    const normal = await pedir(`${base}/panel/flujos`, {
      headers: { 'x-emite-usuario': 'Usuario de Prueba' },
    });
    expect(normal.texto).toContain('viendo como Usuario de Prueba');
    const malo = await pedir(`${base}/panel/flujos`, {
      headers: { 'x-emite-usuario': '<script>alert(1)</script>' },
    });
    expect(malo.texto).not.toContain('<script>');
    expect(malo.texto).toContain('viendo como &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('sin la cabecera no muestra nada', async () => {
    const base = await levantar();
    const { texto } = await pedir(`${base}/panel/flujos`);
    expect(texto).not.toContain('viendo como');
  });
});

describe('panel: rutas y métodos', () => {
  it.each(['/panel/nada', '/panel/flujos/', '/panel/eventos/', '/panel/flujos/x'])(
    'GET %s responde 404 HTML',
    async (ruta_) => {
      const base = await levantar();
      const { res, texto } = await pedir(base + ruta_);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(texto).toContain('No existe');
    },
  );

  it('POST /panel responde 405 con Allow', async () => {
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(texto).toContain('Método no permitido');
  });

  it('GET /panel/acciones/reglas responde 405 con Allow: POST', async () => {
    const base = await levantar();
    const { res, texto } = await pedir(`${base}/panel/acciones/reglas`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(texto).toContain('Método no permitido');
  });

  it('HEAD /panel/flujos responde 200 sin cuerpo', async () => {
    const base = await levantar();
    const res = await fetch(`${base}/panel/flujos`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('/panelx no es el panel: 404 JSON del servidor', async () => {
    const base = await levantar();
    const res = await fetch(`${base}/panelx`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'no existe' });
  });

  it('envía cabeceras de seguridad y no cachea', async () => {
    const base = await levantar();
    const { res } = await pedir(`${base}/panel/flujos`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self'");
  });
});

describe('panel montado junto al resto del servidor', () => {
  it('/salud sigue respondiendo el mismo JSON', async () => {
    poblarBasico();
    const base = await levantar();
    const res = await fetch(`${base}/salud`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(salud.respuesta())));
  });

  it('POST /webhooks con firma inválida sigue dando 401', async () => {
    const base = await levantar();
    const res = await fetch(`${base}/webhooks`, {
      method: 'POST',
      headers: {
        'webhook-id': 'wh-x',
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': 'v1,firmamala',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('panel: estado ilegible', () => {
  it('responde 500 HTML sin filtrar el error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = await levantar();
    estado.cerrar();
    estadoCerrado = true;
    for (const ruta_ of ['/panel/flujos', '/panel/eventos']) {
      const { res, texto } = await pedir(base + ruta_);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(texto).toContain('No se pudo leer el estado');
      expect(texto).not.toMatch(/database|sqlite|not open/i);
    }
  });
});
