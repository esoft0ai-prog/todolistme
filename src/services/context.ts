import { today as todayFn } from '../domain/dates';
import type { ISODate } from '../domain/types';
import type { SqlDriver, SqlExecutor } from '../db/driver';

/**
 * Everything a service needs. Injected so services can be tested with an
 * in-memory database and a fixed clock.
 */
export interface ServiceContext {
  db: SqlDriver;
  today(): ISODate;
  now(): Date;
}

export function createContext(db: SqlDriver, clock?: { today(): ISODate; now(): Date }): ServiceContext {
  return {
    db,
    today: clock?.today ?? (() => todayFn()),
    now: clock?.now ?? (() => new Date()),
  };
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public fields: { field: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function throwIfErrors(errors: { field: string; message: string }[]): void {
  if (errors.length) throw new ValidationError(errors[0].message, errors[0].field, errors);
}

/** Placeholders for an IN (...) clause. */
export function inList(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

export type Exec = SqlExecutor;
