import { describe, expect, it } from 'vitest';
import type {
  CampoCatalogo,
  Conflicto,
  DecisionVisibilidad,
  LecturaGuardada,
  Regla,
  SistemaCatalogo,
  ValorCampo,
} from '../../estado-catalogo.js';
import {
  brutoDesdeNeto,
  calcularProducto,
  comparable,
  netoDesdeBruto,
  publicadoEnWeb,
} from './canonico.js';
import type { EntradaCanonico } from './canonico.js';

const EN = '2026-10-28T15:00:00.000Z';

function lectura(
  sistema: SistemaCatalogo,
  campos: Partial<Record<CampoCatalogo, ValorCampo>>,
): LecturaGuardada {
  const guardados: LecturaGuardada['campos'] = {};
  for (const [campo, valor] of Object.entries(campos) as Array<[CampoCatalogo, ValorCampo]>) {
    guardados[campo] = { valor, vistoEn: EN, leidoEn: EN, escritoValor: null, escritoEn: null };
  }
  return {
    sistema,
    idExterno: `${sistema}-1`,
    modificadoEn: EN,
    leidoEn: EN,
    extra: {},
    campos: guardados,
  };
}

function regla(ambito: string, campo: CampoCatalogo, fuente: SistemaCatalogo): Regla {
  return { ambito, campo, fuente, usuario: null, en: EN };
}

function conflicto(campo: CampoCatalogo): Conflicto {
  return {
    id: 1,
    sku: 'SKU-001',
    campo,
    valores: {},
    abiertoEn: EN,
    estado: 'abierto',
    resueltoCon: null,
    resueltoPor: null,
    resueltoEn: null,
  };
}

function decision(estado: DecisionVisibilidad['estado']): DecisionVisibilidad {
  return { estado, usuario: null, en: EN };
}

function entrada(extra: Partial<EntradaCanonico> = {}): EntradaCanonico {
  return {
    sku: 'SKU-001',
    lecturas: {},
    reglas: [],
    visibilidad: null,
    conflictosAbiertos: [],
    ...extra,
  };
}

describe('precio: bruto y neto', () => {
  it('convierte entre neto y bruto con el IVA', () => {
    expect(brutoDesdeNeto(4201.68, 0.19)).toBe(5000);
    expect(netoDesdeBruto(5000, 0.19)).toBe(4201.68);
  });

  it('un producto exento no lleva IVA', () => {
    expect(brutoDesdeNeto(5000, 0)).toBe(5000);
    expect(netoDesdeBruto(5000, 0)).toBe(5000);
  });
});

describe('comparable', () => {
  it('el nombre pierde los espacios de más', () => {
    expect(comparable('nombre', '  A   b ')).toBe('A b');
  });

  it('el nombre se corta a 80 caracteres', () => {
    expect(comparable('nombre', 'x'.repeat(100))).toBe('x'.repeat(80));
  });

  it('los demás campos quedan como están', () => {
    expect(comparable('precio', 5000)).toBe(5000);
    expect(comparable('activo', true)).toBe(true);
  });
});

describe('publicadoEnWeb', () => {
  it('es cierto sólo con la lectura web activa', () => {
    expect(publicadoEnWeb(lectura('woocommerce', { activo: true }))).toBe(true);
    expect(publicadoEnWeb(lectura('woocommerce', { activo: false }))).toBe(false);
    expect(publicadoEnWeb(undefined)).toBe(false);
  });
});

describe('calcularProducto: regla de arranque', () => {
  const lecturas = {
    coreinbox: lectura('coreinbox', {
      nombre: 'Nombre de Coreinbox',
      precio: 4000,
      activo: false,
      tipo: 'bien',
      categoria: 'Categoría de Coreinbox',
      exento: true,
    }),
    woocommerce: lectura('woocommerce', {
      nombre: 'Nombre de la web',
      precio: 5000,
      activo: true,
      tipo: 'servicio',
      categoria: 'Categoría de la web',
      exento: false,
    }),
  };

  it('la web manda en nombre y precio; Coreinbox en tipo, categoría, activo y exento', () => {
    const p = calcularProducto(entrada({ lecturas }));
    expect(p.canonico.nombre).toEqual({ valor: 'Nombre de la web', fuente: 'woocommerce' });
    expect(p.canonico.precio).toEqual({ valor: 5000, fuente: 'woocommerce' });
    expect(p.canonico.tipo).toEqual({ valor: 'bien', fuente: 'coreinbox' });
    expect(p.canonico.categoria).toEqual({ valor: 'Categoría de Coreinbox', fuente: 'coreinbox' });
    expect(p.canonico.activo).toEqual({ valor: false, fuente: 'coreinbox' });
    expect(p.canonico.exento).toEqual({ valor: true, fuente: 'coreinbox' });
    expect(p.tipo).toBe('bien');
  });

  it('si la fuente preferida no tiene el dato, usa la otra', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { nombre: 'Nombre de Coreinbox', precio: 4000 }),
          woocommerce: lectura('woocommerce', { nombre: null, precio: null }),
        },
      }),
    );
    expect(p.canonico.nombre).toEqual({ valor: 'Nombre de Coreinbox', fuente: 'coreinbox' });
    expect(p.canonico.precio).toEqual({ valor: 4000, fuente: 'coreinbox' });
  });

  it('un campo ausente en la lectura preferida también cae a la otra', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'servicio' }),
          woocommerce: lectura('woocommerce', { nombre: 'Nombre de la web' }),
        },
      }),
    );
    expect(p.canonico.nombre?.fuente).toBe('woocommerce');
    expect(p.canonico.precio).toEqual({ valor: null, fuente: null });
  });

  it('sin ninguna lectura todo queda vacío', () => {
    const p = calcularProducto(entrada());
    expect(p.canonico.nombre).toEqual({ valor: null, fuente: null });
    expect(p.tipo).toBeNull();
    expect(p.precioNeto).toBeNull();
    expect(p.presentes).toEqual([]);
  });
});

describe('calcularProducto: reglas', () => {
  const lecturas = {
    coreinbox: lectura('coreinbox', { nombre: 'Nombre de Coreinbox', precio: 4000 }),
    woocommerce: lectura('woocommerce', { nombre: 'Nombre de la web', precio: 5000 }),
    emite: lectura('emite', { nombre: 'Nombre de Emite', precio: 3000 }),
  };

  it('una regla global cambia quién manda', () => {
    const p = calcularProducto(entrada({ lecturas, reglas: [regla('*', 'precio', 'coreinbox')] }));
    expect(p.canonico.precio).toEqual({ valor: 4000, fuente: 'coreinbox' });
    expect(p.canonico.nombre?.fuente).toBe('woocommerce');
  });

  it('la regla del SKU gana a la global', () => {
    const p = calcularProducto(
      entrada({
        lecturas,
        reglas: [regla('*', 'precio', 'coreinbox'), regla('SKU-001', 'precio', 'woocommerce')],
      }),
    );
    expect(p.canonico.precio).toEqual({ valor: 5000, fuente: 'woocommerce' });
  });

  it('la regla de otro SKU no se aplica', () => {
    const p = calcularProducto(
      entrada({ lecturas, reglas: [regla('SKU-999', 'precio', 'emite')] }),
    );
    expect(p.canonico.precio?.fuente).toBe('woocommerce');
  });

  it('una regla puede hacer mandar a Emite DTE', () => {
    const p = calcularProducto(
      entrada({ lecturas, reglas: [regla('SKU-001', 'precio', 'emite')] }),
    );
    expect(p.canonico.precio).toEqual({ valor: 3000, fuente: 'emite' });
  });

  it('si la fuente de la regla no tiene el dato, cae a la de arranque', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { woocommerce: lecturas.woocommerce },
        reglas: [regla('*', 'precio', 'emite')],
      }),
    );
    expect(p.canonico.precio).toEqual({ valor: 5000, fuente: 'woocommerce' });
  });

  it('sin regla, lo de Emite DTE nunca pasa a ser canónico', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          emite: lectura('emite', { nombre: 'Nombre de Emite', precio: 3000, activo: true }),
        },
      }),
    );
    expect(p.canonico.nombre).toEqual({ valor: null, fuente: null });
    expect(p.canonico.precio).toEqual({ valor: null, fuente: null });
    expect(p.canonico.activo).toEqual({ valor: null, fuente: null });
  });
});

describe('calcularProducto: precio neto', () => {
  it('se deriva del bruto con IVA', () => {
    const p = calcularProducto(
      entrada({ lecturas: { woocommerce: lectura('woocommerce', { precio: 5000 }) } }),
    );
    expect(p.precioNeto).toBe(4201.68);
  });

  it('un producto exento tiene neto igual al bruto', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { exento: true }),
          woocommerce: lectura('woocommerce', { precio: 5000 }),
        },
      }),
    );
    expect(p.precioNeto).toBe(5000);
  });
});

describe('calcularProducto: tipo', () => {
  it('un producto sólo de la web es un bien', () => {
    const p = calcularProducto(
      entrada({ lecturas: { woocommerce: lectura('woocommerce', { nombre: 'Solo web' }) } }),
    );
    expect(p.tipo).toBe('bien');
    expect(p.canonico.tipo).toEqual({ valor: 'bien', fuente: 'woocommerce' });
  });

  it('sin la web ni Coreinbox el tipo queda sin definir', () => {
    const p = calcularProducto(
      entrada({ lecturas: { emite: lectura('emite', { nombre: 'Solo Emite' }) } }),
    );
    expect(p.tipo).toBeNull();
  });
});

describe('calcularProducto: visibilidad web y alcance', () => {
  it('un servicio es no_aplica y no llega a la web', () => {
    const p = calcularProducto(
      entrada({ lecturas: { coreinbox: lectura('coreinbox', { tipo: 'servicio' }) } }),
    );
    expect(p.visibilidadWeb).toBe('no_aplica');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
    expect(p.avisos).toEqual([]);
  });

  it('un servicio publicado en la web trae un aviso', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'servicio' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
      }),
    );
    expect(p.visibilidadWeb).toBe('no_aplica');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
    expect(p.avisos).toHaveLength(1);
    expect(p.avisos[0]).toMatch(/servicio/i);
  });

  it('un bien publicado en la web queda aprobado y la web entra al alcance', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
      }),
    );
    expect(p.visibilidadWeb).toBe('aprobado');
    expect(p.alcance).toEqual(['coreinbox', 'woocommerce', 'emite']);
  });

  it('un bien que no está en la web queda propuesto', () => {
    const p = calcularProducto(
      entrada({ lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) } }),
    );
    expect(p.visibilidadWeb).toBe('propuesto');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
  });

  it('un bien en la web pero no publicado (borrador) también queda propuesto', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: false }),
        },
      }),
    );
    expect(p.visibilidadWeb).toBe('propuesto');
  });

  it('una decisión rechazada manda sobre lo publicado y avisa', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
        visibilidad: decision('rechazado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('rechazado');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
    expect(p.avisos).toHaveLength(1);
    expect(p.avisos[0]).toMatch(/rechazada/i);
  });

  it('una decisión rechazada sin publicación no avisa', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) },
        visibilidad: decision('rechazado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('rechazado');
    expect(p.avisos).toEqual([]);
  });

  it('una decisión aprobada manda aunque no esté en la web', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) },
        visibilidad: decision('aprobado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('aprobado');
    expect(p.alcance).toContain('woocommerce');
    expect(p.faltaEn).toContain('woocommerce');
  });

  it('la decisión sobre un servicio se ignora', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { coreinbox: lectura('coreinbox', { tipo: 'servicio' }) },
        visibilidad: decision('aprobado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('no_aplica');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
  });
});

describe('calcularProducto: presentes y faltaEn', () => {
  it('le falta Emite DTE a un bien publicado que sólo está en Coreinbox y la web', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
      }),
    );
    expect(p.presentes).toEqual(['coreinbox', 'woocommerce']);
    expect(p.faltaEn).toEqual(['emite']);
  });

  it('a un producto fuera de la web no le falta la web', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          emite: lectura('emite', { nombre: 'Producto de Prueba' }),
        },
      }),
    );
    expect(p.faltaEn).toEqual([]);
  });

  it('a un producto sólo de la web le faltan Coreinbox y Emite DTE', () => {
    const p = calcularProducto(
      entrada({ lecturas: { woocommerce: lectura('woocommerce', { activo: true }) } }),
    );
    expect(p.faltaEn).toEqual(['coreinbox', 'emite']);
  });
});

describe('calcularProducto: diferencias', () => {
  it('lista el campo con los valores de cada sistema cuando son distintos', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { precio: 4000, activo: true }),
          woocommerce: lectura('woocommerce', { precio: 5000, activo: true }),
        },
      }),
    );
    expect(p.diferencias).toEqual([
      { campo: 'precio', valores: { coreinbox: 4000, woocommerce: 5000 } },
    ]);
  });

  it('detecta la diferencia en activo', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { activo: false }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
      }),
    );
    expect(p.diferencias.map((d) => d.campo)).toEqual(['activo']);
  });

  it('nombres que sólo difieren en espacios no son una diferencia', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { nombre: 'Producto   de Prueba ' }),
          woocommerce: lectura('woocommerce', { nombre: ' Producto de Prueba' }),
        },
      }),
    );
    expect(p.diferencias).toEqual([]);
  });

  it('el nombre de Emite DTE cortado a 80 caracteres no es una diferencia', () => {
    const largo = `Producto de Prueba ${'x'.repeat(100)}`;
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { nombre: largo }),
          emite: lectura('emite', { nombre: largo.slice(0, 80) }),
        },
      }),
    );
    expect(p.diferencias).toEqual([]);
  });

  it('un nombre realmente distinto sí es una diferencia', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { nombre: 'Producto A' }),
          emite: lectura('emite', { nombre: 'Producto B' }),
        },
      }),
    );
    expect(p.diferencias).toEqual([
      { campo: 'nombre', valores: { coreinbox: 'Producto A', emite: 'Producto B' } },
    ]);
  });

  it('un valor nulo en un sistema no cuenta como diferencia', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { precio: 4000 }),
          woocommerce: lectura('woocommerce', { precio: null }),
        },
      }),
    );
    expect(p.diferencias).toEqual([]);
  });
});

describe('calcularProducto: conflictos', () => {
  it('un conflicto abierto marca el campo canónico', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { precio: 4000 }),
          woocommerce: lectura('woocommerce', { precio: 5000 }),
        },
        conflictosAbiertos: [conflicto('precio')],
      }),
    );
    expect(p.canonico.precio?.conflicto).toBe(true);
    expect(p.canonico.nombre?.conflicto).toBeUndefined();
  });
});
