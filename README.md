# Conector Coreinbox → Emite DTE

Lleva las cotizaciones **aceptadas** en [Coreinbox](https://github.com/nicohct/coreinbox-crm) a
[Emite DTE](https://github.com/nicohct/emite-dte) para facturarlas desde ahí, y devuelve al CRM el
folio, el estado ante el SII y el envío por correo como actividades en el negocio. Es un proceso
aparte que usa sólo las APIs públicas de ambos sistemas (ADR-012 y ADR-030 de Emite DTE): no hay
que cambiar ninguno de los dos para instalarlo. Licencia MIT.

## Qué hace

1. **Cada minuto** consulta a Coreinbox las cotizaciones aceptadas desde el último cursor
   (`GET /quotes?status=accepted&updatedSince=…`, receta de `docs/api-claves.md` §6 del CRM:
   cursor = `meta.timestamp` − 5 minutos, deduplicación por id).
2. Por cada una nueva arma la cotización de Emite DTE con **lo que el cliente compró** (las líneas
   de la aceptación: cantidades, precios y descuentos aceptados; sin ellas, las obligatorias más las
   opcionales elegidas), el cliente por RUT, la OC del cliente (`poNumber` → referencia 801 al
   facturar), vigencia, forma de pago, condiciones y el SKU de cada producto, y la crea con
   `POST /cotizaciones` (`origen: { nombre: "coreinbox", idExterno: <id de la cotización> }`,
   `estado: "aceptada"`). Si el RUT no está en el catálogo de Emite DTE
   (`RECEPTOR_NO_EXISTE`), la reenvía con el receptor completo y así lo crea.
3. Anota en el negocio de Coreinbox «Cotización … lista para facturar en Emite DTE (N° …)». Se
   factura desde Emite DTE como siempre (borrador → emitir); el conector no emite nada.
4. Recibe los **webhooks firmados** de Emite DTE (`cotizacion.facturada`, `dte.emitido`,
   `dte.enviado_sii`, `dte.aceptado`, `dte.rechazado`, `dte.correo_enviado`) en `POST /webhooks`,
   verifica la firma (Standard Webhooks), descarta repetidos por `webhook-id` y anota la actividad
   correspondiente en el negocio, con el enlace al PDF.

**Idempotencia.** Repetir una pasada es inocuo: Emite DTE devuelve la cotización existente ante el
mismo `origen` + `idExterno`, y el conector recuerda lo que ya pasó. Una versión nueva de la
cotización en Coreinbox es otra cotización (otro id) y entra sola cuando se acepta.

**Errores.** Una falla de red o un 5xx deja la cotización pendiente y no mueve el cursor: se
reintenta en la pasada siguiente. Un dato que Emite DTE no puede recibir (moneda distinta de CLP,
empresa sin RUT válido, sin líneas, validación 4xx) queda registrado con su mensaje, se anota
**una vez** en el negocio («no se pudo pasar a facturación: …») y se vuelve a intentar al cambiar
la cotización; mientras tanto no bloquea a las demás.

## Requisitos

- Node.js 22.13 o superior (usa `node:sqlite` para su estado; sin más dependencias en producción).
- En **Coreinbox**: una clave de API (Ajustes → Integraciones → Claves de API) con los alcances
  `quotes:read`, `companies:read`, `contacts:read`, `products:read` y `activities:write`.
- En **Emite DTE**: una API key del emisor con `cotizaciones:escribir` y `dte:leer`, y un webhook
  (Configuración → Webhooks) apuntando a `http://<conector>:8080/webhooks` suscrito a los seis
  eventos de arriba. Su secreto `whsec_…` va en `EMITE_WEBHOOK_SECRET`.

## Instalación

```bash
cp .env.example .env   # y completar
pnpm install
pnpm build
pnpm start
```

Con Docker, junto al compose de Emite DTE (el conector habla con la API por la red interna y
recibe los webhooks sin exponer nada a Internet):

```yaml
conector-coreinbox:
  build: ../emite-dte-conector-coreinbox
  env_file: ./privado/conector-coreinbox.env
  environment:
    EMITE_URL: http://app:3000
  volumes:
    - conector_datos:/datos
  restart: unless-stopped
```

y en Emite DTE el webhook apunta a `http://conector-coreinbox:8080/webhooks`.

`GET /salud` responde `{ ok, creadas, conError }`. El estado (cursor, cotizaciones pasadas,
webhooks vistos) vive en `ESTADO_RUTA` (SQLite); borrarlo obliga a volver a empezar desde `DESDE`,
sin duplicar nada en Emite DTE.

## Qué no hace (todavía)

- No muestra el folio como insignia ni adjunta el PDF en Coreinbox: lo anota como actividad con
  el enlace. Cuando Coreinbox tenga webhooks salientes y campos de factura, el conector cambiará
  la consulta periódica por recepción, sin tocar lo demás.
- Factura sólo en pesos. Una cotización en otra moneda queda con error y aviso en el negocio.
- Un workspace de Coreinbox ↔ un emisor de Emite DTE. Para más, una instancia por par.

## Desarrollo

```bash
pnpm test        # vitest, sin red
pnpm typecheck
pnpm dev         # con el .env
```

Los datos de las pruebas son sintéticos (`Empresa de Prueba SpA`, RUT `76000000-0`). Nada de
ninguna empresa real va al repositorio.
