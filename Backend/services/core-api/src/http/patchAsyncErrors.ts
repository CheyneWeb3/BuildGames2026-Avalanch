/*
  Minimal replacement for the `express-async-errors` package.

  Express 4 does not automatically forward rejected promises / thrown errors
  from async route handlers to the error middleware.

  This patch wraps router handlers so any returned Promise rejection is
  forwarded to `next(err)`.
*/

import express from 'express';

type AnyFn = (...args: any[]) => any;

function wrapHandler(fn: AnyFn): AnyFn {
  // Only wrap functions (skip non-functions/middleware objects)
  if (typeof fn !== 'function') return fn;

  return function wrapped(this: any, ...args: any[]) {
    const next = args[2];
    try {
      const out = fn.apply(this, args);
      // If the handler returned a promise, forward rejections to next(err)
      if (out && typeof (out as any).catch === 'function') {
        (out as Promise<any>).catch(next);
      }
      return out;
    } catch (err) {
      return next(err);
    }
  };
}

const METHODS = [
  'all',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head'
] as const;

// Patch once at import-time
const proto: any = (express.Router as any).prototype;

for (const m of METHODS) {
  const orig = proto[m];
  if (typeof orig !== 'function') continue;

  proto[m] = function patched(this: any, ...args: any[]) {
    // Express API: (path, ...handlers)
    // Sometimes `path` omitted, so wrap every function in args.
    const wrapped = args.map(wrapHandler);
    return orig.apply(this, wrapped);
  };
}
