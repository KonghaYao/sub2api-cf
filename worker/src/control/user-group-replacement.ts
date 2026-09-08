import type { Context } from 'hono'
import type { Env } from '../env'
import { asGatewayError, GatewayError } from '../gateway/errors'
import { controlError,controlSuccess,readJsonObject,requireResourceId } from './http'

export async function replaceAdminUserGroup(c: Context<{ Bindings: Env }>) {
  try {
    const body = await readJsonObject(c.req.raw), userId = requireResourceId(c.req.param('id'),'user')
    const id = (value: unknown) => requireResourceId(typeof value === 'string' ? value : Number.isSafeInteger(value) && Number(value)>0 ? String(value) : undefined,'group')
    const oldGroup = id(body.old_group_id), newGroup = id(body.new_group_id)
    if (oldGroup === newGroup) throw new GatewayError(400,'SAME_GROUP','Old and new group must be different')
    const group = await c.env.DB.prepare('SELECT enabled,is_exclusive,group_type FROM "groups" WHERE id=? AND deleted_at_ms IS NULL').bind(newGroup)
      .first<{ enabled: number; is_exclusive: number; group_type: string }>()
    if (!group) throw new GatewayError(404,'group_not_found','Group not found')
    if (!group.enabled) throw new GatewayError(400,'GROUP_NOT_ACTIVE','Target group is not active')
    if (!group.is_exclusive) throw new GatewayError(400,'GROUP_NOT_EXCLUSIVE','Target group is not exclusive')
    if (group.group_type === 'subscription') throw new GatewayError(400,'GROUP_IS_SUBSCRIPTION','Subscription groups are not supported for replacement')
    const user = await c.env.DB.prepare('SELECT control_version FROM users WHERE id=?').bind(userId).first<{ control_version: number }>()
    if (!user) throw new GatewayError(404,'user_not_found','User not found')
    const now = Date.now()
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE users SET control_version=CASE WHEN control_version=? AND EXISTS
        (SELECT 1 FROM "groups" WHERE id=? AND deleted_at_ms IS NULL AND enabled=1 AND is_exclusive=1 AND group_type='standard')
        THEN control_version+1 ELSE -1 END,updated_at_ms=? WHERE id=?`).bind(user.control_version,newGroup,now,userId),
      c.env.DB.prepare('INSERT OR IGNORE INTO user_group_permissions(user_id,group_id,created_at_ms) VALUES (?,?,?)').bind(userId,newGroup,now),
      c.env.DB.prepare(`UPDATE api_keys SET group_id=?,control_version=control_version+1,updated_at_ms=?
        WHERE user_id=? AND group_id=? AND revoked_at_ms IS NULL RETURNING id`).bind(newGroup,now,userId,oldGroup),
      // Original invalidates authentication caches for every non-deleted key owned by this user.
      c.env.DB.prepare('UPDATE api_keys SET auth_version=auth_version+1 WHERE user_id=? AND revoked_at_ms IS NULL').bind(userId),
      c.env.DB.prepare('DELETE FROM user_group_permissions WHERE user_id=? AND group_id=?').bind(userId,oldGroup),
    ])
    return controlSuccess({ migrated_keys: results[2]!.results.length })
  } catch (e) {
    if (e instanceof Error && /CHECK constraint failed:.*control_version|FOREIGN KEY constraint failed/.test(e.message)) {
      return controlError(new GatewayError(409,'group_replacement_conflict','User or group changed; reload and retry'))
    }
    return controlError(asGatewayError(e))
  }
}
