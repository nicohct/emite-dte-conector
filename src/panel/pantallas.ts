/** Las pantallas de los flujos y de los eventos (sólo lectura). */
import type { Evento, FlujoEvento, TipoEvento } from '../estado.js';
import type { ResumenCatalogo } from '../estado-catalogo.js';
import { NOMBRES_ACCIONES } from '../flujos/productos/acciones.js';
import type { RespuestaSalud, UltimaFalla, UltimaPasada } from '../salud.js';
import { cifra, enlaceExterno, fecha, html, paginas, type Html } from './html.js';

export interface Enlaces {
  /** URL con que la gente abre Emite DTE; `null` muestra los ids sin enlace. */
  emite: string | null;
}

export const FLUJOS_EVENTOS: readonly FlujoEvento[] = ['cotizaciones', 'productos'];
/** Los valores de `estado` que produce `Estado.eventos`, por tipo (las acciones, por su nombre). */
export const ESTADOS_EVENTOS: readonly string[] = [
  'creada',
  'error',
  'visto',
  'sincronizado',
  'omitido',
  'abierto',
  'resuelto',
  'propuesto',
  'confirmado',
  'rechazado',
  ...NOMBRES_ACCIONES,
];

export interface FiltroPanelEventos {
  flujo: FlujoEvento | null;
  estado: string | null;
  pagina: number;
  porPagina: number;
}

const encendido = (activo: boolean) =>
  activo
    ? html`<span class="etiqueta bien">activo</span>`
    : html`<span class="etiqueta tenue">apagado</span>`;

const CLASE_ESTADO: Record<string, string> = {
  creada: 'bien',
  sincronizado: 'bien',
  resuelto: 'bien',
  confirmado: 'bien',
  aprobado: 'bien',
  visto: 'tenue',
  omitido: 'aviso',
  abierto: 'aviso',
  propuesto: 'aviso',
  error: 'mal',
  rechazado: 'mal',
};

export const etiquetaEstado = (estado: string) =>
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

const nada = html`<span class="tenue">—</span>`;

/** Enlace al producto en el panel; `base` es el prefijo de los enlaces internos. */
export const enlaceSku = (sku: string, base: string) =>
  html`<a href="${base}productos/${encodeURIComponent(sku)}">${sku}</a>`;

/** Enlace a la cotización creada en Emite DTE (la misma ruta que va en la actividad del CRM). */
function emiteDe(e: Evento, enlaces: Enlaces): Html {
  if (!e.emiteId) return nada;
  if (e.tipo !== 'cotizacion') return html`<span class="id">${e.emiteId}</span>`;
  return enlaceExterno(
    enlaces.emite ? `${enlaces.emite}/cotizaciones/${e.emiteId}` : null,
    e.emiteNumero === null ? e.emiteId : `N° ${e.emiteNumero}`,
  );
}

/** Coreinbox no tiene URL pública en la configuración: los ids van sin enlace. */
function origenDe(e: Evento): Html {
  const id = html`<span class="id tenue">${e.idExterno ?? ''}</span>`;
  if (e.tipo === 'cotizacion') return html`${e.referencia ?? ''} ${id}`;
  if (e.tipo === 'empate') return html`histórico ${id}`;
  if (e.tipo === 'conflicto') return html`conflicto ${id}`;
  if (e.tipo === 'accion') return html`acción ${id}`;
  return id;
}

function detalleDe(e: Evento): Html | string {
  if (e.tipo === 'cotizacion') return e.estado === 'error' ? (e.mensaje ?? '') : nada;
  if (e.tipo === 'conflicto') return html`campo <strong>${e.mensaje ?? ''}</strong>`;
  if (e.tipo === 'accion')
    return e.mensaje ? html`por ${e.mensaje}` : html`<span class="tenue">sin usuario</span>`;
  return e.mensaje ?? nada;
}

export const NOMBRE_TIPO: Record<TipoEvento, string> = {
  cotizacion: 'Cotización',
  webhook: 'Webhook de Emite DTE',
  producto: 'Producto',
  conflicto: 'Conflicto',
  empate: 'Empate de histórico',
  accion: 'Acción del panel',
};

function tablaEventos(eventos: Evento[], enlaces: Enlaces, base: string): Html {
  return html`<div class="tabla">
    <table>
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Qué</th>
          <th>Estado</th>
          <th>Coreinbox / origen</th>
          <th>SKU</th>
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
              <td>${e.sku ? enlaceSku(e.sku, base) : nada}</td>
              <td>${emiteDe(e, enlaces)}</td>
              <td>${detalleDe(e)}</td>
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

function tarjetaCatalogo(r: ResumenCatalogo, base: string): Html {
  const fila = (texto: string, n: number, ruta: string) =>
    html`<dt>${texto}</dt>
      <dd><a href="${base}${ruta}">${cifra(n)}</a></dd>`;
  return html`<section class="tarjeta">
    <header>
      <h2>Catálogo</h2>
      <a href="${base}productos">ver productos</a>
    </header>
    <dl>
      ${fila('SKUs', r.skus, 'productos')}
      <dt>Leídos</dt>
      <dd>
        <span class="tenue">Coreinbox</span> ${cifra(r.leidos.coreinbox)} ·
        <span class="tenue">web</span> ${cifra(r.leidos.woocommerce)} ·
        <span class="tenue">Emite DTE</span> ${cifra(r.leidos.emite)}
      </dd>
      ${fila('Históricos', r.historicos, 'historicos')}
      ${fila('Con diferencias', r.conDiferencias, 'productos?diferencias=1')}
      ${fila('En conflicto', r.enConflicto, 'conflictos')}
      ${fila('Empates propuestos', r.empatesPropuestos, 'historicos?estado=propuesto')}
      ${fila('Sin SKU', r.sinSku, 'productos?vista=sin_sku')}
    </dl>
  </section>`;
}

export function pantallaFlujos(d: DatosFlujos, enlaces: Enlaces): Html {
  const { cotizaciones: c, productos: p } = d.salud.flujos;
  const errores = (flujo: FlujoEvento, lista: Evento[]) =>
    lista.length
      ? html`<h2 style="margin-top:12px">Errores recientes</h2>
          ${tablaEventos(lista, enlaces, d.base)}
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
      ${tarjetaCatalogo(p.catalogo, d.base)}
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
export function consultaEventos(f: FiltroPanelEventos, pagina: number): string {
  const q = new URLSearchParams();
  if (f.flujo) q.set('flujo', f.flujo);
  if (f.estado) q.set('estado', f.estado);
  if (pagina > 1) q.set('pagina', String(pagina));
  const s = q.toString();
  return s ? `?${s}` : '?';
}

export function pantallaEventos(
  p: { eventos: Evento[]; total: number },
  f: FiltroPanelEventos,
  enlaces: Enlaces,
  base: string,
): Html {
  const opciones = (valores: readonly string[], actual: string | null, todos: string) => [
    html`<option value="">${todos}</option>`,
    ...valores.map(
      (v) => html`<option value="${v}" ${v === actual ? html` selected` : ''}>${v}</option>`,
    ),
  ];
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
    ${p.eventos.length ? tablaEventos(p.eventos, enlaces, base) : html`<p class="tenue">No hay eventos${f.flujo || f.estado ? ' con estos filtros' : ''}.</p>`}
    ${paginas(p.total, f.pagina, f.porPagina, (n) => consultaEventos(f, n), {
      anterior: '← Más nuevos',
      siguiente: 'Más antiguos →',
    })}
    <p class="tenue">
      Cotizaciones y productos muestran su último estado y la fecha de su último cambio; conflictos
      y empates, la de su apertura o su decisión.
    </p>`;
}
