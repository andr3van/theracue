#!/bin/bash

# Bundle script for Intel Mac (x86_64) distribution
# This script should be run on an Intel Mac to create the Intel-compatible build

set -e

echo "[INFO] Intel Mac Bundle Script"
echo "=========================="
echo ""

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "[ERROR] Error: This script must be run on macOS"
  exit 1
fi

# Check architecture
ARCH=$(uname -m)
echo "Current architecture: $ARCH"
if [[ "$ARCH" != "x86_64" ]]; then
  echo "[WARN] Warning: You appear to be on $ARCH, not x86_64 (Intel)"
  echo "   The build will be for $ARCH architecture"
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo ""
echo "[CLEAN] Step 1: Cleaning existing builds..."
rm -rf node_modules
rm -rf com.github.andr3van.theracue.sdPlugin/node_modules
rm -rf com.github.andr3van.theracue.sdPlugin/logs
rm -f com.github.andr3van.theracue.sdPlugin/bin/*.map
rm -f *.streamDeckPlugin

echo ""
echo "[INFO] Step 2: Checking/replacing with Intel FFmpeg..."

FFMPEG_PATH="com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin"
INTEL_FFMPEG_SOURCE="scripts/ffmpeg-darwin-x86_64"

# Check if Intel FFmpeg exists in scripts directory
if [ ! -f "$INTEL_FFMPEG_SOURCE" ]; then
  echo "[ERROR] Error: Intel FFmpeg not found at $INTEL_FFMPEG_SOURCE"
  echo "   Please download it first:"
  echo "   curl -L https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip -o ffmpeg-intel.zip"
  echo "   unzip ffmpeg-intel.zip"
  echo "   mv ffmpeg scripts/ffmpeg-darwin-x86_64"
  echo "   chmod +x scripts/ffmpeg-darwin-x86_64"
  exit 1
fi

# Verify it's actually x86_64
INTEL_ARCH=$(file "$INTEL_FFMPEG_SOURCE" | grep -o "x86_64\|arm64")
if [[ "$INTEL_ARCH" != "x86_64" ]]; then
  echo "[ERROR] Error: $INTEL_FFMPEG_SOURCE is $INTEL_ARCH, not x86_64"
  exit 1
fi

# Create ffmpeg directory if it doesn't exist
mkdir -p "com.github.andr3van.theracue.sdPlugin/bin/ffmpeg"

# Copy Intel FFmpeg to plugin
echo "Copying Intel FFmpeg ($INTEL_ARCH) to plugin..."
cp "$INTEL_FFMPEG_SOURCE" "$FFMPEG_PATH"
chmod +x "$FFMPEG_PATH"

# Verify final file
FFMPEG_ARCH=$(file "$FFMPEG_PATH" | grep -o "x86_64\|arm64")
echo "[SUCCESS] FFmpeg installed: $FFMPEG_ARCH"

echo ""
echo "[INFO] Step 3: Installing root dependencies..."
npm install

echo ""
echo "[INFO] Step 4: Preparing runtime dependencies..."

# Create node_modules in the plugin bundle
mkdir -p com.github.andr3van.theracue.sdPlugin/node_modules

# Copy required production dependencies from root (we just ran npm install there)
# Note: Since this script is ideally run on an Intel Mac, these modules will be x86_64
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

# Verify speaker architecture
SPEAKER_NODE="com.github.andr3van.theracue.sdPlugin/node_modules/speaker/build/Release/binding.node"
if [ -f "$SPEAKER_NODE" ]; then
  SPEAKER_ARCH=$(file "$SPEAKER_NODE" | grep -o "x86_64\|arm64")
  echo "Speaker module architecture: $SPEAKER_ARCH"
  
  if [[ "$SPEAKER_ARCH" != "x86_64" ]]; then
    echo "[WARN] Warning: Speaker module is $SPEAKER_ARCH, not x86_64"
    echo "   This build may not work on Intel Macs"
  else
    echo "[SUCCESS] Speaker module is x86_64"
  fi
else
  echo "[WARN] Warning: Could not verify speaker module"
fi

echo ""
echo "[BUILD] Step 5: Building plugin..."
npm run build

echo ""
echo "[PACK] Step 6: Packaging for Intel Mac..."
streamdeck pack com.github.andr3van.theracue.sdPlugin -o .

# Rename to indicate Intel architecture
if [ -f "com.github.andr3van.theracue.streamDeckPlugin" ]; then
  mv com.github.andr3van.theracue.streamDeckPlugin com.github.andr3van.theracue-x86_64.streamDeckPlugin
  echo ""
  echo "[SUCCESS] Intel Mac bundle created successfully!"
  echo ""
  ls -lh com.github.andr3van.theracue-x86_64.streamDeckPlugin
  echo ""
  echo "[INFO] Distribution file: com.github.andr3van.theracue-x86_64.streamDeckPlugin"
  echo "   Use this file for Intel Macs"
else
  echo "[ERROR] Error: Package file not created"
  exit 1
fi
