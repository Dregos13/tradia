/* global process, require, URL */
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Arranque del recorrido «datos desactualizados» (docs/qa/datos-desactualizados.md).
 * Se carga con NODE_OPTIONS=--require antes del proceso principal de Tradia
 * y NO activa el modo E2E: la app usa sus proveedores reales (Tiingo, FRED).
 *
 * - QA_USER_DATA: userData temporal (la app sin TRADIA_E2E no admite otro).
 * - QA_FAKE_NOW: instante ISO en que arranca el reloj del proceso principal
 *   (sigue corriendo desde ahí). Sin la variable, reloj real.
 * - QA_PROVIDER_MOCK: URL base del servidor local que imita a Tiingo y FRED;
 *   solo se desvían api.tiingo.com y api.stlouisfed.org, el resto va a la red.
 */
const { app } = require('electron');

if (process.env.QA_USER_DATA) app.setPath('userData', process.env.QA_USER_DATA);

if (process.env.QA_FAKE_NOW) {
  const RealDate = Date;
  const offset = RealDate.parse(process.env.QA_FAKE_NOW) - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FakeDate;
}

if (process.env.QA_PROVIDER_MOCK) {
  const mock = process.env.QA_PROVIDER_MOCK.replace(/\/+$/, '');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.hostname === 'api.tiingo.com') {
      return realFetch(`${mock}/tiingo-api${url.pathname}${url.search}`, init);
    }
    if (url.hostname === 'api.stlouisfed.org') {
      return realFetch(`${mock}/fred-api${url.pathname}${url.search}`, init);
    }
    return realFetch(input, init);
  };
}
