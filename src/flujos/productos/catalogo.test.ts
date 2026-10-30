import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Estado } from '../../estado.js';
import {
  AHORA,
  armar,
  CI,
  EMITE,
  emite,
  mundoInicial,
  T0,
  T2,
  TIENDA,
} from '../../prueba/catalogo.js';
import { Salud } from '../../salud.js';
import { crearAtencionCatalogo, detalleDe } from './api.js';

/** Lo que el registro sabe, sin lo que depende de cuándo se leyó (horas de lectura). */
function foto(estado: Estado) {
  const r = estado.catalogo;
  const limpiar = (v: unknown): unknown =>
    JSON.parse(
      JSON.stringify(v, (k, valor: unknown) =>
        k === 'leidoEn' || k === 'vistoEn' || k === 'propuestoEn' ? undefined : valor,
      ),
    );
  return limpiar({
    productos: r.skus().map((sku) => {
      const { conflictos: _c, ...resto } = detalleDe(r, sku) ?? { conflictos: [] };
      return resto;
    }),
    historicos: r.historicos(),
    empates: r.empates(),
    sinSku: r.sinSku(),
  });
}

describe('pasada de lectura del catálogo', () => {
  it('la primera pasada deja el registro, las diferencias, los empates y el índice', async () => {
    const { estado, peticiones, pasada } = armar();
    const r = await pasada();

    expect(peticiones.every((p) => p.metodo === 'GET')).toBe(true);
    expect(r).toMatchObject({
      leidosCoreinbox: 5,
      leidosWoocommerce: 4,
      leidosEmite: 6,
      historicos: 5,
      sinSku: 2,
      camposCambiados: 0,
      conflictosNuevos: 0,
      empatesPropuestos: 4,
    });
    const registro = estado.catalogo;
    expect(registro.skus()).toEqual(['SKU-001', 'SKU-002', 'SKU-003', 'SKU-005', 'SKU-006']);

    // Los tres sistemas, sin diferencias: el neto de Coreinbox y Emite DTE da el mismo bruto.
    const valvula = detalleDe(registro, 'SKU-001');
    expect(valvula).toMatchObject({
      tipo: 'bien',
      visibilidadWeb: 'aprobado',
      alcance: ['coreinbox', 'woocommerce', 'emite'],
      presentes: ['coreinbox', 'woocommerce', 'emite'],
      faltaEn: [],
      diferencias: [],
      canonico: {
        nombre: { valor: 'Válvula esfera 1/2', fuente: 'woocommerce' },
        precio: { valor: 5000, fuente: 'woocommerce' },
        tipo: { valor: 'bien', fuente: 'coreinbox' },
        categoria: { valor: 'Válvulas', fuente: 'coreinbox' },
      },
      precioNeto: 4201.68,
      sistemas: {
        coreinbox: { id: 'c1', valores: { precio: 5000, activo: true } },
        woocommerce: { id: '11', valores: { precio: 5000 } },
        emite: { id: 'e5', valores: { precio: 5000 }, extra: { origen: 'manual' } },
      },
    });
    expect(valvula?.indice.map((e) => [e.sistema, e.tipo, e.url])).toEqual([
      ['coreinbox', 'categoria', `${CI}/api/v1/products/c1`],
      ['coreinbox', 'imagen', `${CI}/api/v1/products/c1/image`],
      ['coreinbox', 'producto', `${CI}/api/v1/products/c1`],
      ['emite', 'producto', `${EMITE}/api/v1/productos/e5`],
      ['woocommerce', 'atributos', `${TIENDA}/wp-json/wc/v3/products/11`],
      ['woocommerce', 'categoria', `${TIENDA}/wp-json/wc/v3/products/categories/3`],
      ['woocommerce', 'documento', `${TIENDA}/wp-content/uploads/ficha-001.pdf`],
      ['woocommerce', 'imagen', `${TIENDA}/wp-content/uploads/valvula.jpg`],
      ['woocommerce', 'metadatos', `${TIENDA}/wp-json/wc/v3/products/11`],
      ['woocommerce', 'pagina', `${TIENDA}/producto/p-11/`],
    ]);
    expect(valvula?.indice.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
    expect(valvula?.empates).toMatchObject([
      {
        emiteId: 'e1',
        motivo: 'nombre',
        estado: 'propuesto',
        historico: { codigo: 'VALV ESF 1/2', uso: { documentos: 12 } },
      },
    ]);

    // Diferencias en bruto entre Coreinbox y la web; la web manda en nombre y precio.
    expect(detalleDe(registro, 'SKU-005')).toMatchObject({
      diferencias: [
        {
          campo: 'nombre',
          valores: { coreinbox: 'Bomba centrífuga', woocommerce: 'Bomba centrífuga & motor' },
        },
        { campo: 'precio', valores: { coreinbox: 100000, woocommerce: 99990 } },
      ],
      canonico: { precio: { valor: 99990, fuente: 'woocommerce' } },
      faltaEn: ['emite'],
      empates: [{ emiteId: 'e3', motivo: 'parecido' }],
    });

    // Un servicio nunca va a la web; su histórico empata por código exacto.
    expect(detalleDe(registro, 'SKU-002')).toMatchObject({
      tipo: 'servicio',
      visibilidadWeb: 'no_aplica',
      alcance: ['coreinbox', 'emite'],
      canonico: { precio: { valor: 59500, fuente: 'coreinbox' } },
      empates: [{ emiteId: 'e2', motivo: 'codigo', puntaje: 1 }],
    });

    // Lo que no está en la web queda propuesto; el histórico se encontró por alias.
    expect(detalleDe(registro, 'SKU-003')).toMatchObject({
      visibilidadWeb: 'propuesto',
      motivoVisibilidad: 'sin_decision',
      faltaEn: ['emite'],
      empates: [{ emiteId: 'e4', motivo: 'alias' }],
    });

    // Sólo en la web y en borrador: estar en la tienda no lo aprueba, sigue propuesto.
    expect(detalleDe(registro, 'SKU-006')).toMatchObject({
      presentes: ['woocommerce'],
      visibilidadWeb: 'propuesto',
      motivoVisibilidad: 'sin_decision',
      faltaEn: ['coreinbox', 'emite'],
    });

    expect(registro.sinSku().map((s) => [s.sistema, s.nombre])).toEqual([
      ['coreinbox', 'Producto sin código'],
      ['woocommerce', 'Oferta sin SKU'],
    ]);
    expect(registro.empatesDeHistorico('e6')).toEqual([]);

    // Cursores propios por sistema.
    expect(registro.cursor('coreinbox')).toBe('2026-10-30T10:55:00.000Z');
    expect(registro.cursor('woocommerce')).toBe('2026-10-29T09:55:00.000Z');
    expect(registro.cursor('emite')).toBe('2026-10-29T09:55:00.000Z');
  });

  it('la segunda pasada lee sólo lo cambiado y abre un conflicto si dos sistemas cambian el mismo campo', async () => {
    const { mundo, estado, peticiones, pasada } = armar();
    await pasada();
    peticiones.length = 0;
    // «Último cambio» sólo rige desde la primera escritura.
    estado.catalogo.iniciarEscritura('2026-10-30T10:00:00.000Z');

    const [c1] = mundo.coreinbox;
    const [w11, w15] = mundo.woo;
    if (!c1 || !w11 || !w15) throw new Error('fixture');
    Object.assign(c1, { unitPrice: '5042.02', updatedAt: T2 });
    Object.assign(w11, { regular_price: '5500', date_modified_gmt: T2.slice(0, 19) });
    Object.assign(w15, { regular_price: '100000', date_modified_gmt: T2.slice(0, 19) });

    const r = await pasada();
    expect(peticiones.every((p) => p.metodo === 'GET')).toBe(true);
    // Desde el cursor (menos el margen de 5 minutos): Coreinbox sólo trae lo cambiado; la web
    // vuelve a traer lo de la última modificación vista, que no cuenta como cambio.
    expect(r).toMatchObject({ leidosCoreinbox: 1, camposCambiados: 3, conflictosNuevos: 1 });
    const consultaWeb = peticiones.find((p) => p.url.origin === TIENDA);
    expect(consultaWeb?.url.searchParams.get('modified_after')).toBe('2026-10-29T09:55:00.000Z');
    // `orden=reciente` se deja de recorrer al llegar a lo anterior al cursor: una sola página.
    const consultaEmite = peticiones.filter((p) => p.url.pathname === '/api/v1/productos');
    expect(consultaEmite).toHaveLength(1);
    expect(r.leidosEmite).toBe(3);

    const valvula = detalleDe(estado.catalogo, 'SKU-001');
    expect(valvula?.conflictos).toMatchObject([
      {
        campo: 'precio',
        estado: 'abierto',
        valores: {
          coreinbox: { valor: 6000, en: T2 },
          woocommerce: { valor: 5500, en: T2 },
        },
      },
    ]);
    expect(valvula?.canonico.precio).toEqual({
      valor: 5500,
      fuente: 'woocommerce',
      modo: 'ultimo',
      conflicto: true,
    });

    // Un solo lado cambió: no hay conflicto, y la diferencia de precio desaparece.
    const bomba = detalleDe(estado.catalogo, 'SKU-005');
    expect(bomba?.conflictos).toEqual([]);
    expect(bomba?.diferencias.map((x) => x.campo)).toEqual(['nombre']);
    expect(estado.catalogo.resumen()).toMatchObject({ enConflicto: 1 });
  });

  it('un campo con propietario cambiado en dos sistemas no abre conflicto', async () => {
    const mundo = mundoInicial();
    const w15 = mundo.woo.find((p) => p.id === 15);
    if (!w15) throw new Error('fixture');
    Object.assign(w15, { status: 'draft' });
    const { estado, pasada } = armar(mundo);
    await pasada();
    estado.catalogo.iniciarEscritura('2026-10-30T10:00:00.000Z');

    const c5 = mundo.coreinbox.find((p) => p.id === 'c5');
    if (!c5) throw new Error('fixture');
    Object.assign(c5, { isActive: false, updatedAt: T2 });
    Object.assign(w15, { status: 'publish', date_modified_gmt: T2.slice(0, 19) });
    const r = await pasada();

    expect(r).toMatchObject({ camposCambiados: 2, conflictosNuevos: 0 });
    expect(estado.catalogo.conflictos('SKU-005', true)).toEqual([]);
    expect(estado.catalogo.producto('SKU-005')?.canonico.activo).toMatchObject({
      valor: false,
      fuente: 'coreinbox',
      modo: 'propietario',
    });
  });

  it('borrar el registro y volver a leer los tres reconstruye lo mismo', async () => {
    const original = armar();
    await original.pasada();
    const [c3] = original.mundo.coreinbox;
    const [, w15, w16] = original.mundo.woo;
    if (!c3 || !w15 || !w16) throw new Error('fixture');
    Object.assign(c3, { name: 'Repuesto sello NBR', updatedAt: T2 });
    Object.assign(w15, { regular_price: '100000', date_modified_gmt: T2.slice(0, 19) });
    Object.assign(w16, { sku: '', date_modified_gmt: T2.slice(0, 19) });
    original.mundo.emite.push(
      emite('e7', { codigo: 'LLP', nombre: 'Repuesto sello nbr', updatedAt: T2 }),
    );
    await original.pasada();

    const reconstruido = armar(original.mundo, new Estado(':memory:'));
    await reconstruido.pasada();

    expect(foto(reconstruido.estado)).toEqual(foto(original.estado));
    expect(reconstruido.estado.catalogo.resumen()).toEqual(original.estado.catalogo.resumen());
    expect(reconstruido.estado.catalogo.producto('SKU-006')).toBeNull();
  });

  it('una caída de la tienda corta la pasada sin mover su cursor; lo leído antes queda', async () => {
    const mundo = mundoInicial();
    mundo.wooStatus = 503;
    const { estado, pasada } = armar(mundo);
    await expect(pasada()).rejects.toMatchObject({ status: 503, transitorio: true });
    expect(estado.catalogo.cursor('coreinbox')).not.toBeNull();
    expect(estado.catalogo.cursor('woocommerce')).toBeNull();
    expect(estado.catalogo.cursor('emite')).toBeNull();
    expect(estado.catalogo.producto('SKU-001')?.presentes).toEqual(['coreinbox']);
  });

  it('con la escritura apagada no sale ninguna escritura; encendida escribe sin borrar nada', async () => {
    const apagada = armar();
    await apagada.pasada();
    expect(apagada.peticiones.filter((p) => p.metodo !== 'GET')).toEqual([]);

    const encendida = armar();
    encendida.d.escribir = true;
    await encendida.pasada();
    const escritas = encendida.peticiones.filter((p) => p.metodo !== 'GET');
    expect(escritas.length).toBeGreaterThan(0);
    expect(escritas.some((p) => p.metodo === 'DELETE')).toBe(false);
  });

  it('GET /salud suma los contadores del catálogo sin quitar los de antes', async () => {
    const { estado, pasada } = armar();
    await pasada();
    const salud = new Salud(estado, { cotizaciones: true, productos: true, pedidos: false });
    expect(salud.respuesta().flujos.productos).toMatchObject({
      activo: true,
      sincronizados: 0,
      omitidos: 0,
      conError: 0,
      catalogo: {
        skus: 5,
        leidos: { coreinbox: 5, woocommerce: 4, emite: 6 },
        historicos: 5,
        conDiferencias: 1,
        enConflicto: 0,
        empatesPropuestos: 4,
        sinSku: 2,
      },
    });
  });
});

// --- API del catálogo ---

const CLAVE = 'clave-de-prueba';
let servidor: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolver) => (servidor ? servidor.close(() => resolver()) : resolver()));
  servidor = null;
});

async function api(estado: Estado, clave: string | null = CLAVE) {
  const atender = crearAtencionCatalogo({ estado, clave, ahora: () => AHORA });
  servidor = createServer((req, res) => {
    void atender(req, res).then((atendida) => {
      if (!atendida) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"no existe"}');
      }
    });
  });
  await new Promise<void>((resolver) => servidor?.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address() as AddressInfo;
  return async (
    ruta: string,
    opciones: { metodo?: string; cuerpo?: unknown; clave?: string; usuario?: string } = {},
  ) => {
    const r = await fetch(`http://127.0.0.1:${port}${ruta}`, {
      method: opciones.metodo ?? 'GET',
      headers: {
        authorization: `Bearer ${opciones.clave ?? CLAVE}`,
        ...(opciones.usuario ? { 'x-emite-usuario': opciones.usuario } : {}),
        ...(opciones.cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opciones.cuerpo !== undefined ? { body: JSON.stringify(opciones.cuerpo) } : {}),
    });
    return { status: r.status, cuerpo: (await r.json()) as Record<string, unknown> };
  };
}

async function cargado() {
  const m = armar();
  await m.pasada();
  m.peticiones.length = 0;
  return m;
}

describe('API del catálogo', () => {
  it('sin clave configurada no existe; con clave equivocada responde 401', async () => {
    const { estado } = await cargado();
    expect((await (await api(estado, null))('/catalogo')).status).toBe(404);
    await new Promise<void>((resolver) => servidor?.close(() => resolver()));
    const pedir = await api(estado);
    expect((await pedir('/catalogo', { clave: 'otra' })).status).toBe(401);
    expect((await pedir('/salud')).status).toBe(404);
  });

  it('GET /catalogo pagina y filtra', async () => {
    const { estado } = await cargado();
    const pedir = await api(estado);
    const todo = await pedir('/catalogo?limite=2&pagina=2');
    expect(todo.cuerpo).toMatchObject({ total: 5, pagina: 2, limite: 2 });
    expect((todo.cuerpo.items as Array<{ sku: string }>).map((p) => p.sku)).toEqual([
      'SKU-003',
      'SKU-005',
    ]);
    const skus = async (q: string) =>
      ((await pedir(`/catalogo?${q}`)).cuerpo.items as Array<{ sku: string }>).map((p) => p.sku);
    expect(await skus('diferencias=true')).toEqual(['SKU-005']);
    expect(await skus('sin_sku=true')).toEqual(['SKU-002', 'SKU-003', 'SKU-005', 'SKU-006']);
    expect(await skus('propuesto_web=true')).toEqual(['SKU-003', 'SKU-006']);
    expect(await skus('historicos=true')).toEqual(['SKU-001', 'SKU-002', 'SKU-003', 'SKU-005']);
    expect(await skus('conflicto=true')).toEqual([]);
    expect(await skus('q=Bomba')).toEqual(['SKU-005']);

    const historicos = await pedir('/catalogo?vista=historicos&estado=sin_candidato');
    expect((historicos.cuerpo.items as Array<{ emiteId: string }>).map((h) => h.emiteId)).toEqual([
      'e6',
    ]);
    const sinSku = await pedir('/catalogo?vista=sin_sku&sistema=woocommerce');
    expect(sinSku.cuerpo).toMatchObject({ total: 1, items: [{ nombre: 'Oferta sin SKU' }] });
  });

  it('GET /catalogo/{sku} trae los tres valores y sus enlaces', async () => {
    const { estado } = await cargado();
    const pedir = await api(estado);
    const r = await pedir('/catalogo/SKU-001');
    expect(r.status).toBe(200);
    expect(Object.keys(r.cuerpo.sistemas as object)).toEqual(['coreinbox', 'woocommerce', 'emite']);
    expect((r.cuerpo.indice as unknown[]).length).toBe(10);
    expect((await pedir('/catalogo/NO-EXISTE')).status).toBe(404);
  });

  it('las acciones cambian sólo el registro y anotan quién las hizo', async () => {
    const { estado, peticiones } = await cargado();
    const pedir = await api(estado);
    const usuario = 'admin@example.com';
    const accion = (nombre: string, cuerpo: unknown) =>
      pedir(`/catalogo/acciones/${nombre}`, { metodo: 'POST', cuerpo, usuario });

    // Quién manda, en lote.
    expect(
      (await accion('reglas', { campo: 'precio', fuente: 'coreinbox', skus: ['SKU-005', 'X'] }))
        .cuerpo,
    ).toEqual({ aplicadas: 1, errores: [{ indice: 1, error: 'no existe el SKU X' }] });
    expect(estado.catalogo.producto('SKU-005')?.canonico.precio).toEqual({
      valor: 100000,
      fuente: 'coreinbox',
      modo: 'propietario',
    });
    // Y para todo el catálogo.
    await accion('reglas', { campo: 'nombre', fuente: 'coreinbox' });
    expect(estado.catalogo.producto('SKU-005')?.canonico.nombre?.fuente).toBe('coreinbox');

    // Empates: confirmar uno, rechazar otro (vuelve a proponerse algo distinto o nada).
    expect(
      (
        await accion('empates', {
          decisiones: [
            { emiteId: 'e1', sku: 'SKU-001', estado: 'confirmado' },
            { emiteId: 'e3', sku: 'SKU-005', estado: 'rechazado' },
          ],
        })
      ).cuerpo,
    ).toEqual({ aplicadas: 2, errores: [] });
    expect(estado.catalogo.empatesDeHistorico('e1')).toMatchObject([
      { sku: 'SKU-001', estado: 'confirmado', decididoPor: usuario },
    ]);
    expect(
      estado.catalogo.empatesDeHistorico('e3').filter((e) => e.estado === 'propuesto'),
    ).not.toContainEqual(expect.objectContaining({ sku: 'SKU-005' }));

    // Visibilidad: un servicio nunca va a la web.
    expect(
      (await accion('visibilidad', { skus: ['SKU-003', 'SKU-002'], estado: 'aprobado' })).cuerpo,
    ).toEqual({
      aplicadas: 1,
      errores: [{ indice: 1, error: 'SKU-002 es un servicio: nunca va a la web' }],
    });
    expect(estado.catalogo.producto('SKU-003')).toMatchObject({
      visibilidadWeb: 'aprobado',
      faltaEn: ['woocommerce', 'emite'],
    });

    expect((await accion('reglas', { campo: 'sku', fuente: 'coreinbox' })).status).toBe(400);
    expect((await accion('desconocida', {})).status).toBe(404);
    expect(estado.catalogo.acciones().map((a) => [a.accion, a.usuario])).toEqual([
      ['visibilidad', usuario],
      ['empates', usuario],
      ['reglas', usuario],
      ['reglas', usuario],
    ]);
    expect(peticiones).toEqual([]);
  });

  it('resolver un conflicto deja el valor elegido y lo cierra', async () => {
    const { mundo, estado, pasada } = await cargado();
    estado.catalogo.iniciarEscritura('2026-10-30T10:00:00.000Z');
    const [c1] = mundo.coreinbox;
    const [w11] = mundo.woo;
    if (!c1 || !w11) throw new Error('fixture');
    Object.assign(c1, { unitPrice: '5042.02', updatedAt: T2 });
    Object.assign(w11, { regular_price: '5500', date_modified_gmt: T2.slice(0, 19) });
    await pasada();
    const [conflicto] = estado.catalogo.conflictos('SKU-001', true);
    if (!conflicto) throw new Error('debía haber un conflicto');

    const pedir = await api(estado);
    const r = await pedir('/catalogo/acciones/conflictos', {
      metodo: 'POST',
      cuerpo: { resoluciones: [{ id: conflicto.id, fuente: 'coreinbox' }] },
    });
    expect(r.cuerpo).toEqual({ aplicadas: 1, errores: [] });
    expect(estado.catalogo.conflicto(conflicto.id)).toMatchObject({
      estado: 'resuelto',
      resueltoCon: 'coreinbox',
      resueltoPor: null,
    });
    expect(estado.catalogo.producto('SKU-001')?.canonico.precio).toEqual({
      valor: 6000,
      fuente: 'coreinbox',
      modo: 'ultimo',
    });
    // En «último cambio» elegir un valor no crea una regla: gana ese cambio.
    expect(estado.catalogo.reglas().filter((x) => x.ambito === 'SKU-001')).toEqual([]);
  });
});
