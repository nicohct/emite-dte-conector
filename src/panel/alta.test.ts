import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Salud } from '../salud.js';
import { crearServidor } from '../servidor.js';
import { armar, AHORA } from '../prueba/catalogo.js';
import { crearPanel } from './index.js';

const USUARIO = 'admin@example.com';
const FORM = 'application/x-www-form-urlencoded';

type Montaje = ReturnType<typeof armar>;

let servidor: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolver) => (servidor ? servidor.close(() => resolver()) : resolver()));
  servidor = null;
});

/** Con `leer`, hace antes una pasada de lectura (queda el catálogo y las categorías de Coreinbox). */
async function montar(leer: boolean): Promise<{ m: Montaje; base: string }> {
  const m = armar();
  if (leer) await m.pasada();
  const salud = new Salud(m.estado, { cotizaciones: false, productos: true, pedidos: false });
  const panel = crearPanel({
    salud: () => salud.respuesta(),
    estado: m.estado,
    enlaces: { emite: null },
    ahora: () => AHORA,
  });
  servidor = crearServidor(
    {
      coreinbox: m.d.coreinbox,
      estado: m.estado,
      secreto: 'whsec_prueba',
      urlPublica: 'http://emite.test',
      tipoActividad: 't-1',
    },
    () => salud.respuesta(),
    [panel],
  );
  await new Promise<void>((resolver) => servidor?.listen(0, '127.0.0.1', resolver));
  return { m, base: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}` };
}

async function pagina(base: string, ruta: string) {
  const r = await fetch(`${base}/panel/${ruta}`);
  return { status: r.status, html: await r.text() };
}

function enviar(
  base: string,
  accion: string,
  campos: Array<[string, string]>,
  cabeceras: Record<string, string> = {},
) {
  return fetch(`${base}/panel/acciones/${accion}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': FORM, 'x-emite-usuario': USUARIO, ...cabeceras },
    body: new URLSearchParams(campos).toString(),
  });
}

const skusDeFilas = (html: string) =>
  [...html.matchAll(/name="sku"\s+value="([^"]+)"/g)].map((x) => x[1]);

const consulta = (location: string | null) =>
  new URLSearchParams((location ?? '').split('?')[1] ?? '');

const sin = (campos: Array<[string, string]>, clave: string) => campos.filter(([k]) => k !== clave);

const ALTA: Array<[string, string]> = [
  ['volver', 'productos?pendientes=1'],
  ['sku', 'NUEVO-1'],
  ['nombre', 'Tubo de cobre'],
  ['precio', '12000'],
  ['tipo', 'bien'],
  ['categoria', 'Válvulas'],
  ['activo', '1'],
];

describe('alta desde el panel', () => {
  it('productos/nuevo: desplegable con las categorías leídas y el enlace desde la lista', async () => {
    const { base } = await montar(true);
    const r = await pagina(base, 'productos/nuevo');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h1>Nuevo producto</h1>');
    expect(r.html).toContain('action="../acciones/alta"');
    expect(r.html).toContain('maxlength="35"');
    expect(r.html).toMatch(/<select name="categoria">[\s\S]*<option value="Válvulas"/);
    expect(r.html).toContain('sin categoría');
    expect(r.html).toMatch(/name="activo" value="1" checked/);
    expect(r.html).toContain('name="aprobar_web"');
    expect(r.html).not.toContain('El registro aún no tiene categorías');
    const lista = await pagina(base, 'productos');
    expect(lista.html).toContain('href="./productos/nuevo"');
  });

  it('productos/nuevo: sin categorías leídas ofrece el campo libre con su aviso', async () => {
    const { base } = await montar(false);
    const r = await pagina(base, 'productos/nuevo');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<input type="text" name="categoria"');
    expect(r.html).not.toContain('<select name="categoria">');
    expect(r.html).toContain('El registro aún no tiene categorías de Coreinbox');
  });

  it('el formulario crea el alta pendiente, vuelve a los pendientes y la lista y la ficha la muestran', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(base, 'alta', [...ALTA, ['aprobar_web', '1']]);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('../productos?pendientes=1&accion=alta&aplicadas=1');
    expect(m.estado.catalogo.alta('NUEVO-1')).toMatchObject({
      sku: 'NUEVO-1',
      nombre: 'Tubo de cobre',
      precio: 12000,
      tipo: 'bien',
      categoria: 'Válvulas',
      exento: false,
      activo: true,
      usuario: USUARIO,
    });
    expect(m.estado.catalogo.producto('NUEVO-1')?.visibilidadWeb).toBe('aprobado');

    const lista = await pagina(base, 'productos?pendientes=1&accion=alta&aplicadas=1');
    expect(lista.status).toBe(200);
    expect(skusDeFilas(lista.html)).toEqual(['NUEVO-1']);
    expect(lista.html).toMatch(/class="etiqueta aviso"[^>]*>pendiente</);

    const ficha = await pagina(base, 'productos/NUEVO-1');
    expect(ficha.status).toBe(200);
    expect(ficha.html).toContain('<h2>Pendiente de escribir</h2>');
    expect(ficha.html).toContain('Alta desde el panel');
    expect(ficha.html).toContain('pendiente de crear');
    expect(ficha.html).toContain(USUARIO);
    expect(ficha.html).toContain('PRODUCTOS_ESCRIBIR=false');
    expect(ficha.html).toContain('el panel (pendiente)');
  });

  it('un SKU que ya existe vuelve con el error en el aviso y no crea nada', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(base, 'alta', [...sin(ALTA, 'sku'), ['sku', 'SKU-001']]);
    expect(r.status).toBe(303);
    const q = consulta(r.headers.get('location'));
    expect(q.get('aplicadas')).toBe('0');
    expect(q.getAll('error')).toHaveLength(1);
    expect(m.estado.catalogo.alta('SKU-001')).toBeNull();
    const vuelta = await pagina(base, `productos?${q.toString()}`);
    expect(vuelta.html).toContain('role="status"');
    expect(vuelta.html).toContain('con error');
    expect(vuelta.html).toContain('SKU-001');
  });

  it('un precio vacío o no numérico lo rechaza la acción', async () => {
    const { m, base } = await montar(true);
    for (const precio of ['', 'abc', '10.5']) {
      const r = await enviar(base, 'alta', [...sin(ALTA, 'precio'), ['precio', precio]]);
      expect(consulta(r.headers.get('location')).get('aplicadas')).toBe('0');
    }
    expect(m.estado.catalogo.altas()).toEqual([]);
  });

  it('un servicio aprobado para la web vuelve con error', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(base, 'alta', [
      ...sin(ALTA, 'tipo'),
      ['tipo', 'servicio'],
      ['aprobar_web', '1'],
    ]);
    expect(consulta(r.headers.get('location')).get('aplicadas')).toBe('0');
    expect(m.estado.catalogo.alta('NUEVO-1')).toBeNull();
  });

  it('la lista con pendientes=1 deja sólo lo pendiente', async () => {
    const { base } = await montar(true);
    expect(skusDeFilas((await pagina(base, 'productos')).html).length).toBeGreaterThan(1);
    expect((await pagina(base, 'productos?pendientes=1')).html).toContain('No hay productos');
    await enviar(base, 'alta', ALTA);
    const r = await pagina(base, 'productos?pendientes=1');
    expect(skusDeFilas(r.html)).toEqual(['NUEVO-1']);
    expect(r.html).toMatch(/name="pendientes"\s+value="1"\s+checked/);
    expect(skusDeFilas((await pagina(base, 'productos')).html)).toContain('NUEVO-1');
  });

  it('rechaza con 403 un alta de otro sitio y no crea nada', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(base, 'alta', ALTA, { 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
    expect(r.headers.get('location')).toBeNull();
    expect(m.estado.catalogo.altas()).toEqual([]);
  });
});

describe('edición desde el panel', () => {
  it('la ficha trae el formulario precargado con los antes_ y el SKU como texto', async () => {
    const { base } = await montar(true);
    const r = await pagina(base, 'productos/SKU-001');
    expect(r.html).toContain('action="../acciones/edicion"');
    expect(r.html).toContain('<input type="hidden" name="sku" value="SKU-001" />');
    expect(r.html).toContain('name="antes_nombre" value="Válvula esfera 1/2"');
    expect(r.html).toMatch(/name="antes_activo" value="true"/);
    expect(r.html).toMatch(/name="activo"\s+value="1"\s+checked/);
    expect(r.html).toContain('El SKU no se edita');
    expect(r.html).not.toContain('<h2>Pendiente de escribir</h2>');
  });

  it('sólo los campos que cambian quedan pendientes y la ficha los muestra', async () => {
    const { m, base } = await montar(true);
    const ficha = await pagina(base, 'productos/SKU-001');
    const antes = (campo: string) =>
      ficha.html.match(new RegExp(`name="antes_${campo}" value="([^"]*)"`))?.[1] ?? '';
    const r = await enviar(base, 'edicion', [
      ['volver', 'productos/SKU-001'],
      ['sku', 'SKU-001'],
      ['nombre', 'Válvula esfera 3/4'],
      ['antes_nombre', antes('nombre')],
      ['precio', antes('precio')],
      ['antes_precio', antes('precio')],
      ['activo', '1'],
      ['antes_activo', 'true'],
    ]);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('../productos/SKU-001?accion=edicion&aplicadas=1');
    expect(m.estado.catalogo.pendientes('SKU-001').map((p) => [p.campo, p.valor])).toEqual([
      ['nombre', 'Válvula esfera 3/4'],
    ]);
    const despues = await pagina(base, 'productos/SKU-001?accion=edicion&aplicadas=1');
    expect(despues.html).toContain('<h2>Pendiente de escribir</h2>');
    expect(despues.html).toContain('Válvula esfera 3/4');
    expect(despues.html).toContain(USUARIO);
    expect(skusDeFilas((await pagina(base, 'productos?pendientes=1')).html)).toEqual(['SKU-001']);
  });

  it('sin cambios vuelve con el error de la acción', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(base, 'edicion', [
      ['volver', 'productos/SKU-001'],
      ['sku', 'SKU-001'],
      ['nombre', 'Válvula esfera 1/2'],
      ['antes_nombre', 'Válvula esfera 1/2'],
    ]);
    expect(consulta(r.headers.get('location')).get('aplicadas')).toBe('0');
    expect(m.estado.catalogo.pendientes()).toEqual([]);
  });

  it('la ficha de un alta pendiente se edita y cambia el alta', async () => {
    const { m, base } = await montar(true);
    await enviar(base, 'alta', ALTA);
    const r = await enviar(base, 'edicion', [
      ['volver', 'productos/NUEVO-1'],
      ['sku', 'NUEVO-1'],
      ['precio', '15000'],
      ['antes_precio', '12000'],
    ]);
    expect(consulta(r.headers.get('location')).get('aplicadas')).toBe('1');
    expect(m.estado.catalogo.alta('NUEVO-1')?.precio).toBe(15000);
    const ficha = await pagina(base, 'productos/NUEVO-1');
    expect(ficha.html).toContain('name="antes_precio" value="15000"');
  });

  it('rechaza con 403 una edición de otro sitio', async () => {
    const { m, base } = await montar(true);
    const r = await enviar(
      base,
      'edicion',
      [
        ['sku', 'SKU-001'],
        ['nombre', 'X'],
        ['antes_nombre', 'Y'],
      ],
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(r.status).toBe(403);
    expect(m.estado.catalogo.pendientes()).toEqual([]);
  });
});
