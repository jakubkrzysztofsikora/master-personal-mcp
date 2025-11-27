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
# pip3 installs to /usr/local/bin by default with --break-system-packages
RUN pip3 install uv --break-system-packages

# Verify uv/uvx are available
RUN which uvx && uvx --version

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application
COPY dist/ ./dist/
COPY config.example.json ./config.json

# Environment
ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.json

# Note: PORT is provided by Heroku at runtime, don't hardcode it
EXPOSE 3000

CMD ["node", "dist/index.js"]
