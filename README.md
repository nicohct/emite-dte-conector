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

| Flujo                             | Sentido                                   | Variable                                                        | Estado                                                                                  |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A · Cotizaciones aceptadas        | Coreinbox → Emite DTE → Coreinbox         | `FLUJO_COTIZACIONES` (encendido por omisión)                    | En producción                                                                           |
| B · Pedidos web                   | WooCommerce → Emite DTE → WooCommerce     | `FLUJO_PEDIDOS` (sin implementar: encendido sólo deja un aviso) | Planificado, enero de 2027                                                              |
| C · Productos transversales       | entre los tres, registro canónico por SKU | `FLUJO_PRODUCTOS` (apagado por omisión)                         | Fase 1a: lectura y registro canónico. Fase 1b: escritura con eco, conflictos y fusiones |
| D · Solicitudes de cotización web | WooCommerce → Coreinbox                   | —                                                               | Por evaluar frente al lector de correo de Coreinbox                                     |
| E · Panel                         | —                                         | —                                                               | Flujos, eventos, productos y decisiones del catálogo                                    |

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
   [Catálogo de productos](#catálogo-de-productos)). Con `PRODUCTOS_ESCRIBIR=true` además escribe
   el canónico en los tres (o en los de `PRODUCTOS_ESCRIBIR_SISTEMAS`).

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

Encendido, lee los tres sistemas (Coreinbox, la web WooCommerce y Emite DTE) y arma un **registro
canónico por SKU** en el SQLite del conector (fase 1a). No escribe en ningún sistema mientras
`PRODUCTOS_ESCRIBIR=false` (por omisión). Con `PRODUCTOS_ESCRIBIR=true`, después de leer lleva el
canónico a los sistemas, con eco, conflictos y fusiones de históricos (fase 1b, ver
[Escritura](#escritura-productos_escribirtrue)).

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
vio; la marca «lo escribí yo» (`escritoValor`, para reconocer el eco) y la hora del último cambio
que no fue eco (`cambioEn`); el canónico con su fuente y su modo; el tipo, el alcance, la visibilidad
web y su motivo, las diferencias, «falta en…», lo que la escritura haría (`escrituras`, `crearEn`),
los conflictos, los empates y el índice.

- **Quién manda.** Cada campo tiene un modo. **Propietario**: un sistema manda y lo que cambie otro se
  revierte en la pasada siguiente. **Último cambio**: gana el último cambio que no sea eco y se
  escribe en los otros. Por omisión, `activo`, `tipo` y `categoria` son de Coreinbox (si Coreinbox no
  tiene el producto, de la web); `exento` es de Emite DTE (sin Emite DTE, de Coreinbox); `nombre` y
  `precio` van por último cambio. Antes de la primera escritura rige la **regla de arranque**: en
  nombre y precio manda la web y, sin web, Coreinbox. Desde el panel se fija otro propietario o
  «último cambio» (sólo en nombre, precio y activo), para todo el catálogo o en lote por SKU.
- **Visibilidad web.** `no_aplica` (los servicios nunca van a la web); si no, una decisión
  (`aprobado` o `rechazado`) manda. Lo publicado hoy en la web arranca aprobado: cuando la lectura ve
  un producto con `status: publish` y sin decisión, registra una decisión `aprobado` con usuario
  `web` (se exporta con las demás). Sin decisión: un producto de una **categoría fuera de la web**
  (lista de categorías de Coreinbox que se fija en el panel; pensada para los repuestos) queda
  `rechazado` con motivo `categoria`; el resto, incluido un borrador en la tienda, es `propuesto`.
  Una categoría fuera de la web nunca toca lo que tiene decisión, así que no despublica lo publicado.
- **Alcance.** Servicio → Coreinbox y Emite DTE. Bien aprobado → los tres. El resto → Coreinbox y
  Emite DTE.
- **Conflicto.** Un campo en «último cambio» cambiado en dos sistemas desde la pasada anterior, a
  valores distintos (en un campo con propietario gana el propietario). Queda abierto, con los valores
  y la hora de cada lado, hasta que alguien elija; mientras tanto ese campo no se escribe. Antes de la
  primera escritura no se abren conflictos.
- **Empates.** Para cada histórico se propone el mejor SKU, según el criterio que lo encontró: código
  exacto (1); alias que resuelve `por-codigo` (0,95); código sin signos ni mayúsculas (0,9); nombre
  normalizado igual (0,85); nombre parecido (0,8 × similitud, desde 0,6). Cada propuesta sale junto con
  el `uso` del histórico (documentos y última venta). Un empate rechazado no se vuelve a proponer.
  Confirmar es una decisión; la escritura lo lleva a Emite DTE (adoptar o fusionar).
- **Índice de información.** Por SKU y sistema, enlaces con URL y hash SHA-256 de lo leído. Imágenes y
  documentos no se descargan:
  - Coreinbox: producto e imagen, y categoría.
  - Web: página, atributos, metadatos (los que no empiezan con `_`, p. ej. los campos del generador de
    fichas), imágenes, categorías y documentos (URLs a PDF o planos en los metadatos o la descripción).
  - Emite DTE: producto.
- **Sin SKU.** Los productos sin SKU de Coreinbox o de la web se listan aparte y no entran al registro.
- **Reconstruibilidad.** Lo derivado (lecturas, canónico, históricos, empates propuestos, índice, sin
  SKU y cursores) se reconstruye igual leyendo los tres sistemas si se borra el SQLite; hay una prueba
  que lo verifica. Lo operativo de la escritura (marcas de eco, hora de la primera escritura, bitácora
  de escrituras) se pierde sin daño: a lo más, la pasada siguiente reescribe un valor igual. La única
  excepción son las **decisiones** del panel (quién manda, empates confirmados o rechazados,
  visibilidad, categorías fuera de la web, conflictos resueltos): viven en tablas aparte y se
  respaldan con `GET /catalogo/decisiones` (ver [Respaldo de las decisiones](#respaldo-de-las-decisiones)).

### Lectura consolidada y acciones (JSON)

Protegidas con `Authorization: Bearer <CATALOGO_API_KEY>`. Sin esa variable, las rutas no existen (404).
Están pensadas para la red interna y el panel.

- `GET /catalogo?pagina=1&limite=50` (máximo 200), con los filtros `q`, `diferencias=true`,
  `conflicto=true`, `sin_sku=true` (le falta algún sistema de su alcance), `propuesto_web=true` y
  `historicos=true` (tiene empates propuestos) y `pendientes=true` (tiene un alta o una edición del
  panel sin escribir). Con `vista=historicos` (y `estado=propuesto|confirmado|rechazado|sin_candidato`)
  lista los históricos con sus empates; con `vista=sin_sku` (y `sistema=`) lista los productos sin SKU.
  Responde `{ vista, pagina, limite, total, items }`.
- `GET /catalogo/{sku}`: canónico (valor, fuente y modo), `precioNeto`, tipo, alcance, visibilidad y
  `motivoVisibilidad`, diferencias, `faltaEn`, `escrituras` y `crearEn` (lo que la próxima escritura
  haría), `sistemas` (id, valores, hora de cambio y de lectura de cada uno), reglas, conflictos,
  empates con su histórico, `indice`, `pendientes` (`{ alta, ediciones }`: lo del panel que la
  pasada todavía no deja en los sistemas) y `eventos` (las últimas escrituras del SKU).
- `POST /catalogo/acciones/reglas` con `{ campo, fuente, skus? }`. La fuente es `coreinbox`,
  `woocommerce` o `emite` (propietario), `ultimo` (último cambio; sólo `nombre`, `precio` y
  `activo`), o `null` para volver al modo por omisión. Sin `skus`, aplica a todo el catálogo.
- `POST /catalogo/acciones/empates` con `{ decisiones: [{ emiteId, sku, estado: "confirmado"|"rechazado" }] }`.
- `POST /catalogo/acciones/conflictos` con `{ resoluciones: [{ id, fuente }] }`: el valor de esa fuente
  pasa a ser el canónico y la escritura siguiente lo lleva a los otros. En «último cambio» el campo
  sigue en ese modo; en uno con propietario, queda como regla del SKU.
- `POST /catalogo/acciones/visibilidad` con `{ skus: [...], estado: "aprobado"|"rechazado" }`. Un
  servicio no se aprueba.
- `POST /catalogo/acciones/categorias` con `{ categorias: ["…"], fuera: true|false }`: saca de la web
  (o devuelve) categorías de Coreinbox, por nombre.
- `POST /catalogo/acciones/alta` con `{ sku, nombre, precio, tipo, categoria?, exento?, activo?, visibilidad? }`:
  un producto nuevo (precio bruto entero, `tipo` `bien` o `servicio`, `visibilidad: "aprobado"`
  para que vaya a la web). Ver [Alta y edición](#alta-y-edición-desde-el-panel).
- `POST /catalogo/acciones/edicion` con `{ sku, campos: { nombre?, precio?, activo?, tipo?, categoria?, exento? } }`.
  El SKU no se edita.
- `GET /catalogo/decisiones` y `POST /catalogo/decisiones`: exportar e importar las decisiones (ver
  [Respaldo de las decisiones](#respaldo-de-las-decisiones)).

Las acciones responden `{ aplicadas, errores: [{ indice, error }] }` (un alta o una edición inválida
responde 400 con `{ error }`), las de decisiones procesan en lote (hasta 500) y
registran la cabecera `X-Emite-Usuario`. Sólo cambian el registro: lo que implican en los sistemas lo
lleva la pasada de escritura siguiente. El panel usa las mismas acciones desde sus formularios (ver
«Panel»).

### Escritura (`PRODUCTOS_ESCRIBIR=true`)

Con `PRODUCTOS_ESCRIBIR=true`, después de cada pasada de lectura corre la escritura (fase 1b). Reemplaza a
la escritura de antes (un solo sentido, Coreinbox → Emite DTE). Si la lectura falla, no se escribe.

- **Qué se escribe.** Por SKU y campo, el canónico (según el modo de [Quién manda](#modelo)) en cada
  sistema donde difiere, comparado en bruto el precio y sin espacios de más el nombre. Coreinbox
  recibe nombre, precio neto (con su propia tasa), activo, tipo y categoría; la web, nombre, precio
  bruto y estado (`publish` o `draft`); Emite DTE, nombre, precio neto (con su exención), activo,
  tipo, categoría y exención (manda en ella; al cambiarla recibe también el neto que conserva el
  bruto). Un campo en conflicto no se escribe en ningún lado.
- **Propietario.** Lo que cambie en otro sistema se revierte en la pasada siguiente y queda como evento
  `revertido`. Por ejemplo, despublicar en la web un producto activo en Coreinbox lo vuelve a publicar.
- **Último cambio.** El último cambio que no sea eco se vuelve canónico y se escribe en los otros dos
  (evento `escrito`). Si dos sistemas cambiaron el mismo campo entre pasadas, conflicto.
- **Eco.** Cada escritura anota en el registro qué se escribió en ese sistema. La lectura siguiente que
  trae ese valor lo reconoce como eco: no es un cambio y no se reescribe. Mientras un valor escrito no
  se vuelve a leer, tampoco se manda de nuevo.
- **Crear.** Lo que falte en Emite DTE y tenga fuente (Coreinbox o la web) se crea con el SKU como
  código. No se crea si un histórico de Emite DTE ya usa ese código sin empate confirmado (queda un
  aviso). En la web se crea sólo lo aprobado que falte: publicado si está activo, si no en borrador.
  **En Coreinbox sólo se crea lo que nació en el panel** (un alta): con su tipo, neto, exención y la
  categoría resuelta a su id (si Coreinbox no tiene una categoría con ese nombre, se crea sin
  categoría y el evento `creado` lo avisa). Lo que existe sólo en la web sigue sin crearse en
  Coreinbox. Lo creado queda como lectura de ese sistema, con el eco marcado.
- **Lo pendiente del panel.** Un alta manda en todos sus campos hasta que el SKU existe en todo su
  alcance; ahí se borra y el producto se calcula como cualquier otro. Una edición en «último cambio»
  se escribe en todos los sistemas; con propietario, sólo en el propietario, y la pasada siguiente
  la propaga desde ahí. Nunca cuenta como reversión.
- **Visibilidad.** Sólo lo `aprobado` se publica. Lo `rechazado` o `no_aplica` que ya está en la web
  pasa a borrador. Nunca se borra nada de la web.
- **Históricos.** Un empate confirmado cuyo histórico tiene **exactamente** el SKU como código se
  **adopta**: recibe el nombre y el precio canónicos y pasa a ser el producto de Emite DTE de ese SKU
  (evento `adoptado`; sigue con `origen=historial`, el núcleo todavía no deja cambiarlo). Con otro
  código, se crea el canónico si falta y el histórico se **fusiona** en él (`POST /productos/fusionar`,
  evento `fusionado`). Si hay varios con el código exacto, se adopta el de más uso y los demás se
  fusionan en él. Si Emite DTE rechaza la fusión (por ejemplo, `PRODUCTO_CON_INVENTARIO`), el SKU queda
  con el aviso «requiere mano» y no se reintenta mientras no se vuelva a decidir el empate. Un empate
  rechazado no toca nada.
- **Fallas.** Una falla de red, un 429 o un 5xx deja el SKU pendiente para la pasada siguiente y no se
  le escribe más a ese sistema en esa pasada. Un 4xx queda como evento `error` con el mensaje, no
  frena a los demás y no se reintenta con los mismos datos (sí cuando cambian).
- **Nunca** se borra nada en ningún sistema ni se cambia un código.

**Primera escritura.** La primera pasada con `PRODUCTOS_ESCRIBIR=true` aplica la regla de arranque a
todo lo que difiera (en nombre y precio, lo de la web) y desde ahí rige «último cambio»; los cambios
vistos mientras sólo se leía no cuentan. Antes de encenderla, el panel y `GET /catalogo/{sku}` ya
muestran qué se escribirá: las diferencias, `escrituras` y `crearEn`.

**Por sistema.** `PRODUCTOS_ESCRIBIR_SISTEMAS` (lista separada por comas; por omisión
`coreinbox,woocommerce,emite`) limita dónde se escribe; en los demás sólo se lee. Lo que no se escribe
queda planeado para cuando se encienda ese sistema. Sin `WOO_URL` la web no se lee ni se escribe.

**Eventos.** Cada escritura queda como evento `escritura` en `/panel/eventos` y en el detalle del SKU:
`escrito`, `revertido`, `creado`, `adoptado`, `fusionado` o `error`, con el sistema y el campo. El
resultado de cada pasada (`escritos`, `revertidos`, `creados`, `adoptados`, `fusionados`,
`conError`, `pendientes`) queda en `ultimaPasada` de `GET /salud`. Los contadores `sincronizados`,
`omitidos` y `conError` de `flujos.productos` son de la escritura de antes y ya no cambian.

**Alcances.** En Coreinbox, `products:read` para leer y `products:write` para escribir. En Emite DTE,
`catalogo:leer` y `catalogo:escribir`. En la web, una clave REST con permiso de lectura/escritura.

#### Encenderla en certificación

1. Con `FLUJO_PRODUCTOS=true` y `PRODUCTOS_ESCRIBIR=false`, dejar correr la lectura y revisar en el
   panel: diferencias, «Lo que se escribirá» en el detalle, visibilidad web (lo publicado queda
   aprobado por `web`; un borrador en la tienda queda `propuesto` y no se publica hasta aprobarlo
   por SKU; lo publicado sólo pasa a borrador con un `rechazado` por SKU), categorías fuera de la
   web, empates de históricos y «Quién manda».
2. Respaldar las decisiones: `GET /catalogo/decisiones` (ver abajo).
3. Encender por partes: `PRODUCTOS_ESCRIBIR=true` con `PRODUCTOS_ESCRIBIR_SISTEMAS=emite`, mirar los
   eventos de escritura, y después sumar `coreinbox` y `woocommerce`.

#### Respaldo de las decisiones

Las decisiones del panel son lo único del conector que no se reconstruye leyendo los tres sistemas.
`GET /catalogo/decisiones` (con el mismo `Authorization: Bearer <CATALOGO_API_KEY>`) devuelve todas en
un JSON (`version`, `reglas`, `empates`, `conflictos` resueltos, `visibilidad`, `categoriasFuera`, y
lo pendiente del panel: `altas` y `pendientes`), y `POST /catalogo/decisiones` con ese mismo JSON las
repone. Reponer es idempotente: lo que ya está igual no cambia, lo que no viene no se borra y una
edición pendiente sólo reemplaza a otra del mismo campo si es más nueva. Un respaldo anterior, sin
`altas` ni `pendientes`, se repone igual. Conviene guardarlo junto a `conector.env`:

```bash
curl -fsS -H "Authorization: Bearer $CATALOGO_API_KEY" http://conector:8080/catalogo/decisiones > decisiones-catalogo.json
```

y, en un conector nuevo o con el SQLite borrado:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CATALOGO_API_KEY" -H "content-type: application/json" --data @decisiones-catalogo.json http://conector:8080/catalogo/decisiones
```

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
WooCommerce → Ajustes → Avanzado → API REST, con permiso de lectura/escritura (sólo para leer el catálogo basta el de lectura).

## Requisitos

- Node.js 22.13 o superior (usa `node:sqlite` para su estado; sin más dependencias en producción).
- En **Coreinbox**: una clave de API (Ajustes → Integraciones → Claves de API) con los alcances
  `quotes:read`, `companies:read`, `contacts:read`, `products:read` y `activities:write` (más
  `products:write` con `PRODUCTOS_ESCRIBIR`).
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

| Variable                      | Obligatoria         | Por omisión                                   | Para qué                                                                                                                                                                  |
| ----------------------------- | ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COREINBOX_URL`               | Sí                  | —                                             | URL base de la API de Coreinbox.                                                                                                                                          |
| `COREINBOX_API_KEY`           | Sí                  | —                                             | Clave `cik_…` de Coreinbox, con los alcances de [Requisitos](#requisitos).                                                                                                |
| `COREINBOX_TIPO_ACTIVIDAD`    | No                  | `d0000000-0000-0000-0000-000000000004` (nota) | Tipo de actividad del CRM con que se anotan los eventos.                                                                                                                  |
| `EMITE_URL`                   | Sí                  | —                                             | URL de la API de Emite DTE por la red interna (en el compose, `http://app:3000`).                                                                                         |
| `EMITE_API_KEY`               | Sí                  | —                                             | API key del emisor, `edte_…`, con `cotizaciones:escribir` y `dte:leer` (y catálogo: `catalogo:leer` con `FLUJO_PRODUCTOS`, `catalogo:escribir` con `PRODUCTOS_ESCRIBIR`). |
| `EMITE_EMISOR_ID`             | Sí                  | —                                             | Emisor al que se cargan las cotizaciones y los productos.                                                                                                                 |
| `EMITE_URL_PUBLICA`           | No                  | El valor de `EMITE_URL`                       | URL con la que la gente abre Emite DTE; va en los enlaces de las actividades del CRM.                                                                                     |
| `EMITE_WEBHOOK_SECRET`        | Sí                  | —                                             | Secreto `whsec_…` del webhook registrado en Emite DTE.                                                                                                                    |
| `DESDE`                       | No                  | Fecha y hora de arranque                      | Primer `updatedSince` de cotizaciones cuando no hay cursor guardado (ISO 8601). El catálogo no lo usa.                                                                    |
| `FLUJO_COTIZACIONES`          | No                  | `true`                                        | Enciende el flujo A, cotizaciones aceptadas.                                                                                                                              |
| `FLUJO_PRODUCTOS`             | No                  | `false`                                       | Enciende el flujo C, catálogo de productos: lectura de los tres sistemas y registro canónico.                                                                             |
| `SINCRONIZAR_PRODUCTOS`       | No (obsoleta)       | —                                             | Alias de `FLUJO_PRODUCTOS`, con aviso en el log. Si están las dos, manda `FLUJO_PRODUCTOS`.                                                                               |
| `PRODUCTOS_ESCRIBIR`          | No                  | `false`                                       | Con `FLUJO_PRODUCTOS`, además de leer, escribe el canónico (ver [Escritura](#escritura-productos_escribirtrue)).                                                          |
| `PRODUCTOS_ESCRIBIR_SISTEMAS` | No                  | `coreinbox,woocommerce,emite`                 | Dónde escribe la escritura, separados por comas; en los demás sólo lee.                                                                                                   |
| `CATALOGO_API_KEY`            | No                  | —                                             | Clave de `GET /catalogo` y sus acciones (`Authorization: Bearer`). Sin ella esas rutas no existen.                                                                        |
| `FLUJO_PEDIDOS`               | No                  | `false`                                       | Flujo B, pedidos web. Sin implementar: encendido sólo deja un aviso en el log.                                                                                            |
| `WOO_URL`                     | No, las tres juntas | —                                             | URL de la tienda WooCommerce. Debe ser `https://`.                                                                                                                        |
| `WOO_CONSUMER_KEY`            | No, las tres juntas | —                                             | Clave de consumidor de la API REST, `ck_…`.                                                                                                                               |
| `WOO_CONSUMER_SECRET`         | No, las tres juntas | —                                             | Secreto de consumidor de la API REST, `cs_…`.                                                                                                                             |
| `INTERVALO_S`                 | No                  | `60`                                          | Segundos entre pasadas. Mínimo 10.                                                                                                                                        |
| `PUERTO`                      | No                  | `8080`                                        | Puerto del receptor de webhooks y de `GET /salud`.                                                                                                                        |
| `ESTADO_RUTA`                 | No                  | `./datos/estado.sqlite`                       | Dónde se guarda el estado (SQLite).                                                                                                                                       |

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
  empates propuestos o decididos, acciones del panel y escrituras en los sistemas (con sistema y
  campo), con enlace al SKU cuando lo hay. Filtros por
  consulta `?flujo=cotizaciones|productos&estado=…` (los estados de cada tipo, o el nombre de la
  acción) y `?pagina=2` (50 por página). Los enlaces a la cotización en Emite DTE usan
  `EMITE_URL_PUBLICA`.
- **Productos** (`/panel/productos`): tabla por SKU con la foto, el valor canónico y el de cada
  sistema en nombre, precio bruto y activo (los que difieren, marcados), tipo, alcance, visibilidad
  web y avisos (con la marca «pendiente» si tiene algo del panel sin escribir). Filtros `q`,
  `diferencias=1`, `conflicto=1`, `sin_sku=1`, `propuesto_web=1`, `pendientes=1` e
  `historicos=1`, y paginación. Desde la misma pantalla, las vistas **Históricos** y **Sin SKU**
  (`?vista=sin_sku&sistema=…`).
- **Detalle** (`/panel/productos/{sku}`): valores por sistema con la hora en que se vio cada uno,
  reglas que le aplican, conflictos, empates con su histórico, lo que se escribirá, las últimas
  escrituras, índice de enlaces (cada URL abre el sistema en otra pestaña) y la foto principal.
- **Históricos** (`/panel/historicos`): los productos históricos de Emite DTE con su uso y su
  empate (puntaje, motivo); confirmar o rechazar uno a uno o en lote. Filtro
  `?estado=propuesto|confirmado|rechazado|sin_candidato`.
- **Conflictos** (`/panel/conflictos`): los abiertos de todo el catálogo; «quedarse con el de la
  web / Coreinbox / Emite DTE», uno a uno o en lote.
- **Visibilidad web** (`/panel/visibilidad`): los propuestos para la web; aprobar o rechazar, uno
  a uno o en lote. Un servicio no se ofrece. También las categorías de Coreinbox fuera de la web
  (sacar o devolver) y los SKU rechazados por su categoría, para aprobarlos uno a uno.
- **Quién manda** (`/panel/reglas`): qué sistema manda en cada campo, o «último cambio», para todo
  el catálogo. En lote por SKU, eligiéndolos en la lista de productos; para uno, desde su detalle.

### Acciones

Las decisiones son formularios HTML que mandan `POST /panel/acciones/{reglas|empates|conflictos|visibilidad|categorias|alta|edicion}`
y usan la misma lógica que la API JSON (`src/flujos/productos/acciones.ts`). No piden
`CATALOGO_API_KEY`: el panel está detrás de Emite DTE, y la cabecera `X-Emite-Usuario` queda como
usuario de la decisión. Tras aplicar, redirigen (303) a la pantalla de origen con el resultado
(aplicadas y errores). Cada acción queda en la bitácora y aparece como evento `accion`.

Las decisiones cambian el registro del conector; con `PRODUCTOS_ESCRIBIR=true`, la pasada siguiente
las lleva a Coreinbox, la web y Emite DTE.

### Alta y edición desde el panel

- **Alta** (`/panel/productos/nuevo`, o «Nuevo producto» en la lista): SKU (1 a 35 caracteres, sin
  espacios en los extremos), nombre (hasta 80), precio bruto entero, tipo, categoría (de las de
  Coreinbox que el registro ya leyó; si todavía no leyó ninguna, se escribe a mano), exento, activo
  y «Aprobar para la web». Se rechaza el SKU `nuevo` (reservado por la pantalla
  `productos/nuevo`), un SKU que ya existe, que ya tiene un alta pendiente o que es
  el código exacto de un histórico de Emite DTE (ahí se confirma el empate desde **Históricos**), y
  un nombre que ya existe sin SKU en algún sistema (hay que ponerle el SKU allá). Un servicio no se
  aprueba para la web. Aprobarlo deja la decisión por SKU, aunque su categoría esté fuera de la web.
  Se crea en Coreinbox y Emite DTE siempre, y en la web sólo si quedó aprobado. Coreinbox no acepta
  `isActive` al crear: un alta inactiva se crea y se desactiva enseguida con un `PATCH`.
- **Edición** (en el detalle del SKU): nombre, precio, activo, tipo, categoría y exento, partiendo del
  valor canónico. En «último cambio» (nombre y precio) se escribe en los tres; en un campo con
  propietario (activo, tipo y categoría van a Coreinbox; exento, a Emite DTE) se escribe en el
  propietario y la pasada siguiente lo propaga. Si quien manda es un sistema donde el conector no
  escribe ese campo (por ejemplo, el tipo de un producto que sólo está en la web), se rechaza y hay
  que cambiarlo allá. Una edición
  sobre un campo en conflicto lo resuelve con ese valor. **El SKU no se edita**: un cambio de código
  se hace a mano en los tres sistemas.
- **Pendiente.** Lo que nace o se edita en el panel queda **pendiente** en el hub (sección «Pendiente
  de escribir» del detalle, filtro «pendientes del panel» y marca en la lista) hasta que la pasada lo
  deja en los sistemas: un alta, cuando el SKU existe en todo su alcance (la web cuenta sólo si
  está configurada y en `PRODUCTOS_ESCRIBIR_SISTEMAS`; si no, al encenderla el producto es un
  aprobado que falta allá y se crea por el camino de siempre); una edición, cuando la lectura trae
  ese valor en todos sus destinos. Desde ahí el producto vuelve a ser derivado de los tres. Un
  cambio hecho en un sistema después de la edición la deja atrás y queda como evento `accion`
  `descartada` (SKU, campo y quién la hizo). Con
  `PRODUCTOS_ESCRIBIR=false` las pendientes se acumulan sin que nada salga del conector. Se
  respaldan con las decisiones, por si el hub se pierde entre el alta y la pasada.
- Los **archivos** (foto principal, fichas, manuales) quedan para el PR 7b.

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
- El catálogo sólo crea en Coreinbox lo que nace en el panel. No sube archivos (PR 7b), no borra en
  ningún sistema ni cambia códigos.
- Un histórico adoptado sigue con `origen=historial` en Emite DTE: la API todavía no deja cambiarlo.
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
