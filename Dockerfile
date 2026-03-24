FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --production

# Copy source and config
COPY src/ ./src/
COPY config/ ./config/

# Create data directories for runtime
RUN mkdir -p data/runs data/logs

CMD ["node", "src/index.js"]
