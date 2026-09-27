#!/usr/bin/env python3
"""Adapt LangWatch thread identifiers to the AIGW conversation UUID contract."""
import os
import sys
import uuid
from pathlib import Path

source = Path(os.environ.get('AIGW_LOCAL_REPO', str(Path.home() / 'Desktop/aigw-local')))
sys.path.insert(0, str(source))
from fastapi import FastAPI, Header
from local.langwatch_target import chat as upstream_chat, health as upstream_health

app = FastAPI(title='LangWatch AIGW bridge')

@app.get('/health')
def health():
    return upstream_health()

@app.post('/chat')
def chat(body: dict, authorization: str | None = Header(default=None)):
    thread = body.get('thread_id')
    # LangWatch identifiers are not UUIDs. Use a deterministic mapping so
    # every turn reaches the same AIGW conversation without changing the bot.
    if isinstance(thread, str) and thread:
        body = {**body, 'thread_id': str(uuid.uuid5(uuid.NAMESPACE_URL, 'langwatch:'+thread))}
    return upstream_chat(body, authorization)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8092)
