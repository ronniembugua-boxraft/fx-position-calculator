/**
 * instruments.js - contract specifications.
 *
 * EVERY FIELD HERE IS A DEFAULT, NOT A FACT. Contract sizes genuinely differ between brokers:
 * US30 ships at 0.10, 1, 5, 10, 20 and 25 USD per point depending on the book; WTI is 1000 barrels
 * at most brokers and 100 at others; NATGAS is 10,000 or 1,000 MMBtu. Each of those is a silent
 * 10x or 100x sizing error. The app therefore lets every field be overridden per instrument and
 * always shows its derivation, so the number can be checked against a broker's contract spec page.
 *
 * marginMode/marginValue are null by default, meaning "inherit the account leverage". Regulated
 * books quote a margin percentage per instrument instead of one global ratio, so both are supported.
 */
import { FX, INDEX, ENERGY } from './calc.js';

const fx = (symbol, base, quote, jpy = false) => ({
  symbol, name: `${base}/${quote}`, base, quote, type: FX,
  contractSize: 100000, pipSize: jpy ? 0.01 : 0.0001, digits: jpy ? 3 : 5,
  minLot: 0.01, lotStep: 0.01, maxLot: 100,
  marginMode: null, marginValue: null,
  regulatedCap: 'FCA/ESMA cap 1:30 majors, 1:20 minors',
});

const cfd = (symbol, name, quote, type, contractSize, pipSize, digits, unit, cap) => ({
  symbol, name, base: symbol, quote, type, contractSize, pipSize, digits,
  minLot: 0.01, lotStep: 0.01, maxLot: 100,
  marginMode: null, marginValue: null, unit, regulatedCap: cap,
});

export const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD'];

export const INSTRUMENTS = [
  // --- majors ---
  fx('EURUSD', 'EUR', 'USD'), fx('GBPUSD', 'GBP', 'USD'), fx('USDJPY', 'USD', 'JPY', true),
  fx('USDCHF', 'USD', 'CHF'), fx('USDCAD', 'USD', 'CAD'), fx('AUDUSD', 'AUD', 'USD'),
  fx('NZDUSD', 'NZD', 'USD'),
  // --- crosses ---
  fx('EURGBP', 'EUR', 'GBP'), fx('EURJPY', 'EUR', 'JPY', true), fx('EURCHF', 'EUR', 'CHF'),
  fx('EURAUD', 'EUR', 'AUD'), fx('EURNZD', 'EUR', 'NZD'), fx('EURCAD', 'EUR', 'CAD'),
  fx('GBPJPY', 'GBP', 'JPY', true), fx('GBPCHF', 'GBP', 'CHF'), fx('GBPAUD', 'GBP', 'AUD'),
  fx('GBPNZD', 'GBP', 'NZD'), fx('GBPCAD', 'GBP', 'CAD'),
  fx('AUDJPY', 'AUD', 'JPY', true), fx('AUDCHF', 'AUD', 'CHF'), fx('AUDNZD', 'AUD', 'NZD'),
  fx('AUDCAD', 'AUD', 'CAD'),
  fx('NZDJPY', 'NZD', 'JPY', true), fx('NZDCHF', 'NZD', 'CHF'), fx('NZDCAD', 'NZD', 'CAD'),
  fx('CADJPY', 'CAD', 'JPY', true), fx('CADCHF', 'CAD', 'CHF'), fx('CHFJPY', 'CHF', 'JPY', true),
  // --- indices: settle in their home currency, so a USD account converts on every one but US*/NAS/SPX ---
  cfd('US30', 'Dow Jones 30', 'USD', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  cfd('NAS100', 'Nasdaq 100', 'USD', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  cfd('SPX500', 'S&P 500', 'USD', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  cfd('GER40', 'DAX 40', 'EUR', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  cfd('UK100', 'FTSE 100', 'GBP', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  cfd('JP225', 'Nikkei 225', 'JPY', INDEX, 1, 1, 2, 'per point', 'FCA/ESMA cap 1:20'),
  // --- energies ---
  cfd('XTIUSD', 'WTI Crude Oil', 'USD', ENERGY, 1000, 0.01, 2, 'barrels', 'FCA/ESMA cap 1:10'),
  cfd('XBRUSD', 'Brent Crude Oil', 'USD', ENERGY, 1000, 0.01, 2, 'barrels', 'FCA/ESMA cap 1:10'),
  cfd('XNGUSD', 'Natural Gas', 'USD', ENERGY, 10000, 0.001, 3, 'MMBtu', 'FCA/ESMA cap 1:10'),
];

export const GROUPS = [
  { id: 'majors', label: 'Majors', match: (i) => MAJORS.includes(i.symbol) },
  { id: 'crosses', label: 'Crosses', match: (i) => i.type === FX && !MAJORS.includes(i.symbol) },
  { id: 'indices', label: 'Indices', match: (i) => i.type === INDEX },
  { id: 'energies', label: 'Energies', match: (i) => i.type === ENERGY },
];

/** Currencies the app must be able to convert between; drives rate validation. */
export const ACCOUNT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'KES', 'ZAR', 'NGN', 'INR', 'AED'];

export function findInstrument(symbol, overrides = {}) {
  const base = INSTRUMENTS.find((i) => i.symbol === symbol);
  if (!base) return null;
  return overrides[symbol] ? { ...base, ...overrides[symbol] } : base;
}

/** Human-readable derivation of one lot, so a 10x contract-size error is visible at a glance. */
export function describeLot(instrument, lots) {
  const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const units = lots * instrument.contractSize;
  if (instrument.type === FX) return `${lots} lot = ${fmt(units)} ${instrument.base}`;
  if (instrument.type === INDEX) return `${lots} lot = ${instrument.quote} ${fmt(units)} ${instrument.unit}`;
  return `${lots} lot = ${fmt(units)} ${instrument.unit}`;
}
