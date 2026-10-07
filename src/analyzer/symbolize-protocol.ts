/** Payload and per-frame result shapes shared by the symbolization API and its worker. Types only. */

export type SymbolizeRequest = {
  frames: { url: string; line: number; column: number }[];
};

export type SymbolizeResult =
  | { status: 'unchanged' }
  | { status: 'mapped'; url: string; line: number; column: number }
  | { status: 'malformed'; file: string; reason: string };
