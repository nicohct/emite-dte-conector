/** Configuración por variables de entorno (ver `.env.example`). Falla al arrancar si falta algo. */
import { configWooDesdeEnv } from './adaptadores/woocommerce/cliente.js';
import type { ConfigWoo } from './adaptadores/woocommerce/tipos.js';

export type NombreFlujo = 'cotizaciones' | 'productos' | 'pedidos';

export interface Config {
  coreinbox: { url: string; apiKey: string; tipoActividad: string };
  emite: {
    url: string;
    urlPublica: string;
    apiKey: string;
    emisorId: string;
    webhookSecret: string;
  };
  /** `null` si no se configuró la tienda: ningún flujo encendido la usa todavía. */
  woocommerce: ConfigWoo | null;
  /** Primer `updatedSince` cuando todavía no hay cursor guardado (cotizaciones y productos). */
  desde: string;
  /** Qué flujos corren en cada pasada. `pedidos` queda en `false` hasta que exista. */
  flujos: Record<NombreFlujo, boolean>;
  /** Para el log al arrancar: variables obsoletas o flujos pedidos que todavía no existen. */
  avisos: string[];
  intervaloS: number;
  puerto: number;
  estadoRuta: string;
}

const TIPO_ACTIVIDAD_NOTA = 'd0000000-0000-0000-0000-000000000004';
const SI = ['true', '1', 'si', 'sí'];
const NO = ['false', '0', 'no'];

export function leerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const exigir = (nombre: string): string => {
    const v = env[nombre]?.trim();
    if (!v) throw new Error(`Falta la variable de entorno ${nombre}`);
    return v;
  };
  const bandera = (nombre: string, porOmision: boolean): boolean => {
    const v = env[nombre]?.trim().toLowerCase();
    if (!v) return porOmision;
    if (SI.includes(v)) return true;
    if (NO.includes(v)) return false;
    throw new Error(`${nombre} debe ser true o false (vino «${env[nombre]}»)`);
  };
  const sinBarra = (u: string) => u.replace(/\/+$/, '');
  const desde = env.DESDE?.trim() || new Date().toISOString();
  if (Number.isNaN(Date.parse(desde))) throw new Error('DESDE no es una fecha ISO 8601');
  const emiteUrl = sinBarra(exigir('EMITE_URL'));
  const avisos: string[] = [];

  let productos = bandera('FLUJO_PRODUCTOS', false);
  const alias = env.SINCRONIZAR_PRODUCTOS?.trim();
  if (alias && env.FLUJO_PRODUCTOS?.trim()) {
    avisos.push('SINCRONIZAR_PRODUCTOS se ignora porque está FLUJO_PRODUCTOS: conviene borrarla');
  } else if (alias) {
    // Como antes: cualquier valor que no sea «sí» la deja apagada.
    productos = SI.includes(alias.toLowerCase());
    avisos.push('SINCRONIZAR_PRODUCTOS está obsoleta: usa FLUJO_PRODUCTOS (se lee como alias)');
  }
  if (bandera('FLUJO_PEDIDOS', false)) {
    avisos.push('FLUJO_PEDIDOS: el flujo de pedidos no está implementado todavía; se ignora');
  }

  return {
    coreinbox: {
      url: sinBarra(exigir('COREINBOX_URL')),
      apiKey: exigir('COREINBOX_API_KEY'),
      tipoActividad: env.COREINBOX_TIPO_ACTIVIDAD?.trim() || TIPO_ACTIVIDAD_NOTA,
    },
    emite: {
      url: emiteUrl,
      urlPublica: sinBarra(env.EMITE_URL_PUBLICA?.trim() || emiteUrl),
      apiKey: exigir('EMITE_API_KEY'),
      emisorId: exigir('EMITE_EMISOR_ID'),
      webhookSecret: exigir('EMITE_WEBHOOK_SECRET'),
    },
    woocommerce: configWooDesdeEnv(env),
    desde,
    flujos: { cotizaciones: bandera('FLUJO_COTIZACIONES', true), productos, pedidos: false },
    avisos,
    intervaloS: Math.max(10, Number(env.INTERVALO_S) || 60),
    puerto: Number(env.PUERTO) || 8080,
    estadoRuta: env.ESTADO_RUTA?.trim() || './datos/estado.sqlite',
  };
}
