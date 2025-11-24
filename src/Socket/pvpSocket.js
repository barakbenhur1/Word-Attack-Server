// src/Socket/pvpSocket.js
//
// Socket.IO PVP helpers:
// - pvp:join           => player joins a match room
// - pvp:coinflip       => any player asks "who starts?"
// - pvp:coinflipResult => sent back individually (youStart true/false)
// - pvp:rowDone        => player finished a row -> server flips turn
// - pvp:turn           => broadcast to room: whose turn is next, and which ROW
// - pvp:typing         => live typing mirroring
// - pvp:opponentLeft   => broadcast when the *other* player disconnects/leaves

const { randomUUID } = require("crypto");
const { pvpWordCache } = require("../Routers/pvp");

/**
 * match structure:
 *   {
 *     id: string,
 *     players: Map<playerId, { socketId, ticket?: number | null }>,
 *     playerRows: Map<playerId, number>,  // per-player row index (0..rows-1)
 *     coinflipResolved: boolean,
 *     starterPlayerId: string | null,
 *     currentTurnPlayerId: string | null
 *   }
 */
function createMatch(matchId) {
  return {
    id: matchId,
    players: new Map(),
    playerRows: new Map(),
    coinflipResolved: false,
    starterPlayerId: null,
    currentTurnPlayerId: null,
  };
}

module.exports = function registerPvpSocket(io) {
  // matchId -> match
  const matches = new Map();

  function getOrCreateMatch(matchId) {
    if (!matches.has(matchId)) {
      matches.set(matchId, createMatch(matchId));
    }
    return matches.get(matchId);
  }

  function cleanupEmptyMatches() {
    for (const [matchId, match] of matches.entries()) {
      if (match.players.size === 0) {
        console.log("[PVP] deleting empty match", matchId);
        matches.delete(matchId);

        // Also drop the cached word for this match (if any)
        try {
          if (pvpWordCache && typeof pvpWordCache.delete === "function") {
            pvpWordCache.delete(matchId);
          }
        } catch (e) {
          console.warn(
            "[PVP] error clearing pvpWordCache for match",
            matchId,
            e?.message || e
          );
        }
      }
    }
  }

  // Common leave/disconnect handling
  function handlePlayerLeave(socket) {
    for (const [matchId, match] of matches.entries()) {
      for (const [playerId, info] of match.players.entries()) {
        if (info.socketId === socket.id) {
          match.players.delete(playerId);
          match.playerRows.delete(playerId);

          console.log(
            `[PVP] removed player ${playerId} from match ${matchId} (leave/disconnect)`
          );

          // Notify remaining player(s) in this match
          socket.to(matchId).emit("pvp:opponentLeft", {
            matchId,
            playerId,
          });
        }
      }
    }

    cleanupEmptyMatches();
  }

  io.on("connection", (socket) => {
    console.log("[PVP] socket connected:", socket.id);

    // JOIN a match room
    socket.on("pvp:join", (payload = {}) => {
      try {
        const matchId = payload.matchId || randomUUID();
        const playerId = payload.playerId;

        if (!playerId) {
          socket.emit("pvp:error", {
            message: "playerId is required for pvp:join",
          });
          return;
        }

        const match = getOrCreateMatch(matchId);

        match.players.set(playerId, {
          socketId: socket.id,
          ticket: null,
        });

        // ensure per-player row counter exists
        if (!match.playerRows.has(playerId)) {
          match.playerRows.set(playerId, 0);
        }

        socket.join(matchId);

        console.log(`[PVP] player ${playerId} joined match ${matchId}`);

        socket.emit("pvp:joined", {
          ok: true,
          matchId,
        });

        socket.to(matchId).emit("pvp:playerJoined", {
          playerId,
        });
      } catch (err) {
        console.error("[PVP] error in pvp:join:", err);
        socket.emit("pvp:error", {
          message: "Internal error in pvp:join",
        });
      }
    });

    // COINFLIP:
    //
    // - First call:
    //     -> server picks starter among current players
    //     -> sets starterPlayerId/currentTurnPlayerId
    //     -> resets playerRows for a fresh round (both start at 0)
    //     -> emits pvp:coinflipResult(youStart true/false) to each player
    //
    // - Later calls:
    //     -> re-send same winner (no re-randomization)
    //
    socket.on("pvp:coinflip", (payload = {}) => {
      try {
        const { matchId, playerId, ticket } = payload;

        if (!matchId || !playerId) {
          socket.emit("pvp:error", {
            message: "matchId and playerId are required for pvp:coinflip",
          });
          return;
        }

        const match = matches.get(matchId);
        if (!match) {
          socket.emit("pvp:error", {
            message: "Match not found for given matchId",
          });
          return;
        }

        const playerInfo = match.players.get(playerId);
        if (!playerInfo) {
          socket.emit("pvp:error", {
            message: "Player not registered in this match",
          });
          return;
        }

        if (typeof ticket === "number" && !Number.isNaN(ticket)) {
          playerInfo.ticket = ticket;
        }

        console.log(
          `[PVP] coinflip request from player ${playerId} in match ${matchId}, ticket=${ticket}`
        );

        // Already resolved? just answer again
        if (match.coinflipResolved && match.starterPlayerId) {
          const youStart = playerId === match.starterPlayerId;
          console.log(
            "[PVP] coinflip already resolved for match",
            matchId,
            "starter=",
            match.starterPlayerId,
            "replying youStart=",
            youStart,
            "to",
            playerId
          );

          socket.emit("pvp:coinflipResult", {
            matchId,
            youStart,
            tie: false,
          });
          return;
        }

        // Not resolved yet: pick random starter
        const playerIds = Array.from(match.players.keys());
        if (playerIds.length === 0) {
          socket.emit("pvp:error", {
            message: "No players in match for coinflip",
          });
          return;
        }

        const starterIndex = Math.floor(Math.random() * playerIds.length);
        const starterPlayerId = playerIds[starterIndex];

        match.coinflipResolved = true;
        match.starterPlayerId = starterPlayerId;
        match.currentTurnPlayerId = starterPlayerId;

        // Reset per-player rows for a fresh round
        for (const pid of playerIds) {
          match.playerRows.set(pid, 0);
        }

        console.log(
          "[PVP] coinflip resolved (server random) for match",
          matchId,
          "starter=",
          starterPlayerId
        );

        // Per-player result
        for (const [pid, info] of match.players.entries()) {
          const s = io.sockets.sockets.get(info.socketId);
          if (!s) continue;

          const youStart = pid === starterPlayerId;
          s.emit("pvp:coinflipResult", {
            matchId,
            youStart,
            tie: false,
          });
        }
      } catch (err) {
        console.error("[PVP] error in pvp:coinflip:", err);
        socket.emit("pvp:error", {
          message: "Internal error in pvp:coinflip",
        });
      }
    });

    // ROW DONE:
    //
    //  - row is the index the PLAYER just finished on their OWN board
    //  - we bump that player's row counter
    //  - we set turn to the other player
    //  - nextRow we send = the OTHER player's next row index
    //
    //  => this gives the pattern:
    //      starter:  p1 row 0
    //                p2 row 0
    //                p1 row 1
    //                p2 row 1
    //                ...
    //
    socket.on("pvp:rowDone", (payload = {}) => {
      try {
        const { matchId, playerId, row } = payload;

        if (!matchId || !playerId || typeof row !== "number") {
          socket.emit("pvp:error", {
            message: "matchId, playerId, row are required for pvp:rowDone",
          });
          return;
        }

        const match = matches.get(matchId);
        if (!match) {
          socket.emit("pvp:error", {
            message: "Match not found for pvp:rowDone",
          });
          return;
        }

        if (!match.players.has(playerId)) {
          socket.emit("pvp:error", {
            message: "Player not in match for pvp:rowDone",
          });
          return;
        }

        // Enforce turn order
        if (
          match.currentTurnPlayerId &&
          match.currentTurnPlayerId !== playerId
        ) {
          console.warn("[PVP] pvp:rowDone turn mismatch", {
            matchId,
            playerId,
            current: match.currentTurnPlayerId,
          });
          return;
        }

        const playerIds = [...match.players.keys()];
        const otherPlayerId = playerIds.find((id) => id !== playerId) || null;

        // Get & bump this player's row index
        const currentRowForThisPlayer = match.playerRows.get(playerId) ?? 0;

        if (row !== currentRowForThisPlayer) {
          console.warn("[PVP] pvp:rowDone row mismatch", {
            matchId,
            playerId,
            rowClient: row,
            rowServer: currentRowForThisPlayer,
          });
          // Still accept; server's counter is source of truth
        }

        match.playerRows.set(playerId, currentRowForThisPlayer + 1);

        // Determine next row for the OTHER player
        let nextRowForOther = 0;
        if (otherPlayerId) {
          nextRowForOther = match.playerRows.get(otherPlayerId) ?? 0;
        }

        match.currentTurnPlayerId = otherPlayerId;

        console.log(
          "[PVP] rowDone match",
          matchId,
          "from",
          playerId,
          "-> nextTurn",
          otherPlayerId,
          "nextRowForOther",
          nextRowForOther
        );

        io.to(matchId).emit("pvp:turn", {
          matchId,
          nextPlayerId: otherPlayerId,
          nextRow: nextRowForOther,
        });
      } catch (err) {
        console.error("[PVP] error in pvp:rowDone:", err);
        socket.emit("pvp:error", {
          message: "Internal error in pvp:rowDone",
        });
      }
    });

    // Live typing
    socket.on("pvp:typing", (payload = {}) => {
      try {
        const { matchId, playerId, row, guess } = payload;
        if (!matchId || !playerId || typeof row !== "number") {
          return;
        }
        io.to(matchId).emit("pvp:typing", {
          matchId,
          playerId,
          row,
          guess,
        });
      } catch (err) {
        console.error("[PVP] error in pvp:typing:", err);
      }
    });

    // Explicit leave from queue / match
    socket.on("pvp:queue:leave", () => {
      console.log("[PVP] pvp:queue:leave from socket:", socket.id);
      handlePlayerLeave(socket);
    });

    // Real socket disconnect
    socket.on("disconnect", () => {
      console.log("[PVP] socket disconnected:", socket.id);
      handlePlayerLeave(socket);
    });
  });
};
