/**
 * Lo que el conector recuerda entre pasadas, en SQLite (`node:sqlite`, sin dependencias): los
 * cursores de sincronización (cotizaciones y productos), qué cotización de Coreinbox quedó en
 * Emite DTE (o con qué error), qué producto pasó al catálogo (o por qué se omitió), qué webhooks
 * ya se procesaron, el registro canónico del catálogo (`estado.catalogo`, en `estado-catalogo.ts`)
 * y la caché de miniaturas del panel (`estado.miniaturas`).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RegistroCatalogo } from './estado-catalogo.js';
import { CacheMiniaturas } from './estado-miniaturas.js';

// `process.getBuiltinModule` en vez de `import`: las herramientas que analizan los imports (vite,
// vitest) todavía no reconocen `node:sqlite` como módulo nativo.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

export type EstadoCotizacion = 'creada' | 'error';

export interface FilaCotizacion {
  quoteId: string;
  quoteNumber: string;
  dealId: string | null;
  companyId: string | null;
  contactId: string | null;
  estado: EstadoCotizacion;
  emiteId: string | null;
  emiteNumero: number | null;
  error: string | null;
  actualizadoEn: string;
}

/**
 * `sincronizado`: está en el catálogo de Emite DTE (creado o al día). `omitido`: no viaja por un
 * dato de Coreinbox (sin SKU, otra moneda, inactivo…). `error`: Emite DTE lo rechazó (4xx).
 */
export type EstadoProducto = 'sincronizado' | 'omitido' | 'error';

export interface FilaProducto {
  productId: string;
  sku: string | null;
  estado: EstadoProducto;
  emiteId: string | null;
  error: string | null;
  actualizadoEn: string;
}

export type FlujoEvento = 'cotizaciones' | 'productos';

/**
 * Qué cuenta como evento: una cotización, un producto, un webhook visto y, del registro canónico,
 * un conflicto, un empate (propuesto o decidido) o una acción del panel.
 */
export type TipoEvento = 'cotizacion' | 'producto' | 'webhook' | 'conflicto' | 'empate' | 'accion';

export interface Evento {
  flujo: FlujoEvento;
  tipo: TipoEvento;
  /**
   * `creada`/`error` (cotización), `sincronizado`/`omitido`/`error` (producto), `visto`
   * (webhook), `abierto`/`resuelto` (conflicto), `propuesto`/`confirmado`/`rechazado` (empate) o
   * el nombre de la acción.
   */
  estado: string;
  en: string;
  /** Id en el sistema de origen (cotización o producto de Coreinbox, webhook, histórico…). */
  idExterno: string | null;
  emiteId: string | null;
  sku: string | null;
  /** Error, motivo, número de cotización, campo en conflicto o usuario de la acción. */
  mensaje: string | null;
}

export interface FiltroEventos {
  flujo?: FlujoEvento;
  estado?: string;
  /** Desde 1. */
  pagina?: number;
  porPagina?: number;
}

export interface Resumen {
  creadas: number;
  conError: number;
  productos: { sincronizados: number; omitidos: number; conError: number };
}

export class Estado {
  private readonly db: DatabaseSync;
  /** Registro canónico de productos por SKU (fase 1 del hub). */
  readonly catalogo: RegistroCatalogo;
  /** Copia de la foto principal por SKU para el panel; caché derivado del índice. */
  readonly miniaturas: CacheMiniaturas;

  constructor(ruta: string) {
    if (ruta !== ':memory:') mkdirSync(dirname(ruta), { recursive: true });
    this.db = new DatabaseSync(ruta);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS claves (clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cotizaciones (
        quote_id TEXT PRIMARY KEY,
        quote_number TEXT NOT NULL,
        deal_id TEXT,
        company_id TEXT,
        contact_id TEXT,
        estado TEXT NOT NULL,
        emite_id TEXT,
        emite_numero INTEGER,
        error TEXT,
        actualizado_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS productos (
        product_id TEXT PRIMARY KEY,
        sku TEXT,
        estado TEXT NOT NULL,
        emite_id TEXT,
        error TEXT,
        actualizado_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhooks_vistos (id TEXT PRIMARY KEY, visto_en TEXT NOT NULL);
    `);
    this.catalogo = new RegistroCatalogo(this.db, {
      leer: (nombre) => this.clave(nombre),
      guardar: (nombre, valor) => this.guardarClave(nombre, valor),
    });
    this.miniaturas = new CacheMiniaturas(this.db);
  }

  /** Cursor de las cotizaciones aceptadas. */
  get cursor(): string | null {
    return this.clave('cursor');
  }

  set cursor(valor: string | null) {
    this.guardarClave('cursor', valor);
  }

  /** Cursor de los productos; independiente del de cotizaciones. */
  get cursorProductos(): string | null {
    return this.clave('cursor_productos');
  }

  set cursorProductos(valor: string | null) {
    this.guardarClave('cursor_productos', valor);
  }

  cotizacion(quoteId: string): FilaCotizacion | null {
    const f = this.db.prepare('SELECT * FROM cotizaciones WHERE quote_id = ?').get(quoteId) as
      Record<string, unknown> | undefined;
    return f ? desdeFila(f) : null;
  }

  /** Busca por la cotización creada en Emite DTE (lo que trae el webhook). */
  porEmiteId(emiteId: string): FilaCotizacion | null {
    const f = this.db.prepare('SELECT * FROM cotizaciones WHERE emite_id = ?').get(emiteId) as
      Record<string, unknown> | undefined;
    return f ? desdeFila(f) : null;
  }

  guardarCotizacion(fila: Omit<FilaCotizacion, 'actualizadoEn'>): void {
    this.db
      .prepare(
        `INSERT INTO cotizaciones (quote_id, quote_number, deal_id, company_id, contact_id, estado, emite_id, emite_numero, error, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(quote_id) DO UPDATE SET
           quote_number = excluded.quote_number, deal_id = excluded.deal_id, company_id = excluded.company_id,
           contact_id = excluded.contact_id, estado = excluded.estado, emite_id = excluded.emite_id,
           emite_numero = excluded.emite_numero, error = excluded.error, actualizado_en = excluded.actualizado_en`,
      )
      .run(
        fila.quoteId,
        fila.quoteNumber,
        fila.dealId,
        fila.companyId,
        fila.contactId,
        fila.estado,
        fila.emiteId,
        fila.emiteNumero,
        fila.error,
        new Date().toISOString(),
      );
  }

  producto(productId: string): FilaProducto | null {
    const f = this.db.prepare('SELECT * FROM productos WHERE product_id = ?').get(productId) as
      Record<string, unknown> | undefined;
    return f
      ? {
          productId: f.product_id as string,
          sku: (f.sku as string | null) ?? null,
          estado: f.estado as EstadoProducto,
          emiteId: (f.emite_id as string | null) ?? null,
          error: (f.error as string | null) ?? null,
          actualizadoEn: f.actualizado_en as string,
        }
      : null;
  }

  guardarProducto(fila: Omit<FilaProducto, 'actualizadoEn'>): void {
    this.db
      .prepare(
        `INSERT INTO productos (product_id, sku, estado, emite_id, error, actualizado_en)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           sku = excluded.sku, estado = excluded.estado, emite_id = excluded.emite_id,
           error = excluded.error, actualizado_en = excluded.actualizado_en`,
      )
      .run(
        fila.productId,
        fila.sku,
        fila.estado,
        fila.emiteId,
        fila.error,
        new Date().toISOString(),
      );
  }

  /** Marca el webhook como visto; devuelve false si ya lo estaba (entrega repetida). */
  marcarWebhook(id: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO webhooks_vistos (id, visto_en) VALUES (?, ?)')
      .run(id, new Date().toISOString());
    return r.changes === 1;
  }

  resumen(): Resumen {
    const c = this.db
      .prepare(
        `SELECT SUM(estado = 'creada') AS creadas, SUM(estado = 'error') AS con_error FROM cotizaciones`,
      )
      .get() as { creadas: number | null; con_error: number | null };
    const p = this.db
      .prepare(
        `SELECT SUM(estado = 'sincronizado') AS sincronizados, SUM(estado = 'omitido') AS omitidos,
                SUM(estado = 'error') AS con_error
         FROM productos`,
      )
      .get() as { sincronizados: number | null; omitidos: number | null; con_error: number | null };
    return {
      creadas: c.creadas ?? 0,
      conError: c.con_error ?? 0,
      productos: {
        sincronizados: p.sincronizados ?? 0,
        omitidos: p.omitidos ?? 0,
        conError: p.con_error ?? 0,
      },
    };
  }

  /** Lo último que pasó en los flujos, más reciente primero y paginado (de a 50 por omisión). */
  eventos(filtro: FiltroEventos = {}): Evento[] {
    const { where, args } = condicionEventos(filtro);
    const porPagina = Math.min(500, Math.max(1, Math.trunc(filtro.porPagina ?? 50)));
    const pagina = Math.max(1, Math.trunc(filtro.pagina ?? 1));
    const filas = this.db
      .prepare(
        `SELECT * FROM (${EVENTOS_SQL}) ${where}
         ORDER BY en DESC, tipo, id_externo LIMIT ? OFFSET ?`,
      )
      .all(...args, porPagina, (pagina - 1) * porPagina) as Array<Record<string, unknown>>;
    return filas.map((f) => ({
      flujo: f.flujo as FlujoEvento,
      tipo: f.tipo as TipoEvento,
      estado: f.estado as string,
      en: f.en as string,
      idExterno: (f.id_externo as string | null) ?? null,
      emiteId: (f.emite_id as string | null) ?? null,
      sku: (f.sku as string | null) ?? null,
      mensaje: (f.mensaje as string | null) ?? null,
    }));
  }

  /** Total de eventos con el mismo filtro, para paginar. */
  contar(filtro: Omit<FiltroEventos, 'pagina' | 'porPagina'> = {}): number {
    const { where, args } = condicionEventos(filtro);
    const fila = this.db
      .prepare(`SELECT COUNT(*) AS n FROM (${EVENTOS_SQL}) ${where}`)
      .get(...args) as { n: number };
    return fila.n;
  }

  cerrar(): void {
    this.db.close();
  }

  private clave(nombre: string): string | null {
    const fila = this.db.prepare('SELECT valor FROM claves WHERE clave = ?').get(nombre) as
      { valor: string } | undefined;
    return fila?.valor ?? null;
  }

  private guardarClave(nombre: string, valor: string | null): void {
    if (valor === null) this.db.prepare('DELETE FROM claves WHERE clave = ?').run(nombre);
    else {
      this.db
        .prepare(
          'INSERT INTO claves (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
        )
        .run(nombre, valor);
    }
  }
}

/** Todas las tablas con fecha, en una sola forma; los webhooks son del flujo de cotizaciones. */
const EVENTOS_SQL = `
  SELECT 'cotizaciones' AS flujo, 'cotizacion' AS tipo, estado, actualizado_en AS en,
         quote_id AS id_externo, emite_id, NULL AS sku,
         CASE WHEN estado = 'error' THEN error ELSE quote_number END AS mensaje
  FROM cotizaciones
  UNION ALL
  SELECT 'productos', 'producto', estado, actualizado_en, product_id, emite_id, sku, error
  FROM productos
  UNION ALL
  SELECT 'cotizaciones', 'webhook', 'visto', visto_en, id, NULL, NULL, NULL FROM webhooks_vistos
  UNION ALL
  SELECT 'productos', 'conflicto', estado, COALESCE(resuelto_en, abierto_en), CAST(id AS TEXT),
         NULL, sku, campo
  FROM catalogo_conflictos
  UNION ALL
  SELECT 'productos', 'empate', estado, COALESCE(decidido_en, propuesto_en), emite_id, emite_id,
         sku, motivo
  FROM catalogo_empates
  UNION ALL
  SELECT 'productos', 'accion', accion, en, CAST(id AS TEXT), NULL, NULL, usuario
  FROM catalogo_acciones`;

function condicionEventos(filtro: Omit<FiltroEventos, 'pagina' | 'porPagina'>): {
  where: string;
  args: string[];
} {
  const donde: string[] = [];
  const args: string[] = [];
  if (filtro.flujo) {
    donde.push('flujo = ?');
    args.push(filtro.flujo);
  }
  if (filtro.estado) {
    donde.push('estado = ?');
    args.push(filtro.estado);
  }
  return { where: donde.length > 0 ? `WHERE ${donde.join(' AND ')}` : '', args };
}

function desdeFila(f: Record<string, unknown>): FilaCotizacion {
  return {
    quoteId: f.quote_id as string,
    quoteNumber: f.quote_number as string,
    dealId: (f.deal_id as string | null) ?? null,
    companyId: (f.company_id as string | null) ?? null,
    contactId: (f.contact_id as string | null) ?? null,
    estado: f.estado as EstadoCotizacion,
    emiteId: (f.emite_id as string | null) ?? null,
    emiteNumero: (f.emite_numero as number | null) ?? null,
    error: (f.error as string | null) ?? null,
    actualizadoEn: f.actualizado_en as string,
  };
}
