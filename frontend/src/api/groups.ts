/**
 * User Groups API endpoints (non-admin)
 * Handles group-related operations for regular users
 */

import { apiClient } from './client'
import type { GroupPlatform, SubscriptionType } from '@/types'

/** The intentionally small projection exposed to ordinary Worker users. */
export interface AvailableUserGroup {
  id: string
  name: string
  description: string | null
  platform: GroupPlatform
  rate_multiplier: number
  is_exclusive: boolean
  status: 'active'
  subscription_type: SubscriptionType
  peak_rate_enabled?: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
}

/**
 * Get available groups that the current user can bind to API keys
 * This returns groups based on user's permissions:
 * - Standard groups: public (non-exclusive) or explicitly allowed
 * - Subscription groups: user has active subscription
 * @returns List of available groups
 */
export async function getAvailable(): Promise<AvailableUserGroup[]> {
  const { data } = await apiClient.get<AvailableUserGroup[]>('/groups/available')
  return data
}

/**
 * Get current user's custom group rate multipliers
 * @returns Map of group_id to custom rate_multiplier
 */
export async function getUserGroupRates(): Promise<Record<string, number>> {
  const { data } = await apiClient.get<Record<string, number> | null>('/groups/rates')
  return data || {}
}

export const userGroupsAPI = {
  getAvailable,
  getUserGroupRates
}

export default userGroupsAPI
