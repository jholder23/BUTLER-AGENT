# Knowledge API (bundled with Code Helper)

This folder is packaged with Code Helper Studio. When the app runs, it spawns `python api_server.py` to serve the knowledge base.

## Requirements (for knowledge to work)

The user must have:
1. **Python** installed and in PATH
2. **Dependencies**: `pip install chromadb flask`

If not installed, Code Helper still works—just without knowledge augmentation.

## Populating the knowledge DB

The app uses: `%APPDATA%\Code Helper Studio\knowledge_db`

From the main knowledge project (d:\Chat - PEEPEEDEE):
```powershell
$env:KNOWLEDGE_DB_PATH = "$env:APPDATA\Code Helper Studio\knowledge_db"
python main.py
```

Or run `python ingest_for_code_helper.py` from that project.
