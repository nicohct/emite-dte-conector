/**
 * La pasada del flujo de productos: siempre la lectura de los tres sistemas (fase 1a) y, sólo con
 * `PRODUCTOS_ESCRIBIR=true`, además la escritura Coreinbox → Emite DTE de antes de la fase 1. La
 * escritura en los tres con eco y conflictos es la fase 1b y todavía no existe.
 */
import { pasadaLectura, type DependenciasLectura, type ResultadoLectura } from './lectura.js';
import { pasadaProductos, type ResultadoProductos } from './pasada.js';

export interface DependenciasCatalogo extends DependenciasLectura {
  escribir: boolean;
  /** Primer `updatedSince` de la escritura Coreinbox → Emite DTE (`DESDE`). */
  desde: string;
}

export type ResultadoCatalogo = ResultadoLectura & Partial<ResultadoProductos>;

export async function pasadaCatalogo(d: DependenciasCatalogo): Promise<ResultadoCatalogo> {
  const lectura = await pasadaLectura(d);
  if (!d.escribir) return lectura;
  const escritura = await pasadaProductos({
    coreinbox: d.coreinbox,
    emite: d.emite,
    estado: d.estado,
    emisorId: d.emisorId,
    desde: d.desde,
  });
  return { ...lectura, ...escritura };
}
