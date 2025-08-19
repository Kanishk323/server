const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Store game rooms and players
const gameRooms = new Map();
const waitingPlayers = [];

// Game room structure
class GameRoom {
    constructor(roomId) {
        this.id = roomId;
        this.players = [];
        this.gameState = {
            currentTurn: 0,
            gameStarted: false,
            winner: null,
            deck: [],
            discardPile: []
        };
        this.playerStates = {};
    }

    addPlayer(socket, playerName) {
        if (this.players.length >= 2) {
            return false;
        }

        const player = {
            id: socket.id,
            socket: socket,
            name: playerName,
            playerNumber: this.players.length + 1
        };

        this.players.push(player);

        // Initialize player state
        this.playerStates[socket.id] = {
            ip: 100,
            hand: [],
            branch: null,
            branchEffects: {},
            blocks: 0,
            gracePeriod: false,
            graceTurns: 0
        };

        return true;
    }

    removePlayer(socketId) {
        this.players = this.players.filter(player => player.id !== socketId);
        delete this.playerStates[socketId];

        if (this.players.length === 0) {
            return true; // Room should be deleted
        }

        // Notify remaining player
        if (this.players.length === 1) {
            this.players[0].socket.emit('playerDisconnected');
        }

        return false;
    }

    startGame() {
        if (this.players.length !== 2) {
            return false;
        }

        this.gameState.gameStarted = true;
        this.gameState.currentTurn = 0;

        // Initialize deck and deal cards
        this.initializeDeck();
        this.dealInitialCards();

        // Notify both players
        this.broadcastToRoom('gameStarted', {
            gameState: this.gameState,
            playerStates: this.playerStates,
            players: this.players.map(p => ({ id: p.id, name: p.name, playerNumber: p.playerNumber }))
        });

        return true;
    }

    initializeDeck() {
        // This should match the deck from the original game
        this.gameState.deck = this.createDeck();
        this.shuffleDeck();
    }

    createDeck() {
        // Sample deck - you can expand this based on the original game
        const deck = [];
        const cardTypes = [
            { name: 'Logic Bomb', effect: 'damage', value: 15, description: 'Deal 15 damage to opponent' },
            { name: 'Probability Shield', effect: 'block', value: 10, description: 'Gain 10 block' },
            { name: 'Calculus Heal', effect: 'heal', value: 12, description: 'Restore 12 IP' },
            { name: 'Algebra Strike', effect: 'damage', value: 10, description: 'Deal 10 damage' },
            { name: 'Geometry Defense', effect: 'block', value: 8, description: 'Gain 8 block' },
            { name: 'Statistics Drain', effect: 'drain', value: 5, description: 'Steal 5 IP from opponent' }
        ];

        // Add multiple copies of each card
        cardTypes.forEach(cardType => {
            for (let i = 0; i < 4; i++) {
                deck.push({ ...cardType, id: uuidv4() });
            }
        });

        return deck;
    }

    shuffleDeck() {
        for (let i = this.gameState.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.gameState.deck[i], this.gameState.deck[j]] = [this.gameState.deck[j], this.gameState.deck[i]];
        }
    }

    dealInitialCards() {
        this.players.forEach(player => {
            for (let i = 0; i < 5; i++) {
                this.drawCard(player.id);
            }
        });
    }

    drawCard(playerId) {
        if (this.gameState.deck.length === 0) {
            // Reshuffle discard pile into deck
            this.gameState.deck = [...this.gameState.discardPile];
            this.gameState.discardPile = [];
            this.shuffleDeck();
        }

        if (this.gameState.deck.length > 0) {
            const card = this.gameState.deck.pop();
            this.playerStates[playerId].hand.push(card);
            return card;
        }
        return null;
    }

    playCard(playerId, cardId, targetId = null) {
        const playerState = this.playerStates[playerId];
        const cardIndex = playerState.hand.findIndex(card => card.id === cardId);

        if (cardIndex === -1) {
            return { success: false, message: 'Card not found in hand' };
        }

        const card = playerState.hand[cardIndex];
        const opponentId = this.players.find(p => p.id !== playerId)?.id;

        if (!opponentId) {
            return { success: false, message: 'No opponent found' };
        }

        // Remove card from hand
        playerState.hand.splice(cardIndex, 1);

        // Apply card effect
        const result = this.applyCardEffect(card, playerId, opponentId);

        // Add card to discard pile
        this.gameState.discardPile.push(card);

        // Check for win condition
        this.checkWinCondition();

        // Broadcast the card play to both players
        this.broadcastToRoom('cardPlayed', {
            playerId: playerId,
            card: card,
            result: result,
            gameState: this.gameState,
            playerStates: this.playerStates
        });

        return { success: true, result: result };
    }

    applyCardEffect(card, playerId, opponentId) {
        const playerState = this.playerStates[playerId];
        const opponentState = this.playerStates[opponentId];

        let result = { effect: card.effect, value: card.value, description: card.description };

        switch (card.effect) {
            case 'damage':
                let damage = card.value;
                if (opponentState.blocks > 0) {
                    const blockedDamage = Math.min(damage, opponentState.blocks);
                    damage -= blockedDamage;
                    opponentState.blocks -= blockedDamage;
                    result.blocked = blockedDamage;
                }
                opponentState.ip -= damage;
                result.actualDamage = damage;
                break;

            case 'heal':
                playerState.ip = Math.min(100, playerState.ip + card.value);
                break;

            case 'block':
                playerState.blocks += card.value;
                break;

            case 'drain':
                const drainAmount = Math.min(card.value, opponentState.ip);
                opponentState.ip -= drainAmount;
                playerState.ip = Math.min(100, playerState.ip + drainAmount);
                result.actualDrain = drainAmount;
                break;
        }

        return result;
    }

    checkWinCondition() {
        this.players.forEach(player => {
            const playerState = this.playerStates[player.id];
            if (playerState.ip <= 0 && !playerState.gracePeriod) {
                playerState.gracePeriod = true;
                playerState.graceTurns = 3;
            } else if (playerState.gracePeriod) {
                playerState.graceTurns--;
                if (playerState.graceTurns <= 0) {
                    this.gameState.winner = this.players.find(p => p.id !== player.id)?.id;
                }
            }
        });

        // Also check if someone has positive IP while opponent is in grace period
        const player1State = this.playerStates[this.players[0]?.id];
        const player2State = this.playerStates[this.players[1]?.id];

        if (player1State && player2State) {
            if (player1State.ip > 0 && player2State.gracePeriod && player2State.graceTurns <= 0) {
                this.gameState.winner = this.players[0].id;
            } else if (player2State.ip > 0 && player1State.gracePeriod && player1State.graceTurns <= 0) {
                this.gameState.winner = this.players[1].id;
            }
        }
    }

    nextTurn() {
        this.gameState.currentTurn = 1 - this.gameState.currentTurn;

        // Draw a card for the new current player
        const currentPlayer = this.players[this.gameState.currentTurn];
        if (currentPlayer) {
            this.drawCard(currentPlayer.id);
        }

        // Reset blocks at start of turn (optional rule)
        Object.values(this.playerStates).forEach(state => {
            state.blocks = Math.max(0, state.blocks - 1); // Decay blocks by 1 each turn
        });

        this.broadcastToRoom('turnChanged', {
            currentTurn: this.gameState.currentTurn,
            currentPlayerId: currentPlayer?.id,
            gameState: this.gameState,
            playerStates: this.playerStates
        });
    }

    setBranch(playerId, branch) {
        this.playerStates[playerId].branch = branch;

        // Apply branch effects based on the original game logic
        const branchEffects = this.getBranchEffects(branch);
        this.playerStates[playerId].branchEffects = branchEffects;

        // Apply initial branch bonuses
        if (branchEffects.initialBonus) {
            this.playerStates[playerId].ip += branchEffects.initialBonus.ip || 0;
            this.playerStates[playerId].blocks += branchEffects.initialBonus.blocks || 0;
        }

        this.broadcastToRoom('branchSet', {
            playerId: playerId,
            branch: branch,
            effects: branchEffects,
            playerStates: this.playerStates
        });
    }

    getBranchEffects(branch) {
        const effects = {
            'algebra': {
                initialBonus: { ip: 15, blocks: 5 },
                description: 'Start with +15 IP and +5 Block for 3 turns'
            },
            'calculus': {
                cardBonus: { damage: 2 },
                description: 'All damage cards deal +2 extra damage'
            },
            'geometry': {
                blockBonus: 3,
                description: 'All block effects are increased by 3'
            },
            'probability': {
                risk: true,
                description: 'Higher risk, higher reward mechanics'
            },
            'statistics': {
                cardDraw: 1,
                description: 'Draw an extra card each turn'
            }
        };

        return effects[branch] || {};
    }

    broadcastToRoom(event, data) {
        this.players.forEach(player => {
            player.socket.emit(event, data);
        });
    }

    sendToPlayer(playerId, event, data) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.socket.emit(event, data);
        }
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('findGame', (data) => {
        const { playerName } = data;

        // Check if there's a waiting player
        if (waitingPlayers.length > 0) {
            // Match with waiting player
            const waitingPlayer = waitingPlayers.shift();
            const roomId = uuidv4();
            const room = new GameRoom(roomId);

            // Add both players to the room
            room.addPlayer(waitingPlayer.socket, waitingPlayer.name);
            room.addPlayer(socket, playerName);

            // Join socket rooms
            waitingPlayer.socket.join(roomId);
            socket.join(roomId);

            gameRooms.set(roomId, room);

            // Notify both players they're matched
            room.broadcastToRoom('gameMatched', {
                roomId: roomId,
                players: room.players.map(p => ({ id: p.id, name: p.name, playerNumber: p.playerNumber }))
            });

        } else {
            // Add to waiting list
            waitingPlayers.push({ socket, name: playerName });
            socket.emit('waitingForOpponent');
        }
    });

    socket.on('setBranch', (data) => {
        const { roomId, branch } = data;
        const room = gameRooms.get(roomId);

        if (room) {
            room.setBranch(socket.id, branch);

            // Check if both players have set their branches
            const allBranchesSet = room.players.every(player => 
                room.playerStates[player.id].branch !== null
            );

            if (allBranchesSet && !room.gameState.gameStarted) {
                room.startGame();
            }
        }
    });

    socket.on('playCard', (data) => {
        const { roomId, cardId, targetId } = data;
        const room = gameRooms.get(roomId);

        if (room && room.gameState.gameStarted) {
            const currentPlayer = room.players[room.gameState.currentTurn];

            if (currentPlayer && currentPlayer.id === socket.id) {
                const result = room.playCard(socket.id, cardId, targetId);

                if (result.success) {
                    // End turn
                    setTimeout(() => {
                        if (!room.gameState.winner) {
                            room.nextTurn();
                        }
                    }, 2000); // 2 second delay before next turn
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);

        // Remove from waiting players
        const waitingIndex = waitingPlayers.findIndex(p => p.socket.id === socket.id);
        if (waitingIndex > -1) {
            waitingPlayers.splice(waitingIndex, 1);
        }

        // Remove from active games
        for (const [roomId, room] of gameRooms.entries()) {
            if (room.removePlayer(socket.id)) {
                gameRooms.delete(roomId);
                break;
            }
        }
    });
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Mathematical Card Battle Game Server Running',
        players: waitingPlayers.length,
        activeGames: gameRooms.size
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Mathematical Card Battle Game server running on port ${PORT}`);
});
