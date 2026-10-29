/**
 * Verificación manual contra una tienda WooCommerce (`pnpm verificar:woo`): lista los primeros
 * productos para comprobar URL y claves. Sólo lee; no modifica nada.
 */

import { ErrorWoo, WooCommerce, configWooDesdeEnv } from './cliente.js';

async function main(): Promise<void> {
  const config = configWooDesdeEnv(process.env);
  if (!config) {
    console.error(
      'Falta la configuración: define WOO_URL, WOO_CONSUMER_KEY y WOO_CONSUMER_SECRET.',
    );
    process.exitCode = 1;
    return;
  }

  const woo = new WooCommerce(config);
  const { items, totalPaginas } = await woo.paginaProductos({ porPagina: 5 });
  console.table(
    items.map((p) => ({ id: p.id, sku: p.sku, nombre: p.name, precio: p.regular_price })),
  );
  console.log(`Productos mostrados: ${items.length}. Páginas de 5 en total: ${totalPaginas}.`);
}

main().catch((e: unknown) => {
  if (e instanceof ErrorWoo) {
    console.error(
      `WooCommerce respondió con error (status ${e.status}, code ${e.code}): ${e.message}`,
    );
  } else {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exitCode = 1;
});
