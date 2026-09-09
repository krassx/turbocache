FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY prototype ./prototype
COPY loadtest ./loadtest
# Default build: no LZ4, no external dependency.
RUN cd prototype && npx --yes node-gyp configure build
CMD ["node", "loadtest/load.js"]
