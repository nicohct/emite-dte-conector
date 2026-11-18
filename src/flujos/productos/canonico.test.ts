import { describe, expect, it } from 'vitest';
import type {
  CampoCatalogo,
  Conflicto,
  DecisionVisibilidad,
  ProductoCatalogo,
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
const PRIMERA = '2026-10-29T00:00:00.000Z';
const HORA_1 = '2026-10-29T10:00:00.000Z';
const HORA_2 = '2026-10-29T11:00:00.000Z';

interface OpcionesLectura {
  /** Hora del último cambio visto por campo; sin ella, no hubo cambio. */
  cambios?: Partial<Record<CampoCatalogo, string>>;
  extra?: Record<string, unknown>;
}

function lectura(
  sistema: SistemaCatalogo,
  campos: Partial<Record<CampoCatalogo, ValorCampo>>,
  opciones: OpcionesLectura = {},
): LecturaGuardada {
  const guardados: LecturaGuardada['campos'] = {};
  for (const [campo, valor] of Object.entries(campos) as Array<[CampoCatalogo, ValorCampo]>) {
    guardados[campo] = {
      valor,
      vistoEn: EN,
      leidoEn: EN,
      escritoValor: null,
      escritoEn: null,
      cambioEn: opciones.cambios?.[campo] ?? null,
    };
  }
  return {
    sistema,
    idExterno: `${sistema}-1`,
    modificadoEn: EN,
    leidoEn: EN,
    extra: opciones.extra ?? {},
    campos: guardados,
  };
}

function regla(ambito: string, campo: CampoCatalogo, fuente: Regla['fuente']): Regla {
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

const avisosSobre = (p: ProductoCatalogo, patron: RegExp): string[] =>
  p.avisos.filter((a) => patron.test(a));

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
    expect(p.canonico.nombre).toMatchObject({ valor: 'Nombre de la web', fuente: 'woocommerce' });
    expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
    expect(p.canonico.tipo).toMatchObject({ valor: 'bien', fuente: 'coreinbox' });
    expect(p.canonico.categoria).toMatchObject({
      valor: 'Categoría de Coreinbox',
      fuente: 'coreinbox',
    });
    expect(p.canonico.activo).toMatchObject({ valor: false, fuente: 'coreinbox' });
    expect(p.canonico.exento).toMatchObject({ valor: true, fuente: 'coreinbox' });
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
    expect(p.canonico.nombre).toMatchObject({ valor: 'Nombre de Coreinbox', fuente: 'coreinbox' });
    expect(p.canonico.precio).toMatchObject({ valor: 4000, fuente: 'coreinbox' });
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
    expect(p.canonico.precio).toMatchObject({ valor: null, fuente: null });
  });

  it('sin ninguna lectura todo queda vacío', () => {
    const p = calcularProducto(entrada());
    expect(p.canonico.nombre).toMatchObject({ valor: null, fuente: null });
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
    expect(p.canonico.precio).toMatchObject({ valor: 4000, fuente: 'coreinbox' });
    expect(p.canonico.nombre?.fuente).toBe('woocommerce');
  });

  it('la regla del SKU gana a la global', () => {
    const p = calcularProducto(
      entrada({
        lecturas,
        reglas: [regla('*', 'precio', 'coreinbox'), regla('SKU-001', 'precio', 'woocommerce')],
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
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
    expect(p.canonico.precio).toMatchObject({ valor: 3000, fuente: 'emite' });
  });

  it('si la fuente de la regla no tiene el dato, cae a la de arranque', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { woocommerce: lecturas.woocommerce },
        reglas: [regla('*', 'precio', 'emite')],
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
  });

  it('sin regla, lo de Emite DTE es canónico en exento y, sin otro precio, en precio', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          emite: lectura('emite', {
            nombre: 'Nombre de Emite',
            precio: 3000,
            activo: true,
            exento: true,
          }),
        },
      }),
    );
    expect(p.canonico.exento).toMatchObject({ valor: true, fuente: 'emite', modo: 'propietario' });
    expect(p.canonico.nombre).toMatchObject({ valor: null, fuente: null });
    expect(p.canonico.precio).toMatchObject({ valor: 3000, fuente: 'emite' });
    expect(p.canonico.activo).toMatchObject({ valor: null, fuente: null });
    expect(p.escrituras).toEqual([]);
  });
});

describe('calcularProducto: precio neto', () => {
  it('se deriva del bruto con IVA', () => {
    const p = calcularProducto(
      entrada({ lecturas: { woocommerce: lectura('woocommerce', { precio: 5000 }) } }),
    );
    expect(p.precioNeto).toBe(4201.68);
  });

  it('Emite DTE manda en exento; sin Emite DTE, Coreinbox', () => {
    const con = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { exento: false }),
          emite: lectura('emite', { exento: true }),
        },
      }),
    );
    expect(con.canonico.exento).toMatchObject({ valor: true, fuente: 'emite' });
    const sin = calcularProducto(
      entrada({ lecturas: { coreinbox: lectura('coreinbox', { exento: false }) } }),
    );
    expect(sin.canonico.exento).toMatchObject({ valor: false, fuente: 'coreinbox' });
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
    expect(p.canonico.tipo).toMatchObject({ valor: 'bien', fuente: 'woocommerce' });
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
    expect(p.motivoVisibilidad).toBe('servicio');
    expect(avisosSobre(p, /servicio/i)).toEqual([]);
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
    expect(avisosSobre(p, /servicio/i)).toHaveLength(1);
  });

  it('un bien publicado en la web sin decisión queda propuesto: la lectura no aprueba', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
      }),
    );
    expect(p.visibilidadWeb).toBe('propuesto');
    expect(p.motivoVisibilidad).toBe('sin_decision');
  });

  it('un bien en la web con decisión aprobada entra la web al alcance', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: true }),
        },
        visibilidad: { estado: 'aprobado', usuario: 'web', en: EN },
      }),
    );
    expect(p.visibilidadWeb).toBe('aprobado');
    expect(p.motivoVisibilidad).toBe('decision');
    expect(p.alcance).toEqual(['coreinbox', 'woocommerce', 'emite']);
  });

  it('un bien que no está en la web queda propuesto', () => {
    const p = calcularProducto(
      entrada({ lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) } }),
    );
    expect(p.visibilidadWeb).toBe('propuesto');
    expect(p.motivoVisibilidad).toBe('sin_decision');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
  });

  it('un bien en la web como borrador sin decisión queda propuesto', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { tipo: 'bien' }),
          woocommerce: lectura('woocommerce', { activo: false }),
        },
      }),
    );
    expect(p.visibilidadWeb).toBe('propuesto');
    expect(p.motivoVisibilidad).toBe('sin_decision');
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
    expect(avisosSobre(p, /rechazada/i)).toHaveLength(1);
  });

  it('una decisión rechazada sin publicación no avisa', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) },
        visibilidad: decision('rechazado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('rechazado');
    expect(avisosSobre(p, /rechazada/i)).toEqual([]);
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

describe('calcularProducto: último cambio', () => {
  const lecturas = {
    coreinbox: lectura('coreinbox', { precio: 4000, nombre: 'Nombre de Coreinbox' }),
    woocommerce: lectura('woocommerce', { precio: 5000, nombre: 'Nombre de la web' }),
  };
  const conCambios = (coreinbox: string | null, web: string | null) => ({
    coreinbox: lectura(
      'coreinbox',
      { precio: 4000, nombre: 'Nombre de Coreinbox' },
      coreinbox ? { cambios: { precio: coreinbox, nombre: coreinbox } } : {},
    ),
    woocommerce: lectura(
      'woocommerce',
      { precio: 5000, nombre: 'Nombre de la web' },
      web ? { cambios: { precio: web, nombre: web } } : {},
    ),
  });

  it('después de la primera escritura gana el sistema con el cambio más reciente', () => {
    const p = calcularProducto(
      entrada({ lecturas: conCambios(HORA_2, HORA_1), primeraEscritura: PRIMERA }),
    );
    expect(p.canonico.precio).toEqual({ valor: 4000, fuente: 'coreinbox', modo: 'ultimo' });
    expect(p.canonico.nombre).toEqual({
      valor: 'Nombre de Coreinbox',
      fuente: 'coreinbox',
      modo: 'ultimo',
    });
    const alReves = calcularProducto(
      entrada({ lecturas: conCambios(HORA_1, HORA_2), primeraEscritura: PRIMERA }),
    );
    expect(alReves.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
  });

  it('antes de la primera escritura se ignora cambioEn y manda el arranque', () => {
    for (const primeraEscritura of [null, undefined]) {
      const p = calcularProducto(
        entrada({ lecturas: conCambios(HORA_2, HORA_1), primeraEscritura }),
      );
      expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
    }
  });

  it('sin ningún cambio visto vale el arranque aunque ya haya escritura', () => {
    const p = calcularProducto(entrada({ lecturas, primeraEscritura: PRIMERA }));
    expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce', modo: 'ultimo' });
  });

  it('un cambio sin valor no cuenta', () => {
    const p = calcularProducto(
      entrada({
        lecturas: {
          coreinbox: lectura('coreinbox', { precio: 4000 }, { cambios: { precio: HORA_1 } }),
          woocommerce: lectura('woocommerce', { precio: null }, { cambios: { precio: HORA_2 } }),
        },
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 4000, fuente: 'coreinbox' });
  });

  it('una regla con fuente «ultimo» pone un campo de propietario en último cambio', () => {
    const lecs = {
      coreinbox: lectura('coreinbox', { activo: true }, { cambios: { activo: HORA_1 } }),
      woocommerce: lectura('woocommerce', { activo: false }, { cambios: { activo: HORA_2 } }),
    };
    const propietario = calcularProducto(entrada({ lecturas: lecs, primeraEscritura: PRIMERA }));
    expect(propietario.canonico.activo).toEqual({
      valor: true,
      fuente: 'coreinbox',
      modo: 'propietario',
    });
    const ultimo = calcularProducto(
      entrada({
        lecturas: lecs,
        primeraEscritura: PRIMERA,
        reglas: [regla('SKU-001', 'activo', 'ultimo')],
      }),
    );
    expect(ultimo.canonico.activo).toEqual({ valor: false, fuente: 'woocommerce', modo: 'ultimo' });
  });
});

describe('calcularProducto: categorías fuera de la web', () => {
  const lecturas = {
    coreinbox: lectura('coreinbox', { tipo: 'bien', categoria: 'Interno' }),
  };

  it('un producto de una categoría fuera queda rechazado por la categoría', () => {
    const p = calcularProducto(entrada({ lecturas, categoriasFuera: new Set(['Interno']) }));
    expect(p.visibilidadWeb).toBe('rechazado');
    expect(p.motivoVisibilidad).toBe('categoria');
    expect(p.alcance).toEqual(['coreinbox', 'emite']);
  });

  it('una decisión del panel manda sobre la categoría', () => {
    const p = calcularProducto(
      entrada({
        lecturas,
        categoriasFuera: new Set(['Interno']),
        visibilidad: decision('aprobado'),
      }),
    );
    expect(p.visibilidadWeb).toBe('aprobado');
    expect(p.motivoVisibilidad).toBe('decision');
  });

  it('otra categoría no afecta', () => {
    const p = calcularProducto(entrada({ lecturas, categoriasFuera: new Set(['Otra']) }));
    expect(p.visibilidadWeb).toBe('propuesto');
  });
});

describe('calcularProducto: escrituras planeadas', () => {
  const extraCi = { moneda: 'CLP' };
  const aprobado = decision('aprobado');
  const base = () => ({
    coreinbox: lectura(
      'coreinbox',
      { nombre: 'Viejo', precio: 4000, activo: true, tipo: 'bien', categoria: 'C' },
      { extra: extraCi },
    ),
    woocommerce: lectura(
      'woocommerce',
      { nombre: 'Nuevo', precio: 5000, activo: true },
      { extra: { estado: 'publish' } },
    ),
    emite: lectura('emite', {
      nombre: ' Nuevo  ',
      precio: 5000,
      activo: true,
      tipo: 'bien',
      categoria: 'C',
    }),
  });

  it('lista sólo los campos que difieren del canónico', () => {
    const p = calcularProducto(entrada({ lecturas: base(), visibilidad: aprobado }));
    expect(p.escrituras).toEqual([
      { sistema: 'coreinbox', campo: 'nombre', antes: 'Viejo', valor: 'Nuevo', revierte: false },
      { sistema: 'coreinbox', campo: 'precio', antes: 4000, valor: 5000, revierte: false },
    ]);
  });

  it('un producto igual en los tres no escribe nada', () => {
    const lecturas = base();
    lecturas.coreinbox = lectura(
      'coreinbox',
      { nombre: 'Nuevo', precio: 5000, activo: true, tipo: 'bien', categoria: 'C' },
      { extra: extraCi },
    );
    expect(calcularProducto(entrada({ lecturas, visibilidad: aprobado })).escrituras).toEqual([]);
  });

  it('salta los campos en conflicto', () => {
    const p = calcularProducto(
      entrada({
        lecturas: base(),
        visibilidad: aprobado,
        conflictosAbiertos: [conflicto('precio')],
      }),
    );
    expect(p.escrituras.map((x) => x.campo)).toEqual(['nombre']);
  });

  it('no escribe el precio en una Coreinbox que no es CLP', () => {
    const lecturas = base();
    lecturas.coreinbox = lectura(
      'coreinbox',
      { nombre: 'Nuevo', precio: 4000, activo: true, tipo: 'bien', categoria: 'C' },
      { extra: { moneda: 'USD' } },
    );
    expect(calcularProducto(entrada({ lecturas, visibilidad: aprobado })).escrituras).toEqual([]);
  });

  it('marca revierte cuando el sistema cambió, no es la fuente y ya hubo primera escritura', () => {
    const lecturas = base();
    lecturas.coreinbox = lectura(
      'coreinbox',
      { nombre: 'Viejo', precio: 4000, activo: true, tipo: 'bien', categoria: 'C' },
      { extra: extraCi, cambios: { precio: HORA_1 } },
    );
    lecturas.woocommerce = lectura(
      'woocommerce',
      { nombre: 'Nuevo', precio: 5000, activo: true },
      { extra: { estado: 'publish' }, cambios: { precio: HORA_2 } },
    );
    const p = calcularProducto(entrada({ lecturas, primeraEscritura: PRIMERA }));
    expect(p.canonico.precio).toMatchObject({ valor: 5000, fuente: 'woocommerce' });
    expect(p.escrituras.find((x) => x.campo === 'precio')).toMatchObject({
      sistema: 'coreinbox',
      revierte: true,
    });
    // El nombre difiere pero Coreinbox no lo cambió: se actualiza, no se revierte.
    expect(p.escrituras.find((x) => x.campo === 'nombre')?.revierte).toBe(false);
    const antes = calcularProducto(entrada({ lecturas }));
    expect(antes.escrituras.every((x) => !x.revierte)).toBe(true);
  });

  it('en la web activo sigue el estado: borrador aprobado y activo se publica', () => {
    const lecturas = base();
    lecturas.woocommerce = lectura(
      'woocommerce',
      { nombre: 'Nuevo', precio: 5000, activo: false },
      { extra: { estado: 'draft' } },
    );
    const p = calcularProducto(entrada({ lecturas, visibilidad: aprobado }));
    expect(p.visibilidadWeb).toBe('aprobado');
    expect(p.escrituras.find((x) => x.sistema === 'woocommerce')).toEqual({
      sistema: 'woocommerce',
      campo: 'activo',
      antes: false,
      valor: true,
      revierte: false,
    });
  });

  it('un producto rechazado y publicado pasa a borrador en la web', () => {
    const p = calcularProducto(entrada({ lecturas: base(), visibilidad: decision('rechazado') }));
    expect(p.escrituras.find((x) => x.sistema === 'woocommerce')).toMatchObject({
      campo: 'activo',
      antes: true,
      valor: false,
    });
  });

  it('un producto aprobado ya publicado no escribe activo en la web', () => {
    const p = calcularProducto(entrada({ lecturas: base(), visibilidad: aprobado }));
    expect(p.escrituras.some((x) => x.sistema === 'woocommerce')).toBe(false);
  });
});

describe('calcularProducto: crearEn', () => {
  const lecturas = {
    coreinbox: lectura('coreinbox', {
      nombre: 'Solo Coreinbox',
      precio: 4000,
      tipo: 'bien',
      activo: true,
    }),
  };

  it('incluye Emite DTE cuando falta y hay una fuente', () => {
    const p = calcularProducto(entrada({ lecturas }));
    expect(p.crearEn).toEqual(['emite']);
  });

  it('no crea en Emite DTE si hay un motivo, y lo avisa', () => {
    const p = calcularProducto(
      entrada({ lecturas, noCrearEnEmite: 'Hay un histórico con el mismo código sin decidir' }),
    );
    expect(p.crearEn).toEqual([]);
    expect(p.avisos).toContain('Hay un histórico con el mismo código sin decidir');
  });

  it('un producto que existe sólo en Emite DTE no se crea en ningún lado', () => {
    const p = calcularProducto(
      entrada({ lecturas: { emite: lectura('emite', { nombre: 'Histórico', precio: 100 }) } }),
    );
    expect(p.crearEn).toEqual([]);
  });

  it('sin nombre y precio avisa en vez de crear', () => {
    const p = calcularProducto(
      entrada({ lecturas: { coreinbox: lectura('coreinbox', { tipo: 'bien' }) } }),
    );
    expect(p.crearEn).toEqual([]);
    expect(p.avisos.some((a) => /nombre y precio/.test(a))).toBe(true);
  });

  it('la web sólo se crea si está aprobada por decisión y falta', () => {
    expect(calcularProducto(entrada({ lecturas })).crearEn).not.toContain('woocommerce');
    const aprobado = calcularProducto(entrada({ lecturas, visibilidad: decision('aprobado') }));
    expect(aprobado.crearEn).toEqual(['emite', 'woocommerce']);
    const rechazado = calcularProducto(entrada({ lecturas, visibilidad: decision('rechazado') }));
    expect(rechazado.crearEn).not.toContain('woocommerce');
  });
});

describe('calcularProducto: crear en Coreinbox desde la web', () => {
  const enWeb = (campos: Partial<Record<CampoCatalogo, ValorCampo>> = {}, estado = 'publish') =>
    lectura(
      'woocommerce',
      { nombre: 'Taza térmica', precio: 5990, activo: estado === 'publish', ...campos },
      { extra: { estado } },
    );
  const publicado = (extra: Partial<EntradaCanonico> = {}) =>
    entrada({
      lecturas: { woocommerce: enWeb() },
      visibilidad: decision('aprobado'),
      crearEnCoreinboxDesdeWeb: true,
      ...extra,
    });
  const sinCrear = (p: ProductoCatalogo) => expect(p.crearEn).not.toContain('coreinbox');

  it('un bien publicado y aprobado con nombre y precio se crea en Coreinbox', () => {
    const p = calcularProducto(publicado());
    expect(p.faltaEn).toContain('coreinbox');
    expect(p.crearEn).toContain('coreinbox');
    expect(p.avisos).toEqual([]);
  });

  it('con la variable apagada no se crea, como antes', () => {
    sinCrear(calcularProducto(publicado({ crearEnCoreinboxDesdeWeb: false })));
    sinCrear(calcularProducto(publicado({ crearEnCoreinboxDesdeWeb: undefined })));
  });

  it('un borrador en la tienda no se crea aunque esté aprobado', () => {
    sinCrear(calcularProducto(publicado({ lecturas: { woocommerce: enWeb({}, 'draft') } })));
  });

  it('publicado pero sin aprobar (propuesto o rechazado) no se crea', () => {
    sinCrear(calcularProducto(publicado({ visibilidad: null })));
    sinCrear(calcularProducto(publicado({ visibilidad: decision('propuesto') })));
    sinCrear(calcularProducto(publicado({ visibilidad: decision('rechazado') })));
  });

  it('un servicio nunca nace en la web', () => {
    const p = calcularProducto(
      publicado({
        lecturas: {
          woocommerce: enWeb(),
          emite: lectura('emite', { nombre: 'Taza térmica', precio: 5990, tipo: 'servicio' }),
        },
        reglas: [regla('*', 'tipo', 'emite')],
      }),
    );
    expect(p.tipo).toBe('servicio');
    sinCrear(p);
  });

  it('sin precio en la web avisa en vez de crear', () => {
    const p = calcularProducto(publicado({ lecturas: { woocommerce: enWeb({ precio: null }) } }));
    sinCrear(p);
    expect(p.avisos).toContain(
      'Falta en Coreinbox y la web no tiene precio: crearlo en Coreinbox o desde el panel',
    );
  });

  it('sin precio en la web no se crea aunque Emite DTE tenga uno', () => {
    const p = calcularProducto(
      publicado({
        lecturas: {
          woocommerce: enWeb({ precio: null }),
          emite: lectura('emite', { nombre: 'Taza térmica', precio: 5990, activo: true }),
        },
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'emite' });
    sinCrear(p);
    expect(p.avisos).toContain(
      'Falta en Coreinbox y la web no tiene precio: crearlo en Coreinbox o desde el panel',
    );
  });

  it('un homónimo sin SKU en Coreinbox (sin tildes, espacios ni mayúsculas) lo frena con un aviso', () => {
    const p = calcularProducto(publicado({ nombresSinSkuCoreinbox: new Set(['tazatermica']) }));
    sinCrear(p);
    expect(p.avisos).toContain(
      'Coreinbox tiene un producto sin SKU con el mismo nombre: ponerle el SKU allá',
    );
  });

  it('lo que ya está en Coreinbox no se vuelve a crear, y la categoría de la web no se le lleva', () => {
    const conCoreinbox = (crearEnCoreinboxDesdeWeb: boolean) =>
      publicado({
        crearEnCoreinboxDesdeWeb,
        lecturas: {
          woocommerce: enWeb({ categoria: 'Tazas' }),
          coreinbox: lectura('coreinbox', {
            nombre: 'Taza térmica',
            precio: 5990,
            activo: true,
            tipo: 'bien',
            categoria: null,
          }),
        },
        primeraEscritura: PRIMERA,
      });
    const p = calcularProducto(conCoreinbox(true));
    sinCrear(p);
    expect(p.escrituras.filter((w) => w.sistema === 'coreinbox')).toEqual([]);
    // Con la variable apagada sigue como antes: la categoría de la web se planea para Coreinbox.
    expect(
      calcularProducto(conCoreinbox(false)).escrituras.filter((w) => w.sistema === 'coreinbox'),
    ).toEqual([
      { sistema: 'coreinbox', campo: 'categoria', antes: null, valor: 'Tazas', revierte: false },
    ]);
  });
});

describe('calcularProducto: la web sin precio', () => {
  const tres = (
    web: ValorCampo,
    coreinbox: ValorCampo,
    emite: ValorCampo,
    cambios: Partial<Record<SistemaCatalogo, string>> = {},
  ) => ({
    woocommerce: lectura(
      'woocommerce',
      { nombre: 'Taza', precio: web, activo: true },
      {
        extra: { estado: 'publish' },
        cambios: cambios.woocommerce ? { precio: cambios.woocommerce } : {},
      },
    ),
    coreinbox: lectura(
      'coreinbox',
      { nombre: 'Taza', precio: coreinbox, activo: true, tipo: 'bien' },
      { extra: { moneda: 'CLP' }, cambios: cambios.coreinbox ? { precio: cambios.coreinbox } : {} },
    ),
    emite: lectura(
      'emite',
      { nombre: 'Taza', precio: emite, activo: true, tipo: 'bien', exento: false },
      { cambios: cambios.emite ? { precio: cambios.emite } : {} },
    ),
  });
  const precioEn = (p: ProductoCatalogo, s: SistemaCatalogo) =>
    p.escrituras?.find((w) => w.sistema === s && w.campo === 'precio');

  it('al arrancar el precio sale de Coreinbox y no se escribe en la web ni cuenta como diferencia', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres(null, 5990, 5990), visibilidad: decision('aprobado') }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'coreinbox' });
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
    expect(p.diferencias.map((d) => d.campo)).not.toContain('precio');
    expect(p.escrituras).toEqual([]);
  });

  it('sin web ni Coreinbox con precio, sale de Emite DTE', () => {
    const p = calcularProducto(entrada({ lecturas: tres(null, null, 4990) }));
    expect(p.canonico.precio).toMatchObject({ valor: 4990, fuente: 'emite' });
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
  });

  it('con precio en la web, la web manda como siempre', () => {
    const p = calcularProducto(entrada({ lecturas: tres(6990, 5990, 5990) }));
    expect(p.canonico.precio).toMatchObject({ valor: 6990, fuente: 'woocommerce' });
    expect(precioEn(p, 'coreinbox')?.valor).toBe(6990);
    expect(precioEn(p, 'emite')?.valor).toBe(6990);
  });

  it('en la primera escritura un 0 de Coreinbox no pisa el precio de Emite DTE', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres(null, 0, 5990), primeraEscritura: PRIMERA }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'emite' });
    expect(precioEn(p, 'emite')).toBeUndefined();
    expect(precioEn(p, 'coreinbox')?.valor).toBe(5990);
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
  });

  it('con 0 en todos lados queda el 0, pero no se le escribe a la web', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres(null, 0, 0), visibilidad: decision('aprobado') }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 0, fuente: 'coreinbox' });
    expect(p.escrituras).toEqual([]);
  });

  it('pasar la web de un valor a vacío no se propaga: los demás conservan el suyo', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(null, 5990, 5990, { woocommerce: HORA_1 }),
        primeraEscritura: PRIMERA,
        visibilidad: decision('aprobado'),
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'coreinbox' });
    expect(p.escrituras).toEqual([]);
  });

  it('en último cambio, un cambio de Coreinbox llega a Emite DTE pero no a la web sin precio', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(null, 7990, 5990, { coreinbox: HORA_1, woocommerce: HORA_2 }),
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 7990, fuente: 'coreinbox' });
    expect(precioEn(p, 'emite')?.valor).toBe(7990);
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
  });

  it('un 0 puesto después en Coreinbox no se publica en la web', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(5990, 0, 5990, { coreinbox: HORA_1 }),
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 0, fuente: 'coreinbox' });
    expect(precioEn(p, 'emite')?.valor).toBe(0);
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
  });

  it('cuando la web vuelve a tener precio, vuelve a regir la regla normal', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(8990, 5990, 5990, { woocommerce: HORA_1 }),
        primeraEscritura: PRIMERA,
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 8990, fuente: 'woocommerce' });
    expect(precioEn(p, 'coreinbox')?.valor).toBe(8990);
  });

  it('con la web como propietaria y sin precio allá, manda el siguiente con precio', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(null, 0, 5990),
        reglas: [regla('*', 'precio', 'woocommerce')],
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 5990, fuente: 'emite', modo: 'propietario' });
    expect(precioEn(p, 'woocommerce')).toBeUndefined();
  });

  it('un propietario explícito manda aunque tenga 0', () => {
    const p = calcularProducto(
      entrada({ lecturas: tres(null, 0, 5990), reglas: [regla('*', 'precio', 'coreinbox')] }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 0, fuente: 'coreinbox' });
  });

  it('una edición de precio del panel sí llega a la web sin precio', () => {
    const p = calcularProducto(
      entrada({
        lecturas: tres(null, 5990, 5990),
        primeraEscritura: PRIMERA,
        ediciones: [{ sku: 'SKU-001', campo: 'precio', valor: 6490, usuario: 'ana', en: HORA_1 }],
      }),
    );
    expect(p.canonico.precio).toMatchObject({ valor: 6490, fuente: 'panel' });
    expect(precioEn(p, 'woocommerce')).toMatchObject({ valor: 6490, revierte: false });
    expect(precioEn(p, 'coreinbox')?.valor).toBe(6490);
  });

  it('dejar la web sin precio después de una edición del panel no la deja atrás', () => {
    const e = entrada({
      lecturas: tres(null, 5990, 5990, { woocommerce: HORA_2 }),
      primeraEscritura: PRIMERA,
      ediciones: [{ sku: 'SKU-001', campo: 'precio', valor: 6490, usuario: 'ana', en: HORA_1 }],
    });
    const p = calcularProducto(e);
    expect(p.canonico.precio).toMatchObject({ valor: 6490, fuente: 'panel' });
    expect(p.pendiente).toBe(true);
  });

  it('un alta del panel lleva su precio a la web aunque allá no tenga', () => {
    const p = calcularProducto(
      entrada({
        lecturas: { woocommerce: tres(null, null, null).woocommerce },
        visibilidad: decision('aprobado'),
        alta: {
          sku: 'SKU-001',
          nombre: 'Taza',
          precio: 5990,
          tipo: 'bien',
          categoria: null,
          exento: false,
          activo: true,
          usuario: 'ana',
          en: EN,
        },
      }),
    );
    expect(precioEn(p, 'woocommerce')).toMatchObject({ valor: 5990 });
  });
});
