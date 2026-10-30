/**
 * Cálculo puro del producto canónico de un SKU a partir de lo leído en cada sistema, las reglas de
 * «quién manda» y las decisiones del panel, y de lo que la escritura llevaría a cada sistema
 * (`escrituras` y `crearEn`). No escribe nada: la pasada de escritura ejecuta este plan.
 *
 * - **Modos:** cada campo tiene un **propietario** (un sistema manda; lo que cambie otro se
 *   revierte) o va por **último cambio** (gana el último cambio que no sea eco). Por omisión:
 *   `activo`, `tipo` y `categoria` son de Coreinbox (sin Coreinbox, de la web), `exento` de Emite
 *   DTE (sin Emite DTE, de Coreinbox) y `nombre` y `precio` van por último cambio. Una regla del
 *   panel (`*` o un SKU) fija otro propietario o pone «último cambio».
 * - **Regla de arranque:** antes de la primera escritura «último cambio» no rige: en nombre y
 *   precio manda la web y, sin web, Coreinbox. Es lo que aplica la primera escritura. Después, sin
 *   ningún cambio visto, sigue valiendo el arranque.
 * - **Precio:** bruto entero en pesos; se compara siempre en bruto. El neto (dos decimales) es
 *   derivado, con el IVA de cada sistema.
 * - **Visibilidad web:** un servicio nunca va (`no_aplica`); si no, una decisión manda (lo que la
 *   lectura vio publicado en la web queda aprobado con usuario `web`); sin decisión, un producto de
 *   una categoría fuera de la web queda `rechazado` (motivo `categoria`) y el resto, incluido un
 *   borrador en la tienda, `propuesto`. Sólo lo aprobado se publica.
 * - **Lo pendiente del panel:** un alta pone todos los campos (fuente `panel`) y se crea en
 *   Coreinbox, Emite DTE y, si quedó aprobada, la web; mientras exista, manda sobre lo leído. Una
 *   edición es el último cambio del campo a la hora en que se hizo: en «último cambio» se escribe
 *   en todos; con propietario, sólo en el propietario, y de ahí se propaga como siempre. Un cambio
 *   visto después en un sistema que cuenta la deja atrás. `pendientesCerradas` dice cuáles ya
 *   están en los sistemas.
 */
import type {
  AltaPendiente,
  CampoCatalogo,
  CampoCompartido,
  Conflicto,
  DecisionVisibilidad,
  EdicionPendiente,
  EscrituraPlaneada,
  LecturaGuardada,
  ModoCampo,
  MotivoVisibilidad,
  ProductoCatalogo,
  Regla,
  SistemaCatalogo,
  TipoProductoCatalogo,
  ValorCampo,
  ValorCanonico,
  VisibilidadWeb,
} from '../../estado-catalogo.js';
import { CAMPOS_COMPARTIDOS, SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import { LARGO_CATEGORIA, LARGO_NOMBRE } from './mapeo.js';

export const TASA_IVA = 0.19;

/** Quién manda al arrancar (y en modo propietario sin regla), en orden de preferencia. */
export const FUENTES_DE_ARRANQUE: Record<CampoCatalogo, SistemaCatalogo[]> = {
  nombre: ['woocommerce', 'coreinbox'],
  precio: ['woocommerce', 'coreinbox'],
  activo: ['coreinbox', 'woocommerce'],
  tipo: ['coreinbox', 'woocommerce'],
  categoria: ['coreinbox', 'woocommerce'],
  exento: ['emite', 'coreinbox'],
};

/** Modo de cada campo sin regla del panel. */
export const MODO_POR_OMISION: Record<CampoCatalogo, ModoCampo> = {
  nombre: 'ultimo',
  precio: 'ultimo',
  activo: 'propietario',
  tipo: 'propietario',
  categoria: 'propietario',
  exento: 'propietario',
};

/** Los campos que pueden ir por «último cambio»: los que viajan entre los tres. */
export const CAMPOS_ULTIMO_CAMBIO: readonly CampoCatalogo[] = CAMPOS_COMPARTIDOS;

/**
 * Lo que la escritura cambia en cada sistema. La exención no se escribe en ninguno (manda Emite
 * DTE y sólo sirve para el neto); en la web no hay tipo ni una categoría comparable.
 */
export const CAMPOS_ESCRIBIBLES: Record<SistemaCatalogo, readonly CampoCatalogo[]> = {
  coreinbox: ['nombre', 'precio', 'activo', 'categoria'],
  woocommerce: ['nombre', 'precio', 'activo'],
  emite: ['nombre', 'precio', 'activo', 'tipo', 'categoria'],
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

/**
 * El valor tal como se compara entre sistemas, y como se escribe: nombres sin espacios de más y a
 * 80 caracteres, categorías a 60.
 */
export function comparable(campo: CampoCompartido | CampoCatalogo, valor: ValorCampo): ValorCampo {
  if (campo === 'nombre' && typeof valor === 'string') {
    return valor.replace(/\s+/g, ' ').trim().slice(0, LARGO_NOMBRE);
  }
  if (campo === 'categoria' && typeof valor === 'string') {
    return valor.trim().slice(0, LARGO_CATEGORIA);
  }
  return valor;
}

const igualesEn = (campo: CampoCatalogo, a: ValorCampo, b: ValorCampo): boolean =>
  JSON.stringify(comparable(campo, a)) === JSON.stringify(comparable(campo, b));

export type ModoDeCampo = { modo: 'ultimo' } | { modo: 'propietario'; orden: SistemaCatalogo[] };

/** Cómo se decide un campo de un SKU: la regla del SKU gana a la de todo el catálogo. */
export function modoDe(reglas: Regla[], sku: string, campo: CampoCatalogo): ModoDeCampo {
  const regla =
    reglas.find((r) => r.ambito === sku && r.campo === campo) ??
    reglas.find((r) => r.ambito === '*' && r.campo === campo);
  const arranque = FUENTES_DE_ARRANQUE[campo];
  if (regla?.fuente === 'ultimo') return { modo: 'ultimo' };
  if (regla) {
    const fuente = regla.fuente;
    return { modo: 'propietario', orden: [fuente, ...arranque.filter((f) => f !== fuente)] };
  }
  return MODO_POR_OMISION[campo] === 'ultimo'
    ? { modo: 'ultimo' }
    : { modo: 'propietario', orden: arranque };
}

/** Quién manda de hecho en un campo con propietario: el primero del orden donde está el SKU. */
export function duenoDe(
  modo: ModoDeCampo,
  presentes: readonly SistemaCatalogo[],
): SistemaCatalogo | null {
  return modo.modo === 'propietario'
    ? (modo.orden.find((s) => presentes.includes(s)) ?? null)
    : null;
}

/**
 * Dónde escribe la pasada una edición del panel: en «último cambio», en todos los sistemas donde
 * está el SKU y se escribe el campo; con propietario, sólo en el propietario (de ahí se propaga a
 * los demás como cualquier cambio suyo). Vacío si el propietario no deja escribir el campo.
 */
export function destinosEdicion(
  reglas: Regla[],
  sku: string,
  campo: CampoCatalogo,
  presentes: readonly SistemaCatalogo[],
): SistemaCatalogo[] {
  const modo = modoDe(reglas, sku, campo);
  const candidatos = modo.modo === 'ultimo' ? presentes : [duenoDe(modo, presentes)];
  return candidatos.filter(
    (s): s is SistemaCatalogo => s !== null && CAMPOS_ESCRIBIBLES[s].includes(campo),
  );
}

export interface EntradaCanonico {
  sku: string;
  lecturas: Partial<Record<SistemaCatalogo, LecturaGuardada>>;
  /** Reglas globales (`*`) y del SKU; la del SKU gana. */
  reglas: Regla[];
  visibilidad: DecisionVisibilidad | null;
  conflictosAbiertos: Conflicto[];
  /** Hora de la primera escritura; sin ella «último cambio» no rige y manda el arranque. */
  primeraEscritura?: string | null;
  /** Categorías de Coreinbox fuera de la web. */
  categoriasFuera?: ReadonlySet<string>;
  /**
   * Por qué no se crea en Emite DTE aunque falte: un histórico con el mismo código sin decidir, o
   * uno confirmado que se adopta en vez de crear.
   */
  noCrearEnEmite?: string | null;
  /** Avisos que vienen de fuera del cálculo (una fusión que requiere mano, por ejemplo). */
  avisos?: string[];
  /** El alta del panel, mientras no esté en todo su alcance. */
  alta?: AltaPendiente | null;
  /** Ediciones del panel que la pasada todavía no deja en los sistemas. */
  ediciones?: EdicionPendiente[];
}

const valorDe = (l: LecturaGuardada | undefined, campo: CampoCatalogo): ValorCampo =>
  l?.campos[campo]?.valor ?? null;

const presentesEn = (e: EntradaCanonico): SistemaCatalogo[] =>
  SISTEMAS_CATALOGO.filter((s) => e.lecturas[s] !== undefined);

/**
 * Una edición queda atrás si después de hacerla un sistema que cuenta (en «último cambio»,
 * cualquiera; con propietario, el propietario) cambió el campo a otro valor.
 */
function edicionSuperada(e: EntradaCanonico, ed: EdicionPendiente): boolean {
  const modo = modoDe(e.reglas, e.sku, ed.campo);
  const presentes = presentesEn(e);
  const cuentan = modo.modo === 'ultimo' ? presentes : [duenoDe(modo, presentes)];
  return cuentan.some((s) => {
    const c = s ? e.lecturas[s]?.campos[ed.campo] : undefined;
    return (
      c?.cambioEn != null &&
      Date.parse(c.cambioEn) > Date.parse(ed.en) &&
      !igualesEn(ed.campo, c.valor, ed.valor)
    );
  });
}

function valorDeAlta(a: AltaPendiente, campo: CampoCatalogo): ValorCampo {
  return {
    nombre: a.nombre,
    precio: a.precio,
    activo: a.activo,
    tipo: a.tipo,
    categoria: a.categoria,
    exento: a.exento,
  }[campo];
}

/**
 * Las ediciones que ya no hace falta guardar: las que quedaron atrás y las que ya están en todos
 * sus destinos (la pasada no tiene nada que escribir de ese campo ahí). Con un alta no se cierra
 * ninguna: el alta manda hasta que el producto existe en todo su alcance.
 */
export function pendientesCerradas(e: EntradaCanonico, p: ProductoCatalogo): EdicionPendiente[] {
  if (e.alta) return [];
  return (e.ediciones ?? []).filter((ed) => {
    if (edicionSuperada(e, ed)) return true;
    if (p.canonico[ed.campo]?.conflicto) return false;
    const destinos = destinosEdicion(e.reglas, e.sku, ed.campo, p.presentes);
    return !(p.escrituras ?? []).some((w) => w.campo === ed.campo && destinos.includes(w.sistema));
  });
}

/** Publicado en la web: `publish` y no oculto del catálogo. */
export function publicadoEnWeb(l: LecturaGuardada | undefined): boolean {
  return l !== undefined && valorDe(l, 'activo') === true;
}

export function calcularProducto(e: EntradaCanonico): ProductoCatalogo {
  const avisos: string[] = [...(e.avisos ?? [])];
  const presentes = presentesEn(e);
  const conflictos = new Set(e.conflictosAbiertos.map((c) => c.campo));
  const primera = e.primeraEscritura ?? null;
  const ediciones = new Map<CampoCatalogo, EdicionPendiente>();
  if (!e.alta) {
    for (const ed of e.ediciones ?? []) if (!edicionSuperada(e, ed)) ediciones.set(ed.campo, ed);
  }
  /** Con propietario, una edición se escribe sólo en él. */
  const soloEn = new Map<CampoCatalogo, SistemaCatalogo | null>();

  const canonico: Partial<Record<CampoCatalogo, ValorCanonico>> = {};
  for (const campo of CAMPOS_CANONICOS) {
    const modo = modoDe(e.reglas, e.sku, campo);
    const primeroCon = (orden: SistemaCatalogo[]): ValorCanonico => {
      for (const fuente of orden) {
        const v = valorDe(e.lecturas[fuente], campo);
        if (v !== null) return { valor: v, fuente, modo: modo.modo };
      }
      return { valor: null, fuente: null, modo: modo.modo };
    };
    let elegido: ValorCanonico;
    if (modo.modo === 'propietario') {
      elegido = primeroCon(modo.orden);
    } else {
      // Último cambio: el más reciente que no sea eco; sin ninguno (o antes de la primera
      // escritura), el arranque. Dos a la misma hora los desempata el orden del arranque.
      const arranque = FUENTES_DE_ARRANQUE[campo];
      const orden = [...arranque, ...SISTEMAS_CATALOGO.filter((s) => !arranque.includes(s))];
      const cambios = primera
        ? orden
            .map((s) => ({ s, c: e.lecturas[s]?.campos[campo] }))
            .filter((x) => x.c?.cambioEn && x.c.valor !== null)
            .sort((a, b) => Date.parse(b.c?.cambioEn ?? '') - Date.parse(a.c?.cambioEn ?? ''))
        : [];
      elegido = primeroCon(cambios[0] ? [cambios[0].s] : arranque);
    }
    const edicion = ediciones.get(campo);
    if (e.alta) {
      elegido = { valor: valorDeAlta(e.alta, campo), fuente: 'panel', modo: modo.modo };
    } else if (edicion) {
      elegido = { valor: edicion.valor, fuente: 'panel', modo: modo.modo };
      if (modo.modo === 'propietario') soloEn.set(campo, duenoDe(modo, presentes));
    }
    if (conflictos.has(campo)) elegido.conflicto = true;
    canonico[campo] = elegido;
  }
  // Lo que se vende en la web es un bien: sin Coreinbox, el tipo sale de que esté en la web.
  if (canonico.tipo?.valor === null && e.lecturas.woocommerce) {
    canonico.tipo = { valor: 'bien', fuente: 'woocommerce', modo: 'propietario' };
  }
  const tipo = (canonico.tipo?.valor as TipoProductoCatalogo | null | undefined) ?? null;

  const publicado = publicadoEnWeb(e.lecturas.woocommerce);
  const categoria = canonico.categoria?.valor;
  let visibilidadWeb: VisibilidadWeb;
  let motivoVisibilidad: MotivoVisibilidad;
  if (tipo === 'servicio') {
    visibilidadWeb = 'no_aplica';
    motivoVisibilidad = 'servicio';
    if (publicado) avisos.push('Es un servicio y está publicado en la web');
  } else if (e.visibilidad) {
    visibilidadWeb = e.visibilidad.estado;
    motivoVisibilidad = 'decision';
  } else if (typeof categoria === 'string' && e.categoriasFuera?.has(categoria)) {
    visibilidadWeb = 'rechazado';
    motivoVisibilidad = 'categoria';
  } else {
    visibilidadWeb = 'propuesto';
    motivoVisibilidad = 'sin_decision';
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

  const escrituras = planificar(e, canonico, visibilidadWeb, primera, soloEn);
  const crearEn: SistemaCatalogo[] = [];
  const nombre = canonico.nombre?.valor;
  // En Coreinbox sólo se crea lo que nació en el panel.
  if (faltaEn.includes('coreinbox') && e.alta) crearEn.push('coreinbox');
  // Sólo se crea lo que viene de una fuente: un producto que existe sólo en Emite DTE se queda ahí.
  if (faltaEn.includes('emite') && (e.alta || e.lecturas.coreinbox || e.lecturas.woocommerce)) {
    if (e.noCrearEnEmite) avisos.push(e.noCrearEnEmite);
    else if (typeof nombre === 'string' && typeof precio === 'number') crearEn.push('emite');
    else avisos.push('Falta en Emite DTE pero no tiene nombre y precio para crearlo');
  }
  if (faltaEn.includes('woocommerce') && typeof nombre === 'string') crearEn.push('woocommerce');

  return {
    sku: e.sku,
    tipo,
    alcance,
    visibilidadWeb,
    motivoVisibilidad,
    canonico,
    precioNeto,
    diferencias,
    presentes,
    faltaEn,
    avisos,
    escrituras,
    crearEn,
    ...(e.alta || ediciones.size > 0 ? { pendiente: true as const } : {}),
  };
}

/**
 * Qué campo se escribe en qué sistema: lo que difiere del canónico al compararlo (en bruto el
 * precio), salvo los campos en conflicto o sin valor canónico. En la web `activo` es el estado:
 * publicado sólo si está aprobado y activo; rechazado o `no_aplica` pasa a borrador. Lo que viene
 * del panel nunca es una reversión, y una edición con propietario va sólo a él (`soloEn`).
 */
function planificar(
  e: EntradaCanonico,
  canonico: Partial<Record<CampoCatalogo, ValorCanonico>>,
  visibilidad: VisibilidadWeb,
  primera: string | null,
  soloEn: ReadonlyMap<CampoCatalogo, SistemaCatalogo | null>,
): EscrituraPlaneada[] {
  const plan: EscrituraPlaneada[] = [];
  for (const sistema of SISTEMAS_CATALOGO) {
    const l = e.lecturas[sistema];
    if (!l) continue;
    for (const campo of CAMPOS_ESCRIBIBLES[sistema]) {
      const c = canonico[campo];
      if (!c || c.conflicto) continue;
      if (soloEn.has(campo) && soloEn.get(campo) !== sistema) continue;
      let valor = c.valor;
      if (sistema === 'woocommerce' && campo === 'activo') {
        if (visibilidad !== 'aprobado') valor = false;
        if (valor === null) continue;
        // Se compara con el estado: un producto publicado pero oculto del catálogo se respeta.
        if ((l.extra.estado === 'publish') === valor) continue;
      } else {
        if (valor === null) continue;
        if (campo === 'precio' && sistema === 'coreinbox' && l.extra.moneda !== 'CLP') continue;
        if (igualesEn(campo, valorDe(l, campo), valor)) continue;
      }
      const leido = l.campos[campo];
      plan.push({
        sistema,
        campo,
        antes: leido?.valor ?? null,
        valor: comparable(campo, valor),
        revierte:
          primera !== null &&
          Boolean(leido?.cambioEn) &&
          c.fuente !== sistema &&
          c.fuente !== 'panel',
      });
    }
  }
  return plan;
}
