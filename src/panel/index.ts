/**
 * El panel del conector bajo `/panel`: HTML del servidor, sólo lectura, sin autenticación propia.
 * Se ve dentro de Emite DTE (Administración → Integraciones), que reenvía `/integraciones/conector/…`
 * a este proceso y agrega `X-Emite-Usuario`; nunca se expone a Internet.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../log.js';
import type { RespuestaSalud } from '../salud.js';
import { ESTADOS_EVENTOS, FLUJOS_EVENTOS, leerEventos, type FiltroEventos } from './eventos.js';
import { html, pagina, type Marco } from './html.js';
import { pantallaEventos, pantallaFlujos, type Enlaces } from './pantallas.js';

export interface DependenciasPanel {
  salud: () => RespuestaSalud;
  /** El mismo SQLite de `Estado`; el panel lo abre en sólo lectura. */
  estadoRuta: string;
  enlaces: Enlaces;
}

const POR_PAGINA = 50;
const ERRORES_RECIENTES = 5;

/** Atiende `/panel` y lo que cuelga de él; devuelve false si la ruta no es del panel. */
export function crearPanel(d: DependenciasPanel) {
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (url.pathname !== '/panel' && !url.pathname.startsWith('/panel/')) return false;
    // En `/panel` sin barra el navegador resuelve `./x` contra la raíz; ahí los enlaces llevan `panel/`.
    const base = url.pathname === '/panel' ? 'panel/' : './';
    const usuario = cabecera(req, 'x-emite-usuario');
    const marco = (titulo: string, activa: Marco['activa']): Marco => ({
      titulo,
      base,
      activa,
      usuario,
    });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      enviar(
        res,
        405,
        pagina(marco('Método no permitido', null), html`<h1>Método no permitido</h1>`),
        {
          allow: 'GET, HEAD',
        },
      );
      return true;
    }
    try {
      // Sin normalizar barras finales: en `/panel/flujos/` los enlaces relativos quedarían mal.
      const ruta = url.pathname;
      if (ruta === '/panel' || ruta === '/panel/' || ruta === '/panel/flujos') {
        const errores = (flujo: 'cotizaciones' | 'productos') =>
          leerEventos(d.estadoRuta, {
            flujo,
            estado: 'error',
            pagina: 1,
            porPagina: ERRORES_RECIENTES,
          }).eventos;
        const cuerpo = pantallaFlujos(
          {
            salud: d.salud(),
            errores: { cotizaciones: errores('cotizaciones'), productos: errores('productos') },
            base,
          },
          d.enlaces,
        );
        enviar(res, 200, pagina(marco('Flujos', 'flujos'), cuerpo));
      } else if (ruta === '/panel/eventos') {
        const filtro = filtroDe(url.searchParams);
        const cuerpo = pantallaEventos(leerEventos(d.estadoRuta, filtro), filtro, d.enlaces);
        enviar(res, 200, pagina(marco('Eventos', 'eventos'), cuerpo));
      } else {
        enviar(
          res,
          404,
          pagina(
            marco('No existe', null),
            html`<h1>No existe</h1>
              <p><a href="${base}flujos">Volver a los flujos</a></p>`,
          ),
        );
      }
    } catch (e) {
      log('error', 'el panel no pudo leer el estado', { ruta: url.pathname, error: String(e) });
      enviar(
        res,
        500,
        pagina(
          marco('Error', null),
          html`<h1>No se pudo leer el estado</h1>
            <p class="tenue">El detalle quedó en el log del conector.</p>`,
        ),
      );
    }
    return true;
  };
}

/** Valores desconocidos en la consulta se ignoran (filtro vacío, página 1). */
export function filtroDe(q: URLSearchParams): FiltroEventos {
  const de = <T extends string>(valores: readonly T[], v: string | null): T | null =>
    valores.includes(v as T) ? (v as T) : null;
  const n = Number(q.get('pagina'));
  return {
    flujo: de(FLUJOS_EVENTOS, q.get('flujo')),
    estado: de(ESTADOS_EVENTOS, q.get('estado')),
    pagina: Number.isInteger(n) && n > 0 ? n : 1,
    porPagina: POR_PAGINA,
  };
}

function cabecera(req: IncomingMessage, nombre: string): string | null {
  const v = req.headers[nombre];
  return (Array.isArray(v) ? v[0] : v)?.trim() || null;
}

function enviar(
  res: ServerResponse,
  status: number,
  cuerpo: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'",
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : cuerpo);
}
