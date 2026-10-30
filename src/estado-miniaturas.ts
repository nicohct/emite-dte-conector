/**
 * Copia de la foto principal de cada SKU para el panel (tabla `miniaturas`, en el mismo SQLite que
 * `Estado`). Es caché derivado del índice del catálogo: cada fila lleva el hash de la entrada del
 * índice de la que salió y se reemplaza cuando ese hash cambia. Borrar la tabla no pierde nada; el
 * panel vuelve a descargar las fotos a medida que se piden.
 */
type DatabaseSync = import('node:sqlite').DatabaseSync;

export interface Miniatura {
  sku: string;
  /** Hash de la entrada del índice que se descargó. */
  hash: string;
  contentType: string;
  bytes: Uint8Array;
  obtenidaEn: string;
}

export class CacheMiniaturas {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS miniaturas (
        sku TEXT PRIMARY KEY, hash TEXT NOT NULL, content_type TEXT NOT NULL,
        bytes BLOB NOT NULL, obtenida_en TEXT NOT NULL
      );
    `);
  }

  miniatura(sku: string): Miniatura | null {
    const f = this.db.prepare('SELECT * FROM miniaturas WHERE sku = ?').get(sku) as
      Record<string, unknown> | undefined;
    return f
      ? {
          sku: f.sku as string,
          hash: f.hash as string,
          contentType: f.content_type as string,
          bytes: f.bytes as Uint8Array,
          obtenidaEn: f.obtenida_en as string,
        }
      : null;
  }

  guardar(m: Miniatura): void {
    this.db
      .prepare(
        `INSERT INTO miniaturas (sku, hash, content_type, bytes, obtenida_en) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET hash = excluded.hash, content_type = excluded.content_type,
           bytes = excluded.bytes, obtenida_en = excluded.obtenida_en`,
      )
      .run(m.sku, m.hash, m.contentType, m.bytes, m.obtenidaEn);
  }

  quitar(sku: string): void {
    this.db.prepare('DELETE FROM miniaturas WHERE sku = ?').run(sku);
  }
}
