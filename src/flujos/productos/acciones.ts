/**
 * Las decisiones del panel sobre el catálogo (quién manda, empates, conflictos, visibilidad web y
 * categorías fuera de la web), el alta y la edición de productos, con sus validaciones, y la
 * importación de decisiones respaldadas. Las usan la API JSON (`api.ts`) y los formularios del
 * panel. Sólo cambian el registro: lo que implican en los sistemas lo lleva la pasada de escritura
 * siguiente. Un alta o una edición queda pendiente hasta entonces.
 */
import type {
  AltaPendiente,
  CampoCatalogo,
  Decisiones,
  FuenteRegla,
  RegistroCatalogo,
  SistemaCatalogo,
  ValorCampo,
} from '../../estado-catalogo.js';
import { CAMPOS_CATALOGO, SISTEMAS_CATALOGO } from '../../estado-catalogo.js';
import { log } from '../../log.js';
import { CAMPOS_ULTIMO_CAMBIO, comparable, destinosEdicion, duenoDe, modoDe } from './canonico.js';
import { recalcular, recalcularEmpates, recalcularTodo } from './lectura.js';
import { LARGO_CATEGORIA, LARGO_CODIGO, LARGO_NOMBRE } from './mapeo.js';

const MAX_LOTE = 500;

/** Una petición mal formada: la API responde 400 y el panel lo muestra como error. */
export class ErrorPeticion extends Error {}

export interface ResultadoAccion {
  aplicadas: number;
  errores: Array<{ indice: number; error: string }>;
}

type Accion = (
  registro: RegistroCatalogo,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
) => ResultadoAccion;

export type NombreAccion =
  'reglas' | 'empates' | 'conflictos' | 'visibilidad' | 'categorias' | 'alta' | 'edicion';
export const NOMBRES_ACCIONES: readonly NombreAccion[] = [
  'reglas',
  'empates',
  'conflictos',
  'visibilidad',
  'categorias',
  'alta',
  'edicion',
];

/** `productos/nuevo` es la pantalla del alta: un producto con ese SKU quedaría tapado. */
export const SKU_RESERVADO = 'nuevo';

const NOMBRE_SISTEMA: Record<SistemaCatalogo, string> = {
  coreinbox: 'Coreinbox',
  woocommerce: 'la web',
  emite: 'Emite DTE',
};

/** Los campos que se dan de alta o se editan desde el panel. El SKU nunca se edita. */
export const CAMPOS_EDITABLES: readonly CampoCatalogo[] = CAMPOS_CATALOGO;

/**
 * Valida el valor de un campo del panel y lo deja como se guarda: nombre sin espacios de más (1 a
 * 80), precio bruto entero ≥ 0, tipo `bien` o `servicio`, categoría de las leídas en Coreinbox (si
 * el registro no tiene ninguna, cualquiera) y `activo`/`exento` booleanos.
 */
function validarCampo(registro: RegistroCatalogo, campo: CampoCatalogo, v: unknown): ValorCampo {
  switch (campo) {
    case 'nombre': {
      const nombre = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
      if (nombre.length < 1 || nombre.length > LARGO_NOMBRE) {
        throw new ErrorPeticion(`el nombre debe tener entre 1 y ${LARGO_NOMBRE} caracteres`);
      }
      return nombre;
    }
    case 'precio':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new ErrorPeticion('el precio debe ser un bruto entero en pesos, 0 o más');
      }
      return v;
    case 'tipo':
      if (v !== 'bien' && v !== 'servicio')
        throw new ErrorPeticion('tipo debe ser bien o servicio');
      return v;
    case 'categoria': {
      const categoria = typeof v === 'string' ? v.trim() : '';
      if (!categoria || categoria.length > LARGO_CATEGORIA) {
        throw new ErrorPeticion(`la categoría debe tener entre 1 y ${LARGO_CATEGORIA} caracteres`);
      }
      const leidas = registro.categoriasLeidas();
      if (leidas.length > 0 && !leidas.includes(categoria)) {
        throw new ErrorPeticion(`la categoría «${categoria}» no está entre las de Coreinbox`);
      }
      return categoria;
    }
    case 'activo':
    case 'exento':
      if (typeof v !== 'boolean') throw new ErrorPeticion(`${campo} debe ser true o false`);
      return v;
  }
}

/**
 * Por qué un SKU no puede tomarse para un alta: ya existe (en el registro o como alta pendiente),
 * un producto sin SKU de algún sistema tiene ese mismo nombre (hay que ponerle el SKU allá) o un
 * histórico de Emite DTE ocupa ese código (se confirma el empate en vez de crear).
 */
function skuOcupado(registro: RegistroCatalogo, sku: string, nombre: string): string | null {
  if (registro.alta(sku)) return `ya hay un alta pendiente con el SKU ${sku}`;
  if (registro.producto(sku) || Object.keys(registro.lecturas(sku)).length > 0) {
    return `ya existe el SKU ${sku}`;
  }
  const historico = registro.historicosConCodigo(sku)[0];
  if (historico) {
    return `Emite DTE tiene un histórico con el código ${sku}: confirma el empate desde Históricos en vez de crearlo`;
  }
  const clave = (n: string) => String(comparable('nombre', n)).toLowerCase();
  const sinSku = registro.sinSku().find((s) => clave(s.nombre) === clave(nombre));
  if (sinSku) {
    return `«${sinSku.nombre}» ya existe sin SKU en ${NOMBRE_SISTEMA[sinSku.sistema]}: ponle el SKU ${sku} ahí en vez de crearlo`;
  }
  return null;
}

export const esAccion = (v: string): v is NombreAccion =>
  (NOMBRES_ACCIONES as readonly string[]).includes(v);

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

export const ACCIONES: Record<NombreAccion, Accion> = {
  /**
   * «Quién manda» en un campo: `{ campo, fuente, skus? }`. `fuente` es el sistema propietario o
   * `ultimo` (último cambio, sólo en nombre, precio y activo). Sin `skus` es la regla de todo el
   * catálogo; con `skus`, en lote para esos. `fuente: null` vuelve al modo por omisión.
   */
  reglas(registro, cuerpo, usuario, en) {
    if (!esObjeto(cuerpo)) throw new ErrorPeticion('se esperaba un objeto');
    const { campo, skus } = cuerpo;
    if (typeof campo !== 'string' || !(CAMPOS_CATALOGO as readonly string[]).includes(campo)) {
      throw new ErrorPeticion(`campo debe ser uno de ${CAMPOS_CATALOGO.join(', ')}`);
    }
    const fuente = cuerpo.fuente as FuenteRegla | null;
    if (fuente !== null && fuente !== 'ultimo' && !esSistema(fuente)) {
      throw new ErrorPeticion(`fuente debe ser ${SISTEMAS_CATALOGO.join(', ')}, ultimo o null`);
    }
    if (fuente === 'ultimo' && !CAMPOS_ULTIMO_CAMBIO.includes(campo as CampoCatalogo)) {
      throw new ErrorPeticion(`«último cambio» sólo vale para ${CAMPOS_ULTIMO_CAMBIO.join(', ')}`);
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

  /**
   * `{ decisiones: [{ emiteId, sku, estado: 'confirmado' | 'rechazado' }] }`. Un lote que confirma
   * dos SKU para el mismo histórico no aplica nada: sólo uno puede quedar.
   */
  empates(registro, cuerpo, usuario, en) {
    const decisiones = lote(cuerpo, 'decisiones');
    const confirmados = decisiones
      .filter(esObjeto)
      .filter((d) => d.estado === 'confirmado')
      .map((d) => d.emiteId);
    const repetido = confirmados.find((id, i) => confirmados.indexOf(id) !== i);
    if (repetido !== undefined) {
      const codigo = typeof repetido === 'string' ? registro.historico(repetido)?.codigo : null;
      throw new ErrorPeticion(
        `el histórico ${codigo ?? String(repetido)} trae más de un candidato marcado para confirmar: marca uno solo (no se aplicó nada)`,
      );
    }
    const r = porCada(decisiones, (d) => {
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
   * («quedarse con el de la web / Coreinbox / Emite DTE») y la escritura siguiente lo lleva a los
   * demás. En «último cambio» el elegido pasa a ser el último cambio (el campo sigue en ese modo);
   * en un campo con propietario queda como regla de ese SKU.
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
      const modo = modoDe(registro.reglas(), conflicto.sku, conflicto.campo).modo;
      if (modo === 'ultimo') registro.elegirCambio(conflicto.sku, conflicto.campo, fuente, en);
      else registro.guardarRegla(conflicto.sku, conflicto.campo, fuente, usuario, en);
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

  /**
   * `{ categorias: [...], fuera: true | false }`: categorías de Coreinbox (por nombre) cuyos
   * productos no van a la web salvo aprobación por SKU (`fuera: false` las devuelve).
   */
  categorias(registro, cuerpo, usuario, en) {
    const fuera = esObjeto(cuerpo) ? cuerpo.fuera : undefined;
    if (typeof fuera !== 'boolean') throw new ErrorPeticion('fuera debe ser true o false');
    const r = porCada(lote(cuerpo, 'categorias'), (c) => {
      if (typeof c !== 'string' || !c.trim()) throw new ErrorPeticion('categoría vacía');
      registro.marcarCategoria(c.trim(), fuera, usuario, en);
    });
    recalcularTodo(registro);
    return r;
  },

  /**
   * Un producto nuevo: `{ sku, nombre, precio, tipo, categoria?, exento?, activo?, visibilidad? }`.
   * Queda pendiente hasta que la pasada lo crea en Coreinbox y Emite DTE (y en la web si
   * `visibilidad: 'aprobado'`, que queda como decisión por SKU aunque su categoría esté fuera de la
   * web). Un servicio nunca va a la web.
   */
  alta(registro, cuerpo, usuario, en) {
    if (!esObjeto(cuerpo)) throw new ErrorPeticion('se esperaba un objeto');
    const { sku } = cuerpo;
    if (typeof sku !== 'string' || sku.length < 1 || sku.length > LARGO_CODIGO) {
      throw new ErrorPeticion(`el SKU debe tener entre 1 y ${LARGO_CODIGO} caracteres`);
    }
    if (sku !== sku.trim())
      throw new ErrorPeticion('el SKU no puede empezar ni terminar en espacio');
    if (sku === SKU_RESERVADO) {
      throw new ErrorPeticion(`el SKU «${SKU_RESERVADO}» está reservado por el panel`);
    }
    const alta: AltaPendiente = {
      sku,
      nombre: validarCampo(registro, 'nombre', cuerpo.nombre) as string,
      precio: validarCampo(registro, 'precio', cuerpo.precio) as number,
      tipo: validarCampo(registro, 'tipo', cuerpo.tipo) as AltaPendiente['tipo'],
      categoria:
        cuerpo.categoria === undefined || cuerpo.categoria === null || cuerpo.categoria === ''
          ? null
          : (validarCampo(registro, 'categoria', cuerpo.categoria) as string),
      exento:
        cuerpo.exento === undefined
          ? false
          : (validarCampo(registro, 'exento', cuerpo.exento) as boolean),
      activo:
        cuerpo.activo === undefined
          ? true
          : (validarCampo(registro, 'activo', cuerpo.activo) as boolean),
      usuario,
      en,
    };
    const { visibilidad } = cuerpo;
    if (visibilidad !== undefined && visibilidad !== null && visibilidad !== 'aprobado') {
      throw new ErrorPeticion('visibilidad sólo puede ser aprobado (o no venir)');
    }
    if (visibilidad === 'aprobado' && alta.tipo === 'servicio') {
      throw new ErrorPeticion(`${sku} es un servicio: nunca va a la web`);
    }
    const ocupado = skuOcupado(registro, sku, alta.nombre);
    if (ocupado) throw new ErrorPeticion(ocupado);
    registro.guardarAlta(alta);
    if (visibilidad === 'aprobado') {
      registro.decidirVisibilidad(sku, { estado: 'aprobado', usuario, en });
    }
    recalcular(registro, sku);
    return { aplicadas: 1, errores: [] };
  },

  /**
   * `{ sku, campos: { nombre?, precio?, activo?, tipo?, categoria?, exento? } }`. Cada campo queda
   * como edición pendiente (el último cambio del campo, a esta hora) y resuelve un conflicto
   * abierto en él. Sobre un alta pendiente, cambia el alta. Se rechaza entera si un campo no es
   * válido o si quien manda en él es un sistema donde el conector no lo escribe.
   */
  edicion(registro, cuerpo, usuario, en) {
    if (!esObjeto(cuerpo)) throw new ErrorPeticion('se esperaba un objeto');
    const { sku, campos } = cuerpo;
    if (typeof sku !== 'string') throw new ErrorPeticion('falta el SKU');
    if ('sku' in (esObjeto(campos) ? campos : {})) {
      throw new ErrorPeticion('el SKU no se edita: se cambia a mano en los tres sistemas');
    }
    if (!esObjeto(campos) || Object.keys(campos).length === 0) {
      throw new ErrorPeticion('falta «campos» con al menos un campo');
    }
    const alta = registro.alta(sku);
    const producto = registro.producto(sku);
    if (!alta && !producto) throw new ErrorPeticion(`no existe el SKU ${sku}`);
    const valores = new Map<CampoCatalogo, ValorCampo>();
    for (const [campo, v] of Object.entries(campos)) {
      if (!(CAMPOS_EDITABLES as readonly string[]).includes(campo)) {
        throw new ErrorPeticion(`campo desconocido: ${campo}`);
      }
      valores.set(campo as CampoCatalogo, validarCampo(registro, campo as CampoCatalogo, v));
    }

    if (alta) {
      registro.guardarAlta({ ...alta, ...Object.fromEntries(valores), usuario, en });
      recalcular(registro, sku);
      return { aplicadas: valores.size, errores: [] };
    }
    const reglas = registro.reglas();
    const presentes = producto?.presentes ?? [];
    for (const campo of valores.keys()) {
      if (destinosEdicion(reglas, sku, campo, presentes).length > 0) continue;
      const dueno = duenoDe(modoDe(reglas, sku, campo), presentes);
      throw new ErrorPeticion(
        dueno
          ? `«${campo}» lo manda ${NOMBRE_SISTEMA[dueno]} y el conector no lo escribe ahí: cámbialo en ${NOMBRE_SISTEMA[dueno]}`
          : `${sku} no está en ningún sistema donde el conector escriba «${campo}»`,
      );
    }
    const abiertos = registro.conflictos(sku, true);
    for (const [campo, valor] of valores) {
      for (const c of abiertos.filter((c) => c.campo === campo)) {
        registro.resolverConflicto(c.id, null, usuario, en);
      }
      registro.guardarPendiente({ sku, campo, valor, usuario, en });
    }
    recalcular(registro, sku);
    return { aplicadas: valores.size, errores: [] };
  },
};

const esLista = (v: unknown): v is unknown[] => Array.isArray(v);

/**
 * Valida un respaldo de `GET /catalogo/decisiones` y lo repone (idempotente). Anota la importación
 * en la bitácora como acción `decisiones`.
 */
export function importarDecisiones(
  registro: RegistroCatalogo,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
): Record<string, number> {
  if (!esObjeto(cuerpo) || cuerpo.version !== 1) {
    throw new ErrorPeticion('se esperaba un respaldo de decisiones con version 1');
  }
  const claves = ['reglas', 'empates', 'conflictos', 'visibilidad', 'categoriasFuera'] as const;
  for (const clave of claves) {
    if (!esLista(cuerpo[clave])) throw new ErrorPeticion(`falta la lista «${clave}»`);
  }
  const d = cuerpo as unknown as Decisiones;
  for (const r of d.reglas as unknown[]) {
    if (!esObjeto(r) || typeof r.ambito !== 'string')
      throw new ErrorPeticion('una regla no es válida');
    if (r.fuente !== 'ultimo' && !esSistema(r.fuente)) {
      throw new ErrorPeticion(`una regla tiene una fuente desconocida: ${String(r.fuente)}`);
    }
    if (typeof r.campo !== 'string' || !(CAMPOS_CATALOGO as readonly string[]).includes(r.campo)) {
      throw new ErrorPeticion(`una regla tiene un campo desconocido: ${String(r.campo)}`);
    }
  }
  for (const e of d.empates as unknown[]) {
    if (!esObjeto(e) || typeof e.emiteId !== 'string' || typeof e.sku !== 'string') {
      throw new ErrorPeticion('un empate no es válido');
    }
    if (e.estado !== 'confirmado' && e.estado !== 'rechazado') {
      throw new ErrorPeticion('un empate debe estar confirmado o rechazado');
    }
  }
  for (const c of d.conflictos as unknown[]) {
    if (!esObjeto(c) || typeof c.sku !== 'string' || typeof c.abiertoEn !== 'string') {
      throw new ErrorPeticion('un conflicto no es válido');
    }
  }
  for (const v of d.visibilidad as unknown[]) {
    if (!esObjeto(v) || typeof v.sku !== 'string') {
      throw new ErrorPeticion('una visibilidad no es válida');
    }
    if (v.estado !== 'aprobado' && v.estado !== 'rechazado') {
      throw new ErrorPeticion('una visibilidad debe ser aprobado o rechazado');
    }
  }
  for (const c of d.categoriasFuera as unknown[]) {
    if (!esObjeto(c) || typeof c.categoria !== 'string') {
      throw new ErrorPeticion('una categoría no es válida');
    }
  }
  for (const clave of ['altas', 'pendientes'] as const) {
    if (cuerpo[clave] !== undefined && !esLista(cuerpo[clave])) {
      throw new ErrorPeticion(`«${clave}» debe ser una lista`);
    }
  }
  for (const a of (d.altas ?? []) as unknown[]) {
    if (
      !esObjeto(a) ||
      typeof a.sku !== 'string' ||
      typeof a.nombre !== 'string' ||
      typeof a.precio !== 'number' ||
      !Number.isInteger(a.precio) ||
      (a.tipo !== 'bien' && a.tipo !== 'servicio') ||
      typeof a.exento !== 'boolean' ||
      typeof a.activo !== 'boolean' ||
      typeof a.en !== 'string'
    ) {
      throw new ErrorPeticion('un alta pendiente no es válida');
    }
  }
  for (const p of (d.pendientes ?? []) as unknown[]) {
    if (
      !esObjeto(p) ||
      typeof p.sku !== 'string' ||
      typeof p.en !== 'string' ||
      typeof p.campo !== 'string' ||
      !(CAMPOS_CATALOGO as readonly string[]).includes(p.campo)
    ) {
      throw new ErrorPeticion('una edición pendiente no es válida');
    }
  }
  const resultado = registro.transaccion(() => {
    const n = registro.importarDecisiones(d);
    recalcularTodo(registro);
    return n;
  });
  registro.registrarAccion('decisiones', usuario, resultado, en);
  log('info', 'decisiones del catálogo importadas', { usuario, ...resultado });
  return resultado;
}

/**
 * Aplica una acción en una transacción y la anota en la bitácora (queda como evento `accion`).
 * Un cuerpo inválido entero lanza `ErrorPeticion` y no anota nada.
 */
export function aplicarAccion(
  registro: RegistroCatalogo,
  nombre: NombreAccion,
  cuerpo: unknown,
  usuario: string | null,
  en: string,
): ResultadoAccion {
  const resultado = registro.transaccion(() => ACCIONES[nombre](registro, cuerpo, usuario, en));
  registro.registrarAccion(nombre, usuario, cuerpo, en);
  log('info', 'acción del catálogo', { accion: nombre, usuario, aplicadas: resultado.aplicadas });
  return resultado;
}
