const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Store active games and players
const games = new Map();
const waitingPlayers = [];

// Serve static files
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Handle player joining queue
    socket.on('join-queue', (playerData) => {
        const player = {
            id: socket.id,
            name: playerData.name || `Player_${socket.id.substring(0, 6)}`,
            socket: socket
        };

        // Check if there's a waiting player
        if (waitingPlayers.length > 0) {
            const opponent = waitingPlayers.shift();

            // Create new game
            const gameId = `game_${Date.now()}`;
            const game = {
                id: gameId,
                players: {
                    player1: player,
                    player2: opponent
                },
                gameState: {
                    currentTurn: 'player1',
                    turnCount: 1,
                    gamePhase: 'playing',
                    player1: {
                        ip: 100.0,
                        tokens: 10,
                        hand: [],
                        blockDamage: 0,
                        damageOverTime: { active: false, value: 0, turns: 0 },
                        healOverTime: { active: false, value: 0, turns: 0 },
                        doubleDamageNextTurn: false,
                        reflectDamage: { active: false, value: 0, turns: 0 },
                        isIPIrrational: false,
                        isIPImaginary: false,
                        selectedBranch: '',
                        inGracePeriod: false,
                        graceRoundsRemaining: -1,
                        angle: 0
                    },
                    player2: {
                        ip: 100.0,
                        tokens: 10,
                        hand: [],
                        blockDamage: 0,
                        damageOverTime: { active: false, value: 0, turns: 0 },
                        healOverTime: { active: false, value: 0, turns: 0 },
                        doubleDamageNextTurn: false,
                        reflectDamage: { active: false, value: 0, turns: 0 },
                        isIPIrrational: false,
                        isIPImaginary: false,
                        selectedBranch: '',
                        inGracePeriod: false,
                        graceRoundsRemaining: -1,
                        angle: 0
                    }
                }
            };

            games.set(gameId, game);

            // Join both players to game room
            player.socket.join(gameId);
            opponent.socket.join(gameId);

            // Notify both players that game started
            io.to(gameId).emit('game-start', {
                gameId: gameId,
                players: {
                    player1: { name: player.name, id: player.id },
                    player2: { name: opponent.name, id: opponent.id }
                },
                gameState: game.gameState
            });

            // Tell each player their role
            player.socket.emit('player-role', { role: 'player1', opponent: opponent.name });
            opponent.socket.emit('player-role', { role: 'player2', opponent: player.name });

        } else {
            // Add to waiting queue
            waitingPlayers.push(player);
            socket.emit('waiting-for-opponent');
        }
    });

    // Handle game moves
    socket.on('make-move', (data) => {
        const game = findGameByPlayerId(socket.id);
        if (!game) return;

        // Validate move and update game state
        if (isValidMove(game, socket.id, data)) {
            updateGameState(game, data);

            // Broadcast updated state to both players
            io.to(game.id).emit('game-update', {
                gameState: game.gameState,
                move: data
            });

            // Check for game end
            if (checkGameEnd(game)) {
                const winner = getWinner(game);
                io.to(game.id).emit('game-end', { winner: winner });
                games.delete(game.id);
            }
        }
    });

    // Handle chat messages
    socket.on('chat-message', (data) => {
        const game = findGameByPlayerId(socket.id);
        if (!game) return;

        const player = getPlayerRole(game, socket.id);
        io.to(game.id).emit('chat-message', {
            player: player,
            message: data.message,
            timestamp: Date.now()
        });
    });

    // Handle player disconnect
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);

        // Remove from waiting queue
        const waitingIndex = waitingPlayers.findIndex(p => p.id === socket.id);
        if (waitingIndex > -1) {
            waitingPlayers.splice(waitingIndex, 1);
        }

        // Handle game disconnect
        const game = findGameByPlayerId(socket.id);
        if (game) {
            socket.to(game.id).emit('opponent-disconnected');
            games.delete(game.id);
        }
    });
});

// Helper functions
function findGameByPlayerId(playerId) {
    for (const game of games.values()) {
        if (game.players.player1.id === playerId || game.players.player2.id === playerId) {
            return game;
        }
    }
    return null;
}

function getPlayerRole(game, playerId) {
    if (game.players.player1.id === playerId) return 'player1';
    if (game.players.player2.id === playerId) return 'player2';
    return null;
}

function isValidMove(game, playerId, moveData) {
    const playerRole = getPlayerRole(game, playerId);
    return playerRole === game.gameState.currentTurn;
}

function updateGameState(game, moveData) {
    // Update game state based on move
    // This would contain the actual game logic
    const currentPlayer = game.gameState.currentTurn;
    const nextPlayer = currentPlayer === 'player1' ? 'player2' : 'player1';

    // Apply move effects to game state
    if (moveData.type === 'play-card') {
        // Handle card play logic
        applyCardEffect(game, currentPlayer, moveData.card);
    } else if (moveData.type === 'end-turn') {
        // Handle turn end
        game.gameState.currentTurn = nextPlayer;
        game.gameState.turnCount++;
    }
}

function applyCardEffect(game, player, card) {
    // Implement card effect logic based on the original game
    const targetPlayer = player === 'player1' ? 'player2' : 'player1';
    const gameState = game.gameState;

    // This would contain the full card effect logic from the original game
    switch(card.type) {
        case 'damage':
            gameState[targetPlayer].ip -= card.value;
            break;
        case 'heal':
            gameState[player].ip += card.value;
            break;
        // Add more card types as needed
    }
}

function checkGameEnd(game) {
    return game.gameState.player1.ip <= 0 || game.gameState.player2.ip <= 0;
}

function getWinner(game) {
    if (game.gameState.player1.ip <= 0) return 'player2';
    if (game.gameState.player2.ip <= 0) return 'player1';
    return null;
}

server.listen(PORT, () => {
    console.log(`🚀 Multiplayer Card Battle Server running on port ${PORT}`);
    console.log(`🌐 Game URL: http://localhost:${PORT}`);
    console.log(`👥 Waiting for players to connect...`);
});
