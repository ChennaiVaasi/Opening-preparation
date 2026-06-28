# Opening Preparation

Node-based tools for generating chess opening preparation PGNs from:

- a source PGN file
- a reference PGN database
- local Stockfish analysis

## Included tools

- `unified_opening_generator.js`
  - Builds a move-1 PGN that highlights a detected key move and continues with a structured tree of reference and engine branches.
- `batch_opening_pipeline.js`
  - Runs the generator over a whole PGN collection and writes one output PGN per game.

## Install

```bash
npm install
```

## Single-game generation

```bash
node unified_opening_generator.js <target.pgn> <reference.pgn> <game-number> <output.pgn> <depth>
```

Example:

```bash
node unified_opening_generator.js ./games.pgn ./reference.pgn 32 ./output-game-32.pgn 12
```

## Batch generation

```bash
node batch_opening_pipeline.js <target.pgn> <reference.pgn> <outdir> --mode unified --depth 12
```

Example:

```bash
node batch_opening_pipeline.js ./games.pgn ./reference.pgn ./batch-output --mode unified --depth 12
```

## Current generator behavior

The unified generator currently tries to:

- detect a likely opening key move from reference-base uniqueness
- start the tree on that same ply
- preserve the source game line from move 1 in the exported PGN
- widen opponent replies after the source move
- keep close engine alternatives alive when the top choices are near-equal
- use stricter annotations based on evaluation bands

## Notes

- These tools expect a local Node environment with the `stockfish` npm package installed.
- Large reference PGNs can be used directly, but big batch runs may take time.
- Generated PGNs are written to local files; they are not stored automatically anywhere else.
