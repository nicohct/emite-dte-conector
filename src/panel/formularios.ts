/**
 * Los formularios del panel (`POST /panel/acciones/{…}`): la protección mínima contra envíos desde
 * otro sitio, la traducción de cada formulario al mismo cuerpo que recibe la API JSON y la vuelta a
 * la pantalla de origen con el resultado.
 *
 * Cada formulario manda una sola decisión con un botón `uno` (JSON) o un lote: las casillas
 * elegidas más el botón que dice qué hacer con ellas.
 */
import type { IncomingMessage } from 'node:http';
import { ErrorPeticion, type NombreAccion } from '../flujos/productos/acciones.js';
import { SECCIONES, type Aviso } from './html.js';

const MAX_ERRORES_AVISO = 10;

/**
 * Rechaza (false) un POST que el navegador marca como de otro sitio: `Sec-Fetch-Site` presente y
 * distinto de `same-origin` o `none`, o `Origin` presente y con otro host que el pedido. El host
 * pedido es el primer valor de `X-Forwarded-Host` si viene (el reenvío de Emite DTE reescribe
 * `Host` al host interno del conector) y si no, `Host`. Sin cookies ni sesiones propias: el panel
 * confía en que sólo se llega a él a través de Emite DTE.
 */
export function mismoOrigen(req: IncomingMessage): boolean {
  const sitio = cabecera(req, 'sec-fetch-site');
  if (sitio !== undefined && sitio !== 'same-origin' && sitio !== 'none') return false;
  const origen = cabecera(req, 'origin');
  if (origen === undefined) return true;
  try {
    const reenviado = cabecera(req, 'x-forwarded-host')?.split(',')[0]?.trim();
    return new URL(origen).host === (reenviado || cabecera(req, 'host'));
  } catch {
    return false;
  }
}

function cabecera(req: IncomingMessage, nombre: string): string | undefined {
  const v = req.headers[nombre];
  return Array.isArray(v) ? v[0] : v;
}

function json(texto: string | null): unknown[] {
  if (texto === null) return [];
  try {
    const v: unknown = JSON.parse(texto);
    if (Array.isArray(v)) return v;
  } catch {
    // cae al error de abajo
  }
  throw new ErrorPeticion('el formulario trae una decisión ilegible');
}

/** El cuerpo de la acción (el mismo de la API JSON) desde los campos del formulario. */
export function cuerpoDe(accion: NombreAccion, f: URLSearchParams): unknown {
  const uno = f.has('uno') ? json(f.get('uno')) : null;
  switch (accion) {
    case 'reglas': {
      const fuente = f.get('fuente') || null;
      const campo = f.get('campo');
      return f.get('lote') ? { campo, fuente, skus: f.getAll('sku') } : { campo, fuente };
    }
    case 'empates': {
      if (uno) {
        const [emiteId, sku, estado] = uno;
        return { decisiones: [{ emiteId, sku, estado }] };
      }
      const estado = f.get('estado');
      return {
        decisiones: f.getAll('sel').map((s) => {
          const [emiteId, sku] = json(s);
          return { emiteId, sku, estado };
        }),
      };
    }
    case 'conflictos': {
      if (uno) {
        const [id, fuente] = uno;
        return { resoluciones: [{ id, fuente }] };
      }
      const fuente = f.get('fuente');
      return { resoluciones: f.getAll('sel').map((id) => ({ id: Number(id), fuente })) };
    }
    case 'visibilidad': {
      if (uno) {
        const [sku, estado] = uno;
        return { skus: [sku], estado };
      }
      return { skus: f.getAll('sku'), estado: f.get('estado') };
    }
    case 'categorias':
      return { categorias: f.getAll('categoria'), fuera: f.get('fuera') === '1' };
  }
}

const RUTA_VOLVER = new RegExp(
  `^(?:${Object.keys(SECCIONES).join('|')}|productos/[^/?#.\\\\][^/?#\\\\]*)(?:\\?[^#]*)?$`,
);

/**
 * La pantalla a la que se vuelve, relativa a `/panel/` (`productos/SKU-1?…`), con el resultado en
 * la consulta. Un `volver` que no sea una pantalla del panel vuelve a los flujos.
 */
export function destino(volver: string | null, accion: NombreAccion, aviso: Omit<Aviso, 'accion'>) {
  const ruta = volver && RUTA_VOLVER.test(volver) ? volver : 'flujos';
  const corte = ruta.indexOf('?');
  const camino = corte < 0 ? ruta : ruta.slice(0, corte);
  const q = new URLSearchParams(corte < 0 ? '' : ruta.slice(corte + 1));
  for (const clave of ['accion', 'aplicadas', 'error']) q.delete(clave);
  q.set('accion', accion);
  q.set('aplicadas', String(aviso.aplicadas));
  for (const e of aviso.errores.slice(0, MAX_ERRORES_AVISO)) q.append('error', e);
  return `${camino}?${q.toString()}`;
}

/** El resultado que trae la consulta tras la redirección, si lo hay. */
export function avisoDe(q: URLSearchParams): Aviso | null {
  const accion = q.get('accion');
  const aplicadas = Number(q.get('aplicadas') ?? NaN);
  if (!accion || !Number.isInteger(aplicadas) || aplicadas < 0) return null;
  return {
    accion: accion.slice(0, 40),
    aplicadas,
    errores: q
      .getAll('error')
      .slice(0, MAX_ERRORES_AVISO)
      .map((e) => e.slice(0, 300)),
  };
}
