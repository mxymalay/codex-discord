const OP = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
});

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000];
const INTERACTION_CACHE_LIMIT = 1_000;

function identifyPayload(token) {
  return {
    op: OP.IDENTIFY,
    d: {
      token,
      intents: 1,
      properties: { os: 'windows', browser: 'codex-discord', device: 'codex-discord' },
    },
  };
}

function resumePayload(token, sessionId, sequence) {
  return { op: OP.RESUME, d: { token, session_id: sessionId, seq: sequence } };
}

function withGatewayQuery(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=10&encoding=json`;
}

function gatewayError() {
  return new Error('Discord Gateway connection failed');
}

export function createGatewayClient({
  token,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  onInteraction = async () => {},
  onStatus = () => {},
  timers = {},
}) {
  const clock = {
    setTimeout: timers.setTimeout ?? globalThis.setTimeout,
    clearTimeout: timers.clearTimeout ?? globalThis.clearTimeout,
    now: timers.now ?? Date.now,
    random: timers.random ?? Math.random,
  };
  const status = {
    state: 'idle', sessionId: null, lastHeartbeatAt: null, lastAckAt: null,
    lastEventAt: null, reconnectCount: 0, lastError: null,
  };
  const deliveredInteractions = new Set();
  let currentSocket = null;
  let gatewayUrl = null;
  let resumeGatewayUrl = null;
  let sequence = null;
  let heartbeatInterval = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let heartbeatOutstanding = false;
  let stopped = false;
  let started = false;
  let lifecycleGeneration = 0;
  let nextConnectionGeneration = 0;
  let activeConnectionGeneration = 0;

  function snapshot() {
    return { ...status };
  }

  function publish() {
    onStatus(snapshot());
  }

  function setState(state, lastError = status.lastError) {
    status.state = state;
    status.lastError = lastError;
    publish();
  }

  function clearTimer(name) {
    if (name === 'heartbeat' && heartbeatTimer !== null) {
      clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (name === 'reconnect' && reconnectTimer !== null) {
      clock.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function isLifecycleActive(lifecycle) {
    return !stopped && lifecycle === lifecycleGeneration;
  }

  function isConnectionActive(socket, lifecycle, connection) {
    return isLifecycleActive(lifecycle)
      && socket === currentSocket
      && connection === activeConnectionGeneration;
  }

  function retireCurrentSocket() {
    const socket = currentSocket;
    currentSocket = null;
    activeConnectionGeneration = 0;
    if (socket) socket.close();
  }

  function send(socket, lifecycle, connection, payload) {
    if (isConnectionActive(socket, lifecycle, connection)) socket.send(JSON.stringify(payload));
  }

  function sendHeartbeat(socket, lifecycle, connection) {
    send(socket, lifecycle, connection, { op: OP.HEARTBEAT, d: sequence });
    heartbeatOutstanding = true;
    status.lastHeartbeatAt = clock.now();
    publish();
  }

  function scheduleHeartbeat(socket, lifecycle, connection, delay) {
    clearTimer('heartbeat');
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null;
      if (!isConnectionActive(socket, lifecycle, connection)) return;
      if (heartbeatOutstanding) {
        scheduleReconnect('heartbeat-timeout');
        return;
      }
      sendHeartbeat(socket, lifecycle, connection);
      scheduleHeartbeat(socket, lifecycle, connection, heartbeatInterval);
    }, delay);
  }

  function rememberInteraction(id) {
    if (deliveredInteractions.has(id)) return false;
    deliveredInteractions.add(id);
    if (deliveredInteractions.size > INTERACTION_CACHE_LIMIT) {
      deliveredInteractions.delete(deliveredInteractions.values().next().value);
    }
    return true;
  }

  function handleDispatch(frame, lifecycle, connection) {
    if (frame.s !== null && frame.s !== undefined) sequence = frame.s;
    status.lastEventAt = clock.now();
    if (frame.t === 'READY' && typeof frame.d?.session_id === 'string') {
      status.sessionId = frame.d.session_id;
      resumeGatewayUrl = typeof frame.d.resume_gateway_url === 'string' ? frame.d.resume_gateway_url : gatewayUrl;
      setState('ready', null);
      return;
    }
    publish();
    if (frame.t === 'INTERACTION_CREATE' && typeof frame.d?.id === 'string' && rememberInteraction(frame.d.id)) {
      const interaction = frame.d;
      const interactionId = interaction.id;
      Promise.resolve()
        .then(() => {
          if (!isLifecycleActive(lifecycle) || connection !== activeConnectionGeneration) {
            deliveredInteractions.delete(interactionId);
            return undefined;
          }
          return onInteraction(interaction);
        })
        .catch(() => {
          if (isLifecycleActive(lifecycle) && connection === activeConnectionGeneration) {
            status.lastError = 'interaction-handler-failed';
            publish();
          }
        });
    }
  }

  function handleFrame(socket, lifecycle, connection, event) {
    if (!isConnectionActive(socket, lifecycle, connection)) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      status.lastError = 'gateway-frame-invalid';
      publish();
      return;
    }
    if (frame.op === OP.DISPATCH) {
      handleDispatch(frame, lifecycle, connection);
      return;
    }
    if (frame.op === OP.HELLO) {
      heartbeatInterval = frame.d?.heartbeat_interval;
      heartbeatOutstanding = false;
      if (!Number.isFinite(heartbeatInterval) || heartbeatInterval <= 0) {
        scheduleReconnect('gateway-hello-invalid');
        return;
      }
      if (status.sessionId !== null && sequence !== null) send(socket, lifecycle, connection, resumePayload(token, status.sessionId, sequence));
      else send(socket, lifecycle, connection, identifyPayload(token));
      scheduleHeartbeat(socket, lifecycle, connection, Math.floor(clock.random() * heartbeatInterval));
      return;
    }
    if (frame.op === OP.HEARTBEAT) {
      sendHeartbeat(socket, lifecycle, connection);
      scheduleHeartbeat(socket, lifecycle, connection, heartbeatInterval);
      return;
    }
    if (frame.op === OP.HEARTBEAT_ACK) {
      heartbeatOutstanding = false;
      status.lastAckAt = clock.now();
      publish();
      return;
    }
    if (frame.op === OP.RECONNECT) {
      scheduleReconnect('gateway-reconnect-requested');
      return;
    }
    if (frame.op === OP.INVALID_SESSION) {
      status.sessionId = null;
      resumeGatewayUrl = null;
      sequence = null;
      scheduleReconnect('gateway-session-invalid');
    }
  }

  function connect(lifecycle) {
    if (!isLifecycleActive(lifecycle)) return false;
    const url = resumeGatewayUrl ?? gatewayUrl;
    if (!url) {
      status.lastError = 'gateway-url-unavailable';
      setState('disconnected');
      return false;
    }
    heartbeatOutstanding = false;
    setState('connecting', null);
    let socket;
    try {
      socket = new WebSocketImpl(withGatewayQuery(url));
    } catch {
      status.lastError = 'gateway-connect-failed';
      setState('disconnected');
      return false;
    }
    if (!isLifecycleActive(lifecycle)) {
      socket.close();
      return false;
    }
    const connection = ++nextConnectionGeneration;
    currentSocket = socket;
    activeConnectionGeneration = connection;
    socket.addEventListener('message', (event) => handleFrame(socket, lifecycle, connection, event));
    socket.addEventListener('close', () => {
      if (isConnectionActive(socket, lifecycle, connection)) scheduleReconnect('gateway-closed');
    });
    socket.addEventListener('error', () => {
      if (isConnectionActive(socket, lifecycle, connection)) scheduleReconnect('gateway-error');
    });
    return true;
  }

  function scheduleReconnect(reason) {
    if (stopped || reconnectTimer !== null) return;
    const lifecycle = lifecycleGeneration;
    clearTimer('heartbeat');
    heartbeatOutstanding = false;
    retireCurrentSocket();
    status.reconnectCount += 1;
    status.lastError = reason;
    setState('reconnecting');
    const delay = RECONNECT_DELAYS[Math.min(status.reconnectCount - 1, RECONNECT_DELAYS.length - 1)];
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      if (!isLifecycleActive(lifecycle)) return;
      if (!connect(lifecycle)) scheduleReconnect('gateway-connect-failed');
    }, delay);
  }

  return {
    async start() {
      if (started) return;
      const lifecycle = ++lifecycleGeneration;
      started = true;
      stopped = false;
      setState('connecting', null);
      let response;
      try {
        response = await fetchImpl('https://discord.com/api/v10/gateway/bot', {
          headers: { Authorization: `Bot ${token}` },
        });
        if (!response?.ok) throw gatewayError();
        const body = await response.json();
        if (typeof body?.url !== 'string') throw gatewayError();
        if (!isLifecycleActive(lifecycle)) return;
        gatewayUrl = body.url;
      } catch {
        if (!isLifecycleActive(lifecycle)) return;
        started = false;
        status.lastError = 'gateway-connect-failed';
        setState('disconnected');
        throw gatewayError();
      }
      if (!connect(lifecycle)) {
        if (!isLifecycleActive(lifecycle)) return;
        started = false;
        throw gatewayError();
      }
    },

    async stop() {
      lifecycleGeneration += 1;
      stopped = true;
      started = false;
      clearTimer('heartbeat');
      clearTimer('reconnect');
      retireCurrentSocket();
      setState('stopped', null);
    },

    getStatus: snapshot,
  };
}
