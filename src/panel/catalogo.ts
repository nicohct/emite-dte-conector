/**
 * Las pantallas del catálogo: la lista por SKU (con sus vistas «sin SKU»), el detalle de un SKU y
 * las piezas que comparten con las de decisiones (valores, formularios, foto).
 */
import type {
  CampoCatalogo,
  CampoCompartido,
  FiltroCatalogo,
  FuenteRegla,
  ProductoCatalogo,
  RegistroCatalogo,
  SistemaCatalogo,
  ValorCampo,
} from '../estado-catalogo.js';
import { CAMPOS_CATALOGO, CAMPOS_COMPARTIDOS, SISTEMAS_CATALOGO } from '../estado-catalogo.js';
import type { NombreAccion } from '../flujos/productos/acciones.js';
import { detalleDe } from '../flujos/productos/api.js';
import { CAMPOS_ULTIMO_CAMBIO } from '../flujos/productos/canonico.js';
import { cifra, enlaceExterno, fecha, html, paginas, type Html } from './html.js';
import { enlaceSku, etiquetaEstado } from './pantallas.js';

export const NOMBRE_SISTEMA: Record<SistemaCatalogo, string> = {
  coreinbox: 'Coreinbox',
  woocommerce: 'Web',
  emite: 'Emite DTE',
};

export const NOMBRE_FUENTE: Record<FuenteRegla, string> = {
  ...NOMBRE_SISTEMA,
  ultimo: 'último cambio',
};

const NOMBRE_CAMPO: Record<CampoCatalogo, string> = {
  nombre: 'Nombre',
  precio: 'Precio bruto',
  activo: 'Activo',
  tipo: 'Tipo',
  categoria: 'Categoría',
  exento: 'Exento',
};

export const nada = html`<span class="tenue">—</span>`;

export function valor(campo: CampoCatalogo, v: ValorCampo | undefined): Html | string {
  if (v === null || v === undefined || v === '') return nada;
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (campo === 'precio' && typeof v === 'number') return html`$ ${cifra(v)}`;
  return String(v);
}

/** Un formulario de acción del panel; `volver` es la pantalla a la que redirige al terminar. */
export function formulario(
  base: string,
  accion: NombreAccion,
  volver: string,
  contenido: Html,
): Html {
  return html`<form method="post" action="${base}acciones/${accion}">
    <input type="hidden" name="volver" value="${volver}" />
    ${contenido}
  </form>`;
}

/** Botón que manda una sola decisión (`uno`) codificada en JSON. */
export const boton = (texto: string, uno: unknown[]) =>
  html`<button type="submit" name="uno" value="${JSON.stringify(uno)}">${texto}</button>`;

/** La miniatura, o un hueco si el SKU no tiene foto en el índice. */
export function foto(
  base: string,
  sku: string,
  tieneFoto: boolean,
  tamano: 'chica' | 'grande',
): Html {
  const px = tamano === 'chica' ? 48 : 240;
  return tieneFoto
    ? html`<img
        class="foto ${tamano}"
        src="${base}imagen/${encodeURIComponent(sku)}"
        width="${px}"
        height="${px}"
        alt=""
        loading="lazy"
      />`
    : html`<span class="foto ${tamano}" aria-hidden="true"></span>`;
}

/**
 * Las fuentes de una regla. «Último cambio» sólo vale para algunos campos: `campo` lo restringe
 * (el de una fila fija) y sin `campo` se ofrece siempre (el servidor rechaza el resto).
 */
export const selectFuente = (
  nombre: string,
  actual: FuenteRegla | null,
  arranque: string,
  campo?: CampoCatalogo,
) => {
  const fuentes: FuenteRegla[] =
    campo === undefined || CAMPOS_ULTIMO_CAMBIO.includes(campo)
      ? [...SISTEMAS_CATALOGO, 'ultimo']
      : [...SISTEMAS_CATALOGO];
  return html`<select name="${nombre}">
    <option value="">${arranque}</option>
    ${fuentes.map(
      (s) =>
        html`<option value="${s}" ${s === actual ? html` selected` : ''}>
          ${NOMBRE_FUENTE[s]}
        </option>`,
    )}
  </select>`;
};

export const selectCampo = (nombre: string) =>
  html`<select name="${nombre}">
    ${CAMPOS_CATALOGO.map((c) => html`<option value="${c}">${NOMBRE_CAMPO[c]}</option>`)}
  </select>`;

const MOTIVO_VISIBILIDAD: Record<NonNullable<ProductoCatalogo['motivoVisibilidad']>, string> = {
  servicio: 'es un servicio',
  decision: 'decisión del panel',
  categoria: 'categoría fuera de la web',
  en_web: 'ya está en la web',
  sin_decision: 'sin decisión',
};

export const motivoVisibilidad = (m: ProductoCatalogo['motivoVisibilidad']): Html | string =>
  m ? html`<span class="tenue">${MOTIVO_VISIBILIDAD[m]}</span>` : '';

const VISIBILIDAD: Record<ProductoCatalogo['visibilidadWeb'], string> = {
  no_aplica: 'no aplica',
  propuesto: 'propuesto',
  aprobado: 'aprobado',
  rechazado: 'rechazado',
};

export const etiquetaVisibilidad = (v: ProductoCatalogo['visibilidadWeb']) =>
  v === 'no_aplica' ? html`<span class="tenue">no aplica</span>` : etiquetaEstado(VISIBILIDAD[v]);

const alcance = (p: ProductoCatalogo) =>
  p.alcance.length
    ? p.alcance.map(
        (s) =>
          html`<span
              class="${p.faltaEn.includes(s) ? 'aviso' : ''}"
              title="${p.faltaEn.includes(s) ? 'le falta este sistema' : ''}"
              >${NOMBRE_SISTEMA[s]}${p.faltaEn.includes(s) ? ' (falta)' : ''}</span
            ><br />`,
      )
    : nada;

/** El canónico y, debajo, el valor de cada sistema donde está el SKU (los distintos, marcados). */
function celdaCampo(
  p: ProductoCatalogo,
  campo: CampoCompartido,
  valores: Partial<Record<SistemaCatalogo, ValorCampo>>,
): Html {
  const c = p.canonico[campo];
  const distinto = p.diferencias.some((d) => d.campo === campo);
  return html`<div class="canonico">${valor(campo, c?.valor)}</div>
    <dl class="valores">
      ${p.presentes.map(
        (s) =>
          html`<dt>${NOMBRE_SISTEMA[s]}</dt>
            <dd
              class="${distinto && JSON.stringify(valores[s]) !== JSON.stringify(c?.valor) ? 'distinto' : ''}"
            >
              ${valor(campo, valores[s])}
            </dd>`,
      )}
    </dl>`;
}

// --- Lista ---

export interface FiltroPanelCatalogo {
  filtro: FiltroCatalogo;
  vista: 'productos' | 'sin_sku';
  sistema: SistemaCatalogo | null;
  pagina: number;
  porPagina: number;
}

const BANDERAS: Array<[keyof Omit<FiltroCatalogo, 'q'>, string, string]> = [
  ['diferencias', 'diferencias', 'con diferencias'],
  ['conflicto', 'conflicto', 'en conflicto'],
  ['sinSku', 'sin_sku', 'sin SKU en algún sistema de su alcance'],
  ['propuestoWeb', 'propuesto_web', 'propuesto para la web'],
  ['historicos', 'historicos', 'con históricos propuestos'],
];

/** Valores desconocidos se ignoran (filtro vacío, página 1). */
export function filtroCatalogoDe(q: URLSearchParams, porPagina: number): FiltroPanelCatalogo {
  const si = (v: string | null) => v !== null && ['1', 'true', 'si', 'sí'].includes(v);
  const filtro: FiltroCatalogo = {};
  for (const [clave, param] of BANDERAS) if (si(q.get(param))) filtro[clave] = true;
  const texto = q.get('q')?.trim();
  if (texto) filtro.q = texto.slice(0, 200);
  const sistema = q.get('sistema');
  const n = Number(q.get('pagina'));
  return {
    filtro,
    vista: q.get('vista') === 'sin_sku' ? 'sin_sku' : 'productos',
    sistema: (SISTEMAS_CATALOGO as readonly string[]).includes(sistema ?? '')
      ? (sistema as SistemaCatalogo)
      : null,
    pagina: Number.isInteger(n) && n > 0 ? n : 1,
    porPagina,
  };
}

/** La consulta (`?…`) que reproduce el filtro en una página dada. */
export function consultaCatalogo(f: FiltroPanelCatalogo, pagina: number): string {
  const q = new URLSearchParams();
  if (f.vista === 'sin_sku') {
    q.set('vista', 'sin_sku');
    if (f.sistema) q.set('sistema', f.sistema);
  } else {
    if (f.filtro.q) q.set('q', f.filtro.q);
    for (const [clave, param] of BANDERAS) if (f.filtro[clave]) q.set(param, '1');
  }
  if (pagina > 1) q.set('pagina', String(pagina));
  const s = q.toString();
  return s ? `?${s}` : '?';
}

function pestanas(base: string, actual: 'productos' | 'sin_sku' | 'historicos'): Html {
  const p = (clave: typeof actual, ruta: string, texto: string) =>
    html`<a href="${base}${ruta}" ${clave === actual ? html` aria-current="page"` : ''}
      >${texto}</a
    >`;
  return html`<nav class="pestanas" aria-label="Vistas del catálogo">
    ${p('productos', 'productos', 'Por SKU')}
    ${p('historicos', 'historicos', 'Históricos de Emite DTE')}
    ${p('sin_sku', 'productos?vista=sin_sku', 'Sin SKU')}
  </nav>`;
}

export function pantallaProductos(
  registro: RegistroCatalogo,
  f: FiltroPanelCatalogo,
  base: string,
): Html {
  if (f.vista === 'sin_sku') return pantallaSinSku(registro, f, base);
  const { items, total } = registro.listar(f.filtro, f.pagina, f.porPagina);
  const filtrado = Object.keys(f.filtro).length > 0;
  const volver = `productos${consultaCatalogo(f, f.pagina)}`;
  const filas = items.map((p) => {
    const lecturas = registro.lecturas(p.sku);
    const valores = (campo: CampoCompartido) =>
      Object.fromEntries(
        p.presentes.map((s) => [s, lecturas[s]?.campos[campo]?.valor ?? null]),
      ) as Partial<Record<SistemaCatalogo, ValorCampo>>;
    return html`<tr>
      <td><input type="checkbox" name="sku" value="${p.sku}" aria-label="Elegir ${p.sku}" /></td>
      <td>${foto(base, p.sku, registro.fotos(p.sku).length > 0, 'chica')}</td>
      <td class="nowrap">${enlaceSku(p.sku, base)}</td>
      ${CAMPOS_COMPARTIDOS.map((c) => html`<td>${celdaCampo(p, c, valores(c))}</td>`)}
      <td>${p.tipo ?? nada}</td>
      <td>${alcance(p)}</td>
      <td>${etiquetaVisibilidad(p.visibilidadWeb)}</td>
      <td>
        ${
          p.avisos.length
            ? html`<ul class="valores" style="display:block;margin:0;padding-left:14px">
                ${p.avisos.map((a) => html`<li class="aviso">${a}</li>`)}
              </ul>`
            : nada
        }
      </td>
    </tr>`;
  });
  return html`<h1>Productos</h1>
    ${pestanas(base, 'productos')}
    <form class="filtros" method="get">
      <label
        >Buscar
        <input type="search" name="q" value="${f.filtro.q ?? ''}" placeholder="SKU o nombre"
      /></label>
      ${BANDERAS.map(
        ([clave, param, texto]) =>
          html`<label class="casilla"
            ><input
              type="checkbox"
              name="${param}"
              value="1"
              ${f.filtro[clave] ? html` checked` : ''}
            />
            ${texto}</label
          >`,
      )}
      <button type="submit">Filtrar</button>
      ${filtrado ? html`<a href="?">Quitar filtros</a>` : ''}
    </form>
    ${
      items.length
        ? formulario(
            base,
            'reglas',
            volver,
            html`<div class="tabla">
                <table>
                  <thead>
                    <tr>
                      <th><span class="tenue">Lote</span></th>
                      <th>Foto</th>
                      <th>SKU</th>
                      ${CAMPOS_COMPARTIDOS.map((c) => html`<th>${NOMBRE_CAMPO[c]}</th>`)}
                      <th>Tipo</th>
                      <th>Alcance</th>
                      <th>Web</th>
                      <th>Avisos</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filas}
                  </tbody>
                </table>
              </div>
              <div class="lote">
                <input type="hidden" name="lote" value="1" />
                <strong>Quién manda en los SKUs elegidos</strong>
                <label>Campo ${selectCampo('campo')}</label>
                <label
                  >Fuente ${selectFuente('fuente', null, 'la regla de todo el catálogo')}</label
                >
                <button type="submit">Aplicar a los elegidos</button>
              </div>`,
          )
        : html`<p class="tenue">No hay productos${filtrado ? ' con estos filtros' : ''}.</p>`
    }
    ${paginas(total, f.pagina, f.porPagina, (n) => consultaCatalogo(f, n))}
    <p class="tenue">
      Cada celda muestra el valor canónico y, debajo, el de cada sistema donde está el SKU; los que
      difieren del canónico van marcados.
    </p>`;
}

function pantallaSinSku(registro: RegistroCatalogo, f: FiltroPanelCatalogo, base: string): Html {
  const todos = registro.sinSku().filter((s) => !f.sistema || s.sistema === f.sistema);
  const trozo = todos.slice((f.pagina - 1) * f.porPagina, f.pagina * f.porPagina);
  const sistemas = html`<form class="filtros" method="get">
    <input type="hidden" name="vista" value="sin_sku" />
    <label
      >Sistema
      <select name="sistema">
        <option value="">todos</option>
        ${SISTEMAS_CATALOGO.map(
          (s) =>
            html`<option value="${s}" ${s === f.sistema ? html` selected` : ''}>
              ${NOMBRE_SISTEMA[s]}
            </option>`,
        )}
      </select></label
    >
    <button type="submit">Filtrar</button>
  </form>`;
  return html`<h1>Productos sin SKU</h1>
    ${pestanas(base, 'sin_sku')} ${sistemas}
    ${
      trozo.length
        ? html`<div class="tabla">
            <table>
              <thead>
                <tr>
                  <th>Sistema</th>
                  <th>Id</th>
                  <th>Nombre</th>
                  <th>Precio bruto</th>
                  <th>Activo</th>
                  <th>Modificado</th>
                </tr>
              </thead>
              <tbody>
                ${trozo.map(
                  (s) =>
                    html`<tr>
                      <td>${NOMBRE_SISTEMA[s.sistema]}</td>
                      <td><span class="id">${s.idExterno}</span></td>
                      <td>${s.nombre}</td>
                      <td>${valor('precio', s.precio)}</td>
                      <td>${valor('activo', s.activo)}</td>
                      <td>${fecha(s.modificadoEn)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="tenue">No hay productos sin SKU.</p>`
    }
    ${paginas(todos.length, f.pagina, f.porPagina, (n) => consultaCatalogo(f, n))}
    <p class="tenue">
      Sin SKU no se pueden cruzar entre sistemas: hay que ponérselo en su origen.
    </p>`;
}

// --- Detalle ---

/** Uso de un histórico tal como lo entrega Emite DTE (documentos, cantidad, clientes…). */
export function uso(u: unknown): Html {
  if (!u || typeof u !== 'object') return nada;
  return html`<dl class="valores">
    ${Object.entries(u as Record<string, unknown>).map(
      ([k, v]) =>
        html`<dt>${k}</dt>
          <dd>
            ${typeof v === 'number' ? cifra(v) : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? fecha(v) : v === null ? nada : String(v)}
          </dd>`,
    )}
  </dl>`;
}

export function pantallaProducto(
  registro: RegistroCatalogo,
  sku: string,
  base: string,
): Html | null {
  const d = detalleDe(registro, sku);
  if (!d) return null;
  const volver = `productos/${encodeURIComponent(sku)}`;
  const servicio = d.tipo === 'servicio';
  const valores = html`<div class="tabla">
    <table>
      <thead>
        <tr>
          <th>Campo</th>
          <th>Canónico</th>
          ${SISTEMAS_CATALOGO.map((s) => html`<th>${NOMBRE_SISTEMA[s]}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${CAMPOS_CATALOGO.map((campo) => {
          const c = d.canonico[campo];
          return html`<tr>
            <th scope="row">${NOMBRE_CAMPO[campo]}</th>
            <td>
              <span class="canonico">${valor(campo, c?.valor)}</span>
              ${c?.fuente ? html`<br /><span class="tenue">de ${NOMBRE_SISTEMA[c.fuente]}</span>` : ''}
              ${c?.modo ? html`<br /><span class="tenue">${c.modo === 'ultimo' ? 'último cambio' : 'propietario'}</span>` : ''}
              ${c?.conflicto ? html`<br /><span class="etiqueta aviso">en conflicto</span>` : ''}
            </td>
            ${SISTEMAS_CATALOGO.map((s) => {
              const l = d.sistemas[s];
              if (!l) return html`<td>${nada}</td>`;
              return html`<td>
                ${valor(campo, l.valores[campo])}
                ${l.vistoEn[campo] ? html`<br /><span class="tenue">desde ${fecha(l.vistoEn[campo] ?? null)}</span>` : ''}
              </td>`;
            })}
          </tr>`;
        })}
        <tr>
          <th scope="row">Id</th>
          <td>${nada}</td>
          ${SISTEMAS_CATALOGO.map((s) => {
            const l = d.sistemas[s];
            return html`<td>
              ${
                l
                  ? html`<span class="id">${l.id}</span><br /><span class="tenue"
                        >modificado ${fecha(l.modificadoEn)}<br />leído ${fecha(l.leidoEn)}</span
                      >`
                  : html`<span class="tenue">no está</span>`
              }
            </td>`;
          })}
        </tr>
      </tbody>
    </table>
  </div>`;

  const reglas = html`<section class="bloque">
    <h2>Quién manda</h2>
    ${
      d.reglas.length
        ? html`<div class="tabla">
            <table>
              <thead>
                <tr>
                  <th>Ámbito</th>
                  <th>Campo</th>
                  <th>Fuente</th>
                  <th>Quién</th>
                  <th>Cuándo</th>
                </tr>
              </thead>
              <tbody>
                ${d.reglas.map(
                  (r) =>
                    html`<tr>
                      <td>${r.ambito === '*' ? 'todo el catálogo' : 'este SKU'}</td>
                      <td>${NOMBRE_CAMPO[r.campo]}</td>
                      <td>${NOMBRE_FUENTE[r.fuente]}</td>
                      <td>${r.usuario ?? nada}</td>
                      <td>${fecha(r.en)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="tenue">Sin reglas: manda el modo por defecto de cada campo.</p>`
    }
    ${formulario(
      base,
      'reglas',
      volver,
      html`<div class="lote">
        <input type="hidden" name="lote" value="1" />
        <input type="hidden" name="sku" value="${sku}" />
        <strong>Para este SKU</strong>
        <label>Campo ${selectCampo('campo')}</label>
        <label>Fuente ${selectFuente('fuente', null, 'la regla de todo el catálogo')}</label>
        <button type="submit">Fijar</button>
      </div>`,
    )}
  </section>`;

  const escrituras =
    (d.escrituras?.length ?? 0) > 0 || (d.crearEn?.length ?? 0) > 0
      ? html`<section class="bloque">
          <h2>Lo que se escribirá</h2>
          <p class="tenue">
            Lo que la próxima pasada de escritura llevaría a los sistemas, si está encendida.
          </p>
          ${
            d.crearEn?.length
              ? html`<p>Se crearía en: ${d.crearEn.map((s) => NOMBRE_SISTEMA[s]).join(', ')}</p>`
              : ''
          }
          ${
            d.escrituras?.length
              ? html`<div class="tabla">
                  <table>
                    <thead>
                      <tr>
                        <th>Sistema</th>
                        <th>Campo</th>
                        <th>Cambio</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${d.escrituras.map(
                        (e) =>
                          html`<tr>
                            <td>${NOMBRE_SISTEMA[e.sistema]}</td>
                            <td>${NOMBRE_CAMPO[e.campo]}</td>
                            <td>${valor(e.campo, e.antes)} → ${valor(e.campo, e.valor)}</td>
                            <td>
                              ${e.revierte ? html`<span class="aviso">deshace un cambio</span>` : nada}
                            </td>
                          </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>`
              : ''
          }
        </section>`
      : '';

  const escrituraReciente = html`<section class="bloque">
    <h2>Escrituras recientes</h2>
    ${
      d.eventos.length
        ? html`<div class="tabla">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Sistema</th>
                  <th>Campo</th>
                  <th>Estado</th>
                  <th>Cambio</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                ${d.eventos.map(
                  (e) =>
                    html`<tr>
                      <td>${fecha(e.en)}</td>
                      <td>${NOMBRE_SISTEMA[e.sistema]}</td>
                      <td>${e.campo ? NOMBRE_CAMPO[e.campo] : nada}</td>
                      <td>${etiquetaEstado(e.estado)}</td>
                      <td>
                        ${
                          e.campo
                            ? html`${valor(e.campo, e.antes)} → ${valor(e.campo, e.valor)}`
                            : e.idExterno
                              ? html`<span class="id">${e.idExterno}</span>`
                              : nada
                        }
                      </td>
                      <td>${e.mensaje ?? nada}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="tenue">Ninguna.</p>`
    }
  </section>`;

  const conflictos = html`<section class="bloque">
    <h2>Conflictos</h2>
    ${
      d.conflictos.length
        ? formulario(
            base,
            'conflictos',
            volver,
            html`<div class="tabla">
              <table>
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Valores</th>
                    <th>Abierto</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${d.conflictos.map((c) => tablaConflicto(c))}
                </tbody>
              </table>
            </div>`,
          )
        : html`<p class="tenue">Ninguno.</p>`
    }
  </section>`;

  const empates = html`<section class="bloque">
    <h2>Históricos de Emite DTE empatados</h2>
    ${
      d.empates.length
        ? formulario(
            base,
            'empates',
            volver,
            html`<div class="tabla">
              <table>
                <thead>
                  <tr>
                    <th>Histórico</th>
                    <th>Uso</th>
                    <th>Puntaje</th>
                    <th>Motivo</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${d.empates.map(
                    (e) =>
                      html`<tr>
                        <td>
                          ${
                            e.historico
                              ? html`<span class="id">${e.historico.codigo}</span
                                  ><br />${e.historico.nombre}`
                              : html`<span class="id">${e.emiteId}</span>`
                          }
                        </td>
                        <td>${uso(e.historico?.uso)}</td>
                        <td class="cifra">${e.puntaje.toFixed(2)}</td>
                        <td>${e.motivo}<br /><span class="tenue">${e.detalle}</span></td>
                        <td>
                          ${etiquetaEstado(e.estado)}
                          ${e.decididoPor ? html`<br /><span class="tenue">${e.decididoPor}</span>` : ''}
                        </td>
                        <td>
                          ${
                            e.estado === 'propuesto' && !e.historico?.fusionadoEnId
                              ? html`<div class="botones">
                                  ${boton('Confirmar', [e.emiteId, e.sku, 'confirmado'])}
                                  ${boton('Rechazar', [e.emiteId, e.sku, 'rechazado'])}
                                </div>`
                              : ''
                          }
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`,
          )
        : html`<p class="tenue">Ninguno.</p>`
    }
  </section>`;

  const indice = html`<section class="bloque">
    <h2>Índice de información</h2>
    ${
      d.indice.length
        ? html`<div class="tabla">
            <table>
              <thead>
                <tr>
                  <th>Sistema</th>
                  <th>Tipo</th>
                  <th>Enlace</th>
                  <th>Hash</th>
                  <th>Leído</th>
                </tr>
              </thead>
              <tbody>
                ${d.indice.map(
                  (e) =>
                    html`<tr>
                      <td>${NOMBRE_SISTEMA[e.sistema]}</td>
                      <td>${e.tipo}</td>
                      <td style="overflow-wrap:anywhere">${enlaceExterno(e.url, e.url)}</td>
                      <td><span class="id" title="${e.hash}">${e.hash.slice(0, 12)}</span></td>
                      <td>${fecha(e.leidoEn)}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="tenue">Sin entradas.</p>`
    }
  </section>`;

  return html`<p><a href="${base}productos">← Productos</a></p>
    <h1>${sku}</h1>
    <div class="ficha">
      ${foto(base, sku, registro.fotos(sku).length > 0, 'grande')}
      <dl>
        <dt>Tipo</dt>
        <dd>${d.tipo ?? nada}</dd>
        <dt>Alcance</dt>
        <dd>${alcance(d)}</dd>
        <dt>Precio neto</dt>
        <dd>${d.precioNeto === null ? nada : html`$ ${d.precioNeto.toLocaleString('es-CL')}`}</dd>
        <dt>Visibilidad web</dt>
        <dd>
          ${etiquetaVisibilidad(d.visibilidadWeb)} ${motivoVisibilidad(d.motivoVisibilidad)}
          ${
            d.visibilidadDecidida
              ? html`<span class="tenue"
                  >${d.visibilidadDecidida.estado} por
                  ${d.visibilidadDecidida.usuario ?? 'sin usuario'}
                  ${fecha(d.visibilidadDecidida.en)}</span
                >`
              : ''
          }
          ${
            servicio
              ? html`<br /><span class="tenue">Un servicio no se ofrece en la web.</span>`
              : formulario(
                  base,
                  'visibilidad',
                  volver,
                  html`<div class="botones" style="margin-top:4px">
                    ${boton('Aprobar para la web', [sku, 'aprobado'])}
                    ${boton('Rechazar para la web', [sku, 'rechazado'])}
                  </div>`,
                )
          }
        </dd>
        <dt>Avisos</dt>
        <dd>
          ${d.avisos.length ? d.avisos.map((a) => html`<span class="aviso">${a}</span><br />`) : nada}
        </dd>
      </dl>
    </div>
    <section class="bloque">
      <h2>Valores por sistema</h2>
      ${valores}
    </section>
    ${escrituras} ${reglas} ${conflictos} ${empates} ${escrituraReciente} ${indice}`;
}

/** Fila de un conflicto con los botones «quedarse con el de…» si sigue abierto. */
export function tablaConflicto(
  c: ReturnType<RegistroCatalogo['conflictos']>[number],
  base?: string,
): Html {
  const sistemas = SISTEMAS_CATALOGO.filter((s) => c.valores[s]);
  return html`<tr>
    ${
      base === undefined
        ? ''
        : html`<td>
              <input
                type="checkbox"
                name="sel"
                value="${c.id}"
                aria-label="Elegir conflicto ${c.id}"
              />
            </td>
            <td>${enlaceSku(c.sku, base)}</td>`
    }
    <td>${NOMBRE_CAMPO[c.campo]}</td>
    <td>
      <dl class="valores">
        ${sistemas.map(
          (s) =>
            html`<dt>${NOMBRE_SISTEMA[s]}</dt>
              <dd>${valor(c.campo, c.valores[s]?.valor)} ${fecha(c.valores[s]?.en ?? null)}</dd>`,
        )}
      </dl>
    </td>
    <td>${fecha(c.abiertoEn)}</td>
    <td>
      ${etiquetaEstado(c.estado)}
      ${
        c.resueltoCon
          ? html`<br /><span class="tenue"
                >con
                ${NOMBRE_SISTEMA[c.resueltoCon]}${c.resueltoPor ? ` por ${c.resueltoPor}` : ''}</span
              >`
          : ''
      }
    </td>
    <td>
      ${
        c.estado === 'abierto'
          ? html`<div class="botones">
              ${sistemas.map((s) => boton(`Quedarse con el de ${NOMBRE_SISTEMA[s] === 'Web' ? 'la web' : NOMBRE_SISTEMA[s]}`, [c.id, s]))}
            </div>`
          : ''
      }
    </td>
  </tr>`;
}
