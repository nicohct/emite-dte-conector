/**
 * Propuesta pura de empate entre un producto histórico de Emite DTE y un SKU canónico (Coreinbox y
 * web). Sin red ni disco: sólo propone el mejor candidato con puntaje y motivo; decidir es de una
 * persona.
 */

export type MotivoEmpate = 'codigo' | 'alias' | 'codigo_normalizado' | 'nombre' | 'parecido';

export interface Historico {
  emiteId: string;
  codigo: string;
  nombre: string;
}

export interface Canonico {
  sku: string;
  nombres: string[];
}

export interface Candidato {
  sku: string;
  puntaje: number;
  motivo: MotivoEmpate;
  detalle: string;
}

export const UMBRAL_PARECIDO = 0.6;

const PUNTAJE_CODIGO = 1;
const PUNTAJE_ALIAS = 0.95;
const PUNTAJE_CODIGO_NORMALIZADO = 0.9;
const PUNTAJE_NOMBRE = 0.85;
const FACTOR_PARECIDO = 0.8;

/** Minúsculas, sin tildes, todo lo que no sea letra o dígito pasa a un espacio, sin bordes. */
export function normalizarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type Bigramas = ReadonlyMap<string, number>;

/** Multiconjunto de bigramas del texto ya normalizado; un solo carácter es su propio «bigrama». */
function bigramasDe(normalizado: string): { mapa: Bigramas; total: number } {
  const mapa = new Map<string, number>();
  if (normalizado.length === 0) return { mapa, total: 0 };
  if (normalizado.length === 1) {
    mapa.set(normalizado, 1);
    return { mapa, total: 1 };
  }
  const total = normalizado.length - 1;
  for (let i = 0; i < total; i++) {
    const par = normalizado.slice(i, i + 2);
    mapa.set(par, (mapa.get(par) ?? 0) + 1);
  }
  return { mapa, total };
}

function dice(a: Bigramas, totalA: number, b: Bigramas, totalB: number): number {
  if (totalA === 0 || totalB === 0) return 0;
  const [chico, grande] = a.size <= b.size ? [a, b] : [b, a];
  let comun = 0;
  for (const [par, n] of chico) comun += Math.min(n, grande.get(par) ?? 0);
  return (2 * comun) / (totalA + totalB);
}

/** Coeficiente de Dice sobre los bigramas de los textos normalizados, entre 0 y 1. */
export function similitud(a: string, b: string): number {
  const ba = bigramasDe(normalizarTexto(a));
  const bb = bigramasDe(normalizarTexto(b));
  return dice(ba.mapa, ba.total, bb.mapa, bb.total);
}

interface NombreIndexado {
  sku: string;
  original: string;
  mapa: Bigramas;
  total: number;
}

/** Índice precalculado de los canónicos para no recalcular bigramas por cada histórico. */
export interface IndiceCanonicos {
  skus: ReadonlySet<string>;
  porCodigoNormalizado: ReadonlyMap<string, readonly string[]>;
  porNombre: ReadonlyMap<string, readonly string[]>;
  nombres: readonly NombreIndexado[];
}

const porSku = (a: string, b: string): number => a.localeCompare(b);

function agregar(mapa: Map<string, string[]>, clave: string, sku: string): void {
  if (clave === '') return;
  const lista = mapa.get(clave);
  if (lista === undefined) mapa.set(clave, [sku]);
  else if (!lista.includes(sku)) lista.push(sku);
}

export function indexarCanonicos(canonicos: Canonico[]): IndiceCanonicos {
  const skus = new Set<string>();
  const porCodigoNormalizado = new Map<string, string[]>();
  const porNombre = new Map<string, string[]>();
  const nombres: NombreIndexado[] = [];

  for (const canonico of canonicos) {
    skus.add(canonico.sku);
    agregar(porCodigoNormalizado, normalizarTexto(canonico.sku).replaceAll(' ', ''), canonico.sku);
    const vistos = new Set<string>();
    for (const original of canonico.nombres) {
      const normalizado = normalizarTexto(original);
      if (normalizado === '' || vistos.has(normalizado)) continue;
      vistos.add(normalizado);
      agregar(porNombre, normalizado, canonico.sku);
      const { mapa, total } = bigramasDe(normalizado);
      nombres.push({ sku: canonico.sku, original: original.trim(), mapa, total });
    }
  }

  for (const lista of porCodigoNormalizado.values()) lista.sort(porSku);
  for (const lista of porNombre.values()) lista.sort(porSku);
  return { skus, porCodigoNormalizado, porNombre, nombres };
}

function elegir(
  skus: readonly string[] | undefined,
  rechazados: ReadonlySet<string>,
): { sku: string; otros: string[] } | null {
  const validos = (skus ?? []).filter((sku) => !rechazados.has(sku));
  const [sku, ...otros] = validos;
  return sku === undefined ? null : { sku, otros };
}

function tambien(otros: string[]): string {
  return otros.length > 0 ? ` (también: ${otros.join(', ')})` : '';
}

/**
 * El mejor canónico para un histórico, o `null`. Precedencia: código exacto, alias, código
 * normalizado, nombre normalizado y nombre parecido. Los SKU de `rechazados` nunca se proponen.
 */
export function proponerEmpate(
  historico: Historico,
  indice: IndiceCanonicos,
  opciones: { aliasDe?: string | null; rechazados?: ReadonlySet<string> } = {},
): Candidato | null {
  const rechazados = opciones.rechazados ?? new Set<string>();
  const codigo = historico.codigo.trim();

  if (codigo !== '' && indice.skus.has(codigo) && !rechazados.has(codigo)) {
    return {
      sku: codigo,
      puntaje: PUNTAJE_CODIGO,
      motivo: 'codigo',
      detalle: 'el código del histórico es el SKU',
    };
  }

  const alias = opciones.aliasDe;
  if (alias !== undefined && alias !== null && alias !== '' && !rechazados.has(alias)) {
    return {
      sku: alias,
      puntaje: PUNTAJE_ALIAS,
      motivo: 'alias',
      detalle: 'Emite DTE resuelve el SKU como alias de este histórico',
    };
  }

  const codigoNormalizado = normalizarTexto(codigo).replaceAll(' ', '');
  if (codigoNormalizado !== '') {
    const elegido = elegir(indice.porCodigoNormalizado.get(codigoNormalizado), rechazados);
    if (elegido !== null) {
      return {
        sku: elegido.sku,
        puntaje: PUNTAJE_CODIGO_NORMALIZADO,
        motivo: 'codigo_normalizado',
        detalle: `mismo código sin signos ni mayúsculas${tambien(elegido.otros)}`,
      };
    }
  }

  const nombre = normalizarTexto(historico.nombre);
  if (nombre === '') return null;

  const porNombre = elegir(indice.porNombre.get(nombre), rechazados);
  if (porNombre !== null) {
    return {
      sku: porNombre.sku,
      puntaje: PUNTAJE_NOMBRE,
      motivo: 'nombre',
      detalle: `mismo nombre normalizado: "${nombre}"${tambien(porNombre.otros)}`,
    };
  }

  const { mapa, total } = bigramasDe(nombre);
  let mejor: { sku: string; valor: number; original: string } | null = null;
  for (const candidato of indice.nombres) {
    if (rechazados.has(candidato.sku)) continue;
    const valor = dice(mapa, total, candidato.mapa, candidato.total);
    if (valor < UMBRAL_PARECIDO) continue;
    if (
      mejor === null ||
      valor > mejor.valor ||
      (valor === mejor.valor && candidato.sku.localeCompare(mejor.sku) < 0)
    ) {
      mejor = { sku: candidato.sku, valor, original: candidato.original };
    }
  }
  if (mejor === null) return null;

  return {
    sku: mejor.sku,
    puntaje: Math.round(FACTOR_PARECIDO * mejor.valor * 1000) / 1000,
    motivo: 'parecido',
    detalle: `nombre parecido (${mejor.valor.toFixed(2)}) a "${mejor.original}"`,
  };
}
