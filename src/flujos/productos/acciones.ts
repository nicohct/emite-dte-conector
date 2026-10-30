/**
 * Las decisiones del panel sobre el catálogo (quién manda, empates, conflictos y visibilidad web),
 * con sus validaciones. Las usan la API JSON (`api.ts`) y los formularios del panel; en la fase 1a
 * sólo cambian el registro, no escriben en ningún sistema.
 */
import type { CampoCatalogo, RegistroCatalogo, SistemaCatalogo } from '../../estado-catalogo.js';
import { CAMPOS_CATALOGO, SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import { log } from '../../log.js';
import { recalcular, recalcularEmpates, recalcularTodo } from './lectura.js';

const MAX_LOTE = 500;

/** Una petición mal formada: la API responde 400 y el panel lo muestra como error. */
export class ErrorPeticion extends Error {}

export interface ResultadoAccion {
  aplicadas: number;
  errores: Array<{ indice: number; error: string }>;
}

type Accion = (
  registro: RegistroCatalogo,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
) => ResultadoAccion;

export type NombreAccion = 'reglas' | 'empates' | 'conflictos' | 'visibilidad';
export const NOMBRES_ACCIONES: readonly NombreAccion[] = [
  'reglas',
  'empates',
  'conflictos',
  'visibilidad',
];

export const esAccion = (v: string): v is NombreAccion =>
  (NOMBRES_ACCIONES as readonly string[]).includes(v);

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esSistema = (v: unknown): v is SistemaCatalogo =>
  typeof v === 'string' && (SISTEMAS_CATALOGO as readonly string[]).includes(v);

function lote(cuerpo: unknown, clave: string): unknown[] {
  if (!esObjeto(cuerpo) || !Array.isArray(cuerpo[clave])) {
    throw new ErrorPeticion(`falta la lista «${clave}»`);
  }
  const lista = cuerpo[clave] as unknown[];
  if (lista.length === 0 || lista.length > MAX_LOTE) {
    throw new ErrorPeticion(`«${clave}» debe traer entre 1 y ${MAX_LOTE} elementos`);
  }
  return lista;
}

/** Aplica `f` a cada elemento; un elemento inválido no frena a los demás. */
function porCada(lista: unknown[], f: (item: unknown) => void): ResultadoAccion {
  const r: ResultadoAccion = { aplicadas: 0, errores: [] };
  lista.forEach((item, indice) => {
    try {
      f(item);
      r.aplicadas++;
    } catch (e) {
      if (!(e instanceof ErrorPeticion)) throw e;
      r.errores.push({ indice, error: e.message });
    }
  });
  return r;
}

export const ACCIONES: Record<NombreAccion, Accion> = {
  /**
   * «Quién manda» en un campo: `{ campo, fuente, skus? }`. Sin `skus` es la regla de todo el
   * catálogo; con `skus`, en lote para esos. `fuente: null` vuelve a la regla de arranque.
   */
  reglas(registro, cuerpo, usuario, en) {
    if (!esObjeto(cuerpo)) throw new ErrorPeticion('se esperaba un objeto');
    const { campo, fuente, skus } = cuerpo;
    if (typeof campo !== 'string' || !(CAMPOS_CATALOGO as readonly string[]).includes(campo)) {
      throw new ErrorPeticion(`campo debe ser uno de ${CAMPOS_CATALOGO.join(', ')}`);
    }
    if (fuente !== null && !esSistema(fuente)) {
      throw new ErrorPeticion(`fuente debe ser ${SISTEMAS_CATALOGO.join(', ')} o null`);
    }
    if (skus === undefined) {
      registro.guardarRegla('*', campo as CampoCatalogo, fuente, usuario, en);
      recalcularTodo(registro);
      return { aplicadas: 1, errores: [] };
    }
    const r = porCada(lote(cuerpo, 'skus'), (sku) => {
      if (typeof sku !== 'string' || !registro.producto(sku)) {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      registro.guardarRegla(sku, campo as CampoCatalogo, fuente, usuario, en);
      recalcular(registro, sku);
    });
    return r;
  },

  /** `{ decisiones: [{ emiteId, sku, estado: 'confirmado' | 'rechazado' }] }`. */
  empates(registro, cuerpo, usuario, en) {
    const r = porCada(lote(cuerpo, 'decisiones'), (d) => {
      if (!esObjeto(d)) throw new ErrorPeticion('se esperaba un objeto');
      const { emiteId, sku, estado } = d;
      if (typeof emiteId !== 'string' || !registro.historico(emiteId)) {
        throw new ErrorPeticion(`no existe el histórico ${String(emiteId)}`);
      }
      if (typeof sku !== 'string' || !registro.producto(sku)) {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      if (estado !== 'confirmado' && estado !== 'rechazado') {
        throw new ErrorPeticion('estado debe ser confirmado o rechazado');
      }
      if (registro.historico(emiteId)?.fusionadoEnId) {
        throw new ErrorPeticion(`el histórico ${emiteId} ya está fusionado en Emite DTE`);
      }
      registro.decidirEmpate(emiteId, sku, estado, usuario, en);
    });
    recalcularEmpates(registro, en);
    return r;
  },

  /**
   * `{ resoluciones: [{ id, fuente }] }`: el campo del conflicto queda con el valor de `fuente`
   * («quedarse con el de la web / Coreinbox / Emite DTE») como regla de ese SKU.
   */
  conflictos(registro, cuerpo, usuario, en) {
    return porCada(lote(cuerpo, 'resoluciones'), (d) => {
      if (!esObjeto(d)) throw new ErrorPeticion('se esperaba un objeto');
      const { id, fuente } = d;
      const conflicto = typeof id === 'number' ? registro.conflicto(id) : null;
      if (!conflicto || conflicto.estado !== 'abierto') {
        throw new ErrorPeticion(`no hay un conflicto abierto con id ${String(id)}`);
      }
      if (!esSistema(fuente) || !registro.lecturas(conflicto.sku)[fuente]) {
        throw new ErrorPeticion(`el SKU ${conflicto.sku} no está en ${String(fuente)}`);
      }
      registro.guardarRegla(conflicto.sku, conflicto.campo, fuente, usuario, en);
      registro.resolverConflicto(conflicto.id, fuente, usuario, en);
      recalcular(registro, conflicto.sku);
    });
  },

  /** `{ skus: [...], estado: 'aprobado' | 'rechazado' }`. Un servicio nunca va a la web. */
  visibilidad(registro, cuerpo, usuario, en) {
    const estado = esObjeto(cuerpo) ? cuerpo.estado : undefined;
    if (estado !== 'aprobado' && estado !== 'rechazado') {
      throw new ErrorPeticion('estado debe ser aprobado o rechazado');
    }
    return porCada(lote(cuerpo, 'skus'), (sku) => {
      const producto = typeof sku === 'string' ? registro.producto(sku) : null;
      if (!producto || typeof sku !== 'string') {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      if (producto.tipo === 'servicio') {
        throw new ErrorPeticion(`${sku} es un servicio: nunca va a la web`);
      }
      registro.decidirVisibilidad(sku, { estado, usuario, en });
      recalcular(registro, sku);
    });
  },
};

/**
 * Aplica una acción en una transacción y la anota en la bitácora (queda como evento `accion`).
 * Un cuerpo inválido entero lanza `ErrorPeticion` y no anota nada.
 */
export function aplicarAccion(
  registro: RegistroCatalogo,
  nombre: NombreAccion,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
): ResultadoAccion {
  const resultado = registro.transaccion(() => ACCIONES[nombre](registro, cuerpo, usuario, en));
  registro.registrarAccion(nombre, usuario, cuerpo, en);
  log('info', 'acción del catálogo', { accion: nombre, usuario, aplicadas: resultado.aplicadas });
  return resultado;
}
