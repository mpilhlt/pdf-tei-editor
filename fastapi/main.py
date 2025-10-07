from fastapi import FastAPI
from backend.api import auth, config, files

app = FastAPI()

# Include routers
app.include_router(auth.router)
app.include_router(config.router)
app.include_router(files.router)

@app.get("/health")
def read_root():
    return {"status": "ok"}