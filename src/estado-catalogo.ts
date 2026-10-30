/**
 * Registro canónico del catálogo por SKU, en el mismo SQLite que `Estado` (tablas `catalogo_*`).
 * Hay dos clases de dato y la diferencia importa por la regla de reconstruibilidad:
 *
 * - **Derivado** de lo leído en los tres sistemas: ids, última lectura de cada campo, producto
 *   calculado, históricos de Emite DTE, empates propuestos, índice de información, «sin SKU» y
 *   cursores. Si se borra, una pasada lo reconstruye igual.
 * - **Decisiones** de una persona desde el panel: quién manda, empates confirmados o rechazados,
 *   visibilidad aprobada o rechazada, categorías fuera de la web, conflictos resueltos y la
 *   bitácora de acciones. No son datos del producto sino órdenes que la escritura lleva a los
 *   sistemas (una fusión, una publicación). Viven en tablas propias, nunca se mezclan con lo
 *   derivado y son lo único que no se reconstruye leyendo: se respaldan con `exportarDecisiones`.
 *
 * La escritura (fase 1b) agrega lo operativo: qué escribió el conector en cada campo (`escrito_*`,
 * para reconocer el eco), cuándo vio un cambio que no era eco (`cambio_en`, para «último cambio»),
 * la hora de la primera escritura y la bitácora de escrituras (`catalogo_eventos`).
 */
type DatabaseSync = import('node:sqlite').DatabaseSync;

export type SistemaCatalogo = 'coreinbox' | 'woocommerce' | 'emite';
export const SISTEMAS_CATALOGO: readonly SistemaCatalogo[] = ['coreinbox', 'woocommerce', 'emite'];

/** Campos que viajan entre los tres (`precio` es bruto entero en pesos). */
export type CampoCompartido = 'nombre' | 'precio' | 'activo';
export const CAMPOS_COMPARTIDOS: readonly CampoCompartido[] = ['nombre', 'precio', 'activo'];
/** Los compartidos más los que el registro sólo lee para decidir tipo, alcance y exención. */
export type CampoCatalogo = CampoCompartido | 'tipo' | 'categoria' | 'exento';
export const CAMPOS_CATALOGO: readonly CampoCatalogo[] = [
  ...CAMPOS_COMPARTIDOS,
  'tipo',
  'categoria',
  'exento',
];

export type ValorCampo = string | number | boolean | null;
export type TipoProductoCatalogo = 'bien' | 'servicio';
export type VisibilidadWeb = 'no_aplica' | 'propuesto' | 'aprobado' | 'rechazado';
export type EstadoEmpate = 'propuesto' | 'confirmado' | 'rechazado';

/** Lo leído de un producto con SKU en un sistema. `extra` son datos del sistema (estado web, origen…). */
export interface Lectura {
  sku: string;
  sistema: SistemaCatalogo;
  idExterno: string;
  /** Hora del último cambio según el sistema. */
  modificadoEn: string | null;
  campos: Record<CampoCatalogo, ValorCampo>;
  extra: Record<string, unknown>;
}

export interface CampoLeido {
  valor: ValorCampo;
  /** Hora del sistema en que se vio este valor por primera vez. */
  vistoEn: string | null;
  leidoEn: string;
  /** Lo que el conector escribió en el campo, para reconocer el eco; null si no escribió. */
  escritoValor: ValorCampo;
  escritoEn: string | null;
  /**
   * Hora del conector en que vio en este sistema un cambio que no era eco; null en la primera
   * lectura, tras un eco y al partir la primera escritura. Es lo que ordena «último cambio».
   */
  cambioEn: string | null;
}

export interface LecturaGuardada {
  sistema: SistemaCatalogo;
  idExterno: string;
  modificadoEn: string | null;
  leidoEn: string;
  extra: Record<string, unknown>;
  campos: Partial<Record<CampoCatalogo, CampoLeido>>;
}

/** Un campo que cambió respecto de la lectura anterior (no cuenta la primera lectura ni el eco). */
export interface CambioCampo {
  sku: string;
  sistema: SistemaCatalogo;
  campo: CampoCatalogo;
  antes: ValorCampo;
  despues: ValorCampo;
  en: string | null;
}

export interface EntradaIndice {
  sistema: SistemaCatalogo;
  /** `pagina`, `imagen`, `atributos`, `metadatos`, `documento`, `categoria`, `producto`… */
  tipo: string;
  url: string;
  hash: string;
  leidoEn: string;
}

export type ModoCampo = 'propietario' | 'ultimo';

export interface ValorCanonico {
  valor: ValorCampo;
  fuente: SistemaCatalogo | null;
  modo?: ModoCampo;
  /** Hay un conflicto abierto en el campo: la 1b no lo escribe hasta que se resuelva. */
  conflicto?: true;
}

/** Lo que el registro calcula para un SKU desde sus lecturas, sus reglas y sus decisiones. */
export interface ProductoCatalogo {
  sku: string;
  tipo: TipoProductoCatalogo | null;
  alcance: SistemaCatalogo[];
  visibilidadWeb: VisibilidadWeb;
  canonico: Partial<Record<CampoCatalogo, ValorCanonico>>;
  /** Neto a dos decimales derivado del precio canónico bruto (lo que reciben Emite DTE y Coreinbox). */
  precioNeto: number | null;
  diferencias: Array<{
    campo: CampoCompartido;
    valores: Partial<Record<SistemaCatalogo, ValorCampo>>;
  }>;
  presentes: SistemaCatalogo[];
  faltaEn: SistemaCatalogo[];
  avisos: string[];
  /** Por qué tiene esa visibilidad web. */
  motivoVisibilidad?: MotivoVisibilidad;
  /** Lo que la escritura llevaría a cada sistema en la pasada siguiente (todos los sistemas). */
  escrituras?: EscrituraPlaneada[];
  /** Los sistemas del alcance donde la escritura lo crearía. */
  crearEn?: SistemaCatalogo[];
}

/**
 * `servicio` (nunca a la web), `decision` (del panel), `categoria` (de una categoría fuera de la
 * web, sin decisión), `en_web` (ya está en la tienda) o `sin_decision` (propuesto).
 */
export type MotivoVisibilidad = 'servicio' | 'decision' | 'categoria' | 'en_web' | 'sin_decision';

export interface EscrituraPlaneada {
  sistema: SistemaCatalogo;
  campo: CampoCatalogo;
  /** Lo que hay hoy en el sistema y lo que se escribiría (bruto en el precio). */
  antes: ValorCampo;
  valor: ValorCampo;
  /** El sistema lo cambió y no manda: se deshace (evento `revertido`). */
  revierte: boolean;
}

/** Qué hizo la escritura (o qué le pasó), para `Estado.eventos`. */
export type EstadoEventoCatalogo =
  'escrito' | 'revertido' | 'creado' | 'adoptado' | 'fusionado' | 'error';

export interface EventoCatalogo {
  id: number;
  en: string;
  estado: EstadoEventoCatalogo;
  sku: string;
  sistema: SistemaCatalogo;
  campo: CampoCatalogo | null;
  antes: ValorCampo;
  valor: ValorCampo;
  mensaje: string | null;
  /** Id en el sistema (el creado, el histórico adoptado o fusionado). */
  idExterno: string | null;
  /** Qué operación fue (`sku|sistema|operación`): una misma falla no se reintenta ni se repite. */
  clave: string | null;
}

export interface Conflicto {
  id: number;
  sku: string;
  campo: CampoCatalogo;
  valores: Partial<Record<SistemaCatalogo, { valor: ValorCampo; en: string | null }>>;
  abiertoEn: string;
  estado: 'abierto' | 'resuelto';
  resueltoCon: SistemaCatalogo | null;
  resueltoPor: string | null;
  resueltoEn: string | null;
}

/** Un producto de Emite DTE importado del historial del SII; no es fuente, se empata. */
export interface HistoricoEmite {
  emiteId: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  fusionadoEnId: string | null;
  uso: unknown;
  /** El SKU que `por-codigo` resuelve en este histórico (alias o código antiguo). */
  aliasSku: string | null;
  modificadoEn: string | null;
  leidoEn: string;
}

export interface Empate {
  emiteId: string;
  sku: string;
  puntaje: number;
  motivo: string;
  detalle: string;
  estado: EstadoEmpate;
  propuestoEn: string;
  decididoPor: string | null;
  decididoEn: string | null;
  /** Qué hizo la escritura con un empate confirmado; null mientras no lo lleva a Emite DTE. */
  resultado: ResultadoEmpate | null;
  resultadoEn: string | null;
  resultadoDetalle: string | null;
}

/** `requiere_mano`: Emite DTE no dejó fusionarlo (inventario, por ejemplo); no se reintenta. */
export type ResultadoEmpate = 'adoptado' | 'fusionado' | 'requiere_mano';

export interface SinSku {
  sistema: SistemaCatalogo;
  idExterno: string;
  nombre: string;
  precio: number | null;
  activo: boolean | null;
  modificadoEn: string | null;
  leidoEn: string;
}

/** Un sistema manda (propietario) o gana el último cambio que no sea eco (`ultimo`). */
export type FuenteRegla = SistemaCatalogo | 'ultimo';

export interface Regla {
  /** `*` para todo el catálogo, o un SKU. */
  ambito: string;
  campo: CampoCatalogo;
  fuente: FuenteRegla;
  usuario: string | null;
  en: string;
}

/** Una categoría de Coreinbox cuyos productos no van a la web salvo aprobación por SKU. */
export interface CategoriaFuera {
  categoria: string;
  usuario: string | null;
  en: string;
}

/** Las decisiones humanas, tal como las exporta e importa `GET/POST /catalogo/decisiones`. */
export interface Decisiones {
  version: 1;
  reglas: Regla[];
  empates: Array<{
    emiteId: string;
    sku: string;
    estado: 'confirmado' | 'rechazado';
    decididoPor: string | null;
    decididoEn: string | null;
  }>;
  conflictos: Array<Omit<Conflicto, 'id' | 'estado'>>;
  visibilidad: Array<DecisionVisibilidad & { sku: string }>;
  categoriasFuera: CategoriaFuera[];
}

export interface DecisionVisibilidad {
  estado: 'aprobado' | 'rechazado';
  usuario: string | null;
  en: string;
}

export interface FiltroCatalogo {
  q?: string;
  diferencias?: boolean;
  conflicto?: boolean;
  /** Le falta alguno de los sistemas de su alcance. */
  sinSku?: boolean;
  propuestoWeb?: boolean;
  /** Tiene algún histórico de Emite DTE propuesto como empate. */
  historicos?: boolean;
  /** Rechazado en la web sólo por su categoría (sin decisión por SKU). */
  rechazadoPorCategoria?: boolean;
}

export interface ResumenCatalogo {
  skus: number;
  /** Productos leídos por sistema, con y sin SKU (en Emite DTE, también los históricos). */
  leidos: Record<SistemaCatalogo, number>;
  historicos: number;
  conDiferencias: number;
  enConflicto: number;
  empatesPropuestos: number;
  sinSku: number;
}

type Fila = Record<string, unknown>;
const json = (v: unknown): string => JSON.stringify(v);
const deJson = <T>(v: unknown, porOmision: T): T =>
  typeof v === 'string' ? (JSON.parse(v) as T) : porOmision;
const iguales = (a: ValorCampo, b: ValorCampo): boolean => json(a) === json(b);
const texto = (v: unknown): string | null => (v as string | null) ?? null;

export class RegistroCatalogo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly claves: {
      leer: (nombre: string) => string | null;
      guardar: (nombre: string, valor: string | null) => void;
    },
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalogo_ids (
        sku TEXT NOT NULL, sistema TEXT NOT NULL, id_externo TEXT NOT NULL,
        modificado_en TEXT, leido_en TEXT NOT NULL, extra TEXT NOT NULL,
        PRIMARY KEY (sku, sistema)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS catalogo_ids_externo ON catalogo_ids (sistema, id_externo);
      CREATE TABLE IF NOT EXISTS catalogo_campos (
        sku TEXT NOT NULL, sistema TEXT NOT NULL, campo TEXT NOT NULL,
        valor TEXT NOT NULL, visto_en TEXT, leido_en TEXT NOT NULL,
        escrito_valor TEXT, escrito_en TEXT,
        PRIMARY KEY (sku, sistema, campo)
      );
      CREATE TABLE IF NOT EXISTS catalogo_productos (
        sku TEXT PRIMARY KEY, datos TEXT NOT NULL,
        con_diferencias INTEGER NOT NULL, con_faltantes INTEGER NOT NULL,
        visibilidad_web TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogo_indice (
        sku TEXT NOT NULL, sistema TEXT NOT NULL, tipo TEXT NOT NULL, url TEXT NOT NULL,
        hash TEXT NOT NULL, leido_en TEXT NOT NULL,
        PRIMARY KEY (sku, sistema, tipo, url)
      );
      CREATE TABLE IF NOT EXISTS catalogo_historicos (
        emite_id TEXT PRIMARY KEY, codigo TEXT NOT NULL, nombre TEXT NOT NULL,
        activo INTEGER NOT NULL, fusionado_en_id TEXT, uso TEXT, alias_sku TEXT,
        modificado_en TEXT, leido_en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogo_sin_sku (
        sistema TEXT NOT NULL, id_externo TEXT NOT NULL, nombre TEXT NOT NULL,
        precio INTEGER, activo INTEGER, modificado_en TEXT, leido_en TEXT NOT NULL,
        PRIMARY KEY (sistema, id_externo)
      );
      CREATE TABLE IF NOT EXISTS catalogo_empates (
        emite_id TEXT NOT NULL, sku TEXT NOT NULL, puntaje REAL NOT NULL, motivo TEXT NOT NULL,
        detalle TEXT NOT NULL, estado TEXT NOT NULL, propuesto_en TEXT NOT NULL,
        decidido_por TEXT, decidido_en TEXT,
        PRIMARY KEY (emite_id, sku)
      );
      CREATE TABLE IF NOT EXISTS catalogo_conflictos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, campo TEXT NOT NULL,
        valores TEXT NOT NULL, abierto_en TEXT NOT NULL, estado TEXT NOT NULL,
        resuelto_con TEXT, resuelto_por TEXT, resuelto_en TEXT
      );
      CREATE TABLE IF NOT EXISTS catalogo_reglas (
        ambito TEXT NOT NULL, campo TEXT NOT NULL, fuente TEXT NOT NULL,
        usuario TEXT, en TEXT NOT NULL,
        PRIMARY KEY (ambito, campo)
      );
      CREATE TABLE IF NOT EXISTS catalogo_visibilidad (
        sku TEXT PRIMARY KEY, estado TEXT NOT NULL, usuario TEXT, en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogo_acciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT, en TEXT NOT NULL, usuario TEXT,
        accion TEXT NOT NULL, detalle TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogo_categorias_fuera (
        categoria TEXT PRIMARY KEY, usuario TEXT, en TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS catalogo_eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, en TEXT NOT NULL, estado TEXT NOT NULL,
        sku TEXT NOT NULL, sistema TEXT NOT NULL, campo TEXT, antes TEXT, valor TEXT,
        mensaje TEXT, id_externo TEXT, clave TEXT
      );
      CREATE INDEX IF NOT EXISTS catalogo_eventos_clave ON catalogo_eventos (clave, id);
      CREATE INDEX IF NOT EXISTS catalogo_eventos_sku ON catalogo_eventos (sku, id);
    `);
    // Columnas que llegaron con la fase 1b sobre tablas de la 1a.
    agregarColumna(db, 'catalogo_campos', 'cambio_en', 'TEXT');
    agregarColumna(db, 'catalogo_empates', 'resultado', 'TEXT');
    agregarColumna(db, 'catalogo_empates', 'resultado_en', 'TEXT');
    agregarColumna(db, 'catalogo_empates', 'resultado_detalle', 'TEXT');
  }

  /**
   * Hora en que corrió la primera escritura. Antes de ella «último cambio» no rige: manda la regla
   * de arranque, y eso es lo que la primera escritura aplica.
   */
  primeraEscritura(): string | null {
    return this.claves.leer('catalogo_primera_escritura');
  }

  /**
   * Marca la primera escritura: desde aquí cuenta «último cambio». Los cambios vistos antes se
   * olvidan (la primera escritura aplica el arranque), salvo lo que una persona eligió al resolver
   * un conflicto, que cuenta como un cambio de ese sistema en este momento.
   */
  iniciarEscritura(en: string): void {
    if (this.primeraEscritura()) return;
    this.transaccion(() => {
      this.db.exec('UPDATE catalogo_campos SET cambio_en = NULL');
      const marcar = this.db.prepare(
        'UPDATE catalogo_campos SET cambio_en = ? WHERE sku = ? AND sistema = ? AND campo = ?',
      );
      for (const c of this.conflictosResueltos()) {
        if (c.resueltoCon) marcar.run(en, c.sku, c.resueltoCon, c.campo);
      }
      this.claves.guardar('catalogo_primera_escritura', en);
    });
  }

  /** Cursor propio de cada sistema para el catálogo; independiente de `cursor_productos`. */
  cursor(sistema: SistemaCatalogo): string | null {
    return this.claves.leer(`cursor_catalogo_${sistema}`);
  }

  guardarCursor(sistema: SistemaCatalogo, valor: string | null): void {
    this.claves.guardar(`cursor_catalogo_${sistema}`, valor);
  }

  /** Corre `f` en una transacción; dentro de otra, se suma a ella. */
  transaccion<T>(f: () => T): T {
    if (this.db.isTransaction) return f();
    this.db.exec('BEGIN');
    try {
      const r = f();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** El SKU con que quedó registrado un id de un sistema, si lo hay. */
  skuDe(sistema: SistemaCatalogo, idExterno: string): string | null {
    const f = this.db
      .prepare('SELECT sku FROM catalogo_ids WHERE sistema = ? AND id_externo = ?')
      .get(sistema, idExterno) as { sku: string } | undefined;
    return f?.sku ?? null;
  }

  /**
   * Guarda una lectura con su índice y devuelve los campos que cambiaron respecto de la anterior.
   * Si el id estaba con otro SKU (se cambió el SKU en el sistema), la lectura vieja se quita y su
   * SKU vuelve en `skuAnterior` para recalcularlo.
   */
  guardarLectura(
    l: Lectura,
    indice: EntradaIndice[],
    leidoEn: string,
  ): { cambios: CambioCampo[]; skuAnterior: string | null } {
    const anterior = this.skuDe(l.sistema, l.idExterno);
    const skuAnterior = anterior !== null && anterior !== l.sku ? anterior : null;
    if (skuAnterior) this.quitarLectura(skuAnterior, l.sistema);
    this.db
      .prepare(
        `INSERT INTO catalogo_ids (sku, sistema, id_externo, modificado_en, leido_en, extra)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sku, sistema) DO UPDATE SET id_externo = excluded.id_externo,
           modificado_en = excluded.modificado_en, leido_en = excluded.leido_en, extra = excluded.extra`,
      )
      .run(l.sku, l.sistema, l.idExterno, l.modificadoEn, leidoEn, json(l.extra));

    const cambios: CambioCampo[] = [];
    const previo = this.db.prepare(
      `SELECT valor, visto_en, escrito_valor, escrito_en, cambio_en FROM catalogo_campos
       WHERE sku = ? AND sistema = ? AND campo = ?`,
    );
    const guardar = this.db.prepare(
      `INSERT INTO catalogo_campos
         (sku, sistema, campo, valor, visto_en, leido_en, escrito_valor, escrito_en, cambio_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sku, sistema, campo) DO UPDATE SET valor = excluded.valor,
         visto_en = excluded.visto_en, leido_en = excluded.leido_en,
         escrito_valor = excluded.escrito_valor, escrito_en = excluded.escrito_en,
         cambio_en = excluded.cambio_en`,
    );
    for (const campo of CAMPOS_CATALOGO) {
      const valor = l.campos[campo];
      const p = previo.get(l.sku, l.sistema, campo) as Fila | undefined;
      const antes = p ? deJson<ValorCampo>(p.valor, null) : undefined;
      const mismo = antes !== undefined && iguales(antes, valor);
      let escritoValor = texto(p?.escrito_valor);
      let escritoEn = texto(p?.escrito_en);
      let cambioEn = texto(p?.cambio_en);
      if (antes !== undefined && !mismo) {
        const eco = escritoValor !== null && iguales(deJson(escritoValor, null), valor);
        if (eco) {
          cambioEn = null;
        } else {
          // Un cambio de alguien más: lo escrito antes ya no sirve para reconocer un eco.
          escritoValor = null;
          escritoEn = null;
          cambioEn = leidoEn;
          cambios.push({
            sku: l.sku,
            sistema: l.sistema,
            campo,
            antes,
            despues: valor,
            en: l.modificadoEn,
          });
        }
      }
      const vistoEn = mismo ? texto(p?.visto_en) : l.modificadoEn;
      guardar.run(
        l.sku,
        l.sistema,
        campo,
        json(valor),
        vistoEn,
        leidoEn,
        escritoValor,
        escritoEn,
        cambioEn,
      );
    }

    this.db
      .prepare('DELETE FROM catalogo_indice WHERE sku = ? AND sistema = ?')
      .run(l.sku, l.sistema);
    const entrada = this.db.prepare(
      `INSERT OR REPLACE INTO catalogo_indice (sku, sistema, tipo, url, hash, leido_en)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of indice) entrada.run(l.sku, l.sistema, e.tipo, e.url, e.hash, e.leidoEn);
    this.quitarSinSku(l.sistema, l.idExterno);
    return { cambios, skuAnterior };
  }

  /** Quita lo leído de un SKU en un sistema: ids, campos e índice. */
  quitarLectura(sku: string, sistema: SistemaCatalogo): void {
    for (const tabla of ['catalogo_ids', 'catalogo_campos', 'catalogo_indice']) {
      this.db.prepare(`DELETE FROM ${tabla} WHERE sku = ? AND sistema = ?`).run(sku, sistema);
    }
  }

  /** Quita la lectura de un id (por ejemplo, porque perdió el SKU); devuelve el SKU que tenía. */
  quitarLecturaDeId(sistema: SistemaCatalogo, idExterno: string): string | null {
    const sku = this.skuDe(sistema, idExterno);
    if (sku) this.quitarLectura(sku, sistema);
    return sku;
  }

  lecturas(sku: string): Partial<Record<SistemaCatalogo, LecturaGuardada>> {
    const r: Partial<Record<SistemaCatalogo, LecturaGuardada>> = {};
    const ids = this.db.prepare('SELECT * FROM catalogo_ids WHERE sku = ?').all(sku) as Fila[];
    for (const f of ids) {
      const sistema = f.sistema as SistemaCatalogo;
      r[sistema] = {
        sistema,
        idExterno: f.id_externo as string,
        modificadoEn: texto(f.modificado_en),
        leidoEn: f.leido_en as string,
        extra: deJson(f.extra, {}),
        campos: {},
      };
    }
    const campos = this.db
      .prepare('SELECT * FROM catalogo_campos WHERE sku = ?')
      .all(sku) as Fila[];
    for (const f of campos) {
      const lectura = r[f.sistema as SistemaCatalogo];
      if (!lectura) continue;
      lectura.campos[f.campo as CampoCatalogo] = {
        valor: deJson<ValorCampo>(f.valor, null),
        vistoEn: texto(f.visto_en),
        leidoEn: f.leido_en as string,
        escritoValor: deJson<ValorCampo>(f.escrito_valor, null),
        escritoEn: texto(f.escrito_en),
        cambioEn: texto(f.cambio_en),
      };
    }
    return r;
  }

  /** Anota lo que el conector escribió en un campo, para reconocer el eco en la lectura siguiente. */
  marcarEscrito(
    sku: string,
    sistema: SistemaCatalogo,
    campo: CampoCatalogo,
    valor: ValorCampo,
    en: string,
  ): void {
    this.db
      .prepare(
        `UPDATE catalogo_campos SET escrito_valor = ?, escrito_en = ?
         WHERE sku = ? AND sistema = ? AND campo = ?`,
      )
      .run(json(valor), en, sku, sistema, campo);
  }

  /**
   * Al resolver un conflicto en «último cambio»: el valor del sistema elegido pasa a ser el último
   * cambio y los de los demás dejan de contar como cambio.
   */
  elegirCambio(sku: string, campo: CampoCatalogo, sistema: SistemaCatalogo, en: string): void {
    this.db
      .prepare(
        `UPDATE catalogo_campos SET cambio_en = CASE WHEN sistema = ? THEN ? ELSE NULL END
         WHERE sku = ? AND campo = ?`,
      )
      .run(sistema, en, sku, campo);
  }

  /** Todos los SKU con alguna lectura o con producto calculado. */
  skus(): string[] {
    const filas = this.db
      .prepare('SELECT sku FROM catalogo_ids UNION SELECT sku FROM catalogo_productos ORDER BY sku')
      .all() as Array<{ sku: string }>;
    return filas.map((f) => f.sku);
  }

  /** Nombres leídos en las fuentes (Coreinbox y la web) por SKU, para proponer empates. */
  nombresPorSku(): Map<string, string[]> {
    const filas = this.db
      .prepare(
        `SELECT sku, valor FROM catalogo_campos
         WHERE campo = 'nombre' AND sistema IN ('coreinbox', 'woocommerce') ORDER BY sku, sistema`,
      )
      .all() as Array<{ sku: string; valor: string }>;
    const r = new Map<string, string[]>();
    for (const f of filas) {
      const nombre = deJson<ValorCampo>(f.valor, null);
      if (typeof nombre === 'string') r.set(f.sku, [...(r.get(f.sku) ?? []), nombre]);
    }
    return r;
  }

  guardarProducto(p: ProductoCatalogo): void {
    this.db
      .prepare(
        `INSERT INTO catalogo_productos (sku, datos, con_diferencias, con_faltantes, visibilidad_web)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET datos = excluded.datos,
           con_diferencias = excluded.con_diferencias, con_faltantes = excluded.con_faltantes,
           visibilidad_web = excluded.visibilidad_web`,
      )
      .run(
        p.sku,
        json(p),
        p.diferencias.length > 0 ? 1 : 0,
        p.faltaEn.length > 0 ? 1 : 0,
        p.visibilidadWeb,
      );
  }

  quitarProducto(sku: string): void {
    this.db.prepare('DELETE FROM catalogo_productos WHERE sku = ?').run(sku);
  }

  producto(sku: string): ProductoCatalogo | null {
    const f = this.db.prepare('SELECT datos FROM catalogo_productos WHERE sku = ?').get(sku) as
      Fila | undefined;
    return f ? deJson<ProductoCatalogo | null>(f.datos, null) : null;
  }

  /** Productos calculados por SKU, filtrados y paginados (`pagina` desde 1). */
  listar(
    filtro: FiltroCatalogo,
    pagina: number,
    limite: number,
  ): { items: ProductoCatalogo[]; total: number } {
    const donde: string[] = [];
    const args: string[] = [];
    if (filtro.q) {
      donde.push(`(p.sku LIKE ? ESCAPE '\\' OR p.datos LIKE ? ESCAPE '\\')`);
      const patron = `%${filtro.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(patron, patron);
    }
    if (filtro.diferencias) donde.push('p.con_diferencias = 1');
    if (filtro.sinSku) donde.push('p.con_faltantes = 1');
    if (filtro.propuestoWeb) donde.push(`p.visibilidad_web = 'propuesto'`);
    if (filtro.rechazadoPorCategoria) {
      donde.push(
        `p.visibilidad_web = 'rechazado' AND json_extract(p.datos, '$.motivoVisibilidad') = 'categoria'`,
      );
    }
    if (filtro.conflicto) {
      donde.push(
        `EXISTS (SELECT 1 FROM catalogo_conflictos c WHERE c.sku = p.sku AND c.estado = 'abierto')`,
      );
    }
    if (filtro.historicos) {
      donde.push(
        `EXISTS (SELECT 1 FROM catalogo_empates e WHERE e.sku = p.sku AND e.estado = 'propuesto')`,
      );
    }
    const where = donde.length > 0 ? `WHERE ${donde.join(' AND ')}` : '';
    const { n: total } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM catalogo_productos p ${where}`)
      .get(...args) as { n: number };
    const filas = this.db
      .prepare(`SELECT p.datos FROM catalogo_productos p ${where} ORDER BY p.sku LIMIT ? OFFSET ?`)
      .all(...args, limite, (pagina - 1) * limite) as Fila[];
    return { items: filas.map((f) => JSON.parse(f.datos as string) as ProductoCatalogo), total };
  }

  indice(sku: string): EntradaIndice[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_indice WHERE sku = ? ORDER BY sistema, tipo, url')
      .all(sku) as Fila[];
    return filas.map((f) => ({
      sistema: f.sistema as SistemaCatalogo,
      tipo: f.tipo as string,
      url: f.url as string,
      hash: f.hash as string,
      leidoEn: f.leido_en as string,
    }));
  }

  /**
   * Las imágenes del índice de un SKU, por sistema y en el orden en que el sistema las entregó: la
   * primera de cada sistema es su foto principal.
   */
  fotos(sku: string): EntradaIndice[] {
    const filas = this.db
      .prepare(
        `SELECT * FROM catalogo_indice WHERE sku = ? AND tipo = 'imagen' ORDER BY sistema, rowid`,
      )
      .all(sku) as Fila[];
    return filas.map((f) => ({
      sistema: f.sistema as SistemaCatalogo,
      tipo: f.tipo as string,
      url: f.url as string,
      hash: f.hash as string,
      leidoEn: f.leido_en as string,
    }));
  }

  // --- Históricos de Emite DTE ---

  guardarHistorico(h: Omit<HistoricoEmite, 'aliasSku'>): void {
    this.db
      .prepare(
        `INSERT INTO catalogo_historicos
           (emite_id, codigo, nombre, activo, fusionado_en_id, uso, modificado_en, leido_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(emite_id) DO UPDATE SET codigo = excluded.codigo, nombre = excluded.nombre,
           activo = excluded.activo, fusionado_en_id = excluded.fusionado_en_id, uso = excluded.uso,
           modificado_en = excluded.modificado_en, leido_en = excluded.leido_en`,
      )
      .run(
        h.emiteId,
        h.codigo,
        h.nombre,
        h.activo ? 1 : 0,
        h.fusionadoEnId,
        json(h.uso ?? null),
        h.modificadoEn,
        h.leidoEn,
      );
  }

  /** Anota que `por-codigo` resuelve `sku` en este histórico. */
  marcarAlias(emiteId: string, sku: string): void {
    this.db
      .prepare('UPDATE catalogo_historicos SET alias_sku = ? WHERE emite_id = ?')
      .run(sku, emiteId);
  }

  historicos(): HistoricoEmite[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_historicos ORDER BY codigo, emite_id')
      .all() as Fila[];
    return filas.map(historicoDesdeFila);
  }

  /** Los históricos sin fusionar cuyo código es exactamente `codigo`. */
  historicosConCodigo(codigo: string): HistoricoEmite[] {
    const filas = this.db
      .prepare(
        `SELECT * FROM catalogo_historicos WHERE TRIM(codigo) = ? AND fusionado_en_id IS NULL
         ORDER BY emite_id`,
      )
      .all(codigo) as Fila[];
    return filas.map(historicoDesdeFila);
  }

  historico(emiteId: string): HistoricoEmite | null {
    const f = this.db
      .prepare('SELECT * FROM catalogo_historicos WHERE emite_id = ?')
      .get(emiteId) as Fila | undefined;
    return f ? historicoDesdeFila(f) : null;
  }

  // --- Empates ---

  /**
   * Reemplaza la propuesta vigente de un histórico (o la quita con `null`). Las filas confirmadas o
   * rechazadas no se tocan.
   */
  proponerEmpate(
    emiteId: string,
    candidato: { sku: string; puntaje: number; motivo: string; detalle: string } | null,
    en: string,
  ): void {
    this.db
      .prepare(`DELETE FROM catalogo_empates WHERE emite_id = ? AND estado = 'propuesto'`)
      .run(emiteId);
    if (!candidato) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO catalogo_empates
           (emite_id, sku, puntaje, motivo, detalle, estado, propuesto_en)
         VALUES (?, ?, ?, ?, ?, 'propuesto', ?)`,
      )
      .run(emiteId, candidato.sku, candidato.puntaje, candidato.motivo, candidato.detalle, en);
  }

  empatesDeHistorico(emiteId: string): Empate[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_empates WHERE emite_id = ? ORDER BY sku')
      .all(emiteId) as Fila[];
    return filas.map(empateDesdeFila);
  }

  empatesDeSku(sku: string): Empate[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_empates WHERE sku = ? ORDER BY puntaje DESC, emite_id')
      .all(sku) as Fila[];
    return filas.map(empateDesdeFila);
  }

  empates(estado?: EstadoEmpate): Empate[] {
    const filas = (
      estado
        ? this.db
            .prepare('SELECT * FROM catalogo_empates WHERE estado = ? ORDER BY sku, emite_id')
            .all(estado)
        : this.db.prepare('SELECT * FROM catalogo_empates ORDER BY sku, emite_id').all()
    ) as Fila[];
    return filas.map(empateDesdeFila);
  }

  /** Confirma o rechaza un empate (decisión). Confirmar uno retira la propuesta del histórico. */
  decidirEmpate(
    emiteId: string,
    sku: string,
    estado: 'confirmado' | 'rechazado',
    usuario: string | null,
    en: string,
  ): void {
    if (estado === 'confirmado') {
      this.db
        .prepare(
          `DELETE FROM catalogo_empates WHERE emite_id = ? AND sku <> ? AND estado <> 'rechazado'`,
        )
        .run(emiteId, sku);
    }
    const r = this.db
      .prepare(
        `UPDATE catalogo_empates SET estado = ?, decidido_por = ?, decidido_en = ?,
           resultado = NULL, resultado_en = NULL, resultado_detalle = NULL
         WHERE emite_id = ? AND sku = ?`,
      )
      .run(estado, usuario, en, emiteId, sku);
    if (r.changes === 0) {
      this.db
        .prepare(
          `INSERT INTO catalogo_empates
             (emite_id, sku, puntaje, motivo, detalle, estado, propuesto_en, decidido_por, decidido_en)
           VALUES (?, ?, 1, 'manual', 'elegido a mano en el panel', ?, ?, ?, ?)`,
        )
        .run(emiteId, sku, estado, en, usuario, en);
    }
  }

  /** Anota lo que la escritura hizo con un empate confirmado. */
  marcarResultadoEmpate(
    emiteId: string,
    sku: string,
    resultado: ResultadoEmpate,
    detalle: string | null,
    en: string,
  ): void {
    this.db
      .prepare(
        `UPDATE catalogo_empates SET resultado = ?, resultado_en = ?, resultado_detalle = ?
         WHERE emite_id = ? AND sku = ?`,
      )
      .run(resultado, en, detalle, emiteId, sku);
  }

  // --- Sin SKU ---

  guardarSinSku(s: SinSku): void {
    this.quitarLecturaDeId(s.sistema, s.idExterno);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO catalogo_sin_sku
           (sistema, id_externo, nombre, precio, activo, modificado_en, leido_en)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.sistema,
        s.idExterno,
        s.nombre,
        s.precio,
        s.activo === null ? null : s.activo ? 1 : 0,
        s.modificadoEn,
        s.leidoEn,
      );
  }

  quitarSinSku(sistema: SistemaCatalogo, idExterno: string): void {
    this.db
      .prepare('DELETE FROM catalogo_sin_sku WHERE sistema = ? AND id_externo = ?')
      .run(sistema, idExterno);
  }

  sinSku(): SinSku[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_sin_sku ORDER BY sistema, nombre, id_externo')
      .all() as Fila[];
    return filas.map((f) => ({
      sistema: f.sistema as SistemaCatalogo,
      idExterno: f.id_externo as string,
      nombre: f.nombre as string,
      precio: (f.precio as number | null) ?? null,
      activo: f.activo === null ? null : f.activo === 1,
      modificadoEn: texto(f.modificado_en),
      leidoEn: f.leido_en as string,
    }));
  }

  // --- Conflictos ---

  /** Abre un conflicto, o actualiza los valores del que ya está abierto en ese campo. */
  abrirConflicto(
    sku: string,
    campo: CampoCatalogo,
    valores: Conflicto['valores'],
    en: string,
  ): void {
    const abierto = this.db
      .prepare(
        `SELECT id FROM catalogo_conflictos WHERE sku = ? AND campo = ? AND estado = 'abierto'`,
      )
      .get(sku, campo) as { id: number } | undefined;
    if (abierto) {
      this.db
        .prepare('UPDATE catalogo_conflictos SET valores = ? WHERE id = ?')
        .run(json(valores), abierto.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO catalogo_conflictos (sku, campo, valores, abierto_en, estado)
         VALUES (?, ?, ?, ?, 'abierto')`,
      )
      .run(sku, campo, json(valores), en);
  }

  conflicto(id: number): Conflicto | null {
    const f = this.db.prepare('SELECT * FROM catalogo_conflictos WHERE id = ?').get(id) as
      Fila | undefined;
    return f ? conflictoDesdeFila(f) : null;
  }

  conflictos(sku: string, soloAbiertos = false): Conflicto[] {
    const filas = this.db
      .prepare(
        `SELECT * FROM catalogo_conflictos WHERE sku = ?
         ${soloAbiertos ? `AND estado = 'abierto'` : ''} ORDER BY id`,
      )
      .all(sku) as Fila[];
    return filas.map(conflictoDesdeFila);
  }

  /** Los conflictos abiertos de todo el catálogo, por SKU y campo. */
  conflictosAbiertos(): Conflicto[] {
    const filas = this.db
      .prepare(`SELECT * FROM catalogo_conflictos WHERE estado = 'abierto' ORDER BY sku, campo, id`)
      .all() as Fila[];
    return filas.map(conflictoDesdeFila);
  }

  conflictosResueltos(): Conflicto[] {
    const filas = this.db
      .prepare(`SELECT * FROM catalogo_conflictos WHERE estado = 'resuelto' ORDER BY id`)
      .all() as Fila[];
    return filas.map(conflictoDesdeFila);
  }

  resolverConflicto(id: number, fuente: SistemaCatalogo, usuario: string | null, en: string): void {
    this.db
      .prepare(
        `UPDATE catalogo_conflictos SET estado = 'resuelto', resuelto_con = ?, resuelto_por = ?,
           resuelto_en = ? WHERE id = ?`,
      )
      .run(fuente, usuario, en, id);
  }

  // --- Decisiones: quién manda y visibilidad web ---

  reglas(): Regla[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_reglas ORDER BY ambito, campo')
      .all() as Fila[];
    return filas.map((f) => ({
      ambito: f.ambito as string,
      campo: f.campo as CampoCatalogo,
      fuente: f.fuente as FuenteRegla,
      usuario: texto(f.usuario),
      en: f.en as string,
    }));
  }

  /** Fija quién manda en un campo (`ambito` `*` o un SKU); `fuente` null vuelve a la de arranque. */
  guardarRegla(
    ambito: string,
    campo: CampoCatalogo,
    fuente: FuenteRegla | null,
    usuario: string | null,
    en: string,
  ): void {
    if (fuente === null) {
      this.db
        .prepare('DELETE FROM catalogo_reglas WHERE ambito = ? AND campo = ?')
        .run(ambito, campo);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO catalogo_reglas (ambito, campo, fuente, usuario, en) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ambito, campo) DO UPDATE SET fuente = excluded.fuente,
           usuario = excluded.usuario, en = excluded.en`,
      )
      .run(ambito, campo, fuente, usuario, en);
  }

  visibilidadDecidida(sku: string): DecisionVisibilidad | null {
    const f = this.db.prepare('SELECT * FROM catalogo_visibilidad WHERE sku = ?').get(sku) as
      Fila | undefined;
    return f
      ? {
          estado: f.estado as DecisionVisibilidad['estado'],
          usuario: texto(f.usuario),
          en: f.en as string,
        }
      : null;
  }

  decidirVisibilidad(sku: string, d: DecisionVisibilidad): void {
    this.db
      .prepare(
        `INSERT INTO catalogo_visibilidad (sku, estado, usuario, en) VALUES (?, ?, ?, ?)
         ON CONFLICT(sku) DO UPDATE SET estado = excluded.estado, usuario = excluded.usuario,
           en = excluded.en`,
      )
      .run(sku, d.estado, d.usuario, d.en);
  }

  /** Las visibilidades decididas en el panel, por SKU. */
  visibilidades(): Array<DecisionVisibilidad & { sku: string }> {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_visibilidad ORDER BY sku')
      .all() as Fila[];
    return filas.map((f) => ({
      sku: f.sku as string,
      estado: f.estado as DecisionVisibilidad['estado'],
      usuario: texto(f.usuario),
      en: f.en as string,
    }));
  }

  // --- Decisiones: categorías fuera de la web ---

  categoriasFuera(): CategoriaFuera[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_categorias_fuera ORDER BY categoria')
      .all() as Fila[];
    return filas.map((f) => ({
      categoria: f.categoria as string,
      usuario: texto(f.usuario),
      en: f.en as string,
    }));
  }

  /** Saca una categoría de Coreinbox de la web (`fuera` true) o la devuelve (`false`). */
  marcarCategoria(categoria: string, fuera: boolean, usuario: string | null, en: string): void {
    if (!fuera) {
      this.db.prepare('DELETE FROM catalogo_categorias_fuera WHERE categoria = ?').run(categoria);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO catalogo_categorias_fuera (categoria, usuario, en) VALUES (?, ?, ?)
         ON CONFLICT(categoria) DO UPDATE SET usuario = excluded.usuario, en = excluded.en`,
      )
      .run(categoria, usuario, en);
  }

  /** Las categorías de Coreinbox leídas, para elegirlas en el panel. */
  categoriasLeidas(): string[] {
    const filas = this.db
      .prepare(
        `SELECT DISTINCT valor FROM catalogo_campos
         WHERE campo = 'categoria' AND sistema = 'coreinbox' AND valor <> 'null' ORDER BY valor`,
      )
      .all() as Array<{ valor: string }>;
    return filas
      .map((f) => deJson<ValorCampo>(f.valor, null))
      .filter((v): v is string => typeof v === 'string');
  }

  // --- Exportar e importar las decisiones ---

  /** Todas las decisiones humanas, para respaldarlas (la excepción a la reconstruibilidad). */
  exportarDecisiones(): Decisiones {
    return {
      version: 1,
      reglas: this.reglas(),
      empates: this.empates()
        .filter((e) => e.estado !== 'propuesto')
        .map((e) => ({
          emiteId: e.emiteId,
          sku: e.sku,
          estado: e.estado as 'confirmado' | 'rechazado',
          decididoPor: e.decididoPor,
          decididoEn: e.decididoEn,
        })),
      conflictos: this.conflictosResueltos().map(({ id: _id, estado: _estado, ...c }) => c),
      visibilidad: this.visibilidades(),
      categoriasFuera: this.categoriasFuera(),
    };
  }

  /**
   * Repone decisiones exportadas. Idempotente: lo que ya está igual no cambia y lo que no viene no
   * se borra. Devuelve cuántas filas trajo de cada clase.
   */
  importarDecisiones(d: Decisiones): Record<Exclude<keyof Decisiones, 'version'>, number> {
    return this.transaccion(() => {
      for (const r of d.reglas) this.guardarRegla(r.ambito, r.campo, r.fuente, r.usuario, r.en);
      for (const e of d.empates) {
        const actual = this.empatesDeHistorico(e.emiteId).find((x) => x.sku === e.sku);
        if (actual?.estado === e.estado && actual.decididoEn === e.decididoEn) continue;
        this.decidirEmpate(e.emiteId, e.sku, e.estado, e.decididoPor, e.decididoEn ?? '');
      }
      const existe = this.db.prepare(
        `SELECT 1 FROM catalogo_conflictos WHERE sku = ? AND campo = ? AND abierto_en = ?
           AND estado = 'resuelto' AND resuelto_en IS ?`,
      );
      const insertar = this.db.prepare(
        `INSERT INTO catalogo_conflictos
           (sku, campo, valores, abierto_en, estado, resuelto_con, resuelto_por, resuelto_en)
         VALUES (?, ?, ?, ?, 'resuelto', ?, ?, ?)`,
      );
      for (const c of d.conflictos) {
        if (existe.get(c.sku, c.campo, c.abiertoEn, c.resueltoEn)) continue;
        insertar.run(
          c.sku,
          c.campo,
          json(c.valores),
          c.abiertoEn,
          c.resueltoCon,
          c.resueltoPor,
          c.resueltoEn,
        );
      }
      for (const v of d.visibilidad) {
        this.decidirVisibilidad(v.sku, { estado: v.estado, usuario: v.usuario, en: v.en });
      }
      for (const c of d.categoriasFuera) this.marcarCategoria(c.categoria, true, c.usuario, c.en);
      return {
        reglas: d.reglas.length,
        empates: d.empates.length,
        conflictos: d.conflictos.length,
        visibilidad: d.visibilidad.length,
        categoriasFuera: d.categoriasFuera.length,
      };
    });
  }

  // --- Bitácora de la escritura ---

  registrarEvento(e: Omit<EventoCatalogo, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO catalogo_eventos
           (en, estado, sku, sistema, campo, antes, valor, mensaje, id_externo, clave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.en,
        e.estado,
        e.sku,
        e.sistema,
        e.campo,
        json(e.antes),
        json(e.valor),
        e.mensaje,
        e.idExterno,
        e.clave,
      );
  }

  /** El último evento de una operación (`clave`), para no repetir una misma falla. */
  ultimoEvento(clave: string): EventoCatalogo | null {
    const f = this.db
      .prepare('SELECT * FROM catalogo_eventos WHERE clave = ? ORDER BY id DESC LIMIT 1')
      .get(clave) as Fila | undefined;
    return f ? eventoDesdeFila(f) : null;
  }

  eventosDeSku(sku: string, limite = 50): EventoCatalogo[] {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_eventos WHERE sku = ? ORDER BY id DESC LIMIT ?')
      .all(sku, limite) as Fila[];
    return filas.map(eventoDesdeFila);
  }

  registrarAccion(accion: string, usuario: string | null, detalle: unknown, en: string): void {
    this.db
      .prepare('INSERT INTO catalogo_acciones (en, usuario, accion, detalle) VALUES (?, ?, ?, ?)')
      .run(en, usuario, accion, json(detalle));
  }

  acciones(
    limite = 50,
  ): Array<{ en: string; usuario: string | null; accion: string; detalle: unknown }> {
    const filas = this.db
      .prepare('SELECT * FROM catalogo_acciones ORDER BY id DESC LIMIT ?')
      .all(limite) as Fila[];
    return filas.map((f) => ({
      en: f.en as string,
      usuario: texto(f.usuario),
      accion: f.accion as string,
      detalle: deJson(f.detalle, null),
    }));
  }

  resumen(): ResumenCatalogo {
    const uno = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    const leidos: Record<SistemaCatalogo, number> = { coreinbox: 0, woocommerce: 0, emite: 0 };
    const porSistema = this.db
      .prepare(
        `SELECT sistema, COUNT(*) AS n FROM (
           SELECT sistema FROM catalogo_ids UNION ALL SELECT sistema FROM catalogo_sin_sku
         ) GROUP BY sistema`,
      )
      .all() as Array<{ sistema: SistemaCatalogo; n: number }>;
    for (const f of porSistema) leidos[f.sistema] = f.n;
    const historicos = uno('SELECT COUNT(*) AS n FROM catalogo_historicos');
    leidos.emite += historicos;
    return {
      skus: uno('SELECT COUNT(*) AS n FROM catalogo_productos'),
      leidos,
      historicos,
      conDiferencias: uno('SELECT COUNT(*) AS n FROM catalogo_productos WHERE con_diferencias = 1'),
      enConflicto: uno(
        `SELECT COUNT(DISTINCT sku) AS n FROM catalogo_conflictos WHERE estado = 'abierto'`,
      ),
      empatesPropuestos: uno(
        `SELECT COUNT(*) AS n FROM catalogo_empates WHERE estado = 'propuesto'`,
      ),
      sinSku: uno('SELECT COUNT(*) AS n FROM catalogo_sin_sku'),
    };
  }
}

function historicoDesdeFila(f: Fila): HistoricoEmite {
  return {
    emiteId: f.emite_id as string,
    codigo: f.codigo as string,
    nombre: f.nombre as string,
    activo: f.activo === 1,
    fusionadoEnId: texto(f.fusionado_en_id),
    uso: deJson(f.uso, null),
    aliasSku: texto(f.alias_sku),
    modificadoEn: texto(f.modificado_en),
    leidoEn: f.leido_en as string,
  };
}

function empateDesdeFila(f: Fila): Empate {
  return {
    emiteId: f.emite_id as string,
    sku: f.sku as string,
    puntaje: f.puntaje as number,
    motivo: f.motivo as string,
    detalle: f.detalle as string,
    estado: f.estado as EstadoEmpate,
    propuestoEn: f.propuesto_en as string,
    decididoPor: texto(f.decidido_por),
    decididoEn: texto(f.decidido_en),
    resultado: (f.resultado as ResultadoEmpate | null) ?? null,
    resultadoEn: texto(f.resultado_en),
    resultadoDetalle: texto(f.resultado_detalle),
  };
}

function eventoDesdeFila(f: Fila): EventoCatalogo {
  return {
    id: f.id as number,
    en: f.en as string,
    estado: f.estado as EstadoEventoCatalogo,
    sku: f.sku as string,
    sistema: f.sistema as SistemaCatalogo,
    campo: (f.campo as CampoCatalogo | null) ?? null,
    antes: deJson<ValorCampo>(f.antes, null),
    valor: deJson<ValorCampo>(f.valor, null),
    mensaje: texto(f.mensaje),
    idExterno: texto(f.id_externo),
    clave: texto(f.clave),
  };
}

function agregarColumna(db: DatabaseSync, tabla: string, columna: string, tipo: string): void {
  const columnas = db.prepare(`PRAGMA table_info(${tabla})`).all() as Array<{ name: string }>;
  if (!columnas.some((c) => c.name === columna)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${tipo}`);
  }
}

function conflictoDesdeFila(f: Fila): Conflicto {
  return {
    id: f.id as number,
    sku: f.sku as string,
    campo: f.campo as CampoCatalogo,
    valores: deJson(f.valores, {}),
    abiertoEn: f.abierto_en as string,
    estado: f.estado as Conflicto['estado'],
    resueltoCon: (f.resuelto_con as SistemaCatalogo | null) ?? null,
    resueltoPor: texto(f.resuelto_por),
    resueltoEn: texto(f.resuelto_en),
  };
}
