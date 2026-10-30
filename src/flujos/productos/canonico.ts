/**
 * Cálculo puro del producto canónico de un SKU a partir de lo leído en cada sistema, las reglas de
 * «quién manda» y las decisiones del panel. No escribe nada: es la propuesta que la fase 1b
 * llevaría a los sistemas.
 *
 * - **Fuentes:** Coreinbox y la web. Emite DTE sólo manda en un campo si una regla lo dice (por
 *   ejemplo, al resolver un conflicto «quedarse con el de Emite DTE»), salvo la exención, que es
 *   tributaria y Emite DTE la conoce: sin Coreinbox, se toma la suya.
 * - **Regla de arranque:** la web manda en precio y nombre comercial; Coreinbox en tipo, categoría,
 *   activo y exención. Si la fuente preferida no tiene el dato, se usa la otra.
 * - **Precio:** bruto entero en pesos; se compara siempre en bruto. El neto (dos decimales) es
 *   derivado.
 * - **Visibilidad web:** una decisión del panel manda; si no hay, un servicio es `no_aplica`, lo
 *   publicado en la web es `aprobado` y el resto `propuesto`.
 */
import type {
  CampoCatalogo,
  CampoCompartido,
  Conflicto,
  DecisionVisibilidad,
  LecturaGuardada,
  ProductoCatalogo,
  Regla,
  SistemaCatalogo,
  TipoProductoCatalogo,
  ValorCampo,
  ValorCanonico,
  VisibilidadWeb,
} from '../../estado-catalogo.js';
import { CAMPOS_COMPARTIDOS, SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import { LARGO_NOMBRE } from './mapeo.js';

export const TASA_IVA = 0.19;

/** Quién manda al arrancar, en orden de preferencia. */
export const FUENTES_DE_ARRANQUE: Record<CampoCatalogo, SistemaCatalogo[]> = {
  nombre: ['woocommerce', 'coreinbox'],
  precio: ['woocommerce', 'coreinbox'],
  activo: ['coreinbox', 'woocommerce'],
  tipo: ['coreinbox', 'woocommerce'],
  categoria: ['coreinbox', 'woocommerce'],
  exento: ['coreinbox', 'emite'],
};

const CAMPOS_CANONICOS: CampoCatalogo[] = [
  'nombre',
  'precio',
  'activo',
  'tipo',
  'categoria',
  'exento',
];

/** Bruto entero desde un neto y su tasa (fracción: 0.19). */
export function brutoDesdeNeto(neto: number, tasa: number): number {
  return Math.round(neto * (1 + tasa));
}

/** Neto a dos decimales desde un bruto entero. */
export function netoDesdeBruto(bruto: number, tasa: number): number {
  return Math.round((bruto / (1 + tasa)) * 100) / 100;
}

/** El valor tal como se compara entre sistemas: nombres sin espacios de más y a 80 caracteres. */
export function comparable(campo: CampoCompartido, valor: ValorCampo): ValorCampo {
  if (campo === 'nombre' && typeof valor === 'string') {
    return valor.replace(/\s+/g, ' ').trim().slice(0, LARGO_NOMBRE);
  }
  return valor;
}

export interface EntradaCanonico {
  sku: string;
  lecturas: Partial<Record<SistemaCatalogo, LecturaGuardada>>;
  /** Reglas globales (`*`) y del SKU; la del SKU gana. */
  reglas: Regla[];
  visibilidad: DecisionVisibilidad | null;
  conflictosAbiertos: Conflicto[];
}

const valorDe = (l: LecturaGuardada | undefined, campo: CampoCatalogo): ValorCampo =>
  l?.campos[campo]?.valor ?? null;

/** Publicado en la web: `publish` y no oculto del catálogo. */
export function publicadoEnWeb(l: LecturaGuardada | undefined): boolean {
  return l !== undefined && valorDe(l, 'activo') === true;
}

export function calcularProducto(e: EntradaCanonico): ProductoCatalogo {
  const avisos: string[] = [];
  const presentes = SISTEMAS_CATALOGO.filter((s) => e.lecturas[s] !== undefined);
  const conflictos = new Set(e.conflictosAbiertos.map((c) => c.campo));

  const fuentesDe = (campo: CampoCatalogo): SistemaCatalogo[] => {
    const regla =
      e.reglas.find((r) => r.ambito === e.sku && r.campo === campo) ??
      e.reglas.find((r) => r.ambito === '*' && r.campo === campo);
    const arranque = FUENTES_DE_ARRANQUE[campo];
    return regla ? [regla.fuente, ...arranque.filter((f) => f !== regla.fuente)] : arranque;
  };

  const canonico: Partial<Record<CampoCatalogo, ValorCanonico>> = {};
  for (const campo of CAMPOS_CANONICOS) {
    let elegido: ValorCanonico = { valor: null, fuente: null };
    for (const fuente of fuentesDe(campo)) {
      const v = valorDe(e.lecturas[fuente], campo);
      if (v !== null) {
        elegido = { valor: v, fuente };
        break;
      }
    }
    if (conflictos.has(campo)) elegido.conflicto = true;
    canonico[campo] = elegido;
  }
  // Lo que se vende en la web es un bien: sin Coreinbox, el tipo sale de que esté en la web.
  if (canonico.tipo?.valor === null && e.lecturas.woocommerce) {
    canonico.tipo = { valor: 'bien', fuente: 'woocommerce' };
  }
  const tipo = (canonico.tipo?.valor as TipoProductoCatalogo | null | undefined) ?? null;

  const publicado = publicadoEnWeb(e.lecturas.woocommerce);
  let visibilidadWeb: VisibilidadWeb;
  if (tipo === 'servicio') {
    visibilidadWeb = 'no_aplica';
    if (publicado) avisos.push('Es un servicio y está publicado en la web');
  } else if (e.visibilidad) {
    visibilidadWeb = e.visibilidad.estado;
  } else {
    visibilidadWeb = publicado ? 'aprobado' : 'propuesto';
  }

  const alcance: SistemaCatalogo[] =
    visibilidadWeb === 'aprobado' ? ['coreinbox', 'woocommerce', 'emite'] : ['coreinbox', 'emite'];
  const faltaEn = alcance.filter((s) => !presentes.includes(s));
  if (visibilidadWeb === 'rechazado' && publicado) {
    avisos.push('La visibilidad web está rechazada pero el producto sigue publicado');
  }

  const diferencias: ProductoCatalogo['diferencias'] = [];
  for (const campo of CAMPOS_COMPARTIDOS) {
    const valores: Partial<Record<SistemaCatalogo, ValorCampo>> = {};
    const distintos = new Set<string>();
    for (const s of presentes) {
      const v = valorDe(e.lecturas[s], campo);
      if (v === null) continue;
      valores[s] = v;
      distintos.add(JSON.stringify(comparable(campo, v)));
    }
    if (distintos.size > 1) diferencias.push({ campo, valores });
  }

  const precio = canonico.precio?.valor;
  const exento = canonico.exento?.valor === true;
  const precioNeto =
    typeof precio === 'number' ? netoDesdeBruto(precio, exento ? 0 : TASA_IVA) : null;

  return {
    sku: e.sku,
    tipo,
    alcance,
    visibilidadWeb,
    canonico,
    precioNeto,
    diferencias,
    presentes,
    faltaEn,
    avisos,
  };
}
