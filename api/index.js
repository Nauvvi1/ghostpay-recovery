/**
 * Vercel serverless function — handles all /api/* routes.
 *
 * Vercel routes /api/* to this file via vercel.json rewrites.
 * The repository is opened once per cold start and reused across warm
 * invocations via the module-scoped singleton in repository-turso.js.
 */

import { openTursoRepository } from './lib/repository-turso.js';
import { handleRequest } from './lib/handler.js';

let repo = null;

async function getRepo() {
  if (!repo) {
    repo = openTursoRepository();
    await repo.initSchema();
  }
  return repo;
}

export default async function handler(req, res) {
  try {
    const r = await getRepo();
    await handleRequest(req, res, r);
  } catch (error) {
    console.error('[GhostPay]', error.message);
    if (!res.headersSent) {
      res.status(error.httpStatus || 500).json({
        error: error.httpStatus ? error.message : 'Internal error',
      });
    }
  }
}
