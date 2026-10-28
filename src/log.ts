/** Una línea JSON por evento, como la API de Emite DTE. */
export function log(
  nivel: 'info' | 'warn' | 'error',
  msg: string,
  datos: Record<string, unknown> = {},
) {
  const linea = JSON.stringify({ nivel, msg, ...datos, en: new Date().toISOString() });
  if (nivel === 'error') console.error(linea);
  else console.log(linea);
}
