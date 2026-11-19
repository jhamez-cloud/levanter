const { bot } = require('../lib/')

const panelUrl = () => (process.env.PTERO_PANEL_URL || '').trim().replace(/\/+$/, '')
const clientKey = () =>
  (process.env.PTERO_CLIENT_KEY || process.env.PTERO_API_KEY || '').trim()

const requestTimeout = 20000

async function clientRequest(path, method = 'GET', body = null) {
  const base = panelUrl()
  const key = clientKey()

  if (!base || !key) {
    throw new Error(
      'Pterodactyl Client API configuration is missing. Set PTERO_PANEL_URL and PTERO_CLIENT_KEY.'
    )
  }

  const cleanPath = String(path).replace(/^\/+/, '')
  const suffix = cleanPath.startsWith('?') ? cleanPath : `/${cleanPath}`
  let url
  try {
    url = new URL(`${base}/api/client${suffix}`)
  } catch {
    throw new Error('PTERO_PANEL_URL must be a valid HTTP or HTTPS URL.')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PTERO_PANEL_URL must use HTTP or HTTPS.')
  }

  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'Application/vnd.pterodactyl.v1+json',
        'Content-Type': 'application/json',
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeout),
    })
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new Error('Pterodactyl API request timed out.')
    }
    throw new Error(`Could not reach the Pterodactyl panel: ${error.message}`)
  }

  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!response.ok) {
        throw new Error(`Pterodactyl API error: HTTP ${response.status}`)
      }
      throw new Error('The Pterodactyl panel returned invalid JSON.')
    }
  }

  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.message
    throw new Error(detail || `Pterodactyl API error: HTTP ${response.status}`)
  }

  return data || {}
}

async function getAllServers() {
  const servers = []
  let page = 1
  let totalPages = 1

  do {
    const result = await clientRequest(`?per_page=100&page=${page}`)
    servers.push(...(result.data || []))
    totalPages = Math.max(1, Number(result.meta?.pagination?.total_pages) || 1)
    page += 1
  } while (page <= totalPages)

  return servers
}

async function findServer(query) {
  const wanted = String(query || '').trim().toLowerCase()
  if (!wanted) throw new Error('Provide a server name, ID, UUID, or identifier.')

  const servers = await getAllServers()
  const matches = servers.filter((item) => {
    const server = item.attributes || {}
    return [server.identifier, server.uuid, server.internal_id, server.name]
      .filter((value) => value !== undefined && value !== null)
      .some((value) => String(value).trim().toLowerCase() === wanted)
  })

  if (!matches.length) {
    throw new Error('Server not found among the servers available to this Client API key.')
  }

  return matches[0].attributes
}

function unwrap(result) {
  return result?.attributes || result || {}
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let unit = 0

  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }

  const digits = amount >= 100 || unit === 0 ? 0 : amount >= 10 ? 1 : 2
  return `${amount.toFixed(digits)} ${units[unit]}`
}

function formatUptime(value) {
  let seconds = Math.floor(Number(value) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown'

  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)

  return [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes}m`]
    .filter(Boolean)
    .join(' ')
}

async function sendServerList(message) {
  try {
    const servers = await getAllServers()

    if (!servers.length) {
      return message.send('No servers are available to this Pterodactyl Client API key.')
    }

    const lines = servers.map((item, index) => {
      const server = item.attributes || {}
      const state = server.is_suspended ? 'suspended' : server.status || 'available'
      return `${index + 1}. ${server.name || 'Unnamed'}\n   ID: ${server.identifier || 'Unknown'} | ${state}`
    })

    const chunks = []
    let chunk = '🖥️ *PTERODACTYL SERVERS*\n\n'

    for (const line of lines) {
      if (`${chunk}${line}\n\n`.length > 3500) {
        chunks.push(chunk.trimEnd())
        chunk = '🖥️ *PTERODACTYL SERVERS (CONTINUED)*\n\n'
      }
      chunk += `${line}\n\n`
    }
    chunks.push(chunk.trimEnd())

    for (const part of chunks) await message.send(part)
  } catch (error) {
    await message.send(`❌ ${error.message}`)
  }
}

async function serverInfo(message, query) {
  if (!query) {
    return message.send(
      '*SERVER INFO USAGE*\n\n' +
        '.pservers\n' +
        '.pserverinfo <name or identifier>\n\n' +
        'Example: .pserverinfo Cyran'
    )
  }

  try {
    const found = await findServer(query)
    const identifier = found.identifier

    const [detailsResult, resourcesResult, allocationsResult] = await Promise.allSettled([
      clientRequest(`servers/${encodeURIComponent(identifier)}`),
      clientRequest(`servers/${encodeURIComponent(identifier)}/resources`),
      clientRequest(`servers/${encodeURIComponent(identifier)}/network/allocations`),
    ])

    if (detailsResult.status === 'rejected') throw detailsResult.reason

    const server = unwrap(detailsResult.value)
    const resources =
      resourcesResult.status === 'fulfilled' ? unwrap(resourcesResult.value) : {}
    const usage = resources.resources || {}
    const allocations =
      allocationsResult.status === 'fulfilled' ? allocationsResult.value.data || [] : []
    const allocation =
      allocations.find((item) => item.attributes?.is_default)?.attributes ||
      allocations[0]?.attributes ||
      {}
    const limits = server.limits || {}
    const features = server.feature_limits || {}
    const suspended = server.is_suspended || resources.is_suspended

    const output = [
      '🖥️ *PTERODACTYL SERVER INFO*',
      '',
      `Name: ${server.name || found.name || 'Unknown'}`,
      `Identifier: ${server.identifier || identifier}`,
      `UUID: ${server.uuid || found.uuid || 'Unknown'}`,
      `Internal ID: ${server.internal_id ?? found.internal_id ?? 'Not exposed'}`,
      `Description: ${server.description || 'None'}`,
      '',
      '🔒 *STATUS*',
      `Power: ${resources.current_state || server.status || 'Unknown'}`,
      `Suspended: ${suspended ? 'Yes' : 'No'}`,
      `Installing: ${server.is_installing ? 'Yes' : 'No'}`,
      `Transferring: ${server.is_transferring ? 'Yes' : 'No'}`,
      `Node maintenance: ${server.is_node_under_maintenance ? 'Yes' : 'No'}`,
      '',
      '📈 *CURRENT USAGE*',
      `CPU: ${Number.isFinite(Number(usage.cpu_absolute)) ? `${Number(usage.cpu_absolute).toFixed(2)}%` : 'Unknown'}`,
      `RAM: ${formatBytes(usage.memory_bytes)}`,
      `Disk: ${formatBytes(usage.disk_bytes)}`,
      `Network RX: ${formatBytes(usage.network_rx_bytes)}`,
      `Network TX: ${formatBytes(usage.network_tx_bytes)}`,
      `Uptime: ${formatUptime(usage.uptime)}`,
      '',
      '📊 *RESOURCE LIMITS (READ ONLY)*',
      `RAM: ${limits.memory ?? 'Unknown'} MB`,
      `Disk: ${limits.disk ?? 'Unknown'} MB`,
      `CPU: ${limits.cpu ?? 'Unknown'}%`,
      `Swap: ${limits.swap ?? 'Unknown'} MB`,
      `I/O: ${limits.io ?? 'Unknown'}`,
      `Threads: ${limits.threads ?? 'Default'}`,
      '',
      '⚙️ *FEATURE LIMITS*',
      `Databases: ${features.databases ?? 0}`,
      `Backups: ${features.backups ?? 0}`,
      `Allocations: ${features.allocations ?? 0}`,
      '',
      '🌐 *NETWORK*',
      `Address: ${allocation.ip_alias || allocation.ip || 'Unknown'}:${allocation.port || 'Unknown'}`,
      `SFTP: ${server.sftp_details?.ip || 'Unknown'}:${server.sftp_details?.port || 'Unknown'}`,
    ].join('\n')

    await message.send(output)
  } catch (error) {
    await message.send(`❌ ${error.message}`)
  }
}

function parseConfirmedServer(input, action) {
  const parts = String(input || '').trim().split(/\s+/).filter(Boolean)
  const confirmed = parts.at(-1)?.toUpperCase() === 'CONFIRM'
  if (confirmed) parts.pop()

  const query = parts.join(' ')
  if (!query || !confirmed) {
    throw new Error(`Confirmation required. Use .p${action} <server> CONFIRM`)
  }

  return query
}

async function sendPowerSignal(message, input, signal) {
  try {
    const query = parseConfirmedServer(input, signal)
    const server = await findServer(query)

    await clientRequest(`servers/${encodeURIComponent(server.identifier)}/power`, 'POST', {
      signal,
    })

    await message.send(
      `✅ *POWER SIGNAL ACCEPTED*\n\n` +
        `Server: ${server.name}\n` +
        `Identifier: ${server.identifier}\n` +
        `Signal: ${signal.toUpperCase()}`
    )
  } catch (error) {
    await message.send(`❌ ${error.message}`)
  }
}

async function showLimits(message, input) {
  const raw = String(input || '').trim()
  if (!raw) {
    return message.send(
      '*RESOURCE LIMIT USAGE*\n\n' +
        '.plimits <server>\n\n' +
        'Client API keys can view limits but cannot change them.'
    )
  }

  if (/\b(?:memory|disk|cpu|swap|io|threads)=/i.test(raw)) {
    return message.send(
      '❌ Resource limit changes are not supported by the Pterodactyl Client API. ' +
        'A panel administrator must use the Application API or panel UI.'
    )
  }

  try {
    const found = await findServer(raw)
    const result = await clientRequest(`servers/${encodeURIComponent(found.identifier)}`)
    const server = unwrap(result)
    const limits = server.limits || {}

    await message.send(
      `📊 *SERVER RESOURCE LIMITS*\n\n` +
        `Server: ${server.name || found.name}\n` +
        `Identifier: ${server.identifier || found.identifier}\n\n` +
        `RAM: ${limits.memory ?? 'Unknown'} MB\n` +
        `Disk: ${limits.disk ?? 'Unknown'} MB\n` +
        `CPU: ${limits.cpu ?? 'Unknown'}%\n` +
        `Swap: ${limits.swap ?? 'Unknown'} MB\n` +
        `I/O: ${limits.io ?? 'Unknown'}\n` +
        `Threads: ${limits.threads ?? 'Default'}\n\n` +
        '_These values are read-only through the Client API._'
    )
  } catch (error) {
    await message.send(`❌ ${error.message}`)
  }
}

async function unsupportedAdminAction(message, action) {
  const replacement = action === 'suspend' ? '.pstop' : '.pstart'
  await message.send(
    `❌ The Pterodactyl Client API cannot ${action} accounts or servers. ` +
      `That requires the administrator-only Application API.\n\n` +
      `For a power-state change, use ${replacement} <server> CONFIRM.`
  )
}

bot(
  {
    pattern: 'pservers$',
    fromMe: true,
    desc: 'List servers available to the Pterodactyl Client API key',
    type: 'pterodactyl',
  },
  sendServerList
)

bot(
  {
    pattern: 'pserverinfo ?(.*)',
    fromMe: true,
    desc: 'View Pterodactyl server information and live resource usage',
    type: 'pterodactyl',
  },
  async (message, match) => serverInfo(message, String(match || '').trim())
)

for (const signal of ['start', 'stop', 'restart', 'kill']) {
  bot(
    {
      pattern: `p${signal} ?(.*)`,
      fromMe: true,
      desc: `Send the ${signal} power signal to a Pterodactyl server`,
      type: 'pterodactyl',
    },
    async (message, match) => sendPowerSignal(message, String(match || '').trim(), signal)
  )
}

bot(
  {
    pattern: 'plimits ?(.*)',
    fromMe: true,
    desc: 'View Pterodactyl server resource limits',
    type: 'pterodactyl',
  },
  async (message, match) => showLimits(message, String(match || '').trim())
)

bot(
  {
    pattern: 'psuspend ?(.*)',
    fromMe: true,
    desc: 'Explain Client API suspension limitations',
    type: 'pterodactyl',
  },
  async (message) => unsupportedAdminAction(message, 'suspend')
)

bot(
  {
    pattern: 'punsuspend ?(.*)',
    fromMe: true,
    desc: 'Explain Client API suspension limitations',
    type: 'pterodactyl',
  },
  async (message) => unsupportedAdminAction(message, 'unsuspend')
)
