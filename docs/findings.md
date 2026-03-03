# Findings so far

- Civ 6 uses a BLP package format
  - Civ 7 uses a newer version of the BLP format
  - See docs/llm/references.md for references
- BLP files were generated from source textures in Sid Meier's Civilization VI SDK Assets (Civ 6 SDK Assets)
- Comparing the source textures from with the assets in the BLP files, we can observe:
  - Textures in BLP files keep the same dimensions as the source textures
  - Textures in BLP files so far are DXT5 compressed, whereas source textures are uncompressed
  - Textures in BLP files seem to lack the 2x2 and 1x1 mipmaps which are present in the source textures
  - Textures in BLP files may have other changes as it seems that Civ 6 SDK Assets may not have been updated with the latest source textures used to generate the BLP files
- The names for each asset in the BLP file are stored in the BLP file
- As the beginning of the BLP file contains a lot of undeciphered information, it may be easier to extract textures from the end of the file when working with a new BLP file
  - In particular, the last texture seems to end 176 bytes from the end of the BLP file
