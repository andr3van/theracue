#!/bin/bash

# Bundle script for Apple Silicon Mac (arm64) distribution
# This creates a clean distribution package without development files

set -e

echo "[INFO] Apple Silicon Bundle Script"
echo "=============================="
echo ""

echo "[CLEAN] Cleaning development artifacts..."

# Remove logs directory (runtime logs from testing)
rm -rf com.github.andr3van.theracue.sdPlugin/logs

# Remove source maps (development only)
rm -f com.github.andr3van.theracue.sdPlugin/bin/*.map

# Remove old node_modules from plugin
rm -rf com.github.andr3van.theracue.sdPlugin/node_modules

# Remove any old bundle
rm -f com.github.andr3van.theracue.streamDeckPlugin
rm -f com.github.andr3van.theracue-arm64.streamDeckPlugin

echo ""
echo "[BUILD] Building plugin..."
npm run build

echo "[INFO] Copying runtime dependencies..."

# Create bin/ffmpeg directory
mkdir -p com.github.andr3van.theracue.sdPlugin/bin/ffmpeg

# Copy ffmpeg-darwin (Apple Silicon)
# We assume the developer has ffmpeg installed or we use the one from the system
# In a real CI/CD we might download a specific version
if [ -f "/opt/homebrew/bin/ffmpeg" ]; then
  cp /opt/homebrew/bin/ffmpeg com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin
elif command -v ffmpeg >/dev/null 2>&1; then
  cp "$(command -v ffmpeg)" com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin
else
  echo "[WARN] Warning: ffmpeg not found, it won't be bundled!"
fi

if [ -f "com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin" ]; then
  FFMPEG_ARCH=$(file "com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin" | grep -o "x86_64\|arm64")
  echo "[SUCCESS] Bundled ffmpeg architecture: $FFMPEG_ARCH"
fi

# Create node_modules in the plugin bundle
mkdir -p com.github.andr3van.theracue.sdPlugin/node_modules

# Copy required production dependencies
cp -R node_modules/speaker com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/wav com.github.andr3van.theracue.sdPlugin/node_modules/
# Shared dependencies
cp -R node_modules/bindings com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/buffer-alloc com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/buffer-from com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/debug com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/readable-stream com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/stream-parser com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/ms com.github.andr3van.theracue.sdPlugin/node_modules/
cp -R node_modules/file-uri-to-path com.github.andr3van.theracue.sdPlugin/node_modules/

echo ""
echo "[PACK] Packaging for Apple Silicon..."
streamdeck pack com.github.andr3van.theracue.sdPlugin -o .

# Rename to indicate arm64 architecture
if [ -f "com.github.andr3van.theracue.streamDeckPlugin" ]; then
  mv com.github.andr3van.theracue.streamDeckPlugin com.github.andr3van.theracue-arm64.streamDeckPlugin
  echo ""
  echo "[SUCCESS] Apple Silicon bundle created successfully!"
  echo ""
  ls -lh com.github.andr3van.theracue-arm64.streamDeckPlugin
  echo ""
  echo "[INFO] Distribution file: com.github.andr3van.theracue-arm64.streamDeckPlugin"
  echo "   Use this file for M1/M2/M3 Macs"
else
  echo "[ERROR] Error: Package file not created"
  exit 1
fi
