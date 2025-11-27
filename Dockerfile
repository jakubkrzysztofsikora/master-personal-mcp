FROM node:20-slim

# Install Python and system dependencies for local MCP servers
# Including uv for Python-based servers like Garmin MCP
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv (fast Python package installer) for Garmin MCP
RUN pip3 install uv --break-system-packages

# Ensure uv/uvx is in PATH
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application
COPY dist/ ./dist/
COPY config.example.json ./config.json

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV CONFIG_PATH=/app/config.json

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "dist/index.js"]
