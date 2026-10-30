/** Las pantallas del panel (sólo lectura): flujos y eventos. */
import type { RespuestaSalud, UltimaFalla, UltimaPasada } from '../salud.js';
import {
  ESTADOS_EVENTOS,
  FLUJOS_EVENTOS,
  type Evento,
  type FiltroEventos,
  type PaginaEventos,
} from './eventos.js';
import { enlaceExterno, fecha, html, type Html } from './html.js';

export interface Enlaces {
  /** URL con que la gente abre Emite DTE; `null` muestra los ids sin enlace. */
  emite: string | null;
}

const cifra = (n: number) => html`<span class="cifra">${n.toLocaleString('es-CL')}</span>`;

const encendido = (activo: boolean) =>
  activo
    ? html`<span class="etiqueta bien">activo</span>`
    : html`<span class="etiqueta tenue">apagado</span>`;

const CLASE_ESTADO: Record<string, string> = {
  creada: 'bien',
  sincronizado: 'bien',
  visto: 'tenue',
  omitido: 'aviso',
  error: 'mal',
};

const etiquetaEstado = (estado: string) =>
  html`<span class="etiqueta ${CLASE_ESTADO[estado] ?? 'tenue'}">${estado}</span>`;

function pasadaHtml(p: UltimaPasada | null): Html {
  if (!p) return html`<span class="tenue">sin pasadas desde el último arranque</span>`;
  const cuentas = Object.entries(p.resultado).map(
    ([k, v]) => html`<span class="tenue">${k}</span> ${cifra(v)} `,
  );
  return html`${fecha(p.en)}<br />${cuentas}`;
}

function fallaHtml(f: UltimaFalla | null): Html {
  if (!f) return html`<span class="tenue">ninguna desde el último arranque</span>`;
  return html`${fecha(f.en)}<br /><span class="id mal">${f.codigo}</span>
    ${f.status === null ? '' : html` · status <span class="cifra">${f.status}</span>`} ·
    ${f.transitorio ? html`<span class="aviso">transitoria, se reintenta sola</span>` : html`<span class="mal">no transitoria</span>`}`;
}

/** Enlace a la cotización creada en Emite DTE (la misma ruta que va en la actividad del CRM). */
function cotizacionEmite(e: Evento, enlaces: Enlaces): Html {
  if (!e.emiteId) return html`<span class="tenue">—</span>`;
  const texto = e.emiteNumero === null ? e.emiteId : `N° ${e.emiteNumero}`;
  return enlaceExterno(enlaces.emite ? `${enlaces.emite}/cotizaciones/${e.emiteId}` : null, texto);
}

/** Coreinbox no tiene URL pública en la configuración: el id va sin enlace. */
const cotizacionCoreinbox = (e: Evento) =>
  html`${e.referencia ?? ''} <span class="id tenue">${e.id}</span>`;

function emiteDe(e: Evento, enlaces: Enlaces): Html {
  if (e.tipo === 'cotizacion') return cotizacionEmite(e, enlaces);
  return e.emiteId
    ? html`<span class="id">${e.emiteId}</span>`
    : html`<span class="tenue">—</span>`;
}

function origenDe(e: Evento): Html {
  if (e.tipo === 'cotizacion') return cotizacionCoreinbox(e);
  if (e.tipo === 'producto')
    return html`${e.referencia ? html`SKU ${e.referencia}` : html`<span class="tenue">sin SKU</span>`}
      <span class="id tenue">${e.id}</span>`;
  return html`<span class="id">${e.id}</span>`;
}

const NOMBRE_TIPO: Record<Evento['tipo'], string> = {
  cotizacion: 'Cotización',
  webhook: 'Webhook de Emite DTE',
  producto: 'Producto',
};

function tablaEventos(eventos: Evento[], enlaces: Enlaces): Html {
  return html`<div class="tabla">
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Qué</th>
          <th>Estado</th>
          <th>Coreinbox / origen</th>
          <th>Emite DTE</th>
          <th>Detalle</th>
        </tr>
      </thead>
      <tbody>
        ${eventos.map(
          (e) =>
            html`<tr>
              <td>${fecha(e.en)}</td>
              <td>${NOMBRE_TIPO[e.tipo]}</td>
              <td>${etiquetaEstado(e.estado)}</td>
              <td>${origenDe(e)}</td>
              <td>${emiteDe(e, enlaces)}</td>
              <td>${e.detalle ?? html`<span class="tenue">—</span>`}</td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

export interface DatosFlujos {
  salud: RespuestaSalud;
  /** Últimos con error de cada flujo, ya leídos del estado. */
  errores: { cotizaciones: Evento[]; productos: Evento[] };
  base: string;
}

export function pantallaFlujos(d: DatosFlujos, enlaces: Enlaces): Html {
  const { cotizaciones: c, productos: p } = d.salud.flujos;
  const errores = (flujo: 'cotizaciones' | 'productos', lista: Evento[]) =>
    lista.length
      ? html`<h2 style="margin-top:12px">Errores recientes</h2>
          ${tablaEventos(lista, enlaces)}
          <p>
            <a href="${d.base}eventos?flujo=${flujo}&amp;estado=error">Ver todos los errores</a>
          </p>`
      : '';
  return html`<h1>Flujos</h1>
    <div class="tarjetas">
      <section class="tarjeta">
        <header>
          <h2>Cotizaciones</h2>
          ${encendido(c.activo)}
        </header>
        <dl>
          <dt>Cursor</dt>
          <dd>${fecha(c.cursor)}</dd>
          <dt>Creadas</dt>
          <dd>${cifra(c.creadas)}</dd>
          <dt>Con error</dt>
          <dd>${cifra(c.conError)}</dd>
          <dt>Última pasada</dt>
          <dd>${pasadaHtml(c.ultimaPasada)}</dd>
          <dt>Última falla</dt>
          <dd>${fallaHtml(c.ultimaFalla)}</dd>
        </dl>
      </section>
      <section class="tarjeta">
        <header>
          <h2>Productos</h2>
          ${encendido(p.activo)}
        </header>
        <dl>
          <dt>Cursor</dt>
          <dd>${fecha(p.cursor)}</dd>
          <dt>Sincronizados</dt>
          <dd>${cifra(p.sincronizados)}</dd>
          <dt>Omitidos</dt>
          <dd>${cifra(p.omitidos)}</dd>
          <dt>Con error</dt>
          <dd>${cifra(p.conError)}</dd>
          <dt>Última pasada</dt>
          <dd>${pasadaHtml(p.ultimaPasada)}</dd>
          <dt>Última falla</dt>
          <dd>${fallaHtml(p.ultimaFalla)}</dd>
        </dl>
      </section>
      <section class="tarjeta">
        <header>
          <h2>Pedidos</h2>
          ${encendido(false)}
        </header>
        <p class="tenue">Pedidos web a Emite DTE: todavía no implementado.</p>
      </section>
    </div>
    ${errores('cotizaciones', d.errores.cotizaciones)} ${errores('productos', d.errores.productos)}
    <p class="tenue">
      La última pasada y la última falla viven en memoria: se pierden al reiniciar el conector.
    </p>`;
}

/** Consulta de una página de eventos conservando los filtros. */
export function consultaEventos(f: FiltroEventos, pagina: number): string {
  const q = new URLSearchParams();
  if (f.flujo) q.set('flujo', f.flujo);
  if (f.estado) q.set('estado', f.estado);
  if (pagina > 1) q.set('pagina', String(pagina));
  const s = q.toString();
  return s ? `?${s}` : '?';
}

export function pantallaEventos(p: PaginaEventos, f: FiltroEventos, enlaces: Enlaces): Html {
  const opciones = (valores: readonly string[], actual: string | null, todos: string) => [
    html`<option value="">${todos}</option>`,
    ...valores.map(
      (v) => html`<option value="${v}" ${v === actual ? html` selected` : ''}>${v}</option>`,
    ),
  ];
  const paginas = Math.max(1, Math.ceil(p.total / f.porPagina));
  const navegacion = html`<nav class="paginas" aria-label="Páginas">
    ${f.pagina > 1 ? html`<a href="${consultaEventos(f, f.pagina - 1)}" rel="prev">← Más nuevos</a>` : ''}
    <span class="tenue"
      >Página <span class="cifra">${f.pagina}</span> de <span class="cifra">${paginas}</span> ·
      <span class="cifra">${p.total}</span> en total</span
    >
    ${f.pagina < paginas ? html`<a href="${consultaEventos(f, f.pagina + 1)}" rel="next">Más antiguos →</a>` : ''}
  </nav>`;
  return html`<h1>Eventos</h1>
    <form class="filtros" method="get">
      <label
        >Flujo
        <select name="flujo">
          ${opciones(FLUJOS_EVENTOS, f.flujo, 'todos')}
        </select></label
      >
      <label
        >Estado
        <select name="estado">
          ${opciones(ESTADOS_EVENTOS, f.estado, 'todos')}
        </select></label
      >
      <button type="submit">Filtrar</button>
      ${f.flujo || f.estado ? html`<a href="?">Quitar filtros</a>` : ''}
    </form>
    ${p.eventos.length ? tablaEventos(p.eventos, enlaces) : html`<p class="tenue">No hay eventos${f.flujo || f.estado ? ' con estos filtros' : ''}.</p>`}
    ${navegacion}
    <p class="tenue">
      Cotizaciones y productos muestran su último estado y la fecha de su último cambio.
    </p>`;
}
