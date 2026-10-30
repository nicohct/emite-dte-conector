/**
 * Las pantallas de decisiones sobre el catálogo: empates de históricos, conflictos abiertos,
 * visibilidad web y «quién manda». Cada formulario manda a `POST acciones/{…}`, que sólo cambia el
 * registro del conector hasta la fase 1b.
 */
import type { EstadoEmpate, RegistroCatalogo } from '../estado-catalogo.js';
import { CAMPOS_CATALOGO } from '../estado-catalogo.js';
import {
  boton,
  etiquetaVisibilidad,
  foto,
  formulario,
  nada,
  NOMBRE_SISTEMA,
  selectFuente,
  tablaConflicto,
  uso,
  valor,
} from './catalogo.js';
import { fecha, html, paginas, type Html } from './html.js';
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
  const todos = registro
    .historicos()
    .map((h) => ({ ...h, empates: registro.empatesDeHistorico(h.emiteId) }))
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
  const filas = trozo(todos, n, porPagina).map(
    (h) =>
      html`<tr>
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
        </td>
      </tr>`,
  );
  return html`<h1>Históricos de Emite DTE</h1>
    <nav class="pestanas" aria-label="Vistas del catálogo">
      <a href="${base}productos">Por SKU</a>
      <a href="${base}historicos" aria-current="page">Históricos de Emite DTE</a>
      <a href="${base}productos?vista=sin_sku">Sin SKU</a>
    </nav>
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
        ? formulario(
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
          )
        : html`<p class="tenue">No hay históricos${estado ? ' con este filtro' : ''}.</p>`
    }
    ${paginas(todos.length, n, porPagina, (p) => conPagina(filtro, p))}
    <p class="tenue">
      Confirmar un empate sólo lo anota en el registro: la fusión en Emite DTE llega con la fase 1b.
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
                    ${trozo(todos, n, porPagina).map((c) => tablaConflicto(c, base))}
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
  const volver = `visibilidad${conPagina(new URLSearchParams(), n)}`;
  return html`<h1>Visibilidad web</h1>
    <p class="tenue">
      Productos que no están en la web y se proponen para publicarse. Un servicio no se ofrece en la
      web. Aprobar sólo lo anota: la publicación llega con la fase 1b.
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
                        html`<tr>
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
                          <td>${etiquetaVisibilidad(p.visibilidadWeb)}</td>
                          <td>
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
    ${paginas(total, n, porPagina, (p) => conPagina(new URLSearchParams(), p))}`;
}

// --- Quién manda ---

export function pantallaReglas(registro: RegistroCatalogo, base: string): Html {
  const reglas = registro.reglas();
  const globales = new Map(reglas.filter((r) => r.ambito === '*').map((r) => [r.campo, r]));
  const porSku = reglas.filter((r) => r.ambito !== '*');
  return html`<h1>Quién manda</h1>
    <p class="tenue">
      Qué sistema manda en cada campo para todo el catálogo. Sin regla, manda la de arranque. Para
      fijarlo en lote por SKU, elíjalos en la lista de productos.
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
                ${r ? NOMBRE_SISTEMA[r.fuente] : html`<span class="tenue">regla de arranque</span>`}
              </td>
              <td>${r ? html`${r.usuario ?? nada} ${fecha(r.en)}` : nada}</td>
              <td>
                ${formulario(
                  base,
                  'reglas',
                  'reglas',
                  html`<div class="botones">
                    <input type="hidden" name="campo" value="${campo}" />
                    ${selectFuente('fuente', r?.fuente ?? null, 'regla de arranque')}
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
                        <td>${NOMBRE_SISTEMA[r.fuente]}</td>
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
