/**
 * Los formularios del panel (`POST /panel/acciones/{…}`): la protección mínima contra envíos desde
 * otro sitio, la traducción de cada formulario al mismo cuerpo que recibe la API JSON y la vuelta a
 * la pantalla de origen con el resultado.
 *
 * Cada formulario manda una sola decisión con un botón `uno` (JSON) o un lote: las casillas
 * elegidas más el botón que dice qué hacer con ellas.
 */
import { createHash } from 'node:crypto';
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
    case 'alta': {
      const categoria = f.get('categoria')?.trim();
      return {
        sku: f.get('sku') ?? '',
        nombre: f.get('nombre') ?? '',
        precio: precioDe(f.get('precio')),
        tipo: f.get('tipo') ?? '',
        ...(categoria ? { categoria } : {}),
        exento: f.has('exento'),
        activo: f.has('activo'),
        ...(f.has('aprobar_web') ? { visibilidad: 'aprobado' } : {}),
      };
    }
    case 'edicion': {
      const campos: Record<string, unknown> = {};
      for (const campo of CAMPOS_TEXTO) {
        if (!f.has(campo) && !f.has(`antes_${campo}`)) continue;
        const ahora = f.get(campo) ?? '';
        if (ahora === (f.get(`antes_${campo}`) ?? '')) continue;
        campos[campo] = campo === 'precio' ? precioDe(ahora) : ahora;
      }
      for (const campo of CAMPOS_CASILLA) {
        if (!f.has(`antes_${campo}`)) continue;
        const ahora = f.has(campo);
        if (ahora !== (f.get(`antes_${campo}`) === 'true')) campos[campo] = ahora;
      }
      return { sku: f.get('sku') ?? '', campos };
    }
  }
}

const CAMPOS_TEXTO = ['nombre', 'precio', 'tipo', 'categoria'] as const;
const CAMPOS_CASILLA = ['activo', 'exento'] as const;

/** El precio como número; un texto vacío o no numérico pasa tal cual para que la acción lo rechace. */
function precioDe(texto: string | null): number | string {
  const t = (texto ?? '').trim();
  return t !== '' && Number.isFinite(Number(t)) ? Number(t) : (texto ?? '');
}

const FRAGMENTO = '[A-Za-z0-9_-]+';
const ES_ANCLA = new RegExp(`^${FRAGMENTO}$`);

const RUTA_VOLVER = new RegExp(
  `^(?:${Object.keys(SECCIONES).join('|')}|productos/[^/?#.\\\\][^/?#\\\\]*)(?:\\?[^#]*)?(?:#${FRAGMENTO})?$`,
);

/**
 * El `id` de una fila con acciones, usable como fragmento de URL: `h-<valor>` si el valor sólo trae
 * letras, dígitos, `_` o `-`; si no, `h_<hash corto>` (el `_` tras el prefijo evita choques).
 * Prefijos: `h` histórico, `c` conflicto, `p` producto, `k` categoría.
 */
export function ancla(prefijo: 'h' | 'c' | 'p' | 'k', valor: string | number): string {
  const v = String(valor);
  return ES_ANCLA.test(v)
    ? `${prefijo}-${v}`
    : `${prefijo}_${createHash('sha256').update(v).digest('hex').slice(0, 12)}`;
}

/** La primera decisión del formulario, sin lanzar si es ilegible (la acción ya lo reporta). */
function primera(f: URLSearchParams, clave: string): unknown[] {
  try {
    return f.has('uno') ? json(f.get('uno')) : json(f.get(clave));
  } catch {
    return [];
  }
}

/**
 * La fila a la que vuelve una acción: la de su decisión `uno` o, en un lote, la del primer elemento
 * marcado. `null` en las acciones que no salen de una fila (alta, edición, «quién manda» global).
 */
export function anclaDe(accion: NombreAccion, f: URLSearchParams): string | null {
  const texto = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? v : null);
  switch (accion) {
    case 'empates': {
      const emiteId = texto(primera(f, 'sel')[0]);
      return emiteId === null ? null : ancla('h', emiteId);
    }
    case 'conflictos': {
      const id = f.has('uno') ? texto(primera(f, 'sel')[0]) : f.get('sel');
      return id === null ? null : ancla('c', id);
    }
    case 'visibilidad': {
      const sku = f.has('uno') ? texto(primera(f, 'sku')[0]) : f.get('sku');
      return sku === null ? null : ancla('p', sku);
    }
    case 'reglas': {
      const sku = f.get('lote') ? f.get('sku') : null;
      return sku === null ? null : ancla('p', sku);
    }
    case 'categorias': {
      const categoria = f.get('categoria');
      return categoria === null ? null : ancla('k', categoria);
    }
    case 'alta':
    case 'edicion':
      return null;
  }
}

/**
 * La pantalla a la que se vuelve, relativa a `/panel/` (`productos/SKU-1?…`), con el resultado en
 * la consulta. Un `volver` que no sea una pantalla del panel vuelve a los flujos. El fragmento (el
 * de `volver` o, si no trae, `fila`) va al final y también en la consulta como `fila`, para que la
 * pantalla dibuje el resultado junto a esa fila.
 */
export function destino(
  volver: string | null,
  accion: NombreAccion,
  aviso: Pick<Aviso, 'aplicadas' | 'errores'>,
  fila: string | null = null,
) {
  const ruta = volver && RUTA_VOLVER.test(volver) ? volver : 'flujos';
  const almohadilla = ruta.indexOf('#');
  const sinFragmento = almohadilla < 0 ? ruta : ruta.slice(0, almohadilla);
  const fragmento =
    almohadilla < 0 ? (fila && ES_ANCLA.test(fila) ? fila : null) : ruta.slice(almohadilla + 1);
  const corte = sinFragmento.indexOf('?');
  const camino = corte < 0 ? sinFragmento : sinFragmento.slice(0, corte);
  const q = new URLSearchParams(corte < 0 ? '' : sinFragmento.slice(corte + 1));
  for (const clave of ['accion', 'aplicadas', 'error', 'fila']) q.delete(clave);
  q.set('accion', accion);
  q.set('aplicadas', String(aviso.aplicadas));
  for (const e of aviso.errores.slice(0, MAX_ERRORES_AVISO)) q.append('error', e);
  if (fragmento) q.set('fila', fragmento);
  return `${camino}?${q.toString()}${fragmento ? `#${fragmento}` : ''}`;
}

/** El resultado que trae la consulta tras la redirección, si lo hay. */
export function avisoDe(q: URLSearchParams): Aviso | null {
  const accion = q.get('accion');
  const aplicadas = Number(q.get('aplicadas') ?? NaN);
  if (!accion || !Number.isInteger(aplicadas) || aplicadas < 0) return null;
  const fila = q.get('fila');
  return {
    accion: accion.slice(0, 40),
    aplicadas,
    errores: q
      .getAll('error')
      .slice(0, MAX_ERRORES_AVISO)
      .map((e) => e.slice(0, 300)),
    ...(fila && ES_ANCLA.test(fila) ? { fila } : {}),
  };
}
