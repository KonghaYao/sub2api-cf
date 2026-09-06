import type { UserFinancialEventPayload, UserFinancialEventSource } from '../env'

type UserFinancialEventType = UserFinancialEventPayload['event_type']

const BALANCE_SOURCE_PREFIXES = [
  ['admin-balance:', 'admin_adjustment'],
  ['redeem:', 'redeem_code'],
  ['affiliate-transfer:', 'affiliate_transfer'],
  ['affiliate-refund-clawback:', 'affiliate_refund_clawback'],
  ['auth-source-grant:', 'auth_source_entitlement'],
] as const satisfies ReadonlyArray<readonly [string, UserFinancialEventSource]>

export function financialSourceForMutation(
  mutationId: string,
  eventType: UserFinancialEventType,
  requestId: string | null | undefined,
): Pick<UserFinancialEventPayload, 'source_type' | 'source_id'> {
  if (eventType === 'settlement') {
    return { source_type: 'usage_settlement', source_id: requestId ?? '' }
  }
  if (eventType === 'opening_balance') {
    const d1Prefix = 'd1-user:'
    return {
      source_type: 'opening_balance',
      source_id: mutationId.startsWith(d1Prefix) && mutationId.length > d1Prefix.length
        ? mutationId.slice(d1Prefix.length)
        : mutationId,
    }
  }
  for (const [prefix, sourceType] of BALANCE_SOURCE_PREFIXES) {
    if (mutationId.startsWith(prefix) && mutationId.length > prefix.length) {
      return { source_type: sourceType, source_id: mutationId.slice(prefix.length) }
    }
  }
  return { source_type: 'other_adjustment', source_id: mutationId }
}
