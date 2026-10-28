/**
 * Recepción de los webhooks firmados de Emite DTE (Standard Webhooks) y su traducción a una
 * actividad en el negocio de Coreinbox: folio, estado ante el SII, correo enviado.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ActividadNueva } from './coreinbox.js';
import type { FilaCotizacion } from './estado.js';
import { ORIGEN } from './mapeo.js';

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

export interface EventoEmite {
  id: string;
  tipo: string;
  creadoEn: string;
  ambiente: 'certificacion' | 'produccion';
  emisor: { id: string; rut: string };
  datos: {
    dte?: {
      id: string;
      tipoDte: number;
      folio: number | null;
      fechaEmision: string;
      estado: string;
      estadoSii: string | null;
      estadoSiiDetalle: string | null;
      trackId: string | null;
      montoTotal: number;
      links: { api: string; xml: string; pdf: string };
    };
    cotizacion?: {
      id: string;
      numero: number;
      origenNombre: string | null;
      idExterno: string | null;
    } | null;
    conReparos?: boolean;
    para?: string[];
    mensaje?: string;
  };
}

const TIPOS: Record<number, string> = {
  33: 'Factura electrónica',
  34: 'Factura exenta',
  39: 'Boleta',
  41: 'Boleta exenta',
  52: 'Guía de despacho',
  56: 'Nota de débito',
  61: 'Nota de crédito',
};

export const nombreTipo = (tipo: number) => TIPOS[tipo] ?? `DTE ${tipo}`;

const pesos = (n: number) => `$${new Intl.NumberFormat('es-CL').format(n)}`;

export type Decision =
  | { accion: 'ignorar'; motivo: string }
  | { accion: 'anotar'; quoteId: string; actividad: Omit<ActividadNueva, 'typeId'> };

/**
 * Qué hacer con un evento ya verificado. Sólo interesan los que vienen de una cotización de
 * Coreinbox; `cotizacion.idExterno` es el id de la cotización en el CRM.
 */
export function decidir(
  evento: EventoEmite,
  fila: FilaCotizacion | null,
  urlPublica: string,
): Decision {
  const c = evento.datos.cotizacion;
  if (!c || c.origenNombre !== ORIGEN || !c.idExterno) {
    return { accion: 'ignorar', motivo: 'no viene de una cotización de Coreinbox' };
  }
  if (!fila) return { accion: 'ignorar', motivo: `cotización ${c.idExterno} desconocida` };
  const dte = evento.datos.dte;
  if (!dte) return { accion: 'ignorar', motivo: 'sin documento' };

  const tipo = nombreTipo(dte.tipoDte);
  const doc = dte.folio ? `${tipo} N° ${dte.folio}` : `${tipo} (borrador)`;
  const enlace = `${urlPublica}/documentos?id=${dte.id}`;
  const pdf = `${urlPublica}${dte.links.pdf}`;
  const pie = `Cotización ${fila.quoteNumber} · Emite DTE: ${enlace}`;
  let title: string;
  let body: string;
  switch (evento.tipo) {
    case 'cotizacion.facturada':
      title = `Cotización ${fila.quoteNumber} en facturación`;
      body = `Se creó el borrador de ${tipo.toLowerCase()} en Emite DTE desde la cotización N° ${c.numero}.\n${pie}`;
      break;
    case 'dte.emitido':
      title = `${doc} emitida por ${pesos(dte.montoTotal)}`;
      body = `Emitida el ${dte.fechaEmision}; en camino al SII.\nPDF: ${pdf}\n${pie}`;
      break;
    case 'dte.enviado_sii':
      title = `${doc} enviada al SII`;
      body = `TrackID ${dte.trackId ?? '—'}.\n${pie}`;
      break;
    case 'dte.aceptado':
      title = `${doc} aceptada por el SII${evento.datos.conReparos ? ' con reparos' : ''}`;
      body =
        `${dte.estadoSii ?? ''} ${dte.estadoSiiDetalle ?? ''}`.trim() + `\nPDF: ${pdf}\n${pie}`;
      break;
    case 'dte.rechazado':
      title = `${doc} rechazada por el SII`;
      body =
        `${dte.estadoSii ?? ''} ${dte.estadoSiiDetalle ?? ''}`.trim() +
        `\nRevisar en Emite DTE: ${enlace}\n${pie}`;
      break;
    case 'dte.correo_enviado':
      title = `${doc} enviada por correo`;
      body = `Para: ${(evento.datos.para ?? []).join(', ') || '—'}.\n${pie}`;
      break;
    default:
      return { accion: 'ignorar', motivo: `evento ${evento.tipo} sin uso` };
  }
  return {
    accion: 'anotar',
    quoteId: fila.quoteId,
    actividad: {
      title: title.slice(0, 500),
      body,
      ...(fila.dealId ? { dealId: fila.dealId } : {}),
      ...(fila.companyId ? { companyId: fila.companyId } : {}),
      ...(fila.contactId ? { contactId: fila.contactId } : {}),
      metadata: {
        origen: 'emite-dte',
        evento: evento.tipo,
        webhookId: evento.id,
        dteId: dte.id,
        tipoDte: dte.tipoDte,
        folio: dte.folio,
        estado: dte.estado,
        estadoSii: dte.estadoSii,
        cotizacionEmiteId: c.id,
        ambiente: evento.ambiente,
      },
    },
  };
}
