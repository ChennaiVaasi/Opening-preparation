const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Chess } = require("chess.js");

const targetPath = process.argv[2];
const referencePath = process.argv[3] || ".\\Opening files.pgn";
const gameNumber = Number(process.argv[4] || 1);
const outputPath = process.argv[5] || `.\\opening-key-game-${gameNumber}.pgn`;
const depth = Number(process.argv[6] || 12);
const noEngine = process.argv.includes("--no-engine");

if (!targetPath) {
  console.error(
    "Usage: node unified_opening_generator.js <target.pgn> [reference.pgn] [game-number] [output.pgn] [depth]"
  );
  process.exit(1);
}

const config = {
  minPrefixPly: 8,
  maxPrefixPly: 20,
  maxSubsetGames: 80,
  minSubsetGames: 5,
  minKeyPlyGap: 1,
  rootMaxChildren: 2,
  replyMaxChildren: 4,
  sourceReplyMaxChildren: 6,
  branchMaxChildren: 1,
  transpositionLookaheadPlies: 3,
  engineMultiPv: 2,
  maxEngineOnlyChildren: 1,
  replyMaxEngineOnlyChildren: 0,
  forceEngineOnlyIfGapCp: 25,
  preferEngineIfGapCp: 35,
  enginePriorityDepth: 20,
  equalThresholdCp: 20,
  continueEngineGapCp: 20,
  practicalPreferenceGapCp: 10,
  strictReplyMaxChildren: 2,
  closeGapEngineChildren: 2,
  stopStableCp: 25,
  stopWinningStableCp: 35,
  stopChoiceGapCp: 70,
  minStopPlyFromRoot: 7,
  maxPlyFromRoot: 20,
  preserveGameLinePlies: 10,
};

function splitGames(pgnText) {
  const lines = pgnText.split(/\r?\n/);
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

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
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

function normalizeFen(fen) {
  return fen.trim().replace(/\s+/g, " ").split(" ").slice(0, 4).join(" ");
}

function createNode() {
  return { count: 0, children: new Map(), labels: [] };
}

function pushLabel(node, label) {
  if (!label) return;
  if (!node.labels.includes(label) && node.labels.length < 2) node.labels.push(label);
}

function insertLine(root, moves, label = null) {
  let node = root;
  node.count += 1;
  pushLabel(node, label);
  for (const san of moves) {
    if (!node.children.has(san)) node.children.set(san, createNode());
    node = node.children.get(san);
    node.count += 1;
    pushLabel(node, label);
  }
}

function sortChildren(node) {
  return [...node.children.entries()].sort((a, b) => {
    const diff = b[1].count - a[1].count;
    if (diff !== 0) return diff;
    return a[0].localeCompare(b[0]);
  });
}

function maxDescendantCount(node, depthLeft) {
  if (!node || depthLeft <= 0 || !node.children.size) return node ? node.count : 0;
  let best = node.count;
  for (const child of node.children.values()) {
    best = Math.max(best, maxDescendantCount(child, depthLeft - 1));
  }
  return best;
}

function entropy(map) {
  const total = [...map.values()].reduce((sum, value) => sum + value, 0);
  if (!total) return 0;
  let result = 0;
  for (const value of map.values()) {
    const p = value / total;
    result -= p * Math.log2(p);
  }
  return result;
}

function moveTag(move) {
  if (move.flags.includes("k") || move.flags.includes("q")) return "castling";
  if (move.flags.includes("c") || move.flags.includes("e")) return "capture";
  if (move.piece === "p") return "pawn move";
  return "piece placement";
}

function choosePrefixPly(prefixCounts) {
  for (let ply = config.minPrefixPly; ply <= config.maxPrefixPly; ply += 1) {
    const count = prefixCounts[ply] || 0;
    if (count >= config.minSubsetGames && count <= config.maxSubsetGames) return ply;
  }

  let bestPly = null;
  let bestCount = Infinity;
  for (let ply = config.minPrefixPly; ply <= config.maxPrefixPly; ply += 1) {
    const count = prefixCounts[ply] || 0;
    if (count >= config.minSubsetGames && count < bestCount) {
      bestCount = count;
      bestPly = ply;
    }
  }
  if (bestPly !== null) return bestPly;

  for (let ply = config.maxPrefixPly; ply >= 1; ply -= 1) {
    if ((prefixCounts[ply] || 0) > 0) return ply;
  }
  return Math.min(config.maxPrefixPly, prefixCounts.length - 1);
}

function buildPrefixStrings(history) {
  const replay = new Chess();
  const pieces = [];
  const prefixes = [""];
  for (let i = 0; i < history.length; i += 1) {
    const move = replay.move(history[i], { sloppy: true });
    if (!move) break;
    if (move.color === "w") {
      pieces.push(`${Math.ceil((i + 1) / 2)}. ${move.san}`);
    } else {
      pieces.push(move.san);
    }
    prefixes[i + 1] = pieces.join(" ");
  }
  return prefixes;
}

function chooseKeyPly(rows, subsetPrefixPly) {
  let best = null;
  for (let i = subsetPrefixPly + config.minKeyPlyGap; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (!prev || !prev.count || !curr.count) continue;
    const drop = (prev.count - curr.count) / prev.count;
    const nextEntropy = entropy(curr.nextMoves);
    const score =
      drop +
      (curr.tag === "piece placement" ? 0 : 0.35) +
      (curr.count <= 30 ? 0.35 : curr.count <= 80 ? 0.15 : 0) +
      (nextEntropy <= 1.0 ? 0.4 : nextEntropy <= 1.5 ? 0.2 : 0);

    const reasons = [];
    if (drop >= 0.35) reasons.push(`reference count dropped ${Math.round(drop * 100)}%`);
    if (curr.count <= 30) reasons.push(`only ${curr.count} reference games remain`);
    if (nextEntropy <= 1.0 && curr.nextMoves.size > 0) reasons.push("the next-move tree becomes narrow");
    if (curr.tag === "castling") reasons.push("setup phase ends here");
    if (curr.tag === "capture" || curr.tag === "pawn move") {
      reasons.push(`this move makes the structure more permanent`);
    }

    if (!reasons.length) continue;
    if (!best || score > best.score) {
      best = { index: i, score, drop, entropy: nextEntropy, reasons };
    }
  }
  if (best) return rows[best.index];
  for (let i = rows.length - 1; i > subsetPrefixPly; i -= 1) {
    if (rows[i].count > 0) return rows[i];
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].count > 0) return rows[i];
  }
  return rows[Math.min(rows.length - 1, subsetPrefixPly)];
}

function cpFromLine(line) {
  if (!line) return null;
  if (line.scoreType === "mate") return line.score > 0 ? 100000 - line.score : -100000 - line.score;
  return line.score;
}

function cpForWhite(fen, line) {
  const cp = cpFromLine(line);
  if (cp === null) return null;
  const sideToMove = fen.trim().split(/\s+/)[1];
  return sideToMove === "w" ? cp : -cp;
}

function evalSymbol(cp) {
  if (cp >= 150) return "+-";
  if (cp >= 80) return "+/-";
  if (cp >= config.equalThresholdCp) return "+=";
  if (cp <= -150) return "-+";
  if (cp <= -80) return "-/+";
  if (cp <= -config.equalThresholdCp) return "=+";
  return "=";
}

function stopComment(cp) {
  return evalSymbol(cp);
}

function commentText(node) {
  const parts = [];
  if (node.isKeyMove) parts.push("KEY");
  if (node.sourceLabel) parts.push(node.sourceLabel);
  if (parts.length) return parts.join(" | ");
  if (node.sourceTag === "engine priority") return "engine!";
  if (node.sourceTag === "engine") return "engine";
  if (node.sourceTag === "game") return "source";
  return "source";
}

function shouldStop(history, currentEval, evalGap, plyFromRoot) {
  if (plyFromRoot < config.minStopPlyFromRoot) return false;
  if (history.length < 2) return false;
  if (evalGap !== null && Math.abs(evalGap) <= config.continueEngineGapCp) return false;
  const prev1 = history[history.length - 1];
  const prev2 = history[history.length - 2];
  const stableNow = Math.abs(currentEval - prev1) <= config.stopStableCp;
  const stablePrev = Math.abs(prev1 - prev2) <= config.stopStableCp;
  const clearChoice = evalGap !== null && Math.abs(evalGap) > config.stopChoiceGapCp;
  const winningStable =
    Math.abs(currentEval) >= 150 && Math.abs(currentEval - prev1) <= config.stopWinningStableCp;
  return (stableNow && stablePrev && !clearChoice) || winningStable || plyFromRoot >= config.maxPlyFromRoot;
}

function plyInfoFromFen(fen) {
  const parts = fen.trim().split(/\s+/);
  return { moveNumber: Number(parts[5]), sideToMove: parts[1] === "w" ? "w" : "b" };
}

function nextPly(moveNumber, sideToMove) {
  return sideToMove === "w"
    ? { moveNumber, sideToMove: "b" }
    : { moveNumber: moveNumber + 1, sideToMove: "w" };
}

function formatMove(moveNumber, sideToMove, san, forceBlackPrefix) {
  if (sideToMove === "w") return `${moveNumber}. ${san}`;
  return forceBlackPrefix ? `${moveNumber}... ${san}` : san;
}

function emitVariation(node, moveNumber, sideToMove, forceBlackPrefix = false, annotateCurrent = true) {
  const parts = [formatMove(moveNumber, sideToMove, node.san, forceBlackPrefix)];
  const note = annotateCurrent ? commentText(node) : "";
  if (note) parts.push(`{${note}}`);
  if (node.stopReason) parts.push(`{${node.stopReason}}`);
  if (!node.children.length) return parts.join(" ");

  const [main, ...vars] = node.children;
  const after = nextPly(moveNumber, sideToMove);
  parts.push(formatMove(after.moveNumber, after.sideToMove, main.san, false));
  if (main.stopReason) parts.push(`{${main.stopReason}}`);
  for (const variation of vars) {
    parts.push(`(${emitVariation(variation, after.moveNumber, after.sideToMove, true, true)})`);
  }
  const afterMain = nextPly(after.moveNumber, after.sideToMove);
  const continuation = emitContinuation(main.children, afterMain.moveNumber, afterMain.sideToMove, false);
  if (continuation) parts.push(continuation);
  return parts.join(" ");
}

function emitContinuation(nodes, moveNumber, sideToMove, annotateCurrent = true) {
  if (!nodes.length) return "";
  const [main, ...vars] = nodes;
  const parts = [formatMove(moveNumber, sideToMove, main.san, false)];
  const note = annotateCurrent ? commentText(main) : "";
  if (note) parts.push(`{${note}}`);
  if (main.stopReason) parts.push(`{${main.stopReason}}`);
  for (const variation of vars) {
    parts.push(`(${emitVariation(variation, moveNumber, sideToMove, true, true)})`);
  }
  const after = nextPly(moveNumber, sideToMove);
  const continuation = emitContinuation(main.children, after.moveNumber, after.sideToMove, false);
  if (continuation) parts.push(continuation);
  return parts.join(" ");
}

class Engine {
  constructor(depth) {
    this.depth = depth;
    this.enginePath = path.join(
      process.cwd(),
      "node_modules",
      "stockfish",
      "bin",
      "stockfish-18-lite-single.js"
    );
    this.proc = null;
    this.buffer = "";
    this.pending = null;
    this.cache = new Map();
  }

  async start() {
    this.proc = spawn(process.execPath, [this.enginePath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() || "";
      for (const line of lines) this._handleLine(line.trim());
    });
    this.proc.stderr.on("data", () => {});
  }

  stop() {
    if (this.proc && !this.proc.killed) this.proc.kill();
  }

  _handleLine(line) {
    if (!this.pending || !line) return;
    if (line.startsWith("info ")) {
      const parsed = line.match(/multipv (\d+).*score (cp|mate) (-?\d+).* pv (.+)$/);
      if (!parsed) return;
      const multipv = Number(parsed[1]);
      const scoreType = parsed[2];
      const score = Number(parsed[3]);
      const pvMoves = parsed[4].trim().split(/\s+/).filter(Boolean);
      const replay = new Chess(this.pending.fen);
      const sans = [];
      for (const uci of pvMoves) {
        const move = replay.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci[4],
        });
        if (!move) break;
        sans.push(move.san);
      }
      this.pending.lines.set(multipv, { scoreType, score, sans });
    }
    if (line.startsWith("bestmove ")) {
      const result = [...this.pending.lines.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
      this.cache.set(this.pending.key, result);
      const resolve = this.pending.resolve;
      this.pending = null;
      resolve(result);
    }
  }

  analyze(fen, multipv = 2) {
    const key = `${normalizeFen(fen)}|${multipv}|${this.depth}`;
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));

    return new Promise((resolve, reject) => {
      this.pending = { key, fen, lines: new Map(), resolve };
      const send = (cmd) => this.proc.stdin.write(cmd + "\n");
      try {
        send("uci");
        send(`setoption name MultiPV value ${multipv}`);
        send("ucinewgame");
        send(`position fen ${fen}`);
        send(`go depth ${this.depth}`);
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }
}

async function loadTargetGame() {
  const games = splitGames(fs.readFileSync(targetPath, "utf8"));
  if (gameNumber < 1 || gameNumber > games.length) {
    throw new Error(`Game number ${gameNumber} is out of range for ${games.length} games`);
  }
  const gameText = games[gameNumber - 1];
  const headers = parseHeaders(gameText);
  const chess = new Chess();
  chess.loadPgn(gameText, { newlineChar: /\r?\n/ });
  const history = chess.history();
  const replay = new Chess();
  const positions = [];
  for (let i = 0; i < history.length; i += 1) {
    const move = replay.move(history[i], { sloppy: true });
    positions.push({
      ply: i + 1,
      san: move.san,
      fen: normalizeFen(replay.fen()),
      fullFen: replay.fen(),
      tag: moveTag(move),
      nextMoves: new Map(),
      count: 0,
    });
  }
  return { gameText, headers, history, positions };
}

function scanPrefixCounts(prefixStrings, referenceGames) {
  const prefixCounts = Array(config.maxPrefixPly + 1).fill(0);
  const matchDepths = new Array(referenceGames.length).fill(0);
  const maxPrefixPly = Math.min(config.maxPrefixPly, prefixStrings.length - 1);

  for (let gameIndex = 0; gameIndex < referenceGames.length; gameIndex += 1) {
    const norm = normalizeText(referenceGames[gameIndex]);
    let matched = 0;
    for (let ply = maxPrefixPly; ply >= 1; ply -= 1) {
      if (norm.includes(prefixStrings[ply])) {
        matched = ply;
        break;
      }
    }
    matchDepths[gameIndex] = matched;
    for (let ply = 1; ply <= matched; ply += 1) {
      prefixCounts[ply] += 1;
    }
  }

  return { prefixCounts, matchDepths };
}

function collectSubsetGames(subsetPrefixPly, referenceGames, matchDepths) {
  return referenceGames.filter((_, index) => matchDepths[index] >= subsetPrefixPly);
}

function parseSubsetHistories(subsetGames) {
  const subsetHistories = [];
  for (const text of subsetGames) {
    const chess = new Chess();
    try {
      chess.loadPgn(text, { newlineChar: /\r?\n/ });
    } catch {
      continue;
    }
    subsetHistories.push({
      history: chess.history(),
      headers: parseHeaders(text),
      label: gameLabel(parseHeaders(text)),
    });
  }
  return subsetHistories;
}

function surname(name) {
  if (!name) return "?";
  const cleaned = name.split(",")[0].trim();
  const bits = cleaned.split(/\s+/).filter(Boolean);
  return bits[bits.length - 1] || cleaned;
}

function gameLabel(headers) {
  const white = surname(headers.White);
  const black = surname(headers.Black);
  if (white === "?" && black === "?") return "";
  return `${white}-${black}`;
}

function analyzeSubset(target, subsetHistories, subsetPrefixPly) {
  for (const entry of subsetHistories) {
    const gameHistory = entry.history;
    const max = Math.min(gameHistory.length, target.positions.length);
    for (let i = 0; i < max; i += 1) {
      if (gameHistory[i] !== target.history[i]) break;
      target.positions[i].count += 1;
      if (gameHistory[i + 1]) {
        const map = target.positions[i].nextMoves;
        map.set(gameHistory[i + 1], (map.get(gameHistory[i + 1]) || 0) + 1);
      }
    }
  }
  return chooseKeyPly(target.positions, subsetPrefixPly);
}

function collectTailsFromFen(rootFen, subsetHistories) {
  const tails = [];
  for (const entry of subsetHistories) {
    const history = entry.history;
    const replay = new Chess();
    for (let i = 0; i < history.length; i += 1) {
      const ok = replay.move(history[i], { sloppy: true });
      if (!ok) break;
      if (normalizeFen(replay.fen()) === rootFen) {
        tails.push({ moves: history.slice(i + 1), label: entry.label });
        break;
      }
    }
  }
  return tails;
}

async function buildBranch(chess, dbNode, engines, state) {
  const lines = await engines.base.analyze(chess.fen(), config.engineMultiPv);
  const best = lines[0] || null;
  const second = lines[1] || null;
  const bestEval = cpForWhite(chess.fen(), best) ?? 0;
  const secondEval = second ? cpForWhite(chess.fen(), second) : null;
  const evalGap = secondEval !== null ? bestEval - secondEval : null;
  const strongEnginePreference = evalGap === null || Math.abs(evalGap) >= config.preferEngineIfGapCp;

  const isReplyToKey = state.plyFromRoot === 1;
  const isReplyToSource = !!state.expandOpponentReplies;
  const limit =
    state.plyFromRoot === 0
      ? config.rootMaxChildren
      : isReplyToKey
        ? config.replyMaxChildren
        : isReplyToSource
          ? config.sourceReplyMaxChildren
          : config.branchMaxChildren;
  const candidateMap = new Map();
  const gameSan = state.gameTail && state.gameTail.length ? state.gameTail[0] : null;

  const dbCandidates = sortChildren(dbNode).slice(0, limit);
  for (const [san, child] of dbCandidates) {
    candidateMap.set(san, {
      san,
      child,
      source: "db",
      dbCount: child.count,
      futureCount:
        isReplyToKey || isReplyToSource
          ? maxDescendantCount(child, config.transpositionLookaheadPlies)
          : child.count,
      engineRank: null,
      sourceLabel: child.labels[0] || null,
    });
  }

  if (gameSan && !candidateMap.has(gameSan)) {
    const gameChild = dbNode.children.get(gameSan) || createNode();
    candidateMap.set(gameSan, {
      san: gameSan,
      child: gameChild,
      source: "game",
      dbCount: gameChild.count || 0,
      futureCount: isReplyToKey || isReplyToSource
        ? maxDescendantCount(gameChild, config.transpositionLookaheadPlies)
        : gameChild.count || 0,
      engineRank: null,
      sourceTag: "game",
      sourceLabel: gameChild.labels[0] || null,
    });
  }

  const closeGapExtraEngineBudget =
    gameSan && evalGap !== null && Math.abs(evalGap) <= config.continueEngineGapCp
      ? config.closeGapEngineChildren
      : 0;
  const engineOnlyBudget =
    state.plyFromRoot === 0
      ? config.maxEngineOnlyChildren + 1
      : isReplyToKey
        ? config.replyMaxEngineOnlyChildren
        : isReplyToSource
          ? Math.max(config.maxEngineOnlyChildren, closeGapExtraEngineBudget)
        : Math.max(config.maxEngineOnlyChildren, closeGapExtraEngineBudget);
  for (let i = 0; i < Math.min(lines.length, engineOnlyBudget); i += 1) {
    const line = lines[i];
    const san = line && line.sans[0];
    if (!san) continue;
    if (!candidateMap.has(san)) {
      candidateMap.set(san, {
        san,
        child: createNode(),
        source: "engine",
        dbCount: 0,
        futureCount: 0,
        engineRank: i,
        sourceTag: "engine",
        sourceLabel: null,
      });
    } else if (candidateMap.get(san).engineRank === null) {
      candidateMap.get(san).engineRank = i;
    }
  }

  let children = [...candidateMap.values()].sort((a, b) => {
    const aRank = a.engineRank ?? 99;
    const bRank = b.engineRank ?? 99;

    if (a.dbCount !== b.dbCount) {
      return b.dbCount - a.dbCount;
    }

    if ((isReplyToKey || isReplyToSource) && (a.futureCount || 0) !== (b.futureCount || 0)) {
      return (b.futureCount || 0) - (a.futureCount || 0);
    }

    if (aRank !== bRank) return aRank - bRank;
    return a.san.localeCompare(b.san);
  });

  const topDb = children.find((item) => item.dbCount > 0);
  const topEngine = children.find((item) => item.engineRank === 0);
  const gameCandidate = gameSan ? candidateMap.get(gameSan) : null;
  const selected = [];
  const usedSans = new Set();

  function addCandidate(item) {
    if (!item || usedSans.has(item.san)) return;
    selected.push(item);
    usedSans.add(item.san);
  }

  function replyBreadth(item) {
    return item && item.child && item.child.children ? item.child.children.size : 99;
  }

  const closeEngineChoices = [...candidateMap.values()].filter((item) => item.engineRank !== null && item.engineRank <= 1);
  let practicalPressureChoice = null;
  if (
    state.plyFromRoot > 0 &&
    closeEngineChoices.length >= 2 &&
    evalGap !== null &&
    Math.abs(evalGap) <= config.practicalPreferenceGapCp
  ) {
    const ranked = [...closeEngineChoices].sort((a, b) => {
      const breadthDiff = replyBreadth(a) - replyBreadth(b);
      if (breadthDiff !== 0) return breadthDiff;
      return (a.engineRank ?? 99) - (b.engineRank ?? 99);
    });
    const candidate = ranked[0];
    if (candidate && replyBreadth(candidate) <= config.strictReplyMaxChildren) {
      practicalPressureChoice = candidate;
    }
  }

  const engineBetterThanGame =
    topDb &&
    topEngine &&
    topEngine.san !== topDb.san &&
    topEngine.engineRank === 0 &&
    strongEnginePreference;

  if (practicalPressureChoice) {
    practicalPressureChoice.sourceTag = "engine priority";
    addCandidate(practicalPressureChoice);
  }

  if (gameCandidate) {
    addCandidate(gameCandidate);
  }

  if (topDb) {
    addCandidate(topDb);
    if (topDb.engineRank === 0 && strongEnginePreference) {
      topDb.sourceTag = "engine priority";
    }
  }

  if (topEngine && (!topDb || topEngine.san !== topDb.san) && engineBetterThanGame) {
    topEngine.sourceTag = strongEnginePreference ? "engine priority" : "engine";
    addCandidate(topEngine);
  }

  for (const item of children) {
    const extraBudget = isReplyToKey ? config.replyMaxEngineOnlyChildren : config.maxEngineOnlyChildren;
    if (selected.length >= limit + extraBudget) break;
    addCandidate(item);
  }

  const built = [];
  for (const candidate of selected) {
    const { san, child } = candidate;
    const next = new Chess(chess.fen());
    const ok = next.move(san, { sloppy: true });
    if (!ok) continue;

    const childLines = await engines.base.analyze(next.fen(), config.engineMultiPv);
    const childBest = childLines[0] || null;
    const childSecond = childLines[1] || null;
    const childEval = cpForWhite(next.fen(), childBest) ?? bestEval;
    const childSecondEval = childSecond ? cpForWhite(next.fen(), childSecond) : null;
    const childGap = childSecondEval !== null ? childEval - childSecondEval : null;
    const nextHistory = [...state.evalHistory, childEval].slice(-3);
    const nextGameTail =
      gameSan && san === gameSan && state.gameTail && state.gameTail.length > 1
        ? state.gameTail.slice(1)
        : null;

    const node = {
      san,
      children: [],
      stopReason: null,
      sourceTag: candidate.sourceTag || null,
      sourceLabel: candidate.sourceLabel || null,
    };
    const preserveGameLine =
      nextGameTail &&
      nextGameTail.length > 0 &&
      state.plyFromRoot + 1 < config.preserveGameLinePlies;
    if (!preserveGameLine && shouldStop(nextHistory, childEval, childGap, state.plyFromRoot + 1)) {
      let finalEval = childEval;
      if (candidate.sourceTag === "engine priority") {
        const priorityLines = await engines.priority.analyze(next.fen(), 1);
        const priorityBest = priorityLines[0] || null;
        finalEval = cpForWhite(next.fen(), priorityBest) ?? childEval;
      }
      node.stopReason = stopComment(finalEval);
    } else {
      node.children = await buildBranch(next, child, engines, {
        plyFromRoot: state.plyFromRoot + 1,
        evalHistory: nextHistory,
        gameTail: nextGameTail,
        expandOpponentReplies: !!nextGameTail,
      });
    }
    built.push(node);
  }
  return built;
}

async function main() {
  const target = await loadTargetGame();
  if (!target.history.length) {
    const header = [
      `[Event "Unified Opening Generator Output"]`,
      `[Site "?"]`,
      `[Date "2026.06.06"]`,
      `[Round "?"]`,
      `[White "${target.headers.White || "?"}"]`,
      `[Black "${target.headers.Black || "?"}"]`,
      `[Result "${target.headers.Result || "*"}"]`,
      `[SourceGame "${path.basename(targetPath)}#${gameNumber}"]`,
      `[SourceReference "${path.basename(referencePath)}"]`,
      `[CodexStatus "empty-source-game"]`,
      "",
    ].join("\n");
    fs.writeFileSync(outputPath, `${header}{No movetext in source game.} ${target.headers.Result || "*"}\n`, "utf8");
    fs.writeFileSync(
      outputPath.replace(/\.pgn$/i, ".json"),
      JSON.stringify(
        {
          outputPath,
          gameNumber,
          players: `${target.headers.White || "?"} vs ${target.headers.Black || "?"}`,
          status: "empty-source-game",
          moveCount: 0,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`Game: ${target.headers.White || "?"} vs ${target.headers.Black || "?"}`);
    console.log(`Wrote ${outputPath} (empty source game)`);
    return;
  }
  const referenceGames = splitGames(fs.readFileSync(referencePath, "utf8"));
  const prefixStrings = buildPrefixStrings(target.history);
  const { prefixCounts, matchDepths } = scanPrefixCounts(prefixStrings, referenceGames);
  const subsetPrefixPly = choosePrefixPly(prefixCounts);
  const subsetGames = collectSubsetGames(subsetPrefixPly, referenceGames, matchDepths);
  const subsetHistories = parseSubsetHistories(subsetGames);
  const keyRow = analyzeSubset(target, subsetHistories, subsetPrefixPly);
  const rootPosition =
    keyRow.ply > 1
      ? target.positions[keyRow.ply - 2]
      : {
          fen: normalizeFen(new Chess().fen()),
          fullFen: new Chess().fen(),
        };
  const rootFen = rootPosition.fen;
  const rootFullFen = rootPosition.fullFen;
  const tails = collectTailsFromFen(rootFen, subsetHistories);
  const root = createNode();
  for (const tail of tails) insertLine(root, tail.moves, tail.label);

  const engines = {
    base: new Engine(depth),
    priority: new Engine(config.enginePriorityDepth),
  };
  await engines.base.start();
  await engines.priority.start();
  const tree = await buildBranch(new Chess(rootFullFen), root, engines, {
    plyFromRoot: 0,
    evalHistory: [],
    gameTail: target.history.slice(keyRow.ply - 1),
  });
  if (tree[0]) tree[0].isKeyMove = true;
  engines.base.stop();
  engines.priority.stop();

  const { moveNumber, sideToMove } = plyInfoFromFen(rootFullFen);
  const treeBody = emitContinuation(tree, moveNumber, sideToMove);
  const prefixBody = prefixStrings[keyRow.ply - 1] || "";
  const body = prefixBody ? `${prefixBody} ${treeBody}` : treeBody;
  const moveSequence = target.history.slice(0, keyRow.ply - 1).join(" ");
  const header = [
    `[Event "Unified Opening Generator Output"]`,
    `[Site "?"]`,
    `[Date "2026.06.06"]`,
    `[Round "?"]`,
    `[White "${target.headers.White || "?"}"]`,
    `[Black "${target.headers.Black || "?"}"]`,
    `[Result "*"]`,
    `[SourceGame "${path.basename(targetPath)}#${gameNumber}"]`,
    `[SourceReference "${path.basename(referencePath)}"]`,
    `[CodexPrefixPly "${subsetPrefixPly}"]`,
    `[CodexSubsetGames "${subsetGames.length}"]`,
    `[CodexKeyPly "${keyRow.ply}"]`,
    `[CodexKeyMove "${keyRow.san}"]`,
    `[CodexKeyCount "${keyRow.count}"]`,
    `[CodexReferenceGames "${tails.length}"]`,
    `[CodexEngineDepth "${noEngine ? "none" : depth}"]`,
    `[CodexEnginePriorityDepth "${noEngine ? "none" : config.enginePriorityDepth}"]`,
    `[CodexEqualBand "${noEngine ? "none" : "-0.20 to 0.20"}"]`,
    `[CodexRootLine "${moveSequence}"]`,
    "",
  ].join("\n");

  fs.writeFileSync(outputPath, `${header}${body} *\n`, "utf8");

  const summary = {
    outputPath,
    gameNumber,
    players: `${target.headers.White || "?"} vs ${target.headers.Black || "?"}`,
    subsetPrefixPly,
    subsetGames: subsetHistories.length,
    keyPly: keyRow.ply,
    keyMove: keyRow.san,
    keyCount: keyRow.count,
    rootFen: rootFullFen,
    referenceGamesFromFen: tails.length,
  };
  fs.writeFileSync(
    outputPath.replace(/\.pgn$/i, ".json"),
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log(`Game: ${summary.players}`);
  console.log(`Prefix ply: ${subsetPrefixPly} (${subsetHistories.length} subset games)`);
  console.log(`Key ply: ${summary.keyPly} move ${summary.keyMove} (${summary.keyCount} subset games remain)`);
  console.log(`Reference games from root FEN: ${summary.referenceGamesFromFen}`);
  console.log(`Wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
