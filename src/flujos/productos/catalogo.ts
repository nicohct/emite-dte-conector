/**
 * La pasada del flujo de productos: siempre la lectura de los tres sistemas (fase 1a) y, sólo con
 * `PRODUCTOS_ESCRIBIR=true`, después la escritura del canónico en los sistemas de
 * `PRODUCTOS_ESCRIBIR_SISTEMAS` (fase 1b). Si la lectura falla, no se escribe.
 */
import type { SistemaCatalogo } from '../../estado-catalogo.js';
import { pasadaEscritura, type ResultadoEscritura } from './escritura.js';
import { pasadaLectura, type DependenciasLectura, type ResultadoLectura } from './lectura.js';

export interface DependenciasCatalogo extends DependenciasLectura {
  escribir: boolean;
  /** Dónde escribe la escritura; por omisión, los tres. */
  sistemas?: readonly SistemaCatalogo[];
}

export type ResultadoCatalogo = ResultadoLectura & Partial<ResultadoEscritura>;

export async function pasadaCatalogo(d: DependenciasCatalogo): Promise<ResultadoCatalogo> {
  const lectura = await pasadaLectura(d);
  if (!d.escribir) return lectura;
  const escritura = await pasadaEscritura({
    coreinbox: d.coreinbox,
    emite: d.emite,
    woocommerce: d.woocommerce,
    estado: d.estado,
    emisorId: d.emisorId,
    sistemas: d.sistemas ?? ['coreinbox', 'woocommerce', 'emite'],
    ...(d.ahora ? { ahora: d.ahora } : {}),
  });
  return { ...lectura, ...escritura };
}
