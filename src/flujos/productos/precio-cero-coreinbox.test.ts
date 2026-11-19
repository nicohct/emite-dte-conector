import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Coreinbox } from '../../adaptadores/coreinbox/cliente.js';
import type {
  CampoCatalogo,
  EdicionPendiente,
  LecturaGuardada,
  Regla,
  SistemaCatalogo,
  ValorCampo,
} from '../../estado-catalogo.js';
import { VERSION_REGISTRO } from '../../estado-catalogo.js';
import { Estado } from '../../estado.js';
import { crearPanel } from '../../panel/index.js';
import {
  AHORA,
  CI,
  armar,
  coreinbox,
  mundoInicial,
  tic,
  type Mundo,
} from '../../prueba/catalogo.js';
import { Salud } from '../../salud.js';
import { crearServidor } from '../../servidor.js';
import { aplicarAccion } from './acciones.js';
import { crearAtencionCatalogo } from './api.js';
import {
  AVISO_PRECIO_CERO_COREINBOX,
  calcularProducto,
  esPrecioCeroCoreinbox,
  pendientesCerradas,
  type EntradaCanonico,
} from './canonico.js';
import { precioCoreinbox, recalcularTodo } from './lectura.js';

const EN = '2026-10-28T15:00:00.000Z';
const PRIMERA = '2026-10-29T00:00:00.000Z';
const HORA_1 = '2026-10-29T10:00:00.000Z';
const HORA_2 = '2026-10-29T11:00:00.000Z';
const CLAVE = 'clave-de-prueba';

// --- Cálculo puro ---

function lectura(
  sistema: SistemaCatalogo,
  campos: Partial<Record<CampoCatalogo, ValorCampo>>,
  cambios: Partial<Record<CampoCatalogo, string>> = {},
  extra: Record<string, unknown> = {},
): LecturaGuardada {
  const guardados: LecturaGuardada['campos'] = {};
  for (const [campo, valor] of Object.entries(campos) as Array<[CampoCatalogo, ValorCampo]>) {
    guardados[campo] = {
      valor,
      vistoEn: EN,
      leidoEn: EN,
      escritoValor: null,
      escritoEn: null,
      cambioEn: cambios[campo] ?? null,
    };
  }
  return {
    sistema,
    idExterno: `${sistema}-1`,
    modificadoEn: EN,
    leidoEn: EN,
    extra,
    campos: guardados,
  };
}

/** La taza en los tres sistemas: precio de cada uno y hora del cambio de precio si lo hubo. */
function tres(
  precios: Partial<Record<SistemaCatalogo, ValorCampo>>,
  cambios: Partial<Record<SistemaCatalogo, string>> = {},
): EntradaCanonico['lecturas'] {
  const r: EntradaCanonico['lecturas'] = {};
  const hora = (s: SistemaCatalogo) => (cambios[s] ? { precio: cambios[s] } : {});
  if ('woocommerce' in precios) {
    r.woocommerce = lectura(
      'woocommerce',
      { nombre: 'Taza', precio: precios.woocommerce ?? null, activo: true },
      hora('woocommerce'),
      { estado: 'publish' },
    );
  }
  if ('coreinbox' in precios) {
    r.coreinbox = lectura(
      'coreinbox',
      { nombre: 'Taza', precio: precios.coreinbox ?? null, activo: true, tipo: 'bien' },
      hora('coreinbox'),
      { moneda: 'CLP' },
    );
  }
  if ('emite' in precios) {
    r.emite = lectura(
      'emite',
      { nombre: 'Taza', precio: precios.emite ?? null, activo: true, tipo: 'bien', exento: false },
      hora('emite'),
    );
  }
  return r;
}

function entrada(extra: Partial<EntradaCanonico> = {}): EntradaCanonico {
  return {
    sku: 'SKU-001',
    lecturas: {},
    reglas: [],
    visibilidad: { estado: 'aprobado', usuario: null, en: EN },
    conflictosAbiertos: [],
    ...extra,
  };
}

const regla = (campo: CampoCatalogo, fuente: Regla['fuente']): Regla => ({
  ambito: '*',
  campo,
  fuente,
  usuario: null,
  en: EN,
});

const edicion = (valor: number): EdicionPendiente => ({
  sku: 'SKU-001',
  campo: 'precio',
  valor,
  usuario: 'ana@example.com',
  en: HORA_2,
});

const escriturasDePrecio = (p: ReturnType<typeof calcularProducto>) =>
  (p.escrituras ?? []).filter((w) => w.campo === 'precio');

describe('precio 0 en Coreinbox: lectura', () => {
  it('0, negativo o un neto que redondea a 0 en bruto son precio 0; otra moneda es sin precio', () => {
    expect(precioCoreinbox(coreinbox('x', { unitPrice: '0' }))).toBe(0);
    expect(precioCoreinbox(coreinbox('x', { unitPrice: '0.3' }))).toBe(0);
    expect(precioCoreinbox(coreinbox('x', { unitPrice: '-100' }))).toBe(-119);
    expect(precioCoreinbox(coreinbox('x', { unitPrice: '0', currencyCode: 'USD' }))).toBeNull();
    for (const v of [0, -119]) expect(esPrecioCeroCoreinbox('coreinbox', 'precio', v)).toBe(true);
    expect(esPrecioCeroCoreinbox('coreinbox', 'precio', 1)).toBe(false);
    expect(esPrecioCeroCoreinbox('coreinbox', 'precio', null)).toBe(false);
    expect(esPrecioCeroCoreinbox('emite', 'precio', 0)).toBe(false);
  });
});

describe('precio 0 en Coreinbox: cálculo del canónico', () => {
  it('con la web con precio: manda la web, lleva el aviso y no se le escribe a Coreinbox', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres({ woocommerce: 6990, coreinbox: 0, emite: 5990 }) }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 6990, fuente: 'woocommerce' });
    expect(p.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(escriturasDePrecio(p)).toEqual([
      { sistema: 'emite', campo: 'precio', antes: 5990, valor: 6990, revierte: false },
    ]);
    // El 0 no es una diferencia que haya que conciliar: es un error de datos.
    expect(p.diferencias.find((d) => d.campo === 'precio')?.valores).toEqual({
      woocommerce: 6990,
      emite: 5990,
    });
  });

  it('con la web sin precio: manda Emite DTE y no se escribe precio en ningún lado', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres({ woocommerce: null, coreinbox: 0, emite: 5990 }) }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'emite' });
    expect(p.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(escriturasDePrecio(p)).toEqual([]);
  });

  it('sólo en Coreinbox: queda sin precio canónico y no se crea en Emite DTE', () => {
    const p = calcularProducto(entrada({ visibilidad: null, lecturas: tres({ coreinbox: 0 }) }));
    expect(p.canonico.precio).toMatchObject({ valor: null, fuente: null });
    expect(p.precioNeto).toBeNull();
    expect(p.crearEn).not.toContain('emite');
    expect(p.avisos).toEqual([
      AVISO_PRECIO_CERO_COREINBOX,
      'Falta en Emite DTE pero no tiene nombre y precio para crearlo',
    ]);
  });

  it('un precio negativo es lo mismo que un 0', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres({ woocommerce: null, coreinbox: -119, emite: 5990 }) }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'emite' });
    expect(p.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(escriturasDePrecio(p)).toEqual([]);
  });

  it('al arrancar (sin primera escritura) el 0 de Coreinbox se salta', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres({ woocommerce: null, coreinbox: 0, emite: 4990 }) }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 4990, fuente: 'emite', modo: 'ultimo' });
  });

  it('en último cambio, pasar Coreinbox de un valor a 0 no cuenta: rige el cambio anterior', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(
          { woocommerce: 5990, coreinbox: 0, emite: 7990 },
          { emite: HORA_1, coreinbox: HORA_2 },
        ),
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 7990, fuente: 'emite' });
    expect(escriturasDePrecio(p)).toEqual([
      { sistema: 'woocommerce', campo: 'precio', antes: 5990, valor: 7990, revierte: false },
    ]);
  });

  it('con Coreinbox de propietario explícito, el 0 no manda ni se escribe en ningún sistema', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres({ woocommerce: 6990, coreinbox: 0, emite: 6990 }),
        reglas: [regla('precio', 'coreinbox')],
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({
      valor: 6990,
      fuente: 'woocommerce',
      modo: 'propietario',
    });
    expect(escriturasDePrecio(p)).toEqual([]);
    expect(p.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
  });

  it('una edición de precio del panel sí se escribe en Coreinbox', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres({ woocommerce: 6990, coreinbox: 0, emite: 6990 }),
        primeraEscritura: PRIMERA,
        ediciones: [edicion(6490)],
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 6490, fuente: 'panel' });
    expect(escriturasDePrecio(p).map((w) => [w.sistema, w.valor])).toEqual([
      ['coreinbox', 6490],
      ['woocommerce', 6490],
      ['emite', 6490],
    ]);
  });

  it('con otro propietario, la edición va a él y también a Coreinbox, y no se cierra sin él', () => {
    const e = entrada({
      lecturas: tres({ woocommerce: 6490, coreinbox: 0, emite: 6490 }),
      reglas: [regla('precio', 'woocommerce')],
      primeraEscritura: PRIMERA,
      ediciones: [edicion(6490)],
    });
    const p = calcularProducto(e);
    expect(escriturasDePrecio(p)).toEqual([
      { sistema: 'coreinbox', campo: 'precio', antes: 0, valor: 6490, revierte: false },
    ]);
    expect(pendientesCerradas(e, p)).toEqual([]);
  });

  it('un 0 puesto en Coreinbox después de una edición no la deja atrás', () => {
    const e = entrada({
      lecturas: tres({ woocommerce: 6990, coreinbox: 0, emite: 6990 }, { coreinbox: HORA_2 }),
      primeraEscritura: PRIMERA,
      ediciones: [{ ...edicion(6490), en: HORA_1 }],
    });
    const p = calcularProducto(e);
    expect(p.canonico.precio).toMatchObject({ valor: 6490, fuente: 'panel' });
    expect(pendientesCerradas(e, p)).toEqual([]);
  });

  it('con un precio mayor que 0 en Coreinbox no hay aviso', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres({ woocommerce: 6990, coreinbox: 6990, emite: 6990 }) }),
    );
    expect(p.avisos).not.toContain(AVISO_PRECIO_CERO_COREINBOX);
  });
});

// --- Las pasadas ---

const enCoreinbox = (m: Mundo, id: string) => {
  const p = m.coreinbox.find((c) => c.id === id);
  if (!p) throw new Error(`no está ${id} en Coreinbox`);
  return p;
};

function aManoCoreinbox(m: Mundo, id: string, cambios: Record<string, unknown>): void {
  const p = enCoreinbox(m, id);
  Object.assign(p, cambios);
  p.updatedAt = tic(m);
}

function aManoWeb(m: Mundo, id: number, regular_price: string): void {
  const p = m.woo.find((w) => w.id === id);
  if (!p) throw new Error(`no está ${id} en la web`);
  p.regular_price = regular_price;
  p.date_modified_gmt = p.date_modified = tic(m).slice(0, 19);
}

/** El mundo de siempre con la válvula (SKU-001, c1) en 0 en Coreinbox. */
function conCero(): Mundo {
  const m = mundoInicial();
  enCoreinbox(m, 'c1').unitPrice = '0';
  return m;
}

const preciosEscritosEnCoreinbox = (m: ReturnType<typeof armar>, desde = 0) =>
  m.escrituras
    .slice(desde)
    .filter((w) => w.ruta.endsWith('/products/c1') && 'unitPrice' in w.cuerpo);

const alertas = (m: ReturnType<typeof armar>, estado: 'precio_cero' | 'precio_corregido') =>
  m.estado.eventos({ estado, porPagina: 500 });

describe('precio 0 en Coreinbox: pasadas', () => {
  it('con la web con precio: no se escribe en ningún sistema, no hay conflicto y queda una alerta', async () => {
    const m = armar(conCero());
    m.d.escribir = true;
    await m.pasada();
    const r = m.estado.catalogo;
    expect(r.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 5000,
      fuente: 'woocommerce',
    });
    expect(r.producto('SKU-001')?.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(preciosEscritosEnCoreinbox(m)).toEqual([]);
    expect(enCoreinbox(m.mundo, 'c1').unitPrice).toBe('0');
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(4201.68);
    expect(m.mundo.woo.find((w) => w.id === 11)?.regular_price).toBe('5000');
    expect(r.conflictos('SKU-001', true)).toEqual([]);
    // El 0 sigue guardado: es lo que levanta la alerta.
    expect(r.lecturas('SKU-001').coreinbox?.campos.precio?.valor).toBe(0);
  });

  it('con la web sin precio: manda Emite DTE y nadie recibe precio', async () => {
    const mundo = conCero();
    const web = mundo.woo.find((w) => w.id === 11);
    if (web) web.regular_price = '';
    const m = armar(mundo);
    m.d.escribir = true;
    await m.pasada();
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 5000,
      fuente: 'emite',
    });
    expect(preciosEscritosEnCoreinbox(m)).toEqual([]);
    expect(m.escrituras.filter((w) => w.ruta.endsWith('/products/11'))).toEqual([]);
  });

  it('sólo en Coreinbox con 0: no se crea en Emite DTE', async () => {
    const mundo = mundoInicial();
    mundo.coreinbox.push(coreinbox('c9', { sku: 'SKU-009', name: 'Codo PVC', unitPrice: '0' }));
    const m = armar(mundo);
    m.d.escribir = true;
    await m.pasada();
    expect(m.mundo.emite.some((e) => e.codigo === 'SKU-009')).toBe(false);
    expect(m.estado.catalogo.producto('SKU-009')?.avisos).toEqual([
      AVISO_PRECIO_CERO_COREINBOX,
      'Falta en Emite DTE pero no tiene nombre y precio para crearlo',
    ]);
  });

  it('la alerta deja un evento al entrar, una sola vez mientras siga en 0, con enlace a Coreinbox', async () => {
    const m = armar(conCero());
    m.d.escribir = true;
    await m.pasada();
    await m.pasada();
    await m.pasada();
    expect(alertas(m, 'precio_cero')).toEqual([
      expect.objectContaining({
        flujo: 'productos',
        tipo: 'alerta',
        sku: 'SKU-001',
        idExterno: 'c1',
        sistema: 'coreinbox',
        campo: 'precio',
        mensaje: `${CI}/api/v1/products/c1`,
      }),
    ]);
    expect(alertas(m, 'precio_corregido')).toEqual([]);
  });

  it('pasar Coreinbox de un valor a 0 con la web cambiando a la vez: sin conflicto y sin tocar Coreinbox', async () => {
    const m = armar();
    m.d.escribir = true;
    await m.pasada();
    aManoCoreinbox(m.mundo, 'c1', { unitPrice: '0' });
    aManoWeb(m.mundo, 11, '6000');
    const marca = m.escrituras.length;
    const r = await m.pasada();
    expect(r.conflictosNuevos).toBe(0);
    expect(m.estado.catalogo.conflictos('SKU-001', true)).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 6000,
      fuente: 'woocommerce',
    });
    // 6.000 bruto llega a Emite DTE; a Coreinbox no.
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(5042.02);
    expect(preciosEscritosEnCoreinbox(m, marca)).toEqual([]);
    expect(alertas(m, 'precio_cero')).toHaveLength(1);
  });

  it('una edición de precio del panel llega a Coreinbox y cierra la alerta', async () => {
    const m = armar(conCero());
    m.d.escribir = true;
    await m.pasada();
    aplicarAccion(
      m.estado.catalogo,
      'edicion',
      { sku: 'SKU-001', campos: { precio: 6490 } },
      'ana@example.com',
      AHORA.toISOString(),
    );
    await m.pasada();
    expect(enCoreinbox(m.mundo, 'c1').unitPrice).toBe('5453.78');
    await m.pasada();
    const r = m.estado.catalogo;
    expect(r.producto('SKU-001')?.avisos).not.toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(r.pendientes('SKU-001')).toEqual([]);
    expect(r.resumen().precioCeroCoreinbox).toEqual({ total: 0, conSku: 0, sinSku: 0 });
    expect(alertas(m, 'precio_corregido')).toEqual([
      expect.objectContaining({ sku: 'SKU-001', idExterno: 'c1' }),
    ]);
  });

  it('corregirlo en Coreinbox cierra la alerta; volver a 0 la abre otra vez', async () => {
    const m = armar(conCero());
    m.d.escribir = true;
    await m.pasada();
    aManoCoreinbox(m.mundo, 'c1', { unitPrice: '4621.85' });
    await m.pasada();
    const r = m.estado.catalogo;
    expect(r.producto('SKU-001')?.avisos).not.toContain(AVISO_PRECIO_CERO_COREINBOX);
    // Es el último cambio: 5.500 bruto llega a los demás.
    expect(r.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 5500,
      fuente: 'coreinbox',
    });
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(4621.85);
    expect(alertas(m, 'precio_corregido')).toHaveLength(1);
    await m.pasada();
    expect(alertas(m, 'precio_corregido')).toHaveLength(1);

    aManoCoreinbox(m.mundo, 'c1', { unitPrice: '0' });
    await m.pasada();
    expect(alertas(m, 'precio_cero')).toHaveLength(2);
  });

  it('sin SKU: cuenta, deja su evento sin SKU y se ve en la vista «Sin SKU»', async () => {
    const mundo = mundoInicial();
    enCoreinbox(mundo, 'c4').unitPrice = '0';
    const m = armar(mundo);
    await m.pasada();
    await m.pasada();
    const r = m.estado.catalogo;
    expect(r.resumen().precioCeroCoreinbox).toEqual({ total: 1, conSku: 0, sinSku: 1 });
    expect(alertas(m, 'precio_cero')).toEqual([
      expect.objectContaining({ sku: null, idExterno: 'c4', tipo: 'alerta' }),
    ]);
    // Al ponerle SKU en Coreinbox sigue la misma alerta: no se repite el evento.
    aManoCoreinbox(m.mundo, 'c4', { sku: 'SKU-004' });
    await m.pasada();
    expect(r.resumen().precioCeroCoreinbox).toEqual({ total: 1, conSku: 1, sinSku: 0 });
    expect(alertas(m, 'precio_cero')).toHaveLength(1);
    expect(r.producto('SKU-004')?.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
  });
});

describe('precio 0 en Coreinbox: contador y filtro en el registro', () => {
  it('resumen y listar({ precioCero }) salen del registro', async () => {
    const mundo = conCero();
    enCoreinbox(mundo, 'c3').unitPrice = '-10';
    enCoreinbox(mundo, 'c4').unitPrice = '0';
    // Otra moneda no es precio 0: es sin precio.
    enCoreinbox(mundo, 'c5').currencyCode = 'USD';
    const m = armar(mundo);
    await m.pasada();
    const r = m.estado.catalogo;
    expect(r.resumen().precioCeroCoreinbox).toEqual({ total: 3, conSku: 2, sinSku: 1 });
    const { items, total } = r.listar({ precioCero: true }, 1, 50);
    expect(total).toBe(2);
    expect(items.map((p) => p.sku)).toEqual(['SKU-001', 'SKU-003']);
    expect(r.listar({ precioCero: true, q: 'sello' }, 1, 50).total).toBe(1);
  });
});

// --- Panel, API y salud ---

const servidores: Server[] = [];

afterEach(async () => {
  await Promise.all(servidores.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
  servidores.length = 0;
});

async function escuchar(s: Server): Promise<string> {
  servidores.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function cargadoConCeros() {
  const mundo = conCero();
  enCoreinbox(mundo, 'c4').unitPrice = '0';
  const m = armar(mundo);
  await m.pasada();
  return m;
}

describe('precio 0 en Coreinbox: panel, API y salud', () => {
  it('la tarjeta «Catálogo» lo destaca con enlaces; lista, detalle, sin SKU y eventos lo muestran', async () => {
    const m = await cargadoConCeros();
    const salud = new Salud(m.estado, { cotizaciones: false, productos: true, pedidos: false });
    const panel = crearPanel({
      salud: () => salud.respuesta(),
      estado: m.estado,
      enlaces: { emite: null },
      ahora: () => AHORA,
    });
    const base = await escuchar(
      crearServidor(
        {
          coreinbox: new Coreinbox(CI, 'cik_prueba'),
          estado: m.estado,
          secreto: 'whsec_prueba',
          urlPublica: 'http://emite.test',
          tipoActividad: 't-1',
        },
        () => salud.respuesta(),
        [panel],
      ),
    );
    const pagina = async (ruta: string) => (await fetch(`${base}/panel/${ruta}`)).text();

    const flujos = await pagina('flujos');
    expect(flujos).toContain('<strong>Precio 0 en Coreinbox</strong>');
    expect(flujos).toContain('href="./productos?precio_cero=1"');
    expect(flujos).toContain(
      'href="./productos?vista=sin_sku&amp;sistema=coreinbox&amp;precio_cero=1"',
    );

    const lista = await pagina('productos?precio_cero=1');
    expect([...lista.matchAll(/name="sku"\s+value="([^"]+)"/g)].map((x) => x[1])).toEqual([
      'SKU-001',
    ]);
    expect(lista).toContain('name="precio_cero"');

    const detalle = await pagina('productos/SKU-001');
    expect(detalle).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(detalle).toContain('<span class="etiqueta mal">precio 0</span>');

    const sinSku = await pagina('productos?vista=sin_sku&precio_cero=1');
    expect(sinSku).toContain('Producto sin código');
    expect(sinSku).not.toContain('Oferta sin SKU');
    expect(sinSku).toContain('<span class="etiqueta mal">precio 0</span>');

    const eventos = await pagina('eventos?estado=precio_cero');
    expect(eventos).toContain('Alerta de datos');
    expect(eventos).toContain(`href="${CI}/api/v1/products/c1"`);
    expect(eventos).toContain('href="./productos/SKU-001"');
  });

  it('sin productos en 0 la tarjeta no lo destaca', async () => {
    const m = armar();
    await m.pasada();
    const salud = new Salud(m.estado, { cotizaciones: false, productos: true, pedidos: false });
    const panel = crearPanel({
      salud: () => salud.respuesta(),
      estado: m.estado,
      enlaces: { emite: null },
      ahora: () => AHORA,
    });
    const base = await escuchar(
      crearServidor(
        {
          coreinbox: new Coreinbox(CI, 'cik_prueba'),
          estado: m.estado,
          secreto: 'whsec_prueba',
          urlPublica: 'http://emite.test',
          tipoActividad: 't-1',
        },
        () => salud.respuesta(),
        [panel],
      ),
    );
    const flujos = await (await fetch(`${base}/panel/flujos`)).text();
    expect(flujos).toContain('<dt>Precio 0 en Coreinbox</dt>');
    expect(flujos).not.toContain('<strong>Precio 0 en Coreinbox</strong>');
  });

  it('GET /catalogo acepta precio_cero=1 (también en vista=sin_sku) y /salud trae el contador', async () => {
    const m = await cargadoConCeros();
    const atender = crearAtencionCatalogo({ estado: m.estado, clave: CLAVE, ahora: () => AHORA });
    const base = await escuchar(createServer((req, res) => void atender(req, res)));
    const pedir = async (ruta: string) =>
      (await (
        await fetch(`${base}${ruta}`, { headers: { authorization: `Bearer ${CLAVE}` } })
      ).json()) as { total: number; items: Array<{ sku?: string; idExterno?: string }> };

    const productos = await pedir('/catalogo?precio_cero=1');
    expect(productos.total).toBe(1);
    expect(productos.items.map((p) => p.sku)).toEqual(['SKU-001']);
    const sinSku = await pedir('/catalogo?vista=sin_sku&precio_cero=1');
    expect(sinSku.items.map((s) => s.idExterno)).toEqual(['c4']);

    const salud = new Salud(m.estado, { cotizaciones: false, productos: true, pedidos: false });
    expect(salud.respuesta().flujos.productos.catalogo.precioCeroCoreinbox).toEqual({
      total: 2,
      conSku: 1,
      sinSku: 1,
    });
  });
});

describe('precio 0 en Coreinbox: poner al día un registro de antes (migrar)', () => {
  it('a la versión 3: los conflictos pierden el 0 de Coreinbox y el recálculo pone el aviso', async () => {
    const m = armar(conCero());
    await m.pasada();
    const r = m.estado.catalogo;
    const db = (r as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    r.abrirConflicto(
      'SKU-001',
      'precio',
      { coreinbox: { valor: 0, en: null }, woocommerce: { valor: 5000, en: null } },
      AHORA.toISOString(),
    );
    r.abrirConflicto(
      'SKU-005',
      'precio',
      {
        coreinbox: { valor: 0, en: null },
        woocommerce: { valor: 99990, en: null },
        emite: { valor: 90000, en: null },
      },
      AHORA.toISOString(),
    );
    db.exec(`UPDATE claves SET valor = '2' WHERE clave = 'catalogo_version'`);

    expect(VERSION_REGISTRO).toBe(3);
    expect(r.migrar()).toBe(true);
    recalcularTodo(r);
    expect(r.conflictos('SKU-001', true)).toEqual([]);
    expect(r.conflictos('SKU-005', true)[0]?.valores).toEqual({
      woocommerce: { valor: 99990, en: null },
      emite: { valor: 90000, en: null },
    });
    // Lo leído no cambia: el 0 sigue ahí y levanta el aviso.
    expect(r.lecturas('SKU-001').coreinbox?.campos.precio?.valor).toBe(0);
    expect(r.producto('SKU-001')?.avisos).toContain(AVISO_PRECIO_CERO_COREINBOX);
    expect(r.producto('SKU-001')?.canonico.precio).toMatchObject({ valor: 5000 });
    expect(r.migrar()).toBe(false);
  });

  it('un registro nuevo arranca en la versión 3', () => {
    const r = new Estado(':memory:').catalogo;
    expect(r.migrar()).toBe(true);
    expect(r.migrar()).toBe(false);
  });
});
