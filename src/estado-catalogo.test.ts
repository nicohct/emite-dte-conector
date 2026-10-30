import { describe, expect, it } from 'vitest';
import type { CampoCatalogo, EntradaIndice, Lectura } from './estado-catalogo.js';
import { Estado } from './estado.js';

const T = '2026-10-30T10:00:00.000Z';

function lectura(sku: string, sistema: Lectura['sistema'], idExterno: string): Lectura {
  const campos = {
    nombre: `Producto ${sku}`,
    precio: 1000,
    activo: true,
    tipo: 'bien',
    categoria: null,
    exento: false,
  } satisfies Record<CampoCatalogo, string | number | boolean | null>;
  return { sku, sistema, idExterno, modificadoEn: T, campos, extra: {} };
}

function entrada(
  sistema: EntradaIndice['sistema'],
  tipo: string,
  url: string,
  hash: string,
): EntradaIndice {
  return { sistema, tipo, url, hash, leidoEn: T };
}

describe('fotos(sku)', () => {
  it('devuelve las imágenes en el orden de guardado dentro de cada sistema', () => {
    const estado = new Estado(':memory:');
    estado.catalogo.guardarLectura(
      lectura('SKU-001', 'woocommerce', '11'),
      [
        entrada('woocommerce', 'imagen', 'https://tienda.example.com/z.jpg', 'h-z'),
        entrada('woocommerce', 'pagina', 'https://tienda.example.com/producto/p/', 'h-p'),
        entrada('woocommerce', 'imagen', 'https://tienda.example.com/a.jpg', 'h-a'),
        entrada('woocommerce', 'imagen', 'https://tienda.example.com/m.jpg', 'h-m'),
      ],
      T,
    );
    estado.catalogo.guardarLectura(
      lectura('SKU-001', 'coreinbox', 'c1'),
      [entrada('coreinbox', 'imagen', 'https://ci.example.com/api/v1/products/c1/image', 'h-c')],
      T,
    );

    const fotos = estado.catalogo.fotos('SKU-001');

    expect(fotos.map((f) => `${f.sistema}:${f.url.split('/').at(-1)}`)).toEqual([
      'coreinbox:image',
      'woocommerce:z.jpg',
      'woocommerce:a.jpg',
      'woocommerce:m.jpg',
    ]);
    expect(fotos.every((f) => f.tipo === 'imagen')).toBe(true);
    expect(fotos.find((f) => f.url.endsWith('z.jpg'))).toMatchObject({ hash: 'h-z', leidoEn: T });
    estado.cerrar();
  });

  it('un SKU sin imágenes, o desconocido, devuelve una lista vacía', () => {
    const estado = new Estado(':memory:');
    estado.catalogo.guardarLectura(lectura('SKU-002', 'coreinbox', 'c2'), [], T);
    expect(estado.catalogo.fotos('SKU-002')).toEqual([]);
    expect(estado.catalogo.fotos('SKU-NO')).toEqual([]);
    estado.cerrar();
  });

  it('no mezcla las fotos de otro SKU', () => {
    const estado = new Estado(':memory:');
    estado.catalogo.guardarLectura(
      lectura('SKU-001', 'woocommerce', '11'),
      [entrada('woocommerce', 'imagen', 'https://tienda.example.com/uno.jpg', 'h1')],
      T,
    );
    estado.catalogo.guardarLectura(
      lectura('SKU-002', 'woocommerce', '12'),
      [entrada('woocommerce', 'imagen', 'https://tienda.example.com/dos.jpg', 'h2')],
      T,
    );
    expect(estado.catalogo.fotos('SKU-002').map((f) => f.hash)).toEqual(['h2']);
    estado.cerrar();
  });
});

describe('conflictosAbiertos()', () => {
  it('devuelve sólo los abiertos de todo el catálogo, ordenados por sku y campo', () => {
    const estado = new Estado(':memory:');
    const r = estado.catalogo;
    const valores = {
      coreinbox: { valor: 1000, en: T },
      woocommerce: { valor: 2000, en: T },
    };
    r.abrirConflicto('SKU-003', 'precio', valores, T);
    r.abrirConflicto('SKU-001', 'precio', valores, T);
    r.abrirConflicto('SKU-001', 'nombre', valores, T);
    r.abrirConflicto('SKU-002', 'activo', valores, T);
    r.abrirConflicto('SKU-002', 'nombre', valores, T);

    const resuelto = r.conflictos('SKU-002').find((c) => c.campo === 'activo')!;
    r.resolverConflicto(resuelto.id, 'coreinbox', 'ana', T);

    const abiertos = r.conflictosAbiertos();

    expect(abiertos.map((c) => `${c.sku}/${c.campo}`)).toEqual([
      'SKU-001/nombre',
      'SKU-001/precio',
      'SKU-002/nombre',
      'SKU-003/precio',
    ]);
    expect(abiertos.every((c) => c.estado === 'abierto')).toBe(true);
    estado.cerrar();
  });

  it('un conflicto abierto de nuevo en el mismo campo no se duplica, y sin ninguno devuelve vacío', () => {
    const estado = new Estado(':memory:');
    expect(estado.catalogo.conflictosAbiertos()).toEqual([]);
    const valores = { coreinbox: { valor: 1, en: T } };
    estado.catalogo.abrirConflicto('SKU-001', 'precio', valores, T);
    estado.catalogo.abrirConflicto('SKU-001', 'precio', valores, T);
    expect(estado.catalogo.conflictosAbiertos()).toHaveLength(1);
    estado.cerrar();
  });
});
