import { describe, expect, it } from 'vitest';
import { leerConfig } from './config.js';

const BASE = {
  COREINBOX_URL: 'https://ci.example.com/',
  COREINBOX_API_KEY: 'cik_prueba',
  EMITE_URL: 'http://app:3000',
  EMITE_API_KEY: 'edte_prueba',
  EMITE_EMISOR_ID: '11111111-1111-1111-1111-111111111111',
  EMITE_WEBHOOK_SECRET: 'whsec_prueba',
  DESDE: '2026-01-01T00:00:00Z',
};

describe('leerConfig: flujos', () => {
  it('por omisión sólo corre el de cotizaciones, sin avisos ni tienda', () => {
    const c = leerConfig({ ...BASE });
    expect(c.flujos).toEqual({ cotizaciones: true, productos: false, pedidos: false });
    expect(c.avisos).toEqual([]);
    expect(c.woocommerce).toBeNull();
    expect(c.coreinbox.url).toBe('https://ci.example.com');
  });

  it('cada flujo se enciende y se apaga con su variable', () => {
    const c = leerConfig({ ...BASE, FLUJO_COTIZACIONES: 'false', FLUJO_PRODUCTOS: 'sí' });
    expect(c.flujos).toEqual({ cotizaciones: false, productos: true, pedidos: false });
  });

  it('un valor que no es sí ni no falla al arrancar', () => {
    expect(() => leerConfig({ ...BASE, FLUJO_PRODUCTOS: 'quizás' })).toThrow(/FLUJO_PRODUCTOS/);
  });

  it('SINCRONIZAR_PRODUCTOS sigue funcionando como alias, con aviso', () => {
    const encendido = leerConfig({ ...BASE, SINCRONIZAR_PRODUCTOS: 'true' });
    expect(encendido.flujos.productos).toBe(true);
    expect(encendido.avisos).toEqual([expect.stringMatching(/SINCRONIZAR_PRODUCTOS.*obsoleta/)]);

    // Como antes: cualquier otro valor la deja apagada, sin fallar.
    const apagado = leerConfig({ ...BASE, SINCRONIZAR_PRODUCTOS: 'nop' });
    expect(apagado.flujos.productos).toBe(false);
    expect(apagado.avisos).toHaveLength(1);
  });

  it('FLUJO_PRODUCTOS manda sobre el alias', () => {
    const c = leerConfig({ ...BASE, SINCRONIZAR_PRODUCTOS: 'true', FLUJO_PRODUCTOS: 'false' });
    expect(c.flujos.productos).toBe(false);
    expect(c.avisos).toEqual([expect.stringMatching(/se ignora/)]);
  });

  it('FLUJO_PEDIDOS encendido se ignora con aviso: todavía no existe', () => {
    const c = leerConfig({ ...BASE, FLUJO_PEDIDOS: 'true' });
    expect(c.flujos.pedidos).toBe(false);
    expect(c.avisos).toEqual([expect.stringMatching(/no está implementado/)]);
  });
});

describe('leerConfig: WooCommerce', () => {
  it('es opcional mientras ningún flujo la use', () => {
    const c = leerConfig({
      ...BASE,
      WOO_URL: 'https://tienda.example.com/',
      WOO_CONSUMER_KEY: 'ck_prueba',
      WOO_CONSUMER_SECRET: 'cs_prueba',
    });
    expect(c.woocommerce).toEqual({
      url: 'https://tienda.example.com',
      consumerKey: 'ck_prueba',
      consumerSecret: 'cs_prueba',
    });
  });

  it('a medias o sin HTTPS falla al arrancar', () => {
    expect(() => leerConfig({ ...BASE, WOO_URL: 'https://tienda.example.com' })).toThrow(
      /WOO_CONSUMER_KEY/,
    );
    expect(() =>
      leerConfig({
        ...BASE,
        WOO_URL: 'http://tienda.example.com',
        WOO_CONSUMER_KEY: 'ck_prueba',
        WOO_CONSUMER_SECRET: 'cs_prueba',
      }),
    ).toThrow(/https/i);
  });
});

describe('leerConfig: catálogo', () => {
  it('PRODUCTOS_ESCRIBIR viene apagado por omisión', () => {
    expect(leerConfig({ ...BASE }).productos.escribir).toBe(false);
  });

  it('PRODUCTOS_ESCRIBIR=true lo enciende', () => {
    expect(leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR: 'true' }).productos.escribir).toBe(true);
  });

  it('un valor inválido en PRODUCTOS_ESCRIBIR falla al arrancar', () => {
    expect(() => leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR: 'quizas' })).toThrow(
      /PRODUCTOS_ESCRIBIR/,
    );
  });

  it('PRODUCTOS_ESCRIBIR_SISTEMAS vacía son los tres', () => {
    expect(leerConfig({ ...BASE }).productos.sistemas).toEqual([
      'coreinbox',
      'woocommerce',
      'emite',
    ]);
    expect(leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR_SISTEMAS: ' ' }).productos.sistemas).toEqual([
      'coreinbox',
      'woocommerce',
      'emite',
    ]);
  });

  it('PRODUCTOS_ESCRIBIR_SISTEMAS elige sistemas, sin importar orden ni mayúsculas', () => {
    expect(
      leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR_SISTEMAS: 'emite' }).productos.sistemas,
    ).toEqual(['emite']);
    expect(
      leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR_SISTEMAS: 'Emite, coreinbox' }).productos.sistemas,
    ).toEqual(['coreinbox', 'emite']);
  });

  it('un sistema desconocido en PRODUCTOS_ESCRIBIR_SISTEMAS falla al arrancar', () => {
    expect(() => leerConfig({ ...BASE, PRODUCTOS_ESCRIBIR_SISTEMAS: 'emite,web' })).toThrow(
      /PRODUCTOS_ESCRIBIR_SISTEMAS.*web/,
    );
  });

  it('CATALOGO_API_KEY ausente o en blanco queda en null', () => {
    expect(leerConfig({ ...BASE }).catalogoApiKey).toBeNull();
    expect(leerConfig({ ...BASE, CATALOGO_API_KEY: '   ' }).catalogoApiKey).toBeNull();
  });

  it('CATALOGO_API_KEY se recorta', () => {
    expect(leerConfig({ ...BASE, CATALOGO_API_KEY: '  clave_prueba  ' }).catalogoApiKey).toBe(
      'clave_prueba',
    );
  });
});
