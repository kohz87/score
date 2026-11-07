export { credentialIds, providerLabel, signInKind, slugify } from './settings-catalog.ts'
export { messagingRows, readGatewayPlatforms, readProfilePlatforms } from './settings-gateway.ts'
import { LiveSettingsConnections } from './settings-connections.ts'

/** Provider and connection settings of the live Hermes adapter. */
export class LiveSettings extends LiveSettingsConnections {}
