/**
 * Lectura consolidada del catálogo y acciones del panel, en JSON:
 *
 * - `GET /catalogo`: productos por SKU, paginados (`pagina`, `limite` hasta 200), con filtros
 *   `q`, `diferencias`, `conflicto`, `sin_sku`, `propuesto_web` e `historicos`. Con
 *   `vista=historicos` lista los históricos de Emite DTE con sus empates y con `vista=sin_sku` los
 *   productos sin SKU de cada sistema.
 * - `GET /catalogo/{sku}`: canónico, valor en cada sistema, tipo, alcance, visibilidad,
 *   conflictos, empates e índice de enlaces.
 * - `POST /catalogo/acciones/{reglas|empates|conflictos|visibilidad}`: decisiones del panel. En
 *   la fase 1a sólo cambian el registro; no escriben en ningún sistema.
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
} from '../../estado-catalogo.js';
import { CAMPOS_CATALOGO, SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import type { Estado } from '../../estado.js';
import { log } from '../../log.js';
import { recalcular, recalcularEmpates, recalcularTodo } from './lectura.js';

export interface DependenciasCatalogoApi {
  estado: Estado;
  /** `CATALOGO_API_KEY`; null deja las rutas sin montar. */
  clave: string | null;
  ahora?: () => Date;
}

const MAX_CUERPO = 256 * 1024;
const LIMITE_POR_OMISION = 50;
const LIMITE_MAXIMO = 200;
const MAX_LOTE = 500;

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
    if (req.method === 'GET' && partes.length === 1 && partes[0]) {
      const detalle = detalleDe(registro, partes[0]);
      responder(res, detalle ? 200 : 404, detalle ?? { error: 'no existe' });
      return true;
    }
    if (req.method === 'POST' && partes.length === 2 && partes[0] === 'acciones') {
      const accion = ACCIONES[partes[1] ?? ''];
      if (!accion) {
        responder(res, 404, { error: 'no existe' });
        return true;
      }
      const texto = await leerCuerpo(req);
      if (texto === null) {
        responder(res, 413, { error: 'cuerpo demasiado grande' });
        return true;
      }
      let cuerpo: unknown;
      try {
        cuerpo = JSON.parse(texto);
      } catch {
        responder(res, 400, { error: 'el cuerpo no es JSON' });
        return true;
      }
      try {
        const resultado = registro.transaccion(() => accion(registro, cuerpo, usuario, ahora()));
        registro.registrarAccion(partes[1] ?? '', usuario, cuerpo, ahora());
        log('info', 'acción del catálogo', {
          accion: partes[1],
          usuario,
          aplicadas: resultado.aplicadas,
        });
        responder(res, 200, resultado);
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
  };
  const texto = q.get('q')?.trim();
  if (texto) filtro.q = texto;
  const { items, total } = registro.listar(filtro, pagina, limite);
  return { vista: 'productos', pagina, limite, total, items };
}

/** Todo lo de un SKU desde un solo lugar. */
export function detalleDe(registro: RegistroCatalogo, sku: string) {
  const producto = registro.producto(sku);
  if (!producto) return null;
  const lecturas = registro.lecturas(sku);
  const sistemas: Partial<Record<SistemaCatalogo, unknown>> = {};
  for (const s of SISTEMAS_CATALOGO) {
    const l = lecturas[s];
    if (!l) {
      sistemas[s] = null;
      continue;
    }
    const valores: Partial<Record<CampoCatalogo, unknown>> = {};
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
  };
}

// --- Acciones ---

class ErrorPeticion extends Error {}

interface ResultadoAccion {
  aplicadas: number;
  errores: Array<{ indice: number; error: string }>;
}

type Accion = (
  registro: RegistroCatalogo,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
) => ResultadoAccion;

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const esSistema = (v: unknown): v is SistemaCatalogo =>
  typeof v === 'string' && (SISTEMAS_CATALOGO as readonly string[]).includes(v);

function lote(cuerpo: unknown, clave: string): unknown[] {
  if (!esObjeto(cuerpo) || !Array.isArray(cuerpo[clave])) {
    throw new ErrorPeticion(`falta la lista «${clave}»`);
  }
  const lista = cuerpo[clave] as unknown[];
  if (lista.length === 0 || lista.length > MAX_LOTE) {
    throw new ErrorPeticion(`«${clave}» debe traer entre 1 y ${MAX_LOTE} elementos`);
  }
  return lista;
}

/** Aplica `f` a cada elemento; un elemento inválido no frena a los demás. */
function porCada(lista: unknown[], f: (item: unknown) => void): ResultadoAccion {
  const r: ResultadoAccion = { aplicadas: 0, errores: [] };
  lista.forEach((item, indice) => {
    try {
      f(item);
      r.aplicadas++;
    } catch (e) {
      if (!(e instanceof ErrorPeticion)) throw e;
      r.errores.push({ indice, error: e.message });
    }
  });
  return r;
}

const ACCIONES: Record<string, Accion> = {
  /**
   * «Quién manda» en un campo: `{ campo, fuente, skus? }`. Sin `skus` es la regla de todo el
   * catálogo; con `skus`, en lote para esos. `fuente: null` vuelve a la regla de arranque.
   */
  reglas(registro, cuerpo, usuario, en) {
    if (!esObjeto(cuerpo)) throw new ErrorPeticion('se esperaba un objeto');
    const { campo, fuente, skus } = cuerpo;
    if (typeof campo !== 'string' || !(CAMPOS_CATALOGO as readonly string[]).includes(campo)) {
      throw new ErrorPeticion(`campo debe ser uno de ${CAMPOS_CATALOGO.join(', ')}`);
    }
    if (fuente !== null && !esSistema(fuente)) {
      throw new ErrorPeticion(`fuente debe ser ${SISTEMAS_CATALOGO.join(', ')} o null`);
    }
    if (skus === undefined) {
      registro.guardarRegla('*', campo as CampoCatalogo, fuente, usuario, en);
      recalcularTodo(registro);
      return { aplicadas: 1, errores: [] };
    }
    const r = porCada(lote(cuerpo, 'skus'), (sku) => {
      if (typeof sku !== 'string' || !registro.producto(sku)) {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      registro.guardarRegla(sku, campo as CampoCatalogo, fuente, usuario, en);
      recalcular(registro, sku);
    });
    return r;
  },

  /** `{ decisiones: [{ emiteId, sku, estado: 'confirmado' | 'rechazado' }] }`. */
  empates(registro, cuerpo, usuario, en) {
    const r = porCada(lote(cuerpo, 'decisiones'), (d) => {
      if (!esObjeto(d)) throw new ErrorPeticion('se esperaba un objeto');
      const { emiteId, sku, estado } = d;
      if (typeof emiteId !== 'string' || !registro.historico(emiteId)) {
        throw new ErrorPeticion(`no existe el histórico ${String(emiteId)}`);
      }
      if (typeof sku !== 'string' || !registro.producto(sku)) {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      if (estado !== 'confirmado' && estado !== 'rechazado') {
        throw new ErrorPeticion('estado debe ser confirmado o rechazado');
      }
      if (registro.historico(emiteId)?.fusionadoEnId) {
        throw new ErrorPeticion(`el histórico ${emiteId} ya está fusionado en Emite DTE`);
      }
      registro.decidirEmpate(emiteId, sku, estado, usuario, en);
    });
    recalcularEmpates(registro, en);
    return r;
  },

  /**
   * `{ resoluciones: [{ id, fuente }] }`: el campo del conflicto queda con el valor de `fuente`
   * («quedarse con el de la web / Coreinbox / Emite DTE») como regla de ese SKU.
   */
  conflictos(registro, cuerpo, usuario, en) {
    return porCada(lote(cuerpo, 'resoluciones'), (d) => {
      if (!esObjeto(d)) throw new ErrorPeticion('se esperaba un objeto');
      const { id, fuente } = d;
      const conflicto = typeof id === 'number' ? registro.conflicto(id) : null;
      if (!conflicto || conflicto.estado !== 'abierto') {
        throw new ErrorPeticion(`no hay un conflicto abierto con id ${String(id)}`);
      }
      if (!esSistema(fuente) || !registro.lecturas(conflicto.sku)[fuente]) {
        throw new ErrorPeticion(`el SKU ${conflicto.sku} no está en ${String(fuente)}`);
      }
      registro.guardarRegla(conflicto.sku, conflicto.campo, fuente, usuario, en);
      registro.resolverConflicto(conflicto.id, fuente, usuario, en);
      recalcular(registro, conflicto.sku);
    });
  },

  /** `{ skus: [...], estado: 'aprobado' | 'rechazado' }`. Un servicio nunca va a la web. */
  visibilidad(registro, cuerpo, usuario, en) {
    const estado = esObjeto(cuerpo) ? cuerpo.estado : undefined;
    if (estado !== 'aprobado' && estado !== 'rechazado') {
      throw new ErrorPeticion('estado debe ser aprobado o rechazado');
    }
    return porCada(lote(cuerpo, 'skus'), (sku) => {
      const producto = typeof sku === 'string' ? registro.producto(sku) : null;
      if (!producto || typeof sku !== 'string') {
        throw new ErrorPeticion(`no existe el SKU ${String(sku)}`);
      }
      if (producto.tipo === 'servicio') {
        throw new ErrorPeticion(`${sku} es un servicio: nunca va a la web`);
      }
      registro.decidirVisibilidad(sku, { estado, usuario, en });
      recalcular(registro, sku);
    });
  },
};

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
