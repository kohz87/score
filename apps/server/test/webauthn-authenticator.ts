import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'

// A software authenticator for tests: ES256, no attestation, user verification and counter under test control.
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest()

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32)
  readonly #key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  counter = 0

  get id(): string {
    return isoBase64URL.fromBuffer(this.credentialId)
  }

  #authData(rpId: string, flags: number, attested: boolean): Buffer {
    const header = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags])])
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    if (!attested) return Buffer.concat([header, counter])
    const jwk = this.#key.publicKey.export({ format: 'jwk' })
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    )
    const length = Buffer.alloc(2)
    length.writeUInt16BE(this.credentialId.length)
    return Buffer.concat([header, counter, Buffer.alloc(16), length, this.credentialId, cose])
  }

  create(
    options: { challenge: string },
    opts: { origin: string; rpId: string; uv?: boolean } = { origin: '', rpId: '' },
  ) {
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04) | 0x40
    const clientData = JSON.stringify({
      type: 'webauthn.create',
      challenge: options.challenge,
      origin: opts.origin,
      crossOrigin: false,
    })
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.#authData(opts.rpId, flags, true)],
      ]) as never,
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(Buffer.from(clientData)),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    }
  }

  get(
    options: { challenge: string },
    opts: { origin: string; rpId: string; uv?: boolean; counter?: number },
  ) {
    if (opts.counter !== undefined) this.counter = opts.counter
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04)
    const clientData = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin: opts.origin,
        crossOrigin: false,
      }),
    )
    const authData = this.#authData(opts.rpId, flags, false)
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(clientData)]),
      this.#key.privateKey,
    )
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(signature),
      },
      clientExtensionResults: {},
    }
  }
}
