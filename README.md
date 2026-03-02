# Civ 6 BLP Extractor

> [!WARNING]
> Work in progress. Most of this project was created using AI; caveat emptor.

A tool for extracting embedded assets from Civilization VI BLP files with proper naming from embedded metadata.

## Status

✅ **Working** - Successfully extracts all embedded assets from Civ 6 BLP files as DDS textures.

- ✅ Extracts from `strategicview_terraintypes.blp` (14 assets)
- ✅ Extracts from `strategicview_terrainsprites.blp` (90 assets)
- ✅ All assets named dynamically from embedded BLP metadata
- ✅ All output as BC3/DXT5 DDS files (256×256 with mipmaps)

## Quick Start

```bash
# Install dependencies
npm install

# Extract a single asset by index
node extract-primary-texture.ts <blp-file> <asset-index> [output-dir]

# Example: Extract asset 0 from strategicview_terrainsprites.blp
node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp 0 workdir/extracted
```

## Main Tool: `extract-primary-texture.ts`

The primary extraction tool. Extracts individual texture assets by index from Civ 6 BLP files.

**Features:**

- Dynamically scans BLP package data for asset names (matching "SV\_\*" pattern)
- Correct offset calculation without additional skip bytes
- Builds DDS header and wraps BC3 payload
- Outputs properly named DDS files

**Usage:**

```bash
node extract-primary-texture.ts <blp-file> <asset-index> [output-dir]
```

**Parameters:**

- `<blp-file>`: Path to the BLP file
- `<asset-index>`: Index of asset to extract (0-based)
- `[output-dir]`: Output directory (default: current directory)

**Example:**

```bash
# Extract asset 5 from strategicview_terrainsprites.blp
node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp 5 workdir/extracted

# Extract all 90 assets (bash loop)
for i in {0..89}; do
  node extract-primary-texture.ts workdir/strategicview_terrainsprites.blp $i workdir/extracted
done
```

## Requirements

- Node.js 24+

## Installation

```bash
npm install
```

## How It Works

### Civ 6 BLP Format

Civ 6 BLP files contain embedded assets in a BigData section:

```
Offset  Field              Type     Size  Description
0x00    Magic              String   6     "CIVBLP"
0x08    packageDataOffset  UInt32   4     Offset to package data
0x0C    packageDataSize    UInt32   4     Size of package data
0x10    bigDataOffset      UInt32   4     Offset to embedded assets
0x14    bigDataCount       UInt32   4     Number of embedded assets
0x18    fileSize           UInt32   4     Total file size
```

### Asset Structure

Each asset is stored sequentially in the BigData section:

- **Asset Size**: 87,552 bytes (fixed)
- **Asset Format**: BC3/DXT5 compressed texture
- **Texture Dimensions**: 256×256 pixels
- **Mipmaps**: 7 levels (256×256 down to 4×4)
- **Payload Size**: 87,376 bytes (BC3 data only)

### Offset Calculation

To find asset N within the BigData section:

```
assetOffset = header.bigDataOffset + (assetIndex * 87552)
```

**Important**: No additional offset skip is needed. The 87,552 byte chunks directly contain BC3-compressed texture data.

### Asset Naming

Asset names are stored as null-terminated ASCII strings in the package data section, appearing in sequential order matching asset indices. Names follow the pattern `SV_*` (e.g., `SV_Sprites_HillsDesert_Color_1`).

The extraction tool dynamically scans the package data to locate and assign names to each asset based on its index.

### Output Format

Extracted assets are saved as DDS files with proper BC3/DXT5 headers:

- **Filename**: `{assetName}.dds` (e.g., `SV_Sprites_HillsDesert_Color_1.dds`)
- **Format**: BC3/DXT5 (Direct3D 9 compatible)
- **Header**: DDS with DX10 chunk for extended format information

## Architecture

### Key Files

- **[extract-primary-texture.ts](./extract-primary-texture.ts)**: Main extraction tool (recommended)
- **[blp-format.ts](./blp-format.ts)**: BLP header parsing and type definitions
- **[archive/extract-textures.ts](./archive/extract-textures.ts)**: Archived metadata-based extraction logic (kept for reference)

## Known Findings

From analysis of Civ 6 BLP files:

- **Civ 6 vs Civ 7**: Civ 6 uses a different format with preamble all zeros
- **Asset Storage**: Fixed 87,552-byte chunks, directly accessible without additional parsing
- **Texture Format**: BC3/DXT5 compression, standard for DX9 compatibility
- **Metadata**: Asset names embedded in package data as null-terminated strings

## Resources

- [Civ 6 Fandom Wiki - BLP](https://civ6.fandom.com/wiki/BLP)
- [Civ 7 BLP Format Specification](https://github.com/ghost-ng/blp-studio/wiki/BLP-Format-Specification)
- [BLP Studio (Civ 7 Tool)](https://github.com/ghost-ng/blp-studio)
- [Oodle Decompressor](https://github.com/baconwaifu/ooz)

## Licence

MIT
