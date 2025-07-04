const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const rooms = {};


function generateRoomId() {
    let roomId;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    do {
        const letter = chars.charAt(Math.floor(Math.random() * chars.length));
        const numbers = Math.floor(100 + Math.random() * 900).toString(); // Gera um número entre 100 e 999
        roomId = letter + numbers;
    } while (rooms[roomId]); // Garante que o ID seja único
    return roomId;
}

// FUNÇÃO AUXILIAR PARA EMBARALHAR ARRAY (Fisher-Yates) - DEFINIÇÃO GLOBAL E ÚNICA
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

    
    function startNextTurn(roomId) {
        const room = rooms[roomId];
        if (!room) return;
    
        // Verifica se a etapa terminou (se todas as palavras foram usadas)
        if (room.currentWordIndex >= room.words.length) {
            room.currentStage++;
            
            // Verifica se o jogo terminou
            if (room.currentStage > 3) {
                io.to(roomId).emit('gameOver', { scores: room.scores });
                delete rooms[roomId]; 
                return;
            }
    
            // Prepara a próxima etapa
            room.currentWordIndex = 0;
            room.words = shuffleArray([...room.initialWords]); // Repõe as palavras no saco
            
            io.to(roomId).emit('stageEnded', {
                newStage: room.currentStage,
                scores: room.scores
            });
            return; // Para a execução aqui, esperando o anfitrião continuar
        }
    
        if (room.currentTurn >= room.teams.length) {
            room.currentTurn = 0;
        }
    
        const currentTeam = room.teams[room.currentTurn]; 
        const currentWord = room.words[room.currentWordIndex];
        let turnDuration = 60;
        if (currentTeam.accumulatedTime > 0) {
            turnDuration = currentTeam.accumulatedTime;
            currentTeam.accumulatedTime = 0;
        }
        
        const describerId = currentTeam.ids[currentTeam.currentDescriberIndex];
        const describerPlayer = room.players[describerId].nickname;
        const guesserPlayer = room.players[currentTeam.ids[1 - currentTeam.currentDescriberIndex]].nickname;
        
        const baseTurnData = { 
            currentTeamName: currentTeam.name, 
            currentTeamScore: room.scores[currentTeam.name],
            stage: room.currentStage, 
            describer: describerPlayer, 
            guesser: guesserPlayer, 
            turnDuration: turnDuration, 
            describerId: describerId 
        };
        
        for (const playerId in room.players) {
            const playerSocket = io.sockets.sockets.get(playerId);
            if (playerSocket) {
                if (playerId === describerId || playerId === room.hostId) {
                    playerSocket.emit('startTurn', { ...baseTurnData, currentWord: currentWord });
                } else {
                    playerSocket.emit('startTurn', { ...baseTurnData, currentWord: '******' });
                }
            }
        }
    }
    

io.on('connection', (socket) => {
    console.log('Um usuário conectado:', socket.id);


        socket.on('createRoom', (data) => {
            const nickname = data.nickname ? data.nickname.trim() : '';
            if (nickname.length < 2) {
                socket.emit('nicknameError', 'Apelido deve ter no mínimo 2 caracteres.');
                return;
            }

            const roomId = generateRoomId();
            rooms[roomId] = {
                hostId: socket.id, // <<< ADICIONAMOS ESTA LINHA PARA SABER QUEM É O HOST
                players: {},
                words: [],
                wordsPerPlayer: 0,
                wordsPerPlayerDefined: false,
                teams: [],
                currentTurn: 0,
                currentWordIndex: 0,
                scores: {},
                currentStage: 1,
                allWordsSubmitted: false
            };
            rooms[roomId].players[socket.id] = { id: socket.id, nickname: nickname, isHost: true, wordsSubmitted: 0 };
            socket.join(roomId);
            console.log(`[Sala ${roomId}] criada por ${nickname} (Host ID: ${socket.id})`); // Log aprimorado
            socket.emit('roomCreated', { roomId, nickname: nickname });
            io.to(roomId).emit('playerJoined', rooms[roomId].players[socket.id]);
            io.to(roomId).emit('playersUpdate', Object.values(rooms[roomId].players));
        });

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId ? data.roomId.trim() : ''; // Não precisa de toUpperCase() para números
        const nickname = data.nickname ? data.nickname.trim() : '';

        if (nickname.length < 2) {
            socket.emit('nicknameError', 'Apelido deve ter no mínimo 2 caracteres.');
            return;
        }

        if (rooms[roomId]) {
            if (rooms[roomId].players[socket.id]) {
                socket.emit('alreadyInRoom', { roomId });
                console.log(`[Sala ${roomId}] ${nickname} (ID: ${socket.id}) já está na sala.`);
                io.to(roomId).emit('playersUpdate', Object.values(rooms[roomId].players));
                if (rooms[roomId].wordsPerPlayerDefined) {
                    socket.emit('wordsPerPlayerSet', { wordsPerPlayer: rooms[roomId].wordsPerPlayer });
                }
                return;
            }

            const existingNicknames = Object.values(rooms[roomId].players).map(p => p.nickname.toLowerCase());
            if (existingNicknames.includes(nickname.toLowerCase())) {
                socket.emit('nicknameError', 'Este apelido já está em uso nesta sala. Por favor, escolha outro.');
                return;
            }

            rooms[roomId].players[socket.id] = { id: socket.id, nickname: nickname, isHost: false, wordsSubmitted: 0 };
            socket.join(roomId);
            console.log(`[Sala ${roomId}] ${nickname} entrou na sala.`);
            socket.emit('roomJoined', { roomId, nickname: nickname });
            io.to(roomId).emit('playerJoined', rooms[roomId].players[socket.id]);
            io.to(roomId).emit('playersUpdate', Object.values(rooms[roomId].players));

            if (rooms[roomId].wordsPerPlayerDefined) {
                socket.emit('wordsPerPlayerSet', { wordsPerPlayer: rooms[roomId].wordsPerPlayer });
            }
        } else {
            socket.emit('roomNotFound');
            console.log(`[Sala ${roomId}] Tentativa de entrar em sala inexistente.`);
        }
    });

    socket.on('setWordsPerPlayer', (data) => {
        const { roomId, wordsPerPlayer } = data;
        const room = rooms[roomId];

        if (room && room.players[socket.id] && room.players[socket.id].isHost) {
            room.wordsPerPlayer = parseInt(wordsPerPlayer, 10);
            room.wordsPerPlayerDefined = true;
            console.log(`[Sala ${roomId}] Anfitrião definiu ${wordsPerPlayer} palavras por jogador.`);
            io.to(roomId).emit('wordsPerPlayerSet', { wordsPerPlayer: room.wordsPerPlayer });
        } else {
            console.warn(`[Sala ${roomId}] Tentativa inválida de definir palavras por jogador por ${socket.id}`);
        }
    });

    socket.on('submitWord', (data) => {
        const { roomId, word, nickname } = data;
        const room = rooms[roomId];

        if (room && room.players[socket.id]) {
            const trimmedWord = word.trim();
            if (trimmedWord.length < 2) {
                socket.emit('wordSubmissionError', 'A palavra deve ter no mínimo 2 caracteres.');
                return;
            }

            const normalizedWord = trimmedWord.toLowerCase();
            if (room.words.map(w => w.toLowerCase()).includes(normalizedWord)) {
                socket.emit('wordSubmissionError', 'Esta palavra já foi enviada. Por favor, escolha outra.');
                return;
            }

            if (room.players[socket.id].wordsSubmitted >= room.wordsPerPlayer) {
                socket.emit('wordSubmissionError', `Você já enviou suas ${room.wordsPerPlayer} palavras.`);
                return;
            }

            room.words.push(trimmedWord);
            room.players[socket.id].wordsSubmitted++;
            console.log(`[Sala ${roomId}] Palavra "${trimmedWord}" submetida por ${nickname}. Total: ${room.words.length}`);

            let allWordsCount = Object.keys(room.players).length * room.wordsPerPlayer;

            socket.emit('wordSubmittedIndividual', { wordsSubmittedByMe: room.players[socket.id].wordsSubmitted, totalWordsForPlayer: room.wordsPerPlayer });
            io.to(roomId).emit('wordSubmitted', { currentWordsCount: room.words.length, totalExpectedWords: allWordsCount });

             if (room.words.length === allWordsCount && !room.allWordsSubmitted) {
                    room.allWordsSubmitted = true;
                    room.words = shuffleArray(room.words);
                    room.initialWords = [...room.words]; // <<< ADICIONE ESTA LINHA
                    console.log(`[Sala ${roomId}] Todas as palavras submetidas.`);
                    io.to(roomId).emit('allWordsSubmittedAndReady');
                }
        } else {
            console.warn(`[Sala ${roomId}] Tentativa de submeter palavra em sala inválida ou sem jogador: ${socket.id}`);
            socket.emit('wordSubmissionError', 'Erro ao submeter palavra. Você não está em uma sala válida.');
        }
    });

    socket.on('startGame', (data) => {
        const { roomId } = data;
        const room = rooms[roomId];
    
        if (room && room.players[socket.id] && room.players[socket.id].isHost && room.allWordsSubmitted) {
            if (room.teams.length > 0) {
                startNextTurn(roomId);
            } else {
                console.warn(`[Sala ${roomId}] Não há duplas para iniciar o jogo.`);
                socket.emit('gameError', 'Duplas ainda não foram formadas. O anfitrião precisa sortear as duplas primeiro.');
            }
        } else {
            console.warn(`[Sala ${roomId}] Tentativa inválida de iniciar jogo por ${socket.id}`);
            socket.emit('gameError', 'Você não tem permissão para iniciar o jogo ou as palavras não foram submetidas.');
        }
    });


socket.on('confirmStartTurn', (data) => {
    const { roomId } = data;
    const room = rooms[roomId];

    // A verificação abaixo agora usa o operador de módulo (%) para evitar o erro de 'out of bounds'.
    if (room && (room.players[socket.id]?.isHost || socket.id === room.teams[room.currentTurn % room.teams.length].ids[room.teams[room.currentTurn % room.teams.length].currentDescriberIndex])) {
        // Verifica se quem mandou o comando é o host ou o descritor da vez.
        console.log(`[Sala ${roomId}] Confirmação de início de turno recebida de ${socket.id}. Disparando o turno para todos.`);
        startNextTurn(roomId);
    }
});



socket.on('wordGuessed', (data) => {
    const { roomId, timeLeft } = data;
    const room = rooms[roomId];

    if (room) {
        const currentTeam = room.teams[room.currentTurn];
        const teamName = currentTeam.name;

        room.scores[teamName]++;
        room.currentWordIndex++;

        if (room.currentWordIndex < room.words.length) {
            const nextWord = room.words[room.currentWordIndex];
            
            // <<< INÍCIO DA CORREÇÃO SUTIL >>>
            // A forma correta de pegar o ID de quem está descrevendo é usando o índice atual diretamente.
            const describerId = currentTeam.ids[currentTeam.currentDescriberIndex];
            // <<< FIM DA CORREÇÃO SUTIL >>>

            const hostId = room.hostId;

            console.log(`[Sala ${roomId}] Acerto! Próxima palavra: "${nextWord}"`);

            const successPayload = {
                score: room.scores[teamName],
                stage: room.currentStage,
                currentTeamName: teamName,

                canGuessMore: true
            };

            for (const playerId in room.players) {
                const playerSocket = io.sockets.sockets.get(playerId);
                if (playerSocket) {
                    if (playerId === describerId || playerId === hostId) {
                        playerSocket.emit('wordGuessedSuccess', { ...successPayload, nextWord: nextWord });
                    } else {
                        playerSocket.emit('wordGuessedSuccess', { ...successPayload, nextWord: '******' });
                    }
                }
            }
        } else {
            console.log(`[Sala ${roomId}] Última palavra da Etapa ${room.currentStage} acertada com ${timeLeft}s restantes.`);
            if (room.currentStage < 3 && timeLeft !== undefined) {
                currentTeam.accumulatedTime = timeLeft;
            }
            io.to(roomId).emit('wordGuessedSuccess', {
                score: room.scores[teamName],
                nextWord: '---',
                stage: room.currentStage,
                currentTeamName: teamName,
                canGuessMore: false
            });
            startNextTurn(roomId);
        }
    }
});

    // EM server.js

socket.on('createTeamsAndStart', (data) => {
    const { roomId } = data;
    const room = rooms[roomId];

    if (room && room.players[socket.id] && room.players[socket.id].isHost && room.allWordsSubmitted) {
        const playerIds = Object.keys(room.players);

        if (playerIds.length < 2) {
            socket.emit('gameError', 'São necessários pelo menos 2 jogadores para formar duplas e iniciar o jogo.');
            return;
        }

        const shuffledPlayerIds = shuffleArray([...playerIds]);

        room.teams = [];
        room.scores = {};

        for (let i = 0; i < shuffledPlayerIds.length; i += 2) {
            const player1Id = shuffledPlayerIds[i];
            const player2Id = shuffledPlayerIds[i + 1];

            let team;
            let teamName;

            if (player2Id) {
                team = [player1Id, player2Id];
                teamName = `${room.players[player1Id].nickname} & ${room.players[player2Id].nickname}`;
                room.teams.push({ ids: team, name: teamName, currentDescriberIndex: 0, accumulatedTime: 0 });
            } else {
                team = [player1Id];
                teamName = `${room.players[player1Id].nickname} (Solo)`;
                room.teams.push({ ids: team, name: teamName, currentDescriberIndex: 0, accumulatedTime: 0 });
            }
            room.scores[teamName] = 0;
        }

        room.currentTurn = 0;
        room.currentWordIndex = 0;
        room.currentStage = 1;

        // --- INÍCIO DA MODIFICAÇÃO ---
        const firstTeam = room.teams[0];
        const firstDescriberId = firstTeam.ids[0];
        const firstGuesserId = firstTeam.ids.length > 1 ? firstTeam.ids[1] : null;

        io.to(roomId).emit('teamsFormedAndReady', {
            teams: room.teams.map(team => ({ name: team.name })),
            hostId: socket.id,
            // Informações da primeira dupla
            nextDescriber: room.players[firstDescriberId].nickname,
            nextGuesser: firstGuesserId ? room.players[firstGuesserId].nickname : '(Ninguém)'
        });
        // --- FIM DA MODIFICAÇÃO ---
        console.log(`[Sala ${roomId}] Duplas formadas:`, room.teams.map(t => t.name));

    } else {
        socket.emit('gameError', 'Você não tem permissão para formar duplas ou as palavras não foram submetidas.');
    }
});


// EM server.js, substitua o listener 'turnEnded' por este:

socket.on('turnEnded', (data) => {
    const { roomId } = data;
    console.log(`[Sala ${roomId}] Servidor recebeu o evento 'turnEnded'.`); // LOG 1

    const room = rooms[roomId];

    if (room && room.teams[room.currentTurn]) {
        console.log(`[Sala ${roomId}] Condição 'if' VÁLIDA. Processando fim do turno.`); // LOG 2
        
        const finishedTeam = room.teams[room.currentTurn];
        if (finishedTeam.ids.length > 1) {
            finishedTeam.currentDescriberIndex = 1 - finishedTeam.currentDescriberIndex;
            console.log(`[Sala ${roomId}] Papéis da dupla trocados.`); // LOG 3
        }
        
        room.currentTurn++;
        console.log(`[Sala ${roomId}] Turno incrementado para: ${room.currentTurn}`); // LOG 4

        const nextTurnIndex = room.currentTurn % room.teams.length;
        const nextTeam = room.teams[nextTurnIndex];

        if (!nextTeam) {
            console.error(`[SALA ${roomId}] ERRO CRÍTICO: 'nextTeam' é indefinido!`);
            return;
        }

        const nextDescriberId = nextTeam.ids[nextTeam.currentDescriberIndex];
        const nextGuesserId = nextTeam.ids.length > 1 ? nextTeam.ids[1 - nextTeam.currentDescriberIndex] : null;
        
        console.log(`[Sala ${roomId}] Preparando para emitir 'turnEndedSuccess'. Próxima dupla: ${nextTeam.name}`); // LOG 5

        io.to(roomId).emit('turnEndedSuccess', {
            scores: room.scores,
            nextTeamName: nextTeam.name,
            nextDescriber: room.players[nextDescriberId].nickname,
            nextGuesser: nextGuesserId ? room.players[nextGuesserId].nickname : '(Sozinho)',
            nextDescriberId: nextDescriberId,
            stage: room.currentStage
        });

        console.log(`[Sala ${roomId}] Evento 'turnEndedSuccess' emitido para todos.`); // LOG 6

    } else {
        console.error(`[SALA ${roomId}] ERRO: Condição 'if (room && room.teams[room.currentTurn])' FALHOU.`);
        console.error(`> Detalhes: room existe? ${!!room}, room.teams existe? ${!!room.teams}, room.currentTurn: ${room ? room.currentTurn : 'N/A'}`);
    }
});

    
    socket.on('disconnect', () => {
        console.log('Um usuário desconectado:', socket.id);
        for (const roomId in rooms) {
            if (rooms[roomId].players[socket.id]) {
                const disconnectedPlayer = rooms[roomId].players[socket.id];
                delete rooms[roomId].players[socket.id];
                console.log(`[Sala ${roomId}] "${disconnectedPlayer.nickname}" (${socket.id}) saiu da sala.`);
                io.to(roomId).emit('playerLeft', disconnectedPlayer);
                io.to(roomId).emit('playersUpdate', Object.values(rooms[roomId].players));

                if (Object.keys(rooms[roomId].players).length === 0) {
                    delete rooms[roomId];
                    console.log(`[Sala ${roomId}] Esvaziou e foi removida.`);
                } else if (rooms[roomId].allWordsSubmitted && Object.keys(rooms[roomId].players).length < 2) {
                    console.warn(`[Sala ${roomId}] Jogo comprometido: número insuficiente de jogadores após desconexão.`);
                    io.to(roomId).emit('gameInterrupted', 'Número insuficiente de jogadores.');
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Para acessar via celular na rede local, use o IP do seu computador:${PORT}`);
});