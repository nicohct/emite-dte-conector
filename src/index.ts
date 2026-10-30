import { Coreinbox } from './adaptadores/coreinbox/cliente.js';
import { EmiteDte } from './adaptadores/emite/cliente.js';
import { leerConfig } from './config.js';
import { Estado } from './estado.js';
import { esTransitorio } from './flujos/comun.js';
import { pasada } from './flujos/cotizaciones/pasada.js';
import { pasadaProductos } from './flujos/productos/pasada.js';
import { log } from './log.js';
import { crearPanel } from './panel/index.js';
import { Salud } from './salud.js';
import { crearServidor } from './servidor.js';

const config = leerConfig();
for (const aviso of config.avisos) log('warn', aviso);
const estado = new Estado(config.estadoRuta);
const coreinbox = new Coreinbox(config.coreinbox.url, config.coreinbox.apiKey);
const emite = new EmiteDte(config.emite.url, config.emite.apiKey);
const salud = new Salud(estado, config.flujos);

const servidor = crearServidor(
  {
    coreinbox,
    estado,
    secreto: config.emite.webhookSecret,
    urlPublica: config.emite.urlPublica,
    tipoActividad: config.coreinbox.tipoActividad,
  },
  () => salud.respuesta(),
  [
    crearPanel({
      salud: () => salud.respuesta(),
      estadoRuta: config.estadoRuta,
      enlaces: { emite: config.emite.urlPublica },
    }),
  ],
);
servidor.listen(config.puerto, () =>
  log('info', 'conector escuchando', {
    puerto: config.puerto,
    flujos: config.flujos,
    woocommerce: config.woocommerce !== null,
    estado: estado.resumen(),
  }),
);

let detener = false;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Corre la pasada de un flujo; una falla queda en el log y en `GET /salud`, nunca tumba el bucle. */
async function correr<R extends object>(
  flujo: 'cotizaciones' | 'productos',
  pasadaDelFlujo: () => Promise<R>,
  hubo: (r: R) => boolean,
  mensajes: { terminada: string; fallida: string },
): Promise<void> {
  try {
    const r = await pasadaDelFlujo();
    salud.registrarPasada(flujo, r);
    if (hubo(r)) log('info', mensajes.terminada, { ...(r as Record<string, unknown>) });
  } catch (e) {
    const transitorio = esTransitorio(e);
    salud.registrarFalla(flujo, e, transitorio);
    log(transitorio ? 'warn' : 'error', mensajes.fallida, { transitorio, error: String(e) });
  }
}

async function bucle() {
  while (!detener) {
    if (config.flujos.cotizaciones) {
      await correr(
        'cotizaciones',
        () =>
          pasada({
            coreinbox,
            emite,
            estado,
            emisorId: config.emite.emisorId,
            urlPublica: config.emite.urlPublica,
            tipoActividad: config.coreinbox.tipoActividad,
            desde: config.desde,
          }),
        (r) => r.revisadas > 0,
        {
          terminada: 'pasada terminada',
          fallida: 'la pasada falló; se reintenta en el intervalo siguiente',
        },
      );
    }
    if (config.flujos.productos && !detener) {
      await correr(
        'productos',
        () =>
          pasadaProductos({
            coreinbox,
            emite,
            estado,
            emisorId: config.emite.emisorId,
            desde: config.desde,
          }),
        (r) => r.revisados > 0,
        {
          terminada: 'pasada de productos terminada',
          fallida: 'la pasada de productos falló; se reintenta en el intervalo siguiente',
        },
      );
    }
    await dormir(config.intervaloS * 1000);
  }
}
void bucle();

for (const señal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(señal, () => {
    detener = true;
    servidor.close(() => {
      estado.cerrar();
      process.exit(0);
    });
  });
}
