/**
 * Lectura consolidada del catálogo y acciones del panel, en JSON:
 *
 * - `GET /catalogo`: productos por SKU, paginados (`pagina`, `limite` hasta 200), con filtros
 *   `q`, `diferencias`, `conflicto`, `sin_sku`, `propuesto_web`, `historicos` y `pendientes` (con
 *   un alta o una edición del panel sin escribir). Con `vista=historicos` lista los históricos de
 *   Emite DTE con sus empates y con `vista=sin_sku` los productos sin SKU de cada sistema.
 * - `GET /catalogo/{sku}`: canónico, valor en cada sistema, tipo, alcance, visibilidad,
 *   conflictos, empates, índice de enlaces, lo que la escritura haría (`escrituras`, `crearEn`),
 *   lo pendiente del panel (`pendientes`: alta y ediciones) y sus últimos eventos de escritura.
 * - `POST /catalogo/acciones/{reglas|empates|conflictos|visibilidad|categorias|alta|edicion}`:
 *   decisiones, altas y ediciones del panel. Cambian el registro; la pasada de escritura siguiente
 *   las lleva a los sistemas.
 * - `GET /catalogo/decisiones`: todas las decisiones humanas y lo pendiente del panel en JSON,
 *   para respaldarlas. `POST /catalogo/decisiones` repone un respaldo (idempotente). Un SKU llamado
 *   `decisiones` se consulta igual por `GET /catalogo?q=decisiones`.
 *
 * Todo con `Authorization: Bearer <CATALOGO_API_KEY>`. Sin clave configurada las rutas no existen
 * (404). La cabecera `X-Emite-Usuario` (la pone Emite DTE con el correo del admin) queda
 * registrada en cada decisión.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  CampoCatalogo,
  FiltroCatalogo,
  RegistroCatalogo,
  SistemaCatalogo,
  ValorCampo,
} from '../../estado-catalogo.js';
import { SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import type { Estado } from '../../estado.js';
import { aplicarAccion, ErrorPeticion, esAccion, importarDecisiones } from './acciones.js';

export interface DependenciasCatalogoApi {
  estado: Estado;
  /** `CATALOGO_API_KEY`; null deja las rutas sin montar. */
  clave: string | null;
  ahora?: () => Date;
}

const MAX_CUERPO = 256 * 1024;
const LIMITE_POR_OMISION = 50;
const LIMITE_MAXIMO = 200;

let configurado: DependenciasCatalogoApi | null = null;

/** Lo llama `index.ts` al arrancar, que monta `atenderCatalogo` en las rutas del servidor. */
export function configurarCatalogo(d: DependenciasCatalogoApi | null): void {
  configurado = d;
}

/** Atiende `/catalogo…` si está configurado; devuelve false para que el servidor siga (404). */
export async function atenderCatalogo(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return configurado ? crearAtencionCatalogo(configurado)(req, res) : false;
}

export function crearAtencionCatalogo(
  d: DependenciasCatalogoApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://conector');
    if (!d.clave || (url.pathname !== '/catalogo' && !url.pathname.startsWith('/catalogo/'))) {
      return false;
    }
    if (!autorizado(d.clave, req.headers.authorization)) {
      responder(res, 401, { error: 'clave inválida' });
      return true;
    }
    const usuario = cabecera(req, 'x-emite-usuario')?.trim().slice(0, 200) || null;
    const ahora = () => (d.ahora ?? (() => new Date()))().toISOString();
    const registro = d.estado.catalogo;
    const partes = url.pathname.split('/').slice(2).map(decodeURIComponent);

    if (req.method === 'GET' && partes.length === 0) {
      responder(res, 200, listar(registro, url.searchParams));
      return true;
    }
    if (partes.length === 1 && partes[0] === 'decisiones') {
      if (req.method === 'GET') {
        responder(res, 200, registro.exportarDecisiones());
        return true;
      }
      if (req.method === 'POST') {
        const cuerpo = await cuerpoJson(req, res);
        if (cuerpo === SIN_CUERPO) return true;
        try {
          responder(res, 200, {
            importadas: importarDecisiones(registro, cuerpo, usuario, ahora()),
          });
        } catch (e) {
          if (!(e instanceof ErrorPeticion)) throw e;
          responder(res, 400, { error: e.message });
        }
        return true;
      }
    }
    if (req.method === 'GET' && partes.length === 1 && partes[0]) {
      const detalle = detalleDe(registro, partes[0]);
      responder(res, detalle ? 200 : 404, detalle ?? { error: 'no existe' });
      return true;
    }
    if (req.method === 'POST' && partes.length === 2 && partes[0] === 'acciones') {
      const nombre = partes[1] ?? '';
      if (!esAccion(nombre)) {
        responder(res, 404, { error: 'no existe' });
        return true;
      }
      const cuerpo = await cuerpoJson(req, res);
      if (cuerpo === SIN_CUERPO) return true;
      try {
        responder(res, 200, aplicarAccion(registro, nombre, cuerpo, usuario, ahora()));
      } catch (e) {
        if (!(e instanceof ErrorPeticion)) throw e;
        responder(res, 400, { error: e.message });
      }
      return true;
    }
    responder(res, 404, { error: 'no existe' });
    return true;
  };
}

// --- Lecturas ---

const SI = ['true', '1', 'si', 'sí'];
const bandera = (q: URLSearchParams, nombre: string): boolean =>
  SI.includes(q.get(nombre)?.trim().toLowerCase() ?? '');

function paginacion(q: URLSearchParams): { pagina: number; limite: number } {
  const pagina = Math.max(1, Number.parseInt(q.get('pagina') ?? '', 10) || 1);
  const limite = Math.min(
    LIMITE_MAXIMO,
    Math.max(1, Number.parseInt(q.get('limite') ?? '', 10) || LIMITE_POR_OMISION),
  );
  return { pagina, limite };
}

function listar(registro: RegistroCatalogo, q: URLSearchParams) {
  const { pagina, limite } = paginacion(q);
  const vista = q.get('vista') ?? 'productos';
  const trozo = <T>(todos: T[]) => ({
    pagina,
    limite,
    total: todos.length,
    items: todos.slice((pagina - 1) * limite, pagina * limite),
  });
  if (vista === 'historicos') {
    const estado = q.get('estado');
    const historicos = registro.historicos().map((h) => ({
      ...h,
      empates: registro.empatesDeHistorico(h.emiteId),
    }));
    return {
      vista,
      ...trozo(
        estado === 'sin_candidato'
          ? historicos.filter((h) => !h.fusionadoEnId && h.empates.length === 0)
          : estado
            ? historicos.filter((h) => h.empates.some((e) => e.estado === estado))
            : historicos,
      ),
    };
  }
  if (vista === 'sin_sku') {
    const sistema = q.get('sistema');
    const todos = registro.sinSku();
    return { vista, ...trozo(sistema ? todos.filter((s) => s.sistema === sistema) : todos) };
  }
  const filtro: FiltroCatalogo = {
    diferencias: bandera(q, 'diferencias'),
    conflicto: bandera(q, 'conflicto'),
    sinSku: bandera(q, 'sin_sku'),
    propuestoWeb: bandera(q, 'propuesto_web'),
    historicos: bandera(q, 'historicos'),
    pendientes: bandera(q, 'pendientes'),
  };
  const texto = q.get('q')?.trim();
  if (texto) filtro.q = texto;
  const { items, total } = registro.listar(filtro, pagina, limite);
  return { vista: 'productos', pagina, limite, total, items };
}

/** Lo leído de un SKU en un sistema, campo por campo, con la hora en que se vio cada valor. */
export interface ValoresDeSistema {
  id: string;
  modificadoEn: string | null;
  leidoEn: string;
  valores: Partial<Record<CampoCatalogo, ValorCampo>>;
  vistoEn: Partial<Record<CampoCatalogo, string | null>>;
  extra: Record<string, unknown>;
}

/** Todo lo de un SKU desde un solo lugar. */
export function detalleDe(registro: RegistroCatalogo, sku: string) {
  const producto = registro.producto(sku);
  if (!producto) return null;
  const lecturas = registro.lecturas(sku);
  const sistemas: Partial<Record<SistemaCatalogo, ValoresDeSistema | null>> = {};
  for (const s of SISTEMAS_CATALOGO) {
    const l = lecturas[s];
    if (!l) {
      sistemas[s] = null;
      continue;
    }
    const valores: Partial<Record<CampoCatalogo, ValorCampo>> = {};
    const vistoEn: Partial<Record<CampoCatalogo, string | null>> = {};
    for (const [campo, c] of Object.entries(l.campos) as Array<
      [CampoCatalogo, NonNullable<(typeof l.campos)[CampoCatalogo]>]
    >) {
      valores[campo] = c.valor;
      vistoEn[campo] = c.vistoEn;
    }
    sistemas[s] = {
      id: l.idExterno,
      modificadoEn: l.modificadoEn,
      leidoEn: l.leidoEn,
      valores,
      vistoEn,
      extra: l.extra,
    };
  }
  return {
    ...producto,
    sistemas,
    visibilidadDecidida: registro.visibilidadDecidida(sku),
    reglas: registro.reglas().filter((r) => r.ambito === sku || r.ambito === '*'),
    conflictos: registro.conflictos(sku),
    empates: registro.empatesDeSku(sku).map((e) => ({
      ...e,
      historico: registro.historico(e.emiteId),
    })),
    indice: registro.indice(sku),
    pendientes: { alta: registro.alta(sku), ediciones: registro.pendientes(sku) },
    eventos: registro.eventosDeSku(sku, 20),
  };
}

// --- HTTP ---

function autorizado(clave: string, autorizacion: string | undefined): boolean {
  const recibido = autorizacion?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!recibido) return false;
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(clave).digest();
  return timingSafeEqual(a, b);
}

function cabecera(req: IncomingMessage, nombre: string): string | undefined {
  const v = req.headers[nombre];
  return Array.isArray(v) ? v[0] : v;
}

const SIN_CUERPO = Symbol('sin cuerpo');

/** El cuerpo JSON de la petición; si es demasiado grande o no es JSON, ya respondió (413 o 400). */
async function cuerpoJson(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | typeof SIN_CUERPO> {
  const texto = await leerCuerpo(req);
  if (texto === null) {
    responder(res, 413, { error: 'cuerpo demasiado grande' });
    return SIN_CUERPO;
  }
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    responder(res, 400, { error: 'el cuerpo no es JSON' });
    return SIN_CUERPO;
  }
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
