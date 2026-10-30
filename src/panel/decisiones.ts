/**
 * Las pantallas de decisiones sobre el catálogo: empates de históricos, conflictos abiertos,
 * visibilidad web (con las categorías fuera de la web) y «quién manda». Cada formulario manda a
 * `POST acciones/{…}`, que cambia el registro del conector; la pasada de escritura lleva las
 * decisiones a los sistemas.
 */
import type {
  Empate,
  EstadoEmpate,
  ProductoCatalogo,
  RegistroCatalogo,
} from '../estado-catalogo.js';
import { CAMPOS_CATALOGO } from '../estado-catalogo.js';
import { CAMPOS_ULTIMO_CAMBIO } from '../flujos/productos/canonico.js';
import {
  boton,
  etiquetaVisibilidad,
  foto,
  formulario,
  motivoVisibilidad,
  nada,
  NOMBRE_FUENTE,
  NOMBRE_SISTEMA,
  selectFuente,
  tablaConflicto,
  uso,
  valor,
} from './catalogo.js';
import { ancla, avisoDe } from './formularios.js';
import { avisoEnFila, fecha, html, paginas, type Aviso, type Html } from './html.js';
import { enlaceSku, etiquetaEstado } from './pantallas.js';

const pagina = (q: URLSearchParams): number => {
  const n = Number(q.get('pagina'));
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const trozo = <T>(todos: T[], n: number, porPagina: number) =>
  todos.slice((n - 1) * porPagina, n * porPagina);

const conPagina = (q: URLSearchParams, n: number): string => {
  const r = new URLSearchParams(q);
  r.delete('pagina');
  if (n > 1) r.set('pagina', String(n));
  const s = r.toString();
  return s ? `?${s}` : '?';
};

// --- Históricos ---

const ESTADOS_HISTORICO = ['propuesto', 'confirmado', 'rechazado', 'sin_candidato'] as const;
type FiltroHistorico = (typeof ESTADOS_HISTORICO)[number];

const ORDEN_EMPATE: Record<EstadoEmpate, number> = { confirmado: 0, propuesto: 1, rechazado: 2 };

/** Confirmados, después las propuestas de mejor a peor y al final los rechazados. */
const porDecision = (a: Empate, b: Empate): number =>
  ORDEN_EMPATE[a.estado] - ORDEN_EMPATE[b.estado] ||
  b.puntaje - a.puntaje ||
  a.sku.localeCompare(b.sku);

const MAX_RESULTADOS_BUSQUEDA = 10;
const MAX_TEXTO_BUSQUEDA = 100;

/** El nombre canónico del SKU y en qué sistemas está, para comparar sin abrir el detalle. */
function resumenSku(p: ProductoCatalogo | null): Html {
  if (!p) return html`<span class="tenue">el SKU ya no está en el registro</span>`;
  const nombre = p.canonico.nombre?.valor;
  const sistemas = p.presentes.map((s) => NOMBRE_SISTEMA[s]).join(', ');
  return html`${typeof nombre === 'string' && nombre !== '' ? nombre : nada}
    <span class="tenue">· ${sistemas || 'en ningún sistema'}</span>`;
}

/**
 * Hasta diez canónicos para `texto` (código o nombre), con el SKU exacto primero si lo hay. Usa la
 * misma búsqueda de la lista de productos.
 */
function buscarCanonicos(
  registro: RegistroCatalogo,
  texto: string,
): Array<{ producto: ProductoCatalogo; exacto: boolean }> {
  const exacto = registro.producto(texto);
  const otros = registro
    .listar({ q: texto }, 1, MAX_RESULTADOS_BUSQUEDA)
    .items.filter((p) => p.sku !== exacto?.sku);
  return [
    ...(exacto ? [{ producto: exacto, exacto: true }] : []),
    ...otros.map((producto) => ({ producto, exacto: false })),
  ].slice(0, MAX_RESULTADOS_BUSQUEDA);
}

function resultadosBusqueda(
  registro: RegistroCatalogo,
  emiteId: string,
  texto: string,
  base: string,
): Html {
  const resultados = buscarCanonicos(registro, texto);
  if (resultados.length === 0) {
    return html`<p class="tenue resultados">Ningún canónico coincide con «${texto}».</p>`;
  }
  return html`<ul class="resultados" aria-label="Canónicos para «${texto}»">
    ${resultados.map(
      ({ producto: p, exacto }) =>
        html`<li>
          ${enlaceSku(p.sku, base)}
          ${exacto ? html`<span class="etiqueta bien">SKU exacto</span>` : ''} ${resumenSku(p)} ·
          ${valor('precio', p.canonico.precio?.valor)}
          ${boton('Empatar con este', [emiteId, p.sku, 'confirmado'])}
        </li>`,
    )}
  </ul>`;
}

export function pantallaHistoricos(
  registro: RegistroCatalogo,
  q: URLSearchParams,
  base: string,
  porPagina: number,
): Html {
  const estado = (ESTADOS_HISTORICO as readonly string[]).includes(q.get('estado') ?? '')
    ? (q.get('estado') as FiltroHistorico)
    : null;
  const n = pagina(q);
  const buscado = (q.get('buscar') ?? '').trim().slice(0, MAX_TEXTO_BUSQUEDA);
  const para = q.get('para');
  const aviso = avisoDe(q);
  const todos = registro
    .historicos()
    .map((h) => ({ ...h, empates: registro.empatesDeHistorico(h.emiteId).sort(porDecision) }))
    .filter((h) =>
      estado === 'sin_candidato'
        ? !h.fusionadoEnId && h.empates.length === 0
        : estado
          ? h.empates.some((e) => e.estado === (estado as EstadoEmpate))
          : true,
    );
  const filtro = new URLSearchParams();
  if (estado) filtro.set('estado', estado);
  const volver = `historicos${conPagina(filtro, n)}`;
  const visibles = trozo(todos, n, porPagina);
  // Los buscadores son formularios GET aparte (un formulario no se anida en el POST del lote): el
  // campo de cada fila los nombra con `form`. El fragmento del `action` vuelve a la fila.
  const idBuscador = (i: number) => `buscar-${i}`;
  const buscadores = visibles.map(
    (h, i) =>
      html`<form
        id="${idBuscador(i)}"
        method="get"
        action="${base}historicos#${ancla('h', h.emiteId)}"
      >
        ${estado ? html`<input type="hidden" name="estado" value="${estado}" />` : ''}
        ${n > 1 ? html`<input type="hidden" name="pagina" value="${n}" />` : ''}
        <input type="hidden" name="para" value="${h.emiteId}" />
      </form>`,
  );
  const filas = visibles.map((h, i) => {
    const decidible = !h.fusionadoEnId && !h.empates.some((e) => e.estado === 'confirmado');
    const texto = para === h.emiteId ? buscado : '';
    const id = ancla('h', h.emiteId);
    return html`<tr id="${id}">
      <td>
        <span class="id">${h.codigo}</span><br />${h.nombre}
        ${h.aliasSku ? html`<br /><span class="tenue">alias de ${h.aliasSku}</span>` : ''}
      </td>
      <td>
        ${h.activo ? 'activo' : html`<span class="tenue">inactivo</span>`}
        ${h.fusionadoEnId ? html`<br /><span class="tenue">fusionado en ${h.fusionadoEnId}</span>` : ''}
      </td>
      <td>${uso(h.uso)}</td>
      <td>
        ${avisoEnFila(aviso, id)}
        ${
          h.empates.length
            ? h.empates.map(
                (e) =>
                  html`<div style="margin-bottom:6px">
                    ${
                      e.estado === 'propuesto' && !h.fusionadoEnId
                        ? html`<input
                            type="checkbox"
                            name="sel"
                            value="${JSON.stringify([e.emiteId, e.sku])}"
                            aria-label="Elegir ${h.codigo} con ${e.sku}"
                          />`
                        : ''
                    }
                    ${enlaceSku(e.sku, base)} ${etiquetaEstado(e.estado)}
                    <span class="cifra">${e.puntaje.toFixed(2)}</span><br />
                    ${resumenSku(registro.producto(e.sku))}<br />
                    <span class="tenue">${e.motivo}: ${e.detalle}</span>
                    ${
                      e.estado === 'propuesto' && !h.fusionadoEnId
                        ? html`<div class="botones">
                            ${boton('Confirmar', [e.emiteId, e.sku, 'confirmado'])}
                            ${boton('Rechazar', [e.emiteId, e.sku, 'rechazado'])}
                          </div>`
                        : e.decididoPor
                          ? html`<br /><span class="tenue"
                                >${e.decididoPor} ${fecha(e.decididoEn)}</span
                              >`
                          : ''
                    }
                  </div>`,
              )
            : html`<span class="tenue">sin candidato</span>`
        }
        ${
          decidible
            ? html`<div class="botones">
                  <label
                    >Buscar canónico
                    <input
                      type="search"
                      name="buscar"
                      form="${idBuscador(i)}"
                      value="${texto}"
                      maxlength="${MAX_TEXTO_BUSQUEDA}"
                      placeholder="código o nombre"
                  /></label>
                  <button type="submit" form="${idBuscador(i)}">Buscar</button>
                </div>
                ${texto ? resultadosBusqueda(registro, h.emiteId, texto, base) : ''}`
            : ''
        }
      </td>
    </tr>`;
  });
  return html`<h1>Históricos de Emite DTE</h1>
    <nav class="pestanas" aria-label="Vistas del catálogo">
      <a href="${base}productos">Por SKU</a>
      <a href="${base}historicos" aria-current="page">Históricos de Emite DTE</a>
      <a href="${base}productos?vista=sin_sku">Sin SKU</a>
    </nav>
    <p class="aviso aviso-accion" role="note">
      Confirmar un empate es definitivo cuando la escritura está encendida: fusiona el histórico en
      el canónico y no se deshace.
    </p>
    <form class="filtros" method="get">
      <label
        >Empate
        <select name="estado">
          <option value="">todos</option>
          ${ESTADOS_HISTORICO.map(
            (e) =>
              html`<option value="${e}" ${e === estado ? html` selected` : ''}>
                ${e === 'sin_candidato' ? 'sin candidato' : e}
              </option>`,
          )}
        </select></label
      >
      <button type="submit">Filtrar</button>
    </form>
    ${
      filas.length
        ? html`${formulario(
            base,
            'empates',
            volver,
            html`<div class="tabla">
                <table>
                  <thead>
                    <tr>
                      <th>Histórico</th>
                      <th>Estado</th>
                      <th>Uso</th>
                      <th>Empate con SKU</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filas}
                  </tbody>
                </table>
              </div>
              <div class="lote">
                <strong>Los elegidos</strong>
                <button type="submit" name="estado" value="confirmado">Confirmar</button>
                <button type="submit" name="estado" value="rechazado">Rechazar</button>
              </div>`,
          )}
          ${buscadores}`
        : html`<p class="tenue">No hay históricos${estado ? ' con este filtro' : ''}.</p>`
    }
    ${paginas(todos.length, n, porPagina, (p) => conPagina(filtro, p))}
    <p class="tenue">
      Cada histórico trae hasta tres candidatos, el mejor primero; rechazar uno trae el siguiente.
      Si ninguno es el producto, «Buscar canónico» encuentra el correcto por código o nombre y
      «Empatar con este» lo confirma a mano. Confirmar un empate lo anota en el registro; la fusión
      en Emite DTE la hace la siguiente pasada de escritura, si está encendida.
    </p>`;
}

// --- Conflictos ---

export function pantallaConflictos(
  registro: RegistroCatalogo,
  q: URLSearchParams,
  base: string,
  porPagina: number,
): Html {
  const n = pagina(q);
  const todos = registro.conflictosAbiertos();
  const aviso = avisoDe(q);
  const volver = `conflictos${conPagina(new URLSearchParams(), n)}`;
  return html`<h1>Conflictos abiertos</h1>
    <p class="tenue">
      Dos sistemas cambiaron el mismo campo entre pasadas. Mientras siga abierto, ese campo no se
      escribe en ningún lado.
    </p>
    ${
      todos.length
        ? formulario(
            base,
            'conflictos',
            volver,
            html`<div class="tabla">
                <table>
                  <thead>
                    <tr>
                      <th><span class="tenue">Lote</span></th>
                      <th>SKU</th>
                      <th>Campo</th>
                      <th>Valores</th>
                      <th>Abierto</th>
                      <th>Estado</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${trozo(todos, n, porPagina).map((c) => tablaConflicto(c, base, aviso))}
                  </tbody>
                </table>
              </div>
              <div class="lote">
                <strong>Los elegidos: quedarse con el de</strong>
                ${(['woocommerce', 'coreinbox', 'emite'] as const).map(
                  (s) =>
                    html`<button type="submit" name="fuente" value="${s}">
                      ${s === 'woocommerce' ? 'la web' : NOMBRE_SISTEMA[s]}
                    </button>`,
                )}
              </div>`,
          )
        : html`<p class="tenue">No hay conflictos abiertos.</p>`
    }
    ${paginas(todos.length, n, porPagina, (p) => conPagina(new URLSearchParams(), p))}`;
}

// --- Visibilidad web ---

export function pantallaVisibilidad(
  registro: RegistroCatalogo,
  q: URLSearchParams,
  base: string,
  porPagina: number,
): Html {
  const n = pagina(q);
  const { items, total } = registro.listar({ propuestoWeb: true }, n, porPagina);
  const aviso = avisoDe(q);
  const volver = `visibilidad${conPagina(new URLSearchParams(), n)}`;
  return html`<h1>Visibilidad web</h1>
    <p class="tenue">
      Productos sin decisión que se proponen para la web, incluidos los borradores de la tienda. Un
      servicio no se ofrece, y lo publicado en la web queda aprobado por «web». Aprobar o rechazar
      lo anota; la siguiente pasada de escritura lo lleva a la web, si está encendida.
    </p>
    ${
      items.length
        ? formulario(
            base,
            'visibilidad',
            volver,
            html`<div class="tabla">
                <table>
                  <thead>
                    <tr>
                      <th><span class="tenue">Lote</span></th>
                      <th>Foto</th>
                      <th>SKU</th>
                      <th>Nombre</th>
                      <th>Precio bruto</th>
                      <th>Tipo</th>
                      <th>Web</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${items.map(
                      (p) =>
                        html`<tr id="${ancla('p', p.sku)}">
                          <td>
                            ${
                              p.tipo === 'servicio'
                                ? ''
                                : html`<input
                                    type="checkbox"
                                    name="sku"
                                    value="${p.sku}"
                                    aria-label="Elegir ${p.sku}"
                                  />`
                            }
                          </td>
                          <td>${foto(base, p.sku, registro.fotos(p.sku).length > 0, 'chica')}</td>
                          <td>${enlaceSku(p.sku, base)}</td>
                          <td>${valor('nombre', p.canonico.nombre?.valor)}</td>
                          <td>${valor('precio', p.canonico.precio?.valor)}</td>
                          <td>${p.tipo ?? nada}</td>
                          <td>
                            ${etiquetaVisibilidad(p.visibilidadWeb)}
                            ${motivoVisibilidad(p.motivoVisibilidad)}
                          </td>
                          <td>
                            ${avisoEnFila(aviso, ancla('p', p.sku))}
                            ${
                              p.tipo === 'servicio'
                                ? html`<span class="tenue">un servicio no se ofrece</span>`
                                : html`<div class="botones">
                                    ${boton('Aprobar', [p.sku, 'aprobado'])}
                                    ${boton('Rechazar', [p.sku, 'rechazado'])}
                                  </div>`
                            }
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              <div class="lote">
                <strong>Los elegidos</strong>
                <button type="submit" name="estado" value="aprobado">Aprobar</button>
                <button type="submit" name="estado" value="rechazado">Rechazar</button>
              </div>`,
          )
        : html`<p class="tenue">No hay productos propuestos para la web.</p>`
    }
    ${paginas(total, n, porPagina, (p) => conPagina(new URLSearchParams(), p))}
    ${seccionCategorias(registro, base, volver, aviso)}
    ${seccionRechazadosPorCategoria(registro, base, volver, aviso)}`;
}

const MAX_RECHAZADOS = 100;

/** Las categorías de Coreinbox cuyos productos no van a la web, y el formulario para sumar más. */
function seccionCategorias(
  registro: RegistroCatalogo,
  base: string,
  volver: string,
  aviso: Aviso | null,
): Html {
  const fuera = registro.categoriasFuera();
  const nombres = new Set(fuera.map((c) => c.categoria));
  const libres = registro.categoriasLeidas().filter((c) => !nombres.has(c));
  return html`<section class="bloque">
    <h2>Categorías fuera de la web</h2>
    <p class="tenue">
      Los productos de una categoría marcada no van a la web mientras nadie los apruebe uno a uno.
    </p>
    ${
      fuera.length
        ? html`<div class="tabla">
            <table>
              <thead>
                <tr>
                  <th>Categoría</th>
                  <th>Quién lo marcó</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${fuera.map(
                  (c) =>
                    html`<tr id="${ancla('k', c.categoria)}">
                      <td>${c.categoria}</td>
                      <td>${c.usuario ?? nada} ${fecha(c.en)}</td>
                      <td>
                        ${avisoEnFila(aviso, ancla('k', c.categoria))}
                        ${formulario(
                          base,
                          'categorias',
                          volver,
                          html`<div class="botones">
                            <input type="hidden" name="categoria" value="${c.categoria}" />
                            <button type="submit" name="fuera" value="0">Volver a la web</button>
                          </div>`,
                        )}
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<p class="tenue">Ninguna.</p>`
    }
    ${
      libres.length
        ? formulario(
            base,
            'categorias',
            volver,
            html`<div class="lote">
              <strong>Sacar de la web</strong>
              ${libres.map(
                (c) =>
                  html`<label class="casilla"
                    ><input type="checkbox" name="categoria" value="${c}" /> ${c}</label
                  >`,
              )}
              <button type="submit" name="fuera" value="1">Marcar como fuera de la web</button>
            </div>`,
          )
        : html`<p class="tenue">No hay más categorías de Coreinbox que marcar.</p>`
    }
  </section>`;
}

/** Los SKUs rechazados sólo por su categoría, para aprobarlos uno a uno. */
function seccionRechazadosPorCategoria(
  registro: RegistroCatalogo,
  base: string,
  volver: string,
  aviso: Aviso | null,
): Html {
  const { items: visibles, total } = registro.listar(
    { rechazadoPorCategoria: true },
    1,
    MAX_RECHAZADOS,
  );
  return html`<section class="bloque">
    <h2>Rechazados por su categoría</h2>
    ${
      visibles.length
        ? html`${formulario(
            base,
            'visibilidad',
            volver,
            html`<div class="tabla">
                <table>
                  <thead>
                    <tr>
                      <th><span class="tenue">Lote</span></th>
                      <th>SKU</th>
                      <th>Nombre</th>
                      <th>Categoría</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${visibles.map(
                      (p) =>
                        html`<tr id="${ancla('p', p.sku)}">
                          <td>
                            <input
                              type="checkbox"
                              name="sku"
                              value="${p.sku}"
                              aria-label="Elegir ${p.sku}"
                            />
                          </td>
                          <td>${enlaceSku(p.sku, base)}</td>
                          <td>${valor('nombre', p.canonico.nombre?.valor)}</td>
                          <td>${valor('categoria', p.canonico.categoria?.valor)}</td>
                          <td>
                            ${avisoEnFila(aviso, ancla('p', p.sku))}
                            <div class="botones">${boton('Aprobar', [p.sku, 'aprobado'])}</div>
                          </td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
              <div class="lote">
                <strong>Los elegidos</strong>
                <button type="submit" name="estado" value="aprobado">Aprobar</button>
              </div>`,
          )}
          ${
            total > visibles.length
              ? html`<p class="tenue">Se muestran ${visibles.length} de ${total}.</p>`
              : ''
          }`
        : html`<p class="tenue">Ninguno.</p>`
    }
  </section>`;
}

// --- Quién manda ---

export function pantallaReglas(registro: RegistroCatalogo, base: string): Html {
  const reglas = registro.reglas();
  const globales = new Map(reglas.filter((r) => r.ambito === '*').map((r) => [r.campo, r]));
  const porSku = reglas.filter((r) => r.ambito !== '*');
  return html`<h1>Quién manda</h1>
    <p class="tenue">
      Qué sistema manda en cada campo para todo el catálogo. Hay dos modos. Con un sistema
      propietario, ese sistema manda y los demás se corrigen a su valor. Con «último cambio», gana
      el cambio más reciente que no sea eco de una escritura del conector; sólo vale para
      ${CAMPOS_ULTIMO_CAMBIO.join(', ')}. Sin regla: nombre y precio van por último cambio (antes de
      la primera escritura, manda la regla de arranque: la web y luego Coreinbox); activo, tipo y
      categoría los manda Coreinbox, y exento, Emite DTE. Para fijarlo en lote por SKU, elíjalos en
      la lista de productos.
    </p>
    <div class="tabla">
      <table>
        <thead>
          <tr>
            <th>Campo</th>
            <th>Manda</th>
            <th>Quién lo fijó</th>
            <th>Cambiar</th>
          </tr>
        </thead>
        <tbody>
          ${CAMPOS_CATALOGO.map((campo) => {
            const r = globales.get(campo);
            return html`<tr>
              <td>${campo}</td>
              <td>
                ${r ? NOMBRE_FUENTE[r.fuente] : html`<span class="tenue">modo por defecto</span>`}
              </td>
              <td>${r ? html`${r.usuario ?? nada} ${fecha(r.en)}` : nada}</td>
              <td>
                ${formulario(
                  base,
                  'reglas',
                  'reglas',
                  html`<div class="botones">
                    <input type="hidden" name="campo" value="${campo}" />
                    ${selectFuente('fuente', r?.fuente ?? null, 'modo por defecto', campo)}
                    <button type="submit">Fijar</button>
                  </div>`,
                )}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
    <section class="bloque">
      <h2>Reglas por SKU</h2>
      ${
        porSku.length
          ? html`<div class="tabla">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Campo</th>
                    <th>Manda</th>
                    <th>Quién lo fijó</th>
                  </tr>
                </thead>
                <tbody>
                  ${porSku.map(
                    (r) =>
                      html`<tr>
                        <td>${enlaceSku(r.ambito, base)}</td>
                        <td>${r.campo}</td>
                        <td>${NOMBRE_FUENTE[r.fuente]}</td>
                        <td>${r.usuario ?? nada} ${fecha(r.en)}</td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<p class="tenue">Ninguna.</p>`
      }
    </section>`;
}
