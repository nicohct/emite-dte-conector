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
  origen: { nombre: string; idExterno: string };
  estado: 'aceptada';
}

export interface CotizacionCreada {
  id: string;
  numero: number;
  estado: string;
  montoTotal: number;
  receptorSnapshot: { rut: string; razonSocial: string };
}

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
  async crearCotizacion(cuerpo: CotizacionEmite): Promise<CotizacionCreada> {
    let respuesta: Response;
    try {
      respuesta = await this.http(`${this.base}/api/v1/cotizaciones`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(cuerpo),
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
        error.message ?? `Emite DTE respondió ${respuesta.status}`,
      );
    }
    return json as unknown as CotizacionCreada;
  }
}
