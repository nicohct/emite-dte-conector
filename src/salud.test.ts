import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Coreinbox } from './adaptadores/coreinbox/cliente.js';
import { ErrorCoreinbox } from './adaptadores/coreinbox/cliente.js';
import { Estado } from './estado.js';
import { esTransitorio } from './flujos/comun.js';
import { Salud } from './salud.js';
import { crearServidor } from './servidor.js';

const ACTIVOS = { cotizaciones: true, productos: false, pedidos: false };

function estadoConDatos(): Estado {
  const estado = new Estado(':memory:');
  estado.cursor = '2026-10-28T14:55:02.113Z';
  estado.guardarCotizacion({
    quoteId: 'q-1',
    quoteNumber: 'COT-1',
    dealId: 'd-1',
    companyId: null,
    contactId: null,
    estado: 'creada',
    emiteId: 'em-1',
    emiteNumero: 40,
    error: null,
  });
  estado.guardarProducto({
    productId: 'p-1',
    sku: null,
    estado: 'omitido',
    emiteId: null,
    error: 'SIN_SKU: sin SKU',
  });
  return estado;
}

describe('Salud', () => {
  it('muestra los tres flujos y conserva las claves de antes', () => {
    const salud = new Salud(estadoConDatos(), ACTIVOS);
    expect(salud.respuesta()).toEqual({
      ok: true,
      creadas: 1,
      conError: 0,
      productos: { sincronizados: 0, omitidos: 1, conError: 0 },
      flujos: {
        cotizaciones: {
          activo: true,
          cursor: '2026-10-28T14:55:02.113Z',
          creadas: 1,
          conError: 0,
          ultimaPasada: null,
          ultimaFalla: null,
        },
        productos: {
          activo: false,
          cursor: null,
          sincronizados: 0,
          omitidos: 1,
          conError: 0,
          ultimaPasada: null,
          ultimaFalla: null,
        },
        pedidos: { activo: false },
      },
    });
  });

  it('registra la última pasada y la última falla de cada flujo', () => {
    const salud = new Salud(new Estado(':memory:'), ACTIVOS);
    const en = new Date('2026-10-29T12:00:00.000Z');
    salud.registrarPasada('cotizaciones', { revisadas: 2, creadas: 2 }, en);
    salud.registrarFalla('productos', new Error('Coreinbox no responde'), true, en);
    const { flujos } = salud.respuesta();
    expect(flujos.cotizaciones.ultimaPasada).toEqual({
      en: '2026-10-29T12:00:00.000Z',
      resultado: { revisadas: 2, creadas: 2 },
    });
    expect(flujos.productos.ultimaFalla).toEqual({
      en: '2026-10-29T12:00:00.000Z',
      error: 'Error: Coreinbox no responde',
      transitorio: true,
    });
  });

  it('GET /salud responde lo que arma Salud', async () => {
    const salud = new Salud(estadoConDatos(), ACTIVOS);
    const servidor = crearServidor(
      {
        coreinbox: {} as Coreinbox,
        estado: new Estado(':memory:'),
        secreto: 'whsec_prueba',
        urlPublica: 'https://facturacion.example.com',
        tipoActividad: 't-1',
      },
      () => salud.respuesta(),
    );
    await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
    try {
      const { port } = servidor.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/salud`);
      expect(res.status).toBe(200);
      const cuerpo = (await res.json()) as ReturnType<Salud['respuesta']>;
      expect(cuerpo.creadas).toBe(1);
      expect(cuerpo.flujos.pedidos).toEqual({ activo: false });
    } finally {
      await new Promise((r) => servidor.close(r));
    }
  });
});

describe('esTransitorio', () => {
  it('la red caída y los 5xx son transitorios; un 4xx o un error cualquiera, no', () => {
    expect(esTransitorio(new ErrorCoreinbox(0, 'RED', 'Coreinbox no responde'))).toBe(true);
    expect(esTransitorio(new ErrorCoreinbox(503, 'HTTP_503', 'caído'))).toBe(true);
    expect(esTransitorio(new ErrorCoreinbox(400, 'VALIDACION', 'dato malo'))).toBe(false);
    expect(esTransitorio(new Error('otra cosa'))).toBe(false);
  });
});
