import { WebSocketServer } from "ws";
import * as https from "https";
import * as fs from "fs";
import "dotenv/config";

let runningGames = {};

const ID_CHARS = [
	"A",
	"B",
	"C",
	"D",
	"E",
	"F",
	"G",
	"H",
	"I",
	"J",
	"K",
	"L",
	"M",
	"N",
	"O",
	"P",
	"Q",
	"R",
	"S",
	"T",
	"U",
	"V",
	"W",
	"X",
	"Y",
	"Z",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"0",
];

function randomFromList(l) {
	return l[Math.floor(Math.random() * l.length)];
}

function generateId() {
	let id = "";
	for (let i = 0; i < 4; i++) {
		id += randomFromList(ID_CHARS);
	}
	return id;
}

function createGame(ws, options) {
	let id = generateId();
	while (Object.keys(runningGames).includes(id)) {
		id = generateId();
	}

	const { limit, playerName } = options;

	const gameState = {
		map: {},
		turn: 0,
		placements: [],
		moveLimit: limit > 0 ? limit : 0,
		isLimited: limit > 0,
		status: 0,
		players: [null],
	};

	runningGames[id] = {
		id,
		gameState,
		sockets: [
			{
				ws,
				name: playerName,
				isReady: false,
				isHost: true,
				wins: 0,
			},
		],
	};

	return id;
}

function swapPlayers(id, pos1, pos2) {
	const wsData1 = runningGames[id].sockets[pos1];
	const wsData2 = runningGames[id].sockets[pos2];
	runningGames[id].sockets[pos1] = wsData2;
	runningGames[id].sockets[pos2] = wsData1;
}

function propagateState(id, isMove = false) {
	const { sockets, gameState } = runningGames[id];
	sockets.forEach(({ ws }, index) =>
		ws.send(
			JSON.stringify({
				action: isMove ? "STATE_UPDATE_MOVE" : "STATE_UPDATE",
				gameState,
				id,
				playerIndex: index,
				players: sockets.map(({ isReady, isHost, wins, name }) => ({ isReady, isHost, wins, name })),
			})
		)
	);
}

function joinGame(id, ws, playerName) {
	if (gameExists(id) && runningGames[id].gameState.status === 0 && runningGames[id].sockets.length < 4) {
		if (ws) {
			runningGames[id].gameState.players.push(null);
			runningGames[id].sockets.push({
				ws,
				name: playerName,
				isReady: false,
				isHost: false,
				wins: 0,
			});
		}
		return true;
	}
	return false;
}

function socketIsConnectedToGame(socket, id) {
	return runningGames[id].sockets.find(({ ws }) => socket === ws) !== undefined;
}

function gameExists(id) {
	return runningGames[id] !== undefined;
}

function shoveDownEntity(id, ws) {
	const { sockets } = runningGames[id];
	const socketIndex = sockets.findIndex((e) => e.ws === ws);
	const socketData = sockets[socketIndex];
	runningGames[id].sockets[socketIndex] = undefined;
	while (socketIndex > 0 && sockets[socketIndex - 1] === null) {
		socketIndex--;
	}
	if (socketIndex > -1) {
		sockets[socketIndex] = socketData;
	}
}

/* Randomize array in-place using Durstenfeld shuffle algorithm */
function shuffleArray(array) {
	for (var i = array.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var temp = array[i];
		array[i] = array[j];
		array[j] = temp;
	}
}

function startGame(id, gameState, gameSettings) {
	runningGames[id].gameState = gameState;
	runningGames[id].gameState.status = 1;
	runningGames[id].sockets.forEach(({ ws }) =>
		ws.send(
			JSON.stringify({
				action: "START",
				gameSettings,
			})
		)
	);
}

function endGame(id, winner) {
	runningGames[id].gameState.status = 0;
	runningGames[id].sockets[winner].wins++;
	unreadyAll(id);
}

function unreadyAll(id) {
	runningGames[id].sockets.forEach((e) => (e.isReady = false));
}

function basicCheck(ws, id) {
	if (!gameExists(id)) {
		ws.send(
			JSON.stringify({
				action: "FAILURE",
				message: `Game '${id}' does not exist`,
			})
		);
		return false;
	}
	if (!socketIsConnectedToGame(ws, id)) {
		ws.send(
			JSON.stringify({
				action: "FAILURE",
				message: `Socket is not connected to game '${id}'`,
			})
		);
		return false;
	}
	return true;
}

const server = https
	.createServer(
		{
			cert: fs.readFileSync(process.env.CERT_FILE),
			key: fs.readFileSync(process.env.KEY_FILE),
		},
		(req, res) => {
			res.setHeader("Content-Type", "text/html");
			res.writeHead(200);
			res.end(
				`
<html>
	<body>
		<h1>RUNNING GAMES (as of ${new Date().toISOString()})</h1>
		${Object.entries(runningGames)
			.map(([key, value]) => `<div><span>${key}</span> (${value.sockets.length}/4)</div>`)
			.join("")}
	</body>
</html>
			`
			);
		}
	)
	.listen(process.env.PORT);

const wss = new WebSocketServer({ server });

function processRequest(ws, data) {
	switch (data.action) {
		case "CREATE_GAME": {
			const { options } = data;
			const id = createGame(ws, options);
			console.log(`${new Date(Date.now()).toISOString()} | Created Game: ${id} (Total Current Games: ${Object.entries(runningGames).length})`);
			propagateState(id);
			break;
		}
		case "JOIN_GAME": {
			const { id, playerName } = data;
			if (joinGame(id, ws, playerName)) {
				unreadyAll(id);
				propagateState(id);
			} else {
				ws.send(
					JSON.stringify({
						action: "JOIN_FAILURE",
						message: `Cannot join game '${id}'`,
					})
				);
				return;
			}
			break;
		}
		case "MOVE_UP": {
			const { id, pos } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			if (pos < runningGames[id].sockets.length - 1) {
				swapPlayers(id, pos, pos + 1);
			}
			unreadyAll(id);
			propagateState(id);
			break;
		}
		case "MOVE_DOWN": {
			const { id, pos } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			if (pos > 0) {
				swapPlayers(id, pos, pos - 1);
			}
			unreadyAll(id);
			propagateState(id);
			break;
		}
		case "READY_UP": {
			const { id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].sockets.find((e) => e.ws === ws).isReady = true;
			propagateState(id);
			break;
		}
		case "READY_DOWN": {
			const { id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].sockets.find((e) => e.ws === ws).isReady = false;
			propagateState(id);
			break;
		}
		case "START_GAME": {
			const { gameState, gameSettings, id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			startGame(id, gameState, gameSettings);
			propagateState(id);
			break;
		}
		case "END_GAME": {
			const { id, winner } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			endGame(id, winner);
			propagateState(id);
			break;
		}
		case "BROADCAST_MOVE": {
			const { gameState, id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].gameState = gameState;
			propagateState(id, true);
			break;
		}
		case "BROADCAST": {
			const { gameState, id } = data;
			if (!basicCheck(ws, id)) {
				return;
			}
			runningGames[id].gameState = gameState;
			propagateState(id);
			break;
		}
	}
}

wss.on("connection", function connection(ws) {
	ws.on("close", (code, desc) => {
		console.log(`${new Date(Date.now()).toISOString()} | Closed connection`, code, desc);
		const game = Object.entries(runningGames).find(([_, value]) => {
			if (value && value.sockets.find((e) => e.ws === ws)) {
				return true;
			}
			return false;
		});
		if (game) {
			const id = game[0];
			const wsIndex = runningGames[id].sockets.findIndex((e) => e.ws === ws);
			const wasHost = runningGames[id].sockets[wsIndex].isHost;
			runningGames[id].sockets.splice(wsIndex, 1);
			for (let i = 0; i < 4; i++) {
				if (runningGames[id].sockets[i] !== null) {
					shoveDownEntity(id, ws);
				}
			}
			if (wasHost) {
				console.log(`${new Date(Date.now()).toISOString()} | Closing game ${id} (Total Current Games: ${Object.entries(runningGames).length - 1})`);
				runningGames[id].sockets.forEach(({ ws }) =>
					ws.send(
						JSON.stringify({
							action: "CLOSE",
						})
					)
				);
				delete runningGames[id];
			} else {
				runningGames[id].gameState.players.splice(0, 1);
				propagateState(id);
			}
		}
	});
	ws.on("message", (raw) => {
		const dataArray = JSON.parse(raw);
		dataArray.forEach((data) => processRequest(ws, data));
	});

	ws.send(
		JSON.stringify({
			action: "SUCCESS",
			message: "Connected",
		}),
		ws
	);
});

console.log(`Created WebSocket on port ${process.env.PORT}`);
