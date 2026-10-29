/**
 * Cliente de la API de Coreinbox con clave `cik_…` (docs/api-claves.md del CRM). Sólo lo que el
 * conector necesita: cotizaciones aceptadas desde una fecha, su detalle, la empresa, el contacto,
 * el producto (por el SKU), los productos cambiados desde una fecha con sus categorías, y anotar
 * actividades en el negocio.
 */

export interface PaginaCotizaciones {
  items: CotizacionResumen[];
  nextCursor: string | null;
  /** `meta.timestamp` del servidor: es lo que se guarda como cursor de la pasada siguiente. */
  timestamp: string;
}

export interface CotizacionResumen {
  id: string;
  quoteNumber: string;
  status: string;
  updatedAt: string;
}

/** Detalle de `GET /quotes/:id`; sólo los campos que se usan (Decimal llega como texto). */
export interface CotizacionCoreinbox {
  id: string;
  quoteNumber: string;
  status: string;
  title?: string | null;
  companyId: string | null;
  contactId: string | null;
  dealId: string | null;
  currencyCode: string;
  validUntil: string | null;
  paymentTerms: { mode?: string; creditDays?: number; note?: string } | null;
  termsAndConditions: string | null;
  notes: string | null;
  discountMode?: string | null;
  discountPercent?: string | number | null;
  sections: Array<{ items: LineaCoreinbox[] }>;
  acceptance: AceptacionCoreinbox | null;
}

export interface LineaCoreinbox {
  id: string;
  productId: string | null;
  name: string;
  description: string | null;
  quantity: string | number;
  unit: string | null;
  unitPrice: string | number;
  discountPercent: string | number | null;
  discountAmount: string | number | null;
  taxRate: string | number | null;
  isOptional: boolean;
  isSelectedByContact?: boolean | null;
  sortOrder: number;
}

export interface AceptacionCoreinbox {
  acceptedAt: string;
  poNumber: string | null;
  note: string | null;
  differsFromQuote: boolean;
  lines: Array<{
    quoteLineItemId: string;
    quantity: string | number;
    unitPrice: string | number;
    discountPercent: string | number | null;
    discountAmount: string | number | null;
  }>;
}

export interface EmpresaCoreinbox {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  activityDescription: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  admin1Name: string | null;
  admin2Name: string | null;
  city: string | null;
  countryCode: string | null;
}

export interface ContactoCoreinbox {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string | null;
}

/** Un producto del catálogo de Coreinbox (`GET /products`); Decimal llega como texto. */
export interface ProductoCoreinbox {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  /** `product`, `service`, `license` o `subscription`. */
  type: string;
  unit: string | null;
  unitPrice: string | number;
  currencyCode: string;
  isTaxable: boolean;
  /** Fracción entre 0 y 1 (0.19 = 19 %). */
  taxRate: string | number | null;
  categoryId: string | null;
  isActive: boolean;
  updatedAt: string;
}

export interface CategoriaCoreinbox {
  id: string;
  name: string;
  parentId: string | null;
}

export interface PaginaProductos {
  items: ProductoCoreinbox[];
  nextCursor: string | null;
  /** `meta.timestamp` del servidor: es lo que se guarda como cursor de la pasada siguiente. */
  timestamp: string;
}

export interface ActividadNueva {
  typeId: string;
  title: string;
  body: string;
  dealId?: string;
  companyId?: string;
  contactId?: string;
  metadata?: Record<string, unknown>;
}

export class ErrorCoreinbox extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorCoreinbox';
  }
  /** 5xx o límite de peticiones: vale la pena volver a intentar. */
  get transitorio(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

interface Sobre<T> {
  success: boolean;
  data: T;
  meta?: { timestamp?: string };
  error?: { code?: string; message?: string };
}

export class Coreinbox {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  async listarAceptadas(desde: string, cursor?: string): Promise<PaginaCotizaciones> {
    const q = new URLSearchParams({ status: 'accepted', updatedSince: desde, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const { data, meta } = await this.pedir<{
      items: CotizacionResumen[];
      nextCursor?: string | null;
    }>('GET', `/quotes?${q}`);
    return {
      items: data.items,
      nextCursor: data.nextCursor ?? null,
      timestamp: meta?.timestamp ?? new Date().toISOString(),
    };
  }

  async cotizacion(id: string): Promise<CotizacionCoreinbox> {
    return (await this.pedir<CotizacionCoreinbox>('GET', `/quotes/${id}`)).data;
  }

  async empresa(id: string): Promise<EmpresaCoreinbox> {
    return (await this.pedir<EmpresaCoreinbox>('GET', `/crm/companies/${id}`)).data;
  }

  async contacto(id: string): Promise<ContactoCoreinbox> {
    return (await this.pedir<ContactoCoreinbox>('GET', `/crm/contacts/${id}`)).data;
  }

  /** El SKU del producto, o null si no existe o la clave no puede leer productos. */
  async skuDe(productoId: string): Promise<string | null> {
    try {
      const { data } = await this.pedir<{ sku?: string | null }>('GET', `/products/${productoId}`);
      return data.sku?.trim() || null;
    } catch (e) {
      if (e instanceof ErrorCoreinbox && !e.transitorio) return null;
      throw e;
    }
  }

  /** Productos cambiados desde `desde` (`updatedSince`), en páginas de 100; sin los eliminados. */
  async listarProductos(desde: string, cursor?: string): Promise<PaginaProductos> {
    const q = new URLSearchParams({ updatedSince: desde, limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const { data, meta } = await this.pedir<{
      items: ProductoCoreinbox[];
      nextCursor?: string | null;
    }>('GET', `/products?${q}`);
    return {
      items: data.items,
      nextCursor: data.nextCursor ?? null,
      timestamp: meta?.timestamp ?? new Date().toISOString(),
    };
  }

  async categorias(): Promise<CategoriaCoreinbox[]> {
    return (await this.pedir<CategoriaCoreinbox[]>('GET', '/products/categories')).data;
  }

  async crearActividad(actividad: ActividadNueva): Promise<string> {
    const { data } = await this.pedir<{ id: string }>('POST', '/activities', {
      ...actividad,
      occurredAt: new Date().toISOString(),
    });
    return data.id;
  }

  private async pedir<T>(
    metodo: 'GET' | 'POST',
    ruta: string,
    cuerpo?: unknown,
  ): Promise<Sobre<T>> {
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
      throw new ErrorCoreinbox(0, 'RED', `Coreinbox no responde: ${String(e)}`);
    }
    const texto = await respuesta.text();
    let sobre: Sobre<T> | null = null;
    try {
      sobre = texto ? (JSON.parse(texto) as Sobre<T>) : null;
    } catch {
      sobre = null;
    }
    if (!respuesta.ok || !sobre?.success) {
      throw new ErrorCoreinbox(
        respuesta.status,
        sobre?.error?.code ?? `HTTP_${respuesta.status}`,
        sobre?.error?.message ?? `Coreinbox respondió ${respuesta.status} a ${metodo} ${ruta}`,
      );
    }
    return sobre;
  }
}
