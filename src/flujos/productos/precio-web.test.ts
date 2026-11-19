import { describe, expect, it } from 'vitest';
import { Estado } from '../../estado.js';
import { VERSION_REGISTRO } from '../../estado-catalogo.js';
import { AHORA, TIENDA, armar, mundoInicial, tic, woo, type Mundo } from '../../prueba/catalogo.js';
import { WooCommerce } from '../../adaptadores/woocommerce/cliente.js';
import { aplicarAccion } from './acciones.js';
import { desdeWoo, precioWoo, recalcularTodo } from './lectura.js';

const tienda = new WooCommerce({ url: TIENDA, consumerKey: 'ck', consumerSecret: 'cs' });

const enWeb = (m: Mundo, id: number) => {
  const p = m.woo.find((w) => w.id === id);
  if (!p) throw new Error(`no está el producto ${id} en la web`);
  return p;
};

/** Cambia un producto de la web «a mano», con su hora de modificación. */
function aManoWeb(m: Mundo, id: number, cambios: Partial<ReturnType<typeof enWeb>>): void {
  const p = enWeb(m, id);
  Object.assign(p, cambios);
  p.date_modified_gmt = p.date_modified = tic(m).slice(0, 19);
}

function aManoCoreinbox(m: Mundo, id: string, cambios: Record<string, unknown>): void {
  const p = m.coreinbox.find((c) => c.id === id);
  if (!p) throw new Error(`no está ${id} en Coreinbox`);
  Object.assign(p, cambios);
  p.updatedAt = tic(m);
}

/** El mundo de siempre con la válvula (SKU-001) «a cotizar» en la web. */
function aCotizar(precio: string): Mundo {
  const m = mundoInicial();
  enWeb(m, 11).regular_price = precio;
  return m;
}

const escriturasDe = (
  escrituras: Array<{ sistema: string; metodo: string; ruta: string; cuerpo?: unknown }>,
  sistema: string,
  ruta: string,
) => escrituras.filter((e) => e.sistema === sistema && e.ruta.endsWith(ruta));

describe('lectura del precio de la web', () => {
  it('vacío, 0 o 0.00 es «sin precio»; un valor es el bruto entero', () => {
    const p = (regular_price: string) => precioWoo(woo(1, { regular_price }));
    expect(p('')).toBeNull();
    expect(p('  ')).toBeNull();
    expect(p('0')).toBeNull();
    expect(p('0.00')).toBeNull();
    expect(p('0.4')).toBeNull();
    expect(p('5990')).toBe(5990);
    expect(p('5990.6')).toBe(5991);
  });

  it('la lectura de un producto «a cotizar» queda con precio null', () => {
    const { lectura } = desdeWoo(
      tienda,
      woo(1, { regular_price: '0' }),
      'SKU-1',
      null,
      AHORA.toISOString(),
    );
    expect(lectura.campos.precio).toBeNull();
  });
});

describe('la web sin precio en las pasadas', () => {
  for (const precio of ['', '0']) {
    it(`con la web en «${precio}» la primera escritura no toca el precio en ningún lado`, async () => {
      const m = armar(aCotizar(precio));
      m.d.escribir = true;
      await m.pasada();
      const p = m.estado.catalogo.producto('SKU-001');
      // 4.201,68 neto en Coreinbox = 5.000 bruto.
      expect(p?.canonico.precio).toMatchObject({ valor: 5000, fuente: 'coreinbox' });
      expect(p?.diferencias.map((d) => d.campo)).not.toContain('precio');
      expect(p?.escrituras?.some((w) => w.campo === 'precio')).toBe(false);
      expect(enWeb(m.mundo, 11).regular_price).toBe(precio);
      expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.unitPrice).toBe('4201.68');
      expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(4201.68);
      expect(m.estado.catalogo.lecturas('SKU-001').woocommerce?.campos.precio?.valor).toBeNull();
    });
  }

  it('pasar la web de un valor a vacío no se propaga ni abre conflicto', async () => {
    const m = armar();
    m.d.escribir = true;
    await m.pasada();
    aManoWeb(m.mundo, 11, { regular_price: '' });
    const marca = m.escrituras.length;
    const r = await m.pasada();
    expect(r).toMatchObject({ conflictosNuevos: 0, escritos: 0, revertidos: 0 });
    expect(m.escrituras.slice(marca)).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.precio).toMatchObject({ valor: 5000 });
    expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.unitPrice).toBe('4201.68');
  });

  it('a la misma vez la web a 0 y Coreinbox a otro precio: no hay conflicto y no llega a la web', async () => {
    const m = armar();
    m.d.escribir = true;
    await m.pasada();
    aManoWeb(m.mundo, 11, { regular_price: '0' });
    aManoCoreinbox(m.mundo, 'c1', { unitPrice: '4621.85' });
    const marca = m.escrituras.length;
    const r = await m.pasada();
    expect(r.conflictosNuevos).toBe(0);
    expect(m.estado.catalogo.conflictos('SKU-001', true)).toEqual([]);
    expect(m.estado.catalogo.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 5500,
      fuente: 'coreinbox',
    });
    // 5.500 bruto llega a Emite DTE; la web sigue sin precio.
    expect(m.mundo.emite.find((e) => e.id === 'e5')?.precioNeto).toBe(4621.85);
    expect(escriturasDe(m.escrituras.slice(marca), 'woocommerce', '/products/11')).toEqual([]);
    expect(enWeb(m.mundo, 11).regular_price).toBe('0');
  });

  it('una edición de precio del panel sí llega a la web, y desde ahí rige lo normal', async () => {
    const m = armar(aCotizar(''));
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
    expect(enWeb(m.mundo, 11).regular_price).toBe('6490');
    // La pasada siguiente lee el eco y cierra la edición.
    await m.pasada();
    expect(m.estado.catalogo.pendientes('SKU-001')).toEqual([]);
    // Con precio en la web otra vez, un cambio allá llega a los demás.
    aManoWeb(m.mundo, 11, { regular_price: '7000' });
    await m.pasada();
    expect(m.mundo.coreinbox.find((c) => c.id === 'c1')?.unitPrice).toBe('5882.35');
  });

  it('crear en Coreinbox desde la web: sin precio no se crea y queda el aviso', async () => {
    const mundo = mundoInicial();
    mundo.woo.push(woo(20, { sku: 'SKU-200', name: 'Taza térmica', regular_price: '0' }));
    const m = armar(mundo, new Estado(':memory:'));
    m.estado.catalogo.fijarCrearEnCoreinboxDesdeWeb(true);
    m.d.escribir = true;
    await m.pasada();
    expect(m.mundo.coreinbox.some((c) => c.sku === 'SKU-200')).toBe(false);
    // Tampoco en Emite DTE: no hay ningún precio, como antes.
    expect(m.mundo.emite.some((e) => e.codigo === 'SKU-200')).toBe(false);
    expect(m.estado.catalogo.producto('SKU-200')?.avisos).toEqual([
      'Falta en Coreinbox y la web no tiene precio: crearlo en Coreinbox o desde el panel',
      'Falta en Emite DTE pero no tiene nombre y precio para crearlo',
    ]);
  });
});

describe('poner al día un registro de antes (migrar)', () => {
  /** Simula lo que dejaba la versión anterior: el 0 de la web guardado como precio. */
  async function registroViejo() {
    const m = armar();
    await m.pasada();
    const r = m.estado.catalogo;
    const db = (r as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    db.exec(
      `UPDATE catalogo_campos SET valor = '0' WHERE sistema = 'woocommerce' AND campo = 'precio' AND sku = 'SKU-001'`,
    );
    r.guardarSinSku({
      sistema: 'woocommerce',
      idExterno: '99',
      nombre: 'A cotizar sin SKU',
      precio: 0,
      activo: true,
      modificadoEn: null,
      leidoEn: AHORA.toISOString(),
    });
    r.abrirConflicto(
      'SKU-001',
      'precio',
      { woocommerce: { valor: 0, en: null }, coreinbox: { valor: 5000, en: null } },
      AHORA.toISOString(),
    );
    r.abrirConflicto(
      'SKU-005',
      'precio',
      {
        woocommerce: { valor: 0, en: null },
        coreinbox: { valor: 100000, en: null },
        emite: { valor: 90000, en: null },
      },
      AHORA.toISOString(),
    );
    db.exec(`DELETE FROM claves WHERE clave = 'catalogo_version'`);
    recalcularTodo(r);
    return m;
  }

  it('el 0 guardado de la web pasa a «sin precio» y sus conflictos se limpian; una sola vez', async () => {
    const m = await registroViejo();
    const r = m.estado.catalogo;
    expect(r.lecturas('SKU-001').woocommerce?.campos.precio?.valor).toBe(0);

    expect(r.migrar()).toBe(true);
    recalcularTodo(r);
    expect(r.lecturas('SKU-001').woocommerce?.campos.precio?.valor).toBeNull();
    expect(r.sinSku().find((s) => s.idExterno === '99')?.precio).toBeNull();
    expect(r.conflictos('SKU-001', true)).toEqual([]);
    expect(r.conflictos('SKU-005', true)[0]?.valores).toEqual({
      coreinbox: { valor: 100000, en: null },
      emite: { valor: 90000, en: null },
    });
    expect(r.producto('SKU-001')?.canonico.precio).toMatchObject({
      valor: 5000,
      fuente: 'coreinbox',
    });
    expect(r.migrar()).toBe(false);
  });

  it('un registro nuevo queda en la versión actual', () => {
    const r = new Estado(':memory:').catalogo;
    expect(r.migrar()).toBe(true);
    expect(r.migrar()).toBe(false);
    expect(VERSION_REGISTRO).toBe(3);
  });
});
