import { describe, expect, it } from 'vitest';
import type { CategoriaCoreinbox, ProductoCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { ErrorMapeo } from '../comun.js';
import { armarProducto, unidadEmite } from './mapeo.js';

const EMISOR = '11111111-1111-1111-1111-111111111111';

function producto(extra: Partial<ProductoCoreinbox> = {}): ProductoCoreinbox {
  return {
    id: 'p-1',
    sku: 'SRV-INST-01',
    name: 'Servicio de instalación',
    description: 'Instalación en terreno',
    type: 'service',
    unit: 'hora',
    unitPrice: '45000.0000',
    currencyCode: 'CLP',
    isTaxable: true,
    taxRate: '0.1900',
    categoryId: 'cat-1',
    isActive: true,
    updatedAt: '2026-10-28T15:00:00.000Z',
    ...extra,
  };
}

const categorias = new Map<string, CategoriaCoreinbox>([
  ['cat-1', { id: 'cat-1', name: 'Servicios técnicos', parentId: null }],
]);

describe('armarProducto', () => {
  it('traduce SKU, nombre, descripción, tipo, unidad, precio neto y categoría', () => {
    const { datos, avisos } = armarProducto(producto(), categorias, EMISOR);
    expect(datos).toEqual({
      emisorId: EMISOR,
      codigo: 'SRV-INST-01',
      nombre: 'Servicio de instalación',
      descripcion: 'Instalación en terreno',
      tipo: 'servicio',
      unidad: 'HRS',
      precioNeto: 45000,
      exento: false,
      categoria: 'Servicios técnicos',
    });
    expect(avisos).toEqual([]);
  });

  it('un bien sin unidad ni categoría ni descripción va sin esos campos', () => {
    const { datos } = armarProducto(
      producto({ type: 'product', unit: null, categoryId: null, description: null }),
      categorias,
      EMISOR,
    );
    expect(datos.tipo).toBe('bien');
    expect(datos).not.toHaveProperty('unidad');
    expect(datos).not.toHaveProperty('categoria');
    expect(datos).not.toHaveProperty('descripcion');
  });

  it('exento si no lleva impuesto o su tasa es 0', () => {
    expect(armarProducto(producto({ taxRate: '0' }), categorias, EMISOR).datos.exento).toBe(true);
    expect(armarProducto(producto({ taxRate: 0 }), categorias, EMISOR).datos.exento).toBe(true);
    expect(
      armarProducto(producto({ isTaxable: false, taxRate: null }), categorias, EMISOR).datos.exento,
    ).toBe(true);
    expect(armarProducto(producto({ taxRate: null }), categorias, EMISOR).datos.exento).toBe(false);
  });

  it('redondea el precio a dos decimales', () => {
    expect(
      armarProducto(producto({ unitPrice: '4201.6789' }), categorias, EMISOR).datos.precioNeto,
    ).toBe(4201.68);
  });

  it('acorta el nombre a 80 y la categoría a 60 con aviso', () => {
    const largo = 'x'.repeat(90);
    const { datos, avisos } = armarProducto(
      producto({ name: largo, categoryId: 'cat-2' }),
      new Map([...categorias, ['cat-2', { id: 'cat-2', name: 'y'.repeat(70), parentId: null }]]),
      EMISOR,
    );
    expect(datos.nombre).toHaveLength(80);
    expect(datos.categoria).toHaveLength(60);
    expect(avisos).toEqual(['El nombre se acortó a 80 caracteres']);
  });

  it('una categoría que ya no existe deja el producto sin categoría y avisa', () => {
    const { datos, avisos } = armarProducto(producto({ categoryId: 'nada' }), categorias, EMISOR);
    expect(datos).not.toHaveProperty('categoria');
    expect(avisos[0]).toContain('categoría');
  });

  it('sin SKU, con SKU demasiado largo, en otra moneda o con precio inválido no viaja', () => {
    const codigo = (p: ProductoCoreinbox) => {
      try {
        armarProducto(p, categorias, EMISOR);
        return null;
      } catch (e) {
        return e instanceof ErrorMapeo ? e.code : String(e);
      }
    };
    expect(codigo(producto({ sku: null }))).toBe('SIN_SKU');
    expect(codigo(producto({ sku: '   ' }))).toBe('SIN_SKU');
    expect(codigo(producto({ sku: 'A'.repeat(36) }))).toBe('SKU_LARGO');
    expect(codigo(producto({ currencyCode: 'USD' }))).toBe('MONEDA');
    expect(codigo(producto({ unitPrice: 'abc' }))).toBe('PRECIO');
    expect(codigo(producto({ unitPrice: '-1' }))).toBe('PRECIO');
  });
});

describe('unidadEmite', () => {
  it('traduce las unidades conocidas y recorta las demás a 4 caracteres', () => {
    expect(unidadEmite('hora')).toBe('HRS');
    expect(unidadEmite('Horas')).toBe('HRS');
    expect(unidadEmite('unidad')).toBe('UN');
    expect(unidadEmite('c/u')).toBe('UN');
    expect(unidadEmite('kg')).toBe('KG');
    expect(unidadEmite('metro cuadrado')).toBe('M2');
    expect(unidadEmite('día')).toBe('DIA');
    expect(unidadEmite('mes')).toBe('MES');
    expect(unidadEmite('Paquete')).toBe('PAQU');
    expect(unidadEmite('')).toBeUndefined();
    expect(unidadEmite(null)).toBeUndefined();
  });
});
