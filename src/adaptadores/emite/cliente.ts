/** Cliente mínimo de la API de Emite DTE (docs/05-api-interna.md) con API key `edte_…`. */

export interface ReceptorCompleto {
  rut: string;
  razonSocial: string;
  giro?: string;
  direccion?: string;
  comuna?: string;
  ciudad?: string;
  contacto?: string;
  correo?: string;
}

export interface ItemEmite {
  codigo?: string;
  nombre: string;
  descripcion?: string;
  cantidad: number;
  unidad?: string;
  precioUnitario: number;
  descuentoPorcentaje?: number;
  descuentoMonto?: number;
  exento?: boolean;
}

export interface CotizacionEmite {
  emisorId: string;
  receptor: ReceptorCompleto | { rut: string; contacto?: string };
  items: ItemEmite[];
  vigenteHasta?: string;
  formaPago?: 1 | 2 | 3;
  descuentoGlobalPorcentaje?: number;
  condiciones?: string;
  observaciones?: string;
  ordenCompra?: { numero: string; fecha?: string };
  /** `numero` es el de Coreinbox («C-3008»): Emite DTE lo muestra y lo cita en vez de su correlativo. */
  origen: { nombre: string; idExterno: string; numero?: string };
  estado: 'aceptada';
}

export interface CotizacionCreada {
  id: string;
  numero: number;
  estado: string;
  montoTotal: number;
  receptorSnapshot: { rut: string; razonSocial: string };
}

/** Un producto del catálogo de Emite DTE; sólo los campos que el conector lee. */
export interface ProductoEmite {
  id: string;
  codigo: string;
  nombre: string;
  descripcion: string | null;
  tipo: 'bien' | 'servicio';
  unidad: string;
  precioNeto: number;
  exento: boolean;
  categoria: string | null;
  activo: boolean;
  /** `manual`, `csv` o `historial` (importado del historial del SII). */
  origen?: OrigenProductoEmite;
  /** Producto que lo absorbió al fusionar; el absorbido queda inactivo y como alias. */
  fusionadoEnId?: string | null;
  /** Último cambio; es lo que ordena `orden=reciente`. */
  updatedAt?: string;
  /** Sólo en los listados: cuánto se usó en documentos emitidos o importados. */
  uso?: UsoProductoEmite;
}

export type OrigenProductoEmite = 'manual' | 'csv' | 'historial';

export interface UsoProductoEmite {
  documentos: number;
  cantidad: number;
  ultimaVez: string | null;
  clientes: number;
}

export interface FiltroProductosEmite {
  emisorId: string;
  origen?: OrigenProductoEmite;
  /** `reciente` es el último cambio primero. */
  orden?: 'nombre' | 'codigo' | 'precio' | 'reciente';
  /** Por omisión Emite DTE lista sólo los activos; el catálogo pide `todos`. */
  activo?: 'true' | 'false' | 'todos';
  cursor?: string;
  limite?: number;
}

export interface PaginaProductosEmite {
  items: ProductoEmite[];
  siguiente: string | null;
}

/** Cuerpo de `POST /productos/fusionar`: las líneas de los orígenes pasan al destino. */
export interface Fusion {
  emisorId: string;
  destinoId: string;
  origenIds: string[];
}

export interface ResultadoFusion {
  destino: ProductoEmite;
  fusionados: number;
  lineasReapuntadas: number;
}

/** Cuerpo de `POST /productos` (`productos.schemas.ts` de Emite DTE). */
export interface ProductoNuevo {
  emisorId: string;
  /** CdgItem: hasta 35 caracteres. */
  codigo: string;
  /** NmbItem: hasta 80 caracteres. */
  nombre: string;
  descripcion?: string;
  tipo?: 'bien' | 'servicio';
  /** UnmdItem: hasta 4 caracteres (UN, HRS, KG…). */
  unidad?: string;
  /** Neto en pesos, sin IVA. */
  precioNeto: number;
  exento?: boolean;
  categoria?: string;
  activo?: boolean;
}

/**
 * Lo único que el conector cambia en un producto que ya existe en Emite DTE (`PATCH`). Nunca el
 * código ni el origen.
 */
export type CambiosProducto = Partial<
  Pick<ProductoNuevo, 'nombre' | 'precioNeto' | 'tipo' | 'categoria'> & { activo: boolean }
>;

export class ErrorEmite extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorEmite';
  }
  get transitorio(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export class EmiteDte {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  /** `POST /cotizaciones`: con el mismo `origen` repetido, Emite DTE devuelve la que ya existe. */
  crearCotizacion(cuerpo: CotizacionEmite): Promise<CotizacionCreada> {
    return this.pedir<CotizacionCreada>('POST', '/cotizaciones', cuerpo);
  }

  /**
   * `GET /productos/por-codigo/{codigo}`: por código exacto o por alias (código o nombre antiguo);
   * un producto fusionado responde con el que lo absorbió. `null` si no hay ninguno.
   */
  async productoPorCodigo(emisorId: string, codigo: string): Promise<ProductoEmite | null> {
    const q = new URLSearchParams({ emisorId });
    try {
      return await this.pedir<ProductoEmite>(
        'GET',
        `/productos/por-codigo/${encodeURIComponent(codigo)}?${q}`,
      );
    } catch (e) {
      if (e instanceof ErrorEmite && e.status === 404) return null;
      throw e;
    }
  }

  /** `GET /productos` con su `uso`, paginado por cursor (`{ data, next_cursor }`). */
  async listarProductos(filtro: FiltroProductosEmite): Promise<PaginaProductosEmite> {
    const q = new URLSearchParams({
      emisorId: filtro.emisorId,
      limit: String(filtro.limite ?? 100),
    });
    if (filtro.origen) q.set('origen', filtro.origen);
    if (filtro.orden) q.set('orden', filtro.orden);
    if (filtro.activo) q.set('activo', filtro.activo);
    if (filtro.cursor) q.set('cursor', filtro.cursor);
    const r = await this.pedir<{ data: ProductoEmite[]; next_cursor?: string | null }>(
      'GET',
      `/productos?${q}`,
    );
    return { items: r.data, siguiente: r.next_cursor ?? null };
  }

  /**
   * `POST /productos/fusionar`. No se deshace. Rechaza con `PRODUCTO_CON_INVENTARIO` un origen que
   * controla stock o tiene movimientos.
   */
  fusionarProductos(fusion: Fusion): Promise<ResultadoFusion> {
    return this.pedir<ResultadoFusion>('POST', '/productos/fusionar', fusion);
  }

  /** URL del producto en la API. */
  urlProducto(id: string): string {
    return `${this.base}/api/v1/productos/${encodeURIComponent(id)}`;
  }

  crearProducto(datos: ProductoNuevo): Promise<ProductoEmite> {
    return this.pedir<ProductoEmite>('POST', '/productos', datos);
  }

  actualizarProducto(id: string, cambios: CambiosProducto): Promise<ProductoEmite> {
    return this.pedir<ProductoEmite>('PATCH', `/productos/${encodeURIComponent(id)}`, cambios);
  }

  private async pedir<T>(metodo: 'GET' | 'POST' | 'PATCH', ruta: string, cuerpo?: unknown) {
    let respuesta: Response;
    try {
      respuesta = await this.http(`${this.base}/api/v1${ruta}`, {
        method: metodo,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : null,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ErrorEmite(0, 'RED', `Emite DTE no responde: ${String(e)}`);
    }
    const texto = await respuesta.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = texto ? (JSON.parse(texto) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    if (!respuesta.ok) {
      const error = (json?.error ?? {}) as { code?: string; message?: string };
      throw new ErrorEmite(
        respuesta.status,
        error.code ?? `HTTP_${respuesta.status}`,
        error.message ?? `Emite DTE respondió ${respuesta.status} a ${metodo} ${ruta}`,
      );
    }
    return json as unknown as T;
  }
}
