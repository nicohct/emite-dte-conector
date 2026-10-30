/**
 * `GET /panel/imagen/{sku}`: la foto principal del SKU, descargada del lado del servidor y guardada
 * en la caché `miniaturas` de `Estado`. Sólo se descargan URL del índice del catálogo, nunca una que
 * venga en la petición. Se elige la foto principal de la web si el producto está en la web; si no,
 * la de Coreinbox (con la clave, por el adaptador). Si el hash de esa entrada del índice cambió, se
 * vuelve a descargar. Sin foto, con la descarga fallida o sobre el tope, 404.
 *
 * No se redimensiona: la imagen va tal cual y el CSS la muestra a 48 o 240 px.
 */
import type { Coreinbox } from '../adaptadores/coreinbox/cliente.js';
import type { EntradaIndice } from '../estado-catalogo.js';
import type { Estado } from '../estado.js';
import type { Miniatura } from '../estado-miniaturas.js';
import { log } from '../log.js';

export const TOPE_IMAGEN = 1024 * 1024;

/** Sin SVG: podría llevar script y se sirve desde el mismo origen que el panel. */
const TIPOS_IMAGEN = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

export interface Imagen {
  contentType: string;
  bytes: Uint8Array;
}

/** Descarga una entrada del índice; null si no es una imagen aceptable o supera `tope`. */
export type DescargaImagen = (entrada: EntradaIndice, tope: number) => Promise<Imagen | null>;

/**
 * Las imágenes de Coreinbox van con su clave por el adaptador; las de la web, sin credenciales y
 * sólo si están en el mismo origen que la tienda configurada (`tienda`, la URL de WooCommerce), sin
 * seguir redirecciones: la URL viene de los datos del producto y no debe llevar al conector a
 * pedir otra cosa de la red. Sin tienda configurada, sólo se descargan las de Coreinbox.
 */
export function crearDescargaImagen(d: {
  coreinbox: Pick<Coreinbox, 'archivo'>;
  tienda: string | null;
  http?: typeof fetch;
}): DescargaImagen {
  const http = d.http ?? fetch;
  const origenTienda = d.tienda ? new URL(d.tienda).origin : null;
  return async (entrada, tope) => {
    if (entrada.sistema === 'coreinbox') {
      return leerImagen(await d.coreinbox.archivo(entrada.url), tope);
    }
    let url: URL;
    try {
      url = new URL(entrada.url);
    } catch {
      return null;
    }
    if (entrada.sistema !== 'woocommerce' || url.origin !== origenTienda) return null;
    const respuesta = await http(url, {
      headers: { accept: 'image/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    return leerImagen(respuesta, tope);
  };
}

export async function leerImagen(respuesta: Response, tope: number): Promise<Imagen | null> {
  const contentType = (respuesta.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const largo = Number(respuesta.headers.get('content-length'));
  if (!respuesta.ok || !TIPOS_IMAGEN.includes(contentType) || largo > tope || !respuesta.body) {
    await respuesta.body?.cancel();
    return null;
  }
  const partes: Uint8Array[] = [];
  let total = 0;
  for await (const parte of respuesta.body as unknown as AsyncIterable<Uint8Array>) {
    total += parte.length;
    if (total > tope) {
      await respuesta.body.cancel().catch(() => undefined);
      return null;
    }
    partes.push(parte);
  }
  return { contentType, bytes: Buffer.concat(partes) };
}

/** La entrada del índice que hace de foto principal, o null si el SKU no tiene foto. */
export function fotoPrincipal(estado: Estado, sku: string): EntradaIndice | null {
  const fotos = estado.catalogo.fotos(sku);
  const enLaWeb = estado.catalogo.producto(sku)?.presentes.includes('woocommerce') ?? false;
  const de = (sistema: EntradaIndice['sistema']) => fotos.find((f) => f.sistema === sistema);
  return (enLaWeb ? de('woocommerce') : undefined) ?? de('coreinbox') ?? null;
}

/**
 * La miniatura del SKU desde la caché, o descargada si falta o cambió el hash. Dos pedidos a la
 * vez del mismo SKU comparten la misma descarga.
 */
export function crearMiniaturas(d: {
  estado: Estado;
  descargar: DescargaImagen | null;
  ahora?: () => Date;
}): (sku: string) => Promise<Miniatura | null> {
  const enCurso = new Map<string, Promise<Miniatura | null>>();
  const obtener = async (sku: string): Promise<Miniatura | null> => {
    const entrada = fotoPrincipal(d.estado, sku);
    if (!entrada) return null;
    const guardada = d.estado.miniaturas.miniatura(sku);
    if (guardada && guardada.hash === entrada.hash) return guardada;
    if (!d.descargar) return null;
    let imagen: Imagen | null;
    try {
      imagen = await d.descargar(entrada, TOPE_IMAGEN);
    } catch (e) {
      log('warn', 'no se pudo descargar la foto del producto', { sku, error: String(e) });
      return null;
    }
    if (!imagen) {
      log('warn', 'la foto del producto no es una imagen aceptable o supera el tope', { sku });
      return null;
    }
    const miniatura: Miniatura = {
      sku,
      hash: entrada.hash,
      ...imagen,
      obtenidaEn: (d.ahora ?? (() => new Date()))().toISOString(),
    };
    d.estado.miniaturas.guardar(miniatura);
    return miniatura;
  };
  return (sku) => {
    const previa = enCurso.get(sku);
    if (previa) return previa;
    const promesa = obtener(sku).finally(() => enCurso.delete(sku));
    enCurso.set(sku, promesa);
    return promesa;
  };
}
