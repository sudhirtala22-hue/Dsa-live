import os
import json
import base64
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from dotenv import load_dotenv
from das_prompt import DAS_LIVE_PROMPT

load_dotenv()

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

MODEL = "gemini-2.5-flash-native-audio-preview-09-2025"

def build_config(resume_handle: str | None = None) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=DAS_LIVE_PROMPT,
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow(target_tokens=16000),
        ),
        session_resumption=types.SessionResumptionConfig(handle=resume_handle),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(
                    voice_name="Aoede"
                )
            ),
           
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )

resume_tokens: dict[str, str] = {}

@app.get("/")
async def index():
    with open("templates/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())

@app.websocket("/ws/{user_id}")
async def live_ws(websocket: WebSocket, user_id: str):
    await websocket.accept()
    print(f"[Das] {user_id} જોડાયો")

    existing_token = resume_tokens.get(user_id)
    config = build_config(resume_handle=existing_token)

    try:
        async with client.aio.live.connect(model=MODEL, config=config) as session:

            async def upstream():
                try:
                    while True:
                        msg = await websocket.receive_text()
                        data = json.loads(msg)
                        if data.get("type") == "audio":
                            pcm = base64.b64decode(data["data"])
                            await session.send_realtime_input(
                                audio=types.Blob(
                                    data=pcm,
                                    mime_type="audio/pcm;rate=16000",
                                )
                            )
                        elif data.get("type") == "text":
                            await session.send_realtime_input(text=data["text"])
                except WebSocketDisconnect:
                    print(f"[Das] {user_id} — client બંધ")
                except Exception as e:
                    print(f"[Das] Upstream error: {e}")

            async def downstream():
                try:
                    async for response in session.receive():
                        if response.session_resumption_update:
                            upd = response.session_resumption_update
                            if upd.resumable and upd.new_handle:
                                resume_tokens[user_id] = upd.new_handle
                                await websocket.send_text(json.dumps({
                                    "type": "resume_token",
                                    "token": upd.new_handle,
                                }))

                        if response.server_content:
                            sc = response.server_content

                            if sc.interrupted:
                                await websocket.send_text(json.dumps({
                                    "type": "interrupted"
                                }))

                            if sc.model_turn:
                                for part in sc.model_turn.parts:
                                    if part.inline_data:
                                        b64 = base64.b64encode(
                                            part.inline_data.data
                                        ).decode()
                                        await websocket.send_text(json.dumps({
                                            "type": "audio",
                                            "data": b64,
                                        }))

                            if sc.input_transcription and sc.input_transcription.text:
                                await websocket.send_text(json.dumps({
                                    "type": "user_transcript",
                                    "text": sc.input_transcription.text,
                                }))

                            if sc.output_transcription and sc.output_transcription.text:
                                await websocket.send_text(json.dumps({
                                    "type": "das_transcript",
                                    "text": sc.output_transcription.text,
                                }))

                            if sc.turn_complete:
                                await websocket.send_text(json.dumps({
                                    "type": "turn_complete"
                                }))
                except Exception as e:
                    print(f"[Das] Downstream error: {e}")

            await asyncio.gather(upstream(), downstream())

    except Exception as e:
        print(f"[Das] Session error: {e}")
        try:
            await websocket.send_text(json.dumps({
                "type": "error", "message": str(e)
            }))
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
        print(f"[Das] {user_id} — બંધ")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=False)