FROM node:24.22.1 AS base

ARG FDB_VERSION=7.4.8

# Install system dependencies
RUN apt-get update && apt-get install -y vim redis-tools postgresql-client htop curl libpq-dev build-essential cmake tmux screen

WORKDIR /tmp/foundationdb
RUN package="foundationdb-clients_${FDB_VERSION}-1_amd64.deb" && \
    url="https://github.com/apple/foundationdb/releases/download/${FDB_VERSION}/${package}" && \
    curl --fail --location --retry 3 --output "$package" "$url" && \
    echo "4a97efef549c583c3938266cfa71a17199421be5747c2cf0a4cca65b8e64fb63  ${package}" | sha256sum --check - && \
    dpkg -i "$package" && \
    rm -rf /tmp/foundationdb

# Set the working directory to /dust
WORKDIR /dust

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN npm install -g npm@11.19.0

COPY . .

# Install dependencies, including devDependencies (e.g. tsx, needed to run
# scripts/db/run-migrate.cjs against uncompiled TypeScript).
RUN --mount=type=cache,id=npm-cache,target=/root/.npm npm ci --include=dev

RUN cd sdks/js && npm run build

RUN cd sparkle && npm run build

RUN cd connectors && npm run build

# Set the default start directory to /dust when SSH into the container
WORKDIR /dust

# Wraning and prompt
RUN echo "echo -e \"\033[0;31mWARNING: This is a PRODUCTION system!\033[0m\"" >> /root/.bashrc

ENV GIT_SSH_COMMAND="ssh -i ~/.ssh/github-deploykey-deploybox"

# Set a default command
CMD ["/dust/prodbox/init.sh"]
