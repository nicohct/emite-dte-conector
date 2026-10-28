import { leerConfig } from './config.js';
import { Coreinbox } from './coreinbox.js';
import { EmiteDte } from './emite.js';
import { Estado } from './estado.js';
import { log } from './log.js';
import { crearServidor } from './servidor.js';
import { pasada } from './sincronizar.js';

const config = leerConfig();
const estado = new Estado(config.estadoRuta);
const coreinbox = new Coreinbox(config.coreinbox.url, config.coreinbox.apiKey);
const emite = new EmiteDte(config.emite.url, config.emite.apiKey);

const servidor = crearServidor({
  coreinbox,
  estado,
  secreto: config.emite.webhookSecret,
  urlPublica: config.emite.urlPublica,
  tipoActividad: config.coreinbox.tipoActividad,
});
servidor.listen(config.puerto, () =>
  log('info', 'conector escuchando', { puerto: config.puerto, estado: estado.resumen() }),
);

let detener = false;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bucle() {
  while (!detener) {
    try {
      const r = await pasada({
        coreinbox,
        emite,
        estado,
        emisorId: config.emite.emisorId,
        urlPublica: config.emite.urlPublica,
        tipoActividad: config.coreinbox.tipoActividad,
        desde: config.desde,
      });
      if (r.revisadas > 0) log('info', 'pasada terminada', { ...r });
    } catch (e) {
      log('error', 'la pasada falló; se reintenta en el intervalo siguiente', { error: String(e) });
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
