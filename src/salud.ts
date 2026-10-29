/**
 * Lo que responde `GET /salud`: por cada flujo, si está encendido, su cursor, sus contadores (del
 * estado en SQLite) y la última pasada y la última falla (en memoria, se pierden al reiniciar).
 * Mantiene además las claves de antes (`creadas`, `conError`, `productos`) para lo que ya las lee.
 */
import type { NombreFlujo } from './config.js';
import type { Estado, Resumen } from './estado.js';

export interface UltimaPasada {
  en: string;
  resultado: Record<string, number>;
}

export interface UltimaFalla {
  en: string;
  error: string;
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
    this.actividad[flujo].ultimaFalla = { en: en.toISOString(), error: String(error), transitorio };
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
          ...this.actividad.productos,
        },
        pedidos: { activo: false },
      },
    };
  }
}
