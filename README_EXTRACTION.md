# Civ 6 BLP Texture Extractor

Extract DDS textures from Civilization VI BLP archive files.

## Quick Start

```bash
# Extract a single texture
npx tsx extract-primary-texture.ts workdir/strategicview_terrainsprites.blp 0 output/

# Extract all textures from a BLP (90 textures in this file)
for i in {0..89}; do
  npx tsx extract-primary-texture.ts workdir/strategicview_terrainsprites.blp $i output/
done
```

## What This Tool Does

- ✅ Extracts BC3/DXT5 compressed textures from Civ 6 BLP files
- ✅ Creates valid DDS files with proper headers
- ✅ Preserves all 7 mipmaps stored in the BLP
- ✅ Can extract any texture by index

## File Structure

- **blp-format.ts** - BLP format specification (documented structures)
- **extract-primary-texture.ts** - Simple extraction tool
- **extract-textures.ts** - Advanced extraction with metadata parsing
- **EXTRACTION_SUCCESS.md** - Detailed findings and validation
- **archive/** - Old investigation scripts

## Format Details

### BLP BigData Structure

Each texture in the BigData section:
- 176 bytes: Prefix (metadata/padding)
- 87,376 bytes: BC3/DXT5 texture data (7 mipmaps)

BC3/DXT5 compression:
- 256×256 main texture: 65,536 bytes
- 6 additional mipmaps: 21,840 bytes
- Lossy compression (expect ~25% visual difference from uncompressed)

### Civ 6 vs Reference Files

The reference files (SV_Sprites_HillsDesert_Color_*.dds) are:
- Uncompressed RGBA (4 bytes/pixel)
- 9 mipmaps total
- ~342 KB per file

The BLP stores:
- BC3/DXT5 compressed
- 7 mipmaps (drops 2 largest)
- ~87 KB per texture

## Converting to Other Formats

### To PNG (for viewing):
```bash
convert texture_0_bc3.dds texture_0.png
```

### To uncompressed DDS (for editing):
```bash
nvdecompress texture_0_bc3.dds texture_0_rgba.dds
```

## See Also

- [EXTRACTION_SUCCESS.md](EXTRACTION_SUCCESS.md) - Detailed analysis and findings
- [blp-format.ts](blp-format.ts) - Format specification
- [docs/references.md](docs/references.md) - External references
