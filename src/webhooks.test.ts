import { describe, expect, it } from 'vitest';
import type { ActividadNueva, Coreinbox } from './coreinbox.js';
import { Estado } from './estado.js';
import { procesarWebhook } from './servidor.js';
import { decidir, firmar, verificarFirma, type EventoEmite } from './webhooks.js';

const SECRETO = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // gitleaks:allow (vector público de Standard Webhooks)

function evento(tipo: string, extra: Partial<EventoEmite['datos']> = {}): EventoEmite {
  return {
    id: `wh-${tipo}`,
    tipo,
    creadoEn: '2026-10-28T12:00:00.000Z',
    ambiente: 'certificacion',
    emisor: { id: 'em-1', rut: '76000000-0' },
    datos: {
      dte: {
        id: 'dte-1',
        tipoDte: 33,
        folio: 1234,
        fechaEmision: '2026-10-28',
        estado: 'emitido',
        estadoSii: null,
        estadoSiiDetalle: null,
        trackId: null,
        montoTotal: 1547000,
        links: {
          api: '/api/v1/dtes/dte-1',
          xml: '/api/v1/dtes/dte-1/xml',
          pdf: '/api/v1/dtes/dte-1/pdf',
        },
      },
      cotizacion: { id: 'cot-1', numero: 9, origenNombre: 'coreinbox', idExterno: 'q-1' },
      ...extra,
    },
  };
}

const fila = {
  quoteId: 'q-1',
  quoteNumber: 'COT-2026-012',
  dealId: 'd-1',
  companyId: 'e-1',
  contactId: null,
  estado: 'creada' as const,
  emiteId: 'cot-1',
  emiteNumero: 9,
  error: null,
  actualizadoEn: '',
};

describe('firma', () => {
  it('coincide con el vector de la especificación y se verifica con tolerancia', () => {
    expect(
      firmar(SECRETO, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}'),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const ahora = 1_800_000_000_000;
    const firma = firmar(SECRETO, 'e1', ahora / 1000, '{"a":1}');
    const h = { id: 'e1', timestamp: String(ahora / 1000), firma };
    expect(verificarFirma(SECRETO, h, '{"a":1}', ahora)).toBe(true);
    expect(verificarFirma(SECRETO, h, '{"a":2}', ahora)).toBe(false);
    expect(verificarFirma(SECRETO, h, '{"a":1}', ahora + 301_000)).toBe(false);
    expect(verificarFirma(SECRETO, { id: 'e1' }, '{"a":1}', ahora)).toBe(false);
  });
});

describe('decidir', () => {
  const url = 'https://facturacion.example.test';

  it('ignora lo que no viene de Coreinbox o no se conoce', () => {
    expect(decidir(evento('dte.emitido', { cotizacion: null }), fila, url)).toMatchObject({
      accion: 'ignorar',
    });
    expect(
      decidir(
        evento('dte.emitido', {
          cotizacion: { id: 'x', numero: 1, origenNombre: 'otro', idExterno: 'z' },
        }),
        fila,
        url,
      ),
    ).toMatchObject({ accion: 'ignorar' });
    expect(decidir(evento('dte.emitido'), null, url)).toMatchObject({ accion: 'ignorar' });
  });

  it('arma la actividad de cada evento con el negocio de la cotización', () => {
    const emitido = decidir(evento('dte.emitido'), fila, url);
    expect(emitido).toMatchObject({
      accion: 'anotar',
      quoteId: 'q-1',
      actividad: {
        title: 'Factura electrónica N° 1234 emitida por $1.547.000',
        dealId: 'd-1',
        companyId: 'e-1',
        metadata: { evento: 'dte.emitido', folio: 1234, cotizacionEmiteId: 'cot-1' },
      },
    });
    if (emitido.accion !== 'anotar') throw new Error();
    expect(emitido.actividad.body).toContain(`${url}/api/v1/dtes/dte-1/pdf`);
    expect(emitido.actividad).not.toHaveProperty('contactId');

    const aceptado = decidir(evento('dte.aceptado', { conReparos: true }), fila, url);
    expect(aceptado).toMatchObject({
      actividad: { title: 'Factura electrónica N° 1234 aceptada por el SII con reparos' },
    });

    const borrador = evento('cotizacion.facturada');
    borrador.datos.dte!.folio = null;
    borrador.datos.dte!.estado = 'borrador';
    expect(decidir(borrador, fila, url)).toMatchObject({
      actividad: { title: 'Cotización COT-2026-012 en facturación' },
    });

    expect(
      decidir(evento('dte.correo_enviado', { para: ['dte@cliente.test'] }), fila, url),
    ).toMatchObject({
      actividad: { title: 'Factura electrónica N° 1234 enviada por correo' },
    });
  });
});

describe('procesarWebhook', () => {
  function armar() {
    const estado = new Estado(':memory:');
    estado.guardarCotizacion(fila);
    const actividades: ActividadNueva[] = [];
    const coreinbox = {
      crearActividad: async (a: ActividadNueva) => {
        actividades.push(a);
        return 'act-1';
      },
    } as unknown as Coreinbox;
    return {
      actividades,
      d: {
        coreinbox,
        estado,
        secreto: SECRETO,
        urlPublica: 'https://f.test',
        tipoActividad: 'tipo-nota',
      },
    };
  }

  it('anota una vez y descarta la entrega repetida por webhook-id', async () => {
    const { d, actividades } = armar();
    const cuerpo = JSON.stringify(evento('dte.emitido'));
    expect(await procesarWebhook(d, cuerpo)).toEqual({ resultado: 'anotado' });
    expect(await procesarWebhook(d, cuerpo)).toEqual({ resultado: 'repetido' });
    expect(actividades).toHaveLength(1);
    expect(actividades[0]).toMatchObject({
      typeId: 'tipo-nota',
      dealId: 'd-1',
      metadata: { quoteId: 'q-1' },
    });
  });

  it('la prueba del webhook y lo ajeno no generan actividad', async () => {
    const { d, actividades } = armar();
    expect(
      await procesarWebhook(d, JSON.stringify({ id: 'p1', tipo: 'webhook.prueba', datos: {} })),
    ).toEqual({
      resultado: 'prueba',
    });
    expect(
      (await procesarWebhook(d, JSON.stringify(evento('dte.emitido', { cotizacion: null }))))
        .resultado,
    ).toBe('ignorado');
    expect((await procesarWebhook(d, 'no json')).resultado).toBe('ignorado');
    expect(actividades).toHaveLength(0);
  });
});
