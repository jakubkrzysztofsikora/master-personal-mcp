# MCP Gateway Server

A web service that exposes a modern MCP (Model Context Protocol) remote interface while aggregating multiple local MCP servers configured by users. The gateway acts as a bridge, allowing remote MCP clients to interact with locally-configured MCP servers through a single, authenticated endpoint.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     MCP Gateway Service                         │
│                                                                 │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │   OAuth     │    │   Gateway    │    │  Local MCP       │   │
│  │   Layer     │───▶│   Router     │───▶│  Server Pool     │   │
│  │             │    │              │    │                  │   │
│  │  - Token    │    │  - Tool      │    │  ┌────────────┐  │   │
│  │    Verify   │    │    Merge     │    │  │ Server A   │  │   │
│  │  - User     │    │  - Request   │    │  │ (stdio)    │  │   │
│  │    Lookup   │    │    Route     │    │  └────────────┘  │   │
│  │             │    │  - Response  │    │  ┌────────────┐  │   │
│  └─────────────┘    │    Aggregate │    │  │ Server B   │  │   │
│                     └──────────────┘    │  │ (stdio)    │  │   │
│                                         │  └────────────┘  │   │
│                                         └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Streamable HTTP
                              ▼
                    ┌──────────────────┐
                    │  Remote MCP      │
                    │  Clients         │
                    │  (Claude, etc.)  │
                    └──────────────────┘
```

## Features

- **Single MCP Endpoint**: Expose multiple local MCP servers through one Streamable HTTP endpoint
- **Tool Aggregation**: Automatically merges tools from all configured servers with namespacing
- **OAuth 2.1 Authentication**: Bearer token authentication with static user configuration
- **Scope-based Access Control**: Restrict access to specific servers based on user scopes
- **Heroku Ready**: Docker container optimized for Heroku deployment

## Quick Start

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/your-org/master-personal-mcp.git
   cd master-personal-mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create configuration:
   ```bash
   cp config.example.json config.json
   # Edit config.json with your settings
   ```

4. Build and run:
   ```bash
   npm run build
   npm start
   ```

5. Test with MCP Inspector:
   ```bash
   npx @modelcontextprotocol/inspector http://localhost:3000/mcp \
     --header "Authorization: Bearer your-token-here"
   ```

### Docker

```bash
# Build
docker build -t mcp-gateway .

# Run
docker run -p 3000:3000 \
  -e GARMIN_EMAIL=your-email \
  -e GARMIN_PASSWORD=your-password \
  mcp-gateway
```

## Configuration

Configuration is loaded in the following priority order:

1. `CONFIG_PATH` environment variable → JSON file path
2. `./config.json` in working directory
3. Environment variables with `GATEWAY_` prefix

### Configuration Schema

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "baseUrl": "https://your-app.herokuapp.com"
  },
  "auth": {
    "enabled": true,
    "users": [
      {
        "id": "user-1",
        "email": "admin@example.com",
        "name": "Admin User",
        "token": "your-bearer-token",
        "scopes": ["tools:read", "tools:execute"]
      }
    ]
  },
  "mcpServers": [
    {
      "id": "garmin",
      "name": "Garmin Connect",
      "description": "Garmin fitness data",
      "command": "uvx",
      "args": ["--python", "3.12", "--from", "git+https://github.com/Taxuspt/garmin_mcp", "garmin-mcp"],
      "env": {
        "GARMIN_EMAIL": "${GARMIN_EMAIL}",
        "GARMIN_PASSWORD": "${GARMIN_PASSWORD}"
      },
      "enabled": true,
      "requiredScopes": ["tools:read"]
    }
  ]
}
```

### Environment Variable References

Use `${VAR_NAME}` syntax in configuration to reference environment variables:

```json
{
  "env": {
    "API_KEY": "${MY_API_KEY}"
  }
}
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/mcp` | POST | Yes | MCP JSON-RPC endpoint |
| `/mcp` | GET | Yes | SSE notifications |
| `/mcp` | DELETE | Yes | Close session |
| `/health` | GET | No | Health check |
| `/docs` | GET | No | API documentation |
| `/.well-known/oauth-protected-resource` | GET | No | OAuth metadata |

## Authentication

Include a Bearer token in the Authorization header:

```
Authorization: Bearer gw_live_xxxxxxxxxxxx
```

### Scopes

- `tools:read` - List available tools
- `tools:execute` - Execute tool calls

## Tool Namespacing

Tools from different servers are namespaced to avoid conflicts:

- Original tool: `create_issue` from server `github`
- Gateway tool: `github_create_issue`

## Deployment to Heroku

### Prerequisites

1. Heroku CLI installed
2. Docker installed
3. GitHub repository with secrets configured

### GitHub Secrets

Configure in `Settings > Secrets and variables > Actions`:

| Secret | Description |
|--------|-------------|
| `HEROKU_API_KEY` | Your Heroku API key |

### Heroku Config Vars

```bash
heroku config:set GARMIN_EMAIL=your-email --app master-personal-mcp
heroku config:set GARMIN_PASSWORD=your-password --app master-personal-mcp
```

### Deploy

Push to `main` branch to trigger automatic deployment via GitHub Actions.

## Development

```bash
# Install dependencies
npm install

# Development mode with auto-reload
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Start production
npm start
```

## Project Structure

```
mcp-gateway-server/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configuration loading
│   ├── types.ts              # TypeScript interfaces
│   ├── server/
│   │   ├── gateway.ts        # MCP server implementation
│   │   └── transport.ts      # HTTP transport setup
│   ├── auth/
│   │   ├── middleware.ts     # Express auth middleware
│   │   └── provider.ts       # Token validation
│   ├── pool/
│   │   ├── manager.ts        # Server pool manager
│   │   ├── client.ts         # Individual server client
│   │   └── aggregator.ts     # Tool aggregation
│   └── utils/
│       ├── logger.ts         # Structured logging
│       └── errors.ts         # Error handling
├── Dockerfile
├── heroku.yml
├── package.json
├── tsconfig.json
└── config.example.json
```

## Included Integrations

### Garmin Connect

The gateway includes Garmin Connect as the primary example integration, providing access to:

- Activities (runs, rides, swims, etc.)
- Sleep data and scores
- Step counts
- Heart rate metrics
- Body composition

**Required Environment Variables:**
- `GARMIN_EMAIL` - Your Garmin account email
- `GARMIN_PASSWORD` - Your Garmin account password

## License

MIT
