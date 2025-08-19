const express = require('express');
const http =require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// A more robust CORS configuration for Render and local development
const io = new Server(server, {
    cors: {
        origin: "*", // Allows all origins, simpler for this use case
        methods: ["GET", "POST"],
        credentials: false
    },
    // Connection stability settings, good for platforms like Render
    pingTimeout: 60000,
    pingInterval: 25000,
});

// Use the PORT environment variable provided by Render
const PORT = process.env.PORT || 3001;

// Serve the main HTML file and any static assets
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'maths nerds multiplayer.html'));
});

// In-memory store for active game rooms
// Structure: { roomCode: { players: [{id, name}], gameState: {} } }
const rooms = {};

/**
 * Generates a unique 6-character room code.
 * @returns {string} A unique room code.
 */
function generateRoomCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (rooms[code]);
    return code;
}

// --- Socket.IO Event Handlers ---
io.on('connection', (socket) => {
    console.log(`✅ User connected: ${socket.id}`);

    // Handler for creating a new game room
    socket.on('create-room', ({ name }) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            players: [{ id: socket.id, name: name || 'Player 1' }],
            gameState: null // Game state will be initialized by the host
        };
        socket.join(roomCode);
        socket.emit('room-created', { roomCode });
        console.log(`🚪 Room [${roomCode}] created by ${name} (${socket.id})`);
    });

    // Handler for joining an existing game room
    socket.on('join-room', ({ name, roomCode }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit('join-error', { message: 'Room not found.' });
        }
        if (room.players.length >= 2) {
            return socket.emit('join-error', { message: 'This room is already full.' });
        }

        // Add the second player to the room
        room.players.push({ id: socket.id, name: name || 'Player 2' });
        socket.join(roomCode);

        // Notify both players to start the game
        const player1 = room.players[0];
        const player2 = room.players[1];
        io.to(player1.id).emit('game-start', { opponentName: player2.name, role: 'player1', roomCode });
        io.to(player2.id).emit('game-start', { opponentName: player1.name, role: 'player2', roomCode });

        console.log(`🤝 ${name} (${socket.id}) joined room [${roomCode}]`);
    });

    // Relays game actions (like playing a card, ending a turn) to the other player
    socket.on('game-action', (data) => {
        // Broadcast to the other player in the room
        socket.to(data.roomCode).emit('opponent-action', data.action);
    });
    
    // Relays chat messages to everyone in the room
    socket.on('chat-message', (data) => {
        const player = Object.values(rooms).flatMap(r => r.players).find(p => p.id === socket.id);
        if (player) {
            io.to(data.roomCode).emit('chat-message', {
                playerName: player.name,
                message: data.message,
                timestamp: new Date().toISOString()
            });
            console.log(`💬 Chat in [${data.roomCode}] from ${player.name}: ${data.message}`);
        }
    });

    // Handles player disconnection
    socket.on('disconnect', () => {
        console.log(`❌ User disconnected: ${socket.id}`);
        // Find which room the player was in
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                // Notify the other player that their opponent has left
                socket.to(roomCode).emit('opponent-disconnected');
                // Clean up the room
                delete rooms[roomCode];
                console.log(`🧹 Room [${roomCode}] closed due to disconnection.`);
                break;
            }
        }
    });

    // Basic error handling
    socket.on('error', (err) => {
        console.error("Socket Error:", err);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server is live and listening on port ${PORT}`);
});
