/**
 * Pasada de lectura del catálogo (fase 1a): lee lo cambiado en Coreinbox (`updatedSince`), en la
 * web (`modified_after`, páginas de 100) y en Emite DTE (`orden=reciente`), lo deja en el registro
 * canónico por SKU y recalcula diferencias, conflictos, propuestas de empate e índice. **No
 * escribe en ningún sistema**: sólo hace GET.
 *
 * Cada sistema tiene su cursor propio en el registro. Una falla transitoria corta la pasada (la
 * registra `GET /salud`) sin mover el cursor del sistema que falló; los que ya terminaron quedan
 * guardados.
 */
import { createHash } from 'node:crypto';
import type {
  CategoriaCoreinbox,
  Coreinbox,
  ProductoCoreinbox,
} from '../../adaptadores/coreinbox/cliente.js';
import type { EmiteDte, ProductoEmite } from '../../adaptadores/emite/cliente.js';
import type { WooCommerce } from '../../adaptadores/woocommerce/cliente.js';
import type { ProductoWoo } from '../../adaptadores/woocommerce/tipos.js';
import type {
  CambioCampo,
  EntradaIndice,
  Lectura,
  RegistroCatalogo,
  SistemaCatalogo,
} from '../../estado-catalogo.js';
import { CAMPOS_COMPARTIDOS } from '../../estado-catalogo.js';
import type { Estado } from '../../estado.js';
import { MARGEN_CURSOR_MS, conValor, num } from '../comun.js';
import { TASA_IVA, brutoDesdeNeto, calcularProducto, comparable, modoDe } from './canonico.js';
import { indexarCanonicos, proponerEmpate } from './empates.js';
import { unidadEmite } from './mapeo.js';

export interface DependenciasLectura {
  coreinbox: Coreinbox;
  emite: EmiteDte;
  /** `null` si no está configurada la tienda: la pasada lee sólo los otros dos. */
  woocommerce: WooCommerce | null;
  estado: Estado;
  emisorId: string;
  ahora?: () => Date;
}

export interface ResultadoLectura {
  leidosCoreinbox: number;
  leidosWoocommerce: number;
  leidosEmite: number;
  historicos: number;
  sinSku: number;
  camposCambiados: number;
  conflictosNuevos: number;
  empatesPropuestos: number;
  conDiferencias: number;
}

/** Primer `updatedSince` del catálogo: todo, no sólo desde `DESDE`. */
const DESDE_SIEMPRE = '1970-01-01T00:00:00.000Z';

const sha256 = (texto: string): string => createHash('sha256').update(texto).digest('hex');
const restar = (iso: string): string => new Date(Date.parse(iso) - MARGEN_CURSOR_MS).toISOString();
const masReciente = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : Date.parse(a) >= Date.parse(b) ? a : b;

export async function pasadaLectura(d: DependenciasLectura): Promise<ResultadoLectura> {
  const leidoEn = (d.ahora ?? (() => new Date()))().toISOString();
  const registro = d.estado.catalogo;
  const r: ResultadoLectura = {
    leidosCoreinbox: 0,
    leidosWoocommerce: 0,
    leidosEmite: 0,
    historicos: 0,
    sinSku: 0,
    camposCambiados: 0,
    conflictosNuevos: 0,
    empatesPropuestos: 0,
    conDiferencias: 0,
  };
  const tocados = new Set<string>();
  /** SKU que aparecieron en un sistema en esta pasada (o cambiaron de SKU). */
  const nuevos = new Set<string>();
  const cambios: CambioCampo[] = [];
  // El margen del cursor vuelve a traer lo último visto: sólo un cambio real recalcula empates.
  let historicosCambiaron = false;
  let nombresCambiaron = false;
  const guardar = (lectura: Lectura, indice: EntradaIndice[]) => {
    const { sku } = lectura;
    if (registro.skuDe(lectura.sistema, lectura.idExterno) !== sku) nuevos.add(sku);
    const resultado = registro.guardarLectura(lectura, indice, leidoEn);
    tocados.add(sku);
    if (resultado.skuAnterior) tocados.add(resultado.skuAnterior);
    cambios.push(...resultado.cambios);
  };
  const perderSku = (sistema: SistemaCatalogo, idExterno: string) => {
    const previo = registro.quitarLecturaDeId(sistema, idExterno);
    if (previo) {
      tocados.add(previo);
      nombresCambiaron = true;
    }
  };

  try {
    // Coreinbox: receta del CRM, `meta.timestamp` de la primera página menos 5 minutos.
    {
      const desde = registro.cursor('coreinbox') ?? DESDE_SIEMPRE;
      let cursor: string | undefined;
      let timestamp: string | null = null;
      let categorias: Map<string, CategoriaCoreinbox> | null = null;
      const vistos = new Set<string>();
      do {
        const pagina = await d.coreinbox.listarProductos(desde, cursor);
        timestamp ??= pagina.timestamp;
        for (const p of pagina.items) {
          if (vistos.has(p.id)) continue;
          vistos.add(p.id);
          r.leidosCoreinbox++;
          if (p.categoryId && !categorias) {
            categorias = new Map((await d.coreinbox.categorias()).map((c) => [c.id, c]));
          }
          const sku = p.sku?.trim() ?? '';
          if (!sku) {
            perderSku('coreinbox', p.id);
            registro.guardarSinSku({
              sistema: 'coreinbox',
              idExterno: p.id,
              nombre: p.name,
              precio: precioCoreinbox(p),
              activo: p.isActive,
              modificadoEn: p.updatedAt,
              leidoEn,
            });
            continue;
          }
          const { lectura, indice } = desdeCoreinbox(d.coreinbox, p, sku, categorias, leidoEn);
          guardar(lectura, indice);
        }
        cursor = pagina.nextCursor ?? undefined;
      } while (cursor);
      if (timestamp) registro.guardarCursor('coreinbox', restar(timestamp));
    }

    // La web: `modified_after` en UTC; el cursor es la última modificación vista menos 5 minutos.
    if (d.woocommerce) {
      const desde = registro.cursor('woocommerce') ?? undefined;
      let ultima: string | null = null;
      for await (const p of d.woocommerce.productos(desde)) {
        r.leidosWoocommerce++;
        const modificado = horaUtc(p.date_modified_gmt);
        ultima = masReciente(ultima, modificado);
        const sku = p.sku?.trim() ?? '';
        if (!sku) {
          perderSku('woocommerce', String(p.id));
          registro.guardarSinSku({
            sistema: 'woocommerce',
            idExterno: String(p.id),
            nombre: decodificarEntidades(p.name),
            precio: precioWoo(p),
            activo: activoWoo(p),
            modificadoEn: modificado,
            leidoEn,
          });
          continue;
        }
        const { lectura, indice } = desdeWoo(d.woocommerce, p, sku, modificado, leidoEn);
        guardar(lectura, indice);
      }
      if (ultima) registro.guardarCursor('woocommerce', restar(ultima));
    }

    // Emite DTE: `orden=reciente` (último cambio primero) hasta llegar a lo ya visto. Los
    // importados del historial no son fuente: van a la tabla de históricos para empatarlos.
    {
      const cursorEmite = registro.cursor('emite');
      const hasta = cursorEmite ? Date.parse(cursorEmite) : null;
      let ultima: string | null = null;
      let cursor: string | undefined;
      recorrer: do {
        const pagina = await d.emite.listarProductos({
          emisorId: d.emisorId,
          orden: 'reciente',
          activo: 'todos',
          limite: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const p of pagina.items) {
          const modificado = p.updatedAt ?? null;
          if (hasta !== null && modificado !== null && Date.parse(modificado) < hasta) {
            break recorrer;
          }
          ultima = masReciente(ultima, modificado);
          r.leidosEmite++;
          // Un histórico adoptado por la escritura (código igual al SKU, empate confirmado) es el
          // producto de Emite DTE de ese SKU aunque siga con `origen=historial`.
          const adoptado = registro.skuDe('emite', p.id);
          if (p.origen === 'historial' && !(adoptado && p.codigo.trim() === adoptado)) {
            const antes = registro.historico(p.id);
            if (
              !antes ||
              antes.codigo !== p.codigo ||
              antes.nombre !== p.nombre ||
              antes.fusionadoEnId !== (p.fusionadoEnId ?? null)
            ) {
              historicosCambiaron = true;
            }
            registro.guardarHistorico({
              emiteId: p.id,
              codigo: p.codigo,
              nombre: p.nombre,
              activo: p.activo,
              fusionadoEnId: p.fusionadoEnId ?? null,
              uso: p.uso ?? null,
              modificadoEn: modificado,
              leidoEn,
            });
            perderSku('emite', p.id);
            continue;
          }
          const sku = p.codigo.trim();
          if (p.fusionadoEnId || !sku) {
            perderSku('emite', p.id);
            continue;
          }
          const { lectura, indice } = desdeEmite(d.emite, p, sku, leidoEn);
          guardar(lectura, indice);
        }
        cursor = pagina.siguiente ?? undefined;
      } while (cursor);
      if (ultima) registro.guardarCursor('emite', restar(ultima));
    }

    // Alias: un SKU canónico que no está como tal en Emite DTE puede ser el código o el nombre
    // antiguo de un histórico (`por-codigo` resuelve alias y fusiones). Se pregunta por los SKU
    // nuevos y, si cambió algún histórico, por todos.
    const historicosPorId = new Map(registro.historicos().map((h) => [h.emiteId, h]));
    for (const sku of historicosCambiaron ? registro.skus() : nuevos) {
      const lecturas = registro.lecturas(sku);
      if (lecturas.emite || (!lecturas.coreinbox && !lecturas.woocommerce)) continue;
      const resuelto = await d.emite.productoPorCodigo(d.emisorId, sku);
      const historico = resuelto ? historicosPorId.get(resuelto.id) : undefined;
      if (historico && historico.aliasSku !== sku) {
        registro.marcarAlias(historico.emiteId, sku);
        historicosCambiaron = true;
      }
    }
  } finally {
    // Lo leído hasta una falla queda calculado igual: la pasada siguiente sigue desde ahí.
    r.conflictosNuevos = abrirConflictos(registro, cambios, leidoEn);
    r.camposCambiados = cambios.length;
    for (const sku of tocados) recalcular(registro, sku);
    nombresCambiaron ||= cambios.some((c) => c.campo === 'nombre' && c.sistema !== 'emite');
    if (historicosCambiaron || nombresCambiaron || nuevos.size > 0) {
      recalcularEmpates(registro, leidoEn);
    }
  }

  const resumen = registro.resumen();
  r.historicos = resumen.historicos;
  r.sinSku = resumen.sinSku;
  r.empatesPropuestos = resumen.empatesPropuestos;
  r.conDiferencias = resumen.conDiferencias;
  return r;
}

/** Recalcula el producto canónico de un SKU; si ya no queda ninguna lectura, lo quita. */
export function recalcular(registro: RegistroCatalogo, sku: string): void {
  const lecturas = registro.lecturas(sku);
  if (Object.keys(lecturas).length === 0) {
    registro.quitarProducto(sku);
    return;
  }
  const empates = registro.empatesDeSku(sku);
  const avisos = empates
    .filter((e) => e.resultado === 'requiere_mano')
    .map(
      (e) =>
        `Requiere mano: Emite DTE no dejó fusionar el histórico ${
          registro.historico(e.emiteId)?.codigo ?? e.emiteId
        } (${e.resultadoDetalle ?? 'sin detalle'})`,
    );
  // Un histórico con el código exacto del SKU ocupa ese código en Emite DTE: confirmado se adopta,
  // y sin confirmar no se crea otro encima.
  let noCrearEnEmite: string | null = null;
  for (const h of registro.historicosConCodigo(sku)) {
    const empate = empates.find((e) => e.emiteId === h.emiteId);
    noCrearEnEmite =
      empate?.estado === 'confirmado'
        ? `Se adopta el histórico ${h.codigo} de Emite DTE en vez de crearlo`
        : empate?.estado === 'rechazado'
          ? `Requiere mano: el histórico ${h.codigo} de Emite DTE ocupa el código y su empate está rechazado`
          : `Emite DTE tiene un histórico con el código ${h.codigo}: falta decidir el empate`;
    if (empate?.estado === 'confirmado') break;
  }
  const reglas = registro.reglas().filter((r) => r.ambito === '*' || r.ambito === sku);
  registro.guardarProducto(
    calcularProducto({
      sku,
      lecturas,
      reglas,
      visibilidad: registro.visibilidadDecidida(sku),
      conflictosAbiertos: registro.conflictos(sku, true),
      primeraEscritura: registro.primeraEscritura(),
      categoriasFuera: new Set(registro.categoriasFuera().map((c) => c.categoria)),
      noCrearEnEmite,
      avisos,
    }),
  );
}

export function recalcularTodo(registro: RegistroCatalogo): void {
  for (const sku of registro.skus()) recalcular(registro, sku);
}

/**
 * Vuelve a proponer el mejor SKU para cada histórico sin fusionar ni confirmar. Las decisiones
 * (confirmados, rechazados) se respetan: un SKU rechazado nunca vuelve a proponerse para ese
 * histórico.
 */
export function recalcularEmpates(registro: RegistroCatalogo, en: string): void {
  const indice = indexarCanonicos(
    [...registro.nombresPorSku()].map(([sku, nombres]) => ({ sku, nombres })),
  );
  registro.transaccion(() => {
    for (const h of registro.historicos()) {
      const decididos = registro.empatesDeHistorico(h.emiteId);
      if (h.fusionadoEnId || decididos.some((e) => e.estado === 'confirmado')) {
        registro.proponerEmpate(h.emiteId, null, en);
        continue;
      }
      const rechazados = new Set(
        decididos.filter((e) => e.estado === 'rechazado').map((e) => e.sku),
      );
      const candidato = proponerEmpate(
        { emiteId: h.emiteId, codigo: h.codigo, nombre: h.nombre },
        indice,
        { aliasDe: h.aliasSku, rechazados },
      );
      const vigente = decididos.find((e) => e.estado === 'propuesto');
      if (
        vigente &&
        candidato &&
        vigente.sku === candidato.sku &&
        vigente.puntaje === candidato.puntaje &&
        vigente.detalle === candidato.detalle
      ) {
        continue;
      }
      registro.proponerEmpate(h.emiteId, candidato, en);
    }
  });
}

/**
 * Un conflicto es un mismo campo en «último cambio» cambiado en dos sistemas desde la última
 * pasada a valores distintos (en un campo con propietario gana el propietario y no hay conflicto).
 * Antes de la primera escritura no rige «último cambio» y tampoco hay conflictos. Devuelve cuántos
 * se abrieron o actualizaron.
 */
function abrirConflictos(registro: RegistroCatalogo, cambios: CambioCampo[], en: string): number {
  if (!registro.primeraEscritura()) return 0;
  const reglas = registro.reglas();
  const porCampo = new Map<string, CambioCampo[]>();
  for (const c of cambios) {
    if (!(CAMPOS_COMPARTIDOS as readonly string[]).includes(c.campo)) continue;
    if (modoDe(reglas, c.sku, c.campo).modo !== 'ultimo') continue;
    const clave = `${c.sku}\u0000${c.campo}`;
    porCampo.set(clave, [...(porCampo.get(clave) ?? []), c]);
  }
  let n = 0;
  for (const lista of porCampo.values()) {
    const primero = lista[0];
    if (!primero || lista.length < 2) continue;
    const campo = primero.campo as (typeof CAMPOS_COMPARTIDOS)[number];
    const distintos = new Set(lista.map((c) => JSON.stringify(comparable(campo, c.despues))));
    if (distintos.size < 2) continue;
    const valores: Partial<
      Record<SistemaCatalogo, { valor: typeof primero.despues; en: string | null }>
    > = {};
    for (const c of lista) valores[c.sistema] = { valor: c.despues, en: c.en };
    registro.abrirConflicto(primero.sku, primero.campo, valores, en);
    n++;
  }
  return n;
}

// --- Traducción de cada sistema a una lectura ---

/** Bruto entero desde el `unitPrice` neto; otra moneda no tiene precio comparable. */
export function precioCoreinbox(p: ProductoCoreinbox): number | null {
  if (p.currencyCode !== 'CLP') return null;
  const neto = num(p.unitPrice);
  if (!Number.isFinite(neto)) return null;
  return brutoDesdeNeto(neto, exentoCoreinbox(p) ? 0 : tasaCoreinbox(p));
}

const exentoCoreinbox = (p: ProductoCoreinbox): boolean =>
  !p.isTaxable || (p.taxRate !== null && p.taxRate !== undefined && num(p.taxRate) === 0);
const tasaCoreinbox = (p: ProductoCoreinbox): number =>
  p.taxRate === null || p.taxRate === undefined ? TASA_IVA : num(p.taxRate);

export function desdeCoreinbox(
  coreinbox: Coreinbox,
  p: ProductoCoreinbox,
  sku: string,
  categorias: Map<string, CategoriaCoreinbox> | null,
  leidoEn: string,
): { lectura: Lectura; indice: EntradaIndice[] } {
  const categoria = p.categoryId ? (categorias?.get(p.categoryId)?.name ?? null) : null;
  const indice: EntradaIndice[] = [
    {
      sistema: 'coreinbox',
      tipo: 'producto',
      url: coreinbox.urlProducto(p.id),
      hash: sha256(JSON.stringify([p.name, p.description, p.unit, p.unitPrice, p.type])),
      leidoEn,
    },
  ];
  if (p.imageStorageKey) {
    indice.push({
      sistema: 'coreinbox',
      tipo: 'imagen',
      url: coreinbox.urlImagen(p.id),
      hash: sha256(p.imageStorageKey),
      leidoEn,
    });
  }
  if (categoria !== null) {
    indice.push({
      sistema: 'coreinbox',
      tipo: 'categoria',
      url: coreinbox.urlProducto(p.id),
      hash: sha256(categoria),
      leidoEn,
    });
  }
  return {
    lectura: {
      sku,
      sistema: 'coreinbox',
      idExterno: p.id,
      modificadoEn: p.updatedAt,
      campos: {
        nombre: p.name.trim(),
        precio: precioCoreinbox(p),
        activo: p.isActive,
        tipo: p.type === 'product' ? 'bien' : 'servicio',
        categoria,
        exento: exentoCoreinbox(p),
      },
      // La tasa y la unidad las usa la escritura: el neto con el IVA de Coreinbox y la unidad al
      // crear en Emite DTE.
      extra: {
        tipoCoreinbox: p.type,
        moneda: p.currencyCode,
        tasa: exentoCoreinbox(p) ? 0 : tasaCoreinbox(p),
        ...conValor('unidad', unidadEmite(p.unit)),
        ...conValor('categoriaId', p.categoryId ?? undefined),
      },
    },
    indice,
  };
}

/** Precio de lista de la web (bruto, entero); vacío → sin precio. */
export function precioWoo(p: ProductoWoo): number | null {
  const texto = p.regular_price?.trim();
  if (!texto) return null;
  const n = Number(texto);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Activo en la web = publicado y visible en el catálogo; borrador u oculto es inactivo. */
export function activoWoo(p: ProductoWoo): boolean {
  return p.status === 'publish' && p.catalog_visibility !== 'hidden';
}

const ENTIDADES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** WooCommerce entrega el nombre con entidades HTML (`&amp;`, `&#8211;`). */
export function decodificarEntidades(texto: string): string {
  return texto
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (todo, nombre: string) => ENTIDADES[nombre.toLowerCase()] ?? todo)
    .trim();
}

const URL_DOCUMENTO =
  /https?:\/\/[^\s"'<>]+\.(?:pdf|docx?|xlsx?|zip|dwg|stp|step)(?:\?[^\s"'<>]*)?/gi;

export function desdeWoo(
  woo: WooCommerce,
  p: ProductoWoo,
  sku: string,
  modificadoEn: string | null,
  leidoEn: string,
): { lectura: Lectura; indice: EntradaIndice[] } {
  const indice: EntradaIndice[] = [];
  const entrada = (tipo: string, url: string, contenido: unknown) =>
    indice.push({
      sistema: 'woocommerce',
      tipo,
      url,
      hash: sha256(JSON.stringify(contenido)),
      leidoEn,
    });

  if (p.permalink) {
    entrada('pagina', p.permalink, [p.name, p.description ?? '', p.short_description ?? '']);
  }
  const atributos = (p.attributes ?? []).map((a) => [a.name, a.options]);
  if (atributos.length > 0) entrada('atributos', woo.urlProducto(p.id), atributos);
  // Los metadatos con guion bajo son internos de WordPress; los demás (campos del generador de
  // fichas, por ejemplo) son información del producto.
  const metadatos = (p.meta_data ?? []).filter((m) => !m.key.startsWith('_'));
  if (metadatos.length > 0) {
    entrada(
      'metadatos',
      woo.urlProducto(p.id),
      metadatos.map((m) => [m.key, m.value]),
    );
  }
  for (const imagen of p.images ?? []) entrada('imagen', imagen.src, [imagen.id, imagen.src]);
  for (const c of p.categories ?? []) entrada('categoria', woo.urlCategoria(c.id), [c.id, c.name]);
  const documentos = new Set<string>();
  const buscar = (v: unknown) => {
    const texto = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    for (const url of texto.match(URL_DOCUMENTO) ?? []) documentos.add(url);
  };
  for (const m of metadatos) buscar(m.value);
  buscar(p.description);
  buscar(p.short_description);
  for (const url of documentos) entrada('documento', url, url);

  const categoria = p.categories?.[0]?.name ?? null;
  return {
    lectura: {
      sku,
      sistema: 'woocommerce',
      idExterno: String(p.id),
      modificadoEn,
      campos: {
        nombre: decodificarEntidades(p.name),
        precio: precioWoo(p),
        activo: activoWoo(p),
        tipo: null,
        categoria: categoria === null ? null : decodificarEntidades(categoria),
        exento: null,
      },
      extra: {
        estado: p.status,
        visibilidad: p.catalog_visibility ?? null,
        tipoWoo: p.type ?? null,
        ...(p.permalink ? { url: p.permalink } : {}),
      },
    },
    indice,
  };
}

export function desdeEmite(
  emite: EmiteDte,
  p: ProductoEmite,
  sku: string,
  leidoEn: string,
): { lectura: Lectura; indice: EntradaIndice[] } {
  return {
    lectura: {
      sku,
      sistema: 'emite',
      idExterno: p.id,
      modificadoEn: p.updatedAt ?? null,
      campos: {
        nombre: p.nombre.trim(),
        precio: brutoDesdeNeto(p.precioNeto, p.exento ? 0 : TASA_IVA),
        activo: p.activo,
        tipo: p.tipo,
        categoria: p.categoria,
        exento: p.exento,
      },
      extra: { origen: p.origen ?? null, ...(p.uso ? { uso: p.uso } : {}) },
    },
    indice: [
      {
        sistema: 'emite',
        tipo: 'producto',
        url: emite.urlProducto(p.id),
        hash: sha256(JSON.stringify([p.nombre, p.descripcion, p.unidad, p.precioNeto, p.tipo])),
        leidoEn,
      },
    ],
  };
}

/** WooCommerce da la hora UTC sin zona (`2026-10-30T11:00:00`); se lleva a ISO completo. */
export function horaUtc(gmt: string | undefined): string | null {
  if (!gmt) return null;
  const ms = Date.parse(`${gmt.replace(/Z$/, '')}Z`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
