/**
 * Una pasada de sincronización del catálogo: los productos cambiados en Coreinbox desde el cursor
 * pasan al catálogo de Emite DTE. Misma receta que las cotizaciones (`docs/api-claves.md` §6 del
 * CRM): cursor propio = `meta.timestamp` de la primera página menos 5 minutos, entrega al menos
 * una vez, deduplicación por id.
 *
 * Coreinbox manda: lo que cambia allá se refleja acá. En Emite DTE **nunca se borra ni se
 * desactiva** nada. Un producto que ya existe con ese código (o con ese código como alias, o
 * fusionado en otro) recibe sólo el nombre y el precio nuevos; lo demás (descripción, unidad,
 * categoría, exento, activo) se respeta como esté en Emite DTE.
 */
import type { CategoriaCoreinbox, Coreinbox, ProductoCoreinbox } from './coreinbox.js';
import { ErrorCoreinbox } from './coreinbox.js';
import type { CambiosProducto, EmiteDte, ProductoEmite } from './emite.js';
import { ErrorEmite } from './emite.js';
import type { Estado } from './estado.js';
import { log } from './log.js';
import { ErrorMapeo } from './mapeo.js';
import { armarProducto } from './mapeo-productos.js';
import { MARGEN_CURSOR_MS } from './sincronizar.js';

export interface DependenciasProductos {
  coreinbox: Coreinbox;
  emite: EmiteDte;
  estado: Estado;
  emisorId: string;
  /** Primer `updatedSince` cuando todavía no hay cursor de productos. */
  desde: string;
}

export interface ResultadoProductos {
  revisados: number;
  creados: number;
  actualizados: number;
  sinCambios: number;
  /** No viajan por un dato de Coreinbox (sin SKU, otra moneda, inactivo y no existe acá). */
  omitidos: number;
  /** Emite DTE los rechazó (4xx): quedan registrados con el mensaje. */
  conError: number;
  /** Fallas transitorias: el producto queda pendiente para la pasada siguiente. */
  pendientes: number;
}

type Desenlace = Exclude<keyof ResultadoProductos, 'revisados'>;

export async function pasadaProductos(d: DependenciasProductos): Promise<ResultadoProductos> {
  const desde = d.estado.cursorProductos ?? d.desde;
  const r: ResultadoProductos = {
    revisados: 0,
    creados: 0,
    actualizados: 0,
    sinCambios: 0,
    omitidos: 0,
    conError: 0,
    pendientes: 0,
  };
  let cursor: string | undefined;
  let timestampInicial: string | null = null;
  const vistos = new Set<string>();
  // Las categorías se piden una sola vez por pasada, y sólo si algún producto tiene una.
  let categorias: Map<string, CategoriaCoreinbox> | null = null;
  const categoriasDe = async () => {
    categorias ??= new Map((await d.coreinbox.categorias()).map((c) => [c.id, c]));
    return categorias;
  };

  do {
    const pagina = await d.coreinbox.listarProductos(desde, cursor);
    timestampInicial ??= pagina.timestamp;
    for (const producto of pagina.items) {
      if (vistos.has(producto.id)) continue;
      vistos.add(producto.id);
      r.revisados++;
      r[await procesar(d, producto, categoriasDe)]++;
    }
    cursor = pagina.nextCursor ?? undefined;
  } while (cursor);

  // Con alguno pendiente por una falla transitoria no se avanza el cursor: la pasada siguiente lo
  // vuelve a ver. Los omitidos y los rechazados quedan registrados y entran de nuevo sólo cuando
  // cambian en Coreinbox.
  if (timestampInicial && r.pendientes === 0) {
    d.estado.cursorProductos = new Date(
      Date.parse(timestampInicial) - MARGEN_CURSOR_MS,
    ).toISOString();
  }
  return r;
}

async function procesar(
  d: DependenciasProductos,
  p: ProductoCoreinbox,
  categoriasDe: () => Promise<Map<string, CategoriaCoreinbox>>,
): Promise<Desenlace> {
  const contexto = { productId: p.id, sku: p.sku };
  const previo = d.estado.producto(p.id);
  try {
    const { datos, avisos } = armarProducto(
      p,
      p.categoryId ? await categoriasDe() : new Map(),
      d.emisorId,
    );
    const existente = await d.emite.productoPorCodigo(d.emisorId, datos.codigo);

    if (existente) {
      const cambios = cambiosEntre(existente, datos);
      if (Object.keys(cambios).length === 0) {
        d.estado.guardarProducto({
          productId: p.id,
          sku: datos.codigo,
          estado: 'sincronizado',
          emiteId: existente.id,
          error: null,
        });
        return 'sinCambios';
      }
      const actualizado = await d.emite.actualizarProducto(existente.id, cambios);
      d.estado.guardarProducto({
        productId: p.id,
        sku: datos.codigo,
        estado: 'sincronizado',
        emiteId: actualizado.id,
        error: null,
      });
      log('info', 'producto actualizado en Emite DTE', {
        ...contexto,
        codigo: existente.codigo,
        cambios,
        avisos,
      });
      return 'actualizados';
    }

    if (!p.isActive) {
      throw new ErrorMapeo(
        'INACTIVO',
        `El producto «${datos.codigo}» está inactivo en Coreinbox y no existe en Emite DTE`,
      );
    }

    let creado: ProductoEmite;
    try {
      creado = await d.emite.crearProducto(datos);
    } catch (e) {
      // Alguien lo creó entre la consulta y el alta: se trata como existente.
      if (!(e instanceof ErrorEmite && e.code === 'PRODUCTO_DUPLICADO')) throw e;
      const ahora = await d.emite.productoPorCodigo(d.emisorId, datos.codigo);
      if (!ahora) throw e;
      const cambios = cambiosEntre(ahora, datos);
      creado =
        Object.keys(cambios).length > 0
          ? await d.emite.actualizarProducto(ahora.id, cambios)
          : ahora;
    }
    d.estado.guardarProducto({
      productId: p.id,
      sku: datos.codigo,
      estado: 'sincronizado',
      emiteId: creado.id,
      error: null,
    });
    log('info', 'producto creado en Emite DTE', { ...contexto, codigo: creado.codigo, avisos });
    return 'creados';
  } catch (e) {
    if ((e instanceof ErrorEmite || e instanceof ErrorCoreinbox) && e.transitorio) {
      log('warn', 'falla transitoria; se reintenta en la pasada siguiente', {
        ...contexto,
        error: e.message,
      });
      return 'pendientes';
    }
    const omitido = e instanceof ErrorMapeo;
    const mensaje =
      e instanceof ErrorMapeo || e instanceof ErrorEmite || e instanceof ErrorCoreinbox
        ? `${e.code}: ${e.message}`
        : String(e);
    // Se avisa una vez por motivo distinto: el mismo producto vuelve en cada pasada que lo cambie.
    if (previo?.error !== mensaje) {
      log(
        omitido ? 'warn' : 'error',
        omitido ? 'producto omitido' : 'Emite DTE rechazó el producto',
        { ...contexto, error: mensaje },
      );
    }
    d.estado.guardarProducto({
      productId: p.id,
      sku: p.sku?.trim() || null,
      estado: omitido ? 'omitido' : 'error',
      emiteId: previo?.emiteId ?? null,
      error: mensaje,
    });
    return omitido ? 'omitidos' : 'conError';
  }
}

/** Sólo nombre y precio, y sólo si cambiaron: el resto del producto se respeta como esté allá. */
function cambiosEntre(
  existente: ProductoEmite,
  datos: { nombre: string; precioNeto: number },
): CambiosProducto {
  return {
    ...(existente.nombre !== datos.nombre ? { nombre: datos.nombre } : {}),
    ...(Math.abs(existente.precioNeto - datos.precioNeto) >= 0.005
      ? { precioNeto: datos.precioNeto }
      : {}),
  };
}
