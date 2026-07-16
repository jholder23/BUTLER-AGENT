#!/usr/bin/env python3
"""
Code Helper knowledge: ingestion + optional CLI chat.
Run: python main.py           - ingest only
     python main.py --chat    - ingest + chat
"""
import argparse
from ingester import AutonomousIngester

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chat", action="store_true", help="Also run chat (ingestion in background)")
    args = parser.parse_args()

    print("=" * 50)
    print("  Code Helper - Knowledge")
    print("  Web + OpenAI -> ChromaDB")
    print("=" * 50)

    ingester = AutonomousIngester()

    if args.chat:
        import threading
        from agent import HybridAgent
        agent = HybridAgent()
        threading.Thread(target=ingester.run, kwargs={"delay_sec": 3.0}, daemon=True).start()
        print("\nIngestion running. Type to chat. /quit to exit.\n")
        while True:
            try:
                user_input = input("\nYou: ").strip()
            except (KeyboardInterrupt, EOFError):
                break
            if not user_input:
                continue
            if user_input.lower() in ("/quit", "/exit", "/q"):
                break
            if user_input.lower() == "/reset":
                agent.reset()
                print("Reset.")
                continue
            content, source = agent.chat(user_input)
            print(f"\n[{source}]\n{content}")
    else:
        ingester.run(delay_sec=2.0)

if __name__ == "__main__":
    main()
