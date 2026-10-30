/**
 * Piezas comunes del HTML del panel: escape, fechas, enlaces y el marco de cada página. Sin
 * JavaScript ni recursos externos; todos los enlaces son relativos para que el panel funcione igual
 * en `/panel` que detrás de `/integraciones/conector/` en Emite DTE.
 */

const ENTIDADES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ENTIDADES[c]!);

/** Marca un fragmento ya escapado para que `html` no lo vuelva a escapar. */
export class Html {
  constructor(readonly valor: string) {}
  toString(): string {
    return this.valor;
  }
}

type Parte = Html | string | number | null | undefined | false | Parte[];

const unir = (p: Parte): string =>
  p instanceof Html
    ? p.valor
    : Array.isArray(p)
      ? p.map(unir).join('')
      : p === null || p === undefined || p === false
        ? ''
        : esc(p);

/** Plantilla que escapa cada valor interpolado salvo los `Html`. */
export function html(partes: TemplateStringsArray, ...valores: Parte[]): Html {
  return new Html(
    partes.reduce((acc, s, i) => acc + s + (i < valores.length ? unir(valores[i]!) : ''), ''),
  );
}

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CL', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/Santiago',
});

export function fecha(iso: string | null): Html {
  if (!iso) return html`<span class="tenue">—</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return html`<span class="cifra">${iso}</span>`;
  return html`<time class="cifra" datetime="${iso}" title="${iso}"
    >${FORMATO_FECHA.format(d)}</time
  >`;
}

/** Enlace a un objeto de otro sistema; sin URL base, sólo el texto. */
export function enlaceExterno(url: string | null, texto: string): Html {
  return url
    ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${texto}</a>`
    : html`<span class="id">${texto}</span>`;
}

export const cifra = (n: number) => html`<span class="cifra">${n.toLocaleString('es-CL')}</span>`;

/** Navegación de páginas para listas paginadas; `consulta` arma el `?…` de cada página. */
export function paginas(
  total: number,
  pagina: number,
  porPagina: number,
  consulta: (pagina: number) => string,
  textos: { anterior: string; siguiente: string } = {
    anterior: '← Anterior',
    siguiente: 'Siguiente →',
  },
): Html {
  const ultima = Math.max(1, Math.ceil(total / porPagina));
  return html`<nav class="paginas" aria-label="Páginas">
    ${pagina > 1 ? html`<a href="${consulta(pagina - 1)}" rel="prev">${textos.anterior}</a>` : ''}
    <span class="tenue"
      >Página <span class="cifra">${pagina}</span> de <span class="cifra">${ultima}</span> ·
      <span class="cifra">${total}</span> en total</span
    >
    ${pagina < ultima ? html`<a href="${consulta(pagina + 1)}" rel="next">${textos.siguiente}</a>` : ''}
  </nav>`;
}

/** Las secciones de la navegación, en orden. */
export const SECCIONES = {
  flujos: 'Flujos',
  eventos: 'Eventos',
  productos: 'Productos',
  historicos: 'Históricos',
  conflictos: 'Conflictos',
  visibilidad: 'Visibilidad web',
  reglas: 'Quién manda',
} as const;
export type Seccion = keyof typeof SECCIONES;

/** Resultado de una acción del panel, que vuelve en la consulta tras la redirección. */
export interface Aviso {
  accion: string;
  aplicadas: number;
  errores: string[];
}

export interface Marco {
  titulo: string;
  /**
   * Prefijo de los enlaces internos: `./` dentro de `/panel/`, `panel/` en `/panel` sin barra y
   * `../` un nivel más abajo (`/panel/productos/{sku}`).
   */
  base: string;
  activa: Seccion | null;
  usuario: string | null;
  aviso?: Aviso | null;
}

const ESTILOS = `
:root {
  color-scheme: light dark;
  --fondo: #ffffff; --texto: #1b1f24; --tenue: #5b6470; --borde: #d8dde3; --suave: #f4f6f8;
  --enlace: #0b5cad; --bien: #1a7f37; --mal: #c62828; --aviso: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fondo: #14171b; --texto: #e6e9ed; --tenue: #9aa4b0; --borde: #2e343b; --suave: #1c2026;
    --enlace: #6cb6ff; --bien: #4ac26b; --mal: #ff7b72; --aviso: #d29922;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--fondo); color: var(--texto);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 20px;
  padding: 12px 16px; border-bottom: 1px solid var(--borde);
}
header strong { font-size: 15px; }
nav { display: flex; flex-wrap: wrap; gap: 4px 14px; }
nav a { color: var(--tenue); text-decoration: none; padding-bottom: 2px; }
nav a[aria-current="page"] { color: var(--texto); border-bottom: 2px solid var(--enlace); }
.usuario { margin-left: auto; color: var(--tenue); font-size: 12px; }
main { padding: 16px; max-width: 1200px; }
h1 { font-size: 18px; margin: 0 0 12px; }
h2 { font-size: 15px; margin: 0; }
a { color: var(--enlace); }
.tarjetas { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.tarjeta { border: 1px solid var(--borde); border-radius: 8px; padding: 12px 14px; }
.tarjeta header { padding: 0 0 8px; border: 0; justify-content: space-between; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
dt { color: var(--tenue); }
dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.cifra, td.cifra { font-variant-numeric: tabular-nums; }
time { white-space: nowrap; }
.id { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.tenue { color: var(--tenue); }
.etiqueta { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; }
.bien { color: var(--bien); } .mal { color: var(--mal); } .aviso { color: var(--aviso); }
.tabla { overflow-x: auto; border: 1px solid var(--borde); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--borde); vertical-align: top; }
th { background: var(--suave); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
form.filtros { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin-bottom: 12px; }
label { display: grid; gap: 2px; color: var(--tenue); font-size: 12px; }
select, button, input[type="search"] { font: inherit; padding: 4px 8px; color: var(--texto); background: var(--fondo); border: 1px solid var(--borde); border-radius: 6px; }
button { cursor: pointer; }
label.casilla { display: flex; gap: 6px; align-items: center; color: var(--texto); font-size: 14px; }
.paginas { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
.pestanas { display: flex; gap: 14px; margin-bottom: 12px; }
.pestanas a[aria-current="page"] { color: var(--texto); font-weight: 600; text-decoration: none; }
.lote { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin-top: 12px; padding: 10px 12px; border: 1px solid var(--borde); border-radius: 8px; background: var(--suave); }
.botones { display: flex; flex-wrap: wrap; gap: 6px; }
.aviso-accion { border: 1px solid currentColor; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
.aviso-accion ul { margin: 4px 0 0; padding-left: 18px; }
.foto { display: block; object-fit: contain; background: var(--suave); border-radius: 6px; }
.foto.chica { width: 48px; height: 48px; }
.foto.grande { width: 240px; height: 240px; }
.valores { display: grid; grid-template-columns: max-content 1fr; gap: 0 8px; font-size: 12px; }
.valores dt, .valores dd { font-size: 12px; }
.valores dd { overflow-wrap: normal; }
.nowrap { white-space: nowrap; }
.canonico { font-weight: 600; }
.distinto { color: var(--aviso); }
section.bloque { margin-top: 20px; }
section.bloque > h2 { margin-bottom: 8px; }
.ficha { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
`;

function avisoHtml(a: Aviso): Html {
  const clase = a.errores.length === 0 ? 'bien' : a.aplicadas === 0 ? 'mal' : 'aviso';
  return html`<div class="aviso-accion ${clase}" role="status">
    <strong>${a.accion}</strong>: <span class="cifra">${a.aplicadas}</span>
    ${a.aplicadas === 1 ? 'aplicada' : 'aplicadas'}${
      a.errores.length
        ? html`, <span class="cifra">${a.errores.length}</span> con error
            <ul>
              ${a.errores.map((e) => html`<li>${e}</li>`)}
            </ul>`
        : ''
    }.
    <span class="tenue"
      >Cambia el registro del conector; la siguiente pasada de escritura lo lleva a los sistemas, si
      está encendida.</span
    >
  </div>`;
}

export function pagina(m: Marco, cuerpo: Html): string {
  const item = (clave: Seccion) =>
    html`<a href="${m.base}${clave}" ${m.activa === clave ? html` aria-current="page"` : ''}
      >${SECCIONES[clave]}</a
    >`;
  return html`<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>${m.titulo} · Conector</title>
        <style>
          ${new Html(ESTILOS)}
        </style>
      </head>
      <body>
        <header>
          <strong>Conector</strong>
          <nav>${(Object.keys(SECCIONES) as Seccion[]).map(item)}</nav>
          ${m.usuario ? html`<span class="usuario">viendo como ${m.usuario}</span>` : ''}
        </header>
        <main>${m.aviso ? avisoHtml(m.aviso) : ''}${cuerpo}</main>
      </body>
    </html> `.valor;
}
