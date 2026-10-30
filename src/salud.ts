/**
 * Lo que responde `GET /salud`: por cada flujo, si está encendido, su cursor, sus contadores (del
 * estado en SQLite) y la última pasada y la última falla (en memoria, se pierden al reiniciar).
 * Mantiene además las claves de antes (`creadas`, `conError`, `productos`) para lo que ya las lee.
 *
 * `/salud` no lleva autenticación: de una falla muestra sólo el código y el status HTTP, nunca el
 * mensaje (puede traer datos del otro sistema); el mensaje completo queda en el log.
 */
import type { NombreFlujo } from './config.js';
import type { ResumenCatalogo } from './estado-catalogo.js';
import type { Estado, Resumen } from './estado.js';

export interface UltimaPasada {
  en: string;
  resultado: Record<string, number>;
}

export interface UltimaFalla {
  en: string;
  /** `RED`, `HTTP_503`, el `code` del sistema que respondió o el nombre del error. */
  codigo: string;
  /** Status HTTP de la respuesta; 0 si no hubo respuesta, `null` si no fue una falla de HTTP. */
  status: number | null;
  /** Red, 5xx o límite de peticiones: se reintenta sola en el intervalo siguiente. */
  transitorio: boolean;
}

interface Actividad {
  ultimaPasada: UltimaPasada | null;
  ultimaFalla: UltimaFalla | null;
}

type FlujoActivo = 'cotizaciones' | 'productos';

export interface RespuestaSalud extends Resumen {
  ok: true;
  flujos: {
    cotizaciones: {
      activo: boolean;
      cursor: string | null;
      creadas: number;
      conError: number;
    } & Actividad;
    productos: {
      activo: boolean;
      cursor: string | null;
      sincronizados: number;
      omitidos: number;
      conError: number;
      /** Registro canónico: leídos por sistema, con diferencias, en conflicto, empates, sin SKU. */
      catalogo: ResumenCatalogo;
    } & Actividad;
    pedidos: { activo: false };
  };
}

export class Salud {
  private readonly actividad: Record<FlujoActivo, Actividad> = {
    cotizaciones: { ultimaPasada: null, ultimaFalla: null },
    productos: { ultimaPasada: null, ultimaFalla: null },
  };

  constructor(
    private readonly estado: Estado,
    private readonly activos: Record<NombreFlujo, boolean>,
  ) {}

  registrarPasada(flujo: FlujoActivo, resultado: object, en = new Date()): void {
    this.actividad[flujo].ultimaPasada = {
      en: en.toISOString(),
      resultado: { ...(resultado as Record<string, number>) },
    };
  }

  registrarFalla(flujo: FlujoActivo, error: unknown, transitorio: boolean, en = new Date()): void {
    const deHttp =
      error instanceof Error && 'code' in error && 'status' in error
        ? { codigo: String(error.code), status: Number(error.status) }
        : null;
    this.actividad[flujo].ultimaFalla = {
      en: en.toISOString(),
      codigo: deHttp?.codigo ?? (error instanceof Error ? error.name : 'Error'),
      status: deHttp?.status ?? null,
      transitorio,
    };
  }

  respuesta(): RespuestaSalud {
    const r = this.estado.resumen();
    return {
      ok: true,
      ...r,
      flujos: {
        cotizaciones: {
          activo: this.activos.cotizaciones,
          cursor: this.estado.cursor,
          creadas: r.creadas,
          conError: r.conError,
          ...this.actividad.cotizaciones,
        },
        productos: {
          activo: this.activos.productos,
          cursor: this.estado.cursorProductos,
          ...r.productos,
          catalogo: this.estado.catalogo.resumen(),
          ...this.actividad.productos,
        },
        pedidos: { activo: false },
      },
    };
  }
}
