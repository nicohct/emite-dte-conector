# Conector de Emite DTE

Es el proceso de integración de una instalación de
[Emite DTE](https://github.com/nicohct/emite-dte). Hoy lleva las cotizaciones **aceptadas** de
[Coreinbox](https://github.com/nicohct/coreinbox-crm) a Emite DTE y devuelve al CRM el folio, el
estado ante el SII y el envío por correo como actividades en el negocio. Opcionalmente lee el catálogo de productos de Coreinbox, de Emite DTE y de una tienda
**WooCommerce**, y arma un registro canónico por SKU. Es un proceso aparte que sólo usa las APIs públicas de Emite DTE (ADR-012,
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

| Flujo                             | Sentido                                   | Variable                                                        | Estado                                                                                 |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A · Cotizaciones aceptadas        | Coreinbox → Emite DTE → Coreinbox         | `FLUJO_COTIZACIONES` (encendido por omisión)                    | En producción                                                                          |
| B · Pedidos web                   | WooCommerce → Emite DTE → WooCommerce     | `FLUJO_PEDIDOS` (sin implementar: encendido sólo deja un aviso) | Planificado, enero de 2027                                                             |
| C · Productos transversales       | entre los tres, registro canónico por SKU | `FLUJO_PRODUCTOS` (apagado por omisión)                         | Fase 1a: lectura y registro canónico. Fase 1b (escritura, fusiones): noviembre de 2026 |
| D · Solicitudes de cotización web | WooCommerce → Coreinbox                   | —                                                               | Por evaluar frente al lector de correo de Coreinbox                                    |
| E · Panel                         | —                                         | —                                                               | Flujos, eventos, productos y decisiones del catálogo (sólo el registro hasta la 1b)    |

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
5. Con `FLUJO_PRODUCTOS=true`, en la misma pasada lee los **productos** de Coreinbox, de la web
   WooCommerce y de Emite DTE, y arma el registro canónico por SKU (ver
   [Catálogo de productos](#catálogo-de-productos)). Con `PRODUCTOS_ESCRIBIR=true` lleva además
   Coreinbox → Emite DTE, como antes.

**Idempotencia.** Repetir una pasada es inocuo: Emite DTE devuelve la cotización existente ante el
mismo `origen` + `idExterno`, y el conector recuerda lo que ya pasó. Una versión nueva de la
cotización en Coreinbox es otra cotización (otro id) y entra sola cuando se acepta.

**Errores.** Una falla de red o un 5xx deja la cotización pendiente y no mueve el cursor: se
reintenta en la pasada siguiente. Un dato que Emite DTE no puede recibir (moneda distinta de CLP,
empresa sin RUT válido, sin líneas, validación 4xx) queda registrado con su mensaje, se anota
**una vez** en el negocio («no se pudo pasar a facturación: …») y se vuelve a intentar al cambiar
la cotización; mientras tanto no bloquea a las demás.

## Catálogo de productos

Flujo C, apagado por omisión (`FLUJO_PRODUCTOS=false`). `SINCRONIZAR_PRODUCTOS=true` sigue funcionando
como alias obsoleto de `FLUJO_PRODUCTOS` y deja un aviso en el log al arrancar; si están las dos, manda
`FLUJO_PRODUCTOS`.

Desde la fase 1a del hub, encendido **sólo lee** los tres sistemas (Coreinbox, la web WooCommerce y
Emite DTE) y arma un **registro canónico por SKU** en el SQLite del conector. No escribe en ningún
sistema mientras `PRODUCTOS_ESCRIBIR=false` (por omisión). La escritura en los tres, con eco y
conflictos, y las fusiones son la fase 1b.

### Lectura

- **Coreinbox**: `GET /products?updatedSince=…`, con cursor = `meta.timestamp` − 5 minutos.
- **Web (WooCommerce)**: `GET /products?modified_after=…` en páginas de 100. 429, 5xx y fallas de red
  son transitorios y se reintentan.
- **Emite DTE**: `GET /productos?orden=reciente&activo=todos`, hasta llegar a productos anteriores al
  cursor.

Cada sistema tiene su cursor propio (`cursor_catalogo_coreinbox`, `cursor_catalogo_woocommerce`,
`cursor_catalogo_emite`), independiente de `cursor_productos`. La primera pasada lee todo el catálogo;
no usa `DESDE`. Una falla transitoria corta la pasada sin mover el cursor del sistema que falló, y
queda visible en `GET /salud`. Sin `WOO_URL` la pasada lee sólo Coreinbox y Emite DTE.

### Modelo

Las fuentes son Coreinbox y la web. Los productos de Emite DTE con `origen=historial` (importados del
SII) **no son fuente**: van a una lista de históricos para empatarlos con los productos reales.

Campos compartidos:

- **`nombre`**.
- **`precio`**: bruto entero en pesos. Coreinbox y Emite DTE se llevan a bruto desde su neto con su
  tasa (los exentos, sin IVA). Se compara siempre en bruto; el neto a dos decimales es derivado.
- **`activo`**: en la web significa publicado y no oculto.

Además se leen `tipo` (bien o servicio: `service`, `license` y `subscription` son servicio),
`categoria` y `exento`.

Por SKU se guarda: el id en cada sistema; la última versión leída de cada campo, con la hora en que se
vio; la marca «lo escribí yo» (vacía en la 1a); el canónico con su fuente; el tipo, el alcance, la
visibilidad web, las diferencias, «falta en…», los conflictos, los empates y el índice.

- **Quién manda (regla de arranque).** La web manda en precio y nombre comercial; Coreinbox, en tipo,
  categoría, activo y exención. Si la fuente preferida no tiene el dato, manda la otra. Se ajusta por
  campo, para todo el catálogo o en lote por SKU, desde el panel.
- **Visibilidad web.** `no_aplica` (los servicios nunca van a la web); `aprobado` (lo publicado hoy en
  la web arranca así); `propuesto` (todo lo demás, repuestos incluidos); `rechazado` (decisión del
  panel).
- **Alcance.** Servicio → Coreinbox y Emite DTE. Bien aprobado → los tres. El resto → Coreinbox y
  Emite DTE.
- **Conflicto.** El mismo campo compartido cambiado en dos sistemas desde la pasada anterior, a valores
  distintos. Queda abierto, con los valores y la hora de cada lado, hasta que alguien elija.
- **Empates.** Para cada histórico se propone el mejor SKU, según el criterio que lo encontró: código
  exacto (1); alias que resuelve `por-codigo` (0,95); código sin signos ni mayúsculas (0,9); nombre
  normalizado igual (0,85); nombre parecido (0,8 × similitud, desde 0,6). Cada propuesta sale junto con
  el `uso` del histórico (documentos y última venta). Un empate rechazado no se vuelve a proponer.
  Confirmar es una decisión del registro; fusionar en Emite DTE es de la 1b.
- **Índice de información.** Por SKU y sistema, enlaces con URL y hash SHA-256 de lo leído. Imágenes y
  documentos no se descargan:
  - Coreinbox: producto e imagen, y categoría.
  - Web: página, atributos, metadatos (los que no empiezan con `_`, p. ej. los campos del generador de
    fichas), imágenes, categorías y documentos (URLs a PDF o planos en los metadatos o la descripción).
  - Emite DTE: producto.
- **Sin SKU.** Los productos sin SKU de Coreinbox o de la web se listan aparte y no entran al registro.
- **Reconstruibilidad.** Lo derivado (lecturas, canónico, históricos, empates propuestos, índice, sin
  SKU y cursores) se reconstruye igual leyendo los tres sistemas si se borra el SQLite; hay una prueba
  que lo verifica. Las **decisiones** del panel (quién manda, empates confirmados o rechazados,
  visibilidad, conflictos resueltos, bitácora con el usuario) viven en tablas aparte: son órdenes que la
  1b llevará a los sistemas, y se pierden si se borra el archivo antes de eso.

### Lectura consolidada y acciones (JSON)

Protegidas con `Authorization: Bearer <CATALOGO_API_KEY>`. Sin esa variable, las rutas no existen (404).
Están pensadas para la red interna y el panel.

- `GET /catalogo?pagina=1&limite=50` (máximo 200), con los filtros `q`, `diferencias=true`,
  `conflicto=true`, `sin_sku=true` (le falta algún sistema de su alcance), `propuesto_web=true` y
  `historicos=true` (tiene empates propuestos). Con `vista=historicos` (y `estado=propuesto|confirmado|rechazado|sin_candidato`)
  lista los históricos con sus empates; con `vista=sin_sku` (y `sistema=`) lista los productos sin SKU.
  Responde `{ vista, pagina, limite, total, items }`.
- `GET /catalogo/{sku}`: canónico, `precioNeto`, tipo, alcance, visibilidad, diferencias, `faltaEn`,
  `sistemas` (id, valores, hora de cambio y de lectura de cada uno), reglas, conflictos, empates con su
  histórico e `indice`.
- `POST /catalogo/acciones/reglas` con `{ campo, fuente, skus? }`. La fuente es `coreinbox`,
  `woocommerce` o `emite`, o `null` para volver a la de arranque. Sin `skus`, aplica a todo el catálogo.
- `POST /catalogo/acciones/empates` con `{ decisiones: [{ emiteId, sku, estado: "confirmado"|"rechazado" }] }`.
- `POST /catalogo/acciones/conflictos` con `{ resoluciones: [{ id, fuente }] }`: deja el valor de esa
  fuente como regla del SKU y cierra el conflicto.
- `POST /catalogo/acciones/visibilidad` con `{ skus: [...], estado: "aprobado"|"rechazado" }`. Un
  servicio no se aprueba.

Las acciones responden `{ aplicadas, errores: [{ indice, error }] }`, procesan en lote (hasta 500) y
registran la cabecera `X-Emite-Usuario`. En la 1a sólo cambian el registro; no escriben en los sistemas.
El panel usa las mismas acciones desde sus formularios (ver «Panel»).

### Escritura de antes (`PRODUCTOS_ESCRIBIR=true`)

Con `PRODUCTOS_ESCRIBIR=true`, la escritura corre después de la pasada de lectura. Es el comportamiento
de antes de la fase 1: un solo sentido, Coreinbox → Emite DTE. Se mantiene hasta la 1b.

- **Correspondencia.** El SKU de Coreinbox es el `codigo` de Emite DTE (35 caracteres). Un producto sin
  SKU, con un SKU de más de 35 caracteres, en otra moneda, o inactivo que todavía no existe en Emite
  DTE, queda omitido con aviso y se reintenta cuando cambie.
- **Coreinbox manda.** En Emite DTE nunca se borra ni se desactiva nada: Coreinbox no informa borrados
  por `updatedSince`, y desactivar un producto es una decisión de quien factura.
- **Qué viaja al crear.** `codigo`, `nombre` (80 caracteres), `descripcion`, `tipo`, `unidad` (la sigla
  SII de 4 caracteres; una desconocida se recorta), `precioNeto` (el `unitPrice` base, neto, a dos
  decimales), `exento` y `categoria` (60 caracteres). Las listas de precios de Coreinbox no se miran.
- **Si ya existe.** Si Emite DTE ya tiene ese código (como código, alias o producto fusionado; `por-codigo`
  resuelve los tres casos), sólo se actualizan el nombre y el precio, y sólo cuando difieren. La
  descripción, unidad, categoría, exención, inventario y estado activo se respetan como estén en Emite
  DTE, y el código nunca cambia. Un precio nuevo queda en el historial, y un nombre nuevo deja el
  anterior como alias.
- **Idempotencia.** Antes de crear se busca por código. Un `409 PRODUCTO_DUPLICADO` (alguien lo creó
  entre la consulta y el alta) se trata como existente.
- **Errores.** Una falla de red o un 5xx deja el producto pendiente y no mueve el cursor de escritura.
  Un 4xx queda registrado con su mensaje, se avisa una vez en el log y no bloquea a los demás. No se
  anota nada en el CRM. Los contadores `sincronizados`, `omitidos` y `conError` de `GET /salud`
  corresponden a esta escritura.

Alcances: `products:read` en la clave de Coreinbox; `catalogo:leer` en la API key de Emite DTE para
leer, y `catalogo:escribir` sólo con la escritura. En WooCommerce basta el permiso de lectura para la 1a.
La escritura arranca desde `DESDE`, como antes: con catálogos grandes conviene un `DESDE`
antiguo y paciencia, o depurar antes los SKU en Coreinbox.

## WooCommerce

El catálogo de productos la lee cuando `FLUJO_PRODUCTOS` está encendido. `src/adaptadores/woocommerce/cliente.ts` es un
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
WooCommerce → Ajustes → Avanzado → API REST, con permiso de lectura/escritura (para la fase 1a del catálogo basta el de lectura).

## Requisitos

- Node.js 22.13 o superior (usa `node:sqlite` para su estado; sin más dependencias en producción).
- En **Coreinbox**: una clave de API (Ajustes → Integraciones → Claves de API) con los alcances
  `quotes:read`, `companies:read`, `contacts:read`, `products:read` y `activities:write`.
- En **Emite DTE**: una API key del emisor con `cotizaciones:escribir` y `dte:leer` (más
  `catalogo:leer` si se enciende `FLUJO_PRODUCTOS`, y `catalogo:escribir` sólo con `PRODUCTOS_ESCRIBIR`), y un webhook
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

| Variable                   | Obligatoria         | Por omisión                                   | Para qué                                                                                                                                                                  |
| -------------------------- | ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COREINBOX_URL`            | Sí                  | —                                             | URL base de la API de Coreinbox.                                                                                                                                          |
| `COREINBOX_API_KEY`        | Sí                  | —                                             | Clave `cik_…` de Coreinbox, con los alcances de [Requisitos](#requisitos).                                                                                                |
| `COREINBOX_TIPO_ACTIVIDAD` | No                  | `d0000000-0000-0000-0000-000000000004` (nota) | Tipo de actividad del CRM con que se anotan los eventos.                                                                                                                  |
| `EMITE_URL`                | Sí                  | —                                             | URL de la API de Emite DTE por la red interna (en el compose, `http://app:3000`).                                                                                         |
| `EMITE_API_KEY`            | Sí                  | —                                             | API key del emisor, `edte_…`, con `cotizaciones:escribir` y `dte:leer` (y catálogo: `catalogo:leer` con `FLUJO_PRODUCTOS`, `catalogo:escribir` con `PRODUCTOS_ESCRIBIR`). |
| `EMITE_EMISOR_ID`          | Sí                  | —                                             | Emisor al que se cargan las cotizaciones y los productos.                                                                                                                 |
| `EMITE_URL_PUBLICA`        | No                  | El valor de `EMITE_URL`                       | URL con la que la gente abre Emite DTE; va en los enlaces de las actividades del CRM.                                                                                     |
| `EMITE_WEBHOOK_SECRET`     | Sí                  | —                                             | Secreto `whsec_…` del webhook registrado en Emite DTE.                                                                                                                    |
| `DESDE`                    | No                  | Fecha y hora de arranque                      | Primer `updatedSince` de cotizaciones y, con `PRODUCTOS_ESCRIBIR`, de productos, cuando no hay cursor guardado (ISO 8601). El catálogo no lo usa.                         |
| `FLUJO_COTIZACIONES`       | No                  | `true`                                        | Enciende el flujo A, cotizaciones aceptadas.                                                                                                                              |
| `FLUJO_PRODUCTOS`          | No                  | `false`                                       | Enciende el flujo C, catálogo de productos: lectura de los tres sistemas y registro canónico.                                                                             |
| `SINCRONIZAR_PRODUCTOS`    | No (obsoleta)       | —                                             | Alias de `FLUJO_PRODUCTOS`, con aviso en el log. Si están las dos, manda `FLUJO_PRODUCTOS`.                                                                               |
| `PRODUCTOS_ESCRIBIR`       | No                  | `false`                                       | Con `FLUJO_PRODUCTOS`, además de leer, lleva Coreinbox → Emite DTE como antes de la fase 1.                                                                               |
| `CATALOGO_API_KEY`         | No                  | —                                             | Clave de `GET /catalogo` y sus acciones (`Authorization: Bearer`). Sin ella esas rutas no existen.                                                                        |
| `FLUJO_PEDIDOS`            | No                  | `false`                                       | Flujo B, pedidos web. Sin implementar: encendido sólo deja un aviso en el log.                                                                                            |
| `WOO_URL`                  | No, las tres juntas | —                                             | URL de la tienda WooCommerce. Debe ser `https://`.                                                                                                                        |
| `WOO_CONSUMER_KEY`         | No, las tres juntas | —                                             | Clave de consumidor de la API REST, `ck_…`.                                                                                                                               |
| `WOO_CONSUMER_SECRET`      | No, las tres juntas | —                                             | Secreto de consumidor de la API REST, `cs_…`.                                                                                                                             |
| `INTERVALO_S`              | No                  | `60`                                          | Segundos entre pasadas. Mínimo 10.                                                                                                                                        |
| `PUERTO`                   | No                  | `8080`                                        | Puerto del receptor de webhooks y de `GET /salud`.                                                                                                                        |
| `ESTADO_RUTA`              | No                  | `./datos/estado.sqlite`                       | Dónde se guarda el estado (SQLite).                                                                                                                                       |

Los booleanos aceptan `true`, `1`, `si` o `sí`, y `false`, `0` o `no`. Otro valor falla al arrancar.
`SINCRONIZAR_PRODUCTOS` se lee como antes: sólo `true`, `1`, `si` o `sí` la encienden.

`GET /salud` responde:

```text
{
  ok, creadas, conError, productos,
  flujos: {
    cotizaciones: { activo, cursor, creadas, conError, ultimaPasada, ultimaFalla },
    productos:    { activo, cursor, sincronizados, omitidos, conError, catalogo, ultimaPasada, ultimaFalla },
    pedidos:      { activo: false }
  }
}
```

`flujos.productos.catalogo` trae `skus`, `leidos` por sistema (`coreinbox`, `woocommerce`, `emite`, con los históricos y los sin SKU), `historicos`, `conDiferencias`, `enConflicto`, `empatesPropuestos` y `sinSku`.

Las claves de primer nivel (`ok`, `creadas`, `conError`, `productos`) se mantienen por compatibilidad.
`ultimaPasada` y `ultimaFalla` viven en memoria y se pierden al reiniciar. `ultimaFalla` trae sólo
`codigo`, `status` y `transitorio` (`/salud` no lleva autenticación); el mensaje completo queda en el
log. Una falla de red o un 5xx en una pasada queda con `transitorio: true` y en el log como `warn`.

El estado (cursores, cotizaciones pasadas, productos sincronizados, webhooks vistos) vive en
`ESTADO_RUTA` (SQLite); borrarlo obliga a volver a empezar desde `DESDE`, sin duplicar nada en
Emite DTE.

## Panel

El conector sirve un panel en `/panel`. Es HTML generado por el propio proceso, sin JavaScript ni
dependencias, y lee todo de `Estado` (no abre el SQLite por su cuenta).

- **Flujos** (`/panel` o `/panel/flujos`): por flujo (cotizaciones, productos, pedidos) si está
  activo, su cursor, contadores, última pasada, última falla con código, status y si fue transitoria,
  y los errores recientes. La tarjeta **Catálogo** suma el resumen del registro (SKUs, leídos por
  sistema, históricos, con diferencias, en conflicto, empates propuestos, sin SKU), cada cifra con
  enlace a su lista filtrada.
- **Eventos** (`/panel/eventos`): lo último que pasó, en orden inverso: cotizaciones creadas o con
  error, webhooks recibidos, productos sincronizados u omitidos, conflictos abiertos o resueltos,
  empates propuestos o decididos y acciones del panel, con enlace al SKU cuando lo hay. Filtros por
  consulta `?flujo=cotizaciones|productos&estado=…` (los estados de cada tipo, o el nombre de la
  acción) y `?pagina=2` (50 por página). Los enlaces a la cotización en Emite DTE usan
  `EMITE_URL_PUBLICA`.
- **Productos** (`/panel/productos`): tabla por SKU con la foto, el valor canónico y el de cada
  sistema en nombre, precio bruto y activo (los que difieren, marcados), tipo, alcance, visibilidad
  web y avisos. Filtros `q`, `diferencias=1`, `conflicto=1`, `sin_sku=1`, `propuesto_web=1` e
  `historicos=1`, y paginación. Desde la misma pantalla, las vistas **Históricos** y **Sin SKU**
  (`?vista=sin_sku&sistema=…`).
- **Detalle** (`/panel/productos/{sku}`): valores por sistema con la hora en que se vio cada uno,
  reglas que le aplican, conflictos, empates con su histórico, índice de enlaces (cada URL abre el
  sistema en otra pestaña) y la foto principal.
- **Históricos** (`/panel/historicos`): los productos históricos de Emite DTE con su uso y su
  empate (puntaje, motivo); confirmar o rechazar uno a uno o en lote. Filtro
  `?estado=propuesto|confirmado|rechazado|sin_candidato`.
- **Conflictos** (`/panel/conflictos`): los abiertos de todo el catálogo; «quedarse con el de la
  web / Coreinbox / Emite DTE», uno a uno o en lote.
- **Visibilidad web** (`/panel/visibilidad`): los propuestos para la web; aprobar o rechazar, uno
  a uno o en lote. Un servicio no se ofrece.
- **Quién manda** (`/panel/reglas`): qué sistema manda en cada campo para todo el catálogo. En lote
  por SKU, eligiéndolos en la lista de productos; para uno, desde su detalle.

### Acciones

Las decisiones son formularios HTML que mandan `POST /panel/acciones/{reglas|empates|conflictos|visibilidad}`
y usan la misma lógica que la API JSON (`src/flujos/productos/acciones.ts`). No piden
`CATALOGO_API_KEY`: el panel está detrás de Emite DTE, y la cabecera `X-Emite-Usuario` queda como
usuario de la decisión. Tras aplicar, redirigen (303) a la pantalla de origen con el resultado
(aplicadas y errores). Cada acción queda en la bitácora y aparece como evento `accion`.

**Hasta la fase 1b, las decisiones del panel sólo cambian el registro del conector: no escriben en
Coreinbox, en la web ni en Emite DTE.**

Protección mínima contra envíos desde otro sitio, sin cookies ni sesiones propias: un POST se rechaza
con 403 si trae `Sec-Fetch-Site` y no es `same-origin` ni `none`, o si trae `Origin` y su host no es
el pedido: el primer valor de `X-Forwarded-Host` si viene, o si no `Host`. Por eso el reenvío de
Emite DTE debe conservar `Host` o mandar `X-Forwarded-Host` con el host del navegador.

### Miniatura de la foto principal

`GET /panel/imagen/{sku}` sirve la foto principal del SKU: la primera imagen de la web si el producto
está en la web; si no, la de Coreinbox (descargada con su clave por el adaptador). Sólo se descargan
URL que están en el índice del catálogo, nunca una que venga en la petición. La copia queda en la
tabla `miniaturas` del SQLite con el hash de la entrada del índice; si ese hash cambia, se vuelve a
descargar. Tope de 1 MB y sólo PNG, JPEG, GIF, WebP o AVIF; sin foto, con la descarga fallida o
sobre el tope responde 404 y la pantalla deja un hueco. Se sirve con
`cache-control: private, max-age=86400`. No se redimensiona: el CSS la muestra a 48 px en la lista
y a 240 px en el detalle.

Es un caché derivado del índice: borrar la tabla no pierde nada, el panel vuelve a descargar las
fotos a medida que se piden.

### Dónde se ve

Se verá dentro de Emite DTE, en Administración → «Integraciones», cuando el núcleo tenga esa sección:
reenvía `/integraciones/conector/…` al conector y agrega la cabecera `X-Emite-Usuario`, que el panel
muestra como «viendo como …». Por eso todos los enlaces son relativos.

Mientras tanto se prueba en local con `pnpm dev` y se abre http://localhost:8080/panel (o el `PUERTO`
configurado).

**No tiene autenticación propia: no debe exponerse a Internet.** Sólo se alcanza por la red interna
del compose.

La última pasada y la última falla viven en memoria y se pierden al reiniciar.

## Qué no hace (todavía)

- No muestra el folio como insignia ni adjunta el PDF en Coreinbox: lo anota como actividad con
  el enlace. Cuando Coreinbox tenga webhooks salientes y campos de factura, el conector cambiará
  la consulta periódica por recepción, sin tocar lo demás.
- Factura sólo en pesos. Una cotización en otra moneda queda con error y aviso en el negocio.
- Un workspace de Coreinbox ↔ un emisor de Emite DTE. Para más, una instancia por par.
- El catálogo lee los tres sistemas, pero todavía no escribe en ninguno. La única escritura es el camino
  de Coreinbox → Emite DTE de antes, sólo con `PRODUCTOS_ESCRIBIR=true`. No fusiona históricos y no
  desactiva ni borra nada en Emite DTE.
- No lee las variaciones de los productos variables: sólo el SKU del padre.
- No detecta los productos borrados en Coreinbox ni en la web: se quedan con su última lectura.
- No descarga documentos: sólo indexa la URL y el hash SHA-256. De las imágenes, sólo la foto
  principal de cada SKU, como miniatura del panel.
- El flujo de pedidos no está implementado.

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
