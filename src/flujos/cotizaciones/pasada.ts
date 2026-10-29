/**
 * Una pasada de sincronización: las cotizaciones aceptadas en Coreinbox desde el cursor pasan a
 * Emite DTE como cotizaciones externas (`origen: coreinbox`). Sigue la receta de
 * `docs/api-claves.md` §6: cursor = `meta.timestamp` de la primera página menos 5 minutos,
 * entrega al menos una vez, deduplicación por id (la nuestra y la de Emite DTE por `origen`).
 */
import type { Coreinbox, CotizacionResumen } from '../../adaptadores/coreinbox/cliente.js';
import { ErrorCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { EmiteDte, ErrorEmite } from '../../adaptadores/emite/cliente.js';
import type { Estado } from '../../estado.js';
import { log } from '../../log.js';
import { ErrorMapeo, MARGEN_CURSOR_MS, esTransitorio } from '../comun.js';
import { armarCotizacion } from './mapeo.js';

export interface Dependencias {
  coreinbox: Coreinbox;
  emite: EmiteDte;
  estado: Estado;
  emisorId: string;
  urlPublica: string;
  tipoActividad: string;
  desde: string;
}

export interface ResultadoPasada {
  revisadas: number;
  creadas: number;
  conError: number;
  /** Fallas transitorias: la cotización queda pendiente para la pasada siguiente. */
  pendientes: number;
}

export async function pasada(d: Dependencias): Promise<ResultadoPasada> {
  const desde = d.estado.cursor ?? d.desde;
  const r: ResultadoPasada = { revisadas: 0, creadas: 0, conError: 0, pendientes: 0 };
  let cursor: string | undefined;
  let timestampInicial: string | null = null;
  const vistas = new Set<string>();

  do {
    const pagina = await d.coreinbox.listarAceptadas(desde, cursor);
    timestampInicial ??= pagina.timestamp;
    for (const resumen of pagina.items) {
      if (vistas.has(resumen.id)) continue;
      vistas.add(resumen.id);
      if (resumen.status !== 'accepted') continue;
      if (d.estado.cotizacion(resumen.id)?.estado === 'creada') continue;
      r.revisadas++;
      const resultado = await procesar(d, resumen);
      r[resultado]++;
    }
    cursor = pagina.nextCursor ?? undefined;
  } while (cursor);

  // Si alguna quedó pendiente por una falla transitoria no se avanza el cursor: la pasada
  // siguiente la vuelve a ver. Las que fallaron por datos quedan registradas y no se repiten.
  if (timestampInicial && r.pendientes === 0) {
    d.estado.cursor = new Date(Date.parse(timestampInicial) - MARGEN_CURSOR_MS).toISOString();
  }
  return r;
}

async function procesar(
  d: Dependencias,
  resumen: CotizacionResumen,
): Promise<'creadas' | 'conError' | 'pendientes'> {
  const contexto = { quoteId: resumen.id, quoteNumber: resumen.quoteNumber };
  try {
    const q = await d.coreinbox.cotizacion(resumen.id);
    const [empresa, contacto] = await Promise.all([
      q.companyId ? d.coreinbox.empresa(q.companyId) : null,
      q.contactId ? d.coreinbox.contacto(q.contactId) : null,
    ]);
    const productoIds = [
      ...new Set(
        q.sections
          .flatMap((s) => s.items)
          .map((l) => l.productId)
          .filter((id): id is string => !!id),
      ),
    ];
    const skus = new Map<string, string>();
    for (const id of productoIds) {
      const sku = await d.coreinbox.skuDe(id);
      if (sku) skus.set(id, sku);
    }
    const mapeo = armarCotizacion({ cotizacion: q, empresa, contacto, skus }, d.emisorId);

    let creada;
    try {
      creada = await d.emite.crearCotizacion(mapeo.porRut);
    } catch (e) {
      if (e instanceof ErrorEmite && e.code === 'RECEPTOR_NO_EXISTE') {
        log('info', 'cliente nuevo en Emite DTE, se envía completo', {
          ...contexto,
          rut: mapeo.receptor.rut,
        });
        creada = await d.emite.crearCotizacion(mapeo.completo);
      } else throw e;
    }

    d.estado.guardarCotizacion({
      quoteId: q.id,
      quoteNumber: q.quoteNumber,
      dealId: q.dealId,
      companyId: q.companyId,
      contactId: q.contactId,
      estado: 'creada',
      emiteId: creada.id,
      emiteNumero: creada.numero,
      error: null,
    });
    log('info', 'cotización creada en Emite DTE', {
      ...contexto,
      emiteNumero: creada.numero,
      avisos: mapeo.avisos,
    });
    await anotar(d, q, {
      title: `Cotización ${q.quoteNumber} lista para facturar en Emite DTE (N° ${creada.numero})`,
      body:
        `Cliente ${creada.receptorSnapshot.razonSocial} (${creada.receptorSnapshot.rut}), total $${new Intl.NumberFormat('es-CL').format(creada.montoTotal)}.` +
        (mapeo.avisos.length ? `\nAvisos: ${mapeo.avisos.join('; ')}` : '') +
        `\n${d.urlPublica}/cotizaciones/${creada.id}`,
      metadata: { origen: 'emite-dte', evento: 'cotizacion.creada', cotizacionEmiteId: creada.id },
    });
    return 'creadas';
  } catch (e) {
    if (esTransitorio(e)) {
      log('warn', 'falla transitoria; se reintenta en la pasada siguiente', {
        ...contexto,
        error: e.message,
      });
      return 'pendientes';
    }
    const mensaje =
      e instanceof ErrorMapeo || e instanceof ErrorEmite || e instanceof ErrorCoreinbox
        ? `${e.code}: ${e.message}`
        : String(e);
    log('error', 'la cotización no se pudo pasar a Emite DTE', { ...contexto, error: mensaje });
    const previa = d.estado.cotizacion(resumen.id);
    d.estado.guardarCotizacion({
      quoteId: resumen.id,
      quoteNumber: resumen.quoteNumber,
      dealId: previa?.dealId ?? null,
      companyId: previa?.companyId ?? null,
      contactId: previa?.contactId ?? null,
      estado: 'error',
      emiteId: null,
      emiteNumero: null,
      error: mensaje,
    });
    // Se avisa en el CRM una sola vez por error distinto, para que alguien corrija el dato.
    if (previa?.error !== mensaje) {
      try {
        const q = await d.coreinbox.cotizacion(resumen.id).catch(() => null);
        await anotar(d, q ?? { id: resumen.id, dealId: null, companyId: null, contactId: null }, {
          title: `Cotización ${resumen.quoteNumber}: no se pudo pasar a facturación`,
          body: `${mensaje}\nCorrige el dato en Coreinbox; el conector lo vuelve a intentar al cambiar la cotización.`,
          metadata: { origen: 'emite-dte', evento: 'cotizacion.error', error: mensaje },
        });
      } catch (e2) {
        log('warn', 'no se pudo anotar el error en Coreinbox', { ...contexto, error: String(e2) });
      }
    }
    return 'conError';
  }
}

async function anotar(
  d: Dependencias,
  q: { id: string; dealId: string | null; companyId: string | null; contactId: string | null },
  actividad: { title: string; body: string; metadata: Record<string, unknown> },
): Promise<void> {
  if (!q.dealId && !q.companyId && !q.contactId) {
    log('warn', 'cotización sin negocio, empresa ni contacto: no hay dónde anotar', {
      quoteId: q.id,
    });
    return;
  }
  await d.coreinbox.crearActividad({
    typeId: d.tipoActividad,
    ...actividad,
    metadata: { ...actividad.metadata, quoteId: q.id },
    ...(q.dealId ? { dealId: q.dealId } : {}),
    ...(q.companyId ? { companyId: q.companyId } : {}),
    ...(q.contactId ? { contactId: q.contactId } : {}),
  });
}
