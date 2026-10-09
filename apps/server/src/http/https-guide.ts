import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { HttpError, registerErrorHandlers } from '../errors.ts'
import type { Config } from '../config.ts'

// The HTTPS setup guide. Remote mode is HTTPS-only (5.18): a plain-HTTP request, or any request while no certificate is
// configured, gets this page instead of the app. It is static, shows no secrets and loads nothing from outside.
export const GUIDE_PATH = '/setup/https'
export const CA_PATH = '/setup/https/score-ca.crt'

const HOST = /^(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?|\[[\da-f:.]+\])(?::\d{1,5})?$/i

const GUIDE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

function secureAuthority(hostHeader: string | undefined, origins: readonly string[]): string {
  // The Host header comes from the client: it only reaches the page when it is a plain host[:port].
  if (hostHeader && HOST.test(hostHeader)) return hostHeader
  return new URL(origins[0] ?? 'https://localhost').host
}

function guidePage(secureUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Score needs HTTPS</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #ECEEF2; color: #12131A; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
.card { background: #fff; border-radius: 28px; padding: 28px 32px; margin-bottom: 20px; }
h1 { font-size: 30px; line-height: 1.15; margin: 0 0 12px; }
h2 { font-size: 20px; margin: 0 0 8px; }
h3 { font-size: 16px; margin: 18px 0 4px; }
p, ul, ol { margin: 0 0 12px; }
li { margin-bottom: 4px; }
code, pre { font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace; font-size: 14px; }
pre { background: #ECEEF2; border-radius: 14px; padding: 12px 16px; overflow-x: auto; }
a.button { display: inline-block; background: #12131A; color: #fff; text-decoration: none; padding: 12px 22px; border-radius: 999px; font-weight: 600; }
.note { color: #4a4d5c; }
@media (max-width: 480px) { .card { padding: 22px 18px; } }
</style>
</head>
<body>
<main>
<section class="card">
<h1>Score needs a secure (HTTPS) connection</h1>
<p>You reached Score over plain HTTP. Score only serves its app over HTTPS when it runs on your network, so this page is all that is shown here.</p>
<p><a class="button" href="${secureUrl}">Open the secure address</a></p>
<p class="note">If that link shows a certificate warning, or does not open, follow the steps below once.</p>
</section>
<section class="card">
<h2>Why HTTPS is required</h2>
<p>Over plain HTTP everything between your browser and Score, including the pairing cookie, API keys and conversations, can be read by anyone on the same network. Browsers also switch off features Score needs (secure cookies, the clipboard, random identifiers) on pages that are not served securely. Only this machine (localhost) counts as secure without HTTPS.</p>
</section>
<section class="card">
<h2>Option A (recommended): Score's own certificate</h2>
<p>On the machine that runs Score:</p>
<pre>scripts/score tls
scripts/score stop
scripts/score start</pre>
<p>This creates a small local certificate authority and a certificate for this machine in <code>$SCORE_HOME/tls/</code> (default <code>~/.score/tls/</code>). Then install the authority on every device that opens Score, so the browser trusts it:</p>
<p><a href="${CA_PATH}">Download Score's certificate authority (score-ca.crt)</a>. It contains only the public certificate. The private key never leaves the server.</p>
<h3>Windows</h3>
<p>Open the file, choose Install Certificate, Local Machine, then place it in <em>Trusted Root Certification Authorities</em>. Restart the browser.</p>
<h3>macOS</h3>
<p>Open the file (Keychain Access opens), add it to the <em>System</em> keychain, double-click it, expand Trust and set <em>Always Trust</em>. Restart the browser.</p>
<h3>iOS and iPadOS</h3>
<p>Open the file in Safari and allow the profile download. Settings, General, VPN &amp; Device Management: install the profile. Then Settings, General, About, Certificate Trust Settings: switch on full trust for Score's certificate authority.</p>
<h3>Android</h3>
<p>Settings, Security, Encryption &amp; credentials, Install a certificate, CA certificate. Choose the downloaded file. (Some versions: Settings, search for &quot;CA certificate&quot;.)</p>
<h3>Linux and Chrome</h3>
<p>Chrome and Chromium: Settings, Privacy and security, Security, Manage certificates, Authorities, Import the file and trust it for websites. System-wide on Debian or Ubuntu: copy it to <code>/usr/local/share/ca-certificates/score-ca.crt</code> and run <code>sudo update-ca-certificates</code>. Firefox: Settings, Privacy &amp; Security, View Certificates, Authorities, Import.</p>
<p class="note">Running <code>scripts/score tls</code> again keeps the same authority and only renews the server certificate, so devices stay trusted. <code>scripts/score tls --new-ca</code> replaces both and every device must install the new file.</p>
</section>
<section class="card">
<h2>Option B: your own certificate</h2>
<p>If you already have a certificate the devices trust (from a reverse proxy, Tailscale, or your own authority), point Score at it before starting:</p>
<pre>SCORE_TLS_CERT=/path/to/fullchain.pem
SCORE_TLS_KEY=/path/to/private-key.pem
SCORE_PUBLIC_ORIGINS=https://your-name:8741</pre>
<p>The public origin must be the https address people type in the browser.</p>
</section>
<section class="card">
<h2>Then</h2>
<p>Restart Score (<code>scripts/score stop</code>, then <code>scripts/score start</code>) and open the https address: <a href="${secureUrl}">${secureUrl}</a>. Pair each browser with the link <code>scripts/score pair</code> prints.</p>
</section>
</main>
</body>
</html>
`
}

function registerGuideRoutes(
  app: FastifyInstance,
  { home, origins }: { home: string; origins: readonly string[] },
): void {
  app.get(GUIDE_PATH, async (request, reply) => {
    const secureUrl = `https://${secureAuthority(request.headers.host, origins)}/`
    return reply
      .header('content-security-policy', GUIDE_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(guidePage(secureUrl))
  })
  // Only the public certificate, from one fixed path; the private key sits next to it and is never read here.
  app.get(CA_PATH, async (_request, reply) => {
    let pem: string
    try {
      pem = readFileSync(join(home, 'tls', 'ca.crt'), 'utf8')
    } catch {
      throw new HttpError(404, 'not_found', 'No certificate authority yet: run scripts/score tls')
    }
    if (!pem.includes('BEGIN CERTIFICATE') || pem.includes('PRIVATE KEY'))
      throw new HttpError(404, 'not_found', 'No certificate authority yet: run scripts/score tls')
    return reply
      .header('content-disposition', 'attachment; filename="score-ca.crt"')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .type('application/x-x509-ca-cert')
      .send(pem)
  })
}

/** The guide and CA download on the HTTPS app too (same page in both modes). */
export function registerHttpsGuide(app: FastifyInstance, config: Config): void {
  registerGuideRoutes(app, { home: config.home, origins: config.remote?.origins ?? [] })
}

/** A plain-HTTP app: the guide, `426 https_required` under /api, and a redirect to the guide for everything else. */
export function buildGuideApp(
  config: Config,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger, trustProxy: false, forceCloseConnections: true })
  registerErrorHandlers(app)
  registerGuideRoutes(app, { home: config.home, origins: config.remote?.origins ?? [] })
  // onRequest runs before body parsing, so no request body or content type can get past it.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0]!
    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      [GUIDE_PATH, CA_PATH].includes(path)
    )
      return
    if (path === '/api' || path.startsWith('/api/'))
      return reply
        .code(426)
        .header('cache-control', 'no-store')
        .header('upgrade', 'TLS/1.2')
        .send({
          error: {
            code: 'https_required',
            message: `Score is only served over HTTPS. Open the setup guide at ${GUIDE_PATH}`,
          },
        })
    return reply.code(308).header('location', GUIDE_PATH).header('cache-control', 'no-store').send()
  })
  return app
}
