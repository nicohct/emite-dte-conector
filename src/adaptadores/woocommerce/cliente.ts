/**
 * Cliente de la API REST v3 de WooCommerce con claves de consumidor (Basic sobre HTTPS). Sólo lo
 * que el conector necesita: productos y pedidos modificados desde una fecha, un pedido, anotar
 * en un pedido y actualizar un producto. Reintenta 429, 5xx y fallas de red con espera creciente.
 */

import type {
  CambiosProductoWoo,
  ConfigWoo,
  NotaPedidoWoo,
  PedidoWoo,
  ProductoWoo,
} from './tipos.js';

export interface PaginaWoo<T> {
  items: T[];
  totalPaginas: number;
}

export interface OpcionesPaginaProductos {
  /** ISO 8601 en UTC; se envía con `dates_are_gmt=true`. */
  modificadosDesde?: string;
  pagina?: number;
  porPagina?: number;
}

export interface OpcionesPaginaPedidos extends OpcionesPaginaProductos {
  estados?: string[];
}

export interface OpcionesReintento {
  reintentos?: number;
  esperaBaseMs?: number;
  esperaMaxMs?: number;
  dormir?: (ms: number) => Promise<void>;
}

const POR_PAGINA = 100;

function exigirHttps(url: string): void {
  if (!url.toLowerCase().startsWith('https://')) {
    throw new Error(
      'WOO_URL debe empezar con https://: la clave viaja en Authorization: Basic, que WooCommerce sólo acepta sobre HTTPS',
    );
  }
}

function sinBarrasFinales(url: string): string {
  return url.replace(/\/+$/, '');
}

/** La configuración de WooCommerce del entorno, o null si no hay ninguna de las tres variables. */
export function configWooDesdeEnv(env: NodeJS.ProcessEnv): ConfigWoo | null {
  const url = env.WOO_URL?.trim() ?? '';
  const consumerKey = env.WOO_CONSUMER_KEY?.trim() ?? '';
  const consumerSecret = env.WOO_CONSUMER_SECRET?.trim() ?? '';
  if (!url && !consumerKey && !consumerSecret) return null;
  const faltan = [
    ['WOO_URL', url],
    ['WOO_CONSUMER_KEY', consumerKey],
    ['WOO_CONSUMER_SECRET', consumerSecret],
  ]
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);
  if (faltan.length > 0) {
    throw new Error(
      `WOO_URL, WOO_CONSUMER_KEY y WOO_CONSUMER_SECRET van juntas; falta ${faltan.join(', ')}`,
    );
  }
  exigirHttps(url);
  return { url: sinBarrasFinales(url), consumerKey, consumerSecret };
}

export class ErrorWoo extends Error {
  /** Segundos de la cabecera `Retry-After`, si el servidor la mandó. */
  retryAfterSegundos: number | null = null;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorWoo';
  }
  /** Falla de red, límite de peticiones o 5xx: vale la pena volver a intentar. */
  get transitorio(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function exigirIdPositivo(nombre: string, valor: number): void {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new RangeError(`${nombre} debe ser un entero positivo: ${String(valor)}`);
  }
}

function segundosDe(cabecera: string | null): number | null {
  if (cabecera === null || !/^\d+$/.test(cabecera.trim())) return null;
  return Number.parseInt(cabecera, 10);
}

export class WooCommerce {
  private readonly base: string;
  private readonly autorizacion: string;
  private readonly reintentos: number;
  private readonly esperaBaseMs: number;
  private readonly esperaMaxMs: number;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(
    config: ConfigWoo,
    private readonly http: typeof fetch = fetch,
    opciones: OpcionesReintento = {},
  ) {
    exigirHttps(config.url);
    this.base = `${sinBarrasFinales(config.url)}/wp-json/wc/v3`;
    const credencial = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`);
    this.autorizacion = `Basic ${credencial.toString('base64')}`;
    this.reintentos = opciones.reintentos ?? 3;
    this.esperaBaseMs = opciones.esperaBaseMs ?? 1000;
    this.esperaMaxMs = opciones.esperaMaxMs ?? 30_000;
    this.dormir = opciones.dormir ?? ((ms) => new Promise((resolver) => setTimeout(resolver, ms)));
  }

  /** Una página de productos; con `modificadosDesde` sólo los cambiados desde ese instante UTC. */
  async paginaProductos(opciones: OpcionesPaginaProductos = {}): Promise<PaginaWoo<ProductoWoo>> {
    return this.pagina<ProductoWoo>('/products', this.consulta(opciones));
  }

  /** Todos los productos, página a página (de a 100). */
  async *productos(modificadosDesde?: string): AsyncGenerator<ProductoWoo> {
    yield* this.recorrer((pagina) =>
      this.paginaProductos({
        pagina,
        porPagina: POR_PAGINA,
        ...(modificadosDesde !== undefined ? { modificadosDesde } : {}),
      }),
    );
  }

  /** Una página de pedidos, opcionalmente filtrada por estados (`processing`, `completed`…). */
  async paginaPedidos(opciones: OpcionesPaginaPedidos = {}): Promise<PaginaWoo<PedidoWoo>> {
    const q = this.consulta(opciones);
    if (opciones.estados && opciones.estados.length > 0) {
      q.set('status', opciones.estados.join(','));
    }
    return this.pagina<PedidoWoo>('/orders', q);
  }

  /** Todos los pedidos, página a página (de a 100). */
  async *pedidos(
    opciones: Omit<OpcionesPaginaPedidos, 'pagina' | 'porPagina'> = {},
  ): AsyncGenerator<PedidoWoo> {
    yield* this.recorrer((pagina) =>
      this.paginaPedidos({ ...opciones, pagina, porPagina: POR_PAGINA }),
    );
  }

  async pedido(id: number): Promise<PedidoWoo> {
    exigirIdPositivo('id del pedido', id);
    return (await this.pedir<PedidoWoo>('GET', `/orders/${id}`)).data;
  }

  /** Anota en el pedido; con `paraCliente` la nota también le llega al cliente por correo. */
  async agregarNota(pedidoId: number, nota: string, paraCliente = false): Promise<NotaPedidoWoo> {
    exigirIdPositivo('id del pedido', pedidoId);
    return (
      await this.pedir<NotaPedidoWoo>('POST', `/orders/${pedidoId}/notes`, {
        note: nota,
        customer_note: paraCliente,
      })
    ).data;
  }

  /** URL del producto en la API REST (pide la clave para leerla). */
  urlProducto(id: number): string {
    return `${this.base}/products/${id}`;
  }

  /** URL de una categoría de productos en la API REST. */
  urlCategoria(id: number): string {
    return `${this.base}/products/categories/${id}`;
  }

  async actualizarProducto(id: number, cambios: CambiosProductoWoo): Promise<ProductoWoo> {
    exigirIdPositivo('id del producto', id);
    return (await this.pedir<ProductoWoo>('PUT', `/products/${id}`, cambios)).data;
  }

  private consulta(opciones: OpcionesPaginaProductos): URLSearchParams {
    const q = new URLSearchParams({
      page: String(opciones.pagina ?? 1),
      per_page: String(opciones.porPagina ?? POR_PAGINA),
    });
    if (opciones.modificadosDesde) {
      q.set('modified_after', opciones.modificadosDesde);
      q.set('dates_are_gmt', 'true');
    }
    return q;
  }

  private async pagina<T>(ruta: string, q: URLSearchParams): Promise<PaginaWoo<T>> {
    const { data, cabeceras } = await this.pedir<T[]>('GET', `${ruta}?${q}`);
    const total = Number.parseInt(cabeceras.get('x-wp-totalpages') ?? '', 10);
    return { items: data, totalPaginas: Number.isFinite(total) && total > 0 ? total : 1 };
  }

  private async *recorrer<T>(traer: (pagina: number) => Promise<PaginaWoo<T>>): AsyncGenerator<T> {
    for (let pagina = 1; ; pagina++) {
      const { items, totalPaginas } = await traer(pagina);
      if (items.length === 0) return;
      yield* items;
      if (pagina >= totalPaginas) return;
    }
  }

  private async pedir<T>(
    metodo: 'GET' | 'POST' | 'PUT',
    ruta: string,
    cuerpo?: unknown,
  ): Promise<{ data: T; cabeceras: Headers }> {
    for (let intento = 0; ; intento++) {
      try {
        return await this.intentar<T>(metodo, ruta, cuerpo);
      } catch (e) {
        if (!(e instanceof ErrorWoo) || !e.transitorio || intento >= this.reintentos) throw e;
        await this.dormir(this.espera(intento, e));
      }
    }
  }

  private espera(intento: number, error: ErrorWoo): number {
    const ms =
      error.retryAfterSegundos !== null
        ? error.retryAfterSegundos * 1000
        : this.esperaBaseMs * 2 ** intento;
    return Math.min(ms, this.esperaMaxMs);
  }

  private async intentar<T>(
    metodo: 'GET' | 'POST' | 'PUT',
    ruta: string,
    cuerpo?: unknown,
  ): Promise<{ data: T; cabeceras: Headers }> {
    let respuesta: Response;
    try {
      respuesta = await this.http(`${this.base}${ruta}`, {
        method: metodo,
        headers: {
          authorization: this.autorizacion,
          accept: 'application/json',
          ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: cuerpo !== undefined ? JSON.stringify(cuerpo) : null,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ErrorWoo(0, 'RED', `WooCommerce no responde: ${String(e)}`);
    }
    const texto = await respuesta.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    if (!respuesta.ok) {
      const cuerpoError = (json ?? {}) as { code?: unknown; message?: unknown };
      const error = new ErrorWoo(
        respuesta.status,
        typeof cuerpoError.code === 'string' ? cuerpoError.code : `HTTP_${respuesta.status}`,
        typeof cuerpoError.message === 'string'
          ? cuerpoError.message
          : `WooCommerce respondió ${respuesta.status} a ${metodo} ${ruta}`,
      );
      error.retryAfterSegundos = segundosDe(respuesta.headers.get('retry-after'));
      throw error;
    }
    if (json === null) {
      throw new ErrorWoo(
        respuesta.status,
        'RESPUESTA_INVALIDA',
        `WooCommerce respondió algo que no es JSON a ${metodo} ${ruta}`,
      );
    }
    return { data: json as T, cabeceras: respuesta.headers };
  }
}
