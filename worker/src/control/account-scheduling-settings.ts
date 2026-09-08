import { GatewayError } from '../gateway/errors'
export const accountSchedulingDefaults = { allow_ungrouped_key_scheduling: false, account_scheduling_thresholds: {openai:100,anthropic:100,grok:100} }
export type AccountSchedulingThresholds = typeof accountSchedulingDefaults.account_scheduling_thresholds
export function parseAccountSchedulingThresholds(value:unknown): AccountSchedulingThresholds {
 if(!value || typeof value!=='object' || Array.isArray(value))throw new GatewayError(400,'invalid_settings','Account scheduling thresholds must be a platform map')
 const result={...accountSchedulingDefaults.account_scheduling_thresholds}
 for(const [key,threshold] of Object.entries(value)) {
  if(!(key in result) || !Number.isInteger(threshold) || threshold<1 || threshold>100)throw new GatewayError(400,'invalid_settings','Scheduling thresholds must be integers from 1 to 100 for a supported platform')
  result[key as keyof typeof result]=threshold
 }
 return result
}
