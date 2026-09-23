"""Run Azure voices without installing heavy MeloTTS/OpenVoice dependencies.

In voice_server/: pip install fastapi uvicorn
Then: uvicorn azure_server:app --host 127.0.0.1 --port 8765
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from azure_speech import router

app = FastAPI(title="Manhua Lens Azure Korean Voices")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.include_router(router)


@app.get("/health")
def health():
    return {"ok": True, "engine": "azure"}
