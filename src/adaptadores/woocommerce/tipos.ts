/** Tipos de la API REST v3 de WooCommerce: sólo los campos que el conector lee o escribe. */

/** Credenciales de la tienda. `url` es la raíz del sitio, sin barra final y siempre `https://`. */
export interface ConfigWoo {
  url: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface ProductoWoo {
  id: number;
  sku: string;
  name: string;
  /** `publish`, `draft`, `pending` o `private`. */
  status: string;
  /** Precio de lista, como texto; vacío si el producto no tiene precio. */
  regular_price: string;
  /** Precio vigente (con oferta aplicada), como texto. */
  price: string;
  /** Hora local del sitio; no sirve de cursor porque depende de la zona de la tienda. */
  date_modified: string;
  /** Misma fecha en UTC; es la que se usa como cursor de sincronización. */
  date_modified_gmt: string;
  /** Lo que sigue lo usa el catálogo; WooCommerce siempre lo manda, los dobles a veces no. */
  permalink?: string;
  /** `simple`, `variable`, `grouped` o `external`. */
  type?: string;
  /** `visible`, `catalog`, `search` o `hidden`. */
  catalog_visibility?: string;
  description?: string;
  short_description?: string;
  categories?: CategoriaProductoWoo[];
  images?: ImagenWoo[];
  attributes?: AtributoWoo[];
  meta_data?: MetaWoo[];
}

export interface CategoriaProductoWoo {
  id: number;
  name: string;
  slug: string;
}

export interface ImagenWoo {
  id: number;
  src: string;
  name?: string;
}

export interface AtributoWoo {
  id: number;
  name: string;
  options: string[];
}

export interface MetaWoo {
  id: number;
  key: string;
  value: unknown;
}

export interface FacturacionWoo {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email: string;
  phone: string;
}

/** En una línea `price` llega como número y `total` como texto. */
export interface LineaPedidoWoo {
  id: number;
  name: string;
  product_id: number;
  sku: string;
  quantity: number;
  price: number;
  total: string;
}

export interface PedidoWoo {
  id: number;
  /** Número visible del pedido; puede diferir del `id`. */
  number: string;
  status: string;
  date_modified: string;
  date_modified_gmt: string;
  billing: FacturacionWoo;
  line_items: LineaPedidoWoo[];
  shipping_total: string;
  meta_data: MetaWoo[];
}

/** Lo único que el plan escribe en un producto de WooCommerce. */
export type CambiosProductoWoo = Partial<{
  name: string;
  regular_price: string;
  status: string;
}>;

/** Cuerpo de `POST /products`: un producto simple con lo mínimo del catálogo. */
export interface ProductoNuevoWoo {
  name: string;
  sku: string;
  type: 'simple';
  /** Precio bruto entero, como texto; vacío si no tiene. */
  regular_price: string;
  /** `publish` si está activo y aprobado; si no, `draft`. */
  status: 'publish' | 'draft';
}

/** Respuesta de `POST /orders/{id}/notes`. */
export interface NotaPedidoWoo {
  id: number;
  note: string;
  customer_note: boolean;
  date_created: string;
}
