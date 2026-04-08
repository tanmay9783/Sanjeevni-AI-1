FROM node:20-slim

# Install ffmpeg + unzip
RUN apt-get update && apt-get install -y ffmpeg wget unzip && rm -rf /var/lib/apt/lists/*

# Install Rhubarb Lip Sync (Linux binary)
# The zip extracts into a subdirectory like "Rhubarb-Lip-Sync-1.13.0-Linux/"
# so we use `find` to locate the binary and copy it to /usr/local/bin (which is in PATH)
RUN wget -q https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip \
    -O /tmp/rhubarb.zip \
    && unzip /tmp/rhubarb.zip -d /tmp/rhubarb-extract \
    && find /tmp/rhubarb-extract -maxdepth 2 -name "rhubarb" -type f \
         -exec cp {} /usr/local/bin/rhubarb \; \
    && chmod +x /usr/local/bin/rhubarb \
    && rm -rf /tmp/rhubarb.zip /tmp/rhubarb-extract

# No need to set RHUBARB_PATH — "rhubarb" is now in PATH via /usr/local/bin
# No need to set FFMPEG_PATH  — "ffmpeg"  is already in PATH from apt

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

# Ensure audios folder exists at runtime
RUN mkdir -p audios

EXPOSE 3125
CMD ["npm", "start"]

