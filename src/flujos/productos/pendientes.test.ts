import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Estado } from '../../estado.js';
import { AHORA, T2, armar, mundoInicial, tic, type Mundo } from '../../prueba/catalogo.js';
import { aplicarAccion } from './acciones.js';
import { crearAtencionCatalogo } from './api.js';

const EN = AHORA.toISOString();
const ANA = 'ana@example.com';

/** Lee una vez (sin escribir), como queda el conector con `PRODUCTOS_ESCRIBIR=false`. */
async function leido(mundo: Mundo = mundoInicial()) {
  const m = armar(mundo);
  await m.pasada();
  return m;
}

/** Con la escritura encendida y la primera pasada hecha: todo el mundo inicial ya en los tres. */
async function escrito(mundo: Mundo = mundoInicial()) {
  const m = armar(mundo);
  m.d.escribir = true;
  await m.pasada();
  return m;
}

const de = (escrituras: Array<{ ruta: string; cuerpo: Record<string, unknown> }>, sku: string) =>
  escrituras.filter((e) => e.cuerpo.sku === sku || e.cuerpo.codigo === sku);

const alta = (m: { estado: Estado }, cuerpo: Record<string, unknown>, usuario: string | null = ANA) =>
  aplicarAccion(m.estado.catalogo, 'alta', cuerpo, usuario, EN);

const edicion = (m: { estado: Estado }, sku: string, campos: Record<string, unknown>, en = EN) =>
  aplicarAccion(m.estado.catalogo, 'edicion', { sku, campos }, ANA, en);

const CODO = {
  sku: 'SKU-100',
  nombre: 'Codo bronce 1/2',
  precio: 2380,
  tipo: 'bien',
  categoria: 'Válvulas',
  visibilidad: 'aprobado',
};

describe('alta desde el panel', () => {
  it('queda pendiente; la pasada la crea en los tres, guarda los ids y borra el alta', async () => {
    const m = await leido();
    alta(m, CODO);
    const r = m.estado.catalogo;
    expect(r.alta('SKU-100')).toMatchObject({ nombre: 'Codo bronce 1/2', precio: 2380, usuario: ANA });
    const pendiente = r.producto('SKU-100');
    expect(pendiente).toMatchObject({
      presentes: [],
      pendiente: true,
      visibilidadWeb: 'aprobado',
      alcance: ['coreinbox', 'woocommerce', 'emite'],
      crearEn: ['coreinbox', 'emite', 'woocommerce'],
    });
    expect(pendiente?.canonico.nombre).toMatchObject({ valor: 'Codo bronce 1/2', fuente: 'panel' });

    // Sin escritura no sale nada: el alta sigue pendiente.
    await m.pasada();
    expect(m.escrituras).toEqual([]);
    expect(r.alta('SKU-100')).not.toBeNull();

    m.d.escribir = true;
    const hecho = await m.pasada();
    expect(hecho.conError).toBe(0);
    expect(de(m.escrituras, 'SKU-100')).toEqual([
      {
        sistema: 'coreinbox',
        metodo: 'POST',
        ruta: '/api/v1/products',
        cuerpo: {
          name: 'Codo bronce 1/2',
          sku: 'SKU-100',
          type: 'product',
          unitPrice: 2000,
          currencyCode: 'CLP',
          isTaxable: true,
          categoryId: 'cat-1',
        },
      },
      {
        sistema: 'emite',
        metodo: 'POST',
        ruta: '/api/v1/productos',
        cuerpo: expect.objectContaining({
          codigo: 'SKU-100',
          nombre: 'Codo bronce 1/2',
          precioNeto: 2000,
          tipo: 'bien',
          exento: false,
          activo: true,
          categoria: 'Válvulas',
        }) as unknown,
      },
      {
        sistema: 'woocommerce',
        metodo: 'POST',
        ruta: '/wp-json/wc/v3/products',
        cuerpo: {
          name: 'Codo bronce 1/2',
          sku: 'SKU-100',
          type: 'simple',
          regular_price: '2380',
          status: 'publish',
        },
      },
    ]);
    expect(r.alta('SKU-100')).toBeNull();
    const creado = r.producto('SKU-100');
    expect(creado).toMatchObject({
      presentes: ['coreinbox', 'woocommerce', 'emite'],
      faltaEn: [],
      crearEn: [],
      escrituras: [],
      diferencias: [],
    });
    expect(creado?.pendiente).toBeUndefined();
    expect(creado?.canonico.nombre?.fuente).not.toBe('panel');
    expect(r.lecturas('SKU-100').coreinbox?.idExterno).toBe('ci-SKU-100');
    expect(r.lecturas('SKU-100').emite?.idExterno).toBe('nuevo-SKU-100');
    const creados = r.eventosDeSku('SKU-100').filter((e) => e.estado === 'creado');
    expect(creados.map((e) => e.sistema).sort()).toEqual(['coreinbox', 'emite', 'woocommerce']);

    // La lectura siguiente lo reconoce como eco: nada cambió y no se vuelve a escribir.
    const marca = m.escrituras.length;
    const otra = await m.pasada();
    expect(m.escrituras.slice(marca)).toEqual([]);
    expect(otra.camposCambiados).toBe(0);
    expect(r.producto('SKU-100')).toEqual(creado);
  });

  it('un servicio inactivo y exento va a Coreinbox y Emite DTE; sin la categoría en Coreinbox queda aviso', async () => {
    const m = armar();
    m.d.escribir = true;
    // Sin lectura previa el registro no conoce categorías: se acepta cualquiera.
    alta(m, {
      sku: 'SRV-1',
      nombre: 'Visita técnica',
      precio: 30000,
      tipo: 'servicio',
      categoria: 'Servicios',
      exento: true,
      activo: false,
    });
    expect(m.estado.catalogo.producto('SRV-1')).toMatchObject({
      visibilidadWeb: 'no_aplica',
      crearEn: ['coreinbox', 'emite'],
    });
    await m.pasada();
    const [enCoreinbox, enEmite, ...resto] = de(m.escrituras, 'SRV-1');
    expect(resto).toEqual([]);
    expect(enCoreinbox?.cuerpo).toEqual({
      name: 'Visita técnica',
      sku: 'SRV-1',
      type: 'service',
      unitPrice: 30000,
      currencyCode: 'CLP',
      isTaxable: false,
      isActive: false,
    });
    expect(enEmite?.cuerpo).toMatchObject({ tipo: 'servicio', exento: true, activo: false });
    const [evento] = m.estado.catalogo
      .eventosDeSku('SRV-1')
      .filter((e) => e.estado === 'creado' && e.sistema === 'coreinbox');
    expect(evento?.mensaje).toContain('sin categoría: «Servicios» no existe en Coreinbox');
    expect(m.estado.catalogo.alta('SRV-1')).toBeNull();
    expect(m.estado.catalogo.producto('SRV-1')?.canonico.activo?.valor).toBe(false);
  });

  it('en una categoría fuera de la web nace rechazado, salvo que el alta lo apruebe', async () => {
    const m = await leido();
    aplicarAccion(m.estado.catalogo, 'categorias', { categorias: ['Válvulas'], fuera: true }, null, EN);
    alta(m, { ...CODO, sku: 'SKU-101', nombre: 'Codo 3/4', visibilidad: undefined });
    alta(m, { ...CODO, sku: 'SKU-102', nombre: 'Codo 1' });
    expect(m.estado.catalogo.producto('SKU-101')).toMatchObject({
      visibilidadWeb: 'rechazado',
      motivoVisibilidad: 'categoria',
      crearEn: ['coreinbox', 'emite'],
    });
    expect(m.estado.catalogo.producto('SKU-102')).toMatchObject({
      visibilidadWeb: 'aprobado',
      motivoVisibilidad: 'decision',
    });
    expect(m.estado.catalogo.visibilidadDecidida('SKU-102')).toMatchObject({ estado: 'aprobado', usuario: ANA });
  });

  it('rechaza un SKU tomado, el nombre de un «sin SKU», el código de un histórico y datos inválidos', async () => {
    const m = await leido();
    const rechazo = (cuerpo: Record<string, unknown>) => () => alta(m, { ...CODO, ...cuerpo });
    expect(rechazo({ sku: 'SKU-001' })).toThrow('ya existe el SKU SKU-001');
    expect(rechazo({ nombre: 'Producto  sin código' })).toThrow(
      '«Producto sin código» ya existe sin SKU en Coreinbox: ponle el SKU SKU-100 ahí en vez de crearlo',
    );
    expect(rechazo({ sku: 'ANT-003' })).toThrow(
      'Emite DTE tiene un histórico con el código ANT-003: confirma el empate desde Históricos en vez de crearlo',
    );
    expect(rechazo({ tipo: 'servicio' })).toThrow('SKU-100 es un servicio: nunca va a la web');
    expect(rechazo({ sku: ' SKU-100' })).toThrow('espacio');
    expect(rechazo({ sku: 'X'.repeat(36) })).toThrow('entre 1 y 35');
    expect(rechazo({ nombre: '' })).toThrow('entre 1 y 80');
    expect(rechazo({ precio: 10.5 })).toThrow('bruto entero');
    expect(rechazo({ precio: -1 })).toThrow('bruto entero');
    expect(rechazo({ tipo: 'licencia' })).toThrow('bien o servicio');
    expect(rechazo({ categoria: 'No existe' })).toThrow('no está entre las de Coreinbox');
    expect(rechazo({ visibilidad: 'rechazado' })).toThrow('sólo puede ser aprobado');
    alta(m, CODO);
    expect(rechazo({})).toThrow('ya hay un alta pendiente con el SKU SKU-100');
    // Nada de lo rechazado quedó en la bitácora.
    expect(m.estado.catalogo.acciones().filter((a) => a.accion === 'alta')).toHaveLength(1);
  });

  it('una edición sobre un alta pendiente cambia el alta', async () => {
    const m = await leido();
    alta(m, CODO);
    edicion(m, 'SKU-100', { precio: 2500, nombre: 'Codo bronce 1/2 HE' });
    expect(m.estado.catalogo.alta('SKU-100')).toMatchObject({ precio: 2500, nombre: 'Codo bronce 1/2 HE' });
    expect(m.estado.catalogo.pendientes('SKU-100')).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-100')?.canonico.precio?.valor).toBe(2500);
  });

  it('queda en la bitácora como acción con el SKU', async () => {
    const m = await leido();
    alta(m, CODO);
    edicion(m, 'SKU-001', { precio: 6000 });
    const acciones = m.estado
      .eventos({ flujo: 'productos' })
      .filter((e) => e.tipo === 'accion' && (e.estado === 'alta' || e.estado === 'edicion'));
    expect(acciones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ estado: 'alta', sku: 'SKU-100', mensaje: `SKU-100 · ${ANA}` }),
        expect.objectContaining({ estado: 'edicion', sku: 'SKU-001', mensaje: `SKU-001 · ${ANA}` }),
      ]),
    );
  });
});

const coreinboxDe = (m: Mundo, id: string) => m.coreinbox.find((c) => c.id === id);
const webDe = (m: Mundo, id: number) => m.woo.find((w) => w.id === id);
const emiteDe = (m: Mundo, id: string) => m.emite.find((e) => e.id === id);

describe('edición desde el panel', () => {
  it('una edición de precio se escribe en los tres y, leído el eco, la pendiente desaparece', async () => {
    const m = await escrito();
    edicion(m, 'SKU-001', { precio: 6000 });
    const r = m.estado.catalogo;
    expect(r.pendientes('SKU-001')).toMatchObject([{ campo: 'precio', valor: 6000, usuario: ANA }]);
    expect(r.producto('SKU-001')).toMatchObject({ pendiente: true });
    expect(r.producto('SKU-001')?.canonico.precio).toMatchObject({ valor: 6000, fuente: 'panel' });

    const hecho = await m.pasada();
    expect(hecho).toMatchObject({ escritos: 3, revertidos: 0, conError: 0 });
    expect(coreinboxDe(m.mundo, 'c1')?.unitPrice).toBe('5042.02');
    expect(webDe(m.mundo, 11)?.regular_price).toBe('6000');
    expect(emiteDe(m.mundo, 'e5')?.precioNeto).toBe(5042.02);
    // Escrita, espera a leer el eco para soltarla.
    expect(r.pendientes('SKU-001')).toHaveLength(1);

    const marca = m.escrituras.length;
    await m.pasada();
    expect(m.escrituras.slice(marca)).toEqual([]);
    expect(r.pendientes('SKU-001')).toEqual([]);
    expect(r.producto('SKU-001')?.pendiente).toBeUndefined();
    expect(r.producto('SKU-001')?.canonico.precio?.valor).toBe(6000);
  });

  it('una edición de activo va primero a Coreinbox, que manda, y la pasada siguiente la propaga', async () => {
    const m = await escrito();
    edicion(m, 'SKU-001', { activo: false });
    const plan = m.estado.catalogo.producto('SKU-001')?.escrituras ?? [];
    expect(plan.filter((w) => w.campo === 'activo')).toEqual([
      { sistema: 'coreinbox', campo: 'activo', antes: true, valor: false, revierte: false },
    ]);
    await m.pasada();
    expect(coreinboxDe(m.mundo, 'c1')?.isActive).toBe(false);
    expect(webDe(m.mundo, 11)?.status).toBe('publish');
    expect(emiteDe(m.mundo, 'e5')?.activo).toBe(true);

    const siguiente = await m.pasada();
    expect(siguiente).toMatchObject({ escritos: 2, revertidos: 0 });
    expect(webDe(m.mundo, 11)?.status).toBe('draft');
    expect(emiteDe(m.mundo, 'e5')?.activo).toBe(false);
    expect(m.estado.catalogo.pendientes('SKU-001')).toEqual([]);
  });

  it('una edición sobre un campo en conflicto lo resuelve con ese valor', async () => {
    const m = await escrito();
    const cambiar = (p: { updatedAt?: string }) => (p.updatedAt = tic(m.mundo));
    const w = webDe(m.mundo, 11);
    const c = coreinboxDe(m.mundo, 'c1');
    if (!w || !c) throw new Error('falta el producto');
    w.regular_price = '5500';
    w.date_modified_gmt = w.date_modified = tic(m.mundo).slice(0, 19);
    c.unitPrice = '5042.02';
    cambiar(c);
    await m.pasada();
    const [conflicto] = m.estado.catalogo.conflictos('SKU-001', true);
    expect(conflicto).toMatchObject({ campo: 'precio' });

    edicion(m, 'SKU-001', { precio: 5800 });
    expect(m.estado.catalogo.conflictos('SKU-001', true)).toEqual([]);
    expect(m.estado.catalogo.conflictos('SKU-001')).toMatchObject([
      { estado: 'resuelto', resueltoCon: null, resueltoPor: ANA },
    ]);
    await m.pasada();
    expect(webDe(m.mundo, 11)?.regular_price).toBe('5800');
    expect(coreinboxDe(m.mundo, 'c1')?.unitPrice).toBe('4873.95');
    expect(emiteDe(m.mundo, 'e5')?.precioNeto).toBe(4873.95);
    await m.pasada();
    expect(m.estado.catalogo.pendientes('SKU-001')).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.precio?.valor).toBe(5800);
  });

  it('un cambio visto en un sistema después de la edición la deja atrás', async () => {
    const m = await escrito();
    m.d.escribir = false;
    edicion(m, 'SKU-001', { nombre: 'Válvula del panel' }, T2);
    const w = webDe(m.mundo, 11);
    if (!w) throw new Error('falta el producto');
    w.name = 'Válvula de la web';
    w.date_modified_gmt = w.date_modified = tic(m.mundo).slice(0, 19);
    await m.pasada();
    expect(m.estado.catalogo.pendientes('SKU-001')).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.nombre).toMatchObject({
      valor: 'Válvula de la web',
      fuente: 'woocommerce',
    });
  });

  it('rechaza el SKU, lo que el conector no escribe en quien manda y valores inválidos', async () => {
    const m = await escrito();
    const r = m.estado.catalogo;
    expect(() => edicion(m, 'SKU-001', { tipo: 'servicio' })).toThrow(
      '«tipo» lo manda Coreinbox y el conector no lo escribe ahí: cámbialo en Coreinbox',
    );
    expect(() => edicion(m, 'SKU-001', { exento: true })).toThrow(
      '«exento» lo manda Emite DTE y el conector no lo escribe ahí: cámbialo en Emite DTE',
    );
    expect(() => edicion(m, 'SKU-001', { sku: 'SKU-999' })).toThrow('el SKU no se edita');
    expect(() => edicion(m, 'SKU-404', { precio: 1 })).toThrow('no existe el SKU SKU-404');
    expect(() => edicion(m, 'SKU-001', {})).toThrow('al menos un campo');
    expect(() => edicion(m, 'SKU-001', { precio: '6000' })).toThrow('bruto entero');
    expect(() => edicion(m, 'SKU-001', { categoria: 'Otra' })).toThrow('no está entre las de Coreinbox');
    // Una edición válida junto a una inválida no deja nada.
    expect(() => edicion(m, 'SKU-001', { precio: 6000, tipo: 'servicio' })).toThrow();
    expect(r.pendientes()).toEqual([]);
  });

  it('una categoría se escribe en Coreinbox por su id', async () => {
    const m = await escrito();
    edicion(m, 'SKU-003', { categoria: 'Válvulas' });
    await m.pasada();
    expect(coreinboxDe(m.mundo, 'c3')?.categoryId).toBe('cat-1');
    await m.pasada();
    expect(m.mundo.emite.find((e) => e.codigo === 'SKU-003')?.categoria).toBe('Válvulas');
    expect(m.estado.catalogo.pendientes('SKU-003')).toEqual([]);
  });
});

const CLAVE = 'clave-de-prueba';
let servidor: Server | null = null;
afterEach(() => {
  servidor?.close();
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
  return async (ruta: string, opciones: { metodo?: string; cuerpo?: unknown } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${ruta}`, {
      method: opciones.metodo ?? 'GET',
      headers: {
        authorization: `Bearer ${CLAVE}`,
        'x-emite-usuario': ANA,
        ...(opciones.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
    });
    return { status: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
  };
}

describe('API JSON y respaldo con la escritura apagada', () => {
  it('las pendientes se acumulan sin que nada salga, se ven y se respaldan con las decisiones', async () => {
    const m = await leido();
    const pedir = await api(m.estado);
    expect(
      await pedir('/catalogo/acciones/alta', { metodo: 'POST', cuerpo: CODO }),
    ).toMatchObject({ status: 200, cuerpo: { aplicadas: 1, errores: [] } });
    expect(
      await pedir('/catalogo/acciones/edicion', {
        metodo: 'POST',
        cuerpo: { sku: 'SKU-005', campos: { nombre: 'Bomba centrífuga 1 HP' } },
      }),
    ).toMatchObject({ status: 200, cuerpo: { aplicadas: 1 } });
    expect(
      await pedir('/catalogo/acciones/alta', { metodo: 'POST', cuerpo: { ...CODO, sku: 'SKU-001' } }),
    ).toMatchObject({ status: 400, cuerpo: { error: 'ya existe el SKU SKU-001' } });

    await m.pasada();
    await m.pasada();
    expect(m.escrituras).toEqual([]);

    const lista = await pedir('/catalogo?pendientes=true');
    expect((lista.cuerpo.items as Array<{ sku: string }>).map((p) => p.sku)).toEqual([
      'SKU-005',
      'SKU-100',
    ]);
    const detalle = await pedir('/catalogo/SKU-005');
    expect(detalle.cuerpo.pendientes).toMatchObject({
      alta: null,
      ediciones: [{ campo: 'nombre', valor: 'Bomba centrífuga 1 HP', usuario: ANA }],
    });
    expect((await pedir('/catalogo/SKU-100')).cuerpo.pendientes).toMatchObject({
      alta: { sku: 'SKU-100', precio: 2380 },
    });

    const respaldo = await pedir('/catalogo/decisiones');
    expect(respaldo.cuerpo).toMatchObject({
      altas: [{ sku: 'SKU-100', nombre: 'Codo bronce 1/2', usuario: ANA }],
      pendientes: [{ sku: 'SKU-005', campo: 'nombre' }],
    });

    // Si el hub se pierde entre el alta y la pasada, el respaldo la repone.
    const vacio = new Estado(':memory:');
    const pedirVacio = await api(vacio);
    expect(
      await pedirVacio('/catalogo/decisiones', { metodo: 'POST', cuerpo: respaldo.cuerpo }),
    ).toMatchObject({ status: 200, cuerpo: { importadas: { altas: 1, pendientes: 1 } } });
    expect(vacio.catalogo.alta('SKU-100')).toMatchObject({ precio: 2380 });
    expect(vacio.catalogo.pendientes('SKU-005')).toHaveLength(1);
    expect(vacio.catalogo.producto('SKU-100')).toMatchObject({ pendiente: true, presentes: [] });
    const repuesto = await pedirVacio('/catalogo/decisiones');
    expect(repuesto.cuerpo).toEqual(respaldo.cuerpo);
  });

  it('un respaldo anterior a la 1c (sin altas ni pendientes) se repone igual', async () => {
    const pedir = await api(new Estado(':memory:'));
    expect(
      await pedir('/catalogo/decisiones', {
        metodo: 'POST',
        cuerpo: { version: 1, reglas: [], empates: [], conflictos: [], visibilidad: [], categoriasFuera: [] },
      }),
    ).toMatchObject({ status: 200, cuerpo: { importadas: { altas: 0, pendientes: 0 } } });
  });
});
