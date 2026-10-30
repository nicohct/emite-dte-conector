import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ErrorPeticion } from '../flujos/productos/acciones.js';
import { avisoDe, cuerpoDe, destino, mismoOrigen } from './formularios.js';

const form = (...pares: Array<[string, string]>) => new URLSearchParams(pares);
const req = (headers: Record<string, string | string[]>) => ({ headers }) as IncomingMessage;

describe('cuerpoDe', () => {
  it('reglas: global y en lote, con fuente vacía como null', () => {
    expect(cuerpoDe('reglas', form(['campo', 'precio'], ['fuente', 'coreinbox']))).toEqual({
      campo: 'precio',
      fuente: 'coreinbox',
    });
    expect(cuerpoDe('reglas', form(['campo', 'precio'], ['fuente', '']))).toEqual({
      campo: 'precio',
      fuente: null,
    });
    expect(
      cuerpoDe(
        'reglas',
        form(['lote', '1'], ['campo', 'nombre'], ['fuente', 'emite'], ['sku', 'A'], ['sku', 'B']),
      ),
    ).toEqual({ campo: 'nombre', fuente: 'emite', skus: ['A', 'B'] });
  });

  it('empates: una decisión (uno) y un lote (sel + estado)', () => {
    expect(
      cuerpoDe('empates', form(['uno', JSON.stringify(['e1', 'SKU-001', 'confirmado'])])),
    ).toEqual({ decisiones: [{ emiteId: 'e1', sku: 'SKU-001', estado: 'confirmado' }] });
    expect(
      cuerpoDe(
        'empates',
        form(
          ['sel', JSON.stringify(['e1', 'SKU-001'])],
          ['sel', JSON.stringify(['e2', 'SKU-002'])],
          ['estado', 'rechazado'],
        ),
      ),
    ).toEqual({
      decisiones: [
        { emiteId: 'e1', sku: 'SKU-001', estado: 'rechazado' },
        { emiteId: 'e2', sku: 'SKU-002', estado: 'rechazado' },
      ],
    });
  });

  it('conflictos: uno conserva el id del JSON; el lote lo convierte a número', () => {
    expect(cuerpoDe('conflictos', form(['uno', JSON.stringify([7, 'coreinbox'])]))).toEqual({
      resoluciones: [{ id: 7, fuente: 'coreinbox' }],
    });
    expect(
      cuerpoDe('conflictos', form(['sel', '3'], ['sel', '4'], ['fuente', 'woocommerce'])),
    ).toEqual({
      resoluciones: [
        { id: 3, fuente: 'woocommerce' },
        { id: 4, fuente: 'woocommerce' },
      ],
    });
  });

  it('visibilidad: uno y lote', () => {
    expect(cuerpoDe('visibilidad', form(['uno', JSON.stringify(['SKU-003', 'aprobado'])]))).toEqual(
      { skus: ['SKU-003'], estado: 'aprobado' },
    );
    expect(
      cuerpoDe('visibilidad', form(['sku', 'A'], ['sku', 'B'], ['estado', 'rechazado'])),
    ).toEqual({ skus: ['A', 'B'], estado: 'rechazado' });
  });

  it('categorias: las elegidas y si salen o vuelven a la web', () => {
    expect(
      cuerpoDe(
        'categorias',
        form(['categoria', 'Válvulas'], ['categoria', 'Bombas'], ['fuera', '1']),
      ),
    ).toEqual({ categorias: ['Válvulas', 'Bombas'], fuera: true });
    expect(cuerpoDe('categorias', form(['categoria', 'Válvulas'], ['fuera', '0']))).toEqual({
      categorias: ['Válvulas'],
      fuera: false,
    });
    expect(cuerpoDe('categorias', form(['fuera', '1']))).toEqual({ categorias: [], fuera: true });
  });

  it('un lote sin casillas da una lista vacía (la acción lo rechaza)', () => {
    expect(cuerpoDe('empates', form(['estado', 'confirmado']))).toEqual({ decisiones: [] });
    expect(cuerpoDe('conflictos', form(['fuente', 'emite']))).toEqual({ resoluciones: [] });
    expect(cuerpoDe('visibilidad', form(['estado', 'aprobado']))).toEqual({
      skus: [],
      estado: 'aprobado',
    });
  });

  it('una decisión ilegible lanza ErrorPeticion', () => {
    expect(() => cuerpoDe('empates', form(['uno', 'no es json']))).toThrow(ErrorPeticion);
    expect(() => cuerpoDe('visibilidad', form(['uno', '{"a":1}']))).toThrow(ErrorPeticion);
    expect(() => cuerpoDe('empates', form(['sel', '"texto"']))).toThrow(ErrorPeticion);
  });
});

describe('destino', () => {
  const ok = { aplicadas: 2, errores: [] };

  it('vuelve a la pantalla de origen con el resultado en la consulta', () => {
    expect(destino('productos', 'reglas', ok)).toBe('productos?accion=reglas&aplicadas=2');
    expect(destino('productos/SKU-001', 'visibilidad', ok)).toBe(
      'productos/SKU-001?accion=visibilidad&aplicadas=2',
    );
    expect(destino('historicos?estado=propuesto&pagina=2', 'empates', ok)).toBe(
      'historicos?estado=propuesto&pagina=2&accion=empates&aplicadas=2',
    );
  });

  it('reemplaza el resultado anterior en vez de acumularlo', () => {
    expect(
      destino('conflictos?accion=reglas&aplicadas=9&error=viejo&pagina=2', 'conflictos', {
        aplicadas: 1,
        errores: ['nuevo'],
      }),
    ).toBe('conflictos?pagina=2&accion=conflictos&aplicadas=1&error=nuevo');
  });

  it('agrega cada error y corta en diez', () => {
    const errores = Array.from({ length: 15 }, (_, i) => `e${i}`);
    const q = new URLSearchParams(
      destino('reglas', 'reglas', { aplicadas: 0, errores }).split('?')[1],
    );
    expect(q.getAll('error')).toEqual(errores.slice(0, 10));
  });

  it('codifica los errores con caracteres especiales', () => {
    const d = destino('reglas', 'reglas', { aplicadas: 0, errores: ['a&b=c #d'] });
    expect(new URLSearchParams(d.split('?')[1]).get('error')).toBe('a&b=c #d');
  });

  it.each([
    null,
    '',
    '//evil.example.com',
    'https://evil.example.com',
    '../x',
    'productos/../../x',
    'productos/..',
    'productos/a/b',
    'productos/a\\b',
    '/productos',
    'desconocida',
    'productos#frag',
    'javascript:alert(1)',
    'productosx',
  ])('un volver no válido (%j) cae en flujos', (volver) => {
    expect(destino(volver, 'reglas', ok)).toBe('flujos?accion=reglas&aplicadas=2');
  });

  it('acepta cada sección del panel', () => {
    for (const s of [
      'flujos',
      'eventos',
      'productos',
      'historicos',
      'conflictos',
      'visibilidad',
      'reglas',
    ]) {
      expect(destino(s, 'reglas', ok).startsWith(`${s}?`)).toBe(true);
    }
  });
});

describe('avisoDe', () => {
  it('lee la acción, las aplicadas y los errores', () => {
    expect(avisoDe(new URLSearchParams('accion=reglas&aplicadas=3&error=uno&error=dos'))).toEqual({
      accion: 'reglas',
      aplicadas: 3,
      errores: ['uno', 'dos'],
    });
    expect(avisoDe(new URLSearchParams('accion=empates&aplicadas=0'))).toEqual({
      accion: 'empates',
      aplicadas: 0,
      errores: [],
    });
  });

  it('sin acción o con aplicadas inválidas no hay aviso', () => {
    expect(avisoDe(new URLSearchParams(''))).toBeNull();
    expect(avisoDe(new URLSearchParams('aplicadas=2'))).toBeNull();
    expect(avisoDe(new URLSearchParams('accion=reglas&aplicadas=-1'))).toBeNull();
    expect(avisoDe(new URLSearchParams('accion=reglas&aplicadas=1.5'))).toBeNull();
    expect(avisoDe(new URLSearchParams('accion=reglas&aplicadas=abc'))).toBeNull();
  });

  it('acota la acción a 40, los errores a 10 y cada error a 300 caracteres', () => {
    const q = new URLSearchParams([
      ['accion', 'x'.repeat(100)],
      ['aplicadas', '1'],
      ...Array.from({ length: 12 }, (): [string, string] => ['error', 'y'.repeat(500)]),
    ]);
    const a = avisoDe(q);
    expect(a?.accion).toHaveLength(40);
    expect(a?.errores).toHaveLength(10);
    expect(a?.errores.every((e) => e.length === 300)).toBe(true);
  });

  it('es la inversa de destino', () => {
    const d = destino('productos?q=a', 'visibilidad', { aplicadas: 1, errores: ['falló <b>'] });
    expect(avisoDe(new URLSearchParams(d.split('?')[1]))).toEqual({
      accion: 'visibilidad',
      aplicadas: 1,
      errores: ['falló <b>'],
    });
  });
});

describe('mismoOrigen', () => {
  const host = '127.0.0.1:4000';

  it('detrás del reenvío compara Origin con X-Forwarded-Host', () => {
    const interno = { host: 'conector:8080', origin: 'https://facturacion.ejemplo' };
    expect(mismoOrigen(req({ ...interno, 'x-forwarded-host': 'facturacion.ejemplo' }))).toBe(true);
    expect(
      mismoOrigen(req({ ...interno, 'x-forwarded-host': 'facturacion.ejemplo, conector:8080' })),
    ).toBe(true);
    expect(mismoOrigen(req({ ...interno, 'x-forwarded-host': 'otro.ejemplo' }))).toBe(false);
    expect(mismoOrigen(req(interno))).toBe(false);
  });

  it('sin cabeceras de navegador pasa (curl, pruebas)', () => {
    expect(mismoOrigen(req({ host }))).toBe(true);
  });

  it('Sec-Fetch-Site: sólo same-origin y none pasan', () => {
    expect(mismoOrigen(req({ host, 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(mismoOrigen(req({ host, 'sec-fetch-site': 'none' }))).toBe(true);
    expect(mismoOrigen(req({ host, 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(mismoOrigen(req({ host, 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(mismoOrigen(req({ host, 'sec-fetch-site': '' }))).toBe(false);
  });

  it('Origin: pasa si es el mismo host, falla si no', () => {
    expect(mismoOrigen(req({ host, origin: `http://${host}` }))).toBe(true);
    expect(mismoOrigen(req({ host, origin: 'http://otro.example.com' }))).toBe(false);
    expect(mismoOrigen(req({ host, origin: 'http://127.0.0.1:4001' }))).toBe(false);
  });

  it('un Origin ilegible, "null" o sin Host falla', () => {
    expect(mismoOrigen(req({ host, origin: 'null' }))).toBe(false);
    expect(mismoOrigen(req({ host, origin: 'no es url' }))).toBe(false);
    expect(mismoOrigen(req({ origin: `http://${host}` }))).toBe(false);
  });

  it('Origin "null" (lo que manda el navegador con referrer-policy no-referrer) falla', () => {
    expect(mismoOrigen(req({ host, origin: 'null', 'sec-fetch-site': 'same-origin' }))).toBe(false);
  });

  it('Sec-Fetch-Site cross-site falla aunque el Origin coincida', () => {
    expect(
      mismoOrigen(req({ host, origin: `http://${host}`, 'sec-fetch-site': 'cross-site' })),
    ).toBe(false);
  });

  it('con cabeceras repetidas toma la primera', () => {
    expect(mismoOrigen(req({ host, 'sec-fetch-site': ['same-origin', 'cross-site'] }))).toBe(true);
  });
});

describe('destino y avisoDe: bordes', () => {
  it('sólo productos admite un segundo segmento', () => {
    expect(destino('eventos/x', 'reglas', { aplicadas: 1, errores: [] })).toMatch(/^flujos\?/);
    expect(destino('productos/SKU-1', 'reglas', { aplicadas: 1, errores: [] })).toMatch(
      /^productos\/SKU-1\?/,
    );
  });

  it('conserva la consulta entera aunque traiga otro «?»', () => {
    const r = destino('productos?q=a?b', 'reglas', { aplicadas: 0, errores: [] });
    expect(new URLSearchParams(r.slice(r.indexOf('?') + 1)).get('q')).toBe('a?b');
  });

  it('sin «aplicadas» no hay aviso', () => {
    expect(avisoDe(new URLSearchParams('accion=reglas'))).toBeNull();
  });
});

describe('cuerpoDe: alta y edición', () => {
  it('alta: precio numérico, categoría vacía omitida, casillas y aprobación', () => {
    expect(
      cuerpoDe(
        'alta',
        form(
          ['sku', 'N-1'],
          ['nombre', 'Tubo'],
          ['precio', '1200'],
          ['tipo', 'bien'],
          ['categoria', ''],
          ['activo', '1'],
          ['aprobar_web', '1'],
        ),
      ),
    ).toEqual({
      sku: 'N-1',
      nombre: 'Tubo',
      precio: 1200,
      tipo: 'bien',
      exento: false,
      activo: true,
      visibilidad: 'aprobado',
    });
    expect(
      cuerpoDe(
        'alta',
        form(
          ['sku', 'N-2'],
          ['nombre', 'X'],
          ['precio', ''],
          ['tipo', 'servicio'],
          ['categoria', 'C'],
          ['exento', '1'],
        ),
      ),
    ).toEqual({
      sku: 'N-2',
      nombre: 'X',
      precio: '',
      tipo: 'servicio',
      categoria: 'C',
      exento: true,
      activo: false,
    });
    expect(cuerpoDe('alta', form(['precio', 'abc']))).toMatchObject({ precio: 'abc' });
  });

  it('edicion: sólo los campos que difieren de su antes_', () => {
    expect(
      cuerpoDe(
        'edicion',
        form(
          ['sku', 'A'],
          ['nombre', 'Nuevo'],
          ['antes_nombre', 'Viejo'],
          ['precio', '500'],
          ['antes_precio', '500'],
          ['tipo', 'bien'],
          ['antes_tipo', 'bien'],
          ['categoria', ''],
          ['antes_categoria', ''],
          ['activo', '1'],
          ['antes_activo', 'true'],
          ['antes_exento', 'false'],
        ),
      ),
    ).toEqual({ sku: 'A', campos: { nombre: 'Nuevo' } });
  });

  it('edicion: precio numérico y casillas que se marcan o se desmarcan', () => {
    expect(
      cuerpoDe(
        'edicion',
        form(
          ['sku', 'A'],
          ['precio', '700'],
          ['antes_precio', '500'],
          ['exento', '1'],
          ['antes_exento', 'false'],
          ['antes_activo', 'true'],
        ),
      ),
    ).toEqual({ sku: 'A', campos: { precio: 700, exento: true, activo: false } });
  });

  it('edicion: sin cambios deja campos vacío; un precio ilegible pasa tal cual', () => {
    expect(cuerpoDe('edicion', form(['sku', 'A'], ['nombre', 'N'], ['antes_nombre', 'N']))).toEqual(
      { sku: 'A', campos: {} },
    );
    expect(cuerpoDe('edicion', form(['sku', 'A'], ['precio', 'x'], ['antes_precio', '5']))).toEqual(
      {
        sku: 'A',
        campos: { precio: 'x' },
      },
    );
  });
});
