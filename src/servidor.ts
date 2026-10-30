/** Receptor HTTP de los webhooks de Emite DTE (`POST /webhooks`), `GET /salud` y las rutas montadas (el panel). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Coreinbox } from './adaptadores/coreinbox/cliente.js';
import { verificarFirma } from './adaptadores/emite/firma.js';
import type { Estado } from './estado.js';
import { log } from './log.js';
import { decidir, type EventoEmite } from './flujos/cotizaciones/webhooks.js';

export interface DependenciasServidor {
  coreinbox: Coreinbox;
  estado: Estado;
  secreto: string;
  urlPublica: string;
  tipoActividad: string;
}

/**
 * Un grupo de rutas montado en el servidor (el panel, por ejemplo): atiende la petición y devuelve
 * true, o devuelve false si la ruta no es suya. Se prueban en orden antes de `/salud` y `/webhooks`.
 */
export type Rutas = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

const MAX_CUERPO = 256 * 1024;

/** `salud` arma la respuesta de `GET /salud` (ver `salud.ts`). */
export function crearServidor(
  d: DependenciasServidor,
  salud: () => unknown,
  rutas: Rutas[] = [],
): Server {
  return createServer((req, res) => {
    void atender(d, salud, rutas, req, res).catch((e) => {
      log('error', 'error atendiendo la petición', { error: String(e) });
      responder(res, 500, { error: 'interno' });
    });
  });
}

async function atender(
  d: DependenciasServidor,
  salud: () => unknown,
  rutas: Rutas[],
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? '/', 'http://conector');
  for (const atenderRutas of rutas) if (await atenderRutas(req, res, url)) return;
  if (req.method === 'GET' && url.pathname === '/salud') {
    return responder(res, 200, salud());
  }
  if (req.method !== 'POST' || url.pathname !== '/webhooks') {
    return responder(res, 404, { error: 'no existe' });
  }
  const cuerpo = await leerCuerpo(req);
  if (cuerpo === null) return responder(res, 413, { error: 'cuerpo demasiado grande' });
  const h = (nombre: string) => {
    const v = req.headers[nombre];
    return Array.isArray(v) ? v[0] : v;
  };
  if (
    !verificarFirma(
      d.secreto,
      { id: h('webhook-id'), timestamp: h('webhook-timestamp'), firma: h('webhook-signature') },
      cuerpo,
    )
  ) {
    log('warn', 'webhook con firma inválida', { id: h('webhook-id') });
    return responder(res, 401, { error: 'firma inválida' });
  }
  const resultado = await procesarWebhook(d, cuerpo);
  return responder(res, 200, resultado);
}

/** Separado del servidor para probarlo sin red. Siempre responde 2xx tras verificar la firma. */
export async function procesarWebhook(
  d: DependenciasServidor,
  cuerpo: string,
): Promise<{ resultado: string; detalle?: string }> {
  let evento: EventoEmite;
  try {
    evento = JSON.parse(cuerpo) as EventoEmite;
  } catch {
    return { resultado: 'ignorado', detalle: 'cuerpo no es JSON' };
  }
  if (evento.tipo === 'webhook.prueba') {
    log('info', 'webhook de prueba recibido', { id: evento.id });
    return { resultado: 'prueba' };
  }
  if (!d.estado.marcarWebhook(evento.id)) return { resultado: 'repetido' };
  const idExterno = evento.datos.cotizacion?.idExterno ?? null;
  const fila = idExterno ? d.estado.cotizacion(idExterno) : null;
  const decision = decidir(evento, fila, d.urlPublica);
  if (decision.accion === 'ignorar') {
    log('info', 'webhook ignorado', { id: evento.id, tipo: evento.tipo, motivo: decision.motivo });
    return { resultado: 'ignorado', detalle: decision.motivo };
  }
  await d.coreinbox.crearActividad({
    typeId: d.tipoActividad,
    ...decision.actividad,
    metadata: { ...decision.actividad.metadata, quoteId: decision.quoteId },
  });
  log('info', 'actividad anotada en Coreinbox', {
    id: evento.id,
    tipo: evento.tipo,
    quoteId: decision.quoteId,
  });
  return { resultado: 'anotado' };
}

function leerCuerpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolver, rechazar) => {
    const partes: Buffer[] = [];
    let largo = 0;
    req.on('data', (chunk: Buffer) => {
      largo += chunk.length;
      if (largo > MAX_CUERPO) {
        req.destroy();
        resolver(null);
        return;
      }
      partes.push(chunk);
    });
    req.on('end', () => resolver(Buffer.concat(partes).toString('utf8')));
    req.on('error', rechazar);
  });
}

function responder(res: ServerResponse, status: number, cuerpo: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(cuerpo));
}
