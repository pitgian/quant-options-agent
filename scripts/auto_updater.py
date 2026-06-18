import time
import subprocess
import sys
import os
import datetime

scripts_dir = os.path.dirname(os.path.abspath(__file__))
python_executable = sys.executable

def run_script(script_name, args=[]):
    script_path = os.path.join(scripts_dir, script_name)
    cmd = [python_executable, script_path] + args
    print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Running: {' '.join(cmd)}")
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Success: {script_name}")
        # Print summary or stdout if small
        lines = result.stdout.strip().split('\n')
        for line in lines[-3:]: # Print last 3 lines
            print(f"  > {line}")
    except subprocess.CalledProcessError as e:
        print(f"[{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ERROR running {script_name}: {e.stderr}", file=sys.stderr)

def main():
    print("🚀 Starting local auto-update daemon for Options & Kronos forecasts...")
    print("Press Ctrl+C to stop.")
    
    # Run once at startup
    run_script("fetch_options_data.py", ["--symbol", "ALL"])
    run_script("run_kronos.py")
    
    interval_seconds = 10 * 60 # 10 minutes
    
    try:
        while True:
            print(f"⏳ Sleeping for {interval_seconds // 60} minutes...")
            time.sleep(interval_seconds)
            run_script("fetch_options_data.py", ["--symbol", "ALL"])
            run_script("run_kronos.py")
    except KeyboardInterrupt:
        print("\n👋 Auto-update daemon stopped.")

if __name__ == "__main__":
    main()
