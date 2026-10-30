import { describe, expect, it } from 'vitest';
import {
  MAX_CANDIDATOS,
  UMBRAL_PARECIDO,
  indexarCanonicos,
  normalizarTexto,
  proponerEmpate,
  similitud,
  type Canonico,
  type Historico,
} from './empates.js';

const historico = (codigo: string, nombre: string): Historico => ({
  emiteId: 'h-1',
  codigo,
  nombre,
});

const canonicos: Canonico[] = [
  { sku: 'VAL-ESF-12', nombres: ['Válvula esfera 1/2', 'Valvula esfera media pulgada'] },
  { sku: 'SKU-001', nombres: ['Servicio de mantención'] },
  { sku: 'SKU-002', nombres: [] },
];

describe('normalizarTexto', () => {
  it('quita tildes, signos y mayúsculas', () => {
    expect(normalizarTexto('Válvula  Esfera, 1/2"')).toBe('valvula esfera 1 2');
  });

  it('convierte la ñ en n y colapsa espacios', () => {
    expect(normalizarTexto('  Cañería   PVC  ')).toBe('caneria pvc');
  });

  it('trata los guiones como separadores', () => {
    expect(normalizarTexto('VAL-ESF_12')).toBe('val esf 12');
  });

  it('devuelve vacío si no hay letras ni dígitos', () => {
    expect(normalizarTexto(' -- ¿? ')).toBe('');
  });
});

describe('similitud', () => {
  it('iguales no vacíos dan 1', () => {
    expect(similitud('Válvula', 'valvula')).toBe(1);
  });

  it('disjuntos dan 0', () => {
    expect(similitud('abc', 'xyz')).toBe(0);
  });

  it('vacíos dan 0', () => {
    expect(similitud('', '')).toBe(0);
    expect(similitud('', 'abc')).toBe(0);
  });

  it('es simétrica', () => {
    expect(similitud('servicio mantencion', 'mantencion de servicio')).toBe(
      similitud('mantencion de servicio', 'servicio mantencion'),
    );
  });

  it('calcula el valor conocido night/nacht = 0.25', () => {
    expect(similitud('night', 'nacht')).toBe(0.25);
  });

  it('un carácter es su propio bigrama', () => {
    expect(similitud('a', 'a')).toBe(1);
    expect(similitud('a', 'b')).toBe(0);
  });

  it('cuenta bigramas repetidos como multiconjunto', () => {
    // «aaa» = {aa:2}, «aa» = {aa:1}: 2*1/3
    expect(similitud('aaa', 'aa')).toBeCloseTo(2 / 3, 10);
  });
});

describe('proponerEmpate', () => {
  const indice = indexarCanonicos(canonicos);

  it('codigo: el código es el SKU, puntaje 1', () => {
    const [c] = proponerEmpate(historico(' SKU-001 ', 'cualquiera'), indice);
    expect(c).toEqual({
      sku: 'SKU-001',
      puntaje: 1,
      motivo: 'codigo',
      detalle: 'el código del histórico es el SKU',
    });
  });

  it('alias: usa aliasDe con 0.95', () => {
    const [c] = proponerEmpate(historico('X9', 'Otra cosa'), indice, { aliasDe: 'SKU-001' });
    expect(c?.motivo).toBe('alias');
    expect(c?.sku).toBe('SKU-001');
    expect(c?.puntaje).toBe(0.95);
  });

  it('codigo gana sobre alias', () => {
    const [c] = proponerEmpate(historico('VAL-ESF-12', 'x'), indice, { aliasDe: 'SKU-001' });
    expect(c?.motivo).toBe('codigo');
    expect(c?.sku).toBe('VAL-ESF-12');
  });

  it('alias gana sobre nombre', () => {
    const [c] = proponerEmpate(historico('X9', 'Servicio de mantención'), indice, {
      aliasDe: 'VAL-ESF-12',
    });
    expect(c?.motivo).toBe('alias');
    expect(c?.sku).toBe('VAL-ESF-12');
  });

  it('codigo_normalizado: ignora signos y mayúsculas, puntaje 0.9', () => {
    const [c] = proponerEmpate(historico('val esf.12', 'zzz'), indice);
    expect(c).toMatchObject({
      sku: 'VAL-ESF-12',
      puntaje: 0.9,
      motivo: 'codigo_normalizado',
      detalle: 'mismo código sin signos ni mayúsculas',
    });
  });

  it('nombre: mismo nombre normalizado, puntaje 0.85', () => {
    const [c] = proponerEmpate(historico('MAL', 'VÁLVULA  esfera, 1/2'), indice);
    expect(c).toMatchObject({
      sku: 'VAL-ESF-12',
      puntaje: 0.85,
      motivo: 'nombre',
      detalle: 'mismo nombre normalizado: "valvula esfera 1 2"',
    });
  });

  it('parecido: puntaje 0.8 * similitud redondeado a 3 decimales', () => {
    const h = historico('MAL', 'Servicio de mantencion mensual');
    const [c] = proponerEmpate(h, indice);
    const s = similitud('Servicio de mantencion mensual', 'Servicio de mantención');
    expect(c?.motivo).toBe('parecido');
    expect(c?.sku).toBe('SKU-001');
    expect(c?.puntaje).toBe(Math.round(0.8 * s * 1000) / 1000);
    expect(c?.detalle).toBe(`nombre parecido (${s.toFixed(2)}) a "Servicio de mantención"`);
  });

  it('bajo el umbral devuelve null', () => {
    expect(similitud('Tornillo galvanizado', 'Servicio de mantención')).toBeLessThan(
      MAX_CANDIDATOS,
      UMBRAL_PARECIDO,
    );
    expect(proponerEmpate(historico('MAL', 'Tornillo galvanizado'), indice)).toEqual([]);
  });

  it('nombre vacío y sin código útil devuelve null', () => {
    expect(proponerEmpate(historico('', ''), indice)).toEqual([]);
    expect(proponerEmpate(historico('--', '  '), indice)).toEqual([]);
  });

  it('canónicos con nombres vacíos no rompen el índice', () => {
    const solo = indexarCanonicos([{ sku: 'SKU-002', nombres: ['', '  '] }]);
    expect(proponerEmpate(historico('MAL', 'algo'), solo)).toEqual([]);
    expect(proponerEmpate(historico('sku 002', 'algo'), solo)[0]?.sku).toBe('SKU-002');
  });

  describe('rechazados', () => {
    it('salta el código rechazado y sigue con otras reglas', () => {
      const c = proponerEmpate(historico('SKU-001', 'Servicio de mantención'), indice, {
        rechazados: new Set(['SKU-001']),
      });
      expect(c).toEqual([]);
    });

    it('salta un alias rechazado y cae al nombre', () => {
      const [c] = proponerEmpate(historico('X9', 'Servicio de mantención'), indice, {
        aliasDe: 'VAL-ESF-12',
        rechazados: new Set(['VAL-ESF-12']),
      });
      expect(c?.motivo).toBe('nombre');
      expect(c?.sku).toBe('SKU-001');
    });

    it('pasa al siguiente dentro de la misma regla', () => {
      const dupes = indexarCanonicos([
        { sku: 'SKU-B', nombres: ['Pieza común'] },
        { sku: 'SKU-A', nombres: ['Pieza común'] },
        { sku: 'SKU-C', nombres: ['Pieza común'] },
      ]);
      const c = proponerEmpate(historico('MAL', 'pieza comun'), dupes, {
        rechazados: new Set(['SKU-A']),
      });
      expect(c.map((x) => x.sku)).toEqual(['SKU-B', 'SKU-C']);
    });

    it('pasa al segundo más parecido', () => {
      const dos = indexarCanonicos([
        { sku: 'SKU-1', nombres: ['Servicio de mantención mensual'] },
        { sku: 'SKU-2', nombres: ['Servicio de mantención anual'] },
      ]);
      const h = historico('MAL', 'Servicio de mantencion mensual x');
      expect(proponerEmpate(h, dos)[0]?.sku).toBe('SKU-1');
      expect(proponerEmpate(h, dos, { rechazados: new Set(['SKU-1']) })[0]?.sku).toBe('SKU-2');
    });

    it('pasa de una regla a otra cuando el único acierto está rechazado', () => {
      const c = proponerEmpate(historico('val-esf-12', 'Valvula esfera 1/2'), indice, {
        rechazados: new Set(['VAL-ESF-12']),
      });
      expect(c).toEqual([]);
      const dos = indexarCanonicos([
        { sku: 'VAL-ESF-12', nombres: ['Otro'] },
        { sku: 'SKU-009', nombres: ['Valvula esfera 1/2'] },
      ]);
      const [d] = proponerEmpate(historico('val-esf-12', 'Valvula esfera 1/2'), dos, {
        rechazados: new Set(['VAL-ESF-12']),
      });
      expect(d).toMatchObject({ sku: 'SKU-009', motivo: 'nombre' });
    });
  });

  describe('empates', () => {
    it('código normalizado repetido propone cada SKU, el menor primero', () => {
      const dupes = indexarCanonicos([
        { sku: 'AB-1', nombres: [] },
        { sku: 'A-B1', nombres: [] },
        { sku: 'a b 1', nombres: [] },
      ]);
      const c = proponerEmpate(historico('ab1', ''), dupes);
      expect(c.map((x) => [x.sku, x.motivo])).toEqual([
        ['a b 1', 'codigo_normalizado'],
        ['A-B1', 'codigo_normalizado'],
        ['AB-1', 'codigo_normalizado'],
      ]);
    });

    it('nombre repetido propone cada SKU, el menor primero', () => {
      const dupes = indexarCanonicos([
        { sku: 'SKU-C', nombres: ['Pieza común'] },
        { sku: 'SKU-A', nombres: ['Pieza común'] },
        { sku: 'SKU-B', nombres: ['Pieza común'] },
      ]);
      const c = proponerEmpate(historico('MAL', 'Pieza comun'), dupes);
      expect(c.map((x) => x.sku)).toEqual(['SKU-A', 'SKU-B', 'SKU-C']);
      expect(c[0]?.detalle).toBe('mismo nombre normalizado: "pieza comun"');
    });

    it('similitud empatada elige el SKU menor', () => {
      const dupes = indexarCanonicos([
        { sku: 'SKU-2', nombres: ['Servicio de mantención'] },
        { sku: 'SKU-1', nombres: ['Servicio de mantención'] },
      ]);
      expect(proponerEmpate(historico('MAL', 'Servicio mantención extra'), dupes)[0]?.sku).toBe(
        'SKU-1',
      );
    });
  });

  describe('varios candidatos', () => {
    const parecidos = indexarCanonicos([
      { sku: 'MOP-1', nombres: ['Mopa industrial algodón 60 cm'] },
      { sku: 'MOP-2', nombres: ['Mopa industrial algodón 80 cm'] },
      { sku: 'MOP-3', nombres: ['Mopa industrial algodon 40 cm'] },
      { sku: 'MOP-4', nombres: ['Mopa industrial microfibra 60 cm'] },
      { sku: 'BAL-1', nombres: ['Balde con estrujador'] },
    ]);
    const h = historico('MAL', 'Mopa industrial algodon 60cm');

    it(`propone hasta ${MAX_CANDIDATOS} SKU distintos, mejor primero`, () => {
      const c = proponerEmpate(h, parecidos);
      expect(c).toHaveLength(MAX_CANDIDATOS);
      expect(c[0]?.sku).toBe('MOP-1');
      expect(new Set(c.map((x) => x.sku)).size).toBe(c.length);
      for (let i = 1; i < c.length; i++) {
        expect(c[i]!.puntaje).toBeLessThanOrEqual(c[i - 1]!.puntaje);
      }
      expect(c.map((x) => x.sku)).not.toContain('BAL-1');
    });

    it('sin rechazados repetidos: rechazar el primero trae el siguiente sobre el umbral', () => {
      const antes = proponerEmpate(h, parecidos).map((x) => x.sku);
      const despues = proponerEmpate(h, parecidos, { rechazados: new Set([antes[0]!]) });
      expect(despues.map((x) => x.sku)).toEqual([
        ...antes.slice(1),
        expect.not.stringMatching(antes[0]!),
      ]);
      expect(despues).toHaveLength(MAX_CANDIDATOS);
    });

    it('mezcla reglas sin repetir SKU: código exacto y después los parecidos', () => {
      const c = proponerEmpate(historico('MOP-2', 'Mopa industrial algodon 60cm'), parecidos);
      expect(c.map((x) => [x.sku, x.motivo])).toEqual([
        ['MOP-2', 'codigo'],
        ['MOP-1', 'parecido'],
        [expect.any(String), 'parecido'],
      ]);
      expect(c[2]?.sku).not.toBe('MOP-2');
    });

    it('un SKU con varios nombres parecidos aparece una sola vez', () => {
      const c = proponerEmpate(historico('MAL', 'Válvula esfera 1/2 pulgada'), indice);
      expect(c.map((x) => x.sku)).toEqual(['VAL-ESF-12']);
    });
  });
});
