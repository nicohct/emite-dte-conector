/**
 * Pasada de escritura del catálogo (fase 1b): tras la lectura, lleva el canónico de cada SKU a los
 * sistemas habilitados (`PRODUCTOS_ESCRIBIR_SISTEMAS`). Ejecuta el plan que deja `calcularProducto`
 * (`escrituras` y `crearEn`) y los empates confirmados con los históricos de Emite DTE.
 *
 * - **Orden por SKU:** adoptar el histórico con el código exacto (empate confirmado), crear lo que
 *   falte del alcance (en Emite DTE y, si está aprobado, en la web; nunca en Coreinbox), fusionar
 *   los demás históricos confirmados en el canónico y escribir los campos que difieren.
 * - **Eco:** cada escritura anota `escritoValor` en el campo del sistema destino; la lectura
 *   siguiente que lo devuelve no es un cambio. Mientras no se vuelve a leer, no se reescribe.
 * - **Fallas:** una transitoria deja el SKU para la pasada siguiente y no se le escribe más a ese
 *   sistema en esta pasada; un 4xx queda como evento `error` con el mensaje, no se reintenta con
 *   los mismos datos y no frena a los demás. Una fusión rechazada (inventario) queda «requiere
 *   mano» en el SKU.
 * - **Nunca** se borra nada ni se cambia un código.
 */
import type { CategoriaCoreinbox, Coreinbox } from '../../adaptadores/coreinbox/cliente.js';
import { ErrorCoreinbox } from '../../adaptadores/coreinbox/cliente.js';
import type {
  CambiosProducto,
  EmiteDte,
  ProductoEmite,
  ProductoNuevo,
} from '../../adaptadores/emite/cliente.js';
import { ErrorEmite } from '../../adaptadores/emite/cliente.js';
import type { WooCommerce } from '../../adaptadores/woocommerce/cliente.js';
import { ErrorWoo } from '../../adaptadores/woocommerce/cliente.js';
import type { CambiosProductoWoo } from '../../adaptadores/woocommerce/tipos.js';
import type {
  CampoCatalogo,
  EscrituraPlaneada,
  EstadoEventoCatalogo,
  HistoricoEmite,
  Lectura,
  ProductoCatalogo,
  RegistroCatalogo,
  SistemaCatalogo,
  ValorCampo,
} from '../../estado-catalogo.js';
import type { Estado } from '../../estado.js';
import { log } from '../../log.js';
import { esTransitorio } from '../comun.js';
import { TASA_IVA, netoDesdeBruto } from './canonico.js';
import { desdeEmite, desdeWoo, horaUtc, recalcular, recalcularTodo } from './lectura.js';

export interface DependenciasEscritura {
  coreinbox: Coreinbox;
  emite: EmiteDte;
  woocommerce: WooCommerce | null;
  estado: Estado;
  emisorId: string;
  /** Dónde se escribe; en los demás sólo se lee. */
  sistemas: readonly SistemaCatalogo[];
  ahora?: () => Date;
}

export interface ResultadoEscritura {
  /** SKU a los que se les mandó alguna escritura. */
  revisados: number;
  /** Campos escritos (los revertidos aparte). */
  escritos: number;
  revertidos: number;
  creados: number;
  adoptados: number;
  fusionados: number;
  /** Rechazos (4xx): quedan como evento `error`. */
  conError: number;
  /** Fallas transitorias: quedan para la pasada siguiente. */
  pendientes: number;
}

type Resultado<T> = { ok: true; valor: T } | { ok: false };

const json = (v: unknown): string => JSON.stringify(v);

function mensajeDe(e: unknown): string {
  return e instanceof ErrorEmite || e instanceof ErrorCoreinbox || e instanceof ErrorWoo
    ? `${e.code}: ${e.message}`
    : String(e);
}

const codigoDe = (e: unknown): string | null =>
  e instanceof ErrorEmite || e instanceof ErrorCoreinbox || e instanceof ErrorWoo ? e.code : null;

const usoDe = (h: HistoricoEmite): [number, number] => {
  const u = h.uso as { documentos?: number; cantidad?: number } | null;
  return [u?.documentos ?? 0, u?.cantidad ?? 0];
};

const texto = (v: ValorCampo): string => (v === null ? '—' : String(v));

export async function pasadaEscritura(d: DependenciasEscritura): Promise<ResultadoEscritura> {
  const en = (d.ahora ?? (() => new Date()))().toISOString();
  const registro = d.estado.catalogo;
  const r: ResultadoEscritura = {
    revisados: 0,
    escritos: 0,
    revertidos: 0,
    creados: 0,
    adoptados: 0,
    fusionados: 0,
    conError: 0,
    pendientes: 0,
  };
  // La primera escritura aplica el arranque y desde ahí rige «último cambio»: se recalcula todo.
  if (!registro.primeraEscritura()) {
    registro.iniciarEscritura(en);
    recalcularTodo(registro);
    log('info', 'primera escritura del catálogo', { sistemas: d.sistemas });
  }
  const caidos = new Set<SistemaCatalogo>();
  const intentados = new Set<string>();
  const habilitado = (s: SistemaCatalogo): boolean =>
    d.sistemas.includes(s) && !caidos.has(s) && (s !== 'woocommerce' || d.woocommerce !== null);

  const evento = (
    estado: EstadoEventoCatalogo,
    sku: string,
    sistema: SistemaCatalogo,
    datos: {
      campo?: CampoCatalogo | null;
      antes?: ValorCampo;
      valor?: ValorCampo;
      mensaje?: string | null;
      idExterno?: string | null;
      clave?: string | null;
    } = {},
  ) =>
    registro.registrarEvento({
      en,
      estado,
      sku,
      sistema,
      campo: datos.campo ?? null,
      antes: datos.antes ?? null,
      valor: datos.valor ?? null,
      mensaje: datos.mensaje ?? null,
      idExterno: datos.idExterno ?? null,
      clave: datos.clave ?? null,
    });

  /**
   * Corre una escritura en un sistema habilitado. Un 4xx queda como evento `error` con la carga y
   * la misma carga no se vuelve a mandar; una falla transitoria deja el sistema por esta pasada.
   */
  const operar = async <T>(
    op: {
      sku: string;
      sistema: SistemaCatalogo;
      operacion: string;
      carga: unknown;
      /** Lo que se hace además con un 4xx (una fusión, por ejemplo, queda «requiere mano»). */
      siRechaza?: (mensaje: string) => string;
    },
    f: () => Promise<T>,
  ): Promise<Resultado<T>> => {
    if (!habilitado(op.sistema)) return { ok: false };
    const clave = `${op.sku}|${op.sistema}|${op.operacion}`;
    const carga = json(op.carga);
    const previo = registro.ultimoEvento(clave);
    if (previo?.estado === 'error' && previo.valor === carga) return { ok: false };
    intentados.add(op.sku);
    try {
      return { ok: true, valor: await f() };
    } catch (e) {
      if (esTransitorio(e)) {
        caidos.add(op.sistema);
        r.pendientes++;
        log('warn', 'falla transitoria al escribir; se reintenta en la pasada siguiente', {
          sku: op.sku,
          sistema: op.sistema,
          operacion: op.operacion,
          error: String(e),
        });
        return { ok: false };
      }
      const base = mensajeDe(e);
      const mensaje = op.siRechaza ? op.siRechaza(base) : base;
      r.conError++;
      evento('error', op.sku, op.sistema, { mensaje, valor: carga, clave });
      log('error', 'un sistema rechazó la escritura', {
        sku: op.sku,
        sistema: op.sistema,
        operacion: op.operacion,
        error: mensaje,
      });
      return { ok: false };
    }
  };

  /** Guarda lo que devolvió el sistema al crear o adoptar, como su lectura, y lo marca escrito. */
  const quedarCon = (lectura: Lectura, campos: readonly CampoCatalogo[]) => {
    registro.guardarLectura(lectura, [], en);
    for (const campo of campos) {
      registro.marcarEscrito(lectura.sku, lectura.sistema, campo, lectura.campos[campo], en);
    }
  };

  let categorias: Map<string, CategoriaCoreinbox> | null = null;
  const categoriaCoreinbox = async (nombre: string): Promise<string | null> => {
    categorias ??= new Map((await d.coreinbox.categorias()).map((c) => [c.name.trim(), c]));
    return categorias.get(nombre.trim())?.id ?? null;
  };

  // --- Emite DTE: adoptar, crear y fusionar ---

  const netoEmite = (p: ProductoCatalogo, bruto: number, exento?: boolean): number =>
    netoDesdeBruto(bruto, (exento ?? p.canonico.exento?.valor === true) ? 0 : TASA_IVA);

  const crearEnEmite = async (p: ProductoCatalogo): Promise<string | null> => {
    const c = p.canonico;
    const nombre = c.nombre?.valor;
    const precio = c.precio?.valor;
    if (typeof nombre !== 'string' || typeof precio !== 'number') return null;
    const unidad = registro.lecturas(p.sku).coreinbox?.extra.unidad;
    const categoria = c.categoria?.valor;
    const datos: ProductoNuevo = {
      emisorId: d.emisorId,
      codigo: p.sku,
      nombre,
      precioNeto: netoEmite(p, precio),
      tipo: c.tipo?.valor === 'servicio' ? 'servicio' : 'bien',
      exento: c.exento?.valor === true,
      activo: c.activo?.valor !== false,
      ...(typeof unidad === 'string' ? { unidad } : {}),
      ...(typeof categoria === 'string' ? { categoria } : {}),
    };
    const creado = await operar(
      { sku: p.sku, sistema: 'emite', operacion: 'crear', carga: datos },
      async (): Promise<ProductoEmite> => {
        try {
          return await d.emite.crearProducto(datos);
        } catch (e) {
          // Ya existía con ese código (alguien lo creó entre la lectura y ahora): se toma ése.
          if (codigoDe(e) !== 'PRODUCTO_DUPLICADO') throw e;
          const ya = await d.emite.productoPorCodigo(d.emisorId, p.sku);
          if (!ya || ya.codigo.trim() !== p.sku || ya.origen === 'historial') throw e;
          return ya;
        }
      },
    );
    if (!creado.ok) return null;
    quedarCon(desdeEmite(d.emite, creado.valor, p.sku, en).lectura, [
      'nombre',
      'precio',
      'activo',
      'tipo',
      'categoria',
    ]);
    r.creados++;
    evento('creado', p.sku, 'emite', {
      idExterno: creado.valor.id,
      mensaje: `creado en Emite DTE con el código ${p.sku}`,
    });
    log('info', 'producto creado en Emite DTE', { sku: p.sku, emiteId: creado.valor.id });
    return creado.valor.id;
  };

  const empates = async (p: ProductoCatalogo): Promise<boolean> => {
    const pendientes = registro
      .empatesDeSku(p.sku)
      .filter((e) => e.estado === 'confirmado' && e.resultado === null)
      .map((e) => ({ e, h: registro.historico(e.emiteId) }))
      .filter((x): x is { e: typeof x.e; h: HistoricoEmite } => Boolean(x.h && !x.h.fusionadoEnId));
    if (pendientes.length === 0 || !habilitado('emite')) return false;

    let destino = registro.lecturas(p.sku).emite?.idExterno ?? null;
    let adoptado: string | null = null;
    // Con el código exacto se adopta (el de más uso, si hay varios); los demás se fusionan en él.
    const exacto = pendientes
      .filter((x) => x.h.codigo.trim() === p.sku)
      .sort((a, b) => {
        const [da, ca] = usoDe(a.h);
        const [db, cb] = usoDe(b.h);
        return db - da || cb - ca || a.h.emiteId.localeCompare(b.h.emiteId);
      })[0];
    if (!destino && exacto) {
      const nombre = p.canonico.nombre?.valor;
      const precio = p.canonico.precio?.valor;
      const cambios: CambiosProducto = {
        ...(typeof nombre === 'string' ? { nombre } : {}),
        ...(typeof precio === 'number' ? { precioNeto: netoEmite(p, precio) } : {}),
      };
      const hecho = await operar(
        { sku: p.sku, sistema: 'emite', operacion: `adoptar|${exacto.h.emiteId}`, carga: cambios },
        () => d.emite.actualizarProducto(exacto.h.emiteId, cambios),
      );
      if (!hecho.ok) return true;
      quedarCon(
        desdeEmite(d.emite, hecho.valor, p.sku, en).lectura,
        Object.keys(cambios).length > 0 ? ['nombre', 'precio'] : [],
      );
      registro.marcarResultadoEmpate(exacto.h.emiteId, p.sku, 'adoptado', null, en);
      adoptado = exacto.h.emiteId;
      destino = hecho.valor.id;
      r.adoptados++;
      evento('adoptado', p.sku, 'emite', {
        idExterno: exacto.h.emiteId,
        mensaje: `el histórico ${exacto.h.codigo} pasa a ser el producto de Emite DTE de ${p.sku}`,
      });
      log('info', 'histórico adoptado', { sku: p.sku, emiteId: exacto.h.emiteId });
    }
    if (!destino) {
      recalcular(registro, p.sku);
      const ahora = registro.producto(p.sku);
      if (!ahora?.crearEn?.includes('emite')) return true;
      destino = await crearEnEmite(ahora);
      if (!destino) return true;
    }

    for (const { h } of pendientes) {
      if (h.emiteId === adoptado || h.emiteId === destino) continue;
      const fusion = { emisorId: d.emisorId, destinoId: destino, origenIds: [h.emiteId] };
      let rechazo: string | null = null;
      const hecho = await operar(
        {
          sku: p.sku,
          sistema: 'emite',
          operacion: `fusionar|${h.emiteId}`,
          carga: fusion,
          siRechaza: (m) => {
            rechazo = m;
            return `Requiere mano: no se pudo fusionar el histórico ${h.codigo} (${m})`;
          },
        },
        () => d.emite.fusionarProductos(fusion),
      );
      if (rechazo !== null) {
        registro.marcarResultadoEmpate(h.emiteId, p.sku, 'requiere_mano', rechazo, en);
      }
      if (!hecho.ok) continue;
      const { aliasSku: _alias, ...resto } = h;
      registro.guardarHistorico({ ...resto, fusionadoEnId: destino, activo: false, leidoEn: en });
      registro.marcarResultadoEmpate(h.emiteId, p.sku, 'fusionado', null, en);
      r.fusionados++;
      evento('fusionado', p.sku, 'emite', {
        idExterno: h.emiteId,
        mensaje: `el histórico ${h.codigo} quedó fusionado en ${p.sku}`,
      });
      log('info', 'histórico fusionado', { sku: p.sku, emiteId: h.emiteId, destino });
    }
    return true;
  };

  // --- La web: crear lo aprobado que falte ---

  const crearEnWeb = async (p: ProductoCatalogo): Promise<void> => {
    const woo = d.woocommerce;
    const nombre = p.canonico.nombre?.valor;
    if (!woo || typeof nombre !== 'string') return;
    const precio = p.canonico.precio?.valor;
    const publicar = p.visibilidadWeb === 'aprobado' && p.canonico.activo?.valor === true;
    const datos = {
      name: nombre,
      sku: p.sku,
      type: 'simple' as const,
      regular_price: typeof precio === 'number' ? String(precio) : '',
      status: publicar ? ('publish' as const) : ('draft' as const),
    };
    const creado = await operar(
      { sku: p.sku, sistema: 'woocommerce', operacion: 'crear', carga: datos },
      () => woo.crearProducto(datos),
    );
    if (!creado.ok) return;
    const { lectura } = desdeWoo(
      woo,
      creado.valor,
      p.sku,
      horaUtc(creado.valor.date_modified_gmt),
      en,
    );
    quedarCon(lectura, ['nombre', 'precio', 'activo']);
    r.creados++;
    evento('creado', p.sku, 'woocommerce', {
      idExterno: String(creado.valor.id),
      mensaje: `creado en la web ${publicar ? 'publicado' : 'en borrador'}`,
    });
    log('info', 'producto creado en la web', { sku: p.sku, id: creado.valor.id, publicar });
  };

  // --- Campos ---

  const escribirCampos = async (
    p: ProductoCatalogo,
    sistema: SistemaCatalogo,
    plan: EscrituraPlaneada[],
  ): Promise<void> => {
    const lectura = registro.lecturas(p.sku)[sistema];
    if (!lectura) return;
    // Lo ya escrito que todavía no se volvió a leer no se manda de nuevo.
    const porEscribir = plan.filter((w) => {
      const c = lectura.campos[w.campo];
      return !(
        c?.escritoEn &&
        Date.parse(c.escritoEn) >= Date.parse(lectura.leidoEn) &&
        json(c.escritoValor) === json(eco(sistema, w, lectura.extra))
      );
    });
    if (porEscribir.length === 0) return;

    let carga: unknown;
    let escribir: () => Promise<unknown>;
    if (sistema === 'coreinbox') {
      const cambios: Record<string, unknown> = {};
      for (const w of porEscribir) {
        if (w.campo === 'nombre') cambios.name = w.valor;
        if (w.campo === 'precio' && typeof w.valor === 'number') {
          const tasa = typeof lectura.extra.tasa === 'number' ? lectura.extra.tasa : TASA_IVA;
          cambios.unitPrice = netoDesdeBruto(w.valor, tasa);
        }
        if (w.campo === 'activo') cambios.isActive = w.valor;
        if (w.campo === 'categoria' && typeof w.valor === 'string') {
          const id = await categoriaCoreinbox(w.valor);
          if (id) cambios.categoryId = id;
        }
      }
      carga = cambios;
      escribir = () => d.coreinbox.actualizarProducto(lectura.idExterno, cambios);
    } else if (sistema === 'woocommerce') {
      const woo = d.woocommerce;
      if (!woo) return;
      const cambios: CambiosProductoWoo = {};
      for (const w of porEscribir) {
        if (w.campo === 'nombre' && typeof w.valor === 'string') cambios.name = w.valor;
        if (w.campo === 'precio' && typeof w.valor === 'number') {
          cambios.regular_price = String(w.valor);
        }
        if (w.campo === 'activo') cambios.status = w.valor === true ? 'publish' : 'draft';
      }
      carga = cambios;
      escribir = () => woo.actualizarProducto(Number(lectura.idExterno), cambios);
    } else {
      const cambios: CambiosProducto = {};
      const exento = lectura.campos.exento?.valor === true;
      for (const w of porEscribir) {
        if (w.campo === 'nombre' && typeof w.valor === 'string') cambios.nombre = w.valor;
        if (w.campo === 'precio' && typeof w.valor === 'number') {
          cambios.precioNeto = netoEmite(p, w.valor, exento);
        }
        if (w.campo === 'activo' && typeof w.valor === 'boolean') cambios.activo = w.valor;
        if (w.campo === 'tipo' && (w.valor === 'bien' || w.valor === 'servicio')) {
          cambios.tipo = w.valor;
        }
        if (w.campo === 'categoria' && typeof w.valor === 'string') cambios.categoria = w.valor;
      }
      carga = cambios;
      escribir = () => d.emite.actualizarProducto(lectura.idExterno, cambios);
    }
    if (Object.keys(carga as object).length === 0) return;

    const hecho = await operar({ sku: p.sku, sistema, operacion: 'campos', carga }, escribir);
    if (!hecho.ok) return;
    const clave = `${p.sku}|${sistema}|campos`;
    for (const w of porEscribir) {
      registro.marcarEscrito(p.sku, sistema, w.campo, eco(sistema, w, lectura.extra), en);
      if (w.revierte) r.revertidos++;
      else r.escritos++;
      evento(w.revierte ? 'revertido' : 'escrito', p.sku, sistema, {
        campo: w.campo,
        antes: w.antes,
        valor: w.valor,
        mensaje: `${w.campo}: ${texto(w.antes)} → ${texto(w.valor)}`,
        idExterno: lectura.idExterno,
        clave,
      });
    }
    log('info', 'catálogo escrito', {
      sku: p.sku,
      sistema,
      campos: porEscribir.map((w) => w.campo),
    });
  };

  // --- Por SKU ---

  const conEmpates = new Set(
    registro
      .empates('confirmado')
      .filter((e) => e.resultado === null)
      .map((e) => e.sku),
  );
  for (const sku of registro.skus()) {
    let p = registro.producto(sku);
    if (!p) continue;
    const hayTrabajo =
      conEmpates.has(sku) || (p.escrituras?.length ?? 0) > 0 || (p.crearEn?.length ?? 0) > 0;
    if (!hayTrabajo) continue;

    if (conEmpates.has(sku) && (await empates(p))) {
      recalcular(registro, sku);
      p = registro.producto(sku) ?? p;
    }
    if (p.crearEn?.includes('emite') && habilitado('emite')) await crearEnEmite(p);
    if (p.crearEn?.includes('woocommerce') && habilitado('woocommerce')) await crearEnWeb(p);
    recalcular(registro, sku);
    p = registro.producto(sku) ?? p;

    for (const sistema of ['coreinbox', 'woocommerce', 'emite'] as const) {
      const plan = (p.escrituras ?? []).filter((w) => w.sistema === sistema);
      if (plan.length > 0 && habilitado(sistema)) await escribirCampos(p, sistema, plan);
    }
    recalcular(registro, sku);
  }
  r.revisados = intentados.size;
  return r;
}

/**
 * Lo que el sistema devolverá en ese campo después de escribirlo. En la web `activo` es publicado
 * y no oculto del catálogo.
 */
function eco(sistema: SistemaCatalogo, w: EscrituraPlaneada, extra: Record<string, unknown>) {
  if (sistema === 'woocommerce' && w.campo === 'activo') {
    return w.valor === true && extra.visibilidad !== 'hidden';
  }
  return w.valor;
}
