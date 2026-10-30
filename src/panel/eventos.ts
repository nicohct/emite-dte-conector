/**
 * Lo que la pantalla de eventos lee del estado: cotizaciones pasadas, webhooks vistos y productos,
 * en orden inverso y paginado. `Estado` todavía no expone listados, así que el panel abre el mismo
 * SQLite en modo de sólo lectura (una conexión por consulta) y lee sus tablas tal como están. Cuando
 * `Estado` tenga sus propios listados, esto pasa a usarlos y el SQL de acá desaparece.
 *
 * Cotizaciones y productos guardan sólo su último estado: la fecha de cada uno es la de su último
 * cambio, no un historial.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

export type TipoEvento = 'cotizacion' | 'webhook' | 'producto';

export interface Evento {
  tipo: TipoEvento;
  /** quote_id, id del webhook o product_id. */
  id: string;
  /** `creada`/`error`, `visto`, `sincronizado`/`omitido`/`error`. */
  estado: string;
  en: string;
  /** Número de la cotización en Coreinbox o SKU del producto. */
  referencia: string | null;
  emiteId: string | null;
  emiteNumero: number | null;
  /** Mensaje de error de la cotización, o motivo de omisión o error del producto. */
  detalle: string | null;
}

export const FLUJOS_EVENTOS = ['cotizaciones', 'productos'] as const;
export const ESTADOS_EVENTOS = ['creada', 'visto', 'sincronizado', 'omitido', 'error'] as const;

export interface FiltroEventos {
  flujo: (typeof FLUJOS_EVENTOS)[number] | null;
  estado: (typeof ESTADOS_EVENTOS)[number] | null;
  pagina: number;
  porPagina: number;
}

export interface PaginaEventos {
  eventos: Evento[];
  total: number;
}

const TODOS = `
  SELECT 'cotizacion' AS tipo, quote_id AS id, estado, actualizado_en AS en, quote_number AS referencia,
         emite_id, emite_numero, error AS detalle
  FROM cotizaciones
  UNION ALL
  SELECT 'webhook', id, 'visto', visto_en, NULL, NULL, NULL, NULL FROM webhooks_vistos
  UNION ALL
  SELECT 'producto', product_id, estado, actualizado_en, sku, emite_id, NULL, error FROM productos
`;

const TIPOS_DEL_FLUJO: Record<(typeof FLUJOS_EVENTOS)[number], TipoEvento[]> = {
  cotizaciones: ['cotizacion', 'webhook'],
  productos: ['producto'],
};

export function leerEventos(rutaEstado: string, f: FiltroEventos): PaginaEventos {
  const db = new DatabaseSync(rutaEstado, { readOnly: true });
  try {
    const condiciones: string[] = [];
    const valores: string[] = [];
    if (f.flujo) {
      const tipos = TIPOS_DEL_FLUJO[f.flujo];
      condiciones.push(`tipo IN (${tipos.map(() => '?').join(', ')})`);
      valores.push(...tipos);
    }
    if (f.estado) {
      condiciones.push('estado = ?');
      valores.push(f.estado);
    }
    const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM (${TODOS}) ${donde}`)
      .get(...valores) as { total: number };
    const filas = db
      .prepare(`SELECT * FROM (${TODOS}) ${donde} ORDER BY en DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...valores, f.porPagina, (f.pagina - 1) * f.porPagina) as Record<string, unknown>[];
    return {
      total,
      eventos: filas.map((r) => ({
        tipo: r.tipo as TipoEvento,
        id: r.id as string,
        estado: r.estado as string,
        en: r.en as string,
        referencia: (r.referencia as string | null) ?? null,
        emiteId: (r.emite_id as string | null) ?? null,
        emiteNumero: (r.emite_numero as number | null) ?? null,
        detalle: (r.detalle as string | null) ?? null,
      })),
    };
  } finally {
    db.close();
  }
}
