/**
 * db/errors.ts — Shared typed errors for store-layer authorization guards.
 *
 * OwnershipError  — thrown when a non-owner attempts a destructive operation
 *                   on an asset with an assigned owner_username.
 * NotFoundError   — thrown by store methods when a requested record does not
 *                   exist, so route handlers get a typed signal rather than
 *                   having to inspect null returns.
 *
 * Both carry a statusCode so route catch blocks can map them to HTTP responses
 * without instanceof chains in every route file.
 */

export class OwnershipError extends Error {
  readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'OwnershipError';
  }
}

export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
