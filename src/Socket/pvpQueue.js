// src/sockets/pvpQueue.js
//
// Simple in-memory PVP matchmaking queue using Socket.IO.
// Language-aware: only players with the same `lang` are paired,
// and we NEVER match a player against themselves.
//

const { randomUUID } = require("crypto");

/**
 * @param {import("socket.io").Server} io
 */
module.exports = function initPvpQueue(io) {
  // Players waiting for a match
  // Each item: { socketId, playerId, lang, joinedAt }
  const waitingQueue = [];

  // Match data by matchId
  // matchId -> { players: [socketId1, socketId2], playerIds: { [socketId]: playerId }, lang }
  const matches = new Map();

  // Helper: remove a socket from the queue if it exists
  function removeFromQueueBySocketId(socketId) {
    const idx = waitingQueue.findIndex((p) => p.socketId === socketId);
    if (idx !== -1) {
      waitingQueue.splice(idx, 1);
    }
  }

  // Helper: remove any stale entries with the same playerId (e.g. old sockets)
  function removeFromQueueByPlayerId(playerId) {
    let removed = false;
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      if (waitingQueue[i].playerId === playerId) {
        waitingQueue.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      console.log("[PVP] removed stale queue entries for playerId", playerId);
    }
  }

  // Helper: find match info for a given socketId
  function findMatchBySocketId(socketId) {
    for (const [matchId, match] of matches.entries()) {
      if (match.players.includes(socketId)) {
        return { matchId, match };
      }
    }
    return null;
  }

  io.on("connection", (socket) => {
    console.log("[PVP] socket connected", socket.id);

    // Player wants to join queue
    // Payload: { playerId: string, lang?: "en" | "he" | ... }
    socket.on("pvp:queue:join", (payload = {}) => {
      const playerId = String(payload.playerId || "").trim();
      const lang = String(payload.lang || "en").toLowerCase(); // default EN

      if (!playerId) {
        socket.emit("pvp:error", { message: "Missing playerId" });
        return;
      }

      console.log("[PVP] queue:join", { socketId: socket.id, playerId, lang });

      // Avoid duplicates in queue:
      // - remove any entry for this socket
      // - remove any stale entry with the same playerId (old connection)
      removeFromQueueBySocketId(socket.id);
      removeFromQueueByPlayerId(playerId);

      // Try to find opponent with the same language BUT DIFFERENT playerId
      const opponentIdx = waitingQueue.findIndex(
        (p) => p.lang === lang && p.playerId !== playerId
      );

      if (opponentIdx !== -1) {
        // Found someone queued with the same language & different playerId
        const opponent = waitingQueue.splice(opponentIdx, 1)[0];
        const opponentSocket = io.sockets.sockets.get(opponent.socketId);

        // Opponent might have disconnected
        if (!opponentSocket) {
          console.log(
            "[PVP] opponent socket gone, re-queuing current player (lang)",
            lang
          );
          waitingQueue.push({
            socketId: socket.id,
            playerId,
            lang,
            joinedAt: Date.now(),
          });
          socket.emit("pvp:queue:waiting", { waiting: true, lang });
          return;
        }

        // Create a match id
        const matchId = randomUUID();

        // Join sockets to the same room
        socket.join(matchId);
        opponentSocket.join(matchId);

        // Save match info
        const matchData = {
          players: [socket.id, opponent.socketId],
          playerIds: {
            [socket.id]: playerId,
            [opponent.socketId]: opponent.playerId,
          },
          lang,
        };
        matches.set(matchId, matchData);

        console.log("[PVP] match created", {
          matchId,
          lang,
          p1: { socketId: socket.id, playerId },
          p2: { socketId: opponent.socketId, playerId: opponent.playerId },
        });

        // Notify both players
        socket.emit("pvp:matchFound", {
          matchId,
          you: playerId,
          opponentId: opponent.playerId,
          lang,
        });

        opponentSocket.emit("pvp:matchFound", {
          matchId,
          you: opponent.playerId,
          opponentId: playerId,
          lang,
        });
      } else {
        // No opponent yet for this language – put this player into the waiting queue
        waitingQueue.push({
          socketId: socket.id,
          playerId,
          lang,
          joinedAt: Date.now(),
        });
        console.log("[PVP] player queued", {
          socketId: socket.id,
          playerId,
          lang,
        });
        socket.emit("pvp:queue:waiting", { waiting: true, lang });
      }
    });

    // Player leaves the queue voluntarily
    socket.on("pvp:queue:leave", () => {
      console.log("[PVP] queue:leave", socket.id);
      removeFromQueueBySocketId(socket.id);
      socket.emit("pvp:queue:left", { ok: true });
    });

    // Optional: client can ask what matchId it's currently in
    socket.on("pvp:match:status", () => {
      const info = findMatchBySocketId(socket.id);
      if (!info) {
        socket.emit("pvp:match:status", { inMatch: false });
      } else {
        const { matchId, match } = info;
        socket.emit("pvp:match:status", {
          inMatch: true,
          matchId,
          players: match.playerIds,
          lang: match.lang,
        });
      }
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log("[PVP] socket disconnected", socket.id);

      // 1) Remove from queue if still waiting
      removeFromQueueBySocketId(socket.id);

      // 2) If was in a match, tell the opponent
      for (const [matchId, match] of matches.entries()) {
        if (!match.players.includes(socket.id)) continue;

        const otherSocketId = match.players.find((id) => id !== socket.id);
        const otherSocket = io.sockets.sockets.get(otherSocketId);

        matches.delete(matchId);

        if (otherSocket) {
          otherSocket.leave(matchId);
          otherSocket.emit("pvp:opponentLeft", {
            matchId,
            reason: "disconnect",
          });
        }
      }
    });
  });
};
