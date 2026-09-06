import type { Context } from 'hono'

/** Stable fail-closed boundary for legacy video APIs that are not Worker-native yet. */
export function unsupportedVideoGeneration(context: Context): Response {
  return context.json({
    error: {
      type: 'invalid_request_error',
      code: 'unsupported_video_generation',
      message: 'Video generation is not supported by the Cloudflare Worker runtime',
    },
  }, 501)
}
