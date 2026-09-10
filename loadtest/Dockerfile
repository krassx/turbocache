FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src ./src
COPY binding.gyp package.json ./
COPY scripts ./scripts
COPY loadtest ./loadtest
# Default build: no LZ4, no external dependency.
RUN npx --yes node-gyp configure build
CMD ["node", "loadtest/load.js"]
