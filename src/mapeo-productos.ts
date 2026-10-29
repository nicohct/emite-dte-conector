/**
 * Traducción pura de un producto de Coreinbox al cuerpo de `POST /productos` de Emite DTE. Sin
 * red: las categorías se piden antes y se pasan aquí.
 *
 * - La clave de correspondencia es el **SKU** de Coreinbox = `codigo` de Emite DTE (CdgItem, 35
 *   caracteres). Sin SKU el producto no viaja.
 * - El precio es el `unitPrice` base, neto y en pesos; las listas de precios de Coreinbox no se
 *   miran. Otra moneda no viaja.
 * - `exento` si el producto no lleva impuesto (`isTaxable: false`) o su `taxRate` es 0.
 */
import type { CategoriaCoreinbox, ProductoCoreinbox } from './coreinbox.js';
import type { ProductoNuevo } from './emite.js';
import { ErrorMapeo, conValor, corta, num } from './mapeo.js';

export const LARGO_CODIGO = 35;
export const LARGO_NOMBRE = 80;
export const LARGO_CATEGORIA = 60;

export interface ProductoMapeado {
  datos: ProductoNuevo;
  avisos: string[];
}

/** Unidades frecuentes de Coreinbox (texto libre) en las siglas de 4 caracteres del SII. */
const UNIDADES: Record<string, string> = {
  UNIDAD: 'UN',
  UNIDADES: 'UN',
  UN: 'UN',
  UND: 'UN',
  U: 'UN',
  C_U: 'UN',
  CU: 'UN',
  HORA: 'HRS',
  HORAS: 'HRS',
  HR: 'HRS',
  HRS: 'HRS',
  H: 'HRS',
  DIA: 'DIA',
  DIAS: 'DIA',
  D: 'DIA',
  MES: 'MES',
  MESES: 'MES',
  ANO: 'AÑO',
  ANOS: 'AÑO',
  KILO: 'KG',
  KILOS: 'KG',
  KILOGRAMO: 'KG',
  KILOGRAMOS: 'KG',
  KG: 'KG',
  GRAMO: 'GR',
  GRAMOS: 'GR',
  G: 'GR',
  GR: 'GR',
  METRO: 'MT',
  METROS: 'MT',
  M: 'MT',
  MT: 'MT',
  MTS: 'MT',
  METRO_CUADRADO: 'M2',
  M2: 'M2',
  LITRO: 'LT',
  LITROS: 'LT',
  L: 'LT',
  LT: 'LT',
  LTS: 'LT',
  CAJA: 'CAJA',
  CAJAS: 'CAJA',
  PAR: 'PAR',
  PARES: 'PAR',
  SERVICIO: 'SERV',
  SERVICIOS: 'SERV',
  LICENCIA: 'LIC',
  LICENCIAS: 'LIC',
  GLOBAL: 'GL',
  GL: 'GL',
};

/**
 * La unidad en los 4 caracteres de UnmdItem: las conocidas por su sigla; el resto, en mayúsculas
 * y sin acentos, recortado. Vacía → `undefined` (Emite DTE pone `UN`).
 */
export function unidadEmite(unit: string | null | undefined): string | undefined {
  const texto = unit?.trim();
  if (!texto) return undefined;
  const clave = texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const conocida = UNIDADES[clave];
  if (conocida) return conocida;
  const sigla = clave.replace(/_/g, '').slice(0, 4);
  return sigla || undefined;
}

export function armarProducto(
  p: ProductoCoreinbox,
  categorias: Map<string, CategoriaCoreinbox>,
  emisorId: string,
): ProductoMapeado {
  const avisos: string[] = [];
  const codigo = p.sku?.trim() ?? '';
  const nombre = p.name.trim() || codigo;

  if (!codigo) {
    throw new ErrorMapeo('SIN_SKU', `El producto «${nombre}» no tiene SKU en Coreinbox`);
  }
  if (codigo.length > LARGO_CODIGO) {
    throw new ErrorMapeo(
      'SKU_LARGO',
      `El SKU «${codigo}» supera los ${LARGO_CODIGO} caracteres del código de ítem del SII`,
    );
  }
  if (p.currencyCode !== 'CLP') {
    throw new ErrorMapeo(
      'MONEDA',
      `El producto «${codigo}» está en ${p.currencyCode}; el catálogo de Emite DTE es en pesos`,
    );
  }
  const precioNeto = Math.round(num(p.unitPrice) * 100) / 100;
  if (!Number.isFinite(precioNeto) || precioNeto < 0 || precioNeto >= 1e12) {
    throw new ErrorMapeo(
      'PRECIO',
      `El producto «${codigo}» tiene un precio que Emite DTE no acepta (${String(p.unitPrice)})`,
    );
  }

  if (p.name.trim().length > LARGO_NOMBRE) {
    avisos.push(`El nombre se acortó a ${LARGO_NOMBRE} caracteres`);
  }
  let categoria: string | undefined;
  if (p.categoryId) {
    const c = categorias.get(p.categoryId);
    if (c) categoria = corta(c.name, LARGO_CATEGORIA);
    else avisos.push('La categoría de Coreinbox ya no existe; queda sin categoría');
  }

  const datos: ProductoNuevo = {
    emisorId,
    codigo,
    nombre: corta(nombre, LARGO_NOMBRE) ?? codigo,
    ...conValor('descripcion', corta(p.description, 1000)),
    tipo: p.type === 'product' ? 'bien' : 'servicio',
    ...conValor('unidad', unidadEmite(p.unit)),
    precioNeto,
    exento: !p.isTaxable || (p.taxRate !== null && p.taxRate !== undefined && num(p.taxRate) === 0),
    ...conValor('categoria', categoria),
  };
  return { datos, avisos };
}
