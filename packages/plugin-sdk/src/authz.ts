/**
 * GL3 authorization: role → module grants → this check. A player's role
 * (players.roleId → role_module_access rows) yields a list of module keys;
 * a grant for the module or the V2-preserved `*` wildcard passes.
 *
 * Deny-by-default: no role means no grants means false; an unknown module
 * key matches nothing.
 *
 * Future (deliberately not plumbed — see the design doc): the ABAC gist this
 * takes inspiration from allows `boolean | (user, data) => boolean` per
 * check. Every v1 check is a boolean grant; the predicate level lands with
 * its first real consumer, not before.
 */
export function hasPermission(grants: readonly string[], moduleKey: string): boolean {
  return grants.some((g) => g === moduleKey || g === "*");
}
