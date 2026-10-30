/**
 * El panel del conector bajo `/panel`: HTML del servidor, sin autenticación propia. Se ve dentro de
 * Emite DTE (Administración → Integraciones), que reenvía `/integraciones/conector/…` a este
 * proceso y agrega `X-Emite-Usuario`; nunca se expone a Internet.
 *
 * Lee todo de `Estado`. Los únicos POST son las decisiones del catálogo
 * (`/panel/acciones/{reglas|empates|conflictos|visibilidad}`), que usan la misma lógica que la API
 * JSON y, hasta la fase 1b, sólo cambian el registro.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Estado, FlujoEvento } from '../estado.js';
import { aplicarAccion, ErrorPeticion, esAccion } from '../flujos/productos/acciones.js';
import { log } from '../log.js';
import type { RespuestaSalud } from '../salud.js';
import { filtroCatalogoDe, pantallaProducto, pantallaProductos } from './catalogo.js';
import {
  pantallaConflictos,
  pantallaHistoricos,
  pantallaReglas,
  pantallaVisibilidad,
} from './decisiones.js';
import { avisoDe, cuerpoDe, destino, mismoOrigen } from './formularios.js';
import { html, pagina, type Html, type Marco, type Seccion } from './html.js';
import { crearMiniaturas, type DescargaImagen } from './imagen.js';
import {
  ESTADOS_EVENTOS,
  FLUJOS_EVENTOS,
  pantallaEventos,
  pantallaFlujos,
  type Enlaces,
  type FiltroPanelEventos,
} from './pantallas.js';

export interface DependenciasPanel {
  salud: () => RespuestaSalud;
  estado: Estado;
  enlaces: Enlaces;
  /** Descarga de la foto principal para las miniaturas; null deja todas las fotos en hueco. */
  descargarImagen?: DescargaImagen | null;
  ahora?: () => Date;
}

const POR_PAGINA = 50;
const ERRORES_RECIENTES = 5;
const MAX_CUERPO = 256 * 1024;

/** Atiende `/panel` y lo que cuelga de él; devuelve false si la ruta no es del panel. */
export function crearPanel(d: DependenciasPanel) {
  const miniatura = crearMiniaturas({
    estado: d.estado,
    descargar: d.descargarImagen ?? null,
    ...(d.ahora ? { ahora: d.ahora } : {}),
  });
  const ahora = () => (d.ahora ?? (() => new Date()))().toISOString();

  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== '/panel' && !url.pathname.startsWith('/panel/')) return false;
    // Sin normalizar barras finales: en `/panel/flujos/` los enlaces relativos quedarían mal.
    const partes = url.pathname.split('/').slice(2);
    // En `/panel` sin barra el navegador resuelve `./x` contra la raíz; ahí los enlaces llevan
    // `panel/`. Un nivel más abajo (`/panel/productos/{sku}`) llevan `../`.
    const base = partes.length === 0 ? 'panel/' : partes.length === 1 ? './' : '../';
    const usuario = cabecera(req, 'x-emite-usuario')?.slice(0, 200) ?? null;
    const marco = (titulo: string, activa: Seccion | null): Marco => ({
      titulo,
      base,
      activa,
      usuario,
      aviso: avisoDe(url.searchParams),
    });
    const html200 = (titulo: string, activa: Seccion, cuerpo: Html) =>
      enviar(res, 200, pagina(marco(titulo, activa), cuerpo));
    const noExiste = () =>
      enviar(
        res,
        404,
        pagina(
          marco('No existe', null),
          html`<h1>No existe</h1>
            <p><a href="${base}flujos">Volver a los flujos</a></p>`,
        ),
      );

    const esAcciones = partes.length === 2 && partes[0] === 'acciones';
    const metodoValido = esAcciones
      ? req.method === 'POST'
      : req.method === 'GET' || req.method === 'HEAD';
    if (!metodoValido) {
      enviar(
        res,
        405,
        pagina(marco('Método no permitido', null), html`<h1>Método no permitido</h1>`),
        { allow: esAcciones ? 'POST' : 'GET, HEAD' },
      );
      return true;
    }

    try {
      const ruta = partes.join('/');
      const registro = d.estado.catalogo;
      if (esAcciones) {
        await atenderAccion(req, res, partes[1] ?? '', usuario, ahora());
      } else if (ruta === '' || ruta === 'flujos') {
        const errores = (flujo: FlujoEvento) =>
          d.estado.eventos({ flujo, estado: 'error', porPagina: ERRORES_RECIENTES });
        const cuerpo = pantallaFlujos(
          {
            salud: d.salud(),
            errores: { cotizaciones: errores('cotizaciones'), productos: errores('productos') },
            base,
          },
          d.enlaces,
        );
        html200('Flujos', 'flujos', cuerpo);
      } else if (ruta === 'eventos') {
        const f = filtroEventosDe(url.searchParams);
        const filtro = {
          ...(f.flujo ? { flujo: f.flujo } : {}),
          ...(f.estado ? { estado: f.estado } : {}),
        };
        const datos = {
          eventos: d.estado.eventos({ ...filtro, pagina: f.pagina, porPagina: f.porPagina }),
          total: d.estado.contar(filtro),
        };
        html200('Eventos', 'eventos', pantallaEventos(datos, f, d.enlaces, base));
      } else if (ruta === 'productos') {
        const f = filtroCatalogoDe(url.searchParams, POR_PAGINA);
        html200('Productos', 'productos', pantallaProductos(registro, f, base));
      } else if (partes.length === 2 && partes[0] === 'productos' && partes[1]) {
        const sku = decodificar(partes[1]);
        const cuerpo = sku === null ? null : pantallaProducto(registro, sku, base);
        if (cuerpo && sku) html200(sku, 'productos', cuerpo);
        else noExiste();
      } else if (ruta === 'historicos') {
        html200(
          'Históricos',
          'historicos',
          pantallaHistoricos(registro, url.searchParams, base, POR_PAGINA),
        );
      } else if (ruta === 'conflictos') {
        html200(
          'Conflictos',
          'conflictos',
          pantallaConflictos(registro, url.searchParams, base, POR_PAGINA),
        );
      } else if (ruta === 'visibilidad') {
        html200(
          'Visibilidad web',
          'visibilidad',
          pantallaVisibilidad(registro, url.searchParams, base, POR_PAGINA),
        );
      } else if (ruta === 'reglas') {
        html200('Quién manda', 'reglas', pantallaReglas(registro, base));
      } else if (partes.length === 2 && partes[0] === 'imagen' && partes[1]) {
        const sku = decodificar(partes[1]);
        const m = sku === null ? null : await miniatura(sku);
        if (!m) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SEGURIDAD });
          res.end(req.method === 'HEAD' ? undefined : 'sin foto');
        } else {
          res.writeHead(200, {
            ...SEGURIDAD,
            'content-type': m.contentType,
            'content-length': String(m.bytes.length),
            'cache-control': 'private, max-age=86400',
            'content-security-policy': "default-src 'none'",
          });
          res.end(req.method === 'HEAD' ? undefined : m.bytes);
        }
      } else {
        noExiste();
      }
    } catch (e) {
      log('error', 'el panel no pudo leer el estado', { ruta: url.pathname, error: String(e) });
      if (res.headersSent) {
        res.destroy();
        return true;
      }
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

  /**
   * Aplica la acción y redirige (303) a la pantalla de origen con el resultado. Desde la ruta
   * `/panel/acciones/{…}`, `../` es la raíz del panel, también detrás del reenvío de Emite DTE.
   */
  async function atenderAccion(
    req: IncomingMessage,
    res: ServerResponse,
    nombre: string,
    usuario: string | null,
    en: string,
  ): Promise<void> {
    const texto = (s: number, t: string) => {
      res.writeHead(s, { 'content-type': 'text/plain; charset=utf-8', ...SEGURIDAD });
      res.end(t);
    };
    if (!esAccion(nombre)) return texto(404, 'no existe');
    if (!mismoOrigen(req)) {
      log('warn', 'POST del panel desde otro origen', {
        origin: cabecera(req, 'origin'),
        secFetchSite: cabecera(req, 'sec-fetch-site'),
      });
      return texto(403, 'envío desde otro sitio');
    }
    const tipo = cabecera(req, 'content-type')?.split(';')[0]?.trim().toLowerCase();
    if (tipo !== 'application/x-www-form-urlencoded')
      return texto(415, 'se esperaba un formulario');
    const cuerpoTexto = await leerCuerpo(req);
    if (cuerpoTexto === null) return texto(413, 'cuerpo demasiado grande');
    const formulario = new URLSearchParams(cuerpoTexto);
    let resultado: { aplicadas: number; errores: string[] };
    try {
      const r = aplicarAccion(d.estado.catalogo, nombre, cuerpoDe(nombre, formulario), usuario, en);
      resultado = { aplicadas: r.aplicadas, errores: r.errores.map((e) => e.error) };
    } catch (e) {
      if (!(e instanceof ErrorPeticion)) throw e;
      resultado = { aplicadas: 0, errores: [e.message] };
    }
    res.writeHead(303, {
      location: `../${destino(formulario.get('volver'), nombre, resultado)}`,
      'cache-control': 'no-store',
      ...SEGURIDAD,
    });
    res.end();
  }
}

/** Valores desconocidos en la consulta se ignoran (filtro vacío, página 1). */
export function filtroEventosDe(q: URLSearchParams): FiltroPanelEventos {
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

function decodificar(parte: string): string | null {
  try {
    return decodeURIComponent(parte);
  } catch {
    return null;
  }
}

function cabecera(req: IncomingMessage, nombre: string): string | undefined {
  const v = req.headers[nombre];
  return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
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

const SEGURIDAD = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function enviar(
  res: ServerResponse,
  status: number,
  cuerpo: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, {
    ...SEGURIDAD,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'self'",
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : cuerpo);
}
