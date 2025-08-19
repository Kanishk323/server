const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = createServer(app);

// Configure CORS for Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple multiplayer game management
class MultiplayerGameManager {
    constructor() {
        this.rooms = new Map();
        this.waitingPlayers = [];
    }

    addWaitingPlayer(socket, playerData) {
        const player = {
            id: socket.id,
            socket: socket,
            name: playerData.name || `Player_${socket.id.substring(0, 6)}`
        };

        this.waitingPlayers.push(player);

        // If we have 2 players, create a room
        if (this.waitingPlayers.length >= 2) {
            const player1 = this.waitingPlayers.shift();
            const player2 = this.waitingPlayers.shift();

            const roomId = uuidv4();
            const room = {
                id: roomId,
                players: [player1, player2],
                gameState: null,
                createdAt: new Date()
            };

            this.rooms.set(roomId, room);

            // Join both players to the room
            player1.socket.join(roomId);
            player2.socket.join(roomId);

            // Notify players
            player1.socket.emit('gameFound', {
                roomId: roomId,
                opponent: player2.name,
                role: 'player1'
            });

            player2.socket.emit('gameFound', {
                roomId: roomId,
                opponent: player1.name,
                role: 'player2'
            });

            return room;
        }

        return null;
    }

    removePlayer(socketId) {
        // Remove from waiting list
        this.waitingPlayers = this.waitingPlayers.filter(p => p.id !== socketId);

        // Remove from rooms
        for (let [roomId, room] of this.rooms.entries()) {
            const playerIndex = room.players.findIndex(p => p.id === socketId);
            if (playerIndex !== -1) {
                // Notify other player
                const otherPlayer = room.players[1 - playerIndex];
                if (otherPlayer && otherPlayer.socket) {
                    otherPlayer.socket.emit('opponentDisconnected');
                }

                // Remove room after delay
                setTimeout(() => {
                    this.rooms.delete(roomId);
                }, 30000);

                break;
            }
        }
    }

    getRoom(roomId) {
        return this.rooms.get(roomId);
    }
}

const gameManager = new MultiplayerGameManager();

// Serve the main game file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeRooms: gameManager.rooms.size,
        waitingPlayers: gameManager.waitingPlayers.length
    });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    let currentRoom = null;

    // Handle joining multiplayer queue
    socket.on('joinMultiplayer', (playerData) => {
        console.log('Player joining multiplayer:', playerData);

        const room = gameManager.addWaitingPlayer(socket, playerData);

        if (!room) {
            socket.emit('waitingForOpponent');
        }
    });

    // Handle game state synchronization
    socket.on('gameStateUpdate', (data) => {
        if (currentRoom) {
            // Broadcast game state to other players in room
            socket.to(currentRoom).emit('gameStateSync', data);
        }
    });

    // Handle card plays (sync between players)
    socket.on('cardPlayed', (data) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentCardPlayed', data);
        }
    });

    // Handle turn changes
    socket.on('turnEnded', (data) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentTurnEnded', data);
        }
    });

    // Handle game end
    socket.on('gameEnded', (data) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentGameEnded', data);
        }
    });

    // Handle chat messages
    socket.on('chatMessage', (data) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentChatMessage', {
                message: data.message,
                timestamp: new Date()
            });
        }
    });

    // Handle room joining
    socket.on('joinRoom', (roomId) => {
        currentRoom = roomId;
        socket.join(roomId);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        gameManager.removePlayer(socket.id);
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Mathematical Card Battle Multiplayer Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
    });
});
