import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Salud } from '../salud.js';
import { crearServidor } from '../servidor.js';
import { armar, AHORA, coreinbox, mundoInicial, T2, type Mundo } from '../prueba/catalogo.js';
import { recalcularTodo } from '../flujos/productos/lectura.js';
import { crearPanel } from './index.js';

const USUARIO = 'admin@example.com';
const FORM = 'application/x-www-form-urlencoded';

type Montaje = ReturnType<typeof armar>;

let servidor: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolver) => (servidor ? servidor.close(() => resolver()) : resolver()));
  servidor = null;
});

async function cargado(mundo: Mundo = mundoInicial()): Promise<Montaje> {
  const m = armar(mundo);
  await m.pasada();
  m.peticiones.length = 0;
  return m;
}

async function levantar(m: Montaje): Promise<string> {
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
  return `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
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

/** Los SKUs de las filas de la lista de productos (cada fila trae su casilla de lote). */
const skusDeFilas = (html: string) =>
  [...html.matchAll(/name="sku"\s+value="([^"]+)"/g)].map((x) => x[1]);

const sinEntidades = (texto: string) => texto.replaceAll('&amp;', '&');

const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]*)"/g)].map((x) => sinEntidades(x[1] ?? ''));

function consulta(location: string | null) {
  const q = (location ?? '').split('?')[1] ?? '';
  return new URLSearchParams(q);
}

/** Los eventos de la bitácora de una acción, con el usuario que la hizo. */
const eventosDe = (m: Montaje, accion: string) =>
  m.estado.eventos({ estado: accion }).filter((e) => e.tipo === 'accion');

/** Hace el POST, comprueba la redirección y devuelve la consulta de `location`. */
async function aplicar(
  base: string,
  accion: string,
  campos: Array<[string, string]>,
  volver: string,
) {
  const r = await enviar(base, accion, [['volver', volver], ...campos]);
  expect(r.status).toBe(303);
  const location = r.headers.get('location') ?? '';
  expect(location.startsWith(`../${volver.split('?')[0]}?`)).toBe(true);
  return { location, q: consulta(location) };
}

describe('pantallas del catálogo', () => {
  it('flujos: la tarjeta Catálogo trae las cifras y los enlaces', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'flujos');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h2>Catálogo</h2>');
    expect(r.html).toMatch(
      /SKUs<\/dt>\s*<dd><a href="\.\/productos"><span class="cifra">5<\/span>/,
    );
    for (const ruta of [
      './productos?diferencias=1',
      './conflictos',
      './historicos?estado=propuesto',
      './productos?vista=sin_sku',
      './historicos',
    ]) {
      expect(hrefs(r.html)).toContain(ruta);
    }
    expect(r.html).toMatch(/Con diferencias<\/dt>\s*<dd><a[^>]*><span class="cifra">1<\/span>/);
    expect(r.html).toMatch(/Empates propuestos<\/dt>\s*<dd><a[^>]*><span class="cifra">4<\/span>/);
    expect(r.html).toMatch(/Sin SKU<\/dt>\s*<dd><a[^>]*><span class="cifra">2<\/span>/);
  });

  it('productos: una fila por SKU con el valor de cada sistema', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'productos');
    expect(r.status).toBe(200);
    expect(skusDeFilas(r.html)).toEqual(['SKU-001', 'SKU-002', 'SKU-003', 'SKU-005', 'SKU-006']);
    expect(hrefs(r.html)).toContain('./productos/SKU-001');
    for (const sistema of ['Coreinbox', 'Web', 'Emite DTE']) expect(r.html).toContain(sistema);
    // SKU-005: precio de Coreinbox (100.000 bruto) y de la web (99.990) distintos.
    expect(r.html).toContain('Bomba centrífuga');
    expect(r.html).toContain('class="distinto"');
    expect(r.html).toContain('5.000');
    expect(r.html).toContain('99.990');
    // La foto de SKU-001 y el hueco de los demás.
    expect(r.html).toContain('src="./imagen/SKU-001"');
    expect(r.html).not.toContain('src="./imagen/SKU-003"');
    expect(r.html).toContain('<form method="post" action="./acciones/reglas">');
  });

  it('productos: los filtros se reflejan en las filas', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const filas = async (q: string) => skusDeFilas((await pagina(base, `productos?${q}`)).html);
    expect(await filas('q=Bomba')).toEqual(['SKU-005']);
    expect(await filas('q=sku-00')).toEqual([
      'SKU-001',
      'SKU-002',
      'SKU-003',
      'SKU-005',
      'SKU-006',
    ]);
    expect(await filas('diferencias=1')).toEqual(['SKU-005']);
    // SKU-006 es un borrador en la web: lo que está en la web ya está aprobado.
    expect(await filas('propuesto_web=1')).toEqual(['SKU-003']);
    expect(await filas('historicos=1')).toEqual(['SKU-001', 'SKU-002', 'SKU-003', 'SKU-005']);
    expect(await filas('sin_sku=1')).toEqual(['SKU-002', 'SKU-003', 'SKU-005', 'SKU-006']);
    expect(await filas('conflicto=1')).toEqual([]);
    expect(await filas('q=Bomba&diferencias=1')).toEqual(['SKU-005']);
    expect(await filas('q=Bomba&propuesto_web=1')).toEqual([]);
    // Valores desconocidos se ignoran.
    expect(await filas('diferencias=quizas&pagina=-3&sistema=otro')).toHaveLength(5);

    const vacio = await pagina(base, 'productos?conflicto=1');
    expect(vacio.html).toContain('No hay productos con estos filtros.');
    expect(vacio.html).toContain('<a href="?">Quitar filtros</a>');
    const filtrado = await pagina(base, 'productos?q=Bomba&diferencias=1');
    expect(filtrado.html).toMatch(/name="diferencias"\s+value="1"\s+checked/);
    expect(filtrado.html).toContain('value="Bomba"');
  });

  it('productos: la paginación conserva los filtros', async () => {
    const mundo = mundoInicial();
    for (let i = 1; i <= 55; i++) {
      const n = String(i).padStart(2, '0');
      mundo.coreinbox.push(coreinbox(`b${n}`, { sku: `BULK-${n}`, name: `Tornillo ${n}` }));
    }
    const m = await cargado(mundo);
    const base = await levantar(m);

    const p1 = await pagina(base, 'productos?q=BULK&propuesto_web=1');
    expect(skusDeFilas(p1.html)).toHaveLength(50);
    expect(p1.html).toContain('de <span class="cifra">2</span>');
    const siguiente = sinEntidades(/<a href="([^"]*)" rel="next"/.exec(p1.html)?.[1] ?? '');
    expect(siguiente).not.toBe('');
    const q1 = new URLSearchParams(siguiente.split('?')[1]);
    expect(q1.get('q')).toBe('BULK');
    expect(q1.get('propuesto_web')).toBe('1');
    expect(q1.get('pagina')).toBe('2');

    const p2 = await pagina(base, `productos${siguiente}`);
    expect(skusDeFilas(p2.html)).toHaveLength(5);
    const anterior = sinEntidades(/<a href="([^"]*)" rel="prev"/.exec(p2.html)?.[1] ?? '');
    expect(new URLSearchParams(anterior.split('?')[1]).get('q')).toBe('BULK');
    expect(new URLSearchParams(anterior.split('?')[1]).get('pagina')).toBeNull();
    // El formulario de lote vuelve a la misma página con los mismos filtros.
    const volver = /name="volver" value="([^"]*)"/.exec(p2.html)?.[1] ?? '';
    expect(sinEntidades(volver)).toContain('pagina=2');
    expect(volver).toContain('q=BULK');
  });

  it('productos?vista=sin_sku lista los productos sin SKU, con filtro por sistema', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const todos = await pagina(base, 'productos?vista=sin_sku');
    expect(todos.status).toBe(200);
    expect(todos.html).toContain('<h1>Productos sin SKU</h1>');
    expect(todos.html).toContain('Producto sin código');
    expect(todos.html).toContain('Oferta sin SKU');
    expect(skusDeFilas(todos.html)).toEqual([]);

    const web = await pagina(base, 'productos?vista=sin_sku&sistema=woocommerce');
    expect(web.html).toContain('Oferta sin SKU');
    expect(web.html).not.toContain('Producto sin código');
    expect(web.html).toMatch(/<option value="woocommerce"\s+selected>\s*Web\s*<\/option>/);

    const coreinbox = await pagina(base, 'productos?vista=sin_sku&sistema=coreinbox');
    expect(coreinbox.html).toContain('Producto sin código');
    expect(coreinbox.html).not.toContain('Oferta sin SKU');

    const emite = await pagina(base, 'productos?vista=sin_sku&sistema=emite');
    expect(emite.html).toContain('No hay productos sin SKU.');
  });

  it('productos/SKU-001: valores por sistema, reglas, empates, índice y foto', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'productos/SKU-001');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h1>SKU-001</h1>');
    expect(r.html).toContain('<h2>Valores por sistema</h2>');
    for (const campo of ['Nombre', 'Precio bruto', 'Activo', 'Tipo', 'Categoría', 'Exento']) {
      expect(r.html).toContain(`<th scope="row">${campo}</th>`);
    }
    expect(r.html).toContain('Válvula esfera 1/2');
    expect(r.html).toContain('5.000');
    // Un id por sistema.
    for (const id of ['c1', '11', 'e5']) expect(r.html).toContain(`<span class="id">${id}</span>`);

    expect(r.html).toContain('<h2>Quién manda</h2>');
    expect(r.html).toContain('Sin reglas: manda el modo por defecto de cada campo.');
    expect(r.html).toContain('<input type="hidden" name="sku" value="SKU-001" />');

    expect(r.html).toContain('<h2>Históricos de Emite DTE empatados</h2>');
    expect(r.html).toContain('VALV ESF 1/2');
    expect(r.html).toContain('Confirmar');
    expect(r.html).toContain('<h2>Conflictos</h2>');
    expect(r.html).toContain('Ninguno.');

    expect(r.html).toContain('<h2>Índice de información</h2>');
    const externos = [
      ...r.html.matchAll(/<a href="(https?:[^"]+)" target="_blank" rel="noopener noreferrer">/g),
    ].map((x) => x[1]);
    expect(externos.length).toBe(m.estado.catalogo.indice('SKU-001').length);
    expect(externos.length).toBeGreaterThan(0);
    expect(externos).toContain('https://tienda.example.com/wp-content/uploads/ficha-001.pdf');

    expect(r.html).toContain('src="../imagen/SKU-001"');
    expect(r.html).toContain('<a href="../productos">← Productos</a>');
    expect(r.html).toContain('action="../acciones/visibilidad"');
  });

  it('productos/SKU-003: sin foto muestra un hueco; un servicio no ofrece la web', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'productos/SKU-003');
    expect(r.status).toBe(200);
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('class="foto grande"');
    expect(r.html).toContain('Aprobar para la web');

    const servicio = await pagina(base, 'productos/SKU-002');
    expect(servicio.html).toContain('Un servicio no se ofrece en la web.');
    expect(servicio.html).not.toContain('Aprobar para la web');
  });

  it('productos/NO-EXISTE responde 404, también con un SKU mal codificado', async () => {
    const base = await levantar(await cargado());
    const r = await pagina(base, 'productos/NO-EXISTE');
    expect(r.status).toBe(404);
    expect(r.html).toContain('No existe');
    expect((await pagina(base, 'productos/%E0%A4%A')).status).toBe(404);
    expect((await pagina(base, 'productos/SKU-001/otra')).status).toBe(404);
  });

  it('historicos: puntaje, motivo y uso; el filtro sin_candidato deja sólo e6', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'historicos');
    expect(r.status).toBe(200);
    for (const codigo of ['VALV ESF 1/2', 'SKU-002', 'XX-9', 'ANT-003', 'ZZZ']) {
      expect(r.html).toContain(`<span class="id">${codigo}</span>`);
    }
    expect(r.html).toContain('sin candidato');
    expect(r.html).toMatch(/<dt>documentos<\/dt>\s*<dd>\s*<span class="cifra">12<\/span>/);
    expect(r.html).toMatch(/<span class="cifra">\d\.\d\d<\/span>/);
    const primero = m.estado.catalogo.empatesDeHistorico('e1')[0];
    expect(primero).toBeDefined();
    expect(r.html).toContain(`${primero?.motivo}:`);
    expect(r.html).toContain('alias de SKU-003');
    expect(r.html).toContain('Confirmar un empate lo anota en el registro');

    const sin = await pagina(base, 'historicos?estado=sin_candidato');
    expect(sin.html).toContain('<span class="id">ZZZ</span>');
    expect(sin.html).not.toContain('<span class="id">XX-9</span>');
    expect(sin.html).not.toContain('<span class="id">ANT-003</span>');
    expect(sin.html).toMatch(/<option value="sin_candidato"\s+selected>/);

    const propuestos = await pagina(base, 'historicos?estado=propuesto');
    expect(propuestos.html).not.toContain('<span class="id">ZZZ</span>');
    const confirmados = await pagina(base, 'historicos?estado=confirmado');
    expect(confirmados.html).toContain('No hay históricos con este filtro.');
  });

  it('conflictos: sin ninguno lo dice; con uno muestra los valores y los botones', async () => {
    const m = await cargado();
    const base = await levantar(m);
    expect((await pagina(base, 'conflictos')).html).toContain('No hay conflictos abiertos.');

    // Antes de la primera escritura la pasada de lectura no abre conflictos: se abre a mano.
    m.estado.catalogo.abrirConflicto(
      'SKU-001',
      'precio',
      { coreinbox: { valor: 6000, en: T2 }, woocommerce: { valor: 5500, en: T2 } },
      T2,
    );
    recalcularTodo(m.estado.catalogo);

    const r = await pagina(base, 'conflictos');
    expect(r.status).toBe(200);
    expect(r.html).toContain('<h1>Conflictos abiertos</h1>');
    expect(r.html).toContain('<a href="./productos/SKU-001">SKU-001</a>');
    expect(r.html).toContain('Precio bruto');
    expect(r.html).toContain('6.000');
    expect(r.html).toContain('5.500');
    expect(r.html).toMatch(/name="sel"\s+value="\d+"/);
    expect(r.html).toContain('Quedarse con el de Coreinbox');
    expect(r.html).toContain('Quedarse con el de la web');
    expect(r.html).toMatch(/<button type="submit" name="fuente" value="woocommerce">\s*la web/);

    const ficha = await pagina(base, 'productos/SKU-001');
    expect(ficha.html).toContain('en conflicto');
    expect((await pagina(base, 'productos?conflicto=1')).html).toContain('SKU-001');
  });

  it('visibilidad: sólo SKU-003 propuesto (SKU-006 ya está en la web), con foto en hueco', async () => {
    const base = await levantar(await cargado());
    const r = await pagina(base, 'visibilidad');
    expect(r.status).toBe(200);
    const tabla = r.html.slice(0, r.html.indexOf('Categorías fuera de la web'));
    expect(skusDeFilas(tabla)).toEqual(['SKU-003']);
    expect(r.html).toContain('Repuesto sello');
    expect(r.html).not.toContain('<img');
    expect(r.html).not.toContain('Llave de paso');
    expect(r.html).toContain(
      '<button type="submit" name="estado" value="aprobado">Aprobar</button>',
    );
    expect(r.html).toContain('name="uno"');
    expect(r.html).toContain('propuesto');
    expect(r.html).toContain('sin decisión');

    const web = await pagina(base, 'productos/SKU-006');
    expect(web.html).toContain('ya está en la web');
  });

  describe('categorías fuera de la web', () => {
    async function conCategoria() {
      const mundo = mundoInicial();
      const c3 = mundo.coreinbox[2];
      if (!c3) throw new Error('fixture');
      Object.assign(c3, { categoryId: 'cat-1' });
      return cargado(mundo);
    }

    it('ofrece las categorías leídas y la acción las saca de la web y las devuelve', async () => {
      const m = await conCategoria();
      const base = await levantar(m);
      expect(m.estado.catalogo.categoriasLeidas()).toContain('Válvulas');
      const antes = await pagina(base, 'visibilidad');
      expect(antes.html).toContain('<h2>Categorías fuera de la web</h2>');
      expect(antes.html).toMatch(/name="categoria"\s+value="Válvulas"/);
      expect(antes.html).toContain('action="./acciones/categorias"');
      expect(antes.html).toContain('<h2>Rechazados por su categoría</h2>');

      const r = await aplicar(
        base,
        'categorias',
        [
          ['categoria', 'Válvulas'],
          ['fuera', '1'],
        ],
        'visibilidad',
      );
      expect(r.location).toBe('../visibilidad?accion=categorias&aplicadas=1');
      expect(m.estado.catalogo.categoriasFuera()).toMatchObject([
        { categoria: 'Válvulas', usuario: USUARIO },
      ]);
      expect(eventosDe(m, 'categorias')).toMatchObject([{ mensaje: USUARIO }]);
      expect(m.peticiones).toEqual([]);

      // Sin decisión por SKU, la categoría pesa más que estar en la web (SKU-001).
      expect(m.estado.catalogo.producto('SKU-003')).toMatchObject({
        visibilidadWeb: 'rechazado',
        motivoVisibilidad: 'categoria',
      });
      expect(m.estado.catalogo.producto('SKU-001')?.motivoVisibilidad).toBe('categoria');
      const despues = await pagina(base, 'visibilidad');
      expect(despues.html).toMatch(/<td>Válvulas<\/td>/);
      expect(despues.html).toContain('Volver a la web');
      expect(despues.html).not.toMatch(/<input type="checkbox" name="categoria"/);
      const rechazados = despues.html.slice(despues.html.indexOf('Rechazados por su categoría'));
      expect(skusDeFilas(rechazados)).toEqual(['SKU-001', 'SKU-003']);

      // Aprobar el SKU por la pantalla usa la acción de visibilidad.
      const aprobado = await aplicar(
        base,
        'visibilidad',
        [['uno', JSON.stringify(['SKU-003', 'aprobado'])]],
        'visibilidad',
      );
      expect(aprobado.q.get('aplicadas')).toBe('1');
      expect(m.estado.catalogo.producto('SKU-003')?.visibilidadWeb).toBe('aprobado');
      const sin = await pagina(base, 'visibilidad');
      expect(skusDeFilas(sin.html.slice(sin.html.indexOf('Rechazados por su categoría')))).toEqual([
        'SKU-001',
      ]);

      const vuelve = await aplicar(
        base,
        'categorias',
        [
          ['categoria', 'Válvulas'],
          ['fuera', '0'],
        ],
        'visibilidad',
      );
      expect(vuelve.q.get('aplicadas')).toBe('1');
      expect(m.estado.catalogo.categoriasFuera()).toEqual([]);
    });

    it('sin categorías vuelve como error', async () => {
      const base = await levantar(await conCategoria());
      const r = await aplicar(base, 'categorias', [['fuera', '1']], 'visibilidad');
      expect(r.q.get('aplicadas')).toBe('0');
      expect(r.q.getAll('error')).toHaveLength(1);
    });
  });

  it('productos/SKU-003: lo que se escribirá y las escrituras recientes', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const p = m.estado.catalogo.producto('SKU-003');
    expect(p?.crearEn?.length).toBeGreaterThan(0);
    const vacia = await pagina(base, 'productos/SKU-001');
    expect(vacia.html).toContain('<h2>Escrituras recientes</h2>');

    m.estado.catalogo.registrarEvento({
      en: T2,
      estado: 'escrito',
      sku: 'SKU-003',
      sistema: 'woocommerce',
      campo: 'precio',
      antes: 1000,
      valor: 1200,
      mensaje: null,
      idExterno: null,
      clave: 'SKU-003|woocommerce|precio',
    });
    const r = await pagina(base, 'productos/SKU-003');
    expect(r.html).toContain('<h2>Lo que se escribirá</h2>');
    expect(r.html).toContain('Se crearía en:');
    expect(r.html).toContain('<h2>Escrituras recientes</h2>');
    expect(r.html).toContain('escrito');
    expect(r.html).toMatch(
      /\$ <span class=\"cifra\">1\.000<\/span> → \$ <span class=\"cifra\">1\.200<\/span>/,
    );
  });

  it('productos/SKU-001: muestra el modo de cada valor canónico', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const modos = Object.values(m.estado.catalogo.producto('SKU-001')?.canonico ?? {}).map(
      (c) => c.modo,
    );
    expect(modos).toContain('ultimo');
    const r = await pagina(base, 'productos/SKU-001');
    expect(r.html).toContain('último cambio');
    expect(r.html).toContain('propietario');
  });

  it('reglas: «último cambio» sólo se ofrece en los campos donde vale', async () => {
    const base = await levantar(await cargado());
    const r = await pagina(base, 'reglas');
    const filas = r.html.split('<tr>').filter((f) => f.includes('name="campo"'));
    expect(filas).toHaveLength(6);
    for (const f of filas) {
      const campo = /name="campo"\s+value="([^"]+)"/.exec(f)?.[1] ?? '';
      expect(f.includes('value="ultimo"')).toBe(['nombre', 'precio', 'activo'].includes(campo));
    }
    await enviar(base, 'reglas', [
      ['volver', 'reglas'],
      ['campo', 'precio'],
      ['fuente', 'ultimo'],
    ]);
    const despues = await pagina(base, 'reglas');
    expect(despues.html).toMatch(/<td>precio<\/td>\s*<td>\s*último cambio/);
    expect(despues.html).toMatch(/value="ultimo"\s+selected/);

    const lote = await pagina(base, 'productos');
    expect(lote.html).toContain('value="ultimo"');
  });

  it('reglas: una fila por campo y las reglas por SKU una vez fijadas', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await pagina(base, 'reglas');
    expect(r.status).toBe(200);
    for (const campo of ['nombre', 'precio', 'activo', 'tipo', 'categoria', 'exento']) {
      expect(r.html).toContain(`<td>${campo}</td>`);
    }
    expect(r.html).toContain('modo por defecto');
    expect(r.html).toContain('«último cambio»');
    expect(r.html).toContain('Ninguna.');
    expect((r.html.match(/action="\.\/acciones\/reglas"/g) ?? []).length).toBe(6);

    await enviar(base, 'reglas', [
      ['volver', 'reglas'],
      ['lote', '1'],
      ['sku', 'SKU-005'],
      ['campo', 'precio'],
      ['fuente', 'coreinbox'],
    ]);
    const despues = await pagina(base, 'reglas');
    expect(despues.html).toContain('<a href="./productos/SKU-005">SKU-005</a>');
    expect(despues.html).toContain(USUARIO);
  });

  it('escapa el HTML de los nombres del mundo', async () => {
    const mundo = mundoInicial();
    const c3 = mundo.coreinbox.find((p) => p.id === 'c3');
    if (!c3) throw new Error('fixture');
    c3.name = '<script>alert(1)</script>';
    const m = await cargado(mundo);
    const base = await levantar(m);
    for (const ruta of ['productos', 'productos/SKU-003', 'visibilidad']) {
      const r = await pagina(base, ruta);
      expect(r.html, ruta).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(r.html, ruta).not.toContain('<script');
    }
    const q = await pagina(base, `productos?q=${encodeURIComponent('"><script>')}`);
    expect(q.html).not.toContain('<script');
  });

  it('un método distinto de GET a una pantalla responde 405 con Allow', async () => {
    const base = await levantar(await cargado());
    const r = await fetch(`${base}/panel/productos`, { method: 'POST' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('acciones por formulario', () => {
  it('reglas: la de todo el catálogo y la de un lote de SKUs', async () => {
    const m = await cargado();
    const base = await levantar(m);

    const global = await aplicar(
      base,
      'reglas',
      [
        ['campo', 'nombre'],
        ['fuente', 'coreinbox'],
      ],
      'reglas',
    );
    expect(global.location).toBe('../reglas?accion=reglas&aplicadas=1');
    expect(m.estado.catalogo.reglas()).toContainEqual(
      expect.objectContaining({
        ambito: '*',
        campo: 'nombre',
        fuente: 'coreinbox',
        usuario: USUARIO,
      }),
    );

    const lote = await aplicar(
      base,
      'reglas',
      [
        ['lote', '1'],
        ['sku', 'SKU-005'],
        ['sku', 'SKU-001'],
        ['campo', 'precio'],
        ['fuente', 'coreinbox'],
      ],
      'productos?q=Bomba',
    );
    expect(lote.location).toBe('../productos?q=Bomba&accion=reglas&aplicadas=2');
    for (const sku of ['SKU-005', 'SKU-001']) {
      expect(m.estado.catalogo.reglas()).toContainEqual(
        expect.objectContaining({ ambito: sku, campo: 'precio', fuente: 'coreinbox' }),
      );
    }
    expect(m.estado.catalogo.producto('SKU-005')?.canonico.precio?.fuente).toBe('coreinbox');

    // Una fuente vacía quita la regla global.
    await aplicar(
      base,
      'reglas',
      [
        ['campo', 'nombre'],
        ['fuente', ''],
      ],
      'reglas',
    );
    expect(
      m.estado.catalogo.reglas().filter((r) => r.ambito === '*' && r.campo === 'nombre'),
    ).toEqual([]);

    const eventos = eventosDe(m, 'reglas');
    expect(eventos).toHaveLength(3);
    expect(eventos.every((e) => e.mensaje === USUARIO && e.flujo === 'productos')).toBe(true);
    expect(m.peticiones).toEqual([]);
  });

  it('empates: una decisión y un lote cambian el registro y quedan en la bitácora', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const propuestos = m.estado.catalogo
      .historicos()
      .flatMap((h) => m.estado.catalogo.empatesDeHistorico(h.emiteId))
      .filter((e) => e.estado === 'propuesto');
    expect(propuestos.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = propuestos;
    if (!a || !b || !c) throw new Error('fixture');

    const uno = await aplicar(
      base,
      'empates',
      [['uno', JSON.stringify([a.emiteId, a.sku, 'confirmado'])]],
      'historicos?estado=propuesto',
    );
    expect(uno.q.get('accion')).toBe('empates');
    expect(uno.q.get('aplicadas')).toBe('1');
    expect(uno.q.get('estado')).toBe('propuesto');
    expect(
      m.estado.catalogo.empatesDeHistorico(a.emiteId).find((e) => e.sku === a.sku),
    ).toMatchObject({ estado: 'confirmado', decididoPor: USUARIO });

    const lote = await aplicar(
      base,
      'empates',
      [
        ['sel', JSON.stringify([b.emiteId, b.sku])],
        ['sel', JSON.stringify([c.emiteId, c.sku])],
        ['estado', 'rechazado'],
      ],
      'historicos',
    );
    expect(lote.location).toBe('../historicos?accion=empates&aplicadas=2');
    for (const e of [b, c]) {
      expect(
        m.estado.catalogo.empatesDeHistorico(e.emiteId).find((x) => x.sku === e.sku),
      ).toMatchObject({ estado: 'rechazado', decididoPor: USUARIO });
    }

    const eventos = eventosDe(m, 'empates');
    expect(eventos).toHaveLength(2);
    expect(eventos.every((e) => e.mensaje === USUARIO)).toBe(true);
    expect(m.peticiones).toEqual([]);
  });

  describe('conflictos', () => {
    async function conConflictos() {
      const m = await cargado();
      m.estado.catalogo.abrirConflicto(
        'SKU-001',
        'precio',
        { coreinbox: { valor: 6000, en: T2 }, woocommerce: { valor: 5500, en: T2 } },
        T2,
      );
      m.estado.catalogo.abrirConflicto(
        'SKU-005',
        'nombre',
        { coreinbox: { valor: 'Bomba CI', en: T2 }, woocommerce: { valor: 'Bomba web', en: T2 } },
        T2,
      );
      recalcularTodo(m.estado.catalogo);
      const abiertos = m.estado.catalogo.conflictosAbiertos();
      expect(abiertos.length).toBeGreaterThanOrEqual(2);
      return { m, abiertos };
    }

    it('uno: resuelve con el sistema elegido', async () => {
      const { m, abiertos } = await conConflictos();
      const base = await levantar(m);
      const [a] = abiertos;
      if (!a) throw new Error('fixture');
      const r = await aplicar(
        base,
        'conflictos',
        [['uno', JSON.stringify([a.id, 'coreinbox'])]],
        'conflictos',
      );
      expect(r.location).toBe('../conflictos?accion=conflictos&aplicadas=1');
      expect(m.estado.catalogo.conflicto(a.id)).toMatchObject({
        estado: 'resuelto',
        resueltoCon: 'coreinbox',
        resueltoPor: USUARIO,
      });
      expect(m.estado.catalogo.conflictosAbiertos()).toHaveLength(abiertos.length - 1);
      expect(eventosDe(m, 'conflictos')).toMatchObject([{ mensaje: USUARIO }]);
      expect(m.peticiones).toEqual([]);
    });

    it('lote: resuelve todos los elegidos con la misma fuente', async () => {
      const { m, abiertos } = await conConflictos();
      const base = await levantar(m);
      const r = await aplicar(
        base,
        'conflictos',
        [
          ...abiertos.map((c): [string, string] => ['sel', String(c.id)]),
          ['fuente', 'woocommerce'],
        ],
        'conflictos',
      );
      expect(r.q.get('aplicadas')).toBe(String(abiertos.length));
      expect(r.q.getAll('error')).toEqual([]);
      for (const c of abiertos) {
        expect(m.estado.catalogo.conflicto(c.id)).toMatchObject({
          estado: 'resuelto',
          resueltoCon: 'woocommerce',
          resueltoPor: USUARIO,
        });
      }
      expect(m.estado.catalogo.conflictosAbiertos()).toEqual([]);
      expect(eventosDe(m, 'conflictos')).toMatchObject([{ mensaje: USUARIO }]);
      expect((await pagina(base, 'conflictos')).html).toContain('No hay conflictos abiertos.');
      expect(m.peticiones).toEqual([]);
    });

    it('un conflicto ya resuelto vuelve como error y no frena a los demás', async () => {
      const { m, abiertos } = await conConflictos();
      const base = await levantar(m);
      const [a, b] = abiertos;
      if (!a || !b) throw new Error('fixture');
      await aplicar(base, 'conflictos', [['uno', JSON.stringify([a.id, 'emite'])]], 'conflictos');
      const r = await aplicar(
        base,
        'conflictos',
        [
          ['sel', String(a.id)],
          ['sel', String(b.id)],
          ['fuente', 'coreinbox'],
        ],
        'conflictos',
      );
      expect(r.q.get('aplicadas')).toBe('1');
      expect(r.q.getAll('error')).toEqual([`no hay un conflicto abierto con id ${a.id}`]);
    });
  });

  it('visibilidad: una decisión y un lote', async () => {
    const m = await cargado();
    const base = await levantar(m);

    const uno = await aplicar(
      base,
      'visibilidad',
      [['uno', JSON.stringify(['SKU-003', 'aprobado'])]],
      'productos/SKU-003',
    );
    expect(uno.location).toBe('../productos/SKU-003?accion=visibilidad&aplicadas=1');
    expect(m.estado.catalogo.producto('SKU-003')?.visibilidadWeb).toBe('aprobado');

    const lote = await aplicar(
      base,
      'visibilidad',
      [
        ['sku', 'SKU-006'],
        ['sku', 'SKU-003'],
        ['estado', 'rechazado'],
      ],
      'visibilidad',
    );
    expect(lote.location).toBe('../visibilidad?accion=visibilidad&aplicadas=2');
    expect(m.estado.catalogo.producto('SKU-006')?.visibilidadWeb).toBe('rechazado');
    expect(m.estado.catalogo.producto('SKU-003')?.visibilidadWeb).toBe('rechazado');

    const eventos = eventosDe(m, 'visibilidad');
    expect(eventos).toHaveLength(2);
    expect(eventos.every((e) => e.mensaje === USUARIO)).toBe(true);
    expect(m.peticiones).toEqual([]);

    const ficha = await pagina(base, 'productos/SKU-003');
    expect(ficha.html).toMatch(/rechazado por\s+admin@example\.com/);
  });

  it('un servicio vuelve con error en la consulta y la pantalla lo muestra escapado', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const sku = 'SKU-002';
    const r = await aplicar(
      base,
      'visibilidad',
      [['uno', JSON.stringify([sku, 'aprobado'])]],
      'visibilidad',
    );
    expect(r.q.get('aplicadas')).toBe('0');
    expect(r.q.getAll('error')).toEqual(['SKU-002 es un servicio: nunca va a la web']);
    expect(m.estado.catalogo.producto(sku)?.visibilidadWeb).toBe('no_aplica');

    const parcial = await aplicar(
      base,
      'visibilidad',
      [
        ['sku', 'SKU-003'],
        ['sku', sku],
        ['estado', 'aprobado'],
      ],
      'visibilidad',
    );
    expect(parcial.q.get('aplicadas')).toBe('1');
    expect(parcial.q.getAll('error')).toHaveLength(1);

    const pantalla = await pagina(base, `visibilidad?${parcial.location.split('?')[1]}`);
    expect(pantalla.status).toBe(200);
    expect(pantalla.html).toContain('role="status"');
    expect(pantalla.html).toContain('<strong>visibilidad</strong>');
    expect(pantalla.html).toContain('SKU-002 es un servicio: nunca va a la web');
    expect(pantalla.html).toContain('aplicada');
    expect(pantalla.html).toContain('la siguiente pasada de escritura lo lleva a los sistemas');

    const hostil = new URLSearchParams([
      ['accion', 'visibilidad'],
      ['aplicadas', '0'],
      ['error', '<script>alert(1)</script>'],
    ]);
    const escapado = await pagina(base, `reglas?${hostil.toString()}`);
    expect(escapado.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapado.html).not.toContain('<script');
    expect(m.peticiones).toEqual([]);
  });

  it('un cuerpo inválido entero vuelve como error y no anota la acción', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const sinSkus = await aplicar(base, 'visibilidad', [['estado', 'aprobado']], 'visibilidad');
    expect(sinSkus.q.get('aplicadas')).toBe('0');
    expect(sinSkus.q.getAll('error')).toHaveLength(1);
    const ilegible = await aplicar(base, 'empates', [['uno', 'no es json']], 'historicos');
    expect(ilegible.q.getAll('error')).toEqual(['el formulario trae una decisión ilegible']);
    const campo = await aplicar(
      base,
      'reglas',
      [
        ['campo', 'sku'],
        ['fuente', 'emite'],
      ],
      'reglas',
    );
    expect(campo.q.get('aplicadas')).toBe('0');
    expect(m.estado.catalogo.acciones()).toEqual([]);
  });

  it('sin x-emite-usuario la acción queda sin usuario', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await fetch(`${base}/panel/acciones/reglas`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': FORM },
      body: new URLSearchParams({ campo: 'tipo', fuente: 'emite' }).toString(),
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('../flujos?accion=reglas&aplicadas=1');
    expect(m.estado.catalogo.acciones()).toMatchObject([{ accion: 'reglas', usuario: null }]);
  });

  it('acepta un content-type con charset', async () => {
    const m = await cargado();
    const base = await levantar(m);
    const r = await enviar(
      base,
      'reglas',
      [
        ['campo', 'tipo'],
        ['fuente', 'emite'],
      ],
      {
        'content-type': `${FORM}; charset=UTF-8`,
      },
    );
    expect(r.status).toBe(303);
  });
});

describe('protección de los POST', () => {
  const campos: Array<[string, string]> = [
    ['campo', 'tipo'],
    ['fuente', 'emite'],
    ['volver', 'reglas'],
  ];

  async function prueba() {
    const m = await cargado();
    const base = await levantar(m);
    return { m, base, host: new URL(base).host };
  }

  it('rechaza con 403 un envío de otro sitio y no cambia nada', async () => {
    const { m, base } = await prueba();
    const cruzado = await enviar(base, 'reglas', campos, { 'sec-fetch-site': 'cross-site' });
    expect(cruzado.status).toBe(403);
    expect(cruzado.headers.get('location')).toBeNull();
    const mismoSitio = await enviar(base, 'reglas', campos, { 'sec-fetch-site': 'same-site' });
    expect(mismoSitio.status).toBe(403);
    const origen = await enviar(base, 'reglas', campos, { origin: 'http://otro.example.com' });
    expect(origen.status).toBe(403);
    expect(await origen.text()).toBe('envío desde otro sitio');
    expect(m.estado.catalogo.acciones()).toEqual([]);
    expect(m.estado.catalogo.reglas()).toEqual([]);
  });

  it('deja pasar same-origin, none y un Origin igual al host del servidor', async () => {
    const { m, base, host } = await prueba();
    for (const cabeceras of [
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { origin: `http://${host}` },
      { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
      {},
    ]) {
      const r = await enviar(base, 'reglas', campos, cabeceras);
      expect(r.status, JSON.stringify(cabeceras)).toBe(303);
    }
    expect(m.estado.catalogo.acciones()).toHaveLength(5);
  });

  it('415 sin content-type de formulario', async () => {
    const { m, base } = await prueba();
    const json = await fetch(`${base}/panel/acciones/reglas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ campo: 'tipo', fuente: 'emite' }),
    });
    expect(json.status).toBe(415);
    const sin = await fetch(`${base}/panel/acciones/reglas`, {
      method: 'POST',
      headers: { 'content-type': '' },
      body: 'campo=tipo&fuente=emite',
    });
    expect(sin.status).toBe(415);
    const texto = await fetch(`${base}/panel/acciones/reglas`, {
      method: 'POST',
      body: 'campo=tipo&fuente=emite',
    });
    expect(texto.status).toBe(415);
    expect(m.estado.catalogo.acciones()).toEqual([]);
  });

  it('413 si el cuerpo pasa del máximo', async () => {
    const { m, base } = await prueba();
    const r = await fetch(`${base}/panel/acciones/reglas`, {
      method: 'POST',
      headers: { 'content-type': FORM },
      body: `campo=tipo&relleno=${'x'.repeat(300 * 1024)}`,
    }).catch(() => null);
    // Puede cortarse la conexión antes de leer la respuesta; si llega, es 413.
    if (r) expect(r.status).toBe(413);
    expect(m.estado.catalogo.acciones()).toEqual([]);
  });

  it('404 para una acción desconocida y 405 con GET a una acción', async () => {
    const { base } = await prueba();
    const desconocida = await enviar(base, 'desconocida', campos);
    expect(desconocida.status).toBe(404);
    const get = await fetch(`${base}/panel/acciones/reglas`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const raiz = await fetch(`${base}/panel/acciones`, { method: 'POST', redirect: 'manual' });
    expect(raiz.status).toBe(405);
  });

  it.each([
    '//evil.example.com',
    'https://evil.example.com',
    '../x',
    'productos/../../x',
    '/productos',
    'productos/a/b',
    'javascript:alert(1)',
  ])('un volver malicioso (%s) termina en ../flujos', async (volver) => {
    const { m, base } = await prueba();
    const r = await enviar(base, 'reglas', [
      ['campo', 'tipo'],
      ['fuente', 'emite'],
      ['volver', volver],
    ]);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('../flujos?accion=reglas&aplicadas=1');
    expect(m.estado.catalogo.acciones()).toHaveLength(1);
  });

  it('la redirección se resuelve a una pantalla del panel que responde 200', async () => {
    const { base } = await prueba();
    const url = `${base}/panel/acciones/reglas`;
    const r = await enviar(base, 'reglas', campos);
    const destino = new URL(r.headers.get('location') ?? '', url);
    expect(destino.origin).toBe(new URL(base).origin);
    expect(destino.pathname).toBe('/panel/reglas');
    const pantalla = await fetch(destino);
    expect(pantalla.status).toBe(200);
    expect(await pantalla.text()).toContain('<strong>reglas</strong>');
  });
});
