const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const dot      = document.getElementById("statusDot");
const transcriptEl = document.getElementById("transcript");

const USER_ID = "user-" + Math.random().toString(36).slice(2, 10);
let resumeToken = null;

let ws, audioCtx, micStream, workletNode;
let playbackCtx, playbackTime = 0;
let isRunning = false;
let reconnectAttempts = 0;

function setStatus(text, state = "") {
  statusEl.textContent = text;
  dot.className = state;
}

function addLine(who, text) {
  const div = document.createElement("div");
  div.className = `line ${who}`;
  div.innerHTML = `<div class="who">${who === "das" ? "Das" : "તમે"}</div>
                   <div class="text"></div>`;
  div.querySelector(".text").textContent = text;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function updateLastLine(who, text) {
  const last = transcriptEl.lastElementChild;
  if (last && last.classList.contains(who)) {
    last.querySelector(".text").textContent = text;
  } else {
    addLine(who, text);
  }
}

const WORKLET_CODE = `
class RecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.size = 0;
    this.chunkSize = 640;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.buffer.push(ch[i]);
      if (++this.size >= this.chunkSize) {
        this.port.postMessage(new Float32Array(this.buffer));
        this.buffer = []; this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor('recorder-worklet', RecorderWorklet);
`;

function floatTo16BitPCM(f32) {
  const buf = new ArrayBuffer(f32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buf;
}

function b64FromBuffer(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function playChunk(int16) {
  if (!playbackCtx) playbackCtx = new AudioContext({ sampleRate: 24000 });
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
  const buffer = playbackCtx.createBuffer(1, f32.length, 24000);
  buffer.copyToChannel(f32, 0);
  const src = playbackCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playbackCtx.destination);
  const now = playbackCtx.currentTime;
  if (playbackTime < now) playbackTime = now;
  src.start(playbackTime);
  playbackTime += buffer.duration;
}

function clearPlayback() {
  playbackTime = playbackCtx ? playbackCtx.currentTime : 0;
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${USER_ID}`);

  ws.onopen = () => {
    reconnectAttempts = 0;
    setStatus(resumeToken ? "🟢 પુનઃજોડાયું — બોલો..." : "🟢 જોડાયું — બોલો...", "on");
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "audio": {
        const raw = atob(msg.data);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        playChunk(new Int16Array(bytes.buffer));
        break;
      }
      case "interrupted":
        clearPlayback();
        setStatus("⏸️ Das અટક્યો — તમે બોલો", "busy");
        break;
      case "user_transcript":
        updateLastLine("user", msg.text); break;
      case "das_transcript":
        updateLastLine("das", msg.text); break;
      case "turn_complete":
        setStatus("🔊 Das બોલ્યો — તમે બોલો", "on"); break;
      case "resume_token":
        resumeToken = msg.token; break;
      case "error":
        setStatus("⚠️ " + msg.message, "err"); break;
    }
  };

  ws.onclose = () => {
    setStatus("🔴 કનેક્શન બંધ", "err");
    if (isRunning && reconnectAttempts < 5) {
      reconnectAttempts++;
      const delay = resumeToken ? 1000 : 2500 * reconnectAttempts;
      setStatus(`🔄 ફરી જોડાઈ રહ્યું છે... (${reconnectAttempts}/5)`, "busy");
      setTimeout(connectWS, delay);
    }
  };

  ws.onerror = () => setStatus("⚠️ કનેક્શનમાં સમસ્યા", "err");
}

async function start() {
  if (isRunning) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount:1, echoCancellation:true,
               noiseSuppression:true, autoGainControl:true }
    });
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, "recorder-worklet");
    source.connect(workletNode);

    workletNode.port.onmessage = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatTo16BitPCM(e.data);
      ws.send(JSON.stringify({ type:"audio", data: b64FromBuffer(pcm) }));
    };

    connectWS();
    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus("🎤 માઇક ચાલુ — બોલો...", "on");
  } catch (err) {
    console.error(err);
    setStatus("⚠️ માઇકની પરવાનગી જરૂરી છે", "err");
  }
}

function stop() {
  isRunning = false;
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (playbackCtx) { playbackCtx.close(); playbackCtx = null; playbackTime = 0; }
  if (ws) { ws.close(); ws = null; }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("⏹️ બંધ થયું", "");
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
window.addEventListener("beforeunload", stop);