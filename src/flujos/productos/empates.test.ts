import { describe, expect, it } from 'vitest';
import {
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
    const c = proponerEmpate(historico(' SKU-001 ', 'cualquiera'), indice);
    expect(c).toEqual({
      sku: 'SKU-001',
      puntaje: 1,
      motivo: 'codigo',
      detalle: 'el código del histórico es el SKU',
    });
  });

  it('alias: usa aliasDe con 0.95', () => {
    const c = proponerEmpate(historico('X9', 'Otra cosa'), indice, { aliasDe: 'SKU-001' });
    expect(c?.motivo).toBe('alias');
    expect(c?.sku).toBe('SKU-001');
    expect(c?.puntaje).toBe(0.95);
  });

  it('codigo gana sobre alias', () => {
    const c = proponerEmpate(historico('VAL-ESF-12', 'x'), indice, { aliasDe: 'SKU-001' });
    expect(c?.motivo).toBe('codigo');
    expect(c?.sku).toBe('VAL-ESF-12');
  });

  it('alias gana sobre nombre', () => {
    const c = proponerEmpate(historico('X9', 'Servicio de mantención'), indice, {
      aliasDe: 'VAL-ESF-12',
    });
    expect(c?.motivo).toBe('alias');
    expect(c?.sku).toBe('VAL-ESF-12');
  });

  it('codigo_normalizado: ignora signos y mayúsculas, puntaje 0.9', () => {
    const c = proponerEmpate(historico('val esf.12', 'zzz'), indice);
    expect(c).toMatchObject({
      sku: 'VAL-ESF-12',
      puntaje: 0.9,
      motivo: 'codigo_normalizado',
      detalle: 'mismo código sin signos ni mayúsculas',
    });
  });

  it('nombre: mismo nombre normalizado, puntaje 0.85', () => {
    const c = proponerEmpate(historico('MAL', 'VÁLVULA  esfera, 1/2'), indice);
    expect(c).toMatchObject({
      sku: 'VAL-ESF-12',
      puntaje: 0.85,
      motivo: 'nombre',
      detalle: 'mismo nombre normalizado: "valvula esfera 1 2"',
    });
  });

  it('parecido: puntaje 0.8 * similitud redondeado a 3 decimales', () => {
    const h = historico('MAL', 'Servicio de mantencion mensual');
    const c = proponerEmpate(h, indice);
    const s = similitud('Servicio de mantencion mensual', 'Servicio de mantención');
    expect(c?.motivo).toBe('parecido');
    expect(c?.sku).toBe('SKU-001');
    expect(c?.puntaje).toBe(Math.round(0.8 * s * 1000) / 1000);
    expect(c?.detalle).toBe(`nombre parecido (${s.toFixed(2)}) a "Servicio de mantención"`);
  });

  it('bajo el umbral devuelve null', () => {
    expect(similitud('Tornillo galvanizado', 'Servicio de mantención')).toBeLessThan(
      UMBRAL_PARECIDO,
    );
    expect(proponerEmpate(historico('MAL', 'Tornillo galvanizado'), indice)).toBeNull();
  });

  it('nombre vacío y sin código útil devuelve null', () => {
    expect(proponerEmpate(historico('', ''), indice)).toBeNull();
    expect(proponerEmpate(historico('--', '  '), indice)).toBeNull();
  });

  it('canónicos con nombres vacíos no rompen el índice', () => {
    const solo = indexarCanonicos([{ sku: 'SKU-002', nombres: ['', '  '] }]);
    expect(proponerEmpate(historico('MAL', 'algo'), solo)).toBeNull();
    expect(proponerEmpate(historico('sku 002', 'algo'), solo)?.sku).toBe('SKU-002');
  });

  describe('rechazados', () => {
    it('salta el código rechazado y sigue con otras reglas', () => {
      const c = proponerEmpate(historico('SKU-001', 'Servicio de mantención'), indice, {
        rechazados: new Set(['SKU-001']),
      });
      expect(c).toBeNull();
    });

    it('salta un alias rechazado y cae al nombre', () => {
      const c = proponerEmpate(historico('X9', 'Servicio de mantención'), indice, {
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
      expect(c?.sku).toBe('SKU-B');
      expect(c?.detalle).toContain('también: SKU-C');
    });

    it('pasa al segundo más parecido', () => {
      const dos = indexarCanonicos([
        { sku: 'SKU-1', nombres: ['Servicio de mantención mensual'] },
        { sku: 'SKU-2', nombres: ['Servicio de mantención anual'] },
      ]);
      const h = historico('MAL', 'Servicio de mantencion mensual x');
      expect(proponerEmpate(h, dos)?.sku).toBe('SKU-1');
      expect(proponerEmpate(h, dos, { rechazados: new Set(['SKU-1']) })?.sku).toBe('SKU-2');
    });

    it('pasa de una regla a otra cuando el único acierto está rechazado', () => {
      const c = proponerEmpate(historico('val-esf-12', 'Valvula esfera 1/2'), indice, {
        rechazados: new Set(['VAL-ESF-12']),
      });
      expect(c).toBeNull();
      const dos = indexarCanonicos([
        { sku: 'VAL-ESF-12', nombres: ['Otro'] },
        { sku: 'SKU-009', nombres: ['Valvula esfera 1/2'] },
      ]);
      const d = proponerEmpate(historico('val-esf-12', 'Valvula esfera 1/2'), dos, {
        rechazados: new Set(['VAL-ESF-12']),
      });
      expect(d).toMatchObject({ sku: 'SKU-009', motivo: 'nombre' });
    });
  });

  describe('empates', () => {
    it('código normalizado repetido elige el menor SKU y lista los otros', () => {
      const dupes = indexarCanonicos([
        { sku: 'AB-1', nombres: [] },
        { sku: 'A-B1', nombres: [] },
        { sku: 'a b 1', nombres: [] },
      ]);
      const c = proponerEmpate(historico('ab1', ''), dupes);
      expect(c?.motivo).toBe('codigo_normalizado');
      expect(c?.sku).toBe('a b 1');
      expect(c?.detalle).toContain('también: ');
      expect(c?.detalle).toContain('A-B1');
      expect(c?.detalle).toContain('AB-1');
    });

    it('nombre repetido elige el menor SKU y menciona los demás', () => {
      const dupes = indexarCanonicos([
        { sku: 'SKU-C', nombres: ['Pieza común'] },
        { sku: 'SKU-A', nombres: ['Pieza común'] },
        { sku: 'SKU-B', nombres: ['Pieza común'] },
      ]);
      const c = proponerEmpate(historico('MAL', 'Pieza comun'), dupes);
      expect(c?.sku).toBe('SKU-A');
      expect(c?.detalle).toBe('mismo nombre normalizado: "pieza comun" (también: SKU-B, SKU-C)');
    });

    it('similitud empatada elige el SKU menor', () => {
      const dupes = indexarCanonicos([
        { sku: 'SKU-2', nombres: ['Servicio de mantención'] },
        { sku: 'SKU-1', nombres: ['Servicio de mantención'] },
      ]);
      expect(proponerEmpate(historico('MAL', 'Servicio mantención extra'), dupes)?.sku).toBe(
        'SKU-1',
      );
    });
  });
});
