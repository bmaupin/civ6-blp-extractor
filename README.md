# Civ 6 BLP Extractor

A minimal tool for extracting embedded assets from Civilization VI BLP files.

## Status

✅ **Working** - Successfully extracts all embedded assets from BLP files.

- ✅ Extracts from `strategicview_terraintypes.blp` (14 assets)
- ✅ Extracts from `strategicview_terrainsprites.blp` (90 assets)
- 📖 See [docs/investigation.md](./docs/investigation.md) for detailed format analysis

## Tools Included

### `extract-blp.ts`

Main extraction tool. Extracts all embedded assets from a BLP file.

**Usage:**

```bash
npm run extract -- <blp-file> [output-dir] [ooz-path]
```

**Example:**

```bash
npm install
npm run extract -- workdir/strategicview_terraintypes.blp workdir/extracted
```

### `investigate-blp.ts`

Analyzes BLP file structure and reports format details.

**Usage:**

```bash
npm run investigate -- <blp-file>
```

**Example:**

```bash
npm run investigate -- workdir/strategicview_terraintypes.blp
```

### `analyze-assets.ts`

Analyzes extracted asset files to understand their structure and patterns.

**Usage:**

```bash
npm run analyze -- <directory>
```

**Example:**

```bash
npm run analyze -- workdir/extracted
```

### `convert-civ6-raw-to-dds.ts`

Converts extracted `.raw` assets into `.dds` files using current Civ 6 texture heuristics.

**Usage:**

```bash
npm run convert-dds -- <input-dir> [output-dir]
```

**Example:**

```bash
npm run convert-dds -- workdir/extracted workdir/extracted/dds
```

### `scan-blp-strings.ts`

Scans BLP package data stripes for ASCII strings (useful for locating original asset names).

**Usage:**

```bash
npm run scan-strings -- <blp-file> [min-length]
```

**Example:**

```bash
npm run scan-strings -- workdir/strategicview_terrainsprites.blp 6
```

### `extract-textures.ts`

Extracts texture entries using package metadata (names, sizes, mip counts, formats) and writes DDS files with DX10 headers.

**Usage:**

```bash
npm run extract-textures -- <blp-file> [output-dir]
```

**Example:**

```bash
npm run extract-textures -- workdir/strategicview_terrainsprites.blp workdir/textures_sprites
```

## Quick Start

```bash
# Install dependencies
npm install

# Extract assets
npm run extract -- workdir/strategicview_terraintypes.blp

# Analyze the extracted data
npm run analyze -- workdir/extracted

# Convert extracted raw assets to DDS (heuristic)
npm run convert-dds -- workdir/extracted
```

## Requirements

- Node.js 18+
- TypeScript/tsx (installed via npm)
- Optional: ooz decompressor for Oodle Kraken compressed files

## Installation

```bash
npm install
```

## How It Works

### BLP Header Format

```
Offset  Field              Type     Size  Description
0x00    Magic              String   6     "CIVBLP"
0x08    packageDataOffset  UInt32   4     Offset to type information
0x0C    packageDataSize    UInt32   4     Size of package data
0x10    bigDataOffset      UInt32   4     Offset to embedded assets
0x14    bigDataCount       UInt32   4     Number of embedded assets
0x18    fileSize           UInt32   4     Total file size
```

### Extraction Process

1. **Read BLP header** to locate BigData section
2. **Calculate asset boundaries** using bigDataCount
3. **Extract raw chunks** from BigData section
4. **Parse CIVBIG containers** if detected in the data
5. **Save to output directory** as raw files

### Asset Format

Extracted assets are saved as raw binary data by default:

- **Name**: `asset_NN.raw` or `asset_NN.civbig`
- **Size**: Varies (87,552 bytes for terrain sprites)
- **Format**: Unknown (requires further reverse engineering)

For strategic-view texture BLPs tested so far, raw assets appear to be:

- **176-byte Civ 6-specific prefix/header**, followed by
- **BC3/DXT5 mip-chain payload** (typically 256x256 with full mipmaps)

The `convert-civ6-raw-to-dds.ts` tool wraps that payload with a DDS header.

## Known Findings

From investigation of `strategicview_terraintypes.blp`:

- **14 embedded assets**, each 87,552 bytes
- **BigData offset**: 43,008 bytes (0xA800)
- **No DDS magic bytes** in extracted chunks initially (DDS header is missing)
- **Likely BC3/DXT5 texture data** after skipping 176-byte prefix

## Target File

Primary investigation target:

```
~/.local/share/Steam/steamapps/common/Sid Meier's Civilization VI/steamassets/base/platforms/windows/blps/strategicview/strategicview_terraintypes.blp
```

## Known Issues

1. **Format Mismatch:** Civ 6 uses different BLP internal structure than Civ 7
2. **No DDS Magic:** Extracted data doesn't contain standard DDS headers
3. **Unknown Encoding:** Internal asset encoding not yet understood

## Next Steps

See [docs/investigation.md](./docs/investigation.md) for recommended approaches.

## Resources

- [Civ 6 Fandom Wiki - BLP](https://civ6.fandom.com/wiki/BLP)
- [Civ 7 BLP Format Specification](https://github.com/ghost-ng/blp-studio/wiki/BLP-Format-Specification)
- [BLP Studio (Civ 7 Tool)](https://github.com/ghost-ng/blp-studio)
- [Oodle Decompressor](https://github.com/baconwaifu/ooz)

## Licence

MIT
