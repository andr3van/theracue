# Build Instructions for Architecture-Specific Distributions

This plugin uses native Node.js modules (specifically the `speaker` module) that must be compiled for the target architecture. Because of this, **you need separate builds for Apple Silicon and Intel Macs**.

## Apple Silicon Build (Current Mac - arm64)

**Already built**: `com.github.andr3van.theracue-arm64.streamDeckPlugin`

This build works on:
- Macs with M1, M2, M3, or newer Apple Silicon chips

## Intel Build (For Older Macs - x86_64)

To create the Intel build, you need to build on an Intel Mac:

### On the Intel Mac:

1. **Clone/copy the project** to the Intel Mac

2. **Clean existing node_modules** (critical - removes arm64 binaries):
   ```bash
   cd /path/to/theracue
   rm -rf node_modules
   rm -rf com.github.andr3van.theracue.sdPlugin/bin/node_modules
   ```

3. **Replace FFmpeg with Intel-compatible version**:
   ```bash
   # Download Intel FFmpeg
   curl -L https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip -o ffmpeg-intel.zip
   unzip ffmpeg-intel.zip
   
   # Replace the arm64 version with Intel version
   mv ffmpeg com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin
   chmod +x com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin
   
   # Verify it's x86_64 (should show "Mach-O 64-bit executable x86_64")
   file com.github.andr3van.theracue.sdPlugin/bin/ffmpeg/ffmpeg-darwin
   
   # Clean up
   rm ffmpeg-intel.zip
   ```

4. **Install dependencies**:
   ```bash
   # Install root dependencies
   npm install
   
   # Install speaker module for Intel architecture
   cd com.github.andr3van.theracue.sdPlugin/bin
   npm install --omit=dev speaker
   
   # Verify speaker is x86_64 (should show "Mach-O 64-bit bundle x86_64")
   file node_modules/speaker/build/Release/binding.node
   ```

5. **Build the plugin**:
   ```bash
   cd /path/to/theracue
   npm run build
   ```

6. **Package with architecture-specific name**:
   ```bash
   rm -f *.streamDeckPlugin
   streamdeck pack com.github.andr3van.theracue.sdPlugin -o .
   mv com.github.andr3van.theracue.streamDeckPlugin com.github.andr3van.theracue-x86_64.streamDeckPlugin
   ```

## Distribution

When distributing the plugin:

1. **For Apple Silicon Macs** (M1/M2/M3): Use `com.github.andr3van.theracue-arm64.streamDeckPlugin`
2. **For Intel Macs**: Use `com.github.andr3van.theracue-x86_64.streamDeckPlugin`

## Why Separate Builds?

The plugin contains two architecture-specific native components:

1. **speaker module** (`binding.node`): Native Node.js module compiled during installation
   - **arm64**: For Apple Silicon (M1/M2/M3) processors
   - **x86_64**: For Intel processors

2. **ffmpeg binary** (`ffmpeg-darwin`): Pre-compiled executable for audio decoding
   - **arm64**: For Apple Silicon (M1/M2/M3) processors  
   - **x86_64**: For Intel processors

Both components must match the target Mac's architecture. Native binaries cannot run across architectures, which is why we need completely separate builds created on their respective Mac types.

## Common Issues

### "mach-o file, but is an incompatible architecture"
- **Cause**: The `speaker` module's `binding.node` or `ffmpeg-darwin` has the wrong architecture
- **Solution**: On Intel Mac, completely remove `node_modules` folders and replace `ffmpeg-darwin` before rebuilding (see steps above)

### "spawn Unknown system error -86"
- **Cause**: The `ffmpeg-darwin` binary is the wrong architecture (e.g., arm64 on Intel Mac)
- **Solution**: Download and replace `ffmpeg-darwin` with the correct Intel version (see step 3 above)

## Development

For development, use `streamdeck link` instead of installing `.streamDeckPlugin` files:

```bash
streamdeck link com.github.andr3van.theracue.sdPlugin
```

This creates a symlink and works immediately for development and testing.
