# Bundle Scripts

Scripts for creating distribution-ready `.streamDeckPlugin` packages.

## Quick Start

### For Apple Silicon Mac (M1/M2/M3)
**Prerequisites:** Ensure `ffmpeg` is installed (e.g., `brew install ffmpeg`)
```bash
npm run bundle
```
Creates: `com.github.andr3van.theracue-arm64.streamDeckPlugin`

### For Intel Mac (x86_64)
**[WARNING] Must be run on an Intel Mac**

**Prerequisites:** Download Intel FFmpeg first
```bash
# One-time setup: Download Intel FFmpeg
curl -L https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip -o ffmpeg-intel.zip
unzip ffmpeg-intel.zip
mv ffmpeg scripts/ffmpeg-darwin-x86_64
chmod +x scripts/ffmpeg-darwin-x86_64
rm ffmpeg-intel.zip
```

**Then run the bundle script:**
```bash
npm run bundle:intel
```
Creates: `com.github.andr3van.theracue-x86_64.streamDeckPlugin`

## What Each Script Does

### `bundle.sh` - Apple Silicon
- Cleans development files (logs, source maps)
- Builds the plugin
- Packages for distribution
- Output: `com.github.andr3van.theracue-arm64.streamDeckPlugin`

### `bundle-intel.sh` - Intel Mac
- Cleans all native modules
- Uses pre-downloaded Intel FFmpeg from `scripts/ffmpeg-darwin-x86_64`
- Reinstalls dependencies for x86_64 architecture
- Builds the plugin
- Packages for distribution
- Output: `com.github.andr3van.theracue-x86_64.streamDeckPlugin`

## Why Two Builds?

The plugin uses native Node.js modules (`speaker`) and binaries (`ffmpeg`) that are architecture-specific. Intel Macs cannot run arm64 code and vice versa.

### Native Components:
1. **speaker module** (`binding.node`) - Audio output
2. **ffmpeg binary** (`ffmpeg-darwin`) - Audio decoding

Both must match the Mac's architecture.

## Distribution

Provide both files for users:
- **M1/M2/M3 users**: Use `*-arm64.streamDeckPlugin`
- **Intel users**: Use `*-x86_64.streamDeckPlugin`

## Development

For local development, use linking instead:
```bash
streamdeck link com.github.andr3van.theracue.sdPlugin
```

This creates a symlink and works immediately without packaging.
