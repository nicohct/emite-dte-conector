/** Lo que comparten los flujos: el error de dato, el margen del cursor y utilidades de mapeo. */
import { ErrorCoreinbox } from '../adaptadores/coreinbox/cliente.js';
import { ErrorEmite } from '../adaptadores/emite/cliente.js';
import { ErrorWoo } from '../adaptadores/woocommerce/cliente.js';

/**
 * Cuánto se retrocede el cursor respecto del `meta.timestamp` de la primera página (receta de
 * `docs/api-claves.md` §6 del CRM): entrega al menos una vez, deduplicación por id.
 */
export const MARGEN_CURSOR_MS = 5 * 60 * 1000;

/**
 * Un dato del origen que el destino no puede recibir: queda registrado con su mensaje y no se
 * reintenta hasta que el dato cambie en el origen.
 */
export class ErrorMapeo extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorMapeo';
  }
}

export const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined || v === '' ? 0 : Number(v);
export const corta = (s: string | null | undefined, largo: number): string | undefined => {
  const t = s?.trim();
  return t ? (t.length > largo ? t.slice(0, largo) : t) : undefined;
};

export function conValor<K extends string, V>(
  clave: K,
  valor: V | undefined,
): Partial<Record<K, V>> {
  return valor === undefined ? {} : ({ [clave]: valor } as Record<K, V>);
}

/**
 * Una falla que se arregla sola reintentando (red, 5xx, 429), para el log y `GET /salud` cuando una
 * pasada completa falla. La red caída (`status` 0) cuenta como transitoria en los tres sistemas.
 */
export function esTransitorio(e: unknown): boolean {
  if (e instanceof ErrorCoreinbox) return e.transitorio || e.status === 0;
  return (e instanceof ErrorEmite || e instanceof ErrorWoo) && e.transitorio;
}
