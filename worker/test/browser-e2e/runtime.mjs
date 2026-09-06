import { createServer } from 'node:net'

export async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Unable to reserve a numeric loopback port')
  }

  let released = false
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    async release() {
      if (released) return
      released = true
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    },
  }
}

export function workerOriginBindings(origin) {
  const url = new URL(origin)
  return {
    PUBLIC_ORIGIN: { type: 'plain_text', value: origin },
    WEBAUTHN_RP_ID: { type: 'plain_text', value: url.hostname },
    WEBAUTHN_RP_ORIGINS: { type: 'plain_text', value: JSON.stringify([origin]) },
  }
}
