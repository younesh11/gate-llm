import { HttpError, type Row } from './store.ts';

export const isOperator = (user: Row) => user.role === 'owner' || user.role === 'admin';
export function requireOwner(user: Row) {
  if (user.role !== 'owner') throw new HttpError(403, 'Only workspace owners can make this change.');
}
export function requireOperator(user: Row) {
  if (!isOperator(user)) throw new HttpError(403, 'Only owners and admins can manage the workspace.');
}
export function requireManagePerson(actor: Row, target: Row) {
  requireOperator(actor);
  if (target.role === 'owner' || (target.role === 'admin' && actor.role !== 'owner'))
    throw new HttpError(403, 'Only owners can manage admins. Owner accounts cannot be changed here.');
}
