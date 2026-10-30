import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SistemaCatalogo } from '../../estado-catalogo.js';
import { Estado } from '../../estado.js';
import {
  AHORA,
  CI,
  EMITE,
  armar,
  emite,
  mundoInicial,
  respuesta,
  tic,
  type Mundo,
} from '../../prueba/catalogo.js';
import { aplicarAccion } from './acciones.js';
import { crearAtencionCatalogo } from './api.js';

/** Arma el mundo con la escritura encendida y corre la primera pasada (lee y escribe). */
async function escrito(mundo: Mundo = mundoInicial(), sistemas?: SistemaCatalogo[]) {
  const m = armar(mundo);
  m.d.escribir = true;
  if (sistemas) m.d.sistemas = sistemas;
  const primera = await m.pasada();
  return { ...m, primera };
}

/** Lo que se escribió desde la marca, sin las lecturas. */
const desde = (escrituras: Array<{ sistema: string; metodo: string }>, marca: number) =>
  escrituras.slice(marca);

const web = (m: Mundo, id: number) => {
  const p = m.woo.find((w) => w.id === id);
  if (!p) throw new Error(`no está el producto ${id} en la web`);
  return p;
};

/** Cambia un producto en un sistema «a mano», con su hora de modificación, como lo haría alguien. */
const aMano = {
  web(m: Mundo, id: number, cambios: Partial<ReturnType<typeof web>>) {
    const p = web(m, id);
    Object.assign(p, cambios);
    p.date_modified_gmt = p.date_modified = tic(m).slice(0, 19);
  },
  coreinbox(m: Mundo, id: string, cambios: Record<string, unknown>) {
    const p = m.coreinbox.find((c) => c.id === id);
    if (!p) throw new Error(`no está ${id} en Coreinbox`);
    Object.assign(p, cambios);
    p.updatedAt = tic(m);
  },
  emite(m: Mundo, id: string, cambios: Record<string, unknown>) {
    const p = m.emite.find((e) => e.id === id);
    if (!p) throw new Error(`no está ${id} en Emite DTE`);
    Object.assign(p, cambios);
    p.updatedAt = tic(m);
  },
};

describe('primera escritura', () => {
  it('antes de encenderla el registro ya muestra lo que se escribirá, sin escribir nada', async () => {
    const m = armar();
    await m.pasada();
    expect(m.escrituras).toEqual([]);
    expect(m.estado.catalogo.primeraEscritura()).toBeNull();
    const bomba = m.estado.catalogo.producto('SKU-005');
    // La web manda en nombre y precio al arrancar: Coreinbox recibe los de la web.
    expect(bomba?.escrituras).toEqual([
      {
        sistema: 'coreinbox',
        campo: 'nombre',
        antes: 'Bomba centrífuga',
        valor: 'Bomba centrífuga & motor',
        revierte: false,
      },
      { sistema: 'coreinbox', campo: 'precio', antes: 100000, valor: 99990, revierte: false },
    ]);
    expect(bomba?.crearEn).toEqual(['emite']);
  });

  it('aplica el canónico de arranque a lo que difiere y crea lo que falta en Emite DTE', async () => {
    const { mundo, estado, escrituras, primera } = await escrito();
    expect(estado.catalogo.primeraEscritura()).toBe(AHORA.toISOString());
    expect(primera).toMatchObject({ creados: 3, escritos: 3, revertidos: 0, conError: 0 });

    // Coreinbox recibe nombre y neto de la web (99.990 bruto = 84.025,21 neto).
    expect(escrituras.filter((e) => e.sistema === 'coreinbox')).toEqual([
      {
        sistema: 'coreinbox',
        metodo: 'PATCH',
        ruta: '/api/v1/products/c5',
        cuerpo: { name: 'Bomba centrífuga & motor', unitPrice: 84025.21 },
      },
    ]);
    // Emite DTE: la categoría de Coreinbox en SKU-001 y tres productos nuevos con el SKU como código.
    const creados = mundo.emite.filter((e) => e.id.startsWith('nuevo-'));
    expect(creados.map((e) => [e.codigo, e.nombre, e.precioNeto, e.activo])).toEqual([
      ['SKU-003', 'Repuesto sello', 840.34, true],
      ['SKU-005', 'Bomba centrífuga & motor', 84025.21, true],
      ['SKU-006', 'Llave de paso', 2521.01, false],
    ]);
    expect(mundo.emite.find((e) => e.id === 'e5')?.categoria).toBe('Válvulas');
    // Un servicio con un histórico de su mismo código sin decidir no se crea encima.
    expect(mundo.emite.some((e) => e.codigo === 'SKU-002' && e.origen !== 'historial')).toBe(false);
    expect(estado.catalogo.producto('SKU-002')?.avisos).toContain(
      'Emite DTE tiene un histórico con el código SKU-002: falta decidir el empate',
    );
    // Nada se crea en Coreinbox ni se borra en ningún lado.
    expect(escrituras.some((e) => e.sistema === 'coreinbox' && e.metodo === 'POST')).toBe(false);
  });

  it('la pasada siguiente reconoce todo como eco y no vuelve a escribir', async () => {
    const m = await escrito();
    const marca = m.escrituras.length;
    const r = await m.pasada();
    expect(desde(m.escrituras, marca)).toEqual([]);
    expect(r.camposCambiados).toBe(0);
    expect(m.estado.catalogo.producto('SKU-005')?.diferencias).toEqual([]);
    expect(m.estado.catalogo.lecturas('SKU-005').coreinbox?.campos.precio).toMatchObject({
      valor: 99990,
      escritoValor: 99990,
      cambioEn: null,
    });
  });

  it('lo cambiado mientras sólo se leía no cuenta: la primera escritura aplica el arranque', async () => {
    const m = armar();
    await m.pasada();
    aMano.coreinbox(m.mundo, 'c1', { unitPrice: '5042.02' });
    await m.pasada();
    m.d.escribir = true;
    await m.pasada();
    // La web manda al arrancar: Coreinbox vuelve a 5.000 bruto.
    expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.unitPrice).toBe('4201.68');
  });
});

describe('último cambio en nombre y precio', () => {
  const casos: Array<{
    sistema: SistemaCatalogo;
    cambiar: (m: Mundo) => void;
    otros: Array<(m: Mundo) => unknown>;
  }> = [
    {
      sistema: 'woocommerce',
      cambiar: (m) => aMano.web(m, 11, { regular_price: '5500' }),
      otros: [
        (m) => m.coreinbox.find((c) => c.id === 'c1')?.unitPrice,
        (m) => m.emite.find((e) => e.id === 'e5')?.precioNeto,
      ],
    },
    {
      sistema: 'coreinbox',
      cambiar: (m) => aMano.coreinbox(m, 'c1', { unitPrice: '4621.85' }),
      otros: [
        (m) => web(m, 11).regular_price,
        (m) => m.emite.find((e) => e.id === 'e5')?.precioNeto,
      ],
    },
    {
      sistema: 'emite',
      cambiar: (m) => aMano.emite(m, 'e5', { precioNeto: 4621.85 }),
      otros: [
        (m) => web(m, 11).regular_price,
        (m) => m.coreinbox.find((c) => c.id === 'c1')?.unitPrice,
      ],
    },
  ];

  for (const caso of casos) {
    it(`un cambio de precio en ${caso.sistema} llega a los otros dos y vuelve como eco`, async () => {
      const m = await escrito();
      caso.cambiar(m.mundo);
      const marca = m.escrituras.length;
      const r = await m.pasada();
      expect(r).toMatchObject({ escritos: 2, revertidos: 0, conflictosNuevos: 0 });
      const valores = caso.otros.map((f) => f(m.mundo));
      // 5.500 bruto: 4.621,85 neto en Coreinbox y Emite DTE.
      expect(valores.map((v) => (typeof v === 'string' ? Number(v) : v)).sort()).toEqual(
        caso.sistema === 'woocommerce'
          ? [4621.85, 4621.85]
          : caso.sistema === 'coreinbox'
            ? [4621.85, 5500]
            : [4621.85, 5500],
      );
      const producto = m.estado.catalogo.producto('SKU-001');
      expect(producto?.canonico.precio).toMatchObject({
        valor: 5500,
        fuente: caso.sistema,
        modo: 'ultimo',
      });
      expect(desde(m.escrituras, marca).map((e) => e.sistema)).not.toContain(caso.sistema);

      const eventos = m.estado.eventos({ flujo: 'productos', estado: 'escrito' });
      expect(eventos.filter((e) => e.sku === 'SKU-001' && e.campo === 'precio')).toHaveLength(2);

      // La lectura siguiente trae los ecos: nada que escribir.
      const otra = m.escrituras.length;
      const despues = await m.pasada();
      expect(desde(m.escrituras, otra)).toEqual([]);
      expect(despues.camposCambiados).toBe(0);
      expect(m.estado.catalogo.producto('SKU-001')?.diferencias).toEqual([]);
    });
  }

  it('un cambio del mismo campo en dos sistemas queda en conflicto y no pisa nada', async () => {
    const m = await escrito();
    aMano.web(m.mundo, 11, { regular_price: '5500' });
    aMano.coreinbox(m.mundo, 'c1', { unitPrice: '5042.02' });
    const marca = m.escrituras.length;
    const r = await m.pasada();
    expect(r.conflictosNuevos).toBe(1);
    expect(desde(m.escrituras, marca)).toEqual([]);
    expect(web(m.mundo, 11).regular_price).toBe('5500');
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(4201.68);
    const [conflicto] = m.estado.catalogo.conflictos('SKU-001', true);
    expect(conflicto).toMatchObject({ campo: 'precio' });
    expect(m.estado.catalogo.producto('SKU-001')?.escrituras).toEqual([]);

    // Resolverlo desde el panel (la misma acción) lleva el elegido a los otros dos.
    if (!conflicto) throw new Error('debía haber un conflicto');
    aplicarAccion(
      m.estado.catalogo,
      'conflictos',
      { resoluciones: [{ id: conflicto.id, fuente: 'coreinbox' }] },
      'ana@example.com',
      AHORA.toISOString(),
    );
    expect(m.estado.catalogo.reglas()).toEqual([]);
    const resuelta = await m.pasada();
    expect(resuelta).toMatchObject({ escritos: 2 });
    expect(web(m.mundo, 11).regular_price).toBe('6000');
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(5042.02);
    // El campo sigue en «último cambio»: un cambio posterior en la web vuelve a ganar.
    aMano.web(m.mundo, 11, { regular_price: '6100' });
    await m.pasada();
    expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.unitPrice).toBe('5126.05');
  });

  it('un cambio de nombre también viaja, y un nombre con espacios de más no es diferencia', async () => {
    const m = await escrito();
    aMano.coreinbox(m.mundo, 'c1', { name: 'Válvula esfera 1/2 bronce' });
    await m.pasada();
    expect(web(m.mundo, 11).name).toBe('Válvula esfera 1/2 bronce');
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.nombre).toBe('Válvula esfera 1/2 bronce');
    const marca = m.escrituras.length;
    aMano.web(m.mundo, 11, { name: 'Válvula  esfera 1/2 bronce ' });
    await m.pasada();
    expect(desde(m.escrituras, marca)).toEqual([]);
  });
});

describe('propietario', () => {
  it('desactivar un producto en la web lo revierte: Coreinbox manda en activo', async () => {
    const m = await escrito();
    aMano.web(m.mundo, 11, { status: 'draft' });
    const r = await m.pasada();
    expect(r).toMatchObject({ revertidos: 1, conflictosNuevos: 0 });
    expect(web(m.mundo, 11).status).toBe('publish');
    const [evento] = m.estado.eventos({ flujo: 'productos', estado: 'revertido' });
    expect(evento).toMatchObject({
      tipo: 'escritura',
      sku: 'SKU-001',
      sistema: 'woocommerce',
      campo: 'activo',
      mensaje: 'activo: false → true',
    });
  });

  it('desactivarlo en Coreinbox lo lleva a borrador en la web y a inactivo en Emite DTE', async () => {
    const m = await escrito();
    aMano.coreinbox(m.mundo, 'c1', { isActive: false });
    const r = await m.pasada();
    expect(r).toMatchObject({ escritos: 2, revertidos: 0 });
    expect(web(m.mundo, 11).status).toBe('draft');
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.activo).toBe(false);
    // Reactivarlo lo vuelve a publicar: sigue aprobado porque está en la web.
    aMano.coreinbox(m.mundo, 'c1', { isActive: true });
    await m.pasada();
    expect(web(m.mundo, 11).status).toBe('publish');
  });

  it('una regla «último cambio» en activo deja que la web lo cambie', async () => {
    const m = await escrito();
    aplicarAccion(
      m.estado.catalogo,
      'reglas',
      { campo: 'activo', fuente: 'ultimo' },
      null,
      AHORA.toISOString(),
    );
    aMano.web(m.mundo, 11, { status: 'draft' });
    const r = await m.pasada();
    expect(r.revertidos).toBe(0);
    expect(web(m.mundo, 11).status).toBe('draft');
    expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.isActive).toBe(false);
  });
});

describe('históricos de Emite DTE', () => {
  const confirmar = (estado: Estado, emiteId: string, sku: string) =>
    aplicarAccion(
      estado.catalogo,
      'empates',
      { decisiones: [{ emiteId, sku, estado: 'confirmado' }] },
      'ana@example.com',
      AHORA.toISOString(),
    );

  it('con el código exacto se adopta: recibe nombre y precio y pasa a ser el de Emite DTE', async () => {
    const m = armar();
    await m.pasada();
    confirmar(m.estado, 'e2', 'SKU-002');
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r.adoptados).toBe(1);
    const e2 = m.mundo.emite.find((e) => e.id === 'e2');
    expect(e2).toMatchObject({
      nombre: 'Servicio de mantención',
      precioNeto: 50000,
      origen: 'historial',
    });
    expect(m.mundo.emite.some((e) => e.codigo === 'SKU-002' && e.id !== 'e2')).toBe(false);
    expect(m.estado.catalogo.lecturas('SKU-002').emite?.idExterno).toBe('e2');
    expect(m.estado.catalogo.empatesDeSku('SKU-002')[0]).toMatchObject({ resultado: 'adoptado' });
    expect(m.estado.eventos({ estado: 'adoptado' })[0]).toMatchObject({
      sku: 'SKU-002',
      sistema: 'emite',
      idExterno: 'e2',
    });
    // Leído otra vez (sigue con origen historial) sigue siendo el producto del SKU.
    const marca = m.escrituras.length;
    await m.pasada();
    expect(m.estado.catalogo.lecturas('SKU-002').emite?.idExterno).toBe('e2');
    expect(desde(m.escrituras, marca)).toEqual([]);
  });

  it('con otro código se crea el canónico y el histórico se fusiona en él', async () => {
    const m = armar();
    await m.pasada();
    confirmar(m.estado, 'e3', 'SKU-005');
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r).toMatchObject({ fusionados: 1 });
    const creado = m.mundo.emite.find((e) => e.codigo === 'SKU-005');
    expect(creado?.origen).toBe('manual');
    expect(m.mundo.emite.find((e) => e.id === 'e3')).toMatchObject({
      fusionadoEnId: creado?.id,
      activo: false,
    });
    expect(m.estado.catalogo.historico('e3')?.fusionadoEnId).toBe(creado?.id);
    expect(m.estado.catalogo.lecturas('SKU-005').emite?.idExterno).toBe(creado?.id);
    expect(m.estado.eventos({ estado: 'fusionado' })[0]).toMatchObject({
      sku: 'SKU-005',
      idExterno: 'e3',
    });
  });

  it('varios con el código exacto: se adopta el de más uso y los demás se fusionan en él', async () => {
    const mundo = mundoInicial();
    mundo.emite.push(
      emite('e7', {
        codigo: 'SKU-002',
        nombre: 'Mantención (copia)',
        uso: { documentos: 30, cantidad: 90, ultimaVez: null, clientes: 5 },
      }),
    );
    const m = armar(mundo);
    await m.pasada();
    confirmar(m.estado, 'e2', 'SKU-002');
    confirmar(m.estado, 'e7', 'SKU-002');
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r).toMatchObject({ adoptados: 1, fusionados: 1 });
    expect(m.estado.catalogo.lecturas('SKU-002').emite?.idExterno).toBe('e7');
    expect(m.mundo.emite.find((e) => e.id === 'e2')?.fusionadoEnId).toBe('e7');
  });

  it('con inventario y otro código no se fusiona: queda «requiere mano» y no se reintenta', async () => {
    const mundo = mundoInicial();
    mundo.inventario = ['e4'];
    const m = armar(mundo);
    await m.pasada();
    confirmar(m.estado, 'e4', 'SKU-003');
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r).toMatchObject({ fusionados: 0, conError: 1 });
    expect(m.mundo.emite.find((e) => e.id === 'e4')?.fusionadoEnId).toBeNull();
    expect(m.estado.catalogo.empatesDeSku('SKU-003')[0]).toMatchObject({
      resultado: 'requiere_mano',
    });
    const avisos = m.estado.catalogo.producto('SKU-003')?.avisos ?? [];
    expect(avisos.some((a) => a.startsWith('Requiere mano'))).toBe(true);
    expect(m.estado.eventos({ estado: 'error' })[0]?.mensaje).toContain('PRODUCTO_CON_INVENTARIO');

    const marca = m.escrituras.length;
    await m.pasada();
    expect(desde(m.escrituras, marca).filter((e) => e.ruta.endsWith('/fusionar'))).toEqual([]);
  });

  it('un empate rechazado no toca nada', async () => {
    const m = armar();
    await m.pasada();
    aplicarAccion(
      m.estado.catalogo,
      'empates',
      { decisiones: [{ emiteId: 'e3', sku: 'SKU-005', estado: 'rechazado' }] },
      null,
      AHORA.toISOString(),
    );
    m.d.escribir = true;
    await m.pasada();
    expect(m.escrituras.filter((e) => e.ruta.endsWith('/fusionar'))).toEqual([]);
    expect(m.mundo.emite.find((e) => e.id === 'e3')).toMatchObject({
      fusionadoEnId: null,
      nombre: 'Bomba centrifuga c/motor',
    });
  });
});

describe('visibilidad web', () => {
  const categorias = (estado: Estado, fuera: boolean) =>
    aplicarAccion(
      estado.catalogo,
      'categorias',
      { categorias: ['Válvulas'], fuera },
      'ana@example.com',
      AHORA.toISOString(),
    );
  const visibilidad = (estado: Estado, sku: string, valor: 'aprobado' | 'rechazado') =>
    aplicarAccion(
      estado.catalogo,
      'visibilidad',
      { skus: [sku], estado: valor },
      null,
      AHORA.toISOString(),
    );

  it('un SKU de una categoría fuera de la web queda rechazado y pasa a borrador; aprobarlo lo publica', async () => {
    const m = await escrito();
    categorias(m.estado, true);
    expect(m.estado.catalogo.producto('SKU-001')).toMatchObject({
      visibilidadWeb: 'rechazado',
      motivoVisibilidad: 'categoria',
    });
    // Es derivado: no queda como decisión de visibilidad.
    expect(m.estado.catalogo.visibilidadDecidida('SKU-001')).toBeNull();
    await m.pasada();
    expect(web(m.mundo, 11).status).toBe('draft');
    // Nunca se borra de la web.
    expect(m.mundo.woo.some((w) => w.id === 11)).toBe(true);

    visibilidad(m.estado, 'SKU-001', 'aprobado');
    expect(m.estado.catalogo.producto('SKU-001')).toMatchObject({
      visibilidadWeb: 'aprobado',
      motivoVisibilidad: 'decision',
    });
    await m.pasada();
    expect(web(m.mundo, 11).status).toBe('publish');
  });

  it('aprobar uno de la categoría que no está en la web lo crea; inactivo, en borrador', async () => {
    const mundo = mundoInicial();
    const sello = mundo.coreinbox.find((c) => c.id === 'c3');
    if (sello) Object.assign(sello, { categoryId: 'cat-1', isActive: false });
    const m = await escrito(mundo);
    categorias(m.estado, true);
    expect(m.estado.catalogo.producto('SKU-003')?.motivoVisibilidad).toBe('categoria');
    await m.pasada();
    expect(m.mundo.woo.some((w) => w.sku === 'SKU-003')).toBe(false);

    visibilidad(m.estado, 'SKU-003', 'aprobado');
    const r = await m.pasada();
    expect(r.creados).toBe(1);
    expect(m.mundo.woo.find((w) => w.sku === 'SKU-003')).toMatchObject({
      name: 'Repuesto sello',
      regular_price: '1000',
      status: 'draft',
    });
    expect(m.estado.eventos({ estado: 'creado' })[0]).toMatchObject({
      sku: 'SKU-003',
      sistema: 'woocommerce',
    });
    // Ya está: la pasada siguiente no la vuelve a crear.
    const marca = m.escrituras.length;
    await m.pasada();
    expect(desde(m.escrituras, marca)).toEqual([]);
  });

  it('un rechazo por SKU deja en borrador lo publicado y un servicio nunca se crea en la web', async () => {
    const m = await escrito();
    visibilidad(m.estado, 'SKU-005', 'rechazado');
    await m.pasada();
    expect(web(m.mundo, 15).status).toBe('draft');
    expect(m.mundo.woo.some((w) => w.sku === 'SKU-002')).toBe(false);
  });
});

describe('escritura por sistema y fallas', () => {
  it('PRODUCTOS_ESCRIBIR_SISTEMAS=emite escribe sólo en Emite DTE', async () => {
    const m = await escrito(mundoInicial(), ['emite']);
    expect(m.escrituras.length).toBeGreaterThan(0);
    expect(new Set(m.escrituras.map((e) => e.sistema))).toEqual(new Set(['emite']));
    // Lo que no se escribe en Coreinbox queda planeado para cuando se encienda.
    expect(m.estado.catalogo.producto('SKU-005')?.escrituras?.map((w) => w.sistema)).toEqual([
      'coreinbox',
      'coreinbox',
    ]);
  });

  it('una falla transitoria deja el SKU pendiente y la pasada siguiente lo escribe', async () => {
    let caido = true;
    const m = armar(mundoInicial(), new Estado(':memory:'), (url, init) =>
      caido && url.origin === CI && init?.method === 'PATCH'
        ? respuesta({ success: false, error: { code: 'CAIDA' } }, 503)
        : null,
    );
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r.pendientes).toBe(1);
    expect(m.mundo.coreinbox.find((c) => c.id === 'c5')?.name).toBe('Bomba centrífuga');
    // Los demás sistemas se escribieron igual.
    expect(r.creados).toBe(3);
    caido = false;
    const despues = await m.pasada();
    expect(despues.pendientes).toBe(0);
    expect(m.mundo.coreinbox.find((c) => c.id === 'c5')?.name).toBe('Bomba centrífuga & motor');
  });

  it('un 4xx queda como evento de error, no frena a los demás y no se reintenta igual', async () => {
    const rechazos: string[] = [];
    const m = armar(mundoInicial(), new Estado(':memory:'), (url, init) => {
      if (url.origin === EMITE && init?.method === 'POST' && url.pathname === '/api/v1/productos') {
        const cuerpo = JSON.parse(String(init.body)) as { codigo: string };
        if (cuerpo.codigo === 'SKU-005') {
          rechazos.push(cuerpo.codigo);
          return respuesta({ error: { code: 'VALIDACION', message: 'precio inválido' } }, 400);
        }
      }
      return null;
    });
    m.d.escribir = true;
    const r = await m.pasada();
    expect(r).toMatchObject({ conError: 1, creados: 2 });
    const [error] = m.estado.eventos({ estado: 'error' });
    expect(error).toMatchObject({
      tipo: 'escritura',
      sku: 'SKU-005',
      sistema: 'emite',
      mensaje: 'VALIDACION: precio inválido',
    });
    await m.pasada();
    expect(rechazos).toEqual(['SKU-005']);
    expect(m.estado.eventos({ estado: 'error' })).toHaveLength(1);
  });
});

// --- Exportar e importar decisiones ---

const CLAVE = 'clave-de-prueba';
let servidor: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolver) => (servidor ? servidor.close(() => resolver()) : resolver()));
  servidor = null;
});

async function api(estado: Estado) {
  const atender = crearAtencionCatalogo({ estado, clave: CLAVE, ahora: () => AHORA });
  servidor = createServer((req, res) => {
    void atender(req, res).then((atendida) => {
      if (!atendida) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolver) => servidor?.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address() as AddressInfo;
  return async (
    ruta: string,
    opciones: { metodo?: string; cuerpo?: unknown; clave?: string } = {},
  ) => {
    const r = await fetch(`http://127.0.0.1:${port}${ruta}`, {
      method: opciones.metodo ?? 'GET',
      headers: {
        authorization: `Bearer ${opciones.clave ?? CLAVE}`,
        ...(opciones.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
    });
    return { status: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
  };
}

describe('GET y POST /catalogo/decisiones', () => {
  it('exporta todas las decisiones y las repone en un registro vacío con el mismo resultado', async () => {
    const m = await escrito();
    const en = AHORA.toISOString();
    const r = m.estado.catalogo;
    aplicarAccion(r, 'reglas', { campo: 'activo', fuente: 'ultimo' }, 'ana@example.com', en);
    aplicarAccion(
      r,
      'reglas',
      { campo: 'precio', fuente: 'coreinbox', skus: ['SKU-005'] },
      null,
      en,
    );
    aplicarAccion(
      r,
      'empates',
      {
        decisiones: [
          { emiteId: 'e2', sku: 'SKU-002', estado: 'confirmado' },
          { emiteId: 'e6', sku: 'SKU-001', estado: 'rechazado' },
        ],
      },
      'ana@example.com',
      en,
    );
    aplicarAccion(r, 'visibilidad', { skus: ['SKU-003'], estado: 'aprobado' }, null, en);
    aplicarAccion(r, 'categorias', { categorias: ['Válvulas'], fuera: true }, null, en);
    aMano.web(m.mundo, 11, { name: 'Válvula A' });
    aMano.coreinbox(m.mundo, 'c1', { name: 'Válvula B' });
    await m.pasada();
    const [conflicto] = r.conflictos('SKU-001', true);
    if (!conflicto) throw new Error('debía haber un conflicto');
    aplicarAccion(
      r,
      'conflictos',
      { resoluciones: [{ id: conflicto.id, fuente: 'woocommerce' }] },
      null,
      en,
    );

    const pedir = await api(m.estado);
    const exportadas = await pedir('/catalogo/decisiones');
    expect(exportadas.status).toBe(200);
    expect(exportadas.cuerpo).toMatchObject({
      version: 1,
      reglas: [
        { ambito: '*', campo: 'activo', fuente: 'ultimo', usuario: 'ana@example.com' },
        { ambito: 'SKU-005', campo: 'precio', fuente: 'coreinbox' },
      ],
      empates: [
        { emiteId: 'e6', sku: 'SKU-001', estado: 'rechazado' },
        { emiteId: 'e2', sku: 'SKU-002', estado: 'confirmado', decididoPor: 'ana@example.com' },
      ],
      conflictos: [{ sku: 'SKU-001', campo: 'nombre', resueltoCon: 'woocommerce' }],
      visibilidad: [{ sku: 'SKU-003', estado: 'aprobado' }],
      categoriasFuera: [{ categoria: 'Válvulas' }],
    });
    expect(await pedir('/catalogo/decisiones', { clave: 'otra' })).toMatchObject({ status: 401 });

    const vacio = new Estado(':memory:');
    const pedirVacio = await api(vacio);
    const importadas = await pedirVacio('/catalogo/decisiones', {
      metodo: 'POST',
      cuerpo: exportadas.cuerpo,
    });
    expect(importadas).toMatchObject({
      status: 200,
      cuerpo: {
        importadas: { reglas: 2, empates: 2, conflictos: 1, visibilidad: 1, categoriasFuera: 1 },
      },
    });
    expect((await pedirVacio('/catalogo/decisiones')).cuerpo).toEqual(exportadas.cuerpo);
    // Idempotente: reponer dos veces deja lo mismo.
    await pedirVacio('/catalogo/decisiones', { metodo: 'POST', cuerpo: exportadas.cuerpo });
    expect((await pedirVacio('/catalogo/decisiones')).cuerpo).toEqual(exportadas.cuerpo);
    expect(vacio.catalogo.conflictosResueltos()).toHaveLength(1);
  });

  it('rechaza un cuerpo que no es un respaldo', async () => {
    const pedir = await api(new Estado(':memory:'));
    expect(
      await pedir('/catalogo/decisiones', { metodo: 'POST', cuerpo: { reglas: [] } }),
    ).toMatchObject({ status: 400 });
    expect(
      await pedir('/catalogo/decisiones', {
        metodo: 'POST',
        cuerpo: {
          version: 1,
          reglas: [{ ambito: '*', campo: 'precio', fuente: 'otro' }],
          empates: [],
          conflictos: [],
          visibilidad: [],
          categoriasFuera: [],
        },
      }),
    ).toMatchObject({ status: 400 });
  });
});
