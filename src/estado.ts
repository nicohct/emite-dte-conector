/**
 * Lo que el conector recuerda entre pasadas, en SQLite (`node:sqlite`, sin dependencias): el
 * cursor de sincronización, qué cotización de Coreinbox quedó en Emite DTE (o con qué error) y
 * qué webhooks ya se procesaron.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

export class Estado {
  private readonly db: DatabaseSync;

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
      CREATE TABLE IF NOT EXISTS webhooks_vistos (id TEXT PRIMARY KEY, visto_en TEXT NOT NULL);
    `);
  }

  get cursor(): string | null {
    const fila = this.db.prepare('SELECT valor FROM claves WHERE clave = ?').get('cursor') as
      { valor: string } | undefined;
    return fila?.valor ?? null;
  }

  set cursor(valor: string | null) {
    if (valor === null) this.db.prepare('DELETE FROM claves WHERE clave = ?').run('cursor');
    else {
      this.db
        .prepare(
          'INSERT INTO claves (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor',
        )
        .run('cursor', valor);
    }
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

  /** Marca el webhook como visto; devuelve false si ya lo estaba (entrega repetida). */
  marcarWebhook(id: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO webhooks_vistos (id, visto_en) VALUES (?, ?)')
      .run(id, new Date().toISOString());
    return r.changes === 1;
  }

  resumen(): { creadas: number; conError: number } {
    const f = this.db
      .prepare(
        `SELECT SUM(estado = 'creada') AS creadas, SUM(estado = 'error') AS con_error FROM cotizaciones`,
      )
      .get() as { creadas: number | null; con_error: number | null };
    return { creadas: f.creadas ?? 0, conError: f.con_error ?? 0 };
  }

  cerrar(): void {
    this.db.close();
  }
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
