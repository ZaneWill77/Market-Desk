"""Run the dashboard: python -m app"""
import uvicorn

from . import config

if __name__ == "__main__":
    print(f"Market Desk running at http://{config.HOST}:{config.PORT}")
    uvicorn.run("app.server:app", host=config.HOST, port=config.PORT)
