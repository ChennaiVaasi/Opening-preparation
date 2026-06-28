const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function usage() {
  console.log(
    "Usage: node batch_opening_pipeline.js <target.pgn> <reference.pgn> <outdir> [--mode unified|db-only|narrow] [--from N] [--to N] [--depth N] [--narrow-plies N] [--force]"
  );
}

function getArg(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function splitGames(text) {
  const lines = text.split(/\r?\n/);
  const games = [];
  let chunk = [];
  for (const line of lines) {
    if (line.startsWith("[Event ") && chunk.length > 0) {
      games.push(chunk.join("\n").trim());
      chunk = [];
    }
    chunk.push(line);
  }
  if (chunk.join("").trim()) games.push(chunk.join("\n").trim());
  return games.filter(Boolean);
}

function parseHeaders(gameText) {
  const headers = {};
  for (const line of gameText.split(/\r?\n/)) {
    const match = line.match(/^\[(\w+)\s+"(.*)"\]$/);
    if (!match) break;
    headers[match[1]] = match[2];
  }
  return headers;
}

function safeName(text) {
  return String(text || "?")
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

const targetPath = process.argv[2];
const referencePath = process.argv[3];
const outDir = process.argv[4];

if (!targetPath || !referencePath || !outDir) {
  usage();
  process.exit(1);
}

const mode = getArg("--mode", "unified");
const depth = Number(getArg("--depth", "12"));
const narrowPlies = Number(getArg("--narrow-plies", "4"));
const force = hasFlag("--force");

const scriptByMode = {
  unified: "unified_opening_generator.js",
  "db-only": "db_only_opening_generator.js",
  narrow: "narrow_reference_generator.js",
};

if (!scriptByMode[mode]) {
  console.error(`Unknown mode: ${mode}`);
  usage();
  process.exit(1);
}

const targetText = fs.readFileSync(targetPath, "utf8");
const games = splitGames(targetText);
const from = Math.max(1, Number(getArg("--from", "1")));
const to = Math.min(games.length, Number(getArg("--to", String(games.length))));

fs.mkdirSync(outDir, { recursive: true });

const manifest = [];
const manifestPath = path.join(outDir, "batch-manifest.json");
const logPath = path.join(outDir, "batch-log.txt");
fs.writeFileSync(
  logPath,
  `Batch started ${new Date().toISOString()}\nmode=${mode}\nrange=${from}-${to}\n\n`,
  "utf8"
);

for (let gameNumber = from; gameNumber <= to; gameNumber += 1) {
  const headers = parseHeaders(games[gameNumber - 1]);
  const white = safeName(headers.White || "?");
  const black = safeName(headers.Black || "?");
  const date = safeName(headers.Date || headers.Year || "");
  const baseName = `${String(gameNumber).padStart(4, "0")}-${white}-vs-${black}${date ? `-${date}` : ""}`;
  const outputPath = path.join(outDir, `${baseName}.pgn`);
  const jsonPath = outputPath.replace(/\.pgn$/i, ".json");

  if (!force && fs.existsSync(outputPath)) {
    manifest.push({
      gameNumber,
      outputPath,
      status: "skipped",
      reason: "exists",
      white: headers.White || "?",
      black: headers.Black || "?",
    });
    fs.appendFileSync(logPath, `SKIP game ${gameNumber}: ${outputPath}\n`, "utf8");
    continue;
  }

  const scriptPath = path.join(path.dirname(targetPath), scriptByMode[mode]);
  const args = [scriptPath, targetPath, referencePath, String(gameNumber), outputPath];
  if (mode === "unified") args.push(String(depth));
  if (mode === "narrow") args.push(String(narrowPlies));

  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: path.dirname(targetPath),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const elapsedMs = Date.now() - started;

  if (result.status === 0) {
    let summary = null;
    if (fs.existsSync(jsonPath)) {
      try {
        summary = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch {}
    }
    manifest.push({
      gameNumber,
      outputPath,
      status: "ok",
      elapsedMs,
      white: headers.White || "?",
      black: headers.Black || "?",
      summary,
    });
    fs.appendFileSync(logPath, `OK   game ${gameNumber}: ${outputPath} (${elapsedMs} ms)\n`, "utf8");
  } else {
    manifest.push({
      gameNumber,
      outputPath,
      status: "error",
      elapsedMs,
      white: headers.White || "?",
      black: headers.Black || "?",
      error: (result.stderr || result.stdout || "unknown error").trim(),
    });
    fs.appendFileSync(
      logPath,
      `ERR  game ${gameNumber}: ${outputPath}\n${result.stderr || result.stdout || "unknown error"}\n\n`,
      "utf8"
    );
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

const ok = manifest.filter((item) => item.status === "ok").length;
const skipped = manifest.filter((item) => item.status === "skipped").length;
const errors = manifest.filter((item) => item.status === "error").length;

console.log(`Completed batch: ok=${ok}, skipped=${skipped}, errors=${errors}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Log: ${logPath}`);
