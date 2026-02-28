# Civ 6 BLP File Format Investigation

## Summary

Investigation into extracting texture data from Civilization VI BLP files, specifically `strategicview_terraintypes.blp`.

## Update (2026-02-27)

Additional testing indicates these extracted Civ 6 strategic-view assets are not arbitrary unknown blobs:

- Raw chunk size: 87,552 bytes
- A consistent **176-byte prefix** appears before texture payload
- Remaining payload size: 87,376 bytes
- 87,376 exactly matches a full mip-chain for **256x256 BC3/DXT5**
- Wrapping payload with a DDS header produces readable DDS files (validated with `file` and `identify`)

This strongly suggests these entries are Civ 6 texture data with a game-specific wrapper/prefix instead of standard DDS headers.

## Target File

```
/home/bmaupin/.local/share/Steam/steamapps/common/Sid Meier's Civilization VI/steamassets/base/platforms/windows/blps/strategicview/strategicview_terraintypes.blp
```

## Key Findings

### 1. BLP Format Differences

**Critical Discovery:** Civilization VI and VII use **different BLP formats**

- **Civ 7 BLP Format:**
  - Magic: "CIVBLP"
  - File header: 1024 bytes
  - Uses external CIVBIG container files or embedded BigData
  - Well-documented: https://github.com/ghost-ng/blp-studio/wiki/BLP-Format-Specification

- **Civ 6 BLP Format:**
  - Also uses "CIVBLP" magic (confirmed)
  - Header structure differs from Civ 7
  - File header: 512 bytes (vs 1024 in Civ 7)
  - **Not well-documented publicly**

### 2. File Analysis Results

**File:** `strategicview_terraintypes.blp`

- Size: 1,268,736 bytes
- Contains: 14 embedded assets
- BigData offset: 43,008 bytes
- Each asset appears to be: ~87,552 bytes

**Structure confirmed:**

```
Offset 0x00: "CIVBLP" magic ✅
Offset 0x08: packageDataOffset = 0x400 (1024)
Offset 0x0c: packageDataSize = 41,984 bytes
Offset 0x10: bigDataOffset = 43,008 bytes
Offset 0x14: bigDataCount = 14 assets
```

### 3. Extraction Attempts

**What Worked:**

- ✅ Parsing basic BLP header structure
- ✅ Identifying embedded asset count (14)
- ✅ Locating BigData section offset
- ✅ Extracting raw data blocks

**What Didn't Work:**

- ❌ No DDS magic bytes ("DDS ") found in extracted data
- ❌ Data doesn't match expected CIVBIG format
- ❌ Unknown internal structure within BigData section

**Data pattern observed:**

```
0000a800: 0000 0000 0000 0000 af32 8e2a ffff ffff
0000a810: 0000 0000 0000 0002 2f3b ae2a 5555 5525
...
```

- Not raw DDS format
- Not CIVBIG containers
- Possibly compressed or encoded differently

### 4. Compression Status

- ❌ No Oodle Kraken signature (0x8C) detected
- Data appears uncompressed but in unknown format
- May use different compression or encoding specific to Civ 6

## Tools Evaluated

### BLP Studio (Civ 7 Tool)

- **Source:** https://github.com/ghost-ng/blp-studio
- **Version:** 0.5.0-portable
- **Purpose:** Extract/modify BLP files for Civilization VII
- **Status:** Works under Wine, but designed for Civ 7 format
- **Compatibility with Civ 6:** Unknown/untested

### Oodle Decompressor (ooz)

- **Source:** https://github.com/baconwaifu/ooz
- **Purpose:** Decompress Oodle Kraken compressed data
- **Status:** Not needed (no compression detected in Civ 6 BLP)

### Custom TypeScript Extractor

- **Files created:** `investigate-blp.ts`, `extract-blp.ts`
- **Status:** Partially functional
  - ✅ Parses Civ 7-style headers
  - ✅ Extracts raw data blocks
  - ❌ Cannot interpret Civ 6-specific internal structure

## Next Steps

### Option 1: Reverse Engineer Civ 6 Format

**Pros:**

- Full understanding of format
- Custom extraction possible
- No external dependencies

**Cons:**

- Time-consuming
- Requires binary format analysis
- May need multiple sample files

**Approach:**

1. Analyse package data section (TypeInfoStripe)
2. Parse type system to understand object layout
3. Decode PackageBlock using type definitions
4. Extract texture entries with proper metadata

### Option 2: Use Existing Civ 6 Modding Tools

**Pros:**

- Proven to work with Civ 6
- Faster solution
- Community support

**Cons:**

- May require Windows/Wine
- Less control over process
- Tool-specific workflows

**Known Tools:**

- Civ 6 Mod Buddy (official)
- Community texture extraction tools
- Asset Studio / UABE (if assets are Unity-based)

### Option 3: Examine Civ 6 Asset Manager

**Location:**

```
~/.local/share/Steam/steamapps/common/Sid Meier's Civilization VI SDK Assets
```

- Contains pantry/ArtDefs/Textures
- May have original source assets
- Worth checking for DDS files directly

### Option 4: Test BLP Studio with Civ 6 Files

- Try opening Civ 6 BLP in BLP Studio under Wine
- May have backward compatibility
- Could reveal format differences visually

## Resources

### Documentation

- [Civ 7 BLP Format Spec](https://github.com/ghost-ng/blp-studio/wiki/BLP-Format-Specification)
- [Civ 7 BLP 101](https://github.com/ghost-ng/blp-studio/wiki/BLP-101)

### Related Files

- `strategicview_terraintypes.blp` - 14 terrain textures
- `strategicview_terrainblends.blp` - 13MB, terrain blending
- `strategicview_features.blp` - 22MB, terrain features

### Strategic View Files in Civ 6

```
~/.local/share/Steam/steamapps/common/Sid Meier's Civilization VI/steamassets/base/platforms/windows/blps/strategicview/
├── strategicview_buildings.blp (36MB)
├── strategicview_cities.blp (1.2MB)
├── strategicview_districts.blp (2.0MB)
├── strategicview_features.blp (22MB)
├── strategicview_improvements.blp (7.9MB)
├── strategicview_routes.blp (5.4MB)
├── strategicview_terraintypes.blp (1.3MB) ← Target
└── ... (other files)
```

## Conclusion

The Civ 6 BLP format differs significantly from the documented Civ 7 format. While basic header parsing works, the internal structure requires either:

1. Civ 6-specific documentation (unavailable)
2. Reverse engineering the format
3. Using existing Civ 6 modding tools

**Recommended:** Explore existing Civ 6 modding community tools or check if BLP Studio has backward compatibility before investing time in reverse engineering.
