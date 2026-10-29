/** Firma de los webhooks de Emite DTE (Standard Webhooks). */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCIA_S = 300;

/** `v1,<base64>` de HMAC-SHA256 sobre `id.timestamp.cuerpo` con los bytes del secreto `whsec_`. */
export function firmar(secreto: string, id: string, timestamp: number, cuerpo: string): string {
  const llave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', llave).update(`${id}.${timestamp}.${cuerpo}`).digest('base64')}`;
}

export function verificarFirma(
  secreto: string,
  headers: { id?: string | undefined; timestamp?: string | undefined; firma?: string | undefined },
  cuerpo: string,
  ahora = Date.now(),
): boolean {
  if (!headers.id || !headers.timestamp || !headers.firma) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || Math.abs(ahora / 1000 - ts) > TOLERANCIA_S) return false;
  const esperada = Buffer.from(firmar(secreto, headers.id, ts, cuerpo));
  return headers.firma.split(' ').some((f) => {
    const recibida = Buffer.from(f);
    return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
  });
}
