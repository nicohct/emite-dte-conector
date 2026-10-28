/** Configuración por variables de entorno (ver `.env.example`). Falla al arrancar si falta algo. */
export interface Config {
  coreinbox: { url: string; apiKey: string; tipoActividad: string };
  emite: {
    url: string;
    urlPublica: string;
    apiKey: string;
    emisorId: string;
    webhookSecret: string;
  };
  /** Primer `updatedSince` cuando todavía no hay cursor guardado. */
  desde: string;
  intervaloS: number;
  puerto: number;
  estadoRuta: string;
}

const TIPO_ACTIVIDAD_NOTA = 'd0000000-0000-0000-0000-000000000004';

export function leerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const exigir = (nombre: string): string => {
    const v = env[nombre]?.trim();
    if (!v) throw new Error(`Falta la variable de entorno ${nombre}`);
    return v;
  };
  const sinBarra = (u: string) => u.replace(/\/+$/, '');
  const desde = env.DESDE?.trim() || new Date().toISOString();
  if (Number.isNaN(Date.parse(desde))) throw new Error('DESDE no es una fecha ISO 8601');
  const emiteUrl = sinBarra(exigir('EMITE_URL'));
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
    desde,
    intervaloS: Math.max(10, Number(env.INTERVALO_S) || 60),
    puerto: Number(env.PUERTO) || 8080,
    estadoRuta: env.ESTADO_RUTA?.trim() || './datos/estado.sqlite',
  };
}
