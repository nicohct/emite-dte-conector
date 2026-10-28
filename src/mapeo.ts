/**
 * Traducción pura de una cotización aceptada en Coreinbox al cuerpo de `POST /cotizaciones` de
 * Emite DTE. Sin red: lo que falta se pide antes y se pasa aquí.
 */
import type {
  AceptacionCoreinbox,
  ContactoCoreinbox,
  CotizacionCoreinbox,
  EmpresaCoreinbox,
  LineaCoreinbox,
} from './coreinbox.js';
import type { CotizacionEmite, ItemEmite, ReceptorCompleto } from './emite.js';

export const ORIGEN = 'coreinbox';

/** Un dato de la cotización que Emite DTE no puede recibir: se anota en el CRM, no se reintenta. */
export class ErrorMapeo extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ErrorMapeo';
  }
}

export interface EntradaMapeo {
  cotizacion: CotizacionCoreinbox;
  empresa: EmpresaCoreinbox | null;
  contacto: ContactoCoreinbox | null;
  /** SKU por `productId`, para que Emite DTE enlace la línea a su catálogo. */
  skus: Map<string, string>;
}

export interface ResultadoMapeo {
  /** Receptor sólo por RUT: respeta lo que ya hay en el catálogo de Emite DTE. */
  porRut: CotizacionEmite;
  /** Receptor completo: para cuando el RUT todavía no existe allá (`RECEPTOR_NO_EXISTE`). */
  completo: CotizacionEmite;
  receptor: ReceptorCompleto;
  avisos: string[];
}

const num = (v: string | number | null | undefined): number =>
  v === null || v === undefined || v === '' ? 0 : Number(v);
const corta = (s: string | null | undefined, largo: number): string | undefined => {
  const t = s?.trim();
  return t ? (t.length > largo ? t.slice(0, largo) : t) : undefined;
};

/** RUT como lo recibe Emite DTE: sin puntos, con guion y dígito verificador en mayúscula. */
export function normalizarRut(valor: string): string | null {
  const limpio = valor.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,8})-?([\dK])$/.exec(limpio);
  if (!m) return null;
  const cuerpo = m[1]!;
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return dv === m[2] ? `${cuerpo}-${dv}` : null;
}

export function armarCotizacion(entrada: EntradaMapeo, emisorId: string): ResultadoMapeo {
  const { cotizacion: q, empresa, contacto } = entrada;
  const avisos: string[] = [];

  if (q.currencyCode !== 'CLP') {
    throw new ErrorMapeo(
      'MONEDA',
      `La cotización ${q.quoteNumber} está en ${q.currencyCode}; Emite DTE factura sólo en pesos`,
    );
  }
  if (!empresa) {
    throw new ErrorMapeo('SIN_EMPRESA', `La cotización ${q.quoteNumber} no tiene empresa`);
  }
  const rut = empresa.taxId ? normalizarRut(empresa.taxId) : null;
  if (!rut) {
    throw new ErrorMapeo(
      'SIN_RUT',
      `La empresa «${empresa.name}» no tiene un RUT válido en Coreinbox (${empresa.taxId ?? 'vacío'})`,
    );
  }

  const nombreContacto = [contacto?.firstName, contacto?.lastName]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ');
  const receptor: ReceptorCompleto = {
    rut,
    razonSocial: corta(empresa.legalName, 100) ?? corta(empresa.name, 100) ?? rut,
    ...conValor('giro', corta(empresa.activityDescription, 40)),
    ...conValor(
      'direccion',
      corta([empresa.addressLine1, empresa.addressLine2].filter(Boolean).join(', '), 70),
    ),
    ...conValor('comuna', corta(empresa.admin2Name, 20)),
    ...conValor('ciudad', corta(empresa.city ?? empresa.admin1Name, 20)),
    ...conValor('contacto', corta(nombreContacto, 80)),
    ...conValor('correo', contacto?.email?.trim().toLowerCase() || undefined),
  };
  if (empresa.activityDescription && empresa.activityDescription.trim().length > 40) {
    avisos.push('El giro se acortó a 40 caracteres');
  }

  const items = lineasAceptadas(q, entrada.skus);
  if (items.length === 0) {
    throw new ErrorMapeo('SIN_LINEAS', `La cotización ${q.quoteNumber} no tiene líneas aceptadas`);
  }

  const condiciones = [q.termsAndConditions?.trim(), q.paymentTerms?.note?.trim()]
    .filter(Boolean)
    .join('\n\n');
  // Coreinbox usa el número como título cuando no hay otro; repetirlo no aporta.
  const titulo = q.title?.trim() && q.title.trim() !== q.quoteNumber ? q.title.trim() : '';
  const observaciones = [
    `Cotización ${q.quoteNumber} de Coreinbox${titulo ? ` · ${titulo}` : ''}`,
    q.acceptance?.note?.trim() ? `Nota del cliente al aceptar: ${q.acceptance.note.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let ordenCompra: CotizacionEmite['ordenCompra'];
  const po = q.acceptance?.poNumber?.trim();
  if (po) {
    if (po.length <= 18) ordenCompra = { numero: po };
    else
      avisos.push(
        `La OC «${po}» supera los 18 caracteres de la referencia 801; queda en las notas`,
      );
  }

  const base: Omit<CotizacionEmite, 'receptor'> = {
    emisorId,
    items,
    ...conValor('vigenteHasta', q.validUntil ? q.validUntil.slice(0, 10) : undefined),
    ...conValor('formaPago', formaPago(q.paymentTerms)),
    ...(q.discountMode === 'global' && num(q.discountPercent) > 0
      ? { descuentoGlobalPorcentaje: num(q.discountPercent) }
      : {}),
    ...conValor('condiciones', corta(condiciones, 2000)),
    observaciones: corta(
      ordenCompra || !po ? observaciones : `${observaciones}\nOC del cliente: ${po}`,
      2000,
    )!,
    ...conValor('ordenCompra', ordenCompra),
    origen: { nombre: ORIGEN, idExterno: q.id, numero: q.quoteNumber },
    estado: 'aceptada',
  };

  return {
    porRut: { ...base, receptor: { rut, ...conValor('contacto', receptor.contacto) } },
    completo: { ...base, receptor },
    receptor,
    avisos,
  };
}

function conValor<K extends string, V>(clave: K, valor: V | undefined): Partial<Record<K, V>> {
  return valor === undefined ? {} : ({ [clave]: valor } as Record<K, V>);
}

function formaPago(terminos: CotizacionCoreinbox['paymentTerms']): 1 | 2 | undefined {
  switch (terminos?.mode) {
    case 'contado':
      return 1;
    case 'credito':
    case 'suscripcion':
      return 2;
    default:
      return undefined;
  }
}

/**
 * Lo que el cliente compró: las líneas de la aceptación (cantidad, precio y descuento aceptados)
 * sobre los datos de la línea cotizada; sin aceptación detallada, las obligatorias más las
 * opcionales elegidas.
 */
function lineasAceptadas(q: CotizacionCoreinbox, skus: Map<string, string>): ItemEmite[] {
  const todas = q.sections.flatMap((s) => s.items).sort((a, b) => a.sortOrder - b.sortOrder);
  const porId = new Map(todas.map((l) => [l.id, l]));
  const aceptacion: AceptacionCoreinbox['lines'] = q.acceptance?.lines?.length
    ? q.acceptance.lines
    : todas
        .filter((l) => !l.isOptional || l.isSelectedByContact)
        .map((l) => ({
          quoteLineItemId: l.id,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPercent: l.discountPercent,
          discountAmount: l.discountAmount,
        }));
  return aceptacion
    .map((a) => {
      const linea = porId.get(a.quoteLineItemId);
      if (!linea) return null;
      return itemDesde(linea, a, skus.get(linea.productId ?? ''));
    })
    .filter((i): i is ItemEmite => i !== null && i.cantidad > 0);
}

function itemDesde(
  linea: LineaCoreinbox,
  aceptada: AceptacionCoreinbox['lines'][number],
  sku: string | undefined,
): ItemEmite {
  const cantidad = num(aceptada.quantity);
  const precio = num(aceptada.unitPrice);
  const pct = num(aceptada.discountPercent);
  const monto = num(aceptada.discountAmount);
  return {
    ...conValor('codigo', corta(sku, 35)),
    nombre: corta(linea.name, 80) ?? 'Ítem',
    ...conValor('descripcion', corta(linea.description, 1000)),
    cantidad,
    ...conValor('unidad', corta(linea.unit, 4)),
    precioUnitario: precio,
    // Emite DTE acepta % o monto por línea; Coreinbox guarda uno de los dos (el monto manda).
    ...(monto > 0 ? { descuentoMonto: monto } : pct > 0 ? { descuentoPorcentaje: pct } : {}),
    exento: linea.taxRate !== null && linea.taxRate !== undefined && num(linea.taxRate) === 0,
  };
}
