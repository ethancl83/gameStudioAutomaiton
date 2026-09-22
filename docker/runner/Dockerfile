FROM node:22@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates curl unzip openjdk-17-jdk-headless git openssh-client \
    libx11-6 libxcursor1 libxinerama1 libxi6 libxrandr2 libgl1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY docker/runner/install-godot.sh docker/runner/install-godot.sh
RUN sh docker/runner/install-godot.sh editor
COPY . .

ENV APPOPS_RUNNER_DATA_DIR=/data/runner \
    APPOPS_GODOT_DATA_DIR=/data/godot
EXPOSE 4320
ENTRYPOINT ["sh", "/app/docker/runner/start.sh"]
