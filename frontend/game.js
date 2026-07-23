'use strict';

// -------------------------------------------------------
// 定数
// -------------------------------------------------------
const WIN_PATTERNS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const PING_INTERVAL_MS = 30_000;
const RECONNECT_MAX = 3;

// -------------------------------------------------------
// 状態
// -------------------------------------------------------
const state = {
  ws: /** @type {WebSocket|null} */ (null),
  player: /** @type {'X'|'O'|null} */ (null),
  board: /** @type {(string|null)[]} */ (Array(9).fill(null)),
  turn: /** @type {'X'|'O'} */ ('X'),
  gameId: /** @type {string|null} */ (null),
  myName: '',
  wsUrl: '',
  pingTimer: /** @type {number|null} */ (null),
  reconnectCount: 0,
  gameOver: false,
};

// -------------------------------------------------------
// DOM 参照
// -------------------------------------------------------
const screens = {
  setup:   document.getElementById('screen-setup'),
  waiting: document.getElementById('screen-waiting'),
  game:    document.getElementById('screen-game'),
  error:   document.getElementById('screen-error'),
};

const el = {
  inputName:   document.getElementById('input-name'),
  inputUrl:    document.getElementById('input-url'),
  btnConnect:  document.getElementById('btn-connect'),
  setupError:  document.getElementById('setup-error'),
  waitingMsg:  document.getElementById('waiting-msg'),
  btnCancel:   document.getElementById('btn-cancel'),
  board:       document.getElementById('board'),
  statusBar:   document.getElementById('status-bar'),
  infoX:       document.getElementById('info-x'),
  infoO:       document.getElementById('info-o'),
  resultPanel: document.getElementById('result-panel'),
  resultMsg:   document.getElementById('result-msg'),
  btnRematch:  document.getElementById('btn-rematch'),
  btnQuit:     document.getElementById('btn-quit'),
  errorDetail: document.getElementById('error-detail'),
  btnRetry:    document.getElementById('btn-retry'),
};

// -------------------------------------------------------
// 画面切替
// -------------------------------------------------------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// -------------------------------------------------------
// WebSocket 管理
// -------------------------------------------------------
function connectWs(url) {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  clearPing();

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    console.log('[WS] open');
    state.reconnectCount = 0;
    startPing();
    // 接続直後に参加リクエスト
    sendMsg({ action: 'join', name: state.myName });
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    console.log('[WS] recv:', msg);
    handleServerMessage(msg);
  };

  ws.onerror = (err) => {
    console.error('[WS] error:', err);
  };

  ws.onclose = (event) => {
    console.log('[WS] close:', event.code, event.reason);
    clearPing();

    // ゲーム中でなければ再接続を試みる
    if (state.reconnectCount < RECONNECT_MAX && !state.gameOver) {
      state.reconnectCount++;
      console.log(`[WS] reconnecting (${state.reconnectCount}/${RECONNECT_MAX})...`);
      setTimeout(() => connectWs(state.wsUrl), 2000 * state.reconnectCount);
    } else {
      showErrorScreen('接続が切れました。ページを再読み込みしてください。');
    }
  };
}

function sendMsg(data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

function startPing() {
  state.pingTimer = setInterval(() => sendMsg({ action: 'ping' }), PING_INTERVAL_MS);
}

function clearPing() {
  if (state.pingTimer !== null) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
}

function closeWs() {
  clearPing();
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

// -------------------------------------------------------
// サーバーメッセージ処理
// -------------------------------------------------------
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'pong':
      break;

    case 'waiting':
      showScreen('waiting');
      el.waitingMsg.textContent = msg.message ?? '対戦相手を待っています...';
      break;

    case 'game_start':
      onGameStart(msg);
      break;

    case 'board_update':
      onBoardUpdate(msg);
      break;

    case 'game_over':
      onGameOver(msg);
      break;

    case 'opponent_disconnected':
      onOpponentDisconnected(msg);
      break;

    case 'error':
      showInlineError(msg.message ?? 'エラーが発生しました');
      break;

    default:
      console.warn('[WS] unknown message type:', msg.type);
  }
}

// -------------------------------------------------------
// ゲームイベント
// -------------------------------------------------------
function onGameStart(msg) {
  state.player  = msg.player;
  state.gameId  = msg.gameId;
  state.board   = msg.board;
  state.turn    = msg.turn;
  state.gameOver = false;

  renderBoard();
  updateTurnIndicator();
  el.resultPanel.classList.add('hidden');
  showScreen('game');
}

function onBoardUpdate(msg) {
  state.board = msg.board;
  state.turn  = msg.turn;

  renderBoard(msg.lastMove);
  updateTurnIndicator();
}

function onGameOver(msg) {
  state.board    = msg.board;
  state.gameOver = true;

  renderBoard();
  highlightWinningCells(msg.board);

  // 結果テキスト
  let text;
  if (msg.winner === 'draw') {
    text = '🤝 引き分け！';
  } else if (msg.winner === state.player) {
    text = '🎉 あなたの勝ち！';
  } else {
    text = '😢 あなたの負け...';
  }
  el.resultMsg.textContent = text;

  // ステータスバーも更新
  el.statusBar.textContent = msg.winner === 'draw' ? '引き分け' : `${msg.winner} の勝ち`;

  el.resultPanel.classList.remove('hidden');
  disableBoard();
}

function onOpponentDisconnected(msg) {
  state.gameOver = true;
  el.resultMsg.textContent = '🏆 相手が切断しました。あなたの勝ちです！';
  el.resultPanel.classList.remove('hidden');
  disableBoard();
}

// -------------------------------------------------------
// ボード描画
// -------------------------------------------------------
function renderBoard(lastMove = null) {
  el.board.innerHTML = '';

  state.board.forEach((cell, idx) => {
    const div = document.createElement('div');
    div.className = 'cell';
    div.setAttribute('role', 'gridcell');
    div.setAttribute('aria-label', `マス ${idx + 1}: ${cell ?? '空き'}`);

    if (cell) {
      div.textContent = cell === 'X' ? '✕' : '○';
      div.classList.add('taken', cell.toLowerCase());
    } else {
      div.setAttribute('tabindex', '0');
      div.addEventListener('click', () => onCellClick(idx));
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onCellClick(idx);
      });
    }

    if (lastMove && lastMove.index === idx) {
      div.classList.add('last-move');
    }

    el.board.appendChild(div);
  });
}

function disableBoard() {
  el.board.querySelectorAll('.cell:not(.taken)').forEach(c => {
    c.classList.add('disabled');
    c.removeAttribute('tabindex');
  });
}

function highlightWinningCells(board) {
  for (const [a, b, c] of WIN_PATTERNS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      const cells = el.board.querySelectorAll('.cell');
      [a, b, c].forEach(i => cells[i].classList.add('winning'));
      return;
    }
  }
}

function updateTurnIndicator() {
  const isMyTurn = state.turn === state.player;

  el.statusBar.textContent = isMyTurn ? 'あなたのターン' : '相手のターン';

  el.infoX.classList.toggle('active-turn', state.turn === 'X');
  el.infoO.classList.toggle('active-turn', state.turn === 'O');
}

// -------------------------------------------------------
// セルクリック
// -------------------------------------------------------
function onCellClick(index) {
  if (state.gameOver) return;
  if (state.turn !== state.player) return;
  if (state.board[index] !== null) return;

  sendMsg({ action: 'move', index });
}

// -------------------------------------------------------
// エラー表示
// -------------------------------------------------------
function showInlineError(message) {
  el.setupError.textContent = message;
  el.setupError.classList.remove('hidden');
  setTimeout(() => el.setupError.classList.add('hidden'), 4000);
}

function showErrorScreen(detail) {
  el.errorDetail.textContent = detail;
  showScreen('error');
}

// -------------------------------------------------------
// イベントリスナー
// -------------------------------------------------------

// 接続ボタン
el.btnConnect.addEventListener('click', () => {
  const name = el.inputName.value.trim() || '匿名';
  const url  = el.inputUrl.value.trim();

  if (!url) {
    el.setupError.textContent = 'WebSocket URL を入力してください';
    el.setupError.classList.remove('hidden');
    return;
  }

  if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
    el.setupError.textContent = 'URL は wss:// または ws:// で始まる必要があります';
    el.setupError.classList.remove('hidden');
    return;
  }

  el.setupError.classList.add('hidden');
  el.btnConnect.disabled = true;
  el.btnConnect.textContent = '接続中...';

  state.myName = name;
  state.wsUrl  = url;
  state.reconnectCount = 0;

  connectWs(url);

  // 接続失敗時のタイムアウト
  setTimeout(() => {
    if (state.ws?.readyState !== WebSocket.OPEN) {
      el.btnConnect.disabled = false;
      el.btnConnect.textContent = '接続して対戦を探す';
      el.setupError.textContent = '接続できませんでした。URLを確認してください';
      el.setupError.classList.remove('hidden');
    }
  }, 5000);
});

// Enter キーでも接続
el.inputUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnConnect.click();
});

// 待機キャンセル
el.btnCancel.addEventListener('click', () => {
  closeWs();
  el.btnConnect.disabled = false;
  el.btnConnect.textContent = '接続して対戦を探す';
  showScreen('setup');
});

// 再戦
el.btnRematch.addEventListener('click', () => {
  el.resultPanel.classList.add('hidden');
  el.statusBar.textContent = '再戦リクエスト送信中...';
  sendMsg({ action: 'rematch' });
});

// 終了
el.btnQuit.addEventListener('click', () => {
  closeWs();
  // 状態リセット
  state.player  = null;
  state.board   = Array(9).fill(null);
  state.gameId  = null;
  state.gameOver = false;
  el.btnConnect.disabled = false;
  el.btnConnect.textContent = '接続して対戦を探す';
  showScreen('setup');
});

// 再試行（エラー画面）
el.btnRetry.addEventListener('click', () => {
  closeWs();
  state.reconnectCount = 0;
  el.btnConnect.disabled = false;
  el.btnConnect.textContent = '接続して対戦を探す';
  showScreen('setup');
});

// -------------------------------------------------------
// ローカルストレージから URL を復元
// -------------------------------------------------------
(function init() {
  const saved = localStorage.getItem('ttt_ws_url');
  if (saved) el.inputUrl.value = saved;

  el.inputUrl.addEventListener('change', () => {
    localStorage.setItem('ttt_ws_url', el.inputUrl.value.trim());
  });
})();
