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
  meta_data: Array<{ id: number; key: string; value: unknown }>;
}

/** Lo único que el plan escribe en un producto de WooCommerce. */
export type CambiosProductoWoo = Partial<{
  name: string;
  regular_price: string;
  status: string;
}>;

/** Respuesta de `POST /orders/{id}/notes`. */
export interface NotaPedidoWoo {
  id: number;
  note: string;
  customer_note: boolean;
  date_created: string;
}
