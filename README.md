# Conector de Emite DTE

Es el proceso de integración de una instalación de
[Emite DTE](https://github.com/nicohct/emite-dte). Hoy lleva las cotizaciones **aceptadas** de
[Coreinbox](https://github.com/nicohct/coreinbox-crm) a Emite DTE y devuelve al CRM el folio, el
estado ante el SII y el envío por correo como actividades en el negocio. Opcionalmente mantiene el
**catálogo de productos** de Emite DTE al día con el de Coreinbox, y está preparado para sumar una
tienda **WooCommerce**. Es un proceso aparte que sólo usa las APIs públicas de Emite DTE (ADR-012,
ADR-030 y ADR-031): no hay que cambiar Emite DTE para instalarlo. Todo funciona por consulta
periódica; no entra nada desde Internet, salvo los webhooks de Emite DTE, que llegan por la red
interna. Licencia MIT.

## Arquitectura: adaptadores y flujos

El conector es un hub con tres sistemas: Coreinbox, Emite DTE y una tienda WooCommerce. Tiene un
adaptador por sistema y flujos que se encienden por variable.

- `src/adaptadores/{coreinbox,emite,woocommerce}` son los clientes de cada sistema. Hablan HTTP y no
  contienen lógica de negocio.
- `src/flujos/{cotizaciones,productos,pedidos}` son las pasadas de cada flujo, con su mapeo entre
  sistemas y sus pruebas.
- Cada flujo tiene su variable, su cursor y sus contadores. Una falla de un flujo no detiene a los
  otros.

```
src/
├── adaptadores/
│   ├── coreinbox/
│   │   └── cliente.ts
│   ├── emite/
│   │   ├── cliente.ts
│   │   └── firma.ts
│   └── woocommerce/
│       ├── cliente.ts
│       ├── tipos.ts
│       └── verificar.ts
├── flujos/
│   ├── comun.ts
│   ├── cotizaciones/
│   │   ├── mapeo.ts
│   │   ├── pasada.ts
│   │   └── webhooks.ts
│   ├── productos/
│   │   ├── mapeo.ts
│   │   └── pasada.ts
│   └── pedidos/
│       └── README.md
├── config.ts
├── estado.ts
├── index.ts
├── log.ts
├── salud.ts
└── servidor.ts
```

Las pruebas (`*.test.ts`) están junto al código que prueban y no aparecen en el árbol.

| Flujo                             | Sentido                                   | Variable                                                            | Estado                                                               |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A · Cotizaciones aceptadas        | Coreinbox → Emite DTE → Coreinbox         | `FLUJO_COTIZACIONES` (encendido por omisión)                        | En producción                                                        |
| B · Pedidos web                   | WooCommerce → Emite DTE → WooCommerce     | `FLUJO_PEDIDOS` (sin implementar: encendido sólo deja un aviso)     | Planificado, enero de 2027                                           |
| C · Productos transversales       | entre los tres, registro canónico por SKU | `FLUJO_PRODUCTOS` (hoy: Coreinbox → Emite DTE, apagado por omisión) | En producción en un sentido; el registro canónico, noviembre de 2026 |
| D · Solicitudes de cotización web | WooCommerce → Coreinbox                   | —                                                                   | Por evaluar frente al lector de correo de Coreinbox                  |
| E · Panel                         | —                                         | —                                                                   | Noviembre de 2026, junto con C                                       |

El plan completo está en `docs/10-conector-hub.md` del repositorio de Emite DTE.

## Qué hace

1. **Cada minuto** consulta a Coreinbox las cotizaciones aceptadas desde el último cursor
   (`GET /quotes?status=accepted&updatedSince=…`, receta de `docs/api-claves.md` §6 del CRM:
   cursor = `meta.timestamp` − 5 minutos, deduplicación por id).
2. Por cada una nueva arma la cotización de Emite DTE con **lo que el cliente compró** (las líneas
   de la aceptación: cantidades, precios y descuentos aceptados; sin ellas, las obligatorias más las
   opcionales elegidas), el cliente por RUT, la OC del cliente (`poNumber` → referencia 801 al
   facturar), vigencia, forma de pago, condiciones y el SKU de cada producto, y la crea con
   `POST /cotizaciones` (`origen: { nombre: "coreinbox", idExterno: <id>, numero: <número de Coreinbox> }`:
   Emite DTE muestra la cotización con ese número, «C-3008», y lo cita en la factura;
   `estado: "aceptada"`). Si el RUT no está en el catálogo de Emite DTE
   (`RECEPTOR_NO_EXISTE`), la reenvía con el receptor completo y así lo crea.
3. Anota en el negocio de Coreinbox «Cotización … lista para facturar en Emite DTE (N° …)». Se
   factura desde Emite DTE como siempre (borrador → emitir); el conector no emite nada.
4. Recibe los **webhooks firmados** de Emite DTE (`cotizacion.facturada`, `dte.emitido`,
   `dte.enviado_sii`, `dte.aceptado`, `dte.rechazado`, `dte.correo_enviado`) en `POST /webhooks`,
   verifica la firma (Standard Webhooks), descarta repetidos por `webhook-id` y anota la actividad
   correspondiente en el negocio, con el enlace al PDF.
5. Con `FLUJO_PRODUCTOS=true`, en la misma pasada lleva los **productos** cambiados en Coreinbox al
   catálogo de Emite DTE (ver [Catálogo de productos](#catálogo-de-productos)).

**Idempotencia.** Repetir una pasada es inocuo: Emite DTE devuelve la cotización existente ante el
mismo `origen` + `idExterno`, y el conector recuerda lo que ya pasó. Una versión nueva de la
cotización en Coreinbox es otra cotización (otro id) y entra sola cuando se acepta.

**Errores.** Una falla de red o un 5xx deja la cotización pendiente y no mueve el cursor: se
reintenta en la pasada siguiente. Un dato que Emite DTE no puede recibir (moneda distinta de CLP,
empresa sin RUT válido, sin líneas, validación 4xx) queda registrado con su mensaje, se anota
**una vez** en el negocio («no se pudo pasar a facturación: …») y se vuelve a intentar al cambiar
la cotización; mientras tanto no bloquea a las demás.

## Catálogo de productos

Apagado por omisión (`FLUJO_PRODUCTOS=false`). `SINCRONIZAR_PRODUCTOS=true` sigue funcionando como
alias de `FLUJO_PRODUCTOS` y deja un aviso en el log al arrancar; si están las dos, manda
`FLUJO_PRODUCTOS`. Encendido, cada pasada consulta también `GET /products?updatedSince=…` de
Coreinbox (misma receta de cursor, con un cursor **propio**, `cursor_productos`) y deja cada producto
en el catálogo de Emite DTE (`GET /productos/por-codigo`, `POST /productos`, `PATCH /productos/{id}`).
Decisiones:

- **Correspondencia: el SKU de Coreinbox es el `codigo` de Emite DTE** (CdgItem, 35 caracteres).
  Un producto sin SKU **no viaja**: queda como omitido con aviso en el log y vuelve a intentarse
  cuando cambie en Coreinbox (basta ponerle SKU). Lo mismo con un SKU de más de 35 caracteres, un
  producto en otra moneda o uno inactivo en Coreinbox que todavía no existe en Emite DTE.
- **Coreinbox manda.** Un cambio allá se refleja acá. En Emite DTE **nunca se borra ni se
  desactiva nada**: Coreinbox no informa borrados por `updatedSince`, y desactivar un producto en
  el catálogo es una decisión de quien factura.
- **Qué viaja al crear:** `codigo` (SKU), `nombre` (80 caracteres), `descripcion`, `tipo`
  (`product` → `bien`; `service`, `license`, `subscription` → `servicio`), `unidad` (la de
  Coreinbox llevada a la sigla de 4 caracteres del SII: hora → `HRS`, unidad → `UN`, kg → `KG`…;
  una desconocida se recorta), `precioNeto` (el `unitPrice` base, neto en pesos, a dos decimales),
  `exento` (si el producto no lleva impuesto o su `taxRate` es 0) y `categoria` (el nombre de la
  categoría de Coreinbox, 60 caracteres). Las **listas de precios** de Coreinbox no se miran: el
  catálogo de Emite DTE tiene un solo precio de lista por producto.
- **Si ya existe en Emite DTE un producto con ese código** (o con ese código como alias por haberlo
  recodificado, o fusionado en otro: `por-codigo` resuelve las tres cosas y responde con el que
  queda), el conector **sólo actualiza el nombre y el precio**, y sólo cuando difieren. La
  descripción, unidad, categoría, exención, inventario y estado activo del producto se respetan
  como estén en Emite DTE; el código nunca se cambia. Un precio nuevo queda en el historial de
  precios y un nombre nuevo deja el anterior como alias, como con cualquier edición.
- **Idempotencia.** Repetir una pasada no crea duplicados: antes de crear se busca por código y un
  `409 PRODUCTO_DUPLICADO` (alguien lo creó entre la consulta y el alta) se trata como existente.
- **Errores.** Una falla de red o un 5xx deja el producto pendiente y no mueve el cursor de
  productos. Un dato que Emite DTE rechaza (4xx) queda registrado con su mensaje, se avisa una vez
  en el log y no bloquea a los demás; no se anota nada en el CRM (un producto no tiene negocio).
  `GET /salud` trae los contadores en `flujos.productos`: `sincronizados`, `omitidos` y `conError`.

Alcances: `products:read` en la clave de Coreinbox y `catalogo:leer` + `catalogo:escribir` en la
API key de Emite DTE. La primera pasada recorre todo el catálogo desde `DESDE` (páginas de 100,
una consulta a Emite DTE por producto): con catálogos grandes conviene un `DESDE` antiguo y
paciencia, o depurar antes los SKU en Coreinbox.

## WooCommerce

Adaptador listo, sin flujo que lo use todavía. `src/adaptadores/woocommerce/cliente.ts` es un
cliente de la API REST `wc/v3` de la tienda:

- Autenticación con clave y secreto de consumidor por `Authorization: Basic`. Sólo HTTPS: con
  `WOO_URL` en `http://` el conector no arranca.
- Lectura en páginas de 100, según el total de la cabecera `X-WP-TotalPages`.
- Productos y pedidos modificados desde una fecha con `modified_after` en UTC
  (`dates_are_gmt=true`).
- 429, 5xx y fallas de red son transitorios: se reintenta hasta tres veces con espera creciente
  (1 s, 2 s, 4 s…), con tope de 30 s. Se respeta `Retry-After` si llega.
- 4xx es un error de dato: no se reintenta y se registra con el mensaje que devuelve WooCommerce.

Las tres variables `WOO_*` son opcionales y van juntas: si se define una, las tres son obligatorias.
Para probar URL y claves a mano:

```bash
pnpm verificar:woo
```

Lista los primeros 5 productos (id, SKU, nombre y precio). Sólo lee. Las claves se crean en
WooCommerce → Ajustes → Avanzado → API REST, con permiso de lectura/escritura.

## Requisitos

- Node.js 22.13 o superior (usa `node:sqlite` para su estado; sin más dependencias en producción).
- En **Coreinbox**: una clave de API (Ajustes → Integraciones → Claves de API) con los alcances
  `quotes:read`, `companies:read`, `contacts:read`, `products:read` y `activities:write`.
- En **Emite DTE**: una API key del emisor con `cotizaciones:escribir` y `dte:leer` (más
  `catalogo:leer` y `catalogo:escribir` si se enciende `FLUJO_PRODUCTOS`), y un webhook
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
recibe los webhooks sin exponer nada a Internet). `docker-compose.prod.yml` de Emite DTE ya trae
el servicio bajo el perfil `conector`: se clona este repositorio **junto** a la carpeta de Emite
DTE (`../emite-dte-conector`), se deja `conector.env` (600) al lado del `.env` y se levanta con

```bash
docker compose -p <proyecto> -f docker-compose.prod.yml --profile conector up -d --build
```

El servicio equivale a:

```yaml
conector:
  build: ../emite-dte-conector
  profiles: [conector]
  env_file: conector.env
  environment:
    EMITE_URL: http://app:3000
  volumes:
    - conector_datos:/datos
  restart: unless-stopped
```

y en Emite DTE el webhook apunta a `http://conector:8080/webhooks`.

Nota: mientras el repositorio no se renombre y el compose de Emite DTE no se actualice, la
instalación existente sigue con el servicio `conector-coreinbox`, el archivo
`conector-coreinbox.env` y la carpeta `../emite-dte-conector-coreinbox`. El cambio se hace junto
en la siguiente subida.

## Variables de entorno

| Variable                   | Obligatoria         | Por omisión                                   | Para qué                                                                                                  |
| -------------------------- | ------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `COREINBOX_URL`            | Sí                  | —                                             | URL base de la API de Coreinbox.                                                                          |
| `COREINBOX_API_KEY`        | Sí                  | —                                             | Clave `cik_…` de Coreinbox, con los alcances de [Requisitos](#requisitos).                                |
| `COREINBOX_TIPO_ACTIVIDAD` | No                  | `d0000000-0000-0000-0000-000000000004` (nota) | Tipo de actividad del CRM con que se anotan los eventos.                                                  |
| `EMITE_URL`                | Sí                  | —                                             | URL de la API de Emite DTE por la red interna (en el compose, `http://app:3000`).                         |
| `EMITE_API_KEY`            | Sí                  | —                                             | API key del emisor, `edte_…`, con `cotizaciones:escribir` y `dte:leer` (y catálogo si `FLUJO_PRODUCTOS`). |
| `EMITE_EMISOR_ID`          | Sí                  | —                                             | Emisor al que se cargan las cotizaciones y los productos.                                                 |
| `EMITE_URL_PUBLICA`        | No                  | El valor de `EMITE_URL`                       | URL con la que la gente abre Emite DTE; va en los enlaces de las actividades del CRM.                     |
| `EMITE_WEBHOOK_SECRET`     | Sí                  | —                                             | Secreto `whsec_…` del webhook registrado en Emite DTE.                                                    |
| `DESDE`                    | No                  | Fecha y hora de arranque                      | Primer `updatedSince` de cotizaciones y productos, cuando no hay cursor guardado (ISO 8601).              |
| `FLUJO_COTIZACIONES`       | No                  | `true`                                        | Enciende el flujo A, cotizaciones aceptadas.                                                              |
| `FLUJO_PRODUCTOS`          | No                  | `false`                                       | Enciende el flujo C, catálogo de productos (Coreinbox → Emite DTE).                                       |
| `SINCRONIZAR_PRODUCTOS`    | No (obsoleta)       | —                                             | Alias de `FLUJO_PRODUCTOS`, con aviso en el log. Si están las dos, manda `FLUJO_PRODUCTOS`.               |
| `FLUJO_PEDIDOS`            | No                  | `false`                                       | Flujo B, pedidos web. Sin implementar: encendido sólo deja un aviso en el log.                            |
| `WOO_URL`                  | No, las tres juntas | —                                             | URL de la tienda WooCommerce. Debe ser `https://`.                                                        |
| `WOO_CONSUMER_KEY`         | No, las tres juntas | —                                             | Clave de consumidor de la API REST, `ck_…`.                                                               |
| `WOO_CONSUMER_SECRET`      | No, las tres juntas | —                                             | Secreto de consumidor de la API REST, `cs_…`.                                                             |
| `INTERVALO_S`              | No                  | `60`                                          | Segundos entre pasadas. Mínimo 10.                                                                        |
| `PUERTO`                   | No                  | `8080`                                        | Puerto del receptor de webhooks y de `GET /salud`.                                                        |
| `ESTADO_RUTA`              | No                  | `./datos/estado.sqlite`                       | Dónde se guarda el estado (SQLite).                                                                       |

Los booleanos aceptan `true`, `1`, `si` o `sí`, y `false`, `0` o `no`. Otro valor falla al arrancar.
`SINCRONIZAR_PRODUCTOS` se lee como antes: sólo `true`, `1`, `si` o `sí` la encienden.

`GET /salud` responde:

```text
{
  ok, creadas, conError, productos,
  flujos: {
    cotizaciones: { activo, cursor, creadas, conError, ultimaPasada, ultimaFalla },
    productos:    { activo, cursor, sincronizados, omitidos, conError, ultimaPasada, ultimaFalla },
    pedidos:      { activo: false }
  }
}
```

Las claves de primer nivel (`ok`, `creadas`, `conError`, `productos`) se mantienen por compatibilidad.
`ultimaPasada` y `ultimaFalla` viven en memoria y se pierden al reiniciar. `ultimaFalla` trae sólo
`codigo`, `status` y `transitorio` (`/salud` no lleva autenticación); el mensaje completo queda en el
log. Una falla de red o un 5xx en una pasada queda con `transitorio: true` y en el log como `warn`.

El estado (cursores, cotizaciones pasadas, productos sincronizados, webhooks vistos) vive en
`ESTADO_RUTA` (SQLite); borrarlo obliga a volver a empezar desde `DESDE`, sin duplicar nada en
Emite DTE.

## Panel

El conector sirve un panel de sólo lectura en `/panel`. Es HTML generado por el propio proceso, sin
JavaScript ni dependencias.

- **Flujos** (`/panel` o `/panel/flujos`): por flujo (cotizaciones, productos, pedidos) si está
  activo, su cursor, contadores, última pasada, última falla con código, status y si fue transitoria,
  y los errores recientes.
- **Eventos** (`/panel/eventos`): lo último que pasó por el conector, en orden inverso (cotizaciones
  creadas o con error, webhooks recibidos, productos sincronizados u omitidos con su motivo). Filtros
  por consulta: `?flujo=cotizaciones|productos&estado=creada|visto|sincronizado|omitido|error`, y
  paginación con `?pagina=2` (50 por página). Los enlaces a la cotización en Emite DTE usan
  `EMITE_URL_PUBLICA`.

Se verá dentro de Emite DTE, en Administración → «Integraciones», cuando el núcleo tenga esa sección:
reenvía `/integraciones/conector/…` al conector y agrega la cabecera `X-Emite-Usuario`, que el panel
muestra como «viendo como …». Por eso todos los enlaces son relativos.

Mientras tanto se prueba en local con `pnpm dev` y se abre http://localhost:8080/panel (o el `PUERTO`
configurado).

**No tiene autenticación propia: no debe exponerse a Internet.** Sólo se alcanza por la red interna
del compose.

Lee el mismo SQLite del estado en modo de sólo lectura. La última pasada y la última falla viven en
memoria y se pierden al reiniciar.

## Qué no hace (todavía)

- No muestra el folio como insignia ni adjunta el PDF en Coreinbox: lo anota como actividad con
  el enlace. Cuando Coreinbox tenga webhooks salientes y campos de factura, el conector cambiará
  la consulta periódica por recepción, sin tocar lo demás.
- Factura sólo en pesos. Una cotización en otra moneda queda con error y aviso en el negocio.
- Un workspace de Coreinbox ↔ un emisor de Emite DTE. Para más, una instancia por par.
- La sincronización de productos va en un solo sentido (Coreinbox → Emite DTE), no mira las
  listas de precios ni las imágenes, y no desactiva ni borra nada en Emite DTE.
- El flujo de pedidos y la sincronización con WooCommerce no están implementados: sólo existe el
  adaptador.

## Desarrollo

```bash
pnpm test           # vitest, sin red
pnpm typecheck
pnpm build          # compila a dist/
pnpm format:check   # prettier sobre src/ y README.md
pnpm dev            # con el .env
pnpm verificar:woo  # lista 5 productos de WooCommerce; sólo lee
```

Los datos de las pruebas son sintéticos (`Empresa de Prueba SpA`, RUT `76000000-0`). Nada de
ninguna empresa real va al repositorio.
